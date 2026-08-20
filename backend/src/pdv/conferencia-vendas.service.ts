import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * CONFERÊNCIA DE VENDAS (20/08 — caso ON-000049 e os 24 sem prova).
 *
 * A venda online do PDV fecha por 4 caminhos, e dois deles ("PIX recebido" e
 * "Link externo") são a PALAVRA da vendedora: nenhum gateway confere, o
 * dinheiro cai numa conta que o sistema não enxerga. Medido em 20/08: dos 52
 * pedidos ON- criados desde 14/08, 24 (R$ 5.419) não tinham NENHUM registro
 * de pagamento — e 20 já estavam enviados/entregues. O ON-000049 saiu com
 * "recebemos seu pagamento" pra cliente que respondeu "Nao paguei ainda".
 *
 * Esta tela é o contraponto humano: a matriz olha o extrato da conta que
 * recebe os PIX/links manuais e CARIMBA cada pedido como conferido
 * (`vendaConferidaEm/Por` no Order). O que fica vermelho é exatamente o que
 * ninguém provou: sem gateway e sem carimbo.
 *
 * Só leitura + carimbo — nada aqui mexe em estoque, envio ou caixa.
 */
@Injectable()
export class ConferenciaVendasService {
  private readonly logger = new Logger(ConferenciaVendasService.name);

  constructor(private readonly prisma: PrismaService) {}

  private tipoLabel(tipo: string): string {
    switch (tipo) {
      case 'pix': return 'PIX recebido';
      case 'link': return 'Link externo';
      case 'pagarme_link': return 'Link Pagar.me';
      case 'pix_gerar': return 'PIX gerado';
      default: return 'sem detalhe';
    }
  }

  async listar(de?: string, ate?: string) {
    const where: any = { source: 'pdv_online' };
    if (de || ate) {
      where.wcDateCreated = {};
      // Dia inteiro no fuso da loja (BRT) — mesmo recorte das outras telas.
      if (de) where.wcDateCreated.gte = new Date(`${de}T00:00:00-03:00`);
      if (ate) where.wcDateCreated.lte = new Date(`${ate}T23:59:59.999-03:00`);
    }

    const orders: any[] = await (this.prisma as any).order.findMany({
      where,
      orderBy: { wcOrderId: 'desc' },
      select: {
        id: true, wcOrderId: true, wcOrderNumber: true, status: true,
        wcDateCreated: true, totalAmount: true, sellerStoreCode: true,
        customerName: true, customerPhone: true, checkoutInfo: true,
        shippingMethod: true, isPickup: true, trackingCode: true, carrier: true,
        vendaConferidaEm: true, vendaConferidaPor: true,
      },
    });
    if (!orders.length) return { rows: [], resumo: this.resumo([]) };

    const stores: any[] = await (this.prisma as any).store.findMany({
      select: { code: true, name: true },
    });
    const nomeLoja = new Map(stores.map((s) => [s.code, s.name]));

    // Payments de todas as vendas de uma vez (evita N+1).
    const saleIds: string[] = [];
    const metaPorOrder = new Map<string, any>();
    for (const o of orders) {
      let ck: any = {};
      try { ck = JSON.parse(o.checkoutInfo || '{}'); } catch {}
      metaPorOrder.set(o.id, ck);
      if (ck.pdvSaleId) saleIds.push(ck.pdvSaleId);
    }
    const pays: any[] = saleIds.length
      ? await (this.prisma as any).pdvSalePayment.findMany({
          where: { saleId: { in: saleIds } },
          select: { saleId: true, details: true },
        })
      : [];
    const paysPorSale = new Map<string, any[]>();
    for (const p of pays) {
      let det: any = null;
      try { det = JSON.parse(p.details || 'null'); } catch {}
      const arr = paysPorSale.get(p.saleId) || [];
      arr.push(det || {});
      paysPorSale.set(p.saleId, arr);
    }

    // Ids de gateway citados nos payments → busca os PAGOS em lote.
    const pagarmeIds = new Set<string>();
    const pagbankIds = new Set<string>();
    for (const dets of paysPorSale.values()) {
      for (const d of dets) {
        if (d?.pagarmeOrderId) pagarmeIds.add(String(d.pagarmeOrderId));
        const pb = d?.pagbankOrderId || d?.pixTxid;
        if (pb) pagbankIds.add(String(pb));
      }
    }
    const pagarmePagos = new Set(
      pagarmeIds.size
        ? (
            await (this.prisma as any).pagarmePayment.findMany({
              where: { pagarmeOrderId: { in: [...pagarmeIds] }, status: 'paid' },
              select: { pagarmeOrderId: true },
            })
          ).map((r: any) => r.pagarmeOrderId)
        : [],
    );
    const pagbankPagos = new Set(
      pagbankIds.size
        ? (
            await (this.prisma as any).pagbankPayment.findMany({
              where: { pagbankOrderId: { in: [...pagbankIds] }, status: 'paid' },
              select: { pagbankOrderId: true },
            })
          ).map((r: any) => r.pagbankOrderId)
        : [],
    );

    // Cards de separação — pra denunciar "ENVIADO sem separação" (ON-000049:
    // marcado shipped na mão com o card ainda 'new').
    const picks: any[] = await (this.prisma as any).pickOrder.findMany({
      where: { orderId: { in: orders.map((o) => o.id) } },
      select: { orderId: true, status: true },
    });
    const picksPorOrder = new Map<string, string[]>();
    for (const p of picks) {
      const arr = picksPorOrder.get(p.orderId) || [];
      arr.push(p.status);
      picksPorOrder.set(p.orderId, arr);
    }

    const rows = orders.map((o) => {
      const ck = metaPorOrder.get(o.id) || {};
      const dets = ck.pdvSaleId ? paysPorSale.get(ck.pdvSaleId) || [] : [];
      const tipos = dets.map((d) => this.tipoLabel(String(d?.tipo || '')));
      // TODOS os payments precisam de gateway PAGO — split com metade sem
      // prova conta como sem prova (na dúvida, fica vermelho).
      const prova =
        dets.length > 0 &&
        dets.every((d) => {
          if (d?.pagarmeOrderId && pagarmePagos.has(String(d.pagarmeOrderId))) return true;
          const pb = d?.pagbankOrderId || d?.pixTxid;
          return !!(pb && pagbankPagos.has(String(pb)));
        });
      const pickStatuses = picksPorOrder.get(o.id) || [];
      const enviadoSemSeparacao =
        ['shipped', 'delivered'].includes(o.status) &&
        pickStatuses.length > 0 &&
        pickStatuses.every((s) => s === 'new');
      return {
        orderId: o.id,
        numero: o.wcOrderNumber,
        wcOrderId: o.wcOrderId,
        criadoEm: o.wcDateCreated,
        status: o.status,
        loja: {
          code: o.sellerStoreCode,
          name: nomeLoja.get(o.sellerStoreCode) || o.sellerStoreCode || '—',
        },
        cliente: { nome: o.customerName, telefone: o.customerPhone },
        total: o.totalAmount,
        fechadoComo: tipos,
        prova,
        conferida: o.vendaConferidaEm
          ? { em: o.vendaConferidaEm, por: o.vendaConferidaPor }
          : null,
        entrega: o.shippingMethod || (o.isPickup ? 'RETIRADA' : null),
        rastreio: o.trackingCode
          ? { codigo: o.trackingCode, transportadora: o.carrier || 'Correios' }
          : null,
        quemFechou: ck.vendedora || null,
        enviadoSemSeparacao,
        separacao: pickStatuses,
      };
    });

    return { rows, resumo: this.resumo(rows) };
  }

  private resumo(rows: any[]) {
    const semProva = rows.filter((r) => !r.prova);
    const pendentes = semProva.filter((r) => !r.conferida);
    return {
      total: rows.length,
      comProva: rows.length - semProva.length,
      semProva: semProva.length,
      semProvaValor: Math.round(semProva.reduce((s, r) => s + (Number(r.total) || 0), 0) * 100) / 100,
      pendentes: pendentes.length,
      pendentesValor: Math.round(pendentes.reduce((s, r) => s + (Number(r.total) || 0), 0) * 100) / 100,
    };
  }

  /**
   * Carimbo humano: "olhei o extrato, o dinheiro deste pedido ENTROU".
   * `desfazer` tira o carimbo (marcou errado). Sempre deixa rastro no
   * histórico do pedido — carimbo sem autor não vale como conferência.
   */
  async conferir(orderId: string, usuario: string, desfazer = false) {
    const order = await (this.prisma as any).order.findUnique({
      where: { id: orderId },
      select: { id: true, wcOrderNumber: true, source: true },
    });
    if (!order || order.source !== 'pdv_online') {
      throw new NotFoundException('Pedido de venda online não encontrado');
    }
    await (this.prisma as any).order.update({
      where: { id: orderId },
      data: desfazer
        ? { vendaConferidaEm: null, vendaConferidaPor: null }
        : { vendaConferidaEm: new Date(), vendaConferidaPor: usuario || 'matriz' },
    });
    await (this.prisma as any).orderHistory
      .create({
        data: {
          orderId,
          note: desfazer
            ? `Conferência de pagamento DESFEITA por ${usuario || 'matriz'}`
            : `Pagamento CONFERIDO no extrato por ${usuario || 'matriz'} (tela Conferência de Vendas)`,
        },
      })
      .catch(() => null);
    this.logger.log(
      `[conferencia] ${order.wcOrderNumber} ${desfazer ? 'desconferido' : 'conferido'} por ${usuario}`,
    );
    return { ok: true };
  }
}
