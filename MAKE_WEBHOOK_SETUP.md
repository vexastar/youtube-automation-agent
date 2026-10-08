═══════════════════════════════════════════════════════════════════════════════
SETUP MAKE.COM WEBHOOK - GUÍA RÁPIDA
═══════════════════════════════════════════════════════════════════════════════

✅ ARCHIVOS CREADOS/ACTUALIZADOS:
─────────────────────────────────────────────────────────────────────────────

1. agents/webhook-distribution-agent.js (NUEVO)
   └─ Clase WebhookDistributionAgent con métodos:
      • sendToMakeWebhook(videoPath, metadata)
      • sendBatchToMake(videos)

2. index.js (ACTUALIZADO)
   └─ Importación de WebhookDistributionAgent (línea ~22)
   └─ Step 9D: Distribución a Make.com (después de Step 9C, ~760-830)
   └─ Incluye: Short principal + Product Shorts

3. .env.example (ACTUALIZADO)
   └─ Agregada: MAKE_WEBHOOK_URL=https://hook.make.com/your-webhook-id-here


═══════════════════════════════════════════════════════════════════════════════
PASO 1: VERIFICAR DEPENDENCIAS
═══════════════════════════════════════════════════════════════════════════════

✅ axios y form-data YA ESTÁN INSTALADOS en package.json

NO necesitas hacer npm install. Las librerías que usa el WebhookDistributionAgent:
  • axios ^1.6.0 ✅ (instalado)
  • form-data ^4.0.4 ✅ (instalado)
  • fs (built-in Node.js)
  • path (built-in Node.js)

Para confirmar:
  npm list axios form-data


═══════════════════════════════════════════════════════════════════════════════
PASO 2: OBTENER URL DEL WEBHOOK EN MAKE.COM
═══════════════════════════════════════════════════════════════════════════════

1. Ve a https://www.make.com (o https://www.integromat.com si es la versión antigua)
2. Inicia sesión o crea una cuenta FREE
3. Haz clic en "Create a new scenario"
4. En el lienzo vacío, haz clic para añadir módulo
5. Busca "Webhooks" y selecciona "Webhooks" (como trigger)
6. Haz clic en "Add"
7. Se abrirá un panel. Haz clic en "Add a webhook"
8. COPIA la URL que aparece. Debe verse así:
   https://hook.make.com/abcd1234efgh5678ijkl9012mnop3456

Guarda esta URL, la necesitarás.


═══════════════════════════════════════════════════════════════════════════════
PASO 3: CONFIGURAR .env
═══════════════════════════════════════════════════════════════════════════════

Abre tu archivo .env en la raíz del proyecto y añade:

MAKE_WEBHOOK_URL=https://hook.make.com/abcd1234efgh5678ijkl9012mnop3456

Reemplaza abcd1234... con tu URL real de Make.com


═══════════════════════════════════════════════════════════════════════════════
PASO 4: CONFIGURAR SCENARIO EN MAKE.COM (EJEMPLO BÁSICO)
═══════════════════════════════════════════════════════════════════════════════

En Make.com, después de crear el webhook, tienes 2 opciones:

OPCIÓN A: SOLO RECIBIR Y GUARDAR (TESTING)
──────────────────────────────────────────
Webhooks → Google Drive (guardar video) → Slack (notificar)

Pasos:
1. Webhooks (ya hecho) ← Recibe video + metadata
2. Añade módulo "Google Drive" → "Upload a File"
   └─ Mapea el campo "video" (binario) del webhook
   └─ Nombre: {title}_{timestamp}
3. Añade módulo "Slack" → "Send a Message"
   └─ Canal: #videos
   └─ Mensaje: "✅ Video {title} guardado en Drive"
4. Haz clic en "Turn on"


OPCIÓN B: DISTRIBUIR A REDES SOCIALES (RECOMENDADO)
────────────────────────────────────────────────────
Webhooks → TikTok + Instagram + Facebook (automático)

Pasos:
1. Webhooks (ya hecho) ← Recibe video + metadata
2. Conecta tus cuentas de:
   • TikTok (Make.com → TikTok Connector)
   • Instagram (Make.com → Instagram Connector)
   • Facebook (Make.com → Facebook Connector)
3. Añade módulo "TikTok" → "Upload Video"
   └─ Mapea video (field "video")
   └─ Descripción: {description}
   └─ Hashtags: {hashtags}
4. Duplica para Instagram y Facebook
5. Haz clic en "Turn on"


═══════════════════════════════════════════════════════════════════════════════
PASO 5: ESTRUCTURA DE DATOS DEL WEBHOOK
═══════════════════════════════════════════════════════════════════════════════

El webhook recibe automáticamente en formato multipart/form-data:

{
  "video": "<binary file stream>",
  "title": "Top 5 Gadgets Gaming - Intro",
  "description": "Descubre los 5 gadgets gaming más novedosos del 2026...",
  "hashtags": "#gadgets #gaming #tecnologia #products",
  "source": "youtube-automation-agent",
  "timestamp": "2026-07-16T14:32:10.456Z"
}

En Make.com, usa Variables para acceder:
  • {{data.title}}
  • {{data.description}}
  • {{data.hashtags}}
  • {{data.video}}


═══════════════════════════════════════════════════════════════════════════════
PASO 6: TEST END-TO-END
═══════════════════════════════════════════════════════════════════════════════

1. Asegúrate de que:
   ✅ MAKE_WEBHOOK_URL está en .env
   ✅ El scenario en Make.com está "On" (activado)
   ✅ Tus credenciales de redes sociales están conectadas en Make.com

2. Ejecuta:
   node index.js "5 gadgets para tu oficina"

3. Observa los logs. Busca:
   ════════════════════════════════════════════════════════════
   Step 9D: Distribuyendo videos a Make.com...
   
   📤 Enviando a Make.com:
      Video: intro_short.mp4 (2.34 MB)
      Título: Top 5 gadgets para tu oficina - Intro
   
   ✅ Video enviado a Make.com: HTTP 200
   
   📊 RESUMEN BATCH MAKE.COM:
      ✅ Exitosos: 1
      📤 Total: 1 videos procesados

4. Verifica en tus cuentas de redes sociales (TikTok, Instagram, Facebook).
   El video debe aparecer en las próximas 5-15 minutos.


═══════════════════════════════════════════════════════════════════════════════
TROUBLESHOOTING
═══════════════════════════════════════════════════════════════════════════════

❌ "MAKE_WEBHOOK_URL no configurada"
   → Verifica que está en .env y que contiene la URL completa (no vacío)

❌ "Error enviando a Make.com: ECONNREFUSED"
   → La URL del webhook es inaccesible. Verifica que:
      1. Copiaste la URL correctamente desde Make.com
      2. El scenario en Make.com está "On"
      3. Tu conexión a internet funciona

❌ "Error enviando a Make.com: ETIMEDOUT"
   → El webhook tardó más de 120 segundos en responder.
      • Esto es normal si Make.com está procesando. Reintenta.
      • Aumenta timeout en webhookDistributionAgent.js línea ~85

❌ "Video no aparece en TikTok/Instagram/Facebook"
   → Verifica en Make.com:
      1. El scenario ejecutó sin errores (Execution history)
      2. Las conexiones a TikTok/Instagram/Facebook tienen permisos
      3. La cuenta destino acepta videos con esas características

✅ "Logs muestran HTTP 200 pero video no aparece en redes"
   → Make.com recibió el video pero aún lo está procesando.
   → Espera 5-15 minutos. Revisa la bandeja de entrada de Make.com (ejecuciones).


═══════════════════════════════════════════════════════════════════════════════
MONITOREO Y LOGGING
═══════════════════════════════════════════════════════════════════════════════

Los logs del WebhookDistributionAgent incluyen:
  ✅ Videos exitosos: "[WebhookDistributionAgent] ✅ Video enviado"
  ⚠️  Advertencias: "[WebhookDistributionAgent] ⚠️ Error enviando"
  📊 Resumen batch: "[WebhookDistributionAgent] 📊 RESUMEN BATCH MAKE.COM"

Puedes amplificar logs cambiando LOG_LEVEL en .env:
  LOG_LEVEL=debug  ← Muy detallado (útil para troubleshooting)
  LOG_LEVEL=info   ← Normal (recomendado)
  LOG_LEVEL=warn   ← Solo warnings y errores


═══════════════════════════════════════════════════════════════════════════════
COSTOS Y LÍMITES
═══════════════════════════════════════════════════════════════════════════════

Make.com (FREE PLAN):
  • Hasta 1,000 operaciones/mes
  • Cada video = 1 operación (webhook) + N operaciones (1 por red social)
  • 1 video → 4 operaciones (webhook + TikTok + Instagram + Facebook)
  
Estimación:
  • 1 video/día × 30 días = 120 videos
  • 120 videos × 4 operaciones = 480 operaciones ✅ Cabe en FREE

Si necesitas más, actualiza a PREMIUM ($9.99/mes).


═══════════════════════════════════════════════════════════════════════════════
CÓDIGOS DE REFERENCIA
═══════════════════════════════════════════════════════════════════════════════

Ubicaciones de archivos:
  • agents/webhook-distribution-agent.js (línea 1-150)
  • index.js → Step 9D (línea ~760-830)
  • .env.example (línea final)

Métodos disponibles:
  • new WebhookDistributionAgent()
  • webhookAgent.initialize()
  • webhookAgent.sendToMakeWebhook(videoPath, metadata)
  • webhookAgent.sendBatchToMake(videos)

Respuesta de éxito:
  {
    status: 'success',
    webhookStatus: 200,
    videoName: 'intro_short.mp4',
    fileSizeMB: '2.34'
  }

Respuesta de error:
  {
    status: 'failed',
    error: 'Error message',
    videoName: 'intro_short.mp4',
    errorCode: 'ETIMEDOUT'
  }


═══════════════════════════════════════════════════════════════════════════════
¿NECESITAS AYUDA?
═══════════════════════════════════════════════════════════════════════════════

1. Revisa los logs en la terminal (buscando [WebhookDistributionAgent])
2. Comprueba que MAKE_WEBHOOK_URL tiene la URL completa
3. Verifica que el scenario en Make.com está "On"
4. Intenta con el modo de testing (Google Drive + Slack) para simplificar
5. Aumenta LOG_LEVEL=debug en .env para más detalles

═══════════════════════════════════════════════════════════════════════════════
