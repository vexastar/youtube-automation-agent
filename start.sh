#!/bin/bash
echo "YouTube Automation Agent - Modo Manual"
echo "============================================"
if [ -z "$1" ]; then
    echo "USO: ./start.sh \"tema del video\""
    echo "Ejemplo: ./start.sh \"3 gadgets para tu cocina\""
    exit 1
fi
echo "Generando video sobre: $*"
node index.js "$@"