@echo off
REM Libera portas 3000 (frontend) e 3001 (backend) no Firewall do Windows.
REM Precisa rodar como Administrador (o 1-instalar.bat ja chama com elevacao).

netsh advfirewall firewall delete rule name="FlowOps Frontend 3000" >nul 2>&1
netsh advfirewall firewall delete rule name="FlowOps Backend 3001"  >nul 2>&1

netsh advfirewall firewall add rule name="FlowOps Frontend 3000" dir=in action=allow protocol=TCP localport=3000
netsh advfirewall firewall add rule name="FlowOps Backend 3001"  dir=in action=allow protocol=TCP localport=3001

echo.
echo Regras de firewall adicionadas ^(portas 3000 e 3001^).
timeout /t 3 >nul
