# Cambios: Reordenamiento Producto-Primero y Filtro de Text Slides Mejorado

**Fecha**: 2025-05-25  
**Versión**: 1.0  
**Afectados**: `utils/scene-extractor.js`, `agents/product-hunter-agent.js`

---

## Resumen Ejecutivo

Se implementó una solución **adaptativa y dinámica** para mejorar la calidad de videos `_combined.mp4` garantizando que:

1. **Producto aparece primero**: Las escenas con alto contenido visual (producto) se priorizan al inicio del video
2. **Fondos/texto eliminados**: Se mejoró la detección de slides de título/información con fondos coloreados
3. **Adaptabilidad**: El sistema ajusta automáticamente según la disponibilidad de escenas de calidad

---

## Problema Original

### Situación
- El archivo `_combined.mp4` concatenaba escenas en orden secuencial sin considerar su contenido
- Pantallas de título/información (como "Vector Onboarding Series") permanecían en el video final
- Escenas con producto se mezclaban con fondos uniformes y texto, reduciendo impacto visual

### Impacto
- Videos iniciales con baja calidad visual (fondos planos + texto)
- Experiencia de usuario degradada (pierde atención en primeros segundos)
- Mensaje del producto no llega con suficiente fuerza

---

## Solución Implementada

### 1. **Mejora en Detección de Text Slides** (`scene-extractor.js`)

#### Función Actualizada: `isTextSlide()`
```javascript
// NUEVO: Detección de fondos coloreados uniformes
if (yavg !== null && yavg > maxBrightness) {
  // ... detección original de grises ...
  
  // MEJORADO: Detecta beige, azul claro, verde pastel, etc.
  const avgUV = (Math.abs(uavg - 128) + Math.abs(vavg - 128)) / 2;
  if (avgUV < 35) return true;  // Fondo de slide claro con baja saturación
}
```

**Razón**: Los slides de título no son solo blancos/grises; pueden ser beige, azul claro, o verde pastel. El filtro original dejaba pasar estos fondos coloreados unifor mes.

**Cómo funciona**:
- Mide la desaturación general (distancia de U,V respecto a 128)
- Fondos uniformes coloreados = baja variación de color
- Permite filtrar correctamente incluso fondos "creativos" de slides

#### Nueva Función: `scoreProductContent()`
```javascript
function scoreProductContent(stats, edgeDensity) {
  // Retorna score 0-100 indicando qué tan probable es que sea producto real
  // Basado en:
  // - Densidad de bordes Sobel (productos = bordes complejos)
  // - Variabilidad de color (productos = colores variados)
  // - Luminancia (productos no son fondos uniformes)
}
```

**Razón**: Necesitamos una métrica para identificar y priorizar escenas de producto vs. slides de texto.

**Score Ranges**:
- **70+**: Claramente producto (bordes complejos, colores variados)
- **50-69**: Contenido mixto (posible producto con fondo)
- **<50**: Probable fondo/texto (baja complejidad visual)

---

### 2. **Reordenamiento Adaptativo** (`product-hunter-agent.js`)

#### Estrategia: Producto-Primero con Relleno Dinámico

En `_extractProductScenes()`:

```javascript
// Separar por productScore
const highScore = [...filtro >= 70...]    // Producto claro
const mediumScore = [...filtro 50-69...]   // Contenido mixto
const lowScore = [...filtro < 50...]       // Probable texto/fondo

// Ordenar: Alto → Medio → Bajo
const adaptiveOrder = [...highScore, ...mediumScore, ...lowScore];
```

**Razón**: 
- Primeras 10-15 segundos = críticos para captar atención
- El producto debe ser protagonista desde el inicio
- Escenas de texto/fondo se usan solo como relleno si es necesario

**Beneficios**:
- Videos comienzan mostrando el producto claramente
- Mantiene el ritmo visual consistente
- Adaptable a diferentes tipos de productos (grandes, pequeños, formas complejas)

#### Adaptabilidad Dinámica

Si hay pocos clips de alta calidad:
1. Se usan ALL clips disponibles (alta + media + baja)
2. Pero se ordenan smart (producto primero)
3. Si es necesario ciclar, el ciclo mantiene el orden adaptativo

```javascript
// Ajuste automático según disponibilidad
if (highScore.length > 0 || mediumScore.length > 0) {
  logger.log('📊 Adaptabilidad: ' + highScore.length + ' alto, ' + mediumScore.length + ' medio');
}
```

---

## Cambios Específicos

### `utils/scene-extractor.js`

| Línea | Cambio | Razón |
|-------|--------|-------|
| 88-98 | Mejorada `isTextSlide()` | Detecta fondos coloreados uniformes |
| 100-123 | NUEVA `scoreProductContent()` | Métrica para identificar producto |
| 350 | Agregar `productScore` a Scene | Metadata necesaria para ordenamiento |
| 376 | Agregar `productScore` en retry | Consistencia en scoring |
| 420+ | Exportar `scoreProductContent` | Disponible para otros módulos |

### `agents/product-hunter-agent.js`

| Línea | Cambio | Razón |
|-------|--------|-------|
| 710-730 | Extender `clipObjs` con `productScore` | Capturar score de cada escena |
| 765-805 | NUEVO: Bloque de ordenamiento adaptativo | Implementar producto-primero |
| 854-859 | Mejorar logging de salida | Mostrar estrategia utilizada |

---

## Parámetros Configurables

Se pueden ajustar via variables de entorno:

```bash
# En scene-extractor.js (existentes, ahora más relevantes)
SCENE_MAX_BRIGHTNESS=220        # Ajustar límite de brillo para fondos
SCENE_MIN_EDGE_DENSITY=15       # Ajustar sensibilidad de bordes

# NUEVOS thresholds (propuestos pero no en env aún)
PRODUCT_SCORE_HIGH_THRESHOLD=70  # Qué se considera "alto score"
PRODUCT_SCORE_MEDIUM_THRESHOLD=50 # Umbral entre medio y bajo
```

**Recomendación**: Si el sistema detecta demasiados fondos en videos finales:
- Aumentar `SCENE_MIN_EDGE_DENSITY` (p.ej. 20 en lugar de 15)
- Aumentar `PRODUCT_SCORE_HIGH_THRESHOLD` (p.ej. 75)

---

## Ejemplos de Comportamiento

### Caso 1: Producto Multi-Escena (Normal)
```
INPUT SCENES:
  - Escena 1: Portada/Logo (score: 35)  ← Bajo
  - Escena 2: Producto en mano (score: 85)  ← Alto
  - Escena 3: Especificaciones (score: 40)  ← Bajo
  - Escena 4: Primer plano producto (score: 92)  ← Alto
  
OUTPUT ORDEN EN _combined.mp4:
  ▶ Escena 2 (score 85) — Primero
  ▶ Escena 4 (score 92) — Segundo
  ▶ Escena 1 (score 35) — Relleno
  ▶ Escena 3 (score 40) — Relleno
```

### Caso 2: Pocos Clips de Calidad
```
INPUT SCENES:
  - Escena 1: Producto clear (score: 75)
  - Escena 2: Fondo blanco + logo (score: 38)
  
OUTPUT ORDEN EN _combined.mp4:
  ▶ Escena 1 (score 75) — Primera
  ▶ [ciclo] Escena 1 nuevamente
  ▶ Escena 2 (score 38) — Relleno si es necesario
  ▶ [ciclo] Escena 1 nuevamente
```

### Caso 3: Solo Video/Fotos (Fallback)
```
INPUT:
  No hay escenas extraídas → Fallback al video completo
  Slideshow de fotos disponible
  
OUTPUT:
  Se usa video completo ordenado por productScore calculado
  Se mantiene adaptabilidad pero con recurso limitado
```

---

## Razones Técnicas del Diseño

### ¿Por qué productScore vs. solo filtro booleano?

**Alternativa rechazada**: Solo filtrar (acepta/rechaza)
- Problema: Pierde información gradual
- Resultado: No se puede priorizar entre buenas escenas

**Solución elegida**: Score 0-100
- Permite ranking numérico
- Útil para ordenamiento flexible
- Adaptable a umbrales dinámicos

### ¿Por qué 3 buckets (Alto/Medio/Bajo)?

**Alternativa 1**: Ordenar 100% por score
- Problema: Si hay muchas escenas de score 52, 51, 50, el orden es erratic
- Resultaría: Saltos visuales sin estructura lógica

**Alternativa 2**: Solo alto vs. resto
- Problema: Desperdicia información de escenas "buenas pero no excelentes"
- Resultado: Videos con estructuras visuales débiles

**Solución elegida**: 3 categorías con umbrales claros
- Alto (≥70): Producto claramente visible
- Medio (50-69): Contenido útil pero no protagonista
- Bajo (<50): Fondo/texto/relleno
- Resultado: Estructura visual coherente + flexibilidad

### ¿Por qué conservar escenas de bajo score?

**Razón 1**: Duración de 60s
- Algunos productos no generan 60s de contenido de alta calidad
- Mejor reutilizar escenas "medias" que dejar huecos

**Razón 2**: Adaptabilidad
- Si hay solo 2 clips total, ambos se usan (pero reordenados)
- El sistema no falla; solo se adapta

**Razón 3**: Contexto visual
- Algunas escenas de bajo score pueden proporcionar contexto necesario
- Ordenamiento asegura que no aparezcan de primero

---

## Testing Recomendado

Para validar los cambios en tu proyecto:

```bash
# 1. Verificar que detecta text slides mejorados
# Busca en logs: "slide(brillo=..." indicando fondos detectados

# 2. Verificar productScore
# Logs deben mostrar: "prod=85" o similar en cada escena

# 3. Verificar ordenamiento adaptativo
# Logs mostrarán: "Adaptabilidad productScore: X alto, Y medio, Z bajo"

# 4. Ejecutar video final
# Primeros 10s deben mostrar producto claramente (no logos/títulos)
```

---

## Fallbacks y Seguridad

### ¿Qué pasa si falla scene-extractor?
```javascript
// Si extractAndFilterScenes falla, fallback a video completo
catch (e) {
  clipObjs.push({
    path: vp,
    duration: 30,
    productScore: 60,  // Score moderado por defecto
    source: 'whole'
  });
}
```

### ¿Qué pasa si no hay escenas?
```javascript
const fromPhotosOnly = adaptiveOrder.length === 0;
// Usa slideshow de fotos si existe
// El ordenamiento adaptativo no rompe el fallback
```

### ¿Qué pasa con videos que son 100% texto?
```javascript
// El retry adaptativo de scene-extractor los procesa
// Si TODOS fallan: usa video entero (source: 'whole-fallback')
// Ordenamiento adaptativo intenta mejorar pero no puede hacer magia
```

---

## Monitoreo y Ajustes Futuros

### KPIs a monitorear:
1. **Porcentaje de videos con producto en primeros 5s**: Objetivo >95%
2. **Promedio de productScore del primer clip**: Objetivo >75
3. **Relación alto:bajo en _combined**: Objetivo >2:1

### Si los videos no mejoran:
1. Revisar SCENE_MAX_BRIGHTNESS (quizá demasiado permisivo)
2. Aumentar PRODUCT_SCORE_HIGH_THRESHOLD
3. Verificar manualmente videos de entrada (pueden ser inherentemente malos)

---

## Resumen de Beneficios

| Aspecto | Antes | Después |
|--------|-------|---------|
| **Inicio del video** | Aleatorio (posible título/logo) | Producto prioritario |
| **Fondos uniformes** | Frecuentes en video | Filtrados inteligentemente |
| **Adaptabilidad** | Fija (concat lineal) | Dinámica (reorden smartscoring) |
| **Logs** | Genéricos | Detallan score y estrategia |
| **Escalabilidad** | Difícil agregar lógica | Fácil ajustar umbrales |

---

## Conclusión

Esta implementación transforma `_combined.mp4` de un simple concatenado lineal a un **video estructurado inteligentemente**, priorizando siempre el producto y adaptándose a la calidad disponible. 

El sistema es **resiliente** (no se quiebra si hay poco contenido bueno) y **observable** (logs detallados de cada decisión).

---

*Para preguntas o mejoras, revisar logs del agente y productScore de escenas individuales.*
