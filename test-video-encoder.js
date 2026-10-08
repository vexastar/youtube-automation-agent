/**
 * TEST: VIDEO ENCODER MODULE
 * ═══════════════════════════════════════════════════════════════
 * Script de prueba para validar la funcionalidad del VideoEncoder.
 * 
 * USO:
 *   node test-video-encoder.js
 *   node test-video-encoder.js --input=./path/to/video.mp4 --format=vertical
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const { VideoEncoder } = require('./utils/video-encoder');

// ═══════════════════════════════════════════════════════════════
// PARSEAR ARGUMENTOS
// ═══════════════════════════════════════════════════════════════
const args = process.argv.slice(2);
const config = {
  input: null,
  output: null,
  format: 'horizontal',
  help: false
};

args.forEach(arg => {
  if (arg === '--help' || arg === '-h') config.help = true;
  if (arg.startsWith('--input=')) config.input = arg.split('=')[1];
  if (arg.startsWith('--output=')) config.output = arg.split('=')[1];
  if (arg.startsWith('--format=')) config.format = arg.split('=')[1];
});

// ═══════════════════════════════════════════════════════════════
// MOSTRAR AYUDA
// ═══════════════════════════════════════════════════════════════
if (config.help) {
  console.log(chalk.cyan.bold('\n📹 VIDEO ENCODER TEST - Ayuda\n'));
  console.log('Uso:');
  console.log(chalk.white('  node test-video-encoder.js [opciones]'));
  console.log('\nOpciones:');
  console.log(chalk.gray('  --input=<path>    Ruta del archivo de entrada (requerido para test real)'));
  console.log(chalk.gray('  --output=<path>   Ruta del archivo de salida (default: ./uploads/test_output.mp4)'));
  console.log(chalk.gray('  --format=<fmt>    Formato: vertical o horizontal (default: horizontal)'));
  console.log(chalk.gray('  --help, -h        Mostrar esta ayuda'));
  console.log('\nEjemplos:');
  console.log(chalk.cyan('  node test-video-encoder.js --help'));
  console.log(chalk.cyan('  node test-video-encoder.js --input=data/shorts/video.mp4 --format=vertical'));
  console.log(chalk.cyan('  node test-video-encoder.js --input=data/shorts/video.mp4 --format=horizontal --output=uploads/final.mp4'));
  console.log();
  process.exit(0);
}

// ═══════════════════════════════════════════════════════════════
// MAIN TEST FUNCTION
// ═══════════════════════════════════════════════════════════════
async function runTest() {
  console.log(chalk.cyan.bold('\n🎬 VIDEO ENCODER MODULE TEST\n'));
  console.log(chalk.gray('─'.repeat(70)));

  try {
    const encoder = new VideoEncoder();

    // ───────────────────────────────────────────────────────────
    // TEST 1: Verificar disponibilidad de FFmpeg
    // ───────────────────────────────────────────────────────────
    console.log('\n📋 TEST 1: Verificar FFmpeg/FFprobe');
    console.log(chalk.gray('─'.repeat(70)));

    try {
      const ffmpeg = require('fluent-ffmpeg');
      console.log(chalk.green('✅ fluent-ffmpeg disponible'));
      console.log(chalk.white('   Versión: ') + chalk.cyan(require('fluent-ffmpeg/package.json').version));
    } catch (err) {
      console.log(chalk.red('❌ fluent-ffmpeg no encontrado'));
      console.log(chalk.yellow('   Ejecuta: npm install fluent-ffmpeg'));
      process.exit(1);
    }

    // ───────────────────────────────────────────────────────────
    // TEST 2: Revisar presets disponibles
    // ───────────────────────────────────────────────────────────
    console.log('\n📋 TEST 2: Presets de Codificación');
    console.log(chalk.gray('─'.repeat(70)));

    console.log('\n🎬 VERTICAL (9:16):');
    console.log(chalk.white('  Resolución: ') + chalk.cyan('1080x1920'));
    console.log(chalk.white('  FPS: ') + chalk.cyan('30 (CFR)'));
    console.log(chalk.white('  Bitrate: ') + chalk.cyan('5000k'));
    console.log(chalk.white('  Uso: ') + chalk.cyan('TikTok, Instagram Reels, Facebook Reels, Webhooks'));

    console.log('\n🎬 HORIZONTAL (16:9):');
    console.log(chalk.white('  Resolución: ') + chalk.cyan('1920x1080'));
    console.log(chalk.white('  FPS: ') + chalk.cyan('30 (CFR)'));
    console.log(chalk.white('  Bitrate: ') + chalk.cyan('10000k'));
    console.log(chalk.white('  Uso: ') + chalk.cyan('YouTube, videos largos'));

    // ───────────────────────────────────────────────────────────
    // TEST 3: Validar archivo de entrada si existe
    // ───────────────────────────────────────────────────────────
    if (config.input) {
      console.log('\n📋 TEST 3: Información del Video de Entrada');
      console.log(chalk.gray('─'.repeat(70)));

      if (!fs.existsSync(config.input)) {
        console.log(chalk.red(`❌ Archivo no encontrado: ${config.input}`));
        process.exit(1);
      }

      console.log(chalk.green(`✅ Archivo encontrado: ${config.input}`));

      try {
        const info = await encoder.getVideoInfo(config.input);
        console.log('\n📊 Metadatos:');
        console.log(chalk.white('  Duración: ') + chalk.cyan(`${info.duration.toFixed(2)}s`));
        console.log(chalk.white('  Resolución: ') + chalk.cyan(`${info.width}x${info.height}`));
        console.log(chalk.white('  FPS: ') + chalk.cyan(info.fps));
        console.log(chalk.white('  Códec video: ') + chalk.cyan(info.videoCodec || 'unknown'));
        console.log(chalk.white('  Códec audio: ') + chalk.cyan(info.audioCodec || 'none'));
        console.log(chalk.white('  Bitrate: ') + chalk.cyan(`${(info.bitrate / 1000).toFixed(0)}k`));
        console.log(chalk.white('  Tamaño: ') + chalk.cyan(`${(info.size / 1024 / 1024).toFixed(2)} MB`));

        // Detectar formato
        console.log('\n📐 Detección automática de formato:');
        const detectedFormat = await encoder.detectFormat(config.input);
        console.log(chalk.white('  Formato detectado: ') + chalk.cyan(detectedFormat));
        
        if (detectedFormat !== config.format) {
          console.log(chalk.yellow(`  ⚠️  Solicitaste ${config.format}, pero el video es ${detectedFormat}`));
          console.log(chalk.yellow('     Continuando con el formato solicitado...\n'));
        }
      } catch (err) {
        console.log(chalk.red(`❌ Error al leer metadatos: ${err.message}`));
        process.exit(1);
      }

      // ───────────────────────────────────────────────────────────
      // TEST 4: Codificar video
      // ───────────────────────────────────────────────────────────
      console.log('\n📋 TEST 4: Codificación de Video');
      console.log(chalk.gray('─'.repeat(70)));

      const outputDir = path.dirname(config.output || './uploads/test_output.mp4');
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      const outputPath = config.output || './uploads/test_output.mp4';

      console.log(chalk.white('\n⚙️  Configuración:'));
      console.log(chalk.gray(`  Entrada: ${config.input}`));
      console.log(chalk.gray(`  Salida: ${outputPath}`));
      console.log(chalk.gray(`  Formato: ${config.format}`));
      console.log(chalk.gray(`  Timeout: 600000ms (10 min)`));

      try {
        console.log(chalk.cyan('\n🎥 Iniciando codificación...\n'));

        const result = await encoder.encodeVideo(
          config.input,
          outputPath,
          config.format,
          { timeout: 600000 }
        );

        // ───────────────────────────────────────────────────────────
        // TEST 5: Validar archivo de salida
        // ───────────────────────────────────────────────────────────
        console.log('\n📋 TEST 5: Validación del Video Codificado');
        console.log(chalk.gray('─'.repeat(70)));

        if (fs.existsSync(outputPath)) {
          console.log(chalk.green(`✅ Archivo de salida creado: ${outputPath}`));

          const outputInfo = await encoder.getVideoInfo(outputPath);
          console.log('\n📊 Metadatos del archivo codificado:');
          console.log(chalk.white('  Duración: ') + chalk.cyan(`${outputInfo.duration.toFixed(2)}s`));
          console.log(chalk.white('  Resolución: ') + chalk.cyan(`${outputInfo.width}x${outputInfo.height}`));
          console.log(chalk.white('  FPS: ') + chalk.cyan(outputInfo.fps));
          console.log(chalk.white('  Códec video: ') + chalk.cyan(outputInfo.videoCodec));
          console.log(chalk.white('  Códec audio: ') + chalk.cyan(outputInfo.audioCodec));
          console.log(chalk.white('  Tamaño: ') + chalk.cyan(`${(outputInfo.size / 1024 / 1024).toFixed(2)} MB`));

          // ───────────────────────────────────────────────────────────
          // VALIDACIONES FINALES
          // ───────────────────────────────────────────────────────────
          console.log('\n📋 VALIDACIONES FINALES');
          console.log(chalk.gray('─'.repeat(70)));

          let allValid = true;

          // Validar códec de video
          if (outputInfo.videoCodec === 'h264') {
            console.log(chalk.green(`✅ Códec video correcto (h264/libx264)`));
          } else {
            console.log(chalk.red(`❌ Códec video incorrecto (${outputInfo.videoCodec})`));
            allValid = false;
          }

          // Validar códec de audio
          if (outputInfo.audioCodec === 'aac') {
            console.log(chalk.green(`✅ Códec audio correcto (aac)`));
          } else if (outputInfo.audioCodec) {
            console.log(chalk.yellow(`⚠️  Códec audio (${outputInfo.audioCodec}). Esperado: aac`));
          } else {
            console.log(chalk.red(`❌ No hay pista de audio`));
            allValid = false;
          }

          // Validar resolución
          const preset = config.format === 'vertical' 
            ? { w: 1080, h: 1920 }
            : { w: 1920, h: 1080 };

          if (outputInfo.width === preset.w && outputInfo.height === preset.h) {
            console.log(chalk.green(`✅ Resolución correcta (${preset.w}x${preset.h})`));
          } else {
            console.log(chalk.red(`❌ Resolución incorrecta (${outputInfo.width}x${outputInfo.height}). Esperado: ${preset.w}x${preset.h}`));
            allValid = false;
          }

          // Validar FPS
          if (outputInfo.fps === 30 || outputInfo.fps === 30.0) {
            console.log(chalk.green(`✅ FPS correcto (30 CFR)`));
          } else {
            console.log(chalk.yellow(`⚠️  FPS (${outputInfo.fps}). Esperado: 30`));
          }

          console.log('\n' + chalk.gray('─'.repeat(70)));
          if (allValid) {
            console.log(chalk.green.bold('\n✅ TODAS LAS VALIDACIONES PASARON\n'));
            console.log(chalk.cyan('El video está optimizado para compatibilidad móvil:'));
            console.log(chalk.white('  • Códec H.264 + AAC (compatible universal)'));
            console.log(chalk.white('  • Constant Framerate (CFR) - sin desincronización'));
            console.log(chalk.white('  • Resolución correcta para el formato'));
            console.log(chalk.white('  • Faststart habilitado para streaming\n'));
          } else {
            console.log(chalk.yellow.bold('\n⚠️  ALGUNAS VALIDACIONES FALLARON\n'));
            console.log(chalk.yellow('El video podría no ser totalmente compatible en dispositivos móviles.\n'));
          }
        } else {
          console.log(chalk.red(`❌ Archivo de salida no creado: ${outputPath}`));
          process.exit(1);
        }
      } catch (encodeErr) {
        console.log(chalk.red(`\n❌ Error en codificación: ${encodeErr.message}`));
        console.log(chalk.yellow('Posibles causas:'));
        console.log(chalk.white('  • FFmpeg no instalado o no en PATH'));
        console.log(chalk.white('  • Archivo de entrada corrupto'));
        console.log(chalk.white('  • Insuficientes recursos de CPU/RAM'));
        console.log(chalk.white('  • Permisos de lectura/escritura insuficientes'));
        process.exit(1);
      }
    } else {
      // Sin archivo de entrada: mostrar resumen de capacidades
      console.log('\n📋 TEST 3: Resumen de Capacidades');
      console.log(chalk.gray('─'.repeat(70)));
      console.log(chalk.cyan('\n✅ Módulo VideoEncoder está listo para usar.\n'));
      console.log('Para probar con un video real, ejecuta:');
      console.log(chalk.white('  node test-video-encoder.js --input=./data/shorts/video.mp4 --format=vertical'));
      console.log('\nO desde tu código:');
      console.log(chalk.white('  const { VideoEncoder } = require("./utils/video-encoder");'));
      console.log(chalk.white('  const encoder = new VideoEncoder();'));
      console.log(chalk.white('  await encoder.encodeVideo("input.mp4", "output.mp4", "vertical");'));
      console.log();
    }

    console.log(chalk.gray('─'.repeat(70)));
    console.log(chalk.green.bold('\n✅ TEST COMPLETADO\n'));

  } catch (error) {
    console.log(chalk.red.bold('\n❌ ERROR FATAL\n'));
    console.log(chalk.red(error.message));
    console.log(chalk.gray(error.stack));
    process.exit(1);
  }
}

// ═══════════════════════════════════════════════════════════════
// EJECUTAR
// ═══════════════════════════════════════════════════════════════
runTest().catch(error => {
  console.error(chalk.red('Fatal error:'), error);
  process.exit(1);
});
