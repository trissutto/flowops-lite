/**
 * A GRADE DA CATEGORIA AGRUPADA PELAS SUBCATEGORIAS (dono, 31/08/2026).
 *
 * ── O PROBLEMA ──
 *
 * "Linha Conforto" não é uma família de peça: é uma CAMPANHA montada por cima
 * do catálogo (`categoriasExtras`). Em 31/08 ela tinha 36 blusas e 3 vestidos,
 * e a página abria em NOVIDADES — a ordem certa pra "Blusas", onde a cliente
 * volta toda semana pra ver o que entrou, e a errada aqui: os três vestidos
 * caíam espalhados no meio das blusas, pela data em que cada um subiu. Quem
 * abria a linha rolava a página inteira sem perceber que ela tem duas coisas
 * dentro.
 *
 * ── A REGRA ──
 *
 * A peça cai no BLOCO da primeira subcategoria da ordem em que ela se encaixa,
 * e os blocos saem na `ordem` que o dono já configurou em `SiteCategoria`
 * (`blusas-conforto` = 1, `vestidos-conforto` = 2) — a MESMA ordem dos chips
 * de filtro no topo da página. Grade e chips contando histórias diferentes é
 * o tipo de divergência que já custou caro aqui (o chip que pintava de dourado
 * e não filtrava nada, 10/08).
 *
 * Dentro do bloco nada muda: o `sort` é ESTÁVEL, então a novidade continua
 * abrindo as blusas e a novidade continua abrindo os vestidos.
 *
 * ── PRINCIPAL **OU** EXTRA, E A PRIMEIRA QUE CASAR ──
 *
 * Na campanha a subcategoria que interessa quase nunca é a principal: a blusa
 * VOGUE tem `subcategoria = 'manga-curta'` (filha de *Blusas*) e carrega
 * `blusas-conforto` nas EXTRAS. Olhar só a principal deixaria 31 das 36 blusas
 * fora de qualquer bloco. Peça marcada nas duas famílias cai na primeira da
 * ordem — arbitrário, mas determinístico, e melhor que aparecer duas vezes.
 *
 * Peça que não está em NENHUMA das subcategorias vai pro fim da fila. É o
 * comportamento honesto: ela realmente não foi classificada, e ficar visível
 * depois dos blocos é o que faz alguém notar e classificar.
 */

export interface PecaComSubcategoria {
  subcategoria?: string | null;
  subcategoriasExtras?: string[] | null;
}

/** Slug comparável — a mesma normalização da taxonomia do catálogo. */
export function slugSub(v?: string | null): string {
  return String(v ?? '').trim().toLowerCase();
}

/**
 * Em que bloco a peça cai: o índice da PRIMEIRA subcategoria da `ordem` que
 * ela tem (principal ou extra). Fora de todas = `ordem.length`, o fim.
 */
export function blocoDaPeca(peca: PecaComSubcategoria, ordem: string[]): number {
  const minhas = new Set<string>();
  const principal = slugSub(peca?.subcategoria);
  if (principal) minhas.add(principal);
  for (const extra of Array.isArray(peca?.subcategoriasExtras) ? peca.subcategoriasExtras : []) {
    const s = slugSub(extra);
    if (s) minhas.add(s);
  }
  for (let i = 0; i < ordem.length; i++) {
    if (minhas.has(slugSub(ordem[i]))) return i;
  }
  return ordem.length;
}

/**
 * A ORDEM FINAL DA GRADE DE UMA CATEGORIA: bloco primeiro, curadoria depois.
 *
 * ⚠️ POR QUE O BLOCO GANHA DA POSIÇÃO MANUAL (31/08). A Linha Conforto já
 * tinha ordem gravada em `/retaguarda/ordem-vitrine`, e ela ABRIA com
 * VMS-223 e VLM-222 — os dois vestidos. Se a posição valesse por cima, ligar
 * "blusas antes de vestidos" não mudaria NADA na página: a curadoria antiga
 * venceria calada e o botão novo pareceria quebrado. É a armadilha do "não
 * mudou nada" que este repositório já pagou caro.
 *
 * E a curadoria não se perde — ela passa a ordenar DENTRO da família: as
 * blusas posicionadas à mão abrem as blusas, os vestidos abrem os vestidos.
 *
 * Ordena in-place (o array já é cópia de quem chama, igual ao resto da
 * ordenação da vitrine). Sem `subs` e sem `posicaoManual` não faz nada.
 */
export function ordenarGradeDaCategoria<T extends PecaComSubcategoria>(
  pecas: T[],
  opcoes: {
    /** Subcategorias da categoria, na ordem configurada. Vazio = não agrupa. */
    subs?: string[];
    /** Posição da REF na ordem manual; `null`/`undefined` = não posicionada. */
    posicaoManual?: (peca: T) => number | null | undefined;
  } = {},
): T[] {
  const subs = (opcoes.subs ?? []).map(slugSub).filter(Boolean);
  const posicao = opcoes.posicaoManual;
  if (!subs.length && !posicao) return pecas;
  // Bloco calculado UMA vez por peça: o comparador roda O(n log n) vezes e
  // remontar o Set de subcategorias lá dentro é trabalho repetido à toa.
  const bloco = subs.length
    ? new Map<T, number>(pecas.map((p) => [p, blocoDaPeca(p, subs)] as const))
    : null;
  pecas.sort((a, b) => {
    if (bloco) {
      const d = (bloco.get(a) ?? subs.length) - (bloco.get(b) ?? subs.length);
      if (d) return d;
    }
    if (posicao) {
      const pa = posicao(a);
      const pb = posicao(b);
      if (pa != null && pb != null) return pa - pb;
      if (pa != null) return -1;
      if (pb != null) return 1;
    }
    // Empate = fica como estava. O sort é estável, então a ordenação de cima
    // (novidades, relevância) segue valendo dentro de cada bloco.
    return 0;
  });
  return pecas;
}
