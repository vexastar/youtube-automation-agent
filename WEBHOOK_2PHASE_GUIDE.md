# 🚀 Webhook Distribution: Arquitectura 2-Fases

## ⚡ Resumen Ejecutivo

La refactorización del sistema de distribución de videos a Make.com elimina los **problemas de timeout** al desacoplar completamente el upload a CDN del envío de webhooks.

### Antes (Acoplado - Problemas)
```
Video Local
   ↓
[Upload a CDN] ← Esperando...
   ↓
[Enviar Webhook] ← Timeout si CDN es lento
   ↓
Make.com (TikTok, Instagram, Facebook)
```
**Problema:** El webhook espera a que termine el upload. Si el CDN está lento → timeout.

### Después (Desacoplado - Solución)
```
Video Local
   ↓
FASE 1: [Upload a CDN] ← Síncrono + Secuencial, SIN webhooks
   │
   ├─ Video 1 → catbox.moe
   ├─ Video 2 → 0x0.st (fallback)
   └─ Video 3 → tmpfiles.org (fallback)
   ↓
FASE 2: [Enviar Webhooks] ← POST-CDN, URLs confirmadas
   │
   ├─ Webhook 1 → Make.com
   ├─ Webhook 2 → Make.com
   └─ Webhook 3 → Make.com (ÚLTIMA INSTRUCCIÓN)
   ↓
Make.com (TikTok, Instagram, Facebook)
```
**Ventaja:** Webhooks se envían cuando TODO ya está listo en CDN. Sin timeouts.

---

## 📋 Estructura del Pipeline Completo

```
index.js: generateContent()
  │
  ├─ Step 1: Content Strategy (GPT-4o)
  ├─ Step 2: Product Hunter (RapidAPI o Local)
  ├─ Step 3: Script Writer (Guion con voces)
  ├─ Step 4: Thumbnail Designer (Miniatura con IA)
  ├─ Step 5: SEO Optimization
  ├─ Step 6: Production Management (Video 16:9 + Shorts 9:16)
  ├─ Step 7: Save to Database
  ├─ Step 8: Generate Affiliate Links
  │
  ├─ Step 9A: Publicar Video Largo (YouTube 16:9)
  ├─ Step 9B: Publicar Short (YouTube 9:16)
  ├─ Step 9C: Publicar Product Shorts (YouTube Unlisted)
  │
  └─ Step 9D: WEBHOOK DISTRIBUTION (2 FASES)
     │
     ├─ FASE 1: uploadVideoBatchToCloudCDN()
     │  └─ Subir TODOS los videos a CDN (Síncrono + Secuencial)
     │
     └─ FASE 2: sendWebhooksForUploadedVideos()
        └─ Enviar webhooks a Make.com (ÚLTIMA INSTRUCCIÓN)
```

---

## 🔧 API Reference

### FASE 1: `uploadVideoBatchToCloudCDN(videos)`

**Propósito:** Subir todos los videos a CDN de forma SÍNCRONA y SECUENCIAL.

**Entrada:**
```javascript
const videosToUpload = [
  {
    videoPath: "/path/to/intro_short.mp4",
    metadata: {
      title: "Top 5 Gadgets 2025",
      description: "Amazing products...",
      hashtags: "#gadgets #tech #products"
    }
  },
  {
    videoPath: "/path/to/product_short_1.mp4",
    metadata: {
      title: "Sony WH-1000XM5 Review",
      description: "Best headphones ever...",
      hashtags: "#review #sony"
    }
  }
];

const uploadedVideos = await webhookAgent.uploadVideoBatchToCloudCDN(videosToUpload);
```

**Salida:**
```javascript
[
  {
    videoPath: "/path/to/intro_short.mp4",
    videoUrl: "https://catbox.moe/h3k8j2l.mp4",  // ← URL del CDN
    metadata: {...},
    uploadedAt: "2025-07-22T10:30:00Z",
    status: "uploaded",
    fileName: "intro_short.mp4",
    fileSizeMB: 45.23
  },
  {
    videoPath: "/path/to/product_short_1.mp4",
    videoUrl: "https://0x0.st/q9Ky.mp4",  // ← Fallback a 0x0.st
    metadata: {...},
    uploadedAt: "2025-07-22T10:35:00Z",
    status: "uploaded",
    fileName: "product_short_1.mp4",
    fileSizeMB: 32.15
  }
]
```

**Características:**
- ✅ Ejecución **completamente síncrona** (un video a la vez)
- ✅ Reintentos automáticos por video (3 intentos por CDN)
- ✅ Fallback dinámico: catbox.moe → 0x0.st → tmpfiles.org
- ✅ NO hace webhooks
- ✅ Retorna URLs confirmadas

---

### FASE 2: `sendWebhooksForUploadedVideos(uploadedVideos)`

**Propósito:** Enviar webhooks a Make.com para videos QUE YA TIENEN URL de CDN.

**Entrada:**
```javascript
// El array retornado por uploadVideoBatchToCloudCDN()
const webhookResults = await webhookAgent.sendWebhooksForUploadedVideos(uploadedVideos);
```

**Payload JSON enviado a Make.com:**
```json
{
  "title": "Top 5 Gadgets 2025",
  "description": "Amazing products you need...",
  "hashtags": "#gadgets #tech #products",
  "videoUrl": "https://catbox.moe/h3k8j2l.mp4",
  "source": "youtube-automation-agent",
  "timestamp": "2025-07-22T10:30:00Z"
}
```

**Salida:**
```javascript
[
  {
    videoPath: "/path/to/intro_short.mp4",
    videoUrl: "https://catbox.moe/h3k8j2l.mp4",
    metadata: {...},
    webhookStatus: 200,  // ← HTTP status
    webhookResponse: {message: "Accepted"},
    status: "success"
  },
  {
    videoPath: "/path/to/product_short_1.mp4",
    videoUrl: "https://0x0.st/q9Ky.mp4",
    metadata: {...},
    webhookStatus: 200,
    webhookResponse: {...},
    status: "success"
  }
]
```

**Características:**
- ✅ Envía webhooks **SOLO** para videos con URL de CDN
- ✅ Ejecución **completamente síncrona**
- ✅ Reintentos automáticos por webhook (3 intentos)
- ✅ NO hace uploads (responsabilidad de FASE1)
- ✅ Omite automáticamente videos sin CDN URL

---

## 💻 Uso en index.js

```javascript
// Paso 9D: Distribución a Make.com (2 Fases)
const webhookAgent = new WebhookDistributionAgent();
await webhookAgent.initialize();

// Preparar batch
const videosToDistribute = [
  {
    videoPath: shortVideoPath,
    metadata: {title: "...", hashtags: "..."}
  },
  // más videos
];

// ═══ FASE 1: Upload a CDN (Síncrono + Secuencial) ═══
const uploadedVideos = await webhookAgent.uploadVideoBatchToCloudCDN(videosToDistribute);

// ═══ FASE 2: Webhooks (SOLO si hay uploads exitosos) ═══
const uploadedCount = uploadedVideos.filter(v => v.status === 'uploaded').length;

if (uploadedCount > 0) {
  const webhookResults = await webhookAgent.sendWebhooksForUploadedVideos(uploadedVideos);
  // webhookResults contiene respuestas de Make.com
}
```

---

## 🐛 Debugging

### Verificar que FASE 1 funciona
```bash
# Logs esperados:
# ════════════════════════════════════════════════════════════
# FASE 1: Subiendo 3 video(s) a CDN (Secuencial + Síncrono)
# [1/3] Procesando video...
#   ☁️  Iniciando upload a CDN...
#   ✅ Upload completado
# [2/3] Procesando video...
# ...
# FASE 1 RESUMEN:
#   ✅ Exitosos: 3/3
```

### Verificar que FASE 2 funciona
```bash
# Logs esperados:
# ════════════════════════════════════════════════════════════
# FASE 2: Enviando 3 webhook(s) a Make.com (Post-CDN)
# [1/3] Procesando webhook...
#   🔗 URL CDN: https://catbox.moe/abc123.mp4
#   🔄 Intento webhook [1/3]...
#   ✅ Webhook enviado (HTTP 200)
# ...
# FASE 2 RESUMEN:
#   ✅ Exitosos: 3
```

### Problema: Webhook no se envía
**Verificar:**
1. `MAKE_WEBHOOK_URL` está configurada en `.env`
2. URL es válida y accesible desde tu red
3. FASE 1 completó exitosamente (logs de `uploadedSuccessfully > 0`)

---

## 🔄 Flujo Detallado con Ejemplo

### Escenario: 3 Videos para Make.com

```javascript
// INPUT
const videos = [
  { videoPath: "shorts/intro.mp4", metadata: {title: "Top 5"} },
  { videoPath: "shorts/product1.mp4", metadata: {title: "Product 1"} },
  { videoPath: "shorts/product2.mp4", metadata: {title: "Product 2"} }
];

// FASE 1
uploadedVideos = [
  { videoUrl: "https://catbox.moe/abc.mp4", status: "uploaded" },
  { videoUrl: "https://0x0.st/def.mp4", status: "uploaded" },
  { videoUrl: null, status: "failed", error: "Connection timeout" }
];

// FASE 2
webhookResults = [
  { webhookStatus: 200, status: "success" },
  { webhookStatus: 200, status: "success" },
  { webhookStatus: "skipped", status: "skipped", reason: "No CDN URL" }
];

// RESUMEN
// 3 videos → 2 uploaded a CDN → 2 webhooks enviados → 2 exitosos
```

---

## 🛡️ Resilencia

### Reintentos Automáticos

**FASE 1:**
- Cada video: 3 reintentos por CDN (9 intentos total si cada CDN falla)
- Fallback automático entre CDNs

**FASE 2:**
- Cada webhook: 3 reintentos
- Espera 2 segundos entre reintentos

### Manejo de Fallos

| Escenario | Comportamiento |
|-----------|----------------|
| Upload falla | Omitido de webhooks automáticamente |
| Webhook falla | Registrado, pero pipeline continúa |
| CDN no disponible | Fallback automático al siguiente CDN |
| Make.com inaccesible | Reintentos automáticos, luego log de error |

---

## 📊 Variables de Entorno

```bash
# Requerida para activar webhooks
MAKE_WEBHOOK_URL=https://hook.make.com/your-webhook-id

# Opcional (si no configurada, ambas fases se omiten)
```

---

## 🚀 Migración de Código Legacy

### Antes (DEPRECATED)
```javascript
// ❌ NO USAR - Acoplado (problemas de timeout)
const results = await webhookAgent.sendBatchToMake(videos);
```

### Después (RECOMENDADO)
```javascript
// ✅ USAR - 2 Fases desacopladas
const uploadedVideos = await webhookAgent.uploadVideoBatchToCloudCDN(videos);
const webhookResults = await webhookAgent.sendWebhooksForUploadedVideos(uploadedVideos);
```

---

## 📝 Logs Esperados

### Run Exitoso (3 videos, todos en CDN)
```
════════════════════════════════════════════════════════════
FASE 1: Subiendo 3 video(s) a CDN (Secuencial + Síncrono)
════════════════════════════════════════════════════════════

[1/3] Procesando video...
  📄 Archivo: intro_short.mp4
  📏 Tamaño: 45.23 MB
  ☁️  Iniciando upload a CDN...
  🔄 Catbox.moe [Intento 1/3]...
  ✅ Subido a catbox: https://catbox.moe/h3k8j2l.mp4...
  ✅ [1] Upload completado

[2/3] Procesando video...
  📄 Archivo: product_short_1.mp4
  📏 Tamaño: 32.15 MB
  ☁️  Iniciando upload a CDN...
  🔄 Catbox.moe [Intento 1/3]...
  🔄 0x0.st [Intento 1/3]...
  ✅ Subido a 0x0.st: https://0x0.st/q9Ky.mp4...
  ✅ [2] Upload completado

[3/3] Procesando video...
  ❌ [3] Upload falló: File not found

════════════════════════════════════════════════════════════
FASE 1 RESUMEN:
  ✅ Exitosos: 2/3
  ❌ Fallidos: 1/3
════════════════════════════════════════════════════════════

════════════════════════════════════════════════════════════
FASE 2: Enviando 2 webhook(s) a Make.com (Post-CDN)
════════════════════════════════════════════════════════════

[1/2] Procesando webhook...
  📄 Archivo: intro_short.mp4
  🔗 URL CDN: https://catbox.moe/h3k8j2l.mp4...
  📝 Título: Top 5 Gadgets 2025
  📦 Payload preparado (287 bytes)
  🔄 Intento webhook [1/3]...
  ✅ [1] Webhook enviado (HTTP 200)
     Respuesta: Accepted

[2/2] Procesando webhook...
  📄 Archivo: product_short_1.mp4
  🔗 URL CDN: https://0x0.st/q9Ky.mp4...
  📝 Título: Product 1
  📦 Payload preparado (265 bytes)
  🔄 Intento webhook [1/3]...
  ✅ [2] Webhook enviado (HTTP 200)

════════════════════════════════════════════════════════════
FASE 2 RESUMEN:
  ✅ Exitosos: 2
  ⏭️  Omitidos: 1 (sin CDN URL)
════════════════════════════════════════════════════════════

Step 9D RESUMEN FINAL:
  📤 Uploads a CDN:  2/3 exitosos
                    1 fallidos
  🔗 Webhooks:      2 exitosos
                    1 omitidos (sin CDN URL)
════════════════════════════════════════════════════════════
```

---

## ✅ Checklist de Implementación

- [x] Método `uploadVideoBatchToCloudCDN()` creado en WebhookDistributionAgent
- [x] Método `sendWebhooksForUploadedVideos()` creado en WebhookDistributionAgent
- [x] Step 9D en index.js refactorizado para 2 fases
- [x] Logs explicativos por fase
- [x] Resumen final consolidado
- [x] Documentación en WEBHOOK_2PHASE_GUIDE.md
- [x] Notas en memoria del repositorio

---

## 🎯 Próximos Pasos

1. **Testing:** Ejecutar con videos reales y verificar logs
2. **Monitoring:** Revisar periodicamente success rate de uploads y webhooks
3. **Optimización:** Si hay patrones de fallo en CDN, ajustar reintentos/timeouts
4. **Deprecación:** Remover método legacy `sendBatchToMake()` en versión future

