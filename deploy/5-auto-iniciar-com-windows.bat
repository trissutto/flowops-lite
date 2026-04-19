@echo off
REM =========================================================================
REM  FlowOps — Auto-iniciar com Windows
REM =========================================================================
REM  Cria atalho do 2-iniciar-flowops.bat na pasta Startup do Windows.
REM  Assim, toda vez que a maquina ligar, o FlowOps sobe sozinho.
REM =========================================================================

title FlowOps - Auto-start
color 0B

set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "TARGET=%~dp02-iniciar-flowops.bat"
set "SHORTCUT=%STARTUP%\FlowOps.lnk"

echo Criando atalho em:
echo   %STARTUP%
echo.

powershell -NoProfile -Command ^
  "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('%SHORTCUT%');" ^
  "$s.TargetPath='%TARGET%';" ^
  "$s.WorkingDirectory='%~dp0';" ^
  "$s.WindowStyle=7;" ^
  "$s.Save()"

if exist "%SHORTCUT%" (
    echo.
    echo OK! FlowOps vai iniciar automaticamente toda vez que a maquina ligar.
    echo.
    echo Pra desativar: apague o arquivo "FlowOps.lnk" desta pasta:
    echo   %STARTUP%
) else (
    echo.
    echo *** Falha ao criar o atalho. Rode como Administrador. ***
)

echo.
pause
