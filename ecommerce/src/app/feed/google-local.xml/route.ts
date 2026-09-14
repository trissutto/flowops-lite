import { api } from '@/lib/api';
import { SITE } from '@/lib/seo';
import { chaveDeCor, variantes, type PecaFeed } from '@/lib/feed/variantes';

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
 * ── 🚨 A REGRA MUDOU EM 13/09/2026: ESTOQUE DA REDE, NÃO DA LOJA ──
 *
 * Até aqui valia "só sai linha pra loja que TEM a peça", pelo medo de mandar a
 * cliente atravessar a cidade atrás de peça que não está lá.
 *
 * O dono derrubou essa regra, e com um motivo de operação que a supera:
 * **"LIGAR COM ESTOQUE TOTAL POIS AS LOJAS PODEM PEGAR DE OUTRA LOJA PARA
 * ATENDER"**. A rede transfere peça entre unidades todo dia — é o mesmo
 * mecanismo que o roteamento do site já usa. Então "esta loja te atende" é
 * verdade mesmo quando a peça está na unidade vizinha, e esconder a peça da
 * ficha de Piracicaba só porque ela dormiu em Santos custa a venda inteira.
 *
 * Consequência assumida: **toda peça que a REDE tem aparece nas 14 fichas**, e
 * a quantidade publicada é a da rede, não a da prateleira daquela loja.
 * A cobertura sai de 78% (10.577 linhas) para 100% (13.482).
 *
 * O que continua valendo: peça que a rede NÃO tem não entra em ficha nenhuma.
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

/**
 * SÓ LOJA QUE A CLIENTE PODE VISITAR — as 14 que têm ficha no Meu Negócio.
 *
 * O Flow tem 18 códigos de loja, e nem todos são porta de rua. Sem esta trava
 * o feed anunciava também (medido em 23/08, 132 linhas):
 *
 *   09 MATRIZ (inativa) · 13 SITE (o estoque do e-commerce)
 *   19 ITU (**fechada** — as duas fichas viraram "Encerrado permanentemente"
 *      em 23/08) · 20 DEPÓSITO
 *
 * As três primeiras o Google descartaria em silêncio, por não existir ficha
 * com esse código. ITU é o caso que dói: no dia em que alguém criasse a ficha
 * de novo, o feed começaria a mandar cliente pra uma loja que não abre mais.
 *
 * A lista é explícita de propósito. Loja nova entra AQUI depois que a ficha
 * dela existe no Meu Negócio com o código — nunca antes.
 */
const LOJAS_COM_FICHA = new Set([
  '01', // Itanhaém
  '02', // Santos (Parque Balneário)
  '03', // Vinhedo
  '04', // Indaiatuba
  '05', // Piracicaba
  '06', // Sorocaba
  '07', // Campinas
  '08', // São José dos Campos
  '10', // Jundiaí
  '11', // Limeira
  '14', // Praia Grande
  '15', // Moema
  '17', // Suzano
  '18', // Anália Franco
]);

/** `1`, `07`, ` 7 ` → `07`. A mesma chave que o `codigoDaFicha` usa. */
const numeroDaLoja = (loja: string) => String(loja).trim().padStart(2, '0');

/** Uma linha de estoque por (peça × cor × loja), vinda do backend. */
interface EstoqueLoja {
  loja: string;
  ref: string;
  cor: string | null;
  estoque: number;
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
    api<PecaFeed[]>('/public/loja/feed?rev=1', { revalidate, tags: ['catalogo'], timeoutMs: 25000 })
      .then((r) => { pecas = r ?? []; })
      .catch((e) => {
        falhou = true;
        console.error('[feed-local] catálogo nacional falhou:', e?.message ?? e);
      }),
    api<EstoqueLoja[]>('/public/loja/feed-local', { revalidate, tags: ['catalogo'], timeoutMs: 25000 })
      .then((r) => { estoques = r ?? []; })
      .catch((e) => {
        falhou = true;
        console.error('[feed-local] estoque por loja falhou:', e?.message ?? e);
      }),
  ]);

  /**
   * Índice do estoque: `REF` → `COR normalizada` → mapa de loja → quantidade.
   *
   * A cor é normalizada porque as duas pontas vêm do mesmo `wincred_produtos`
   * mas por caminhos diferentes, e chegam com acento e caixa variando —
   * "CAFÉ" contra "CAFE" já custou uma vitrine inteira antes.
   */
  const porRef = new Map<string, Map<string, Map<string, number>>>();
  for (const e of estoques) {
    if (!e.ref || !e.loja || !(e.estoque > 0)) continue;
    const ref = e.ref.trim().toUpperCase();
    const cor = chaveDeCor(e.cor);
    if (!porRef.has(ref)) porRef.set(ref, new Map());
    const porCor = porRef.get(ref)!;
    if (!porCor.has(cor)) porCor.set(cor, new Map());
    const porLoja = porCor.get(cor)!;
    porLoja.set(e.loja, (porLoja.get(e.loja) ?? 0) + e.estoque);
  }

  /** Soma todas as cores de uma REF — o caso da peça de cor única. */
  function todasAsCores(ref: string): Map<string, number> {
    const total = new Map<string, number>();
    for (const porLoja of porRef.get(ref)?.values() ?? []) {
      for (const [loja, qtd] of porLoja) total.set(loja, (total.get(loja) ?? 0) + qtd);
    }
    return total;
  }

  const linhas: string[] = [];

  for (const p of pecas) {
    if (!p.ref || !p.slug || !(p.preco > 0)) continue;
    const ref = p.ref.trim().toUpperCase();
    const vars = variantes(p);
    /**
     * Peça de cor única sai como um item só no feed nacional — então aqui ela
     * some o estoque de TODAS as cores por loja. Peça explodida por cor casa
     * cor a cor: é o que faz a ficha mostrar a blusa preta onde tem preta e a
     * vinho onde tem vinho.
     */
    const corUnica = vars.length === 1;

    for (const v of vars) {
      const preco = p.precoPromocional && p.precoPromocional > 0 ? p.precoPromocional : p.preco;
      const porLoja = corUnica ? todasAsCores(ref) : (porRef.get(ref)?.get(chaveDeCor(v.cor)) ?? new Map());

      /**
       * O ESTOQUE DA REDE, somado só das lojas que têm ficha.
       *
       * ⚠️ Depósito, matriz e sobretudo a 13/SITE ficam DE FORA da soma. A do
       * site não é prateleira: é o estoque separado pro e-commerce, e a regra
       * da casa é que ela não cede peça pra loja. Contá-la aqui prometeria na
       * ficha uma peça que a loja não consegue buscar em lugar nenhum.
       */
      let totalRede = 0;
      for (const [loja, qtd] of porLoja) {
        if (qtd > 0 && LOJAS_COM_FICHA.has(numeroDaLoja(loja))) totalRede += qtd;
      }
      if (!(totalRede > 0)) continue;

      /* Uma linha por FICHA, não por loja com saldo — ver a regra de 13/09. */
      for (const numero of LOJAS_COM_FICHA) {
        const quantidade = totalRede;

        linhas.push(
          '<item>' +
          `<g:store_code>${escapar(codigoDaFicha(numero))}</g:store_code>` +
          `<g:id>${escapar(v.id)}</g:id>` +
          `<g:quantity>${quantidade}</g:quantity>` +
          `<g:availability>in_stock</g:availability>` +
          `<g:price>${dinheiro(preco)}</g:price>` +
          // A cliente vê a peça na ficha e vai buscar na loja — é o
          // comportamento que a rede já tem no balcão.
          `<g:pickup_method>buy</g:pickup_method>` +
          `<g:pickup_sla>same_day</g:pickup_sla>` +
          '</item>',
        );
      }
    }
  }

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
