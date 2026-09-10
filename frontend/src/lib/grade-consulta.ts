/**
 * GRADE cor × tamanho da Consulta (/minha-loja/consultar) — a parte que
 * decide O QUE CADA CÉLULA MOSTRA, fora do componente pra ter teste
 * (`npm run test:grade-consulta`).
 *
 * Regra (10/09/2026, REF 22 de Itanhaém): a célula é a SOMA de todos os
 * códigos que caem naquela cor×tamanho — e por isso bate SEMPRE com a linha
 * Total. Antes o mapa fazia `set(tam, v)`: o último código sobrescrevia o
 * anterior enquanto os totais somavam os dois, e a célula do 14 dizia 23
 * com o Total do 14 dizendo 32 — e a peça que a vendedora procurava
 * (camiseta manga curta) em ZERO na arara. Dois códigos na mesma célula é
 * REF compartilhada por produtos diferentes ou duplicidade de cadastro: o
 * backend evita (dedup + balde por marca/família), mas a tela não pode
 * depender disso pra não mentir.
 */
export interface VarianteGrade {
  sku: string;
  cor: string;
  tamanho: string;
  myStoreQty: number;
  preco?: number | null;
}

export interface CelulaGrade {
  /** Código PRINCIPAL da célula (o de mais estoque) — preço e hover saem dele. */
  sku: string;
  cor: string;
  tamanho: string;
  /** SOMA de todos os códigos da célula. */
  myStoreQty: number;
  preco: number | null;
  /** Todos os códigos que caem nesta cor×tamanho — 1 no caso normal. */
  skus: string[];
}

export interface GradeConsulta {
  /** cor → tamanho → célula */
  celulas: Map<string, Map<string, CelulaGrade>>;
  totalsByColor: Map<string, number>;
  totalsBySize: Map<string, number>;
  /** Na ordem de chegada — quem chama ordena (tamanho tem régua própria). */
  cores: string[];
  tamanhos: string[];
}

/** Rótulo da cor/tamanho na grade: vazio vira "—" (é a chave da célula). */
export const rotuloGrade = (s: string | null | undefined): string => (s || '—').trim();

export function montarGradeConsulta(variants: VarianteGrade[]): GradeConsulta {
  const celulas = new Map<string, Map<string, CelulaGrade>>();
  const totalsByColor = new Map<string, number>();
  const totalsBySize = new Map<string, number>();
  const cores: string[] = [];
  const tamanhos: string[] = [];
  // Quantidade do código principal de cada célula — decide quem manda no
  // preço/hover quando há 2+ códigos na mesma cor×tamanho.
  const qtdPrincipal = new Map<CelulaGrade, number>();

  for (const v of variants) {
    const cor = rotuloGrade(v.cor);
    const tam = rotuloGrade(v.tamanho);
    const qty = Number(v.myStoreQty) || 0;
    if (!celulas.has(cor)) {
      celulas.set(cor, new Map());
      cores.push(cor);
    }
    if (!tamanhos.includes(tam)) tamanhos.push(tam);

    const linha = celulas.get(cor)!;
    const atual = linha.get(tam);
    if (!atual) {
      const celula: CelulaGrade = {
        sku: v.sku, cor, tamanho: tam, myStoreQty: qty, preco: v.preco ?? null, skus: [v.sku],
      };
      linha.set(tam, celula);
      qtdPrincipal.set(celula, qty);
    } else {
      atual.myStoreQty += qty;
      atual.skus.push(v.sku);
      if (qty > (qtdPrincipal.get(atual) ?? 0)) {
        atual.sku = v.sku;
        atual.preco = v.preco ?? null;
        qtdPrincipal.set(atual, qty);
      }
    }
    totalsByColor.set(cor, (totalsByColor.get(cor) || 0) + qty);
    totalsBySize.set(tam, (totalsBySize.get(tam) || 0) + qty);
  }

  return { celulas, totalsByColor, totalsBySize, cores, tamanhos };
}
