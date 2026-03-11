@echo off
chcp 65001 >nul
echo =============================================
echo   Transcrição Universal - Iniciando...
echo =============================================
echo.

node --version >nul 2>&1
if errorlevel 1 (
    echo [ERRO] Node.js nao encontrado.
    echo.
    echo Instale o Node.js em: https://nodejs.org/
    echo.
    pause
    exit /b 1
)

echo [1/2] Instalando dependencias...
npm install --silent

echo [2/2] Iniciando o servidor...
echo.
echo Acesse no navegador: http://localhost:3000
echo Pressione Ctrl+C para parar.
echo.
node server.js
pause
