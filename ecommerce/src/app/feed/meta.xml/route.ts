import { SITE } from '@/lib/seo';
import { feedIndisponivel, lerListaDoBackend, respostaDoFeed } from '@/lib/feed/leitura';
import { linkDoItem } from '@/lib/feed/variantes';

/**
 * FEED DE PRODUTOS DO META — o que destrava o anúncio dinâmico.
 *
 * Endereço pra cadastrar no Meta:
 *   Commerce Manager → Catálogo → Fontes de dados → Feed agendado
 *   https://<dominio>/feed/meta.xml
 *   (hoje o catálogo 1286815124507399 lê de HORA EM HORA — conferido na
 *   auditoria de 04/10/2026; este cabeçalho dizia "1× por dia")
 *
 * Sem catálogo cadastrado, o Meta não consegue rodar **anúncio dinâmico** —
 * aquele que mostra pra cliente exatamente a peça que ela olhou e não
 * comprou. Em moda é geralmente a campanha de melhor retorno, e o pixel já
 * manda tudo que ela precisa (`content_ids`, `contents`): faltava o outro
 * lado, o catálogo.
 *
 * ── A REGRA QUE FAZ ISSO FUNCIONAR OU NÃO ──
 *
 * O `<g:id>` da cor PRINCIPAL é a REF crua, idêntico ao `content_ids` que o
 * pixel dispara — é o que mantém evento e catálogo casando depois que a peça
 * passou a sair uma vez por cor (21/08). As cores adicionais levam sufixo e
 * não recebem evento do site; quem representa a família no retargeting é a
 * principal. Ver `variantes()`.
 * O pixel manda `sku || product_id`, e `mapPeca` preenche os dois com a REF —
 * então o id do feed é a REF, e nada mais. Se divergir, o Meta recebe os
 * eventos, recebe o catálogo, e não casa um com o outro: o anúncio dinâmico
 * fica sem produto pra mostrar, sem nenhum erro em lugar nenhum. É o erro
 * mais comum de catálogo e o mais difícil de enxergar.
 *
 * ── ESGOTADO ENTRA NO FEED ──
 *
 * De propósito, com `availability: out of stock`. Peça esgotada para de ser
 * anunciada e volta sozinha quando reabastece. Se ela SUMISSE do feed, o Meta
 * a trataria como produto morto e o aprendizado recomeçaria do zero quando
 * voltasse.
 *
 * RSS 2.0 (e não CSV) porque o catálogo tem acento, aspas e "&" em nome de
 * peça — em CSV isso vira campo quebrado; em XML, `escapar()` resolve.
 */

/**
 * O FEED NÃO ENTRA NO CACHE DE PÁGINA — a proteção que nasceu no feed do
 * Google em 14/09/2026 (o incidente está escrito lá por inteiro): resposta
 * nascida de falha não pode ser GUARDADA. Quem decide o que pode ser guardado
 * é o `Cache-Control` do GET, por execução.
 *
 * ── 04/10/2026: SEM DATA CACHE, E FALHA VIROU 503 ──
 *
 * Aqui havia um `revalidate = 3600` no `fetch` do catálogo (e antes dele um
 * ISR de 24 h, que manteve o feed em 60 peças mesmo depois do fix do backend,
 * em 13/08). O catálogo agora é lido fresco a cada regeneração e a única
 * cópia guardada é a da CDN, por 15 min — a conta e o porquê do 503 no lugar
 * do feed vazio estão em `lib/feed/leitura.ts`. O backend guarda o catálogo
 * em memória por 60 s, então regenerar custa no máximo ~4 requests por hora.
 */
export const dynamic = 'force-dynamic';

interface PecaFeed {
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
  topSemana?: boolean;
  /** Slug da coleção PONTUAL que contém a REF ('resort') — vira carimbo do feed. */
  colecaoSlug?: string | null;
  lancamento?: boolean;
  /** Quantidade em estoque somada — o critério das vitrines. Ver `carimbarTop30`. */
  estoqueTotal?: number;
}

/** `&` vira `&amp;` etc. Sem isto, um nome com "&" invalida o XML inteiro. */
function escapar(v: string): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** O Meta exige moeda junto do número: "199.90 BRL". Ponto, não vírgula. */
function dinheiro(v: number): string {
  return `${(Number(v) || 0).toFixed(2)} BRL`;
}

const ROTULO_CATEGORIA: Record<string, string> = {
  calcas: 'Calças',
  macacoes: 'Macacões',
  'moda-praia': 'Moda praia',
  lingerie: 'Lingerie',
  pijamas: 'Pijamas',
};

function rotulo(slug: string | null): string {
  const s = String(slug || '').trim();
  if (!s) return 'Moda plus size';
  if (ROTULO_CATEGORIA[s]) return ROTULO_CATEGORIA[s];
  const limpo = s.replace(/[-_]+/g, ' ');
  return limpo.charAt(0).toUpperCase() + limpo.slice(1);
}

/**
 * AS 20 MAIS NOVAS DE CADA CATEGORIA — `custom_label_2`.
 *
 * O conjunto de produtos do Meta é um FILTRO, não uma consulta: ele sabe
 * responder "todas as blusas", nunca "as 20 blusas mais novas". Não existe
 * ordenar-e-cortar no filtro dele, e o feed também não manda data nenhuma.
 * Quem sabe quais são as 20 mais novas é este feed — o backend já devolve o
 * catálogo ordenado por `novidades` (publicado_em desc), então basta contar
 * de cima e carimbar as primeiras. O conjunto no Meta vira um `eq` bobo no
 * carimbo e a rotação acontece sozinha: peça nova entra no topo, a 21ª sai do
 * carimbo, e na leitura seguinte do feed o conjunto já está trocado.
 *
 * `custom_label_2` porque a 0 é o slug da subcategoria (acima) e a 1 fica de
 * reserva pra não brigar com conjunto que alguém já tenha criado na mão.
 *
 * SÓ PEÇA DISPONÍVEL entra na conta. Esgotado continua no feed (ver o
 * cabeçalho), mas não pode ocupar uma das 20 vagas do anúncio: gastaria
 * vitrine com peça que não vende e encolheria o conjunto na prática.
 */
const NOVIDADES_TETO = 20;

/**
 * O CARIMBO SAI DO PRÓPRIO SLUG DA CATEGORIA (25/08/2026).
 *
 * Até aqui isto era um mapa fixo com blusas, vestidos e macacões. O efeito era
 * invisível e caro: calça, saia, shorts, conjunto, jaqueta, moda praia,
 * lingerie e linha conforto NUNCA entravam na vitrine de novidade, por mais
 * nova que fosse a peça — oito categorias fora, sem erro nenhum aparecer. O
 * dono abriu a vitrine, viu 17 modelos e perguntou por que não pegava as mais
 * novas. Era isso.
 *
 * Derivar do slug resolve os dois lados: as categorias que faltavam entram
 * agora, e categoria criada no futuro entra sozinha, sem ninguém lembrar de
 * mexer aqui.
 *
 * O que NÃO mudou, de propósito: o teto de `NOVIDADES_TETO` continua sendo POR
 * categoria (uma categoria cheia não come a vaga da outra) e a trava de
 * `lancamento` continua intacta — é ela que impede peça velha de voltar à
 * vitrine (incidente de 19/08, ver o cabeçalho do TOP30).
 *
 * Peça sem categoria vai pra `novidades-outros` em vez de ser descartada: ela é
 * peça nova do mesmo jeito, e o conjunto no Meta casa por `custom_label_2`
 * contendo `novidades-`, então entra na vitrine junto.
 */
function carimboNovidade(categoria: unknown): string {
  const slug = String(categoria ?? '').trim();
  return slug ? `novidades-${slug}` : 'novidades-outros';
}

/**
 * AS 30 DE MAIOR ESTOQUE DE CADA CATEGORIA — `custom_label_3` e `custom_label_4`.
 *
 * Sete vitrines rotativas — blusas, vestidos, moda praia, lingerie, macacões,
 * linha conforto e uma geral — que alimentam os conjuntos de anúncio.
 *
 * ── POR QUE ESTOQUE, E NÃO "AS MAIS NOVAS" (INCIDENTE DE 19/08/2026) ──
 *
 * Nasceu como "as 30 mais recentes", contando de cima da lista, que o backend
 * devolve por `publicadoEm desc`. Foi pro ar e o dono pausou a campanha em
 * minutos: **peça velha aparecendo como novidade** (REF 13014, 13015, 700927).
 *
 * A causa: `publicadoEm` é quando a peça entrou no ar NO SITE, e no catálogo
 * legado esse campo foi preenchido de trás pra frente — a data da primeira
 * foto no R2. Peça de 2023 fotografada mês passado sobe como lançamento.
 * Ordem de publicação não é idade de peça, e o feed não carrega data nenhuma
 * pra desempatar.
 *
 * Pior: a trava contra isso JÁ EXISTIA — o carimbo `novidades-*` abaixo exige
 * `lancamento` (janela de `NOVIDADE_DIAS` no backend — 60 dias hoje; este
 * comentário dizia 30) exatamente porque o dono reclamou da mesma coisa em
 * 16/08. Ela foi removida aqui de propósito, com um comentário justificando.
 * O comentário estava errado e o bug voltou. Lição: quando existe uma trava
 * com dono e data, ela é resposta a um incidente — não a remova sem descobrir
 * qual foi.
 *
 * `estoqueTotal` não tem esse problema: é dado do Flow, medido, e responde uma
 * pergunta melhor pro anúncio — peça com grade cheia atende mais gente e não
 * frustra quem clica e descobre que o tamanho dela acabou. Se um dia a vitrine
 * precisar mesmo ser por novidade, primeiro exponha a data real no feed.
 *
 * `novidades-*` (abaixo) continua respondendo "o que é NOVO DE VERDADE", com a
 * trava de `lancamento` intacta. São perguntas diferentes e convivem.
 *
 * ── POR QUE DOIS CAMPOS E NÃO UM ──
 *
 * Uma peça pode estar entre as 30 de maior estoque da categoria dela E entre as
 * 30 de maior estoque do site inteiro. `custom_label` guarda UM valor por campo, então
 * o recorte da categoria vai no 3 e o geral no 4. Os slots 0, 1 e 2 já têm dono
 * (subcategoria, top-semana, novidades) — estes eram os dois que sobravam, e
 * agora os cinco estão ocupados: o próximo recorte precisa de outra estratégia.
 *
 * Esgotado não ocupa vaga: gastaria vitrine com peça que não vende e
 * encolheria o conjunto na prática.
 */
const TOP30_TETO = 30;
const TOP30_CATEGORIA: Record<string, string> = {
  blusas: 'top30-blusas',
  vestidos: 'top30-vestidos',
  'moda-praia': 'top30-moda-praia',
  lingerie: 'top30-lingerie',
  macacoes: 'top30-macacoes',
  'linha-conforto': 'top30-linha-conforto',
};
/**
 * A VITRINE DO RESTO — as 30 de maior estoque que NÃO entraram em nenhuma
 * vitrine de categoria.
 *
 * Nasceu como "as 30 do site inteiro" e o dono achou o defeito na mesma noite:
 * as de maior estoque do catálogo SÃO as blusas, vestidos e macacões, que já
 * têm conjunto próprio. Os quatro anúncios disputavam as mesmas peças.
 *
 * Filtrar isso no Meta não resolveria: as 30 vagas já teriam sido gastas
 * justamente nas peças a excluir, e o conjunto sairia vazio. A exclusão tem
 * que acontecer no CARIMBO — por isso `carimbarTop30` dá `continue` em quem
 * já ganhou vitrine de categoria.
 *
 * O que sobra aqui é o resto do catálogo: calças, saias, shorts, conjuntos,
 * jaquetas e as peças sem categoria — que hoje não aparecem em anúncio nenhum.
 */
const TOP30_GERAL = 'top30-novidades';

interface CarimboTop30 {
  /** REF → carimbo da categoria (`custom_label_3`). */
  categoria: Map<string, string>;
  /** REFs entre as 30 de maior estoque do site (`custom_label_4`). */
  geral: Set<string>;
}

function carimbarTop30(pecas: PecaFeed[]): CarimboTop30 {
  const usadas = new Map<string, number>();
  const categoria = new Map<string, string>();
  const geral = new Set<string>();

  /**
   * DA MAIOR QUANTIDADE PRA MENOR — e a cópia antes de ordenar não é capricho:
   * a lista original vem por `publicadoEm desc` e o carimbo de novidades acima
   * DEPENDE dessa ordem. Ordenar no lugar quebraria o outro carimbo em silêncio.
   */
  const porEstoque = [...pecas]
    .filter((p) => p.disponivel)
    .sort((a, b) => (Number(b.estoqueTotal) || 0) - (Number(a.estoqueTotal) || 0));

  for (const p of porEstoque) {
    const alvo = TOP30_CATEGORIA[String(p.categoria || '').trim()];

    if (alvo) {
      const n = usadas.get(alvo) ?? 0;
      if (n < TOP30_TETO) {
        usadas.set(alvo, n + 1);
        categoria.set(p.ref, alvo);
        // Já tem vitrine própria: NÃO entra na geral. Ver o cabeçalho.
        continue;
      }
    }

    // Sobrou: categoria sem vitrine própria (calças, saias, shorts, conjuntos,
    // jaquetas), peça sem categoria nenhuma, ou a 31ª de uma vitrine cheia.
    if (geral.size < TOP30_TETO) geral.add(p.ref);
  }

  return { categoria, geral };
}

/** REF → carimbo, pras `NOVIDADES_TETO` primeiras disponíveis de cada categoria. */
function carimbarNovidades(pecas: PecaFeed[]): Map<string, string> {
  const usadas = new Map<string, number>();
  const carimbo = new Map<string, string>();
  for (const p of pecas) {
    const alvo = carimboNovidade(p.categoria);
    // SÓ peça NOVA de verdade (`lancamento`) e disponível. A janela é a do
    // backend — `NOVIDADE_DIAS`, 60 dias contados do carimbo da peça (1ª venda
    // da REF; sem venda, 1ª foto). ⚠️ Este comentário dizia "≤30 dias" e o
    // código já contava 60: conferido em 04/10/2026, quando a página
    // /novidades e este rótulo marcavam as mesmas 21 REFs.
    // Sem a trava de lancamento o feed completava as 20 com peça velha (o
    // "peça velha como nova" — dono 16/08). Com ela o conjunto varia (às vezes
    // <20) e cresce sozinho conforme entra peça nova; a peça envelhece e sai.
    if (!p.disponivel || !p.lancamento) continue;
    const n = usadas.get(alvo) ?? 0;
    if (n >= NOVIDADES_TETO) continue;
    usadas.set(alvo, n + 1);
    carimbo.set(p.ref, alvo);
  }
  return carimbo;
}

/** `MARROM DOURADO` → `MARROM-DOURADO`, pra caber num id de item. */
function slugCor(nome: string): string {
  return String(nome ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

interface Variante {
  id: string;
  cor: string;
  fotos: string[];
  tamanhos: string[];
  /** `item_group_id`. Nulo = peça de cor única, item solto como antes. */
  grupo: string | null;
}

/**
 * CADA COR VIRA UM ITEM — a mesma regra que a vitrine do site já aplica
 * (`explodirPorCor` em `services/products.ts`), agora no catálogo do Meta.
 *
 * Antes uma peça de 8 cores era UM anúncio: rotulado com a primeira cor e
 * com as fotos das outras sete embaralhadas na galeria — a cliente via um
 * anúncio "PRETO" cuja segunda foto era bege.
 *
 * 🔑 A COR DE MAIOR ESTOQUE HERDA O `id` DA REF.
 *
 * É o que impede a virada de zerar tudo: para o Meta aquele item continua
 * sendo o mesmo de sempre (aprendizado, prova social e desempenho seguem),
 * e só as cores adicionais entram como itens novos. Serve também pro pixel:
 * o site dispara `content_ids` com a REF crua, então o evento continua
 * casando — com a cor principal, que é a que tem mais peça em estoque.
 *
 * Só entra cor COM foto própria e COM estoque: cor sem foto viraria anúncio
 * com a foto de outra cor, e esgotada frustra quem clica.
 */
function variantes(p: PecaFeed): Variante[] {
  const unica: Variante = {
    id: p.ref,
    cor: p.cores[0] ?? "",
    fotos: p.imagens,
    tamanhos: p.tamanhos,
    grupo: null,
  };
  const vendaveis = (p.coresDetalhe ?? [])
    .filter((c) => c.estoque > 0 && (c.fotos?.length ?? 0) > 0)
    .sort((a, b) => b.estoque - a.estoque);
  if (vendaveis.length < 2) return [unica];
  return vendaveis.map((c, i) => ({
    id: i === 0 ? p.ref : `${p.ref}-${slugCor(c.nome)}`,
    cor: c.nome,
    fotos: c.fotos,
    tamanhos: c.tamanhos?.length ? c.tamanhos : p.tamanhos,
    grupo: p.ref,
  }));
}

function item(p: PecaFeed, v: Variante, novidade?: string, top30?: string, top30Geral?: boolean): string {
  /**
   * O MESMO ENDEREÇO DO FEED DO GOOGLE (04/10/2026): `/produto/ref-<REF>`, com
   * `?cor=` na peça de várias cores — a ficha abre já na cor do anúncio.
   *
   * Até aqui este link era `/produto/<slug>`. O slug embute nome e cor
   * principal, e 38 peças tinham slug SEM `ref-` — o formato que vira 404 sem
   * volta quando a peça é renomeada (incidente de 13/09, escrito em
   * `enderecoDaPeca`). O anúncio guarda a URL: o clique pago caía no erro.
   *
   * ⚠️ SÓ O LINK MUDA. O `<g:id>` continua o mesmo, então pro Meta o item é o
   * de sempre (aprendizado e `content_ids` do pixel seguem casando).
   */
  const link = linkDoItem(p, v, SITE.url);
  const [capa, ...resto] = v.fotos;

  const campos: string[] = [
    // A cor de MAIOR estoque herda a REF crua; as outras ganham sufixo.
    // Ver `variantes()`.
    `<g:id>${escapar(v.id)}</g:id>`,
    ...(v.grupo ? [`<g:item_group_id>${escapar(v.grupo)}</g:item_group_id>`] : []),
    // Com a COR no nome, igual ao card do site: sem isto a peça de 8 cores
    // vira 8 anúncios de título idêntico e a cliente não sabe qual é qual.
    `<g:title>${escapar(v.grupo ? `${p.nome} · ${v.cor}` : p.nome)}</g:title>`,
    // Descrição é obrigatória no Meta. Sem ficha cadastrada, o nome da peça
    // com a categoria é honesto e melhor que deixar o item ser recusado.
    `<g:description>${escapar(p.descricao || `${p.nome} — ${rotulo(p.categoria)} plus size do 44 ao 60.`)}</g:description>`,
    `<g:link>${escapar(link)}</g:link>`,
    `<g:availability>${p.disponivel ? 'in stock' : 'out of stock'}</g:availability>`,
    `<g:condition>new</g:condition>`,
    `<g:price>${dinheiro(p.preco)}</g:price>`,
    `<g:brand>${escapar(p.marca || "Lurd's Plus Size")}</g:brand>`,
    // A loja veste mulher adulta — sem estes dois o Meta classifica sozinho e
    // erra, e o anúncio vai parar no público errado.
    `<g:gender>female</g:gender>`,
    `<g:age_group>adult</g:age_group>`,
    `<g:product_type>${escapar(rotulo(p.categoria))}</g:product_type>`,
  ];

  // O SLUG da subcategoria, cru — é a chave que o conjunto de produtos do
  // Meta filtra (custom_label_0 eq "blusas-confort"). Campanha por
  // subcategoria depende disto; sem subcategoria o campo nem vai.
  if (p.subcategoria) campos.push(`<g:custom_label_0>${escapar(p.subcategoria)}</g:custom_label_0>`);
  // Ver `carimbarNovidades`. Só as 20 do topo de cada categoria recebem.
  if (novidade) campos.push(`<g:custom_label_2>${escapar(novidade)}</g:custom_label_2>`);
  // Curadoria do site no `custom_label_1` — vira conjunto de produtos no Meta:
  //   · coleção fixa  → `top-semana` (o carimbo histórico, `eq "top-semana"`)
  //   · coleção PONTUAL ('Resort') → `colecao-<slug>` (`eq "colecao-resort"`) —
  //     assim o conjunto do Meta segue a curadoria da tela sozinho (26/08).
  // Um valor só por peça: a fixa vence quando a REF está nas duas.
  if (p.topSemana) campos.push(`<g:custom_label_1>top-semana</g:custom_label_1>`);
  else if (p.colecaoSlug) campos.push(`<g:custom_label_1>colecao-${escapar(p.colecaoSlug)}</g:custom_label_1>`);
  // As 30 de MAIOR ESTOQUE da categoria (3) e do resto do catálogo (4) — ver
  // `carimbarTop30`. ⚠️ Este comentário dizia "as 30 mais recentes": era o
  // desenho de antes do incidente de 19/08, e o valor `top30-novidades` ficou
  // com o nome antigo de propósito (renomear rótulo = conjunto do Meta
  // servindo zero produto, calado). Quem quer NOVIDADE filtra o
  // `custom_label_2` (`novidades-*`), não estes dois.
  if (top30) campos.push(`<g:custom_label_3>${escapar(top30)}</g:custom_label_3>`);
  if (top30Geral) campos.push(`<g:custom_label_4>${TOP30_GERAL}</g:custom_label_4>`);

  if (capa) campos.push(`<g:image_link>${escapar(capa)}</g:image_link>`);
  // Até 10 fotos extras — o carrossel do anúncio dinâmico usa estas.
  for (const extra of resto.slice(0, 10)) {
    campos.push(`<g:additional_image_link>${escapar(extra)}</g:additional_image_link>`);
  }
  // `sale_price` só quando há promoção de verdade: é o que desenha o "de/por"
  // no anúncio. Mandar sempre faria todo item parecer estar em promoção.
  if (p.precoPromocional && p.precoPromocional < p.preco) {
    campos.push(`<g:sale_price>${dinheiro(p.precoPromocional)}</g:sale_price>`);
  }
  // Cor e tamanho no nível da REF: a peça tem uma página só, e a cliente
  // escolhe a variação dentro dela. Manda a primeira cor e a grade que existe
  // — serve pro Meta filtrar e segmentar, sem fingir que são itens separados.
  if (v.cor) campos.push(`<g:color>${escapar(v.cor)}</g:color>`);
  if (v.tamanhos.length) campos.push(`<g:size>${escapar(v.tamanhos.join(", "))}</g:size>`);

  return `<item>${campos.join('')}</item>`;
}

export async function GET() {
  let pecas: PecaFeed[];
  try {
    // Sem Data Cache desde 04/10/2026 (ver `lib/feed/leitura.ts`). O `?rev=5`
    // que vivia aqui só existia pra rotacionar a chave de uma entrada
    // envenenada do Data Cache — sem cache, não há chave pra rotacionar.
    pecas = await lerListaDoBackend<PecaFeed>('/public/loja/feed');
  } catch (e) {
    /* Catálogo fora do ar: 503 SEM cache, nunca feed vazio com 200 (04/10/2026).
       O feed agendado do Meta SUBSTITUI o catálogo pelo arquivo que leu: um RSS
       válido sem item nenhum é a ordem de apagar tudo. Com 5xx ele registra a
       falha da sessão e mantém os itens como estão. */
    console.error('[feed-meta] catálogo falhou — respondendo 503:', (e as Error)?.message ?? e);
    return feedIndisponivel();
  }

  // A ORDEM DA LISTA É O DADO. O backend devolve por `novidades` (mais nova
  // primeiro) e o carimbo das 20 depende disso — nunca reordenar aqui.
  const validas = pecas.filter((p) => p.ref && p.slug && p.preco > 0);
  const novidades = carimbarNovidades(validas);
  const top30 = carimbarTop30(validas);

  const itens = validas.flatMap((p) =>
    variantes(p).map((v) =>
      item(p, v, novidades.get(p.ref), top30.categoria.get(p.ref), top30.geral.has(p.ref)),
    ),
  );
  /* Zero item é anomalia, não notícia — trata igual à falha. */
  if (!itens.length) {
    console.error(
      `[feed-meta] catálogo respondeu ${pecas.length} peça(s), ${validas.length} válida(s) e NENHUM item — respondendo 503`,
    );
    return feedIndisponivel();
  }

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0"><channel>` +
    `<title>${escapar(SITE.name)}</title>` +
    `<link>${escapar(SITE.url)}</link>` +
    `<description>${escapar(SITE.description)}</description>` +
    itens.join("") +
    `</channel></rss>`;

  /* Só a resposta BOA chega aqui, e só ela é guardada pela CDN (15 min). */
  return respostaDoFeed(xml);
}
