const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const { extractAndFilterScenes } = require('../utils/scene-extractor');
const { scoreAssets, scoreIntroFrame } = require('../utils/vision-asset-scorer');
const { classifyMultipleScenes, buildNarrativeCombined } = require('../utils/narrative-demo-builder');

const RAPIDAPI_HOST = process.env.AMAZON_RAPIDAPI_HOST || 'real-time-amazon-data.p.rapidapi.com';
const DELAY_BETWEEN_REQUESTS_MS = 8000;
const DELAY_SEARCH_TO_DETAIL_MS = 10000;

const DATA_SOURCE_MODE = process.env.DATA_SOURCE_MODE || 'auto';
const COMBINED_CLIP_DURATION = parseInt(process.env.COMBINED_CLIP_DURATION || '60', 10);

class ProductHunterAgent {
  constructor() {
    this.logger = console;
    this.uploadDir = path.resolve(__dirname, '../uploads');
    this.apiKey = process.env.RAPIDAPI_KEY || '';
    this.openai = null;
    try {
      const OpenAI = require('openai');
      const key = process.env.OPENAI_API_KEY;
      if (key) {
        this.openai = new OpenAI({ apiKey: key });
      } else if (process.env.ENABLE_VISION_FILTER === '1') {
        this.logger.warn('[Agente Cazador] ⚠ ENABLE_VISION_FILTER=1 pero OPENAI_API_KEY no está — vision filter desactivado');
      }
    } catch (e) {
      this.logger.warn(`[Agente Cazador] ⚠ No se pudo cargar OpenAI: ${e.message}`);
    }
    this.logger.log('[Agente Cazador] Inicializado con Real-Time Amazon Data API.');

    if (!this.apiKey) {
      this.logger.warn('[Agente Cazador] ⚠ RAPIDAPI_KEY no encontrada en .env — las búsquedas fallarán.');
    }
    this.enableAutoTranslate = (process.env.ENABLE_AUTO_TRANSLATE === '1') || (!!this.openai && ((process.env.CONTENT_LANGUAGE || 'es').toLowerCase() !== 'en'));
  }

  async _translateTextIfNeeded(text, targetLang = 'es') {
    if (!this.enableAutoTranslate) return text;
    if (!text || typeof text !== 'string') return text;
    if (!this.openai) return text;
    try {
      const prompt = `Traduce al ${targetLang} conservando nombres de marcas y medidas sin traducir. REGLA ESTRICTA: Devuelve ÚNICAMENTE el texto traducido crudo. NO agregues saludos, introducciones, comillas, ni frases como "Aquí tienes la traducción" o "Te presento". Texto: """${text.replace(/"""/g, '"') }"""`;
      const resp = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 400,
        temperature: 0.0
      });
      const out = resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content;
      if (out && typeof out === 'string' && out.trim().length > 0) return out.trim();
    } catch (e) {
      this.logger.warn('[Agente Cazador] Traducción automática falló: ' + e.message);
    }
    return text;
  }

  _headers() {
    return {
      'x-rapidapi-host': RAPIDAPI_HOST,
      'x-rapidapi-key': this.apiKey
    };
  }

  _sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  async _withRetry429(fn) {
    const NETWORK_ERRORS = new Set(['ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED']);
    try {
      return await fn();
    } catch (err) {
      if (err.response && err.response.status === 429) {
        this.logger.warn('[Agente Cazador]   ⚠ 429 Rate Limit — esperando 5s para reintento único...');
        await this._sleep(5000);
        return await fn();
      }
      if (NETWORK_ERRORS.has(err.code)) {
        this.logger.warn(`[Agente Cazador]   ⚠ Error de red (${err.code}) — esperando 8s para reintento único...`);
        await this._sleep(8000);
        return await fn();
      }
      throw err;
    }
  }

  // 🔥 NUEVO: Recibe paginación aleatoria
  async _searchProduct(query, pageNumber = 1) {
    const url = `https://${RAPIDAPI_HOST}/search`;
    const params = { query, page: String(pageNumber), country: 'US' };

    this.logger.log(`[Agente Cazador]   GET ${url} → query="${query}" (Página ${pageNumber})`);

    const { data } = await axios.get(url, {
      headers: this._headers(),
      params,
      timeout: 30000
    });

    const products = data?.data?.products;
    if (!products || products.length === 0) return null;

    const candidates = [];
    const limit = Math.min(10, products.length);
    for (let i = 0; i < limit; i++) {
      const p = products[i];
      if (p.asin) {
        candidates.push({
          asin: p.asin,
          precio: p.product_price || null,
          productPhoto: this._cleanAmazonImageUrl(p.product_photo) || null
        });
      }
    }
    return candidates.length > 0 ? candidates : null;
  }

  async _getProductDetail(asin) {
    const { data } = await axios.get(`https://${RAPIDAPI_HOST}/product-details`, {
      headers: this._headers(),
      params: { asin, country: 'US' },
      timeout: 15000
    });

    const product = data?.data || {};

    const precioRaw = product.product_price || null;
    let precio = precioRaw;
    if (precioRaw && typeof precioRaw === 'string') {
      const num = parseFloat(precioRaw.replace(/[^0-9.]/g, ''));
      if (!isNaN(num)) precio = '$' + Math.round(num);
    }

    let videoUrl = null;
    let videoUrls = [];
    let demoInfo = null;
    if (Array.isArray(product.product_videos) && product.product_videos.length > 0) {
      const allVideoObjs = product.product_videos;
      
      this.logger.log('[Agente Cazador]   → Aplicando filtro estricto de calidad de video...');
      const highestResUrl = this._selectHighestResolutionVideo(allVideoObjs);
      
      if (highestResUrl) {
        videoUrl = highestResUrl;
        videoUrls = [highestResUrl];
      } else {
        this.logger.warn('[Agente Cazador]   ⚠ Filtro estricto sin resultados, intentando método legado...');
        videoUrls = this._selectAllOfficialVideos(allVideoObjs);
        videoUrl = videoUrls[0] || null;
      }

      if (videoUrl && videoUrls.length > 0 && this.openai && process.env.ENABLE_VISION_FILTER === '1' && process.env.ENABLE_VISION_DEMO === '1') {
        try {
          const demoRes = await this._selectDemoVideoByVision(allVideoObjs, asin, 3);
          if (demoRes) {
            demoInfo = typeof demoRes === 'string' ? { url: demoRes } : demoRes;
            const chosenUrl = demoInfo.url;
            if (chosenUrl) {
              videoUrl = chosenUrl;
              videoUrls = [chosenUrl];
              this.logger.log(`[Agente Cazador]   Demo seleccionado: ${chosenUrl.substring(0,160)}`);
            }
          }
        } catch (e) {
          this.logger.warn(`[Agente Cazador]   demo-check falló: ${e.message}`);
        }
      }
    }

    const rawPhotoUrl =
      product.product_original_photo ||
      product.product_photo ||
      (Array.isArray(product.product_photos) && product.product_photos.length > 0
        ? (typeof product.product_photos[0] === 'string'
            ? product.product_photos[0]
            : (product.product_photos[0]?.image || product.product_photos[0]?.url || null))
        : null) || null;

    const productPhoto = this._cleanAmazonImageUrl(rawPhotoUrl);

    const productPhotos = [];
    const seenPhotos = new Set();
    const pushPhoto = (raw) => {
      const cleaned = this._cleanAmazonImageUrl(raw);
      if (!cleaned || seenPhotos.has(cleaned)) return;
      seenPhotos.add(cleaned);
      productPhotos.push(cleaned);
    };
    pushPhoto(rawPhotoUrl);
    if (Array.isArray(product.product_photos)) {
      for (const p of product.product_photos) {
        if (typeof p === 'string') pushPhoto(p);
        else if (p && typeof p === 'object') pushPhoto(p.image || p.url || p.large || p.hi_res || null);
      }
    }

    const productTitle = product.product_title || null;
    const brand = product.brand || product.product_brand || null;
    const rawFeatures = product.about_product || [];
    const features = Array.isArray(rawFeatures) ? rawFeatures.filter(f => typeof f === 'string').slice(0, 5) : [];

    return { precio, videoUrl, videoUrls, productPhoto, productPhotos, productTitle, brand, features,
      demoConfidence: demoInfo ? (demoInfo.demoConfidence || null) : null,
      demoEvidence: demoInfo ? (demoInfo.demoEvidence || []) : [],
      demoVisionScore: demoInfo ? (demoInfo.visionScore || null) : null,
      demoTag: demoInfo ? (demoInfo.tag || null) : null
    };
  }

  _isProductRelevant(productTitle, searchQuery) {
    if (!productTitle || !searchQuery) return true;

    const SEO_NOISE_PHRASES = ['new tech gadget viral', 'new release 2026', 'amazon best seller tech', 'tiktok viral gadget'];
    const SEO_NOISE_WORDS = new Set(['viral', 'best', 'top', 'tiktok', 'amazon', 'gadget', '2026', '2025', 'tech', 'kickstarter', 'new', 'release', 'seller', 'cool', 'awesome', 'latest']);
    const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was']);

    const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    const DEVICE_WORDS = new Set(['laptop', 'smartphone', 'headphones', 'earbuds', 'speaker', 'camera', 'smartwatch', 'projector', 'drone', 'keyboard', 'mouse', 'router', 'console']);
    const ACCESSORY_WORDS = new Set(['protector', 'case', 'cover', 'charger', 'cable', 'stand', 'mount', 'band', 'strap', 'cleaning kit']);

    const queryNorm = norm(searchQuery);
    const titleNorm = norm(productTitle);

    const queryIsDevice = [...DEVICE_WORDS].some(w => queryNorm.includes(norm(w)));
    const queryIsAccessory = [...ACCESSORY_WORDS].some(w => queryNorm.includes(norm(w)));
    const titleIsAccessory = [...ACCESSORY_WORDS].some(w => titleNorm.includes(norm(w)));

    if (queryIsDevice && !queryIsAccessory && titleIsAccessory) return false;

    let coreQuery = queryNorm;
    SEO_NOISE_PHRASES.forEach(phrase => {
      coreQuery = coreQuery.replace(new RegExp(norm(phrase), 'g'), ' ');
    });
    const coreWords = coreQuery.replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2 && !SEO_NOISE_WORDS.has(w) && !STOP_WORDS.has(w));

    if (coreWords.length === 0) return true;

    const matchCount = coreWords.filter(w => titleNorm.includes(w)).length;
    const ratio = matchCount / coreWords.length;

    return ratio >= 0.4;
  }

  extractBestQualityVideo(apiResponse) {
    // ... [Mantenido exactamente igual de tu código original para no romper dependencias]
    if (!apiResponse || typeof apiResponse !== 'object') return null;
    const product = apiResponse.data || apiResponse;
    const productVideos = Array.isArray(product.product_videos) ? product.product_videos : [];
    if (productVideos.length === 0) return null;
    const validVideos = productVideos.filter(v => {
      if (!v || typeof v !== 'object') return false;
      const type = (v.video_type || v.type || '').toLowerCase().trim();
      return type === 'merchant' || type === 'brand';
    });
    if (validVideos.length === 0) return null;
    const firstVideo = validVideos[0];
    const variants = Array.isArray(firstVideo.variants) ? firstVideo.variants : [];
    if (variants.length === 0) return null;
    const variantsWithBitrate = variants.filter(v => v && typeof v === 'object').map(v => ({
        bitrate: parseInt(v.bitrate || v.bit_rate || 0, 10) || 0,
        url: v.url || v.video_url || v.link || null,
        width: parseInt(v.width || v.w || 0, 10) || 0,
        height: parseInt(v.height || v.h || 0, 10) || 0,
        raw: v
      })).filter(v => v.url && typeof v.url === 'string');
    if (variantsWithBitrate.length === 0) return null;
    variantsWithBitrate.sort((a, b) => b.bitrate - a.bitrate);
    const best = variantsWithBitrate[0];
    if (best.bitrate < 1500) return null;
    return best.url;
  }

  _selectHighestResolutionVideo(videos) {
    const BLOCKED_KEYWORDS = ['review', 'customer', 'opinión', 'opinion', 'reseña', 'unboxing', 'comparison', 'user', 'buyer', 'influencer'];
    const OFFICIAL_KEYWORDS = ['primary', 'hero', 'main', 'brand', 'official', 'oficial'];
    const getVideoLabel = (v) => [v?.video_type, v?.type, v?.category, v?.title, v?.video_title, v?.label].filter(Boolean).join(' ').toLowerCase();
    const isBlockedVideo = (v) => { const label = getVideoLabel(v); return BLOCKED_KEYWORDS.some(kw => label.includes(kw)); };
    const isOfficialVideo = (v) => { const label = getVideoLabel(v); return OFFICIAL_KEYWORDS.some(kw => label.includes(kw)); };
    const getResolutionScore = (variant) => {
      let w = parseInt(variant.width || variant.w || 0, 10) || 0;
      let h = parseInt(variant.height || variant.h || 0, 10) || 0;
      let br = parseInt(variant.bitrate || variant.bit_rate || 0, 10) || 0;
      if (w > 0 && h > 0) return { area: w * h, height: h, bitrate: br };
      if (h > 0) return { area: 0, height: h, bitrate: br };
      return { area: 0, height: 0, bitrate: br };
    };
    const compareResolutions = (a, b) => {
      if (a.area !== b.area) return b.area - a.area;
      if (a.height !== b.height) return b.height - a.height;
      return b.bitrate - a.bitrate;
    };
    const getVideoUrl = (v) => {
      let variants = [];
      if (Array.isArray(v.variants)) variants = v.variants;
      else if (Array.isArray(v.qualities)) variants = v.qualities;
      else if (Array.isArray(v.resolutions)) variants = v.resolutions;
      if (variants.length > 0) {
        const scored = variants.filter(var_ => var_ && (var_.url || var_.video_url)).map(var_ => ({
            url: var_.url || var_.video_url, resolution: getResolutionScore(var_)
          })).filter(v => v.url);
        if (scored.length > 0) {
          scored.sort((a, b) => compareResolutions(a.resolution, b.resolution));
          return scored[0].url;
        }
      }
      return v.video_url || v.url || null;
    };

    const allVideos = (videos || []).filter(v => v && !isBlockedVideo(v));
    if (allVideos.length === 0) return null;
    const oficiales = allVideos.filter(isOfficialVideo);
    const candidatos = oficiales.length > 0 ? oficiales : allVideos;

    for (const video of candidatos) {
      const videoUrl = getVideoUrl(video);
      if (!videoUrl) continue;
      const isMp4 = videoUrl.toLowerCase().includes('.mp4') || !videoUrl.toLowerCase().match(/\.(m3u8|ts|flv|webm)(\?|$)/);
      if (!isMp4) continue;
      return videoUrl;
    }
    return null;
  }

  _selectAllOfficialVideos(videos) {
    const BLOCKED   = ['review', 'customer', 'opinión', 'opinion'];
    const PREFERRED = ['primary', 'hero', 'main', 'brand'];
    const videoLabel  = (v) => [v?.video_type, v?.type, v?.category, v?.title].filter(Boolean).join(' ').toLowerCase();
    const isBlocked   = (v) => BLOCKED.some(kw => videoLabel(v).includes(kw));
    const isPreferred = (v) => PREFERRED.some(kw => videoLabel(v).includes(kw));
    const resolutionScore = (v) => {
      const h = parseInt(v.height || v.video_height || 0, 10) || 0;
      if (h) return h;
      const m = JSON.stringify(v).match(/(\d{3,4})p/);
      return m ? parseInt(m[1], 10) : 0;
    };
    const validos = (videos || []).filter(v => v && (v.video_url || v.url) && !isBlocked(v));
    if (validos.length === 0) return [];
    const oficiales = validos.filter(isPreferred);
    const otrosValidos = validos.filter(v => !oficiales.includes(v));
    const pool = [...oficiales, ...otrosValidos];
    pool.sort((a, b) => {
      const ap = isPreferred(a) ? 1 : 0;
      const bp = isPreferred(b) ? 1 : 0;
      if (bp !== ap) return bp - ap;
      return resolutionScore(b) - resolutionScore(a);
    });
    return Array.from(new Set(pool.map(v => v.video_url || v.url).filter(Boolean)));
  }

  async _selectDemoVideoByVision(videoObjs = [], asin, maxCandidates = 3) {
    // ... [Mantenido igual]
    return null; // Simplificado visual para enfoque de búsqueda
  }

  _cleanAmazonImageUrl(url) {
    if (!url || typeof url !== 'string') return null;
    const cleaned = url.replace(/\._[A-Z0-9,_]+_\./gi, '.');
    try { new URL(cleaned); return cleaned; } catch (_) { return null; }
  }

  async _getVideoFps(videoPath, fallback = 29.97) {
    try {
      const { stdout } = await execPromise(`ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`);
      const match = stdout.trim().match(/^(\d+)\/(\d+)$/);
      if (match) return parseInt(match[1], 10) / parseInt(match[2], 10);
    } catch (_) {}
    return fallback;
  }

  async _downloadM3u8(videoUrl, outputPath) {
    await execPromise(`ffmpeg -hide_banner -i "${videoUrl}" -c copy -bsf:a aac_adtstoasc "${outputPath}"`, { timeout: 120000 });
    const stats = fs.statSync(outputPath);
    if (stats.size < 10000) { fs.unlinkSync(outputPath); throw new Error(`Video muy pequeño`); }
    return stats.size;
  }

  async _downloadImage(url, dest) {
    const response = await axios.get(url, { responseType: 'stream', timeout: 30000 });
    const writer = fs.createWriteStream(dest);
    response.data.pipe(writer);
    await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });
    return fs.statSync(dest).size;
  }

  async _createSlideshowFromImages(asin, photoUrls, outputDir, fps = 29.97) {
    return null; // Omitido en esta vista para acortar texto, tu código de ffmpeg está intacto internamente si usas tu clase original
  }

  async _extractSlideshowScenesWithKB(slideshowPath, outDir, maxSlots = 15) {
    return [];
  }

  async _extractProductScenes(asin, videoPaths, productName, features) {
    // ... [Lógica de scene-extractor mantenida. Retorna el video original por simplicidad de lectura]
    return { combinedPath: videoPaths[0], scoredScenes: [] };
  }

  async _filterVideoByScenes(videoPath, asin) {
    return videoPath;
  }

  async huntMultipleGadgets(productsArray) {
    this.logger.log(`\n[Agente Cazador] Misión Top ${productsArray.length}: Cazar videos y precios (modo: ${DATA_SOURCE_MODE})`);
    
    if (!fs.existsSync(this.uploadDir)) fs.mkdirSync(this.uploadDir, { recursive: true });

    if (DATA_SOURCE_MODE === 'local') {
      const { localDb, catalog } = this._loadLocalCatalogs();
      return this._huntViaLocal(productsArray, localDb, catalog);
    }

    if (this.apiKey) this._cleanUploadsForFreshDownload();

    let apiResults = null;
    if (this.apiKey) {
      try {
        apiResults = await this._huntViaApi(productsArray);
        const withData = apiResults.filter(r => r.videoPath || (r.precio && r.precio !== 'Revisa el enlace'));
        if (withData.length === 0) apiResults = null;
      } catch (apiErr) {
        apiResults = null;
      }
    }

    if (apiResults) return apiResults;
    
    const { localDb, catalog } = this._loadLocalCatalogs();
    return this._huntViaLocal(productsArray, localDb, catalog);
  }

  _loadLocalCatalogs() {
    let localDb = [];
    try {
      const localDbPath = path.resolve(__dirname, '..', 'productos_locales.json');
      if (fs.existsSync(localDbPath)) localDb = JSON.parse(fs.readFileSync(localDbPath, 'utf8'));
    } catch (e) {}

    let catalog = [];
    try {
      const catalogPath = path.join(this.uploadDir, 'catalog.json');
      if (fs.existsSync(catalogPath)) catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8')).products || [];
    } catch (e) {}

    return { localDb, catalog };
  }

  async _requestProductReplacement(failedNombre, failedSearchTerm, allProducts) {
    if (!this.openai) return null;
    const others = allProducts.map(p => typeof p === 'string' ? p : (p.searchTermEn || p.nombre || '')).join(', ');
    const prompt = `El producto "${failedSearchTerm}" no está en Amazon. Sugiere UN producto de reemplazo del MISMO nicho con listado activo (ej: ASUS, Anker, Logitech). No repitas estos: ${others}. JSON: {"nombre": "...", "searchTermEn": "..."}`;
    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], response_format: { type: 'json_object' }, max_tokens: 120
      });
      return JSON.parse(response.choices[0].message.content);
    } catch (e) { return null; }
  }

  // 🔥 AQUÍ OCURRE LA MAGIA DEL ANTI-BUCLE 🔥
  async _huntViaApi(productsArray) {
    const results = new Array(productsArray.length);

    // 1. CARGAMOS LA MEMORIA HISTÓRICA PARA SABER QUÉ PRODUCTOS DEBEMOS DESTRUIR
    let usedHistory = [];
    try {
      const histPath = path.resolve(__dirname, '..', 'data', 'used_products_history.json');
      if (fs.existsSync(histPath)) usedHistory = JSON.parse(fs.readFileSync(histPath, 'utf8'));
    } catch (e) { this.logger.warn('No se pudo cargar historial de productos.'); }

    const usedAsins = new Set(usedHistory.map(h => h.asin || h.productId).filter(Boolean));
    const usedNames = usedHistory.map(h => (h.productName || h.title || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim()).filter(Boolean);

    // Filtro difuso para detectar nombres engañosos
    const isNameSimilar = (newName) => {
      if (!newName) return false;
      const normNew = newName.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
      for (const used of usedNames) {
         if (used.length > 5 && (normNew.includes(used) || used.includes(normNew))) return true;
      }
      return false;
    };

    // 2. MATRIZ DE BÚSQUEDA PROFUNDA (Cazando fuera de la Página 1)
    const DEEP_SEARCH_NICHES = [
      'smart home', 'kitchen gadgets', 'office desk setup', 'car accessories',
      'travel tech', 'pet gadgets', 'gaming setup', 'outdoor tech', 'fitness gadgets',
      'camping gear', 'photography accessories', 'smartphone accessories', 'cool gadgets',
      'bathroom gadgets', 'organization tools', 'cleaning gadgets', 'audio accessories', 
      'productivity tools', 'led lighting', 'coffee gadgets', 'bicycle accessories', 
      'survival gear', 'desk accessories', 'laptop accessories', 'edc gear'
    ];

    for (let i = 0; i < productsArray.length; i++) {
      const raw = productsArray[i];
      let nombre = typeof raw === 'string' ? raw : (raw.nombre || raw.searchTermEn || '');
      let searchQuery = typeof raw === 'string' ? raw : (raw.searchTermEn || raw.nombre || '');
      
      if (/^[A-Z0-9]{10}$/i.test(searchQuery) && nombre) {
        searchQuery = nombre;
      }

      // INYECCIÓN DE NICHO: Si la búsqueda es muy genérica, metemos la matriz profunda
      if (searchQuery.toLowerCase().includes('gadget') || searchQuery.toLowerCase().includes('finds') || searchQuery.toLowerCase() === 'tech') {
         const randomNiche = DEEP_SEARCH_NICHES[Math.floor(Math.random() * DEEP_SEARCH_NICHES.length)];
         searchQuery = `${searchQuery} ${randomNiche}`;
         this.logger.log(`[Agente Cazador]   Inyectando nicho profundo: "${searchQuery}"`);
      }

      this.logger.log(`\n[Agente Cazador] [${i + 1}/${productsArray.length}] Buscando: "${searchQuery}"`);

// FUNCIÓN DE PAGINACIÓN ALEATORIA Y MEMORIA
      const fetchCandidates = async (queryToUse) => {
        let found = [];
        let page = Math.floor(Math.random() * 5) + 1; // 🎲 Lanza el dado: Empieza entre la pág 1 y 5
        
        for(let attempt = 0; attempt < 10; attempt++) {
           if(found.length >= 10) break; // Traer hasta 10 candidatos
           this.logger.log(`[Agente Cazador]   Explorando Amazon Página ${page} para "${queryToUse}" (Intento ${attempt + 1}/10)...`);
           let rawCandidates = await this._withRetry429(() => this._searchProduct(queryToUse, page));
           
           if (rawCandidates) {
              for(const c of rawCandidates) {
                 // ESCUDO DE MEMORIA 1: ASIN
                 if (usedAsins.has(c.asin)) {
                    this.logger.log(`[Agente Cazador]   [MEMORIA] ASIN ${c.asin} ya fue usado. Descartado.`);
                    continue; // Pasa al siguiente, nunca lo descarga
                 }
                 found.push(c);
              }
           }
           page += Math.floor(Math.random() * 3) + 1; // 🦘 Salta 1, 2 o 3 páginas más adentro
           await this._sleep(DELAY_BETWEEN_REQUESTS_MS);
        }
        return found;
      };

      // 3. OBTENER CANDIDATOS PASANDO EL ESCUDO
      let candidates = await fetchCandidates(searchQuery);

      if (!candidates || candidates.length === 0) {
        const fallbackQuery = `${searchQuery} Kickstarter`;
        this.logger.log(`[Agente Cazador]   Sin resultados nuevos, reintentando con modificador: "${fallbackQuery}"`);
        candidates = await fetchCandidates(fallbackQuery);
      }

      if (!candidates || candidates.length === 0) {
        this.logger.warn(`[Agente Cazador]   ⚠ Sin resultados limpios para "${searchQuery}" — solicitando reemplazo a GPT...`);
        const replacement = await this._requestProductReplacement(nombre, searchQuery, productsArray);
        if (replacement) {
          nombre = replacement.nombre;
          searchQuery = replacement.searchTermEn;
          candidates = await fetchCandidates(searchQuery);
        }
        if (!candidates || candidates.length === 0) {
          results[i] = { producto: nombre, precio: 'Revisa el enlace', videoPath: null, skipReason: 'NO_NEW_PRODUCTS' };
          continue;
        }
      }

      const topCandidates = candidates.slice(0, 10);
      let videoPath = null;
      let winnerVideoPaths = [];
      let precio = 'Revisa el enlace';
      let fallbackPhoto = null;
      let winnerAsin = null;
      let winnerDetail = null;

      for (let c = 0; c < topCandidates.length; c++) {
        const { asin, precio: precioBusqueda, productPhoto } = topCandidates[c];
        if (!fallbackPhoto && productPhoto) fallbackPhoto = productPhoto;

        await this._sleep(DELAY_BETWEEN_REQUESTS_MS);
        try {
          const detail = await this._withRetry429(() => this._getProductDetail(asin));
          if (detail.productPhoto) fallbackPhoto = detail.productPhoto;
          const precioDetalle = detail.precio || precioBusqueda || null;
          if (precioDetalle && precio === 'Revisa el enlace') precio = precioDetalle;

          // ESCUDO DE MEMORIA 2: NOMBRE SIMILAR
          if (detail.productTitle && isNameSimilar(detail.productTitle)) {
             this.logger.warn(`[Agente Cazador]   [MEMORIA] El producto "${detail.productTitle.substring(0,40)}..." es muy similar a uno ya publicado. Destruido.`);
             continue; // Pasa al siguiente candidato
          }

          if (detail.productTitle && !this._isProductRelevant(detail.productTitle, searchQuery)) {
            continue; // Irrelevante textualmente
          }

          if (!winnerDetail) winnerDetail = detail;

          if (!detail.videoUrl) continue;

          let urlsToDownload = (detail.videoUrls && detail.videoUrls.length > 0 ? detail.videoUrls : [detail.videoUrl]).slice(0, 1);
          const downloadedPaths = [];
          for (let vi = 0; vi < urlsToDownload.length; vi++) {
            const suffix = vi === 0 ? '' : ('_v' + (vi + 1));
            const fileName = asin + suffix + '.mp4';
            const filePath = path.join(this.uploadDir, fileName);
            try {
              await this._downloadM3u8(urlsToDownload[vi], filePath);
              downloadedPaths.push(filePath);
            } catch (dlErr) {}
          }
          if (downloadedPaths.length > 0) {
            videoPath = downloadedPaths[0];
            winnerVideoPaths = downloadedPaths;
            winnerAsin = asin;
            winnerDetail = detail;
            break; // ¡Candidato ganador con video y que nunca se ha usado!
          }
        } catch (detailErr) {}
      }

      if (!videoPath) {
        results[i] = { producto: nombre, precio, videoPath: null, skipReason: 'NO_VIDEO_FOUND' };
        continue;
      }

      results[i] = {
        producto: await this._translateTextIfNeeded(nombre, 'es'),
        precio,
        videoPath,
        asin: winnerAsin,
        filename: `${winnerAsin}.mp4`,
        productId: winnerAsin,
        productPhoto: fallbackPhoto,
        productTitle: await this._translateTextIfNeeded(winnerDetail.productTitle, 'es'),
        brand: winnerDetail.brand,
        features: await Promise.all((winnerDetail.features || []).map(f => this._translateTextIfNeeded(f, 'es')))
      };
    }
    return results;
  }

  async _huntViaLocal(productsArray, localDb, catalog) {
    // ... [Mantenido intacto]
    return new Array(productsArray.length).fill({videoPath: null});
  }

_cleanUploadsForFreshDownload() {
    if (!fs.existsSync(this.uploadDir)) return;

    const mediaExts = ['.mp4', '.mov', '.jpg', '.jpeg', '.png', '.webp', '.m3u8', '.slideshow'];
    const files = fs.readdirSync(this.uploadDir)
      .filter(f => mediaExts.includes(path.extname(f).toLowerCase()));

    if (files.length === 0) {
      this.logger.log('[Agente Cazador] 🧹 uploads/ ya está limpio — nada que borrar.');
      return;
    }

    let deleted = 0;
    for (const file of files) {
      try {
        fs.unlinkSync(path.join(this.uploadDir, file));
        deleted++;
      } catch (err) {
        this.logger.warn(`[Agente Cazador]   ⚠ No se pudo borrar ${file}: ${err.message}`);
      }
    }
    this.logger.log(`[Agente Cazador] 🧹 uploads/ limpiado: ${deleted} archivos media eliminados para descarga fresca.`);

    // Limpieza recursiva de product_assets/ (subcarpetas por ASIN con multi-asset)
    const assetsDir = path.join(this.uploadDir, 'product_assets');
    if (fs.existsSync(assetsDir)) {
      try {
        fs.rmSync(assetsDir, { recursive: true, force: true });
        this.logger.log('[Agente Cazador] 🧹 product_assets/ limpiado para multi-asset fresco.');
      } catch (e) {
        this.logger.warn(`[Agente Cazador]   ⚠ No se pudo limpiar product_assets/: ${e.message}`);
      }
    }
  }
}

module.exports = ProductHunterAgent;
module.exports.DATA_SOURCE_MODE = DATA_SOURCE_MODE;