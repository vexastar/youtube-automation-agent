/**
 * TEST-WEBHOOK.JS (REFACTORED - TIKTOK NATIVE PUBLISHING)
 * 
 * Script de prueba para publicación nativa en TikTok:
 * 1. Busca el video .mp4 más reciente en data/shorts
 * 2. Importa y usa TikTokPublishingAgent para publicación directa
 * 3. Lee credenciales desde .env (TIKTOK_ACCESS_TOKEN, TIKTOK_CLIENT_KEY)
 * 4. Inicia las 3 fases de publicación: Init → Upload → Status
 * 5. Imprime claramente si fue exitoso o si hubo error
 * 
 * ARQUITECTURA:
 *   ❌ Make.com webhook - ELIMINADO COMPLETAMENTE
 *   ❌ FormData y multipart/form-data a webhooks - ELIMINADO
 *   ✅ TikTok Direct Post API FILE_UPLOAD (3 fases nativas)
 *   ✅ Manejo robusto de errores y respuestas
 * 
 * USO:
 *   node test-webhook.js
 * 
 * RESULTADO:
 *   - ✅ Video publicado nativa en TikTok
 *   - ✅ Mensaje claro de éxito con URL de TikTok
 *   - ❌ Mensaje claro de error si falla
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const { TikTokPublishingAgent } = require('./agents/tiktok-publishing-agent');

// ═══════════════════════════════════════════════════════════════
// CONFIGURACIÓN
// ═══════════════════════════════════════════════════════════════

const DATA_SHORTS_DIR = path.resolve(__dirname, 'data', 'shorts');


// ═══════════════════════════════════════════════════════════════
// UTILIDADES
// ═══════════════════════════════════════════════════════════════

/**
 * Encuentra el archivo .mp4 más reciente en data/shorts
 */
function findLatestVideo() {
  console.log(chalk.cyan(`\n📂 Buscando videos en: ${DATA_SHORTS_DIR}`));

  if (!fs.existsSync(DATA_SHORTS_DIR)) {
    console.log(chalk.red(`   ❌ Directorio no existe: ${DATA_SHORTS_DIR}`));
    return null;
  }

  const files = fs.readdirSync(DATA_SHORTS_DIR)
    .filter(f => f.endsWith('.mp4'))
    .map(f => ({
      name: f,
      path: path.join(DATA_SHORTS_DIR, f),
      time: fs.statSync(path.join(DATA_SHORTS_DIR, f)).mtime.getTime()
    }))
    .sort((a, b) => b.time - a.time);

  if (files.length === 0) {
    console.log(chalk.red(`   ❌ No se encontraron archivos .mp4 en ${DATA_SHORTS_DIR}`));
    return null;
  }

  const latest = files[0];
  console.log(chalk.green(`   ✅ Video encontrado: ${latest.name}`));
  console.log(chalk.gray(`      Tamaño: ${(fs.statSync(latest.path).size / 1024 / 1024).toFixed(2)} MB`));
  
  return latest.path;
}

// ═══════════════════════════════════════════════════════════════
// PUBLICACIÓN EN TIKTOK (NATIVA)
// ═══════════════════════════════════════════════════════════════

/**
 * Publica video directamente en TikTok usando TikTokPublishingAgent
 * Coordina las 3 fases: Init Upload → Upload Video Chunks → Check Status
 * 
 * @param {string} videoPath - Ruta local del archivo .mp4
 * @returns {Promise<object>} Resultado de publicación
 */
async function publishToTikTok(videoPath) {
  console.log(chalk.cyan.bold(`\n🎵 INICIANDO PUBLICACIÓN EN TIKTOK`));
  console.log(chalk.gray('─'.repeat(70)));

  try {
    // Validar archivo
    if (!fs.existsSync(videoPath)) {
      throw new Error(`Video no encontrado: ${videoPath}`);
    }

    const fileName = path.basename(videoPath);
    const fileStats = fs.statSync(videoPath);
    const fileSizeMB = (fileStats.size / (1024 * 1024)).toFixed(2);

    console.log(chalk.white('📄 Archivo: ') + chalk.cyan(fileName));
    console.log(chalk.white('📏 Tamaño: ') + chalk.cyan(`${fileSizeMB} MB`));
    console.log(chalk.white('🎬 Tipo: ') + chalk.cyan('video/mp4'));

    // ═══════════════════════════════════════════════════════════
    // INSTANCIAR Y INICIALIZAR TIKTOK PUBLISHING AGENT
    // ═══════════════════════════════════════════════════════════
    console.log(chalk.blue(`\n⏳ Inicializando TikTok Publishing Agent...`));
    
    const tiktokAgent = new TikTokPublishingAgent(null, {});
    const initialized = await tiktokAgent.initialize();

    if (!initialized) {
      throw new Error('TikTok credentials not configured. Set TIKTOK_ACCESS_TOKEN and TIKTOK_CLIENT_KEY in .env');
    }

    console.log(chalk.green(`✅ TikTok agent inicializado correctamente`));

    // ═══════════════════════════════════════════════════════════
    // PUBLICAR VIDEO EN TIKTOK (3 FASES AUTOMÁTICAS)
    // ═══════════════════════════════════════════════════════════
    console.log(chalk.blue(`\n▶️  Iniciando publicación...`));
    
    const result = await tiktokAgent.publishVideo(videoPath, {
      title: '🎬 Tech Finds - Auto Published',
      description: 'Los mejores gadgets y tecnología. Publicado automáticamente desde YouTube Automation Agent.',
      privacyLevel: 'MUTUAL_FOLLOW_FRIENDS'
    });

    // ═══════════════════════════════════════════════════════════
    // VALIDAR RESULTADO
    // ═══════════════════════════════════════════════════════════
    if (result.status === 'success') {
      console.log(chalk.green.bold(`\n✅ VIDEO PUBLICADO EN TIKTOK EXITOSAMENTE`));
      console.log(chalk.white('URL: ') + chalk.green(result.videoUrl || 'N/A'));
      console.log(chalk.white('Status: ') + chalk.green(result.tiktokStatus));
      console.log(chalk.white('Publish ID: ') + chalk.green(result.publishId));
      console.log(chalk.white('Duración: ') + chalk.green(result.duration + 's'));
      return result;
    } else {
      throw new Error(`TikTok publishing failed: ${result.error}`);
    }

  } catch (error) {
    console.log(chalk.red.bold(`\n❌ ERROR AL PUBLICAR EN TIKTOK`));
    console.log(chalk.white('Error: ') + chalk.red(error.message));

    if (error.code === 'ECONNREFUSED') {
      console.log(chalk.yellow('\n💡 Tip: Conexión rechazada. Verifica:'));
      console.log(chalk.white('   • TikTok API endpoint está disponible'));
      console.log(chalk.white('   • Conexión a Internet está activa'));
    } else if (error.code === 'ETIMEDOUT') {
      console.log(chalk.yellow('\n💡 Tip: Timeout. El API de TikTok tardó mucho en responder.'));
    }

    throw error;
  }
}

// ═══════════════════════════════════════════════════════════════
// FUNCIÓN PRINCIPAL
// ═══════════════════════════════════════════════════════════════

async function main() {
  console.log(chalk.cyan.bold('\n🎬 TEST-WEBHOOK: TIKTOK NATIVE PUBLISHING\n'));
  console.log(chalk.gray('─'.repeat(70)));

  try {
    // PASO 1: Encontrar video más reciente
    console.log(chalk.white('PASO 1: Buscando video más reciente'));
    const videoPath = findLatestVideo();
    
    if (!videoPath) {
      console.log(chalk.red('\n❌ No se encontró video para procesar'));
      process.exit(1);
    }

    // PASO 2: Publicar en TikTok (nativa) usando TikTokPublishingAgent
    console.log(chalk.white('\nPASO 2: Publicando en TikTok mediante TikTokPublishingAgent'));
    const tiktokResult = await publishToTikTok(videoPath);

    // ÉXITO TOTAL
    console.log(chalk.gray('\n' + '─'.repeat(70)));
    console.log(chalk.green.bold('\n🎉 PIPELINE COMPLETADO EXITOSAMENTE\n'));
    console.log(chalk.cyan('Resumen:'));
    console.log(chalk.white(`  ✅ Video encontrado: ${path.basename(videoPath)}`));
    console.log(chalk.white(`  ✅ Video publicado en TikTok nativa`));
    console.log(chalk.white(`  ✅ URL de TikTok: ${tiktokResult.videoUrl}`));
    console.log(chalk.white(`  ✅ Sin Make.com webhook (eliminado)\n`));

  } catch (error) {
    console.log(chalk.gray('\n' + '─'.repeat(70)));
    console.log(chalk.red.bold('\n💥 ERROR FATAL\n'));
    console.log(chalk.red('Tipo: ' + (error.name || 'Unknown')));
    console.log(chalk.red('Mensaje: ' + (error.message || 'Unknown error')));
    
    if (process.env.DEBUG) {
      console.log(chalk.gray('\nStack trace:'));
      console.log(chalk.gray(error.stack));
    }
    
    console.log();
    process.exit(1);
  }
}

// ═══════════════════════════════════════════════════════════════
// EJECUTAR
// ═══════════════════════════════════════════════════════════════

main();
