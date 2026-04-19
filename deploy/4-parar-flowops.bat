@echo off
REM Mata qualquer processo escutando nas portas 3000 e 3001.
title FlowOps - Parando
color 0C

echo Parando FlowOps...

for %%P in (3000 3001) do (
    for /f "tokens=5" %%A in ('netstat -ano ^| findstr /R ":%%P .*LISTENING"') do (
        echo  - matando PID %%A ^(porta %%P^)
        taskkill /F /PID %%A >nul 2>&1
    )
)

echo.
echo FlowOps parado.
timeout /t 3 >nul
