/**
 * WEBHOOK DISTRIBUTION AGENT (REFACTORED - DIRECT VIDEO DELIVERY)
 * ═══════════════════════════════════════════════════════════════
 * 
 * Distribuye videos verticales a Make.com para publicación en:
 * - TikTok
 * - Instagram Reels
 * - Facebook Reels
 * 
 * ARQUITECTURA (NUEVA - DIRECT DELIVERY):
 * ✅ Envía video .mp4 DIRECTAMENTE a Make.com webhook (multipart/form-data)
 * ❌ No usa CDN intermedio (elimina DNS timeouts, rate limits, anti-bot blocks)
 * ❌ No requiere esperar confirmación de URL de CDN
 * 
 * CAMBIOS RESPECTO A VERSIÓN ANTERIOR:
 * - Antes: video → catbox.moe → get URL → JSON webhook
 * - Ahora:  video → multipart/form-data → direct webhook
 * 
 * BENEFICIOS:
 * - Más rápido (sin upload a CDN intermedio)
 * - Más confiable (evita DNS, rate limits, anti-bot)
 * - Más simple (una etapa en lugar de dos)
 */

const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const { Logger } = require('../utils/logger');

class WebhookDistributionAgent {
  constructor(credentials = null) {
    this.logger = new Logger('WebhookDistributionAgent');
    this.webhookUrl = process.env.MAKE_WEBHOOK_URL || null;
    this.credentials = credentials;
    this.catboxApiUrl = 'https://catbox.moe/user/api.php';
  }

  async initialize() {
    if (!this.webhookUrl) {
      this.logger.warn('⚠️  MAKE_WEBHOOK_URL no configurada en .env — distribución a Make.com desactivada');
    } else {
      this.logger.info(`✓ WebhookDistributionAgent inicializado`);
      this.logger.info(`  Webhook URL: ${this.webhookUrl.substring(0, 60)}...`);
      this.logger.info(`  Modo: DIRECT VIDEO DELIVERY (sin CDN intermedio)`);
    }
  }

  /**
   * Intenta subir a Catbox.moe con una sola instancia.
   * @private
   */
  async _uploadToCatbox(videoPath, fileName, fileSizeMB) {
    const form = new FormData();
    form.append('reqtype', 'fileupload');
    form.append('fileToUpload', fs.createReadStream(videoPath));

    const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

    const response = await axios.post(this.catboxApiUrl, form, {
      headers: {
        ...form.getHeaders(),
        'User-Agent': userAgent
      },
      timeout: 180000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      validateStatus: () => true
    });

    const uploadedUrl = response.data;

    if (!uploadedUrl || uploadedUrl.includes('error') || response.status >= 400) {
      throw new Error(`catbox.moe error (HTTP ${response.status}): ${uploadedUrl}`);
    }

    return uploadedUrl.trim();
  }

  /**
   * Intenta subir a 0x0.st (fallback) con una sola instancia.
   * Timeout aumentado a 60s para permitir uploads de videos grandes.
   * @private
   */
  async _uploadTo0x0(videoPath, fileName, fileSizeMB) {
    const form = new FormData();
    form.append('file', fs.createReadStream(videoPath));

    const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

    const response = await axios.post('https://0x0.st', form, {
      headers: {
        ...form.getHeaders(),
        'User-Agent': userAgent
      },
      timeout: 60000, // 60 segundos para uploads de video
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      validateStatus: () => true
    });

    const uploadedUrl = response.data;

    if (!uploadedUrl || response.status >= 400) {
      throw new Error(`0x0.st error (HTTP ${response.status}): ${uploadedUrl}`);
    }

    return uploadedUrl.trim();
  }

  /**
   * Intenta subir a tmpfiles.org (fallback secundario).
   * Parsea correctamente la respuesta JSON: {"status":"success","data":{"url":"..."}}
   * @private
   */
  async _uploadToTmpfiles(videoPath, fileName, fileSizeMB) {
    const form = new FormData();
    form.append('file', fs.createReadStream(videoPath));

    const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

    const response = await axios.post('https://tmpfiles.org/api/v1/upload', form, {
      headers: {
        ...form.getHeaders(),
        'User-Agent': userAgent
      },
      timeout: 180000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      validateStatus: () => true
    });

    if (response.status >= 400) {
      throw new Error(`tmpfiles.org error (HTTP ${response.status})`);
    }

    // tmpfiles.org devuelve JSON estructurado: {"status":"success","data":{"url":"..."}} 
    try {
      let responseData = response.data;

      // Si la respuesta es string, parsear como JSON
      if (typeof responseData === 'string') {
        responseData = JSON.parse(responseData);
      }

      // Validar estructura de respuesta exitosa
      if (responseData && responseData.status === 'success' && responseData.data && responseData.data.url) {
        const url = responseData.data.url;
        if (typeof url === 'string' && url.length > 0) {
          return url.trim();
        }
      }

      throw new Error(`tmpfiles.org: estructura de respuesta inesperada`);

    } catch (parseError) {
      if (parseError.message.includes('estructura de respuesta inesperada')) {
        throw parseError;
      }
      // Error en parseo JSON
      throw new Error(`tmpfiles.org: error al parsear respuesta - ${parseError.message}`);
    }
  }

  /**
   * Sube archivo de video con reintentos automáticos y fallback dinámico.
   * Implementa adaptabilidad dinámica con 3 servicios CDN (catbox → 0x0 → tmpfiles).
   * 
   * Arquitectura:
   * 1. Intenta Catbox.moe (principal) con 2 reintentos
   * 2. Si falla, intenta 0x0.st (fallback primario) con 2 reintentos
   * 3. Si falla, intenta tmpfiles.org (fallback secundario) con 2 reintentos
   * 4. Si todo falla, lanza error (pero el pipeline no debe llegar aquí)
   * 
   * @param {string} videoPath - Ruta local del archivo de video
   * @returns {Promise<string>} URL pública del archivo en CDN
   * @throws {Error} Si todos los servicios fallan
   */
  async _uploadToCloud(videoPath) {
    try {
      // Validar archivo
      if (!fs.existsSync(videoPath)) {
        throw new Error(`Video no encontrado en: ${videoPath}`);
      }

      const fileStats = fs.statSync(videoPath);
      const fileSizeMB = (fileStats.size / (1024 * 1024)).toFixed(2);
      const fileName = path.basename(videoPath);

      this.logger.info(`   ☁️  Iniciando upload: ${fileName} (${fileSizeMB} MB)`);

      // ═════════════════════════════════════════════════════════════
      // SERVICIO PRINCIPAL: 0x0.st (ÚNICO CDN CONFIABLE)
      // catbox.moe: DNS_PROBE_POSSIBLE (network issue)
      // tmpfiles.org: Cloudflare anti-bot blocks
      // ═════════════════════════════════════════════════════════════
      const maxRetries = 2;
      let lastError = null;

      // 🔴 COMENTADO: catbox.moe - DNS errors en red actual
      // for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      //   try {
      //     this.logger.info(`   🔄 Catbox.moe [Intento ${attempt}/${maxRetries + 1}]...`);
      //     const url = await this._uploadToCatbox(videoPath, fileName, fileSizeMB);
      //     this.logger.success(`   ✅ Subido a catbox: ${url.substring(0, 70)}...`);
      //     return url;
      //   } catch (error) {
      //     lastError = error;
      //     this.logger.warn(`   ⚠️  Intento ${attempt} falló: ${error.message}`);
      //     if (attempt <= maxRetries) {
      //       const delayMs = Math.pow(2, attempt - 1) * 1000;
      //       this.logger.info(`   ⏳ Esperando ${delayMs}ms antes de reintentar...`);
      //       await new Promise(resolve => setTimeout(resolve, delayMs));
      //     }
      //   }
      // }
      // this.logger.warn(`   ❌ Catbox.moe agotado. Intentando fallback: 0x0.st`);

      // ═════════════════════════════════════════════════════════════
      // FALLBACK 0: 0x0.st (ACTUALMENTE PRINCIPAL - ÚNICO CDN FUNCIONAL)
      // ═════════════════════════════════════════════════════════════
      for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
        try {
          this.logger.info(`   🔄 0x0.st [Intento ${attempt}/${maxRetries + 1}]...`);
          const url = await this._uploadTo0x0(videoPath, fileName, fileSizeMB);
          this.logger.success(`   ✅ Subido a 0x0.st: ${url.substring(0, 70)}...`);
          return url;
        } catch (error) {
          lastError = error;
          this.logger.warn(`   ⚠️  Intento ${attempt} falló: ${error.message}`);

          if (attempt <= maxRetries) {
            const delayMs = Math.pow(2, attempt - 1) * 1000;
            this.logger.info(`   ⏳ Esperando ${delayMs}ms antes de reintentar...`);
            await new Promise(resolve => setTimeout(resolve, delayMs));
          }
        }
      }

      // 🔴 COMENTADO: tmpfiles.org - Cloudflare anti-bot en red actual
      // this.logger.warn(`   ❌ 0x0.st agotado. Intentando fallback: tmpfiles.org`);
      // for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      //   try {
      //     this.logger.info(`   🔄 tmpfiles.org [Intento ${attempt}/${maxRetries + 1}]...`);
      //     const url = await this._uploadToTmpfiles(videoPath, fileName, fileSizeMB);
      //     this.logger.success(`   ✅ Subido a tmpfiles.org: ${url.substring(0, 70)}...`);
      //     return url;
      //   } catch (error) {
      //     lastError = error;
      //     this.logger.warn(`   ⚠️  Intento ${attempt} falló: ${error.message}`);
      //     if (attempt <= maxRetries) {
      //       const delayMs = Math.pow(2, attempt - 1) * 1000;
      //       this.logger.info(`   ⏳ Esperando ${delayMs}ms antes de reintentar...`);
      //       await new Promise(resolve => setTimeout(resolve, delayMs));
      //     }
      //   }
      // }

      // Si llegamos aquí, todos los servicios fallaron
      throw new Error(`Todos los servicios CDN agotados. Último error: ${lastError.message}`);

    } catch (error) {
      this.logger.error(`   ❌ Error fatal en upload a CDN: ${error.message}`);
      throw error;
    }
  }

  /**
   * ═══════════════════════════════════════════════════════════════
   * HELPER: Convierte URLs de tmpfiles.org a descarga directa
   * ═══════════════════════════════════════════════════════════════
   * Problema: tmpfiles.org devuelve URLs a landing pages (HTML)
   * Solución: Inyectar "/dl/" después del dominio para obtener binarios directos
   * 
   * Ejemplo:
   *   Entrada:  https://tmpfiles.org/1785175222/video.mp4
   *   Salida:   https://tmpfiles.org/dl/1785175222/video.mp4
   * 
   * URLs de otros CDNs (catbox, 0x0) no se modifican.
   * 
   * @param {string} url - URL original del CDN
   * @returns {string} URL optimizada para descarga directa si es tmpfiles.org
   * @private
   */
  _optimizeUrlForDirectDownload(url) {
    if (!url || typeof url !== 'string') {
      return url;
    }

    // Validar que contiene tmpfiles.org
    if (url.includes('tmpfiles.org')) {
      try {
        // Convertir string URL a objeto URL para manipulación segura
        const urlObj = new URL(url);

        // Si ya tiene "/dl/" en el pathname, no modificar (ya está optimizado)
        if (urlObj.pathname.includes('/dl/')) {
          this.logger.info(`   ℹ️  tmpfiles URL ya optimizada: ${url}`);
          return url;
        }

        // Inyectar "/dl/" después del dominio
        // pathname actual: /1785175222/video.mp4
        // pathname nuevo:  /dl/1785175222/video.mp4
        const originalPathname = urlObj.pathname;
        urlObj.pathname = `/dl${originalPathname}`;

        const optimizedUrl = urlObj.toString();
        this.logger.info(`   ✏️  tmpfiles URL convertida a descarga directa`);
        this.logger.info(`      Antes: ${url}`);
        this.logger.info(`      Después: ${optimizedUrl}`);

        return optimizedUrl;
      } catch (parseError) {
        // Si URL parsing falla, retornar original sin modificar
        this.logger.warn(`   ⚠️  Error al parsear URL para optimización: ${parseError.message}`);
        return url;
      }
    }

    // Si no es tmpfiles.org (catbox, 0x0, etc.), retornar sin cambios
    return url;
  }

  /**
   * Envía un video vertical directamente a Make.com a través del webhook.
   * 
   * Arquitectura NUEVA (Direct Delivery):
   * 1. Lee archivo .mp4 del sistema de archivos
   * 2. Crea FormData con video binario + metadata
   * 3. POSTs directamente al webhook de Make.com
   * 4. Sin CDN intermedio (elimina DNS, rate limits, anti-bot)
   * 
   * @param {string} videoPath - Ruta local del archivo de video
   * @param {object} metadata - Metadata {title, description, hashtags}
   * @returns {Promise<object>} Respuesta con status, webhookStatus, videoName
   */
  async sendToMakeWebhook(videoPath, metadata = {}) {
    try {
      // Validar webhook URL
      if (!this.webhookUrl) {
        this.logger.warn('⚠️  MAKE_WEBHOOK_URL no definida. Saltando envío a Make.com');
        return { 
          status: 'skipped', 
          reason: 'No webhook URL configured',
          videoName: path.basename(videoPath)
        };
      }

      const fileName = path.basename(videoPath);

      // Log pre-envío
      this.logger.info(`\n📤 Enviando video DIRECTAMENTE a Make.com (sin CDN):`);
      this.logger.info(`   Video: ${fileName}`);
      this.logger.info(`   Título: ${metadata.title || '(sin título)'}`);
      this.logger.info(`   Hashtags: ${(metadata.hashtags || '(ninguno)').substring(0, 60)}...`);

      // ═══════════════════════════════════════════════════════════
      // VALIDAR ARCHIVO
      // ═══════════════════════════════════════════════════════════
      if (!fs.existsSync(videoPath)) {
        throw new Error(`Video no encontrado: ${videoPath}`);
      }

      const fileStats = fs.statSync(videoPath);
      const fileSizeMB = (fileStats.size / (1024 * 1024)).toFixed(2);

      this.logger.info(`   📏 Tamaño: ${fileSizeMB} MB`);
      this.logger.info(`   🎬 Tipo: video/mp4`);

      // ═══════════════════════════════════════════════════════════
      // CREAR FormData CON VIDEO + METADATA
      // ═══════════════════════════════════════════════════════════
      const form = new FormData();

      // Append video file (stream)
      form.append('file', fs.createReadStream(videoPath), {
        filename: fileName,
        contentType: 'video/mp4'
      });

      // Append metadata fields
      form.append('title', metadata.title || 'Video de Productos');
      form.append('description', metadata.description || '');
      form.append('hashtags', (metadata.hashtags || '#gadgets #tecnologia').trim());
      form.append('source', 'youtube-automation-agent');
      form.append('file_size', fileStats.size.toString()); // Exact file size in bytes
      form.append('timestamp', new Date().toISOString());

      this.logger.info(`\n   📦 Payload:`);
      this.logger.info(`      • file: [stream] ${fileName}`);
      this.logger.info(`      • title: ${metadata.title || 'Video de Productos'}`);
      this.logger.info(`      • hashtags: ${(metadata.hashtags || '#gadgets #tecnologia').substring(0, 50)}...`);

      // ═══════════════════════════════════════════════════════════
      // REINTENTOS AUTOMÁTICOS: Resistencia a fallos de DNS/red
      // ═══════════════════════════════════════════════════════════
      const maxWebhookRetries = 3;
      const webhookRetryDelayMs = 2000; // 2 segundos entre intentos
      let lastWebhookError = null;
      let response = null;

      for (let attempt = 1; attempt <= maxWebhookRetries; attempt++) {
        try {
          this.logger.info(`\n   🔄 Intento de envío a Make.com [${attempt}/${maxWebhookRetries}]...`);
          
          response = await axios.post(this.webhookUrl, form, {
            headers: {
              ...form.getHeaders(),
              'User-Agent': 'youtube-automation-agent/direct-video-delivery'
            },
            timeout: 120000, // 120s para video file upload
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
            validateStatus: () => true // No lanzar error en cualquier status
          });

          // Si obtuvimos respuesta (incluso con error HTTP), romper el bucle
          break;

        } catch (error) {
          lastWebhookError = error;
          this.logger.warn(`   ⚠️  Intento ${attempt} falló: ${error.message}`);

          // Si es el último intento, no esperar
          if (attempt < maxWebhookRetries) {
            this.logger.info(`   ⏳ Esperando ${webhookRetryDelayMs}ms antes de reintentar...`);
            await new Promise(resolve => setTimeout(resolve, webhookRetryDelayMs));
          }
        }
      }

      // ═══════════════════════════════════════════════════════════
      // VALIDAR RESPUESTA
      // ═══════════════════════════════════════════════════════════

      // Si todos los reintentos fallaron con errores de red (sin obtener respuesta HTTP)
      if (!response && lastWebhookError) {
        this.logger.error(`   ❌ Webhook Make.com inaccesible después de ${maxWebhookRetries} intentos`);
        
        // Diagnóstico adicional
        if (lastWebhookError.code === 'ENOTFOUND') {
          this.logger.warn(`   → Error DNS (ENOTFOUND): Verifica conexión a internet o MAKE_WEBHOOK_URL`);
        } else if (lastWebhookError.code === 'ECONNREFUSED') {
          this.logger.warn(`   → Conexión rechazada (ECONNREFUSED): Webhook URL inaccesible`);
        } else if (lastWebhookError.code === 'ETIMEDOUT') {
          this.logger.warn(`   → Timeout de conexión (ETIMEDOUT): Servidor lento o caído`);
        }

        return {
          status: 'failed',
          error: `Webhook Make.com inaccesible: ${lastWebhookError.message}`,
          videoName: fileName,
          errorCode: lastWebhookError.code || 'NETWORK_ERROR',
          attemptsUsed: maxWebhookRetries
        };
      }

      // Validar respuesta HTTP (si la obtuvimos)
      if (response.status >= 200 && response.status < 300) {
        this.logger.success(`\n✅ Video enviado directamente a Make.com: HTTP ${response.status}`);
        if (response.data && response.data.message) {
          this.logger.info(`   Respuesta: ${response.data.message}`);
        }
        return {
          status: 'success',
          webhookStatus: response.status,
          videoName: fileName
        };
      } else {
        // Status no-exitoso pero no lanzar excepción
        this.logger.warn(`⚠️  Make.com respondió con HTTP ${response.status}`);
        if (response.data) {
          this.logger.warn(`   Respuesta: ${JSON.stringify(response.data).substring(0, 200)}`);
        }
        return {
          status: 'warning',
          webhookStatus: response.status,
          videoName: fileName,
          responseData: response.data
        };
      }

    } catch (error) {
      // Capturar error de red/timeout sin interrumpir pipeline
      this.logger.warn(`⚠️  Error enviando a Make.com: ${error.message}`);
      
      // Detalles adicionales para debugging
      if (error.code === 'ECONNREFUSED') {
        this.logger.warn(`   → Webhook URL inaccesible (ECONNREFUSED). Verifica MAKE_WEBHOOK_URL`);
      } else if (error.code === 'ETIMEDOUT') {
        this.logger.warn(`   → Timeout alcanzado. El webhook tardó mucho en responder`);
      }

      return {
        status: 'failed',
        error: error.message,
        videoName: path.basename(videoPath),
        errorCode: error.code || 'UNKNOWN'
      };
    }
  }

  /**
   * ═══════════════════════════════════════════════════════════════
   * ARQUITECTURA REFACTORIZADA: DIRECT VIDEO DELIVERY (SIN CDN)
   * ═══════════════════════════════════════════════════════════════
   * 
   * CAMBIO: La arquitectura 2-fase anterior (CDN upload + webhook)
   * ha sido reemplazada por entrega DIRECTA al webhook de Make.com.
   * 
   * NUEVA ARQUITECTURA (ACTIVA):
   * 1. Prepara batch de videos locales (SIN uploads a CDN)
   * 2. Envía cada video DIRECTAMENTE a webhook via multipart/form-data
   * 3. NO hay CDN intermedio (elimina 0x0.st, catbox, tmpfiles)
   * 
   * BENEFICIOS:
   * - Más rápido (un paso en lugar de dos)
   * - Más confiable (sin dependencias externas)
   * - Más simple (una llamada directa)
   * - Evita HTTP 503 errors de CDN inestables
   */

  /**
   * FASE 1 (REFACTORIZADA): Prepara videos para envío DIRECTO
   * 
   * YA NO SUBE A CDN. Simplemente:
   * 1. Valida que los archivos existan
   * 2. Calcula metadata
   * 3. Retorna array "listo para envío directo"
   * 
   * Mantiene compatibilidad con la interfaz de index.js.
   * 
   * @param {array} videos - Array de {videoPath, metadata}
   * @returns {Promise<array>} Array de {videoPath, metadata, status: 'ready'}
   */
  async uploadVideoBatchToCloudCDN(videos = []) {
    if (!videos || videos.length === 0) {
      this.logger.info('Batch vacío — sin videos para procesar');
      return [];
    }

    this.logger.info(`\n════════════════════════════════════════════════════════════`);
    this.logger.info(`FASE 1 (REFACTORIZADA): Preparando ${videos.length} video(s) para envío directo`);
    this.logger.info(`────────────────────────────────────────────────────────────`);
    this.logger.info(`Nota: Ya NO usa CDN intermedio (0x0.st, catbox, tmpfiles)`);
    this.logger.info(`      Envío directo a Make.com webhook en FASE 2`);
    this.logger.info(`════════════════════════════════════════════════════════════`);

    const preparedVideos = [];
    let validCount = 0;
    let invalidCount = 0;

    // ═══ VALIDACIÓN SECUENCIAL (SIN uploads) ═══
    for (let i = 0; i < videos.length; i++) {
      const video = videos[i];
      const videoNum = i + 1;

      this.logger.info(`\n[${videoNum}/${videos.length}] Validando video local...`);

      try {
        // Validar que el archivo existe
        if (!video.videoPath || !fs.existsSync(video.videoPath)) {
          throw new Error(`Video no encontrado: ${video.videoPath}`);
        }

        const fileStats = fs.statSync(video.videoPath);
        const fileSizeMB = (fileStats.size / (1024 * 1024)).toFixed(2);
        const fileName = path.basename(video.videoPath);

        this.logger.info(`  📄 Archivo: ${fileName}`);
        this.logger.info(`  📏 Tamaño: ${fileSizeMB} MB`);
        if (video.metadata && video.metadata.title) {
          this.logger.info(`  📝 Título: ${video.metadata.title}`);
        }

        // Preparar para envío directo (sin subirlo a CDN)
        preparedVideos.push({
          videoPath: video.videoPath,
          videoUrl: null,  // NO hay URL de CDN
          metadata: video.metadata || {},
          preparedAt: new Date().toISOString(),
          status: 'ready_for_direct_delivery',  // Señal para FASE 2
          fileName: fileName,
          fileSizeMB: parseFloat(fileSizeMB)
        });

        validCount++;
        this.logger.success(`  ✅ [${videoNum}] Video listo para envío directo`);

      } catch (error) {
        invalidCount++;
        this.logger.error(`  ❌ [${videoNum}] Validación falló: ${error.message}`);
        
        preparedVideos.push({
          videoPath: video.videoPath,
          videoUrl: null,
          metadata: video.metadata || {},
          preparedAt: new Date().toISOString(),
          status: 'failed',
          error: error.message,
          fileName: path.basename(video.videoPath || 'unknown')
        });
      }
    }

    // ═══ RESUMEN DE FASE 1 ═══
    this.logger.info(`\n════════════════════════════════════════════════════════════`);
    this.logger.info(`FASE 1 RESUMEN:`);
    this.logger.info(`  ✅ Listos para envío: ${validCount}/${videos.length}`);
    if (invalidCount > 0) {
      this.logger.warn(`  ❌ Inválidos: ${invalidCount}/${videos.length}`);
    }
    this.logger.info(`════════════════════════════════════════════════════════════\n`);

    return preparedVideos;
  }

  /**
   * FASE 2 (REFACTORIZADA): Envía videos DIRECTAMENTE a Make.com
   * 
   * YA NO usa URLs de CDN. En su lugar:
   * 1. Itera sobre videos "ready_for_direct_delivery"
   * 2. Para cada video, llama a sendToMakeWebhook(videoPath, metadata)
   * 3. Envía Buffer/Stream directamente via multipart/form-data
   * 
   * Mantiene compatibilidad con la interfaz de index.js.
   * 
   * @param {array} preparedVideos - Array de resultado de FASE 1
   * @returns {Promise<array>} Array de {status, webhookStatus, videoName}
   */
  async sendWebhooksForUploadedVideos(preparedVideos = []) {
    if (!preparedVideos || preparedVideos.length === 0) {
      this.logger.info('Batch vacío — sin videos para enviar a Make.com');
      return [];
    }

    // Validar webhook URL
    if (!this.webhookUrl) {
      this.logger.warn('⚠️  MAKE_WEBHOOK_URL no configurada — webhooks desactivados');
      return preparedVideos.map(v => ({
        ...v,
        webhookStatus: 'skipped',
        webhookReason: 'No webhook URL configured'
      }));
    }

    this.logger.info(`\n════════════════════════════════════════════════════════════`);
    this.logger.info(`FASE 2 (REFACTORIZADA): Enviando ${preparedVideos.length} video(s) DIRECTAMENTE a Make.com`);
    this.logger.info(`────────────────────────────────────────────────────────────`);
    this.logger.info(`Arquitectura: Direct Video Delivery (sin CDN intermedio)`);
    this.logger.info(`════════════════════════════════════════════════════════════`);

    const webhookResults = [];
    let successCount = 0;
    let failureCount = 0;
    let skippedCount = 0;

    // ═══ LOOP SECUENCIAL para webhooks (SIN concurrencia) ═══
    for (let i = 0; i < preparedVideos.length; i++) {
      const preparedVideo = preparedVideos[i];
      const videoNum = i + 1;

      this.logger.info(`\n[${videoNum}/${preparedVideos.length}] Procesando...`);

      // ═══ SALTAR videos que no pasaron validación ═══
      if (preparedVideo.status === 'failed' || !preparedVideo.videoPath) {
        this.logger.warn(`  ⏭️  Omitido (validación falló): ${preparedVideo.fileName}`);
        skippedCount++;
        webhookResults.push({
          ...preparedVideo,
          webhookStatus: 'skipped',
          webhookReason: 'Video validation failed',
          status: 'skipped'
        });
        continue;
      }

      try {
        const fileName = preparedVideo.fileName || path.basename(preparedVideo.videoPath);
        const metadata = preparedVideo.metadata || {};

        this.logger.info(`  📄 Archivo: ${fileName}`);
        this.logger.info(`  📝 Título: ${metadata.title || '(sin título)'}`);
        this.logger.info(`  🚀 Enviando DIRECTAMENTE a Make.com...`);

        // ═══ LLAMAR A sendToMakeWebhook (ENVÍO DIRECTO) ═══
        // Esta función ya maneja:
        // - FormData con multipart/form-data
        // - Content-Range headers
        // - Reintentos automáticos
        // - Errores de red
        const webhookResult = await this.sendToMakeWebhook(
          preparedVideo.videoPath,
          metadata
        );

        // ═══ PROCESAR RESULTADO DEL WEBHOOK ═══
        if (webhookResult.status === 'success') {
          successCount++;
          this.logger.success(`  ✅ [${videoNum}] Enviado exitosamente (HTTP ${webhookResult.webhookStatus})`);
          
          webhookResults.push({
            ...preparedVideo,
            webhookStatus: webhookResult.webhookStatus,
            webhookResponse: webhookResult,
            status: 'success'
          });

        } else if (webhookResult.status === 'warning') {
          this.logger.warn(`  ⚠️  [${videoNum}] Advertencia: HTTP ${webhookResult.webhookStatus}`);
          
          webhookResults.push({
            ...preparedVideo,
            webhookStatus: webhookResult.webhookStatus,
            webhookResponse: webhookResult,
            status: 'warning'
          });

        } else if (webhookResult.status === 'skipped') {
          skippedCount++;
          this.logger.info(`  ⏭️  [${videoNum}] Saltado: ${webhookResult.reason}`);
          
          webhookResults.push({
            ...preparedVideo,
            webhookStatus: 'skipped',
            webhookReason: webhookResult.reason,
            status: 'skipped'
          });

        } else {
          // Failed
          failureCount++;
          this.logger.error(`  ❌ [${videoNum}] Falló: ${webhookResult.error || 'Unknown error'}`);
          
          webhookResults.push({
            ...preparedVideo,
            webhookStatus: 'failed',
            webhookError: webhookResult.error,
            errorCode: webhookResult.errorCode,
            status: 'failed'
          });
        }

      } catch (error) {
        failureCount++;
        this.logger.error(`  ❌ [${videoNum}] Excepción: ${error.message}`);

        webhookResults.push({
          ...preparedVideo,
          webhookStatus: 'failed',
          webhookError: error.message,
          status: 'failed'
        });
      }

      // Pequeña pausa entre webhooks (reduce carga)
      if (i < preparedVideos.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    // ═══ RESUMEN DE FASE 2 ═══
    this.logger.info(`\n════════════════════════════════════════════════════════════`);
    this.logger.info(`FASE 2 RESUMEN:`);
    this.logger.info(`  ✅ Enviados exitosamente: ${successCount}`);
    if (failureCount > 0) {
      this.logger.warn(`  ❌ Fallos: ${failureCount}`);
    }
    if (skippedCount > 0) {
      this.logger.info(`  ⏭️  Omitidos: ${skippedCount}`);
    }
    this.logger.info(`════════════════════════════════════════════════════════════\n`);

    return webhookResults;
  }
}

module.exports = { WebhookDistributionAgent };
