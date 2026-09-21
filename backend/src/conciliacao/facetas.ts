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
}

export interface FiltrosConciliacao {
  status?: string | null;
  gateway?: string | null;
  origem?: string | null;
  storeCode?: string | null;
}

export interface ResumoFacetado {
  conciliacoes: Array<{ status: string; qtd: number }>;
  gateways: Array<{ gateway: string; qtd: number; cents: number }>;
  origens: Array<{ origem: string; qtd: number; cents: number }>;
  lojas: Array<{ storeCode: string; qtd: number }>;
  total: { qtd: number; cents: number };
}

type Campo = keyof FiltrosConciliacao;
const CAMPOS: Campo[] = ['status', 'gateway', 'origem', 'storeCode'];

const limpo = (v: string | null | undefined) => String(v ?? '').trim();

export function facetarConciliacoes(linhas: LinhaResumo[], filtros: FiltrosConciliacao): ResumoFacetado {
  const ativos = CAMPOS.filter((c) => limpo(filtros[c])).map((c) => [c, limpo(filtros[c])] as const);
  const passa = (l: LinhaResumo, ignorar?: Campo) =>
    ativos.every(([campo, valor]) => campo === ignorar || limpo(l[campo]) === valor);

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
