import { api } from '@/lib/api';
import { SITE } from '@/lib/seo';

/**
 * FEED DE PRODUTOS DO META — o que destrava o anúncio dinâmico.
 *
 * Endereço pra cadastrar no Meta:
 *   Commerce Manager → Catálogo → Fontes de dados → Feed agendado
 *   https://<dominio>/feed/meta.xml   (buscar 1× por dia)
 *
 * Sem catálogo cadastrado, o Meta não consegue rodar **anúncio dinâmico** —
 * aquele que mostra pra cliente exatamente a peça que ela olhou e não
 * comprou. Em moda é geralmente a campanha de melhor retorno, e o pixel já
 * manda tudo que ela precisa (`content_ids`, `contents`): faltava o outro
 * lado, o catálogo.
 *
 * ── A REGRA QUE FAZ ISSO FUNCIONAR OU NÃO ──
 *
 * O `<g:id>` daqui TEM que ser idêntico ao `content_ids` que o pixel dispara.
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
 * De hora em hora, não uma vez por dia: o Meta lê 1×/dia, mas com ISR de 24h
 * a leitura pegava um retrato de até um dia atrás — foi o que manteve o feed
 * em 60 peças mesmo depois do fix do backend (13/08). O backend cacheia o
 * catálogo internamente, então regenerar custa um request por hora.
 */
export const revalidate = 3600;

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
  topSemana?: boolean;
  lancamento?: boolean;
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
const NOVIDADES_CATEGORIA: Record<string, string> = {
  blusas: 'novidades-blusas',
  vestidos: 'novidades-vestidos',
  macacoes: 'novidades-macacoes',
};

/** REF → carimbo, pras `NOVIDADES_TETO` primeiras disponíveis de cada categoria. */
function carimbarNovidades(pecas: PecaFeed[]): Map<string, string> {
  const usadas = new Map<string, number>();
  const carimbo = new Map<string, string>();
  for (const p of pecas) {
    const alvo = NOVIDADES_CATEGORIA[String(p.categoria || '').trim()];
    // SÓ peça NOVA de verdade (≤30 dias da 1ª venda, `lancamento`) e disponível.
    // Sem a trava de lancamento o feed completava as 20 com peça de 60-90 dias
    // (o "peça velha como nova" — dono 16/08). Com ela o conjunto varia (às vezes
    // <20) e cresce sozinho conforme entra peça nova; peça envelhece 30d e sai.
    if (!alvo || !p.disponivel || !p.lancamento) continue;
    const n = usadas.get(alvo) ?? 0;
    if (n >= NOVIDADES_TETO) continue;
    usadas.set(alvo, n + 1);
    carimbo.set(p.ref, alvo);
  }
  return carimbo;
}

function item(p: PecaFeed, novidade?: string): string {
  const link = `${SITE.url}/produto/${p.slug}`;
  const [capa, ...resto] = p.imagens;

  const campos: string[] = [
    // A REF, e só a REF — ver o cabeçalho.
    `<g:id>${escapar(p.ref)}</g:id>`,
    `<g:title>${escapar(p.nome)}</g:title>`,
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
  // Curadoria "mais top da semana": o backend marca a peça com `topSemana` e o
  // carimbo entra no `custom_label_1` (o que estava de reserva). Vira conjunto
  // de produtos no Meta com um `eq "top-semana"`, igual às novidades.
  if (p.topSemana) campos.push(`<g:custom_label_1>top-semana</g:custom_label_1>`);

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
  if (p.cores[0]) campos.push(`<g:color>${escapar(p.cores[0])}</g:color>`);
  if (p.tamanhos.length) campos.push(`<g:size>${escapar(p.tamanhos.join(', '))}</g:size>`);

  return `<item>${campos.join('')}</item>`;
}

export async function GET() {
  let pecas: PecaFeed[] = [];
  try {
    // A tag deixa a retaguarda derrubar este cache junto com o resto do
    // catálogo (POST /api/revalidar com tags:['catalogo']) — sem ela, o dado
    // preso aqui só saía pelo relógio, por mais que o backend já respondesse
    // o catálogo novo.
    //
    // O `?rev=2` rotaciona a CHAVE no Data Cache da Vercel (13/08): a entrada
    // antiga foi gravada com validade de 24h e SEM tag, e o Data Cache
    // sobrevive a deploy — trocar revalidate/tags no código não alcança a
    // entrada já gravada (config de cache não entra na chave). O backend
    // ignora a query. Se um dia envenenar de novo: soma 1 aqui.
    pecas = (await api<PecaFeed[]>('/public/loja/feed?rev=3', { revalidate, tags: ['catalogo'], timeoutMs: 25000 })) ?? [];
  } catch {
    /* Catálogo fora do ar: devolve feed VAZIO e válido, nunca erro. O Meta
       trata resposta com erro como falha de importação e pode desativar o
       agendamento; feed vazio ele só registra e tenta de novo amanhã. */
  }

  // A ORDEM DA LISTA É O DADO. O backend devolve por `novidades` (mais nova
  // primeiro) e o carimbo das 20 depende disso — nunca reordenar aqui.
  const validas = pecas.filter((p) => p.ref && p.slug && p.preco > 0);
  const novidades = carimbarNovidades(validas);

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0"><channel>` +
    `<title>${escapar(SITE.name)}</title>` +
    `<link>${escapar(SITE.url)}</link>` +
    `<description>${escapar(SITE.description)}</description>` +
    validas.map((p) => item(p, novidades.get(p.ref))).join('') +
    `</channel></rss>`;

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      // CDN no mesmo ritmo do ISR (1h); SWR cobre a virada sem buraco.
      'Cache-Control': 'public, max-age=600, s-maxage=3600, stale-while-revalidate=86400',
    },
  });
}
