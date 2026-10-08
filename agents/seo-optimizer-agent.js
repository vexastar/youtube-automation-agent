const OpenAI = require('openai');
const { Logger } = require('../utils/logger');

// Durations configurable via env (keep consistent with other agents)
const PER_PRODUCT_DURATION_MIN = parseInt(process.env.PER_PRODUCT_DURATION_MIN || '30', 10);
const PER_PRODUCT_DURATION_MAX = parseInt(process.env.PER_PRODUCT_DURATION_MAX || '50', 10);
const PER_PRODUCT_DURATION_DEFAULT = parseInt(process.env.PER_PRODUCT_DURATION_DEFAULT || String(Math.round((PER_PRODUCT_DURATION_MIN + PER_PRODUCT_DURATION_MAX)/2)), 10);
const INTRO_DURATION_MIN = parseInt(process.env.INTRO_DURATION_MIN || '25', 10);
const INTRO_DURATION_MAX = parseInt(process.env.INTRO_DURATION_MAX || '30', 10);
const INTRO_DURATION_AVG = Math.round((INTRO_DURATION_MIN + INTRO_DURATION_MAX) / 2);

class SEOOptimizerAgent {
  constructor(db, credentials) {
    this.db = db;
    this.credentials = credentials;
    this.logger = new Logger('SEOOptimizer');
    this.keywordDatabase = new Map();

    // Initialize OpenAI (idéntico al patrón usado por ScriptWriter)
    const creds = credentials.credentials || credentials;
    const apiKey = creds.openai?.apiKey || process.env.OPENAI_API_KEY;
    if (apiKey) {
      this.openai = new OpenAI({ apiKey });
    } else {
      this.logger.warn('OpenAI API key no encontrada — SEO usará fallback heurístico.');
    }
  }

  async initialize() {
    this.logger.info('Initializing SEO Optimizer Agent...');
    await this.loadKeywordDatabase();
    return true;
  }

  async loadKeywordDatabase() {
    try {
      const keywords = await this.db.getKeywordHistory();
      keywords.forEach(kw => {
        this.keywordDatabase.set(kw.keyword, kw.performance);
      });
    } catch (error) {
      this.logger.warn('No keyword history found');
    }
  }

  async optimize(script, strategy) {
    try {
      this.logger.info(`Optimizing SEO for: ${script.title}`);

      // ── Construir datos derivados (timestamps + enlaces afiliado) ──
      const productsData = this._buildProductsData(script);
      const chapters = this._buildChaptersFromProducts(productsData);
      const hashtags = await this.generateHashtags(strategy);
      const niche = this.identifyNiche(strategy);

      // ── Llamar al LLM con contrato estricto ──
      let llmResult = null;
      if (this.openai) {
        try {
          llmResult = await this._generateSEOWithLLM(strategy, productsData, niche);
        } catch (e) {
          this.logger.warn(`LLM SEO falló (${e.message}) — usando fallback heurístico.`);
        }
      }

      // ── Fallback heurístico si LLM no disponible ──
      let title, description, tags;
      if (llmResult) {
        title = llmResult.titulo_seleccionado;
        description = llmResult.descripcion_optimizada;
        tags = llmResult.tags;
      } else {
        title = await this.optimizeTitle(script.title, strategy);
        description = await this.generateDescription(script, strategy);
        tags = await this.generateTags(script, strategy);
      }

      // ── Saneamientos defensivos sobre la salida del LLM ──
      title = this._enforceTitleLimit(title, 65);
      tags = this._enforceTagLimits(tags);

      // ── Garantizar que la lista de afiliados+timestamps esté presente ──
      // Si el LLM la omitió o cambió el formato, la inyectamos.
      description = this._ensureAffiliateListInDescription(description, productsData);

      const seoScore = await this.calculateSEOScore(title, description, tags);

      const seoData = {
        title,
        description,
        tags,
        hashtags,
        chapters,
        endScreen: await this.generateEndScreenStrategy(),
        seoScore,
        metadata: {
          primaryKeyword: (strategy.keywords && strategy.keywords[0]) || strategy.topic,
          secondaryKeywords: (strategy.keywords || []).slice(1, 5),
          targetLength: this.calculateOptimalLength(strategy.contentType),
          language: process.env.CONTENT_LANGUAGE || 'es',
          category: this.selectCategory(strategy)
        },
        // Salida cruda del LLM, útil para debugging y para publishing-scheduling-agent
        llmOutput: llmResult || null,
        createdAt: new Date().toISOString()
      };

      await this.db.saveSEOData(seoData);
      this.logger.info(`SEO optimization complete. Score: ${seoScore}/100 — Title (${title.length}c): "${title}"`);
      return seoData;
    } catch (error) {
      this.logger.error('Failed to optimize SEO:', error);
      throw error;
    }
  }

  /**
   * Construye la lista de productos enriquecida con timestamp acumulado y URL de afiliado.
   * Usa estimatedAudioSeconds o clipDuration por sección para timestamps realistas.
   */
  _buildProductsData(script) {
    const sections = (script.mainContent && script.mainContent.sections) || [];
    const tag = process.env.AMAZON_AFFILIATE_TAG || '';
    const INTRO_SECONDS = 15; // hook (~10s) + introduccion (~5s)

    const products = [];
    let cursor = INTRO_SECONDS;

    for (let i = 0; i < sections.length; i++) {
      const sec = sections[i];
      const asin = sec.asin || sec.productId || null;
      const name = sec.productName || sec.title || `Producto ${i + 1}`;
      const dur = Number(sec.estimatedAudioSeconds) || Number(sec.clipDuration) || 25;

      const mm = Math.floor(cursor / 60);
      const ss = Math.floor(cursor % 60);
      const timestamp = `${mm.toString().padStart(2, '0')}:${ss.toString().padStart(2, '0')}`;

      const affiliateUrl = asin
        ? `https://www.amazon.com/dp/${asin}${tag ? `?tag=${tag}` : ''}`
        : null;

      products.push({ index: i + 1, asin, name, timestamp, affiliateUrl, durationSeconds: dur });
      cursor += dur;
    }

    return products;
  }

  _buildChaptersFromProducts(productsData) {
    const chapters = [{ time: '00:00', title: 'Introducción', seconds: 0 }];
    for (const p of productsData) {
      const [mm, ss] = p.timestamp.split(':').map(Number);
      chapters.push({ time: p.timestamp, title: p.name, seconds: mm * 60 + ss });
    }
    return chapters;
  }

  /**
   * Llama a GPT-4o con el System Prompt CTR-first y obtiene JSON estricto:
   *   { titulo_seleccionado, descripcion_optimizada, tags }
   */
  async _generateSEOWithLLM(strategy, productsData, niche) {
    const year = new Date().getFullYear();
    const channelName = process.env.CHANNEL_NAME || 'Tech Finds Amazon';
    const language = process.env.CONTENT_LANGUAGE || 'es';

    // Lista exacta de líneas de afiliado que el LLM DEBE incluir literalmente.
    const affiliateLines = productsData.map(p =>
      `${p.timestamp} - ${p.name} 👉 ${p.affiliateUrl || '(enlace no disponible)'}`
    );

    const systemPrompt = [
      `Eres un experto en SEO y CTR para YouTube en ${language}.`,
      `Tu objetivo es maximizar el Click-Through Rate y la retención algorítmica del canal "${channelName}".`,
      `NO escribes como una IA: tu copia es punzante, emocional y humana.`,
      '',
      '╔══════════════════════════════════════════════════════════════╗',
      '║  REGLA 1 — TÍTULOS PARA CTR (3 OPCIONES)                    ║',
      '║  Genera 3 títulos. Cada uno DEBE:                            ║',
      '║   • Tener MÁXIMO 65 caracteres (cuenta los espacios).        ║',
      '║   • Incluir un gancho emocional fuerte. Ejemplos válidos:    ║',
      '║     "Brutales", "Prohibidos", "Imprescindibles", "Locos",   ║',
      '║     "Increíbles", "Salvajes", "Adictivos", "Insanos".       ║',
      `║   • Mencionar el nicho (${niche}/gadgets/tech) y el año ${year}. ║`,
      '║   • Sonar humano. NUNCA empezar con "Descubre los..." ni    ║',
      '║     "Top 10 mejores...". Variar la apertura.                ║',
      '║  Después elige el MEJOR de los 3 como "titulo_seleccionado". ║',
      '╠══════════════════════════════════════════════════════════════╣',
      '║  REGLA 2 — DESCRIPCIÓN EN FORMATO EMBUDO                    ║',
      '║  Las PRIMERAS 2 LÍNEAS son lo único visible en búsqueda.    ║',
      '║  Línea 1-2: párrafo denso en LSI keywords resumiendo los    ║',
      '║  gadgets, mencionando "bienvenidos a tech finds amazon"    ║',
      '║  de forma natural (autoridad de marca).                     ║',
      '║  Después un párrafo expandido con keywords semánticas.      ║',
      '╠══════════════════════════════════════════════════════════════╣',
      '║  REGLA 3 — TIMESTAMPS + AFILIADOS (FORMATO LITERAL)         ║',
      '║  En el cuerpo, incluye una sección titulada                  ║',
      '║  "🛒 PRODUCTOS DEL VIDEO:" seguida de UNA LÍNEA POR PRODUCTO ║',
      '║  con este formato EXACTO (copia textual, NO inventes):      ║',
      '║    [Timestamp] - [Nombre Corto y Atractivo] 👉 [Link]       ║',
      '║  Te entrego las líneas ya armadas en "afiliados_obligatorios"║',
      '║  Debes copiarlas TAL CUAL, en el mismo orden, sin alterar   ║',
      '║  ASINs, URLs ni timestamps.                                  ║',
      '╠══════════════════════════════════════════════════════════════╣',
      '║  REGLA 4 — TAGS (15-20 EN 3 NIVELES)                        ║',
      '║   Nivel A — Amplias (3-5):  ej. "tecnologia", "gadgets"     ║',
      '║   Nivel B — Específicas (5-8): ej. "smart home", "accesorios escritorio" ║',
      '║   Nivel C — Intención de compra (5-7): ej. "mejores gadgets║',
      '║              baratos en amazon", "comprar gadgets 2026"     ║',
      '║  Devuelve el array combinado en "tags" (15-20 strings).     ║',
      '║  Sin "#" delante. Sin duplicados. Total ≤ 500 caracteres.   ║',
      '╚══════════════════════════════════════════════════════════════╝',
      '',
      'REGLA 5 — SALIDA ESTRICTA EN JSON (sin texto extra):',
      '{',
      '  "titulos_candidatos": ["...", "...", "..."],',
      '  "titulo_seleccionado": "El mejor título elegido (≤65 caracteres)",',
      '  "descripcion_optimizada": "Texto completo del embudo con timestamps y links...",',
      '  "tags": ["tag1", "tag2", "..."]',
      '}',
      'PROHIBIDO incluir cualquier campo fuera de este JSON.',
      'PROHIBIDO usar "#" en el array de tags.',
      'PROHIBIDO inventar productos, ASINs o URLs.'
    ].join('\n');

    const userPrompt = [
      `Tema del video: ${strategy.topic}`,
      `Nicho identificado: ${niche}`,
      `Año actual: ${year}`,
      `Audiencia objetivo: ${strategy.targetAudience || 'consumidores de tech en LATAM y España'}`,
      `Keywords semilla: ${(strategy.keywords || []).slice(0, 10).join(', ')}`,
      '',
      'PRODUCTOS DEL VIDEO (orden cronológico, con timestamps reales):',
      JSON.stringify(productsData.map(p => ({
        index: p.index,
        nombre: p.name,
        timestamp: p.timestamp,
        asin: p.asin
      })), null, 2),
      '',
      'AFILIADOS OBLIGATORIOS — copia estas líneas LITERALMENTE en el cuerpo de la descripción,',
      'bajo el encabezado "🛒 PRODUCTOS DEL VIDEO:", en este mismo orden, sin alterar nada:',
      ...affiliateLines.map(l => `    ${l}`),
      '',
      'Genera el JSON ahora.'
    ].join('\n');

    const response = await this.openai.chat.completions.create({
      model: 'gpt-4o',
      temperature: 0.85,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    });

    const parsed = JSON.parse(response.choices[0].message.content);
    if (!parsed.titulo_seleccionado || !parsed.descripcion_optimizada || !Array.isArray(parsed.tags)) {
      throw new Error('Respuesta del LLM sin campos requeridos (titulo_seleccionado/descripcion_optimizada/tags).');
    }

    if (Array.isArray(parsed.titulos_candidatos)) {
      this.logger.info(`Títulos candidatos: ${parsed.titulos_candidatos.map(t => `"${t}"`).join(' | ')}`);
    }

    return parsed;
  }

  _enforceTitleLimit(title, maxChars) {
    if (!title) return '';
    let t = String(title).trim();
    if (t.length <= maxChars) return t;
    // Truncar respetando palabras
    t = t.substring(0, maxChars);
    const lastSpace = t.lastIndexOf(' ');
    if (lastSpace > maxChars * 0.7) t = t.substring(0, lastSpace);
    return t;
  }

  _enforceTagLimits(tags) {
    if (!Array.isArray(tags)) return [];
    // Quitar "#", trim, dedupe (case-insensitive), límite 500 chars total
    const seen = new Set();
    const cleaned = [];
    for (let raw of tags) {
      if (typeof raw !== 'string') continue;
      const t = raw.replace(/^#/, '').trim();
      if (!t) continue;
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      cleaned.push(t);
    }
    let total = 0;
    const final = [];
    for (const t of cleaned) {
      if (total + t.length + 1 > 500) break;
      final.push(t);
      total += t.length + 1;
    }
    return final;
  }

  /**
   * Si el LLM omitió la lista de afiliados o cambió ASINs/URLs, la añadimos al final.
   * La detección es laxa: basta con que aparezca el primer ASIN.
   */
  _ensureAffiliateListInDescription(description, productsData) {
    if (!description) description = '';
    const validAffiliates = productsData.filter(p => p.affiliateUrl);
    if (validAffiliates.length === 0) return description;

    const firstAsin = validAffiliates[0].asin;
    const alreadyPresent = firstAsin && description.includes(firstAsin);
    if (alreadyPresent) return description;

    this.logger.warn('Lista de afiliados ausente en descripción del LLM — inyectando bloque al final.');
    const block = [
      '',
      '🛒 PRODUCTOS DEL VIDEO:',
      ...validAffiliates.map(p => `${p.timestamp} - ${p.name} 👉 ${p.affiliateUrl}`),
      ''
    ].join('\n');
    return description.trimEnd() + '\n\n' + block;
  }

  async optimizeTitle(originalTitle, strategy) {
    // YouTube title limit: 100 characters, optimal: 60-70
    let optimizedTitle = originalTitle;
    
    // Add power words if not present
    const powerWords = ['Ultimate', 'Complete', 'Essential', 'Proven', 'Secret', 'Amazing', 'Powerful'];
    const hasPowerWord = powerWords.some(word => 
      originalTitle.toLowerCase().includes(word.toLowerCase())
    );
    
    if (!hasPowerWord && originalTitle.length < 60) {
      const randomPowerWord = powerWords[Math.floor(Math.random() * powerWords.length)];
      optimizedTitle = `${randomPowerWord} ${originalTitle}`;
    }
    
    // Add year if relevant and not present
    const currentYear = new Date().getFullYear();
    if (!optimizedTitle.includes(currentYear.toString()) && optimizedTitle.length < 70) {
      optimizedTitle = `${optimizedTitle} (${currentYear})`;
    }
    
    // Ensure primary keyword is in title
    const primaryKeyword = strategy.keywords[0];
    if (primaryKeyword && !optimizedTitle.toLowerCase().includes(primaryKeyword.toLowerCase())) {
      optimizedTitle = `${optimizedTitle} - ${primaryKeyword}`;
    }
    
    // Truncate if too long
    if (optimizedTitle.length > 100) {
      optimizedTitle = optimizedTitle.substring(0, 97) + '...';
    }
    
    // Capitalize properly
    optimizedTitle = this.titleCase(optimizedTitle);
    
    return optimizedTitle;
  }

  titleCase(str) {
    const smallWords = ['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'if', 'in', 'of', 'on', 'or', 'the', 'to', 'via', 'vs'];
    
    return str.split(' ').map((word, index) => {
      if (index === 0 || !smallWords.includes(word.toLowerCase())) {
        return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
      }
      return word.toLowerCase();
    }).join(' ');
  }

  async generateDescription(script, strategy) {
    // YouTube description limit: 5000 characters, first 125 shown in search
    
    let description = '';
    
    // First 125 characters - most important for SEO
    const hook = `${script.title} - In this video, you'll discover ${strategy.angle.toLowerCase()}.`;
    description += hook + '\n\n';
    
    // Video overview
    description += '📺 WHAT YOU\'LL LEARN:\n';
    if (script.mainContent && script.mainContent.sections) {
      script.mainContent.sections.slice(0, 5).forEach(section => {
        if (section.title) {
          description += `• ${section.title}\n`;
        }
      });
    }
    description += '\n';
    
    // Timestamps/Chapters
    description += '⏱️ TIMESTAMPS:\n';
    description += '00:00 Introduction\n';
    let timestamp = INTRO_DURATION_AVG;
    if (script.mainContent && script.mainContent.sections) {
      script.mainContent.sections.forEach(section => {
        const minutes = Math.floor(timestamp / 60);
        const seconds = timestamp % 60;
        description += `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')} ${section.title || 'Section'}\n`;
        timestamp += section.duration || 60;
      });
    }
    description += '\n';
    
    // Keywords paragraph (SEO optimized)
    description += '📝 ABOUT THIS VIDEO:\n';
    description += `This comprehensive guide on ${strategy.topic} covers everything you need to know. `;
    description += `Whether you're a beginner or advanced, you'll find valuable insights about ${strategy.keywords.slice(0, 3).join(', ')}. `;
    description += `Perfect for ${strategy.targetAudience}.\n\n`;
    
    // Links section
    description += '🔗 USEFUL LINKS:\n';
    description += `• Subscribe: [Your Channel URL]\n`;
    description += `• Website: ${process.env.WEBSITE_URL || '[Your Website]'}\n`;
    description += `• Social Media: ${process.env.SOCIAL_LINKS || '[Your Social Media]'}\n\n`;
    
    // Related videos
    description += '📹 RELATED VIDEOS:\n';
    description += '• [Related Video 1]\n';
    description += '• [Related Video 2]\n';
    description += '• [Related Video 3]\n\n';
    
    // Equipment/Tools (if applicable)
    if (strategy.contentType === 'Tutorial') {
      description += '🛠️ TOOLS & RESOURCES MENTIONED:\n';
      description += '• [Tool/Resource 1]\n';
      description += '• [Tool/Resource 2]\n\n';
    }
    
    // Contact/Business
    description += '📧 BUSINESS INQUIRIES:\n';
    description += `${process.env.BUSINESS_EMAIL || '[Your Business Email]'}\n\n`;
    
    // Tags/Hashtags
    description += '🏷️ TAGS:\n';
    const hashtags = await this.generateHashtags(strategy);
    description += hashtags.join(' ') + '\n\n';
    
    // Disclaimer if needed
    description += '⚠️ DISCLAIMER:\n';
    description += 'This video is for educational purposes only.\n\n';
    
    // Copyright
    description += `© ${new Date().getFullYear()} All Rights Reserved\n`;
    
    // Music credits if applicable
    description += '\n🎵 MUSIC:\n';
    description += 'Background music from YouTube Audio Library\n';
    
    return description;
  }

  async generateTags(script, strategy) {
    const tags = new Set();
    
    // Add primary keywords
    strategy.keywords.forEach(keyword => tags.add(keyword));
    
    // Add topic variations
    const topic = strategy.topic.toLowerCase();
    tags.add(topic);
    tags.add(topic.replace(/\s+/g, ''));
    tags.add(topic.replace(/\s+/g, '_'));
    
    // Add content type tags
    const contentTypeTags = {
      'Tutorial': ['how to', 'tutorial', 'guide', 'step by step', 'learn'],
      'Explainer': ['explained', 'what is', 'understanding', 'explanation'],
      'Review': ['review', 'comparison', 'vs', 'best', 'top'],
      'List': ['top 10', 'best', 'list', 'countdown'],
      'Story': ['story', 'journey', 'experience', 'case study']
    };
    
    const typeTags = contentTypeTags[strategy.contentType] || [];
    typeTags.forEach(tag => tags.add(tag));
    
    // Add year tags
    const year = new Date().getFullYear();
    tags.add(year.toString());
    tags.add(`${topic} ${year}`);
    
    // Add niche-specific tags
    const niche = this.identifyNiche(strategy);
    const nicheTags = this.getNicheTags(niche);
    nicheTags.forEach(tag => tags.add(tag));
    
    // Add long-tail keywords
    const longTailKeywords = this.generateLongTailKeywords(strategy);
    longTailKeywords.forEach(keyword => tags.add(keyword));
    
    // Extract tags from script content
    if (script.keywords) {
      script.keywords.forEach(keyword => tags.add(keyword));
    }
    
    // Add channel branding tags
    if (process.env.CHANNEL_NAME) {
      tags.add(process.env.CHANNEL_NAME);
    }
    
    // YouTube allows max 500 characters in tags, prioritize most important
    const tagArray = Array.from(tags);
    const prioritizedTags = this.prioritizeTags(tagArray, strategy);
    
    // Ensure total character count doesn't exceed 500
    let totalLength = 0;
    const finalTags = [];
    
    for (const tag of prioritizedTags) {
      if (totalLength + tag.length + 1 <= 500) {
        finalTags.push(tag);
        totalLength += tag.length + 1; // +1 for comma separator
      }
    }
    
    return finalTags;
  }

  identifyNiche(strategy) {
    const topic = strategy.topic.toLowerCase();
    
    const niches = {
      'technology': ['tech', 'software', 'hardware', 'gadget', 'computer', 'phone', 'app'],
      'gaming': ['game', 'gaming', 'gamer', 'play', 'stream'],
      'education': ['learn', 'study', 'course', 'tutorial', 'education', 'teach'],
      'business': ['business', 'entrepreneur', 'startup', 'money', 'finance', 'invest'],
      'lifestyle': ['life', 'lifestyle', 'daily', 'routine', 'habit'],
      'health': ['health', 'fitness', 'workout', 'diet', 'nutrition', 'wellness'],
      'entertainment': ['fun', 'comedy', 'entertainment', 'funny', 'laugh']
    };
    
    for (const [niche, keywords] of Object.entries(niches)) {
      if (keywords.some(keyword => topic.includes(keyword))) {
        return niche;
      }
    }
    
    return 'general';
  }

  getNicheTags(niche) {
    const nicheTags = {
      'technology': ['tech', 'technology', 'innovation', 'future tech', 'tech news'],
      'gaming': ['gaming', 'gameplay', 'walkthrough', 'lets play', 'game review'],
      'education': ['educational', 'learning', 'study tips', 'online learning', 'edtech'],
      'business': ['business tips', 'entrepreneurship', 'startup', 'business strategy', 'success'],
      'lifestyle': ['lifestyle', 'life hacks', 'daily routine', 'productivity', 'self improvement'],
      'health': ['health tips', 'fitness', 'healthy living', 'wellness', 'nutrition'],
      'entertainment': ['entertainment', 'fun', 'viral', 'trending', 'must watch'],
      'general': ['video', 'youtube', 'content', 'new', 'latest']
    };
    
    return nicheTags[niche] || nicheTags.general;
  }

  generateLongTailKeywords(strategy) {
    const longTailTemplates = [
      `how to ${strategy.topic}`,
      `${strategy.topic} for beginners`,
      `${strategy.topic} tutorial`,
      `best ${strategy.topic}`,
      `${strategy.topic} tips and tricks`,
      `${strategy.topic} step by step`,
      `${strategy.topic} guide ${new Date().getFullYear()}`,
      `${strategy.topic} explained simply`,
      `everything about ${strategy.topic}`,
      `${strategy.topic} mistakes to avoid`
    ];
    
    return longTailTemplates.slice(0, 5);
  }

  prioritizeTags(tags, strategy) {
    // Score and sort tags by importance
    const scoredTags = tags.map(tag => {
      let score = 0;
      
      // Primary keyword gets highest score
      if (tag === strategy.keywords[0]) score += 10;
      
      // Other strategy keywords
      if (strategy.keywords.includes(tag)) score += 5;
      
      // Contains topic
      if (tag.includes(strategy.topic.toLowerCase())) score += 3;
      
      // Long-tail keywords
      if (tag.split(' ').length > 2) score += 2;
      
      // Current year
      if (tag.includes(new Date().getFullYear().toString())) score += 1;
      
      return { tag, score };
    });
    
    // Sort by score descending
    scoredTags.sort((a, b) => b.score - a.score);
    
    return scoredTags.map(item => item.tag);
  }

  async generateHashtags(strategy) {
    const hashtags = [];
    
    // Primary hashtag
    const primaryHashtag = `#${strategy.topic.replace(/\s+/g, '')}`;
    hashtags.push(primaryHashtag);
    
    // Content type hashtag
    hashtags.push(`#${strategy.contentType.toLowerCase()}`);
    
    // Trending hashtags
    const trendingHashtags = [
      '#youtube',
      '#youtuber',
      '#subscribe',
      '#video',
      '#viral',
      '#trending',
      '#new'
    ];
    
    // Niche hashtags
    const niche = this.identifyNiche(strategy);
    const nicheHashtags = {
      'technology': ['#tech', '#technology', '#innovation'],
      'gaming': ['#gaming', '#gamer', '#games'],
      'education': ['#education', '#learning', '#study'],
      'business': ['#business', '#entrepreneur', '#success'],
      'lifestyle': ['#lifestyle', '#life', '#daily'],
      'health': ['#health', '#fitness', '#wellness'],
      'entertainment': ['#entertainment', '#fun', '#funny']
    };
    
    const selectedNicheHashtags = nicheHashtags[niche] || [];
    hashtags.push(...selectedNicheHashtags.slice(0, 2));
    
    // Add 2-3 trending hashtags
    hashtags.push(...trendingHashtags.slice(0, 3));
    
    // Year hashtag
    hashtags.push(`#${new Date().getFullYear()}`);
    
    // Limit to 15 hashtags (YouTube recommendation)
    return hashtags.slice(0, 15);
  }

  async generateChapters(script) {
    const chapters = [];
    let currentTime = 0;
    
    // Introduction
    chapters.push({
      time: '00:00',
      title: 'Introduction',
      seconds: 0
    });
    
    currentTime = 20; // Intro duration
    
    // Main content chapters
    if (script.mainContent && script.mainContent.sections) {
      script.mainContent.sections.forEach(section => {
        const minutes = Math.floor(currentTime / 60);
        const seconds = currentTime % 60;
        const timeString = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        
        chapters.push({
          time: timeString,
          title: section.title || 'Section',
          seconds: currentTime
        });
        
        currentTime += section.duration || PER_PRODUCT_DURATION_DEFAULT;
      });
    }
    
    // Conclusion
    const conclusionMinutes = Math.floor(currentTime / 60);
    const conclusionSeconds = currentTime % 60;
    chapters.push({
      time: `${conclusionMinutes.toString().padStart(2, '0')}:${conclusionSeconds.toString().padStart(2, '0')}`,
      title: 'Conclusion & Next Steps',
      seconds: currentTime
    });
    
    return chapters;
  }

  async generateEndScreenStrategy() {
    return {
      elements: [
        {
          type: 'video',
          position: 'left',
          title: 'Recommended Video',
          duration: 20
        },
        {
          type: 'playlist',
          position: 'right',
          title: 'Watch More',
          duration: 20
        },
        {
          type: 'subscribe',
          position: 'center-bottom',
          duration: 20
        }
      ],
      startTime: -20, // 20 seconds before end
      template: 'standard'
    };
  }

  async calculateSEOScore(title, description, tags) {
    let score = 0;
    
    // Title scoring (30 points max)
    if (title.length >= 60 && title.length <= 70) score += 10;
    else if (title.length >= 50 && title.length <= 100) score += 5;
    
    if (/\d/.test(title)) score += 5; // Contains number
    if (/[A-Z]/.test(title)) score += 5; // Proper capitalization
    if (title.includes(new Date().getFullYear().toString())) score += 5; // Current year
    if (['how', 'what', 'why', 'best', 'top'].some(word => title.toLowerCase().includes(word))) score += 5;
    
    // Description scoring (40 points max)
    if (description.length >= 200) score += 10;
    if (description.length >= 500) score += 10;
    if (description.includes('TIMESTAMPS')) score += 5;
    if (description.includes('http')) score += 5; // Contains links
    if (description.split('\n').length > 10) score += 5; // Well formatted
    if (description.substring(0, 125).includes(tags[0])) score += 5; // Primary keyword in first 125 chars
    
    // Tags scoring (30 points max)
    if (tags.length >= 10) score += 10;
    if (tags.length >= 15) score += 5;
    if (tags.some(tag => tag.split(' ').length > 2)) score += 5; // Long-tail keywords
    if (tags.join('').length <= 500) score += 5; // Within character limit
    if (new Set(tags).size === tags.length) score += 5; // No duplicates
    
    return Math.min(100, score);
  }

  calculateOptimalLength(contentType) {
    const optimalLengths = {
      'Tutorial': '10-15 minutes',
      'Explainer': '5-10 minutes',
      'Review': '8-12 minutes',
      'List': '8-15 minutes',
      'Story': '10-20 minutes'
    };
    
    return optimalLengths[contentType] || '8-12 minutes';
  }

  selectCategory(strategy) {
    const categories = {
      'technology': 28, // Science & Technology
      'gaming': 20, // Gaming
      'education': 27, // Education
      'business': 27, // Education (closest match)
      'lifestyle': 22, // People & Blogs
      'health': 26, // Howto & Style
      'entertainment': 24 // Entertainment
    };
    
    const niche = this.identifyNiche(strategy);
    return categories[niche] || 22; // Default to People & Blogs
  }
}

module.exports = { SEOOptimizerAgent };