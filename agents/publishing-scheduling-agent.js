const { google } = require('googleapis');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { Logger } = require('../utils/logger');

class PublishingSchedulingAgent {
  constructor(db, credentials) {
    this.db = db;
    this.credentials = credentials;
    this.logger = new Logger('PublishingScheduling');
    this.youtube = null;
    this.publishQueue = [];
  }

  async initialize() {
    this.logger.info('Initializing Publishing & Scheduling Agent...');
    await this.setupYouTubeAPI();
    await this.loadPublishQueue();
    return true;
  }

  async setupYouTubeAPI() {
    try {
      const auth = this.credentials.getYouTubeAuth();
      this.youtube = google.youtube({ version: 'v3', auth });
      this.logger.info('YouTube API initialized');
    } catch (error) {
      this.logger.error('Failed to initialize YouTube API:', error);
      throw error;
    }
  }

  async loadPublishQueue() {
    try {
      const queue = await this.db.getPublishQueue();
      this.publishQueue = queue || [];
      this.logger.info(`Loaded ${this.publishQueue.length} items in publish queue`);
    } catch (error) {
      this.logger.warn('No existing publish queue found');
    }
  }

async scheduleContent(productionData, videoType = 'long') {
    try {
      const contentType = videoType === 'short' ? 'Shorts Verticales Múltiples' : 'Video Largo (16:9)';
      this.logger.info(`Scheduling content: ${productionData.id} [Tipo: ${contentType}]`);
      
      // ══════════════════════════════════════════════════════════
      // LÓGICA PARA EL VIDEO LARGO HORIZONTAL
      // ══════════════════════════════════════════════════════════
      if (videoType === 'long') {
        const videoPath = productionData.assets.finalVideo?.path || null;
        if (!videoPath) throw new Error('No long video available for scheduling');

        const scheduleEntry = {
          productionId: productionData.id,
          title: productionData.script.title,
          videoType: 'long',
          publishTime: new Date(productionData.scheduledPublishTime).toISOString(),
          status: 'scheduled',
          priority: productionData.priority,
          metadata: {
            seo: productionData.seo,
            script: productionData.script,
            thumbnail: productionData.assets.thumbnail,
            video: productionData.assets.finalVideo,
            captions: productionData.assets.captions
          },
          createdAt: new Date().toISOString()
        };
        
        this.publishQueue.push(scheduleEntry);
        this.publishQueue.sort((a, b) => new Date(a.publishTime) - new Date(b.publishTime));
        await this.db.saveScheduleEntry(scheduleEntry);
        
        this.logger.info(`✅ Video Largo programado para: ${scheduleEntry.publishTime}`);
        return scheduleEntry;

      // ══════════════════════════════════════════════════════════
      // LÓGICA PARA PUBLICAR TODOS LOS SHORTS VERTICALES GENERADOS
      // ══════════════════════════════════════════════════════════
      } else if (videoType === 'short') {
        const scheduledEntries = [];
        let basePublishTime = new Date(productionData.scheduledPublishTime);

        // 1. Programar el TEASER SHORT (+4 horas de diferencia para traccionar tráfico)
        if (productionData.assets.shortVideos?.teaser?.path) {
          let teaserTime = new Date(basePublishTime);
          teaserTime.setHours(teaserTime.getHours() + 4);
          
          const teaserEntry = {
            productionId: `${productionData.id}_teaser`,
            title: productionData.script.title,
            videoType: 'short',
            publishTime: teaserTime.toISOString(),
            status: 'scheduled',
            priority: productionData.priority,
            metadata: {
              seo: productionData.seo,
              script: productionData.script,
              thumbnail: null,
              video: productionData.assets.shortVideos.teaser,
              captions: productionData.assets.captions
            },
            createdAt: new Date().toISOString()
          };
          
          this.publishQueue.push(teaserEntry);
          await this.db.saveScheduleEntry(teaserEntry);
          scheduledEntries.push(teaserEntry);
          this.logger.info(`✅ Teaser Short programado para: ${teaserEntry.publishTime}`);
        }

        // 2. Programar el INTRO SHORT (+8 horas de diferencia para un segundo pico de alcance)
        if (productionData.assets.shortVideos?.intro?.path) {
          let introTime = new Date(basePublishTime);
          introTime.setHours(introTime.getHours() + 8);
          
          const introEntry = {
            productionId: `${productionData.id}_intro`,
            title: productionData.script.title,
            videoType: 'short',
            publishTime: introTime.toISOString(),
            status: 'scheduled',
            priority: productionData.priority,
            metadata: {
              seo: productionData.seo,
              script: productionData.script,
              thumbnail: null,
              video: productionData.assets.shortVideos.intro,
              captions: productionData.assets.captions
            },
            createdAt: new Date().toISOString()
          };
          
          this.publishQueue.push(introEntry);
          await this.db.saveScheduleEntry(introEntry);
          scheduledEntries.push(introEntry);
          this.logger.info(`✅ Intro Short programado para: ${introEntry.publishTime}`);
        }

        if (scheduledEntries.length === 0) {
          throw new Error('No short videos available for scheduling');
        }

        this.publishQueue.sort((a, b) => new Date(a.publishTime) - new Date(b.publishTime));
        // Retornamos el array completo de lo que se programó
        return scheduledEntries; 
      }
    } catch (error) {
      this.logger.error('Failed to schedule content:', error);
      throw error;
    }
  }

  async publishContent(contentId) {
    try {
      this.logger.info(`Publishing content requested for: ${contentId}`);
      
      // Buscar todas las entradas en la cola que coincidan con el ID base o sus variantes (teaser/intro)
      const entriesToPublish = this.publishQueue.filter(entry => 
        entry.productionId === contentId || 
        entry.id === contentId ||
        entry.productionId === `${contentId}_teaser` ||
        entry.productionId === `${contentId}_intro`
      );
      
      if (entriesToPublish.length === 0) {
        throw new Error(`Content not found in queue: ${contentId}`);
      }
      
      const results = [];
      
      // Procesar y publicar cada video encontrado secuencialmente
      for (const scheduleEntry of entriesToPublish) {
        this.logger.info(`[Publishing] Subiendo a YouTube la entrada: ${scheduleEntry.productionId}`);
        
        // Upload video to YouTube (Aplica estado "No Listado" por defecto)
        const uploadResult = await this.uploadToYouTube(scheduleEntry);
        
        // Update database
        scheduleEntry.status = 'published';
        scheduleEntry.publishedAt = new Date().toISOString();
        scheduleEntry.youtubeId = uploadResult.id;
        scheduleEntry.youtubeUrl = `https://www.youtube.com/watch?v=${uploadResult.id}`;
        
        await this.db.updateScheduleEntry(scheduleEntry);
        
        // Remove exactly this entry from queue
        this.publishQueue = this.publishQueue.filter(entry => entry.productionId !== scheduleEntry.productionId);
        
        this.logger.success(`Content published: ${scheduleEntry.youtubeUrl}`);
        results.push(scheduleEntry);
      }
      
      // Retornar objeto si es uno solo (compatibilidad) o array si son múltiples
      return results.length === 1 ? results[0] : results;
      
    } catch (error) {
      this.logger.error('Failed to publish content:', error);
      throw error;
    }
  }

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
    
// ═══ MOTOR DE SUBIDA REANUDABLE ANTI-CORTES ═══
    const videoUpload = await this._robustChunkedUpload(videoPath, videoMetadata, isShort ? '[Short]' : '[Video]');
    
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

  /**
   * Prepara metadata optimizada para YouTube Shorts (9:16 vertical).
   * Sigue las mejores prácticas del algoritmo vertical: titulo con #Shorts,
   * descripción MINIMALISTA con enlace afiliado en línea 3-4 para máxima visibilidad móvil,
   * tags para búsqueda vertical.
   * 
   * ESTRUCTURA DE DESCRIPCIÓN (Móvil-Optimizada):
   * Línea 1: [Primera oración del gancho]
   * Línea 2: 👇 Consíguelo aquí:
   * Línea 3: [Enlace de Afiliado] ← Visible en preview
   * Línea 4: [Hashtags]
   */
  _prepareShortMetadata(scheduleEntry, metadata) {
    const baseTitle = metadata.seo.title || scheduleEntry.title;
    
    // ═══ TÍTULO DE ALTO IMPACTO: Generar dinámicamente ═══
    // Usa la función helper para plantillas de CTR optimizado
    let shortsTitle = this._generateImpactShortTitle(baseTitle);
    
    // Asegurar que no excede 100 caracteres (YouTube max)
    if (shortsTitle.length > 100) {
      shortsTitle = shortsTitle.substring(0, 97) + '...';
    }

    // ═══ DESCRIPCIÓN OPTIMIZADA: Enlace afiliado + Link al video principal ═══
    // Estructura compacta: [Primera oración] → [CTA] → [Enlace] → [Promo Video] → [Hashtags]
    // CRÍTICO: El enlace afiliado debe aparecer en líneas 2-3 para máxima visibilidad en móviles
    let shortsDescription = '';
    
    // ═══ EXTRAER PRIMERA ORACIÓN (hasta el primer punto) ═══
    const fullDescription = metadata.seo.description || '';
    let firstSentence = 'Descubre este increíble gadget';
    
    if (fullDescription && fullDescription.length > 0) {
      const firstPeriod = fullDescription.indexOf('.');
      if (firstPeriod !== -1) {
        firstSentence = fullDescription.substring(0, firstPeriod + 1).trim();
      } else {
        if (fullDescription.length <= 80) {
          firstSentence = fullDescription.trim();
        } else {
          const words = fullDescription.split(/\s+/);
          firstSentence = words.slice(0, Math.min(3, words.length)).join(' ').trim();
          if (!firstSentence.endsWith('.')) {
            firstSentence += '.';
          }
        }
      }
    }
    
    // Línea 1: Hook/Primera oración
    shortsDescription += `${firstSentence}\n`;
    
    // Línea 2: Call-to-action con emoji
    shortsDescription += `👇 Consíguelo en Amazon:\n`;
    
    // Línea 3: Enlace afiliado (PRIORITARIO - visible inmediatamente en móviles)
    if (metadata.seo.affiliateLink) {
      shortsDescription += `${metadata.seo.affiliateLink}\n`;
    } else {
      shortsDescription += `https://amazon.com\n`;
    }
    
    // Línea 4: Enlace al video principal
    shortsDescription += `\n🎬 Ver análisis COMPLETO en nuestro video principal\n`;
    shortsDescription += `📺 Suscríbete para más gadgets tech\n`;
    
    // Línea 5: Hashtags para SEO vertical
    shortsDescription += `\n#Shorts #techfinds #amazonfinds #gadgets #technologia #amazonfavorites`;

    // ═══ TAGS (ETIQUETAS): Optimizadas para Shorts ═══
    const shortsTags = [
      'Shorts',
      'amazon finds',
      'tech gadgets',
      'mejores gadgets',
      'tecnologia',
      'gadgets amazon',
      'tech review'
    ]
      .filter(tag => tag && typeof tag === 'string' && tag.trim().length > 0)
      .map(tag => String(tag).substring(0, 30))
      .slice(0, 500);

    return {
      snippet: {
        title: shortsTitle,
        description: shortsDescription,
        tags: shortsTags,
        categoryId: String(metadata.seo?.metadata?.category || '28'),
        defaultLanguage: 'es'
      },
      status: {
        privacyStatus: process.env.DEFAULT_PRIVACY_STATUS || 'unlisted',
        selfDeclaredMadeForKids: false,
        embeddable: true,
        license: 'creativeCommon',
        publicStatsViewable: true
      }
    };
  }

  /**
   * Genera títulos de impacto ultra-cortos para Shorts (<60 caracteres).
   * Formato: "El MEJOR [Producto] 😱 #shorts #tech"
   * Estos títulos optimizan CTR en formato vertical.
   * 
   * @private
   */
  _generateImpactShortTitle(baseTitle) {
    // Eliminar prefijos comunes como "Top X", "Mejor", etc.
    let cleanTitle = baseTitle
      .replace(/^Top\s+\d+\s*[:\-]?\s*/i, '')
      .replace(/^Mejor\s+/i, '')
      .replace(/^Los\s+/i, '')
      .trim();
    
    // Si es muy largo, acortar
    if (cleanTitle.length > 30) {
      cleanTitle = cleanTitle.substring(0, 27) + '...';
    }
    
    // Elegir emoji de impacto aleatorio
    const impactEmojis = ['😱', '🤯', '🔥', '⚡', '💎', '🚀', '🎯', '✨'];
    const randomEmoji = impactEmojis[Math.floor(Math.random() * impactEmojis.length)];
    
    // Plantillas variadas para impacto
    const templates = [
      `${cleanTitle} ${randomEmoji} #shorts`,
      `El MEJOR ${cleanTitle} ${randomEmoji}`,
      `IMPRESCINDIBLE: ${cleanTitle} ${randomEmoji}`,
      `${cleanTitle} te SORPRENDERÁ ${randomEmoji}`,
      `¿Ya conoces el ${cleanTitle}? ${randomEmoji}`
    ];
    
    // Seleccionar plantilla aleatoria
    const selectedTemplate = templates[Math.floor(Math.random() * templates.length)];
    
    return selectedTemplate;
  }

  /**
   * Prepara metadata estándar para videos largos (16:9 horizontal).
   * Estructura tradicional: título, descripción expandida, tags variados.
   */
  _prepareLongVideoMetadata(scheduleEntry, metadata) {
    // Validar campos requeridos
    const title = String(metadata.seo?.title || scheduleEntry?.title || 'Nuevo Video').substring(0, 100);
    const description = String(metadata.seo?.description || 'Descubrimiento de gadgets increíbles').substring(0, 5000);
    const categoryId = String(metadata.seo?.metadata?.category || '28'); // 28 = Science & Technology
    
    // Tags: validar que todos sean strings válidos
    const tags = (Array.isArray(metadata.seo?.tags) ? metadata.seo.tags : ['tech', 'gadgets', 'amazon'])
      .filter(tag => tag && typeof tag === 'string' && tag.trim().length > 0)
      .map(tag => String(tag).substring(0, 30))  // Max 30 caracteres por tag
      .slice(0, 500);  // Max 500 tags

    return {
      snippet: {
        title: title,
        description: description,
        tags: tags,
        categoryId: categoryId,
        defaultLanguage: 'es'
      },
      status: {
        privacyStatus: process.env.DEFAULT_PRIVACY_STATUS || 'unlisted',
        selfDeclaredMadeForKids: false,
        embeddable: true,
        license: 'creativeCommon',
        publicStatsViewable: true
      }
    };
  }

  /**
   * Genera un título dinámico con plantillas de alto CTR.
   * Ejemplos: 
   * - "[X] Gadgets de Amazon que NO Sabías que Necesitabas 🤯"
   * - "[X] Gadgets Tecnológicos que Cambiarán tu Setup ⚡"
   * 
   * @private
   */
  _generateDynamicTitle(baseTitle, seo) {
    // Extraer número del título si existe (ej: "Top 5" → 5)
    const numberMatch = baseTitle.match(/\b(Top|top|TOP)\s+(\d+)/i);
    const topNumber = numberMatch ? numberMatch[2] : '';
    
    // Plantillas de alto CTR disponibles
    const templates = [
      `[${topNumber}] Gadgets de Amazon que NO Sabías que Necesitabas 🤯`,
      `[${topNumber}] Gadgets Tecnológicos que Cambiarán tu Setup ⚡`,
      `[${topNumber}] Productos Secretos de Amazon que DEBES Probar 🔥`,
      `[${topNumber}] Los Mejores Gadgets Tech de Amazon 💎`,
      `[${topNumber}] Gadgets Amazon que Hacen Puro DAÑO 🚀`,
      `[${topNumber}] Descubrimientos Increíbles en Amazon 🎯`,
      `[${topNumber}] Gadgets Tech Que TODO MUNDO Debería Tener 😱`,
      `[${topNumber}] Los Gadgets Más Buscados de Amazon Este Año ⭐`
    ];
    
    // Seleccionar una plantilla aleatoria (o basada en hash del contenido)
    const contentHash = baseTitle.split('').reduce((a, b) => {
      a = ((a << 5) - a) + b.charCodeAt(0);
      return a & a;
    }, 0);
    const selectedTemplate = templates[Math.abs(contentHash) % templates.length];
    
    // Limitar a 100 caracteres (máximo de YouTube)
    const finalTitle = selectedTemplate.length > 100 
      ? selectedTemplate.substring(0, 97) + '...'
      : selectedTemplate;
    
    return finalTitle;
  }

  /**
   * Genera capítulos automáticos basados en duración de cada clip.
   * Retorna array de { timestamp: "MM:SS", title: "Nombre del Producto" }
   * 
   * @private
   */
  _generateChapters(script) {
    const chapters = [];
    
    // Siempre empezar con Intro
    chapters.push({
      timestamp: '00:00',
      title: 'Intro'
    });
    
    if (!script || !script.mainContent || !script.mainContent.sections) {
      return chapters;
    }
    
    const sections = script.mainContent.sections;
    const INTRO_DURATION = 30;  // Intro es ~30 segundos
    let currentTime = INTRO_DURATION;  // Comenzar después del intro
    
    // Iterar sobre cada sección/producto
    sections.forEach((section, idx) => {
      const productName = section.productName || section.title || `Producto ${idx + 1}`;
      
      // Usar videoDuration del script o fallback a duración estándar
      const clipDuration = section.videoDuration || 30;  // En segundos
      
      // Convertir tiempo actual (segundos) a formato MM:SS
      const minutes = Math.floor(currentTime / 60);
      const seconds = Math.floor(currentTime % 60);
      const timestamp = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
      
      chapters.push({
        timestamp: timestamp,
        title: productName
      });
      
      // Sumar duración del clip para el siguiente capítulo
      currentTime += clipDuration;
    });
    
    return chapters;
  }

  /**
   * Construye la descripción del video incluyendo capítulos y enlaces.
   * Formato:
   * - Descripción original
   * - [Capítulos automáticos]
   * - [Enlaces de afiliado]
   * - [Hashtags]
   * 
   * @private
   */
  _buildDescriptionWithChapters(originalDescription, chapters, affiliateLink) {
    let description = originalDescription || 'Descubre los mejores gadgets de Amazon.';
    
    // Agregar separador visual
    description += '\n\n' + '═'.repeat(50) + '\n';
    description += '📌 CAPÍTULOS DEL VIDEO\n';
    description += '═'.repeat(50) + '\n';
    
    // Agregar cada capítulo con timestamp
    chapters.forEach(chapter => {
      description += `${chapter.timestamp} - ${chapter.title}\n`;
    });
    
    // Agregar sección de enlaces
    description += '\n' + '═'.repeat(50) + '\n';
    description += '🔗 ENLACES Y RECURSOS\n';
    description += '═'.repeat(50) + '\n';
    
    if (affiliateLink) {
      description += `Todos los enlaces de compra:\n${affiliateLink}\n\n`;
    }
    
    // Agregar CTA para suscripción
    description += `👉 Suscríbete para más gadgets tech\n`;
    description += `👉 Visita nuestro canal de TikTok/Instagram para versiones cortas\n\n`;
    
    // Agregar hashtags de SEO
    description += '#gadgets #amazon #amazonfinds #tech #technologia #gadgetstecnologicos #productostech #recomendaciones #viral';
    
    return description;
  }

  async getVideoStream(videoPath) {
    // In a real implementation, this would return a file stream
    // For now, we'll simulate it
    return JSON.stringify({
      message: 'Video stream would be provided here',
      path: videoPath,
      timestamp: new Date().toISOString()
    });
  }

  async uploadThumbnail(videoId, thumbnailPath) {
    try {
      // ═══ VALIDAR QUE EXISTE EL ARCHIVO ═══
      const exists = fsSync.existsSync(thumbnailPath);
      if (!exists) {
        throw new Error(`Thumbnail file not found at: ${thumbnailPath}`);
      }
      
      const stats = fsSync.statSync(thumbnailPath);
      if (stats.size === 0) {
        throw new Error(`Thumbnail file is empty: ${thumbnailPath}`);
      }
      
      this.logger.info(`[Thumbnail] Leyendo archivo: ${thumbnailPath} (${(stats.size / 1024).toFixed(2)} KB)`);
      
      const thumbnailBuffer = await fs.readFile(thumbnailPath);
      
      this.logger.info(`[Thumbnail] Subiendo miniatura a YouTube para video ID: ${videoId}...`);
      
      await this.youtube.thumbnails.set({
        videoId: videoId,
        media: {
          body: thumbnailBuffer
        }
      });
      
      this.logger.info(`[Thumbnail] ✅ Thumbnail uploaded for video: ${videoId}`);
    } catch (error) {
      this.logger.error(`[Thumbnail] ❌ Failed to upload thumbnail: ${error.message}`);
      throw error; // Re-throw para que el caller sepa que falló
    }
  }

  async uploadCaptions(videoId, captionsPath) {
    try {
      const captionsContent = await fs.readFile(captionsPath, 'utf8');
      
      await this.youtube.captions.insert({
        part: 'snippet',
        requestBody: {
          snippet: {
            videoId: videoId,
            language: 'en',
            name: 'English Captions',
            isDraft: false
          }
        },
        media: {
          body: captionsContent
        }
      });
      
      this.logger.info(`Captions uploaded for video: ${videoId}`);
    } catch (error) {
      this.logger.error(`Failed to upload captions: ${error.message}`);
    }
  }

  async processPublishQueue() {
    this.logger.info('Processing publish queue...');
    
    const now = new Date();
    const readyToPublish = this.publishQueue.filter(entry => {
      const publishTime = new Date(entry.publishTime);
      return publishTime <= now && entry.status === 'scheduled';
    });
    
    for (const entry of readyToPublish) {
      try {
        await this.publishContent(entry.productionId);
        this.logger.info(`Auto-published: ${entry.title}`);
      } catch (error) {
        this.logger.error(`Failed to auto-publish ${entry.title}:`, error);
        // Mark as failed but don't stop processing other items
        entry.status = 'failed';
        entry.error = error.message;
        await this.db.updateScheduleEntry(entry);
      }
    }
    
    return readyToPublish.length;
  }

  async getUpcomingSchedule(days = 7) {
    const now = new Date();
    const endDate = new Date(now.getTime() + (days * 24 * 60 * 60 * 1000));
    
    return this.publishQueue
      .filter(entry => {
        const publishTime = new Date(entry.publishTime);
        return publishTime >= now && publishTime <= endDate;
      })
      .sort((a, b) => new Date(a.publishTime) - new Date(b.publishTime));
  }

  async optimizePublishTimes() {
    // Analyze channel analytics to find optimal publish times
    const analytics = await this.getChannelAnalytics();
    const optimalTimes = this.calculateOptimalTimes(analytics);
    
    // Update scheduled content with better times
    for (const entry of this.publishQueue) {
      if (entry.status === 'scheduled') {
        const currentTime = new Date(entry.publishTime);
        const betterTime = this.findBetterTime(currentTime, optimalTimes);
        
        if (betterTime && betterTime.getTime() !== currentTime.getTime()) {
          entry.publishTime = betterTime.toISOString();
          await this.db.updateScheduleEntry(entry);
          this.logger.info(`Optimized publish time for: ${entry.title}`);
        }
      }
    }
  }

  async getChannelAnalytics() {
    try {
      // Get channel analytics for the last 30 days
      const endDate = new Date();
      const startDate = new Date(endDate.getTime() - (30 * 24 * 60 * 60 * 1000));
      
      const response = await this.youtube.channels.list({
        part: 'statistics',
        mine: true
      });
      
      // In a full implementation, you'd use YouTube Analytics API
      // For now, we'll return simulated data
      return {
        totalViews: response.data.items[0]?.statistics?.viewCount || 0,
        subscribers: response.data.items[0]?.statistics?.subscriberCount || 0,
        videos: response.data.items[0]?.statistics?.videoCount || 0,
        optimalDays: ['Tuesday', 'Wednesday', 'Thursday'], // Most active days
        optimalHours: [14, 15, 16, 20] // Most active hours
      };
    } catch (error) {
      this.logger.error('Failed to get channel analytics:', error);
      return {
        optimalDays: ['Tuesday', 'Wednesday', 'Thursday'],
        optimalHours: [14, 15, 16]
      };
    }
  }

  calculateOptimalTimes(analytics) {
    const { optimalDays, optimalHours } = analytics;
    
    return {
      bestDays: optimalDays,
      bestHours: optimalHours,
      worstDays: ['Monday', 'Friday'],
      worstHours: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 22, 23]
    };
  }

  findBetterTime(currentTime, optimalTimes) {
    const currentDay = currentTime.toLocaleDateString('en-US', { weekday: 'long' });
    const currentHour = currentTime.getHours();
    
    // If current time is already optimal, return null
    if (optimalTimes.bestDays.includes(currentDay) && 
        optimalTimes.bestHours.includes(currentHour)) {
      return null;
    }
    
    // Find the next optimal time
    const nextOptimalTime = new Date(currentTime);
    
    // Try to find an optimal hour on the same day
    for (const hour of optimalTimes.bestHours) {
      if (hour > currentHour) {
        nextOptimalTime.setHours(hour, 0, 0, 0);
        if (optimalTimes.bestDays.includes(currentDay)) {
          return nextOptimalTime;
        }
      }
    }
    
    // Find next optimal day
    for (let i = 1; i <= 7; i++) {
      const testDate = new Date(currentTime.getTime() + (i * 24 * 60 * 60 * 1000));
      const testDay = testDate.toLocaleDateString('en-US', { weekday: 'long' });
      
      if (optimalTimes.bestDays.includes(testDay)) {
        testDate.setHours(optimalTimes.bestHours[0], 0, 0, 0);
        return testDate;
      }
    }
    
    return null; // No better time found
  }

  async createPublishingReport() {
    const report = {
      queueStatus: {
        total: this.publishQueue.length,
        scheduled: this.publishQueue.filter(e => e.status === 'scheduled').length,
        published: this.publishQueue.filter(e => e.status === 'published').length,
        failed: this.publishQueue.filter(e => e.status === 'failed').length
      },
      upcomingPublications: await this.getUpcomingSchedule(7),
      recentPublications: this.publishQueue
        .filter(e => e.status === 'published' && 
                new Date(e.publishedAt) > new Date(Date.now() - 7 * 24 * 60 * 60 * 1000))
        .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt)),
      performance: await this.getPublishingPerformance(),
      generatedAt: new Date().toISOString()
    };
    
    return report;
  }

  async getPublishingPerformance() {
    const published = this.publishQueue.filter(e => e.status === 'published');
    
    if (published.length === 0) {
      return {
        totalPublished: 0,
        averageScheduleAccuracy: 0,
        publishingFrequency: 0
      };
    }
    
    // Calculate schedule accuracy
    let totalDelay = 0;
    let accuratePublishes = 0;
    
    published.forEach(entry => {
      const scheduledTime = new Date(entry.publishTime);
      const actualTime = new Date(entry.publishedAt);
      const delay = Math.abs(actualTime - scheduledTime) / (1000 * 60); // minutes
      
      totalDelay += delay;
      if (delay <= 5) accuratePublishes++; // Within 5 minutes is considered accurate
    });
    
    const averageDelay = totalDelay / published.length;
    const accuracyRate = (accuratePublishes / published.length) * 100;
    
    return {
      totalPublished: published.length,
      averageScheduleAccuracy: `${accuracyRate.toFixed(1)}%`,
      averageDelay: `${averageDelay.toFixed(1)} minutes`,
      publishingFrequency: this.calculatePublishingFrequency(published)
    };
  }

  calculatePublishingFrequency(published) {
    if (published.length < 2) return 'Insufficient data';
    
    const dates = published.map(p => new Date(p.publishedAt)).sort((a, b) => a - b);
    const totalDays = (dates[dates.length - 1] - dates[0]) / (1000 * 60 * 60 * 24);
    const frequency = published.length / totalDays;
    
    if (frequency >= 1) return `${frequency.toFixed(1)} videos per day`;
    if (frequency >= 0.14) return `${(frequency * 7).toFixed(1)} videos per week`;
    return `${(frequency * 30).toFixed(1)} videos per month`;
  }

  async emergencyPublish(contentId, delayMinutes = 0) {
    // For urgent publishing needs
    this.logger.info(`Emergency publish requested: ${contentId}`);
    
    const entry = this.publishQueue.find(e => 
      e.productionId === contentId || e.id === contentId
    );
    
    if (!entry) {
      throw new Error(`Content not found: ${contentId}`);
    }
    
    if (delayMinutes > 0) {
      const newPublishTime = new Date(Date.now() + (delayMinutes * 60 * 1000));
      entry.publishTime = newPublishTime.toISOString();
      await this.db.updateScheduleEntry(entry);
      this.logger.info(`Emergency scheduled for: ${entry.publishTime}`);
      return entry;
    } else {
      return await this.publishContent(contentId);
    }
  }

  async pauseScheduledContent(contentId) {
    const entry = this.publishQueue.find(e => 
      e.productionId === contentId || e.id === contentId
    );
    
    if (!entry) {
      throw new Error(`Content not found: ${contentId}`);
    }
    
    entry.status = 'paused';
    await this.db.updateScheduleEntry(entry);
    
    this.logger.info(`Content paused: ${entry.title}`);
    return entry;
  }

  async resumeScheduledContent(contentId, newPublishTime = null) {
    const entry = this.publishQueue.find(e => 
      e.productionId === contentId || e.id === contentId
    );
    
    if (!entry) {
      throw new Error(`Content not found: ${contentId}`);
    }
    
    entry.status = 'scheduled';
    if (newPublishTime) {
      entry.publishTime = new Date(newPublishTime).toISOString();
    }
    
    await this.db.updateScheduleEntry(entry);
    
    this.logger.info(`Content resumed: ${entry.title}`);
    return entry;
  }

  /**
   * Publica un SHORT individual de producto directamente a YouTube como "Unlisted"
   * para revisión manual sin publicación automática.
   * 
   * @param {Object} productShortData - { productId, productName, path, ... }
   * @param {Object} generalMetadata - { seo, captions, ... } del contenido general
   * @returns {Promise<Object>} Resultado de la subida (videoId, webUrl, etc)
   */
/**
   * Publica un SHORT individual de producto directamente a YouTube como "Unlisted"
   * para revisión manual sin publicación automática.
   */
  async publishProductShort(productShortData, generalMetadata = {}) {
    try {
      const { productId, productName, path: videoPath } = productShortData;
      
      if (!videoPath || !fsSync.existsSync(videoPath)) {
        throw new Error(`Product short video not found: ${videoPath}`);
      }
      
      this.logger.info(`[ProductShort] Subiendo: "${productName}" (${productId})`);
      this.logger.info(`[ProductShort] Ruta: ${videoPath}`);
      
      // ═══ GENERAR METADATA ESPECÍFICA PARA PRODUCT SHORTMETADATA ═══
      const metadata = this._prepareProductShortMetadata(
        productName,
        generalMetadata
      );
      
// ═══ SUBIR VIDEO A YOUTUBE (SHORTS) CON REINTENTOS ═══
      this.logger.info(`[ProductShort] Iniciando carga en YouTube...`);
      
      const videoUpload = await this._robustChunkedUpload(videoPath, metadata, '[ProductShort]');
      
      const videoId = videoUpload.data.id;
      const webUrl = `https://www.youtube.com/watch?v=${videoId}`;
      
      this.logger.success(`[ProductShort] ✅ "${productName}" publicado como UNLISTED`);
      this.logger.info(`[ProductShort] Video ID: ${videoId}`);
      this.logger.info(`[ProductShort] URL: ${webUrl}`);
      
      return {
        videoId,
        webUrl,
        productId,
        productName,
        uploadedAt: new Date().toISOString()
      };
      
    } catch (error) {
      // Detallar el tipo de error para debugging
      const errorMessage = error.response?.data?.error?.message || error.message;
      const errorCode = error.response?.data?.error?.code || 'UNKNOWN';
      
      this.logger.error(`[ProductShort] ❌ Error: ${errorCode}`);
      this.logger.error(`[ProductShort] Detalle: ${errorMessage}`);
      
      throw {
        productId: productShortData.productId,
        productName: productShortData.productName,
        errorCode,
        errorMessage,
        originalError: error
      };
    }
  }
    
  /**
   * Prepara metadata optimizada para Product Shorts (9:16 vertical, sin lista).
   * Estructura:
   * - Título: "{Nombre del Producto} #shorts #tecnologia"
   * - Descripción: Breve + CTA + Hashtags
   * - privacyStatus: process.env.DEFAULT_PRIVACY_STATUS
   * - Tags: Para búsqueda dentro de YouTube
   * 
   * @private
   */
/**
   * Prepara metadata optimizada para Product Shorts (9:16 vertical, sin lista).
   */
  _prepareProductShortMetadata(productName, generalMetadata = {}) {
    // ═══ TÍTULO ULTRA-CORTO: Máximo 60 caracteres para impacto ═══
    let productDisplayName = productName;
    if (productDisplayName.length > 30) {
      productDisplayName = productDisplayName.substring(0, 27) + '...';
    }
    
    // Elegir emoji aleatorio de impacto
    const impactEmojis = ['😱', '🤯', '🔥', '⚡', '💎', '🚀'];
    const randomEmoji = impactEmojis[Math.floor(Math.random() * impactEmojis.length)];
    
    const title = `El MEJOR ${productDisplayName} ${randomEmoji} #shorts #tech`;
    
    // Asegurar que no exceda 100 caracteres
    const finalTitle = title.length > 100 ? title.substring(0, 97) + '...' : title;
    
    // ═══ DESCRIPCIÓN: Estructura móvil-first ═══
    const description = 
      `✨ Descubre por qué todos quieren este producto.\n` +
      `\n` +
      `👇 Consíguelo en Amazon:\n` +
      `${generalMetadata.affiliateUrl || 'https://amazon.com'}\n` +
      `\n` +
      `🎬 Ver análisis completo en el video principal (link en bio)\n` +
      `\n` +
      `#shorts #gadgets #amazon #tecnologia #techfinds`;
    
    // ═══ TAGS: Optimizados para descubrimiento vertical ═══
    const tags = [
      'shorts', 'gadgets', 'tecnologia', 'tech', 'amazon', 'amazonfinds', 'techfinds', 'review'
    ];
    
    return {
      snippet: {
        title: finalTitle,
        description: description,
        tags: tags,
        categoryId: generalMetadata.categoryId || '28',
        defaultLanguage: generalMetadata.language || 'es',
        defaultAudioLanguage: generalMetadata.language || 'es'
      },
      status: {
      privacyStatus: process.env.DEFAULT_PRIVACY_STATUS || 'unlisted',
        selfDeclaredMadeForKids: false
      }
    };
  }

// ═══ MOTOR DE SUBIDA REANUDABLE ANTI-CORTES (VERSIÓN DEFINITIVA) ═══
  async _robustChunkedUpload(videoPath, metadata, logPrefix) {
    const fileSize = fsSync.statSync(videoPath).size;
    this.logger.info(`${logPrefix} Iniciando subida fragmentada. Tamaño real: ${(fileSize / (1024 * 1024)).toFixed(2)} MB`);

    const auth = this.credentials.getYouTubeAuth();
    const tokenObj = await auth.getAccessToken();
    const token = typeof tokenObj === 'string' ? tokenObj : tokenObj.token;
    
    const axios = require('axios');
    const https = require('https');

    // APAGAMOS keepAlive: Fuerza a Node.js a crear una conexión fresca cada vez.
    // Esto evita los ECONNRESET causados por routers que matan sockets inactivos.
    const httpsAgent = new https.Agent({
      keepAlive: false 
    });

    const axiosClient = axios.create({
      httpsAgent: httpsAgent,
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });

    // 1. ABRIR SESIÓN ÚNICA EN YOUTUBE
    let uploadUrl;
    let sessionAttempt = 1;
    while (!uploadUrl && sessionAttempt <= 3) {
      try {
        const initRes = await axiosClient.post(
          'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
          metadata,
          {
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json',
              'X-Upload-Content-Length': fileSize.toString(),
              'X-Upload-Content-Type': 'video/mp4',
              'Connection': 'close' // Instruye al router a cerrar limpio
            },
            timeout: 60000 
          }
        );
        uploadUrl = initRes.headers.location;
      } catch (err) {
        this.logger.warn(`${logPrefix} Fallo inicio de sesión (Intento ${sessionAttempt}/3): ${err.message}`);
        sessionAttempt++;
        if (sessionAttempt > 3) {
          throw new Error(`Fallo al solicitar espacio en YouTube: ${err.response?.data?.error?.message || err.message}`);
        }
        await new Promise(r => setTimeout(r, 10000)); 
      }
    }
    
    // 2. CORTAR Y EMPUJAR
    const minChunk = 262144; // Mínimo absoluto de Google (256 KB)
    // Reducimos el tamaño por defecto si no hay variable .env para evadir bloqueos rápidos
    const envChunk = process.env.YOUTUBE_CHUNK_SIZE_MB ? parseFloat(process.env.YOUTUBE_CHUNK_SIZE_MB) : 0.5; 
    const targetSize = envChunk * 1024 * 1024;
    const chunkSize = Math.max(minChunk, Math.floor(targetSize / minChunk) * minChunk);
    
    const fd = fsSync.openSync(videoPath, 'r');
    let uploadedBytes = 0;
    let videoData = null;

    try {
      while (uploadedBytes < fileSize) {
        const end = Math.min(uploadedBytes + chunkSize, fileSize);
        const chunkLength = end - uploadedBytes;
        const buffer = Buffer.alloc(chunkLength);
        fsSync.readSync(fd, buffer, 0, chunkLength, uploadedBytes);

        let chunkAttempt = 1;
        let success = false;

        while (!success && chunkAttempt <= 5) {
          try {
            this.logger.info(`${logPrefix} Subiendo paquete ${((end/fileSize)*100).toFixed(0)}% (Intento interno ${chunkAttempt}/5)...`);
            
            const chunkRes = await axiosClient.put(uploadUrl, buffer, {
              headers: {
                'Content-Length': chunkLength.toString(),
                'Content-Range': `bytes ${uploadedBytes}-${end - 1}/${fileSize}`,
                'Content-Type': 'video/mp4',
                'Connection': 'close'
              },
              timeout: 120000,
              validateStatus: (status) => status === 308 || status === 200 || status === 201
            });

            if (chunkRes.status === 308) {
              success = true;
            } else if (chunkRes.status === 200 || chunkRes.status === 201) {
              success = true;
              videoData = chunkRes.data;
            }
          } catch (err) {
            const errorMsg = err.response?.data?.error?.message || err.message || 'Error de socket local';
            this.logger.warn(`${logPrefix} Corte de red detectado: ${errorMsg}.`);
            
            // 3. RECUPERACIÓN INTELIGENTE (CORREGIDA)
            try {
              this.logger.info(`${logPrefix} Sincronizando estado con YouTube tras el corte...`);
              
              // CRÍTICO: Se pasa un string vacío '' y se declara Content-Length: 0 explícitamente
              const statusRes = await axiosClient.put(uploadUrl, '', {
                headers: {
                  'Content-Range': `bytes */${fileSize}`,
                  'Content-Length': '0',
                  'Connection': 'close'
                },
                timeout: 30000,
                validateStatus: (status) => status === 308 || status === 200 || status === 201
              });

              if (statusRes.status === 308 && statusRes.headers.range) {
                const rangeMatch = statusRes.headers.range.match(/bytes=0-(\d+)/);
                if (rangeMatch && rangeMatch[1]) {
                  const serverBytes = parseInt(rangeMatch[1], 10) + 1;
                  // Si el servidor guardó la misma cantidad o más de bytes, ajustamos y avanzamos
                  if (serverBytes >= uploadedBytes) {
                    uploadedBytes = serverBytes;
                    this.logger.info(`${logPrefix} Sincronización exitosa. Reanudando desde byte ${serverBytes}...`);
                    break; // Rompe el loop de reintentos actual para recalcular el siguiente chunk
                  }
                }
              }
            } catch (syncErr) {
              const syncMsg = syncErr.response?.data?.error?.message || syncErr.message || 'Sin respuesta del servidor';
              this.logger.warn(`${logPrefix} Fallo al sincronizar estado: ${syncMsg}`);
            }

            chunkAttempt++;
            if (chunkAttempt > 5) throw new Error(`Conexión perdida definitivamente tras 5 intentos.`);
            // Aumentamos el tiempo de espera a 15s para dar tiempo al router de liberar puertos atascados
            await new Promise(r => setTimeout(r, 5000)); 
          }
        }
        if (success) {
          uploadedBytes = end;
        }
      }
    } finally {
      fsSync.closeSync(fd);
    }

    return { data: videoData };
  }
}
module.exports = { PublishingSchedulingAgent };