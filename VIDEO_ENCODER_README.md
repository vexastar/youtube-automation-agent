## 🎬 VIDEO ENCODER MODULE - GUÍA RÁPIDA DE IMPLEMENTACIÓN

### ¿QUÉ RESUELVE ESTO?

Los videos generados se reproducen en **cámara lenta o sin audio en dispositivos móviles** porque:
- ❌ Tienen framerate variable (VFR) en lugar de constante (CFR)
- ❌ Usan códecs no estandarizados
- ❌ No tienen optimizaciones de streaming

**Este módulo aplica codificación estándar** que garantiza compatibilidad universal:
- ✅ Constant Framerate (CFR) - elimina desincronización audio/video
- ✅ Códecs H.264 + AAC (compatibles con todos los dispositivos)
- ✅ Resoluciones optimizadas: 1080x1920 (vertical) y 1920x1080 (horizontal)
- ✅ Faststart para streaming sin demoras

---

## 📦 INSTALACIÓN (3 PASOS)

### Paso 1: Instalar FFmpeg
Elige según tu sistema operativo:

**Linux (Ubuntu/Debian):**
```bash
sudo apt-get update
sudo apt-get install ffmpeg
```

**macOS (con Homebrew):**
```bash
brew install ffmpeg
```

**Windows:**
- Opción A (Chocolatey): `choco install ffmpeg`
- Opción B (Manual): Descarga desde https://ffmpeg.org/download.html
- Opción C (Package): `npm install ffmpeg-static` (opcional, para empaquetar)

**Verificar instalación:**
```bash
ffmpeg -version
ffprobe -version
```

### Paso 2: Instalar dependencia Node.js
```bash
npm install fluent-ffmpeg
```

### Paso 3: Copiar el módulo
El módulo `video-encoder.js` ya está en tu proyecto:
```
✅ c:\PROYECTOS\youtube-automation-agent\utils\video-encoder.js
```

---

## 🔧 INTEGRACIÓN EN TU CÓDIGO

### Opción A: En ProductionManagementAgent (RECOMENDADO)

En `agents/production-management-agent.js`, agrega al inicio:

```javascript
const { VideoEncoder } = require('../utils/video-encoder');
```

Luego, en tu método de renderizado de video, después de ensamblar clips:

```javascript
async renderFinalVideo(clips, audioTrack, outputPath, format = 'horizontal') {
  try {
    this.logger.info(`Renderizando video: ${format}...`);
    
    // 1. Crear video crudo (sin codificación estricta)
    const tempRawPath = path.join(__dirname, '..', 'temp', 'raw_video_temp.mp4');
    await this.assembleClipsRaw(clips, audioTrack, tempRawPath);
    
    // 2. Aplicar codificación estándar
    const encoder = new VideoEncoder();
    const result = await encoder.encodeVideo(
      tempRawPath,
      outputPath,
      format,
      { timeout: 600000 } // 10 minutos
    );
    
    // 3. Limpiar temporal
    if (fs.existsSync(tempRawPath)) {
      fs.unlinkSync(tempRawPath);
    }
    
    this.logger.success(`✅ Video optimizado: ${result.path}`);
    return result;
  } catch (error) {
    this.logger.error(`Error renderizando: ${error.message}`);
    throw error;
  }
}
```

### Opción B: En index.js (Step 6.5 - Post-Producción)

En el método `generateContent()`, después de `ProductionManagementAgent.processContent()`:

```javascript
const { VideoEncoder } = require('./utils/video-encoder');
const encoder = new VideoEncoder();

// Optimizar video largo (16:9)
if (productionData.assets?.finalVideo?.path) {
  const videoPath = productionData.assets.finalVideo.path;
  const optimizedPath = videoPath.replace('.mp4', '_optimized.mp4');
  
  this.logger.info('🎬 Optimizando video largo...');
  await encoder.encodeVideo(videoPath, optimizedPath, 'horizontal');
  
  fs.unlinkSync(videoPath);
  fs.renameSync(optimizedPath, videoPath);
}

// Optimizar short (9:16)
if (productionData.assets?.shortVideos?.intro?.path) {
  const shortPath = productionData.assets.shortVideos.intro.path;
  const optimizedPath = shortPath.replace('.mp4', '_optimized.mp4');
  
  this.logger.info('🎬 Optimizando short...');
  await encoder.encodeVideo(shortPath, optimizedPath, 'vertical');
  
  fs.unlinkSync(shortPath);
  fs.renameSync(optimizedPath, shortPath);
}
```

---

## 🧪 PRUEBA RÁPIDA

### Test 1: Verificar instalación
```bash
node test-video-encoder.js
```

Debería mostrar:
```
✅ fluent-ffmpeg disponible
📋 TEST 2: Presets de Codificación
...
```

### Test 2: Codificar un video real
```bash
node test-video-encoder.js --input=data/shorts/video.mp4 --format=vertical
```

Verifica el resultado:
```bash
ffprobe uploads/test_output.mp4 | grep -E "codec_name|width|height"
```

Debería mostrar:
```
"codec_name": "h264"           ✅
"codec_name": "aac"            ✅
"width": 1080                  ✅
"height": 1920                 ✅
```

---

## 📊 ESPECIFICACIONES TÉCNICAS

### Configuración Universal (todos los videos)
| Parámetro | Valor |
|-----------|-------|
| **Contenedor** | MP4 |
| **Códec Video** | libx264 (H.264) |
| **Códec Audio** | AAC |
| **Sample Rate** | 44100 Hz |
| **Framerate** | Constant (CFR) - Critico para móviles |
| **Faststart** | Habilitado (+faststart) |
| **Perfil H.264** | Main (compatible máximo) |

### Configuración por Formato

#### 🎬 Vertical (9:16) - TikTok, Instagram Reels
```
Resolución:  1080x1920
FPS:         30 (CFR)
Bitrate:     5000k (optimizado para webhooks)
Caso Uso:    Publicación en redes sociales
```

#### 🎬 Horizontal (16:9) - YouTube
```
Resolución:  1920x1080
FPS:         30 (CFR)
Bitrate:     10000k (máxima calidad)
Caso Uso:    Videos largos de YouTube
```

---

## 🔍 API DEL MÓDULO

### encodeVideo() - Codificar video
```javascript
const result = await encoder.encodeVideo(
  inputPath,      // string: ruta del video crudo
  outputPath,     // string: donde guardar el resultado
  format,         // 'vertical' | 'horizontal'
  options         // {timeout: ms, onProgress: fn}
);

// Resultado:
// {
//   success: true,
//   path: "/path/to/output.mp4",
//   size: 5000000,          // bytes
//   sizeMB: 4.77,
//   format: "Horizontal (16:9)",
//   fps: 30,
//   bitrate: "10000k",
//   elapsedSec: 45.32
// }
```

### getVideoInfo() - Inspeccionar metadatos
```javascript
const info = await encoder.getVideoInfo(filePath);

// Resultado:
// {
//   duration: 60.5,
//   width: 1920,
//   height: 1080,
//   fps: 30,
//   videoCodec: "h264",
//   audioCodec: "aac",
//   bitrate: 10000000,
//   size: 75000000
// }
```

### detectFormat() - Auto-detectar formato
```javascript
const format = await encoder.detectFormat(filePath);
// Returns: 'vertical' o 'horizontal'

// Luego:
await encoder.encodeVideo(input, output, format);
```

---

## ⚙️ CONFIGURACIÓN AVANZADA

### Variables de entorno (.env)
Si FFmpeg está instalado en ruta no-estándar:

```env
FFMPEG_PATH=/usr/local/bin/ffmpeg
FFPROBE_PATH=/usr/local/bin/ffprobe
```

### Personalizar Presets
Edita `utils/video-encoder.js`, método `constructor()`:

```javascript
this.presets = {
  vertical: {
    bitrate: '6000k',  // Cambiar si deseas mayor bitrate
    maxrate: '7000k'
  },
  horizontal: {
    bitrate: '15000k', // Aumentar para mayor calidad (requiere más espacio)
    fps: 60            // Cambiar a 60fps si deseas (siempre CFR)
  }
};
```

---

## 🐛 TROUBLESHOOTING

| Problema | Solución |
|----------|----------|
| **"ffmpeg: command not found"** | Instala FFmpeg (ver arriba). O configura `FFMPEG_PATH` en `.env` |
| **"Timeout after 300000ms"** | Aumenta timeout: `{timeout: 600000}` (10 min) |
| **Video sin audio** | Verifica input con `getVideoInfo()`. Aumenta timeout |
| **Resolución incorrecta** | Verifica formato (vertical vs horizontal) |
| **Video desincronizado en móviles** | ✅ Este módulo resuelve exactamente esto (CFR garantizado) |

---

## 📝 CHECKLIST DE IMPLEMENTACIÓN

- [ ] ✅ FFmpeg instalado (`ffmpeg -version` funciona)
- [ ] ✅ `npm install fluent-ffmpeg` ejecutado
- [ ] ✅ `utils/video-encoder.js` existe en el proyecto
- [ ] ✅ Importa `VideoEncoder` en tu agent de producción
- [ ] ✅ Reemplaza llamadas antiguas de FFmpeg con `encoder.encodeVideo()`
- [ ] ✅ Ejecuta `node test-video-encoder.js` y valida salida
- [ ] ✅ Prueba con video real: `node test-video-encoder.js --input=data/shorts/video.mp4`
- [ ] ✅ Verifica resultado con `ffprobe` (codec_name, fps, resolución)
- [ ] ✅ Integra en pipeline principal

---

## 📚 REFERENCIAS ÚTILES

- **FFmpeg Docs**: https://ffmpeg.org/ffmpeg.html
- **fluent-ffmpeg**: https://github.com/fluent-ffmpeg/node-fluent-ffmpeg
- **H.264 Profiles**: https://en.wikipedia.org/wiki/H.264#Levels
- **MP4 Faststart**: https://ffmpeg.org/ffmpeg-formats.html#toc-Options-8

---

## 💡 PREGUNTAS FRECUENTES

**P: ¿Cuánto tiempo tarda en codificar un video de 1 minuto?**
R: Aproximadamente 30-60 segundos (varía según CPU). Usa `onProgress` para monitoreo.

**P: ¿Puedo cambiar el FPS a 60?**
R: Sí, edita el preset. Pero mantén CFR. La mayoría de móviles es 30fps nativo.

**P: ¿Qué pasa si desactivo faststart?**
R: El video tardará más en empezar a reproducirse en web/streaming (no recomendado).

**P: ¿Funcionará en producción con videos de 1 hora?**
R: Sí, pero aumenta timeout: `{timeout: 1800000}` (30 min) y monitorea CPU/RAM.

**P: ¿Necesito este módulo si solo subo a YouTube?**
R: YouTube es tolerante, pero se recomienda para garantizar calidad consistente.

---

## 🚀 PRÓXIMOS PASOS

1. **Implementa el módulo** según la sección "Integración"
2. **Prueba** con `node test-video-encoder.js`
3. **Monitorea** logs de `VideoEncoder` en tus videos generados
4. **Valida** que dispositivos móviles reproduzcan correctamente (sin cámara lenta, con audio)
5. **Itera** si necesitas ajustar bitrates o resoluciones

---

**Creado para:** youtube-automation-agent  
**Módulo:** utils/video-encoder.js  
**Versión:** 1.0.0  
**Fecha:** 2026-07-28
