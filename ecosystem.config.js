// DESACTIVADO: El agente ahora funciona solo en modo manual.
// Usar: node index.js "tema del video"
// Para reactivar el modo automático, descomentar el bloque de abajo.

/*
module.exports = {
  "apps": [
    {
      "name": "youtube-automation-agent",
      "script": "index.js",
      "instances": 1,
      "autorestart": true,
      "watch": false,
      "max_memory_restart": "1G",
      "env": {
        "NODE_ENV": "production",
        "PORT": 3456
      }
    }
  ]
};
*/

module.exports = { apps: [] };