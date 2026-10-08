# ⚡ Quick Reference: Webhook Distribution 2-Fases

## 🎯 De un Vistazo

### El Problema (Antes)
```javascript
// ❌ ACOPLADO (timeout issues)
await webhookAgent.sendBatchToMake(videos);
// Dentro: Upload (30-90s) + Webhook (10-20s) por video
// Resultado: Timeout si CDN lento
```

### La Solución (Después)
```javascript
// ✅ DESACOPLADO (sin timeout)
const uploaded = await webhookAgent.uploadVideoBatchToCloudCDN(videos);  // 30-90s
const results = await webhookAgent.sendWebhooksForUploadedVideos(uploaded);  // 10-20s
// Webhook es la ÚLTIMA instrucción
```

---

## 📍 Dónde Ocurre en el Código

```
index.js
  └─ generateContent()
      ├─ Step 1-8: [IA, Guion, Video]
      ├─ Step 9A: YouTube Long
      ├─ Step 9B: YouTube Short
      ├─ Step 9C: Product Shorts
      │
      └─ Step 9D: WEBHOOK DISTRIBUTION (2 FASES) ◄─── AQUÍ
          ├─ FASE 1: uploadVideoBatchToCloudCDN()
          │  └─ agents/webhook-distribution-agent.js:~440
          └─ FASE 2: sendWebhooksForUploadedVideos()
             └─ agents/webhook-distribution-agent.js:~565
```

---

## 💻 API Rápida

### FASE 1: Upload a CDN

```javascript
const videos = [
  {
    videoPath: "/path/to/video1.mp4",
    metadata: { title: "...", hashtags: "..." }
  },
  // más videos...
];

const uploadedVideos = await webhookAgent.uploadVideoBatchToCloudCDN(videos);

// Retorna: [{videoUrl: "https://...", status: "uploaded"}, ...]
```

### FASE 2: Send Webhooks

```javascript
const webhookResults = await webhookAgent.sendWebhooksForUploadedVideos(uploadedVideos);

// Retorna: [{webhookStatus: 200, status: "success"}, ...]
```

---

## 📊 Garantías

| Aspecto | Antes | Después |
|---------|-------|---------|
| Timeouts | ❌ Sí | ✅ No |
| Upload + Webhook | ❌ Mezclados | ✅ Separados |
| Webhook es último | ❌ No | ✅ Sí |
| Reintentos | ✅ Sí | ✅ Sí |
| Fallback CDNs | ✅ Sí | ✅ Sí |

---

## 🔄 Flujo Esperado

```
1. Setup videos ▶️
2. FASE1: Upload a CDN (secuencial)
   ├─ Video 1 → catbox.moe ✅
   ├─ Video 2 → 0x0.st ✅
   └─ Video 3 → falló ❌
3. FASE2: Webhooks (solo exitosos)
   ├─ Video 1 → Make.com ✅
   ├─ Video 2 → Make.com ✅
   └─ Video 3: omitido (sin URL)
```

---

## 🐛 Troubleshooting Rápido

### Webhook no se envía
```
✓ ¿MAKE_WEBHOOK_URL configurada en .env?
✓ ¿FASE1 completó exitosamente?
✓ ¿Log muestra "FASE 2 RESUMEN"?
```

### Upload falla
```
✓ ¿Archivo existe?
✓ ¿Conectividad a internet?
✓ ¿Archivo < 2GB?
```

### Todo falla
```
✓ Revisar logs FASE1 y FASE2
✓ Consultar WEBHOOK_2PHASE_GUIDE.md
✓ Ver ARCHITECTURE_VISUAL.md
```

---

## 📝 Logs Clave

### FASE 1 Completada
```
FASE 1 RESUMEN:
  ✅ Exitosos: 3/3
```

### FASE 2 Completada
```
FASE 2 RESUMEN:
  ✅ Exitosos: 3
```

### Éxito Total
```
Step 9D RESUMEN FINAL:
  📤 Uploads a CDN:  3/3 exitosos
  🔗 Webhooks:      3 exitosos
```

---

## 🎯 Cambios Importantes

### Qué Cambió
- ✅ Arquitectura: 2 fases desacopladas
- ✅ Timeouts: Eliminados
- ✅ Orden: Webhook siempre es último

### Qué NO Cambió
- ✅ CDN fallback (catbox → 0x0 → tmpfiles)
- ✅ Reintentos automáticos
- ✅ Metadatos del payload

---

## 🚀 Para Empezar

1. **Deploy** los cambios
2. **Verifica** `MAKE_WEBHOOK_URL` en `.env`
3. **Ejecuta** pipeline: `node index.js "test"`
4. **Revisa** logs para "FASE 1" y "FASE 2"
5. **Confirma** webhook se envió exitosamente

---

## 📖 Documentación Completa

- **WEBHOOK_2PHASE_GUIDE.md** ← Guía detallada
- **ARCHITECTURE_VISUAL.md** ← Diagramas ASCII
- **TESTING_CHECKLIST.md** ← Tests exhaustivos
- **REFACTORIZATION_SUMMARY.md** ← Cambios exactos

---

## ⚠️ Método Legacy (DEPRECATED)

```javascript
// ❌ NO USAR (causa timeouts)
await webhookAgent.sendBatchToMake(videos);

// ✅ USAR (nueva arquitectura)
const uploaded = await webhookAgent.uploadVideoBatchToCloudCDN(videos);
const results = await webhookAgent.sendWebhooksForUploadedVideos(uploaded);
```

---

## 💡 Tips

1. **Monitorear logs en tiempo real:** `tail -f logs/output.log`
2. **Buscar FASE2:** `grep "FASE 2" logs.log`
3. **Contar webhooks exitosos:** `grep "HTTP 200" logs.log | wc -l`
4. **Ver CDN usado:** `grep "Subido a" logs.log`

---

