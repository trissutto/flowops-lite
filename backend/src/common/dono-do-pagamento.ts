/**
 * DONO DO PAGAMENTO — a régua, num lugar só (20/09).
 *
 * Todo registro de `pagbank_payments`/`pagarme_payments` carrega um `saleId`,
 * e esse id pode apontar pra QUATRO coisas diferentes:
 *
 *   - venda do PDV            → `pdv_sales.id`
 *   - carrinho da live        → `live_pdv_carts.id`
 *   - baixa de crediário (PIX)→ `crediario_baixas.id`
 *   - pedido do site          → `orders.id` (Pagar.me desde o go-live, PagBank
 *                               desde 16/09 com `origem='site'`)
 *
 * O `GET /pdv/pix-orfaos` já conferia os quatro; o motor da conciliação nasceu
 * em 17/07 conhecendo só os dois primeiros. Resultado medido na tela em 20/09:
 * 1.519 "Pgto sem venda" — TODO pedido do site e TODA parcela de crediário
 * paga por PIX apareciam como dinheiro sem dono, e o órfão de verdade ficava
 * enterrado no meio. Duas réguas pro mesmo critério divergem; por isso esta.
 *
 * Em LOTE de propósito: o motor passa ~5 mil transações por vez, e 4 consultas
 * por transação viravam ~20 mil idas ao banco.
 *
 * ⚠️ Erro do banco SOBE. Nada de `catch` devolvendo "não achei": consulta que
 * falhou com cara de "sem dono" carimbaria venda boa como órfã (a família
 * "fonte morta com cara de não-existe").
 */

export type TipoDono = 'pdv' | 'live' | 'crediario' | 'site';

export interface DonoDoPagamento {
  tipo: TipoDono;
  /** Quanto o SISTEMA espera que aquele pagamento valha, em centavos. */
  cents: number | null;
  clienteNome: string | null;
}

export const ROTULO_DONO: Record<TipoDono, string> = {
  pdv: 'venda do PDV',
  live: 'carrinho da live',
  crediario: 'baixa de crediário',
  site: 'pedido do site',
};

/** Reais (Float do banco) → centavos. Lixo vira null, nunca zero. */
export function reaisParaCents(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/**
 * Quanto do crediário passou pelo gateway. Na baixa MISTA (dinheiro + PIX) o
 * QR sai só pelo `valorPix` — comparar com o `totalPago` acusaria divergência
 * falsa do tamanho do dinheiro que entrou no caixa.
 */
export function centsDaBaixaNoGateway(b: {
  formaPagamento?: string | null;
  valorPix?: number | null;
  totalPago?: number | null;
}): number | null {
  const pix = Number(b?.valorPix);
  if (String(b?.formaPagamento || '') === 'misto' && Number.isFinite(pix) && pix > 0) {
    return reaisParaCents(pix);
  }
  return reaisParaCents(b?.totalPago);
}

const LOTE = 1000;

/**
 * Resolve o dono de cada `saleId`. Quem não aparece no Map não tem dono em
 * lugar nenhum — esse é o órfão de verdade.
 */
export async function donosDosPagamentos(
  prisma: any,
  saleIds: Array<string | null | undefined>,
): Promise<Map<string, DonoDoPagamento>> {
  const ids = Array.from(new Set(saleIds.map((s) => String(s || '').trim()).filter(Boolean)));
  const out = new Map<string, DonoDoPagamento>();

  for (let i = 0; i < ids.length; i += LOTE) {
    const lote = ids.slice(i, i + LOTE);
    const where = { id: { in: lote } };
    const [vendas, carrinhos, baixas, pedidos] = await Promise.all([
      prisma.pdvSale.findMany({ where, select: { id: true, total: true, customerName: true } }),
      prisma.livePdvCart.findMany({ where, select: { id: true, totalCents: true, customerName: true } }),
      prisma.crediarioBaixa.findMany({
        where,
        select: { id: true, formaPagamento: true, valorPix: true, totalPago: true, customerName: true },
      }),
      prisma.order.findMany({ where, select: { id: true, totalAmount: true, customerName: true } }),
    ]);

    // Ordem inversa de precedência: quem grava por último ganha (pdv > live >
    // crediário > site). Os ids são uuid — colisão é teórica, mas a ordem fica
    // escrita pra não depender de sorte.
    for (const p of pedidos as any[]) {
      out.set(p.id, { tipo: 'site', cents: reaisParaCents(p.totalAmount), clienteNome: p.customerName || null });
    }
    for (const b of baixas as any[]) {
      out.set(b.id, { tipo: 'crediario', cents: centsDaBaixaNoGateway(b), clienteNome: b.customerName || null });
    }
    for (const c of carrinhos as any[]) {
      const cents = Number(c.totalCents);
      out.set(c.id, { tipo: 'live', cents: Number.isFinite(cents) ? cents : null, clienteNome: c.customerName || null });
    }
    for (const v of vendas as any[]) {
      out.set(v.id, { tipo: 'pdv', cents: reaisParaCents(v.total), clienteNome: v.customerName || null });
    }
  }
  return out;
}
