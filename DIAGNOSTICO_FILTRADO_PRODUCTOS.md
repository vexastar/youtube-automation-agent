# DIAGNÓSTICO: Por qué se filtran 2 productos (Top 19 → Top 17)

## Problema Identificado

**Síntoma:** Pipeline recibe 19 videos en `uploads/`, pero genera video final "Top 17"

**Causa Raíz:** Falla en el emparejamiento exacto (exact-match) entre:
- ASINs/filenames del guion (generados por ScriptWriter)
- ASINs/filenames en huntResults (videos descargados)

**Sección Responsable:** `index.js` líneas 346-420 (VÍNCULO POR EXACT-MATCH)

---

## Flujo de Falla

```
1. ProductHunter descarga 19 videos → huntResults[] con:
   - huntResults[0]: { asin: "B07HWNSYD", filename: "B07HWNSYD.mp4", videoPath: "data/..." }
   - huntResults[1]: { asin: "B099R6BQHB", filename: "B099R6BQHB.mp4", ... }
   - ... × 19

2. ScriptWriter genera 19 secciones:
   - section[0]: { title: "Gaming Headset", productId: "B07HWNSYD", filename: "B07HWNSYD.mp4" }
   - section[1]: { title: "Keyboard RGB", productId: "B099R6BQHB", filename: "B099R6BQHB.mp4" }
   - ... × 19

3. PERO FALLA DE COINCIDENCIA (2 productos):
   - section[i]: { productId: "B08XYZ123", filename: null }  ← NO EXISTE EN HUNTRESULTS
   - section[j]: { productId: "B0QWERTY99", filename: null }  ← NO EXISTE EN HUNTRESULTS

4. VÍNCULO EXACTO no encuentra match:
   for each section:
     matchedHunt = huntResults.find(h => h.asin === section.productId)  ← NOT FOUND
     section.videoPath = null  ← ❌

5. RESILIENCIA filtra secciones sin video:
   validSections = sections.filter(s => s.videoPath)  ← 17 secciones quedan
   Título: "Top 19" → "Top 17"
```

---

## ¿Por Qué Falla el Exact-Match?

### Escenario 1: ScriptWriter Inventa ASINs
- ScriptWriter recibe `strategy.productos[]` con ASINs reales
- Pero en su prompt generador pueden:
  - Cambiar el ASIN (error de GPT)
  - Usar un ASIN que no está en huntResults
  - Generar más secciones que productos

### Escenario 2: Problemas en Backfill
- El backfill `strategy.productos[i].id = hunt.asin` ocurre bien
- Pero el ScriptWriter puede:
  - No recibir bien los productIds inyectados
  - Regenerarlos internamente sin esos datos

### Escenario 3: Inconsistencia de Filenames
- huntResults tiene: `filename: "B07HWNSYD_combined.mp4"`
- ScriptWriter genera: `filename: "B07HWNSYD.mp4"`
- No hacen exact-match (`"B07HWNSYD_combined.mp4"` ≠ `"B07HWNSYD.mp4"`)

---

## SOLUCIÓN IMPLEMENTADA EN index.js

He mejorado la sección de VÍNCULO EXACTO con:

### 1. **Diagnóstico Detallado (Nuevo)**
Antes de intentar matching, se imprime:

```
┌─ DIAGNÓSTICO PRE-VÍNCULO ──
Secciones en script: 19
HuntResults disponibles: 19

┌─ HUNTRESULTS DISPONIBLES:
  [0] ASIN/ID: B07HWNSYD | Filename: B07HWNSYD.mp4 | Precio: $45
  [1] ASIN/ID: B099R6BQHB | Filename: B099R6BQHB.mp4 | Precio: $89
  ... × 19
└─ FIN INVENTARIO

┌─ SECCIONES DEL SCRIPT:
  [0] Título: "Gaming Headset Pro" | productId="B07HWNSYD" | filename="B07HWNSYD.mp4"
  [1] Título: "Keyboard RGB" | productId="B099R6BQHB" | filename="B099R6BQHB.mp4"
  ... × 19
└─ FIN SECCIONES
```

**Beneficio:** Ves exactamente qué estás buscando vs qué está disponible.

### 2. **Fuzzy Matching (Nuevo)**
Además de exact-match, implementé 3 niveles de búsqueda:

```javascript
const fuzzyMatch = (searchTerm, candidates) => {
  // Nivel 1: Exact match
  if (exact) return match;
  
  // Nivel 2: Substring (e.g., "B07HWNSYD" in "B07HWNSYD_combined.mp4")
  if (substring) return match;
  
  // Nivel 3: Sin extensión (e.g., "B07HWNSYD" vs "B07HWNSYD.mp4")
  if (baseEqual) return match;
  
  return null;
};
```

**Beneficio:** Absorbe errores de extensiones, sufijos `_combined`, etc.

### 3. **Reporte de Emparejamiento (Nuevo)**
Después de todo el matching, se imprime:

```
┌─ REPORTE DE EMPAREJAMIENTO:
  Exitosos: 19/19
└─ FIN REPORTE
```

O si hay fallos:

```
┌─ REPORTE DE EMPAREJAMIENTO:
  Exitosos: 17/19
  ❌ Fallidos: 2
    [8] "USB-C Hub"
         Buscado: filename="USB-C_Hub.mp4", id="B08UNKNOWN"
         Disponibles: B07HWNSYD, B099R6BQHB, B0CPD7GVZ1, ...
    [15] "Wireless Charger"
         Buscado: filename="WirelessCharger.mp4", id="B0QWERTY99"
         Disponibles: B07HWNSYD, B099R6BQHB, B0CPD7GVZ1, ...
└─ FIN REPORTE
```

**Beneficio:** Sabes EXACTAMENTE cuáles fueron los 2 ASINs filtrados.

### 4. **Logging Mejorado (Nuevo)**
Cada match tiene método identificado:

```
[0] ✅ "Gaming Headset Pro" ← B07HWNSYD.mp4 [B07HWNSYD] (exact-filename)
[1] ✅ "Keyboard RGB" ← B099R6BQHB.mp4 [B099R6BQHB] (exact-asin)
[2] ✅ "USB Cable" ← B0CPD7.mp4 [B0CPD7GVZ1] (fuzzy-filename)  ← Vés el fuzzy kick in
[8] ❌ "USB-C Hub" ← SIN VIDEO COINCIDENTE
     Buscó: filename="USB-C_Hub.mp4", productId="B08UNKNOWN"
     Disponibles en huntResults: [B07HWNSYD, B099R6BQHB, B0CPD7GVZ1, ...]
```

**Beneficio:** Diagnosticas exactamente POR QUÉ falló cada una.

---

## SOLUCIÓN PARA EL FUTURO (Mejoras Sugeridas)

### Opción 1: Mejorar ScriptWriter (Fuerza N secciones exactas)
En `script-writer-agent.js`, agregar validación post-generación:

```javascript
// DESPUÉS de generar iterativeProductos
if (iterativeProductos.length !== numProductos) {
  this.logger.warn(`⚠️ ScriptWriter generó ${iterativeProductos.length} secciones, pero se esperaban ${numProductos}`);
  
  // Llenar con fallbacks si faltan
  while (iterativeProductos.length < numProductos) {
    const idx = iterativeProductos.length;
    const pl = productLines[idx];
    iterativeProductos.push({
      asin: pl.asin,
      title: pl.nombreReal,
      narracion: `[Fallback Narrativa Adaptativa]`,
      sales_cta: `Precio: ${pl.precioTexto}. ¡Link en el primer comentario!`
    });
  }
}
```

### Opción 2: Mejor Inyección en Strategy
Garantizar que `strategy.productos` tenga ASINs reales ANTES de ScriptWriter:

```javascript
// En index.js, antes de llamar ScriptWriter
for (let i = 0; i < strategy.productos.length; i++) {
  const prod = strategy.productos[i];
  const hunt = huntResults[i];
  
  // FORZAR ASIN real
  prod.id = hunt.asin || hunt.productId;
  prod.filename = hunt.filename;
  prod.videoPath = hunt.videoPath;
}
```

### Opción 3: Matching Más Inteligente (Ya Implementado)
Usar fuzzy matching + contexto en lugar de exact-match puro.

---

## CÓMO DIAGNOSTICAR EN PRÓXIMAS EJECUCIONES

1. **Ejecutar:**
   ```bash
   node index.js "Tu tema aquí" 2>&1 | grep -A 50 "DIAGNÓSTICO PRE-VÍNCULO"
   ```

2. **Buscar sección:**
   ```
   ┌─ REPORTE DE EMPAREJAMIENTO:
   ```

3. **Leer logs:**
   - Si ves `Exitosos: 19/19` → ¡Perfecto, sin problemas!
   - Si ves `Exitosos: 17/19` → Exactamente los 2 que fallaron están listados

4. **Verificar manualmente:**
   ```bash
   ls -la data/shorts/*.mp4 | wc -l  # Cantidad de videos
   grep "REPORTE DE EMPAREJAMIENTO" output.log  # Ver resultados
   ```

---

## CÓDIGO IMPLEMENTADO EN index.js

La nueva sección (líneas ~346-420) incluye:

1. **Inventario Pre-Vínculo:** Lista todos los huntResults
2. **Inventario de Secciones:** Lista lo que el script busca
3. **Fuzzy Match Helper:** Función con 3 niveles de búsqueda
4. **Diagnostic Log Object:** Tracks matched/unmatched por índice
5. **Reporte Final:** Muestra exactamente qué se filtró y por qué

---

## PRÓXIMAS ACCIONES RECOMENDADAS

### Inmediato (Ya Hecho)
- ✅ Agregar logging diagnóstico detallado
- ✅ Implementar fuzzy matching (filename + extensión)
- ✅ Reporte de exactamente cuáles ASINs se filtraron

### Corto Plazo (Próxima PR)
- [ ] Validar en ScriptWriter que `len(iterativeProductos) == numProductos`
- [ ] Agregar rellenos (fallbacks) si se generan menos secciones
- [ ] Forzar inyección de IDs reales ANTES de ScriptWriter

### Medio Plazo (Optimización)
- [ ] Usar Levenshtein distance para matching aún más flexible
- [ ] Historial de matched/unmatched para detectar patrones
- [ ] Alertas si el filtrado > 10% (ej., Top 19 → Top 17)

---

## Ejemplo de Ejecución Exitosa (Después de Fixes)

```
════════════════════════════════════════════
Step 3.5: VÍNCULO POR EXACT-MATCH
════════════════════════════════════════════

┌─ DIAGNÓSTICO PRE-VÍNCULO ──
Secciones en script: 19
HuntResults disponibles: 19

[Inventarios...]

┌─ REPORTE DE EMPAREJAMIENTO:
  Exitosos: 19/19 ✅
└─ FIN REPORTE

⚠️  RESILIENCIA: 0 secciones descartadas (perfecta alineación)
    Resultado: 19/19 productos en el guion ✅
```

---

**¡Diagnóstico Completado!** Ahora puedes:
1. Ver exactamente qué se filtra
2. Entender POR QUÉ se filtra
3. Aplicar las mejoras sugeridas para evitarlo en el futuro
