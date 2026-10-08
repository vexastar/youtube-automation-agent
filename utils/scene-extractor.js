/**
 * scene-extractor.js
 *
 * Divide un video en segmentos usando Twelve Labs como motor de comprensión de video.
 * Ejecuta búsquedas visuales para identificar "close-ups de gadgets con manos interactuando",
 * luego extrae esos segmentos como MP4s independientes.
 *
 * Motor: Twelve Labs API (marengo2.6 + opciones 'visual')
 * FFmpeg: Solo para extracción de segmentos y cálculo de duración
 *
 * API:
 *   extractAndFilterScenes(videoPath, outputDir, opts) → Promise<Array<Scene>>
 *
 * Scene = {
 *   path:       string,   // ruta al mp4 del segmento
 *   start:      number,   // segundos desde el inicio del video original
 *   duration:   number,   // duración en segundos
 *   source:     'twelve-labs' | 'whole-fallback'
 * }
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const { TwelveLabs } = require('twelvelabs-js');

async function probeDuration(filePath) {
  try {
    const { stdout } = await execPromise(
      `ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "${filePath}"`
    );
    return parseFloat(stdout.trim()) || 0;
  } catch (_) { return 0; }
}

async function extractSegment(videoPath, start, duration, outPath) {
  // -ss antes de -i = seek rápido por keyframes; re-encode para precisión y
  // para que cada segmento sea independiente y concatenable más tarde.
  // 
  // FILTROS DE VIDEO:
  // 1. Normalizar a 1920x1080 (scale + crop para aspect ratio)
  // 2. Ken Burns dinámico (zoompan): zoom-in progresivo lento desde 1.0x a 1.5x
  //    para crear sensación de movimiento de cámara y evitar clips estáticos
  // 3. El parámetro 'd' (duración de cada frame) se ajusta a la duración total
  
  // Calcular frames por segundo y duración total en frames para zoompan
  const fps = 30; // Asumiendo 30 fps (estándar YouTube)
  const totalFrames = Math.ceil(duration * fps);
  
  const cmd = `ffmpeg -hide_banner -y -ss ${start.toFixed(3)} -i "${videoPath}" -t ${duration.toFixed(3)} -an -vf "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,zoompan=z='min(zoom+0.0015,1.5)':d=${totalFrames}:s=1920x1080" "${outPath}"`;
  await execPromise(cmd, { maxBuffer: 8 * 1024 * 1024 });
}

/**
 * Divide y filtra un video por escenas usando Twelve Labs.
 * 
 * Flujo:
 * 1. Instancia cliente de Twelve Labs (TWELVE_LABS_API_KEY)
 * 2. Crea índice con modelo 'marengo2.6' y opciones 'visual'
 * 3. Sube el videoPath mediante stream y espera indexación
 * 4. Ejecuta búsqueda visual con prompt optimizado para B-Roll de alta retención
 * 5. Itera sobre resultados, extrae segmentos MP4 con duración 1.2-3.5s y devuelve array
 *
 * @param {string} videoPath - ruta absoluta al video
 * @param {string} outputDir - directorio para guardar segmentos MP4
 * @param {object} [opts]
 *   logger (console) - objeto con log(), warn(), error()
 * @returns {Promise<Array<Scene>>}
 *   Scene = { path, start, duration, source: 'twelve-labs' }
 */
async function extractAndFilterScenes(videoPath, outputDir, opts = {}) {
  let { logger = console } = opts;

  // Logger blindado: asegurar que `logger.log` existe y es una función.
  // Si no existe, enlazar a `logger.info` o a `console.log` para evitar errores.
  try {
    if (!logger || typeof logger.log !== 'function') {
      if (logger && typeof logger.info === 'function') {
        logger.log = logger.info.bind(logger);
      } else {
        // Fallback definitivo a console.log
        logger = logger || console;
        logger.log = console.log.bind(console);
      }
    }
  } catch (e) {
    // En caso de cualquier problema, garantizamos un logger funcional
    logger = console;
    logger.log = console.log.bind(console);
  }

  // Parámetros de duración para ritmo de alta retención (estilo Shorts/TikTok)
  const MIN_DURATION = 1.2; // segundos mínimos
  const MAX_DURATION = 3.5; // segundos máximos (truncar si excede)

  // Validar entrada
  if (!fs.existsSync(videoPath)) {
    logger.warn(`[SceneExtractor/TwelveLabs] ⚠ Video no existe: ${videoPath}`);
    return [];
  }
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Verificar API key
  const apiKey = process.env.TWELVE_LABS_API_KEY;
  if (!apiKey) {
    logger.error('[SceneExtractor/TwelveLabs] ✗ TWELVE_LABS_API_KEY no configurada');
    return [];
  }

  const totalDur = await probeDuration(videoPath);
  if (totalDur <= 0) {
    logger.warn(`[SceneExtractor/TwelveLabs] ⚠ Video con duración 0: ${videoPath}`);
    return [];
  }

  logger.info(`[SceneExtractor/TwelveLabs] Iniciando análisis de ${path.basename(videoPath)} (${totalDur.toFixed(1)}s)...`);
  logger.info(`[SceneExtractor/TwelveLabs] Parámetros de retención: ${MIN_DURATION}s-${MAX_DURATION}s por clip`);

  try {
    // ── 1. Instanciar cliente de Twelve Labs ──────────────────────────────
    const client = new TwelveLabs({ apiKey });
    logger.info('[SceneExtractor/TwelveLabs] ✓ Cliente Twelve Labs instanciado');

    // --- 2. Crear índice con modelo 'marengo2.6' y opciones 'visual' ---
    logger.info('[SceneExtractor/TwelveLabs] → Creando índice (modelo: marengo3.0, opciones: visual)...');
    const indexName = `scene_extract_${Math.round(Date.now() / 1000)}`;
    
    const index = await client.indexes.create({
      indexName: indexName,
      models: [
        {
          modelName: 'marengo3.0',
          modelOptions: ['visual']
        }
      ]
    });
    
    logger.info(`[SceneExtractor/TwelveLabs] ✓ Índice creado: ${index.id}`);

    // --- 3. Subir video mediante stream y esperar indexación (HTTP directo con axios) ---
    logger.info(`[SceneExtractor/TwelveLabs] → Subiendo video: ${path.basename(videoPath)}...`);
    
// 1. Obtener el tamaño exacto del archivo físico
    const stats = fs.statSync(videoPath);

  // --- 3. Subir video y esperar indexación (SDK Oficial v1.2+) ---
    logger.info(`[SceneExtractor/TwelveLabs] -> Subiendo asset físico: ${path.basename(videoPath)}...`);
    
// --- 3.1 Subir Asset con Auto-Reintento anti micro-cortes ---
    let asset;
    let intentos = 3;
    
    while (intentos > 0) {
      try {
        asset = await client.assets.create({
          method: "direct",
          file: fs.createReadStream(videoPath)
        });
        logger.info(`[SceneExtractor/TwelveLabs] ✓ Asset subido (ID: ${asset.id}). Esperando preparación...`);
        break; // Éxito total, salimos del bucle de reintentos
      } catch (uploadError) {
        intentos--;
        logger.info(`[SceneExtractor/TwelveLabs] ⚠️ Fallo de red al subir. Reintentos restantes: ${intentos}`);
        if (intentos === 0) throw uploadError; // Si se acaban los intentos, ahora sí lanzamos el error fatal
        await new Promise(resolve => setTimeout(resolve, 3000)); // Esperar 3 seg para que la red se estabilice
      }
    }
// --- Esperar a que el archivo físico esté listo antes de indexar ---
    logger.info(`[SceneExtractor/TwelveLabs] Esperando a que el archivo físico sea validado internamente...`);
    while (true) {
      asset = await client.assets.retrieve(asset.id);
      if (asset.status === "ready") {
        logger.info(`[SceneExtractor/TwelveLabs] ✓ Archivo validado. Pasando a indexación visual...`);
        break;
      } else if (asset.status === "failed") {
        throw new Error("Twelve Labs falló al procesar el archivo físico.");
      }
      // Preguntar cada 3 segundos
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
    // 3.2 Conectar el Asset a tu Índice con el modelo marengo3.0
    let indexedAsset = await client.indexes.indexedAssets.create(index.id, { 
      assetId: asset.id 
    });

// 3.3 Bucle de espera (Polling) hasta que la IA termine de procesar el B-Roll
    while (true) {
      try {
        indexedAsset = await client.indexes.indexedAssets.retrieve(index.id, indexedAsset.id);
        
        if (indexedAsset.status === "ready") {
          logger.info(`[SceneExtractor/TwelveLabs] ✓ ¡Video listo para extraer escenas dinámicas!`);
          break;
        } else if (indexedAsset.status === "failed") {
          throw new Error("La indexación del video falló internamente en Twelve Labs.");
        }
        
        logger.info(`[SceneExtractor/TwelveLabs] Estado: ${indexedAsset.status}. Esperando...`);
      } catch (pollingError) {
        // Atrapamos el fetch failed para que el agente no muera, solo advierta.
        logger.info(`[SceneExtractor/TwelveLabs] ⚠️ Micro-corte de red ignorado (${pollingError.message}). Reintentando...`);
      }
      
      // Esperar 5 segundos antes de volver a consultar para no saturar la API
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
    // --- 4. Búsqueda visual DINÁMICA guiada por Audio y GPT ---
    // Extraemos los prompts visuales y la duración objetivo desde los opts
    const visualPrompts = opts.visualPrompts && opts.visualPrompts.length > 0 
        ? opts.visualPrompts 
        : ["Extreme close up of tech gadget, dynamic camera movement"]; // Fallback por si acaso
    
    const targetAudioDuration = opts.targetAudioDuration || null;
    const productName = opts.productName || null;  // Nombre del producto para fallback dinámico
    
    // Matemática de corte: Dividimos la duración del audio entre la cantidad de escenas
    const clipDurationExact = targetAudioDuration 
        ? (targetAudioDuration / visualPrompts.length) 
        : 3.5; // Si no hay audio, usamos un ritmo rápido por defecto

    logger.info(`[SceneExtractor/TwelveLabs] -> Ejecutando búsqueda dinámica: ${visualPrompts.length} escenas a ${clipDurationExact.toFixed(2)}s c/u...`);
    
    const escenasExtraidas = [];

    /**
     * Sistema de Fallback Robusto (3 niveles)
     * Nivel 1: Prompt cinematográfico original
     * Nivel 2: Prompt genérico permisivo
     * Nivel 3: Prompt ultra-genérico (último recurso)
     */
    const generateFallbackPrompts = (originalPrompt, productName) => {
      return [
        originalPrompt,  // Nivel 1: Original (ej: "Extreme close up of tech gadget...")
        "The product clearly visible, product demonstration, or device in use",  // Nivel 2: Genérico
        productName 
          ? `${productName} visible on screen`  // Nivel 3a: Con nombre de producto
          : "Any product or device on display",  // Nivel 3b: Sin nombre
        "Close up view, person interacting with object, or device demonstration",  // Nivel 3c: Muy genérico
        "Video showing product, hands, or device activity"  // Nivel 3d: Ultra permisivo
      ];
    };

    // Iterar sobre cada prompt generado por GPT
    for (let i = 0; i < visualPrompts.length; i++) {
        const primaryPrompt = visualPrompts[i];
        logger.info(`[SceneExtractor/TwelveLabs] Buscando escena ${i + 1}/${visualPrompts.length}: "${primaryPrompt}"`);
        
        const fallbackPrompts = generateFallbackPrompts(primaryPrompt, productName);
        let clipEncontrado = false;
        
        // Iterar sobre el array de fallbacks hasta encontrar resultados
        for (let fallbackLevel = 0; fallbackLevel < fallbackPrompts.length; fallbackLevel++) {
            const promptToUse = fallbackPrompts[fallbackLevel];
            const isInitial = fallbackLevel === 0;
            
            try {
                if (!isInitial) {
                    logger.info(`[SceneExtractor/TwelveLabs] 🔄 Fallback nivel ${fallbackLevel}: "${promptToUse}"`);
                }
                
                const searchResults = await client.search.query({
                    indexId: index.id,
                    queryText: promptToUse,
                    searchOptions: ["visual"]
                });

                const resultados = searchResults.data || [];
                
                if (resultados.length > 0) {
                    // Log si usó fallback
                    if (!isInitial) {
                        logger.info(`[SceneExtractor/TwelveLabs] ✅ Búsqueda primaria fallida. Fallback nivel ${fallbackLevel} exitoso con: "${promptToUse}"`);
                    } else {
                        logger.info(`[SceneExtractor/TwelveLabs] ✅ Búsqueda primaria exitosa`);
                    }
                    
                    // Tomar la escena con mayor confianza (la número 0)
                    const bestMatch = resultados[0];
                    const outPath = path.join(outputDir, `clip_${Date.now()}_${i}.mp4`);
                    
                    logger.info(`[SceneExtractor/TwelveLabs] ✂ Recortando clip ${i + 1} exactamente a ${clipDurationExact.toFixed(2)}s...`);
                    
                    // Extraer físicamente usando la matemática exacta
                    await extractSegment(videoPath, bestMatch.start, clipDurationExact, outPath);
                    
                    escenasExtraidas.push({
                        path: outPath,
                        start: bestMatch.start,
                        duration: clipDurationExact,
                        truncated: true,
                        source: isInitial ? 'twelve-labs' : 'twelve-labs-fallback'
                    });
                    
                    clipEncontrado = true;
                    break;  // Salir del loop de fallbacks
                }
            } catch (e) {
                logger.warn(`[SceneExtractor/TwelveLabs] ⚠️ Error en fallback nivel ${fallbackLevel}: ${e.message}`);
            }
        }
        
        if (!clipEncontrado) {
            logger.warn(`[SceneExtractor/TwelveLabs] ❌ No se encontró coincidencia tras ${fallbackPrompts.length} intentos para: "${primaryPrompt}"`);
        }
    }

    // 🔴 DEFENSA #3: Si NO hay escenas después de TwelveLabs, generar clip desde imagen estática
    if (escenasExtraidas.length === 0 && opts.productImage && opts.videoGenerator) {
        try {
            logger.warn(`[SceneExtractor] 🔄 DEFENSA: No hay escenas. Generando clip dinámico desde imagen estática...`);
            const staticClipPath = require('path').join(outputDir, 'static_product_fallback.mp4');
            const generatedClip = await opts.videoGenerator._generateStaticImageClip(
                opts.productImage,
                staticClipPath,
                3.0
            );
            
            if (generatedClip) {
                logger.info(`[SceneExtractor] ✅ Clip de imagen estática generado: ${require('path').basename(generatedClip)}`);
                escenasExtraidas.push({
                    path: generatedClip,
                    start: 0,
                    duration: 3.0,
                    source: 'static-image-fallback'
                });
            } else {
                logger.warn(`[SceneExtractor] ⚠️ No se pudo generar clip desde imagen estática`);
            }
        } catch (staticErr) {
            logger.error(`[SceneExtractor] Error generando fallback de imagen estática: ${staticErr.message}`);
        }
    }

    logger.info(`[SceneExtractor/TwelveLabs] ✓ Proceso finalizado. ${escenasExtraidas.length} clips exportados con efecto Ken Burns.`);
    return escenasExtraidas;

  } catch (error) {
    logger.error(`[SceneExtractor/TwelveLabs] ✗ Error fatal: ${error.message}`);
    // Fallback: Si Twelve Labs falla, el agente no muere, devuelve array vacío para que lo intente por otro método
    return []; 
  }
}
module.exports = {
  extractAndFilterScenes,
  probeDuration
};