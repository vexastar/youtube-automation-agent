require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const { Logger } = require('../utils/logger');
const { DATA_SOURCE_MODE } = require('./product-hunter-agent');
// Durations configurable via env
const PER_PRODUCT_DURATION_MIN = parseInt(process.env.PER_PRODUCT_DURATION_MIN || '30', 10);
const PER_PRODUCT_DURATION_MAX = parseInt(process.env.PER_PRODUCT_DURATION_MAX || '50', 10);
const PER_PRODUCT_DURATION_DEFAULT = parseInt(process.env.PER_PRODUCT_DURATION_DEFAULT || String(Math.round((PER_PRODUCT_DURATION_MIN + PER_PRODUCT_DURATION_MAX)/2)), 10);
const INTRO_DURATION_MIN = parseInt(process.env.INTRO_DURATION_MIN || '25', 10);
const INTRO_DURATION_MAX = parseInt(process.env.INTRO_DURATION_MAX || '30', 10);
const INTRO_DURATION_AVG = Math.round((INTRO_DURATION_MIN + INTRO_DURATION_MAX) / 2);

class ContentStrategyAgent {
  constructor(db, credentials) {
    this.db = db;
    this.credentials = credentials;
    this.logger = new Logger('ContentStrategy');
    this.trendingTopics = [];
    this.competitorData = [];
    this.contentCalendar = [];

    // Initialize OpenAI
    const creds = credentials.credentials || credentials;
    const apiKey = creds.openai?.apiKey || process.env.OPENAI_API_KEY;
    if (apiKey) {
      this.openai = new OpenAI({ apiKey });
    }
  }

  async initialize() {
    this.logger.info('Initializing Content Strategy Agent...');
    await this.loadHistoricalData();
    await this.analyzeTrends();
    return true;
  }

  async loadHistoricalData() {
    try {
      const history = await this.db.getContentHistory();
      this.historicalPerformance = history;
    } catch (error) {
      this.logger.warn('No historical data found, starting fresh');
      this.historicalPerformance = [];
    }
  }

  /**
   * MEMORIA DUAL: Carga lista negra + patrones ganadores
   * @returns {Promise<Object>} {usedProducts: Set, winningPatterns: Object}
   */
  async _loadProductMemory() {
    try {
      const usedProducts = await this.db.getUsedProductNames();
      const winningPatterns = await this.db.getWinningPatterns();
      return { usedProducts, winningPatterns };
    } catch (error) {
      this.logger.warn('Error loading product memory:', error.message);
      return { usedProducts: new Set(), winningPatterns: { topCategories: [] } };
    }
  }

  /**
   * MEMORIA DUAL: Construye inyección de lista negra + patrones para prompt
   * @param {Set<String>} usedProducts - Nombres de productos ya publicados
   * @param {Object} winningPatterns - Categorías de alto desempeño
   * @returns {String} Texto a inyectar en system prompt
   */
  _buildMemoryInjection(usedProducts, winningPatterns) {
    let injection = '\n═══ MEMORIA DE CANAL (LISTA NEGRA + PATRONES DE ÉXITO) ═══\n';
    
    // Inyectar lista negra
    if (usedProducts && usedProducts.size > 0) {
      const blacklist = Array.from(usedProducts).slice(-20).join(', ');
      injection += `\n⛔ LISTA NEGRA (${usedProducts.size} productos publicados, mostrar últimos 20):\n`;
      injection += `PROHIBIDO SUGERIR estos productos o variantes semánticas:\n${blacklist}\n`;
      injection += `Si detectas que un producto es similar a uno en la lista negra (ej: "Sony WH-1000XM5" vs "Sony Premium Headphones"), RECHÁZALO.\n`;
    }
    
    // Inyectar patrones ganadores
    if (winningPatterns && winningPatterns.topCategories && winningPatterns.topCategories.length > 0) {
      const topCats = winningPatterns.topCategories
        .slice(0, 5)
        .map(cat => `${cat.category} (${cat.frequency} veces)`)
        .join(', ');
      injection += `\n🏆 CATEGORÍAS GANADORAS (prioriza estas si es posible):\n${topCats}\n`;
      injection += `Estas categorías han demostrado alto engagement. Intenta incluir productos de estos nichos cuando sea relevante.\n`;
    }
    
    if (winningPatterns && winningPatterns.topPerformers && winningPatterns.topPerformers.length > 0) {
      const topProds = winningPatterns.topPerformers
        .slice(0, 5)
        .map(p => p.productName)
        .join(', ');
      injection += `\n⭐ TOP 5 ÚLTIMOS PUBLICADOS:\n${topProds}\n`;
    }
    
    injection += '\nAplicar lista negra es CRÍTICO para evitar fatiga de contenido y mejorar engagement a largo plazo.\n';
    
    return injection;
  }

  /**
   * CONTENT PILLARS: Retorna los 11 pilares principales del canal
   * @returns {Array<Object>} Array de pilares con id, nombre y descripción
   */
  _getContentPillars() {
    return [
      {
        id: 1,
        name: 'Smart Home & Domótica',
        description: 'Dispositivos inteligentes para el hogar: iluminación, control de temperatura, seguridad automatizada',
        examples: ['gadgets de automatización del hogar', 'iluminación inteligente', 'cerraduras automatizadas']
      },
      {
        id: 2,
        name: 'Gaming & Setups',
        description: 'Periféricos gaming, sillas, monitores y accesorios para optimizar la experiencia de juego',
        examples: ['periféricos gaming', 'sillas gaming ergonómicas', 'monitores de 240Hz', 'headsets gaming']
      },
      {
        id: 3,
        name: 'Productividad & Home Office (Ergonomía)',
        description: 'Herramientas para mejorar la productividad: escritorios, iluminación, ergonomía',
        examples: ['escritorios ajustables', 'monitores para trabajo', 'teclados mecánicos', 'sillas de oficina']
      },
      {
        id: 4,
        name: 'EDC (Everyday Carry) & Supervivencia Urbana',
        description: 'Gadgets portátiles para el día a día: mochilas, herramientas multiusos, luces de bolsillo',
        examples: ['mochilas multifuncionales', 'herramientas portátiles', 'linterna EDC', 'navaja suiza moderna']
      },
      {
        id: 5,
        name: 'Audio Personal & Audiófilos',
        description: 'Auriculares, altavoces portátiles y accesorios de audio de alta calidad',
        examples: ['auriculares inalámbricos', 'altavoces Bluetooth', 'headphones sobre oreja', 'dacs portátiles']
      },
      {
        id: 6,
        name: 'Creadores de Contenido & Streaming',
        description: 'Equipos para streamers y creadores: micrófonos, cámaras, iluminación, green screens',
        examples: ['micrófonos para streaming', 'cámaras para YouTube', 'ring lights profesionales', 'capturadora de video']
      },
      {
        id: 7,
        name: 'Tecnología para Nómadas Digitales & Viajes',
        description: 'Accesorios de viaje: power banks, adaptadores, fundas, organizadores portátiles',
        examples: ['power banks de 65W+', 'adaptadores de viaje', 'webcams portátiles', 'maletas inteligentes']
      },
      {
        id: 8,
        name: 'Gadgets de Coche & Movilidad Inteligente',
        description: 'Tecnología automotriz: soportes, dashcams, sistemas de carga inalámbrica, accesorios inteligentes',
        examples: ['dashcams inteligentes', 'cargadores inalámbricos para auto', 'soportes magnéticos', 'sistemas HUD']
      },
      {
        id: 9,
        name: 'Salud, Fitness & Recuperación',
        description: 'Dispositivos wearable, rastreadores de salud, masajeadores, bandas deportivas inteligentes',
        examples: ['smartwatches de salud', 'rastreadores de fitness', 'masajeadores musculares', 'balanzas inteligentes']
      },
      {
        id: 10,
        name: 'Pet Tech (Tecnología para Mascotas)',
        description: 'Gadgets para mascotas: comederos automáticos, cámaras de vigilancia, accesorios inteligentes',
        examples: ['comederos automáticos', 'cámaras para mascotas', 'juguetes interactivos', 'collares inteligentes']
      },
      {
        id: 11,
        name: 'Gadgets Curiosos & Novedades Tecnológicas',
        description: 'Productos innovadores, futuristas y poco comunes que generan curiosidad y sorpresa',
        examples: ['proyectores holográficos', 'robots educativos', 'drones autónomos', 'gadgets de ciencia ficción']
      }
    ];
  }

  /**
   * CONTENT PILLARS: Selecciona aleatoriamente un pilar
   * @returns {Object} Pilar seleccionado {id, name, description}
   */
  _selectRandomPillar() {
    const pillars = this._getContentPillars();
    const randomIndex = Math.floor(Math.random() * pillars.length);
    return pillars[randomIndex];
  }

  /**
   * CONTENT PILLARS: Construye inyección de pilares para el prompt
   * Cuando no hay requestedTopic (modo automático), selecciona un pilar y
   * guía al modelo a generar un micro-nicho creativamente
   * 
   * @param {String} requestedTopic - Topic solicitado (null si es automático)
   * @returns {Object} {pillar, injection} - Pilar seleccionado + texto de inyección
   */
  _buildPillarInjection(requestedTopic) {
    // Si hay tema específico del usuario, no forzar pilar (pero mostrar en log)
    if (requestedTopic) {
      return {
        pillar: null,
        injection: ''
      };
    }

    // Modo automático: seleccionar pilar aleatorio
    const pillar = this._selectRandomPillar();
    
    const injection = `
═══ PILARES DE CONTENIDO DEL CANAL ═══
Tu objetivo es inventar un tema altamente atractivo que caiga dentro del siguiente pilar principal:

🎯 PILAR SELECCIONADO: ${pillar.name}
   Descripción: ${pillar.description}
   Ejemplos de sub-nichos: ${pillar.examples.join(' | ')}

REGLA DE CREATIVIDAD - CREAR MICRO-NICHOS:
No uses el nombre del pilar literalmente en el título. En su lugar, usa tu conocimiento del mundo de la tecnología para explorar 'micro-nichos' específicos dentro de este pilar. 

EJEMPLOS DE LO QUE SÍ HACER:
- Pilar "Productividad & Home Office": "5 Gadgets que todo estudiante de ingeniería necesita" (micro-nicho específico)
- Pilar "Gaming & Setups": "5 Accesorios gaming para tortolitos (couples gaming)" (micro-nicho creativo)
- Pilar "Audio": "5 Auriculares para gente que odias los sonidos fuertes" (micro-nicho emocional)
- Pilar "EDC & Supervivencia": "5 Gadgets para gente paranoica que vive en la ciudad" (micro-nicho con humor)

EJEMPLOS DE LO QUE NO HACER:
- ❌ "Gadgets de Smart Home" (demasiado genérico, usa el nombre del pilar)
- ❌ "Top 5 Gaming Peripherals" (inglés, sin creatividad)
- ❌ "5 Cosas aleatorias de tecnología" (sin conexión con el pilar)

El tema DEBE:
1. Ser atractivo y generador de curiosidad (high CTR)
2. Pertenecer claramente al pilar seleccionado
3. Ser específico en un micro-nicho, NO genérico
4. Tener un ángulo único o emotivo
5. Ser tendencia en redes sociales o búsquedas recientes

Combina esta creatividad con la Memoria del Canal (lista negra + patrones ganadores) para garantizar que:
- NO incluyas productos ya publicados
- Priorices categorías de alto engagement
`;

    return { pillar, injection };
  }

  async analyzeTrends() {
    try {
      // Analyze YouTube trends
      const trends = await this.fetchYouTubeTrends();
      
      // Analyze competitor channels
      const competitors = await this.analyzeCompetitors();
      
      // Combine insights
      this.trendingTopics = this.mergeTrendData(trends, competitors);
      
      this.logger.info(`Identified ${this.trendingTopics.length} trending topics`);
    } catch (error) {
      this.logger.error('Error analyzing trends:', error);
    }
  }

  async fetchYouTubeTrends() {
    // Use YouTube API to fetch trending videos
    const youtube = this.credentials.getYouTubeClient();
    
    try {
      const response = await youtube.videos.list({
        part: 'snippet,statistics',
        chart: 'mostPopular',
        maxResults: 50,
        regionCode: process.env.YOUTUBE_REGION || 'US'
      });

      return response.data.items.map(video => ({
        title: video.snippet.title,
        tags: video.snippet.tags || [],
        viewCount: parseInt(video.statistics.viewCount),
        category: video.snippet.categoryId,
        publishedAt: video.snippet.publishedAt
      }));
    } catch (error) {
      this.logger.error('Failed to fetch YouTube trends:', error);
      return [];
    }
  }

  async analyzeCompetitors() {
    const competitorChannels = (process.env.COMPETITOR_CHANNELS || '').split(',');
    const competitorData = [];

    for (const channelId of competitorChannels) {
      if (!channelId) continue;
      
      try {
        const videos = await this.getChannelVideos(channelId);
        const analysis = this.analyzeVideoPerformance(videos);
        competitorData.push({
          channelId,
          topPerformingTopics: analysis.topTopics,
          averageViews: analysis.avgViews,
          uploadFrequency: analysis.frequency
        });
      } catch (error) {
        this.logger.error(`Failed to analyze competitor ${channelId}:`, error);
      }
    }

    return competitorData;
  }

  async getChannelVideos(channelId) {
    const youtube = this.credentials.getYouTubeClient();
    
    try {
      const response = await youtube.search.list({
        part: 'snippet',
        channelId: channelId,
        maxResults: 20,
        order: 'date',
        type: 'video'
      });

      const videoIds = response.data.items.map(item => item.id.videoId).join(',');
      
      const videoDetails = await youtube.videos.list({
        part: 'statistics,snippet',
        id: videoIds
      });

      return videoDetails.data.items;
    } catch (error) {
      this.logger.error(`Failed to get videos for channel ${channelId}:`, error);
      return [];
    }
  }

  analyzeVideoPerformance(videos) {
    if (!videos || videos.length === 0) {
      return { topTopics: [], avgViews: 0, frequency: 0 };
    }

    const topics = {};
    let totalViews = 0;

    videos.forEach(video => {
      const title = video.snippet.title.toLowerCase();
      const views = parseInt(video.statistics.viewCount);
      totalViews += views;

      // Extract topics from title
      const keywords = this.extractKeywords(title);
      keywords.forEach(keyword => {
        if (!topics[keyword]) topics[keyword] = { count: 0, views: 0 };
        topics[keyword].count++;
        topics[keyword].views += views;
      });
    });

    const topTopics = Object.entries(topics)
      .sort((a, b) => b[1].views - a[1].views)
      .slice(0, 10)
      .map(([topic, data]) => ({ topic, avgViews: data.views / data.count }));

    return {
      topTopics,
      avgViews: totalViews / videos.length,
      frequency: videos.length
    };
  }

  extractKeywords(text) {
    // Simple keyword extraction
    const stopWords = ['the', 'is', 'at', 'which', 'on', 'and', 'a', 'an', 'as', 'are', 'was', 'were', 'been', 'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'must', 'can', 'could', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'what', 'which', 'who', 'when', 'where', 'why', 'how', 'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'can', 'will', 'just', 'should', 'now'];
    
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter(word => word.length > 3 && !stopWords.includes(word));
  }

  mergeTrendData(trends, competitors) {
    const mergedTopics = new Map();

    // Add trending topics
    trends.forEach(trend => {
      const keywords = this.extractKeywords(trend.title);
      keywords.forEach(keyword => {
        if (!mergedTopics.has(keyword)) {
          mergedTopics.set(keyword, { score: 0, sources: [] });
        }
        const topic = mergedTopics.get(keyword);
        topic.score += trend.viewCount / 1000000; // Normalize by millions
        topic.sources.push('trending');
      });
    });

    // Add competitor topics
    competitors.forEach(competitor => {
      if (competitor.topPerformingTopics) {
        competitor.topPerformingTopics.forEach(({ topic, avgViews }) => {
          if (!mergedTopics.has(topic)) {
            mergedTopics.set(topic, { score: 0, sources: [] });
          }
          const topicData = mergedTopics.get(topic);
          topicData.score += avgViews / 100000; // Normalize
          topicData.sources.push('competitor');
        });
      }
    });

    // Convert to array and sort by score
    return Array.from(mergedTopics.entries())
      .map(([topic, data]) => ({ topic, ...data }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 50);
  }

  async generateContentStrategy(requestedTopic = null) {
    try {
      // Use GPT-4o to generate a viral Top N listicle concept
      if (this.openai) {
        const channelName = process.env.CHANNEL_NAME || 'Canal';
        const language = process.env.CONTENT_LANGUAGE || 'es';
        const niche = process.env.CHANNEL_NICHE || 'gadgets tecnológicos, inventos curiosos y productos virales de internet';

        // Extraer cantidad de la solicitud del usuario (ej. "3 gadgets"), default 5
        let numProductos = 25;
        if (requestedTopic) {
          const match = requestedTopic.match(/(\d+)/);
          if (match) numProductos = Math.max(1, Math.min(25, parseInt(match[1], 10)));
        }
        this.logger.info(`Formato controlado: Top ${numProductos} productos`);

        // ═══════════════════════════════════════════════════════════════
        //  FUENTE DE VERDAD: productos_locales.json (raíz del proyecto)
        //  Se usa SOLO si NO hay prompt de terminal con API activa.
        //  Si el usuario pasó un prompt (requestedTopic) y la API está
        //  activa (DATA_SOURCE_MODE !== 'local'), se salta los locales
        //  y GPT-4o genera productos dinámicos basados en el prompt.
        //  Fallback: uploads/catalog.json (formato legacy).
        // ═══════════════════════════════════════════════════════════════
        const apiIsActive = DATA_SOURCE_MODE !== 'local';
        const hasUserPrompt = !!requestedTopic;
        const skipLocalForDynamicPrompt = hasUserPrompt && apiIsActive;

        if (skipLocalForDynamicPrompt) {
          this.logger.info(`⚡ MODO DINÁMICO: prompt="${requestedTopic}" + API activa (${DATA_SOURCE_MODE}) → saltando productos_locales.json, GPT generará productos nuevos.`);
        }

        const localDbPath = path.resolve(__dirname, '..', 'productos_locales.json');
        let localProducts = [];
        if (!skipLocalForDynamicPrompt) {
          try {
            if (fs.existsSync(localDbPath)) {
              localProducts = JSON.parse(fs.readFileSync(localDbPath, 'utf8'));
              if (!Array.isArray(localProducts)) localProducts = [];
            }
          } catch (e) {
            this.logger.warn(`Error leyendo productos_locales.json: ${e.message}`);
          }
        }

        if (localProducts.length > 0) {
          numProductos = Math.min(numProductos, localProducts.length);
          const selectedProducts = localProducts.slice(0, numProductos);
          this.logger.info(`📦 FUENTE LOCAL: ${selectedProducts.length} productos de productos_locales.json`);

          const productosNorm = selectedProducts.map(p => ({
            id: p.id,
            nombre: p.product_name,
            filename: p.filename,
            precio: p.price,
            searchTermEn: p.product_name
          }));

          const productList = productosNorm.map((p, i) => `${i + 1}. ${p.nombre}`).join(', ');
          let titulo_video = `Top ${numProductos} ${requestedTopic || 'Gadgets Increíbles'}`;
          let intro_script = '';

          try {
            const offlineResponse = await this.openai.chat.completions.create({
              model: 'gpt-4o',
              temperature: 0.8,
              response_format: { type: 'json_object' },
              messages: [
                {
                  role: 'system',
                  content: [
                    `Genera SOLO un título de video y un intro_script para un video de Top ${numProductos} productos.`,
                    `Los productos son EXACTAMENTE estos (NO los cambies ni inventes otros): ${productList}`,
                    `Tema del video: "${requestedTopic || 'gadgets'}"`,
                    'Responde con JSON: { "titulo_video": "...", "intro_script": "..." }',
                    'El intro_script debe ser 3-4 oraciones narrables por TTS (40-55 palabras), generando curiosidad sobre estos productos específicos.',
                    'NO incluyas saludos. Arranca con curiosidad directa.'
                  ].join('\n')
                },
                { role: 'user', content: `Genera título e intro para: ${productList}` }
              ]
            });
            const offlineParsed = JSON.parse(offlineResponse.choices[0].message.content);
            titulo_video = offlineParsed.titulo_video || titulo_video;
            intro_script = offlineParsed.intro_script || '';
            titulo_video = titulo_video.replace(/\b(Top|top|TOP)\s+\d+/i, `Top ${numProductos}`);
          } catch (gptErr) {
            this.logger.warn(`GPT title/intro falló: ${gptErr.message}. Usando título genérico.`);
          }

          this.logger.info(`Productos locales: ${productosNorm.map(p => `[${p.id}] ${p.nombre}`).join(', ')}`);

          const strategy = {
            topic: titulo_video,
            angle: titulo_video,
            targetAudience: 'Compradores de gadgets, curiosos de tecnología, amantes de productos virales',
            contentType: 'List',
            numProductos,
            introScript: intro_script,
            keywords: this.extractKeywords(titulo_video),
            estimatedViews: this.predictViews(titulo_video),
            bestPublishTime: this.calculateBestPublishTime(),
            competitorAnalysis: [],
            productos: productosNorm,
            _sourceFile: 'productos_locales.json',
            createdAt: new Date().toISOString()
          };

          await this.db.saveContentStrategy(strategy);
          return strategy;
        }

        // ═══════════════════════════════════════════════════════════════

// 🎯 LÓGICA CONDICIONAL INTELIGENTE PARA EL PROMPT DEL USUARIO
        const userPrompt = requestedTopic
          ? `Genera un concepto de video Top ${numProductos} ESTRICTAMENTE sobre el tema: "${requestedTopic}". Aplica la regla de "Variety Show de Nicho" descrita en el sistema.`
          : `Genera un concepto de video Top ${numProductos} aplicando la estrategia "Variety Show Global", mezclando gadgets sorprendentes de todas las categorías.`;

        // 🧠 INYECCIÓN DE MEMORIA DUAL: Cargar lista negra + patrones ganadores
        const { usedProducts, winningPatterns } = await this._loadProductMemory();
        const memoryInjection = this._buildMemoryInjection(usedProducts, winningPatterns);

        // 🎯 INYECCIÓN DE CONTENT PILLARS: Seleccionar pilar para modo automático
        const { pillar, injection: pillarInjection } = this._buildPillarInjection(requestedTopic);
        if (pillar) {
          this.logger.info(`🎯 Pilar seleccionado para generación automática: "${pillar.name}"`);
        }

        // 🔥 REGLA DE ORO DINÁMICA (VARIETY SHOW INTELIGENTE)
        const varietyRule = requestedTopic
          ? [
              '🔥 REGLA DE ORO (VARIETY SHOW DE NICHO):',
              `El tema central OBLIGATORIO es: "${requestedTopic}".`,
              'Sin embargo, para maximizar la retención, aplica la filosofía "Variety Show" DENTRO de este nicho.',
              'NUNCA repitas el mismo formato exacto de producto. Mezcla utilidades, diseños y aproximaciones al problema.',
              'Por ejemplo: si el tema es auriculares, no entregues 5 audífonos over-ear bluetooth. Varía entre in-ear invisibles, antifaces con sonido, tapones inteligentes, etc.',
              'Cada producto debe sentirse como una sorpresa distinta que resuelve el mismo problema base.'
            ].join('\n')
          : [
              '🔥 REGLA DE ORO (ESTRATEGIA EZETECH - "VARIETY SHOW GLOBAL"):',
              'NUNCA limites la lista a un solo nicho. Para maximizar la retención, DEBES mezclar categorías de forma agresiva.',
              'Distribuye la lista así:',
              '- 20% Tecnología y Setup',
              '- 20% EDC y Herramientas',
              '- 20% Hogar y Cocina',
              '- 20% Salud y Descanso',
              '- 20% Random / Curiosidades',
              'El título del video debe reflejar utilidad general, no un nicho.'
            ].join('\n');

        const currentYear = new Date().getFullYear();
        const response = await this.openai.chat.completions.create({
          model: 'gpt-4o',
          temperature: 0.9,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content: [
                `Eres el director creativo del canal de YouTube "${channelName}".`,
                `Idioma: ${language}. Nicho: ${niche}.`,
                `Tu tarea es generar un guion para un video de exactamente ${numProductos} productos.`,
                '',
                varietyRule,
                '',
                '═══ PERSONA OBLIGATORIA: EXPERTO EN KICKSTARTER/INDIEGOGO ═══',
                'Actúa como un experto en tendencias de tecnología y crowdfunding. Prioriza productos reales, innovadores y específicos (ejemplo: "Ekster Parliament Wallet") que tengan disponibilidad comprobada en Amazon.',
                '',
                memoryInjection,
                '',
                `ATENCIÓN: El usuario ha solicitado EXACTAMENTE ${numProductos} productos.`,
                `- El "titulo_video" del JSON DEBE incluir el número ${numProductos} (Ej: "Top ${numProductos} Inventos...").`,
                `- El array de "productos" DEBE contener EXACTAMENTE ${numProductos} elementos.`,
                '',
                `Responde ÚNICAMENTE con un objeto JSON con esta estructura exacta:`,
                '{',
                `  "titulo_video": "Top ${numProductos} [tema general o específico]",`,
                `  "intro_script": "Texto de enganche de EXACTAMENTE 30 segundos...",`,
                `  "productos": [`,
                `    { "nombre": "Nombre en español", "searchTermEn": "english search term" }`,
                `  ]`,
                '}',
                '',
                'REGLA PARA "intro_script":',
                '- CRÍTICO: Debe durar EXACTAMENTE 30 segundos (aprox. 80-95 palabras).',
                '- Genera MÁXIMA curiosidad mencionando características alucinantes de 2-3 productos sin revelar nombres.',
                '- NO uses saludos genéricos.',
                '',
                'REGLAS PARA LOS CAMPOS DE CADA PRODUCTO:',
                '- "nombre": Nombre comercial EXACTO (marca + modelo). Máximo 5 palabras.',
                '- "searchTermEn": Término de búsqueda en INGLÉS para Amazon. Usa palabras clave comerciales y específicas. Mínimo 3, máximo 6 palabras.',
                '',
                'REGLAS PARA EL ARRAY "productos":',
                `1. EXACTAMENTE ${numProductos} elementos.`,
                '2. Los productos DEBEN existir en tiendas reales (Amazon).',
                `3. NO inventes tecnología que no existe.
                IMPORTANTE: El año actual es ${currentYear}. Si decides incluir un año en los títulos, descripciones o guiones, DEBE ser estrictamente ${currentYear}. Tienes absolutamente prohibido utilizar cualquier año anterior a ${currentYear}.`
              ].join('\n')
            },
            { role: 'user', content: userPrompt }
          ]
        });

        const parsed = JSON.parse(response.choices[0].message.content);

        // Validar que GPT respetó la cantidad pedida
        if (parsed.productos && parsed.productos.length !== numProductos) {
          this.logger.warn(`GPT devolvió ${parsed.productos.length} productos pero se pidieron ${numProductos}. Recortando...`);
          parsed.productos = parsed.productos.slice(0, numProductos);
        }

        // Forzar que el título refleje la cantidad correcta (GPT a veces ignora la instrucción)
        if (parsed.titulo_video) {
          parsed.titulo_video = parsed.titulo_video.replace(/\b(Top|top|TOP)\s+\d+/i, `Top ${numProductos}`);
        }

        this.logger.info(`GPT-4o Top ${parsed.productos?.length || '?'} concept: ${parsed.titulo_video}`);

        // Normalizar: si GPT devuelve strings planos, convertir a objetos
        // INYECCIÓN OBLIGATORIA DE IDs: cada producto recibe un id secuencial
        // y un filename placeholder que será actualizado post-hunt con el ASIN real.
        // Esto garantiza que los productos NUNCA transiten sin identificador.
        const productosNorm = parsed.productos.map((p, idx) => {
          const base = typeof p === 'string' ? { nombre: p, searchTermEn: p } : { nombre: p.nombre || p.name || '', searchTermEn: p.searchTermEn || p.search_term_en || p.nombre || '' };
          base.id = `api_prod_${idx}`;
          base.filename = null; // se rellenará con el ASIN real tras la descarga
          return base;
        });
        this.logger.info(`Productos (con IDs inyectados): ${productosNorm.map(p => `[${p.id}] ${p.nombre} [EN: ${p.searchTermEn}]`).join(', ')}`);

        // Build strategy object compatible with the rest of the pipeline
        const strategy = {
          topic: parsed.titulo_video,
          angle: parsed.titulo_video,
          targetAudience: 'Compradores de gadgets, curiosos de tecnología, amantes de productos virales',
          contentType: 'List',
          numProductos,
          introScript: parsed.intro_script || '',
          keywords: this.extractKeywords(parsed.titulo_video),
          estimatedViews: this.predictViews(parsed.titulo_video),
          bestPublishTime: this.calculateBestPublishTime(),
          competitorAnalysis: [],
          productos: productosNorm,
          _sourceFile: 'api',
          createdAt: new Date().toISOString()
        };

        await this.db.saveContentStrategy(strategy);
        return strategy;
      }

      // Fallback: original logic without OpenAI
      let topic, angle, targetAudience, contentType;

      if (requestedTopic) {
        topic = requestedTopic;
        angle = await this.generateAngle(topic);
      } else {
        // Select from trending topics
        const selectedTopic = this.selectOptimalTopic();
        topic = selectedTopic.topic;
        angle = await this.generateAngle(topic);
      }

      // Determine target audience
      targetAudience = await this.identifyTargetAudience(topic);

      // Select content type
      contentType = this.selectContentType(topic);

      // Generate content calendar entry
      const strategy = {
        topic,
        angle,
        targetAudience,
        contentType,
        keywords: this.extractKeywords(topic),
        estimatedViews: this.predictViews(topic),
        bestPublishTime: this.calculateBestPublishTime(),
        competitorAnalysis: this.getCompetitorInsights(topic),
        createdAt: new Date().toISOString()
      };

      // Save to database
      await this.db.saveContentStrategy(strategy);

      this.logger.info(`Generated strategy for: ${topic}`);
      return strategy;
    } catch (error) {
      this.logger.error('Failed to generate content strategy:', error);
      throw error;
    }
  }

  selectOptimalTopic() {
    // Use scoring algorithm to select best topic
    const recentTopics = this.getRecentTopics();
    
    const scoredTopics = this.trendingTopics
      .filter(topic => !recentTopics.includes(topic.topic))
      .map(topic => ({
        ...topic,
        finalScore: topic.score * this.getSeasonalMultiplier(topic.topic) * this.getAudienceMultiplier(topic.topic)
      }));

    return scoredTopics[0] || { topic: 'Technology Trends', score: 1 };
  }

  async generateAngle(topic) {
    // Generate unique angle for the topic
    const angles = [
      `The Ultimate Guide to ${topic}`,
      `${topic}: What Nobody Is Telling You`,
      `How ${topic} Will Change Everything in 2025`,
      `The Hidden Truth About ${topic}`,
      `${topic} Explained in 5 Minutes`,
      `Why ${topic} Is More Important Than You Think`,
      `${topic}: Expert Secrets Revealed`,
      `The Complete ${topic} Tutorial for Beginners`
    ];

    return angles[Math.floor(Math.random() * angles.length)];
  }

  async identifyTargetAudience(topic) {
    // Simplified audience identification
    const audiences = {
      tech: 'Tech enthusiasts, developers, early adopters',
      business: 'Entrepreneurs, business owners, professionals',
      education: 'Students, educators, lifelong learners',
      entertainment: 'General audience, entertainment seekers',
      lifestyle: 'Lifestyle enthusiasts, self-improvement seekers'
    };

    const category = this.categorize(topic);
    return audiences[category] || audiences.entertainment;
  }

  categorize(topic) {
    const categories = {
      tech: ['technology', 'software', 'app', 'ai', 'code', 'programming', 'crypto', 'blockchain'],
      business: ['business', 'money', 'finance', 'startup', 'entrepreneur', 'marketing'],
      education: ['learn', 'tutorial', 'how to', 'guide', 'course', 'study'],
      lifestyle: ['life', 'health', 'fitness', 'food', 'travel', 'fashion']
    };

    const topicLower = topic.toLowerCase();
    
    for (const [category, keywords] of Object.entries(categories)) {
      if (keywords.some(keyword => topicLower.includes(keyword))) {
        return category;
      }
    }

    return 'entertainment';
  }

  selectContentType(topic) {
    const types = [
      { type: 'Tutorial', suitableFor: ['how to', 'guide', 'learn'] },
      { type: 'List', suitableFor: ['best', 'top', 'worst'] },
      { type: 'Review', suitableFor: ['review', 'vs', 'comparison'] },
      { type: 'Explainer', suitableFor: ['what is', 'why', 'explained'] },
      { type: 'News', suitableFor: ['breaking', 'latest', 'new'] },
      { type: 'Story', suitableFor: ['story', 'journey', 'experience'] }
    ];

    const topicLower = topic.toLowerCase();
    
    for (const contentType of types) {
      if (contentType.suitableFor.some(keyword => topicLower.includes(keyword))) {
        return contentType.type;
      }
    }

    return 'Explainer';
  }

  predictViews(topic) {
    // Simplified view prediction based on topic score
    const topicData = this.trendingTopics.find(t => t.topic === topic);
    const baseViews = topicData ? topicData.score * 10000 : 5000;
    const variance = baseViews * 0.3;
    return Math.floor(baseViews + (Math.random() * variance * 2) - variance);
  }

calculateBestPublishTime() {
    // Horarios optimizados para audiencia Tech/Gadgets (Hora GMT-5 Colombia)
    const bestTimes = [
      { day: 'Monday', hour: 14 },    // 2:00 PM
      { day: 'Tuesday', hour: 14 },   // 2:00 PM
      { day: 'Wednesday', hour: 14 }, // 2:00 PM
      { day: 'Thursday', hour: 13 },  // 1:00 PM
      { day: 'Friday', hour: 13 },    // 1:00 PM
      { day: 'Saturday', hour: 9 },   // 9:00 AM
      { day: 'Sunday', hour: 9 }      // 9:00 AM
    ];

    const today = new Date().toLocaleDateString('en-US', { weekday: 'long' });
    const selected = bestTimes.find(t => t.day === today) || bestTimes[0];
    
    // Configura la fecha para mañana a la hora exacta del pico
    const nextDate = new Date();
    nextDate.setDate(nextDate.getDate() + 1);
    nextDate.setHours(selected.hour, 0, 0, 0);
    
    return nextDate.toISOString();
  }

  getNextWeekday(dayName) {
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const targetDay = days.indexOf(dayName);
    const today = new Date();
    const currentDay = today.getDay();
    const daysUntilTarget = (targetDay - currentDay + 7) % 7 || 7;
    const nextDate = new Date(today);
    nextDate.setDate(today.getDate() + daysUntilTarget);
    return nextDate;
  }

  getCompetitorInsights(topic) {
    // Get insights from competitor analysis
    return this.competitorData
      .filter(competitor => 
        competitor.topPerformingTopics.some(t => 
          t.topic.toLowerCase().includes(topic.toLowerCase())
        )
      )
      .map(competitor => ({
        channelId: competitor.channelId,
        averageViews: competitor.averageViews,
        relevantVideos: competitor.topPerformingTopics.filter(t => 
          t.topic.toLowerCase().includes(topic.toLowerCase())
        )
      }));
  }

  getRecentTopics() {
    // Get topics used in last 7 days to avoid repetition
    return this.historicalPerformance
      .filter(content => {
        const contentDate = new Date(content.createdAt);
        const weekAgo = new Date();
        weekAgo.setDate(weekAgo.getDate() - 7);
        return contentDate > weekAgo;
      })
      .map(content => content.topic);
  }

  getSeasonalMultiplier(topic) {
    // Adjust score based on seasonal relevance
    const month = new Date().getMonth();
    const seasonalTopics = {
      winter: ['christmas', 'holiday', 'new year', 'winter'],
      spring: ['spring', 'easter', 'garden'],
      summer: ['summer', 'vacation', 'beach', 'travel'],
      fall: ['halloween', 'thanksgiving', 'autumn', 'back to school']
    };

    const season = month < 3 ? 'winter' : month < 6 ? 'spring' : month < 9 ? 'summer' : 'fall';
    const topicLower = topic.toLowerCase();
    
    if (seasonalTopics[season].some(keyword => topicLower.includes(keyword))) {
      return 1.5;
    }
    
    return 1.0;
  }

  getAudienceMultiplier(topic) {
    // Adjust score based on target audience size
    const category = this.categorize(topic);
    const multipliers = {
      tech: 1.2,
      business: 1.1,
      education: 1.0,
      entertainment: 1.3,
      lifestyle: 1.15
    };
    
    return multipliers[category] || 1.0;
  }
}

module.exports = { ContentStrategyAgent };