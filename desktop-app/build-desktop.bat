@echo off
REM Gera o FlowOps-Setup-*.exe pra instalar nas 15 lojas.
REM Requisitos: Node 20+ instalado.

cd /d "%~dp0"

echo [1/3] Instalando dependencias (se faltar)...
if not exist node_modules (
  call npm install
  if errorlevel 1 goto erro
)

echo [2/3] Checando icones...
if not exist build\icon.ico (
  echo AVISO: build\icon.ico nao encontrado. O build vai usar ícone generico.
)

echo [3/3] Gerando instalador Windows...
call npm run build
if errorlevel 1 goto erro

echo.
echo ==========================================================
echo  Instalador gerado em: dist\FlowOps-Setup-1.0.0.exe
echo  Copia pras lojas e instala. Fim.
echo ==========================================================
pause
exit /b 0

:erro
echo.
echo ERRO no build. Veja mensagens acima.
pause
exit /b 1
