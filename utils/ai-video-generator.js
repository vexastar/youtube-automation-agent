const OpenAI = require('openai');
const Replicate = require('replicate');
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const ffmpeg = require('fluent-ffmpeg');
const { Logger } = require('./logger');
const { matchSegmentsToAssets } = require('./asset-narration-matcher');

// ========================================================
// 🔠 GESTIÓN DE FUENTES MULTI-PLATAFORMA (Windows / Linux)
// ========================================================
const IS_WINDOWS = process.platform === 'win32';
const FONT_BOLD = IS_WINDOWS ? 'C\\\\:/Windows/Fonts/ariblk.ttf' : '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const FONT_REGULAR = IS_WINDOWS ? 'C\\\\:/Windows/Fonts/arial.ttf' : '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
const FONT_BOLD_ALT = IS_WINDOWS ? 'C\\\\:/Windows/Fonts/arialbd.ttf' : '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const FONT_EMOJI = IS_WINDOWS ? 'C\\\\:/Windows/Fonts/seguiemj.ttf' : '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';

// ========================================================
// 🤖 SIMULADOR LOCAL (Redirige tráfico de OpenAI a Qwen)
// ========================================================
class LocalOllamaClient {
  constructor() {
    this.audio = { speech: { create: async () => { throw new Error('Ollama no soporta TTS directo, se usará Kokoro.'); } } };
    this.chat = {
      completions: {
        create: async (params) => {
          const model = process.env.OLLAMA_MODEL || 'qwen2.5:7b';
          const isJson = params.response_format?.type === 'json_object';
          
          // Escudo: Si el código envía una imagen (Vision), Qwen 2.5 texto no lo soporta. 
          // Devolvemos el centro perfecto (0.5) para que el video siga renderizando sin fallar.
          const hasImage = params.messages.some(m => Array.isArray(m.content) && m.content.some(c => c.type === 'image_url'));
          if (hasImage) {
            return { choices: [{ message: { content: '{"center_x_percentage": 0.5}' } }] };
          }

          const payload = {
            model: model,
            messages: params.messages,
            stream: false,
            format: isJson ? 'json' : undefined,
            options: { temperature: params.temperature || 0.8 }
          };
          
          const res = await axios.post(`${process.env.OLLAMA_HOST || 'http://localhost:11434'}/api/chat`, payload);
          return { choices: [{ message: { content: res.data.message.content } }] };
        }
      }
    };
  }
}
if (!process.env.FONTCONFIG_FILE) {
  process.env.FONTCONFIG_FILE = path.resolve(__dirname, '..', 'config', 'fonts.conf').replace(/\\/g, '/');
}
if (!process.env.FONTCONFIG_PATH) {
  process.env.FONTCONFIG_PATH = 'C:/Windows/Fonts';
}

const execAsync = promisify(exec);

const PER_PRODUCT_DURATION_MIN = parseInt(process.env.PER_PRODUCT_DURATION_MIN || '30', 10);
const PER_PRODUCT_DURATION_MAX = parseInt(process.env.PER_PRODUCT_DURATION_MAX || '50', 10);
const PER_PRODUCT_DURATION_DEFAULT = parseInt(process.env.PER_PRODUCT_DURATION_DEFAULT || String(Math.round((PER_PRODUCT_DURATION_MIN + PER_PRODUCT_DURATION_MAX)/2)), 10);
const INTRO_DURATION_MIN = parseInt(process.env.INTRO_DURATION_MIN || '25', 10);
const INTRO_DURATION_MAX = parseInt(process.env.INTRO_DURATION_MAX || '30', 10);

class AIVideoGenerator {
  constructor(credentials) {
    this.logger = new Logger('AIVideoGenerator');
    
const useLocalAI = process.env.USE_LOCAL_AI === 'true';
    if (useLocalAI) {
      this.logger.info('🎚️ USE_LOCAL_AI=true -> Conectando Qwen 2.5 local como motor principal');
      this.openai = new LocalOllamaClient();
    } else {
      const openaiKey = credentials.openai?.apiKey || process.env.OPENAI_API_KEY;
      if (openaiKey) {
        this.openai = new OpenAI({ apiKey: openaiKey });
        this.logger.info('☁️ OpenAI service initialized (Modo Nube/Respaldo)');
      } else {
        this.logger.warn('OpenAI API key not found - AI features will be simulated');
      }
    }
    const replicateKey = credentials.replicate?.apiKey || process.env.REPLICATE_API_KEY;
    
    if (replicateKey) {
      this.replicate = new Replicate({ auth: replicateKey });
      this.logger.info('Replicate service initialized');
    } else {
      this.logger.warn('Replicate API key not found - advanced video generation unavailable');
    }
    
    this.elevenLabsApiKey = credentials.elevenLabs?.apiKey || process.env.ELEVENLABS_API_KEY;
    this.elevenLabsVoiceId = credentials.elevenLabs?.voiceId || process.env.ELEVENLABS_VOICE_ID;

    this.elevenLabsApiKeyValid = !!this.elevenLabsApiKey && (typeof this.elevenLabsApiKey === 'string') && this.elevenLabsApiKey.length === 51;
    if (this.elevenLabsApiKey && !this.elevenLabsApiKeyValid) {
      this.logger.warn(`ELEVENLABS_API_KEY presente pero con longitud inválida (${this.elevenLabsApiKey.length}). ElevenLabs TTS será omitido hasta corregir la clave.`);
    }

    this.ttsProvider = process.env.TTS_PROVIDER || 'openai';
    this.ttsVoice = process.env.TTS_VOICE || 'onyx';
    this.logger.info(`TTS configurado: provider=${this.ttsProvider}, voice=${this.ttsVoice}`);

    this.lowerThirdFont = this._detectFont();
  }

_detectFont() {
    const candidates = IS_WINDOWS ? [
      'C:/Windows/Fonts/ariblk.ttf',
      'C:/Windows/Fonts/arial.ttf'
    ] : [
      '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
      '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
    ];
    
    for (const f of candidates) {
      if (fsSync.existsSync(f)) {
        // En Windows, FFmpeg exige escapar los dos puntos (C\:)
        return IS_WINDOWS ? f.replace(/:/g, '\\:') : f;
      }
    }
    return null;
  }

  _getToneTTSSettings(toneVariant) {
    const out = { eleven: {}, openai: {} };
    if (!toneVariant) return out;
    const v = String(toneVariant).toLowerCase();
    if (v.includes('energetic') || v.includes('upbeat') || v.includes('excited')) {
      out.eleven = { stability: 0.18, similarity_boost: 1.0, style: 0.45 };
      out.openai = { voice: this.ttsVoice || 'alloy', prosody: { rate: 1.06 } };
    } else if (v.includes('calm') || v.includes('soft') || v.includes('gentle')) {
      out.eleven = { stability: 0.45, similarity_boost: 0.7, style: 0.06 };
      out.openai = { voice: this.ttsVoice || 'alloy', prosody: { rate: 0.94 } };
    } else if (v.includes('sales') || v.includes('persuasive') || v.includes('pitch')) {
      out.eleven = { stability: 0.25, similarity_boost: 0.95, style: 0.35 };
      out.openai = { voice: this.ttsVoice || 'alloy', prosody: { rate: 1.02 } };
    } else {
      out.eleven = { stability: 0.35, similarity_boost: 0.85, style: 0.15 };
      out.openai = { voice: this.ttsVoice || 'alloy' };
    }
    return out;
  }

_sanitizeScriptForTTS(text) {
    const pronunciationMap = [
      // Marcas y términos de tu canal
      [/\bTech Finds Amazon\b/gi, 'Tek Fainds Ámazon'],
      [/\bAmazon\b/gi,         'Ámazon'],
      [/\bgadget\b/gi,         'gádyet'],
      [/\bgadgets\b/gi,        'gádyets'],
      
      // 🔥 Traducción obligatoria para evitar tartamudeos 🔥
      [/\blink\b/gi,           'enlace'],
      [/\blinks\b/gi,          'enlaces'],
      [/enlace superior/gi,    'primer enlace'],
      [/enlace anclado/gi,     'primer enlace'],
      
      // Términos técnicos generales
      [/\bapp\b/gi,            'ap'],
      [/\bsmartphone\b/gi,     'esmart-fon'],
      [/\bSmartwatch\b/gi,     'esmart-uach'],
      [/\bsoftware\b/gi,       'sóf-uer'],
      [/\bhardware\b/gi,       'jár-uer'],
      
      // 🔥 Correcciones específicas Couchmaster 🔥
      [/\bCouchmaster\b/gi,    'Cauch-máster'],
      [/\bCycon³/gi,           'Sáicon 3'],
      [/\bCycon3\b/gi,         'Sáicon 3'],
      [/\bCycon\b/gi,          'Sáicon'],
      [/\bHorizonlight\b/gi,   'Joráison Lait'],

      // Términos técnicos existentes y nuevos
      [/\bPhilips Hue\b/gi,    'Fílips Hiu'],
      [/\bsous vide\b/gi,      'su-vid'],
      [/\bsmart home\b/gi,     'hogar inteligente'],
      [/\bfast charging\b/gi,  'carga rápida'],
      [/\btouchscreen\b/gi,    'pantalla táctil'],
      [/\bwireless\b/gi,       'inalámbrico'],
      [/\bstreaming\b/gi,      'stríming'],
      [/\bLogitech\b/gi,       'Lo-yi-tek'],
      [/\bGoPro\b/gi,          'Go-Pro'],
      [/\biPhone\b/gi,         'ai-fon'],
      [/\biPad\b/gi,           'ai-pad'],
      [/\bMacBook\b/gi,        'mac-buk'],
      [/\bAirPods\b/gi,        'er-pods'],
      [/\bYouTube\b/gi,        'Iú-tub'],
      [/\bAnova\b/gi,          'á-no-va'],
      [/\bWi-Fi\b/gi,          'wai-fai'],
      [/\bWiFi\b/gi,           'wai-fai'],
      [/\bBluetooth\b/gi,      'blu-tus'],
      [/\bHDMI\b/g,            'ache-de-eme-i'],
      [/\bUSB\b/g,             'u-ese-be'],
      [/\bRGB\b/g,             'erre-ge-be'],
      [/\bdisplay\b/gi,        'pantalla']
    ];

    let result = text;
// 🛡️ ESCUDO PREVENTIVO: Destruir basura tipográfica antes del mapeo
    // 1. Elimina todos los Emojis
    result = result.replace(/[\u{1F300}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}]/gu, '');
    // 2. Elimina símbolos matemáticos, marcas comerciales y viñetas extrañas
    result = result.replace(/[™®©³²¼½¾♦•▪►]/g, '');
    // 3. Reemplaza el ampersand por la letra "y"
    result = result.replace(/&/g, 'y');
    
    return result
      .replace(/(Section|Sección)\s*\d+[:\.\-]?/gi, '')
      .replace(/(Número|Number)\s*\d+[:\.\-]?/gi, '')
      .replace(/\[.*?\]/g, '')
      .replace(/\(.*?\)/g, '')
      .replace(/[*#]+/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

async generateKokoroTTS(text, outputPath) {
    this.logger.info(`🤖 Generando audio 100% local con Kokoro TTS...`);
    try {
      // Limpieza exhaustiva para evitar romper Python
      const safeText = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/'/g, "\\'");
      const pythonPath = '/home/ubuntu/kokoro_tts/venv/bin/python';
      const kokoroDir = '/home/ubuntu/kokoro_tts';
      
      const pythonScript = `
import sys
import soundfile as sf
sys.path.append("${kokoroDir}")
from kokoro_onnx import Kokoro

text = """${safeText}"""
output_path = "${outputPath}"

try:
    kokoro = Kokoro("${kokoroDir}/kokoro-v1.0.onnx", "${kokoroDir}/voices-v1.0.bin")
    muestras, frecuencia = kokoro.create(text, voice="Mi_voz_clonada", speed=1.0, lang="e")
    sf.write(output_path, muestras, frecuencia)
except Exception as e:
    print(f"ERROR: {str(e)}")
    sys.exit(1)
`;
      const tempScriptPath = path.join(__dirname, '..', 'temp', `kokoro_temp_${Date.now()}.py`);
      await fs.writeFile(tempScriptPath, pythonScript);

      const util = require('util');
      const execPromise = util.promisify(require('child_process').exec);
      await execPromise(`${pythonPath} ${tempScriptPath}`);
      
      if (fsSync.existsSync(tempScriptPath)) fsSync.unlinkSync(tempScriptPath);
      
      return { audioPath: outputPath, wordTimestamps: [] };
    } catch (error) {
      this.logger.error(`❌ Error en Kokoro TTS: ${error.message}`);
      throw error;
    }
  }

  async generateTTSAudio(text, outputPath, toneVariant = null, targetDuration = null) {
    this.logger.info('Generating TTS audio...');
    const cleanText = this._sanitizeScriptForTTS(text);
    const toneSettings = this._getToneTTSSettings(toneVariant);

    // 🎚️ Lógica del Interruptor
    if (process.env.USE_LOCAL_AI === 'true') {
      try {
        return await this.generateKokoroTTS(cleanText, outputPath);
      } catch (error) {
        this.logger.warn('Kokoro falló — generando silencio de respaldo...');
        return await this._generateSilenceAudioWithSimulatedTimestamps(cleanText, outputPath);
      }
    }

    // Lógica Original (ElevenLabs / OpenAI)
    if (this.ttsProvider === 'elevenlabs') {
      if (!this.elevenLabsApiKeyValid || !this.elevenLabsVoiceId) {
        this.logger.warn(`TTS_PROVIDER=elevenlabs faltante. Fallback OpenAI TTS...`);
      } else {
        try {
          return await this.generateElevenLabsTTS(cleanText, outputPath, toneSettings, targetDuration);
        } catch (error) {
          this.logger.warn('ElevenLabs falló — fallback OpenAI TTS...');
        }
      }
      if (this.openai) {
        try {
          return await this.generateOpenAITTS(cleanText, outputPath, toneSettings, targetDuration);
        } catch (error) {
          throw new Error(`TTS falló en AMBOS providers`);
        }
      }
    }

    if (this.ttsProvider === 'openai') {
      if (!this.openai) {
        this.logger.warn('TTS_PROVIDER=openai sin OPENAI_API_KEY. Fallback a ElevenLabs...');
      } else {
        try {
          return await this.generateOpenAITTS(cleanText, outputPath, toneSettings, targetDuration);
        } catch (error) {
          this.logger.warn('OpenAI TTS falló — fallback a ElevenLabs...');
        }
      }
      if (this.elevenLabsApiKey && this.elevenLabsVoiceId) {
        try {
          return await this.generateElevenLabsTTS(cleanText, outputPath, toneSettings, targetDuration);
        } catch (error) {
          return await this._generateSilenceAudioWithSimulatedTimestamps(cleanText, outputPath);
        }
      }
      return await this._generateSilenceAudioWithSimulatedTimestamps(cleanText, outputPath);
    }
    return await this._generateSilenceAudioWithSimulatedTimestamps(cleanText, outputPath);
  }

  async generateElevenLabsTTS(text, outputPath, toneSettings = null, targetDuration = null) {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${this.elevenLabsVoiceId}/with-timestamps`;
    const defaultVoiceSettings = { stability: 0.35, similarity_boost: 0.85, style: 0.15, use_speaker_boost: true };
    const elevenOverrides = (toneSettings && toneSettings.eleven) ? toneSettings.eleven : {};
    
    let response;
    try {
      response = await axios({
        method: 'POST',
        url: url,
        data: { text: text, model_id: 'eleven_multilingual_v2', voice_settings: Object.assign({}, defaultVoiceSettings, elevenOverrides) },
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'xi-api-key': this.elevenLabsApiKey },
        responseType: 'json',
        timeout: 60000,
        validateStatus: (status) => status < 500
      });
    } catch (error) {
      throw new Error(`ElevenLabs conexión falló: ${error.message}`);
    }

    if (response.status >= 400) throw new Error(`ElevenLabs rechazó la petición: ${response.status}`);
    
    const resData = response.data || {};
    const audioBase64 = resData.audio_base64 || resData.audio;
    if (!audioBase64) throw new Error(`ElevenLabs respuesta sin audio`);

    const audioBuffer = Buffer.from(audioBase64, 'base64');
    require('fs').writeFileSync(outputPath, audioBuffer);

    let safeWords = [];
    const alignment = resData.alignment || resData.normalized_alignment;
    if (alignment && Array.isArray(alignment.characters)) {
      const chars = alignment.characters;
      const starts = alignment.character_start_times_seconds;
      const ends = alignment.character_end_times_seconds;
      let currentWord = '';
      let wordStart = null;
      let wordEnd = null;
      for (let ci = 0; ci < chars.length; ci++) {
        const ch = chars[ci];
        if (ch === ' ' || ch === '\n' || ch === '\t') {
          if (currentWord.length > 0 && wordStart !== null) safeWords.push({ word: currentWord, start: wordStart, end: wordEnd });
          currentWord = ''; wordStart = null; wordEnd = null;
        } else {
          if (wordStart === null) wordStart = starts[ci];
          wordEnd = ends[ci]; currentWord += ch;
        }
      }
      if (currentWord.length > 0 && wordStart !== null) safeWords.push({ word: currentWord, start: wordStart, end: wordEnd });
    }

    if (targetDuration && outputPath) {
      try {
        const adjusted = await this._ensureAudioDuration(outputPath, safeWords, targetDuration);
        return { audioPath: adjusted.audioPath, wordTimestamps: adjusted.wordTimestamps, duration: adjusted.duration };
      } catch (err) {}
    }
    return { audioPath: outputPath, wordTimestamps: safeWords };
  }

  async generateOpenAITTS(text, outputPath, toneSettings = null, targetDuration = null) {
    const toneOpen = (toneSettings && toneSettings.openai) ? toneSettings.openai : null;
    const voice = (toneOpen && toneOpen.voice) ? toneOpen.voice : (this.ttsVoice || 'onyx');
    const speed = (toneOpen && toneOpen.speed) ? toneOpen.speed : 1.0;

    const ttsResponse = await this.openai.audio.speech.create({
      model: 'tts-1', voice: voice, input: text, response_format: 'mp3', speed: speed
    });
    const buffer = Buffer.from(await ttsResponse.arrayBuffer());
    await fs.writeFile(outputPath, buffer);

    let wordTimestamps = [];
    try {
      const audioFile = fsSync.createReadStream(outputPath);
      const whisperResponse = await this.openai.audio.transcriptions.create({
        model: 'whisper-1', file: audioFile, response_format: 'verbose_json', timestamp_granularities: ['word']
      });
      if (whisperResponse.words && Array.isArray(whisperResponse.words) && whisperResponse.words.length > 0) {
        wordTimestamps = whisperResponse.words.map(w => ({ word: w.word, start: w.start, end: w.end }));
      }
    } catch (error) {}

    if (targetDuration && outputPath) {
      try {
        const adjusted = await this._ensureAudioDuration(outputPath, wordTimestamps, targetDuration);
        return { audioPath: adjusted.audioPath, wordTimestamps: adjusted.wordTimestamps, duration: adjusted.duration };
      } catch (err) {}
    }
    return { audioPath: outputPath, wordTimestamps: wordTimestamps.length > 0 ? wordTimestamps : null };
  }

  async generateVisualAssets(prompt, style = "ethereal", count = 1) {
    if (process.env.SKIP_IMAGE_GENERATION !== 'false') return await this.simulateVisualAssets(prompt, style, count);
    try {
      if (!this.openai) return await this.simulateVisualAssets(prompt, style, count);
      const enhancedPrompt = `${prompt}, high quality, 16:9 aspect ratio`;
      const response = await this.openai.images.generate({ model: "dall-e-3", prompt: enhancedPrompt, n: count, size: "1792x1024", quality: "hd", style: "natural" });
      const localPaths = [];
      for (let i = 0; i < response.data.length; i++) {
        const imagePath = path.join(__dirname, '..', 'data', 'assets', `visual_${Date.now()}_${i}.png`);
        await this.downloadImage(response.data[i].url, imagePath);
        localPaths.push(imagePath);
      }
      return localPaths;
    } catch (error) { return await this.simulateVisualAssets(prompt, style, count); }
  }

  async downloadImage(url, outputPath) {
    const response = await axios({ method: 'GET', url: url, responseType: 'stream' });
    const writer = require('fs').createWriteStream(outputPath);
    response.data.pipe(writer);
    return new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });
  }

  async generateVideo(script, visualAssets, sectionAudioPaths, outputPath, introAudioPath = null, outroAudioPath = null, sectionWordTimestamps = [], introProductsOrder = null, introScenes = null) {
    this.logger.info('=== ARQUITECTURA LIMPIA: 3 FASES ===');
    try {
      const tempDir = path.resolve(__dirname, '..', 'temp', 'processing');
      await fs.mkdir(tempDir, { recursive: true });
      if (introAudioPath && fsSync.existsSync(introAudioPath)) {
        const paddedIntro = path.join(tempDir, `padded_intro_${Date.now()}.mp3`);
        this.logger.info(`[IntroHook] Añadiendo 4s de silencio inicial para impacto musical...`);
        await new Promise((resolve, reject) => {
          ffmpeg(introAudioPath)
            .audioFilters('adelay=4000|4000') // Retrasa la voz 4 segundos
            .output(paddedIntro)
            .on('end', resolve)
            .on('error', reject)
            .run();
        });
        introAudioPath = paddedIntro; // Sobreescribimos la variable mágica
      }
      const sections = (script && script.mainContent && script.mainContent.sections) || [];
      const validVideoExts = ['.mp4', '.mov'];
      const sectionsWithVideo = [];
      
      for (let i = 0; i < sections.length; i++) {
        const vp = sections[i].videoPath || null;
        if (vp && fsSync.existsSync(vp) && validVideoExts.includes(path.extname(vp).toLowerCase())) {
          sectionsWithVideo.push({ index: i, section: sections[i], videoPath: vp, origVideoPath: vp });
        }
      }

      if (sectionsWithVideo.length === 0) throw new Error('No hay secciones con videos válidos');

      const TAIL_TRIM = 1.5;
      for (let k = 0; k < sectionsWithVideo.length; k++) {
        const origPath = sectionsWithVideo[k].videoPath;
        const trimmedPath = path.join(tempDir, `pretrim_${k}_${path.basename(origPath)}`);
        try {
          await this._trimTail(origPath, trimmedPath, TAIL_TRIM);
          sectionsWithVideo[k].videoPath = trimmedPath;
        } catch (err) {
          sectionsWithVideo[k].videoPath = origPath;
        }
      }

      const allValidVideoPaths = sectionsWithVideo.map(s => s.videoPath);
      let introOrderedPaths = null;
      if (introProductsOrder && Array.isArray(introProductsOrder) && introProductsOrder.length > 0) {
        const rawPaths = [];
        for (const item of introProductsOrder) {
          const matched = sectionsWithVideo.find(sv => (item.filename && sv.section.filename === item.filename) || (item.id && (sv.section.productId === item.id || sv.section.filename === item.filename)));
          if (matched) rawPaths.push(matched.videoPath);
        }
        if (rawPaths.length > 0) introOrderedPaths = rawPaths;
      }

      const silentVideos = [];
      const audioParts = [];
      const productsMeta = [];

      const hasIntroAudio = introAudioPath && fsSync.existsSync(introAudioPath);
      let introAudioDur = 0;
      if (hasIntroAudio) {
        introAudioDur = await this._getMediaDuration(introAudioPath);
        const introVideoOnly = path.join(tempDir, 'intro_video_only.mp4');
        const firstProductVideo = sectionsWithVideo.length > 0 ? sectionsWithVideo[0].videoPath : null;
        await this._buildSilentIntro(allValidVideoPaths, introVideoOnly, introAudioDur, firstProductVideo, introOrderedPaths, introScenes);
        silentVideos.push(introVideoOnly);
        audioParts.push(introAudioPath);
      }

      for (let j = 0; j < sectionsWithVideo.length; j++) {
        const { index: origIdx, section, videoPath: currentVideoPath } = sectionsWithVideo[j];
        const productName = section.title || `Producto #${j + 1}`;
        const productPrice = section.precio || 'Ver enlace';
        const sectionAudio = (sectionAudioPaths && sectionAudioPaths[origIdx]) || null;
        let targetDuration = 15;
        let audioToUse = null;
        let wordTimestamps = [];

if (sectionAudio && fsSync.existsSync(sectionAudio)) {
          // Se elimina el filtro silenceremove para respetar el pacing y pausas de la IA
          const originalDuration = await this._getMediaDuration(sectionAudio);
          targetDuration = originalDuration;
          audioToUse = sectionAudio;
          
          const rawTs = Array.isArray(sectionWordTimestamps[origIdx]) ? sectionWordTimestamps[origIdx] : [];
          if (rawTs.length > 0 && originalDuration > 0) {
            wordTimestamps = rawTs;
          }
        }
        audioParts.push(audioToUse);

        const prodVideoOnly = path.join(tempDir, `prod_${j}_video_only.mp4`);
        await this._buildSilentProduct(currentVideoPath, prodVideoOnly, productName, productPrice, targetDuration);
        silentVideos.push(prodVideoOnly);
        productsMeta.push({ name: productName, price: productPrice, audioDuration: targetDuration, wordTimestamps });
      }

      const hasOutroAudio = outroAudioPath && fsSync.existsSync(outroAudioPath);
      let outroAudioDur = 0;
      if (hasOutroAudio) {
        outroAudioDur = await this._getMediaDuration(outroAudioPath);
        const outroVideoOnly = path.join(tempDir, 'outro_video_only.mp4');
        const lastProductVideo = sectionsWithVideo.length > 0 ? sectionsWithVideo[sectionsWithVideo.length - 1].videoPath : null;
        await this._buildSilentIntro(allValidVideoPaths, outroVideoOnly, outroAudioDur, lastProductVideo);
        silentVideos.push(outroVideoOnly);
        audioParts.push(outroAudioPath);
      }

      const masterVideo = path.join(tempDir, 'master_video_only.mp4');
      await this._concatVideosReencode(silentVideos, masterVideo);

      let masterWithLT = masterVideo;
      if (productsMeta.length > 0) {
        let cumOffset = hasIntroAudio ? introAudioDur : 0;
        for (const pm of productsMeta) { pm.startTime = cumOffset; cumOffset += pm.audioDuration; }
        const ltVideo = path.join(tempDir, 'master_with_lt.mp4');
        try {
          await this._applyAllLowerThirds(masterVideo, ltVideo, productsMeta);
          masterWithLT = ltVideo;
        } catch (err) {}
      }

      const validAudioParts = audioParts.filter(p => p !== null);
      const masterAudio = path.join(tempDir, 'master_audio.mp3');
      if (validAudioParts.length > 0) await this._concatAudios(validAudioParts, masterAudio);

      if (validAudioParts.length > 0) {
        await this._mergeVideoAudio(masterWithLT, masterAudio, outputPath);
      } else {
        await fs.copyFile(masterWithLT, outputPath);
      }

      for (const sv of silentVideos) await fs.unlink(sv).catch(() => {});
      await fs.unlink(masterVideo).catch(() => {});
      if (masterWithLT !== masterVideo) await fs.unlink(masterWithLT).catch(() => {});
      if (validAudioParts.length > 0) await fs.unlink(masterAudio).catch(() => {});
      for (let j = 0; j < sectionsWithVideo.length; j++) await fs.unlink(path.join(tempDir, `prod_${j}_audio_clean.mp3`)).catch(() => {});

      return outputPath;
    } catch (error) { throw error; }
  }

  _getMediaDuration(filePath) {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err) return reject(err);
        resolve(parseFloat(metadata.format.duration) || 0);
      });
    });
  }

  async _detectMotionStart(videoPath) {
    return 0; // Simplificado para estabilidad
  }

async _buildSilentIntro(videoPaths, outputPath, targetDuration, firstProductVideoPath, introOrderedPaths = null, introScenes = null) {
    const tempDir = path.resolve(__dirname, '..', 'temp', 'processing');
    await fs.mkdir(tempDir, { recursive: true });

    // 1. Preparar el pool de videos disponibles
    let sourceVideos = introOrderedPaths && introOrderedPaths.length > 0 ? [...introOrderedPaths] : [...videoPaths];
    if (!sourceVideos || sourceVideos.length === 0) sourceVideos = [firstProductVideoPath];

    // 2. Establecer el tope máximo del gancho de retención (Máximo 30 segundos o la duración del audio si es menor)
    const maxMontageDuration = Math.min(targetDuration, 30.0);
    
    let accumulatedDuration = 0;
    let clipIndex = 0;
    const snippetPaths = [];

    this.logger.info(`[IntroHook] Construyendo gancho de retención dinámico (Max: ${maxMontageDuration}s)...`);

    // 3. Extraer micro-fragmentos aleatorios hasta alcanzar el tiempo máximo
    while (accumulatedDuration < maxMontageDuration) {
      // Tomar videos de la lista de forma iterativa
      const videoToUse = sourceVideos[clipIndex % sourceVideos.length];
      
      if (fsSync.existsSync(videoToUse)) {
        try {
          const srcDur = await this._getMediaDuration(videoToUse).catch(() => 10);
          
          // Generar duración aleatoria entre 2.0 y 4.0 segundos
          let clipDur = 2.0 + (Math.random() * 2.0);
          if (clipDur > srcDur) clipDur = srcDur;
          
          // Ajustar el último clip para que no exceda el límite exacto de 30s
          if (accumulatedDuration + clipDur > maxMontageDuration) {
            clipDur = maxMontageDuration - accumulatedDuration;
          }

          // Elegir un punto de inicio completamente aleatorio dentro del video
          const maxStart = Math.max(0, srcDur - clipDur);
          const startOffset = Math.random() * maxStart;

          const snippetPath = path.join(tempDir, `intro_snippet_${clipIndex}_${Date.now()}.mp4`);
          
          // Usamos _extractSegmentWithZoom porque nos permite inyectar el punto de inicio aleatorio (startOffset)
          await this._extractSegmentWithZoom(videoToUse, snippetPath, startOffset, clipDur);
          
          snippetPaths.push(snippetPath);
          accumulatedDuration += clipDur;
        } catch (err) {
          this.logger.warn(`[IntroHook] Error procesando clip ${clipIndex}: ${err.message}`);
        }
      }
      
      clipIndex++;
      // Freno de seguridad para evitar ciclos infinitos
      if (clipIndex > 50) break;
    }

    // 4. Ensamblar los clips aleatorios
    const rawMontage = path.join(tempDir, 'intro_montage_raw.mp4');
    if (snippetPaths.length === 0) {
      await fs.copyFile(sourceVideos[0] || firstProductVideoPath, rawMontage);
    } else if (snippetPaths.length === 1) {
      await fs.copyFile(snippetPaths[0], rawMontage);
    } else {
      // Unir con una transición dinámica rápida de 0.5s
      await this._concatWithXfade(snippetPaths, rawMontage, 0.5);
    }

    // 5. Sincronizar con el audio: Si el audio dura más de 30s, el montaje de 30s se repetirá sutilmente
    await this._loopVideoSilent(rawMontage, outputPath, targetDuration);

    // Limpieza de temporales
    for (const sp of snippetPaths) await fs.unlink(sp).catch(() => {});
    await fs.unlink(rawMontage).catch(() => {});
  }
  async _createPlaceholderVideo(outputPath, title = 'Placeholder', duration = 30) {
    const fontfile = FONT_REGULAR;
    const cmd = `ffmpeg -y -f lavfi -i color=size=1920x1080:color=black -t ${duration} -vf "drawtext=fontfile='${fontfile}':text='${title}':fontcolor=white:fontsize=56:x=(w-text_w)/2:y=(h-text_h)/2" -c:v libx264 -pix_fmt yuv420p -r 30 "${outputPath}"`;
    await execAsync(cmd);
    return outputPath;
  }

  async _buildSilentProduct(videoPath, outputPath, productName, productPrice, targetDuration) {
    const tempDir = path.resolve(__dirname, '..', 'temp', 'processing');
    const MAX_CLIP_DURATION = 2.0;
    const srcDuration = await this._getMediaDuration(videoPath).catch(() => 10);
    const numSegments = Math.max(1, Math.ceil(targetDuration / MAX_CLIP_DURATION));
    const segDuration = Math.min(MAX_CLIP_DURATION, targetDuration / numSegments);
    const segmentPaths = [];

    for (let i = 0; i < numSegments; i++) {
      const offset = (srcDuration > segDuration * 2) ? (srcDuration - segDuration) * i / numSegments : 0;
      const segPath = path.join(tempDir, `${path.basename(outputPath, '.mp4')}_seg${i}.mp4`);
      await this._extractSegmentWithZoom(videoPath, segPath, offset, segDuration);
      segmentPaths.push(segPath);
    }

    const montage = path.join(tempDir, `${path.basename(outputPath, '.mp4')}_montage.mp4`);
    if (segmentPaths.length === 1) await fs.copyFile(segmentPaths[0], montage);
    else await this._concatWithXfade(segmentPaths, montage, 0.5);

    await this._syncSilentVideoToAudio(montage, outputPath, targetDuration);

    for (const sp of segmentPaths) await fs.unlink(sp).catch(() => {});
    await fs.unlink(montage).catch(() => {});
  }

  _extractSegmentWithZoom(inputPath, outputPath, startOffset, duration) {
    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .inputOptions(['-ss', startOffset.toFixed(3), '-t', duration.toFixed(3)])
.complexFilter([
          // Fondo desenfocado estático (Optimizado para renderizado rápido)
          `[0:v]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,scale=480:270,boxblur=10:10,scale=1920:1080[bg]`,
          // Primer plano estático y centrado
          `[0:v]scale=1920:1080:force_original_aspect_ratio=decrease,format=rgba,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black@0,fps=30,setpts=PTS-STARTPTS,setsar=1[fg]`,
          // Superposición
          `[bg][fg]overlay=0:0[vout]`
        ])
        .outputOptions(['-map', '[vout]', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-an', '-pix_fmt', 'yuv420p'])
        .output(outputPath)
        .on('error', reject)
        .on('end', () => resolve(outputPath))
        .run();
    });
  }

  _trimTail(inputPath, outputPath, trimSeconds) {
    return new Promise(async (resolve, reject) => {
      const srcDur = await this._getMediaDuration(inputPath);
      if (srcDur <= trimSeconds + 1) {
        await fs.copyFile(inputPath, outputPath);
        return resolve(outputPath);
      }
      ffmpeg(inputPath).inputOptions(['-t', (srcDur - trimSeconds).toFixed(3)]).outputOptions(['-c', 'copy', '-an']).output(outputPath).on('error', reject).on('end', () => resolve(outputPath)).run();
    });
  }

  _extractSnippet(inputPath, outputPath, duration) {
    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .inputOptions(['-ss', '0', '-t', duration.toFixed(3)])
.complexFilter([
          `[0:v]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,scale=480:270,boxblur=10:10,scale=1920:1080[bg]`,
          `[0:v]scale=1920:1080:force_original_aspect_ratio=decrease,format=rgba,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black@0,fps=30,setpts=PTS-STARTPTS,setsar=1[fg]`,
          `[bg][fg]overlay=0:0[vout]`
        ])
        .outputOptions(['-map', '[vout]', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-an', '-pix_fmt', 'yuv420p'])
        .output(outputPath)
        .on('error', reject)
        .on('end', () => resolve(outputPath))
        .run();
    });
  }

  async _isVertical(videoPath) {
    return false; // Simplificado
  }

  async _syncSilentVideoToAudio(videoPath, outputPath, targetDuration) {
    const curDur = await this._getMediaDuration(videoPath).catch(() => targetDuration);
    const diff = targetDuration - curDur;

    return new Promise((resolve, reject) => {
      if (diff > 0.05) {
        ffmpeg().input(videoPath).inputOptions(['-stream_loop', '-1']).outputOptions(['-t', targetDuration.toFixed(3), '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-an', '-pix_fmt', 'yuv420p']).output(outputPath).on('error', reject).on('end', () => resolve(outputPath)).run();
      } else {
        ffmpeg().input(videoPath).outputOptions(['-t', targetDuration.toFixed(3), '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-an', '-pix_fmt', 'yuv420p']).output(outputPath).on('error', reject).on('end', () => resolve(outputPath)).run();
      }
    });
  }

  _loopVideoSilent(videoPath, outputPath, targetDuration) {
    return new Promise((resolve, reject) => {
      ffmpeg().input(videoPath).inputOptions(['-stream_loop', '-1']).outputOptions(['-t', targetDuration.toFixed(3), '-map', '0:v', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-an', '-pix_fmt', 'yuv420p']).output(outputPath).on('error', reject).on('end', () => resolve(outputPath)).run();
    });
  }

  async _concatWithXfade(filePaths, outputPath, transitionDur = 0.25) {
    if (filePaths.length === 1) {
      await fs.copyFile(filePaths[0], outputPath);
      return outputPath;
    }
    const durations = await Promise.all(filePaths.map(p => this._getMediaDuration(p).catch(() => 2.0)));
    const n = filePaths.length;
    const td = Math.min(transitionDur, Math.min(...durations) * 0.4);
    const filterParts = [];
    const normalizedLabels = filePaths.map((_, i) => {
      filterParts.push(`[${i}:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p,setpts=PTS-STARTPTS[v${i}_norm]`);
      return { video: `[v${i}_norm]` };
    });
    let prevVideoLabel = normalizedLabels[0].video;
    let cumulativeDur = 0;
    for (let i = 0; i < n - 1; i++) {
      cumulativeDur += durations[i];
      const offset = Math.max(0, cumulativeDur - (i + 1) * td);
      filterParts.push(`${prevVideoLabel}${normalizedLabels[i + 1].video}xfade=transition=fade:duration=${td.toFixed(3)}:offset=${offset.toFixed(3)}[xf${i}]`);
      prevVideoLabel = `[xf${i}]`;
    }
    const totalDur = durations.reduce((a, b) => a + b, 0) - (n - 1) * td;
    return new Promise((resolve, reject) => {
      const cmd = ffmpeg();
      filePaths.forEach(p => cmd.input(p));
      cmd.complexFilter(filterParts.join(';')).outputOptions(['-map', prevVideoLabel, '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p', '-an', '-t', totalDur.toFixed(3)]).output(outputPath).on('error', reject).on('end', () => resolve(outputPath)).run();
    });
  }

  async _concatVideosReencode(filePaths, outputPath) {
    return new Promise((resolve, reject) => {
      const cmd = ffmpeg();
      filePaths.forEach(p => cmd.input(p));
      const videoFilters = filePaths.map((_, i) => `[${i}:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p,setpts=PTS-STARTPTS[v${i}_norm]`).join(';');
      const normalizedVideoInputs = filePaths.map((_, i) => `[v${i}_norm]`).join('');
      const concatFilter = `${videoFilters};${normalizedVideoInputs}concat=n=${filePaths.length}:v=1:a=0[vout]`;
      cmd.complexFilter([concatFilter]).outputOptions(['-map', '[vout]', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart']).output(outputPath).on('error', reject).on('end', () => resolve(outputPath)).run();
    });
  }

  _concatAudios(audioPaths, outputPath) {
    return new Promise((resolve, reject) => {
      const cmd = ffmpeg();
      audioPaths.forEach(p => cmd.input(p));
      const concatFilter = audioPaths.map((_, i) => `[${i}:a]`).join('') + `concat=n=${audioPaths.length}:v=0:a=1[aout]`;
      cmd.complexFilter([concatFilter]).outputOptions(['-map', '[aout]', '-c:a', 'libmp3lame', '-ac', '2', '-ar', '44100', '-b:a', '192k', '-vn']).output(outputPath).on('error', reject).on('end', () => resolve(outputPath)).run();
    });
  }

  async _removeSilence(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
      ffmpeg(inputPath).audioFilters(['silenceremove=stop_periods=-1:stop_duration=0.3:stop_threshold=-35dB']).audioCodec('libmp3lame').outputOptions(['-ac', '2', '-ar', '44100', '-b:a', '192k', '-vn']).output(outputPath).on('error', reject).on('end', () => resolve(outputPath)).run();
    });
  }

  async _ensureAudioDuration(inputPath, wordTimestamps = [], targetDuration) {
    const origDur = await this._getMediaDuration(inputPath).catch(() => 0);
    const tempo = origDur / targetDuration;
    if (Math.abs(tempo - 1.0) < 0.005) return { audioPath: inputPath, wordTimestamps, duration: origDur };
    
    const tempDir = path.resolve(__dirname, '..', 'temp', 'processing');
    const outPath = path.join(tempDir, `stretched_${Date.now()}.mp3`);
    
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath).audioCodec('libmp3lame').audioFilters([`atempo=${tempo.toFixed(6)}`, 'loudnorm=I=-16:TP=-1.5:LRA=11']).outputOptions(['-ac', '2', '-ar', '44100', '-b:a', '192k']).output(outPath).on('error', reject).on('end', resolve).run();
    });
    return { audioPath: outPath, wordTimestamps, duration: targetDuration };
  }

  _escapeDrawText(text) {
    return text.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, '\u2019').replace(/\[/g, '\\[').replace(/\]/g, '\\]').replace(/;/g, '\\;').replace(/%/g, '%%');
  }

_applyAllLowerThirds(inputPath, outputPath, productsMeta) {
    return new Promise((resolve, reject) => {
      // Tonos exactos para coincidir con las imágenes de referencia
      const BORDER_COLOR = '#FF9900'; // Naranja más amarillo/dorado
      const leftX = 58;
      const bottomMargin = 72;
      const boxGap = 14; 
      const NAME_FS = 38;
      const PRICE_FS = 38;
      const STORE_FS = 36;
      
      const safeT = (val, fallback) => (typeof val === 'number' && isFinite(val)) ? val : fallback;
      let filters = '[0:v]';

      for (let i = 0; i < productsMeta.length; i++) {
        const pm = productsMeta[i];
        const segStart = safeT(pm.startTime, 0);
        const dur = safeT(pm.audioDuration, 15);
        const segEnd = segStart + dur;

        const rawName = pm.name.toUpperCase();
        const rawPrice = `PRECIO: ${pm.price}`;
        const cleanName = '   ' + this._escapeDrawText(rawName) + '   ';
        const cleanPrice = '   ' + this._escapeDrawText(rawPrice) + '   ';
        // Ajustado exactamente como en tu imagen, sin el ".com"
        const cleanStore = '   Disponibles En Amazon   '; 

        const LT_DURATION = 5.0;
        let nameStart = segStart + 0.2;
        let nameEnd = Math.min(nameStart + LT_DURATION, segEnd);
        
        // Tiempos por defecto corregidos (Math.max garantiza que aparezcan al final si falla la IA)
        let priceStart = Math.max(nameEnd + 0.3, segEnd - 5.0);
        let storeStart = Math.max(priceStart + 1.0, segEnd - 3.0);

        // 🔥 SINCRONÍA INTELIGENTE CON TIMESTAMPS DE LA IA (BÚSQUEDA INVERSA) 🔥
        if (pm.wordTimestamps && pm.wordTimestamps.length > 0) {
          const words = pm.wordTimestamps;
          
          // 1. Sincronizar el PRECIO (findLastIndex busca la última mención en el CTA)
          const dolaresIdx = words.findLastIndex(w => w.word.toLowerCase().includes('dólar') || w.word.toLowerCase().includes('dolar'));
          if (dolaresIdx !== -1) {
            // Atrapa el número justo antes de la palabra "dólares"
            const targetWord = words[Math.max(0, dolaresIdx - 1)];
            priceStart = segStart + targetWord.start;
          }

          // 2. Sincronizar la TIENDA (findLastIndex busca el llamado a la acción final)
          const amazonIdx = words.findLastIndex(w => w.word.toLowerCase().includes('amazon'));
          if (amazonIdx !== -1) {
            storeStart = segStart + words[amazonIdx].start;
          }
          
          // Orden lógico de seguridad (evita superposiciones si la IA habla muy rápido)
          if (priceStart <= nameStart) priceStart = nameStart + 1.5;
          if (storeStart <= priceStart) storeStart = priceStart + 1.5;
        }

        let priceEnd = Math.min(priceStart + LT_DURATION, segEnd);
        let storeEnd = Math.min(storeStart + LT_DURATION, segEnd);

        // 🔥 EL SECRETO DEL BORDE FINO 🔥
        // La caja exterior mide 18px y la interior 14px = Un borde elegante de 4px
        const BORDER_BW = 18; 
        const BG_BW = 14;     
        const STORE_BW = 14;  // La tienda usará solo esto (sin borde naranja)
        
        const nameElH  = Math.round(NAME_FS  * 1.15) + (BORDER_BW * 2);
        const priceElH = Math.round(PRICE_FS * 1.15) + (BORDER_BW * 2);
        const storeElH = Math.round(STORE_FS * 1.15) + (STORE_BW * 2);

        const storeYVal = bottomMargin + storeElH;
        const priceYVal = bottomMargin + storeElH + boxGap + priceElH;
        const nameYVal  = bottomMargin + storeElH + boxGap + priceElH + boxGap + nameElH;
        const storeY = `h-${storeYVal}`;
        const priceY = `h-${priceYVal}`;
        const nameY  = `h-${nameYVal}`;

        const fontParam = this.lowerThirdFont ? `fontfile='${this.lowerThirdFont}':` : '';

        const nameEn  = `between(t\\,${nameStart.toFixed(3)}\\,${nameEnd.toFixed(3)})`;
        const priceEn = `between(t\\,${priceStart.toFixed(3)}\\,${priceEnd.toFixed(3)})`;
        const storeEn = `between(t\\,${storeStart.toFixed(3)}\\,${storeEnd.toFixed(3)})`;

        const SLIDE_DUR = 0.4;
        const animX = (start) => `if(lte(t\\,${(start + SLIDE_DUR).toFixed(3)})\\,-tw+(tw+${leftX})*(t-${start.toFixed(3)})/${SLIDE_DUR.toFixed(1)}\\,${leftX})`;

        filters +=
          // 1. PRODUCTO: Borde exterior naranja (4px visibles) + Caja negra semi-translúcida + Texto
          `drawtext=text='${cleanName}':${fontParam}fontsize=${NAME_FS}:fontcolor=${BORDER_COLOR}:box=1:boxcolor=${BORDER_COLOR}@0.9:boxborderw=${BORDER_BW}:x='${animX(nameStart)}':y=${nameY}:enable='${nameEn}',` +
          `drawtext=text='${cleanName}':${fontParam}fontsize=${NAME_FS}:fontcolor=white:box=1:boxcolor=black@0.8:boxborderw=${BG_BW}:x='${animX(nameStart)}':y=${nameY}:enable='${nameEn}',` +
          
          // 2. PRECIO: Borde exterior naranja (4px visibles) + Caja negra semi-translúcida + Texto
          `drawtext=text='${cleanPrice}':${fontParam}fontsize=${PRICE_FS}:fontcolor=${BORDER_COLOR}:box=1:boxcolor=${BORDER_COLOR}@0.9:boxborderw=${BORDER_BW}:x='${animX(priceStart)}':y=${priceY}:enable='${priceEn}',` +
          `drawtext=text='${cleanPrice}':${fontParam}fontsize=${PRICE_FS}:fontcolor=white:box=1:boxcolor=black@0.8:boxborderw=${BG_BW}:x='${animX(priceStart)}':y=${priceY}:enable='${priceEn}',` +
          
          // 3. TIENDA: SIN borde exterior, solo caja negra con texto verde vibrante
          `drawtext=text='${cleanStore}':${fontParam}fontsize=${STORE_FS}:fontcolor=#54FF54:box=1:boxcolor=black@0.8:boxborderw=${STORE_BW}:x='${animX(storeStart)}':y=${storeY}:enable='${storeEn}'`;

        filters += (i < productsMeta.length - 1) ? ',' : '[vout]';
      }

      ffmpeg(inputPath)
        .complexFilter([filters])
        .outputOptions(['-map', '[vout]', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-an', '-pix_fmt', 'yuv420p'])
        .output(outputPath)
        .on('error', reject)
        .on('end', () => resolve(outputPath))
        .run();
    });
  }
  async _generateSilenceAudioWithSimulatedTimestamps(text, outputPath) {
    const totalDuration = Math.max(text.split(/\s+/).length * 0.6, 2.0);
    return new Promise((resolve, reject) => {
      ffmpeg().input('anullsrc=r=44100:cl=mono').inputOptions(['-f', 'lavfi', '-t', totalDuration.toFixed(3)]).audioCodec('libmp3lame').audioBitrate('128k').output(outputPath).on('error', reject).on('end', () => resolve({audioPath: outputPath, wordTimestamps: []})).run();
    });
  }

  async simulateVisualAssets(prompt, style, count) {
    return [];
  }

// ═══════════════════════════════════════════════════════════════════
  // GENERATE INTRO SHORT (Tráiler Dinámico Vertical para redirección)
  // ═══════════════════════════════════════════════════════════════════
  async generateIntroShort(introAudioPath_unused, sourceVideoPath, outputDir, productionId, originalVideoPaths = []) {
    return new Promise(async (resolve, reject) => {
      try {
        fsSync.mkdirSync(outputDir, { recursive: true });
        const outputPath = path.join(outputDir, `${productionId}_intro_short.mp4`);
        const tempDir = path.resolve(__dirname, '..', 'temp', 'processing');
        fsSync.mkdirSync(tempDir, { recursive: true });

        this.logger.info(`[IntroShort] 1. Generando nuevo guion y voz exclusiva para el Short...`);

// 1. Crear un guion dinámico para el tráiler usando OpenAI (~30 segundos)
        let trailerText = "";
        if (this.openai) {
          try {
            this.logger.info(`[IntroShort] Solicitando guion dinámico a OpenAI (~30s)...`);
            const response = await this.openai.chat.completions.create({
              model: 'gpt-4o', // O usa 'gpt-4o-mini' para mayor velocidad/menor costo
              messages: [
                {
                  role: 'system',
                  content: 'Eres un guionista experto en YouTube Shorts para el canal "Tech Finds Amazon". Tu objetivo es retener la atención, generar curiosidad extrema y redirigir el tráfico hacia un video largo usando la función "Video Relacionado".'
                },
                {
                  role: 'user',
                  content: 'Escribe un guion dinámico y muy profesional para la introducción de un Short. Debe durar aproximadamente 30 segundos hablado (entre 65 y 75 palabras). Genera urgencia sobre los descubrimientos tecnológicos de Amazon que se verán e invita explícitamente al espectador a hacer clic en el "enlace al video relacionado justo aquí abajo" para ver el top completo. Devuelve ÚNICAMENTE el texto hablado, sin emojis, sin hashtags y sin acotaciones.'
                }
              ],
              temperature: 0.7,
              max_tokens: 150
            });
            trailerText = response.choices[0].message.content.trim();
            this.logger.info(`[IntroShort] Guion de OpenAI generado con éxito: "${trailerText.substring(0, 50)}..."`);
          } catch (e) {
            this.logger.warn(`[IntroShort] Error con OpenAI, usando guion de respaldo: ${e.message}`);
          }
        }

        // Fallback de seguridad por si OpenAI falla o no está configurado
        if (!trailerText) {
          const ctaTemplates = [
            "Estos son algunos de los mejores gadgets de Amazon de este mes. Pero el ganador indiscutible te va a dejar sin palabras. Toca el enlace al video relacionado justo aquí abajo para ver el top completo.",
            "¿Buscando los mejores descubrimientos de Amazon? Te mostramos un adelanto, pero el gadget número uno está en el video completo. Haz clic abajo para descubrirlo."
          ];
          trailerText = ctaTemplates[Math.floor(Math.random() * ctaTemplates.length)];
        }

        const rawTrailerVoice = path.join(tempDir, `${productionId}_raw_trailer_voice.mp3`);

        // Generar la voz usando la función existente
        await this.generateTTSAudio(trailerText, rawTrailerVoice, 'energetic');

        // 2. Añadir 4 segundos de silencio al inicio de esta nueva voz
        const paddedTrailerVoice = path.join(tempDir, `${productionId}_padded_trailer_voice.mp3`);
        this.logger.info(`[IntroShort] Añadiendo 4s de silencio inicial al nuevo audio...`);
        await new Promise((res, rej) => {
          ffmpeg(rawTrailerVoice)
            .audioFilters('adelay=4000|4000')
            .output(paddedTrailerVoice)
            .on('end', res)
            .on('error', rej)
            .run();
        });

        this.logger.info(`[IntroShort] ═══ INICIANDO ENSAMBLE (CORTES 2-4s + FONDO DESENFOCADO) ═══`);

        // 3. Calcular duración objetivo basándonos en la voz + silencios
        const audioDur = await this._getMediaDuration(paddedTrailerVoice).catch(() => 30);
        const targetVideoDuration = Math.min(Math.max(audioDur, 28), 40);

        let effectiveSource = null;
        const verticalClips = [];
        let accumulatedDuration = 0;
        let clipIndex = 0;

        // Usar los clips originales descargados para los cortes dinámicos
        const sourceVideos = (originalVideoPaths && originalVideoPaths.length > 0) ? originalVideoPaths : [sourceVideoPath];

        // 4. Extraer recortes aleatorios de los videos
        while (accumulatedDuration < targetVideoDuration) {
          const videoToUse = sourceVideos[clipIndex % sourceVideos.length];
          
          if (fsSync.existsSync(videoToUse)) {
            try {
              const srcDur = await this._getMediaDuration(videoToUse).catch(() => 10);
              let clipDur = 2.0 + (Math.random() * 2.0);
              if (clipDur > srcDur) clipDur = srcDur;
              if (accumulatedDuration + clipDur > targetVideoDuration) clipDur = targetVideoDuration - accumulatedDuration;

              const maxStart = Math.max(0, srcDur - clipDur);
              const startOffset = Math.random() * maxStart;

              const tempRawClip = path.join(tempDir, `${productionId}_raw_intro_${clipIndex}.mp4`);
              await new Promise((res, rej) => {
                ffmpeg(videoToUse)
                  .inputOptions(['-ss', startOffset.toFixed(3), '-t', clipDur.toFixed(3)])
                  .outputOptions(['-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-an'])
                  .output(tempRawClip).on('end', () => res(tempRawClip)).on('error', rej).run();
              });

              // Mantenemos tus textos estáticos originales de diseño (¿CONOCIAS ESTO? y TECH FINDS AMAZON)
              this.logger.info(`[IntroShort] Aplicando diseño y fondo desenfocado al clip ${clipIndex + 1}...`);
              const tempVertClip = path.join(tempDir, `${productionId}_vert_intro_${clipIndex}.mp4`);
              const filterComplex = `[0:v]fps=30,scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,scale=270:480,boxblur=10:10,scale=1080:1920,colorchannelmixer=rr=0.6:gg=0.6:bb=0.6[bg];[0:v]fps=30,scale=1500:-1[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,drawtext=fontfile='${FONT_BOLD}':text='¿CONOCIAS ESTO?':fontcolor=white:bordercolor=#198038:borderw=5:fontsize=75:x=(W-text_w)/2:y=300,drawtext=fontfile='${FONT_REGULAR}':text='TECH FINDS AMAZON':fontcolor=white:alpha=0.6:fontsize=35:x=(W-text_w)/2:y=H-500,setsar=1,format=yuv420p[v]`;

              await new Promise((res, rej) => {
                ffmpeg(tempRawClip)
                  .complexFilter(filterComplex)
                  .outputOptions(['-map', '[v]', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-an', '-pix_fmt', 'yuv420p'])
                  .output(tempVertClip).on('end', () => res(tempVertClip)).on('error', rej).run();
              });

              verticalClips.push(tempVertClip);
              accumulatedDuration += clipDur;
              fsSync.unlinkSync(tempRawClip);
            } catch (err) {
              this.logger.warn(`[IntroShort] Error procesando clip aleatorio ${clipIndex}: ${err.message}`);
            }
          }
          clipIndex++;
          if (clipIndex > 50) break;
        }

        // 5. Unir los clips
        if (verticalClips.length > 0) {
          const montagePath = path.join(tempDir, `${productionId}_smart_montage.mp4`);
          const listPath = path.join(tempDir, `${productionId}_concat_list.txt`);
          const listContent = verticalClips.map(vp => `file '${vp.replace(/'/g, "'\\''")}'`).join('\n');
          fsSync.writeFileSync(listPath, listContent);

          try {
            await new Promise((res, rej) => {
              ffmpeg().input(listPath).inputOptions(['-f', 'concat', '-safe', '0'])
                .outputOptions(['-c', 'copy']).output(montagePath)
                .on('end', () => res(montagePath)).on('error', rej).run();
            });
            effectiveSource = montagePath;
          } catch (e) {
            effectiveSource = verticalClips[0];
          }
        }

        // Fallback si la unión falla
        if (!effectiveSource || !fsSync.existsSync(effectiveSource)) {
          const fallbackPath = path.join(tempDir, `${productionId}_vert_fallback.mp4`);
          await new Promise((res, rej) => {
            ffmpeg(sourceVideoPath)
              .complexFilter([`[0:v]fps=30,scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,scale=270:480,boxblur=10:10,scale=1080:1920,colorchannelmixer=rr=0.6:gg=0.6:bb=0.6[bg];[0:v]fps=30,scale=1500:-1[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,drawtext=fontfile='${FONT_BOLD}':text='¿CONOCIAS ESTO?':fontcolor=white:bordercolor=#198038:borderw=5:fontsize=75:x=(W-text_w)/2:y=300,drawtext=fontfile='C\\:/Windows/Fonts/arial.ttf':text='TECH FINDS AMAZON':fontcolor=white:alpha=0.6:fontsize=35:x=(W-text_w)/2:y=H-500,setsar=1,format=yuv420p[v]`])
              .outputOptions(['-map', '[v]', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-an'])
              .output(fallbackPath)
              .on('error', rej)
              .on('end', () => res(fallbackPath))
              .run();
          });
          effectiveSource = fallbackPath;
        }

        // 6. Añadir Música de Fondo Aleatoria
        let finalAudioPath = paddedTrailerVoice;
        const sfxDir = path.resolve(__dirname, '..', 'data', 'sfx');

        if (fsSync.existsSync(sfxDir)) {
          const files = fsSync.readdirSync(sfxDir);
          const validTracks = files.filter(f => f.toLowerCase().startsWith('bmg') && f.toLowerCase().endsWith('.mp3'));

          if (validTracks.length > 0) {
            const randomBgm = path.join(sfxDir, validTracks[Math.floor(Math.random() * validTracks.length)]);
            const mixedAudioPath = path.join(tempDir, `${productionId}_intro_mixed_audio.m4a`);

            const fadeStart = Math.max(0, audioDur - 3);
            const bgmVol = parseFloat(process.env.BGM_VOLUME || '0.15');

            await new Promise((res, rej) => {
              ffmpeg()
                .input(paddedTrailerVoice)
                .input(randomBgm)
                .inputOptions(['-stream_loop', '-1'])
                .complexFilter([
                  `[0:a]volume=1.8[voice]`,
                  `[1:a]volume=${bgmVol.toFixed(3)},afade=t=out:st=${fadeStart.toFixed(3)}:d=3[bgm]`,
                  `[voice][bgm]amix=inputs=2:duration=first:dropout_transition=2[aout]`
                ])
                .outputOptions(['-map', '[aout]', '-c:a', 'aac', '-ac', '2', '-ar', '44100', '-b:a', '192k'])
                .output(mixedAudioPath)
                .on('error', rej)
                .on('end', res)
                .run();
            });
            finalAudioPath = mixedAudioPath;
          }
        }

        // 7. Render final con Emoji apuntando en los últimos 5 segundos
        const finalAudioDur = await this._getMediaDuration(finalAudioPath).catch(() => 30);
        const emojiStart = Math.max(0, finalAudioDur - 5);

        const cmd = ffmpeg()
          .input(effectiveSource)
          .inputOptions(['-stream_loop', '-1'])
          .input(finalAudioPath)
          .complexFilter([
            `[0:v]drawtext=fontfile='${FONT_EMOJI}':text='👇 VIDEO COMPLETO AQUÍ 👇':fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=15:fontsize=65:x=(W-text_w)/2:y=H-400:enable='gte(t,${emojiStart.toFixed(2)})'[vout]`
          ])
          .outputOptions([
            '-map', '[vout]',
            '-map', '1:a',
            '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
            '-c:a', 'aac', '-b:a', '192k',
            '-shortest',
            '-y'
          ])
          .output(outputPath);

        cmd.on('end', async () => {
          if (finalAudioPath !== paddedTrailerVoice) fsSync.unlink(finalAudioPath, () => {});
          for (const clip of verticalClips) fsSync.unlink(clip, () => {});
          if (effectiveSource && effectiveSource.includes('temp')) fsSync.unlink(effectiveSource, () => {});
          const listTemp = path.join(tempDir, `${productionId}_concat_list.txt`);
          if (fsSync.existsSync(listTemp)) fsSync.unlink(listTemp, () => {});

          resolve(outputPath);
        });

        cmd.on('error', reject);
        cmd.run();

      } catch (error) {
        reject(error);
      }
    });
  }

// ═══════════════════════════════════════════════════════════════════
  // REPARADO: MERGE WITH BGM (Mezclar audio + música de fondo dinámica)
  // ═══════════════════════════════════════════════════════════════════
  _mergeVideoAudio(videoPath, audioPath, outputPath) {
    const sfxDir = path.resolve(__dirname, '..', 'data', 'sfx');
    let bgmPath = null;
    let hasBgm = false;

    // Lógica de selección dinámica de pista
    if (fsSync.existsSync(sfxDir)) {
      const files = fsSync.readdirSync(sfxDir);
      // Filtra solo los archivos que empiecen con 'bmg' y sean mp3
      const validTracks = files.filter(f => f.toLowerCase().startsWith('bmg') && f.toLowerCase().endsWith('.mp3'));
      
      if (validTracks.length > 0) {
        // Selecciona una pista aleatoriamente
        const randomIndex = Math.floor(Math.random() * validTracks.length);
        bgmPath = path.join(sfxDir, validTracks[randomIndex]);
        hasBgm = true;
        this.logger.info(`🎵 Pista de fondo seleccionada aleatoriamente: ${validTracks[randomIndex]}`);
      }
    }

    if (hasBgm) {
      this.logger.info(`BGM detectado → mezclando TTS + música de fondo`);
      return this._mergeWithBGM(videoPath, audioPath, bgmPath, outputPath);
    }

    this.logger.warn(`⚠️ No se encontraron pistas 'bmg*.mp3' en data/sfx. Procesando sin música de fondo.`);
    return new Promise((resolve, reject) => {
      ffmpeg()
        .input(videoPath)
        .input(audioPath)
        .outputOptions([
          '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
          '-r', '30', '-c:a', 'aac', '-ac', '2', '-ar', '44100', '-b:a', '192k',
          '-movflags', '+faststart'
        ])
        .output(outputPath)
        .on('error', reject)
        .on('end', () => resolve(outputPath))
        .run();
    });
  }
  async _mergeWithBGM(videoPath, audioPath, bgmPath, outputPath) {
    const tempDir = path.resolve(__dirname, '..', 'temp', 'processing');
    await fs.mkdir(tempDir, { recursive: true });

    const audioDur = await this._getMediaDuration(audioPath);
    const fadeStart = Math.max(0, audioDur - 3);
    const mixedAudio = path.join(tempDir, `mixed_audio_${Date.now()}.m4a`);

const bgmVolume = parseFloat(process.env.BGM_VOLUME || '0.15'); // Ajustado para evitar picos
    
    // 🔥 AMPLIFICADOR DE VOZ: 1.8 = 180% del volumen original
    const voiceVolume = 1.8; 

    const audioFilters = [
      `[0:a]volume=${voiceVolume}[voice]`, // Aumenta el volumen de la narración
      `[1:a]volume=${bgmVolume.toFixed(3)},afade=t=out:st=${fadeStart.toFixed(3)}:d=3[bgm]`,
      `[voice][bgm]amix=inputs=2:duration=first:dropout_transition=2[aout]`
    ];

    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(audioPath)
        .input(bgmPath)
        .inputOptions(['-stream_loop', '-1'])
        .complexFilter(audioFilters)
        .outputOptions(['-map', '[aout]', '-c:a', 'aac', '-ac', '2', '-ar', '44100', '-b:a', '192k'])
        .output(mixedAudio)
        .on('error', reject)
        .on('end', resolve)
        .run();
    });

    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(videoPath)
        .input(mixedAudio)
        .outputOptions([
          '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
          '-r', '30', '-c:a', 'aac', '-ac', '2', '-ar', '44100', '-b:a', '192k',
          '-movflags', '+faststart'
        ])
        .output(outputPath)
        .on('error', reject)
        .on('end', resolve)
        .run();
    });

    await fs.unlink(mixedAudio).catch(() => {});
  }
  async _analyzeSubjectPosition(videoPath) {
    try {
      const tempDir = path.join(__dirname, '..', 'temp', 'vision-analysis');
      fsSync.mkdirSync(tempDir, { recursive: true });
      const frameFile = path.join(tempDir, `frame_${Date.now()}.jpg`);
      
      const duration = await new Promise((resolve, reject) => {
        ffmpeg.ffprobe(videoPath, (err, metadata) => {
          if (err) reject(err);
          else resolve(metadata.format.duration || 30);
        });
      });
      
      const midpoint = Math.floor(duration / 2);
      
      await new Promise((resolve, reject) => {
        ffmpeg(videoPath)
          .seekInput(midpoint)
          .frames(1)
          .output(frameFile)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });
      
      if (!fsSync.existsSync(frameFile)) return 0.5;
      
      const frameBuffer = await fs.readFile(frameFile);
      const frameBase64 = frameBuffer.toString('base64');
      
      // Formato de payload corregido estrictamente para OpenAI gpt-4o
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        max_tokens: 200,
        messages: [
          {
            role: 'system',
            content: 'Analiza esta imagen y encuentra el gadget o producto tecnológico principal. Devuelve ÚNICAMENTE un JSON válido con la propiedad "center_x_percentage" entre 0.0 y 1.0.'
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Analiza esta imagen y devuelve SOLO el JSON con center_x_percentage.'
              },
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/jpeg;base64,${frameBase64}`
                }
              }
            ]
          }
        ]
      });
      
      try { await fs.unlink(frameFile); } catch (e) {}
      
      const content = response.choices[0]?.message?.content || '{}';
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return 0.5;
      
      const result = JSON.parse(jsonMatch[0]);
      const centerPercent = parseFloat(result.center_x_percentage);
      
      if (isNaN(centerPercent) || centerPercent < 0 || centerPercent > 1) return 0.5;
      return centerPercent;
      
    } catch (error) {
      this.logger.warn(`[Vision] Error analizando posición, usando centro por defecto: ${error.message}`);
      return 0.5;
    }
  }

  async generateProductShort(productVideoPath, productAudioPath, outputDir, productId) {
    return new Promise(async (resolve, reject) => {
      try {
        if (!productVideoPath || !fsSync.existsSync(productVideoPath)) return reject(new Error('Video no encontrado'));
        if (!productAudioPath || !fsSync.existsSync(productAudioPath)) return reject(new Error('Audio no encontrado'));
        
        fsSync.mkdirSync(outputDir, { recursive: true });
        const outputPath = path.join(outputDir, `${productId}_short.mp4`);
        const tempDir = path.resolve(__dirname, '..', 'temp', 'processing');
        fsSync.mkdirSync(tempDir, { recursive: true });

       this.logger.info(`[ProductShorts] Iniciando motor de recortes dinámicos para ${productId}...`);

// 👇 INYECCIÓN: Crear audio CTA dinámico y concatenarlo al audio del producto 👇
        let ctaText = "";
        if (this.openai) {
          try {
            this.logger.info(`[ProductShorts] Solicitando CTA dinámico a OpenAI para ${productId}...`);
            const response = await this.openai.chat.completions.create({
              model: 'gpt-4o',
              messages: [
                {
                  role: 'system',
                  content: 'Eres un guionista experto en marketing de afiliados y YouTube Shorts para "Tech Finds Amazon".'
                },
                {
                  role: 'user',
                  content: 'Escribe un Call to Action (llamada a la acción) de cierre muy breve, persuasivo y profesional. Máximo 15 a 20 palabras. Dile al espectador que acaba de ver este gadget que si quiere ver más, toque el "enlace al video relacionado aquí abajo" para ver la lista completa. Solo devuelve el texto hablado, sin emojis ni notas.'
                }
              ],
              temperature: 0.8, // Ligeramente más alto para mayor variedad en cada producto
              max_tokens: 60
            });
            ctaText = response.choices[0].message.content.trim();
          } catch (e) {
            this.logger.warn(`[ProductShorts] Error con OpenAI, usando CTA de respaldo: ${e.message}`);
          }
        }

        // Fallback de seguridad
        if (!ctaText) {
          ctaText = "Si quieres descubrir más gadgets increíbles como este, toca el enlace al video relacionado justo aquí abajo.";
        }

        const ctaAudioPath = path.join(tempDir, `${productId}_cta.mp3`);
        await this.generateTTSAudio(ctaText, ctaAudioPath, 'energetic');
        
        const combinedAudioPath = path.join(tempDir, `${productId}_combined_audio.mp3`);
        await this._concatAudios([productAudioPath, ctaAudioPath], combinedAudioPath);
        productAudioPath = combinedAudioPath; // El sistema ahora usará el audio extendido
        // 👆 FIN INYECCIÓN 👆

        // 1. Obtener la duración exacta que necesitamos cubrir basándonos en el audio extendido
        const audioDur = await this._getMediaDuration(productAudioPath).catch(() => 15);
        const srcDur = await this._getMediaDuration(productVideoPath).catch(() => 10);
        
        const targetVideoDuration = audioDur;
        let accumulatedDuration = 0;
        let clipIndex = 0;
        const verticalClips = [];

        // 2. Filtro con fondo desenfocado optimizado, zoom y textos configurados
        const filterComplex = `[0:v]fps=30,scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,scale=270:480,boxblur=10:10,scale=1080:1920,fontfile='${FONT_BOLD}'colorchannelmixer=rr=0.6:gg=0.6:bb=0.6[bg];[0:v]fps=30,scale=1500:-1[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,drawtext=fontfile='':text='¿CONOCIAS ESTO?':fontcolor=white:bordercolor=#198038:borderw=5:fontsize=75:x=(W-text_w)/2:y=300,drawtext=fontfile='${FONT_REGULAR}':text='TECH FINDS AMAZON':fontcolor=white:alpha=0.6:fontsize=35:x=(W-text_w)/2:y=H-500,setsar=1,format=yuv420p[v]`;

        // 3. Extraer fragmentos aleatorios (2 a 4 segundos) del video original
        while (accumulatedDuration < targetVideoDuration) {
          let clipDur = 2.0 + (Math.random() * 2.0);
          if (clipDur > srcDur) clipDur = srcDur;
          
          // Ajustar el tiempo del último clip para que encaje perfecto con el audio
          if (accumulatedDuration + clipDur > targetVideoDuration) {
            clipDur = targetVideoDuration - accumulatedDuration;
          }

          // Punto de inicio aleatorio
          const maxStart = Math.max(0, srcDur - clipDur);
          const startOffset = Math.random() * maxStart;

          const tempVertClip = path.join(tempDir, `${productId}_vert_seg_${clipIndex}.mp4`);

          // Renderizar el micro-clip con nuestro filtro ultrarrápido
          await new Promise((res, rej) => {
            ffmpeg(productVideoPath)
              .inputOptions(['-ss', startOffset.toFixed(3), '-t', clipDur.toFixed(3)])
              .complexFilter([filterComplex])
              .outputOptions(['-map', '[v]', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-an', '-pix_fmt', 'yuv420p'])
              .output(tempVertClip)
              .on('error', rej)
              .on('end', () => res(tempVertClip))
              .run();
          });

          verticalClips.push(tempVertClip);
          accumulatedDuration += clipDur;
          clipIndex++;

          // Freno de seguridad
          if (clipIndex > 50) break;
        }

        // 4. Concatenar los fragmentos en un solo video fluido (Proceso instantáneo)
        let effectiveSource = null;
        if (verticalClips.length > 0) {
          const montagePath = path.join(tempDir, `${productId}_smart_montage.mp4`);
          const listPath = path.join(tempDir, `${productId}_concat_list.txt`);

          const listContent = verticalClips.map(vp => `file '${vp.replace(/'/g, "'\\''")}'`).join('\n');
          fsSync.writeFileSync(listPath, listContent);

          await new Promise((res, rej) => {
            ffmpeg()
              .input(listPath)
              .inputOptions(['-f', 'concat', '-safe', '0'])
              .outputOptions(['-c', 'copy'])
              .output(montagePath)
              .on('error', rej)
              .on('end', () => res(montagePath))
              .run();
          });
          effectiveSource = montagePath;
        }

 // 5. Mezclar el nuevo montaje dinámico con el audio de la IA y MÚSICA DE FONDO ALEATORIA
        if (effectiveSource && fsSync.existsSync(effectiveSource)) {
          let finalAudioPath = productAudioPath;
          const sfxDir = path.resolve(__dirname, '..', 'data', 'sfx');
          
          if (fsSync.existsSync(sfxDir)) {
            const files = fsSync.readdirSync(sfxDir);
            const validTracks = files.filter(f => f.toLowerCase().startsWith('bmg') && f.toLowerCase().endsWith('.mp3'));
            
            if (validTracks.length > 0) {
              const randomBgm = path.join(sfxDir, validTracks[Math.floor(Math.random() * validTracks.length)]);
              const mixedAudioPath = path.join(tempDir, `${productId}_short_mixed_audio.m4a`);
              
              const audioDur = await this._getMediaDuration(productAudioPath).catch(() => 15);
              const fadeStart = Math.max(0, audioDur - 3);
              const bgmVol = parseFloat(process.env.BGM_VOLUME || '0.12');
              
              await new Promise((res, rej) => {
                ffmpeg()
                  .input(productAudioPath)
                  .input(randomBgm)
                  .inputOptions(['-stream_loop', '-1'])
                  .complexFilter([
                    `[0:a]volume=1.8[voice]`,
                    `[1:a]volume=${bgmVol.toFixed(3)},afade=t=out:st=${fadeStart.toFixed(3)}:d=3[bgm]`,
                    `[voice][bgm]amix=inputs=2:duration=first:dropout_transition=2[aout]`
                  ])
                  .outputOptions(['-map', '[aout]', '-c:a', 'aac', '-ac', '2', '-ar', '44100', '-b:a', '192k'])
                  .output(mixedAudioPath)
                  .on('error', rej)
                  .on('end', res)
                  .run();
              });
              finalAudioPath = mixedAudioPath;
            }
          }

          // 👇 INYECCIÓN: Aplicar emoticono 👇 en los últimos 5 segundos 👇
          const finalAudioDur = await this._getMediaDuration(finalAudioPath).catch(() => 15);
          const emojiStart = Math.max(0, finalAudioDur - 5);

          const cmd = ffmpeg()
            .input(effectiveSource)
            .input(finalAudioPath)
            .complexFilter([
              // Usamos Segoe UI Emoji (nativa de Windows) para la mano apuntando
              `[0:v]drawtext=fontfile='${FONT_EMOJI}':text='👇 VIDEO COMPLETO 👇':fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=15:fontsize=65:x=(W-text_w)/2:y=H-400:enable='gte(t,${emojiStart.toFixed(2)})'[vout]`
            ])
            .outputOptions([
              '-map', '[vout]',
              '-map', '1:a',
              '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
              '-c:a', 'aac', '-b:a', '192k',
              '-shortest',
              '-y'
            ])
            .output(outputPath);
          // 👆 FIN INYECCIÓN 👆

          cmd.on('end', async () => {
            if (finalAudioPath !== productAudioPath) fsSync.unlink(finalAudioPath, () => {});
            // Limpiar archivos temporales para no saturar tu disco duro
            for (const clip of verticalClips) fsSync.unlink(clip, () => {});
            fsSync.unlink(effectiveSource, () => {});
            const listTemp = path.join(tempDir, `${productId}_concat_list.txt`);
            if (fsSync.existsSync(listTemp)) fsSync.unlink(listTemp, () => {});
            
            resolve(outputPath);
          });
          cmd.on('error', reject);
          cmd.run();
        } else {
          reject(new Error("No se generó el montaje del producto"));
        }

      } catch (err) {
        reject(err);
      }
    });
  }
// ═══════════════════════════════════════════════════════════════════
  // GENERATE TEASER SHORT (Ganchos Dinámicos Rotativos + Sincronía Perfecta)
  // ═══════════════════════════════════════════════════════════════════
  async generateTeaserShort(script, sectionAudios, originalVideoPaths, outputDir, productionId) {
    return new Promise(async (resolve, reject) => {
      try {
        const tempDir = path.resolve(__dirname, '..', 'temp', 'processing');
        fsSync.mkdirSync(outputDir, { recursive: true });
        
        const outputPath = path.join(outputDir, `${productionId}_teaser_short.mp4`);

        this.logger.info(`[TeaserShort] 1. Seleccionando exactamente 3 productos...`);
        const sections = script.mainContent.sections;
        const availableIndexes = sections.map((_, i) => i).filter(i => 
          originalVideoPaths[i] && fsSync.existsSync(originalVideoPaths[i]) &&
          sectionAudios[i] && fsSync.existsSync(sectionAudios[i])
        );

        if (availableIndexes.length < 1) throw new Error("No hay suficientes archivos para el Teaser Short.");

        const shuffled = availableIndexes.sort(() => 0.5 - Math.random());
        const selectedIndexes = shuffled.slice(0, Math.min(3, shuffled.length));

        // 🔥 1. ROTADOR DE GANCHOS (Visual y Audio) 🔥
        const hookVariations = [
          { line1: "3 GADGETS DE AMAZON", line2: "QUE TE DEJARÁN CON LA BOCA ABIERTA" },
          { line1: "3 PRODUCTOS DE AMAZON", line2: "QUE PROBABLEMENTE QUERRÁS TENER" },
          { line1: "3 INVENTOS DE AMAZON", line2: "QUE VALEN LA PENA CONOCER" },
          { line1: "3 GADGETS INCREÍBLES", line2: "QUE ESTÁN SORPRENDIENDO A TODOS" },
          { line1: "3 COMPRAS DE AMAZON", line2: "QUE NECESITAS EN TU VIDA" }
        ];
        const selectedHook = hookVariations[Math.floor(Math.random() * hookVariations.length)];
        const fullHookText = `${selectedHook.line1} ${selectedHook.line2}`.toLowerCase(); // Texto para la voz

        this.logger.info(`[TeaserShort] 2. Generando guion JSON dinámico. Gancho elegido: "${fullHookText}"`);
        
        const productsListText = selectedIndexes.map((idx, i) => {
          const title = sections[idx].title || `Producto ${i + 1}`;
          return `Item ${3 - i}: ${title}`;
        }).join(', ');

        let scriptParts = null;
        if (this.openai) {
          try {
            const response = await this.openai.chat.completions.create({
              model: 'gpt-4o',
              response_format: { type: "json_object" },
              messages: [
                {
                  role: 'system',
                  content: 'Eres un locutor experto en YouTube Shorts para "Tech Finds Amazon". Tu estilo es ultra-rápido, dinámico y persuasivo, idéntico a los canales virales de gadgets. Devuelve estrictamente un JSON.'
                },
                {
                  role: 'user',
                  content: `Escribe un guion estructurado estrictamente en este orden para 3 productos: ${productsListText}.
                  Estructura obligatoria:
                  - "intro": Debe ser EXACTAMENTE esta frase: "${fullHookText}."
                  - "item3": Empieza con "Número 3." o "Tres.", seguido del nombre del producto y su función principal directa al grano (máximo 12 palabras).
                  - "item2": Empieza con "Número 2." o "Dos.", seguido del nombre del producto y su función principal (máximo 12 palabras).
                  - "item1_cta": Empieza con "Número 1." o "Uno.", seguido del producto y una muy breve descripción. Inmediatamente cierra SIN CORTES con este CTA exacto: "Estos son solo 3 de mis favoritos, pero el gadget número uno de la lista te va a volar la cabeza. Toca el enlace aquí abajo para ver el video completo."
                  
                  Devuelve ÚNICAMENTE un objeto JSON válido con las claves: "intro", "item3", "item2", "item1_cta".`
                }
              ],
              temperature: 0.8,
              max_tokens: 300
            });
            scriptParts = JSON.parse(response.choices[0].message.content);
          } catch (e) {
            this.logger.warn(`[TeaserShort] Error OpenAI JSON, usando respaldo: ${e.message}`);
          }
        }

        // Fallback dinámico si falla OpenAI
        if (!scriptParts || !scriptParts.intro) {
          const p3Name = sections[selectedIndexes[0]].title || 'Producto 3';
          const p2Name = sections[selectedIndexes[1]].title || 'Producto 2';
          const p1Name = sections[selectedIndexes[2]].title || 'Producto 1';
          scriptParts = {
            intro: `${fullHookText}.`,
            item3: `Tres. ${p3Name}. Te sorprenderá su funcionalidad en el día a día.`,
            item2: `Dos. ${p2Name}. Ideal para mantener todo perfectamente organizado.`,
            item1_cta: `Uno. ${p1Name}. Simplemente revolucionario. Estos son solo 3 de mis favoritos, pero el gadget número uno de la lista te va a volar la cabeza. Toca el enlace aquí abajo para ver el video completo.`
          };
        }

        this.logger.info(`[TeaserShort] 3. Generando y midiendo 4 audios independientes...`);
        const audioPaths = [];
        const audioDurs = [];
        const parts = ['intro', 'item3', 'item2', 'item1_cta'];

        for (let i = 0; i < parts.length; i++) {
          const partKey = parts[i];
          const aPath = path.join(tempDir, `${productionId}_t_${partKey}.mp3`);
          await this.generateTTSAudio(scriptParts[partKey], aPath, 'energetic');
          const dur = await this._getMediaDuration(aPath).catch(() => (i === 3 ? 12 : 3));
          audioPaths.push(aPath);
          audioDurs.push(dur);
        }

        const fullTtsPath = path.join(tempDir, `${productionId}_t_full_tts.mp3`);
        await this._concatAudios(audioPaths, fullTtsPath);

        // 🔥 4. RETRASO DE 3 SEGUNDOS: Intro pura visual sin voz 🔥
        const delayedTtsPath = path.join(tempDir, `${productionId}_t_delayed_tts.mp3`);
        await new Promise((res, rej) => {
          ffmpeg(fullTtsPath).audioFilters('adelay=3000|3000').output(delayedTtsPath).on('end', res).on('error', rej).run();
        });

        this.logger.info(`[TeaserShort] 5. Ensamblando clips (Sincronía matemática exacta)...`);
        const videoClips = [];
        const introSilenceDur = 3.0; 
        
        // --- CLIP 0: Intro (3s silencio + la voz leyendo el gancho dinámico) ---
        const durClipIntro = introSilenceDur + audioDurs[0];
        const vPathIntro = originalVideoPaths[selectedIndexes[0]];
        const tempIntroVid = path.join(tempDir, `${productionId}_t_v_intro.mp4`);
        
        // Banner principal usa los textos dinámicos seleccionados arriba
        const introFilter = `[0:v]fps=30,scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,scale=270:480,boxblur=10:10,scale=1080:1920,colorchannelmixer=rr=0.6:gg=0.6:bb=0.6[bg];[0:v]fps=30,scale=1500:-1[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,` +
        `drawtext=fontfile='${FONT_BOLD}':text='${selectedHook.line1}':fontcolor=white:box=1:boxcolor=black@0.8:boxborderw=12:fontsize=55:x=(W-text_w)/2:y=180,` +
        `drawtext=fontfile='${FONT_REGULAR}':text='${selectedHook.line2}':fontcolor=white:box=1:boxcolor=black@0.8:boxborderw=8:fontsize=32:x=(W-text_w)/2:y=260,setsar=1,format=yuv420p[v]`;

        await new Promise((res, rej) => {
          const srcDur = 10; // Valor seguro temporal
          const maxStart = Math.max(0, srcDur - durClipIntro);
          const startOffset = Math.random() * maxStart;

          ffmpeg(vPathIntro).inputOptions(['-ss', startOffset.toFixed(3), '-t', durClipIntro.toFixed(3)])
            .complexFilter([introFilter]).outputOptions(['-map', '[v]', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-an', '-pix_fmt', 'yuv420p'])
            .output(tempIntroVid).on('end', () => res(tempIntroVid)).on('error', rej).run();
        });
        videoClips.push(tempIntroVid);

        // --- CLIPS 1, 2 y 3: (Cortados en el milisegundo exacto que dicta la voz) ---
        const productDurs = [audioDurs[1], audioDurs[2], audioDurs[3]];
        
        for (let i = 0; i < selectedIndexes.length; i++) {
          const idx = selectedIndexes[i];
          const vPath = originalVideoPaths[idx];
          
          let clipDur = productDurs[i]; // SINCRONÍA PERFECTA
          const srcDur = await this._getMediaDuration(vPath).catch(() => 10);
          const maxStart = Math.max(0, srcDur - clipDur);
          const startOffset = Math.random() * maxStart;
          const tempVid = path.join(tempDir, `${productionId}_t_v_seg_${i}.mp4`);

          const productNumber = 3 - i; 
          const cleanTitle = (sections[idx].title || `Producto ${i+1}`).toUpperCase().substring(0, 25);
          const labelText = `${productNumber}. ${cleanTitle}`;

          const filterComplex = `[0:v]fps=30,scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,scale=270:480,boxblur=10:10,scale=1080:1920,colorchannelmixer=rr=0.6:gg=0.6:bb=0.6[bg];[0:v]fps=30,scale=1500:-1[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,` +
          `drawtext=fontfile='${FONT_BOLD_ALT}':text='  ${labelText}  ':fontcolor=black:box=1:boxcolor=white@0.95:boxborderw=14:fontsize=45:x=(W-text_w)/2:y=180,setsar=1,format=yuv420p[v]`;

          await new Promise((res, rej) => {
            ffmpeg(vPath).inputOptions(['-ss', startOffset.toFixed(3), '-t', clipDur.toFixed(3)])
              .complexFilter([filterComplex]).outputOptions(['-map', '[v]', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-an', '-pix_fmt', 'yuv420p'])
              .output(tempVid).on('end', () => res(tempVid)).on('error', rej).run();
          });
          videoClips.push(tempVid);
        }

        // Unir el video visual
        const rawMontagePath = path.join(tempDir, `${productionId}_t_raw.mp4`);
        const listPath = path.join(tempDir, `${productionId}_t_list.txt`);
        fsSync.writeFileSync(listPath, videoClips.map(vp => `file '${vp.replace(/'/g, "'\\''")}'`).join('\n'));
        await new Promise((res, rej) => {
          ffmpeg().input(listPath).inputOptions(['-f', 'concat', '-safe', '0']).outputOptions(['-c', 'copy']).output(rawMontagePath)
            .on('end', () => res(rawMontagePath)).on('error', rej).run();
        });

        this.logger.info(`[TeaserShort] 6. Mezclando BGM y aplicando CTA final con la mano apuntando...`);
        const totalVideoDur = introSilenceDur + audioDurs[0] + audioDurs[1] + audioDurs[2] + audioDurs[3];
        let finalAudioPath = delayedTtsPath;
        const sfxDir = path.resolve(__dirname, '..', 'data', 'sfx');

        if (fsSync.existsSync(sfxDir)) {
          const files = fsSync.readdirSync(sfxDir);
          const validTracks = files.filter(f => f.toLowerCase().startsWith('bmg') && f.toLowerCase().endsWith('.mp3'));
          if (validTracks.length > 0) {
            const randomBgm = path.join(sfxDir, validTracks[Math.floor(Math.random() * validTracks.length)]);
            const mixedAudioPath = path.join(tempDir, `${productionId}_t_mixed.m4a`);
            const fadeStart = Math.max(0, totalVideoDur - 3);
            const bgmVol = parseFloat(process.env.BGM_VOLUME || '0.15');

            await new Promise((res, rej) => {
              ffmpeg().input(delayedTtsPath).input(randomBgm).inputOptions(['-stream_loop', '-1'])
                .complexFilter([`[0:a]volume=1.8[voice]`, `[1:a]volume=${bgmVol.toFixed(3)},afade=t=out:st=${fadeStart.toFixed(3)}:d=3[bgm]`, `[voice][bgm]amix=inputs=2:duration=first:dropout_transition=2[aout]`])
                .outputOptions(['-map', '[aout]', '-c:a', 'aac', '-ac', '2', '-ar', '44100', '-b:a', '192k']).output(mixedAudioPath)
                .on('error', rej).on('end', res).run();
            });
            finalAudioPath = mixedAudioPath;
          }
        }

        const emojiStart = Math.max(0, totalVideoDur - 5);

        await new Promise((res, rej) => {
          ffmpeg().input(rawMontagePath).input(finalAudioPath)
            .complexFilter([`[0:v]drawtext=fontfile='${FONT_EMOJI}':text='👇 VIDEO COMPLETO AQUÍ 👇':fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=15:fontsize=65:x=(W-text_w)/2:y=H-280:enable='gte(t,${emojiStart.toFixed(2)})'[vout]`])
            .outputOptions(['-map', '[vout]', '-map', '1:a', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-y'])
            .output(outputPath).on('end', res).on('error', rej).run();
        });

        // Limpieza de archivos temporales
        for (const clip of videoClips) fsSync.unlink(clip, () => {});
        for (const ap of audioPaths) fsSync.unlink(ap, () => {});
        [fullTtsPath, delayedTtsPath, finalAudioPath, rawMontagePath, listPath].forEach(f => {
          if (fsSync.existsSync(f)) fsSync.unlinkSync(f);
        });

        resolve(outputPath);
      } catch (error) {
        reject(error);
      }
    });
  }
}

module.exports = { AIVideoGenerator };