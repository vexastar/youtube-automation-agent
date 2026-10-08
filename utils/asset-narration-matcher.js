/**
 * asset-narration-matcher.js
 *
 * Recibe:
 *   - narracion_segments: array de bullets de la narración del producto
 *     [{ text, asset_hint? }]
 *   - scoredAssets: array de assets visuales ya rankeados con tag/score
 *     [{ path, type, score, tag }]
 *
 * Devuelve un mapping segment[i] → asset (el más relevante semánticamente).
 *
 * Estrategia: matching cheap basado en tokens (keyword overlap entre
 * `text + asset_hint` y `tag`). Si hay OpenAI disponible y se activa
 * `ENABLE_LLM_MATCHING=1`, refina con un único call gpt-4o-mini que decide
 * todas las asignaciones a la vez (1 token/segment).
 *
 * No llama a vision, solo texto → coste despreciable (~$0.0005 por producto).
 */
'use strict';

function _norm(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2);
}

function _scoreOverlap(segText, assetTag) {
  const a = new Set(_norm(segText));
  const b = _norm(assetTag);
  let hits = 0;
  for (const w of b) if (a.has(w)) hits++;
  return hits;
}

/**
 * Matching heurístico (sin LLM).
 * Penaliza reuso del mismo asset en segmentos consecutivos para promover variedad.
 */
function matchHeuristic(segments, scoredAssets) {
  if (!scoredAssets || scoredAssets.length === 0) return segments.map(() => null);

  const lastUsedAt = new Map(); // assetPath -> índice del último segmento que lo usó
  const assignments = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const text = `${seg.text || ''} ${seg.asset_hint || ''}`;

    let best = null;
    let bestRank = -Infinity;
    for (const a of scoredAssets) {
      const overlap = _scoreOverlap(text, a.tag || '');
      const recency = lastUsedAt.has(a.path) ? (i - lastUsedAt.get(a.path)) : 999;
      const recencyPenalty = recency < 2 ? -3 : 0;          // muy reciente → fuera
      const typeBonus = a.type === 'video' ? 0.5 : 0;       // ligera preferencia por video
      const rank = (a.score || 0) * 0.6 + overlap * 4 + typeBonus + recencyPenalty;
      if (rank > bestRank) { bestRank = rank; best = a; }
    }
    if (best) lastUsedAt.set(best.path, i);
    assignments.push(best);
  }
  return assignments;
}

/**
 * @param {Array<{text: string, asset_hint?: string}>} segments
 * @param {Array<{path, type, score, tag}>} scoredAssets
 * @param {object} [opts]
 *   openai (optional)
 *   useLLM  (process.env.ENABLE_LLM_MATCHING === '1')
 *   logger  (console)
 *
 * @returns {Promise<Array<{segment, asset}>>}
 */
async function matchSegmentsToAssets(segments, scoredAssets, opts = {}) {
  const { openai, useLLM = process.env.ENABLE_LLM_MATCHING === '1', logger = console } = opts;

  if (!Array.isArray(segments) || segments.length === 0) return [];
  if (!Array.isArray(scoredAssets) || scoredAssets.length === 0) {
    return segments.map(s => ({ segment: s, asset: null }));
  }

  // Heurística por defecto (rápida, gratis)
  let assigned = matchHeuristic(segments, scoredAssets);

  // Refinamiento LLM opcional: un solo call, decide TODAS las asignaciones
  if (useLLM && openai && segments.length > 0) {
    try {
      const assetsTable = scoredAssets
        .map((a, i) => `${i}|${a.tag || 'sin tag'}|score=${a.score}|${a.type}`)
        .join('\n');
      const segsTable = segments
        .map((s, i) => `${i}|${(s.text || '').slice(0, 100)}`)
        .join('\n');

      const prompt =
        `Tienes ${segments.length} frases de narraci\u00f3n y ${scoredAssets.length} assets visuales.\n` +
        `Asigna a cada frase el asset M\u00c1S RELEVANTE.\n` +
        `Reglas: prefiere variedad (no repetir el mismo asset en frases consecutivas), prefiere tags relacionados con el contenido de la frase.\n\n` +
        `ASSETS (id|tag|score|tipo):\n${assetsTable}\n\n` +
        `FRASES (id|texto):\n${segsTable}\n\n` +
        `Devuelve SOLO una l\u00ednea por frase con el formato: FRASE_ID:ASSET_ID\n` +
        `Ejemplo: 0:2 / 1:0 / 2:5\n` +
        `Sin explicaciones.`;

      const resp = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0,
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }]
      });
      const raw = (resp.choices?.[0]?.message?.content || '').trim();
      const re = /(\d+)\s*:\s*(\d+)/g;
      const map = new Map();
      let m;
      while ((m = re.exec(raw)) !== null) map.set(parseInt(m[1], 10), parseInt(m[2], 10));

      const llmAssigned = segments.map((_, i) => {
        const aId = map.get(i);
        if (aId !== undefined && scoredAssets[aId]) return scoredAssets[aId];
        return assigned[i]; // fallback heurístico
      });
      assigned = llmAssigned;
      logger.log(`[AssetMatcher] LLM refinó ${map.size}/${segments.length} asignaciones`);
    } catch (err) {
      logger.warn(`[AssetMatcher] LLM matching falló (${err.message}), usando heurística`);
    }
  }

  return segments.map((s, i) => ({ segment: s, asset: assigned[i] || null }));
}

module.exports = { matchSegmentsToAssets, matchHeuristic };
