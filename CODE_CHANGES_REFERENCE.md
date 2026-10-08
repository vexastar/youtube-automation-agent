# 💾 CÓDIGO EXACTO DE CAMBIOS

## 1. PublishingSchedulingAgent - uploadToYouTube()

**Localización:** `agents/publishing-scheduling-agent.js` línea 132

### VERSIÓN NUEVA (REEMPLAZAR LÍNEAS 132-210)

```javascript
  async uploadToYouTube(scheduleEntry) {
    const { metadata } = scheduleEntry;
    const videoPath = metadata.video.path;

    // ═══ DETECTAR TIPO DE CONTENIDO ═══
    // Si la ruta incluye '_short', es un Short vertical. Aplicar metadata optimizada.
    const isShort = videoPath.toLowerCase().includes('_short');
    
    this.logger.info(`[Publishing] Detectado: ${isShort ? 'SHORT VERTICAL' : 'VIDEO LARGO'}`);
    this.logger.info(`[Publishing] Ruta: ${videoPath}`);

    // ═══ PREPARAR METADATA ESPECÍFICA POR TIPO ═══
    const videoMetadata = isShort 
      ? this._prepareShortMetadata(scheduleEntry, metadata)
      : this._prepareLongVideoMetadata(scheduleEntry, metadata);
    
    this.logger.info(`[Publishing] ╔════════════════════════════════════════════════════════╗`);
    this.logger.info(`[Publishing] ║              METADATA PREPARADA PARA YOUTUBE            ║`);
    this.logger.info(`[Publishing] ╠════════════════════════════════════════════════════════╣`);
    this.logger.info(`[Publishing] ║ Tipo: ${isShort ? 'SHORT (9:16)' : 'VIDEO LARGO (16:9)'.padEnd(42)}║`);
    this.logger.info(`[Publishing] ║ Título: ${videoMetadata.snippet.title.substring(0, 48).padEnd(49)}║`);
    this.logger.info(`[Publishing] ║ Tags: ${videoMetadata.snippet.tags.join(', ').substring(0, 51).padEnd(52)}║`);
    this.logger.info(`[Publishing] ╚════════════════════════════════════════════════════════╝`);
    
    // ═══════════════════════════════════════════════════════════════
    // UPLOAD VIDEO: RESUMABLE UPLOAD CON REINTENTOS ROBUSTOS
    // Soluciona: read ECONNRESET errors en conexiones inestables
    // ═══════════════════════════════════════════════════════════════
    let videoUpload;
    const maxRetries = 3;
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        this.logger.info(`[YouTube] Subiendo video... [Intento ${attempt}/${maxRetries}]`);
        
        // RESUMABLE UPLOAD: Más robusto ante errores de conexión
        // Retorna estado de progreso y permite reintentos parciales
        videoUpload = await this.youtube.videos.insert(
          {
            part: 'snippet,status',
            requestBody: videoMetadata
          },
          {
            // Resumable upload configuration
            resumable: true,
            media: {
              mimeType: 'video/mp4',
              body: fsSync.createReadStream(videoPath)
            },
            // Reintentos internos de gaxios
            retryConfig: {
              maxRetries: 2,
              retryDelayMs: 1000
            },
            // Timeout aumentado para uploads grandes
            timeout: 600000  // 10 minutos
          }
        );
        
        // Success - romper el bucle de reintentos
        this.logger.success(`[YouTube] Upload exitoso en intento ${attempt}`);
        break;
        
      } catch (error) {
        lastError = error;
        const errorCode = error.code || error.message;
        const isNetworkError = errorCode.includes('ECONNRESET') || 
                              errorCode.includes('ETIMEDOUT') || 
                              errorCode.includes('ENOTFOUND') ||
                              errorCode.includes('socket hang up');
        
        this.logger.warn(`[YouTube] Intento ${attempt} falló: ${errorCode}`);
        
        if (isNetworkError && attempt < maxRetries) {
          // Error de red - reintentar con backoff exponencial
          const delayMs = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
          this.logger.info(`[YouTube] Error de red detectado. Esperando ${delayMs}ms antes de reintentar...`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
        } else if (attempt === maxRetries) {
          // Último intento - lanzar error
          throw new Error(`YouTube upload falló después de ${maxRetries} intentos: ${lastError.message}`);
        } else {
          // Error no-red (quota, permiso, etc) - no reintentar
          throw error;
        }
      }
    }
    
    const videoId = videoUpload.data.id;
    const contentType = isShort ? 'SHORT' : 'VIDEO';
    this.logger.info(`[YouTube Agent] ${contentType} subido exitosamente como NO LISTADO. Listo para revisión manual.`);
    this.logger.info(`Video ID: ${videoId}`);
    
    // ═══ UPLOAD THUMBNAIL (SOLO PARA VIDEOS LARGOS) ═══
    if (!isShort) {
      if (metadata.thumbnail && metadata.thumbnail.path) {
        try {
          this.logger.info(`[Thumbnail] Inicializando carga de miniatura...`);
          this.logger.info(`[Thumbnail] Ruta: ${metadata.thumbnail.path}`);
          await this.uploadThumbnail(videoId, metadata.thumbnail.path);
          this.logger.success(`[Thumbnail] ✅ Miniatura subida exitosamente`);
        } catch (thumbErr) {
          this.logger.warn(`[Thumbnail] ⚠️ Error al subir miniatura: ${thumbErr.message}`);
          this.logger.warn(`[Thumbnail] El video está publicado pero sin miniatura personalizada.`);
        }
      } else {
        this.logger.warn(`[Thumbnail] ⚠️ No hay miniatura disponible en metadata.thumbnail`);
        this.logger.warn(`[Thumbnail] Usando miniatura por defecto de YouTube.`);
      }
    } else {
      this.logger.info(`[Thumbnail] ⏭️  Short detectado — usando frame del video como miniatura.`);
    }
    
    // Upload captions
    if (metadata.captions && metadata.captions.path) {
      await this.uploadCaptions(videoId, metadata.captions.path);
    }
    
    return videoUpload.data;
  }
```

---

## 2. WebhookDistributionAgent - uploadVideoBatchToCloudCDN()

**Localización:** `agents/webhook-distribution-agent.js` línea ~510

### VERSIÓN NUEVA (REEMPLAZAR MÉTODO COMPLETO)

```javascript
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
```

---

## 3. WebhookDistributionAgent - sendWebhooksForUploadedVideos()

**Localización:** `agents/webhook-distribution-agent.js` línea ~670

### VERSIÓN NUEVA (REEMPLAZAR MÉTODO COMPLETO)

```javascript
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
```

---

## ✅ Validación de Cambios

Después de reemplazar el código, validar:

```bash
# Verificar sintaxis
node -c agents/publishing-scheduling-agent.js
node -c agents/webhook-distribution-agent.js

# Debería no producir output (significa OK)
```

---

## 🔍 Keywords a Buscar en Logs (Post-Deploy)

Después de ejecutar `node index.js "5 gadgets" --publish`, buscar:

### YouTube Upload (Step 8)
- `[YouTube] Subiendo video... [Intento 1/3]` ← Iniciando upload
- `[YouTube] Upload exitoso en intento 1` ← Success en primer intento
- O si hay error:
  - `[YouTube] Error de red detectado` → Reintentar
  - `[YouTube] Intento 2/3` → Segundo intento

### Webhook Distribution (Step 9D)
- `FASE 1 (REFACTORIZADA): Preparando X video(s)` ← Fase 1 iniciada
- `ready_for_direct_delivery` ← Listo para envío directo
- `FASE 2 (REFACTORIZADA): Enviando X video(s) DIRECTAMENTE` ← Fase 2 iniciada
- `Enviando DIRECTAMENTE a Make.com (sin CDN)` ← Usando direct delivery
- `HTTP 200` o `HTTP 202` ← Webhook exitoso

---

**Status:** ✅ CÓDIGO LISTO PARA USAR
