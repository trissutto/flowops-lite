# FlowOps Desktop

Wrapper Electron pra rodar o FlowOps (`/minha-loja`) como aplicativo Windows nas
15 lojas da rede. O app:

- Inicia com o Windows (minimizado na bandeja)
- Fica na bandeja do sistema (perto do relógio)
- Imprime silenciosamente na térmica padrão
- Recebe comando `focusWindow()` do backend (via WebSocket) quando chega pedido
  novo e o operador não clicou na notificação em 5min

---

## Pré-requisitos (uma vez só, na máquina do Thiago)

1. Node 20+
2. `cd desktop-app && npm install`
3. Ter um `icon.ico` (256x256) em `build/icon.ico`
   e um `icon-tray.png` (32x32 ou 64x64) em `build/icon-tray.png`
   (se faltar, usa fallback mas fica feio)

---

## Rodar em dev (testando apontando pro frontend local)

```bash
npm run dev
```

Isso abre apontando pra `http://localhost:3000/minha-loja`.

## Rodar apontando pra produção (Vercel)

```bash
npm start
```

A URL fica gravada em `electron-store` (muda pela tray → "Configurar URL").

---

## Gerar o instalador Windows (`FlowOps-Setup-1.0.0.exe`)

```bash
npm run build
```

Saída em `dist/FlowOps-Setup-1.0.0.exe` (NSIS installer).

**Na loja**:
1. Roda o `.exe`, escolhe pasta, marca "Criar atalho no Desktop"
2. Na primeira execução, o app:
   - Registra auto-start
   - Abre janela cheia na `/minha-loja`
   - Operador loga com o user dele (role=store)
3. Fecha a janela → fica na bandeja (perto do relógio)
4. Chegou pedido → popup + se ninguém clicar em 5min, janela restaura sozinha

---

## Tray menu (clique direito no ícone)

- **Abrir FlowOps** — traz janela de volta
- **Iniciar com o Windows** — toggle (default ON)
- **Impressão silenciosa** — toggle (default ON)
- **Configurar URL...** — troca URL caso o front mude de dominio
- **Recarregar página** — F5
- **Abrir DevTools** — debug (Ctrl+Shift+I também funciona)
- **Sair do FlowOps** — encerra de vez (Windows não reabre até próximo boot)

---

## IPC disponível pro renderer (`/minha-loja/page.tsx`)

```js
window.electronAPI.isElectron            // true (em Electron), undefined (browser)
window.electronAPI.focusWindow()         // traz janela pra frente
window.electronAPI.getConfig()           // { url, autoLaunch, silentPrint, printer }
window.electronAPI.setConfig({ ... })    // persiste patch
window.electronAPI.silentPrintHTML(html) // imprime em janela offscreen
window.electronAPI.listPrinters()        // lista impressoras do Windows
window.electronAPI.openExternal(url)     // abre no browser do sistema
```

O `/minha-loja` já chama `electronAPI.focusWindow()` no timer de 5min
(se estiver rodando no browser puro, o chamado é no-op).

---

## Estrutura

```
desktop-app/
├── package.json           # electron-builder config
├── src/
│   ├── main.js            # main process (tray, window, IPC, auto-launch)
│   └── preload.js         # ponte segura contextBridge
├── build/
│   ├── icon.ico           # ícone do app (256x256)
│   └── icon-tray.png      # ícone da bandeja (32x32)
└── dist/                  # gerado pelo electron-builder
```

---

## Troubleshooting

- **App não aparece na bandeja após boot** → `openAsHidden:true` é por design.
  Clica no ícone da bandeja (pode estar agrupado em "^" no Windows 11).
- **Imprime mas em PDF/OneNote** → vai na tray → desmarca "Impressão silenciosa",
  clica "Imprimir" no pedido e seleciona a térmica manualmente. Ou configura
  a térmica como impressora padrão no Windows.
- **Não conecta no backend** → tray → "Configurar URL..." confere se bate com
  o domínio do Vercel.
- **Operador quer sair da conta** → Botão "Sair" dentro do header do /minha-loja.
  Pra reabrir a janela depois de fechar: clica no ícone da bandeja.
