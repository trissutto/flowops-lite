import { feedIndisponivel, lerListaDoBackend, respostaDoFeed } from '@/lib/feed/leitura';
import { SITE } from '@/lib/seo';
import { type PecaFeed } from '@/lib/feed/variantes';
import {
  ESTOQUE_MINIMO_PADRAO,
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
 * Hoje: **só sai linha pra loja que TEM a peça, com a quantidade dela** — e
 * com 2 unidades ou mais (`FEED_LOCAL_MIN_ESTOQUE`, margem contra a peça que
 * vendeu depois da leitura diária do Google).
 * `FEED_LOCAL_ESTOQUE_REDE=1` volta à regra de 13/09 (só depois de aprovado).
 */

/**
 * O FEED NÃO ENTRA NO CACHE DE PÁGINA — mesma proteção do feed nacional
 * (14/09/2026, e lá está o incidente escrito por inteiro).
 *
 * Aqui o estrago tem uma cara a mais: se o catálogo responde e só o ESTOQUE
 * POR LOJA falha, o arquivo sairia bem formado, com as 14 lojas no lugar e
 * ZERO linha de inventário — e o Google entende isso como "nenhuma loja tem
 * nada". A vitrine local morreria nas 14 fichas de uma vez, sem erro em lugar
 * nenhum. Por isso a falha de QUALQUER uma das duas fontes responde 503 sem
 * cache (`feedIndisponivel`): o Merchant registra "não consegui buscar" e
 * mantém o inventário da última leitura boa.
 *
 * ── A LEITURA É SEMPRE FRESCA (05/10/2026) ──
 *
 * O Merchant lê este arquivo UMA vez por dia, e é contra esse retrato que a
 * verificação de inventário confere a prateleira. Com o `revalidate = 3600`
 * no `fetch` e o `stale-while-revalidate` de 24 h na CDN, quem lê 1×/dia
 * recebia sempre a cópia da leitura ANTERIOR — estoque de ontem (ou de
 * anteontem) apresentado como "tem na loja hoje". A regra e a conta estão em
 * `lib/feed/leitura.ts`, que as três rotas de feed dividem.
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
  /**
   * As duas fontes em paralelo, sem Data Cache e com segunda chance
   * (`lerListaDoBackend`). Falhou uma, o feed inteiro responde 503: metade do
   * dado aqui não é "feed menor", é inventário apagado.
   *
   * `allSettled` e não `all` pra o log dizer o NOME de quem caiu — com `all`
   * a primeira rejeição esconde a segunda.
   */
  const [lidoCatalogo, lidoEstoque] = await Promise.allSettled([
    lerListaDoBackend<PecaFeed>('/public/loja/feed'),
    lerListaDoBackend<EstoqueLoja>('/public/loja/feed-local'),
  ]);
  if (lidoCatalogo.status === 'rejected') {
    console.error('[feed-local] catálogo nacional falhou — respondendo 503:', lidoCatalogo.reason?.message ?? lidoCatalogo.reason);
  }
  if (lidoEstoque.status === 'rejected') {
    console.error('[feed-local] estoque por loja falhou — respondendo 503:', lidoEstoque.reason?.message ?? lidoEstoque.reason);
  }
  if (lidoCatalogo.status === 'rejected' || lidoEstoque.status === 'rejected') return feedIndisponivel();
  const pecas = lidoCatalogo.value;
  const estoques = lidoEstoque.value;

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
  /** Margem de segurança da loja (padrão 2). `FEED_LOCAL_MIN_ESTOQUE=1` desliga. */
  const pedido = Number(process.env.FEED_LOCAL_MIN_ESTOQUE);
  const estoqueMinimo = Number.isFinite(pedido) && pedido >= 1 ? Math.floor(pedido) : ESTOQUE_MINIMO_PADRAO;
  const inventario = linhasDeInventarioLocal(fonte, estoques, { estoqueDaRede, estoqueMinimo });

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
   * 14 lojas com estoque todo dia. Responde 503 — o vazio com 200 seria a
   * ordem de zerar o inventário das 14 fichas.
   */
  if (!linhas.length) {
    console.error(
      `[feed-local] ZERO linhas — ${pecas.length} peça(s) e ${estoques.length} linha(s) de estoque — respondendo 503`,
    );
    return feedIndisponivel();
  }

  /**
   * Loja com ficha que saiu SEM NENHUMA peça também é anomalia — com a regra
   * da prateleira o Google passa a ler isso como "essa loja não tem nada".
   * Não derruba o feed (as outras 13 estão certas); só grita no log.
   */
  {
    const comLinha = new Set(inventario.map((l) => l.loja));
    const vazias = [...LOJAS_COM_FICHA].filter((n) => !comLinha.has(n));
    if (vazias.length) console.error(`[feed-local] loja(s) sem nenhuma peça no feed: ${vazias.join(', ')}`);
  }

  /* Só a resposta BOA chega aqui, e só ela é guardada pela CDN (15 min). */
  return respostaDoFeed(xml);
}
