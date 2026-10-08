/**
 * VIDEO ENCODER MODULE
 * ═══════════════════════════════════════════════════════════════
 * Centraliza la exportación/renderizado de videos con estándares
 * de codificación estrictos para garantizar compatibilidad en
 * dispositivos móviles (especialmente streaming sin desincronización).
 * 
 * CARACTERÍSTICAS:
 * ✅ Constant Framerate (CFR) - evita desincronización audio/video
 * ✅ Códecs compatibles: libx264 (H.264) + AAC
 * ✅ Faststart para streaming web
 * ✅ Formatos dinámicos: Vertical (9:16) e Horizontal (16:9)
 * ✅ Tasa de muestreo de audio: 44100 Hz (universal)
 * ✅ Bitrates optimizados por formato
 * 
 * INTEGRACIÓN:
 * En index.js, ProductionManagementAgent o VideoAssemblerAgent:
 *   const { VideoEncoder } = require('./utils/video-encoder');
 *   const encoder = new VideoEncoder();
 *   await encoder.encodeVideo(inputPath, outputPath, 'vertical');
 */

const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const { Logger } = require('./logger');

class VideoEncoder {
  constructor() {
    this.logger = new Logger('VideoEncoder');
    this.presets = {
      vertical: {
        name: 'Vertical (9:16)',
        resolution: '1080x1920',
        width: 1080,
        height: 1920,
        fps: 30,
        bitrate: '5000k', // Optimizado para webhooks (tamaño contenido)
        maxrate: '6000k',
        bufsize: '12000k'
      },
      horizontal: {
        name: 'Horizontal (16:9)',
        resolution: '1920x1080',
        width: 1920,
        height: 1080,
        fps: 30,
        bitrate: '10000k', // Máxima calidad para YouTube
        maxrate: '12000k',
        bufsize: '24000k'
      }
    };

    // Configuración FFmpeg global
    this.ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
    this.ffprobePath = process.env.FFPROBE_PATH || 'ffprobe';
    
    ffmpeg.setFfmpegPath(this.ffmpegPath);
    ffmpeg.setFfprobePath(this.ffprobePath);
  }

  /**
   * Renderiza un video aplicando estándares de codificación estrictos.
   * 
   * @param {string} inputPath - Ruta del archivo de entrada (video crudo)
   * @param {string} outputPath - Ruta del archivo de salida (.mp4)
   * @param {string} format - 'vertical' (9:16) o 'horizontal' (16:9)
   * @param {Object} options - Opciones adicionales {timeout, onProgress}
   * @returns {Promise<Object>} {success, path, size, duration, format}
   * 
   * EJEMPLO:
   *   const result = await encoder.encodeVideo(
   *     'temp/raw_video.mp4',
   *     'uploads/final_video.mp4',
   *     'vertical',
   *     { timeout: 300000 }
   *   );
   */
async encodeVideo(inputPath, outputPath, format = 'vertical', options = {}) {
    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      try {
        if (!inputPath || !fs.existsSync(inputPath)) {
          const err = `Input file not found: ${inputPath}`;
          this.logger.error(err);
          return reject(new Error(err));
        }

        if (!['vertical', 'horizontal'].includes(format)) {
          const err = `Invalid format: ${format}. Use 'vertical' or 'horizontal'.`;
          this.logger.error(err);
          return reject(new Error(err));
        }

        const preset = this.presets[format];
        const timeout = options.timeout || 1200000;
        const onProgress = options.onProgress || (() => {});

        const outputDir = path.dirname(outputPath);
        if (!fs.existsSync(outputDir)) {
          fs.mkdirSync(outputDir, { recursive: true });
        }

        const inputSize = fs.statSync(inputPath).size;
        const inputSizeMB = (inputSize / (1024 * 1024)).toFixed(2);

        this.logger.info(`\n════════════════════════════════════════════════════════════`);
        this.logger.info(`🎬 VIDEO ENCODER: ${preset.name} (Estilo EzeTech)`);
        this.logger.info(`════════════════════════════════════════════════════════════`);

const command = ffmpeg(inputPath);

        // 1. Eliminamos el hardware acceleration automático que causa crashes
        command
          .videoCodec('libx264')
          .fps(preset.fps);

// ── LÓGICA CONDICIONAL DE FILTROS (ESTILO EZETECH PARA SHORTS) ──
        if (format === 'vertical') {
          // 2. Ruta absoluta de fuente con escape exacto para FFmpeg en Windows
          const fontPath = "C\\:/Windows/Fonts/arialbd.ttf"; 

          command.complexFilter([
            // Dividir en fondo y frente
            '[0:v]split=2[bg][fg]',
            // Fondo: Llenar pantalla, blur fuerte y oscurecer (CORREGIDO a rr, gg, bb)
            `[bg]scale=${preset.width}:${preset.height}:force_original_aspect_ratio=increase,crop=${preset.width}:${preset.height},boxblur=25:25,colorchannelmixer=rr=0.4:gg=0.4:bb=0.4[bg_blurred]`,
            // Frente: Escalar al ancho
            `[fg]scale=${preset.width}:-1[fg_scaled]`,
            // Montar frente sobre fondo centrado
            '[bg_blurred][fg_scaled]overlay=0:(H-h)/2[base_video]',
            // Textos quemados referenciando la fuente correctamente
            `[base_video]drawtext=fontfile='${fontPath}':text='¿CONOCIAS ESTO?':fontcolor=white:fontsize=80:bordercolor=green:borderw=6:x=(w-text_w)/2:y=250[with_top_text]`,
            `[with_top_text]drawtext=fontfile='${fontPath}':text='TECH FINDS AMAZON':fontcolor=white:fontsize=45:bordercolor=black:borderw=3:x=(w-text_w)/2:y=H-300[outv]`
          ]);
          
          command.outputOptions([
            '-map [outv]',       // Usar la salida del complexFilter
            '-map 0:a?'          // Mapear el audio original si existe
          ]);
        } else {
          // Formato horizontal estándar
          command.videoFilters([
            `scale=${preset.width}:${preset.height}:force_original_aspect_ratio=decrease`,
            `pad=${preset.width}:${preset.height}:(ow-iw)/2:(oh-ih)/2:black`
          ]);
        }

        command.outputOptions([
          '-c:v libx264',
          '-preset fast',
          `-b:v ${preset.bitrate}`,
          `-maxrate ${preset.maxrate}`,
          `-bufsize ${preset.bufsize}`,
          `-fps_mode cfr`,
          '-x264-params ref=4:bframes=3',
          '-c:a aac',
          '-b:a 128k',
          '-ar 44100',
          '-ac 2',
          '-y',
          '-movflags +faststart',
          '-pix_fmt yuv420p',
          '-profile:v main',
          '-level 4.1',
          '-f mp4',
          '-threads 4'
        ]);

        command.output(outputPath);

        let lastProgressReport = 0;
        command.on('progress', (progress) => {
          const now = Date.now();
          if (now - lastProgressReport > 5000) {
            this.logger.info(`⏳ Progreso: ${(progress.percent || 0).toFixed(1)}% | FPS: ${(progress.currentFps || 0).toFixed(1)}`);
            onProgress(progress);
            lastProgressReport = now;
          }
        });

        command.on('error', (err) => {
          this.logger.error(`❌ FFmpeg Error: ${err.message}`);
          try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (_) {}
          reject(err);
        });

        command.on('end', () => {
          if (!fs.existsSync(outputPath)) return reject(new Error('Output file not created'));
          this.logger.success(`✅ Codificación completada: ${path.basename(outputPath)}`);
          resolve({
            success: true,
            path: outputPath,
            fps: preset.fps,
            sizeMB: (fs.statSync(outputPath).size / (1024 * 1024)).toFixed(2)
          });
        });

        setTimeout(() => {
          command.kill();
          reject(new Error(`Encoding timeout after ${timeout}ms`));
        }, timeout);

        command.run();
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Obtiene información técnica de un archivo de video (duración, resolución, etc.)
   * usando ffprobe. Útil para validación pre-codificación.
   * 
   * @param {string} filePath - Ruta del archivo de video
   * @returns {Promise<Object>} {duration, width, height, fps, codec_name, ...}
   */
  async getVideoInfo(filePath) {
    return new Promise((resolve, reject) => {
      if (!fs.existsSync(filePath)) {
        return reject(new Error(`File not found: ${filePath}`));
      }

      ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err) return reject(err);

        try {
          const videoStream = metadata.streams.find(s => s.codec_type === 'video');
          const audioStream = metadata.streams.find(s => s.codec_type === 'audio');

          if (!videoStream) {
            return reject(new Error('No video stream found in file'));
          }

          const fps = videoStream.r_frame_rate
            ? eval(videoStream.r_frame_rate).toFixed(2)
            : 'unknown';

          resolve({
            duration: parseFloat(metadata.format.duration || 0),
            width: videoStream.width || 0,
            height: videoStream.height || 0,
            fps: parseFloat(fps),
            codec: videoStream.codec_name || 'unknown',
            videoCodec: videoStream.codec_name,
            audioCodec: audioStream ? audioStream.codec_name : null,
            bitrate: parseInt(metadata.format.bit_rate || 0),
            size: parseInt(metadata.format.size || 0),
            format: metadata.format.format_name
          });
        } catch (parseErr) {
          reject(parseErr);
        }
      });
    });
  }

  /**
   * Detecta el formato más apropiado basado en las dimensiones del video de entrada.
   * 
   * @param {string} filePath - Ruta del archivo de video
   * @returns {Promise<string>} 'vertical' o 'horizontal'
   */
  async detectFormat(filePath) {
    try {
      const info = await this.getVideoInfo(filePath);
      const aspectRatio = info.width / info.height;
      
      // Si aspect ratio < 1, es más alto que ancho (vertical)
      // Si aspect ratio > 1, es más ancho que alto (horizontal)
      const format = aspectRatio < 1 ? 'vertical' : 'horizontal';
      
      this.logger.info(`📐 Formato detectado: ${format} (${info.width}x${info.height}, ratio: ${aspectRatio.toFixed(2)})`);
      return format;
    } catch (error) {
      this.logger.warn(`⚠️  No se pudo detectar formato, usando 'horizontal' por defecto: ${error.message}`);
      return 'horizontal';
    }
  }
}

module.exports = { VideoEncoder };
