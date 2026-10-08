# 🔧 Ejemplos Prácticos de Integración

## Cómo Usar las Funciones Mejoradas

---

## Ejemplo 1: Generar Título Dinámico

### Ubicación en código:
```javascript
// En PublishingSchedulingAgent.js, función _prepareLongVideoMetadata()
const dynamicTitle = this._generateDynamicTitle(scheduleEntry.title, metadata.seo);
```

### Entrada (scheduleEntry.title):
```
"Top 5 Amazing Tech Gadgets"
```

### Proceso Interno:
```javascript
1. Extrae número: "5"
2. Hash del contenido: determina plantilla fija
3. Selecciona: "[5] Gadgets Tecnológicos que Cambiarán tu Setup ⚡"
4. Verifica longitud: 52 caracteres < 100 ✓
5. Retorna: "[5] Gadgets Tecnológicos que Cambiarán tu Setup ⚡"
```

### Salida:
```
[5] Gadgets Tecnológicos que Cambiarán tu Setup ⚡
```

---

## Ejemplo 2: Generar Capítulos Automáticos

### Datos de Entrada (script.mainContent.sections):
```javascript
[
  {
    productName: "AirPods Pro",
    videoDuration: 45,  // segundos
    content: "Descripción del producto..."
  },
  {
    productName: "MacBook Air M3",
    videoDuration: 60,
    content: "..."
  },
  {
    productName: "iPad Pro 12.9",
    videoDuration: 50,
    content: "..."
  }
]
```

### Proceso Interno:
```javascript
const INTRO_DURATION = 30;  // segundos
let currentTime = INTRO_DURATION;

// Capítulo 0: Siempre Intro
chapters.push({
  timestamp: '00:00',
  title: 'Intro'
});

// Para AirPods Pro (videoDuration: 45)
currentTime = 30;
timestamp = '00:30'  // 30 segundos = 00:30
chapters.push({ timestamp: '00:30', title: 'AirPods Pro' });
currentTime += 45;  // Ahora es 75

// Para MacBook Air (videoDuration: 60)
timestamp = '01:15'  // 75 segundos = 1 min 15 seg
chapters.push({ timestamp: '01:15', title: 'MacBook Air M3' });
currentTime += 60;  // Ahora es 135

// Para iPad Pro (videoDuration: 50)
timestamp = '02:15'  // 135 segundos = 2 min 15 seg
chapters.push({ timestamp: '02:15', title: 'iPad Pro 12.9' });
currentTime += 50;  // Total 185
```

### Salida Completa:
```
[
  { timestamp: '00:00', title: 'Intro' },
  { timestamp: '00:30', title: 'AirPods Pro' },
  { timestamp: '01:15', title: 'MacBook Air M3' },
  { timestamp: '02:15', title: 'iPad Pro 12.9' }
]
```

### Cómo Se Vería en YouTube:
```
00:00 - Intro
00:30 - AirPods Pro
01:15 - MacBook Air M3
02:15 - iPad Pro 12.9
```

⚠️ **Nota:** YouTube convierte automáticamente timestamps a marcas clickeables en el player.

---

## Ejemplo 3: Descripción con Capítulos

### Entrada:
```javascript
{
  originalDescription: "En este video te mostramos los mejores gadgets de Amazon...",
  chapters: [
    { timestamp: '00:00', title: 'Intro' },
    { timestamp: '00:30', title: 'AirPods Pro' },
    { timestamp: '01:15', title: 'MacBook Air M3' },
    { timestamp: '02:15', title: 'iPad Pro 12.9' }
  ],
  affiliateLink: "https://amazon.com/shop/techfinds"
}
```

### Salida Completa:
```
En este video te mostramos los mejores gadgets de Amazon...

══════════════════════════════════════════════════
📌 CAPÍTULOS DEL VIDEO
══════════════════════════════════════════════════
00:00 - Intro
00:30 - AirPods Pro
01:15 - MacBook Air M3
02:15 - iPad Pro 12.9

══════════════════════════════════════════════════
🔗 ENLACES Y RECURSOS
══════════════════════════════════════════════════
Todos los enlaces de compra:
https://amazon.com/shop/techfinds

👉 Suscríbete para más gadgets tech
👉 Visita nuestro canal de TikTok/Instagram para versiones cortas

#gadgets #amazon #amazonfinds #tech #technologia #gadgetstecnologicos #productostech #recomendaciones #viral
```

**Longitud Total:** ~800-900 caracteres (bien dentro del límite de 5000)

---

## Ejemplo 4: Título de Shorts Alto Impacto

### Entrada:
```javascript
baseTitle = "Top 5 Best Amazon Tech Gadgets"
```

### Proceso Interno:
```javascript
1. Limpia prefijo "Top 5" → "Best Amazon Tech Gadgets"
2. Longitud 28 caracteres → OK (< 30)
3. Selecciona emoji: 🔥
4. Plantilla aleatoria: "El MEJOR ${cleanTitle} ${emoji}"
5. Resultado: "El MEJOR Best Amazon Tech Gadgets 🔥"
6. Verifica longitud: 45 caracteres < 60 ✓
```

### Salida:
```
El MEJOR Best Amazon Tech Gadgets 🔥 #shorts
```

---

## Ejemplo 5: Product Short Completo

### Entrada:
```javascript
const productName = "Sony WH-1000XM5 Wireless Headphones";
const generalMetadata = {
  affiliateUrl: "https://amazon.com/dp/B0B3KXRXDL",
  categoryId: "28",  // Tech & Science
  language: "es"
};

agent._prepareProductShortMetadata(productName, generalMetadata);
```

### Proceso Interno:

**1. Genera Título:**
```javascript
productDisplayName = "Sony WH-1000XM5..." (truncado a 30)
emoji = "😱"  // Aleatorio
title = "El MEJOR Sony WH-1000XM5... 😱 #shorts #tech"
finalTitle = (50 caracteres) → Válido
```

**2. Genera Descripción:**
```
✨ Descubre por qué todos quieren este producto.

👇 Consíguelo en Amazon:
https://amazon.com/dp/B0B3KXRXDL

🎬 Ver análisis completo en el video principal (link en bio)

#shorts #gadgets #amazon #tecnologia #techfinds
```

**3. Genera Tags:**
```javascript
['shorts', 'gadgets', 'tecnologia', 'tech', 'amazon', 'amazonfinds', 'techfinds', 'review']
```

### Salida Completa:
```json
{
  "snippet": {
    "title": "El MEJOR Sony WH-1000XM5... 😱 #shorts #tech",
    "description": "✨ Descubre por qué todos quieren este producto.\n\n👇 Consíguelo en Amazon:\nhttps://amazon.com/dp/B0B3KXRXDL\n\n🎬 Ver análisis completo en el video principal (link en bio)\n\n#shorts #gadgets #amazon #tecnologia #techfinds",
    "tags": ["shorts", "gadgets", "tecnologia", "tech", "amazon", "amazonfinds", "techfinds", "review"],
    "categoryId": "28",
    "defaultLanguage": "es",
    "defaultAudioLanguage": "es"
  },
  "status": {
    "privacyStatus": "unlisted",
    "selfDeclaredMadeForKids": false
  }
}
```

---

## Ejemplo 6: Flujo Completo de Publicación

### Paso 1: Script Se Prepara (index.js Step 3)
```javascript
const script = {
  title: "Top 5 Amazing Tech Gadgets",
  mainContent: {
    sections: [
      {
        productName: "AirPods Pro",
        videoDuration: 45,
        filename: "airpods_pro.mp4"
      },
      {
        productName: "MacBook Air",
        videoDuration: 60,
        filename: "macbook_air.mp4"
      }
      // ... más productos
    ]
  }
};
```

### Paso 2: Video Se Procesa (Step 8)
```javascript
const productionData = {
  script: script,
  assets: {
    finalVideo: { path: 'data/production/final_video.mp4' }
  },
  seo: {
    title: "Top 5 Amazing Tech Gadgets",
    description: "En este video mostramos..."
  }
};
```

### Paso 3: Se Programa (scheduleContent)
```javascript
const scheduleEntry = {
  title: "Top 5 Amazing Tech Gadgets",
  metadata: {
    script: script,              // ← CRÍTICO para capítulos
    seo: productionData.seo
  }
};
```

### Paso 4: Se Publica (publishContent)
```javascript
// _prepareLongVideoMetadata() es llamada:
const metadata = this._prepareLongVideoMetadata(scheduleEntry, scheduleEntry.metadata);

// Internamente:
// 1. Genera título dinámico:
const title = this._generateDynamicTitle(
  "Top 5 Amazing Tech Gadgets",
  metadata.seo
);
// → "[5] Gadgets Tecnológicos que Cambiarán tu Setup ⚡"

// 2. Genera capítulos:
const chapters = this._generateChapters(metadata.script);
// → [{ timestamp: '00:00', title: 'Intro' }, { timestamp: '00:30', title: 'AirPods Pro' }, ...]

// 3. Construye descripción:
const description = this._buildDescriptionWithChapters(
  metadata.seo.description,
  chapters,
  metadata.seo.affiliateLink
);

// 4. Retorna metadata optimizado:
return {
  snippet: {
    title: "[5] Gadgets Tecnológicos que Cambiarán tu Setup ⚡",
    description: "[Descripción con capítulos y enlaces]",
    tags: ["tech", "gadgets", "amazon finds", ...],
    categoryId: "28"
  },
  status: {
    privacyStatus: "unlisted"
  }
};
```

### Paso 5: YouTube API Inserta
```javascript
const response = await youtube.videos.insert({
  part: 'snippet,status,fileDetails',
  resource: metadata,  // ← Metadata optimizado
  media: { body: fs.createReadStream(videoPath) }
});
```

### Resultado en YouTube:
- ✅ Título dinámico visible en búsqueda
- ✅ Capítulos clickeables en descripción
- ✅ Enlace de afiliado centralizado
- ✅ Hashtags optimizados para SEO
- ✅ Status "No listado" para revisión

---

## Ejemplo 7: Intro Short Mejorado

### Entrada:
```javascript
const scheduleEntry = {
  title: "Top 5 Amazing Gadgets"
};

const metadata = {
  seo: {
    title: "Top 5 Amazing Gadgets",
    description: "Descubre los 5 gadgets más sorprendentes...",
    affiliateLink: "https://amazon.com/shop/techfinds"
  }
};

agent._prepareShortMetadata(scheduleEntry, metadata);
```

### Proceso Interno:

**1. Genera Título Dinámico:**
```javascript
// Llama a _generateImpactShortTitle()
baseTitle = "Top 5 Amazing Gadgets"
cleanTitle = "Amazing Gadgets"  // Quita "Top 5"
randomEmoji = "🤯"
template = "El MEJOR ${cleanTitle} ${emoji}"
resultado = "El MEJOR Amazing Gadgets 🤯 #shorts"
```

**2. Extrae Primera Oración:**
```javascript
fullDescription = "Descubre los 5 gadgets más sorprendentes..."
firstSentence = "Descubre los 5 gadgets más sorprendentes."
```

**3. Construye Descripción:**
```
Descubre los 5 gadgets más sorprendentes.

👇 Consíguelo en Amazon:
https://amazon.com/shop/techfinds

🎬 Ver análisis COMPLETO en nuestro video principal
📺 Suscríbete para más gadgets tech

#Shorts #techfinds #amazonfinds #gadgets #technologia #amazonfavorites
```

### Salida Completa:
```json
{
  "snippet": {
    "title": "El MEJOR Amazing Gadgets 🤯 #shorts",
    "description": "Descubre los 5 gadgets más sorprendentes.\n\n👇 Consíguelo en Amazon:\nhttps://amazon.com/shop/techfinds\n\n🎬 Ver análisis COMPLETO en nuestro video principal\n📺 Suscríbete para más gadgets tech\n\n#Shorts #techfinds #amazonfinds #gadgets #technologia #amazonfavorites",
    "tags": ["Shorts", "amazon finds", "tech gadgets", "mejores gadgets", "tecnologia", "gadgets amazon", "tech review"],
    "categoryId": "28"
  },
  "status": {
    "privacyStatus": "unlisted"
  }
}
```

---

## Integración en index.js (Ejemplo)

### En Step 9 (Publicación), después de assembleVideo:
```javascript
// ANTES (antiguo):
// const metadata = await publishingAgent._prepareLongVideoMetadata(scheduleEntry);

// DESPUÉS (nuevo):
// El metadata se prepara automáticamente en publishContent()
// Asegurar que script esté disponible:
scheduleEntry.metadata.script = productionData.script;

// Luego llamar:
const result = await publishingAgent.publishContent(scheduleEntry.id);
```

### Para Verificar en Consola:
```javascript
// Agregar logging en _prepareLongVideoMetadata():
const title = this._generateDynamicTitle(scheduleEntry.title, metadata.seo);
console.log('📊 Título Dinámico:', title);

const chapters = this._generateChapters(metadata.script);
console.log('📍 Capítulos:', chapters.map(c => `${c.timestamp} - ${c.title}`).join('\n'));

const description = this._buildDescriptionWithChapters(...);
console.log('📝 Descripción (primeras 200 chars):', description.substring(0, 200));
```

---

## Resolución de Problemas

### ❌ Problema: Capítulos no aparecen
```javascript
// Verificar que script se pase:
console.log('¿Script disponible?', !!metadata.script);
console.log('¿Sections?', !!metadata.script?.mainContent?.sections);
console.log('¿VideoDuration?', metadata.script?.mainContent?.sections?.[0]?.videoDuration);
```

**Solución:** Asegurar propagación en `scheduleContent()`:
```javascript
metadata: {
  script: productionData.script,  // ← Esto es crítico
  seo: productionData.seo
}
```

### ❌ Problema: Título truncado
```javascript
// Títulos muy largos se cortan
if (title.length > 100) {
  console.warn('⚠️ Título truncado en YouTube API');
}
```

**Solución:** Verificar en `_generateDynamicTitle()`:
```javascript
const finalTitle = selectedTemplate.length > 100 
  ? selectedTemplate.substring(0, 97) + '...'
  : selectedTemplate;
```

### ❌ Problema: Descripción truncada
```javascript
const description = this._buildDescriptionWithChapters(...);
if (description.length > 5000) {
  console.error('❌ Descripción excede límite de YouTube (5000 chars)');
  console.log('Longitud actual:', description.length);
}
```

**Solución:** Limitar número de capítulos o reducir descripción original.

---

## Verificación Final

### Checklist de Implementación:
- [ ] Sintaxis validada: `node -c agents/publishing-scheduling-agent.js` ✓
- [ ] Script propagado a metadata en `scheduleContent()` ✓
- [ ] `clipDuration` disponible en `huntResults[i]` ✓
- [ ] `videoDuration` copiado a `script.mainContent.sections[i]` ✓
- [ ] Títulos dinámicos retornan > 40 caracteres ✓
- [ ] Capítulos tienen formato MM:SS ✓
- [ ] Descripciones < 5000 caracteres ✓
- [ ] Emojis se insertan correctamente ✓
- [ ] Product shorts retornan URL de afiliado ✓

---

**Documento de Integración:** Listo para Copiar y Reemplazar ✅  
**Versión:** 2.0  
**Última Actualización:** 2024
