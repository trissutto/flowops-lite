import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RoutingService } from '../routing/routing.service';
import { ehLojaCanal } from '../common/loja-canal';

/**
 * LASTRO DA VENDA À DISTÂNCIA (26/08 — caso ON-000110/ON-000162).
 *
 * As duas vendas do carrossel de hoje foram fechadas no PDV com ZERO peça
 * real na rede — a vendedora não tinha como saber: nada checa lastro na
 * venda online. O pedido nascia, o roteamento não achava ninguém, a matriz
 * forçava loja a loja e cada loja perdia meia hora procurando peça que não
 * existe. A trava certa é na PORTA: avisar ANTES de fechar a venda.
 *
 * Semáforo por SKU do carrinho (decisão do dono, 26/08):
 *   verde    — tem peça disponível na rede (estoque − prometida a card aberto)
 *   amarelo  — dá pra vender mas com ressalva: só parte da quantidade, tudo
 *              já prometido a outro pedido, ou a peça está DENTRO DE CAIXA EM
 *              TRÂNSITO entre lojas ("vamos deixar de vender peça que está
 *              chegando?" — NÃO; o limbo da remessa não é ruptura)
 *   vermelho — não existe em loja nenhuma NEM em trânsito. Vender exige o
 *              "Vender mesmo assim" (fica registrado em integration_log).
 *
 * Só vale pra venda À DISTÂNCIA (online/entrega): balcão com a peça na mão
 * bipada NUNCA passa por aqui — a peça física é a prova (mesma filosofia do
 * garantirNaoDuplicaBipe). Loja-canal (13/SITE) não conta como lastro.
 */
@Injectable()
export class LastroRedeService {
  private readonly logger = new Logger(LastroRedeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly routing: RoutingService,
  ) {}

  private semZeros(v: any): string {
    return String(v ?? '').trim().replace(/^0+/, '');
  }

  async checar(itens: Array<{ sku: string; qty?: number }>) {
    const precisaPorSku = new Map<string, number>();
    for (const it of itens ?? []) {
      const sku = this.semZeros(it?.sku);
      if (!sku) continue;
      const qty = Math.max(1, Number(it?.qty) || 1);
      precisaPorSku.set(sku, (precisaPorSku.get(sku) ?? 0) + qty);
    }
    const skus = Array.from(precisaPorSku.keys());
    if (!skus.length) return { porSku: {} };

    const stores = await this.prisma.store.findMany({
      where: { active: true },
      select: { code: true, name: true },
    });
    const lojas = stores.filter((s) => !ehLojaCanal(s.code));
    const codes = lojas.map((s) => s.code);

    // Estoque bruto por loja (raw pra casar zeros à esquerda do codigo).
    const rows: Array<{ sku: string; loja: string; estoque: number }> =
      await this.prisma.$queryRawUnsafe(
        `SELECT regexp_replace(codigo,'^0+','') AS sku, loja, estoque::int AS estoque
           FROM giga_estoque
          WHERE regexp_replace(codigo,'^0+','') = ANY($1) AND estoque > 0`,
        skus,
      );

    // Prometida a card aberto — a MESMA conta do roteamento (esperado − bipado).
    const committed = await this.routing.getCommittedStock(skus, codes);

    // Peça dentro de caixa EM TRÂNSITO entre lojas (limbo da remessa: saiu da
    // origem, ainda não entrou no destino). Caixa de juntada (orderId != null)
    // carrega peça JÁ VENDIDA — não é lastro.
    const caixas: Array<{ id: string; code: string; toStoreCode: string; toStoreName: string; sentAt: Date | null }> =
      await (this.prisma as any).realignmentShipment.findMany({
        where: { status: 'in_transit', orderId: null },
        select: { id: true, code: true, toStoreCode: true, toStoreName: true, sentAt: true },
      });
    const caixaPorId = new Map(caixas.map((c) => [c.id, c]));
    // 1 linha de TransferOrder = 1 peça bipada na caixa.
    const pecasEmCaixa: Array<{ shipmentId: string | null; codigoBipado: string | null }> =
      caixas.length
        ? await (this.prisma as any).transferOrder.findMany({
            where: { shipmentId: { in: caixas.map((c) => c.id) } },
            select: { shipmentId: true, codigoBipado: true },
          })
        : [];

    const canalCodes = new Set(stores.filter((s) => ehLojaCanal(s.code)).map((s) => s.code));
    const porSku: Record<string, any> = {};
    for (const sku of skus) {
      const precisa = precisaPorSku.get(sku) ?? 1;
      let bruto = 0;
      let disponivel = 0;
      let prometidas = 0;
      for (const r of rows) {
        if (r.sku !== sku) continue;
        const loja = String(r.loja ?? '').trim();
        if (canalCodes.has(loja) || ehLojaCanal(loja)) continue;
        const est = Number(r.estoque) || 0;
        const prom = committed.get(`${loja}::${sku}`) ?? 0;
        bruto += est;
        prometidas += Math.min(est, prom);
        disponivel += Math.max(0, est - prom);
      }

      const transitoPorCaixa = new Map<string, number>();
      for (const p of pecasEmCaixa) {
        if (this.semZeros(p.codigoBipado) !== sku) continue;
        if (!p.shipmentId) continue;
        transitoPorCaixa.set(p.shipmentId, (transitoPorCaixa.get(p.shipmentId) ?? 0) + 1);
      }
      const transito = Array.from(transitoPorCaixa.entries()).map(([shipmentId, qty]) => {
        const c = caixaPorId.get(shipmentId)!;
        const dias = c.sentAt
          ? Math.floor((Date.now() - new Date(c.sentAt).getTime()) / 86_400_000)
          : null;
        return { caixa: c.code, paraLoja: c.toStoreCode, paraLojaNome: c.toStoreName, qty, dias };
      });
      const transitoQty = transito.reduce((a, t) => a + t.qty, 0);

      let status: 'verde' | 'amarelo' | 'vermelho';
      let motivo: string | null = null;
      if (disponivel >= precisa) {
        status = 'verde';
      } else if (disponivel > 0) {
        status = 'amarelo';
        motivo = 'parcial';
      } else if (transitoQty > 0) {
        status = 'amarelo';
        motivo = 'transito';
      } else if (bruto > 0) {
        status = 'amarelo';
        motivo = 'prometida';
      } else {
        status = 'vermelho';
        motivo = 'inexistente';
      }
      porSku[sku] = { status, motivo, precisa, disponivel, bruto, prometidas, transito };
    }

    return { porSku };
  }

  /**
   * "Vender mesmo assim" — a vendedora viu o vermelho e decidiu seguir.
   * Não bloqueia nada (a decisão é dela com a cliente na linha); só deixa a
   * assinatura no log pra linha do tempo do sufoco seguinte ter autor.
   */
  async registrarOverride(input: {
    storeId?: string | null;
    userId?: string | null;
    saleId?: string | null;
    skus: string[];
  }) {
    await this.prisma.integrationLog.create({
      data: {
        source: 'pdv',
        direction: 'internal',
        event: 'venda.sem-lastro.confirmada',
        payload: JSON.stringify({
          storeId: input.storeId ?? null,
          userId: input.userId ?? null,
          saleId: input.saleId ?? null,
          skus: input.skus,
        }),
        status: 200,
      },
    });
    return { ok: true };
  }
}
