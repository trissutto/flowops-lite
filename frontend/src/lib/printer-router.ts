/**
 * printer-router.ts — Roteamento centralizado de impressão por TIPO de documento.
 *
 * O PDV emite vários tipos de impresso (cupom térmico, DANFE NFC-e, carnê A4,
 * vale-troca, etc). Cada um costuma ir pra uma impressora diferente:
 *   - TERMICA 80mm (ELGIN i9, MP-4200, etc) → cupom, NFC-e DANFE, vale, sangria
 *   - A4 LASER (HP, Brother)                → carnê de crediário (papel azul)
 *
 * Este helper:
 *   1. Carrega config do localStorage (printer pra TERMICA, printer pra A4)
 *   2. Antes de cada print, seta a impressora ativa no Electron (electron-store)
 *   3. Dispara silentPrintUrl
 *   4. Fallback: se não for Electron, abre popup com window.print()
 *
 * Config é POR PC (cada caixa tem suas impressoras). Ainda salvo o storeCode
 * pra UI mostrar a qual loja a config pertence.
 *
 * Uso típico:
 *   import { routePrint } from '@/lib/printer-router';
 *   routePrint({ kind: 'cupom', url: '/minha-loja/pdv/recibo/abc?autoprint=1' });
 */

import { getAuthToken } from './api';

export type PrinterKind = 'cupom' | 'nfce' | 'vale' | 'sangria' | 'recibo_pix' | 'carne';

/**
 * Mapa: cada KIND vai pra um PROFILE de impressora (termica ou a4).
 * Mexer aqui pra rotear novo tipo de impresso.
 */
const KIND_TO_PROFILE: Record<PrinterKind, 'termica' | 'a4'> = {
  cupom: 'termica',         // Cupom não-fiscal (PIX/Dinheiro 2 vias)
  nfce: 'termica',          // DANFE NFC-e 80mm
  vale: 'termica',          // Vale-troca
  sangria: 'termica',       // Comprovante sangria/suprimento
  recibo_pix: 'termica',    // Recibo PIX-link crediário pago
  carne: 'a4',              // Carnê de crediário (folhas azul/branca)
};

const LS_KEYS = {
  termica: 'flowops_printer_termica',
  a4: 'flowops_printer_a4',
} as const;

export type PrinterConfig = {
  termica: string | null;   // deviceName escolhido pra cupons térmicos
  a4: string | null;        // deviceName escolhido pra carnê A4
};

/** Lê config salva localmente */
export function loadPrinterConfig(): PrinterConfig {
  if (typeof window === 'undefined') return { termica: null, a4: null };
  return {
    termica: localStorage.getItem(LS_KEYS.termica) || null,
    a4: localStorage.getItem(LS_KEYS.a4) || null,
  };
}

/** Salva escolha de impressora pra um profile */
export function savePrinterChoice(profile: 'termica' | 'a4', deviceName: string | null) {
  if (typeof window === 'undefined') return;
  if (deviceName) localStorage.setItem(LS_KEYS[profile], deviceName);
  else localStorage.removeItem(LS_KEYS[profile]);
}

/**
 * Lista impressoras instaladas. Só funciona no Electron (PC com app desktop).
 * Browser puro retorna array vazio — a vendedora escolhe no diálogo do Chrome.
 */
export async function listAvailablePrinters(): Promise<Array<{ name: string; isDefault?: boolean; displayName?: string }>> {
  if (typeof window === 'undefined') return [];
  const electron = (window as any).electronAPI;
  if (!electron?.listPrinters) return [];
  try {
    const list = await electron.listPrinters();
    return Array.isArray(list) ? list : [];
  } catch (e) {
    console.warn('[printer-router] listPrinters falhou:', e);
    return [];
  }
}

/** Detecta se está rodando dentro do Electron (PC desktop) */
export function isElectron(): boolean {
  if (typeof window === 'undefined') return false;
  // App ANTIGO instalado na loja pode não expor a flag isElectron (preload
  // velho), mas já ter alguma API de impressão — conta como app mesmo assim.
  // Caso real (Suzano PDV-17, 10/07): app antigo caía no ramo "Chrome puro"
  // e a NFC-e não saía na emissão.
  const api = (window as any).electronAPI;
  return !!(api && (api.isElectron || api.silentPrintUrl || api.silentPrintHTML || api.notifyPrintReady));
}

/**
 * Imprime via printer roteada pelo KIND.
 * - Electron: seta impressora ativa via setConfig({printer}) + chama silentPrintUrl
 * - Browser puro: abre popup que dispara window.print() (Chrome lembra escolha)
 *
 * Retorna { ok: boolean, mode: 'electron-silent' | 'iframe' | 'popup', error?: string }
 */
export async function routePrint(input: {
  kind: PrinterKind;
  url: string;
  /** Se true e não tiver impressora configurada pro profile, mostra alerta */
  warnIfMissing?: boolean;
}): Promise<{ ok: boolean; mode: string; error?: string }> {
  const profile = KIND_TO_PROFILE[input.kind];
  const config = loadPrinterConfig();
  const deviceName = config[profile];

  // Electron desktop: usa silentPrint com a impressora configurada
  if (isElectron()) {
    const electron = (window as any).electronAPI;
    try {
      // Antes de imprimir, seta a impressora ATIVA no electron-store.
      // O silentPrintUrl vai usar essa impressora automaticamente.
      if (deviceName) {
        await electron.setConfig({ printer: deviceName });
      } else if (input.warnIfMissing) {
        console.warn(`[printer-router] Sem impressora configurada pra "${profile}". Usando padrão do Windows.`);
      }

      let absoluteUrl = input.url.startsWith('http')
        ? input.url
        : window.location.origin + input.url;
      // FIX 14/07 ("teste imprime, venda não"): a hidden window do app roda
      // numa sessão SEM o login → recibo/NFC-e tomavam 401 e nada saía. O JWT
      // vai no FRAGMENT (#ptk=) — não aparece em servidor/log — e a página de
      // impressão autentica (ver getAuthToken em api.ts).
      try {
        const tk = getAuthToken();
        if (tk) absoluteUrl += `${absoluteUrl.includes('#') ? '&' : '#'}ptk=${encodeURIComponent(tk)}`;
      } catch { /* sem token, segue como antes */ }
      await electron.silentPrintUrl(absoluteUrl);
      return { ok: true, mode: 'electron-silent' };
    } catch (e: any) {
      const msg = e?.message || String(e);
      console.warn('[printer-router] electron silentPrint falhou, caindo pra iframe:', msg);
      // Fallback iframe
      return printViaIframe(input.url);
    }
  }

  // Browser puro: iframe oculto que dispara window.print() (autoprint=1 na URL)
  return printViaIframe(input.url);
}

/**
 * Iframe oculto que carrega a URL e dispara window.print() internamente
 * (a página chama window.print() quando autoprint=1 e dados carregaram).
 */
function printViaIframe(url: string): Promise<{ ok: boolean; mode: string; error?: string }> {
  return new Promise((resolve) => {
    try {
      const iframe = document.createElement('iframe');
      iframe.style.cssText = 'position:fixed;left:-9999px;top:0;width:300px;height:600px;border:0;';
      iframe.src = url;
      iframe.setAttribute('aria-hidden', 'true');

      let loaded = false;
      iframe.onload = () => { loaded = true; };
      document.body.appendChild(iframe);

      // Fallback: se em 4s não carregou, abre popup visível
      setTimeout(() => {
        if (!loaded) {
          try { iframe.remove(); } catch {}
          const w = window.open(url, 'lurds_print', 'width=380,height=600,resizable=yes');
          if (!w) {
            resolve({ ok: false, mode: 'popup-blocked', error: 'Popup bloqueado pelo navegador' });
          } else {
            resolve({ ok: true, mode: 'popup' });
          }
        }
      }, 4000);

      // Cleanup 30s depois
      setTimeout(() => { try { iframe.remove(); } catch {} }, 30000);

      // Se carregou no prazo, considera sucesso após 1s (tempo do window.print() interno)
      setTimeout(() => {
        if (loaded) resolve({ ok: true, mode: 'iframe' });
      }, 1500);
    } catch (e: any) {
      resolve({ ok: false, mode: 'error', error: e?.message || String(e) });
    }
  });
}

/** Retorna o profile (termica/a4) que um KIND usa — útil pra UI */
export function getProfileForKind(kind: PrinterKind): 'termica' | 'a4' {
  return KIND_TO_PROFILE[kind];
}

/** Texto humano pro KIND — usado na UI de config */
export const KIND_LABELS: Record<PrinterKind, { label: string; desc: string }> = {
  cupom: { label: 'Cupom não-fiscal de venda', desc: 'PIX, dinheiro — 2 vias (1ª Loja + 2ª Cliente)' },
  nfce: { label: 'DANFE NFC-e', desc: 'Nota Fiscal Eletrônica do Consumidor' },
  vale: { label: 'Vale-troca', desc: 'Crédito gerado em devolução' },
  sangria: { label: 'Sangria / Suprimento', desc: 'Movimento de caixa com assinatura' },
  recibo_pix: { label: 'Recibo PIX-link crediário', desc: 'Quando cliente paga parcela remotamente' },
  carne: { label: 'Carnê de crediário', desc: 'Promissórias + carnê em A4 (azul/branca)' },
};
