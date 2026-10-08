const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const { Logger } = require('../utils/logger');
const { AIVideoGenerator } = require('../utils/ai-video-generator');
const { extractAndFilterScenes } = require('../utils/scene-extractor');

// Durations configurable via env
const PER_PRODUCT_DURATION_MIN = parseInt(process.env.PER_PRODUCT_DURATION_MIN || '30', 10);
const PER_PRODUCT_DURATION_MAX = parseInt(process.env.PER_PRODUCT_DURATION_MAX || '50', 10);
const PER_PRODUCT_DURATION_DEFAULT = parseInt(process.env.PER_PRODUCT_DURATION_DEFAULT || String(Math.round((PER_PRODUCT_DURATION_MIN + PER_PRODUCT_DURATION_MAX)/2)), 10);
const INTRO_DURATION_MIN = parseInt(process.env.INTRO_DURATION_MIN || '25', 10);
const INTRO_DURATION_MAX = parseInt(process.env.INTRO_DURATION_MAX || '30', 10);
const INTRO_DURATION_AVG = Math.round((INTRO_DURATION_MIN + INTRO_DURATION_MAX) / 2);
const COMBINED_CLIP_DURATION = parseInt(process.env.COMBINED_CLIP_DURATION || '60', 10);

class ProductionManagementAgent {
  constructor(db, credentials) {
    this.db = db;
    this.credentials = credentials;
    this.logger = new Logger('ProductionManagement');
    this.pipeline = [];
    this.assets = new Map();
    this.aiVideoGenerator = new AIVideoGenerator(credentials);
  }

  async initialize() {
    this.logger.info('Initializing Production Management Agent...');
    await this.setupDirectories();
    await this.loadPipeline();
    return true;
  }

  async setupDirectories() {
    const dirs = [
      'data/production',
      'data/assets',
      'data/videos',
      'data/audio',
      'data/scripts',
      'temp/processing',
      'data/shorts' // Asegura que la carpeta de shorts exista
    ];

    for (const dir of dirs) {
      await fs.mkdir(path.join(__dirname, '..', dir), { recursive: true });
    }
  }

  async loadPipeline() {
    try {
      const pipeline = await this.db.getProductionPipeline();
      this.pipeline = pipeline || [];
    } catch (error) {
      this.logger.warn('No existing pipeline found, starting fresh');
    }
  }

  async processContent(contentData) {
    try {
      this.logger.info('Processing content for production...');
      
      const { strategy, script, thumbnail, seo, huntResults, introProductsOrder } = contentData;

      // ── MATCH EXACTO OBLIGATORIO: Asegurar vínculo con los MP4 locales originales ──
      await this._resolveVideoPathsByProductId(script);
      
      // Create production entry
      const productionId = this.generateProductionId();

      const productionData = {
        id: productionId,
        strategy,
        script,
        thumbnail,
        seo,
        introProductsOrder: Array.isArray(introProductsOrder) && introProductsOrder.length > 0
          ? introProductsOrder
          : [],
        status: 'processing',
        assets: {
          script: await this.processScript(script),
          thumbnail: await this.processThumbnail(thumbnail),
          audio: null, // Will be generated later
          video: null, // Will be generated later
          captions: null // Will be generated later
        },
        timeline: {
          created: new Date().toISOString(),
          scriptReady: new Date().toISOString(),
          thumbnailReady: new Date().toISOString(),
          audioGenerated: null,
          videoGenerated: null,
          captionsGenerated: null,
          readyForUpload: null
        },
        scheduledPublishTime: this.calculatePublishTime(strategy),
        priority: this.calculatePriority(strategy),
        estimatedDuration: script.duration,
        createdAt: new Date().toISOString()
      };
      
      // Add to pipeline
      this.pipeline.push(productionData);
      
      // Save to database
      await this.db.saveProductionData(productionData);
      
      // Generate video content
      await this.generateVideoContent(productionData);
      
      // Generate per-section audio narration (one TTS per product)
      await this.generatePerSectionAudio(productionData);

      // Generar audio de intro ANTES de extraer escenas
      try {
        await this.generateIntroAudio(productionData);
      } catch (e) {
        this.logger.warn(`[ProductionManagement] ✗ generateIntroAudio falló (continuando): ${e.message}`);
      }

// Generate individual product shorts (9:16) ANTES de ensamblar el video final
      const productShorts = await this.generateProductShorts(productionData);
      if (productShorts.length > 0) {
        if (!productionData.assets.shortVideos) {
          productionData.assets.shortVideos = {};
        }
        productionData.assets.shortVideos.products = productShorts;
        
        // 🔥 EL PARCHE CLAVE: Le damos a index.js la ruta exacta que está buscando 🔥
        productionData.assets.productShorts = productShorts;
        
        this.logger.info(`[ProductionManagement] ✅ Agregados ${productShorts.length} product shorts a assets`);
      } else {
        this.logger.warn(`[ProductionManagement] ⚠️ No se generaron product shorts`);
      }

      // Generate outro audio (conclusión + CTA, separado del último producto)
      await this.generateOutroAudio(productionData);
      
      // Final assembly (esto renderizará el master 16:9 y el Intro Short 9:16)
      await this.assembleVideo(productionData);
      
      // Mark as ready
      productionData.status = 'ready';
      productionData.timeline.readyForUpload = new Date().toISOString();
      
      await this.db.updateProductionData(productionData);
      
      this.logger.info(`Content processing complete: ${productionId}`);
      return productionData;
    } catch (error) {
      this.logger.error('Failed to process content:', error);
      throw error;
    }
  }

  generateProductionId() {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 15);
    const extra = Math.random().toString(36).substring(2, 15);
    return `prod_${timestamp}_${random}_${extra}`;
  }

  /**
   * Match exacto: para cada sección del guion, busca {productId}.mp4
   * en la carpeta uploads/. Si encuentra el archivo, asigna videoPath original.
   * Esto previene que se asigne a un pre-trimmed que luego se borrará.
   */
  async _resolveVideoPathsByProductId(script) {
    const sections = (script.mainContent && script.mainContent.sections) || [];
    if (sections.length === 0) return;

    const uploadsDir = path.join(__dirname, '..', 'uploads');
    let mp4Files = [];
    try {
      const allFiles = await fs.readdir(uploadsDir);
      mp4Files = allFiles.filter(f => f.toLowerCase().endsWith('.mp4'));
    } catch (err) {
      this.logger.warn(`_resolveVideoPathsByProductId: no se pudo leer uploads/ — ${err.message}`);
      return;
    }

    const fileMap = new Map();
    for (const f of mp4Files) {
      const baseName = path.basename(f, path.extname(f));
      fileMap.set(baseName, path.join(uploadsDir, f));
    }

    this.logger.info('── RESOLVE VIDEO PATHS (productId ↔ .mp4 original) ──');

    for (let i = 0; i < sections.length; i++) {
      const sec = sections[i];
      const pid = sec.productId || null;

      // Buscar si el archivo original existe en uploads/ con ese pid
      if (pid && fileMap.has(pid)) {
        sec.originalVideoPath = fileMap.get(pid); // Guardar la ruta original SIEMPRE
        this.logger.info(`  [${i}] "${sec.title}" ← original: ${pid}.mp4 ✓`);
      } else if (sec.videoPath && fsSync.existsSync(sec.videoPath)) {
        sec.originalVideoPath = sec.videoPath; // Fallback al videopath general si no coincide ID
      } else {
        sec.originalVideoPath = null;
        this.logger.warn(`  [${i}] "${sec.title}" ← SIN ORIGINAL (productId=${pid})`);
      }
    }
    this.logger.info('── FIN RESOLVE VIDEO PATHS ──');
  }

  async processScript(script) {
    const scriptPath = path.join(__dirname, '..', 'data', 'scripts', `${Date.now()}_script.json`);
    const ttsScript = this.formatScriptForTTS(script);
    await fs.writeFile(scriptPath, JSON.stringify(script, null, 2));
    await fs.writeFile(scriptPath.replace('.json', '_tts.txt'), ttsScript);
    return {
      originalPath: scriptPath,
      ttsPath: scriptPath.replace('.json', '_tts.txt'),
      duration: script.duration,
      sections: script.mainContent.sections.length
    };
  }

  formatScriptForTTS(script) {
    let ttsText = '';
    if (script.hook) ttsText += `${script.hook.text}\n\n`;
    if (script.introduction) {
      ttsText += `${script.introduction.greeting}\n`;
      ttsText += `${script.introduction.topicIntro}\n`;
      ttsText += `${script.introduction.valueProposition}\n`;
      ttsText += `${script.introduction.credibility}\n\n`;
    }
    if (script.mainContent && script.mainContent.sections) {
      script.mainContent.sections.forEach((section) => {
        if (Array.isArray(section.content)) {
          section.content.forEach(line => {
            if (typeof line === 'string' && !line.startsWith('[')) ttsText += `${line}\n`;
          });
        } else if (section.steps) {
          section.steps.forEach(step => {
            ttsText += `${step.description}\n`;
            if (step.tip) ttsText += `${step.tip}\n`;
          });
        } else if (section.items) {
          section.items.forEach(item => {
            ttsText += `${item.title}. ${item.description}\n`;
          });
        } else if (typeof section.content === 'string') {
          ttsText += `${section.content}\n`;
        }
        ttsText += '\n';
      });
    }
    if (script.conclusion) {
      script.conclusion.recap.forEach(line => {
        if (typeof line === 'string') ttsText += `${line}\n`;
      });
      ttsText += `\n${script.conclusion.finalThought}\n\n`;
    }
    if (script.callToAction) {
      ttsText += `${script.callToAction.subscribe}\n`;
      ttsText += `${script.callToAction.like}\n`;
      ttsText += `${script.callToAction.comment}\n`;
    }
    return ttsText;
  }

  async processThumbnail(thumbnail) {
    if (thumbnail && thumbnail.path) {
      return {
        path: thumbnail.path,
        originalPath: thumbnail.path,
        dimensions: thumbnail.dimensions || { width: 3840, height: 2160 },
        fileSize: thumbnail.fileSize || 0,
        generatedWith: 'ThumbnailDesignerAgent'
      };
    }
    const productionThumbnailPath = path.join(__dirname, '..', 'data', 'assets', `thumbnail_${Date.now()}.jpg`);
    await fs.writeFile(productionThumbnailPath + '.placeholder', 'Thumbnail placeholder');
    return {
      path: productionThumbnailPath + '.placeholder',
      originalPath: null,
      dimensions: { width: 1280, height: 720 },
      fileSize: 0
    };
  }

  calculatePublishTime(strategy) {
    if (strategy.bestPublishTime) return strategy.bestPublishTime;
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    tomorrow.setHours(14, 0, 0, 0); // 2 PM default
    return tomorrow.toISOString();
  }

  calculatePriority(strategy) {
    let priority = 50;
    if (strategy.estimatedViews > 100000) priority += 30;
    else if (strategy.estimatedViews > 50000) priority += 20;
    else if (strategy.estimatedViews > 10000) priority += 10;
    if (strategy.competitorAnalysis && strategy.competitorAnalysis.length > 0) priority += 10;
    const hoursUntilPublish = (new Date(strategy.bestPublishTime) - new Date()) / (1000 * 60 * 60);
    if (hoursUntilPublish < 24) priority += 20;
    else if (hoursUntilPublish < 48) priority += 10;
    return Math.min(100, priority);
  }

  async _getMediaDuration(filePath) {
    if (!filePath) return 0;
    try {
      const safePath = String(filePath).replace(/\\/g, '/');
      const { stdout } = await execPromise(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${safePath}"`);
      return parseFloat(stdout.trim()) || 0;
    } catch (e) {
      this.logger.warn(`_getMediaDuration error for ${filePath}: ${e.message}`);
      return 0;
    }
  }

  async generateVideoContent(productionData) {
    this.logger.info('Generating AI video content...');
    try {
      const { strategy, script } = productionData;
      const visualPrompts = this.createVisualPromptsFromScript(script);
      const visualAssets = [];
      for (const prompt of visualPrompts) {
        const assets = await this.aiVideoGenerator.generateVisualAssets(prompt, 'ethereal', 1);
        visualAssets.push(...assets);
      }
      productionData.assets.video = {
        visualAssets: visualAssets,
        duration: productionData.estimatedDuration,
        format: 'mp4',
        resolution: '1920x1080',
        fps: 30,
        generatedWith: 'AI'
      };
      productionData.timeline.videoGenerated = new Date().toISOString();
      return visualAssets;
    } catch (error) {
      return [];
    }
  }

  async generatePerSectionAudio(productionData) {
    this.logger.info('Generating per-section TTS audio (modular architecture)...');
    try {
      const { script } = productionData;
      const sections = (script.mainContent && script.mainContent.sections) || [];

      if (sections.length === 0) {
        productionData.assets.sectionAudios = [];
        return [];
      }

      const sectionAudios = new Array(sections.length);
      const sectionWordTimestamps = new Array(sections.length);

      for (let i = 0; i < sections.length; i++) {
        let ttsText = '';
        const section = sections[i];
        if (Array.isArray(section.content)) {
          section.content.forEach(line => {
            if (typeof line === 'string' && !line.startsWith('[')) ttsText += line + ' ';
          });
        } else if (section.steps) {
          section.steps.forEach(step => {
            ttsText += (step.description || '') + ' ';
            if (step.tip) ttsText += step.tip + ' ';
          });
        } else if (section.items) {
          section.items.forEach(item => {
            ttsText += `${item.title}. ${item.description} `;
          });
        } else if (typeof section.content === 'string') {
          ttsText += section.content + ' ';
        }

        const audioPath = path.join(__dirname, '..', 'data', 'audio', `${productionData.id}_section_${i}.mp3`);
        const ttsInput = ttsText.trim();
        if (ttsInput.length === 0) ttsText = section.title || section.heading || `Producto ${i + 1}`;
        const toneHint = (section && section.tone_variant) || (productionData.script && productionData.script.tone_variant) || (productionData.script && productionData.script.tone) || 'conversacional y cercano';
        
        const ttsResult = await this.aiVideoGenerator.generateTTSAudio(ttsText.trim(), audioPath, toneHint);
        sectionAudios[i] = ttsResult.audioPath || audioPath;
        sectionWordTimestamps[i] = Array.isArray(ttsResult.wordTimestamps) ? ttsResult.wordTimestamps : [];

        let audioDurationSec = null;
        if (ttsResult && Array.isArray(ttsResult.wordTimestamps) && ttsResult.wordTimestamps.length > 0) {
          const lastWord = ttsResult.wordTimestamps[ttsResult.wordTimestamps.length - 1];
          audioDurationSec = Math.ceil(lastWord.end || 0);
        } else {
          const words = (ttsInput || '').split(/\s+/).filter(Boolean).length;
          audioDurationSec = Math.ceil(words / 2.5);
        }
        audioDurationSec = Math.max(PER_PRODUCT_DURATION_MIN, Math.min(PER_PRODUCT_DURATION_MAX, audioDurationSec));
        section.duration = audioDurationSec;
      }

      productionData.assets.sectionAudios = sectionAudios;
      productionData.assets.sectionWordTimestamps = sectionWordTimestamps;
      productionData.timeline.audioGenerated = new Date().toISOString();

      return sectionAudios;
    } catch (error) {
      throw error;
    }
  }

  async generateIntroAudio(productionData) {
    const script = productionData.script;
    if (!script) return null;
    let introText = '';
    if (script.hook && script.hook.text) introText += script.hook.text + ' ';
    if (script.introduction && script.introduction.greeting) introText += script.introduction.greeting + ' ';
    introText = introText.trim();
    if (!introText) return null;

    const introAudioPath = path.join(__dirname, '..', 'data', 'audio', `${productionData.id}_intro.mp3`);
    const introTone = (productionData.script && productionData.script.tone_variant) || (productionData.script && productionData.script.tone) || 'conversacional y cercano';
    const ttsResult = await this.aiVideoGenerator.generateTTSAudio(introText, introAudioPath, introTone);
    productionData.assets.introAudio = {
      path: ttsResult.audioPath || introAudioPath,
      wordTimestamps: Array.isArray(ttsResult.wordTimestamps) ? ttsResult.wordTimestamps : [],
      duration: ttsResult.duration || null,
      format: 'mp3',
      generatedWith: 'AI'
    };
    return ttsResult.audioPath || introAudioPath;
  }

  async generateOutroAudio(productionData) {
    const script = productionData.script;
    if (!script) return null;
    let outroText = '';
    if (script.conclusion) {
      if (Array.isArray(script.conclusion.recap)) script.conclusion.recap.forEach(line => { if (typeof line === 'string') outroText += line + ' '; });
      if (script.conclusion.finalThought) outroText += script.conclusion.finalThought + ' ';
    }
    if (script.callToAction) {
      if (script.callToAction.subscribe) outroText += script.callToAction.subscribe + ' ';
      if (script.callToAction.like) outroText += script.callToAction.like + ' ';
      if (script.callToAction.comment) outroText += script.callToAction.comment + ' ';
    }
    outroText = outroText.trim();
    if (!outroText) return null;

    const outroAudioPath = path.join(__dirname, '..', 'data', 'audio', `${productionData.id}_outro.mp3`);
    const outroTone = (productionData.script && productionData.script.tone_variant) || (productionData.script && productionData.script.tone) || 'conversacional y cercano';
    const ttsResult = await this.aiVideoGenerator.generateTTSAudio(outroText, outroAudioPath, outroTone);
    productionData.assets.outroAudio = {
      path: ttsResult.audioPath || outroAudioPath,
      wordTimestamps: Array.isArray(ttsResult.wordTimestamps) ? ttsResult.wordTimestamps : [],
      format: 'mp3',
      generatedWith: 'AI'
    };
    return ttsResult.audioPath || outroAudioPath;
  }

  /**
   * Genera los Shorts Individuales de Producto.
   * Utiliza strictamente `section.originalVideoPath` para evitar errores de archivo no encontrado
   * causados por eliminaciones tempranas de temporales pre-cortados.
   */
 /**
   * Genera los Shorts Individuales de Producto (Máximo 2 aleatorios).
   * Utiliza estrictamente `section.originalVideoPath` para evitar errores de archivo no encontrado
   * causados por eliminaciones tempranas de temporales pre-cortados.
   */
  async generateProductShorts(productionData) {
    try {
      this.logger.info('▶ GENERANDO SHORTS INDIVIDUALES (Máximo 2 productos aleatorios)...');
      
      const { script, id: productionId } = productionData;
      const sections = (script && script.mainContent && script.mainContent.sections) || [];
      const sectionAudios = productionData.assets?.sectionAudios || [];
      
      if (sections.length === 0 || sectionAudios.length === 0) return [];
      
      const shortsDir = path.join(__dirname, '..', 'data', 'shorts');
      await fs.mkdir(shortsDir, { recursive: true });
      const productShorts = [];

      // 1. Filtrar solo las secciones que tengan video y audio válidos
      const validSections = [];
      for (let i = 0; i < sections.length; i++) {
        const section = sections[i];
        const videoPath = section.originalVideoPath || section.videoPath;
        const audioPath = sectionAudios[i] || null;
        
        if (videoPath && fsSync.existsSync(videoPath) && audioPath && fsSync.existsSync(audioPath)) {
          validSections.push({ section, videoPath, audioPath, originalIndex: i });
        }
      }

      if (validSections.length === 0) {
        this.logger.warn(`[ProductShorts] No hay secciones válidas para procesar.`);
        return [];
      }

      // 2. Barajar la lista aleatoriamente (Algoritmo Fisher-Yates)
      const shuffledSections = [...validSections];
      for (let i = shuffledSections.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffledSections[i], shuffledSections[j]] = [shuffledSections[j], shuffledSections[i]];
      }

      // 3. Tomar un máximo de 2 productos de la lista barajada
      const maxShortsToGenerate = Math.min(2, shuffledSections.length);
      const selectedSections = shuffledSections.slice(0, maxShortsToGenerate);

      this.logger.info(`[ProductShorts] Se seleccionaron ${selectedSections.length} productos al azar para shorts individuales.`);

      // 4. Procesar únicamente los productos seleccionados
      for (const { section, videoPath, audioPath, originalIndex } of selectedSections) {
        const productId = section.productId || section.filename || section.id || `product_${originalIndex}`;
        const productName = section.title || `Producto ${originalIndex + 1}`;
        
        try {
          this.logger.info(`[ProductShorts] Construyendo short para: "${productName}"`);
          const shortPath = await this.aiVideoGenerator.generateProductShort(
            videoPath,
            audioPath,
            shortsDir,
            productId
          );
          
          const shortStats = await fs.stat(shortPath);
          productShorts.push({
            productId,
            productName,
            path: shortPath,              // Mantenemos path por compatibilidad
            videoPath: shortPath,         // 🔥 LA LÍNEA MÁGICA requerida por index.js
            fileSize: shortStats.size,
            duration: await this._getMediaDuration(audioPath),
            resolution: '1080x1920',
            format: 'mp4',
            targetPlatforms: ['YouTube Shorts', 'Instagram Reels', 'TikTok', 'YouTube Community']
          });
        } catch (shortErr) {
          this.logger.error(`[ProductShorts] ❌ Error en "${productName}": ${shortErr.message}`);
        }
      }
      return productShorts;
    } catch (err) {
      this.logger.error(`[ProductShorts] Error global: ${err.message}`);
      return [];
    }
  }

 async assembleVideo(productionData) {
    this.logger.info('Assembling final AI-generated video...');
    
    try {
      const finalVideoPath = path.join(__dirname, '..', 'data', 'videos', `${productionData.id}_final.mp4`);
      
      const introAudioPath = productionData.assets.introAudio ? productionData.assets.introAudio.path : null;
      const sectionAudios = productionData.assets.sectionAudios || [];
      const outroAudioPath = productionData.assets.outroAudio ? productionData.assets.outroAudio.path : null;

      // 🔥 RECUPERAMOS LAS ESCENAS ORIGINALES PARA LA INTRO 🔥
      const introScenes = productionData.assets && productionData.assets.scenes && productionData.assets.scenes.intro
        ? productionData.assets.scenes.intro
        : null;

      await this.aiVideoGenerator.generateVideo(
        productionData.script,
        productionData.assets.video.visualAssets || [],
        sectionAudios,
        finalVideoPath,
        introAudioPath,
        outroAudioPath,
        productionData.assets.sectionWordTimestamps || [],
        productionData.introProductsOrder || [],
        introScenes // <--- PASAMOS LAS ESCENAS AQUÍ (antes decía 'null')
      );
      
      const stats = await fs.stat(finalVideoPath);
      productionData.assets.finalVideo = {
        path: finalVideoPath, fileSize: stats.size, duration: productionData.estimatedDuration,
        generatedWith: 'AI', resolution: '1920x1080', format: 'mp4'
      };
      
      this.logger.info('AI video assembly complete');

// 🔥 RECUPERAMOS LOS VIDEOS ORIGINALES PARA LA INTRO INTELIGENTE 🔥
      const originalVideoPaths = productionData.script.mainContent.sections
        .map(sec => sec.videoPath)
        .filter(vp => vp && require('fs').existsSync(vp));

try {
        if (productionData.assets && productionData.assets.introAudio && productionData.assets.introAudio.path) {
          this.logger.info(`[IntroShort] Iniciando generación de intro short vertical inteligente...`);
          const shortsDir = path.join(__dirname, '..', 'data', 'shorts');
          
          const introShortPath = await this.aiVideoGenerator.generateIntroShort(
            introAudioPath, finalVideoPath, shortsDir, productionData.id, originalVideoPaths
          );
          
          const introShortStats = await fs.stat(introShortPath);
          if (!productionData.assets.shortVideos) productionData.assets.shortVideos = {};
          
          productionData.assets.shortVideos.intro = {
            path: introShortPath, fileSize: introShortStats.size,
            duration: productionData.assets.introAudio.duration || 30,
            generatedWith: 'AI-Dynamic-Vision', resolution: '1080x1920', format: 'mp4',
            targetPlatforms: ['YouTube Shorts', 'Instagram Reels', 'TikTok']
          };
          this.logger.info(`[IntroShort] ✅ Intro short generado exitosamente`);
        }
      } catch (introShortErr) {
        this.logger.warn(`[IntroShort] ⚠️ Generación falló: ${introShortErr.message}`);
      }
      // Generar el Teaser Short (Top 3 productos + CTA de intriga)
      try {
        this.logger.info(`[TeaserShort] Iniciando generación de Short tipo Tráiler (Top 3)...`);
        const shortsDir = path.join(__dirname, '..', 'data', 'shorts');
        
        const teaserShortPath = await this.aiVideoGenerator.generateTeaserShort(
          productionData.script,
          sectionAudios,
          originalVideoPaths,
          shortsDir,
          productionData.id
        );
        
        const teaserStats = await fs.stat(teaserShortPath);
        if (!productionData.assets.shortVideos) productionData.assets.shortVideos = {};
        
        productionData.assets.shortVideos.teaser = {
          path: teaserShortPath,
          fileSize: teaserStats.size,
          duration: 35,
          generatedWith: 'AI-Teaser-Top3',
          resolution: '1080x1920',
          format: 'mp4',
          targetPlatforms: ['YouTube Shorts', 'Instagram Reels', 'TikTok']
        };
        this.logger.info(`[TeaserShort] ✅ Teaser short generado exitosamente`);
      } catch (teaserErr) {
        this.logger.warn(`[TeaserShort] ⚠️ Generación falló: ${teaserErr.message}`);
      }

      return finalVideoPath;
    } catch (error) {
      this.logger.error('AI video assembly failed:', error);
      throw error;
    }
  }

  createVisualPromptsFromScript(script) {
    const prompts = [`${script.title}, ethereal storytelling, mystical background`];
    if (script.mainContent && script.mainContent.sections) {
      script.mainContent.sections.forEach(section => {
        if (section.title) prompts.push(`${section.title}, ethereal dreamscape, creative visualization`);
      });
    }
    while (prompts.length < 3) prompts.push('ethereal dreamscape, mystical storytelling, creative visualization');
    return prompts.slice(0, 5);
  }
}

module.exports = { ProductionManagementAgent };