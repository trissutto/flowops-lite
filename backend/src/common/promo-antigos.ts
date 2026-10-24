import { chaveDeClassificacao } from './promo-por-termo';

/**
 * PROMOÇÃO DOS ANTIGOS — preço FIXO por faixa (dono, 23/10/2026).
 *
 * A pedida: "peças de 31/12/2022 pra trás por 49,90 se forem até 149,90 e
 * 99,90 se forem de 149,91 pra cima — os BÁSICOS não entram", com a data base
 * corrigida no mesmo dia pra 31/12/2023. Ativada no PDV igual à campanha de
 * 30% (o botão da venda), SÓ no PDV: o site não muda.
 *
 * ── QUEM ENTRA ──
 *
 *   1. sem data de cadastro              → fora (não dá pra saber se é antiga)
 *   2. cadastro DEPOIS de 31/12/2023     → fora
 *   3. linha BÁSICA (Classificação)      → fora — a mesma regra de sempre
 *   4. preço atual já ≤ preço da faixa   → fora: a "promoção" subiria o preço
 *                                          (Itanhaém tinha 17.873 peças assim
 *                                          em 23/10 — camiseta a R$ 9,90)
 *   5. o resto                           → entra, pelo preço da faixa
 *
 * A data é o `dataAlt` do cadastro — a MESMA "data de cadastro" que a consulta
 * de promoção do PDV mostra e que o "liquida antigos" usava (ver o incidente
 * de 14/07 em `erp.service.ts`: o editor nunca carimba DATAALT).
 *
 * A vendedora ainda tira a linha (🚫) e põe (⬆️) só naquela venda, como na
 * campanha de 30%. Pôr vale pros motivos 1–3; o 4 continua sem desconto,
 * porque não há desconto a dar.
 */

/**
 * O valor de `pdv_sales.active_promotion` que liga esta promoção na venda. Sem
 * o ano no nome: a data base já mudou uma vez (2022 → 2023), e trocar a chave
 * derrubaria a venda aberta com a promoção.
 */
export const PROMO_ANTIGOS = 'ANTIGOS';

/** Último dia de cadastro que entra (inclusive), em YYYY-MM-DD. */
export const ANTIGOS_CADASTRO_ATE = '2023-12-31';

/** Faixas em ordem: a primeira cujo `ate` cobre o preço atual decide. */
export const ANTIGOS_FAIXAS: ReadonlyArray<{ ate: number; preco: number }> = [
  { ate: 149.9, preco: 49.9 },
  { ate: Number.POSITIVE_INFINITY, preco: 99.9 },
];

export const ANTIGOS_NOME = 'Antigos até 2023';

export type CriterioAntigos = 'sem_data' | 'nova' | 'basico' | 'ja_barata' | 'faixa';

export interface PecaAntigos {
  ref?: string | null;
  codigo?: string | null;
  /** `product.dataAlt` — Date, ISO ou YYYY-MM-DD. */
  dataCadastro?: Date | string | null;
  /** Preço unitário atual (o que o caixa cobraria sem promoção). */
  preco: number;
}

export interface DecisaoAntigos {
  entra: boolean;
  criterio: CriterioAntigos;
  /** Preço unitário da faixa (null = fora da faixa, preço segue o atual). */
  precoFaixa: number | null;
  motivo: string;
}

const centavos = (v: number) => Math.round(Number(v || 0) * 100);

/** Preço da faixa pelo preço atual — comparado em centavos (149,90 × 149,91). */
export function precoDaFaixa(preco: number): number {
  const c = centavos(preco);
  for (const f of ANTIGOS_FAIXAS) {
    if (c <= centavos(f.ate) || !Number.isFinite(f.ate)) return f.preco;
  }
  return ANTIGOS_FAIXAS[ANTIGOS_FAIXAS.length - 1].preco;
}

/** YYYY-MM-DD do cadastro, ou null quando não há data válida. */
export function diaDoCadastro(v: Date | string | null | undefined): string | null {
  if (v == null || v === '') return null;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

const brl = (v: number) => v.toFixed(2).replace('.', ',');

/**
 * A decisão de uma peça. `basicos` = chaves (`chaveDeClassificacao`) marcadas
 * BÁSICO na tela de Classificação. `forcar` = a vendedora pôs a linha (⬆️).
 */
export function decidirAntigos(peca: PecaAntigos, basicos: Set<string>, forcar = false): DecisaoAntigos {
  const preco = Number(peca.preco) || 0;
  const faixa = precoDaFaixa(preco);
  if (centavos(preco) <= centavos(faixa)) {
    return {
      entra: false,
      criterio: 'ja_barata',
      precoFaixa: null,
      motivo: `já custa R$ ${brl(preco)} — a faixa de R$ ${brl(faixa)} não baixa o preço`,
    };
  }
  const entra = (criterio: CriterioAntigos, motivo: string): DecisaoAntigos => ({
    entra: true, criterio, precoFaixa: faixa, motivo,
  });
  const fora = (criterio: CriterioAntigos, motivo: string): DecisaoAntigos =>
    forcar
      ? entra(criterio, `posta na mão (${motivo})`)
      : { entra: false, criterio, precoFaixa: null, motivo };

  const dia = diaDoCadastro(peca.dataCadastro);
  if (!dia) return fora('sem_data', 'sem data de cadastro');
  if (dia > ANTIGOS_CADASTRO_ATE) return fora('nova', `cadastrada em ${dia.split('-').reverse().join('/')}`);
  if (basicos.has(chaveDeClassificacao(peca.ref, peca.codigo))) {
    return fora('basico', 'linha BÁSICA (classificação)');
  }
  return entra('faixa', `cadastro até 31/12/2023 — sai a R$ ${brl(faixa)}`);
}

/** Linha do PDV: total = preço da faixa × quantidade (centavos inteiros). */
export function totalDoItemAntigos(precoUnit: number, qty: number, precoFaixa: number) {
  const q = Math.max(1, qty);
  const bruto = Math.round(centavos(precoUnit) * q) / 100;
  const total = Math.round(centavos(precoFaixa) * q) / 100;
  return { bruto, total, desconto: Math.round((bruto - total) * 100) / 100 };
}

/** Etiqueta da linha: começa com PROMO (o PDV reconhece o prefixo). */
export function rotuloAntigos(precoFaixa: number, naMao = false): string {
  return `PROMO R$ ${brl(precoFaixa)} · antigos${naMao ? ' · na mão' : ''}`;
}
