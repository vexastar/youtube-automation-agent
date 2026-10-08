/**
 * narrative-demo-builder.js
 *
 * Construye videos demostrativos profesionales de productos clasificando escenas
 * por tipo narrativo (hero/detail/demo/context) y ordenándolas en secuencia visual.
 *
 * Fases del video demostrativo:
 *   1. HERO (0-10s)       → Presenta el producto entero y claro
 *   2. DETALLES (10-35s)  → Close-ups, características, partes específicas
 *   3. DEMOSTRACIÓN (35-60s) → Manos, uso real, resultados, pruebas
 *
 * Clasificación de escenas usando Vision AI + prompts especializados.
 */
'use strict';

const path = require('path');
const fs = require('fs');

/**
 * Clasifica una escena según su tipo narrativo para video demostrativo.
 * Usa Vision AI (GPT-4o-mini) para entender el contenido visual.
 *
 * @param {string} assetPath - Ruta a video (frame extraído) o imagen
 * @param {string} productName - Nombre del producto para contexto
 * @param {object} openai - Instancia OpenAI configurada
 * @param {string} model - Modelo Vision ('gpt-4o-mini')
 * @returns {Promise<{type: 'hero'|'detail'|'demo'|'context', confidence: number, description: string}>}
 *
 * Rúbrica:
 *   - HERO (90-100): Producto entero, completamente visible, limpio, primer plano, claro
 *   - DETAIL (70-89): Close-up de partes, pantalla, botones, características específicas
 *   - DEMO (60-79): Manos, interacción, uso real, funcionamiento visible
 *   - CONTEXT (40-59): Ambientación, packaging, accesorios, lifestyle (sin uso directo)
 *   - REJECT (<40): Persona solo hablando, fondo genérico, logo, texto, sin producto visible
 */
async function classifySceneType(assetPath, productName, openai, model = 'gpt-4o-mini') {
  if (!fs.existsSync(assetPath)) {
    return { type: 'reject', confidence: 0, description: 'Archivo no existe' };
  }

  // Leer imagen y convertir a base64
  const buf = fs.readFileSync(assetPath);
  const ext = path.extname(assetPath).toLowerCase();
  const mime = ext === '.png' ? 'image/png'
             : ext === '.webp' ? 'image/webp'
             : 'image/jpeg';
  const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;

  const prompt = `Analiza esta imagen para un video demostrativo de "${productName}".

Clasifica EXACTAMENTE en UNA de estas categorías:

HERO (90-100): El producto está COMPLETO, visible en su totalidad, primer plano, claro, sin obstrucciones.
  Ejemplo: El smartphone entero visto de frente y lado.

DETAIL (70-89): CLOSE-UP de partes específicas: pantalla encendida, botones, logo, marca, características visibles.
  Ejemplo: Zoom en la cámara del teléfono, botones de control, pantalla mostrando app.

DEMO (60-79): MANOS USANDO el producto o interacción clara: persona manipulando, presionando botones, 
  demostrando funcionamiento, pruebas en acción.
  Ejemplo: Dedo tocando pantalla, persona sosteniendo el device, probando una función.

CONTEXT (40-59): Ambientación, packaging cerrado, accesorios, fondo (pero sin demostración clara de uso).
  Ejemplo: Caja del producto, detalles de embalaje, producto en escritorio sin manos.

REJECT (<40): NO es útil para demo: solo persona hablando a cámara, fondo negro/blanco genérico, 
  solo logo/texto, sin producto visible, irrelevante.

Devuelve EXACTAMENTE: TYPE|CONFIDENCE|DESCRIPTION
  TYPE: hero, detail, demo, context (minúsculas)
  CONFIDENCE: 0-100 (número)
  DESCRIPTION: 1-3 palabras en español (lo más visible)

Sin explicación. Sin punto. Solo: tipo|número|palabras`;

  try {
    const response = await openai.chat.completions.create({
      model,
      max_tokens: 20,
      temperature: 0,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } }
        ]
      }]
    });

    const raw = (response.choices?.[0]?.message?.content || '').trim().toLowerCase();
    const parts = raw.split('|').map(p => p.trim());

    if (parts.length < 3) {
      return { type: 'context', confidence: 50, description: 'Parse error', raw };
    }

    const [typeStr, confStr, desc] = parts;
    const type = typeStr.match(/hero|detail|demo|context/) ? typeStr.match(/hero|detail|demo|context/)[0] : 'context';
    const confidence = Math.max(0, Math.min(100, parseInt(confStr, 10) || 0));

    return { type, confidence, description: desc || 'unknown', raw };
  } catch (err) {
    return { type: 'context', confidence: 0, description: `Error: ${err.message}` };
  }
}

/**
 * Construye un video demostrativo ordenando escenas narrativamente.
 *
 * Estrategia de 3 fases:
 *   1. HERO (0-10s): Escenas hero con confidence ≥80, máx 5s cada una
 *   2. DETAIL (10-35s): Escenas detail + demo de confianza alta
 *   3. DEMO (35-60s): Escenas demo, luego context/detail como relleno
 *
 * @param {Array<{path: string, type: string, confidence: number, description: string}>} classifiedScenes
 * @param {number} targetDuration - Duración objetivo en segundos (default 60)
 * @returns {Array<{path: string, type: string, confidence: number, duration?: number}>}
 *   Ordenado narrativamente, con duraciones estimadas.
 */
function buildNarrativeCombined(classifiedScenes, targetDuration = 60) {
  if (!classifiedScenes || classifiedScenes.length === 0) return [];

  // Separar por tipo y confianza
  const heroes = classifiedScenes.filter(s => s.type === 'hero' && s.confidence >= 80).sort((a, b) => b.confidence - a.confidence);
  const details = classifiedScenes.filter(s => s.type === 'detail' && s.confidence >= 70).sort((a, b) => b.confidence - a.confidence);
  const demos = classifiedScenes.filter(s => s.type === 'demo' && s.confidence >= 60).sort((a, b) => b.confidence - a.confidence);
  const contexts = classifiedScenes.filter(s => s.type === 'context').sort((a, b) => b.confidence - a.confidence);

  // Calcular duraciones por fase
  const heroPhase = Math.round(targetDuration * 0.17); // 0-10s de 60
  const detailPhase = Math.round(targetDuration * 0.42); // 10-35s de 60
  const demoPhase = targetDuration - heroPhase - detailPhase; // Resto

  const narrative = [];
  let accumulated = 0;

  // ── FASE 1: HERO (0-10s) ──
  // Mostrar el producto completo primero
  const slotDuration = 3.0; // Duración predeterminada por escena
  for (const scene of heroes) {
    if (accumulated >= heroPhase) break;
    narrative.push({ ...scene, duration: Math.min(slotDuration, heroPhase - accumulated) });
    accumulated += slotDuration;
  }

  // Si no hay suficientes heroes, usar details de alta confianza
  if (accumulated < heroPhase) {
    for (const scene of details) {
      if (accumulated >= heroPhase) break;
      if (!narrative.find(n => n.path === scene.path)) {
        narrative.push({ ...scene, duration: Math.min(slotDuration, heroPhase - accumulated) });
        accumulated += slotDuration;
      }
    }
  }

  // ── FASE 2: DETALLES (10-35s) ──
  // Close-ups, características, partes específicas
  for (const scene of details) {
    if (accumulated >= heroPhase + detailPhase) break;
    if (!narrative.find(n => n.path === scene.path)) {
      narrative.push({ ...scene, duration: Math.min(slotDuration, heroPhase + detailPhase - accumulated) });
      accumulated += slotDuration;
    }
  }

  // Rellenar con demos de baja confianza si es necesario
  if (accumulated < heroPhase + detailPhase) {
    for (const scene of demos) {
      if (accumulated >= heroPhase + detailPhase) break;
      if (!narrative.find(n => n.path === scene.path)) {
        narrative.push({ ...scene, duration: Math.min(slotDuration, heroPhase + detailPhase - accumulated) });
        accumulated += slotDuration;
      }
    }
  }

  // ── FASE 3: DEMOSTRACIÓN (35-60s) ──
  // Manos, uso real, pruebas, resultados
  for (const scene of demos) {
    if (accumulated >= targetDuration) break;
    if (!narrative.find(n => n.path === scene.path)) {
      narrative.push({ ...scene, duration: Math.min(slotDuration, targetDuration - accumulated) });
      accumulated += slotDuration;
    }
  }

  // Rellenar con contexts si es necesario
  if (accumulated < targetDuration) {
    for (const scene of contexts) {
      if (accumulated >= targetDuration) break;
      if (!narrative.find(n => n.path === scene.path)) {
        narrative.push({ ...scene, duration: Math.min(slotDuration, targetDuration - accumulated) });
        accumulated += slotDuration;
      }
    }
  }

  return narrative;
}

/**
 * Clasifica múltiples escenas en paralelo (pool de concurrencia).
 *
 * @param {Array<string>} assetPaths - Rutas a imágenes/videos
 * @param {string} productName - Nombre del producto
 * @param {object} openai - Instancia OpenAI
 * @param {object} opts - { model, maxConcurrent, logger }
 * @returns {Promise<Array<{path, type, confidence, description}>>}
 */
async function classifyMultipleScenes(assetPaths, productName, openai, opts = {}) {
  const {
    model = 'gpt-4o-mini',
    maxConcurrent = 2,
    logger = console
  } = opts;

  const results = [];
  let inFlight = 0;

  async function processOne(assetPath) {
    const result = await classifySceneType(assetPath, productName, openai, model);
    return { path: assetPath, ...result };
  }

  const tasks = [];
  for (let i = 0; i < assetPaths.length; i++) {
    while (inFlight >= maxConcurrent) await new Promise(r => setTimeout(r, 100));
    inFlight++;
    const t = processOne(assetPaths[i]).then(r => {
      inFlight--;
      results.push(r);
    }).catch(err => {
      inFlight--;
      logger.warn(`[NarrativeBuilder] Clasificación falló para ${path.basename(assetPaths[i])}: ${err.message}`);
    });
    tasks.push(t);
  }

  await Promise.all(tasks);
  return results.sort((a, b) => {
    // Prioridad: hero > demo > detail > context > reject
    const typeOrder = { hero: 0, demo: 1, detail: 2, context: 3, reject: 4 };
    const aOrder = typeOrder[a.type] ?? 5;
    const bOrder = typeOrder[b.type] ?? 5;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return b.confidence - a.confidence;
  });
}

module.exports = {
  classifySceneType,
  buildNarrativeCombined,
  classifyMultipleScenes
};
