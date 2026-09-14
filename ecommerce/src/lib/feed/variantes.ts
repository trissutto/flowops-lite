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
  /** Curadoria do site: coleção fixa "Mais Top da Semana". Vira `custom_label_1`. */
  topSemana?: boolean;
  /** Slug da coleção PONTUAL que contém a REF ('resort') — o outro `custom_label_1`. */
  colecaoSlug?: string | null;
  /**
   * Uma das últimas 25 peças CADASTRADAS, tirando as da Linha Conforto — a
   * régua do dono (14/09) para o que a campanha de loja anuncia como novidade.
   * Vira `custom_label_2`. ⚠️ Não confundir com janela de tempo: contagem não
   * esvazia quando o cadastro para, e em 14/09 já havia 18 dias sem peça nova.
   */
  novidade?: boolean;
  /** A peça está na LINHA CONFORTO. Vira `custom_label_3`. Exclui `novidade`. */
  linhaConforto?: boolean;
}

export interface Variante {
  id: string;
  cor: string;
  fotos: string[];
  tamanhos: string[];
  /** `item_group_id`. Nulo = peça de cor única, item solto como antes. */
  grupo: string | null;
}

/**
 * FOTO DO WORDPRESS APAGADO NÃO SAI NO FEED — a rede, não a cura.
 *
 * A CURA é no backend (`common/foto-viva.ts` + `montarPeca`): peça cuja
 * galeria inteira está no WordPress morto passa a sair do catálogo, e como os
 * feeds leem o catálogo ela nem chega aqui. Esta função existe porque o
 * backend e o site sobem em deploys separados e o feed fica cacheado até uma
 * hora — enquanto uma das duas pontas estiver velha, o item continuaria
 * saindo com `<g:image_link>` em `lurds.com.br/wp-content/...`, que responde
 * 403 desde 27/08/2026 e faz o Google REPROVAR o item (medido em 14/09: 48
 * dos 945 itens, mais 152 fotos extras).
 *
 * O corte é pelo CAMINHO e não pelo host: `lurds.com.br` é o site vivo.
 */
const CAMINHOS_DO_WP_MORTO = /\/wp-(content|includes)\//i;

function fotosVivas(lista: readonly (string | null | undefined)[] | null | undefined): string[] {
  return (lista ?? [])
    .map((u) => String(u ?? '').trim())
    .filter((u) => u && !CAMINHOS_DO_WP_MORTO.test(u));
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
 *
 * ⚠️ LISTA VAZIA = A PEÇA NÃO SAI (14/09/2026). Sem uma única foto que abra,
 * o item é reprovado de qualquer jeito — e é melhor não mandar do que mandar
 * quebrado. Devolver `[]` tira a peça dos DOIS feeds de uma vez, e isso é
 * requisito e não efeito colateral: o Google casa o inventário local com o
 * feed nacional **pelo `id`**, então item local sem par nacional falha calado
 * (a vitrine da loja simplesmente não aparece na ficha). O `id` de quem
 * sobrevive não muda — REF na cor principal, como sempre.
 */
export function variantes(p: PecaFeed): Variante[] {
  const fotosDaPeca = fotosVivas(p.imagens);
  const unica: Variante = {
    id: p.ref,
    cor: p.cores[0] ?? '',
    fotos: fotosDaPeca,
    tamanhos: p.tamanhos,
    grupo: null,
  };
  /* Filtra a galeria de cada cor ANTES do teste "tem foto própria": cor cuja
   * galeria inteira é do WP morto não tem foto nenhuma, e deixá-la virar item
   * geraria um anúncio sem imagem com id novo — o pior dos dois mundos. */
  const vendaveis = (p.coresDetalhe ?? [])
    .map((c) => ({ ...c, fotos: fotosVivas(c.fotos) }))
    .filter((c) => c.estoque > 0 && c.fotos.length > 0)
    .sort((a, b) => b.estoque - a.estoque);
  if (vendaveis.length < 2) return unica.fotos.length ? [unica] : [];
  return vendaveis.map((c, n) => ({
    id: n === 0 ? p.ref : `${p.ref}-${slugCor(c.nome)}`,
    cor: c.nome,
    fotos: c.fotos,
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

/**
 * O TÍTULO QUE O SHOPPING LÊ — e que hoje não diz nada.
 *
 * Medido em 27/08/2026: **561 dos 977 itens** do feed saíam com título que é
 * só a categoria — 73 peças diferentes chamadas "Blusa Manga Curta", 30
 * "Vestido Manga Curta". Para o Google, título é o principal sinal de
 * relevância do Shopping: sem Ref, sem cor e sem "plus size", a peça disputa
 * a busca errada e some da certa. O feed velho do WooCommerce, que ainda leva
 * três quartos do gasto, tem títulos como "Blusa Feminina Plus Size Manga
 * Curta Ref 207372 Preto" — e é ele que converte.
 *
 * A ordem segue o que o Google recomenda para vestuário: tipo da peça,
 * público, atributo (cor), identificador e marca. Nada promocional — "frete
 * grátis" e afins reprovam o item, e a caixa alta em excesso também, por isso
 * a cor vem capitalizada e não como o ERP a entrega ("PRETO").
 *
 * A vitrine NÃO usa isto: `p.nome` continua sendo o nome da peça no site.
 * Aqui é só o rótulo do anúncio.
 */
export function tituloShopping(p: PecaFeed, v: Variante): string {
  const partes: string[] = [p.nome.trim()];
  /**
   * A comparação é por texto simples, sem acento e sem caixa — nunca por
   * regex montada com o nome da peça dentro. Nome de cadastro vem com `(`,
   * `+` e `*`, e isso explodiria na hora de gerar o feed inteiro.
   */
  const simples = (t: string) =>
    String(t ?? '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase();
  const jaTem = (t: string) => simples(partes.join(' ')).includes(simples(t));

  // "Plus size" é o que a cliente digita. Nome que já traz, não repete.
  if (!jaTem('plus size') && !jaTem('plussize')) partes.push('Plus Size');
  if (v.cor && !jaTem(v.cor)) partes.push(capitalizar(v.cor));
  // A Ref é como a loja e a cliente se referem à peça no WhatsApp.
  if (p.ref && !jaTem(`ref ${p.ref}`)) partes.push(`Ref ${p.ref}`);
  const marca = (p.marca || '').trim();
  if (marca && !jaTem(marca)) partes.push(marca);

  // Teto do Google é 150; o que decide é o começo, então cortar o fim é seguro.
  return partes.join(' ').replace(/\s+/g, ' ').trim().slice(0, 150).trim();
}

/** "PRETO" → "Preto"; "AZUL MARINHO" → "Azul Marinho". */
function capitalizar(texto: string): string {
  return String(texto ?? '')
    .toLocaleLowerCase('pt-BR')
    .split(/\s+/)
    .filter(Boolean)
    .map((palavra) => palavra.charAt(0).toLocaleUpperCase('pt-BR') + palavra.slice(1))
    .join(' ');
}
