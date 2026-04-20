@echo off
REM ============================================================
REM  FlowOps - Cria um pick-order de TESTE pra uma loja.
REM
REM  Uso:
REM    test-pick-order.bat LJ15
REM    test-pick-order.bat LJ01
REM
REM  Requer:
REM    - Backend URL setada na variavel FLOWOPS_API (ver abaixo)
REM    - PowerShell (vem no Windows)
REM ============================================================
chcp 65001 >nul
setlocal EnableDelayedExpansion
title FlowOps - Teste pick-order

REM >>>>>> AJUSTA AQUI COM A URL DO TEU BACKEND NO RAILWAY <<<<<<
set "FLOWOPS_API=https://flowops-backend-production.up.railway.app"

if "%~1"=="" (
  echo Uso: test-pick-order.bat CODIGO-DA-LOJA
  echo Ex:  test-pick-order.bat LJ15
  pause
  exit /b 1
)
set "STORE_CODE=%~1"

echo.
echo ============================================================
echo   FlowOps - Teste pick-order pra loja %STORE_CODE%
echo ============================================================
echo.
echo Backend: %FLOWOPS_API%
echo.

set /p ADMIN_EMAIL=Email do admin (ex: admin@flowops.local):
set /p ADMIN_PASS=Senha do admin:

echo.
echo [1/2] Fazendo login como admin...

powershell -NoProfile -Command ^
  "$r = Invoke-RestMethod -Method Post -Uri '%FLOWOPS_API%/api/auth/login' -ContentType 'application/json' -Body (@{email='%ADMIN_EMAIL%';password='%ADMIN_PASS%'}|ConvertTo-Json); Set-Content -Path '%TEMP%\flowops_tok.txt' -Value $r.accessToken -NoNewline; Write-Host 'Login OK. Role:' $r.user.role"

if errorlevel 1 (
  echo [ERRO] Login falhou. Confere email/senha/URL do backend.
  pause
  exit /b 1
)

set /p TOKEN=<%TEMP%\flowops_tok.txt

echo.
echo [2/2] Disparando pick-order pra loja %STORE_CODE%...

powershell -NoProfile -Command ^
  "$h = @{Authorization='Bearer %TOKEN%';'Content-Type'='application/json'}; $b = @{storeCode='%STORE_CODE%'} | ConvertTo-Json; $r = Invoke-RestMethod -Method Post -Uri '%FLOWOPS_API%/api/pick-orders/test-create' -Headers $h -Body $b; $r | ConvertTo-Json -Depth 5"

if errorlevel 1 (
  echo.
  echo [ERRO] Falhou ao criar pick-order. Veja a mensagem acima.
  pause
  exit /b 1
)

del /q "%TEMP%\flowops_tok.txt" 2>nul

echo.
echo ============================================================
echo   PRONTO! Pick-order criado.
echo   Agora abre /minha-loja logado como operador da %STORE_CODE%
echo   e veja se o card aparece em tempo real.
echo ============================================================
pause
