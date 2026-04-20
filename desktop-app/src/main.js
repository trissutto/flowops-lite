/**
 * LURDS ORDER ONE Desktop — main process.
 *
 * O que faz:
 *  - Abre BrowserWindow apontando pra URL do sistema (Vercel) na tela /minha-loja
 *  - Cria tray icon perto do relógio (clicar abre/restaura janela)
 *  - Auto-start com Windows (registra em Run on login)
 *  - Impressão silenciosa (silent print) na térmica padrão da máquina
 *  - IPC: focusWindow, silentPrintHTML, getConfig, setConfig
 *  - Persiste URL configurada via electron-store
 *
 * Comportamento de fechar:
 *  - Botão X minimiza pra tray (não encerra). Sair só pelo menu da tray ou Quit explícito.
 *  - Auto-restore quando o backend manda pick-order:new (via timer no /minha-loja chamando focusWindow)
 */

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, dialog, shell, session } = require('electron');
const path = require('path');
const Store = require('electron-store');

const store = new Store({
  name: 'flowops-config',
  defaults: {
    url: 'https://flowops-lite.vercel.app/minha-loja',
    autoLaunch: true,
    silentPrint: true,
    printer: '', // vazio = padrão do Windows
  },
});

let mainWindow = null;
let tray = null;
let isQuitting = false;

// Argumentos CLI: --app-url=http://... (ou --flowops-url= legado)
function parseUrlArg() {
  for (const a of process.argv) {
    if (a.startsWith('--app-url=')) return a.slice('--app-url='.length);
    if (a.startsWith('--flowops-url=')) return a.slice('--flowops-url='.length);
  }
  return null;
}

// ----------------- Single-instance lock -----------------
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Se já tem instância rodando, traz a janela pra frente
    showWindow();
  });
}

// ----------------- Auto-launch (Windows) -----------------
function applyAutoLaunch(enabled) {
  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      openAsHidden: true, // sobe minimizado pra tray (não rouba foco no boot)
      path: process.execPath,
      args: ['--hidden'],
    });
  } catch (err) {
    console.error('Falha ao configurar auto-launch:', err);
  }
}

// ----------------- Janela principal -----------------
function createWindow() {
  const url = parseUrlArg() || store.get('url');
  const startHidden = process.argv.includes('--hidden');

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 360,
    minHeight: 600,
    show: !startHidden,
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    title: 'LURDS ORDER ONE',
    backgroundColor: '#0f172a',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.setMenu(null);
  mainWindow.loadURL(url);

  // Botão X → minimiza pra tray ao invés de encerrar
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('minimize', () => {
    // Em vez de só minimizar pra taskbar, esconde (vai pra tray)
    mainWindow.hide();
  });

  // Atalhos de debug (opcional)
  mainWindow.webContents.on('before-input-event', (_e, input) => {
    if (input.control && input.shift && input.key.toLowerCase() === 'i') {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
    if (input.key === 'F5') {
      mainWindow.webContents.reload();
    }
  });
}

function showWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
  mainWindow.setAlwaysOnTop(true);
  setTimeout(() => mainWindow && mainWindow.setAlwaysOnTop(false), 800);
}

// ----------------- Tray -----------------
function createTray() {
  const iconPath = path.join(__dirname, '..', 'build', 'icon-tray.png');
  let img;
  try {
    img = nativeImage.createFromPath(iconPath);
    if (img.isEmpty()) throw new Error('icon vazio');
  } catch {
    // Fallback: ícone gerado em runtime (quadrado azul com F)
    img = nativeImage.createFromBuffer(Buffer.alloc(0));
  }
  tray = new Tray(img);
  tray.setToolTip('LURDS ORDER ONE — Pedidos da loja');
  tray.setContextMenu(buildTrayMenu());

  tray.on('click', () => {
    if (mainWindow && mainWindow.isVisible() && mainWindow.isFocused()) {
      mainWindow.hide();
    } else {
      showWindow();
    }
  });
  tray.on('double-click', () => showWindow());
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Abrir LURDS ORDER ONE', click: () => showWindow() },
    { type: 'separator' },
    {
      label: 'Iniciar com o Windows',
      type: 'checkbox',
      checked: !!store.get('autoLaunch'),
      click: (item) => {
        store.set('autoLaunch', item.checked);
        applyAutoLaunch(item.checked);
      },
    },
    {
      label: 'Impressão silenciosa',
      type: 'checkbox',
      checked: !!store.get('silentPrint'),
      click: (item) => store.set('silentPrint', item.checked),
    },
    { type: 'separator' },
    {
      label: 'Configurar URL...',
      click: async () => {
        const current = store.get('url');
        const { response, checkboxChecked } = await dialog.showMessageBox({
          type: 'info',
          message: 'URL atual do LURDS ORDER ONE:',
          detail: current,
          buttons: ['Trocar URL', 'Manter'],
          defaultId: 1,
          cancelId: 1,
        });
        if (response === 0) {
          // showMessageBox não aceita input; abrimos uma janela leve com prompt
          promptUrl(current).then((novaUrl) => {
            if (novaUrl && novaUrl !== current) {
              store.set('url', novaUrl);
              if (mainWindow) mainWindow.loadURL(novaUrl);
            }
          });
        }
      },
    },
    {
      label: 'Recarregar página',
      click: () => mainWindow && mainWindow.webContents.reload(),
    },
    {
      label: 'Abrir DevTools',
      click: () => mainWindow && mainWindow.webContents.openDevTools({ mode: 'detach' }),
    },
    { type: 'separator' },
    {
      label: 'Sair do LURDS ORDER ONE',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
}

// Prompt simples via janela transitória (Electron não tem dialog.prompt nativo)
function promptUrl(currentUrl) {
  return new Promise((resolve) => {
    const w = new BrowserWindow({
      width: 520,
      height: 200,
      modal: true,
      parent: mainWindow,
      resizable: false,
      minimizable: false,
      maximizable: false,
      title: 'URL do LURDS ORDER ONE',
      webPreferences: { contextIsolation: true, sandbox: false },
    });
    const html = `
      <!doctype html><html><head><meta charset="utf-8"><style>
        body{font-family:Segoe UI,Arial;padding:16px;background:#f8fafc;color:#0f172a}
        input{width:100%;padding:8px;font-size:14px;border:1px solid #cbd5e1;border-radius:4px;margin:8px 0}
        button{padding:8px 14px;border:none;border-radius:4px;cursor:pointer;font-weight:600}
        .ok{background:#0f172a;color:#fff}.cancel{background:#e2e8f0;color:#0f172a;margin-right:8px}
      </style></head><body>
        <label>Digite a URL do LURDS ORDER ONE:</label>
        <input id="u" value="${(currentUrl || '').replace(/"/g, '&quot;')}" autofocus />
        <div style="text-align:right;margin-top:8px">
          <button class="cancel" onclick="window.close()">Cancelar</button>
          <button class="ok" onclick="document.title='::OK::'+document.getElementById('u').value;window.close()">OK</button>
        </div>
      </body></html>`;
    w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    let result = null;
    w.on('page-title-updated', (_e, title) => {
      if (title.startsWith('::OK::')) result = title.slice('::OK::'.length);
    });
    w.on('closed', () => resolve(result));
  });
}

// ----------------- IPC -----------------
ipcMain.handle('flowops:focus', () => {
  showWindow();
  return { ok: true };
});

ipcMain.handle('flowops:get-config', () => ({
  url: store.get('url'),
  autoLaunch: !!store.get('autoLaunch'),
  silentPrint: !!store.get('silentPrint'),
  printer: store.get('printer') || '',
}));

ipcMain.handle('flowops:set-config', (_evt, patch = {}) => {
  if (typeof patch.url === 'string') store.set('url', patch.url);
  if (typeof patch.autoLaunch === 'boolean') {
    store.set('autoLaunch', patch.autoLaunch);
    applyAutoLaunch(patch.autoLaunch);
  }
  if (typeof patch.silentPrint === 'boolean') store.set('silentPrint', patch.silentPrint);
  if (typeof patch.printer === 'string') store.set('printer', patch.printer);
  return { ok: true };
});

/**
 * Imprime HTML em uma janela offscreen e dispara silent print na térmica padrão.
 * Renderer pode chamar: window.electronAPI.silentPrintHTML('<html>...</html>')
 */
ipcMain.handle('flowops:silent-print', async (_evt, html) => {
  if (!html || typeof html !== 'string') {
    return { ok: false, error: 'HTML vazio' };
  }
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: false },
  });
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    const printer = store.get('printer');
    const silent = !!store.get('silentPrint');
    await new Promise((resolve, reject) => {
      win.webContents.print(
        {
          silent,
          printBackground: true,
          deviceName: printer || undefined,
          margins: { marginType: 'none' },
        },
        (success, errorType) => {
          if (success) resolve();
          else reject(new Error(errorType || 'print failed'));
        },
      );
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    setTimeout(() => { try { win.destroy(); } catch {} }, 1000);
  }
});

/**
 * Impressão silenciosa VIA URL — usado quando a matriz dispara impressão remota.
 * Abre hidden BrowserWindow, carrega a URL, espera a página sinalizar pronto
 * (ou timeout de 6s), imprime silenciosamente e destrói a janela.
 *
 * A URL pode ser relativa ('/minha-loja/imprimir/...') → resolve em cima da URL
 * base configurada no electron-store.
 */
ipcMain.handle('flowops:silent-print-url', async (_evt, inputUrl) => {
  if (!inputUrl || typeof inputUrl !== 'string') {
    return { ok: false, error: 'URL vazia' };
  }
  // Resolve URL relativa contra a base configurada
  let absoluteUrl = inputUrl;
  if (inputUrl.startsWith('/')) {
    const base = (store.get('url') || '').replace(/\/minha-loja.*$/, '');
    absoluteUrl = base + inputUrl;
  }
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Compartilha sessão com a janela principal → localStorage (JWT) disponível
      partition: 'persist:default',
    },
  });
  try {
    await win.loadURL(absoluteUrl);
    // Espera a página terminar de hidratar + renderizar dados fetchados.
    // A página imprimir/[id] já chama window.electronAPI.silentPrintHTML() sozinha
    // quando tem ?autoprint=1 — então NÃO imprimimos aqui, só deixamos a página fazer.
    // Só usamos esse handler pra: abrir invisível + garantir que fecha.
    // Timeout de segurança pra garantir que não fica janela órfã.
    await new Promise((resolve) => setTimeout(resolve, 6000));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    try { win.destroy(); } catch {}
  }
});

ipcMain.handle('flowops:list-printers', async () => {
  if (!mainWindow) return [];
  try {
    const printers = await mainWindow.webContents.getPrintersAsync();
    return printers.map((p) => ({ name: p.name, isDefault: p.isDefault, status: p.status }));
  } catch {
    return [];
  }
});

ipcMain.handle('flowops:open-external', (_evt, url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url);
  return { ok: true };
});

// ----------------- Lifecycle -----------------
app.whenReady().then(async () => {
  // Limpa cache HTTP no startup pra evitar ChunkLoadError quando a Vercel
  // faz redeploy (HTML cacheado pede chunks JS antigos que viraram 404).
  // Faz isso só na 1ª inicialização — não atrasa muito o boot.
  try {
    await session.defaultSession.clearCache();
    console.log('[startup] cache HTTP limpo');
  } catch (err) {
    console.warn('[startup] falha ao limpar cache:', err.message);
  }

  // Defesa extra: intercepta requests HTML e adiciona Cache-Control: no-store.
  // Isso garante que o HTML do Next sempre vem fresco, mas mantém cache
  // pros chunks JS/CSS (que tem hash no nome — cache safe).
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const isHtmlNav = details.resourceType === 'mainFrame' || details.resourceType === 'subFrame';
    const headers = { ...details.requestHeaders };
    if (isHtmlNav) {
      headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
      headers['Pragma'] = 'no-cache';
    }
    callback({ requestHeaders: headers });
  });

  applyAutoLaunch(!!store.get('autoLaunch'));
  createWindow();
  createTray();
});

app.on('window-all-closed', (e) => {
  // Não encerra: fica vivo na tray
  e.preventDefault?.();
});

app.on('before-quit', () => { isQuitting = true; });
