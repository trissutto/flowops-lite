@echo off
REM Gera o LURDS-ORDER-ONE-Setup-*.exe pra instalar nas lojas.
REM Requisitos: Node 20+ instalado.

cd /d "%~dp0"

echo [1/4] Limpando dist antiga (se existir)...
if exist dist (
  rmdir /s /q dist
)

echo [2/4] Instalando dependencias (se faltar)...
if not exist node_modules (
  call npm install
  if errorlevel 1 goto erro
)

echo [3/4] Checando icones...
if not exist build\icon.ico (
  echo AVISO: build\icon.ico nao encontrado. O build vai usar icone generico.
)

echo [4/4] Gerando instalador Windows...
call npm run build
if errorlevel 1 goto erro

echo.
echo ==========================================================
echo  Instalador gerado em: dist\LURDS-ORDER-ONE-Setup-1.0.0.exe
echo  Copia pras lojas e instala. Fim.
echo ==========================================================
explorer dist
pause
exit /b 0

:erro
echo.
echo ERRO no build. Veja mensagens acima.
pause
exit /b 1
