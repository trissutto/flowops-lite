/**
 * FRETE — a fonte agora é o BACKEND; o que sobrou aqui é paraquedas.
 *
 * Até 06/08/2026 esta tabela ERA o preço: faixa de CEP → PAC/SEDEX estimados,
 * e o cálculo real com contrato existia no FlowOps sem ninguém consumir. Duas
 * verdades, e a que a cliente via era a errada.
 *
 * Hoje `fetchQuotes()` pede as opções ao backend (`/api/loja/frete`), que
 * aplica a tabela promocional cadastrada — SP SEDEX R$ 9,99, RJ/MG/PR/SC/RS
 * PAC R$ 19,99, demais UFs pela cotação do contrato — soma os dias de
 * separação e devolve a régua do frete grátis vigente. Nada disso é decidido
 * aqui, e é de propósito: campanha de frete não pode esperar deploy.
 *
 * `quoteShipping()` continua existindo e continua SÍNCRONA porque é o
 * PARAQUEDAS (item 20): backend fora do ar, a cliente ainda vê um preço e
 * fecha o pedido. O backend reconfere na hora de cobrar, então o pior caso é
 * o valor mudar entre a tela e a cobrança — nunca cobrar errado.
 *
 * Retirada continua 100% local: depende de `data/stores.ts` e das faixas de
 * CEP das cidades atendidas, que o backend não tem.
 */

import { stores } from '@/data/stores';
import type { ShippingQuote } from '@/types/checkout';

/**
 * Régua do frete grátis usada SÓ no paraquedas e como valor inicial da barra
 * de progresso antes da primeira cotação. A régua que vale vem do backend
 * (`freteGratis.minimo`) — o dono mudou pra R$ 499,90 em 06/08 e daqui pra
 * frente muda na tela, sem deploy.
 */
export const FREE_SHIPPING_FROM = 499.9;

/** Faixas de CEP (2 primeiros dígitos) → grupo de preço/prazo. */
type Zone = 'sp-capital' | 'sp-interior' | 'sudeste' | 'sul' | 'centro-nordeste' | 'norte';

function zoneOf(cep: string): Zone {
  const d2 = Number(cep.slice(0, 2));
  if (Number.isNaN(d2)) return 'sudeste';
  if (d2 <= 9) return 'sp-capital'; // 01xxx–09xxx: capital e grande SP
  if (d2 <= 19) return 'sp-interior'; // 10–19: interior/litoral SP
  if (d2 <= 39) return 'sudeste'; // RJ/ES/MG
  if (d2 >= 80 && d2 <= 99) return 'sul';
  if (d2 >= 69 || (d2 >= 66 && d2 <= 68)) return 'norte';
  return 'centro-nordeste';
}

const TABELA: Record<Zone, { pac: { price: number; min: number; max: number }; sedex: { price: number; min: number; max: number } }> = {
  'sp-capital': { pac: { price: 14.9, min: 2, max: 4 }, sedex: { price: 24.9, min: 1, max: 2 } },
  'sp-interior': { pac: { price: 17.9, min: 3, max: 5 }, sedex: { price: 28.9, min: 1, max: 3 } },
  sudeste: { pac: { price: 21.9, min: 4, max: 7 }, sedex: { price: 34.9, min: 2, max: 4 } },
  sul: { pac: { price: 24.9, min: 5, max: 8 }, sedex: { price: 39.9, min: 2, max: 4 } },
  'centro-nordeste': { pac: { price: 27.9, min: 6, max: 10 }, sedex: { price: 46.9, min: 3, max: 5 } },
  norte: { pac: { price: 32.9, min: 8, max: 12 }, sedex: { price: 54.9, min: 4, max: 7 } },
};

/** Cidades atendidas → prefixos de CEP (faixa aproximada, mesma base do CRM). */
const RETIRADA_POR_PREFIXO: Array<{ prefixos: string[]; slugs: string[] }> = [
  { prefixos: ['117'], slugs: ['itanhaem'] },
  { prefixos: ['110', '115'], slugs: ['santos'] },
  { prefixos: ['132'], slugs: ['vinhedo'] },
  { prefixos: ['133'], slugs: ['indaiatuba'] },
  { prefixos: ['134'], slugs: ['piracicaba'] },
  { prefixos: ['180', '181'], slugs: ['sorocaba'] },
  { prefixos: ['130', '131'], slugs: ['campinas'] },
  { prefixos: ['122'], slugs: ['sao-jose-dos-campos'] },
  { prefixos: ['132'], slugs: ['jundiai'] },
  { prefixos: ['1348'], slugs: ['limeira'] },
  { prefixos: ['117'], slugs: ['praia-grande'] },
  { prefixos: ['04', '05', '03', '01', '02', '08'], slugs: ['moema', 'analia-franco'] },
  { prefixos: ['086', '087'], slugs: ['suzano'] },
];

export function onlyDigits(v: string): string {
  return v.replace(/\D/g, '');
}

export function isValidCep(v: string): boolean {
  return onlyDigits(v).length === 8;
}

/**
 * Lojas com retirada disponível pro CEP.
 *
 * ⚠️ NÃO exige que a peça esteja NAQUELA loja (item 26, decisão do dono
 * 04/08): se a loja escolhida não tiver, vem de outra da rede. A retirada é
 * sobre ONDE a cliente quer buscar, não sobre onde a peça está hoje — quem
 * resolve a origem é o roteamento da matriz, exatamente como já faz com
 * qualquer pedido dividido entre lojas.
 */
export function pickupStoresFor(cep: string, prazoHoras = 3): ShippingQuote[] {
  const digits = onlyDigits(cep);
  if (digits.length < 3) return [];

  const slugs = new Set<string>();
  for (const faixa of RETIRADA_POR_PREFIXO) {
    if (faixa.prefixos.some((p) => digits.startsWith(p))) faixa.slugs.forEach((s) => slugs.add(s));
  }

  return stores
    .filter((s) => slugs.has(s.slug))
    .map((s) => ({
      id: `retirada-${s.slug}`,
      kind: 'retirada' as const,
      label: `Retirar na loja ${s.unit}`,
      price: 0,
      readyInHours: prazoHoras,
      storeSlug: s.slug,
      storeLabel: `${s.unit} · ${s.city}/${s.uf}`,
    }));
}

/**
 * Cotações pro CEP. Sempre devolve pelo menos PAC + SEDEX; retirada entra
 * quando há loja na área. Frete grátis: PAC zera acima do teto (o SEDEX
 * continua pago — grátis é o econômico, não o expresso).
 */
export function quoteShipping(cep: string, subtotal: number): ShippingQuote[] {
  if (!isValidCep(cep)) return [];
  const digits = onlyDigits(cep);
  const zona = TABELA[zoneOf(digits)];
  const gratis = subtotal >= FREE_SHIPPING_FROM;

  return [
    {
      id: 'correios-pac',
      kind: 'correios',
      label: 'Correios PAC',
      price: gratis ? 0 : zona.pac.price,
      etaDays: { min: zona.pac.min, max: zona.pac.max },
    },
    {
      id: 'correios-sedex',
      kind: 'expressa',
      label: 'SEDEX Expresso',
      price: zona.sedex.price,
      etaDays: { min: zona.sedex.min, max: zona.sedex.max },
    },
    ...pickupStoresFor(digits),
  ];
}

export function findQuote(cep: string, subtotal: number, quoteId: string): ShippingQuote | undefined {
  return quoteShipping(cep, subtotal).find((q) => q.id === quoteId);
}

/* ───────────────────────── cotação de verdade ──────────────────────────── */

export interface CotacaoDoSite {
  quotes: ShippingQuote[];
  /** Régua vigente — a barra de progresso da sacola lê daqui. */
  freteGratis: { ativo: boolean; minimo: number; alcancado: boolean; falta: number };
  /** true = veio da tabela local (backend fora) ou da estimativa do backend. */
  estimado: boolean;
  /** Texto da retirada em loja, cadastrado na retaguarda. */
  retirada?: { prazoHoras: number; instrucoes: string | null };
}

/**
 * As opções de entrega REAIS. Roda no navegador (a rota /api carrega o token).
 *
 * Sempre devolve algo: backend fora → tabela local marcada `estimado`. A
 * retirada é adicionada aqui nos dois casos, porque quem sabe quais lojas
 * atendem aquele CEP é o site.
 */
export async function fetchQuotes(
  cep: string,
  subtotal: number,
  pecas = 1,
  signal?: AbortSignal,
): Promise<CotacaoDoSite> {
  const digits = onlyDigits(cep);
  const local = (): CotacaoDoSite => ({
    quotes: quoteShipping(digits, subtotal),
    freteGratis: {
      ativo: true,
      minimo: FREE_SHIPPING_FROM,
      alcancado: subtotal >= FREE_SHIPPING_FROM,
      falta: Math.max(0, Math.round((FREE_SHIPPING_FROM - subtotal) * 100) / 100),
    },
    estimado: true,
  });

  if (!isValidCep(digits)) {
    return { quotes: [], freteGratis: { ativo: false, minimo: 0, alcancado: false, falta: 0 }, estimado: false };
  }

  try {
    const res = await fetch('/api/loja/frete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cep: digits, subtotal, pecas }),
      signal,
    });
    const dados = await res.json().catch(() => null);
    if (!dados?.ok || !Array.isArray(dados.opcoes) || !dados.opcoes.length) return local();

    return {
      quotes: [
        ...dados.opcoes.map(
          (o: {
            id?: string | number; kind?: string; label?: string;
            price?: number | string; etaDays?: { min: number; max: number };
          }): ShippingQuote => ({
            id: String(o.id),
            kind: o.kind === 'expressa' ? 'expressa' : 'correios',
            label: String(o.label),
            price: Number(o.price) || 0,
            etaDays: o.etaDays,
          }),
        ),
        ...pickupStoresFor(digits, dados.retirada?.prazoHoras),
      ],
      freteGratis: dados.freteGratis ?? local().freteGratis,
      estimado: !!dados.estimado,
      retirada: dados.retirada,
    };
  } catch {
    // AbortError incluído: quem cancelou não quer resultado, e devolver a
    // tabela local é inofensivo (a tela descarta).
    return local();
  }
}

/** Quanto falta pro frete grátis — alimenta a barra de progresso da sacola. */
export function freeShippingGap(
  subtotal: number,
  minimo = FREE_SHIPPING_FROM,
): { reached: boolean; missing: number; progress: number } {
  if (!(minimo > 0)) return { reached: true, missing: 0, progress: 1 };
  const missing = Math.max(0, minimo - subtotal);
  return {
    reached: missing === 0,
    missing: Math.round(missing * 100) / 100,
    progress: Math.min(1, subtotal / minimo),
  };
}
