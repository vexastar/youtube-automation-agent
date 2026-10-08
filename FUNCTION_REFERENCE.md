# 📋 Quick Reference - Funciones Listas para Copiar

## Ubicación en Archivo
**Archivo:** `agents/publishing-scheduling-agent.js`

---

## 1️⃣ Función: `_generateDynamicTitle()`

**Propósito:** Generar títulos de alto CTR para videos largos  
**Parámetros:** `(baseTitle: string, seo: object)` → `string`  
**Línea:** ~730 en el archivo

```javascript
_generateDynamicTitle(baseTitle, seo) {
  const numberMatch = baseTitle.match(/\b(Top|top|TOP)\s+(\d+)/i);
  const topNumber = numberMatch ? numberMatch[2] : '';
  
  const templates = [
    `[${topNumber}] Gadgets de Amazon que NO Sabías que Necesitabas 🤯`,
    `[${topNumber}] Gadgets Tecnológicos que Cambiarán tu Setup ⚡`,
    `[${topNumber}] Productos Secretos de Amazon que DEBES Probar 🔥`,
    `[${topNumber}] Los Mejores Gadgets Tech de Amazon 💎`,
    `[${topNumber}] Gadgets Amazon que Hacen Puro DAÑO 🚀`,
    `[${topNumber}] Descubrimientos Increíbles en Amazon 🎯`,
    `[${topNumber}] Gadgets Tech Que TODO MUNDO Debería Tener 😱`,
    `[${topNumber}] Los Gadgets Más Buscados de Amazon Este Año ⭐`
  ];
  
  const contentHash = baseTitle.split('').reduce((a, b) => {
    a = ((a << 5) - a) + b.charCodeAt(0);
    return a & a;
  }, 0);
  const selectedTemplate = templates[Math.abs(contentHash) % templates.length];
  
  const finalTitle = selectedTemplate.length > 100 
    ? selectedTemplate.substring(0, 97) + '...'
    : selectedTemplate;
  
  return finalTitle;
}
```

---

## 2️⃣ Función: `_generateChapters()`

**Propósito:** Generar capítulos automáticos con timestamps  
**Parámetros:** `(script: object)` → `array`  
**Línea:** ~780 en el archivo

```javascript
_generateChapters(script) {
  const chapters = [];
  
  chapters.push({
    timestamp: '00:00',
    title: 'Intro'
  });
  
  if (!script || !script.mainContent || !script.mainContent.sections) {
    return chapters;
  }
  
  const sections = script.mainContent.sections;
  const INTRO_DURATION = 30;
  let currentTime = INTRO_DURATION;
  
  sections.forEach((section, idx) => {
    const productName = section.productName || section.title || `Producto ${idx + 1}`;
    const clipDuration = section.videoDuration || 30;
    
    const minutes = Math.floor(currentTime / 60);
    const seconds = Math.floor(currentTime % 60);
    const timestamp = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    
    chapters.push({
      timestamp: timestamp,
      title: productName
    });
    
    currentTime += clipDuration;
  });
  
  return chapters;
}
```

---

## 3️⃣ Función: `_buildDescriptionWithChapters()`

**Propósito:** Construir descripción con capítulos y enlaces  
**Parámetros:** `(description: string, chapters: array, affiliateLink: string)` → `string`  
**Línea:** ~830 en el archivo

```javascript
_buildDescriptionWithChapters(originalDescription, chapters, affiliateLink) {
  let description = originalDescription || 'Descubre los mejores gadgets de Amazon.';
  
  description += '\n\n' + '═'.repeat(50) + '\n';
  description += '📌 CAPÍTULOS DEL VIDEO\n';
  description += '═'.repeat(50) + '\n';
  
  chapters.forEach(chapter => {
    description += `${chapter.timestamp} - ${chapter.title}\n`;
  });
  
  description += '\n' + '═'.repeat(50) + '\n';
  description += '🔗 ENLACES Y RECURSOS\n';
  description += '═'.repeat(50) + '\n';
  
  if (affiliateLink) {
    description += `Todos los enlaces de compra:\n${affiliateLink}\n\n`;
  }
  
  description += `👉 Suscríbete para más gadgets tech\n`;
  description += `👉 Visita nuestro canal de TikTok/Instagram para versiones cortas\n\n`;
  
  description += '#gadgets #amazon #amazonfinds #tech #technologia #gadgetstecnologicos #productostech #recomendaciones #viral';
  
  return description;
}
```

---

## 4️⃣ Función: `_generateImpactShortTitle()`

**Propósito:** Generar títulos de alto impacto para Shorts  
**Parámetros:** `(baseTitle: string)` → `string`  
**Línea:** ~880 en el archivo

```javascript
_generateImpactShortTitle(baseTitle) {
  let cleanTitle = baseTitle
    .replace(/^Top\s+\d+\s*[:\-]?\s*/i, '')
    .replace(/^Mejor\s+/i, '')
    .replace(/^Los\s+/i, '')
    .trim();
  
  if (cleanTitle.length > 30) {
    cleanTitle = cleanTitle.substring(0, 27) + '...';
  }
  
  const impactEmojis = ['😱', '🤯', '🔥', '⚡', '💎', '🚀', '🎯', '✨'];
  const randomEmoji = impactEmojis[Math.floor(Math.random() * impactEmojis.length)];
  
  const templates = [
    `${cleanTitle} ${randomEmoji} #shorts`,
    `El MEJOR ${cleanTitle} ${randomEmoji}`,
    `IMPRESCINDIBLE: ${cleanTitle} ${randomEmoji}`,
    `${cleanTitle} te SORPRENDERÁ ${randomEmoji}`,
    `¿Ya conoces el ${cleanTitle}? ${randomEmoji}`
  ];
  
  const selectedTemplate = templates[Math.floor(Math.random() * templates.length)];
  
  return selectedTemplate;
}
```

---

## 5️⃣ Función Refactorizada: `_prepareLongVideoMetadata()`

**Propósito:** Preparar metadata optimizado para videos largos (16:9)  
**Parámetros:** `(scheduleEntry: object, metadata: object)` → `object`  
**Línea:** ~690 en el archivo

```javascript
_prepareLongVideoMetadata(scheduleEntry, metadata) {
  const dynamicTitle = this._generateDynamicTitle(scheduleEntry.title, metadata.seo);
  const chapters = this._generateChapters(metadata.script);
  const descriptionWithChapters = this._buildDescriptionWithChapters(
    metadata.seo.description,
    chapters,
    metadata.seo.affiliateLink
  );
  
  return {
    snippet: {
      title: dynamicTitle,
      description: descriptionWithChapters,
      tags: [
        'tech',
        'gadgets',
        'amazon finds',
        'amazon',
        'tecnologia',
        'YouTube',
        'recomendaciones'
      ],
      categoryId: metadata.seo.metadata?.category?.toString() || '28',
      defaultLanguage: metadata.seo.metadata?.language || 'es',
      defaultAudioLanguage: metadata.seo.metadata?.language || 'es'
    },
    status: {
      privacyStatus: 'unlisted',
      selfDeclaredMadeForKids: false,
      madeForKids: false
    }
  };
}
```

---

## 6️⃣ Función Refactorizada: `_prepareShortMetadata()`

**Propósito:** Preparar metadata optimizado para Intro Shorts (9:16)  
**Parámetros:** `(scheduleEntry: object, metadata: object)` → `object`  
**Línea:** ~217 en el archivo

```javascript
_prepareShortMetadata(scheduleEntry, metadata) {
  const baseTitle = metadata.seo.title || scheduleEntry.title;
  let shortsTitle = this._generateImpactShortTitle(baseTitle);
  
  if (shortsTitle.length > 100) {
    shortsTitle = shortsTitle.substring(0, 97) + '...';
  }

  let shortsDescription = '';
  
  const fullDescription = metadata.seo.description || '';
  let firstSentence = 'Descubre este increíble gadget';
  
  if (fullDescription && fullDescription.length > 0) {
    const firstPeriod = fullDescription.indexOf('.');
    if (firstPeriod !== -1) {
      firstSentence = fullDescription.substring(0, firstPeriod + 1).trim();
    } else {
      if (fullDescription.length <= 80) {
        firstSentence = fullDescription.trim();
      } else {
        const words = fullDescription.split(/\s+/);
        firstSentence = words.slice(0, Math.min(3, words.length)).join(' ').trim();
        if (!firstSentence.endsWith('.')) {
          firstSentence += '.';
        }
      }
    }
  }
  
  shortsDescription += `${firstSentence}\n`;
  shortsDescription += `👇 Consíguelo en Amazon:\n`;
  
  if (metadata.seo.affiliateLink) {
    shortsDescription += `${metadata.seo.affiliateLink}\n`;
  } else {
    shortsDescription += `https://amazon.com\n`;
  }
  
  shortsDescription += `\n🎬 Ver análisis COMPLETO en nuestro video principal\n`;
  shortsDescription += `📺 Suscríbete para más gadgets tech\n`;
  shortsDescription += `\n#Shorts #techfinds #amazonfinds #gadgets #technologia #amazonfavorites`;

  const shortsTags = [
    'Shorts',
    'amazon finds',
    'tech gadgets',
    'mejores gadgets',
    'tecnologia',
    'gadgets amazon',
    'tech review'
  ];

  return {
    snippet: {
      title: shortsTitle,
      description: shortsDescription,
      tags: shortsTags,
      categoryId: metadata.seo.metadata?.category?.toString() || '28',
      defaultLanguage: metadata.seo.metadata?.language || 'es',
      defaultAudioLanguage: metadata.seo.metadata?.language || 'es'
    },
    status: {
      privacyStatus: 'unlisted',
      selfDeclaredMadeForKids: false
    }
  };
}
```

---

## 7️⃣ Función Refactorizada: `_prepareProductShortMetadata()`

**Propósito:** Preparar metadata optimizado para Product Shorts (9:16)  
**Parámetros:** `(productName: string, generalMetadata: object)` → `object`  
**Línea:** ~731 en el archivo

```javascript
_prepareProductShortMetadata(productName, generalMetadata = {}) {
  let productDisplayName = productName;
  if (productDisplayName.length > 30) {
    productDisplayName = productDisplayName.substring(0, 27) + '...';
  }
  
  const impactEmojis = ['😱', '🤯', '🔥', '⚡', '💎', '🚀'];
  const randomEmoji = impactEmojis[Math.floor(Math.random() * impactEmojis.length)];
  
  const title = `El MEJOR ${productDisplayName} ${randomEmoji} #shorts #tech`;
  const finalTitle = title.length > 100 ? title.substring(0, 97) + '...' : title;
  
  const description = 
    `✨ Descubre por qué todos quieren este producto.\n` +
    `\n` +
    `👇 Consíguelo en Amazon:\n` +
    `${generalMetadata.affiliateUrl || 'https://amazon.com'}\n` +
    `\n` +
    `🎬 Ver análisis completo en el video principal (link en bio)\n` +
    `\n` +
    `#shorts #gadgets #amazon #tecnologia #techfinds`;
  
  const tags = [
    'shorts',
    'gadgets',
    'tecnologia',
    'tech',
    'amazon',
    'amazonfinds',
    'techfinds',
    'review'
  ];
  
  return {
    snippet: {
      title: finalTitle,
      description: description,
      tags: tags,
      categoryId: generalMetadata.categoryId || '28',
      defaultLanguage: generalMetadata.language || 'es',
      defaultAudioLanguage: generalMetadata.language || 'es'
    },
    status: {
      privacyStatus: 'unlisted',
      selfDeclaredMadeForKids: false
    }
  };
}
```

---

## Cambio Requerido en `scheduleContent()`

**Ubicación:** Línea ~70 en PublishingSchedulingAgent.js

**Cambio:**
```javascript
// ANTES:
const scheduleEntry = {
  productionId: productionData.id,
  title: productionData.script.title,
  videoType: videoType,
  publishTime: productionData.scheduledPublishTime,
  status: 'scheduled',
  priority: productionData.priority,
  metadata: {
    seo: productionData.seo,
    // ... resto
  }
};

// DESPUÉS:
const scheduleEntry = {
  productionId: productionData.id,
  title: productionData.script.title,
  videoType: videoType,
  publishTime: productionData.scheduledPublishTime,
  status: 'scheduled',
  priority: productionData.priority,
  metadata: {
    seo: productionData.seo,
    script: productionData.script,  // ← NUEVO: Requerido para capítulos
    // ... resto
  }
};
```

---

## Tabla de Cambios Resumida

| Función | Línea Aprox. | Estado | Cambio |
|---------|-------------|--------|--------|
| `_generateDynamicTitle()` | 730 | ✅ Nueva | Genera títulos de alto CTR |
| `_generateChapters()` | 780 | ✅ Nueva | Timestamps automáticos |
| `_buildDescriptionWithChapters()` | 830 | ✅ Nueva | Descripciones con capítulos |
| `_generateImpactShortTitle()` | 880 | ✅ Nueva | Títulos de corta duración |
| `_prepareLongVideoMetadata()` | 690 | ✏️ Refactorizado | Usa helpers dinámicos |
| `_prepareShortMetadata()` | 217 | ✏️ Refactorizado | Usa `_generateImpactShortTitle()` |
| `_prepareProductShortMetadata()` | 731 | ✏️ Refactorizado | Nuevos emojis + estructura |
| `scheduleContent()` | 70 | ✏️ Modificado | Agregar `script` a metadata |

---

## Validación Syntax Check

```bash
node -c agents/publishing-scheduling-agent.js
```

✅ **Resultado esperado:** Sin output (sin errores)

---

## Uso en publishContent()

```javascript
// Dentro de publishContent():
async publishContent(contentId) {
  // ... obtener scheduleEntry ...
  
  const metadata = videoType === 'short' 
    ? this._prepareShortMetadata(scheduleEntry, scheduleEntry.metadata)
    : this._prepareLongVideoMetadata(scheduleEntry, scheduleEntry.metadata);
  
  // Aquí se llaman automáticamente las funciones helper
  // - _generateDynamicTitle() → Título optimizado
  // - _generateChapters() → Capítulos con timestamps
  // - _buildDescriptionWithChapters() → Descripción completa
  
  // Resultado: metadata optimizado para YouTube API
  const response = await youtube.videos.insert({
    part: 'snippet,status',
    resource: metadata
  });
  
  return response;
}
```

---

## Checklist de Implementación

- [x] Sintaxis validada
- [x] Funciones helper creadas
- [x] Funciones refactorizadas
- [x] Cambio en `scheduleContent()` aplicado
- [x] Documentación completa
- [x] Ejemplos de uso disponibles
- [ ] Prueba en producción (siguiente paso)

---

**Status:** ✅ Listo para Copiar y Reemplazar  
**Versión:** 2.0  
**Fecha:** 2024
