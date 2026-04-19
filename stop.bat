@echo off
REM Desliga FlowOps Lite - mata QUALQUER coisa rodando nas portas do backend (3001) e frontend (3000)
chcp 65001 >nul
echo Desligando FlowOps Lite...

REM Tenta primeiro pela janela (caso ainda estejam abertas)
taskkill /FI "WINDOWTITLE eq FlowOps Backend*" /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq FlowOps Frontend*" /F >nul 2>&1

REM Mata qualquer processo escutando em 3000 (frontend)
echo Limpando porta 3000...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000 " ^| findstr LISTENING') do (
    echo   Matando PID %%a na porta 3000
    taskkill /F /PID %%a >nul 2>&1
)

REM Mata qualquer processo escutando em 3001 (backend Nest)
echo Limpando porta 3001...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3001 " ^| findstr LISTENING') do (
    echo   Matando PID %%a na porta 3001
    taskkill /F /PID %%a >nul 2>&1
)

echo.
echo Processos encerrados. Pode rodar start.bat agora.
pause
