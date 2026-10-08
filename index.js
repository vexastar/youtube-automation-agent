// ═══ CARGA DE VARIABLES DE ENTORNO (.env) ═══
// DEBE ser la primera línea antes de cualquier otro require/import.
// Sin esto, process.env.OPENAI_API_KEY, ELEVENLABS_API_KEY, etc. serán undefined.
require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const fsSync = require('fs');
const { Logger } = require('./utils/logger');
const { Database } = require('./database/db');
const { CredentialManager } = require('./utils/credential-manager');
const { ContentStrategyAgent } = require('./agents/content-strategy-agent');
const { ScriptWriterAgent } = require('./agents/script-writer-agent');
const { ThumbnailDesignerAgent } = require('./agents/thumbnail-designer-agent');
const { SEOOptimizerAgent } = require('./agents/seo-optimizer-agent');
const { ProductionManagementAgent } = require('./agents/production-management-agent');
const { PublishingSchedulingAgent } = require('./agents/publishing-scheduling-agent');
const { AnalyticsOptimizationAgent } = require('./agents/analytics-optimization-agent');
const ProductHunterAgent = require('./agents/product-hunter-agent');
const { TikTokPublishingAgent } = require('./agents/tiktok-publishing-agent');
const { DATA_SOURCE_MODE } = require('./agents/product-hunter-agent');
const { DailyAutomation } = require('./schedules/daily-automation');
const { VideoEncoder } = require('./utils/video-encoder');
const chalk = require('chalk');
const axios = require('axios');
const { mapProductsToVideos } = require('./utils/product-mapper');

// Durations configurable via env
const PER_PRODUCT_DURATION_MIN = parseInt(process.env.PER_PRODUCT_DURATION_MIN || '30', 10);
const PER_PRODUCT_DURATION_MAX = parseInt(process.env.PER_PRODUCT_DURATION_MAX || '50', 10);
const PER_PRODUCT_DURATION_DEFAULT = parseInt(process.env.PER_PRODUCT_DURATION_DEFAULT || String(Math.round((PER_PRODUCT_DURATION_MIN + PER_PRODUCT_DURATION_MAX)/2)), 10);
const INTRO_DURATION_MIN = parseInt(process.env.INTRO_DURATION_MIN || '25', 10);
const INTRO_DURATION_MAX = parseInt(process.env.INTRO_DURATION_MAX || '30', 10);
const INTRO_DURATION_AVG = Math.round((INTRO_DURATION_MIN + INTRO_DURATION_MAX) / 2);
const COMBINED_CLIP_DURATION = parseInt(process.env.COMBINED_CLIP_DURATION || '60', 10);

class YouTubeAutomationAgent {
  constructor() {
    this.logger = new Logger('MainAgent');
    this.db = null;
    this.credentials = null;
    this.agents = {};
    this.app = express();
    this.isInitialized = false;
  }

  async initialize() {
    try {
      console.log(chalk.cyan.bold('\n🎬 YouTube Automation Agent v1.0'));
      console.log(chalk.gray('─'.repeat(50)));
      
      // Initialize database
      this.logger.info('Initializing database...');
      this.db = new Database();
      await this.db.initialize();
      
      // Load credentials
      this.logger.info('Loading credentials...');
      this.credentials = new CredentialManager();
      const credentialsValid = await this.credentials.validateAll();
      
      if (!credentialsValid) {
        console.log(chalk.yellow('\n⚠️  Some credentials are missing or invalid.'));
        console.log(chalk.yellow('Run: npm run credentials:setup'));
        return false;
      }
      
      // Initialize agents
      this.logger.info('Initializing agents...');
      await this.initializeAgents();
      
      // Setup API endpoints
      this.setupAPI();
      
      // Initialize scheduler — solo en modo servidor (sin argumentos de línea de comando)
      const isManualMode = process.argv.slice(2).join('').trim().length > 0;
      if (!isManualMode) {
        this.logger.info('Setting up automation scheduler...');
        this.scheduler = new DailyAutomation(this.agents, this.db);
        await this.scheduler.initialize();
      } else {
        this.logger.info('Modo manual — scheduler desactivado.');
      }
      
      this.isInitialized = true;
      this.logger.success('YouTube Automation Agent initialized successfully!');
      
      return true;
    } catch (error) {
      this.logger.error('Failed to initialize:', error);
      return false;
    }
  }

  async initializeAgents() {
    this.agents = {
      strategy: new ContentStrategyAgent(this.db, this.credentials),
      scriptWriter: new ScriptWriterAgent(this.db, this.credentials),
      thumbnailDesigner: new ThumbnailDesignerAgent(this.db, this.credentials),
      seoOptimizer: new SEOOptimizerAgent(this.db, this.credentials),
      production: new ProductionManagementAgent(this.db, this.credentials),
      publishing: new PublishingSchedulingAgent(this.db, this.credentials),
      analytics: new AnalyticsOptimizationAgent(this.db, this.credentials)
    };

    // Initialize each agent
    for (const [name, agent] of Object.entries(this.agents)) {
      await agent.initialize();
      this.logger.info(`✓ ${name} agent initialized`);
    }
  }

  setupAPI() {
    this.app.use(express.json());
    this.app.use(express.static(path.join(__dirname, 'dashboard')));
    
    // Main dashboard route
    this.app.get('/', (req, res) => {
      res.sendFile(path.join(__dirname, 'dashboard', 'index.html'));
    });
    
    // Health check
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        initialized: this.isInitialized,
        agents: Object.keys(this.agents),
        timestamp: new Date().toISOString()
      });
    });

    // Manual content generation
    this.app.post('/generate', async (req, res) => {
      try {
        const { topic, style, length } = req.body;
        const result = await this.generateContent(topic, style, length);
        res.json({ success: true, result });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Get analytics
    this.app.get('/analytics', async (req, res) => {
      try {
        const analytics = await this.agents.analytics.getRecentAnalytics();
        res.json(analytics);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Get upcoming schedule
    this.app.get('/schedule', async (req, res) => {
      try {
        const schedule = await this.db.getUpcomingSchedule();
        res.json(schedule);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Manual publish
    this.app.post('/publish/:contentId', async (req, res) => {
      try {
        const { contentId } = req.params;
        const result = await this.agents.publishing.publishContent(contentId);
        res.json({ success: true, result });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });
  }

  async generateContent(topic = null, options = {}) {
    this.logger.info('Starting content generation pipeline...');

    // Step 0: Purga — limpiar temp/processing/ de material viejo
    // uploads/ se limpia en ProductHunterAgent solo si la API está activa
    this._purgeOldMedia();

    // ═══════════════════════════════════════════════════════════════
    //  ADAPTACIÓN DINÁMICA DE CANTIDAD
    //  Detecta el modo de trabajo, cuenta clips reales disponibles,
    //  y adapta la cantidad final del video al material existente.
    // ═══════════════════════════════════════════════════════════════
    const isLocalMode = DATA_SOURCE_MODE === 'local';
    const modo = isLocalMode ? 'Local' : (DATA_SOURCE_MODE === 'auto' ? 'Auto (API→Local)' : 'API');
    const uploadsDir = path.resolve(__dirname, 'uploads');
    const validVideoExts = ['.mp4', '.mov'];

    // Extraer cantidad solicitada del topic (ej. "5 gadgets para tu cocina" → 5)
    let requestedCount = 25; // default
    if (topic) {
      const countMatch = topic.match(/(\d+)/);
      if (countMatch) requestedCount = Math.max(1, Math.min(25, parseInt(countMatch[1], 10)));
    }

    let availableClips = requestedCount; // se sobreescribirá abajo

    if (isLocalMode) {
      let localClipCount = 0;
      if (fsSync.existsSync(uploadsDir)) {
        localClipCount = fsSync.readdirSync(uploadsDir)
          .filter(f => validVideoExts.includes(path.extname(f).toLowerCase()))
          .length;
      }
      availableClips = localClipCount;
      this.logger.info(`[Detección] Modo Local — ${localClipCount} clips válidos en uploads/`);
    }
    // En modo API, availableClips se recalcula después del Step 2 (hunt)

    // Calcular cantidad adaptada (pre-strategy, para modo local)
    let adaptedCount = Math.min(requestedCount, availableClips);
    if (adaptedCount < 1) adaptedCount = 1;

    console.log(`Modo: ${modo} | Solicitados: ${requestedCount} | Clips válidos: ${availableClips} | Adaptando guion a ${adaptedCount} productos`);
    this.logger.info(`Modo: ${modo} | Solicitados: ${requestedCount} | Clips válidos: ${availableClips} | Adaptando guion a ${adaptedCount} productos`);

    // Step 1: Strategy — GPT-4o genera el Top con array "productos"
    // Inyectar la cantidad adaptada para que el strategy agent la respete
    const strategyTopic = isLocalMode
      ? (topic ? topic.replace(/\d+/, String(adaptedCount)) : topic)
      : topic;
    const strategy = await this.agents.strategy.generateContentStrategy(strategyTopic);
    this.logger.info(`Strategy generated: ${strategy.topic}`);

    if (isLocalMode) {
      strategy.numProductos = adaptedCount;
      if (strategy.productos && strategy.productos.length > adaptedCount) {
        strategy.productos = strategy.productos.slice(0, adaptedCount);
        this.logger.info(`Productos recortados a ${adaptedCount} (adaptación dinámica, modo local)`);
      }
      // Sanear título
      strategy.topic = (strategy.topic || '').replace(/\b(Top|top|TOP)\s+\d+/i, `Top ${adaptedCount}`);
    }
    
    // Step 2: Product Hunter — Busca precios y descarga videos de cada producto
    let huntResults = [];
    if (strategy.productos && Array.isArray(strategy.productos)) {
      this.logger.info(`Cazando ${strategy.productos.length} productos...`);
      const hunter = new ProductHunterAgent();
      const rawHuntResults = await hunter.huntMultipleGadgets(strategy.productos);

      // Filtrado sincronizado: eliminar pares (producto, huntResult) sin media,
      // manteniendo la correspondencia de índices 1:1 entre ambos arrays.
      const paired = strategy.productos.map((prod, i) => ({ prod, hunt: rawHuntResults[i] }));
      const validPairs = paired.filter(({ hunt }) => hunt && hunt.videoPath !== null);

      if (validPairs.length < paired.length) {
        this.logger.info(`Descartados ${paired.length - validPairs.length} productos sin media. ${validPairs.length} productos válidos para el video.`);
      }

      strategy.productos = validPairs.map(({ prod }) => prod);
      huntResults = validPairs.map(({ hunt }) => hunt);

      this.logger.info(`Caza completada: ${huntResults.length} productos con media lista`);

      // ── Modo API: re-adaptar cantidad tras verificar descargas reales ──
      if (!isLocalMode) {
        availableClips = huntResults.length;
        adaptedCount = Math.min(requestedCount, availableClips);
        if (adaptedCount < 1) adaptedCount = 1;

        if (strategy.productos.length > adaptedCount) {
          strategy.productos = strategy.productos.slice(0, adaptedCount);
          huntResults = huntResults.slice(0, adaptedCount);
        }
        strategy.numProductos = adaptedCount;
        strategy.topic = (strategy.topic || '').replace(/\b(Top|top|TOP)\s+\d+/i, `Top ${adaptedCount}`);

        console.log(`Modo: ${modo} | Solicitados: ${requestedCount} | Clips válidos: ${availableClips} | Adaptando guion a ${adaptedCount} productos`);
        this.logger.info(`[Re-adaptación API] Solicitados: ${requestedCount} → Clips descargados: ${availableClips} → Adaptado a ${adaptedCount}`);
      }
    }
    
    // ── Inyectar metadata de adaptación para el script-writer ──
    strategy._requestedCount = requestedCount;
    strategy._adaptedCount = adaptedCount;
    if (requestedCount !== adaptedCount) {
      strategy._adaptationNote = `ATENCIÓN: El usuario pidió ${requestedCount} productos pero solo hay ${adaptedCount} clips de video disponibles. El guion, título y narrativa deben referirse EXCLUSIVAMENTE a ${adaptedCount} productos.`;
      this.logger.info(`Adaptación activa: ${requestedCount} solicitados → ${adaptedCount} con video real`);
    }

    // ═══════════════════════════════════════════════════════════════
    //  BACKFILL DE IDs REALES: Después de la caza, enriquecer
    //  strategy.productos[i] con el ASIN, filename y productId
    //  reales obtenidos de huntResults[i]. Esto garantiza que cuando
    //  el ScriptWriter lea strategy.productos, cada producto ya tenga
    //  su identificador definitivo (no el placeholder api_prod_X).
    //  La correspondencia es 1:1 porque ambos arrays pasaron por el
    //  mismo filtrado sincronizado (paired → validPairs).
    // ═══════════════════════════════════════════════════════════════
    if (strategy.productos && huntResults.length > 0) {
      this.logger.info('── BACKFILL de IDs y Nombres reales (hunt → strategy.productos) ──');
      for (let i = 0; i < strategy.productos.length && i < huntResults.length; i++) {
        const hunt = huntResults[i];
        const prod = strategy.productos[i];
        
        const oldId = prod.id;
        const oldNombre = prod.nombre;

        // Función interna para limpiar el título SEO de Amazon
        const cleanTitle = (title) => {
          if (!title) return '';
          // Normalizar comillas y espacios, quitar comillas sobrantes
          let t = title.replace(/(^\"+|\"+$)/g, '').replace(/\s+/g, ' ').trim();
          // Cortar en la primera coma, guion, barra o paréntesis
          let clean = t.split(/[,|\-\/\(]/)[0].trim();
          // Limitar a 6 palabras máximo
          const words = clean.split(' ');
          return words.length > 6 ? words.slice(0, 6).join(' ') : clean;
        };

        // 1. SINCRONIZACIÓN DE NOMBRE (Con limpieza de longitud)
        if (hunt.productTitle) {
          prod.nombre = cleanTitle(hunt.productTitle);
        } else if (hunt.producto && hunt.producto !== oldNombre) {
          prod.nombre = cleanTitle(hunt.producto);
        }

        // 2. SINCRONIZACIÓN DE IDS Y ARCHIVOS
        if (hunt.asin) {
          prod.id = hunt.asin;
          prod.filename = hunt.filename || `${hunt.asin}.mp4`;
        } else if (hunt.productId) {
          prod.id = hunt.productId;
          prod.filename = hunt.filename || null;
        }
        
        if (hunt.filename && !prod.filename) prod.filename = hunt.filename;
        
        if (oldNombre !== prod.nombre) {
          this.logger.info(`  [${i}] Renombrado limpio: "${oldNombre}" → "${prod.nombre}"`);
        }
        this.logger.info(`  [${i}] ID/File: ${oldId} → ${prod.id}, filename: ${prod.filename || '(none)'}`);
      }
      this.logger.info('── FIN BACKFILL ──');
    }

    // ── NORMALIZACIÓN DE PRECIOS ──
    // Garantiza que TODOS los huntResults tienen precio entero (sin decimales)
    // antes de pasarlos al guionista y al ensamblador de video.
    // Cubre cualquier ruta de datos (API, local, catalog.json).
    for (const hunt of huntResults) {
      if (hunt && hunt.precio && typeof hunt.precio === 'string') {
        const num = parseFloat(hunt.precio.replace(/[^0-9.]/g, ''));
        if (!isNaN(num)) hunt.precio = '$' + Math.round(num);
      }
    }

    // ── MEDICIÓN DE DURACIÓN DE CLIPS (Pre-producción) ──
    // Mide con ffprobe la duración real de cada clip .mp4 descargado
    // y la inyecta en huntResults[i].clipDuration (segundos). El guionista
    // usará este valor para limitar palabras (regla 2.5 wps) y el
    // ensamblador para sincronizar audio↔video con freeze de último frame.
    await this._measureClipDurations(huntResults);

    // ── BUILD INTRO PRODUCTS ORDER ──
    // Se construye AQUÍ, ANTES del guionista, con los productos/clips ya validados.
    // 1) El guionista recibirá introProductsOrder → escribirá el hook en ese orden exacto.
    // 2) El ensamblador recibirá introProductsOrder → mostrará esos clips en ese orden exacto.
    // Resultado: audio del hook y video de intro en sincronía perfecta.
    const introProductsOrder = this._buildIntroProductsOrder(strategy.productos || [], huntResults);
    strategy.introProductsOrder = introProductsOrder;
    this.logger.info(`introProductsOrder (${introProductsOrder.length} clips): [${introProductsOrder.map(p => path.basename(p.videoPath || p.filename || p.id)).join(', ')}]`);

    // Step 3: Script Writing — BYPASS DE CACHÉ: forzar generación nueva
    // Se añade un nonce único a la estrategia para que nunca reutilice guiones previos.
    strategy._scriptNonce = `nonce_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    this.logger.info(`Script nonce: ${strategy._scriptNonce} (bypass de caché)`);
    const script = await this.agents.scriptWriter.generateScript(strategy, huntResults);
    this.logger.info(`Script generated: ${script.title}`);

    // Step 3.5: VÍNCULO POR EXACT-MATCH DE ID — videoPath+precio por filename/productId
    // ═══════════════════════════════════════════════════════════════
    //  ARQUITECTURA UNIVERSAL (Local + API):
    //  Cada sección porta un filename y/o productId inyectado por el
    //  ScriptWriter desde productLines (backfilled con ASINs reales).
    //  Se usa .find() contra huntResults para localizar el video
    //  correcto por identificador exacto — NUNCA por índice [i].
    //  Esto es inmune al orden en que el SO lee uploads/ o en que
    //  la API devuelve resultados.
    // ═══════════════════════════════════════════════════════════════
    const sections = (script.mainContent && script.mainContent.sections) || [];

    this.logger.info('── DIAGNÓSTICO PRE-VÍNCULO ──');
    this.logger.info(`Secciones en script: ${sections.length}`);
    this.logger.info(`HuntResults disponibles: ${huntResults.length}`);
    
    // ═══ INVENTARIO DE HUNTRESULTS ═══
    this.logger.info('┌─ HUNTRESULTS DISPONIBLES:');
    huntResults.forEach((h, idx) => {
      const displayId = h.asin || h.productId || h.id || `unknown_${idx}`;
      const displayFilename = path.basename(h.filename || h.videoPath || '(unknown)');
      this.logger.info(`  [${idx}] ASIN/ID: ${displayId} | Filename: ${displayFilename} | Precio: ${h.precio || 'N/A'}`);
    });
    this.logger.info('└─ FIN INVENTARIO');
    
    // ═══ INVENTARIO DE SECCIONES DEL SCRIPT ═══
    this.logger.info('┌─ SECCIONES DEL SCRIPT:');
    sections.forEach((s, idx) => {
      const id = s.productId || s.filename || s.id || '(sin ID)';
      this.logger.info(`  [${idx}] Título: "${s.title}" | Buscando: productId="${s.productId}" | filename="${s.filename}"`);
    });
    this.logger.info('└─ FIN SECCIONES');

    this.logger.info('── VÍNCULO POR EXACT-MATCH (filename/productId) ──');
    
    // Helper function: fuzzy match para casos donde exact-match falla
    const fuzzyMatch = (searchTerm, candidates) => {
      if (!searchTerm) return null;
      
      // Primero: buscar exact
      let match = candidates.find(c => c === searchTerm);
      if (match) return match;
      
      // Segundo: buscar substring (e.g., "B07HWNSYD" en "B07HWNSYD.mp4")
      match = candidates.find(c => c && c.includes(searchTerm));
      if (match) return match;
      
      // Tercero: buscar sin extensión (e.g., "B07HWNSYD" vs "B07HWNSYD.mp4")
      const searchClean = searchTerm.replace(/\.[^/.]+$/, ''); // quitar extensión
      match = candidates.find(c => c && c.replace(/\.[^/.]+$/, '') === searchClean);
      if (match) return match;
      
      return null;
    };

    const diagnosticLog = {
      totalSections: sections.length,
      matched: 0,
      unmatched: [],
      details: []
    };

    for (let i = 0; i < sections.length; i++) {
      const sec = sections[i];
      const targetFilename = sec.filename || null;
      const targetId = sec.productId || null;

      // Buscar por filename exacto (prioridad)
      let matchedHunt = null;
      let matchMethod = null;
      
      if (targetFilename) {
        // Exact match por filename
        matchedHunt = huntResults.find(h => h && h.filename === targetFilename);
        if (matchedHunt) matchMethod = 'exact-filename';
        
        // Fuzzy match si exact falla
        if (!matchedHunt) {
          const allFilenames = huntResults.map(h => h.filename).filter(f => f);
          const fuzzyFilename = fuzzyMatch(targetFilename, allFilenames);
          if (fuzzyFilename) {
            matchedHunt = huntResults.find(h => h && h.filename === fuzzyFilename);
            matchMethod = 'fuzzy-filename';
          }
        }
      }
      
      // Fallback: buscar por productId/asin exacto
      if (!matchedHunt && targetId) {
        matchedHunt = huntResults.find(h => h && (h.productId === targetId || h.asin === targetId));
        if (matchedHunt) matchMethod = 'exact-asin';
        
        // Fuzzy match en ASINs
        if (!matchedHunt) {
          const allAsins = huntResults.map(h => h.asin || h.productId).filter(a => a);
          const fuzzyId = fuzzyMatch(targetId, allAsins);
          if (fuzzyId) {
            matchedHunt = huntResults.find(h => h && (h.asin === fuzzyId || h.productId === fuzzyId));
            matchMethod = 'fuzzy-asin';
          }
        }
      }

      if (matchedHunt && matchedHunt.videoPath) {
        sec.videoPath = matchedHunt.videoPath;
        sec.precio = matchedHunt.precio || null;
        sec.productPhoto = matchedHunt.productPhoto || null;
        // Multi-source pipeline (Bloque 3-4): propagar assets descargados + scoring vision
        sec.assets = matchedHunt.assets || { images: [], videos: [] };
        sec.scoredAssets = Array.isArray(matchedHunt.scoredAssets) ? matchedHunt.scoredAssets : [];
        sec.features = Array.isArray(matchedHunt.features) ? matchedHunt.features : [];
        // Reforzar filename/productId desde huntResults (fuente de verdad post-descarga)
        if (matchedHunt.filename) sec.filename = matchedHunt.filename;
        if (matchedHunt.productId || matchedHunt.asin) sec.productId = matchedHunt.productId || matchedHunt.asin;
        
        diagnosticLog.matched++;
        diagnosticLog.details.push({
          sectionIndex: i,
          title: sec.title,
          method: matchMethod,
          matchedId: matchedHunt.asin || matchedHunt.productId
        });
        
        this.logger.info(`  [${i}] ✅ "${sec.title}" ← ${require('path').basename(matchedHunt.videoPath)} [${sec.productId}] (${matchMethod})`);
      } else {
        sec.videoPath = null;
        sec.precio = null;
        sec.productPhoto = matchedHunt ? (matchedHunt.productPhoto || null) : null;
        
        diagnosticLog.unmatched.push({
          sectionIndex: i,
          title: sec.title,
          searchedFilename: targetFilename,
          searchedId: targetId,
          availableAsins: huntResults.map(h => h.asin || h.productId || '?').join(', ')
        });
        
        this.logger.warn(`  [${i}] ❌ "${sec.title}" ← SIN VIDEO COINCIDENTE`);
        this.logger.warn(`         Buscó: filename="${targetFilename}", productId="${targetId}"`);
        this.logger.warn(`         Disponibles en huntResults: [${huntResults.map(h => h.asin || h.productId || '?').join(', ')}]`);
      }
    }

    // ═══════════════════════════════════════════════════════════════
    //  REPORTE DE DIAGNÓSTICO PRE-RESILIENCIA
    // ═══════════════════════════════════════════════════════════════
    this.logger.info('┌─ REPORTE DE EMPAREJAMIENTO:');
    this.logger.info(`  Exitosos: ${diagnosticLog.matched}/${sections.length}`);
    if (diagnosticLog.unmatched.length > 0) {
      this.logger.warn(`  ❌ Fallidos: ${diagnosticLog.unmatched.length}`);
      diagnosticLog.unmatched.forEach(um => {
        this.logger.warn(`    [${um.sectionIndex}] "${um.title}"`);
        this.logger.warn(`         Buscado: filename="${um.searchedFilename}", id="${um.searchedId}"`);
        this.logger.warn(`         Disponibles: ${um.availableAsins}`);
      });
    }
    this.logger.info('└─ FIN REPORTE');

    // ═══════════════════════════════════════════════════════════════
    //  RESILIENCIA ANTE FALTANTES: Si hay secciones sin video,
    //  recortar el guion para renderizar SOLO las que tienen coincidencia
    //  exacta. Se preserva la coherencia absoluta voz ↔ imagen.
    // ═══════════════════════════════════════════════════════════════
    const sectionsWithoutVideo = sections.filter(s => !s.videoPath);
    if (sectionsWithoutVideo.length > 0 && sections.length > sectionsWithoutVideo.length) {
      const originalCount = sections.length;
      // Filtrar in-place: solo mantener secciones con video
      const validSections = sections.filter(s => s.videoPath);
      script.mainContent.sections = validSections;
      script.mainContent.totalDuration = validSections.length * PER_PRODUCT_DURATION_DEFAULT;
      // Actualizar título si cambió la cantidad
      const newCount = validSections.length;
      if (script.title) {
        script.title = script.title.replace(/\b(Top|top|TOP)\s+\d+/i, `Top ${newCount}`);
      }
      this.logger.warn(`\n⚠️  RESILIENCIA ACTIVADA:`);
      this.logger.warn(`    ${sectionsWithoutVideo.length} secciones sin video descartadas:`);
      diagnosticLog.unmatched.forEach(um => {
        this.logger.warn(`      - "${um.title}" (buscó: ${um.searchedId || um.searchedFilename})`);
      });
      this.logger.warn(`    Resultado: ${newCount}/${originalCount} productos en el guion\n`);
    } else if (sectionsWithoutVideo.length > 0 && sectionsWithoutVideo.length === sections.length) {
      this.logger.error('  ❌ TODAS las secciones sin video — el video no puede generarse.');
    }
    this.logger.info('── FIN VÍNCULO POSICIONAL ──');

    // ── SYNC INTRO PRODUCTS ORDER post-resiliencia ──
    // Si alguna sección fue descartada (sin video), eliminar ese producto de
    // introProductsOrder para que el hook y los clips queden perfectamente alineados.
    if (strategy.introProductsOrder && strategy.introProductsOrder.length > 0) {
      const finalSections = script.mainContent?.sections || [];
      const finalFilenames  = new Set(finalSections.map(s => s.filename).filter(Boolean));
      const finalIds        = new Set(finalSections.map(s => s.productId).filter(Boolean));
      const finalVideoBases = new Set(finalSections.map(s => s.videoPath ? path.basename(s.videoPath) : null).filter(Boolean));
      strategy.introProductsOrder = strategy.introProductsOrder.filter(item => {
        const itemVideoBase = item.videoPath ? path.basename(item.videoPath) : null;
        return (item.filename  && finalFilenames.has(item.filename))  ||
               (item.id        && finalIds.has(item.id))              ||
               (itemVideoBase  && finalVideoBases.has(itemVideoBase));
      });
      this.logger.info(`introProductsOrder post-resiliencia: ${strategy.introProductsOrder.length} clips activos`);
    }

    // Step 4: Thumbnail Design
    // Llamada explícita con datos directos de huntResults (producto + foto Amazon)
    let thumbnail;
    const firstHuntWithPhoto = huntResults.find(h => h && h.productPhoto);
    const firstSectionTitle = script.mainContent?.sections?.[0]?.title || script.title;

    if (firstHuntWithPhoto && this.agents.thumbnailDesigner.falEnabled) {
      try {
        const productTitle = firstSectionTitle;
        const photoUrl     = firstHuntWithPhoto.productPhoto;
        this.logger.info(`[Thumbnail] fal.ai → "${productTitle.substring(0, 60)}" ← ${photoUrl.substring(0, 60)}...`);

        const miniaturaUrl = await this.agents.thumbnailDesigner.procesarMiniaturaProducto(
          productTitle,
          photoUrl
        );

        // Descargar la imagen generada y guardarla como archivo local
        const thumbPath = path.join(__dirname, 'uploads', 'thumbnails', `thumbnail_optimized_${Date.now()}.jpg`);
        const dlRes = await axios.get(miniaturaUrl, { responseType: 'arraybuffer', timeout: 60000, headers: { 'User-Agent': 'Mozilla/5.0' } });
        fsSync.writeFileSync(thumbPath, Buffer.from(dlRes.data));
        await this.db.saveThumbnail({ path: thumbPath, dimensions: { width: 1920, height: 1080 }, fileSize: fsSync.statSync(thumbPath).size, createdAt: new Date().toISOString() });
        thumbnail = { path: thumbPath, dimensions: { width: 1920, height: 1080 }, fileSize: fsSync.statSync(thumbPath).size, createdAt: new Date().toISOString() };
        this.logger.info(`[Thumbnail] Miniatura fal.ai guardada: ${path.basename(thumbPath)}`);
      } catch (falErr) {
        this.logger.warn(`[Thumbnail] fal.ai explícito falló (${falErr.message}) — usando generateThumbnail como fallback`);
      }
    }

    if (!thumbnail) {
      thumbnail = await this.agents.thumbnailDesigner.generateThumbnail(script);
    }
    this.logger.info('Thumbnail generated');
    
    // Step 5: SEO Optimization
    const seoData = await this.agents.seoOptimizer.optimize(script, strategy);
    this.logger.info('SEO optimization complete');
    
    // Step 6: Production Management
    const productionData = await this.agents.production.processContent({
      strategy,
      script,
      thumbnail,
      seo: seoData,
      huntResults,
      introProductsOrder: strategy.introProductsOrder || []
    });
    this.logger.info('Production processing complete');
    
    // ═══════════════════════════════════════════════════════════════
    // Step 6.5: VIDEO ENCODING OPTIMIZATION (CFR + H.264 + AAC)
    // ═══════════════════════════════════════════════════════════════
    // Aplica estándares de codificación estrictos a TODOS los videos:
    //   ✓ CFR (Constant Framerate) - elimina desincronización móvil
    //   ✓ H.264 + AAC - codecs universales
    //   ✓ Resoluções optimizadas por formato
    //   ✓ Faststart para streaming
    // ═══════════════════════════════════════════════════════════════
    try {
      this.logger.info('\n════════════════════════════════════════════════════════════');
      this.logger.info('Step 6.5: VIDEO ENCODING (CFR + H.264 + AAC)');
      this.logger.info('════════════════════════════════════════════════════════════');
      
      throw new Error("Desactivado para acelerar la producción");

      const encoder = new VideoEncoder();
      let encodedCount = 0;
      let failedCount = 0;

      // ─── CODIFICAR VIDEO LARGO (16:9) ───
      if (productionData.assets?.finalVideo?.path) {
        const videoPath = productionData.assets.finalVideo.path;
        const optimizedPath = videoPath.replace(/\.mp4$/, '_optimized.mp4');
        
        if (fsSync.existsSync(videoPath)) {
          this.logger.info(`\n🎬 [1/3] Optimizando video largo (16:9 - 1920x1080, 30fps CFR)...`);
          
          try {
            const result = await encoder.encodeVideo(
              videoPath,
              optimizedPath,
              'horizontal',
              { timeout: 600000 }  // 10 minutos
            );
            
            // Reemplazar con versión optimizada
            fsSync.unlinkSync(videoPath);
            fsSync.renameSync(optimizedPath, videoPath);
            productionData.assets.finalVideo.optimized = true;
            productionData.assets.finalVideo.codec = 'h264+aac';
            productionData.assets.finalVideo.fps = result.fps;
            
            this.logger.success(`✅ Video largo: ${result.sizeMB}MB, ${result.fps}fps, ${result.bitrate}`);
            encodedCount++;
          } catch (encErr) {
            this.logger.error(`❌ Error codificando video largo: ${encErr.message}`);
            // Limpiar archivo parcial si existe
            if (fsSync.existsSync(optimizedPath)) {
              try { fsSync.unlinkSync(optimizedPath); } catch (_) {}
            }
            failedCount++;
            // Continuar con versión cruda
          }
        }
      }

      // ─── CODIFICAR SHORT INTRO (9:16) ───
      if (productionData.assets?.shortVideos?.intro?.path) {
        const shortPath = productionData.assets.shortVideos.intro.path;
        const optimizedPath = shortPath.replace(/\.mp4$/, '_optimized.mp4');
        
        if (fsSync.existsSync(shortPath)) {
          this.logger.info(`\n🎬 [2/3] Optimizando short intro (9:16 - 1080x1920, 30fps CFR)...`);
          
          try {
            const result = await encoder.encodeVideo(
              shortPath,
              optimizedPath,
              'vertical',
              { timeout: 300000 }  // 5 minutos
            );
            
            fsSync.unlinkSync(shortPath);
            fsSync.renameSync(optimizedPath, shortPath);
            productionData.assets.shortVideos.intro.optimized = true;
            productionData.assets.shortVideos.intro.codec = 'h264+aac';
            productionData.assets.shortVideos.intro.fps = result.fps;
            
            this.logger.success(`✅ Short intro: ${result.sizeMB}MB, ${result.fps}fps, ${result.bitrate}`);
            encodedCount++;
          } catch (encErr) {
            this.logger.error(`❌ Error codificando short intro: ${encErr.message}`);
            if (fsSync.existsSync(optimizedPath)) {
              try { fsSync.unlinkSync(optimizedPath); } catch (_) {}
            }
            failedCount++;
          }
        }
      }

      // ─── CODIFICAR PRODUCT SHORTS (9:16) ───
      if (productionData.assets?.shortVideos?.products && 
          Array.isArray(productionData.assets.shortVideos.products) &&
          productionData.assets.shortVideos.products.length > 0) {
        
        const productShorts = productionData.assets.shortVideos.products;
        this.logger.info(`\n🎬 [3/3] Optimizando ${productShorts.length} product shorts (9:16)...`);
        
        for (let i = 0; i < productShorts.length; i++) {
          const pShort = productShorts[i];
          const productName = pShort.productName || `Producto ${i + 1}`;
          
          if (!pShort.videoPath || !fsSync.existsSync(pShort.videoPath)) {
            this.logger.warn(`  [${i + 1}/${productShorts.length}] ⏭️  "${productName}" (sin video local)`);
            continue;
          }
          
          const optimizedPath = pShort.videoPath.replace(/\.mp4$/, '_optimized.mp4');
          
          try {
            const result = await encoder.encodeVideo(
              pShort.videoPath,
              optimizedPath,
              'vertical',
              { timeout: 300000 }
            );
            
            fsSync.unlinkSync(pShort.videoPath);
            fsSync.renameSync(optimizedPath, pShort.videoPath);
            pShort.optimized = true;
            pShort.codec = 'h264+aac';
            pShort.fps = result.fps;
            
            this.logger.success(`  [${i + 1}/${productShorts.length}] ✅ "${productName}": ${result.sizeMB}MB, ${result.fps}fps`);
            encodedCount++;
          } catch (encErr) {
            this.logger.error(`  [${i + 1}/${productShorts.length}] ❌ "${productName}": ${encErr.message}`);
            if (fsSync.existsSync(optimizedPath)) {
              try { fsSync.unlinkSync(optimizedPath); } catch (_) {}
            }
            failedCount++;
          }
        }
      }

      // ═══ RESUMEN ═══
      this.logger.info(`\n════════════════════════════════════════════════════════════`);
      this.logger.info(`Step 6.5 RESUMEN: ${encodedCount} video(s) optimizado(s) con éxito`);
      if (failedCount > 0) {
        this.logger.warn(`                  ${failedCount} video(s) mantienen versión cruda`);
      }
      this.logger.info(`════════════════════════════════════════════════════════════\n`);
      
    } catch (encoderInitErr) {
      this.logger.warn(`⚠️  Step 6.5 abortado (init error): ${encoderInitErr.message}`);
      this.logger.warn(`    Los videos se distribuirán SIN optimización (versión cruda)\n`);
    }
    
    // Step 7: Save to database
    const contentId = await this.db.saveProductionData(productionData);
    this.logger.info(`Content saved with ID: ${contentId}`);

    // Step 8: Generar enlaces de afiliado
    this.generarEnlacesAfiliado(script);

    // Step 9: Publicar a YouTube (siempre obligatorio, independiente del modo)
    // ═══ PUBLICAR DOS VIDEOS: Largo (16:9) + Short (9:16) ═══
    let youtubeUrl = null;
    let shortUrl = null;
    const productShortResults = [];
    
    // Extraer paths de videos desde productionData (faltaban estas variables)
    const finalVideoPath = productionData.assets?.finalVideo?.path;
    const shortVideoPath = productionData.assets?.shortVideos?.intro?.path;
    const productShorts = productionData.assets?.shortVideos?.products || [];
    
    try {
      
      // ═══ LLAMADA 1: PUBLICAR VIDEO LARGO (16:9) CON MINIATURA ═══
      this.logger.info(`\n════════════════════════════════════════════════════════════`);
      this.logger.info(`Step 9A: Publicando VIDEO LARGO (16:9) en YouTube...`);
      this.logger.info(`         [video: ${finalVideoPath}]`);
      this.logger.info(`════════════════════════════════════════════════════════════`);
      
      try {
        const scheduleEntryLong = await this.agents.publishing.scheduleContent(
          productionData, 
          'long'  // Video largo con thumbnail
        );
        const publishedLong = await this.agents.publishing.publishContent(productionData.id);
        youtubeUrl = publishedLong.youtubeUrl || null;
        
        if (youtubeUrl) {
          this.logger.success(`✅ [YouTube] Video LARGO publicado: ${youtubeUrl}`);
          
          // 🧠 INYECCIÓN POSTPUBLISH: Actualizar memoria de productos
          await this._updateProductMemoryAfterPublish(script, productionData, youtubeUrl);
        }
      } catch (longErr) {
        this.logger.error(`❌ Error al publicar video largo: ${longErr.message}`);
        this.logger.error(longErr.stack);
      }
      
      // ═══ LLAMADA 2: PUBLICAR SHORT (9:16) SIN MINIATURA ═══
      if (shortVideoPath) {
        this.logger.info(`\n════════════════════════════════════════════════════════════`);
        this.logger.info(`Step 9B: Publicando SHORT (9:16) en YouTube...`);
        this.logger.info(`         [video: ${shortVideoPath}]`);
        this.logger.info(`════════════════════════════════════════════════════════════`);
        
        try {
          const scheduleEntryShort = await this.agents.publishing.scheduleContent(
            productionData, 
            'short'  // Short sin thumbnail (usa frame del video)
          );
          const publishedShort = await this.agents.publishing.publishContent(productionData.id);
          shortUrl = publishedShort.youtubeUrl || null;
          
          if (shortUrl) {
            this.logger.success(`✅ [YouTube] Short publicado: ${shortUrl}`);
          }
        } catch (shortErr) {
          this.logger.error(`❌ Error al publicar Short: ${shortErr.message}`);
          this.logger.error(shortErr.stack);
          // No interrumpir — el video largo ya se publicó exitosamente
        }
      } else {
        this.logger.warn(`⚠️  No Short disponible (no se generó intro_short.mp4)`);
      }
      
      // ═══ LLAMADA 3: PUBLICAR PRODUCT SHORTS (9:16) COMO "UNLISTED" ═══
      if (productShorts && productShorts.length > 0) {
        this.logger.info(`\n════════════════════════════════════════════════════════════`);
        this.logger.info(`Step 9C: Subiendo ${productShorts.length} PRODUCT SHORTS como "No Listados"...`);
        this.logger.info(`         (Para revisión manual, SIN publicación automática)`);
        this.logger.info(`════════════════════════════════════════════════════════════`);
        
        // Preparar metadata general para los shorts (SEO, captions, etc)
        const generalMetadata = {
          seo: productionData.seo || {},
          captions: productionData.assets?.captions || null,
          affiliateUrl: productionData.affiliateUrl || '',
          categoryId: productionData.seo?.metadata?.category || '28',
          language: productionData.seo?.metadata?.language || 'es'
        };
        
        // Iterar sobre cada product short con try-catch individual
        for (let i = 0; i < productShorts.length; i++) {
          const productShort = productShorts[i];
          const shortNumber = i + 1;
          
          this.logger.info(`\n[ProductShorts] Subiendo [${shortNumber}/${productShorts.length}]: "${productShort.productName}"`);
          
          try {
            // Llamar a la función de publicación del Publishing Agent
            const uploadResult = await this.agents.publishing.publishProductShort(
              productShort,
              generalMetadata
            );
            
            // Agregar a resultados exitosos
            productShortResults.push({
              status: 'success',
              ...uploadResult
            });
            
            this.logger.success(`✅ Product short "${productShort.productName}" subido: ${uploadResult.webUrl}`);
            
          } catch (productShortErr) {
            // Capturar error sin interrumpir el pipeline
            const errorCode = productShortErr.errorCode || 'UNKNOWN_ERROR';
            const errorDetail = productShortErr.errorMessage || productShortErr.message || 'Unknown error';
            
            this.logger.error(`\n❌ Error subiendo producto "${productShort.productName}" [${errorCode}]`);
            this.logger.error(`   Detalle: ${errorDetail}`);
            
            // Verificar si es error de cuota
            if (errorCode === 'quotaExceeded' || errorDetail.includes('quota')) {
              this.logger.warn(`\n⚠️  LÍMITE DE CUOTA API ALCANZADO`);
              this.logger.warn(`    Los siguientes ${productShorts.length - i} shorts NO se pudieron subir.`);
              this.logger.warn(`    Por favor, intenta nuevamente mañana o aumenta tu cuota en Google Cloud Console.`);
              this.logger.warn(`    Productos pendientes: ${productShorts.slice(i).map(p => `"${p.productName}"`).join(', ')}`);
              
              // Registrar los que faltaron
              productShorts.slice(i).forEach(p => {
                productShortResults.push({
                  status: 'failed',
                  productId: p.productId,
                  productName: p.productName,
                  errorCode: 'quotaExceeded',
                  errorMessage: 'Límite de cuota de la API de YouTube alcanzado'
                });
              });
              
              break;  // Salir del loop — no usar más cuota hoy
            }
            
            // Para otros errores: registrar pero continuar
            productShortResults.push({
              status: 'failed',
              productId: productShort.productId,
              productName: productShort.productName,
              errorCode,
              errorMessage: errorDetail
            });
          }
        }
        
        // Resumen de publicación de product shorts
        this.logger.info(`\n════════════════════════════════════════════════════════════`);
        const successful = productShortResults.filter(r => r.status === 'success').length;
        const failed = productShortResults.filter(r => r.status === 'failed').length;
        this.logger.info(`Step 9C RESUMEN: ${successful}/${productShorts.length} product shorts subidos exitosamente`);
        if (failed > 0) {
          this.logger.warn(`                 ${failed} producto(s) fallaron en la subida`);
        }
        this.logger.info(`════════════════════════════════════════════════════════════`);
        
      } else {
        this.logger.warn(`⚠️  No hay product shorts disponibles`);
      }
      
    } catch (pubErr) {
      this.logger.error(`[YouTube] Error general al publicar: ${pubErr.message}`);
      // No interrumpir el pipeline — el video ya está guardado localmente
    }
    
    // ═══════════════════════════════════════════════════════════════
    // Step 9E: PUBLICACIÓN EN TIKTOK (Post-YouTube)
    // ═══════════════════════════════════════════════════════════════
    let tiktokPublishResults = {
      status: 'skipped',
      reason: 'No video short disponible'
    };
    
    try {
      // Usar el short video intro (9:16) para TikTok
      const tiktokVideoPath = productionData.assets?.shortVideos?.intro?.path;
      
      if (tiktokVideoPath && fsSync.existsSync(tiktokVideoPath)) {
        this.logger.info(`\n════════════════════════════════════════════════════════════`);
        this.logger.info(`Step 9E: Publicando en TikTok...`);
        this.logger.info(`════════════════════════════════════════════════════════════`);
        
        // Instanciar TikTokPublishingAgent
        const tiktokAgent = new TikTokPublishingAgent(this.db, this.credentials);
        const initialized = await tiktokAgent.initialize();
        
        if (!initialized) {
          this.logger.warn(`⚠️  TikTok agent no pudo inicializarse. Saltando publicación TikTok.`);
          tiktokPublishResults = {
            status: 'skipped',
            reason: 'Agent initialization failed'
          };
        } else {
          // Preparar metadatos desde script
          const tiktokMetadata = {
            title: script.title || 'Video producto',
            description: script.shortDescription || script.description || `Descubre este increíble producto. #shorts #recomendación`,
            hashtags: seoData?.hashtags?.slice(0, 10) || ['#shorts', '#recomendación', '#gadgets']
          };
          
          // Publicar en TikTok
          const videoSizeMB = (fsSync.statSync(tiktokVideoPath).size / (1024 * 1024)).toFixed(2);
          this.logger.info(`Iniciando carga a TikTok (${videoSizeMB}MB)...`);
          tiktokPublishResults = await tiktokAgent.publishVideo(tiktokVideoPath, tiktokMetadata);
          
          if (tiktokPublishResults.status === 'success') {
            this.logger.success(`✅ Publicación en TikTok exitosa`);
            this.logger.success(`   🔗 URL: ${tiktokPublishResults.videoUrl || 'Procesando...'}`);
            this.logger.success(`   ⏱️  Tiempo: ${tiktokPublishResults.duration}s`);
          } else {
            this.logger.warn(`⚠️  Publicación en TikTok falló: ${tiktokPublishResults.error}`);
          }
        }
      } else {
        this.logger.warn(`⚠️  No hay video short disponible para TikTok. Saltando...`);
      }
      
    } catch (tiktokErr) {
      this.logger.error(`❌ Error en Step 9E (TikTok Publishing): ${tiktokErr.message}`);
      tiktokPublishResults = {
        status: 'failed',
        error: tiktokErr.message
      };
      // No interrumpir pipeline — TikTok es distribución opcional
    }
    
    return {
      contentId,
      title: script.title,
      scheduledFor: productionData.scheduledPublishTime,
      youtubeUrl,
      shortUrl,
      productShortResults: productShortResults,
      tiktokPublishResults: tiktokPublishResults
    };
  }

  /**
   * Genera comentarios_youtube.txt con enlaces de afiliado para cada producto del guion.
   */
  generarEnlacesAfiliado(script) {
    const tag = process.env.AMAZON_AFFILIATE_TAG || '';
    const sections = (script.mainContent && script.mainContent.sections) || [];

    if (sections.length === 0) {
      this.logger.warn('generarEnlacesAfiliado: sin secciones en el guion, omitiendo.');
      return;
    }

    const lines = [`🔗 ENLACES DE AFILIADO — ${script.title || 'Video'}\n`];

    for (let i = 0; i < sections.length; i++) {
      const sec = sections[i];
      const asin = sec.productId || sec.asin || null;
      const nombre = sec.title || sec.productName || `Producto ${i + 1}`;

      if (asin) {
        const url = `https://www.amazon.com/dp/${asin}${tag ? `?tag=${tag}` : ''}`;
        lines.push(`${i + 1}. ${nombre}\n   ${url}\n`);
      } else {
        lines.push(`${i + 1}. ${nombre}\n   (sin ASIN disponible)\n`);
      }
    }

    const outputPath = path.resolve(__dirname, 'comentarios_youtube.txt');
    fsSync.writeFileSync(outputPath, lines.join(''), 'utf8');
    this.logger.info(`✅ comentarios_youtube.txt generado con ${sections.length} enlaces → ${outputPath}`);
  }

  /**
   * Selecciona aleatoriamente los productos que aparecerán en la introducción.
   * El array resultante (introProductsOrder) es la fuente de verdad para:
   *   1) el hook del guionista (menciona los productos en este orden exacto)
   *   2) el ensamblador de video (muestra los clips en este orden exacto)
   *
   * Reglas de cantidad:
   *   > 5 productos disponibles → exactamente 5 (aleatorios)
   *   2 a 5 productos         → número aleatorio entre 2 y el total
   *   1 producto              → devolver ese producto
   *
   * @param {Array} productos  - strategy.productos (ya backfilled con IDs reales)
   * @param {Array} huntResults - resultados sincronizados de huntMultipleGadgets
   * @returns {Array<{nombre, id, filename, videoPath}>}
   */
  /**
   * Pre-producción: mide la duración real (segundos) de cada clip .mp4
   * descargado/local con ffprobe y la inyecta en huntResults[i].clipDuration.
   * También backfilla uploads/catalog.json para reutilización en runs futuros.
   */
  async _measureClipDurations(huntResults) {
    const ffmpeg = require('fluent-ffmpeg');
    const probe = (file) => new Promise((resolve) => {
      ffmpeg.ffprobe(file, (err, meta) => {
        if (err || !meta || !meta.format) return resolve(null);
        const d = parseFloat(meta.format.duration);
        resolve(isFinite(d) && d > 0 ? d : null);
      });
    });

    this.logger.info('── MEDICIÓN DE DURACIÓN DE CLIPS (ffprobe) ──');
    for (const hunt of huntResults) {
      if (!hunt || !hunt.videoPath || !fsSync.existsSync(hunt.videoPath)) continue;
      const dur = await probe(hunt.videoPath);
      if (dur) {
        hunt.clipDuration = +dur.toFixed(2);
        this.logger.info(`  ${path.basename(hunt.videoPath)} → ${hunt.clipDuration}s`);
      } else {
        this.logger.warn(`  ${path.basename(hunt.videoPath)} → no medible`);
      }
    }

    // Persistir en uploads/catalog.json (solo entradas que ya existen)
    try {
      const catalogPath = path.resolve(__dirname, 'uploads', 'catalog.json');
      if (fsSync.existsSync(catalogPath)) {
        const catalog = JSON.parse(fsSync.readFileSync(catalogPath, 'utf8'));
        if (catalog && Array.isArray(catalog.products)) {
          let touched = false;
          for (const hunt of huntResults) {
            if (!hunt || !hunt.clipDuration) continue;
            const fname = hunt.filename || (hunt.videoPath ? path.basename(hunt.videoPath) : null);
            const entry = catalog.products.find(p =>
              (fname && p.file === fname) || (hunt.asin && p.asin === hunt.asin)
            );
            if (entry && entry.clipDuration !== hunt.clipDuration) {
              entry.clipDuration = hunt.clipDuration;
              touched = true;
            }
          }
          if (touched) {
            fsSync.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));
            this.logger.info('  catalog.json actualizado con clipDuration');
          }
        }
      }
    } catch (e) {
      this.logger.warn(`  No se pudo persistir clipDuration en catalog.json: ${e.message}`);
    }
    this.logger.info('── FIN MEDICIÓN DURACIÓN ──');
  }

  _buildIntroProductsOrder(productos, huntResults) {
    const candidates = [];
    for (let i = 0; i < productos.length && i < huntResults.length; i++) {
      const prod = productos[i];
      const hunt = huntResults[i];
      if (!hunt || !hunt.videoPath) continue;
      candidates.push({
        nombre: (typeof prod === 'object' ? prod.nombre : prod) || hunt.productTitle || `Producto ${i + 1}`,
        id:     (typeof prod === 'object' ? prod.id : null) || hunt.productId || hunt.asin || `prod_${i}`,
        filename: path.basename(hunt.videoPath),
        videoPath: hunt.videoPath
      });
    }

    if (candidates.length <= 1) return [...candidates];

    // Fisher-Yates shuffle — selección verdaderamente aleatoria en cada run
    const shuffled = [...candidates];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    let count;
    // Para garantizar un gancho de 28 a 40 segundos, necesitamos entre 7 y 10 clips en pantalla.
    if (candidates.length >= 10) {
      count = Math.floor(Math.random() * 4) + 7; // Aleatorio entre 7 y 10
    } else if (candidates.length > 3) {
      // Si hay pocos productos, usamos la mayoría para acercarnos al tiempo objetivo
      const minClips = Math.max(3, Math.floor(candidates.length * 0.8));
      count = Math.floor(Math.random() * (candidates.length - minClips + 1)) + minClips;
    } else {
      count = candidates.length;
    }

    return shuffled.slice(0, count);
  }

  /**
   * Elimina archivos viejos de temp/processing/ para cada ejecución.
   * uploads/ NO se purga cuando el modo es local (RapidAPI desconectada),
   * ya que los videos de uploads/ son el material fuente.
   */
  _purgeOldMedia() {
    const extensions = ['.mp4', '.mp3', '.m4a', '.jpg', '.jpeg'];
    const dirs = [
      path.resolve(__dirname, 'temp', 'processing')
    ];

    for (const dir of dirs) {
      if (!fsSync.existsSync(dir)) continue;
      const files = fsSync.readdirSync(dir)
        .filter(f => extensions.includes(path.extname(f).toLowerCase()));
      for (const file of files) {
        try {
          fsSync.unlinkSync(path.join(dir, file));
        } catch (_) { /* ignore */ }
      }
      if (files.length > 0) {
        this.logger.info(`Purga: ${files.length} archivos eliminados de ${path.basename(dir)}/`);
      }
    }
  }

  async start() {
    const initialized = await this.initialize();
    
    if (!initialized) {
      console.log(chalk.red('\n❌ Failed to initialize. Please check your configuration.'));
      process.exit(1);
    }
    
    const PORT = process.env.PORT || 3456;
    this.app.listen(PORT, () => {
      console.log(chalk.green(`\n✅ YouTube Automation Agent running on port ${PORT}`));
      console.log(chalk.gray('─'.repeat(50)));
      console.log(chalk.white('📊 Dashboard: ') + chalk.cyan(`http://localhost:${PORT}`));
      console.log(chalk.white('🔧 API Health: ') + chalk.cyan(`http://localhost:${PORT}/health`));
      console.log(chalk.white('📅 Schedule: ') + chalk.cyan(`http://localhost:${PORT}/schedule`));
      console.log(chalk.white('📈 Analytics: ') + chalk.cyan(`http://localhost:${PORT}/analytics`));
      console.log(chalk.gray('─'.repeat(50)));
      console.log(chalk.yellow('\n🤖 Automation is active. Content will be generated and posted daily.'));
    });
  }

  /**
   * MEMORIA DUAL: Actualiza historial de productos + patrones ganadores
   * después de publicación exitosa en YouTube.
   * Se llama cuando youtubeUrl está presente (confirmación de éxito).
   * 
   * @param {Object} script - guion con mainContent.sections[].{title, productId}
   * @param {Object} productionData - datos de producción con id, seo, scheduledPublishTime
   * @param {String} youtubeUrl - URL confirmada del video publicado
   */
  async _updateProductMemoryAfterPublish(script, productionData, youtubeUrl) {
    try {
      if (!script || !script.mainContent || !Array.isArray(script.mainContent.sections)) {
        this.logger.warn('⚠️  Script sin secciones, memoria no actualizada');
        return;
      }

      const sections = script.mainContent.sections;
      
      this.logger.info('\n🧠 ACTUALIZACIÓN DE MEMORIA DUAL...');

      // Extraer categoría del SEO (fallback a 'general')
      const category = productionData?.seo?.metadata?.category 
        || productionData?.seo?.category 
        || 'general';

      // Iterar sobre cada producto en el guion
      for (const section of sections) {
        const productName = section.title || section.productName || 'Unknown';
        const productId = section.productId || section.asin || null;

        // Agregar a historial
        await this.db.addProductToHistory({
          productName: productName,
          category: category,
          youtubeUrl: youtubeUrl,
          youtubeId: youtubeUrl ? youtubeUrl.split('/').pop() : null,
          title: script.title || ''
        });

        this.logger.info(`   ✓ ${productName} → historial actualizado`);
      }

      // Actualizar patrones ganadores (análisis de categorías)
      await this.db.updateWinningPatterns();
      this.logger.info(`   ✓ Patrones ganadores analizados\n`);

    } catch (error) {
      this.logger.error('Error actualizando memoria de productos:', error.message);
      // No interrumpir el pipeline — es una operación secundaria
    }
  }
}

// Start the agent
if (require.main === module) {
  const rawArgs = process.argv.slice(2);
  const shouldPublish = rawArgs.includes('--publish');
  const userTopic = rawArgs.filter(a => a !== '--publish').join(' ').trim();
  const agent = new YouTubeAutomationAgent();

  if (userTopic) {
    // MODO MANUAL: ejecutar pipeline una vez con el topic del usuario y salir
    (async () => {
      try {
        const modeLabel = shouldPublish ? '🚀 Modo manual + publicar' : '🎯 Modo manual';
        console.log(chalk.cyan.bold(`\n${modeLabel}: "${userTopic}"`));
        const initialized = await agent.initialize();
        if (!initialized) {
          console.log(chalk.red('\n❌ Failed to initialize. Please check your configuration.'));
          process.exit(1);
        }
        const result = await agent.generateContent(userTopic, { publish: shouldPublish });
        console.log(chalk.green(`\n✅ Pipeline completado: ${result.title}`));
        console.log(chalk.gray(`   Content ID: ${result.contentId}`));
        if (result.youtubeUrl) {
          console.log(chalk.cyan(`   YouTube URL: ${result.youtubeUrl}`));
        }
        process.exit(0);
      } catch (error) {
        console.error(chalk.red('Fatal error:'), error);
        process.exit(1);
      }
    })();
  } else {
    // MODO AUTOMÁTICO: servidor + cron diario
    agent.start().catch(error => {
      console.error(chalk.red('Fatal error:'), error);
      process.exit(1);
    });
  }
}

module.exports = { YouTubeAutomationAgent };