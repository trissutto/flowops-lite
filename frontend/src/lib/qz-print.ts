/**
 * QZ TRAY HELPER — impressão direta na ELGIN sem diálogo, sem mudar
 * impressora padrão do Windows.
 *
 * Como funciona:
 *   1. PC do PDV tem QZ Tray instalado (download em qz.io, free).
 *   2. QZ Tray roda em background ouvindo WebSocket em localhost:8181.
 *   3. Frontend carrega o SDK via CDN e conecta.
 *   4. Site escolhe impressora pelo NOME (ex: "ELGIN i9 PRINTER") — salvo
 *      no localStorage por PC.
 *   5. Imprime HTML direto na impressora escolhida, zero diálogo.
 *
 * Setup do PC do PDV (uma vez):
 *   1. Baixa QZ Tray em https://qz.io/download/
 *   2. Instala (next-next-finish), QZ vira tray icon perto do relógio.
 *   3. Vendedora abre /minha-loja/pdv/config-impressora UMA VEZ
 *   4. Escolhe ELGIN da lista, salva.
 *   5. Pronto — cupons NFC-e imprimem auto na ELGIN dali em diante.
 *
 * Modo "unsigned" (default): a primeira conexão de cada origem mostra
 * popup do QZ Tray pedindo permissão. Vendedora marca "lembrar pra essa
 * origem" — fica salvo. Sem certificado/assinatura digital.
 */

// LocalStorage keys
const LS_PRINTER_NAME = 'lurds_qz_printer_name';
const LS_QZ_PORT = 'lurds_qz_port'; // override de porta se quiser

// Singleton da lib (carregada dinamicamente)
let qzInstance: any = null;
let qzLoadingPromise: Promise<any> | null = null;

/**
 * Carrega o SDK do QZ Tray via CDN se ainda não estiver na página.
 * SDK adiciona `window.qz` global.
 */
async function loadQzSdk(): Promise<any> {
  if (typeof window === 'undefined') {
    throw new Error('QZ Tray só funciona no browser');
  }
  if ((window as any).qz) return (window as any).qz;
  if (qzLoadingPromise) return qzLoadingPromise;

  qzLoadingPromise = new Promise<any>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/qz-tray@2.2.4/qz-tray.js';
    script.async = true;
    script.onload = () => {
      const qz = (window as any).qz;
      if (!qz) {
        reject(new Error('QZ Tray SDK carregou mas window.qz não existe'));
        return;
      }
      resolve(qz);
    };
    script.onerror = () => reject(new Error('Falha ao carregar QZ Tray SDK do CDN'));
    document.head.appendChild(script);
  });

  return qzLoadingPromise;
}

/**
 * Conecta no QZ Tray local. Tenta WSS (com SSL) primeiro, fallback WS.
 * Retorna o objeto qz se conectou, ou lança erro.
 */
export async function qzConnect(): Promise<any> {
  const qz = await loadQzSdk();

  if (qz.websocket.isActive()) return qz;

  // Modo unsigned (sem certificado) — vendedora aprova 1x e fica salvo
  qz.security.setCertificatePromise(() => Promise.resolve(''));
  qz.security.setSignatureAlgorithm('SHA512');
  qz.security.setSignaturePromise(() => (resolve: any) => resolve());

  try {
    await qz.websocket.connect({ retries: 1, delay: 1 });
    return qz;
  } catch (e: any) {
    throw new Error(
      `QZ Tray não respondeu. Confira:\n` +
      `1. QZ Tray está instalado? (https://qz.io/download/)\n` +
      `2. QZ Tray está rodando? (ícone perto do relógio)\n` +
      `Erro original: ${e?.message || e}`,
    );
  }
}

/** Lista as impressoras disponíveis no PC. */
export async function qzListPrinters(): Promise<string[]> {
  const qz = await qzConnect();
  const printers = await qz.printers.find();
  // qz.printers.find() retorna string[] (todas as impressoras do sistema)
  return Array.isArray(printers) ? printers : [printers];
}

/** Salva nome da impressora ELGIN no localStorage (por PC). */
export function qzSetPrinter(name: string) {
  try {
    localStorage.setItem(LS_PRINTER_NAME, name);
  } catch { /* ignore */ }
}

/** Lê nome da impressora salva. */
export function qzGetPrinter(): string | null {
  try {
    return localStorage.getItem(LS_PRINTER_NAME);
  } catch {
    return null;
  }
}

/** Apaga config (volta pra fluxo de window.print). */
export function qzClearPrinter() {
  try {
    localStorage.removeItem(LS_PRINTER_NAME);
  } catch { /* ignore */ }
}

/**
 * Imprime HTML na impressora configurada via QZ Tray.
 * Retorna true se imprimiu, false se falhou (caller cai pro fallback).
 */
export async function qzPrintHtml(html: string, opts?: { printer?: string }): Promise<boolean> {
  try {
    const printerName = opts?.printer || qzGetPrinter();
    if (!printerName) return false; // Sem impressora configurada → fallback

    const qz = await qzConnect();
    const config = qz.configs.create(printerName, {
      // 80mm width, scaling auto (cupom térmico)
      size: { width: 3.15, height: null }, // 3.15" ≈ 80mm
      units: 'in',
      margins: 0,
    });
    const data = [{ type: 'html', format: 'plain', data: html }];
    await qz.print(config, data);
    return true;
  } catch (e: any) {
    console.warn('[qz] Falha ao imprimir via QZ Tray:', e?.message || e);
    return false;
  }
}

/**
 * Status rápido — sem efeitos colaterais. Usado em badge "QZ conectado/desconectado"
 * Retorna: 'configured' | 'not-configured' | 'sdk-not-loaded'
 */
export function qzStatus(): {
  configured: boolean;
  printerName: string | null;
  sdkLoaded: boolean;
} {
  return {
    configured: !!qzGetPrinter(),
    printerName: qzGetPrinter(),
    sdkLoaded: typeof window !== 'undefined' && !!(window as any).qz,
  };
}
