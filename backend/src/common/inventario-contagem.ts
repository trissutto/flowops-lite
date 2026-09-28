/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  INVENTÁRIO — a régua da contagem (28/09/2026)
 *
 *  Uma régua só, usada pela tela da loja (o que bipou), pela tela da matriz
 *  (a divergência em peças e em R$) e pelo "Aplicar" (o delta que vai pro
 *  estoque). Tela e porta não podem divergir: quem opera precisa ver na tela
 *  exatamente a conta que o servidor vai aplicar.
 *
 *  O QUE ESTA RÉGUA DECIDE, E O QUE ELA NÃO DECIDE
 *
 *  Ela decide: quanto falta ou sobra de cada código, quanto isso vale a
 *  custo, o que merece recontagem antes de virar ajuste, e qual delta sai.
 *
 *  Ela NÃO decide o `esperado`. Esse número é congelado no PRIMEIRO BIPE de
 *  cada código pelo service (`InventarioEsperado`) — e é isso que faz a loja
 *  poder vender durante a contagem:
 *
 *    esperado congelado 5 · contado 3 · vendeu 1 no meio (saldo vai a 4)
 *    delta = 3 − 5 = −2, aplicado sobre 4  →  saldo final 2      ✔
 *
 *  Se o esperado fosse lido na hora do fechamento (4), o delta viraria −1 e o
 *  saldo terminaria em 3: uma peça fantasma, a que está na sacola da cliente.
 *  A conta é sempre DELTA, nunca "o saldo passa a ser o contado".
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Mesma normalização do espelho e do bipe: sem zeros à esquerda. */
export const normalizarCodigo = (v: unknown): string =>
  String(v ?? '').trim().replace(/^0+/, '');

export type SituacaoLinha = 'confere' | 'faltou' | 'sobrou';

export type LinhaContagem = {
  sku: string;
  rotulo?: string | null;
  /** Soma dos bipes da rodada que vale (bipe +1, correção −1). */
  contado: number;
  /** Saldo congelado no primeiro bipe do código. */
  esperado: number;
  /** Custo unitário congelado. `null` = peça sem custo no cadastro. */
  custo?: number | null;
};

export type LinhaClassificada = LinhaContagem & {
  /** contado − esperado. Positivo = sobrou, negativo = faltou. */
  delta: number;
  situacao: SituacaoLinha;
  /** Peças de diferença, sempre positivo. */
  pecas: number;
  /** A diferença em R$ a custo. `null` quando a peça não tem custo. */
  valor: number | null;
};

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Dinheiro em centavos inteiros — o relatório e a tela mostram o mesmo. */
const reais = (v: number): number => Math.round(v * 100) / 100;

export function classificarLinha(l: LinhaContagem): LinhaClassificada {
  const contado = Math.trunc(num(l.contado));
  const esperado = Math.trunc(num(l.esperado));
  const delta = contado - esperado;
  const custo = l.custo == null ? null : num(l.custo);
  return {
    ...l,
    contado,
    esperado,
    delta,
    situacao: delta === 0 ? 'confere' : delta < 0 ? 'faltou' : 'sobrou',
    pecas: Math.abs(delta),
    valor: custo == null ? null : reais(Math.abs(delta) * custo),
  };
}

export type ResumoContagem = {
  skus: number;
  pecasContadas: number;
  skusConferem: number;
  skusFaltou: number;
  pecasFaltou: number;
  valorFaltou: number;
  skusSobrou: number;
  pecasSobrou: number;
  valorSobrou: number;
  /** Sobrou − faltou, em peças e em R$. Negativo = a loja tem menos do que o sistema diz. */
  pecasLiquido: number;
  valorLiquido: number;
  /** Quantas linhas não têm custo no cadastro — o R$ está incompleto por elas. */
  semCusto: number;
};

export function resumirContagem(linhas: LinhaClassificada[]): ResumoContagem {
  const r: ResumoContagem = {
    skus: linhas.length,
    pecasContadas: 0,
    skusConferem: 0,
    skusFaltou: 0,
    pecasFaltou: 0,
    valorFaltou: 0,
    skusSobrou: 0,
    pecasSobrou: 0,
    valorSobrou: 0,
    pecasLiquido: 0,
    valorLiquido: 0,
    semCusto: 0,
  };
  for (const l of linhas) {
    r.pecasContadas += l.contado;
    if (l.valor == null) r.semCusto++;
    if (l.situacao === 'confere') {
      r.skusConferem++;
      continue;
    }
    if (l.situacao === 'faltou') {
      r.skusFaltou++;
      r.pecasFaltou += l.pecas;
      r.valorFaltou += l.valor ?? 0;
    } else {
      r.skusSobrou++;
      r.pecasSobrou += l.pecas;
      r.valorSobrou += l.valor ?? 0;
    }
  }
  r.valorFaltou = reais(r.valorFaltou);
  r.valorSobrou = reais(r.valorSobrou);
  r.pecasLiquido = r.pecasSobrou - r.pecasFaltou;
  r.valorLiquido = reais(r.valorSobrou - r.valorFaltou);
  return r;
}

/**
 * A matriz confere pelo DINHEIRO, não pela ordem alfabética: 1 peça de R$ 180
 * importa mais que 4 de R$ 9. Empate desce pra quantidade de peças e depois
 * pro código, pra ordem não mudar sozinha entre dois carregamentos da tela.
 */
export function ordenarPorDinheiro(linhas: LinhaClassificada[]): LinhaClassificada[] {
  return [...linhas].sort((a, b) => {
    const va = a.valor ?? 0;
    const vb = b.valor ?? 0;
    if (vb !== va) return vb - va;
    if (b.pecas !== a.pecas) return b.pecas - a.pecas;
    return a.sku.localeCompare(b.sku);
  });
}

/**
 * RECONTAR ANTES DE APLICAR.
 *
 * Erro de contagem e furto chegam na tela com a mesma cara. O que separa os
 * dois é contar de novo — e recontar 4 mil códigos não acontece, então a
 * régua aponta os poucos que pagam a recontagem: muita peça de uma vez ou
 * muito dinheiro numa linha. Sobra que passa do esperado também entra: peça
 * que "apareceu do nada" costuma ser peça marcada ou de card já bipado
 * (fisicamente na loja, fora do saldo de propósito), não peça achada.
 */
export function sugereRecontagem(
  l: LinhaClassificada,
  opts: { minPecas?: number; minValor?: number } = {},
): boolean {
  const minPecas = opts.minPecas ?? 3;
  const minValor = opts.minValor ?? 200;
  if (l.delta === 0) return false;
  if (l.pecas >= minPecas) return true;
  if ((l.valor ?? 0) >= minValor) return true;
  return false;
}

export type PlanoAjuste = {
  entradas: Array<{ sku: string; qty: number }>;
  saidas: Array<{ sku: string; qty: number }>;
};

/**
 * O que vai pro estoque. Linha que confere não gera movimento (e por isso
 * também não gera linha de histórico: inventário de loja inteira criaria
 * milhares de linhas dizendo "nada mudou").
 */
export function planoDeAjuste(linhas: LinhaClassificada[]): PlanoAjuste {
  const plano: PlanoAjuste = { entradas: [], saidas: [] };
  for (const l of linhas) {
    if (!l.delta) continue;
    const alvo = l.delta > 0 ? plano.entradas : plano.saidas;
    alvo.push({ sku: l.sku, qty: Math.abs(l.delta) });
  }
  return plano;
}
