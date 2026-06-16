# Atalho "Bater Ponto Lurd's"

Atalho leve pra colocar na **barra de tarefas** do Windows. Quando clicar,
abre direto a tela de bater ponto com a câmera ativa — sem abrir navegador
inteiro com abas etc.

## Pra que serve

Vendedora chega na loja, vê o ícone de **relógio verde Lurd's** na barra de
tarefas (igual ao ícone do `LURDS ORDER ONE`, mas separado). Um clique →
bate o ponto.

## Como instalar (1 minuto)

1. Tenha o **Google Chrome** instalado (se não tiver, baixa em chrome.com)
2. Dê duplo-clique em `INSTALAR-ATALHO-PONTO.bat`
3. O script vai criar um atalho **"Bater Ponto Lurds"** na sua **área de trabalho**
4. **Botão direito no atalho → "Fixar na barra de tarefas"**
5. Pronto! O ícone fica visível sempre

## Como funciona por dentro

- Abre o Chrome em **modo `--app`** (janela limpa, sem barra de URL, sem abas)
- Aponta direto pra `https://flowops-lite.vercel.app/minha-loja/ponto`
- Usa um ícone próprio (`ponto-icon.ico`, copiado pra `%LOCALAPPDATA%\LurdsPonto\`)

## Diferença vs LURDS ORDER ONE (app Electron)

| | Atalho `.lnk` (este) | App Electron `LURDS ORDER ONE` |
|---|---|---|
| Onde fica | Barra de tarefas | Tray (perto do relógio) |
| Custo de setup | 1 minuto (rodar .bat) | 5 min build + instalar Setup |
| Roda em background | Não | Sim (auto-launch + impressão silenciosa) |
| Impressão silenciosa | Não | Sim |
| Cabe nas 15 lojas | ✅ Distribuir o .bat | ✅ Distribuir o Setup.exe |

## Distribuição pras lojas (15 PCs)

Copia a pasta `atalho-ponto/` inteira pro PC de cada loja (pen drive,
network share, OneDrive). A vendedora roda o `.bat` → fixa na barra → fim.

## Desinstalar

1. Apaga o atalho "Bater Ponto Lurds" da área de trabalho/barra de tarefas
2. Apaga a pasta `%LOCALAPPDATA%\LurdsPonto\`
