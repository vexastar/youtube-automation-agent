require('dotenv').config();
const sharp = require('sharp');
const axios = require('axios');
const path = require('path');
const fs = require('fs').promises;
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const { Logger } = require('../utils/logger');
const { fal } = require('@fal-ai/client');

/**
 * Infiere la categoría del producto desde su nombre y construye un prompt
 * cinematográfico con fondo contextual dinámico (rotación aleatoria entre variantes).
 * @param {string} nombreProducto - Nombre del producto (ej: 'noise machine for sleeping').
 */
function crearPromptMaestro(nombreProducto) {
  const name = (nombreProducto || '').toLowerCase();

  // ── Diccionario de colores LED por nicho (Estrategia Variety Show) ──
  const CATEGORIES = [
    {
      keys: ['sleep', 'snore', 'pillow', 'massager', 'relax', 'health', 'posture', 'spa'],
      colors: 'calming aqua and soft magenta LED accents',
      backdrop: 'dark cinematic purple gradient'
    },
    {
      keys: ['kitchen', 'cocina', 'blender', 'coffee', 'food', 'home', 'clean', 'vacuum'],
      colors: 'warm amber and crisp white LED accents',
      backdrop: 'smooth warm gray gradient'
    },
    {
      keys: ['keyboard', 'mouse', 'monitor', 'gaming', 'desk', 'setup', 'pc', 'gamer'],
      colors: 'electric blue and neon purple LED accents',
      backdrop: 'deep dark blue gradient'
    },
    {
      keys: ['camp', 'hike', 'survival', 'outdoor', 'tool', 'drill', 'tactical', 'knife', 'edc'],
      colors: 'toxic green and warning orange LED accents',
      backdrop: 'dark olive and charcoal gradient'
    },
    {
      keys: ['speaker', 'headphone', 'audio', 'music', 'sound', 'earbuds'],
      colors: 'vibrant pink and soundwave blue LED accents',
      backdrop: 'pitch black with subtle pink rim light'
    },
    {
      keys: ['car', 'auto', 'vehicle', 'driving', 'dash', 'mount'],
      colors: 'racing red and ice blue LED accents',
      backdrop: 'dark asphalt gray gradient'
    }
  ];

  // Detectar categoría por keywords
  let matchedColors = 'glowing cyan and neon orange LED accents'; // Fallback por defecto
  let matchedBackdrop = 'dark cinematic blue or warm studio yellow gradient';

  for (const cat of CATEGORIES) {
    if (cat.keys.some(kw => name.includes(kw))) {
      matchedColors = cat.colors;
      matchedBackdrop = cat.backdrop;
      break;
    }
  }

  return (
    `Ultra-realistic macro photography of a highly futuristic, sci-fi version of ${nombreProducto}. ` +
    `CRITICAL: The product MUST be held closely by human hands in a first-person perspective, showing interaction. ` +
    `Design elements: sleek metallic textures, ${matchedColors}, integrated futuristic digital smart screens. ` +
    `Environment and setting: Smooth, clean studio background (${matchedBackdrop}), intense rim lighting matching the LEDs, extreme depth of field isolating the gadget. ` +
    `The product is the absolute visual hero: perfectly sharp, occupying at least 60% of the frame. 8K resolution, high contrast, professional color grading. ` +
    `CRITICAL INSTRUCTION: Completely remove any text, typography, watermarks, price tags, or logos from the image. The final image must have absolutely NO text visible anywhere.`
  );
}

class ThumbnailDesignerAgent {
  constructor(db, credentials) {
    this.db = db;
    this.credentials = credentials;
    this.logger = new Logger('ThumbnailDesigner');
    this.templatesPath = path.join(__dirname, '..', 'data', 'thumbnail-templates');

    // fal.ai img2img pipeline con Sharp como fallback.
    if (process.env.FAL_KEY) {
      fal.config({ credentials: process.env.FAL_KEY });
      this.falEnabled = true;
      this.logger.info('fal.ai client configurado (pipeline img2img activo)');
    } else {
      this.falEnabled = false;
      this.logger.warn('FAL_KEY no configurado — usando Sharp Black Hole como fallback');
    }
  }

  async initialize() {
    this.logger.info('Initializing Thumbnail Designer Agent...');
    await this.ensureTemplatesDirectory();
    return true;
  }

  async ensureTemplatesDirectory() {
    try {
      await fs.mkdir(this.templatesPath, { recursive: true });
      await fs.mkdir(path.join(__dirname, '..', 'uploads', 'thumbnails'), { recursive: true });
      await fs.mkdir(path.join(__dirname, '..', 'uploads', 'product_images'), { recursive: true });
    } catch (error) {
      this.logger.error('Failed to create directories:', error);
    }
  }

  async generateThumbnail(script) {
    try {
      this.logger.info(`Generating thumbnail for: ${script.title}`);

      const firstSection = script.mainContent?.sections?.[0];
      const productPhotoUrl = firstSection?.productPhoto || null;
      const videoPath = firstSection?.videoPath || null;

      let finalPath = null;

      // ── Ruta 1: Imagen del producto (máxima resolución) ──
      if (productPhotoUrl) {
        try {
          this.logger.info(`Downloading product image: ${productPhotoUrl}`);
          finalPath = await this._downloadAndResizeProductImage(productPhotoUrl, script.title);
        } catch (imgErr) {
          this.logger.warn(`Image download/processing failed: ${imgErr.message}`);
          finalPath = null;
        }
      }

      // ── Ruta 2: Frame del video MP4 (segundo 5) ──
      if (!finalPath && videoPath) {
        try {
          this.logger.info(`Extracting video frame from: ${path.basename(videoPath)}`);
          finalPath = await this._extractAndProcessVideoFrame(videoPath);
        } catch (frameErr) {
          this.logger.warn(`Video frame extraction failed: ${frameErr.message}`);
          finalPath = null;
        }
      }

      // ── Ruta 3: Fallback oscuro cinematográfico (sin colores, sin texto) ──
      if (!finalPath) {
        this.logger.warn('All cinematic paths failed — generating dark cinematic fallback');
        const darkSvg = `<svg width="3840" height="2160" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <radialGradient id="bg" cx="50%" cy="50%" r="70%">
              <stop offset="0%"  stop-color="#0d1117"/>
              <stop offset="60%" stop-color="#050810"/>
              <stop offset="100%" stop-color="#000000"/>
            </radialGradient>
            <radialGradient id="glow" cx="50%" cy="45%" r="40%">
              <stop offset="0%"  stop-color="#1a2a4a" stop-opacity="0.6"/>
              <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
            </radialGradient>
          </defs>
          <rect width="3840" height="2160" fill="url(#bg)"/>
          <rect width="3840" height="2160" fill="url(#glow)"/>
        </svg>`;
        const darkBuf = await sharp(Buffer.from(darkSvg))
          .jpeg({ quality: 85, progressive: true })
          .toBuffer();
        const fallbackPath = path.join(
          __dirname, '..', 'uploads', 'thumbnails',
          `thumbnail_optimized_${Date.now()}.jpg`
        );
        await fs.writeFile(fallbackPath, darkBuf);
        finalPath = fallbackPath;
      }

      const thumbnailData = {
        path: finalPath,
        dimensions: { width: 3840, height: 2160 },
        fileSize: await this.getFileSize(finalPath),
        createdAt: new Date().toISOString()
      };

      await this.db.saveThumbnail(thumbnailData);
      this.logger.info('Thumbnail generated successfully');
      return thumbnailData;
    } catch (error) {
      this.logger.error('Failed to generate thumbnail:', error);
      throw error;
    }
  }

  async _downloadAndResizeProductImage(imageUrl, productName = 'premium tech gadget') {
    const ts = Date.now();
    const outputPath = path.join(
      __dirname, '..', 'uploads', 'thumbnails',
      `thumbnail_optimized_${ts}.jpg`
    );

    const highResUrl = this._upgradeAmazonImageUrl(imageUrl);
    this.logger.info(`Fetching image (high-res): ${highResUrl.substring(0, 100)}`);

    const _fetch = async (url) => {
      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 20000,
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      const buf = Buffer.from(response.data);
      if (buf.length < 5000) {
        throw new Error(`Downloaded file too small (${buf.length} bytes) — likely an error page, not an image`);
      }
      // Validate magic bytes: JPEG (ffd8), PNG (89504e47), WebP (52494646)
      const hex = buf.slice(0, 4).toString('hex');
      if (!hex.startsWith('ffd8') && !hex.startsWith('89504e47') && !hex.startsWith('52494646')) {
        throw new Error(`Not a valid image — magic bytes: ${hex}`);
      }
      return buf;
    };

    let srcBuffer;
    try {
      srcBuffer = await _fetch(highResUrl);
    } catch (err) {
      if (highResUrl !== imageUrl) {
        this.logger.warn(`High-res URL failed (${err.message}), retrying with original`);
        srcBuffer = await _fetch(imageUrl);
      } else {
        throw err;
      }
    }

    // Save raw white-background catalog image for Gemini input / debugging
    const rawPath = path.join(
      __dirname, '..', 'uploads', 'product_images',
      `product_raw_${ts}.jpg`
    );
    await fs.writeFile(rawPath, srcBuffer);
    this.logger.info(`Raw catalog image saved: ${path.basename(rawPath)} (${(srcBuffer.length / 1024).toFixed(0)} KB)`);

    // ── Ruta A: fal.ai img2img cinematic pipeline ──
    if (this.falEnabled) {
      try {
        return await this._generateCinematicWithFal(srcBuffer, productName, outputPath);
      } catch (falErr) {
        this.logger.warn(`fal.ai pipeline falló (${falErr.message}) — usando Sharp Black Hole como fallback`);
      }
    }

    // ── Ruta B: Sharp Black Hole fallback ──
    return this._applyCinematicPipeline(srcBuffer, outputPath);
  }

  /**
   * Tries to replace Amazon thumbnail size tokens with the highest resolution available.
   * e.g. ._SL160_. → ._SL1500_.   ._AC_US400_. → ._AC_SL1500_.
   */
  _upgradeAmazonImageUrl(url) {
    if (!url) return url;
    return url
      .replace(/\._[A-Z]{2}\d+_\./g, '._SL1500_.')       // ._SL160_. ._SL75_. etc.
      .replace(/\._AC_[A-Z0-9,_]+_\./g, '._AC_SL1500_.') // ._AC_US400_. ._AC_SX300_. etc.
      .replace(/\._SR\d+,\d+_\./g, '._SL1500_.')          // ._SR38,50_. etc.
  }

  /**
   * Extracts frame at second 5 from an MP4 file using FFmpeg,
   * then applies the full cinematic pipeline.
   */
  async _extractAndProcessVideoFrame(videoPath) {
    const outputPath = path.join(
      __dirname, '..', 'uploads', 'thumbnails',
      `thumbnail_optimized_${Date.now()}.jpg`
    );
    const tempFrame = path.join(
      __dirname, '..', 'uploads', 'thumbnails',
      `_frame_tmp_${Date.now()}.jpg`
    );

    // Extract single frame at second 5 (fallback to second 1 if video is short)
    const ffmpegCmd = `ffmpeg -y -ss 5 -i "${videoPath}" -vframes 1 -q:v 2 "${tempFrame}"`;
    try {
      await execPromise(ffmpegCmd, { timeout: 30000 });
    } catch (_) {
      // Video might be shorter than 5s — retry at second 1
      const fallbackCmd = `ffmpeg -y -ss 1 -i "${videoPath}" -vframes 1 -q:v 2 "${tempFrame}"`;
      await execPromise(fallbackCmd, { timeout: 30000 });
    }

    const srcBuffer = await fs.readFile(tempFrame);
    await fs.unlink(tempFrame).catch(() => {});

    return this._applyCinematicPipeline(srcBuffer, outputPath);
  }

  /**
   * generarMiniaturaProducto — función pública standalone.
   * Conecta RapidAPI con fal.ai en 4 pasos:
   *   1. Descarga la imagen desde urlImagenRapidAPI (arraybuffer)
   *   2. Sube el buffer a fal.ai storage
   *   3. Llama al modelo fal-ai/flux-2-pro/edit
   *   4. Retorna la URL final de la imagen generada
   */
  async procesarMiniaturaProducto(productName, urlImagen) {
    const promptFinal = crearPromptMaestro(productName || 'premium tech gadget');

    // ── Paso 1: Descargar imagen de RapidAPI ──
    console.log('[ThumbnailDesigner] Paso 1: Descargando imagen original...');
    const response = await axios.get(urlImagen, {
      responseType: 'arraybuffer',
      timeout: 20000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const bufferImagen = Buffer.from(response.data);
    console.log(`[ThumbnailDesigner] Paso 1 OK — imagen descargada: ${(bufferImagen.length / 1024).toFixed(0)} KB`);

    // ── Paso 2: Convertir a Base64 (omite fal.storage.upload) ──
    console.log('[ThumbnailDesigner] Paso 2: Convirtiendo a formato Base64...');
    const base64String = bufferImagen.toString('base64');
    const mimeType = response.headers['content-type'] || 'image/jpeg';
    const dataUri = `data:${mimeType};base64,${base64String}`;

    // ── Paso 3 + 4: Llamar al modelo de edición ──
    console.log('[ThumbnailDesigner] Paso 3: Aplicando IA cinematográfica (FLUX 2 Pro)...');
    const resultado = await fal.subscribe('fal-ai/flux-2-pro/edit', {
      input: {
        prompt:      promptFinal,
        image_urls:  [dataUri],
        image_size:  'landscape_16_9'
      },
      logs: true,
      onQueueUpdate: (update) => {
        if (update.status === 'IN_PROGRESS' && update.logs?.length) {
          update.logs.forEach(l => console.log(`[fal.ai] ${l.message}`));
        }
      }
    });

    const urlFinal =
      resultado?.data?.images?.[0]?.url ||
      resultado?.images?.[0]?.url;
    if (!urlFinal) throw new Error('fal.ai no retornó URL de imagen en la respuesta');

    console.log(`[fal.ai] Paso 4 OK — imagen generada: ${urlFinal.substring(0, 80)}...`);
    return urlFinal;
  }

  /**
   * Llamada a fal.ai CON REINTENTOS AUTOMÁTICOS + TIMEOUT ESTRICTO.
   * Implementa adaptabilidad dinámica:
   *   - Intento 1: Timeout 45s
   *   - Si falla → espera 5s
   *   - Intento 2: Timeout 45s
   *   - Si falla → retorna null (el llamador usa fallback)
   * 
   * @param {string} model - Modelo fal.ai (ej: 'fal-ai/flux-2-pro/edit')
   * @param {object} input - Parámetros del modelo
   * @param {boolean} logs - Mostrar logs de fal.ai
   * @param {function} onQueueUpdate - Callback para updates
   * @returns {Promise<object|null>} Resultado o null si todos los intentos fallan
   */
  async _callFalApiWithRetry(model, input, logs = true, onQueueUpdate = null) {
    const maxAttempts = 2;
    const retryDelay = 5000;  // 5 segundos entre intentos
    const timeout = 45000;    // 45 segundos por intento

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        this.logger.info(`[fal.ai] Intento ${attempt}/${maxAttempts} — llamando ${model} (timeout 45s)...`);

        // Crear promesa de timeout que se rechaza después de 45s
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => {
            reject(new Error('Timeout 45 segundos excedido en fal.ai'));
          }, timeout)
        );

        // Correr fal.subscribe con timeout paralelo
        const subscribePromise = fal.subscribe(model, {
          input,
          logs,
          onQueueUpdate: onQueueUpdate || (() => {})
        });

        // La promesa que resuelve primero gana (o pierde en caso de timeout)
        const result = await Promise.race([subscribePromise, timeoutPromise]);
        this.logger.info(`✅ [fal.ai] Intento ${attempt} exitoso`);
        return result;

      } catch (error) {
        if (attempt < maxAttempts) {
          this.logger.warn(`⚠️  [fal.ai] Intento ${attempt} falló: ${error.message}`);
          this.logger.info(`⏳ [fal.ai] Esperando 5 segundos antes de reintentar...`);
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        } else {
          this.logger.error(`❌ [fal.ai] Falló tras ${maxAttempts} intentos: ${error.message}`);
          return null;  // Señal de fallo — el llamador usará fallback
        }
      }
    }

    return null;  // Failsafe
  }

  /**
   * _generateCinematicWithFal — integración privada con el pipeline de thumbnails.
   * Construye el prompt cinematográfico, llama a fal.ai con reintentos automáticos,
   * y redimensiona el resultado a 3840×2160 con Sharp.
   * 
   * Si fal.ai falla tras los reintentos, retorna la imagen original procesada
   * con Sharp Black Hole (fallback dinámico sin romper pipeline).
   */
  async _generateCinematicWithFal(srcBuffer, productName, outputPath) {
    const W = 3840;
    const H = 2160;
    const MAX_BYTES = 2 * 1024 * 1024;

    // Log del producto para debugging
    const cleanName = (productName || 'premium tech gadget')
      .replace(/["\n\r]/g, ' ')
      .substring(0, 120)
      .trim();

    this.logger.info(`[fal.ai] Generando miniatura cinematográfica para: "${cleanName.substring(0, 60)}"`);

    // Convertir buffer a Base64 data URI
    const dataUri = `data:image/jpeg;base64,${srcBuffer.toString('base64')}`;

    // ═══════════════════════════════════════════════════════════════════════════════
    // PASO 3A: Llamar a fal.ai CON REINTENTOS + TIMEOUT ADAPTABLE
    // ═══════════════════════════════════════════════════════════════════════════════
    const resultado = await this._callFalApiWithRetry(
      'fal-ai/flux-2-pro/edit',
      {
        prompt:      crearPromptMaestro(cleanName),
        image_urls:  [dataUri],
        image_size:  'landscape_16_9'
      },
      true,
      (update) => {
        if (update.status === 'IN_PROGRESS' && update.logs?.length) {
          update.logs.forEach(l => this.logger.info(`[fal] ${l.message}`));
        }
      }
    );

    // ═══════════════════════════════════════════════════════════════════════════════
    // PASO 3B: FALLBACK DINÁMICO — Si fal.ai falló, usar imagen original con Sharp
    // ═══════════════════════════════════════════════════════════════════════════════
    if (!resultado) {
      this.logger.warn(`⚠️  [FALLBACK] fal.ai no disponible tras reintentos → usando Sharp Black Hole`);
      return this._applyCinematicPipeline(srcBuffer, outputPath);
    }

    const urlFinal =
      resultado?.data?.images?.[0]?.url ||
      resultado?.images?.[0]?.url;
    
    if (!urlFinal) {
      this.logger.warn(`⚠️  [FALLBACK] fal.ai no retornó URL válida → usando Sharp Black Hole`);
      return this._applyCinematicPipeline(srcBuffer, outputPath);
    }
    this.logger.info(`✅ fal.ai generó miniatura: ${urlFinal.substring(0, 80)}...`);

    // ═══════════════════════════════════════════════════════════════════════════════
    // PASO 4: Descargar resultado y redimensionar a 3840×2160 con Sharp
    // ═══════════════════════════════════════════════════════════════════════════════
    try {
      const dlResponse = await axios.get(urlFinal, {
        responseType: 'arraybuffer',
        timeout: 60000,
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      const resultBuffer = Buffer.from(dlResponse.data);
      if (resultBuffer.length < 5000) {
        throw new Error(`Descarga demasiado pequeña: ${resultBuffer.length} bytes`);
      }

      const framed = await sharp(resultBuffer)
        .resize(W, H, { fit: 'contain', background: { r: 5, g: 5, b: 8, alpha: 255 } })
        .flatten({ background: '#050508' })
        .toBuffer();

      let quality = 90;
      let outputBuffer;
      do {
        outputBuffer = await sharp(framed)
          .jpeg({ quality, progressive: true, chromaSubsampling: '4:4:4' })
          .toBuffer();
        if (outputBuffer.length <= MAX_BYTES) break;
        quality -= 8;
      } while (quality >= 40);

      await fs.writeFile(outputPath, outputBuffer);
      this.logger.info(`✅ Miniatura fal.ai guardada (${(outputBuffer.length / 1024).toFixed(0)} KB, q=${quality})`);
      return outputPath;
    } catch (dlErr) {
      this.logger.warn(`⚠️  [FALLBACK] Error descargando resultado fal.ai → usando Sharp Black Hole: ${dlErr.message}`);
      return this._applyCinematicPipeline(srcBuffer, outputPath);
    }
  }

  /**
   * Cinematic "Black Hole" pipeline — 100% native Sharp, no external AI.
   * Stamps a radial-gradient SVG over the raw product photo to devour the white
   * catalog background while keeping the gadget visible at the centre, then
   * frames it in a 16:9 (3840×2160) dark letterbox and boosts product colours.
   */
  async _applyCinematicPipeline(srcBuffer, outputPath) {
    const W = 3840;
    const H = 2160;
    const MAX_BYTES = 2 * 1024 * 1024;

    // ── 1. Validate + get source dimensions ──
    if (!srcBuffer || srcBuffer.length < 5000) {
      throw new Error(`Image buffer invalid (${srcBuffer?.length || 0} bytes) — aborting thumbnail generation`);
    }
    let meta;
    try { meta = await sharp(srcBuffer).metadata(); } catch (e) {
      throw new Error(`Cannot decode image: ${e.message}`);
    }
    if (!meta.width || !meta.height || meta.width < 50 || meta.height < 50) {
      throw new Error(`Image dimensions too small: ${meta.width}x${meta.height} — corrupted?`);
    }
    this.logger.info(`Source image OK: ${meta.width}x${meta.height}, ${(srcBuffer.length/1024).toFixed(0)} KB`);

    const sw = meta.width;
    const sh = meta.height;

    // ── 2. Black Hole SVG — same size as the source image
    //    Centre (0–35%): fully transparent → product stays visible
    //    Edge  (55–100%): solid near-black → white catalog BG disappears
    const blackHoleSvg = `<svg width="${sw}" height="${sh}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="hole" cx="50%" cy="50%" r="50%">
          <stop offset="0%"   stop-color="black" stop-opacity="0"/>
          <stop offset="35%"  stop-color="black" stop-opacity="0"/>
          <stop offset="55%"  stop-color="#050508" stop-opacity="1"/>
          <stop offset="100%" stop-color="#050508" stop-opacity="1"/>
        </radialGradient>
      </defs>
      <rect width="${sw}" height="${sh}" fill="url(#hole)"/>
    </svg>`;

    // ── 3. Stamp the black hole over the product + boost colours ──
    const composited = await sharp(srcBuffer)
      .composite([{ input: Buffer.from(blackHoleSvg), blend: 'over' }])
      .modulate({ brightness: 1.15, saturation: 1.6 })
      .toBuffer();

    // ── 4. Fit into 16:9 canvas (3840×2160) with near-black letterbox ──
    const framed = await sharp(composited)
      .resize(W, H, {
        fit: 'contain',
        background: { r: 5, g: 5, b: 8, alpha: 255 }
      })
      .flatten({ background: '#050508' })
      .toBuffer();

    // ── 5. Compress JPEG ≤ 2 MB ──
    let quality = 90;
    let outputBuffer;
    do {
      outputBuffer = await sharp(framed)
        .jpeg({ quality, progressive: true, chromaSubsampling: '4:4:4' })
        .toBuffer();
      if (outputBuffer.length <= MAX_BYTES) break;
      quality -= 8;
    } while (quality >= 40);

    await fs.writeFile(outputPath, outputBuffer);
    this.logger.info(`Cinematic thumbnail saved (${(outputBuffer.length/1024).toFixed(0)} KB, q=${quality})`);
    return outputPath;
  }

  async generateConcept(script) {
    const concepts = {
      tutorial: {
        style: 'clean',
        elements: ['step numbers', 'arrows', 'progress indicators'],
        colors: ['blue', 'white', 'green'],
        emotion: 'helpful'
      },
      explainer: {
        style: 'informative',
        elements: ['icons', 'diagrams', 'question marks'],
        colors: ['purple', 'yellow', 'white'],
        emotion: 'curious'
      },
      list: {
        style: 'numbered',
        elements: ['large numbers', 'countdown', 'highlights'],
        colors: ['red', 'yellow', 'black'],
        emotion: 'exciting'
      },
      review: {
        style: 'comparative',
        elements: ['product image', 'rating stars', 'vs symbol'],
        colors: ['orange', 'gray', 'white'],
        emotion: 'analytical'
      },
      story: {
        style: 'dramatic',
        elements: ['faces', 'emotion', 'journey path'],
        colors: ['dark blue', 'gold', 'white'],
        emotion: 'intriguing'
      }
    };

    const baseConcept = concepts[script.metadata?.strategy?.contentType?.toLowerCase()] || concepts.explainer;
    
    return {
      title: this.formatThumbnailTitle(script.title),
      style: baseConcept.style,
      primaryText: this.extractPrimaryText(script.title),
      secondaryText: this.generateSecondaryText(script),
      elements: baseConcept.elements,
      colors: {
        primary: baseConcept.colors[0],
        secondary: baseConcept.colors[1],
        accent: baseConcept.colors[2]
      },
      emotion: baseConcept.emotion,
      composition: this.selectComposition(),
      effects: this.selectEffects()
    };
  }

  formatThumbnailTitle(title) {
    // Shorten title for thumbnail
    const words = title.split(' ');
    if (words.length > 5) {
      return words.slice(0, 5).join(' ') + '...';
    }
    return title;
  }

  extractPrimaryText(title) {
    // Extract most impactful words
    const impactWords = ['ultimate', 'complete', 'secret', 'truth', 'how', 'why', 'best', 'top', 'guide', 'master'];
    const titleWords = title.toLowerCase().split(' ');
    
    const foundImpactWords = titleWords.filter(word => impactWords.includes(word));
    
    if (foundImpactWords.length > 0) {
      return foundImpactWords[0].toUpperCase();
    }
    
    // Extract numbers if present
    const numbers = title.match(/\d+/);
    if (numbers) {
      return numbers[0];
    }
    
    // Use first significant word
    return titleWords.find(word => word.length > 4)?.toUpperCase() || 'WATCH';
  }

  generateSecondaryText(script) {
    if (script.metadata && script.metadata.strategy) {
      const strategy = script.metadata.strategy;
      
      if (strategy.contentType === 'Tutorial') {
        return 'STEP BY STEP';
      } else if (strategy.contentType === 'List') {
        return 'YOU WON\'T BELIEVE #1';
      } else if (strategy.contentType === 'Review') {
        return 'HONEST REVIEW';
      }
    }
    
    return 'MUST WATCH';
  }

  selectComposition() {
    const compositions = [
      'rule-of-thirds',
      'centered',
      'diagonal',
      'golden-ratio',
      'symmetrical'
    ];
    
    return compositions[Math.floor(Math.random() * compositions.length)];
  }

  selectEffects() {
    return {
      blur: Math.random() > 0.5,
      vignette: Math.random() > 0.7,
      glow: Math.random() > 0.6,
      shadow: true,
      border: Math.random() > 0.8
    };
  }

  async createPrompt(concept) {
    const prompt = `Create a YouTube thumbnail with the following specifications:
    Style: ${concept.style}
    Primary Text: "${concept.primaryText}"
    Secondary Text: "${concept.secondaryText}"
    Color Scheme: ${concept.colors.primary}, ${concept.colors.secondary}, ${concept.colors.accent}
    Elements to include: ${concept.elements.join(', ')}
    Emotional tone: ${concept.emotion}
    Composition: ${concept.composition}
    
    The thumbnail should be eye-catching, professional, and optimized for high click-through rate.
    Resolution: 1280x720px
    Format: High contrast, bold text, clear imagery`;
    
    return prompt;
  }

  async createThumbnail(concept) {
    // Create a base thumbnail using Sharp
    const width = 1280;
    const height = 720;
    
    const outputPath = path.join(__dirname, '..', 'uploads', 'thumbnails', `thumbnail_${Date.now()}.png`);
    
    // Create gradient background
    const svg = `
      <svg width="${width}" height="${height}">
        <defs>
          <linearGradient id="gradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" style="stop-color:${this.hexToRgb(concept.colors.primary)};stop-opacity:1" />
            <stop offset="100%" style="stop-color:${this.hexToRgb(concept.colors.secondary)};stop-opacity:1" />
          </linearGradient>
        </defs>
        <rect width="${width}" height="${height}" fill="url(#gradient)" />
      </svg>
    `;
    
    await sharp(Buffer.from(svg))
      .resize(width, height)
      .png()
      .toFile(outputPath);
    
    return outputPath;
  }

  hexToRgb(color) {
    // Color name to hex mapping
    const colors = {
      'blue': '#0066CC',
      'red': '#CC0000',
      'green': '#00CC66',
      'yellow': '#FFCC00',
      'purple': '#6600CC',
      'orange': '#FF6600',
      'white': '#FFFFFF',
      'black': '#000000',
      'gray': '#808080',
      'dark blue': '#003366',
      'gold': '#FFD700'
    };
    
    return colors[color] || '#000000';
  }

  async addTextOverlay(imagePath, concept) {
    const outputPath = path.join(__dirname, '..', 'uploads', 'thumbnails', `thumbnail_final_${Date.now()}.png`);
    
    // Create text overlay SVG
    const textSvg = `
      <svg width="1280" height="720">
        <style>
          .primary { 
            fill: ${concept.colors.accent === 'white' ? 'white' : 'black'}; 
            font-size: 120px; 
            font-weight: bold; 
            font-family: Arial, sans-serif;
            text-anchor: middle;
          }
          .secondary { 
            fill: ${concept.colors.accent}; 
            font-size: 60px; 
            font-weight: bold; 
            font-family: Arial, sans-serif;
            text-anchor: middle;
          }
          .shadow {
            fill: black;
            opacity: 0.5;
          }
        </style>
        
        <!-- Shadow -->
        <text x="642" y="302" class="primary shadow">${concept.primaryText}</text>
        <text x="642" y="402" class="secondary shadow">${concept.secondaryText}</text>
        
        <!-- Main text -->
        <text x="640" y="300" class="primary">${concept.primaryText}</text>
        <text x="640" y="400" class="secondary">${concept.secondaryText}</text>
      </svg>
    `;
    
    const textOverlay = await sharp(Buffer.from(textSvg)).png().toBuffer();
    
    await sharp(imagePath)
      .composite([{
        input: textOverlay,
        top: 0,
        left: 0
      }])
      .toFile(outputPath);
    
    return outputPath;
  }

  async optimizeForYouTube(imagePath) {
    const outputPath = path.join(__dirname, '..', 'uploads', 'thumbnails', `thumbnail_optimized_${Date.now()}.jpg`);
    
    // YouTube optimization: JPEG format, proper compression
    await sharp(imagePath)
      .resize(1280, 720, {
        fit: 'cover',
        position: 'centre'
      })
      .jpeg({
        quality: 90,
        progressive: true,
        optimizeScans: true
      })
      .toFile(outputPath);
    
    // Verify file size (YouTube limit is 2MB)
    const stats = await fs.stat(outputPath);
    if (stats.size > 2 * 1024 * 1024) {
      // Re-compress if too large
      await sharp(imagePath)
        .resize(1280, 720)
        .jpeg({ quality: 80 })
        .toFile(outputPath);
    }
    
    return outputPath;
  }

  async getFileSize(filePath) {
    const stats = await fs.stat(filePath);
    return stats.size;
  }

  async generateABVariants(concept) {
    // Generate multiple thumbnail variants for A/B testing
    const variants = [];
    
    // Variant 1: Different color scheme
    const variant1 = { ...concept };
    variant1.colors = {
      primary: concept.colors.secondary,
      secondary: concept.colors.primary,
      accent: concept.colors.accent
    };
    variants.push(await this.createThumbnail(variant1));
    
    // Variant 2: Different text
    const variant2 = { ...concept };
    variant2.primaryText = this.generateAlternativeText(concept.primaryText);
    variants.push(await this.createThumbnail(variant2));
    
    // Variant 3: Different composition
    const variant3 = { ...concept };
    variant3.composition = 'centered';
    variants.push(await this.createThumbnail(variant3));
    
    return variants;
  }

  generateAlternativeText(originalText) {
    const alternatives = {
      'HOW': 'WHY',
      'BEST': 'TOP',
      'GUIDE': 'SECRETS',
      'TRUTH': 'FACTS',
      'ULTIMATE': 'COMPLETE'
    };
    
    return alternatives[originalText] || originalText + '!';
  }
}

module.exports = { ThumbnailDesignerAgent };