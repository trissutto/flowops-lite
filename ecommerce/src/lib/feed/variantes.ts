/**
 * A IDENTIDADE DO ITEM NO GOOGLE — uma regra, dois feeds.
 *
 * Morava dentro de `app/feed/google.xml/route.ts`. Saiu de lá em 23/08/2026,
 * quando nasceu o feed de INVENTÁRIO LOCAL (`google-local.xml`), porque o
 * Google casa os dois **pelo `id`** e id divergente falha do pior jeito: sem
 * erro em lugar nenhum, a vitrine local simplesmente não aparece na ficha da
 * loja e ninguém descobre por quê.
 *
 * Duas cópias desta função divergiriam no primeiro ajuste. Uma só, importada
 * pelos dois, não tem como.
 */

export interface PecaFeed {
  ref: string;
  slug: string;
  nome: string;
  descricao: string | null;
  marca: string | null;
  categoria: string | null;
  subcategoria: string | null;
  preco: number;
  precoPromocional: number | null;
  disponivel: boolean;
  imagens: string[];
  tamanhos: string[];
  cores: string[];
  /** Estoque, fotos, preço e grade POR COR — a matéria-prima da explosão. */
  coresDetalhe?: Array<{
    nome: string;
    estoque: number;
    preco: number;
    fotos: string[];
    tamanhos: string[];
  }>;
}

export interface Variante {
  id: string;
  cor: string;
  fotos: string[];
  tamanhos: string[];
  /** `item_group_id`. Nulo = peça de cor única, item solto como antes. */
  grupo: string | null;
}

export function slugCor(nome: string): string {
  return String(nome ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * UM ITEM POR COR — a mesma regra da vitrine e do feed do Meta.
 *
 * Para vestuário o Google ESPERA variação: peça multicor num item só é
 * estrutura incompleta pra ele, e a cliente via um anúncio "PRETO" cuja
 * segunda foto era bege.
 *
 * 🔑 A COR DE MAIOR ESTOQUE HERDA O `id` DA REF.
 *
 * Só entra cor COM foto própria e COM estoque. Peça que ainda serve foto do
 * acervo antigo não tem foto por cor e sai como item único, exatamente como
 * antes: a virada não multiplica item reprovado.
 */
export function variantes(p: PecaFeed): Variante[] {
  const unica: Variante = {
    id: p.ref,
    cor: p.cores[0] ?? '',
    fotos: p.imagens.filter(Boolean),
    tamanhos: p.tamanhos,
    grupo: null,
  };
  const vendaveis = (p.coresDetalhe ?? [])
    .filter((c) => c.estoque > 0 && (c.fotos?.length ?? 0) > 0)
    .sort((a, b) => b.estoque - a.estoque);
  if (vendaveis.length < 2) return [unica];
  return vendaveis.map((c, n) => ({
    id: n === 0 ? p.ref : `${p.ref}-${slugCor(c.nome)}`,
    cor: c.nome,
    fotos: c.fotos.filter(Boolean),
    tamanhos: c.tamanhos?.length ? c.tamanhos : p.tamanhos,
    grupo: p.ref,
  }));
}

/**
 * Cor crua do ERP → chave de comparação.
 *
 * O feed nacional carrega a cor vinda de `coresDetalhe[].nome`; o estoque por
 * loja carrega a coluna `cor` de `wincred_produtos`. É a MESMA origem, mas
 * passa por caminhos diferentes e chega com espaço, acento e caixa variando.
 * Sem normalizar, "CAFÉ" e "CAFE" viram lojas diferentes e a peça some da
 * vitrine local — o mesmo tipo de armadilha do `\b` no nome de vitrine.
 */
export function chaveDeCor(nome: string | null | undefined): string {
  return String(nome ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toUpperCase();
}
