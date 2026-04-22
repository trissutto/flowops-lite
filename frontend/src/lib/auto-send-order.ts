'use client';

/**
 * auto-send-order.ts — helper 1-clique pra enviar 1 pedido pra loja.
 *
 * Faz TUDO em sequência pro `wcOrderId` passado:
 *   1. (opcional) Checa sessão WhatsApp Baileys
 *   2. Chama /orders/wc/:id/prepare-separation → decide a(s) loja(s)
 *   3. Se tem grupo com WhatsApp, chama /whatsapp/send pra cada grupo
 *   4. Faz PATCH /orders/wc/:id → status 'separacao' com nota da(s) loja(s)
 *
 * Reusado em 2 lugares:
 *   - botão "1-CLIQUE" por linha da /separacao (ação manual individual)
 *   - Piloto Automático (auto-executa quando chega order:new)
 *
 * IMPORTANTE: retorna resultado estruturado pra quem chamou decidir o feedback
 * visual. NÃO dispara alert() — o caller faz isso (diferente entre manual/auto).
 */

import { api } from './api';

export interface SeparationGroupLite {
  storeId: string;
  storeCode: string;
  storeName: string;
  whatsapp: string | null;
  whatsappMessage: string;
  items: Array<{ sku: string; quantity: number; productName: string; variant?: string }>;
}

export interface SeparationPreviewLite {
  success: boolean;
  strategy: 'single-store' | 'multi-store' | 'insufficient-stock';
  shippingMethod: string;
  groups: SeparationGroupLite[];
  missing: Array<{ sku: string; quantity: number; productName: string }>;
}

export type AutoSendOutcome =
  | { ok: true; groups: SeparationGroupLite[]; shippingMethod: string }
  | { ok: false; reason: 'wa-disconnected' | 'no-stock' | 'no-whatsapp' | 'send-failed' | 'patch-failed' | 'prepare-failed' | 'unknown'; message: string; groups?: SeparationGroupLite[] };

export interface AutoSendOptions {
  /** Se true, NÃO checa /whatsapp/status antes. Usado só em contextos onde já checou. */
  skipWaStatusCheck?: boolean;
  /** Texto adicional pra nota no WC (ex: "[Piloto Automático]" pra marcar origem). */
  noteSuffix?: string;
}

/**
 * Envia 1 pedido pra loja (fluxo unificado).
 */
export async function autoSendOrderToStore(
  wcOrderId: number,
  opts: AutoSendOptions = {},
): Promise<AutoSendOutcome> {
  // PASSO 0 — checar WhatsApp conectado (pula se indicado)
  if (!opts.skipWaStatusCheck) {
    try {
      const st = await api<{ connected: boolean }>('/whatsapp/status');
      if (!st.connected) {
        return {
          ok: false,
          reason: 'wa-disconnected',
          message: 'WhatsApp não conectado. Abra /retaguarda/whatsapp e escaneie o QR.',
        };
      }
    } catch (e: any) {
      return {
        ok: false,
        reason: 'unknown',
        message: `Falha ao consultar status do WhatsApp: ${e?.message || e}`,
      };
    }
  }

  // PASSO 1 — calcula separação (loja responsável)
  let preview: SeparationPreviewLite;
  try {
    preview = await api<SeparationPreviewLite>(`/orders/wc/${wcOrderId}/prepare-separation`);
  } catch (e: any) {
    return {
      ok: false,
      reason: 'prepare-failed',
      message: e?.message || 'Falha ao calcular separação',
    };
  }

  if (!preview.success) {
    return {
      ok: false,
      reason: 'no-stock',
      message: 'Pedido em ruptura — sem estoque em nenhuma loja. Revisão manual necessária.',
      groups: preview.groups,
    };
  }

  // Se nenhum grupo tem WhatsApp cadastrado, aborta — dispara fallback pra revisão
  const groupsWithWa = preview.groups.filter((g) => g.whatsapp && g.whatsappMessage);
  if (groupsWithWa.length === 0) {
    return {
      ok: false,
      reason: 'no-whatsapp',
      message: 'Loja(s) escolhida(s) sem WhatsApp cadastrado. Ajuste em /lojas.',
      groups: preview.groups,
    };
  }

  // PASSO 2 — envia WhatsApp pra cada grupo. Se qualquer grupo falhar, aborta
  // o PATCH pra não marcar como separacao com mensagem perdida.
  const sendFailures: Array<{ storeCode: string; error: string }> = [];
  for (const g of groupsWithWa) {
    try {
      const r = await api<{ ok: boolean; error?: string }>('/whatsapp/send', {
        method: 'POST',
        body: JSON.stringify({ number: g.whatsapp, text: g.whatsappMessage }),
      });
      if (!r.ok) sendFailures.push({ storeCode: g.storeCode, error: r.error || 'erro desconhecido' });
    } catch (e: any) {
      sendFailures.push({ storeCode: g.storeCode, error: e?.message || 'falha de rede' });
    }
  }

  if (sendFailures.length > 0) {
    return {
      ok: false,
      reason: 'send-failed',
      message: `Falha ao enviar pra ${sendFailures.length} loja(s): ${sendFailures.map((f) => `${f.storeCode}:${f.error}`).join(' · ')}`,
      groups: preview.groups,
    };
  }

  // PASSO 3 — PATCH status → separacao no WC
  const lojas = preview.groups.map((g) => `${g.storeName} (${g.storeCode})`).join(', ');
  const suffix = opts.noteSuffix ? ` ${opts.noteSuffix}` : '';
  try {
    await api(`/orders/wc/${wcOrderId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        status: 'separacao',
        addNote: {
          text: `Separação enviada via WhatsApp pra: ${lojas}.${suffix}`,
          notifyCustomer: false,
        },
      }),
    });
  } catch (e: any) {
    return {
      ok: false,
      reason: 'patch-failed',
      message: `WhatsApp enviado, mas falhou ao mudar status no WC: ${e?.message || e}`,
      groups: preview.groups,
    };
  }

  return { ok: true, groups: preview.groups, shippingMethod: preview.shippingMethod };
}

// ═══════════════════════════════════════════════════════════════════════════
// PILOTO AUTOMÁTICO — flag global (persistida em localStorage)
// ═══════════════════════════════════════════════════════════════════════════

const PILOT_KEY = 'lurds_pilot_automatic_on';

export function isPilotOn(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return localStorage.getItem(PILOT_KEY) === '1';
  } catch {
    return false;
  }
}

export function setPilotOn(on: boolean) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(PILOT_KEY, on ? '1' : '0');
    // Dispatch storage-like event pra componentes reativos atualizarem
    window.dispatchEvent(new CustomEvent('lurds:pilot-changed', { detail: { on } }));
  } catch {}
}
