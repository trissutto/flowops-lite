/**
 * CUPONS — validação compartilhada entre sacola e checkout.
 *
 * A tabela vive aqui (e pode ser sobrescrita por env no server) até o backend
 * ganhar o módulo de cupons. A UI NUNCA calcula desconto por conta própria:
 * chama `applyCoupon` e exibe o `message` — assim a regra muda num lugar só.
 *
 * ⚠️ Validação client-side é cortesia de UX; a validação que VALE é a do
 * server no POST /api/checkout (mesma função, rodando lá). Cliente esperto
 * pode adulterar o front — o total do pedido é sempre recalculado no server.
 */

import type { CouponResult } from '@/types/checkout';

interface CouponRule {
  code: string;
  kind: 'percent' | 'fixed' | 'shipping';
  /** percent: 0–100 · fixed: reais. */
  value: number;
  /** Pedido mínimo em reais. */
  minSubtotal?: number;
  /** ISO — cupom morto depois disso. */
  expiresAt?: string;
  label: string;
}

/** Tabela padrão. No server, `CUPONS_JSON` (env) substitui por completo. */
const DEFAULT_RULES: CouponRule[] = [
  /**
   * PRIMEIRA10 — o cupom do popup de boas-vindas (12/08/2026).
   *
   * SEM VALOR MÍNIMO, por decisão do dono. O BEMVINDA10 logo abaixo exige
   * R$ 149,90; prometer "10% na primeira compra" e a cliente levar um "não"
   * no carrinho de R$ 89 é quebrar a promessa na primeira conversa que a
   * marca teve com ela — pior do que não ter oferecido.
   *
   * Código próprio (e não o BEMVINDA10) pra dar pra medir quanto o popup
   * vendeu. Trocar de campanha: este código + `CUPOM_LEAD_SITE` no backend.
   */
  { code: 'PRIMEIRA10', kind: 'percent', value: 10, label: 'Primeira compra: 10% off' },
  { code: 'BEMVINDA10', kind: 'percent', value: 10, minSubtotal: 149.9, label: 'Boas-vindas: 10% off' },
  { code: 'LURDS15', kind: 'percent', value: 15, minSubtotal: 349.9, label: '15% off acima de R$ 349,90' },
  { code: 'FRETEGRATIS', kind: 'shipping', value: 0, minSubtotal: 199.9, label: 'Frete grátis' },
];

function rules(): CouponRule[] {
  // Server-side: env tem precedência (mesma filosofia das flags do FlowOps).
  if (typeof window === 'undefined' && process.env.CUPONS_JSON) {
    try {
      const parsed = JSON.parse(process.env.CUPONS_JSON) as CouponRule[];
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch {
      console.warn('[cupom] CUPONS_JSON inválido — usando tabela padrão');
    }
  }
  return DEFAULT_RULES;
}

function fmt(v: number): string {
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

/**
 * Valida e calcula. Mensagens ELEGANTES por contrato — a spec proíbe erro
 * técnico na frente da cliente.
 */
export function applyCoupon(rawCode: string, subtotal: number): CouponResult {
  const code = rawCode.trim().toUpperCase();
  if (!code) return { ok: false, code, discount: 0, message: 'Digite o código do cupom.' };

  const rule = rules().find((r) => r.code.toUpperCase() === code);
  if (!rule) {
    return { ok: false, code, discount: 0, message: 'Não encontramos esse cupom. Confira o código e tente de novo.' };
  }
  if (rule.expiresAt && new Date(rule.expiresAt).getTime() < Date.now()) {
    return { ok: false, code, discount: 0, message: 'Esse cupom já expirou — mas fique de olho: sempre temos novidades.' };
  }
  if (rule.minSubtotal && subtotal < rule.minSubtotal) {
    return {
      ok: false,
      code,
      discount: 0,
      message: `Esse cupom vale para compras a partir de ${fmt(rule.minSubtotal)}. Faltam ${fmt(rule.minSubtotal - subtotal)}.`,
    };
  }

  const discount =
    rule.kind === 'percent'
      ? Math.round(subtotal * (rule.value / 100) * 100) / 100
      : rule.kind === 'fixed'
        ? Math.min(rule.value, subtotal)
        : 0; // shipping: o desconto é aplicado no frete, não no subtotal

  return {
    ok: true,
    code,
    discount,
    kind: rule.kind,
    message:
      rule.kind === 'shipping'
        ? 'Cupom aplicado: seu frete sai grátis.'
        : `Cupom aplicado: ${rule.label.toLowerCase()} (−${fmt(discount)}).`,
  };
}
