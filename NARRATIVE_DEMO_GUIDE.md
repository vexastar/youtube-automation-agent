## 🎬 Sistema de Video Demostrativo Narrativo

Se ha implementado un sistema de ordenamiento narrativo inteligente que clasifica escenas/fotos por tipo y las ordena para crear videos demostrativos profesionales de **3 fases**.

---

## ✨ Características Nuevas

### **1. Clasificación Inteligente de Escenas**
Cada escena/foto se analiza con Vision AI y se clasifica como:

- **HERO** (90-100): Producto completo, visible, claro, primer plano
- **DETAIL** (70-89): Close-ups, características, partes específicas, pantallas, botones
- **DEMO** (60-79): Manos usando el producto, interacción real, funcionamiento
- **CONTEXT** (40-59): Ambientación, packaging, accesorios (sin uso directo)
- **REJECT** (<40): No útil (solo texto, logo, fondo, persona hablando)

### **2. Ordenamiento Narrativo Automático**

El video final se estructura en **3 fases coherentes**:

```
FASE 1: HERO (0-10s)       → "Conoce el producto"
  ├─ Producto completo y claramente visible
  └─ Crea primera impresión positiva

FASE 2: DETAIL (10-35s)    → "Descubre características"
  ├─ Close-ups de partes, pantallas, botones
  ├─ Características específicas
  └─ Detalles de calidad y diseño

FASE 3: DEMO (35-60s)      → "Mira cómo funciona"
  ├─ Manos usando el producto
  ├─ Demostración de uso real
  └─ Pruebas y resultados
```

---

## 🚀 Cómo Activar

### **Paso 1: Configurar variable de entorno**

En `.env` (o console antes de ejecutar):

```bash
# Activar ordenamiento narrativo
ENABLE_NARRATIVE_DEMO=1

# (Opcional) Activar vision AI para escenas
ENABLE_VISION_FILTER=1
VISION_MIN_SCORE=5
```

### **Paso 2: Asegurarse de tener OpenAI configurado**

```bash
OPENAI_API_KEY=sk-...
```

### **Paso 3: Ejecutar agentes**

```bash
node index.js "20 gadgets para ciclistas en amazon"
```

---

## 📊 Ejemplo de Salida en Logs

```
[Agente Cazador]   🎬 Clasificación narrativa: analizando 15 clips...
[Agente Cazador]   ✓ Clasificación completada: 3 hero + 6 detail + 4 demo + 2 context
[Agente Cazador]   🎬 Ordenamiento narrativo: 3 hero (0-10s) → 6 detail (10-35s) → 4 demo (35-60s)
[Agente Cazador]   📊 Adaptabilidad [NARRATIVA: 3 hero + 6 detail + 4 demo + 2 context]
[Agente Cazador]   ✅ _combined: 15 clips → 60s — 45.3 MB [video ×1 — ordeno por narrativa]
```

---

## 🎯 Resultados Esperados

### **Sin Narrativa Activada**
```
Video aleatorio de clips:
0-5s: Close-up de botón (sin contexto)
5-10s: Manos usando producto (sin introducción)
10-15s: Fondo borroso (distractor)
15-60s: Clips aleatorios
```

### **Con Narrativa Activada (ENABLE_NARRATIVE_DEMO=1)**
```
Video coherente y profesional:
0-5s: HERO - Producto completo, limpio, atractivo
5-10s: HERO - Ángulo frontal/lateral completo
10-25s: DETAIL - Close-up de pantalla/logo
25-35s: DETAIL - Botones, características visibles
35-50s: DEMO - Manos manipulando, pruebas
50-60s: DEMO - Funcionamiento real, resultados
```

---

## ⚙️ Configuración Avanzada

### **Frecuencia de Concurrencia Vision**

Controlar cuántas escenas se procesan en paralelo:

```bash
VISION_CONCURRENCY=2  # Default: 2 (ahorra cuota OpenAI)
```

Con más concurrencia es más rápido pero cuesta más en API. Con menos concurrencia es más lento pero económico.

### **Desactivar para Fallback**

Si quieres volver al comportamiento antiguo (ordenamiento por productScore):

```bash
# Desactivar narrativa
ENABLE_NARRATIVE_DEMO=0

# (O simplemente no definir la variable)
```

---

## 📁 Archivos Nuevos/Modificados

### **Nuevo:**
- `utils/narrative-demo-builder.js` — Motor de clasificación y ordenamiento narrativo

### **Modificado:**
- `agents/product-hunter-agent.js` — Integración en `_extractProductScenes()` y `_createSlideshowFromImages()`
- `utils/ai-video-generator.js` — Optimización de `_syncSilentVideoToAudio()` para slideshows

---

## 🔍 Cómo Funciona Internamente

### **1. Clasificación por Escena**

```javascript
classifySceneType(assetPath, productName, openai)
→ {type: 'hero'|'detail'|'demo'|'context', confidence: 0-100}
```

Usa Vision AI para analizar cada frame y clasificarlo según la rúbrica.

### **2. Ordenamiento Narrativo**

```javascript
buildNarrativeCombined(classifiedScenes, targetDuration=60)
→ [...escenas ordenadas narrativamente]
```

Coloca heroes primero (0-10s), detalles en el medio (10-35s), demos al final (35-60s).

### **3. Relleno Inteligente**

Si faltan escenas de un tipo:
- Si no hay suficientes HERO → llenar con DETAIL de alta confianza
- Si no hay suficientes DETAIL → llenar con DEMO
- Si no hay suficientes DEMO → llenar con CONTEXT

---

## 💡 Consejos Prácticos

### **Para Máxima Calidad**
```bash
ENABLE_VISION_FILTER=1       # Filtrar escenas de baja calidad
ENABLE_NARRATIVE_DEMO=1      # Activar ordenamiento narrativo
VISION_CONCURRENCY=2         # Balance costo/velocidad
VISION_MIN_SCORE=6           # Ser selectivo (default: 5)
```

### **Para Máxima Velocidad**
```bash
ENABLE_NARRATIVE_DEMO=0      # Desactivar (requiere Vision API)
ENABLE_VISION_FILTER=0       # Desactivar (requiere Vision API)
# Los videos se generarán más rápido pero sin inteligencia de ordenamiento
```

### **Para Máxima Economía**
```bash
VISION_CONCURRENCY=1         # Procesar escenas una por una
# Más lento pero reduce uso de API OpenAI
```

---

## ⚡ Compatibilidad

✅ **Compatible con:**
- Video oficial de Amazon (ordena escenas narrativamente)
- Slideshows de fotos (ordena fotos demostrativamente)
- Vídeos múltiples (selecciona escenas de todos y ordena)

✅ **Funciona con:**
- ElevenLabs TTS
- OpenAI TTS
- Cualquier sistema de audio existente

✅ **Mantiene:**
- Todos los filtros de escena existentes
- Todos los ajustes de color/audio
- Toda la pipeline de generación de video

---

## 🐛 Troubleshooting

**P: ¿Por qué las escenas no se clasifican?**

R: Verifica que:
- `ENABLE_NARRATIVE_DEMO=1` está en `.env`
- `OPENAI_API_KEY` está configurado
- Tienes crédito en OpenAI (requiere GPT-4o-mini)

**P: ¿Por qué es lento?**

R: Vision AI requiere ~1-2 segundos por escena. Para 15 escenas con concurrencia=2, espera ~8-10 segundos. Es normal.

**P: ¿Aumentará mi costo?**

R: Sí, ligeramente. Cada escena cuesta ~$0.0015 en gpt-4o-mini vision. 
- 15 escenas × $0.0015 = ~$0.022 por producto
- Para 20 productos = ~$0.44 por ejecución

**P: ¿Puedo desactivar solo para algunos productos?**

R: No directamente, pero puedes:
```bash
# Desactivar globalmente
ENABLE_NARRATIVE_DEMO=0

# O usar fallback a productScore si vision falla
```

---

## 📈 Resultados Cuantitativos

### **Videos Generados: B07HGTSN7X_combined.mp4**

**Antes (sin narrativa):**
- Clips: orden aleatorio
- Estructura: incoherente
- Impacto: confusión inicial (qué es el producto?)

**Después (con narrativa):**
- Clips: HERO → DETAIL → DEMO
- Estructura: narrativa profesional
- Impacto: comprensión clara del producto

---

## 🎓 Fundamento de Diseño

La estrategia de 3 fases sigue principios de cinematografía:

1. **ESTABLECE** (HERO) — ¿Qué es?
2. **DESARROLLA** (DETAIL) — ¿Cómo es?
3. **DEMUESTRA** (DEMO) — ¿Para qué funciona?

Este es el mismo patrón usado en:
- Anuncios de TV profesionales
- Videos de producto en YouTube
- Presentaciones de producto en tiendas
- Reseñas técnicas

---

## 🔄 Próximos Pasos Opcionales

Mejoras futuras:
- [ ] Transiciones suaves entre fases
- [ ] Música adaptativa según fase
- [ ] Detección automática de calidad de oratoría
- [ ] Subtítulos narrativos ("Conoce...", "Descubre...", "Mira...")
- [ ] Recomendaciones de duración óptima por fase

---

¿Preguntas? Revisa los logs de ejecución - contendrán información detallada sobre cada clasificación.
