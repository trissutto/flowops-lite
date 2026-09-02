/**
 * CUPONS — validação compartilhada entre sacola e checkout.
 *
 * A fonte de verdade é `site_cupons` no FlowOps (painel /retaguarda/cupons);
 * a regra chega aqui via `validarCupomRemoto` e fica em memória. A UI NUNCA
 * calcula desconto por conta própria: chama `applyCoupon` e exibe o
 * `message` — assim a regra muda num lugar só.
 *
 * ⚠️ Validação client-side é cortesia de UX; a validação que VALE é a do
 * server no POST /api/checkout (mesma função, rodando lá). Cliente esperto
 * pode adulterar o front — o total do pedido é sempre recalculado no server.
 */

import type { CouponResult } from '@/types/checkout';

export interface CouponRule {
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

/**
 * Tabela padrão VAZIA desde 01/09 — ordem do dono ("matar"): as campanhas
 * herdadas do site velho (PRIMEIRA10/BEMVINDA10/LURDS15/FRETEGRATIS) e a
 * VESTIDO139 acabaram. Cupom agora nasce SÓ na retaguarda (/retaguarda/cupons
 * → `site_cupons`) e chega aqui pelo `validarCupomRemoto`, que semeia a regra
 * em `REGRAS_REMOTAS`. Manter código aqui era exatamente o vazamento que
 * ressuscitava campanha morta quando o backend piscava.
 *
 * No server, `CUPONS_JSON` (env) continua substituindo por completo —
 * escape hatch pra campanha relâmpago sem deploy.
 */
const DEFAULT_RULES: CouponRule[] = [];

function rules(): CouponRule[] {
  // Server-side: env tem precedência (mesma filosofia das flags do FlowOps).
  if (typeof window === 'undefined' && process.env.CUPONS_JSON) {
    try {
      const parsed = JSON.parse(process.env.CUPONS_JSON) as CouponRule[];
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch {
      console.warn('[cupom] CUPONS_JSON inválido — ignorando');
    }
  }
  return DEFAULT_RULES;
}

/**
 * REGRAS QUE VIERAM DO BACKEND — semeadas por `validarCupomRemoto` (01/09).
 *
 * A tabela local acima é a herança de quando o cupom morava no site; a fonte
 * de verdade é `site_cupons` no FlowOps (criada na retaguarda, sem deploy —
 * e é onde vive o VALE-TROCA nominal, que esta lista nem sabe representar).
 * Quando o backend valida um código, a regra dele entra AQUI, em memória:
 * é o que deixa a sacola recalcular o desconto a cada +/− de peça sem uma
 * chamada de rede por render. Nunca vai pro localStorage — regra persistida
 * é desconto de ontem cobrado amanhã (a mesma filosofia do cart store).
 */
const REGRAS_REMOTAS = new Map<string, CouponRule>();

/** Guarda a regra validada pelo backend pro recálculo local. */
export function seedCouponRule(rule: CouponRule): void {
  REGRAS_REMOTAS.set(rule.code.toUpperCase(), rule);
}

/**
 * "Esse código a gente já sabe calcular localmente?" — decide se o cupom
 * persistido no cart store precisa ser revalidado no backend após um reload
 * (a regra remota mora em memória e morre com a aba).
 */
export function conheceCupom(code: string): boolean {
  const c = code.trim().toUpperCase();
  return REGRAS_REMOTAS.has(c) || rules().some((r) => r.code.toUpperCase() === c);
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

  // Regra do backend na frente: se o mesmo código existe nos dois lados
  // (caso VESTIDO139 — cópia local que envelhece), vale a de quem cobra.
  const rule = REGRAS_REMOTAS.get(code) ?? rules().find((r) => r.code.toUpperCase() === code);
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

/**
 * VALIDA NO BACKEND — a fonte que a retaguarda edita e onde o vale-troca
 * vive (01/09/2026, o "dívida conhecida" do cabeçalho pago).
 *
 * Bate em `/api/loja/cupom` (BFF, que carrega o token) e SEMEIA a regra
 * devolvida em `REGRAS_REMOTAS` — a partir daí o `applyCoupon` local sabe
 * recalcular esse código a cada mudança de subtotal. Backend fora do ar:
 * código já semeado continua recalculando; código novo responde "não
 * encontramos" até a rede voltar — e quem cobra reconfere de qualquer jeito.
 *
 * `cpf` é opcional e só importa pro vale nominal: sem ele o backend devolve
 * `reason='nominal_sem_cpf'` e o checkout reaplica quando o CPF entrar.
 */
export async function validarCupomRemoto(
  rawCode: string,
  subtotal: number,
  cpf?: string,
): Promise<CouponResult> {
  const code = rawCode.trim().toUpperCase();
  if (!code) return { ok: false, code, discount: 0, message: 'Digite o código do cupom.' };

  try {
    const res = await fetch('/api/loja/cupom', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        subtotal,
        ...(cpf ? { cpf: cpf.replace(/\D/g, '') } : {}),
      }),
      cache: 'no-store',
    });
    const dados = (await res.json().catch(() => null)) as
      | (CouponResult & { rule?: CouponRule; fallback?: boolean })
      | null;
    if (!dados || typeof dados.ok !== 'boolean') return applyCoupon(code, subtotal);
    if (dados.rule) seedCouponRule(dados.rule);
    return dados;
  } catch {
    return applyCoupon(code, subtotal);
  }
}
