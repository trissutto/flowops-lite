import { api } from '@/lib/api';
import { SITE } from '@/lib/seo';
import { type PecaFeed } from '@/lib/feed/variantes';
import {
  LOJAS_COM_FICHA,
  linhasDeInventarioLocal,
  numeroDaLoja,
  type EstoqueLoja,
} from '@/lib/feed/inventario-local';

/**
 * FEED DE INVENTÁRIO LOCAL — o que faz a peça aparecer na vitrine da FICHA de
 * cada loja no Google (23/08/2026, pedido do dono).
 *
 * Endereço pra cadastrar:
 *   Merchant Center → Fontes de dados → Inventário local → Feed via URL
 *   https://<dominio>/feed/google-local.xml   (buscar 1× por dia)
 *
 * ── O QUE ELE FAZ ──
 *
 * O feed nacional (`/feed/google.xml`) diz "esta peça existe, custa X, é
 * assim". Este diz **"e ela está NESTA loja, nesta quantidade"**. Com os dois,
 * a cliente que busca "loja plus size perto de mim" vê, na ficha da unidade
 * mais próxima, o que acabou de chegar lá — com a foto principal da cor.
 *
 * ── A FOTO NÃO VEM DAQUI, E ISSO É DE PROPÓSITO ──
 *
 * Inventário local não carrega imagem. O Google casa este arquivo com o feed
 * nacional **pelo `id`** e usa a foto de lá — que já é a principal. Mandar
 * foto aqui duplicaria a fonte e as duas divergiriam no primeiro ajuste.
 *
 * ── 🔑 O `id` É O ÚNICO PONTO QUE NÃO PODE ERRAR ──
 *
 * Ele TEM que ser byte a byte o mesmo do feed nacional. Por isso os dois
 * importam `variantes()` de `lib/feed/variantes` em vez de cada um montar o
 * seu: id divergente falha do pior jeito possível — **sem erro em lugar
 * nenhum**, a vitrine local simplesmente não aparece e ninguém descobre.
 *
 * ── 🚨 A QUANTIDADE É A DA PRATELEIRA DA LOJA (05/10/2026) ──
 *
 * De 13/09 a 05/10 valeu "estoque da REDE nas 14 fichas" (decisão do dono:
 * "as lojas podem pegar de outra loja para atender"). O Google REPROVOU a
 * verificação de inventário com esse arquivo em 23/09 — ele confere na loja,
 * com foto, se a peça declarada está lá — e sem verificação aprovada nenhuma
 * oferta local é elegível. A regra e a medição estão escritas por inteiro em
 * `lib/feed/inventario-local.ts`, que é quem monta as linhas.
 *
 * Hoje: **só sai linha pra loja que TEM a peça, com a quantidade dela**.
 * `FEED_LOCAL_ESTOQUE_REDE=1` volta à regra de 13/09 (só depois de aprovado).
 */

/** O catálogo muda pouco durante o dia e o Google lê 1× — 1h é de sobra. */
const revalidate = 3600;

/**
 * O FEED NÃO ENTRA NO CACHE DE PÁGINA — mesma proteção do feed nacional
 * (14/09/2026, e lá está o incidente escrito por inteiro).
 *
 * Aqui o estrago tem uma cara a mais: se o catálogo responde e só o ESTOQUE
 * POR LOJA falha, o arquivo sai bem formado, com as 14 lojas no lugar e ZERO
 * linha de inventário — e o Google entende isso como "nenhuma loja tem nada".
 * A vitrine local morre nas 14 fichas de uma vez, sem erro em lugar nenhum.
 * Com o segmento dinâmico, quem manda no cache é o `Cache-Control` do GET, que
 * sabe qual das duas fontes caiu.
 */
export const dynamic = 'force-dynamic';

/**
 * Código da ficha no Google = `LURDS-<código da loja no Flow>`.
 *
 * O Flow guarda `01`, `02`, `07`… (`Store.code`, e a coluna `loja` de
 * `wincred_estoque`). O prefixo existe por dois motivos: identifica a rede
 * dentro do painel do Google, e blinda contra o zero à esquerda sumir quando
 * o código passa por planilha.
 *
 * ⚠️ Este é o MESMO valor que precisa estar no campo "Código da loja" de cada
 * ficha do Meu Negócio. Divergir aqui = inventário sem dono, e o Google
 * descarta a linha em silêncio.
 */
function codigoDaFicha(loja: string): string {
  return `LURDS-${numeroDaLoja(loja)}`;
}

const escapar = (v: string) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const dinheiro = (v: number) => `${Number(v || 0).toFixed(2)} BRL`;

export async function GET() {
  let pecas: PecaFeed[] = [];
  let estoques: EstoqueLoja[] = [];

  /**
   * As duas fontes em paralelo. Falha de qualquer uma devolve feed VAZIO e
   * VÁLIDO — nunca erro. Resposta com erro o Google trata como falha de
   * importação e pode desagendar a busca; arquivo vazio ele registra e tenta
   * de novo amanhã. Mesma postura do feed nacional.
   */
  /**
   * ⚠️ UM `try` POR FONTE, e não um `Promise.all` num `try` só.
   *
   * A primeira versão embrulhava as duas num bloco: falhou uma, as DUAS
   * variáveis ficavam vazias e o feed saía sem nada — sem nenhuma pista de
   * qual das duas caiu. Separado, a que responder responde, e o `console.error`
   * diz o nome da que faltou.
   */
  let falhou = false;
  await Promise.all([
    api<PecaFeed[]>('/public/loja/feed?rev=2', { revalidate, tags: ['catalogo'], timeoutMs: 25000 })
      .then((r) => { pecas = r ?? []; })
      .catch((e) => {
        falhou = true;
        console.error('[feed-local] catálogo nacional falhou:', e?.message ?? e);
      }),
    api<EstoqueLoja[]>('/public/loja/feed-local?rev=2', { revalidate, tags: ['catalogo'], timeoutMs: 25000 })
      .then((r) => { estoques = r ?? []; })
      .catch((e) => {
        falhou = true;
        console.error('[feed-local] estoque por loja falhou:', e?.message ?? e);
      }),
  ]);

  /**
   * SÓ A VITRINE COMBINADA (dono, 14/09/2026): a ficha de cada loja e as PMax
   * de loja mostram a LINHA CONFORTO + as últimas cadastradas no Flow — os
   * mesmos rótulos que o feed nacional carrega em `custom_label_2=novidades`
   * e `custom_label_3=conforto`, e que o filtro de listagem das 14 campanhas
   * já usa. Antes o inventário local saía com o estoque INTEIRO (~950 REFs,
   * 12,5 mil linhas), e a vitrine da ficha no Google mostraria tudo.
   * `FEED_LOCAL_SO_VITRINE=0` volta a mandar o estoque inteiro.
   */
  const soVitrine = process.env.FEED_LOCAL_SO_VITRINE !== '0';
  const pecasDaVitrine = soVitrine ? pecas.filter((p) => p.novidade || p.linhaConforto) : pecas;
  if (soVitrine && pecas.length > 0 && pecasDaVitrine.length === 0) {
    // O catálogo veio mas nenhuma peça tem rótulo: o backend não está
    // carimbando `novidade`/`linhaConforto`. Feed vazio aqui apagaria a vitrine
    // das 14 fichas — melhor gritar e cair pro estoque inteiro.
    console.error('[feed-local] catálogo sem novidade/linhaConforto — mandando o estoque inteiro');
  }
  const fonte = pecasDaVitrine.length ? pecasDaVitrine : pecas;

  /** Ver `lib/feed/inventario-local.ts`: a prateleira manda, a chave reverte. */
  const estoqueDaRede = process.env.FEED_LOCAL_ESTOQUE_REDE === '1';
  const inventario = linhasDeInventarioLocal(fonte, estoques, { estoqueDaRede });

  const linhas = inventario.map(
    (l) =>
      '<item>' +
      `<g:store_code>${escapar(codigoDaFicha(l.loja))}</g:store_code>` +
      `<g:id>${escapar(l.id)}</g:id>` +
      `<g:quantity>${l.quantidade}</g:quantity>` +
      `<g:availability>in_stock</g:availability>` +
      `<g:price>${dinheiro(l.preco)}</g:price>` +
      // A cliente vê a peça na ficha e vai buscar na loja — é o
      // comportamento que a rede já tem no balcão.
      `<g:pickup_method>buy</g:pickup_method>` +
      `<g:pickup_sla>same_day</g:pickup_sla>` +
      '</item>',
  );

  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0"><channel>' +
    `<title>${escapar(SITE.name)} — inventário local</title>` +
    `<link>${escapar(SITE.url)}</link>` +
    `<description>Estoque por loja das unidades ${escapar(SITE.shortName)}</description>` +
    linhas.join('') +
    '</channel></rss>';

  /**
   * Arquivo sem uma única linha de inventário é sempre anomalia: a rede tem
   * 14 lojas com estoque todo dia. Não cacheia.
   */
  if (!linhas.length) {
    falhou = true;
    console.error(
      `[feed-local] ZERO linhas — ${pecas.length} peça(s) e ${estoques.length} linha(s) de estoque`,
    );
  }

  /**
   * Loja com ficha que saiu SEM NENHUMA peça também é anomalia — com a regra
   * da prateleira o Google passa a ler isso como "essa loja não tem nada".
   * Não derruba o feed (as outras 13 estão certas); só grita no log.
   */
  if (linhas.length) {
    const comLinha = new Set(inventario.map((l) => l.loja));
    const vazias = [...LOJAS_COM_FICHA].filter((n) => !comLinha.has(n));
    if (vazias.length) console.error(`[feed-local] loja(s) sem nenhuma peça no feed: ${vazias.join(', ')}`);
  }

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      /** Ver o comentário do `dynamic` no topo: só o que deu certo é guardado. */
      'Cache-Control': falhou
        ? 'no-store'
        : 'public, max-age=600, s-maxage=3600, stale-while-revalidate=86400',
    },
  });
}
