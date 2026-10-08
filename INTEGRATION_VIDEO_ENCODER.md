/**
 * GUÍA DE INTEGRACIÓN: VIDEO ENCODER EN TU ARQUITECTURA
 * ═══════════════════════════════════════════════════════════════
 * 
 * Este archivo documenta cómo integrar el módulo VideoEncoder
 * en tu pipeline de producción actual.
 */

// ═══════════════════════════════════════════════════════════════
// PASO 1: INSTALACIÓN DE DEPENDENCIAS
// ═══════════════════════════════════════════════════════════════
/*
Ejecuta en terminal:

npm install fluent-ffmpeg

Si además necesitas garantizar que ffmpeg/ffprobe están instalados:

Linux (Ubuntu/Debian):
  sudo apt-get install ffmpeg

macOS:
  brew install ffmpeg

Windows (con Chocolatey):
  choco install ffmpeg

O descarga desde: https://ffmpeg.org/download.html
*/

// ═══════════════════════════════════════════════════════════════
// PASO 2: INTEGRACIÓN EN ProductionManagementAgent
// ═══════════════════════════════════════════════════════════════

/*
En agents/production-management-agent.js, en el método que renderiza videos,
reemplaza tu lógica actual de FFmpeg con esto:

--- ANTES (pseudocódigo): ---
async renderFinalVideo(clips, audioTrack, outputPath) {
  // Lógica FFmpeg antigua, posiblemente sin CFR ni optimizaciones
  // Resultado: videos lentos o sin audio en móviles
}

--- DESPUÉS: ---
const { VideoEncoder } = require('../utils/video-encoder');

async renderFinalVideo(clips, audioTrack, outputPath, format = 'horizontal') {
  try {
    this.logger.info(`Renderizando video final: ${format}...`);
    
    // 1. Crear archivo temporal sin codificación (video crudo)
    const tempRawPath = path.join(__dirname, '..', 'temp', 'raw_video_temp.mp4');
    await this.assembleClipsRaw(clips, audioTrack, tempRawPath);
    
    // 2. Aplicar codificación estándar
    const encoder = new VideoEncoder();
    const result = await encoder.encodeVideo(
      tempRawPath,
      outputPath,
      format,
      {
        timeout: 600000, // 10 minutos para videos largos
        onProgress: (progress) => {
          this.logger.info(`Codificando: ${progress.percent.toFixed(1)}%`);
        }
      }
    );
    
    // 3. Limpiar archivo temporal
    if (fs.existsSync(tempRawPath)) {
      fs.unlinkSync(tempRawPath);
    }
    
    this.logger.success(`Video final renderizado: ${result.path}`);
    return result;
    
  } catch (error) {
    this.logger.error(`Error en renderFinalVideo: ${error.message}`);
    throw error;
  }
}
*/

// ═══════════════════════════════════════════════════════════════
// PASO 3: EJEMPLO PRÁCTICO EN index.js
// ═══════════════════════════════════════════════════════════════

/*
En index.js, en el método generateContent(), después de que
ProductionManagementAgent ensambla el video, puedes aplicar
codificación optimizada así:

--- EN index.js, dentro de generateContent() ---

// Step 6: Production Management (ensamblaje de clips)
const productionData = await this.agents.production.processContent({
  strategy,
  script,
  thumbnail,
  seo: seoData,
  huntResults,
  introProductsOrder: strategy.introProductsOrder || []
});

// Step 6.5: NUEVA ETAPA - OPTIMIZACIÓN DE CODIFICACIÓN
// ═══════════════════════════════════════════════════════════════
// Aplica estándares de codificación a TODOS los videos:
//   - Video largo (16:9) para YouTube
//   - Short (9:16) para TikTok/Instagram
//   - Product shorts (9:16) como no listados
// ═══════════════════════════════════════════════════════════════

const { VideoEncoder } = require('./utils/video-encoder');
const encoder = new VideoEncoder();

try {
  // Codificar video largo (16:9)
  if (productionData.assets?.finalVideo?.path) {
    const longVideoPath = productionData.assets.finalVideo.path;
    const longVideoOptimized = longVideoPath.replace('.mp4', '_optimized.mp4');
    
    this.logger.info('🎬 Optimizando video largo (16:9)...');
    const longResult = await encoder.encodeVideo(
      longVideoPath,
      longVideoOptimized,
      'horizontal',
      { timeout: 600000 }
    );
    
    // Reemplazar con versión optimizada
    fs.unlinkSync(longVideoPath);
    fs.renameSync(longVideoOptimized, longVideoPath);
    productionData.assets.finalVideo.optimized = true;
    productionData.assets.finalVideo.codec = 'libx264+aac';
  }
  
  // Codificar short intro (9:16)
  if (productionData.assets?.shortVideos?.intro?.path) {
    const introShortPath = productionData.assets.shortVideos.intro.path;
    const introShortOptimized = introShortPath.replace('.mp4', '_optimized.mp4');
    
    this.logger.info('🎬 Optimizando short intro (9:16)...');
    const introResult = await encoder.encodeVideo(
      introShortPath,
      introShortOptimized,
      'vertical',
      { timeout: 300000 }
    );
    
    fs.unlinkSync(introShortPath);
    fs.renameSync(introShortOptimized, introShortPath);
    productionData.assets.shortVideos.intro.optimized = true;
  }
  
  // Codificar product shorts (9:16)
  if (productionData.assets?.shortVideos?.products?.length > 0) {
    for (const product of productionData.assets.shortVideos.products) {
      if (product.videoPath && fs.existsSync(product.videoPath)) {
        const optimizedPath = product.videoPath.replace('.mp4', '_optimized.mp4');
        
        this.logger.info(`🎬 Optimizando product short: "${product.productName}"...`);
        await encoder.encodeVideo(
          product.videoPath,
          optimizedPath,
          'vertical',
          { timeout: 300000 }
        );
        
        fs.unlinkSync(product.videoPath);
        fs.renameSync(optimizedPath, product.videoPath);
        product.optimized = true;
      }
    }
  }
  
} catch (encodingErr) {
  this.logger.error(`⚠️  Error en optimización de codificación: ${encodingErr.message}`);
  this.logger.warn('   Continuando con videos sin optimizar...');
  // No interrumpir — los videos crudos aún funcionan, solo sin optimización
}

// Step 7: Continuar con el resto del pipeline...
*/

// ═══════════════════════════════════════════════════════════════
// PASO 4: DETECCIÓN AUTOMÁTICA DE FORMATO
// ═══════════════════════════════════════════════════════════════

/*
Si quieres que el encoder auto-detecte si un video es vertical u
horizontal, usa el método detectFormat():

const encoder = new VideoEncoder();
const format = await encoder.detectFormat('/path/to/video.mp4');
console.log(`Formato detectado: ${format}`); // 'vertical' o 'horizontal'

// Luego:
await encoder.encodeVideo(inputPath, outputPath, format);
*/

// ═══════════════════════════════════════════════════════════════
// PASO 5: INSPECCIONAR METADATOS DE VIDEO PRE-CODIFICACIÓN
// ═══════════════════════════════════════════════════════════════

/*
Para diagnosticar si un video tiene framerate variable (VFR),
usa getVideoInfo():

const encoder = new VideoEncoder();
const info = await encoder.getVideoInfo('/path/to/video.mp4');

console.log('Información del video:');
console.log(`  Duración: ${info.duration}s`);
console.log(`  Resolución: ${info.width}x${info.height}`);
console.log(`  FPS: ${info.fps}`);
console.log(`  Códec: ${info.videoCodec}`);
console.log(`  Audio: ${info.audioCodec}`);

Esto te ayuda a:
✅ Confirmar que el video tiene audio antes de codificar
✅ Detectar resoluciones incorrectas
✅ Identificar framerate variable (VFR)
*/

// ═══════════════════════════════════════════════════════════════
// PASO 6: VARIABLES DE ENTORNO (OPCIONAL)
// ═══════════════════════════════════════════════════════════════

/*
Si ffmpeg/ffprobe no están en el PATH, configura en .env:

FFMPEG_PATH=/usr/bin/ffmpeg
FFPROBE_PATH=/usr/bin/ffprobe

O en .env de Windows:
FFMPEG_PATH=C:\ffmpeg\bin\ffmpeg.exe
FFPROBE_PATH=C:\ffmpeg\bin\ffprobe.exe

El módulo automáticamente usará estas rutas si existen.
*/

// ═══════════════════════════════════════════════════════════════
// PASO 7: CONFIGURACIÓN DE PRESETS (PERSONALIZACIÓN)
// ═══════════════════════════════════════════════════════════════

/*
Para cambiar los presets de bitrate o FPS, edita video-encoder.js:

En el constructor, la propiedad 'presets' define:

this.presets = {
  vertical: {
    name: 'Vertical (9:16)',
    resolution: '1080x1920',
    fps: 30,
    bitrate: '5000k',        // ← Cambiar aquí si deseas
    maxrate: '6000k',
    bufsize: '12000k'
  },
  horizontal: {
    name: 'Horizontal (16:9)',
    resolution: '1920x1080',
    fps: 30,                 // ← O aquí para 60fps
    bitrate: '10000k',       // ← O aquí para mayor calidad (15000k)
    maxrate: '12000k',
    bufsize: '24000k'
  }
};

Recomendaciones:
- Vertical: 5000k es suficiente para webhooks (TikTok, Instagram)
- Horizontal: 10000k-15000k para máxima calidad en YouTube
- FPS: Mantener 30 (CFR) para compatibilidad móvil universal
*/

// ═══════════════════════════════════════════════════════════════
// PASO 8: TROUBLESHOOTING
// ═══════════════════════════════════════════════════════════════

/*
PROBLEMA: "ffmpeg: command not found" o "ffprobe not found"
SOLUCIÓN:
  1. Instala ffmpeg (ver PASO 1)
  2. Verifica: ffmpeg -version (debe mostrar versión)
  3. Si aún no funciona, configura FFMPEG_PATH en .env

PROBLEMA: "Timeout after 300000ms"
SOLUCIÓN:
  • Aumenta el timeout en opciones: { timeout: 600000 }
  • Reduce resolución o bitrate
  • Verifica recursos de CPU (FFmpeg es intensivo)

PROBLEMA: "Video sin audio en el resultado"
SOLUCIÓN:
  • Asegúrate de que el input tiene pista de audio
  • Usa getVideoInfo() para confirmar audioCodec
  • Aumenta timeout (puede tomar más tiempo demuxar audio)

PROBLEMA: "Video desincronizado o cámara lenta en móviles"
SOLUCIÓN:
  • ✅ Usa este módulo (VideoEncoder resuelve exactamente esto)
  • El -fps_mode cfr garantiza Constant Framerate
  • Garantiza códecs compatibles: libx264 + AAC
*/

// ═══════════════════════════════════════════════════════════════
// RESUMEN: CHECKLIST DE INTEGRACIÓN
// ═══════════════════════════════════════════════════════════════

/*
☐ 1. Instalar: npm install fluent-ffmpeg
☐ 2. Instalar: ffmpeg (sistema operativo)
☐ 3. Copiar: video-encoder.js a utils/
☐ 4. En ProductionManagementAgent:
     const { VideoEncoder } = require('../utils/video-encoder');
☐ 5. Reemplazar llamadas a FFmpeg antiguo con:
     await encoder.encodeVideo(input, output, format)
☐ 6. Probar con video de prueba:
     node -e "const {VideoEncoder} = require('./utils/video-encoder'); 
              new VideoEncoder().encodeVideo('test.mp4', 'out.mp4', 'vertical')"
☐ 7. Verificar resultado con: ffprobe out.mp4
     Debe mostrar: "codec_name": "h264", "codec_name": "aac", etc.
☐ 8. (Opcional) Configurar FFMPEG_PATH en .env si es necesario
*/

module.exports = null; // Este es un archivo de documentación
