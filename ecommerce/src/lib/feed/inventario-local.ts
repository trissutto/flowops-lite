import { chaveDeCor, variantes, type PecaFeed } from './variantes';

/**
 * AS LINHAS DO INVENTÁRIO LOCAL — "esta peça está NESTA loja, nesta quantidade".
 *
 * Saiu de dentro de `app/feed/google-local.xml/route.ts` em 05/10/2026 pra
 * poder ser testada: é a regra que o Google AUDITA na loja, e errar aqui não
 * dá erro em lugar nenhum — dá verificação de inventário reprovada.
 *
 * ── 🚨 A REGRA DE 13/09 FOI O QUE REPROVOU A VERIFICAÇÃO (05/10/2026) ──
 *
 * Em 13/09 o feed passou a mandar o estoque da REDE nas 14 fichas ("as lojas
 * podem pegar de outra loja pra atender"): toda peça que a rede tinha saía
 * como `in_stock`, retirada `same_day`, em TODAS as lojas, com a quantidade da
 * rede inteira.
 *
 * Só que o Google não aceita a palavra do feed: antes de liberar os anúncios
 * de inventário local ele faz a VERIFICAÇÃO DE INVENTÁRIO — sorteia até 100
 * itens de uma loja e confere, com foto da etiqueta, se a peça está na arara
 * daquela loja e com aquele preço. Em 23/09 a resposta veio: "alta
 * discrepância entre os dados de inventário enviados e o que foi confirmado
 * na loja" (tíquete 2-7239000041546). Enquanto isso não passa, NENHUMA oferta
 * local é elegível — é a metade "reprovada" que o Google Ads mostra nas
 * campanhas com produto local ligado, e a vitrine da ficha não aparece em
 * loja nenhuma.
 *
 * Medido em 05/10 na loja 01 (a sorteada): dos 82 itens declarados "em
 * estoque, retirada no mesmo dia", a loja NÃO tinha 6 e tinha 1 ou 2 unidades
 * de outros 24. Em Jundiaí faltavam 13 dos 82.
 *
 * Por isso o padrão voltou a ser o que a prateleira diz: **só sai linha pra
 * loja que TEM a peça, com a quantidade DELA**. A transferência entre lojas
 * continua existindo na operação — ela só não pode ser declarada ao Google
 * como "está aqui hoje", porque é exatamente isso que ele vai conferir.
 *
 * `FEED_LOCAL_ESTOQUE_REDE=1` (Vercel) volta à regra de 13/09. Só faz sentido
 * ligar DEPOIS que a verificação estiver aprovada — e sabendo que uma nova
 * auditoria do Google pega a divergência de novo.
 */

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
export const LOJAS_COM_FICHA: ReadonlySet<string> = new Set([
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

/** `1`, `07`, ` 7 ` → `07`. A mesma chave que o código da ficha usa. */
export const numeroDaLoja = (loja: string) => String(loja).trim().padStart(2, '0');

/** Uma linha de estoque por (peça × cor × loja), vinda do backend. */
export interface EstoqueLoja {
  loja: string;
  ref: string;
  cor: string | null;
  estoque: number;
}

/** Uma linha do feed: a peça `id` existe na loja `loja`, nesta quantidade. */
export interface LinhaInventario {
  /** Número da loja no Flow, com dois dígitos (`01`, `18`). */
  loja: string;
  /** O MESMO `id` do feed nacional — sai de `variantes()`. */
  id: string;
  quantidade: number;
  preco: number;
}

export function linhasDeInventarioLocal(
  pecas: readonly PecaFeed[],
  estoques: readonly EstoqueLoja[],
  opcoes: { estoqueDaRede?: boolean } = {},
): LinhaInventario[] {
  /**
   * Índice do estoque: `REF` → `COR normalizada` → loja (2 dígitos) → quantidade.
   *
   * A cor é normalizada porque as duas pontas vêm do mesmo `wincred_produtos`
   * mas por caminhos diferentes, e chegam com acento e caixa variando —
   * "CAFÉ" contra "CAFE" já custou uma vitrine inteira antes.
   *
   * ⚠️ Só entra loja COM FICHA. Depósito, matriz e sobretudo a 13/SITE ficam
   * de fora: a do site não é prateleira, é o estoque separado pro e-commerce,
   * e a regra da casa é que ela não cede peça pra loja.
   */
  const porRef = new Map<string, Map<string, Map<string, number>>>();
  for (const e of estoques) {
    if (!e.ref || !e.loja || !(e.estoque > 0)) continue;
    const numero = numeroDaLoja(e.loja);
    if (!LOJAS_COM_FICHA.has(numero)) continue;
    const ref = e.ref.trim().toUpperCase();
    const cor = chaveDeCor(e.cor);
    if (!porRef.has(ref)) porRef.set(ref, new Map());
    const porCor = porRef.get(ref)!;
    if (!porCor.has(cor)) porCor.set(cor, new Map());
    const porLoja = porCor.get(cor)!;
    porLoja.set(numero, (porLoja.get(numero) ?? 0) + e.estoque);
  }

  /** Soma todas as cores de uma REF — o caso da peça de cor única. */
  function todasAsCores(ref: string): Map<string, number> {
    const total = new Map<string, number>();
    for (const porLoja of porRef.get(ref)?.values() ?? []) {
      for (const [loja, qtd] of porLoja) total.set(loja, (total.get(loja) ?? 0) + qtd);
    }
    return total;
  }

  const linhas: LinhaInventario[] = [];

  for (const p of pecas) {
    if (!p.ref || !p.slug || !(p.preco > 0)) continue;
    const ref = p.ref.trim().toUpperCase();
    const vars = variantes(p);
    /**
     * Peça de cor única sai como um item só no feed nacional — então aqui ela
     * soma o estoque de TODAS as cores por loja. Peça explodida por cor casa
     * cor a cor: é o que faz a ficha mostrar a blusa preta onde tem preta e a
     * vinho onde tem vinho.
     */
    const corUnica = vars.length === 1;

    for (const v of vars) {
      const preco = p.precoPromocional && p.precoPromocional > 0 ? p.precoPromocional : p.preco;
      const porLoja: Map<string, number> = corUnica
        ? todasAsCores(ref)
        : (porRef.get(ref)?.get(chaveDeCor(v.cor)) ?? new Map<string, number>());

      let totalRede = 0;
      for (const qtd of porLoja.values()) if (qtd > 0) totalRede += qtd;
      // Peça que a rede NÃO tem não entra em ficha nenhuma, em regra nenhuma.
      if (!(totalRede > 0)) continue;

      for (const numero of LOJAS_COM_FICHA) {
        const quantidade = opcoes.estoqueDaRede ? totalRede : (porLoja.get(numero) ?? 0);
        // A prateleira manda: loja sem a peça não a declara "em estoque".
        if (!(quantidade > 0)) continue;
        linhas.push({ loja: numero, id: v.id, quantidade, preco });
      }
    }
  }

  return linhas;
}
