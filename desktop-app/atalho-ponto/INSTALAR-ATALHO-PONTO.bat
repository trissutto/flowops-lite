@echo off
chcp 65001 >nul
title Instalar atalho Bater Ponto Lurd's

REM ============================================================
REM  Cria um atalho "Bater Ponto Lurd's" na area de trabalho.
REM  O atalho abre o Chrome em modo APP (janela limpa)
REM  apontando direto pra tela de bater ponto.
REM  Icone proprio (relogio verde Lurd's).
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
  echo [ERRO] Nao consegui copiar o icone.
  pause
  exit /b 1
)
echo [OK] Icone copiado pra:
echo      %ICON_DEST%\ponto-icon.ico
echo.

REM URL da tela de bater ponto
set "URL=https://crm.lurdsplussize.com.br/minha-loja/ponto"
set "SHORTCUT=%USERPROFILE%\Desktop\Bater Ponto Lurds.lnk"

REM Gera um script .ps1 temporario e executa
set "PS1=%TEMP%\lurds-criar-atalho-ponto.ps1"

(
echo $shell = New-Object -COM WScript.Shell
echo $lnk = $shell.CreateShortcut^("%SHORTCUT%"^)
echo $lnk.TargetPath = "%CHROME%"
echo $lnk.Arguments = "--app=%URL% --new-window --window-size=900,700"
echo $lnk.IconLocation = "%ICON_DEST%\ponto-icon.ico"
echo $lnk.Description = "Bater ponto eletronico Lurds (reconhecimento facial)"
echo $lnk.WorkingDirectory = "%USERPROFILE%"
echo $lnk.Save^(^)
) > "%PS1%"

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
set "PS_EXIT=%ERRORLEVEL%"
del "%PS1%" >nul 2>&1

if not %PS_EXIT% == 0 (
  echo [ERRO] Falha ao criar o atalho. PowerShell retornou %PS_EXIT%.
  pause
  exit /b %PS_EXIT%
)

if not exist "%SHORTCUT%" (
  echo [ERRO] Atalho nao foi criado. Verifique permissoes da area de trabalho.
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
pause
