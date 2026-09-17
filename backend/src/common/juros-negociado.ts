/**
 * JUROS NEGOCIADO NO BALCÃO — a redução, numa régua só (dono, 17/09/2026).
 *
 * A parcela atrasada chega na tela de Recebimentos com o juros que a regra da
 * casa calculou (`CrediarioBaixaService.calcJuros`: taxa/mês dia a dia +
 * multa, com carência e teto). Só que quem recebe negocia: "paga o principal
 * que eu tiro metade do juros". Antes disso existir, a loja não tinha como
 * fazer a conta no sistema — ou cobrava o juros cheio, ou baixava a parcela
 * por fora e o recibo mentia.
 *
 * ── O QUE ESTA RÉGUA FAZ ──
 *
 * Um desconto em % que incide SÓ sobre o juros, nunca sobre o principal, e é
 * aplicado LINHA A LINHA (parcela a parcela), do mesmo jeito que o juros nasce.
 * Somar o desconto no total e depois ratear daria diferença de centavo entre o
 * que o recibo mostra e o que cada parcela leva pro histórico do cliente.
 *
 * ⚠️ 100% de desconto zera o JUROS, não a dívida: o principal continua inteiro.
 * É a diferença entre "perdoei o juros" e "perdoei a parcela" — a segunda não
 * existe aqui e não pode nascer de um arredondamento.
 */

export interface JurosNegociado {
  /** % de desconto que valeu (já normalizado: 0–100, 2 casas). */
  pct: number;
  /** Juros COBRADO de cada parcela, na ordem que entrou. */
  jurosCobrado: number[];
  /** Soma do juros que a regra calculou (antes da negociação). */
  totalCheio: number;
  /** Soma do juros que a cliente paga. */
  totalCobrado: number;
  /** Quanto a loja abriu mão (cheio − cobrado). */
  desconto: number;
}

export const PCT_MAX = 100;

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

/** 0–100 com 2 casas. Lixo (texto, NaN, negativo) vira 0 = sem desconto. */
export function normalizarPctDesconto(v: unknown): number {
  const n = Number(String(v ?? '').toString().replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(PCT_MAX, Math.round(n * 100) / 100);
}

/**
 * Aplica o desconto no juros de cada parcela.
 *
 * Parcela sem juros (em dia, ou dentro da carência) continua sem juros — o
 * desconto não inventa crédito em cima de zero.
 */
export function aplicarDescontoJuros(jurosCheio: Array<number | null | undefined>, pctPedido: unknown): JurosNegociado {
  const pct = normalizarPctDesconto(pctPedido);
  const cheios = jurosCheio.map((j) => Math.max(0, round2(Number(j) || 0)));
  const fator = (100 - pct) / 100;
  const jurosCobrado = cheios.map((j) => (j > 0 ? round2(j * fator) : 0));
  const totalCheio = round2(cheios.reduce((s, j) => s + j, 0));
  const totalCobrado = round2(jurosCobrado.reduce((s, j) => s + j, 0));
  return {
    pct,
    jurosCobrado,
    totalCheio,
    totalCobrado,
    desconto: round2(totalCheio - totalCobrado),
  };
}

/**
 * O % que chega mais perto de um juros final em REAIS — é o que deixa a
 * vendedora digitar "o juros fica R$ 50" em vez de calcular a porcentagem de
 * cabeça.
 *
 * O valor final EXATO sai de `aplicarDescontoJuros` com esse %: como o
 * arredondamento é por parcela, o alvo pode sair um centavo diferente, e quem
 * manda é o que a conta devolve (a tela mostra esse número antes de aplicar).
 */
export function pctParaJurosAlvo(jurosCheio: Array<number | null | undefined>, alvoReais: unknown): number {
  const totalCheio = round2(
    jurosCheio.reduce<number>((s, j) => s + Math.max(0, Number(j) || 0), 0),
  );
  if (totalCheio <= 0) return 0;
  const alvo = Math.max(0, Number(String(alvoReais ?? '').toString().replace(',', '.')) || 0);
  if (alvo >= totalCheio) return 0;
  const pct = (1 - alvo / totalCheio) * 100;
  return normalizarPctDesconto(pct);
}

/** Frase curta pro recibo e pra tela ("50% de desconto no juros"). */
export function rotuloDesconto(n: JurosNegociado): string {
  if (n.pct <= 0 || n.desconto <= 0) return '';
  const valor = n.desconto.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  return n.pct >= 100 ? `juros perdoado (${valor})` : `${n.pct}% de desconto no juros (${valor})`;
}
