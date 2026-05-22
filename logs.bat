@echo off
REM Mostra logs em tempo real do backend (Ctrl+C para sair)
cd /d "%~dp0"
docker compose logs -f backend
