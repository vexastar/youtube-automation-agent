#!/usr/bin/env node

/**
 * SETUP: VIDEO ENCODER MODULE
 * ═══════════════════════════════════════════════════════════════
 * Script de instalación automática para el módulo VideoEncoder.
 * 
 * USO:
 *   npm run setup:encoder
 *   O manualmente: node setup-video-encoder.js
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const chalk = require('chalk');

console.log(chalk.cyan.bold('\n🎬 SETUP: VIDEO ENCODER MODULE\n'));
console.log(chalk.gray('═'.repeat(70)));

const steps = [];
let success = true;

// ═══════════════════════════════════════════════════════════════
// PASO 1: Verificar directorio de proyecto
// ═══════════════════════════════════════════════════════════════
console.log('\n📋 PASO 1: Verificar estructura del proyecto');
console.log(chalk.gray('─'.repeat(70)));

const requiredDirs = [
  'utils',
  'temp',
  'data/shorts',
  'logs'
];

requiredDirs.forEach(dir => {
  const fullPath = path.join(__dirname, dir);
  if (!fs.existsSync(fullPath)) {
    try {
      fs.mkdirSync(fullPath, { recursive: true });
      console.log(chalk.green(`✅ Creado: ${dir}`));
    } catch (err) {
      console.log(chalk.red(`❌ Error creando ${dir}: ${err.message}`));
      success = false;
    }
  } else {
    console.log(chalk.green(`✅ Existe: ${dir}`));
  }
});

// ═══════════════════════════════════════════════════════════════
// PASO 2: Verificar que video-encoder.js existe
// ═══════════════════════════════════════════════════════════════
console.log('\n📋 PASO 2: Verificar módulo VideoEncoder');
console.log(chalk.gray('─'.repeat(70)));

const encoderPath = path.join(__dirname, 'utils', 'video-encoder.js');
if (fs.existsSync(encoderPath)) {
  const stats = fs.statSync(encoderPath);
  console.log(chalk.green(`✅ Módulo encontrado: utils/video-encoder.js`));
  console.log(chalk.gray(`   Tamaño: ${(stats.size / 1024).toFixed(1)} KB`));
} else {
  console.log(chalk.red(`❌ Módulo no encontrado: ${encoderPath}`));
  console.log(chalk.yellow('   ⚠️  El archivo video-encoder.js debe existir en utils/'));
  success = false;
}

// ═══════════════════════════════════════════════════════════════
// PASO 3: Instalar dependencia fluent-ffmpeg
// ═══════════════════════════════════════════════════════════════
console.log('\n📋 PASO 3: Instalar dependencia fluent-ffmpeg');
console.log(chalk.gray('─'.repeat(70)));

try {
  const packageJsonPath = path.join(__dirname, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    console.log(chalk.red('❌ package.json no encontrado'));
    process.exit(1);
  }

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  
  if (packageJson.dependencies && packageJson.dependencies['fluent-ffmpeg']) {
    console.log(chalk.green(`✅ fluent-ffmpeg ya instalado: ${packageJson.dependencies['fluent-ffmpeg']}`));
  } else {
    console.log(chalk.cyan('⏳ Instalando fluent-ffmpeg...'));
    execSync('npm install fluent-ffmpeg', { cwd: __dirname, stdio: 'inherit' });
    console.log(chalk.green('✅ fluent-ffmpeg instalado correctamente'));
  }
} catch (err) {
  console.log(chalk.red(`❌ Error instalando dependencia: ${err.message}`));
  console.log(chalk.yellow('   Puedes instalar manualmente: npm install fluent-ffmpeg'));
  success = false;
}

// ═══════════════════════════════════════════════════════════════
// PASO 4: Verificar FFmpeg en sistema
// ═══════════════════════════════════════════════════════════════
console.log('\n📋 PASO 4: Verificar FFmpeg en sistema');
console.log(chalk.gray('─'.repeat(70)));

let ffmpegInstalled = false;
let ffprobeInstalled = false;

try {
  execSync('ffmpeg -version', { stdio: 'ignore' });
  const version = execSync('ffmpeg -version', { encoding: 'utf8' }).split('\n')[0];
  console.log(chalk.green(`✅ FFmpeg disponible`));
  console.log(chalk.gray(`   ${version}`));
  ffmpegInstalled = true;
} catch (err) {
  console.log(chalk.red(`❌ FFmpeg no encontrado en PATH`));
  ffmpegInstalled = false;
}

try {
  execSync('ffprobe -version', { stdio: 'ignore' });
  console.log(chalk.green(`✅ FFprobe disponible`));
  ffprobeInstalled = true;
} catch (err) {
  console.log(chalk.red(`❌ FFprobe no encontrado en PATH`));
  ffprobeInstalled = false;
}

if (!ffmpegInstalled || !ffprobeInstalled) {
  console.log(chalk.yellow('\n⚠️  IMPORTANTE: Debes instalar FFmpeg en tu sistema:'));
  
  if (process.platform === 'linux') {
    console.log(chalk.white('   Linux (Ubuntu/Debian):'));
    console.log(chalk.cyan('     sudo apt-get update'));
    console.log(chalk.cyan('     sudo apt-get install ffmpeg'));
  } else if (process.platform === 'darwin') {
    console.log(chalk.white('   macOS:'));
    console.log(chalk.cyan('     brew install ffmpeg'));
  } else if (process.platform === 'win32') {
    console.log(chalk.white('   Windows (Chocolatey):'));
    console.log(chalk.cyan('     choco install ffmpeg'));
    console.log(chalk.white('   O descarga desde:'));
    console.log(chalk.cyan('     https://ffmpeg.org/download.html'));
  }
  
  console.log(chalk.white('\n   Luego verifica:'));
  console.log(chalk.cyan('     ffmpeg -version'));
  console.log(chalk.cyan('     ffprobe -version'));
  
  success = false;
}

// ═══════════════════════════════════════════════════════════════
// PASO 5: Crear .env si no existe
// ═══════════════════════════════════════════════════════════════
console.log('\n📋 PASO 5: Configurar variables de entorno');
console.log(chalk.gray('─'.repeat(70)));

const envPath = path.join(__dirname, '.env');
const envExamplePath = path.join(__dirname, '.env.example');

if (fs.existsSync(envPath)) {
  console.log(chalk.green(`✅ .env ya existe`));
} else if (fs.existsSync(envExamplePath)) {
  try {
    const envExample = fs.readFileSync(envExamplePath, 'utf8');
    fs.writeFileSync(envPath, envExample);
    console.log(chalk.green(`✅ .env creado desde .env.example`));
  } catch (err) {
    console.log(chalk.yellow(`⚠️  No se pudo crear .env: ${err.message}`));
  }
} else {
  console.log(chalk.gray('   (.env no es obligatorio si FFmpeg está en PATH)'));
}

// ═══════════════════════════════════════════════════════════════
// PASO 6: Crear directorios temporales
// ═══════════════════════════════════════════════════════════════
console.log('\n📋 PASO 6: Crear directorios de trabajo');
console.log(chalk.gray('─'.repeat(70)));

const workDirs = [
  'temp/encoding',
  'logs/encoder',
  'uploads/encoded'
];

workDirs.forEach(dir => {
  const fullPath = path.join(__dirname, dir);
  try {
    if (!fs.existsSync(fullPath)) {
      fs.mkdirSync(fullPath, { recursive: true });
      console.log(chalk.green(`✅ Creado: ${dir}/`));
    }
  } catch (err) {
    console.log(chalk.yellow(`⚠️  No se pudo crear ${dir}: ${err.message}`));
  }
});

// ═══════════════════════════════════════════════════════════════
// RESUMEN FINAL
// ═══════════════════════════════════════════════════════════════
console.log('\n' + chalk.gray('═'.repeat(70)));

if (ffmpegInstalled && ffprobeInstalled && success) {
  console.log(chalk.green.bold('\n✅ INSTALACIÓN COMPLETADA EXITOSAMENTE\n'));
  
  console.log(chalk.cyan('Próximos pasos:'));
  console.log(chalk.white('  1. Verifica la instalación:'));
  console.log(chalk.cyan('     node test-video-encoder.js'));
  console.log(chalk.white('  2. Prueba con un video real:'));
  console.log(chalk.cyan('     node test-video-encoder.js --input=data/shorts/video.mp4 --format=vertical'));
  console.log(chalk.white('  3. Integra en tu código (ver VIDEO_ENCODER_README.md)'));
  console.log();
  
  process.exit(0);
} else {
  console.log(chalk.yellow.bold('\n⚠️  SETUP PARCIAL - ACCIONES REQUERIDAS\n'));
  
  if (!ffmpegInstalled || !ffprobeInstalled) {
    console.log(chalk.red('❌ FFmpeg no está instalado en el sistema'));
    console.log(chalk.white('   El módulo no funcionará sin FFmpeg.'));
    console.log(chalk.white('   Ver instrucciones de instalación arriba.'));
    console.log();
  }
  
  if (!success) {
    console.log(chalk.red('❌ Algunos pasos fallaron.'));
    console.log(chalk.white('   Revisa los errores arriba y corrige.'));
    console.log();
  }
  
  console.log(chalk.cyan('Después de resolver los problemas, ejecuta nuevamente:'));
  console.log(chalk.white('  node setup-video-encoder.js'));
  console.log();
  
  process.exit(1);
}
