# Ícones — coloca aqui antes de buildar

Para gerar o `FlowOps-Setup.exe` bonito, cria dois arquivos:

- `icon.ico` — 256x256 (ou multi-resolução). Usado no .exe, atalho, taskbar.
- `icon-tray.png` — 32x32 (Windows 10) ou 64x64 (Windows 11 HiDPI). Usado na bandeja.

## Geração rápida a partir de um PNG de logo

Se tiver um PNG 512x512 do logo FlowOps:

```bash
# converte pra .ico com múltiplas resoluções (precisa de ImageMagick)
magick logo.png -define icon:auto-resize=16,32,48,64,128,256 icon.ico

# cria a versão pequena da tray
magick logo.png -resize 32x32 icon-tray.png
```

## Se não tiver o logo pronto

Usa um ícone provisório (qualquer .ico baixado) pra não travar o build.
O electron-builder não gera .ico automaticamente — se faltar ele cai em fallback
genérico.
