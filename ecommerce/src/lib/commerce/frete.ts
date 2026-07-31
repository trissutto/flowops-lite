/**
 * FRETE — cotação estimada por CEP + retirada em loja.
 *
 * ⚠️ ESTIMATIVA, declarada como tal na UI ("frete estimado"). O cálculo real
 * dos Correios exige contrato e roda no backend (o FlowOps já fala com
 * Correios/Mais Envios pros envios da live). Quando o endpoint público de
 * cotação existir, só `quoteShipping` muda — a UI consome `ShippingQuote[]`
 * e não sabe de onde veio.
 *
 * A tabela abaixo segue a lógica real da operação: raiz do CEP → região.
 * Retirada: a loja é elegível quando o CEP da cliente cai na área da cidade
 * dela (mesma lógica de faixas do CRM, simplificada pro client).
 */

import { stores } from '@/data/stores';
import type { ShippingQuote } from '@/types/checkout';

/** Frete grátis a partir deste subtotal (regra de negócio — ajustável). */
export const FREE_SHIPPING_FROM = 399.9;

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

/** Lojas com retirada disponível pro CEP. */
export function pickupStoresFor(cep: string): ShippingQuote[] {
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
      readyInHours: 3,
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

  const quotes: ShippingQuote[] = [
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
  return quotes;
}

export function findQuote(cep: string, subtotal: number, quoteId: string): ShippingQuote | undefined {
  return quoteShipping(cep, subtotal).find((q) => q.id === quoteId);
}

/** Quanto falta pro frete grátis — alimenta a barra de progresso da sacola. */
export function freeShippingGap(subtotal: number): { reached: boolean; missing: number; progress: number } {
  const missing = Math.max(0, FREE_SHIPPING_FROM - subtotal);
  return {
    reached: missing === 0,
    missing: Math.round(missing * 100) / 100,
    progress: Math.min(1, subtotal / FREE_SHIPPING_FROM),
  };
}
