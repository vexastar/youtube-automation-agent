# 🎬 Variables de Entorno - Edición Profesional de Videos

Referencia completa de variables de entorno para el sistema de generación de videos profesionales con ediciones cinematográficas.

---

## 🎯 EDICIONES PROFESIONALES (Nuevas)

### `ENABLE_XFADE_TRANSITIONS`
**Descripción:** Habilita transiciones xfade (crossfade, smoothleft, smoothright) profesionales entre segmentos de video.

- **Tipo:** `boolean` (valores: `0` o `1`)
- **Default:** `1` (activado)
- **Rango:** `0` (desactivado) | `1` (activado)
- **Impacto:** Crítico en calidad visual
- **Ejemplo:**
  ```bash
  ENABLE_XFADE_TRANSITIONS=1       # Transiciones profesionales suaves
  ENABLE_XFADE_TRANSITIONS=0       # Cortes duros (A/B testing, debugging)
  ```
- **Cuándo cambiar:**
  - `0`: Para debugging si sospechas que xfade genera artefactos
  - `0`: Para A/B testing (comparar cortes duros vs transiciones)
  - `1`: Para video final profesional (default)

---

### `FAST_CUT_MAX_DURATION`
**Descripción:** Duración máxima (segundos) de cada corte/segmento de video en modo "fast cuts" (cadencia viral).

- **Tipo:** `float` (segundos)
- **Default:** `2.0`
- **Rango:** `1.0` (muy rápido, vídeo gaming) → `4.0` (más legible, conversacional)
- **Impacto:** Ritmo visual y cadencia de edición
- **Ejemplo:**
  ```bash
  FAST_CUT_MAX_DURATION=1.5        # Ritmo muy rápido (~40 cortes/min)
  FAST_CUT_MAX_DURATION=2.0        # Default (cadencia viral tech, ~30 cortes/min)
  FAST_CUT_MAX_DURATION=3.5        # Ritmo conversacional (~17 cortes/min)
  ```
- **Cuándo cambiar:**
  - `1.0-1.5`: Para gaming, contenido energético, público joven
  - `2.0`: Default recomendado (balancea energía con legibilidad)
  - `3.0-4.0`: Para audiencia madura, productos premium, tutoriales

---

## 🎨 COLOR GRADING (Sistema Automático)

Las siguientes variables NO existen como env vars pero se aplican automáticamente según la **fase narrativa** del producto:

| Fase | Posición | Contraste | Saturación | Brillo | Unsharp | Propósito |
|---|---|---|---|---|---|---|
| **HERO** | 0-20% | +15% | +45% | +4% | 0.4 | Presentación impactante |
| **DETAIL** | 20-70% | +22% | +30% | +2% | 0.9 | Legibilidad de características |
| **DEMO** | 70-100% | +18% | +50% | +5% | 0.6 | Dinamismo y resultados |
| **CONTEXT** | Fallback | +12% | +35% | +2% | 0.5 | Transiciones, ambientación |

**Implementación:** Se asigna automáticamente en `_buildSilentProduct()` basado en el índice del segmento.

```javascript
// NO configurable por env (se asigna dinámicamente)
const getColorProfile = (idx, total) => {
  const pct = total <= 1 ? 0.5 : idx / (total - 1);
  if (pct <= 0.20) return 'hero';      // 20%
  if (pct <= 0.70) return 'detail';    // 50%
  return 'demo';                       // 30%
};
```

---

## ⚡ CONFIGURACIÓN DE SEGMENTACIÓN (Existentes)

### `COMBINED_CLIP_DURATION`
**Descripción:** Duración objetivo (segundos) para el video combined de cada producto (_combined.mp4).

- **Tipo:** `integer` (segundos)
- **Default:** `60`
- **Rango:** `30` → `120`
- **Impacto:** Duración de material fuente por producto
- **Ejemplo:**
  ```bash
  COMBINED_CLIP_DURATION=60        # 60 segundos de material por producto
  COMBINED_CLIP_DURATION=45        # Material más corto (económico en procesamiento)
  ```

---

### `PER_PRODUCT_DURATION_MIN` / `PER_PRODUCT_DURATION_MAX`
**Descripción:** Rango de duración (segundos) permitida para cada sección de producto en el video final.

- **Tipo:** `integer` (segundos)
- **Default Min:** `25` | **Default Max:** `50`
- **Rango:** `15` → `90`
- **Impacto:** Duración de cada producto en el video final
- **Ejemplo:**
  ```bash
  PER_PRODUCT_DURATION_MIN=25       # Mínimo 25s por producto
  PER_PRODUCT_DURATION_MAX=50       # Máximo 50s por producto
  # Video de 5 productos: 125-250s total (2-4 minutos)
  ```

---

### `PER_PRODUCT_DURATION_DEFAULT`
**Descripción:** Duración por defecto para productos sin límites específicos.

- **Tipo:** `integer` (segundos)
- **Default:** Auto-calculado como `(MIN + MAX) / 2 = 37s`
- **Rango:** `PER_PRODUCT_DURATION_MIN` → `PER_PRODUCT_DURATION_MAX`
- **Ejemplo:**
  ```bash
  PER_PRODUCT_DURATION_DEFAULT=40   # Default 40s si no se especifica
  ```

---

## 🔊 AUDIO (Existentes)

### `TTS_PROVIDER`
**Descripción:** Proveedor de síntesis de voz (Text-to-Speech) para narración.

- **Tipo:** `string`
- **Opciones:** `openai` | `elevenlabs`
- **Default:** `openai`
- **Impacto:** Calidad y velocidad de narración
- **Ejemplo:**
  ```bash
  TTS_PROVIDER=openai               # OpenAI TTS (rápido, económico)
  TTS_PROVIDER=elevenlabs           # ElevenLabs (voz natural, con timestamps)
  ```

---

## 🤖 VISION AI (Existentes)

### `ENABLE_VISION_FILTER`
**Descripción:** Habilita filtrado de escenas mediante Vision AI (valida que el producto sea visible).

- **Tipo:** `boolean` (`0` o `1`)
- **Default:** `0`
- **Costo:** ~$0.0015 por escena (GPT-4o-mini vision)
- **Ejemplo:**
  ```bash
  ENABLE_VISION_FILTER=1            # Filtrar escenas de baja calidad
  ```

---

### `VISION_MIN_SCORE`
**Descripción:** Puntuación mínima (0-100) que debe tener una escena para ser aceptada por Vision AI.

- **Tipo:** `integer`
- **Default:** `5`
- **Rango:** `0` (sin filtro) → `100` (ultra-estricto)
- **Ejemplo:**
  ```bash
  VISION_MIN_SCORE=5                # Lenient (casi todo se acepta)
  VISION_MIN_SCORE=20               # Moderado (algunos descartes)
  VISION_MIN_SCORE=50               # Estricto (solo escenas excelentes)
  ```

---

### `VISION_CONCURRENCY`
**Descripción:** Número máximo de escenas que se procesan en paralelo con Vision AI.

- **Tipo:** `integer`
- **Default:** `3`
- **Rango:** `1` (secuencial, económico) → `8` (paralelo, rápido)
- **Impacto:** Velocidad vs costo API
- **Ejemplo:**
  ```bash
  VISION_CONCURRENCY=1              # Procesar una por una (lento, barato)
  VISION_CONCURRENCY=2              # Balance (recomendado)
  VISION_CONCURRENCY=4              # Rápido (más caro)
  ```

---

## 📺 VIDEO GENERATION (Existentes)

### `INTRO_DURATION_MIN`
**Descripción:** Duración mínima de la intro (segundos).

- **Type:** `integer`
- **Default:** `25`
- **Ejemplo:**
  ```bash
  INTRO_DURATION_MIN=20
  ```

---

### `SCENE_THRESHOLD`
**Descripción:** Threshold de detección de cambios de escena (0.0-1.0) para evitar frames estáticos.

- **Type:** `float`
- **Default:** `0.35`
- **Rango:** `0.0` (muy sensible) → `1.0` (insensible)
- **Ejemplo:**
  ```bash
  SCENE_THRESHOLD=0.35              # Default balanceado
  SCENE_THRESHOLD=0.20              # Más sensible (detecta cambios menores)
  ```

---

### `SCENE_MIN_DURATION` / `SCENE_MAX_DURATION`
**Descripción:** Duración mínima y máxima de escenas detectadas automáticamente.

- **Type:** `float`
- **Defaults:** Min `0.8`s | Max `8.0`s
- **Ejemplo:**
  ```bash
  SCENE_MIN_DURATION=0.5            # Escenas de hasta 0.5s
  SCENE_MAX_DURATION=10.0           # Escenas hasta 10s
  ```

---

### `SCENE_MIN_BRIGHTNESS`
**Descripción:** Brillo mínimo para que una escena sea válida (evita frames negros).

- **Type:** `integer`
- **Default:** `30`
- **Rango:** `0` (sin filtro) → `100`
- **Ejemplo:**
  ```bash
  SCENE_MIN_BRIGHTNESS=30           # Default
  SCENE_MIN_BRIGHTNESS=50           # Rechaza frames oscuros
  ```

---

## 📊 NARRATIVA INTELIGENTE (Existentes)

### `ENABLE_NARRATIVE_DEMO`
**Descripción:** Habilita clasificación narrativa de escenas (hero/detail/demo/context) para ordenamiento demostrativo.

- **Type:** `boolean` (`0` o `1`)
- **Default:** `0`
- **Impacto:** Estructura narrativa del video (profesional vs aleatorio)
- **Costo:** ~$0.001-0.002 por escena (GPT-4o-mini vision)
- **Ejemplo:**
  ```bash
  ENABLE_NARRATIVE_DEMO=1           # Video narrativo: hero→detail→demo
  ENABLE_NARRATIVE_DEMO=0           # Video por productScore (default)
  ```

---

### `DATA_SOURCE_MODE`
**Descripción:** Fuente de datos para productos (API real vs local fallback).

- **Type:** `string`
- **Opciones:** `auto` | `api` | `local`
- **Default:** `auto`
- **Ejemplo:**
  ```bash
  DATA_SOURCE_MODE=auto             # API primero, fallback local
  DATA_SOURCE_MODE=api              # Solo API (falla si sin créditos)
  DATA_SOURCE_MODE=local            # Solo datos locales (sin gastar API)
  ```

---

## 🧹 LIMPIEZA (Existentes)

### `ENABLE_CLEANUP`
**Descripción:** Elimina archivos temporales (temp/processing/) después de la generación.

- **Type:** `boolean` (`true` o `false`)
- **Default:** `false`
- **Impacto:** Libera 500MB-2GB de espacio en disco
- **Ejemplo:**
  ```bash
  ENABLE_CLEANUP=false              # Mantener temporales (debugging)
  ENABLE_CLEANUP=true               # Limpiar (producción)
  ```

---

## 📝 EJEMPLO DE `.env` COMPLETO

```bash
# ═══ EDICIONES PROFESIONALES ═══
ENABLE_XFADE_TRANSITIONS=1
FAST_CUT_MAX_DURATION=2.0

# ═══ DURACIÓN ═══
COMBINED_CLIP_DURATION=60
PER_PRODUCT_DURATION_MIN=25
PER_PRODUCT_DURATION_MAX=50
PER_PRODUCT_DURATION_DEFAULT=37
INTRO_DURATION_MIN=25

# ═══ AUDIO ═══
TTS_PROVIDER=openai
OPENAI_API_KEY=sk-...

# ═══ VISION AI ═══
ENABLE_VISION_FILTER=1
ENABLE_NARRATIVE_DEMO=1
VISION_MIN_SCORE=5
VISION_CONCURRENCY=2

# ═══ SCENE DETECTION ═══
SCENE_THRESHOLD=0.35
SCENE_MIN_DURATION=0.8
SCENE_MAX_DURATION=8.0
SCENE_MIN_BRIGHTNESS=30

# ═══ DATA ═══
DATA_SOURCE_MODE=auto

# ═══ LIMPIEZA ═══
ENABLE_CLEANUP=false
```

---

## 🎯 PRESETS POR TIPO DE CONTENIDO

### Preset: Gaming / Energético
```bash
FAST_CUT_MAX_DURATION=1.5          # Muy rápido (~40 cortes/min)
PER_PRODUCT_DURATION_MIN=15
PER_PRODUCT_DURATION_MAX=30        # Productos cortos
ENABLE_XFADE_TRANSITIONS=1
ENABLE_VISION_FILTER=1
VISION_MIN_SCORE=10
```

### Preset: Tech Premium / Profesional (Default)
```bash
FAST_CUT_MAX_DURATION=2.0          # Cadencia viral balanceada
PER_PRODUCT_DURATION_MIN=25
PER_PRODUCT_DURATION_MAX=50        # Productos medianos
ENABLE_XFADE_TRANSITIONS=1
ENABLE_NARRATIVE_DEMO=1
ENABLE_VISION_FILTER=1
VISION_MIN_SCORE=5
```

### Preset: Tutoriales / Educativo
```bash
FAST_CUT_MAX_DURATION=3.5          # Ritmo conversacional
PER_PRODUCT_DURATION_MIN=40
PER_PRODUCT_DURATION_MAX=90        # Productos largos
ENABLE_XFADE_TRANSITIONS=1
ENABLE_NARRATIVE_DEMO=1
SCENE_THRESHOLD=0.20               # Más sensible
```

### Preset: A/B Testing / Debugging
```bash
FAST_CUT_MAX_DURATION=2.0
ENABLE_XFADE_TRANSITIONS=0         # Cortes duros para comparar
ENABLE_VISION_FILTER=0             # Sin filtrado
ENABLE_CLEANUP=false               # Mantener temporales
```

---

## 💡 OPTIMIZACIÓN POR OBJETIVO

### Para Máxima Calidad Visual
```bash
ENABLE_XFADE_TRANSITIONS=1         # Transiciones suaves
ENABLE_VISION_FILTER=1             # Filtrar escenas
ENABLE_NARRATIVE_DEMO=1            # Narrativa coherente
VISION_MIN_SCORE=10                # Selectivo
SCENE_THRESHOLD=0.20               # Sensible
```

### Para Máxima Velocidad
```bash
ENABLE_XFADE_TRANSITIONS=0         # Cortes duros (más rápido)
ENABLE_VISION_FILTER=0             # Sin Vision AI
ENABLE_NARRATIVE_DEMO=0            # Sin clasificación
FAST_CUT_MAX_DURATION=1.5          # Segmentos cortos
```

### Para Máxima Economía API
```bash
ENABLE_VISION_FILTER=0             # No usa Vision
ENABLE_NARRATIVE_DEMO=0            # No usa Vision
VISION_CONCURRENCY=1               # Secuencial si está activado
DATA_SOURCE_MODE=local             # Solo datos locales
```

---

## 🔄 Cómo Aplicar Variables

### Opción 1: Archivo `.env`
```bash
# Crear o editar .env en la raíz del proyecto
echo "ENABLE_XFADE_TRANSITIONS=1" >> .env
echo "FAST_CUT_MAX_DURATION=2.0" >> .env
```

### Opción 2: Command Line
```bash
ENABLE_XFADE_TRANSITIONS=1 FAST_CUT_MAX_DURATION=2.0 node index.js "query"
```

### Opción 3: PowerShell (Windows)
```powershell
$env:ENABLE_XFADE_TRANSITIONS=1
$env:FAST_CUT_MAX_DURATION=2.0
node index.js "query"
```

---

## ✅ Checklist de Configuración

- [ ] Copiar `.env.example` a `.env`
- [ ] Configurar `OPENAI_API_KEY`
- [ ] Elegir preset (gaming/tech/educativo/debug)
- [ ] Ajustar `FAST_CUT_MAX_DURATION` según ritmo deseado
- [ ] Activar/desactivar `ENABLE_XFADE_TRANSITIONS`
- [ ] Definir rango `PER_PRODUCT_DURATION_MIN/MAX`
- [ ] Probar con 1 producto antes de escalar
- [ ] Monitorear logs para "[COLOR PROFILES]" y "[xfade]"

---

## 📊 Monitoreo de Ejecución

Busca estos logs para validar que las variables se aplican:

```bash
# Transiciones xfade activas
"FFmpeg xfade (8 clips, 7 trans): ..."

# Color profiles aplicados
"[COLOR PROFILES] 8 segmentos: hero→hero→detail→detail→detail→detail→demo→demo"

# Ordenamiento narrativo
"[NARRATIVA: 3 hero + 6 detail + 4 demo + 2 context]"

# Vision AI activo
"[Agente Cazador]   👁 Vision vid 1: 15/20 aprobadas (score>=5)"
```

---

## 🐛 Troubleshooting

| Síntoma | Causa | Solución |
|---|---|---|
| Video sin transiciones | `ENABLE_XFADE_TRANSITIONS=0` | Cambiar a `1` |
| Cortes muy rápidos/lentos | `FAST_CUT_MAX_DURATION` mal calibrado | Ajustar a 1.5-3.0 |
| Producto se congela al final | Color profile incorrecto | Verificar logs `[COLOR PROFILES]` |
| Muy lento procesamiento | `VISION_CONCURRENCY` bajo | Aumentar a 2-4 |
| Coste API alto | Vision/Narrativa activados | Desactivar `ENABLE_VISION_FILTER` |

---

*Última actualización: 1 de julio de 2026*
*Versión: 3.2 (Ediciones Profesionales)*
