const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const { Logger } = require('../utils/logger');

// ═══ AUDIO DURATIONS (segundos) ═══
// INTRO: 25-35 segundos (hook + presentación de productos)
const INTRO_AUDIO_MIN = parseInt(process.env.INTRO_AUDIO_MIN || '25', 10);
const INTRO_AUDIO_MAX = parseInt(process.env.INTRO_AUDIO_MAX || '35', 10);

// PRODUCTS: 30-50 segundos por producto (narración + CTA)
const PRODUCT_AUDIO_MIN = parseInt(process.env.PRODUCT_AUDIO_MIN || '30', 10);
const PRODUCT_AUDIO_MAX = parseInt(process.env.PRODUCT_AUDIO_MAX || '50', 10);

// OUTRO/CIERRE: 5-10 segundos (like, suscripción, link)
const OUTRO_AUDIO_MIN = parseInt(process.env.OUTRO_AUDIO_MIN || '5', 10);
const OUTRO_AUDIO_MAX = parseInt(process.env.OUTRO_AUDIO_MAX || '10', 10);

// LEGACY (compatibilidad)
const PER_PRODUCT_DURATION_MIN = PRODUCT_AUDIO_MIN;
const PER_PRODUCT_DURATION_MAX = PRODUCT_AUDIO_MAX;
const PER_PRODUCT_DURATION_DEFAULT = Math.round((PER_PRODUCT_DURATION_MIN + PER_PRODUCT_DURATION_MAX) / 2);
const INTRO_DURATION_MIN = INTRO_AUDIO_MIN;
const INTRO_DURATION_MAX = INTRO_AUDIO_MAX;
const INTRO_DURATION_AVG = Math.round((INTRO_DURATION_MIN + INTRO_DURATION_MAX) / 2);

// ═══ WORD RATE CONSTANTS ═══
const WORDS_PER_SECOND = 2.5;  // TTS rate
const CTA_RESERVE = 12;        // Palabras para CTA

// ═══ DERIVED WORD COUNTS ═══
const INTRO_MIN_WORDS = Math.ceil(INTRO_AUDIO_MIN * WORDS_PER_SECOND);   // 62
const INTRO_MAX_WORDS = Math.floor(INTRO_AUDIO_MAX * WORDS_PER_SECOND);  // 87

const PRODUCT_MIN_WORDS = Math.ceil(PRODUCT_AUDIO_MIN * WORDS_PER_SECOND);   // 75
const PRODUCT_MAX_WORDS = Math.floor(PRODUCT_AUDIO_MAX * WORDS_PER_SECOND);  // 125
const NARRATION_MIN_WORDS = PRODUCT_MIN_WORDS - CTA_RESERVE;  // 63
const NARRATION_MAX_WORDS = PRODUCT_MAX_WORDS - CTA_RESERVE;  // 113

const OUTRO_MIN_WORDS = Math.ceil(OUTRO_AUDIO_MIN * WORDS_PER_SECOND);   // 12
const OUTRO_MAX_WORDS = Math.floor(OUTRO_AUDIO_MAX * WORDS_PER_SECOND);  // 25

class ScriptWriterAgent {
  constructor(db, credentials) {
    this.db = db;
    this.credentials = credentials;
    this.logger = new Logger('ScriptWriter');
    this.templates = this.loadTemplates();

    // Initialize OpenAI
    const creds = credentials.credentials || credentials;
    const apiKey = creds.openai?.apiKey || process.env.OPENAI_API_KEY;
    if (apiKey) {
      this.openai = new OpenAI({ apiKey });
    }
  }

  async initialize() {
    this.logger.info('Initializing Script Writer Agent...');
    return true;
  }

  async _getVideoClipDuration(videoPath) {
    if (!videoPath || !fs.existsSync(videoPath)) return null;
    try {
      const ffmpeg = require('fluent-ffmpeg');
      return new Promise((resolve) => {
        ffmpeg.ffprobe(videoPath, (err, meta) => {
          if (err || !meta?.format?.duration) {
            return resolve(null);
          }
          const duration = parseFloat(meta.format.duration);
          resolve(isFinite(duration) && duration > 0 ? duration : null);
        });
      });
    } catch (e) {
      return null;
    }
  }

  loadTemplates() {
    return {
      tutorial: {
        structure: ['hook', 'introduction', 'problem', 'solution_steps', 'demonstration', 'recap', 'cta'],
        tone: 'educational',
        pacing: 'moderate'
      },
      explainer: {
        structure: ['hook', 'question', 'background', 'explanation', 'examples', 'implications', 'summary', 'cta'],
        tone: 'informative',
        pacing: 'steady'
      },
      list: {
        structure: ['hook', 'introduction', 'list_items', 'bonus_item', 'summary', 'cta'],
        tone: 'engaging',
        pacing: 'quick'
      },
      review: {
        structure: ['hook', 'introduction', 'overview', 'pros', 'cons', 'comparison', 'verdict', 'cta'],
        tone: 'analytical',
        pacing: 'detailed'
      },
      story: {
        structure: ['hook', 'setup', 'conflict', 'journey', 'climax', 'resolution', 'lesson', 'cta'],
        tone: 'narrative',
        pacing: 'dynamic'
      }
    };
  }

  async generateScript(strategy, huntResults = []) {
    try {
      this.logger.info(`Generating script for: ${strategy.topic}`);

      // If strategy has productos (Top N listicle), use GPT-4o
      if (this.openai && strategy.productos && strategy.productos.length > 0) {
        return await this._generateListicleScript(strategy, huntResults);
      }
      
      const template = this.templates[strategy.contentType.toLowerCase()] || this.templates.explainer;
      
      // Generate script components
      const hook = await this.generateHook(strategy);
      const introduction = await this.generateIntroduction(strategy);
      const mainContent = await this.generateMainContent(strategy, template);
      const conclusion = await this.generateConclusion(strategy);
      const cta = await this.generateCTA(strategy);

      // Assemble complete script
      const script = {
        title: await this.generateTitle(strategy),
        hook,
        introduction,
        mainContent,
        conclusion,
        callToAction: cta,
        duration: this.estimateDuration(mainContent),
        tone: template.tone,
        pacing: template.pacing,
        keywords: strategy.keywords,
        metadata: {
          strategy: strategy,
          generatedAt: new Date().toISOString(),
          version: '1.0'
        }
      };

      // Format for readability
      script.fullScript = this.formatFullScript(script);
      
      // Save to database
      await this.db.saveScript(script);
      
      this.logger.info(`Script generated: ${script.title}`);
      return script;
    } catch (error) {
      this.logger.error('Failed to generate script:', error);
      throw error;
    }
  }

  async generateTitle(strategy) {
    const templates = [
      `${strategy.angle}`,
      `${strategy.topic}: The Complete Guide`,
      `Everything You Need to Know About ${strategy.topic}`,
      `${strategy.topic} in ${new Date().getFullYear()}: What's Changed?`,
      `The Truth About ${strategy.topic} (Shocking Results)`,
      `How to Master ${strategy.topic} in 30 Days`,
      `${strategy.topic}: Beginner to Expert Guide`
    ];

    // Select based on content type
    if (strategy.contentType === 'Tutorial') {
      return `How to ${strategy.topic}: Step-by-Step Guide`;
    } else if (strategy.contentType === 'List') {
      return `Top 10 ${strategy.topic} Tips You Need to Know`;
    } else if (strategy.contentType === 'Review') {
      return `${strategy.topic} Review: Is It Worth It?`;
    }

    return templates[Math.floor(Math.random() * templates.length)];
  }

  async generateHook(strategy) {
    const hooks = [
      {
        type: 'question',
        text: `Have you ever wondered ${this.generateQuestionAbout(strategy.topic)}?`
      },
      {
        type: 'statistic',
        text: `Did you know that ${this.generateStatistic(strategy.topic)}?`
      },
      {
        type: 'statement',
        text: `${strategy.topic} is about to change everything, and here's why...`
      },
      {
        type: 'challenge',
        text: `Most people think they understand ${strategy.topic}, but they're completely wrong.`
      },
      {
        type: 'promise',
        text: `In the next few minutes, you'll learn exactly how to master ${strategy.topic}.`
      }
    ];

    const selected = hooks[Math.floor(Math.random() * hooks.length)];
    
    return {
      type: selected.type,
      text: selected.text,
      duration: '0:00-0:05'
    };
  }

  generateQuestionAbout(topic) {
    const questions = [
      `why ${topic} is becoming so important`,
      `how ${topic} actually works`,
      `what makes ${topic} different from everything else`,
      `why experts are talking about ${topic}`,
      `how ${topic} could change your life`
    ];
    
    return questions[Math.floor(Math.random() * questions.length)];
  }

  generateStatistic(topic) {
    const stats = [
      `90% of people don't understand ${topic} correctly`,
      `${topic} has grown by 300% in the last year alone`,
      `experts predict ${topic} will be worth billions by 2030`,
      `only 1 in 10 people are using ${topic} effectively`,
      `${topic} can save you hours every single day`
    ];
    
    return stats[Math.floor(Math.random() * stats.length)];
  }

  async generateIntroduction(strategy) {
    return {
      greeting: "Hey everyone, welcome back to the channel!",
      topicIntro: `Today, we're diving deep into ${strategy.topic}.`,
      valueProposition: `By the end of this video, you'll understand exactly ${this.getValueProposition(strategy)}.`,
      credibility: this.getCredibilityStatement(strategy),
      duration: '0:05-0:20'
    };
  }

  getValueProposition(strategy) {
    const propositions = {
      'Tutorial': `how to implement ${strategy.topic} step by step`,
      'Explainer': `what ${strategy.topic} is and why it matters`,
      'List': `the most important things about ${strategy.topic}`,
      'Review': `whether ${strategy.topic} is right for you`,
      'Story': `the incredible journey of ${strategy.topic}`
    };
    
    return propositions[strategy.contentType] || `everything about ${strategy.topic}`;
  }

  getCredibilityStatement(strategy) {
    const statements = [
      "I've spent months researching this topic",
      "After working with hundreds of people on this",
      "Based on the latest research and data",
      "Drawing from real-world experience",
      "Using proven methods and strategies"
    ];
    
    return statements[Math.floor(Math.random() * statements.length)];
  }

  async generateMainContent(strategy, template) {
    const sections = [];
    
    for (const section of template.structure) {
      if (!['hook', 'introduction', 'cta'].includes(section)) {
        sections.push(await this.generateSection(section, strategy));
      }
    }
    
    return {
      sections,
      totalDuration: this.calculateSectionsDuration(sections)
    };
  }

  async generateSection(sectionType, strategy) {
    const sectionGenerators = {
      problem: () => this.generateProblemSection(strategy),
      solution_steps: () => this.generateSolutionSteps(strategy),
      demonstration: () => this.generateDemonstration(strategy),
      explanation: () => this.generateExplanation(strategy),
      examples: () => this.generateExamples(strategy),
      list_items: () => this.generateListItems(strategy),
      pros: () => this.generatePros(strategy),
      cons: () => this.generateCons(strategy),
      comparison: () => this.generateComparison(strategy),
      implications: () => this.generateImplications(strategy)
    };

    const generator = sectionGenerators[sectionType];
    
    if (generator) {
      return await generator();
    }
    
    return this.generateGenericSection(sectionType, strategy);
  }

  async generateProblemSection(strategy) {
    return {
      type: 'problem',
      title: 'The Challenge',
      content: [
        `Many people struggle with ${strategy.topic}.`,
        `The main issues are:`,
        `1. Lack of clear information`,
        `2. Complexity and confusion`,
        `3. Not knowing where to start`,
        `But don't worry, we're going to solve all of these today.`
      ],
      visuals: ['Problem illustration', 'Statistics graphic'],
      duration: 30
    };
  }

  async generateSolutionSteps(strategy) {
    const steps = [];
    const numSteps = 3 + Math.floor(Math.random() * 3); // 3-5 steps
    
    for (let i = 1; i <= numSteps; i++) {
      steps.push({
        number: i,
        title: `Step ${i}: ${this.generateStepTitle(strategy.topic, i)}`,
        description: this.generateStepDescription(strategy.topic, i),
        tip: this.generateProTip(strategy.topic)
      });
    }
    
    return {
      type: 'solution_steps',
      title: 'The Solution',
      steps,
      duration: steps.length * 45
    };
  }

  generateStepTitle(topic, stepNumber) {
    const titles = [
      'Research and Preparation',
      'Setting Up the Foundation',
      'Implementation and Execution',
      'Testing and Optimization',
      'Scaling and Automation'
    ];
    
    return titles[stepNumber - 1] || `Advanced ${topic} Techniques`;
  }

  generateStepDescription(topic, stepNumber) {
    return `This step involves understanding the key aspects of ${topic} and how to apply them effectively. Pay special attention to the details here, as they make all the difference.`;
  }

  generateProTip(topic) {
    const tips = [
      `Pro tip: Start small and scale gradually`,
      `Remember: Consistency is more important than perfection`,
      `Quick tip: Document everything as you go`,
      `Expert advice: Focus on one aspect at a time`,
      `Insider secret: This works best when combined with regular practice`
    ];
    
    return tips[Math.floor(Math.random() * tips.length)];
  }

  async generateDemonstration(strategy) {
    return {
      type: 'demonstration',
      title: 'Live Demo',
      content: [
        `Now let me show you exactly how this works.`,
        `[Screen recording or visual demonstration]`,
        `As you can see, the process is straightforward once you understand the basics.`,
        `The key is to follow the steps exactly as shown.`
      ],
      visuals: ['Screen recording', 'Step-by-step graphics'],
      duration: 120
    };
  }

  async generateExplanation(strategy) {
    return {
      type: 'explanation',
      title: 'Deep Dive',
      content: [
        `Let's break down ${strategy.topic} into its core components.`,
        `First, we need to understand the fundamental principles.`,
        `The science behind this is fascinating...`,
        `[Detailed explanation with visuals]`,
        `This is why ${strategy.topic} works so effectively.`
      ],
      visuals: ['Diagrams', 'Infographics', 'Charts'],
      duration: 90
    };
  }

  async generateExamples(strategy) {
    return {
      type: 'examples',
      title: 'Real-World Examples',
      content: [
        `Let's look at some real examples of ${strategy.topic} in action.`,
        `Example 1: [Specific case study]`,
        `Example 2: [Another relevant example]`,
        `Example 3: [Third compelling example]`,
        `These examples show the versatility and power of ${strategy.topic}.`
      ],
      visuals: ['Case study graphics', 'Before/after comparisons'],
      duration: 75
    };
  }

  async generateListItems(strategy) {
    const items = [];
    const numItems = 5 + Math.floor(Math.random() * 6); // 5-10 items
    
    for (let i = 1; i <= numItems; i++) {
      items.push({
        number: numItems - i + 1, // Countdown for engagement
        title: this.generateListItemTitle(strategy.topic, i),
        description: this.generateListItemDescription(strategy.topic),
        impact: this.generateImpactStatement()
      });
    }
    
    return {
      type: 'list_items',
      title: `Top ${numItems} Things About ${strategy.topic}`,
      items,
      duration: items.length * 30
    };
  }

  generateListItemTitle(topic, index) {
    const titles = [
      `The Hidden Power of ${topic}`,
      `Why ${topic} Matters More Than You Think`,
      `The Surprising Truth About ${topic}`,
      `How ${topic} Can Transform Your Approach`,
      `The ${topic} Secret Nobody Talks About`,
      `Mastering ${topic} in Record Time`,
      `The Ultimate ${topic} Hack`,
      `${topic}: The Game Changer`,
      `Breaking Down ${topic} Myths`,
      `The Future of ${topic}`
    ];
    
    return titles[index - 1] || `Advanced ${topic} Technique #${index}`;
  }

  generateListItemDescription(topic) {
    return `This aspect of ${topic} is crucial because it fundamentally changes how we approach the subject. Understanding this will give you a significant advantage.`;
  }

  generateImpactStatement() {
    const impacts = [
      'This alone can save you hours',
      'Game-changing for beginners',
      'Essential for long-term success',
      'Often overlooked but critical',
      'The difference between success and failure'
    ];
    
    return impacts[Math.floor(Math.random() * impacts.length)];
  }

  async generatePros(strategy) {
    return {
      type: 'pros',
      title: 'The Benefits',
      points: [
        'Easy to get started',
        'Cost-effective solution',
        'Proven results',
        'Scalable approach',
        'Community support'
      ],
      duration: 45
    };
  }

  async generateCons(strategy) {
    return {
      type: 'cons',
      title: 'Things to Consider',
      points: [
        'Learning curve at the beginning',
        'Requires consistent effort',
        'Results may vary',
        'Some technical knowledge helpful'
      ],
      duration: 30
    };
  }

  async generateComparison(strategy) {
    return {
      type: 'comparison',
      title: 'How It Compares',
      content: `Compared to alternatives, ${strategy.topic} stands out because of its unique approach and proven effectiveness.`,
      comparisonPoints: [
        'More efficient than traditional methods',
        'Better ROI than competitors',
        'Easier to implement',
        'More sustainable long-term'
      ],
      duration: 60
    };
  }

  async generateImplications(strategy) {
    return {
      type: 'implications',
      title: 'What This Means',
      content: [
        `The implications of ${strategy.topic} are far-reaching.`,
        'This will change how we think about the industry.',
        'Early adopters will have a significant advantage.',
        'The potential for growth is enormous.'
      ],
      duration: 45
    };
  }

  generateGenericSection(sectionType, strategy) {
    return {
      type: sectionType,
      title: sectionType.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
      content: `This section covers important aspects of ${strategy.topic} that you need to know.`,
      duration: 60
    };
  }

  async generateConclusion(strategy) {
    return {
      type: 'conclusion',
      title: 'Wrapping Up',
      recap: [
        `So that's everything you need to know about ${strategy.topic}.`,
        'We covered the key points:',
        '- The fundamentals and why they matter',
        '- Practical steps to get started',
        '- Real-world applications and examples',
        '- Tips for long-term success'
      ],
      finalThought: `Remember, ${strategy.topic} is a journey, not a destination. Keep learning and improving!`,
      duration: '30 seconds'
    };
  }

  async generateCTA(strategy) {
    return {
      type: 'call_to_action',
      subscribe: "If you found this helpful, make sure to subscribe and hit the notification bell!",
      like: "Give this video a thumbs up if you learned something new.",
      comment: `Let me know in the comments: What's your experience with ${strategy.topic}?`,
      nextVideo: "Check out this related video for more insights.",
      duration: '15 seconds'
    };
  }

  /**
   * MÉTODO AUXILIAR: Generar narración + CTA para UN producto individual.
   * Usa max_tokens: 350 para forzar concisión (75 palabras máximo).
   * Retorna: {asin, video_file, title, narracion, sales_cta, duracion_estimada_segundos}
   */
async _generateProductNarrationIterative(productData, channelName, language, logger) {
    const { asin, video_file, title, nombre, precio, caracteristicas_principales, marco_narrativo_obligatorio, min_palabras_narracion, max_palabras_narracion, tone_variant, hook_style } = productData;
    
    try {
      logger.info(`[IterativeGen] Generando narración para: "${title}" (${asin})`);
      
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        temperature: 1.1, // Ligeramente más alto para mayor creatividad
        frequency_penalty: 0.6, // Penaliza la repetición de frases
        max_tokens: 350,
        response_format: { type: 'json_object' },
messages: [
          {
            role: 'system',
            content: [
              `Eres un guionista de YouTube especializado en retención extrema para el canal ${channelName}. Actúa como un experto en redacción de reseñas tecnológicas directas y sin rodeos.`,
              `Idioma: ${language}. Optimiza para síntesis de voz profesional (TTS).`,
              '',
              'INSTRUCCIONES ESTRICTAS PARA LA NARRACIÓN DE CADA PRODUCTO:',
              'Debes escribir el guion utilizando el "Bucle de Reseña de Alta Retención".',
              'PROHIBIDO usar transiciones como "El número 3 es...", "A continuación tenemos...", o "Hola a todos".',
              '',
              'Para cada producto, genera un texto fluido de 4 a 5 oraciones siguiendo esta estructura exacta:',
              '',
              '1. GANCHO DE PROBLEMA (15-20 palabras): Inicia directamente describiendo un problema cotidiano, una frustración, o la limitación de una herramienta tradicional. NUNCA menciones el nombre del producto en esta primera oración. (Ej: "Grabar video pesado desde el móvil y quedarte sin almacenamiento suele convertirse en un problema rápido.")',
              '2. PRESENTACIÓN DE SOLUCIÓN (10-15 palabras): Nombra el producto y cómo resuelve ese problema específico mediante su diseño o formato. (Ej: "El [Nombre del Producto] reúne ambas cosas en un módulo magnético que se acopla detrás del teléfono.")',
              '3. ESPECIFICACIONES TÉCNICAS RÁPIDAS (20-30 palabras): Enumera 3 o 4 características técnicas reales (batería, materiales, puertos, potencia). Usa conectores ágiles como "mientras", "además", "también integra". No uses adjetivos vacíos como "maravilloso" o "increíble"; usa datos duros.',
              '4. CIERRE DIRECTO (10 palabras): Termina siempre el bloque mencionando su precio aproximado y su disponibilidad. Usa variaciones de: "Su precio ronda los [Precio] y se consigue en Amazon." o "Actualmente cuesta unos [Precio] en Amazon."',
              '',
              'PROHIBICIONES ABSOLUTAS:',
              '- ❌ Símbolo "$" (escribe SIEMPRE la palabra "dólares").',
              '- ❌ Repetir la misma frase de cierre en todos los productos.',
              '- ❌ "Hola", "Bienvenidos", "Amigos".',
              '- ❌ REPETIR EL NOMBRE DEL PRODUCTO: Menciónalo SOLO UNA VEZ al principio. En el cierre usa exclusivamente pronombres.',
              '- REGLA DE LOCUCIÓN FONÉTICA: Escribe el guion EXACTAMENTE como debe ser pronunciado por un locutor humano.',
              '- DESTRUYE símbolos impronunciables: Elimina ™, ®, ©, ³, ², +, &, /.',
              '- LECTURA LITERAL: Escribe los porcentajes y símbolos como palabras.',
              '',
              `Marco narrativo asignado: ${marco_narrativo_obligatorio}`,
              `Tono deseado: Objetivo, profesional, rápido y directo al grano.`,
              '',
              'Responde ÚNICAMENTE en JSON:',
              '{',
              '  "narracion": "<bloques 1+2+3 combinados con puntuación TTS-optimizada>",',
              '  "word_count": <número exacto de palabras>,',
              '  "sales_cta": "<el bloque 4 generado de forma creativa y única>",',
              '  "escenas_visuales": ["prompt visual 1", "prompt visual 2", "prompt visual 3"]',
              '}'
            ].join('\n')
          },
          {
            role: 'user',
            content: [
              `Producto: ${title}`,
              `Precio: ${precio}`,
              `Características: ${caracteristicas_principales.join('; ')}`,
              `Genera la narración y un CTA único integrando Amazon y el precio.`
            ].join('\n')
          }
        ]
      });

      const content = response.choices[0].message.content;
      let parsed = JSON.parse(content);

      const narracionText = (parsed.narracion || '').trim();
      const ctaText = (parsed.sales_cta || `Disponible en Amazon por ${precio}. Link en comentarios.`).trim();
      const totalWords = narracionText.split(/\s+/).length + ctaText.split(/\s+/).length;
      const estimatedSeconds = Math.ceil(totalWords / 2.5);

      return {
        asin, video_file, title,
        narracion: narracionText,
        sales_cta: ctaText,
        escenas_visuales: parsed.escenas_visuales || [],
        duracion_estimada_segundos: estimatedSeconds,
        word_count: totalWords,
        metadata: { framework: marco_narrativo_obligatorio, validated: true }
      };
    } catch (error) {
      logger.error(`[IterativeGen] ❌ Error generando ${title}: ${error.message}`);
      return {
        asin, video_file, title, narracion: '',
        sales_cta: `Lo encuentras en Amazon por ${precio}. Link en el primer comentario.`,
        duracion_estimada_segundos: null, word_count: 0,
        metadata: { validated: false, error: error.message }
      };
    }
  }

  /**
   * Generate a Top N listicle script using GPT-4o.
   * Each product gets its own section with a mandatory sales CTA.
   */
  async _generateListicleScript(strategy, huntResults = []) {
    const channelName = process.env.CHANNEL_NAME || 'Canal';
    const language = process.env.CONTENT_LANGUAGE || 'es';
    const currentYear = new Date().getFullYear();
    const productos = strategy.productos;
    // Fuente de verdad: strategy.numProductos (del regex original), fallback a productos.length
    const numProductos = strategy.numProductos || productos.length;

    // Sanear el título del video: si GPT puso "Top 5" pero son 3, corregirlo antes de enviarlo
    const tituloSaneado = (strategy.topic || '').replace(/\b(Top|top|TOP)\s+\d+/i, `Top ${numProductos}`);

    // Nota de adaptación dinámica (cuando clips disponibles < solicitados)
    const adaptationNote = strategy._adaptationNote || '';

    // introProductsOrder: orden exacto de clips y productos para la introducción.
    // Si está disponible, el hook debe describir estos productos en este orden.
    const introProductsOrder = (strategy.introProductsOrder && strategy.introProductsOrder.length > 0)
      ? strategy.introProductsOrder
      : null;
    const numIntroSentences = introProductsOrder ? introProductsOrder.length : numProductos;

    this.logger.info(`Generating Top ${numProductos} listicle script for ${numProductos} products...${adaptationNote ? ' [ADAPTADO]' : ''}`);

    // ═══════════════════════════════════════════════════════════════
    //  LECTURA OBLIGATORIA: productos_locales.json (fuente de verdad)
    //  Se lee SIEMPRE antes de llamar a OpenAI para inyectar datos reales.
    //  Bypass de cualquier caché: se lee desde disco en cada ejecución.
    // ═══════════════════════════════════════════════════════════════
    let localDb = [];
    const localDbPath = path.resolve(__dirname, '..', 'productos_locales.json');
    try {
      if (fs.existsSync(localDbPath)) {
        // Forzar lectura fresca (bypass caché de require)
        const rawContent = fs.readFileSync(localDbPath, 'utf8');
        localDb = JSON.parse(rawContent);
        if (!Array.isArray(localDb)) localDb = [];
        this.logger.info(`📦 ScriptWriter: ${localDb.length} productos cargados de productos_locales.json (lectura fresca)`);
      }
    } catch (e) {
      this.logger.warn(`Error leyendo productos_locales.json: ${e.message}`);
    }

    // Construir lista de productos con datos REALES (local DB primero, luego huntResults)
    const _norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();

    // Helper: normalize filename base (strip _combined and extension) and
    // compare tolerant variants (exact match OR base-equal).
    const _normalizeFilenameBase = (fname) => {
      if (!fname) return null;
      return String(fname).toLowerCase().replace(/_combined/gi, '').replace(/\.[^.]+$/, '').trim();
    };
    const _filenamesMatch = (a, b) => {
      if (!a || !b) return false;
      if (a === b) return true;
      const ba = _normalizeFilenameBase(a);
      const bb = _normalizeFilenameBase(b);
      return !!(ba && bb && ba === bb);
    };

    // ── DINAMISMO NARRATIVO: 6 marcos rotativos con offset aleatorio ──
    // Offset aleatorio + rotación garantiza variación entre videos y entre productos.
    const FRAMEWORKS = [
      { id: 'problema_solucion',      label: 'PROBLEMA → SOLUCIÓN',
        desc: 'Abre con un problema cotidiano y frustrante; revela el producto como la solución directa. Ej: "¿Cansado de cables enredados? Este cargador..."' },
      { id: 'enfoque_caracteristica', label: 'ENFOQUE EN LA CARACTERÍSTICA',
        desc: 'Abre con la característica técnica más impresionante (material, potencia, tamaño). Ej: "Construido en aluminio aeronáutico, este soporte..."' },
      { id: 'beneficio_oculto',       label: 'BENEFICIO OCULTO',
        desc: 'Abre revelando un uso no obvio o un secreto poco conocido del producto. Ej: "Lo que nadie te dice de esta lámpara es que..."' },
      { id: 'comparacion_precio',     label: 'COMPARACIÓN DE PRECIO',
        desc: 'Contrasta el precio con lo que parece valer. Ej: "Parece de doscientos dólares. Cuesta cuarenta."' },
      { id: 'dato_numerico',          label: 'DATO NUMÉRICO DE IMPACTO',
        desc: 'Abre con una cifra o estadística sorprendente. Ej: "Tres millones de unidades vendidas en doce meses."' },
      { id: 'experiencia_sensorial',  label: 'EXPERIENCIA SENSORIAL',
        desc: 'Describe la sensación de usarlo por primera vez. Ej: "La primera vez que lo enciendes, no puedes creer que cuesta tan poco."' }
    ];
    const frameworkOffset = Math.floor(Math.random() * FRAMEWORKS.length);

    // ── ESTILO DE HOOK: rotación entre 4 estilos de apertura visual ──
    const HOOK_STYLES = [
      { id: 'accion_directa',   desc: 'Cada oración arranca con un verbo en presente. Ej: "Corta en segundos. Sella al instante. Purifica sin químicos."' },
      { id: 'pregunta_corta',   desc: 'Cada oración es una pregunta retórica de máximo 5 palabras. Ej: "¿En segundos? ¿Sin esfuerzo? ¿A ese precio?"' },
      { id: 'adjetivo_impacto', desc: 'Cada oración abre con un adjetivo chocante. Ej: "Imposiblemente rápido. Increíblemente pequeño. Ridículamente barato."' },
      { id: 'telegrama',        desc: 'Frases telegráficas sin artículo, máximo 4 palabras cada una. Ej: "Corte perfecto. Sellado hermético. Pureza total."' }
    ];
    const hookStyle = HOOK_STYLES[Math.floor(Math.random() * HOOK_STYLES.length)];

    // ── TONO DEL VIDEO: 4 registros narrativos alternos ──
    const TONE_VARIANTS = [
      'directo y urgente, como si el producto se agotara mañana',
      'analítico y preciso, como un ingeniero que explica por qué esto es superior',
      'conversacional y cercano, como si le contaras a un amigo algo increíble que descubriste',
      'entusiasta y acelerado, como un presentador de teletienda pero sin relleno ni repetición'
    ];
    const toneVariant = TONE_VARIANTS[Math.floor(Math.random() * TONE_VARIANTS.length)];

    // ── INTRODUCCIÓN: 4 variantes para romper la fórmula fija ──
    const INTRO_VARIANTS = [
      '"Suscríbete. Los links están en el primer comentario."',
      '"¿Cuál querrías tú? Los links están en el primer comentario."',
      '"Todo está en el primer comentario. Vamos."',
      '"Los links de compra están en el primer comentario. Empezamos."'
    ];
    const introVariant = INTRO_VARIANTS[Math.floor(Math.random() * INTRO_VARIANTS.length)];

    // ── MEDICIÓN DE DURACIÓN DE VIDEO: _combined.mp4 para cada producto ──
    // Se miden ANTES de hacer el map para poder usar await
    this.logger.info('[ScriptWriter] 🎬 Midiendo duración de _combined.mp4 para cada producto...');
    const videoDurations = await Promise.all(
      productos.map((p, i) => {
        const hunt = huntResults[i];
        if (hunt?.videoPath) {
          return this._getVideoClipDuration(hunt.videoPath)
            .then(dur => ({index: i, duration: dur}))
            .catch(err => {
              this.logger.warn(`[ScriptWriter]   ⚠ Error midiendo video ${i}: ${err.message} → fallback 60s`);
              return {index: i, duration: 60};
            });
        }
        return Promise.resolve({index: i, duration: 60});
      })
    );
    
    // Crear mapa de índice → duración para acceso rápido
    const videoDurationMap = {};
    videoDurations.forEach(({index, duration}) => {
      videoDurationMap[index] = duration;
      if (duration) this.logger.info(`[ScriptWriter]   📹 Producto ${index}: ${duration.toFixed(1)}s`);
    });

    const productLines = productos.map((p, i) => {
      const nombre = typeof p === 'string' ? p : (p.nombre || '');
      const prodId = typeof p === 'object' ? p.id : null;
      const prodFilename = typeof p === 'object' ? p.filename : null;

      // Buscar en localDb por id, filename, o nombre
      let localEntry = null;
      if (localDb.length > 0) {
        if (prodId) localEntry = localDb.find(lp => lp.id === prodId);
        if (!localEntry && prodFilename) localEntry = localDb.find(lp => lp.filename === prodFilename);
        if (!localEntry) localEntry = localDb.find(lp => _norm(lp.product_name) === _norm(nombre));
      }

      // Precio: local DB > huntResults > genérico
      const hunt = huntResults[i];
      let precioTexto = 'consulta el enlace';
      // Preferir el precio detectado por el hunter (fuente real/online).
      // Si no existe, usar la entrada local como fallback.
      if (hunt && hunt.precio) {
        const num = Math.round(parseFloat(String(hunt.precio).replace(/[^0-9.]/g, '')));
        precioTexto = !isNaN(num) ? `${num} dólares` : hunt.precio;
      } else if (localEntry && localEntry.price) {
        precioTexto = `${localEntry.price} dólares`;
      }

      // Nombre real: local DB es la fuente de verdad
      const nombreReal = localEntry ? localEntry.product_name : nombre;
      const id = localEntry ? localEntry.id : (prodId || `prod_${i}`);
      const filename = localEntry ? localEntry.filename : (prodFilename || null);
      const asin = (hunt && hunt.asin) || (filename ? filename.replace(/\.[^.]+$/, '') : id);

      // ── Datos estructurados para aislamiento de contexto ──
      // Se pasan al LLM como JSON limpio por producto, evitando sangrado de contexto.
      const brand = (hunt && hunt.brand) || null;
      // USAR 6 FEATURES (en lugar de 4)
      const features = (hunt && Array.isArray(hunt.features) && hunt.features.length > 0)
        ? hunt.features.slice(0, 6)
        : [];

      // USAR VIDEODURATION DEL MAPA (YA MEDIDA EN PARALELO)
      const videoDuration = videoDurationMap[i] || 60;
      if (videoDuration && videoDuration !== 60) {
        this.logger.info(`[ScriptWriter]   📹 ${nombreReal}: video=${videoDuration.toFixed(1)}s`);
      }

      // NARRACIÓN PARA AUDIO DE 30-50 SEGUNDOS (INDEPENDIENTE DEL VIDEO)
      // La narración debe ocupar entre 63-113 palabras para sonar bien en 30-50s
      // El CTA ocupa ~12 palabras aparte
      const minNarrationWords = NARRATION_MIN_WORDS;  // 63
      const maxNarrationWords = NARRATION_MAX_WORDS;  // 113

      // Marco narrativo asignado deterministamente con rotación anti-repetición
      const framework = FRAMEWORKS[(frameworkOffset + i) % FRAMEWORKS.length];

      // ── CONTEXTO HÍBRIDO: Top 3 tags + metadatos visuales ──────────────────
      // Extrae los 3 tags más frecuentes de scoredAssets para que el LLM sepa
      // qué visuals realmente hay disponibles, sin overhead de todas las escenas.
      let tagFrequency = {};
      let escenasDisponibles = 0;
      if (hunt && Array.isArray(hunt.scoredAssets) && hunt.scoredAssets.length > 0) {
        escenasDisponibles = hunt.scoredAssets.length;
        hunt.scoredAssets.forEach(asset => {
          if (asset.tag) {
            tagFrequency[asset.tag] = (tagFrequency[asset.tag] || 0) + 1;
          }
        });
      }
      
      // Top 3 tags ordenados por frecuencia
      const top3Tags = Object.entries(tagFrequency)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([tag, _]) => tag);
      
      // Booleano: ¿Es video real o fallback a slideshow?
      // Si hay >3 escenas válidas, es video real. Si no, probablemente es slideshow.
      const tieneVideoReal = escenasDisponibles > 3;

      const structuredBlock = JSON.stringify({
        nombre: nombreReal,
        marca: brand || 'N/A',
        precio: precioTexto,
        caracteristicas_principales: features,
        duracion_video_segundos: videoDuration || 60,
        audio_objetivo_segundos: `${PRODUCT_AUDIO_MIN}-${PRODUCT_AUDIO_MAX}`,
        min_palabras_narracion: minNarrationWords,
        max_palabras_narracion: maxNarrationWords,
        marco_narrativo_obligatorio: framework.label,
        escenas_disponibles: escenasDisponibles,
        tags_principales: top3Tags.length > 0 ? top3Tags : [],
        tiene_video_real: tieneVideoReal,
        orden_escenas_sugerido: top3Tags.length > 0 ? top3Tags : []
      }, null, 2);

      return {
        line: `${i + 1}. [ID: ${id}] ${nombreReal} — Precio: ${precioTexto}`,
        structuredBlock, nombreReal, id, filename, precioTexto, asin,
        videoDuration, minNarrationWords, maxNarrationWords, framework, features
      };
    });

    // ═══════════════════════════════════════════════════════════════
    // 🔄 ENFOQUE ITERATIVO: Generar cada producto INDIVIDUALMENTE
    // max_tokens: 150 fuerza concisión física (75 palabras máximo por producto)
    // ═══════════════════════════════════════════════════════════════
    
    this.logger.info(`[ScriptWriter] 🔄 GENERACIÓN ITERATIVA: Iniciando ${numProductos} llamadas independientes a GPT-4o...`);
    const iterativeProductos = [];
    
    for (let i = 0; i < productLines.length; i++) {
      const pl = productLines[i];
      
      try {
        // Preparar data del producto para la llamada iterativa
        const productData = {
          asin: pl.asin,
          video_file: pl.filename || `${pl.asin}.mp4`,
          title: pl.nombreReal,
          nombre: pl.nombreReal,
          precio: pl.precioTexto,
          caracteristicas_principales: pl.features || [],
          marco_narrativo_obligatorio: pl.framework.label,
          min_palabras_narracion: pl.minNarrationWords,
          max_palabras_narracion: pl.maxNarrationWords,
          // Hints para variar la narración por producto
          tone_variant: toneVariant,
          hook_style: { id: hookStyle.id, desc: hookStyle.desc }
        };
        
        // Llamada iterativa independiente
        const result = await this._generateProductNarrationIterative(productData, channelName, language, this.logger);
        iterativeProductos.push(result);
        
      } catch (err) {
        this.logger.error(`[ScriptWriter]   ❌ Error en producto ${i + 1}/${numProductos}: ${err.message}`);
        // Agregar fallback vacío para este producto
        iterativeProductos.push({
          asin: pl.asin,
          video_file: pl.filename || `${pl.asin}.mp4`,
          title: pl.nombreReal,
          narracion: '',
          sales_cta: `Su precio actual ronda los... ${pl.precioTexto}. ¡Link ya!`,
          duracion_estimada_segundos: null,
          word_count: 0,
          metadata: { error: err.message }
        });
      }
    }
    
    this.logger.info(`[ScriptWriter] ✅ Generación iterativa completada: ${iterativeProductos.length}/${numProductos} productos`);
    
    // Construir objeto parsed compatible con el resto del pipeline
    const parsed = {
      title: tituloSaneado,
      hook: '',  // Se generará después
      introduccion: '',  // Se generará después
      productos: iterativeProductos.map(p => ({
        asin: p.asin,
        video_file: p.video_file,
        title: p.title,
        narracion: p.narracion,
        narracion_segments: null,
        sales_cta: p.sales_cta,
        escenas_visuales: p.escenas_visuales, // <-- ¡AGREGA ESTA LÍNEA!
        duracion_estimada_segundos: p.duracion_estimada_segundos,
        metadata: p.metadata
      })),
      cierre: ''  // Se generará después
    };

    // ═══ VALIDACIÓN ANTI-ALUCINACIÓN: Forzar nombres exactos de productos_locales ═══
    // Si GPT cambió/inventó un nombre, lo reemplazamos con el nombre real.
    // productLines ya contiene los datos enriquecidos con id, filename, nombreReal.
    const nombresReales = productLines.map(pl => pl.nombreReal);

    if (parsed.productos) {
      for (let i = 0; i < parsed.productos.length; i++) {
        const secTitle = parsed.productos[i].title || '';
        const secTitleNorm = _norm(secTitle);

        // Buscar match exacto o parcial con algún producto real
        let matchIdx = nombresReales.findIndex(n => _norm(n) === secTitleNorm);
        if (matchIdx === -1) {
          matchIdx = nombresReales.findIndex(n => {
            const nn = _norm(n);
            return nn && secTitleNorm && (secTitleNorm.includes(nn) || nn.includes(secTitleNorm));
          });
        }

        if (matchIdx !== -1) {
          if (secTitle !== nombresReales[matchIdx]) {
            this.logger.warn(`Anti-alucinación: producto ${i} "${secTitle}" → forzado a "${nombresReales[matchIdx]}"`);
            parsed.productos[i].title = nombresReales[matchIdx];
          }
        } else {
          const realName = i < nombresReales.length ? nombresReales[i] : nombresReales[0];
          this.logger.warn(`Anti-alucinación: producto ${i} "${secTitle}" es INVENTADO → reemplazado por "${realName}"`);
          parsed.productos[i].title = realName;
        }
      }

      // ═══ REORDENAMIENTO: Alinear parsed.productos al orden de productLines ═══
      const reordered = [];
      const usedGptIdx = new Set();

      for (let p = 0; p < productLines.length; p++) {
        const targetNorm = _norm(productLines[p].nombreReal);
        let found = -1;

        // Match exacto por título
        for (let g = 0; g < parsed.productos.length; g++) {
          if (usedGptIdx.has(g)) continue;
          if (_norm(parsed.productos[g].title) === targetNorm) { found = g; break; }
        }
        // Match parcial si no hubo exacto
        if (found === -1) {
          for (let g = 0; g < parsed.productos.length; g++) {
            if (usedGptIdx.has(g)) continue;
            const gn = _norm(parsed.productos[g].title);
            if (gn && targetNorm && (gn.includes(targetNorm) || targetNorm.includes(gn))) { found = g; break; }
          }
        }

        if (found !== -1) {
          if (found !== p) {
            this.logger.warn(`Reordenamiento: productLines[${p}] "${productLines[p].nombreReal}" ← parsed.productos[${found}] (estaba en posición ${found})`);
          }
          reordered.push(parsed.productos[found]);
          usedGptIdx.add(found);
        } else {
          const fallbackIdx = [...Array(parsed.productos.length).keys()].find(g => !usedGptIdx.has(g));
          if (fallbackIdx !== undefined) {
            this.logger.warn(`Reordenamiento fallback: productLines[${p}] ← parsed.productos[${fallbackIdx}]`);
            reordered.push(parsed.productos[fallbackIdx]);
            usedGptIdx.add(fallbackIdx);
          }
        }
      }

      if (reordered.length === productLines.length) {
        parsed.productos = reordered;
        this.logger.info(`Productos reordenados: ${reordered.map(s => s.title).join(' → ')}`);
      } else {
        this.logger.warn(`Reordenamiento parcial (${reordered.length}/${productLines.length}), manteniendo orden original de GPT.`);
      }

      // ═══ ENFORCE WORD BUDGET (defensivo): truncar narracion si excede max_palabras ═══
      // Si GPT ignoró el límite, recortamos para no romper la sincronización AV.
      for (let i = 0; i < parsed.productos.length; i++) {
        const pl = productLines[i];
        if (!pl || !pl.maxNarrationWords) continue;
        const words = (parsed.productos[i].narracion || '').trim().split(/\s+/).filter(Boolean);
        if (words.length > pl.maxNarrationWords) {
          const truncated = words.slice(0, pl.maxNarrationWords).join(' ');
          // Reasegurar punto final
          const final = /[.!?]$/.test(truncated) ? truncated : truncated + '.';
          this.logger.warn(`AV-sync: narracion[${i}] tenía ${words.length} palabras (máx ${pl.maxNarrationWords}) → truncada`);
          parsed.productos[i].narracion = final;
        }
      }
    }

    this.logger.info(`GPT-4o script generated: ${parsed.title}`);

    // ═══════════════════════════════════════════════════════════════
    //  VALIDACIÓN DINÁMICA DEL HOOK (intro temático multi-producto)
    //
    //  El hook debe contener EXACTAMENTE numIntroSentences oraciones
    //  (una por clip de intro mostrado en pantalla). Si GPT devuelve
    //  un hook con 1 sola frase enfocada en el primer producto, el
    //  intro se siente desconectado del montaje visual.
    //
    //  Estrategia adaptativa:
    //   1) Contar oraciones (separadas por . ! ?)
    //   2) Si faltan oraciones, completar con teasers genéricos basados
    //      en `introProductsOrder` (un teaser por producto faltante,
    //      describiendo visualmente sin mencionar el nombre).
    //   3) Si sobran oraciones, recortar a numIntroSentences.
    // ═══════════════════════════════════════════════════════════════
    if (parsed.hook && typeof parsed.hook === 'string' && numIntroSentences > 0) {
      const splitSentences = (txt) => txt
        .split(/(?<=[.!?])\s+/)
        .map(s => s.trim())
        .filter(s => s.length > 3);

      let sentences = splitSentences(parsed.hook);
      const expected = numIntroSentences;

      if (sentences.length < expected) {
        const order = introProductsOrder || productLines.slice(0, expected).map(pl => ({ nombre: pl.nombreReal }));
        const missing = expected - sentences.length;
        this.logger.warn(`Hook validation: ${sentences.length}/${expected} oraciones → completando ${missing} teaser(s) genérico(s) para clips de intro`);
        for (let i = sentences.length; i < expected; i++) {
          const item = order[i] || order[order.length - 1] || { nombre: 'producto' };
          const nombre = (item.nombre || 'producto').toString().trim();
          const TEASER_TEMPLATES = [
            `Mira lo que pasa cuando pruebas: ${nombre}.`,
            `Observa en uso real a: ${nombre}.`,
            `No vas a creer el potencial de: ${nombre}.`,
            `Atento a los detalles de: ${nombre}.`,
            `Así se ve en la vida real: ${nombre}.`
          ];
          const tmpl = TEASER_TEMPLATES[Math.floor(Math.random() * TEASER_TEMPLATES.length)];
          sentences.push(tmpl);
        }
      } else if (sentences.length > expected) {
        this.logger.warn(`Hook validation: ${sentences.length}/${expected} oraciones → recortando a ${expected}`);
        sentences = sentences.slice(0, expected);
      }

      parsed.hook = sentences.join(' ');
      this.logger.info(`Hook adaptativo final (${sentences.length} oraciones, ${parsed.hook.split(/\s+/).length} palabras): "${parsed.hook.substring(0, 120)}${parsed.hook.length > 120 ? '...' : ''}"`);
    }

    // ═══════════════════════════════════════════════════════════════
    // FALLBACK: Si GPT no devolvió ningún `hook` o `introduccion`, generar
    // un hook determinista basado en el orden de productos y una
    // introducción por defecto para evitar que la producción caiga en
    // usar `strategy.introScript` como único recurso.
    // ═══════════════════════════════════════════════════════════════
    if (!parsed.hook || String(parsed.hook).trim().length === 0) {
      const order = introProductsOrder || productLines.slice(0, numIntroSentences).map(pl => ({ nombre: pl.nombreReal }));
      const fallbackSentences = [];
      const TEASER_TEMPLATES_GLOBAL = [
        'Mira lo que pasa cuando pruebas: %s.',
        'Observa en uso real a: %s.',
        'No vas a creer el potencial de: %s.',
        'Atento a los detalles de: %s.',
        'Así se ve en la vida real: %s.'
      ];
      for (let i = 0; i < Math.max(1, numIntroSentences); i++) {
        const item = order[i] || order[order.length - 1] || { nombre: 'este gadget' };
        const nombre = (item.nombre || 'este gadget').toString().replace(/[\"]+/g, '').trim();
        const tmpl = TEASER_TEMPLATES_GLOBAL[Math.floor(Math.random() * TEASER_TEMPLATES_GLOBAL.length)];
        const sentence = tmpl.includes('%s') ? tmpl.replace('%s', nombre) : tmpl;
        fallbackSentences.push(sentence);
      }
      parsed.hook = fallbackSentences.join(' ');
      this.logger.info(`Fallback hook generado: "${parsed.hook.substring(0, 120)}${parsed.hook.length > 120 ? '...' : ''}"`);
    }

    if (!parsed.introduccion || String(parsed.introduccion).trim().length === 0) {
      // Usar variante de intro templada definida arriba, quitando comillas si existen
      parsed.introduccion = (introVariant || 'Hola, bienvenido. Estos son los gadgets más innovadores de hoy.').replace(/^\"|\"$/g, '');
      this.logger.info(`Fallback introduccion generada: "${parsed.introduccion}"`);
    }

    // Convert GPT-4o response to pipeline-compatible script format
    // Cada sección lleva id, filename, productName de productos_locales.json
    // para matching exacto por filename en el ensamblaje FFmpeg.
    // MAPEO POR TÍTULO: Busca el productLine correcto por nombre, no por índice.
    // Esto garantiza que si el reordenamiento falló parcialmente, cada sección
    // todavía recibe el filename/id/precio del producto correcto.
    // ═══ MAPEO POSICIONAL DETERMINISTA ═══
    // Después del reordenamiento, productos[i] DEBE corresponder a productLines[i].
    // Se asignan filename/productId/productName SIEMPRE desde productLines[i] (fuente de verdad),
    // NUNCA desde lo que GPT devolvió, eliminando toda posibilidad de cruce.
    const sections = (parsed.productos || []).map((s, i) => {
      const pl = productLines[i] || {};
      const hunt = huntResults.find(h => h && (h.productId === pl.id || _filenamesMatch(h.filename, pl.filename))) || huntResults[i];

      if (pl.nombreReal && _norm(s.title) !== _norm(pl.nombreReal)) {
        this.logger.warn(`Mapeo posicional: producto ${i} título GPT "${s.title}" ≠ productLines[${i}] "${pl.nombreReal}" → se fuerza nombre correcto`);
      }

      return {
        type: 'content',
        title: pl.nombreReal || s.title,
        productId: pl.id || (hunt && hunt.asin) || `prod_${i}`,
        productName: pl.nombreReal || s.title,
        filename: pl.filename || (hunt && hunt.filename) || null,
        asin: pl.asin || (hunt && hunt.asin) || null,
        videoDuration: pl.videoDuration || 60,
        estimatedAudioSeconds: s.duracion_estimada_segundos || null,
        framework: pl.framework ? pl.framework.id : null,
        narracionSegments: Array.isArray(s.narracion_segments) ? s.narracion_segments : null,
        content: [
          s.narracion,
          s.sales_cta
        ],
        visuals: [`Product image: ${pl.nombreReal || s.title}`],
        duration: 25
      };
    });

    // ── FALLBACK FINAL ADAPTATIVO: features del producto si narracion sigue vacía ─────────
    // Versión mejorada con cobertura dinámica para garantizar 30-55s de narración.
    // Si GPT Y la re-generación fallaron, genera narración a partir de características reales
    // del producto, escalando según la duración disponible del clip.
    
    const _buildDynamicNarration = (productName, brand, features, clipDuration, maxWords) => {
      const WORDS_PER_SECOND = 2.5;
      const CTA_WORDS = 12;  // "Su precio actual en Amazon ronda los... X dólares. ¡Link..."
      
      // Palabras reales disponibles para narración
      const availableWords = Math.max(40, (maxWords || Math.floor((clipDuration || 25) * WORDS_PER_SECOND) - CTA_WORDS));
      const productNameClean = (productName || 'Este producto').trim();
      const brandClean = brand && brand !== 'N/A' ? brand.trim() : null;
      
      // Sin características: narración genérica pero coherente
      if (!features || features.length === 0) {
        const generic = `${productNameClean} es una solución integral y de alta calidad disponible en Amazon. ` +
                       `Diseñado para satisfacer tus necesidades con durabilidad y funcionalidad, ` +
                       `${brandClean ? `de la marca ${brandClean}, ` : ''}` +
                       `este producto combina innovación y practicidad. ` +
                       `Consulta los detalles completos en el enlace del primer comentario.`;
        return generic;
      }
      
      // Con características: construir narración escalable según disponibilidad
      const useFeatures = features.slice(0, Math.min(6, features.length));
      const featureCount = useFeatures.length;
      
      // Estrategia 1: Si hay pocas palabras (clips cortos), ser conciso
      if (availableWords <= 50) {
        const shortFeatures = useFeatures.slice(0, 3)
          .map(f => f.charAt(0).toLowerCase() + f.slice(1).replace(/\s+/g, ' '))
          .join('; ');
        return `${productNameClean} combina ${shortFeatures}. ` +
               `${brandClean ? `De ${brandClean}, ` : ''}` +
               `es la solución que necesitas para mejorar tu experiencia.`;
      }
      
      // Estrategia 2: Mediano (clips estándar 25-35s), incluir marca y contexto
      if (availableWords <= 75) {
        const mediumFeatures = useFeatures.slice(0, 4)
          .map((f, idx) => {
            const clean = f.charAt(0).toLowerCase() + f.slice(1).replace(/\s+/g, ' ');
            return idx === 0 ? clean : clean;
          })
          .join('; ');
        return `${productNameClean} es una solución versátil que combina varias características clave. ` +
               `Cuenta con ${mediumFeatures}. ` +
               `${brandClean ? `La marca ${brandClean} garantiza ` : 'Esto garantiza '}` +
               `calidad y durabilidad en cada detalle.`;
      }
      
      // Estrategia 3: Largo (clips extensos 35-50s), incluir todas las características
      const longFeatures = useFeatures
        .map((f, idx) => {
          const clean = f.charAt(0).toLowerCase() + f.slice(1).replace(/\s+/g, ' ');
          if (idx === useFeatures.length - 1) return `y ${clean}`;
          return clean;
        })
        .join('; ');
      
      return `${productNameClean} es una solución completa que reúne lo mejor en innovación y funcionalidad. ` +
             `${brandClean ? `De la marca ${brandClean}, ` : ''}` +
             `este producto destaca por sus características versátiles: ${longFeatures}. ` +
             `Cada aspecto está diseñado para ofrecerte la mejor experiencia posible. ` +
             `Descubre por qué miles de usuarios confían en esta solución.`;
    };
    
    let _emptyFinalCount = 0;
    for (let i = 0; i < sections.length; i++) {
      const _sec = sections[i];
      const _hasContent = Array.isArray(_sec.content)
        && _sec.content.some(c => typeof c === 'string' && c.trim().length > 10);
      if (!_hasContent) {
        _emptyFinalCount++;
        const _pl = productLines[i] || {};
        const _hunt = (Array.isArray(huntResults) ? huntResults : []).find(
          h => h && (h.productId === _pl.id || _filenamesMatch(h.filename, _pl.filename))
        ) || (Array.isArray(huntResults) ? huntResults[i] : null);
        
        const _features = (_hunt && Array.isArray(_hunt.features) && _hunt.features.length > 0) ? _hunt.features : [];
        const _brand = (_hunt && _hunt.brand) || _pl.marca || null;
        const _maxWords = _pl.maxNarrationWords || NARRATION_MAX_WORDS;
        
        // Usar narración adaptativa dinámica (independiente de videoDuration, basada en audio 30-50s)
        const _narrFallback = _buildDynamicNarration(_pl.nombreReal || _sec.title, _brand, _features, PRODUCT_AUDIO_MAX, _maxWords);
        const _ctaFallback = `Su precio actual en Amazon ronda los... ${_pl.precioTexto || 'consulta el enlace'}. ¡Link en el primer comentario!`;
        
        const wordCount = _narrFallback.split(/\s+/).length;
        const estimatedSeconds = Math.ceil((wordCount + 12) / 2.5);
        this.logger.warn(`[ScriptWriter] ⚠ Fallback adaptativo para sección ${i} "${_sec.title}" (${wordCount}w [${estimatedSeconds}s objetivo: ${PRODUCT_AUDIO_MIN}-${PRODUCT_AUDIO_MAX}s])`);
        _sec.content = [_narrFallback, _ctaFallback];
      }
    }
    if (_emptyFinalCount > 0) {
      this.logger.warn(`[ScriptWriter] ⚠ ${_emptyFinalCount}/${sections.length} secciones usaron fallback adaptativo (GPT+regeneración fallaron)`);
    }

    // ═══════════════════════════════════════════════════════════════
    //  VALIDACIÓN DETERMINISTA POST-GPT: Forzar filename y productId
    //  Compara cada sección contra el catálogo (localDb) y sobreescribe
    //  filename/productId para garantizar matemáticamente la correspondencia.
    //  Si GPT mezcló identificadores, este bloque lo corrige.
    // ═══════════════════════════════════════════════════════════════
    this._forceIdentifiersFromCatalog(sections, localDb, productLines, this.logger);

// 🔥 ROTADOR SECUENCIAL CON MEMORIA (EN LA FUNCIÓN ACTIVA) 🔥

    
    const rootDir = path.resolve(__dirname, '..');
    const trackerPath = path.join(rootDir, 'style_tracker.json');
    
    let lastHookIndex = -1;
    let lastOutroIndex = -1;

    try {
      if (fs.existsSync(trackerPath)) {
        const tracker = JSON.parse(fs.readFileSync(trackerPath, 'utf8'));
        lastHookIndex = tracker.hook !== undefined ? tracker.hook : -1;
        lastOutroIndex = tracker.outro !== undefined ? tracker.outro : -1;
        this.logger.info(`[Rotador] Último estilo: Hook ${lastHookIndex}, Outro ${lastOutroIndex}`);
      }
    } catch(e) { 
      this.logger.warn(`[Rotador] No se pudo leer el tracker: ${e.message}`);
    }

    const hookStyles = [
      {
        nombre: "Estilo Curador Honesto (Anti-Relleno)",
        reglas: '1. AUTORIDAD: Inicia mencionando que "después de analizar decenas de artículos" llegaste a esta selección definitiva de productos. 2. PROMESA ANTI-BS: Enfatiza de forma directa que en este video "no hay exageraciones ni relleno, solo utilidad real". 3. ENLACES: Indica claramente que los links están en el primer comentario. 4. DISPARADOR: "Comencemos" o "Empezamos".'
      },
      {
        nombre: "Estilo Solución Directa (Promesa de Nicho)",
        reglas: '1. IDENTIFICACIÓN: Arranca hablándole directo a quien quiere mejorar su vida con "accesorios que de verdad sean útiles". Menciona 1 o 2 de los productos. 2. BENEFICIOS RÁPIDOS: Promete resolver "esos pequeños problemas que aparecen cuando menos lo esperas". 3. EXPECTATIVA: Menciona que hay opciones económicas y herramientas inteligentes. 4. ENLACES Y DISPARADOR: Recuerda los links en el primer comentario y cierra con "Prepárate".'
      },
      {
        nombre: "Estilo Híbrido Pragmático",
        reglas: '1. EL FILTRO: Abre diciendo que seleccionaste los mejores productos capaces de hacer tu día a día más cómodo y organizado. 2. LA GARANTÍA: Asegura que son inventos que "probablemente querrás tener desde el momento en que los veas". 3. ENLACES: Menciona rápidamente que la lista de links está en el primer comentario. 4. DISPARADOR: Cierra con un tono seguro: "Aquí vamos".'
      },
      {
        nombre: "Estilo EzeTech (Acción Directa)",
        reglas: '1. MICRO-TEASER: Inicia de golpe mencionando 1 o 2 productos y el problema que resuelven. 2. PROMESA: Genera intriga sobre el resto del video. 3. ENLACES: Menciona que están en el primer comentario. 4. DISPARADOR: "Suscríbete, empecemos".'
      },
      {
        nombre: "Estilo Storytelling (Misterio)",
        reglas: '1. EL SECRETO: Abre diciendo que hay un mercado oculto de productos que nadie conoce. 2. REVELACIÓN: Menciona 1 o 2 productos de la lista como el "santo grial". 3. ENLACES: Di que revelaste los links en el primer comentario. 4. DISPARADOR: "Dale play".'
      },
      {
        nombre: "Estilo Estadístico (Shock)",
        reglas: '1. DATO CHOQUEANTE: Inventa un porcentaje creíble sobre cuánto tiempo/dinero pierde la gente por no tener 1 o 2 productos de la lista. 2. SOLUCIÓN: Preséntalos. 3. ENLACES: Avisa que los dejaste en el primer comentario. 4. DISPARADOR: "Mira esto".'
      },
      {
        nombre: "Estilo Agresivo (Anticonsumismo)",
        reglas: '1. ADVERTENCIA: Inicia diciendo "No compres nada en Amazon hasta ver esto". 2. JUSTIFICACIÓN: Menciona 1 o 2 productos de la lista que realmente valen la pena. 3. ENLACES: Recuerda que los verdaderos links están en el primer comentario. 4. DISPARADOR: "Vamos".'
      }
    ];

    const outroStyles = [
      'Cierre Agresivo: Pregunta de forma enérgica cuál fue su favorito, exige el like y recuerda los links en el primer comentario.',
      'Cierre Misterioso: Agradece por llegar hasta aquí, di que el próximo top será aún más loco, y recuerda los links en el primer comentario.',
      'Cierre Desafiante: Reta a la audiencia a encontrar mejores productos que estos, pide suscripción y recuerda los links en el primer comentario.'
    ];

    const nextHookIndex = (lastHookIndex + 1) % hookStyles.length;
    const nextOutroIndex = (lastOutroIndex + 1) % outroStyles.length;
    const selectedHook = hookStyles[nextHookIndex];
    const selectedOutro = outroStyles[nextOutroIndex];

    try {
      fs.writeFileSync(trackerPath, JSON.stringify({ hook: nextHookIndex, outro: nextOutroIndex }));
      this.logger.info(`[Rotador] ✅ Nuevo estilo guardado en RAÍZ: ${selectedHook.nombre}`);
    } catch(e) { 
      this.logger.error(`[Rotador] ❌ ERROR guardando el tracker: ${e.message}`);
    }

    let dynamicIntro = "Presta atención a estos increíbles gadgets. Los enlaces están abajo.";
    let dynamicOutro = "Déjame en los comentarios cuál fue tu favorito, dale like y suscríbete. Los enlaces están en el primer comentario.";

    try {
      const nombresList = sections.map(s => s.productName).join(', ');
      this.logger.info(`🧠 Solicitando a GPT-4o. Estilo elegido: ${selectedHook.nombre}...`);
      
      const gptResponse = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        temperature: 1.2,
        max_tokens: 250,
        response_format: { type: 'json_object' },
messages: [
          {
            role: 'system',
            content: [
              'Eres un guionista camaleónico experto en retención para YouTube.',
              'Tu objetivo es escribir una INTRO y un OUTRO para un top de productos.',
              '',
              `🔥 REGLAS ESTRICTAS PARA LA INTRO (40-55 palabras):`,
              `DEBES utilizar obligatoriamente este formato narrativo: ${selectedHook.reglas}`,
              '- NUNCA uses la palabra "Hola", "Bienvenidos", ni saludes.',
              '- PROHIBICIÓN CRÍTICA DE SPOILERS: Tienes ESTRICTAMENTE PROHIBIDO mencionar cualquier nombre propio, marca, modelo o empresa (ej. prohibido decir "Ozlo", "Sony", "Apple").',
              '- En lugar de nombres, usa descripciones de misterio que generen curiosidad extrema (ej. "unos auriculares que...", "un dispositivo capaz de...").',
              '',
              `🔥 REGLAS ESTRICTAS PARA EL OUTRO (15-20 palabras):`,
              `DEBES utilizar obligatoriamente este estilo: ${selectedOutro}`,
              '',
              'Devuelve ÚNICAMENTE este JSON:',
              '{',
              '  "intro": "...",',
              '  "outro": "..."',
              '}',
              `IMPORTANTE: El año actual es ${currentYear}. Si decides incluir un año en los títulos, descripciones o guiones, DEBE ser estrictamente ${currentYear}. Tienes absolutamente prohibido utilizar cualquier año anterior a ${currentYear}.`
            ].join('\n')
          },
          {
            role: 'user',
            content: `Aplica el estilo solicitado inspirándote en los problemas que resuelven estos productos, pero CUMPLIENDO LA REGLA DE NO MENCIONAR SUS NOMBRES REALES EN ABSOLUTO: ${nombresList}.`
          }
        ]
      });
      
      const gptData = JSON.parse(gptResponse.choices[0].message.content);
      if (gptData.intro) dynamicIntro = gptData.intro;
      if (gptData.outro) dynamicOutro = gptData.outro;
      this.logger.info('✅ Ganchos multi-estilo generados exitosamente.');
    } catch (err) {
      this.logger.warn(`⚠️ Error generando ganchos dinámicos: ${err.message}`);
    }

    const script = {
      title: parsed.title || strategy.topic,
      hook: {
        type: 'statement',
        text: dynamicIntro,
        duration: '0:00-0:15'
      },
      introduction: {
        greeting: '',
        topicIntro: '',
        valueProposition: '',
        credibility: '',
        duration: '0s'
      },
      mainContent: {
        sections,
        totalDuration: sections.length * PER_PRODUCT_DURATION_DEFAULT
      },
      conclusion: {
        type: 'conclusion',
        title: 'Outro',
        recap: [dynamicOutro],
        finalThought: '',
        duration: '10 seconds'
      },
      callToAction: {
        type: 'call_to_action',
        subscribe: '',
        like: '',
        comment: '',
        nextVideo: '',
        duration: '0 seconds'
      },
      duration: this.formatDuration(sections.length * PER_PRODUCT_DURATION_DEFAULT + INTRO_DURATION_AVG),
      tone: 'engaging',
      tone_variant: toneVariant,
      pacing: 'quick',
      keywords: strategy.keywords || [],
      metadata: {
        strategy,
        generatedAt: new Date().toISOString(),
        version: '4.0-dynamic-rotator',
        productos: strategy.productos
      }
    };
    script.fullScript = this.formatFullScript(script);

    await this.db.saveScript(script);
    this.logger.info(`Listicle script saved: ${script.title}`);
    return script;
  }

  formatFullScript(script) {
    let fullScript = '';
    
    // Title
    fullScript += `TITLE: ${script.title}\n\n`;
    fullScript += '═'.repeat(50) + '\n\n';
    
    // Hook
    fullScript += `[${script.hook.duration}] HOOK\n`;
    fullScript += `${script.hook.text}\n\n`;
    
    // Introduction
    fullScript += `[${script.introduction.duration}] INTRODUCTION\n`;
    fullScript += `${script.introduction.greeting}\n`;
    fullScript += `${script.introduction.topicIntro}\n`;
    fullScript += `${script.introduction.valueProposition}\n`;
    fullScript += `${script.introduction.credibility}\n\n`;
    
    // Main Content
    fullScript += 'MAIN CONTENT\n';
    fullScript += '─'.repeat(30) + '\n\n';
    
    for (const section of script.mainContent.sections) {
      fullScript += `[${this.formatDuration(section.duration)}] ${section.title.toUpperCase()}\n`;
      
      if (Array.isArray(section.content)) {
        section.content.forEach(line => {
          fullScript += `${line}\n`;
        });
      } else if (section.steps) {
        section.steps.forEach(step => {
          fullScript += `\n${step.title}\n`;
          fullScript += `${step.description}\n`;
          fullScript += `💡 ${step.tip}\n`;
        });
      } else if (section.items) {
        section.items.forEach(item => {
          fullScript += `\n#${item.number}: ${item.title}\n`;
          fullScript += `${item.description}\n`;
          fullScript += `Impact: ${item.impact}\n`;
        });
      } else if (section.points) {
        section.points.forEach(point => {
          fullScript += `• ${point}\n`;
        });
      } else {
        fullScript += `${section.content}\n`;
      }
      
      if (section.visuals) {
        fullScript += `\n[VISUALS: ${section.visuals.join(', ')}]\n`;
      }
      
      fullScript += '\n';
    }
    
    // Conclusion
    fullScript += `[${script.conclusion.duration}] CONCLUSION\n`;
    script.conclusion.recap.forEach(line => {
      fullScript += `${line}\n`;
    });
    fullScript += `\n${script.conclusion.finalThought}\n\n`;
    
    // Call to Action
    fullScript += `[${script.callToAction.duration}] CALL TO ACTION\n`;
    fullScript += `${script.callToAction.subscribe}\n`;
    fullScript += `${script.callToAction.like}\n`;
    fullScript += `${script.callToAction.comment}\n`;
    fullScript += `${script.callToAction.nextVideo}\n\n`;
    
    // Metadata
    fullScript += '═'.repeat(50) + '\n';
    fullScript += `ESTIMATED DURATION: ${script.duration}\n`;
    fullScript += `TONE: ${script.tone}\n`;
    fullScript += `PACING: ${script.pacing}\n`;
    fullScript += `KEYWORDS: ${script.keywords.join(', ')}\n`;
    
    return fullScript;
  }

  estimateDuration(mainContent) {
    const totalSeconds = mainContent.sections.reduce((total, section) => {
      return total + (section.duration || PER_PRODUCT_DURATION_DEFAULT);
    }, 0);

    // Add hook (10s), intro (configurable avg), conclusion (30s), CTA (15s)
    const fullDuration = totalSeconds + 10 + INTRO_DURATION_AVG + 30 + 15;
    
    return this.formatDuration(fullDuration);
  }

  formatDuration(seconds) {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
  }

  calculateSectionsDuration(sections) {
    return sections.reduce((total, section) => total + (section.duration || PER_PRODUCT_DURATION_DEFAULT), 0);
  }

  /**
   * VALIDACIÓN DETERMINISTA POST-GPT: Fuerza filename y productId correctos.
   *
   * Estrategia: POSICIONAL PURA (Universal Local + API).
   * Después del reordenamiento, sections[i] corresponde a productLines[i].
   * Se sobreescriben filename, productId, productName desde:
   *   1. localDb (si existe entrada para productLines[i].id)
   *   2. productLines[i] directamente (modo API sin localDb)
   *
   * Esto GARANTIZA MATEMÁTICAMENTE que los identificadores sean correctos,
   * incluso si GPT mezcló nombres, IDs o filenames.
   */
  _forceIdentifiersFromCatalog(sections, localDb, productLines, logger) {
    let corrections = 0;

    logger.info('── VALIDACIÓN DETERMINISTA POSICIONAL DE IDENTIFICADORES ──');

    for (let i = 0; i < sections.length; i++) {
      const sec = sections[i];
      const pl = productLines[i];

      if (!pl) {
        logger.error(`  [SEC ${i}] ✗ Sin productLine correspondiente — no se puede validar.`);
        continue;
      }

      // Intentar enriquecer desde localDb si está disponible
      const catalogEntry = (localDb && localDb.length > 0)
        ? localDb.find(lp => lp.id === pl.id)
        : null;

      const oldFilename = sec.filename;
      const oldProductId = sec.productId;
      const oldTitle = sec.title;

      if (catalogEntry) {
        // Sobreescritura forzosa desde el catálogo local (modo Local)
        sec.filename = catalogEntry.filename;
        sec.productId = catalogEntry.id;
        sec.productName = catalogEntry.product_name;
        sec.title = catalogEntry.product_name;
        sec.precio = catalogEntry.price ? `$${catalogEntry.price}` : sec.precio;
      } else {
        // Sobreescritura forzosa desde productLines (modo API o producto no catalogado)
        sec.filename = pl.filename || sec.filename;
        sec.productId = pl.id || sec.productId;
        sec.productName = pl.nombreReal || sec.productName;
      }

      const changed = oldFilename !== sec.filename || oldProductId !== sec.productId || oldTitle !== sec.title;
      const source = catalogEntry ? 'catálogo' : 'productLines';
      if (changed) {
        corrections++;
        logger.warn(`  [SEC ${i}] CORREGIDO (${source}): "${oldTitle}" → title: "${sec.title}", filename: ${oldFilename} → ${sec.filename}, productId: ${oldProductId} → ${sec.productId}`);
      } else {
        logger.info(`  [SEC ${i}] OK (${source}): "${sec.title}" → ${sec.filename || '(pending)'} [${sec.productId}]`);
      }
    }

    logger.info(`── FIN VALIDACIÓN: ${corrections} correcciones aplicadas de ${sections.length} secciones ──`);
  }

  /**
   * Ensambla el script final maestro a partir de scripts individuales de cada producto.
   *
   * @param {Array} individualScripts - Array de objetos: [{ productId: "B0...", script: "Texto...", título: "...", duracion: 35 }, ...]
   * @returns {Object} Objeto JSON maestro con estructura:
   *   {
   *     introducion: { text: "...", duracion: X, palabra_count: Y },
   *     productos: [
   *       { productId: "B0...", titulo: "...", narracion_limpia: "...", word_count: X, duracion_segundos: Y },
   *       ...
   *     ],
   *     cierre: { text: "...", duracion: X, palabra_count: Y },
   *     metadata: {
   *       total_palabras: Z,
   *       total_segundos: W,
   *       retension_ideal: boolean,
   *       timestamp: "..."
   *     }
   *   }
   */
}

module.exports = { ScriptWriterAgent };
