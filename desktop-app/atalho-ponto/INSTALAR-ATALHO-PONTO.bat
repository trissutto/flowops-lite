@echo off
chcp 65001 >nul
title Instalar atalho Bater Ponto Lurd's

REM ============================================================
REM  Cria um atalho "Bater Ponto Lurd's" na area de trabalho.
REM  O atalho abre o Chrome em modo APP (janela limpa, sem
REM  abas/navegador) apontando direto pra tela de bater ponto.
REM  Icone proprio (relogio verde Lurd's).
REM
REM  Depois de criar, basta clicar com botao DIREITO no atalho
REM  na area de trabalho ou na barra de tarefas e escolher
REM  "Fixar na barra de tarefas" pra deixar sempre visivel.
REM
REM  Pre-requisito: Google Chrome instalado.
REM ============================================================

echo.
echo ============================================================
echo   INSTALADOR — Atalho Bater Ponto Lurd's
echo ============================================================
echo.

REM Procura Chrome em locais padrao
set "CHROME="
if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "CHROME=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%PROGRAMFILES%\Google\Chrome\Application\chrome.exe" set "CHROME=%PROGRAMFILES%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%PROGRAMFILES(X86)%\Google\Chrome\Application\chrome.exe" set "CHROME=%PROGRAMFILES(X86)%\Google\Chrome\Application\chrome.exe"

if not defined CHROME (
  echo [ERRO] Google Chrome nao encontrado no sistema.
  echo Instale o Chrome em https://www.google.com/chrome/ e rode esse instalador de novo.
  echo.
  pause
  exit /b 1
)

echo [OK] Chrome encontrado em:
echo      %CHROME%
echo.

REM Copia o icone pra uma pasta permanente do usuario
set "ICON_DEST=%LOCALAPPDATA%\LurdsPonto"
if not exist "%ICON_DEST%" mkdir "%ICON_DEST%"
copy /Y "%~dp0ponto-icon.ico" "%ICON_DEST%\ponto-icon.ico" >nul
if errorlevel 1 (
  echo [ERRO] Nao consegui copiar o icone. Verifique permissoes.
  pause
  exit /b 1
)
echo [OK] Icone copiado pra:
echo      %ICON_DEST%\ponto-icon.ico
echo.

REM URL da tela de bater ponto
set "URL=https://flowops-lite.vercel.app/minha-loja/ponto"

REM Caminho final do atalho (na area de trabalho)
set "SHORTCUT=%USERPROFILE%\Desktop\Bater Ponto Lurds.lnk"

REM Usa PowerShell pra criar o .lnk com icone customizado
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$s = (New-Object -COM WScript.Shell).CreateShortcut('%SHORTCUT%'); ^
   $s.TargetPath = '%CHROME%'; ^
   $s.Arguments = '--app=%URL% --new-window --window-size=900,700'; ^
   $s.IconLocation = '%ICON_DEST%\ponto-icon.ico'; ^
   $s.Description = 'Bater ponto eletronico Lurds (reconhecimento facial)'; ^
   $s.WorkingDirectory = '%USERPROFILE%'; ^
   $s.Save()"

if errorlevel 1 (
  echo [ERRO] Falha ao criar o atalho.
  pause
  exit /b 1
)

echo [OK] Atalho criado em:
echo      %SHORTCUT%
echo.
echo ============================================================
echo   TUDO PRONTO!
echo ============================================================
echo.
echo  Proximos passos:
echo.
echo   1. Va na sua area de trabalho
echo   2. Procure o atalho "Bater Ponto Lurds" (icone de relogio verde)
echo   3. Botao DIREITO no atalho -^> "Fixar na barra de tarefas"
echo   4. Pronto! Agora basta clicar nele que abre direto a tela
echo      de bater ponto com camera + reconhecimento facial
echo.
echo  Dica: voce pode mover o atalho pra qualquer lugar
echo        (start menu, etc) que ele continua funcionando.
echo.
pause
