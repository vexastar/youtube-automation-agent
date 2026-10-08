@echo off
echo YouTube Automation Agent - Modo Manual
echo ============================================
if "%~1"=="" (
    echo USO: start.bat "tema del video"
    echo Ejemplo: start.bat "3 gadgets para tu cocina"
    pause
    exit /b 1
)
echo Generando video sobre: %*
node index.js %*
pause