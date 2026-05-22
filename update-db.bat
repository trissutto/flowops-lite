@echo off
cd /d "%~dp0backend"
echo.
echo  Atualizando banco SQLite...
echo.
call npx prisma generate
call npx prisma db push
echo.
echo Pronto. Agora reinicie o backend:
echo  1. Va na janela FlowOps Backend
echo  2. Aperte Ctrl+C e confirme com S
echo  3. Cole: npm run start:dev
echo.
pause
