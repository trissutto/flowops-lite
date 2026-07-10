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
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');

// Configura logger do auto-updater — vai pra %APPDATA%/lurds-order-one-desktop/logs/main.log
log.transports.file.level = 'info';
autoUpdater.logger = log;
autoUpdater.autoDownload = true;          // baixa em background sem perguntar
autoUpdater.autoInstallOnAppQuit = true;  // instala silenciosamente ao próximo restart

const store = new Store({
  name: 'flowops-config',
  defaults: {
    url: 'https://crm.lurdsplussize.com.br/minha-loja',
    autoLaunch: true,
    silentPrint: true,
    printer: '', // vazio = padrão do Windows
  },
});

// Migração (07/2026): o sistema da equipe mudou pra crm.lurdsplussize.com.br —
// a raiz antiga virou landing pública. Instalações existentes têm a URL velha
// PERSISTIDA na config (default não corrige), então reescrevemos o host aqui.
// Lista explícita de hosts legados pra não atropelar URL custom (ex.: dev local).
const LEGACY_HOSTS = /^https?:\/\/(flowops-lite\.vercel\.app|app-lurds\.vercel\.app|app\.lurds\.com\.br|(www\.)?lurdsplussize\.com\.br)/i;
{
  const saved = String(store.get('url') || '');
  if (LEGACY_HOSTS.test(saved)) {
    const migrated = saved.replace(LEGACY_HOSTS, 'https://crm.lurdsplussize.com.br');
    store.set('url', migrated);
    log.info(`[config] URL migrada pro novo dominio: ${saved} -> ${migrated}`);
  }
}

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

// Assets de build/ (ícones): empacotado ficam em resources/build (extraResources);
// em dev ficam em desktop-app/build.
function buildAssetPath(name) {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'build', name)
    : path.join(__dirname, '..', 'build', name);
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
    icon: buildAssetPath('icon.ico'),
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

  // ❌ NÃO esconder ao minimizar — vendedora aperta minimizar achando que
  // tá só "guardando" e o app some da barra de tarefas. Comportamento esperado:
  // - Minimizar (--) → vai pra barra de tarefas (Windows padrão) ✓
  // - Fechar (X)    → vai pra tray (não encerra) — já tá ok no on('close') acima
  //
  // mainWindow.on('minimize', () => {
  //   mainWindow.hide();
  // });

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

/**
 * Abre/navega pra tela de Bater Ponto. Usado pelo atalho na tray.
 * Se mainWindow já tá em /minha-loja/ponto, só foca. Senão navega.
 */
function openPonto() {
  if (!mainWindow) return;
  const base = (store.get('url') || 'https://crm.lurdsplussize.com.br/minha-loja').replace(
    /\/minha-loja.*$/,
    '/minha-loja',
  );
  const pontoUrl = `${base}/ponto`;
  try {
    const current = mainWindow.webContents.getURL();
    if (!current || !current.includes('/minha-loja/ponto')) {
      mainWindow.loadURL(pontoUrl);
    }
  } catch (e) {
    mainWindow.loadURL(pontoUrl);
  }
  showWindow();
}

// Fallback da tray: mesmo L dourado 32x32 embutido — buffer vazio deixava a tray INVISÍVEL.
const TRAY_FALLBACK_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAEyElEQVR42q2XyWskZRiHv7l2OklXd6297/ve2ZdJJkknMZk4iTpezEGYi9tN78GDHkREBRGUMGBAhUFHZRQjRBhkIAoBGRgYEISACP4PCa/+vurqrq/SbdJMGp5DvVXv83zkUKEYs/3qOaNczxu7jbxx3Mgbp428Qd0Y6UGjN3Adw40Gc/5qWf1KLafv1HP6SSOv09JEgDYXQrS1GKJnnhA44IITbjTQQrN9gGqWD6g5GaDt62FamQrQdM0QmOkT5z6ccKOBFpo8Xslo5WpGO1ma8NPWYpCqWQ03+UNdyZ1Dj70qR+MNtNBEm1XS2m41o9H2epgqGY1TdZLtUDsH+7NOj+VHi1+ntV1WTqvH18b81Jz0UznNhyYZkWqfOPctLxpooYk2K6XU0425AE2UdSqlVAzPULHIXJDW891caKCFJtqsmFT5xXhJ4zedlFuH+mnvRTr85iWB9flUzxCniw+ghSbarJBQ+MVYUaNiUhEopTo8PniV/jl6Q2CrmRFiYrCz6/SihSbaLJ9Q6PpcgEaLGh9wkmeXHu3for9/fU1gcyklhHoFAZyWHy000Wa5uEzrV/00UlApH5cpnzApcDoHevjDNv314JbAjYVk15gzWEh0vGighSbaLBszD9DIq3wA8nZah/n9u5t0fP8FgaevxamYlDmFpHXoDlbQwvKjhSbaLBP10dos3tcKZWM+Ti4mm9gOdPT1Bv158KzAxnz0QkHLZ/nRQhNtlo74aG3GoHpO4QOQjfraD5sH8tFvd5bpj/11gfW5sC3qo5ydmOjIttwALTTRZqmIl56aMaiWlSkd8fJhJiqC5cMv5ujx94sCa7PBduz/ghZwo4EWmmizZNhLq9MGVTMypcJePkw7yES99GBvnB59Oy2wOuO3Bc3n7Dg9cKOBFppos0RIotVpnSppmQ9Ayk5r+f7tBj38akxgZcroGbMHLSw/WmiizeJBiVamdCqnfXwAknbCEqXCEh18WqOjL0cFmhO6GeEh6QzYtbssP1poos1iAQ8tT+H/gI8PQMLCtvTjx1U63GsILI5rZsQRssc4LZ/lRwtNtFnU76HlSbyGvXwA4hbBDvc+rNAvt+sCLz8foZvNAOc5O0smyVBrv+Wz/GihiTaLGMPUnMRr2MsHFrGAyN33SvTzJ9W+SEek9r7djRaaaLOwMUxLExrlExIftPEPU9TGnXeKtP9RpS9SYQ/fhcvuRgtNtFlIH6LFcbyGJQrrwyaGiX3p87cLdO+DUl8kQh6+a/ksP1poos2CmnmAbEyikDZkoncIt/jszRzdfbfYF/HgsOCy/GihiTYLqEO0MKZSJuqhoDpkoolg6a1XEvT+66m+wJ9fcLX8aKGJNvMrg6fzIwof+pVBCgC1O8EL0msfbjTQQhNtZsiDx7Wsl0aLPjLkQTJaD51HwMFFduBGAy000Wa67N71K27aXNBJl91tjEvG7kYLTbSZ7nOXNZ/7pJ6TaGFMIc3nFtCfEKcPDbTQRJt/HWnegR3VO0C1rEQ35jVq5PA6HaJEsAuhc+iyAxeccKOBFprtb0PVO3BFlQZ2FGng5L8bVE55aLYu09XG5QAXnHCjgRaaZ76SFclVViTXruJxHcse16nscdElcQond0su4fP8X52V9tBPLnCXAAAAAElFTkSuQmCC';

// ----------------- Tray -----------------
function createTray() {
  const iconPath = buildAssetPath('icon-tray.png');
  let img;
  try {
    img = nativeImage.createFromPath(iconPath);
    if (img.isEmpty()) throw new Error('icon vazio');
  } catch {
    img = nativeImage.createFromBuffer(Buffer.from(TRAY_FALLBACK_PNG_B64, 'base64'));
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
  tray.on('double-click', () => openPonto());
}

function buildTrayMenu() {
  // Lista impressoras disponíveis (sync fallback se mainWindow não carregou)
  const printers = (() => {
    try {
      if (mainWindow?.webContents?.getPrinters) {
        return mainWindow.webContents.getPrinters();
      }
    } catch {}
    return [];
  })();
  const currentPrinter = store.get('printer') || '';

  const printerSubmenu = [
    {
      label: 'Impressora padrão do Windows',
      type: 'radio',
      checked: currentPrinter === '',
      click: () => {
        store.set('printer', '');
        if (tray) tray.setContextMenu(buildTrayMenu());
      },
    },
    { type: 'separator' },
    ...printers.map((p) => ({
      label: `${p.name}${p.isDefault ? ' (padrão)' : ''}`,
      type: 'radio',
      checked: currentPrinter === p.name,
      click: () => {
        store.set('printer', p.name);
        if (tray) tray.setContextMenu(buildTrayMenu());
      },
    })),
    { type: 'separator' },
    {
      label: 'Imprimir página de teste',
      click: () => testPrint(),
    },
  ];

  return Menu.buildFromTemplate([
    { label: 'Abrir LURDS ORDER ONE', click: () => showWindow() },
    {
      label: '⏰ Bater Ponto (reconhecimento facial)',
      click: () => openPonto(),
    },
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
    {
      label: `Impressora: ${currentPrinter || '(padrão do Windows)'}`,
      submenu: printerSubmenu,
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

// Imprime um cupom de TESTE pra validar que a térmica selecionada tá
// respondendo. Útil na primeira instalação ou ao trocar impressora.
async function testPrint() {
  const printer = store.get('printer');
  const silent = !!store.get('silentPrint');
  const html = `<!doctype html><html><head><meta charset="utf-8">
    <style>
      @page { size: 80mm auto; margin: 3mm 2mm; }
      body { font-family: 'Courier New', monospace; font-size: 11px; padding: 0; margin: 0; }
      .c { width: 72mm; margin: 0 auto; padding: 4mm 3mm; text-align: center; }
      .big { font-size: 18px; font-weight: bold; margin: 8px 0; }
      hr { border: none; border-top: 1px dashed #000; margin: 6px 0; }
    </style></head><body>
    <div class="c">
      <div class="big">LURDS ORDER ONE</div>
      <hr/>
      <div>TESTE DE IMPRESSORA</div>
      <div>${new Date().toLocaleString('pt-BR')}</div>
      <hr/>
      <div>Impressora: ${printer || '(padrão do Windows)'}</div>
      <div>Modo: ${silent ? 'silencioso' : 'com diálogo'}</div>
      <hr/>
      <div>Se você está lendo isso,</div>
      <div>a impressão está funcionando.</div>
      <div>&nbsp;</div>
      <div>&nbsp;</div>
    </div></body></html>`;
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: false } });
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await new Promise((resolve, reject) => {
      win.webContents.print(
        {
          silent,
          printBackground: true,
          deviceName: printer || undefined,
          margins: { marginType: 'none' },
        },
        (success, err) => success ? resolve() : reject(new Error(err || 'print failed')),
      );
    });
    dialog.showMessageBox({
      type: 'info',
      title: 'Teste de impressão',
      message: 'Comando enviado pra impressora!',
      detail: `Impressora: ${printer || '(padrão do Windows)'}\n\nSe nada saiu, verifique:\n1. Impressora ligada e com papel\n2. Driver instalado no Windows\n3. Menu Impressora selecionou a térmica certa`,
    });
  } catch (err) {
    dialog.showErrorBox('Falha no teste de impressão', err.message);
  } finally {
    setTimeout(() => { try { win.destroy(); } catch {} }, 1500);
  }
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
 *
 * Fluxo real:
 *  1. Abre BrowserWindow hidden apontando pra /minha-loja/imprimir/{id}?autoprint=1
 *  2. A página, ao terminar de buscar dados via API, chama
 *     window.electronAPI.notifyPrintReady() (via preload → ipcRenderer.send)
 *  3. Main recebe o evento, chama win.webContents.print() DIRETO (silent, deviceName
 *     da térmica configurada), e destrói a janela quando terminar.
 *  4. Se notifyPrintReady não vier em 8s (página travou, API lenta), imprime mesmo
 *     assim como fallback pra não ficar janela órfã.
 *
 * A URL pode ser relativa ('/minha-loja/imprimir/...') → resolve em cima da URL
 * base configurada no electron-store.
 */
ipcMain.handle('flowops:silent-print-url', async (_evt, inputUrl) => {
  console.log('[silent-print-url] chamado com:', inputUrl);
  if (!inputUrl || typeof inputUrl !== 'string') {
    return { ok: false, error: 'URL vazia' };
  }
  // Resolve URL relativa contra a base configurada
  let absoluteUrl = inputUrl;
  if (inputUrl.startsWith('/')) {
    const base = (store.get('url') || '').replace(/\/minha-loja.*$/, '');
    absoluteUrl = base + inputUrl;
  }
  console.log('[silent-print-url] URL absoluta:', absoluteUrl);

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

  // Prepara listener de "ready" da página — resolve a promise quando a página
  // avisar que terminou de carregar os dados do pick-order.
  let printReadyResolve;
  const printReadyPromise = new Promise((resolve) => { printReadyResolve = resolve; });
  const readyListener = (evt) => {
    if (evt.sender === win.webContents) {
      console.log('[silent-print-url] página sinalizou READY');
      printReadyResolve();
    }
  };
  ipcMain.on('flowops:print-ready', readyListener);

  const cleanup = () => {
    ipcMain.removeListener('flowops:print-ready', readyListener);
    try { win.destroy(); } catch {}
  };

  try {
    await win.loadURL(absoluteUrl);
    console.log('[silent-print-url] URL carregada, esperando READY...');

    // Espera a página terminar de buscar dados (via notifyPrintReady) OU fallback 8s
    await Promise.race([
      printReadyPromise,
      new Promise((resolve) => setTimeout(() => {
        console.warn('[silent-print-url] timeout 8s — imprimindo mesmo assim');
        resolve();
      }, 8000)),
    ]);

    // Pequena folga pra garantir que o DOM renderizou CSS @page / @media print
    await new Promise((resolve) => setTimeout(resolve, 400));

    const printer = store.get('printer');
    const silent = !!store.get('silentPrint');
    console.log(`[silent-print-url] print silent=${silent} printer="${printer || '(padrão)'}"`);

    await new Promise((resolve, reject) => {
      win.webContents.print(
        {
          silent,
          printBackground: true,
          deviceName: printer || undefined,
          margins: { marginType: 'none' },
        },
        (success, errorType) => {
          if (success) { console.log('[silent-print-url] print OK'); resolve(); }
          else { console.error('[silent-print-url] print falhou:', errorType); reject(new Error(errorType || 'print failed')); }
        },
      );
    });

    return { ok: true };
  } catch (err) {
    console.error('[silent-print-url] erro:', err);
    return { ok: false, error: err.message };
  } finally {
    // Atraso pra dar tempo do spooler receber antes de matar a janela
    setTimeout(cleanup, 1500);
  }
});

// Listener do IPC "print-ready" — página /imprimir/[id] chama isso quando
// termina de carregar. NÃO responde (handle), só consome (on).
// O handler de silent-print-url adiciona seu próprio listener específico
// por hidden window; esse aqui é só pra evitar warning de "unhandled event".
ipcMain.on('flowops:print-ready', () => {
  // no-op — listeners específicos por window já tratam
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

// ── Auto-update manual (botão "Atualizar app" no frontend) ──
// Permite vendedora/admin forçar check imediato sem esperar o auto-check de 4h.
let lastUpdateInfo = null; // armazena info do último update-available pra reaproveitar

ipcMain.handle('flowops:get-app-version', () => app.getVersion());

ipcMain.handle('flowops:check-for-updates', async () => {
  if (!app.isPackaged) {
    return {
      hasUpdate: false,
      currentVersion: app.getVersion(),
      version: null,
      error: 'dev mode — auto-update só funciona no app instalado',
    };
  }
  try {
    const result = await autoUpdater.checkForUpdates();
    const updateInfo = result?.updateInfo;
    const current = app.getVersion();
    const remote = updateInfo?.version;
    const hasUpdate = !!remote && remote !== current;
    if (hasUpdate) lastUpdateInfo = updateInfo;
    return {
      hasUpdate,
      currentVersion: current,
      version: remote || null,
      releaseDate: updateInfo?.releaseDate || null,
    };
  } catch (err) {
    log.warn('[updater] check manual falhou:', err?.message || err);
    return {
      hasUpdate: false,
      currentVersion: app.getVersion(),
      version: null,
      error: err?.message || String(err),
    };
  }
});

ipcMain.handle('flowops:quit-and-install', () => {
  if (!app.isPackaged) {
    return { ok: false, error: 'dev mode' };
  }
  // Pequeno delay pra UI mostrar "Reiniciando..." antes do app fechar
  setTimeout(() => {
    isQuitting = true;
    autoUpdater.quitAndInstall(false, true); // silent=false, forceRunAfter=true
  }, 500);
  return { ok: true };
});

ipcMain.handle('flowops:open-external', (_evt, url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url);
  return { ok: true };
});

/**
 * Cria atalho "Bater Ponto Lurds" na área de trabalho com ícone de relógio.
 * - Idempotente: se já existe, não faz nada.
 * - Usa Chrome em modo --app pra abrir janela limpa (sem abas).
 * - Vendedora só precisa pinar na barra de tarefas uma vez.
 *
 * Fluxo:
 *  1. Verifica se Chrome está instalado.
 *  2. Copia o icon-ponto.ico (bundled em extraResources) pra %LOCALAPPDATA%\LurdsPonto.
 *  3. Cria o .lnk via PowerShell COM (WScript.Shell).
 */
function createPontoShortcutIfMissing() {
  try {
    // Idempotência: se já criou nessa instalação, pula
    if (store.get('pontoShortcutCreated')) {
      return;
    }

    const desktop = path.join(require('os').homedir(), 'Desktop');
    const shortcutPath = path.join(desktop, 'Bater Ponto Lurds.lnk');

    // Se já existe (criado manualmente ou em instalação anterior), só marca flag
    if (require('fs').existsSync(shortcutPath)) {
      store.set('pontoShortcutCreated', true);
      log.info('[ponto-shortcut] já existia em ' + shortcutPath);
      return;
    }

    // Acha Chrome
    const candidates = [
      path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
    const chromePath = candidates.find((p) => p && require('fs').existsSync(p));
    if (!chromePath) {
      log.warn('[ponto-shortcut] Chrome não encontrado — atalho não criado');
      return;
    }

    // Copia ícone bundled (build/icon-ponto.ico) pra pasta permanente do user
    const iconSrc = buildAssetPath('icon-ponto.ico');
    const iconDir = path.join(process.env.LOCALAPPDATA || require('os').tmpdir(), 'LurdsPonto');
    const iconDest = path.join(iconDir, 'icon-ponto.ico');

    if (!require('fs').existsSync(iconSrc)) {
      log.warn('[ponto-shortcut] icon-ponto.ico não encontrado em ' + iconSrc);
      return;
    }
    require('fs').mkdirSync(iconDir, { recursive: true });
    require('fs').copyFileSync(iconSrc, iconDest);

    const url = 'https://crm.lurdsplussize.com.br/minha-loja/ponto';

    // Cria .lnk via PowerShell COM
    const psScript = `
$shell = New-Object -COM WScript.Shell
$lnk = $shell.CreateShortcut("${shortcutPath}")
$lnk.TargetPath = "${chromePath}"
$lnk.Arguments = "--app=${url} --new-window --window-size=900,700"
$lnk.IconLocation = "${iconDest}"
$lnk.Description = "Bater ponto eletronico Lurds (reconhecimento facial)"
$lnk.WorkingDirectory = "${require('os').homedir()}"
$lnk.Save()
    `.trim();

    const { execFile } = require('child_process');
    execFile(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
      (err) => {
        if (err) {
          log.error('[ponto-shortcut] PowerShell falhou: ' + err.message);
          return;
        }
        store.set('pontoShortcutCreated', true);
        log.info('[ponto-shortcut] criado em ' + shortcutPath);
      }
    );
  } catch (e) {
    log.error('[ponto-shortcut] erro: ' + (e?.message || e));
  }
}

// ----------------- Lifecycle -----------------
app.whenReady().then(async () => {
  // ⚠ NÃO usar `await session.clearCache()` no caminho crítico — em PCs
  // lentos demora 20-60s e Windows mata o app como "não responsivo".
  // Em vez disso, dispara em BACKGROUND DEPOIS de abrir a janela.
  // Cache desatualizado é mitigado pelo Cache-Control headers abaixo,
  // que SEMPRE pegam HTML fresco da Vercel.
  setTimeout(() => {
    session.defaultSession.clearCache()
      .then(() => console.log('[startup-bg] cache HTTP limpo'))
      .catch((err) => console.warn('[startup-bg] falha clearCache:', err?.message));
  }, 10000); // 10s depois da abertura — UX já estabilizada

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

  // ── AUTO-CRIA ATALHO "BATER PONTO" NA AREA DE TRABALHO ──
  // Roda 1× por instalacao. Cria atalho com icone de relogio verde apontando
  // pra Chrome --app=URL/minha-loja/ponto. Funcionaria so precisa fixar uma
  // vez na barra de tarefas (botao direito → Fixar). Depois fica fixo sempre.
  setTimeout(() => createPontoShortcutIfMissing(), 5000);

  // ── AUTO-UPDATE ──
  // Verifica updates 30s após boot (deixa o app abrir tranquilo primeiro)
  // e a cada 4h enquanto rodando. Pacote baixa em background; instalação
  // só acontece no próximo restart (não interrompe vendedora no meio da venda).
  setTimeout(() => checkForUpdatesQuietly(), 30000);
  setInterval(() => checkForUpdatesQuietly(), 4 * 60 * 60 * 1000);
});

/** Verifica updates silenciosamente. Não bloqueia UI. */
function checkForUpdatesQuietly() {
  if (!app.isPackaged) {
    log.info('[updater] dev mode — pulando check de update');
    return;
  }
  autoUpdater.checkForUpdates().catch((err) => {
    log.warn('[updater] check falhou:', err?.message || err);
  });
}

// Eventos do auto-updater pra log
autoUpdater.on('checking-for-update', () => log.info('[updater] verificando...'));
autoUpdater.on('update-available', (info) => {
  log.info(`[updater] update disponivel: v${info.version}`);
  // Notifica vendedora discretamente no tray (não toast — pode atrapalhar PDV)
  if (tray) {
    tray.setToolTip(`LURDS ORDER ONE — baixando update v${info.version}...`);
  }
});
autoUpdater.on('update-not-available', () => log.info('[updater] sem updates'));
autoUpdater.on('error', (err) => log.error('[updater] erro:', err?.message || err));
autoUpdater.on('download-progress', (progress) => {
  log.info(`[updater] download ${progress.percent.toFixed(0)}% (${(progress.bytesPerSecond/1024).toFixed(0)} KB/s)`);
});
autoUpdater.on('update-downloaded', (info) => {
  log.info(`[updater] update v${info.version} baixado — instala no proximo restart`);
  if (tray) {
    tray.setToolTip(`LURDS ORDER ONE — v${info.version} pronta. Sera instalada no proximo restart.`);
  }
});

app.on('window-all-closed', (e) => {
  // Não encerra: fica vivo na tray
  e.preventDefault?.();
});

app.on('before-quit', () => { isQuitting = true; });
