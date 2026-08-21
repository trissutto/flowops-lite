import { api } from '@/lib/api';
import type { SkuRow } from './types';

/**
 * A busca da tela de Produtos.
 *
 * Usa o mesmo motor que Master e Consulta padronizaram em 03/08
 * (`resolveRows`), pelo endpoint `ficha-search` — que é a `search` do editor
 * com uma diferença: ele não exige admin, e PODA custo e margem no servidor
 * pra quem não é matriz.
 *
 * ⚠️ REF SOZINHA NÃO IDENTIFICA A PEÇA. REF numérica é reciclada entre
 * fornecedores, então a identidade é REF + MARCA — é por isso que
 * `agruparPorPeca` agrupa pelas duas, e que a ficha exige `marca` na URL.
 */

export interface RespostaBusca {
  rows?: SkuRow[];
  fonte?: string;
  classificacao?: Array<{ ref: string; tipoProduto: number }>;
}

/** `tipoProduto`: 0 = MODA, 1 = BÁSICO. Sem registro = MODA. */
export type Classe = 'MODA' | 'BASICO';

export function classeDaRef(
  ref: string,
  classificacao?: Array<{ ref: string; tipoProduto: number }>,
): Classe {
  const c = (classificacao || []).find((x) => x.ref === ref);
  return c?.tipoProduto === 1 ? 'BASICO' : 'MODA';
}

export interface Peca {
  /** identidade de verdade: REF + MARCA */
  chave: string;
  ref: string;
  marca: string;
  nome: string;
  cores: string[];
  tamanhos: string[];
  precoMin: number | null;
  precoMax: number | null;
  custo: number | null;
  margem: number | null;
  estoque: number;
  estoqueLojas: Record<string, number>;
  skus: SkuRow[];
}

/**
 * Nome curto = descrição sem o que já tem coluna própria (cor, tamanho, ref e
 * marca). O sistema COMPÔS a descrição com esses pedaços no pedido de compra,
 * então tirar é seguro.
 */
export function nomeCurto(row: SkuRow): string {
  const partes = [row.cor, row.tamanho, row.ref, row.marca ?? ''].filter(Boolean);
  let texto = ` ${row.descricao} `.toUpperCase();
  for (const p of partes) {
    const escapado = p.toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    texto = texto.split(new RegExp(`\\b${escapado}\\b`, 'g')).join(' ');
  }
  return texto.replace(/\s+/g, ' ').trim() || row.descricao;
}

export function chaveDaPeca(ref: string, marca: string | null): string {
  return `${ref}::${(marca || '').trim().toUpperCase()}`;
}

/** Agrupa as variações (cor × tamanho) na PEÇA — REF + MARCA. */
export function agruparPorPeca(rows: SkuRow[]): Peca[] {
  const mapa = new Map<string, Peca>();
  for (const r of rows) {
    if (!r.ref) continue;
    const marca = (r.marca || '').trim();
    const chave = chaveDaPeca(r.ref, marca);
    let p = mapa.get(chave);
    if (!p) {
      p = {
        chave, ref: r.ref, marca,
        nome: nomeCurto(r),
        cores: [], tamanhos: [],
        precoMin: null, precoMax: null,
        custo: null, margem: null,
        estoque: 0, estoqueLojas: {}, skus: [],
      };
      mapa.set(chave, p);
    }
    p.skus.push(r);
    if (r.cor && !p.cores.includes(r.cor)) p.cores.push(r.cor);
    if (r.tamanho && !p.tamanhos.includes(r.tamanho)) p.tamanhos.push(r.tamanho);
    if (typeof r.preco === 'number') {
      p.precoMin = p.precoMin == null ? r.preco : Math.min(p.precoMin, r.preco);
      p.precoMax = p.precoMax == null ? r.preco : Math.max(p.precoMax, r.preco);
    }
    /* custo/margem são da peça, não da variação — o primeiro que vier serve */
    if (p.custo == null && typeof r.custo === 'number') p.custo = r.custo;
    if (p.margem == null && typeof r.margem === 'number') p.margem = r.margem;
    p.estoque += r.estoque ?? 0;
    for (const [loja, qtd] of Object.entries(r.estoqueLojas ?? {})) {
      p.estoqueLojas[loja] = (p.estoqueLojas[loja] || 0) + qtd;
    }
  }
  return [...mapa.values()].sort(
    (a, b) => a.ref.localeCompare(b.ref) || a.marca.localeCompare(b.marca),
  );
}

/**
 * Busca com a rede de segurança do Master: quando a pessoa digita "REF + cor"
 * e a REF não tem aquela cor, a busca por TODAS as palavras devolve zero.
 * Repete só com a primeira palavra e devolve o aviso pra tela explicar.
 */
export async function buscarPecas(
  termo: string,
): Promise<{ rows: SkuRow[]; classificacao: RespostaBusca['classificacao']; aviso: string | null }> {
  const q = termo.trim();
  if (q.length < 2) throw new Error('Digite ao menos 2 caracteres');

  /* ⚠️ devolve { rows, ... }, não o array puro — jogar a resposta inteira no
     estado já derrubou a tela inteira com "a is not iterable". */
  const resp = await api<RespostaBusca>(`/products-editor/ficha-search?q=${encodeURIComponent(q)}`);
  let rows = resp?.rows ?? [];
  let aviso: string | null = null;

  const palavras = q.split(/\s+/).filter(Boolean);
  if (rows.length === 0 && palavras.length > 1) {
    const so1 = await api<RespostaBusca>(
      `/products-editor/ficha-search?q=${encodeURIComponent(palavras[0])}`,
    );
    if (so1?.rows?.length) {
      rows = so1.rows;
      aviso =
        `Nada bateu com "${q}" — mostrando "${palavras[0]}". ` +
        `Confira nas cores se "${palavras.slice(1).join(' ')}" existe nessa REF.`;
    }
  }

  return { rows, classificacao: resp?.classificacao, aviso };
}
