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

function item(p: PecaFeed): string {
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
    pecas = (await api<PecaFeed[]>('/public/loja/feed?rev=2', { revalidate, tags: ['catalogo'], timeoutMs: 25000 })) ?? [];
  } catch {
    /* Catálogo fora do ar: devolve feed VAZIO e válido, nunca erro. O Meta
       trata resposta com erro como falha de importação e pode desativar o
       agendamento; feed vazio ele só registra e tenta de novo amanhã. */
  }

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0"><channel>` +
    `<title>${escapar(SITE.name)}</title>` +
    `<link>${escapar(SITE.url)}</link>` +
    `<description>${escapar(SITE.description)}</description>` +
    pecas.filter((p) => p.ref && p.slug && p.preco > 0).map(item).join('') +
    `</channel></rss>`;

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      // CDN no mesmo ritmo do ISR (1h); SWR cobre a virada sem buraco.
      'Cache-Control': 'public, max-age=600, s-maxage=3600, stale-while-revalidate=86400',
    },
  });
}
