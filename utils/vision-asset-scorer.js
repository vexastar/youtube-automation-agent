/**
 * vision-asset-scorer.js
 *
 * Puntúa assets visuales (imágenes y videos) según cuán claramente
 * muestran un producto concreto, usando GPT-4o-mini Vision.
 *
 * Para videos: extrae el frame medio con ffmpeg y lo trata como imagen.
 *
 * Coste estimado: ~$0.0015 por asset con gpt-4o-mini vision baja resolución.
 *
 * API:
 *   scoreAssets(assets, { productName, features }, opts) → Promise<Array<{...assetIn, score, tag}>>
 *
 * Activación: caller debe verificar `process.env.ENABLE_VISION_FILTER === '1'`.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

async function extractCandidateFrames(videoPath, tempDir, position) {
  const probeCmd = `ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "${videoPath}"`;
  let dur = 0;
  try { dur = parseFloat((await execPromise(probeCmd)).stdout.trim()) || 0; } catch (_) {}
  const offsets = [0.25, 0.50, 0.75].map(p => dur > 0 ? dur * p : p);
  const frames = [];
  for (let i = 0; i < offsets.length; i++) {
    const ts = offsets[i];
    const framePath = path.join(tempDir, `frame_${position}_${i}_${Date.now()}.jpg`);
    const cmd = `ffmpeg -hide_banner -y -ss ${ts.toFixed(3)} -i "${videoPath}" -frames:v 1 -q:v 4 -vf "scale=512:-1" "${framePath}"`;
    try {
      await execPromise(cmd);
      if (fs.existsSync(framePath)) frames.push(framePath);
    } catch (_) {}
  }
  return frames;
}

async function scoreFrame(dataUrl, prompt, openai, model) {
  const resp = await openai.chat.completions.create({
    model,
    max_tokens: 16,
    temperature: 0,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } }
      ]
    }]
  });
  const raw = (resp.choices?.[0]?.message?.content || '').trim();
  const m = raw.match(/(\d{1,2})\s*[\|:\-,\s]+\s*(.+)/);
  let score = 0, tag = 'unknown';
  if (m) {
    score = Math.max(0, Math.min(10, parseInt(m[1], 10)));
    tag = m[2].trim().slice(0, 40);
  } else {
    const num = raw.match(/\d+/);
    if (num) score = Math.max(0, Math.min(10, parseInt(num[0], 10)));
  }
  return { score, tag, raw };
}

function fileToDataUrl(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const mime = ext === 'png' ? 'image/png'
             : ext === 'webp' ? 'image/webp'
             : 'image/jpeg';
  const buf = fs.readFileSync(filePath);
  return `data:${mime};base64,${buf.toString('base64')}`;
}

/**
 * @param {Array<{path: string, type: 'image'|'video'}>} assets
 * @param {{ productName: string, features?: string[] }} ctx
 * @param {object} [opts]
 *   openai (required) — instancia OpenAI ya construida
 *   model  ('gpt-4o-mini')
 *   minScore (5)
 *   logger (console)
 *   maxConcurrent (3)
 *
 * @returns {Promise<Array<{path, type, score: number, tag: string, raw?: string}>>}
 *   ordenado por score desc, ya filtrado por minScore.
 */
async function scoreAssets(assets, ctx, opts = {}) {
  const {
    openai,
    model = 'gpt-4o-mini',
    minScore = 5,
    logger = console,
    maxConcurrent = 3,
    tempDir = path.resolve(__dirname, '..', 'temp', 'vision_frames')
  } = opts;

  if (!openai) throw new Error('vision-asset-scorer: opts.openai requerido');
  if (!Array.isArray(assets) || assets.length === 0) return [];
  if (!ctx || !ctx.productName) throw new Error('vision-asset-scorer: ctx.productName requerido');

  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  const featuresLine = (ctx.features && ctx.features.length > 0)
    ? ' Características: ' + ctx.features.slice(0, 3).join(' | ').substring(0, 250)
    : '';

  const prompt =
    `Evalúa esta imagen para un video de "${ctx.productName}".${featuresLine}\n\n` +
    `Devuelve EXACTAMENTE en una sola línea: SCORE|TAG\n` +
    `SCORE según esta rúbrica:\n` +
    `  10 = persona usa el producto con sus manos (interacción real)\n` +
    `   9 = funcionalidades visibles: pantalla encendida, partes móviles, interacción clara\n` +
    `   8 = producto solo, claro, primer plano, reconocible sin dudas\n` +
    `   5 = producto pequeño/al fondo/parcialmente cubierto o borroso\n` +
    `   2 = solo caja cerrada, embalaje o accesorios sin el producto principal\n` +
    `   0 = NO hay producto (persona hablando a cámara, fondo negro, texto genérico, solo logo, lifestyle sin producto)\n` +
    `TAG: 1-3 palabras en español describiendo lo más visible.\n` +
    `Sin explicaciones. Sin punto final. Solo: NUMERO|TAG`;

  // Mini pool de concurrencia
  const results = [];
  let inFlight = 0;

  async function processOne(asset, position) {
    let framePaths = [];
    let isExtractedFrames = false;
    try {
      if (asset.type === 'video') {
        framePaths = await extractCandidateFrames(asset.path, tempDir, position);
        isExtractedFrames = true;
      } else {
        if (!fs.existsSync(asset.path)) {
          logger.warn(`[VisionScorer] asset inexistente: ${asset.path}`);
          return null;
        }
        framePaths = [asset.path];
      }

      if (framePaths.length === 0) {
        logger.warn(`[VisionScorer] no se pudieron extraer frames de: ${asset.path}`);
        return null;
      }

      let bestScore = 0, bestTag = 'unknown', bestRaw = '';
      for (const fp of framePaths) {
        if (!fs.existsSync(fp)) continue;
        const dataUrl = fileToDataUrl(fp);
        const result = await scoreFrame(dataUrl, prompt, openai, model);
        if (result.score > bestScore) {
          bestScore = result.score;
          bestTag = result.tag;
          bestRaw = result.raw;
        }
      }

      if (isExtractedFrames) {
        for (const fp of framePaths) {
          try { fs.unlinkSync(fp); } catch (_) {}
        }
      }

      return { ...asset, score: bestScore, tag: bestTag, raw: bestRaw };
    } catch (err) {
      logger.warn(`[VisionScorer] fallo asset ${path.basename(asset.path)}: ${err.message}`);
      if (isExtractedFrames) {
        for (const fp of framePaths) {
          try { fs.unlinkSync(fp); } catch (_) {}
        }
      }
      return null;
    }
  }

  const tasks = [];
  for (let i = 0; i < assets.length; i++) {
    while (inFlight >= maxConcurrent) await new Promise(r => setTimeout(r, 80));
    inFlight++;
    const t = processOne(assets[i], i).then(r => {
      inFlight--;
      if (r) results.push(r);
    });
    tasks.push(t);
  }
  await Promise.all(tasks);

  const filtered = results.filter(r => r.score >= minScore).sort((a, b) => b.score - a.score);
  const top5 = filtered.slice(0, 5).map(r => `${r.score}:${r.tag}`).join(', ');
  logger.log(`[VisionScorer] ${filtered.length}/${assets.length} superaron umbral ${minScore} para "${ctx.productName.substring(0, 40)}" — top: ${top5 || 'ninguno'}`);
  return filtered;
}

/**
 * Evalúa si el primer frame de un clip de video es contenido real del producto
 * o una pantalla introductoria (título, logo, slide genérico, fondo negro/blanco).
 *
 * Score 0-3 → intro/título  → el clip debe recortarse desde ese punto.
 * Score 4-10 → contenido real → el clip es apto para usar.
 *
 * @param {string} framePath - ruta a JPEG del primer frame
 * @param {object} openai    - instancia OpenAI ya construida
 * @param {string} [model]
 * @returns {Promise<number>} score 0-10 (10 en caso de error = asumir apto)
 */
async function scoreIntroFrame(framePath, openai, model = 'gpt-4o-mini') {
  if (!fs.existsSync(framePath)) return 10;
  const dataUrl = fileToDataUrl(framePath);
  const prompt =
    'Este es el PRIMER FRAME de un clip de video de Amazon.\n' +
    'Responde SOLO con un número del 0 al 10:\n' +
    '  0-3 = pantalla introductoria: título animado, texto de presentación, ' +
    'logo de marca, fondo oscuro/blanco con letras, slide genérico, ' +
    'intro cinematográfica, pantalla negra con texto — NO APTO\n' +
    '  4-10 = contenido real: producto visible, persona usando el producto, ' +
    'demostración, primer plano del gadget — APTO\n' +
    'Sin explicación. Solo el número.';
  try {
    const resp = await openai.chat.completions.create({
      model,
      max_tokens: 4,
      temperature: 0,
      messages: [{ role: 'user', content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } }
      ]}]
    });
    const raw = (resp.choices?.[0]?.message?.content || '').trim();
    const n = parseInt(raw.match(/\d+/)?.[0] || '10', 10);
    return Math.max(0, Math.min(10, n));
  } catch (_) {
    return 10; // en caso de error, asumir contenido válido
  }
}

module.exports = { scoreAssets, scoreIntroFrame };
