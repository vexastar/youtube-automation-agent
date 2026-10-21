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

      } else if (videoType === 'short') {
        const scheduledEntries = [];
        let basePublishTime = new Date(productionData.scheduledPublishTime);

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
      
      for (const scheduleEntry of entriesToPublish) {
        this.logger.info(`[Publishing] Subiendo a YouTube la entrada: ${scheduleEntry.productionId}`);
        
        const uploadResult = await this.uploadToYouTube(scheduleEntry);
        
        scheduleEntry.status = 'published';
        scheduleEntry.publishedAt = new Date().toISOString();
        scheduleEntry.youtubeId = uploadResult.id;
        scheduleEntry.youtubeUrl = `https://www.youtube.com/watch?v=${uploadResult.id}`;
        
        await this.db.updateScheduleEntry(scheduleEntry);
        
        this.publishQueue = this.publishQueue.filter(entry => entry.productionId !== scheduleEntry.productionId);
        
        this.logger.success(`Content published: ${scheduleEntry.youtubeUrl}`);
        results.push(scheduleEntry);
      }
      
      return results.length === 1 ? results[0] : results;
      
    } catch (error) {
      this.logger.error('Failed to publish content:', error);
      throw error;
    }
  }

  async uploadToYouTube(scheduleEntry) {
    const { metadata } = scheduleEntry;
    const videoPath = metadata.video.path;

    const isShort = videoPath.toLowerCase().includes('_short');
    
    this.logger.info(`[Publishing] Detectado: ${isShort ? 'SHORT VERTICAL' : 'VIDEO LARGO'}`);
    this.logger.info(`[Publishing] Ruta: ${videoPath}`);

    const videoMetadata = isShort 
      ? this._prepareShortMetadata(scheduleEntry, metadata)
      : this._prepareLongVideoMetadata(scheduleEntry, metadata);
    
    this.logger.info(`[Publishing] ╔════════════════════════════════════════════════════════╗`);
    this.logger.info(`[Publishing] ║              METADATA PREPARADA PARA YOUTUBE            ║`);
    this.logger.info(`[Publishing] ╠════════════════════════════════════════════════════════╣`);
    this.logger.info(`[Publishing] ║ Tipo: ${isShort ? 'SHORT (9:16)' : 'VIDEO LARGO (16:9)'.padEnd(42)}║`);
    this.logger.info(`[Publishing] ║ Título (ES): ${videoMetadata.snippet.title.substring(0, 41).padEnd(42)}║`);
    if (videoMetadata.localizations?.en?.title) {
      this.logger.info(`[Publishing] ║ Título (EN): ${videoMetadata.localizations.en.title.substring(0, 41).padEnd(42)}║`);
    }
    if (videoMetadata.localizations?.pt?.title) {
      this.logger.info(`[Publishing] ║ Título (PT): ${videoMetadata.localizations.pt.title.substring(0, 41).padEnd(42)}║`);
    }
    this.logger.info(`[Publishing] ║ Tags: ${videoMetadata.snippet.tags.join(', ').substring(0, 51).padEnd(52)}║`);
    this.logger.info(`[Publishing] ╚════════════════════════════════════════════════════════╝`);
    
    const videoUpload = await this._robustChunkedUpload(videoPath, videoMetadata, isShort ? '[Short]' : '[Video]');
    
    const videoId = videoUpload.data.id;
    const contentType = isShort ? 'SHORT' : 'VIDEO';
    this.logger.info(`[YouTube Agent] ${contentType} subido exitosamente como NO LISTADO. Listo para revisión manual.`);
    this.logger.info(`Video ID: ${videoId}`);
    
    if (!isShort) {
      if (metadata.thumbnail && metadata.thumbnail.path) {
        try {
          this.logger.info(`[Thumbnail] Inicializando carga de miniatura...`);
          await this.uploadThumbnail(videoId, metadata.thumbnail.path);
          this.logger.success(`[Thumbnail] ✅ Miniatura subida exitosamente`);
        } catch (thumbErr) {
          this.logger.warn(`[Thumbnail] ⚠️ Error al subir miniatura: ${thumbErr.message}`);
        }
      } else {
        this.logger.warn(`[Thumbnail] ⚠️ No hay miniatura disponible en metadata.thumbnail`);
      }
    } else {
      this.logger.info(`[Thumbnail] ⏭️  Short detectado — usando frame del video como miniatura.`);
    }
    
    if (metadata.captions && metadata.captions.path) {
      await this.uploadCaptions(videoId, metadata.captions.path);
    }
    
    return videoUpload.data;
  }

  _prepareShortMetadata(scheduleEntry, metadata) {
    const baseTitle = metadata.seo?.title || scheduleEntry?.title || '';
    let shortsTitle = this._generateImpactShortTitle(baseTitle);
    if (shortsTitle.length > 100) shortsTitle = shortsTitle.substring(0, 97) + '...';

    const fullDescription = metadata.seo?.description || '';
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
          if (!firstSentence.endsWith('.')) firstSentence += '.';
        }
      }
    }
    
    let shortsDescription = `${firstSentence}\n👇 Consíguelo en Amazon:\n`;
    shortsDescription += (metadata.seo?.affiliateLink || 'https://amazon.com') + '\n';
    shortsDescription += `\n🎬 Ver análisis COMPLETO en nuestro video principal\n📺 Suscríbete para más gadgets tech\n\n#Shorts #techfinds #amazonfinds #gadgets #tecnologia #amazonfavorites`;

    const shortsTags = ['Shorts', 'amazon finds', 'tech gadgets', 'mejores gadgets', 'tecnologia', 'gadgets amazon', 'tech review'].slice(0, 500);

    const randomEmoji = ['😱', '🤯', '🔥', '⚡', '🚀'][Math.floor(Math.random() * 5)];
    const baseTitleEn = metadata.seo?.title_en ? metadata.seo.title_en.substring(0, 50) : 'Awesome Tech Gadgets';
    const baseTitlePt = metadata.seo?.title_pt ? metadata.seo.title_pt.substring(0, 50) : 'Gadgets Incríveis';

    const shortTitleEn = `${baseTitleEn} ${randomEmoji} #shorts`.substring(0, 100);
    const shortTitlePt = `${baseTitlePt} ${randomEmoji} #shorts`.substring(0, 100);

    const link = metadata.seo?.affiliateLink || 'https://amazon.com';
    const shortDescEn = `${baseTitleEn}\n👇 Get it on Amazon:\n${link}\n\n🎬 Watch the FULL video on our channel!\n#shorts #techfinds #amazonfinds`;
    const shortDescPt = `${baseTitlePt}\n👇 Compre na Amazon:\n${link}\n\n🎬 Assista ao vídeo COMPLETO no nosso canal!\n#shorts #techfinds #amazonfinds`;

    return {
      snippet: {
        title: shortsTitle,
        description: shortsDescription,
        tags: shortsTags,
        categoryId: String(metadata.seo?.metadata?.category || '28'),
        defaultLanguage: 'es',
        defaultAudioLanguage: 'es'
      },
      localizations: {
        en: { title: shortTitleEn, description: shortDescEn },
        pt: { title: shortTitlePt, description: shortDescPt }
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

  _generateImpactShortTitle(baseTitle) {
    let cleanTitle = baseTitle.replace(/^Top\s+\d+\s*[:\-]?\s*/i, '').replace(/^Mejor\s+/i, '').replace(/^Los\s+/i, '').trim();
    if (cleanTitle.length > 30) cleanTitle = cleanTitle.substring(0, 27) + '...';
    
    const impactEmojis = ['😱', '🤯', '🔥', '⚡', '💎', '🚀', '🎯', '✨'];
    const randomEmoji = impactEmojis[Math.floor(Math.random() * impactEmojis.length)];
    
    const templates = [
      `${cleanTitle} ${randomEmoji} #shorts`,
      `El MEJOR ${cleanTitle} ${randomEmoji}`,
      `IMPRESCINDIBLE: ${cleanTitle} ${randomEmoji}`,
      `${cleanTitle} te SORPRENDERÁ ${randomEmoji}`,
      `¿Ya conoces el ${cleanTitle}? ${randomEmoji}`
    ];
    
    return templates[Math.floor(Math.random() * templates.length)];
  }

  _prepareLongVideoMetadata(scheduleEntry, metadata) {
    const cleanText = (str, maxLen) => String(str || '').replace(/[<>]/g, '').trim().substring(0, maxLen);

    const title = cleanText(metadata.seo?.title || scheduleEntry?.title || 'Nuevo Video', 100);
    const description = cleanText(metadata.seo?.description || 'Descubrimiento de gadgets increíbles', 5000);
    const categoryId = String(metadata.seo?.metadata?.category || '28'); 
    
    const tags = (Array.isArray(metadata.seo?.tags) ? metadata.seo.tags : ['tech', 'gadgets', 'amazon'])
      .filter(tag => tag && typeof tag === 'string' && tag.trim().length > 0)
      .map(tag => String(tag).replace(/[<>]/g, '').substring(0, 30))
      .slice(0, 500);

    const titleEn = cleanText(metadata.seo?.title_en || metadata.seo?.localizations?.en?.title || metadata.seo?.llmOutput?.title_en || 'Top Must-Have Tech Gadgets You Need To See', 100);
    const descEn = cleanText(metadata.seo?.description_en || metadata.seo?.localizations?.en?.description || metadata.seo?.llmOutput?.description_en || `${description}\n\n🔗 Find all product links in the pinned comment below!`, 5000);
    const titlePt = cleanText(metadata.seo?.title_pt || metadata.seo?.localizations?.pt?.title || metadata.seo?.llmOutput?.title_pt || 'Top Gadgets Tecnológicos Incríveis Que Você Precisa Ver', 100);
    const descPt = cleanText(metadata.seo?.description_pt || metadata.seo?.localizations?.pt?.description || metadata.seo?.llmOutput?.description_pt || `${description}\n\n🔗 Encontre todos os links dos produtos no primeiro comentário fixado!`, 5000);

    return {
      snippet: {
        title: title,
        description: description,
        tags: tags,
        categoryId: categoryId,
        defaultLanguage: 'es',
        defaultAudioLanguage: 'es'
      },
      localizations: {
        en: { title: titleEn, description: descEn },
        pt: { title: titlePt, description: descPt }
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

  _generateDynamicTitle(baseTitle, seo) {
    const numberMatch = baseTitle.match(/\b(Top|top|TOP)\s+(\d+)/i);
    const topNumber = numberMatch ? numberMatch[2] : '';
    
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
    
    const contentHash = baseTitle.split('').reduce((a, b) => {
      a = ((a << 5) - a) + b.charCodeAt(0);
      return a & a;
    }, 0);
    const selectedTemplate = templates[Math.abs(contentHash) % templates.length];
    
    return selectedTemplate.length > 100 ? selectedTemplate.substring(0, 97) + '...' : selectedTemplate;
  }

  _generateChapters(script) {
    const chapters = [{ timestamp: '00:00', title: 'Intro' }];
    if (!script || !script.mainContent || !script.mainContent.sections) return chapters;
    
    const sections = script.mainContent.sections;
    let currentTime = 30;  
    
    sections.forEach((section, idx) => {
      const productName = section.productName || section.title || `Producto ${idx + 1}`;
      const clipDuration = section.videoDuration || 30;  
      
      const minutes = Math.floor(currentTime / 60);
      const seconds = Math.floor(currentTime % 60);
      const timestamp = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
      
      chapters.push({ timestamp: timestamp, title: productName });
      currentTime += clipDuration;
    });
    
    return chapters;
  }

  _buildDescriptionWithChapters(originalDescription, chapters, affiliateLink) {
    let description = originalDescription || 'Descubre los mejores gadgets de Amazon.';
    description += '\n\n' + '═'.repeat(50) + '\n📌 CAPÍTULOS DEL VIDEO\n' + '═'.repeat(50) + '\n';
    
    chapters.forEach(chapter => {
      description += `${chapter.timestamp} - ${chapter.title}\n`;
    });
    
    description += '\n' + '═'.repeat(50) + '\n🔗 ENLACES Y RECURSOS\n' + '═'.repeat(50) + '\n';
    if (affiliateLink) description += `Todos los enlaces de compra:\n${affiliateLink}\n\n`;
    
    description += `👉 Suscríbete para más gadgets tech\n👉 Visita nuestro canal de TikTok/Instagram para versiones cortas\n\n`;
    description += '#gadgets #amazon #amazonfinds #tech #technologia #gadgetstecnologicos #productostech #recomendaciones #viral';
    
    return description;
  }

  async getVideoStream(videoPath) {
    return JSON.stringify({ message: 'Video stream would be provided here', path: videoPath, timestamp: new Date().toISOString() });
  }

  async uploadThumbnail(videoId, thumbnailPath) {
    try {
      const exists = fsSync.existsSync(thumbnailPath);
      if (!exists) throw new Error(`Thumbnail file not found at: ${thumbnailPath}`);
      const stats = fsSync.statSync(thumbnailPath);
      if (stats.size === 0) throw new Error(`Thumbnail file is empty: ${thumbnailPath}`);
      
      const thumbnailBuffer = await fs.readFile(thumbnailPath);
      await this.youtube.thumbnails.set({
        videoId: videoId,
        media: { body: thumbnailBuffer }
      });
      this.logger.info(`[Thumbnail] ✅ Thumbnail uploaded for video: ${videoId}`);
    } catch (error) {
      this.logger.error(`[Thumbnail] ❌ Failed to upload thumbnail: ${error.message}`);
      throw error;
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
            language: 'es',
            name: 'Español',
            isDraft: false
          }
        },
        media: { body: captionsContent }
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
      return new Date(entry.publishTime) <= now && entry.status === 'scheduled';
    });
    
    for (const entry of readyToPublish) {
      try {
        await this.publishContent(entry.productionId);
        this.logger.info(`Auto-published: ${entry.title}`);
      } catch (error) {
        this.logger.error(`Failed to auto-publish ${entry.title}:`, error);
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
        const pTime = new Date(entry.publishTime);
        return pTime >= now && pTime <= endDate;
      })
      .sort((a, b) => new Date(a.publishTime) - new Date(b.publishTime));
  }

  async optimizePublishTimes() {
    const analytics = await this.getChannelAnalytics();
    const optimalTimes = this.calculateOptimalTimes(analytics);
    
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
      const response = await this.youtube.channels.list({ part: 'statistics', mine: true });
      return {
        totalViews: response.data.items[0]?.statistics?.viewCount || 0,
        subscribers: response.data.items[0]?.statistics?.subscriberCount || 0,
        videos: response.data.items[0]?.statistics?.videoCount || 0,
        optimalDays: ['Tuesday', 'Wednesday', 'Thursday'],
        optimalHours: [14, 15, 16, 20]
      };
    } catch (error) {
      return { optimalDays: ['Tuesday', 'Wednesday', 'Thursday'], optimalHours: [14, 15, 16] };
    }
  }

  calculateOptimalTimes(analytics) {
    return {
      bestDays: analytics.optimalDays,
      bestHours: analytics.optimalHours,
      worstDays: ['Monday', 'Friday'],
      worstHours: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 22, 23]
    };
  }

  findBetterTime(currentTime, optimalTimes) {
    const currentDay = currentTime.toLocaleDateString('en-US', { weekday: 'long' });
    const currentHour = currentTime.getHours();
    
    if (optimalTimes.bestDays.includes(currentDay) && optimalTimes.bestHours.includes(currentHour)) {
      return null;
    }
    
    const nextOptimalTime = new Date(currentTime);
    for (const hour of optimalTimes.bestHours) {
      if (hour > currentHour) {
        nextOptimalTime.setHours(hour, 0, 0, 0);
        if (optimalTimes.bestDays.includes(currentDay)) return nextOptimalTime;
      }
    }
    
    for (let i = 1; i <= 7; i++) {
      const testDate = new Date(currentTime.getTime() + (i * 24 * 60 * 60 * 1000));
      const testDay = testDate.toLocaleDateString('en-US', { weekday: 'long' });
      
      if (optimalTimes.bestDays.includes(testDay)) {
        testDate.setHours(optimalTimes.bestHours[0], 0, 0, 0);
        return testDate;
      }
    }
    return null; 
  }

  async createPublishingReport() {
    return {
      queueStatus: {
        total: this.publishQueue.length,
        scheduled: this.publishQueue.filter(e => e.status === 'scheduled').length,
        published: this.publishQueue.filter(e => e.status === 'published').length,
        failed: this.publishQueue.filter(e => e.status === 'failed').length
      },
      upcomingPublications: await this.getUpcomingSchedule(7),
      recentPublications: this.publishQueue
        .filter(e => e.status === 'published' && new Date(e.publishedAt) > new Date(Date.now() - 7 * 24 * 60 * 60 * 1000))
        .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt)),
      performance: await this.getPublishingPerformance(),
      generatedAt: new Date().toISOString()
    };
  }

  async getPublishingPerformance() {
    const published = this.publishQueue.filter(e => e.status === 'published');
    if (published.length === 0) return { totalPublished: 0, averageScheduleAccuracy: 0, publishingFrequency: 0 };
    
    let totalDelay = 0;
    let accuratePublishes = 0;
    
    published.forEach(entry => {
      const delay = Math.abs(new Date(entry.publishedAt) - new Date(entry.publishTime)) / (1000 * 60);
      totalDelay += delay;
      if (delay <= 5) accuratePublishes++; 
    });
    
    return {
      totalPublished: published.length,
      averageScheduleAccuracy: `${((accuratePublishes / published.length) * 100).toFixed(1)}%`,
      averageDelay: `${(totalDelay / published.length).toFixed(1)} minutes`,
      publishingFrequency: this.calculatePublishingFrequency(published)
    };
  }

  calculatePublishingFrequency(published) {
    if (published.length < 2) return 'Insufficient data';
    const dates = published.map(p => new Date(p.publishedAt)).sort((a, b) => a - b);
    const frequency = published.length / ((dates[dates.length - 1] - dates[0]) / (1000 * 60 * 60 * 24));
    
    if (frequency >= 1) return `${frequency.toFixed(1)} videos per day`;
    if (frequency >= 0.14) return `${(frequency * 7).toFixed(1)} videos per week`;
    return `${(frequency * 30).toFixed(1)} videos per month`;
  }

  async emergencyPublish(contentId, delayMinutes = 0) {
    this.logger.info(`Emergency publish requested: ${contentId}`);
    const entry = this.publishQueue.find(e => e.productionId === contentId || e.id === contentId);
    if (!entry) throw new Error(`Content not found: ${contentId}`);
    
    if (delayMinutes > 0) {
      entry.publishTime = new Date(Date.now() + (delayMinutes * 60 * 1000)).toISOString();
      await this.db.updateScheduleEntry(entry);
      this.logger.info(`Emergency scheduled for: ${entry.publishTime}`);
      return entry;
    } else {
      return await this.publishContent(contentId);
    }
  }

  async pauseScheduledContent(contentId) {
    const entry = this.publishQueue.find(e => e.productionId === contentId || e.id === contentId);
    if (!entry) throw new Error(`Content not found: ${contentId}`);
    entry.status = 'paused';
    await this.db.updateScheduleEntry(entry);
    return entry;
  }

  async resumeScheduledContent(contentId, newPublishTime = null) {
    const entry = this.publishQueue.find(e => e.productionId === contentId || e.id === contentId);
    if (!entry) throw new Error(`Content not found: ${contentId}`);
    entry.status = 'scheduled';
    if (newPublishTime) entry.publishTime = new Date(newPublishTime).toISOString();
    await this.db.updateScheduleEntry(entry);
    return entry;
  }

  async publishProductShort(productShortData, generalMetadata = {}) {
    try {
      const { productId, productName, path: videoPath } = productShortData;
      if (!videoPath || !fsSync.existsSync(videoPath)) throw new Error(`Product short video not found: ${videoPath}`);
      
      this.logger.info(`[ProductShort] Subiendo: "${productName}" (${productId})`);
      const metadata = this._prepareProductShortMetadata(productName, generalMetadata);
      
      const videoUpload = await this._robustChunkedUpload(videoPath, metadata, '[ProductShort]');
      const videoId = videoUpload.data.id;
      
      this.logger.success(`[ProductShort] ✅ "${productName}" publicado como UNLISTED`);
      return { videoId, webUrl: `https://www.youtube.com/watch?v=${videoId}`, productId, productName, uploadedAt: new Date().toISOString() };
      
    } catch (error) {
      const errorCode = error.response?.data?.error?.code || 'UNKNOWN';
      this.logger.error(`[ProductShort] ❌ Error: ${errorCode}`);
      throw { productId: productShortData.productId, productName: productShortData.productName, errorCode, errorMessage: error.message, originalError: error };
    }
  }

  _prepareProductShortMetadata(productName, generalMetadata = {}) {
    let productDisplayName = productName;
    if (productDisplayName.length > 30) productDisplayName = productDisplayName.substring(0, 27) + '...';
    
    const impactEmojis = ['😱', '🤯', '🔥', '⚡', '💎', '🚀'];
    const randomEmoji = impactEmojis[Math.floor(Math.random() * impactEmojis.length)];
    const title = `El MEJOR ${productDisplayName} ${randomEmoji} #shorts #tech`;
    const finalTitle = title.length > 100 ? title.substring(0, 97) + '...' : title;
    
    const link = generalMetadata.affiliateUrl || 'https://amazon.com';
    const description = `✨ Descubre por qué todos quieren este producto.\n\n👇 Consíguelo en Amazon:\n${link}\n\n🎬 Ver análisis completo en el video principal (link en bio)\n\n#shorts #gadgets #amazon #tecnologia #techfinds`;
    const tags = ['shorts', 'gadgets', 'tecnologia', 'tech', 'amazon', 'amazonfinds', 'techfinds', 'review'];
    
    const titleEn = `The BEST ${productDisplayName} ${randomEmoji} #shorts`.substring(0, 100);
    const titlePt = `O MELHOR ${productDisplayName} ${randomEmoji} #shorts`.substring(0, 100);
    const descEn = `✨ Discover why everyone wants this.\n\n👇 Get it on Amazon:\n${link}\n\n🎬 Watch full review on our main channel!\n#shorts #techfinds #gadgets`;
    const descPt = `✨ Descubra por que todos querem isso.\n\n👇 Compre na Amazon:\n${link}\n\n🎬 Assista à análise completa no canal principal!\n#shorts #techfinds #gadgets`;

    return {
      snippet: {
        title: finalTitle,
        description: description,
        tags: tags,
        categoryId: generalMetadata.categoryId || '28',
        defaultLanguage: generalMetadata.language || 'es',
        defaultAudioLanguage: generalMetadata.language || 'es'
      },
      localizations: {
        en: { title: titleEn, description: descEn },
        pt: { title: titlePt, description: descPt }
      },
      status: {
        privacyStatus: process.env.DEFAULT_PRIVACY_STATUS || 'unlisted',
        selfDeclaredMadeForKids: false
      }
    };
  }

  async _robustChunkedUpload(videoPath, metadata, logPrefix) {
    const fileSize = fsSync.statSync(videoPath).size;
    this.logger.info(`${logPrefix} Iniciando subida fragmentada. Tamaño real: ${(fileSize / (1024 * 1024)).toFixed(2)} MB`);

    const auth = this.credentials.getYouTubeAuth();
    const tokenObj = await auth.getAccessToken();
    const token = typeof tokenObj === 'string' ? tokenObj : tokenObj.token;
    
    const axios = require('axios');
    const https = require('https');

    const httpsAgent = new https.Agent({ keepAlive: false });
    const axiosClient = axios.create({
      httpsAgent: httpsAgent,
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });

    const parts = metadata.localizations ? 'snippet,status,localizations' : 'snippet,status';
    let uploadUrl;
    let sessionAttempt = 1;
    while (!uploadUrl && sessionAttempt <= 3) {
      try {
        const initRes = await axiosClient.post(
          `https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=${parts}`,
          metadata,
          {
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json',
              'X-Upload-Content-Length': fileSize.toString(),
              'X-Upload-Content-Type': 'video/mp4',
              'Connection': 'close'
            },
            timeout: 60000 
          }
        );
        uploadUrl = initRes.headers.location;
      } catch (err) {
        this.logger.warn(`${logPrefix} Fallo inicio de sesión (Intento ${sessionAttempt}/3): ${err.message}`);
        sessionAttempt++;
        if (sessionAttempt > 3) throw new Error(`Fallo al solicitar espacio en YouTube: ${err.message}`);
        await new Promise(r => setTimeout(r, 10000)); 
      }
    }
    
    const minChunk = 262144;
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
            this.logger.info(`${logPrefix} Subiendo paquete ${((end/fileSize)*100).toFixed(0)}%...`);
            
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

            if (chunkRes.status === 308 || chunkRes.status === 200 || chunkRes.status === 201) {
              success = true;
              if (chunkRes.status !== 308) videoData = chunkRes.data;
            }
          } catch (err) {
            this.logger.warn(`${logPrefix} Corte de red. Sincronizando...`);
            try {
              const statusRes = await axiosClient.put(uploadUrl, '', {
                headers: { 'Content-Range': `bytes */${fileSize}`, 'Content-Length': '0', 'Connection': 'close' },
                timeout: 30000,
                validateStatus: (status) => status === 308 || status === 200 || status === 201
              });

              if (statusRes.status === 308 && statusRes.headers.range) {
                const rangeMatch = statusRes.headers.range.match(/bytes=0-(\d+)/);
                if (rangeMatch && rangeMatch[1]) {
                  const serverBytes = parseInt(rangeMatch[1], 10) + 1;
                  if (serverBytes >= uploadedBytes) {
                    uploadedBytes = serverBytes;
                    break; 
                  }
                }
              }
            } catch (syncErr) { }
            
            chunkAttempt++;
            if (chunkAttempt > 5) throw new Error(`Conexión perdida definitivamente.`);
            await new Promise(r => setTimeout(r, 5000)); 
          }
        }
        if (success) uploadedBytes = end;
      }
    } finally {
      fsSync.closeSync(fd);
    }
    return { data: videoData };
  }
}

module.exports = { PublishingSchedulingAgent };