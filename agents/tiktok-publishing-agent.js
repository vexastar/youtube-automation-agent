/**
 * TikTok Direct Post API Publishing Agent
 * 
 * Integración con TikTok Content Posting API v2
 * Flujo: Init Upload → Upload Video → Check Status
 * 
 * Documentación: https://developer.tiktok.com/doc/embed-sdk/reference/
 */

// ═══ CARGAR VARIABLES DE ENTORNO ═══
require('dotenv').config();

const axios = require('axios');
const fs = require('fs');
const fsSync = require('fs');
const path = require('path');
const { Logger } = require('../utils/logger');

class TikTokPublishingAgent {
  constructor(db, credentials) {
    this.db = db;
    this.credentials = credentials;
    this.logger = new Logger('TikTokPublishing');
    this.apiBaseUrl = 'https://open.tiktokapis.com/v2';
    this.accessToken = null;
    this.clientKey = null;
  }

  async initialize() {
    try {
      this.logger.info('Initializing TikTok Publishing Agent...');
      
      // ═══ ESTRATEGIA DE LECTURA DE CREDENCIALES ═══
      // 1. Primero, intentar obtener desde credential-manager
      let tiktokAuth = null;
      if (this.credentials && typeof this.credentials.getTikTokAuth === 'function') {
        tiktokAuth = this.credentials.getTikTokAuth();
      }
      
      // 2. Si no está disponible, leer directamente desde process.env
      if (!tiktokAuth) {
        const tokenFromEnv = process.env.TIKTOK_ACCESS_TOKEN;
        const keyFromEnv = process.env.TIKTOK_CLIENT_KEY;
        
        if (tokenFromEnv && keyFromEnv) {
          tiktokAuth = {
            accessToken: tokenFromEnv,
            clientKey: keyFromEnv
          };
          this.logger.info('   📝 Credenciales cargadas desde .env');
        }
      } else {
        this.logger.info('   📝 Credenciales cargadas desde credential-manager');
      }
      
      if (!tiktokAuth || !tiktokAuth.accessToken || !tiktokAuth.clientKey) {
        this.logger.error('❌ TikTok credentials not configured');
        this.logger.error('   Asegúrate de que .env contiene:');
        this.logger.error('   - TIKTOK_ACCESS_TOKEN');
        this.logger.error('   - TIKTOK_CLIENT_KEY');
        return false;
      }
      
      this.accessToken = tiktokAuth.accessToken;
      this.clientKey = tiktokAuth.clientKey;
      
      this.logger.success('✅ TikTok Publishing Agent initialized');
      return true;
    } catch (error) {
      this.logger.error('❌ Failed to initialize TikTok agent:', error.message);
      return false;
    }
  }

  /**
   * Valida y sanitiza el título para cumplir con los límites de TikTok
   * - Máximo 150 caracteres en el título
   * - Sin caracteres especiales problemáticos
   * 
   * @param {string} title - Título original
   * @returns {string} Título sanitizado
   * @private
   */
  _sanitizeTitle(title) {
    // Remover caracteres especiales problemáticos
    let sanitized = String(title || 'TikTok Video')
      .replace(/[^\w\s\-áéíóúñ¡!¿?.,#@]/gi, '')
      .trim();
    
    // Limitar a 150 caracteres (máximo de TikTok)
    if (sanitized.length > 150) {
      sanitized = sanitized.substring(0, 147) + '...';
    }
    
    return sanitized || 'TikTok Video';
  }

  /**
   * Valida y sanitiza la descripción para cumplir con los límites de TikTok
   * - Máximo 2200 caracteres
   * - Preservar hashtags y menciones
   * 
   * @param {string} description - Descripción original
   * @returns {string} Descripción sanitizada
   * @private
   */
  _sanitizeDescription(description) {
    let sanitized = String(description || '')
      .replace(/[^\w\s\-áéíóúñ¡!¿?.,:;#@()\n]/gi, '')
      .trim();
    
    // Limitar a 2200 caracteres (máximo de TikTok)
    if (sanitized.length > 2200) {
      sanitized = sanitized.substring(0, 2197) + '...';
    }
    
    return sanitized;
  }

  /**
   * FASE 1: Inicializar la subida
   * POST a /v2/post/publish/video/init/
   * Devuelve upload_url y publish_id
   * 
   * @param {string} videoPath - Ruta local del archivo MP4
   * @param {object} metadata - {title, description, hashtags, privacyLevel}
   * @returns {Promise<{upload_url, publish_id, videoSize, chunkSize, totalChunks}>}
   * @private
   */
  async _initUpload(videoPath, metadata) {
    try {
      this.logger.info(`\n[TikTok] FASE 1: Inicializando carga...`);
      
      // Validar que el archivo existe
      if (!fsSync.existsSync(videoPath)) {
        throw new Error(`Video file not found: ${videoPath}`);
      }
      
      // Obtener tamaño del archivo
      const fileStats = fsSync.statSync(videoPath);
      const videoSize = fileStats.size;
      const fileSizeMB = (videoSize / (1024 * 1024)).toFixed(2);
      
      this.logger.info(`  📏 Tamaño de archivo: ${fileSizeMB}MB (${videoSize} bytes)`);
      
      // Calcular chunk size y total chunks (DINÁMICO)
      // TikTok soporta chunks de hasta 100MB, usamos 50MB como máximo
      // IMPORTANTE: El chunk_size NO PUEDE ser mayor que video_size
      const maxChunkSize = 50 * 1024 * 1024; // 50MB máximo
      const chunkSize = Math.min(videoSize, maxChunkSize); // Adaptarse al tamaño del archivo
      const totalChunks = Math.ceil(videoSize / chunkSize);
      
      this.logger.info(`  📦 Configuración de chunks: ${totalChunks} chunks de ${(chunkSize / (1024 * 1024)).toFixed(2)}MB`);
      
      // Sanitizar metadatos
      const title = this._sanitizeTitle(metadata?.title || 'TikTok Video');
      const description = this._sanitizeDescription(metadata?.description || '');
      const privacyLevel = 'SELF_ONLY'; // Valor estático para evitar error de sandbox
      
      this.logger.info(`  📝 Título: "${title.substring(0, 50)}${title.length > 50 ? '...' : ''}"`);
      this.logger.info(`  🔒 Privacidad: ${privacyLevel}`);
      
      // ═══ SOLICITUD INIT ═══
      const initPayload = {
        post_info: {
          title: title,
          description: description,
          privacy_level: privacyLevel,
          disable_comment: false,
          disable_duet: false,
          disable_stitch: false
        },
        source_info: {
          source: 'FILE_UPLOAD',
          video_size: videoSize,
          chunk_size: chunkSize,
          total_chunk_count: totalChunks
        }
      };
      
      this.logger.info(`  📤 Enviando solicitud INIT a TikTok API...`);
      
      const response = await axios.post(
        `${this.apiBaseUrl}/post/publish/video/init/`,
        initPayload,
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json'
          },
          timeout: 30000
        }
      );
      
      // Validar respuesta
      // IMPORTANTE: La API de TikTok SIEMPRE devuelve un objeto error
      // Cuando es exitoso: error.code === 'ok'
      // Cuando falla: error.code !== 'ok' (ej: 'invalid_params', 'permission_denied')
      if (!response.data || (response.data.error && response.data.error.code !== 'ok')) {
        const errorMsg = response.data?.error?.message || response.data?.error || 'Unknown error';
        
        // ═══ IMPRIMIR ESTRUCTURA COMPLETA DEL ERROR ═══
        this.logger.error(`\n   📋 ESTRUCTURA COMPLETA DEL ERROR DE RESPUESTA:`);
        try {
          const fullErrorData = JSON.stringify(response.data || {}, null, 2);
          this.logger.error(`   ${fullErrorData}`);
        } catch (stringifyError) {
          this.logger.error(`   (No se pudo serializar): ${response.data}`);
        }
        
        throw new Error(`TikTok API error: ${errorMsg}`);
      }
      
      const { data } = response.data;
      if (!data || !data.upload_url || !data.publish_id) {
        throw new Error('Invalid response: missing upload_url or publish_id');
      }
      
      this.logger.success(`✅ FASE 1 exitosa:`);
      this.logger.success(`   📌 Publish ID: ${data.publish_id}`);
      this.logger.success(`   🔗 Upload URL obtenida (${data.upload_url.substring(0, 60)}...)`);
      
      return {
        upload_url: data.upload_url,
        publish_id: data.publish_id,
        videoSize: videoSize,
        chunkSize: chunkSize,
        totalChunks: totalChunks
      };
      
    } catch (error) {
      const statusCode = error.response?.status || 'N/A';
      const errorData = error.response?.data || {};
      const errorMessage = error.message || 'Unknown error';
      
      this.logger.error(`❌ FASE 1 falló [HTTP ${statusCode}]:`);
      this.logger.error(`   Mensaje: ${errorMessage}`);
      
      // ═══ DETALLES COMPLETOS DE LA RESPUESTA DE ERROR ═══
      // Siempre imprimir el JSON completo de la respuesta
      if (error.response?.data) {
        this.logger.error(`\n   📋 ESTRUCTURA COMPLETA DEL ERROR DE TIKTOK API:`);
        try {
          const fullErrorJson = JSON.stringify(error.response.data, null, 2);
          this.logger.error(`${fullErrorJson}`);
        } catch (stringifyError) {
          this.logger.error(`   (Error al serializar): ${String(error.response.data)}`);
        }
      } else if (Object.keys(errorData).length > 0) {
        this.logger.error(`\n   📋 DETALLES DEL ERROR DE TIKTOK API:`);
        try {
          const fallbackJson = JSON.stringify(errorData, null, 2);
          this.logger.error(`${fallbackJson}`);
        } catch (stringifyError) {
          this.logger.error(`   (Error al serializar): ${String(errorData)}`);
        }
      }
      
      // Extraer campos específicos si existen
      if (errorData.error) {
        const errObj = errorData.error;
        if (errObj.code) this.logger.error(`   • Código: ${errObj.code}`);
        if (errObj.message) this.logger.error(`   • Mensaje: ${errObj.message}`);
        if (errObj.error_description) this.logger.error(`   • Descripción: ${errObj.error_description}`);
      }
      
      // ═══ DIAGNÓSTICO ESPECÍFICO POR STATUS CODE ═══
      if (error.response?.status === 400) {
        this.logger.error(`\n   ⚠️  HTTP 400 - Solicitud inválida. Verificar:`);
        this.logger.error(`       - Formato de post_info`);
        this.logger.error(`       - Tamaño de archivo (chunk_size ≤ video_size)`);
        this.logger.error(`       - Permisos de token`);
      } else if (error.response?.status === 403) {
        this.logger.error(`\n   ⚠️  HTTP 403 - Acceso Forbidden. Posibles causas:`);
        this.logger.error(`       - Token de acceso inválido o expirado`);
        this.logger.error(`       - Permisos insuficientes (revisar video.publish scope)`);
        this.logger.error(`       - Token tiene restricciones geográficas`);
        this.logger.error(`       - Cuenta de TikTok sin permisos API`);
        this.logger.error(`   💡 Solución: Verifica el TIKTOK_ACCESS_TOKEN en .env`);
      } else if (error.response?.status === 401) {
        this.logger.error(`\n   ⚠️  HTTP 401 - Unauthorized. El token no es válido.`);
        this.logger.error(`       - Verifica TIKTOK_ACCESS_TOKEN`);
        this.logger.error(`       - Verifica TIKTOK_CLIENT_KEY`);
      }
      
      throw error;
    }
  }

  /**
   * FASE 2: Subir el video en chunks
   * PUT al upload_url con Content-Range headers
   * 
   * @param {string} videoPath - Ruta del archivo
   * @param {string} uploadUrl - URL devuelto en Fase 1
   * @param {number} chunkSize - Tamaño de cada chunk
   * @param {number} totalChunks - Cantidad total de chunks
   * @returns {Promise<boolean>} true si la subida fue exitosa
   * @private
   */
  async _uploadVideoChunks(videoPath, uploadUrl, chunkSize, totalChunks) {
    try {
      this.logger.info(`\n[TikTok] FASE 2: Subiendo ${totalChunks} chunk(s)...`);
      
      const fileStream = fsSync.createReadStream(videoPath);
      const fileStats = fsSync.statSync(videoPath);
      const totalSize = fileStats.size;
      
      let uploadedBytes = 0;
      let chunkNumber = 0;
      let buffer = Buffer.alloc(0);
      
      // ═══ ESTRATEGIA: Leer en chunks y enviar con Content-Range ═══
      return new Promise((resolve, reject) => {
        fileStream.on('data', async (chunk) => {
          buffer = Buffer.concat([buffer, chunk]);
          
          // Si tenemos un chunk completo (o es el último)
          while (buffer.length >= chunkSize || (uploadedBytes + buffer.length === totalSize)) {
            const bytesToSend = Math.min(buffer.length, chunkSize);
            const dataToSend = buffer.slice(0, bytesToSend);
            
            const rangeStart = uploadedBytes;
            const rangeEnd = uploadedBytes + bytesToSend - 1;
            const rangeHeader = `bytes ${rangeStart}-${rangeEnd}/${totalSize}`;
            
            chunkNumber++;
            const percentComplete = ((uploadedBytes + bytesToSend) / totalSize * 100).toFixed(1);
            
            this.logger.info(`  📨 Enviando chunk ${chunkNumber}/${totalChunks} (${percentComplete}%): ${rangeHeader}`);
            
            try {
              // Pausar lectura durante el upload
              fileStream.pause();
              
              // Enviar chunk
              await axios.put(uploadUrl, dataToSend, {
                headers: {
                  'Content-Range': rangeHeader,
                  'Content-Type': 'video/mp4'
                },
                timeout: 120000  // 2 minutos por chunk
              });
              
              this.logger.success(`  ✅ Chunk ${chunkNumber} subido correctamente`);
              
              uploadedBytes += bytesToSend;
              buffer = buffer.slice(bytesToSend);
              
              // Reanudar lectura
              fileStream.resume();
              
            } catch (chunkError) {
              const statusCode = chunkError.response?.status || 'N/A';
              this.logger.error(`  ❌ Error en chunk ${chunkNumber} [HTTP ${statusCode}]:`);
              this.logger.error(`     ${chunkError.message}`);
              
              if (chunkError.response?.status === 400) {
                this.logger.error(`     ⚠️  HTTP 400 - Verificar Content-Range header:`);
                this.logger.error(`         ${rangeHeader}`);
              }
              
              fileStream.destroy();
              reject(chunkError);
              return;
            }
            
            // Si es el último chunk, terminar
            if (uploadedBytes === totalSize) {
              break;
            }
          }
        });
        
        fileStream.on('end', () => {
          if (uploadedBytes === totalSize) {
            this.logger.success(`\n✅ FASE 2 exitosa:`);
            this.logger.success(`   📤 ${totalChunks} chunk(s) subido(s) correctamente`);
            this.logger.success(`   💾 Total: ${(totalSize / (1024 * 1024)).toFixed(2)}MB`);
            resolve(true);
          } else {
            reject(new Error(`Upload incomplete: ${uploadedBytes}/${totalSize} bytes`));
          }
        });
        
        fileStream.on('error', (streamError) => {
          this.logger.error(`  ❌ Error leyendo archivo: ${streamError.message}`);
          reject(streamError);
        });
      });
      
    } catch (error) {
      this.logger.error(`❌ FASE 2 falló:`);
      this.logger.error(`   ${error.message}`);
      throw error;
    }
  }

  /**
   * FASE 3: Verificar estado de la publicación
   * POST a /v2/post/publish/status/fetch/ con publish_id
   * 
   * @param {string} publishId - ID de publicación devuelto en Fase 1
   * @param {number} maxRetries - Máximo número de intentos (default 10)
   * @param {number} retryDelayMs - Delay entre intentos (default 3000ms)
   * @returns {Promise<{status, videoUrl, publishTime}>}
   * @private
   */
  async _checkPublishStatus(publishId, maxRetries = 10, retryDelayMs = 3000) {
    try {
      this.logger.info(`\n[TikTok] FASE 3: Verificando estado de publicación...`);
      this.logger.info(`  ⏳ Esperando a que TikTok procese el video (máx ${maxRetries} intentos)...`);
      
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const statusPayload = {
            publish_id: publishId
          };
          
          this.logger.info(`  📋 Status check intento ${attempt}/${maxRetries}...`);
          
          const response = await axios.post(
            `${this.apiBaseUrl}/post/publish/status/fetch/`,
            statusPayload,
            {
              headers: {
                'Authorization': `Bearer ${this.accessToken}`,
                'Content-Type': 'application/json'
              },
              timeout: 30000
            }
          );
          
          // ═══ VALIDACIÓN IGUAL A FASE 1 ═══
          // IMPORTANTE: La API de TikTok SIEMPRE devuelve un objeto error
          // Cuando es exitoso: error.code === 'ok'
          // Cuando falla: error.code !== 'ok'
          if (!response.data || (response.data.error && response.data.error.code !== 'ok')) {
            const errorMsg = response.data?.error?.message || response.data?.error || 'Unknown error';
            
            // ═══ IMPRIMIR ESTRUCTURA COMPLETA DEL ERROR ═══
            this.logger.error(`\n   📋 ESTRUCTURA COMPLETA DEL ERROR DE RESPUESTA:`);
            try {
              const fullErrorData = JSON.stringify(response.data || {}, null, 2);
              this.logger.error(`   ${fullErrorData}`);
            } catch (stringifyError) {
              this.logger.error(`   (No se pudo serializar): ${response.data}`);
            }
            
            throw new Error(`TikTok API error: ${errorMsg}`);
          }
          
          const { data } = response.data;
          
          // ═══ VERIFICAR ESTADOS POSIBLES ═══
          const status = data?.status || 'UNKNOWN';
          
          this.logger.info(`  📊 Estado recibido: ${status}`);
          
          if (status === 'PUBLISHED' || status === 'PUBLISH_COMPLETE') {
            this.logger.success(`✅ FASE 3 exitosa:`);
            this.logger.success(`   🎬 Video publicado correctamente`);
            this.logger.success(`   🔗 URL: ${data.video_url || 'N/A'}`);
            this.logger.success(`   ⏰ Publicado en: ${data.create_time || 'N/A'}`);
            
            return {
              status: 'PUBLISHED',
              videoUrl: data.video_url || null,
              publishTime: data.create_time || null,
              publishId: publishId
            };
          } else if (status === 'PROCESSING_UPLOAD' || status === 'PROCESSING_PUBLISH') {
            // Aún procesando, reintentar
            this.logger.info(`  ⏳ Estado: ${status}. Reintentando...`);
            await new Promise(resolve => setTimeout(resolve, retryDelayMs));
            continue;
          } else if (status === 'FAILED') {
            const failReason = data?.reason || 'Unknown reason';
            throw new Error(`Video publication failed: ${failReason}`);
          } else {
            // Estado desconocido
            this.logger.warn(`  ⚠️  Estado inesperado: ${status}`);
            await new Promise(resolve => setTimeout(resolve, retryDelayMs));
            continue;
          }
          
        } catch (attemptError) {
          if (attempt === maxRetries) {
            throw attemptError;
          }
          
          // Reintentar en otros casos
          this.logger.warn(`  ⚠️  Intento ${attempt} falló: ${attemptError.message}`);
          await new Promise(resolve => setTimeout(resolve, retryDelayMs));
        }
      }
      
      // Máximo de intentos agotado
      throw new Error(`Status check timeout: Max ${maxRetries} retries exceeded`);
      
    } catch (error) {
      const statusCode = error.response?.status || 'N/A';
      
      this.logger.error(`❌ FASE 3 falló [HTTP ${statusCode}]:`);
      this.logger.error(`   ${error.message}`);
      
      if (error.response?.status === 400) {
        this.logger.error(`   ⚠️  HTTP 400 - Verificar:`);
        this.logger.error(`       - Formato de publish_id`);
        this.logger.error(`       - Permisos de token`);
      }
      
      throw error;
    }
  }

  /**
   * Método público principal: Publicar video en TikTok
   * Coordina las 3 fases del flujo FILE_UPLOAD
   * 
   * @param {string} videoPath - Ruta local del archivo MP4
   * @param {object} metadata - {title, description, hashtags, privacyLevel}
   * @returns {Promise<{status, videoUrl, publishId}>}
   */
  async publishVideo(videoPath, metadata = {}) {
    const startTime = Date.now();
    
    try {
      this.logger.info(`\n════════════════════════════════════════════════════════════`);
      this.logger.info(`TikTok Publishing Pipeline (FILE_UPLOAD)`);
      this.logger.info(`Archivo: ${path.basename(videoPath)}`);
      this.logger.info(`════════════════════════════════════════════════════════════`);
      
      // ═══ VERIFICACIÓN DE SEGURIDAD: Confirmar que el token se está leyendo ═══
      if (this.accessToken) {
        const tokenPreview = this.accessToken.substring(0, 5) + '*'.repeat(Math.max(0, this.accessToken.length - 5));
        console.log(`\n🔐 Token detectado: ${tokenPreview}\n`);
      } else {
        console.warn(`\n⚠️  ADVERTENCIA: No se detectó token de TikTok\n`);
      }
      
      // Validar archivo existe
      if (!fsSync.existsSync(videoPath)) {
        throw new Error(`Video file not found: ${videoPath}`);
      }
      
      // Validar que el token esté configurado
      if (!this.accessToken) {
        throw new Error('TikTok access token not configured');
      }
      
      // ═══ FASE 1: Init ═══
      const initData = await this._initUpload(videoPath, metadata);
      
      // ═══ FASE 2: Upload ═══
      await this._uploadVideoChunks(
        videoPath,
        initData.upload_url,
        initData.chunkSize,
        initData.totalChunks
      );
      
      // ═══ FASE 3: Status ═══
      const statusData = await this._checkPublishStatus(initData.publish_id);
      
      // ═══ RESUMEN FINAL ═══
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      
      this.logger.info(`\n════════════════════════════════════════════════════════════`);
      this.logger.info(`✅ TikTok Publishing Completado`);
      this.logger.info(`   Status: ${statusData.status}`);
      this.logger.info(`   URL: ${statusData.videoUrl || 'N/A'}`);
      this.logger.info(`   Tiempo total: ${duration}s`);
      this.logger.info(`════════════════════════════════════════════════════════════\n`);
      
      return {
        status: 'success',
        tiktokStatus: statusData.status,
        videoUrl: statusData.videoUrl,
        publishId: statusData.publishId,
        publishTime: statusData.publishTime,
        duration: parseFloat(duration)
      };
      
    } catch (error) {
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      
      this.logger.error(`\n════════════════════════════════════════════════════════════`);
      this.logger.error(`❌ TikTok Publishing Falló`);
      this.logger.error(`   Error: ${error.message}`);
      this.logger.error(`   Tiempo: ${duration}s`);
      this.logger.error(`════════════════════════════════════════════════════════════\n`);
      
      return {
        status: 'failed',
        error: error.message,
        duration: parseFloat(duration)
      };
    }
  }

  /**
   * Método auxiliar: Obtener información sobre límites de TikTok
   * Útil para logging y debugging
   * 
   * @returns {object} Límites de video en TikTok
   */
  getTikTokLimits() {
    return {
      maxVideoSize: '287.6 MB',
      maxVideoDuration: '10 minutes (TikTok app) / 60 minutes (TikTok Studio)',
      minVideoDuration: '3 seconds',
      supportedFormats: ['MP4', 'MOV', 'MPEG', 'AVI', 'WMV', 'FLV', 'MKV'],
      maxTitleLength: 150,
      maxDescriptionLength: 2200,
      maxChunkSize: '100 MB',
      privacyLevels: ['PUBLIC', 'FRIENDS', 'MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY'],
      permissionRequired: 'video.publish'
    };
  }
}

module.exports = { TikTokPublishingAgent };
