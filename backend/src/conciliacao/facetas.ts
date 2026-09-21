/**
 * OS NÚMEROS DE CIMA OBEDECEM OS FILTROS — pedido do dono em 21/09: "filtrei
 * Itanhaém e lá em cima não mudou nada… clicou Itanhaém, já aparece tudo de
 * Itanhaém".
 *
 * Até ali só a LISTA filtrava: cartões de status, chips de gateway e chips de
 * origem eram sempre o total da rede, então a tela mostrava duas verdades ao
 * mesmo tempo (39 divergentes em cima, lista de uma loja só embaixo).
 *
 * Regra das facetas (a de qualquer loja online): cada grupo conta com TODOS os
 * outros filtros aplicados, menos o dele próprio — é o que deixa ver "quantos
 * divergentes ESTA loja tem" sem sumir com os outros cartões, e trocar de um
 * pro outro num clique. O `total` é o recorte inteiro: todos os filtros juntos.
 *
 * Puro de propósito: a conta é feita em memória sobre ~3 mil linhas pagas
 * (cresce ~15/dia), e assim tem spec sem banco.
 */

export interface LinhaResumo {
  status: string;
  gateway: string;
  origem: string | null;
  storeCode: string | null;
  cents: number;
  /**
   * Dia da venda em BRASÍLIA ('YYYY-MM-DD'). Já vem convertido por quem monta a
   * linha (`diaBrasiliaDe`): PIX das 22h30 está gravado como 01h30 UTC do dia
   * SEGUINTE, e comparar pelo dia UTC jogaria a noite inteira no dia errado.
   */
  dia?: string | null;
}

export interface FiltrosConciliacao {
  status?: string | null;
  gateway?: string | null;
  origem?: string | null;
  storeCode?: string | null;
  /** Período em dias de Brasília, `from` e `to` INCLUSOS ('YYYY-MM-DD'). Vazio = sem limite daquele lado. */
  from?: string | null;
  to?: string | null;
}

export interface ResumoFacetado {
  conciliacoes: Array<{ status: string; qtd: number }>;
  gateways: Array<{ gateway: string; qtd: number; cents: number }>;
  origens: Array<{ origem: string; qtd: number; cents: number }>;
  lojas: Array<{ storeCode: string; qtd: number }>;
  total: { qtd: number; cents: number };
}

type Campo = 'status' | 'gateway' | 'origem' | 'storeCode';
const CAMPOS: Campo[] = ['status', 'gateway', 'origem', 'storeCode'];

const limpo = (v: string | null | undefined) => String(v ?? '').trim();

/**
 * O input de data dispara com ano PARCIAL enquanto a pessoa digita
 * ("0002-09-21") — data torta é ignorada em vez de zerar a tela. De > Até
 * (clicou nos campos na ordem trocada) vale como o intervalo entre as duas.
 */
const DIA_ISO = /^(19|20)\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
export function periodoDosFiltros(f: FiltrosConciliacao): { from: string | null; to: string | null } {
  const from = DIA_ISO.test(limpo(f.from)) ? limpo(f.from) : null;
  const to = DIA_ISO.test(limpo(f.to)) ? limpo(f.to) : null;
  return from && to && from > to ? { from: to, to: from } : { from, to };
}

/**
 * O predicado ÚNICO do recorte — a lista e os números de cima passam por aqui,
 * então não têm como discordar. `ignorar` tira UM campo da conta (é o que faz
 * cada grupo de chips continuar mostrando as alternativas dele). O período não
 * é grupo de chips: vale sempre.
 */
function montarPredicado(filtros: FiltrosConciliacao) {
  const ativos = CAMPOS.filter((c) => limpo(filtros[c])).map((c) => [c, limpo(filtros[c])] as const);
  const { from, to } = periodoDosFiltros(filtros);
  return (l: LinhaResumo, ignorar?: Campo) => {
    if (from || to) {
      const dia = limpo(l.dia);
      // Linha sem data não pertence a período nenhum.
      if (!dia || (from && dia < from) || (to && dia > to)) return false;
    }
    return ativos.every(([campo, valor]) => campo === ignorar || limpo(l[campo]) === valor);
  };
}

/** As linhas do recorte, com TODOS os filtros — é o que a lista pagina. */
export function filtrarLinhas<T extends LinhaResumo>(linhas: T[], filtros: FiltrosConciliacao): T[] {
  const passa = montarPredicado(filtros);
  return linhas.filter((l) => passa(l));
}

export function facetarConciliacoes(linhas: LinhaResumo[], filtros: FiltrosConciliacao): ResumoFacetado {
  const passa = montarPredicado(filtros);

  const contar = (campo: Campo) => {
    const mapa = new Map<string, { qtd: number; cents: number }>();
    for (const l of linhas) {
      const chave = limpo(l[campo]);
      if (!chave || !passa(l, campo)) continue;
      const atual = mapa.get(chave) || { qtd: 0, cents: 0 };
      atual.qtd += 1;
      atual.cents += l.cents || 0;
      mapa.set(chave, atual);
    }
    return [...mapa.entries()].sort(([a], [b]) => a.localeCompare(b));
  };

  const total = { qtd: 0, cents: 0 };
  for (const l of linhas) {
    if (!passa(l)) continue;
    total.qtd += 1;
    total.cents += l.cents || 0;
  }

  return {
    conciliacoes: contar('status').map(([status, n]) => ({ status, qtd: n.qtd })),
    gateways: contar('gateway').map(([gateway, n]) => ({ gateway, ...n })),
    origens: contar('origem').map(([origem, n]) => ({ origem, ...n })),
    lojas: contar('storeCode').map(([storeCode, n]) => ({ storeCode, qtd: n.qtd })),
    total,
  };
}
