/**
 * Preload — ponte segura entre renderer (/minha-loja) e o main process.
 *
 * Expõe window.electronAPI.* ao contexto da página. Fica em contextBridge
 * pra não vazar Node pro código da web.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,

  // Usado pelo /minha-loja no timer de 5min pra trazer janela de volta
  focusWindow: () => ipcRenderer.invoke('flowops:focus'),

  // Configuração (URL do FlowOps, autoLaunch, silentPrint, printer)
  getConfig: () => ipcRenderer.invoke('flowops:get-config'),
  setConfig: (patch) => ipcRenderer.invoke('flowops:set-config', patch),

  // Impressão silenciosa (térmica 80mm ou padrão da máquina)
  silentPrintHTML: (html) => ipcRenderer.invoke('flowops:silent-print', html),
  // Impressão silenciosa via URL — abre hidden window, carrega a URL, imprime e fecha.
  // Usado pela matriz p/ imprimir cupom remoto na térmica da loja.
  silentPrintUrl: (url) => ipcRenderer.invoke('flowops:silent-print-url', url),
  listPrinters: () => ipcRenderer.invoke('flowops:list-printers'),

  openExternal: (url) => ipcRenderer.invoke('flowops:open-external', url),
});
