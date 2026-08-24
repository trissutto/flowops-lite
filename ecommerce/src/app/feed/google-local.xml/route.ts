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
 * ── A REGRA DE OURO ──
 *
 * Só sai linha pra loja que TEM a peça. Anunciar na ficha de Piracicaba uma
 * blusa que só existe em Santos manda a cliente atravessar a cidade atrás de
 * peça que não tem — o estrago é maior que o ganho da vitrine inteira.
 */

/** O catálogo muda pouco durante o dia e o Google lê 1× — 1h é de sobra. */
export const revalidate = 3600;

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
  return `LURDS-${String(loja).trim().padStart(2, '0')}`;
}

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
  try {
    [pecas, estoques] = await Promise.all([
      api<PecaFeed[]>('/public/loja/feed?rev=1', {
        revalidate,
        tags: ['catalogo'],
        timeoutMs: 25000,
      }).then((r) => r ?? []),
      api<EstoqueLoja[]>('/public/loja/feed-local', {
        revalidate,
        tags: ['catalogo'],
        timeoutMs: 25000,
      }).then((r) => r ?? []),
    ]);
  } catch {
    /* silêncio proposital — ver acima */
  }

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

      for (const [loja, quantidade] of porLoja) {
        if (!(quantidade > 0)) continue;
        linhas.push(
          '<item>' +
            `<g:store_code>${escapar(codigoDaFicha(loja))}</g:store_code>` +
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

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=600, s-maxage=3600, stale-while-revalidate=86400',
    },
  });
}
