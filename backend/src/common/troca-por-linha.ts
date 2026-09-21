/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  TROCA POR LINHA — duas peças iguais são DUAS peças (21/09/2026)
 *
 *  Desde 29/08 ("peça é peça") todo pedido que entra explode a linha de
 *  quantity N em N linhas de 1: a cliente que compra 2 blusas iguais tem DUAS
 *  linhas no pedido, com o MESMO SKU. As telas de troca/devolução do pedido do
 *  site continuaram usando o SKU como identidade da peça, e quebraram quando
 *  ela quis trocar SÓ UMA:
 *
 *   - na tela da loja (/site/trocas) marcar uma linha marcava as duas, e o
 *     botão somava o preço das duas — não havia como escolher só uma;
 *   - o que já voltou era descontado de CADA linha do SKU: devolvida uma, as
 *     duas apareciam "tudo já devolvido" e a segunda nunca mais podia voltar
 *     (no portal da cliente, as duas viravam "já solicitada");
 *   - o backend validava contra a ÚLTIMA linha do SKU (um Map por SKU).
 *
 *  A régua:
 *   1. `saldoPorLinha` — o que já voltou é DISTRIBUÍDO pelas linhas do mesmo
 *      SKU (a de mesmo preço primeiro), nunca descontado de cada uma;
 *   2. `alocarPedidoDeTroca` — o que a tela pediu vira peças de LINHAS
 *      concretas: pela `linhaId` quando a tela manda (a da loja manda), ou pelo
 *      SKU, espalhando pelas linhas com saldo, quando não manda (o portal da
 *      cliente, que pergunta QUANTAS, e a aba velha aberta num PC de loja).
 *
 *  Mora no `common` pelo mesmo motivo do `troca-bloqueio.ts`: quem decide são
 *  os serviços de troca, mas o teste não pode depender de Nest nem de banco.
 * ═══════════════════════════════════════════════════════════════════════════
 */

export type LinhaDeTroca = {
  /** Identidade da LINHA do pedido (`order_items.id`). O SKU não serve: peças iguais repetem. */
  linhaId: string;
  sku: string;
  qty: number;
  /** Preço POR PEÇA — casa o que já voltou com a linha de mesmo preço. */
  precoUnit: number;
};

/** Peça que já saiu do saldo: devolução registrada ou troca ativa. */
export type PecaJaUsada = { sku: string; qty: number; precoUnit?: number | null };

export type SaldoDaLinha = { ja: number; disponivel: number };

/** O que a tela pediu: uma linha (`linhaId`) ou só um SKU com a quantidade. */
export type PedidoDaTela = { linhaId?: string | null; sku?: string | null; qty?: number | null };

export type Alocacao<L> = { linha: L; qty: number };

export type ErroDaAlocacao<L> =
  | { ok: false; erro: 'sem_sku' }
  | { ok: false; erro: 'linha_inexistente'; linhaId: string; sku: string }
  | { ok: false; erro: 'linha_mudou'; linha: L; skuPedido: string }
  | { ok: false; erro: 'fora_do_pedido'; sku: string }
  | { ok: false; erro: 'sem_saldo'; linha: L; sku: string; pedido: number; disponivel: number };

/**
 * Chave de comparação do SKU: sem espaço e sem zero à esquerda — o código do
 * catálogo é o mesmo com ou sem os zeros (`normalizeCodigo`).
 */
export function chaveSku(sku: unknown): string {
  return String(sku ?? '').trim().replace(/^0+(?=.)/, '');
}

function inteiro(n: unknown, minimo = 0): number {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) ? Math.max(minimo, v) : minimo;
}

function centavos(n: unknown): number | null {
  if (n == null || n === '') return null;
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v * 100) : null;
}

function mesmoPreco(a: unknown, b: unknown): boolean {
  const ca = centavos(a);
  return ca != null && ca === centavos(b);
}

/**
 * Quanto de cada LINHA ainda pode voltar, dado o que já voltou (ou está em
 * troca). O que já voltou é distribuído pelas linhas do mesmo SKU: primeiro as
 * de MESMO PREÇO (a peça que voltou valia aquilo), depois as outras, na ordem
 * do pedido. Voltou mais do que foi comprado (dado torto)? As linhas param em
 * zero — nunca negativo.
 */
export function saldoPorLinha(
  linhas: LinhaDeTroca[],
  usadas: PecaJaUsada[] | null | undefined,
): Map<string, SaldoDaLinha> {
  const livre = new Map<string, number>();
  for (const l of linhas) livre.set(l.linhaId, inteiro(l.qty));

  for (const u of usadas ?? []) {
    let falta = inteiro(u?.qty);
    if (!falta) continue;
    const chave = chaveSku(u.sku);
    const doSku = linhas.filter((l) => chaveSku(l.sku) === chave);
    const ordem = [
      ...doSku.filter((l) => mesmoPreco(l.precoUnit, u.precoUnit)),
      ...doSku.filter((l) => !mesmoPreco(l.precoUnit, u.precoUnit)),
    ];
    for (const l of ordem) {
      if (!falta) break;
      const tem = livre.get(l.linhaId) ?? 0;
      const tira = Math.min(tem, falta);
      livre.set(l.linhaId, tem - tira);
      falta -= tira;
    }
  }

  const saldo = new Map<string, SaldoDaLinha>();
  for (const l of linhas) {
    const disponivel = livre.get(l.linhaId) ?? 0;
    saldo.set(l.linhaId, { ja: inteiro(l.qty) - disponivel, disponivel });
  }
  return saldo;
}

/**
 * Transforma o que a tela pediu em peças de linhas concretas — ou diz por que
 * não dá (o serviço escreve a frase: a da loja fala com a vendedora, a do
 * portal fala com a cliente).
 *
 * Os pedidos COM `linhaId` são atendidos primeiro, a partir da linha pedida.
 * Os pedidos só com SKU pegam o que sobrou nas linhas daquele SKU, na ordem do
 * pedido. Uma linha nunca entrega mais do que o `disponivel` dela.
 *
 * ⚠️ PEÇAS IGUAIS SÃO INTERCAMBIÁVEIS. O registro da devolução/troca guarda
 * SKU e preço, não a linha — então QUAL das linhas iguais aparece como "já
 * devolvida" é escolha do `saldoPorLinha` (a primeira), não fato. Pedir a
 * linha X quer dizer "uma peça igual à X": se a própria X já está sem saldo
 * (a vendedora marcou a 2ª, o registro "gastou" a 1ª; ou a tela estava
 * aberta desde antes da outra devolução), a peça sai de outra linha de MESMO
 * SKU e MESMO PREÇO. Linha de preço diferente nunca substitui.
 */
export function alocarPedidoDeTroca<L extends LinhaDeTroca & { disponivel: number }>(
  linhas: L[],
  pedido: PedidoDaTela[] | null | undefined,
): { ok: true; alocacoes: Alocacao<L>[] } | ErroDaAlocacao<L> {
  const livre = new Map<string, number>();
  for (const l of linhas) livre.set(l.linhaId, inteiro(l.disponivel));
  const porLinha = new Map<string, number>();
  const alocar = (l: L, qty: number) => {
    livre.set(l.linhaId, (livre.get(l.linhaId) ?? 0) - qty);
    porLinha.set(l.linhaId, (porLinha.get(l.linhaId) ?? 0) + qty);
  };

  const lista = (pedido ?? []).filter(Boolean);
  const idDe = (p: PedidoDaTela) => String(p.linhaId ?? '').trim();

  for (const p of lista.filter((x) => idDe(x))) {
    const linhaId = idDe(p);
    const qty = inteiro(p.qty, 1);
    const linha = linhas.find((l) => l.linhaId === linhaId);
    if (!linha) {
      return { ok: false, erro: 'linha_inexistente', linhaId, sku: String(p.sku ?? '').trim() };
    }
    // A tela manda o SKU que ela MOSTROU. Se a linha mudou de peça depois
    // (troca de peça no pedido), devolver a peça errada é pior que recusar.
    const skuPedido = String(p.sku ?? '').trim();
    if (skuPedido && chaveSku(skuPedido) !== chaveSku(linha.sku)) {
      return { ok: false, erro: 'linha_mudou', linha, skuPedido };
    }
    // A própria linha primeiro; depois as IGUAIS a ela (mesmo SKU e preço).
    const iguais = [
      linha,
      ...linhas.filter(
        (l) => l !== linha && chaveSku(l.sku) === chaveSku(linha.sku) && mesmoPreco(l.precoUnit, linha.precoUnit),
      ),
    ];
    const tem = iguais.reduce((s, l) => s + Math.max(0, livre.get(l.linhaId) ?? 0), 0);
    if (qty > tem) {
      return { ok: false, erro: 'sem_saldo', linha, sku: linha.sku, pedido: qty, disponivel: tem };
    }
    let falta = qty;
    for (const l of iguais) {
      if (!falta) break;
      const q = Math.min(Math.max(0, livre.get(l.linhaId) ?? 0), falta);
      if (q > 0) {
        alocar(l, q);
        falta -= q;
      }
    }
  }

  for (const p of lista.filter((x) => !idDe(x))) {
    const sku = String(p.sku ?? '').trim();
    if (!sku) return { ok: false, erro: 'sem_sku' };
    const qty = inteiro(p.qty, 1);
    const doSku = linhas.filter((l) => chaveSku(l.sku) === chaveSku(sku));
    if (!doSku.length) return { ok: false, erro: 'fora_do_pedido', sku };
    const total = doSku.reduce((s, l) => s + Math.max(0, livre.get(l.linhaId) ?? 0), 0);
    if (qty > total) {
      return { ok: false, erro: 'sem_saldo', linha: doSku[0], sku, pedido: qty, disponivel: total };
    }
    let falta = qty;
    for (const l of doSku) {
      if (!falta) break;
      const q = Math.min(Math.max(0, livre.get(l.linhaId) ?? 0), falta);
      if (q > 0) {
        alocar(l, q);
        falta -= q;
      }
    }
  }

  return {
    ok: true,
    alocacoes: linhas
      .filter((l) => porLinha.has(l.linhaId))
      .map((l) => ({ linha: l, qty: porLinha.get(l.linhaId)! })),
  };
}

/**
 * Junta alocações que viram UM registro (mesmo SKU e mesmo preço, por
 * exemplo): duas blusas iguais devolvidas juntas continuam sendo uma linha
 * "qty 2" no registro da troca — o formato que o resto do sistema já lê.
 * Mantém a ordem de chegada; a linha representante é a primeira do grupo.
 */
export function somarPorChave<L>(
  alocacoes: Alocacao<L>[],
  chave: (linha: L) => string,
): Array<{ linha: L; qty: number; linhas: L[] }> {
  const grupos = new Map<string, { linha: L; qty: number; linhas: L[] }>();
  for (const a of alocacoes) {
    const k = chave(a.linha);
    const g = grupos.get(k);
    if (g) {
      g.qty += a.qty;
      g.linhas.push(a.linha);
    } else {
      grupos.set(k, { linha: a.linha, qty: a.qty, linhas: [a.linha] });
    }
  }
  return Array.from(grupos.values());
}

/** As linhas agrupadas por SKU, na ordem em que o SKU aparece no pedido. */
export function agruparPorSku<L extends { sku: string }>(linhas: L[]): L[][] {
  const grupos = new Map<string, L[]>();
  for (const l of linhas) {
    const k = chaveSku(l.sku);
    const g = grupos.get(k);
    if (g) g.push(l);
    else grupos.set(k, [l]);
  }
  return Array.from(grupos.values());
}
