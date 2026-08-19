import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CorreiosService } from '../correios/correios.service';
import { MaisEnviosService } from '../mais-envios/mais-envios.service';
import { servicoPagoDoPedido } from '../common/servico-envio';

/**
 * Gestão › FRETE — todos os SEDEX/PAC postados (pra cliente e entre lojas)
 * com o frete COBRADO da cliente × o frete PAGO ao transportador.
 *
 * Fontes (união):
 *  - PickOrder com etiqueta gerada (correiosGeneratedAt) → envio pra CLIENTE
 *    (ou pra outra loja quando isTransfer). Cobrado vem do snapshot do
 *    checkout (Order.checkoutInfo) ou do carrinho da live (freteCents).
 *  - RealignmentShipment com etiqueta (envioGeneratedAt) → remessa ENTRE LOJAS.
 *    Nunca tem cobrado (é custo interno).
 *
 * Pago = `fretePagoCents` (capturado na geração desde 19/08). Envio antigo sem
 * valor: `recotarPendentes` cota o preço de HOJE e grava como 'recotacao'
 * (estimado), ou a matriz digita o valor da fatura ('manual').
 */
export type FreteRow = {
  kind: 'pick' | 'remessa';
  id: string;
  data: string;                 // ISO — quando a etiqueta foi gerada
  tipo: 'cliente' | 'loja';
  origemStoreCode: string | null;
  origemStoreName: string | null;
  destino: string;              // nome da cliente ou loja destino
  destinoUf: string | null;
  referencia: string;           // nº do pedido / código da remessa
  canal: string;                // site | live | ecommerce | pdv_online | transferencia | realinhamento
  servico: 'SEDEX' | 'PAC' | null;
  transportador: 'Correios' | 'Mais Envios' | null;
  carrier: string | null;
  trackingCode: string | null;
  pecas: number;
  cobradoCents: number | null;  // o que a cliente pagou de frete (null = não se aplica/desconhecido)
  cobradoDuplicado: boolean;    // pedido dividido: frete já contado noutra linha
  pagoCents: number | null;
  pagoOrigem: string | null;    // cotacao | recotacao | manual
  pagoEm: string | null;
};

const digits = (v: any) => String(v ?? '').replace(/\D/g, '');

function transportadorDe(carrier?: string | null): 'Correios' | 'Mais Envios' | null {
  const c = String(carrier || '').toLowerCase();
  if (!c) return null;
  if (c.includes('mais envios') || c.includes('maisenvios')) return 'Mais Envios';
  return 'Correios';
}
function servicoDe(carrier?: string | null): 'SEDEX' | 'PAC' | null {
  const c = String(carrier || '').toUpperCase();
  if (c.includes('SEDEX')) return 'SEDEX';
  if (c.includes('PAC')) return 'PAC';
  return null;
}

@Injectable()
export class FreteReportService {
  private readonly logger = new Logger(FreteReportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly correios: CorreiosService,
    private readonly maisEnvios: MaisEnviosService,
  ) {}

  /** Frete COBRADO da cliente, em centavos. Null quando o pedido não guarda o valor. */
  private cobradoDoPedido(order: any, liveCart: any | null): number | null {
    if (!order) return null;
    if (order.source === 'live') {
      return liveCart ? Number(liveCart.freteCents || 0) : null;
    }
    if (order.checkoutInfo) {
      try {
        const ci = JSON.parse(order.checkoutInfo);
        const v = ci?.shipping?.price ?? ci?.shippingPrice;
        if (v != null && Number.isFinite(Number(v))) return Math.round(Number(v) * 100);
      } catch { /* JSON quebrado → desconhecido */ }
    }
    // Pedido do WooCommerce antigo não persiste o valor do frete no Flow.
    return null;
  }

  async report(from: Date, to: Date, opts: { tipo?: 'all' | 'cliente' | 'loja'; storeCode?: string } = {}) {
    const tipo = opts.tipo || 'all';
    const storeCode = String(opts.storeCode || '').trim();

    const rows: FreteRow[] = [];

    // ── 1) PickOrders com etiqueta (cliente, ou loja quando isTransfer) ──
    {
      const picks: any[] = await this.prisma.pickOrder.findMany({
        where: {
          correiosGeneratedAt: { gte: from, lte: to },
          trackingCode: { not: null },
          ...(storeCode ? { store: { code: storeCode } } : {}),
        },
        include: {
          store: { select: { code: true, name: true } },
          order: {
            select: {
              id: true, wcOrderNumber: true, source: true, customerName: true, checkoutInfo: true,
              shippingAddress: true, shippingMethod: true, liveCartId: true, isPickup: true,
              items: { select: { quantity: true, assignedStoreId: true } },
            },
          },
        },
        orderBy: { correiosGeneratedAt: 'desc' },
      });

      const cartIds = picks.map((p) => p.order?.liveCartId).filter(Boolean) as string[];
      const carts: any[] = cartIds.length
        ? await (this.prisma as any).livePdvCart.findMany({ where: { id: { in: cartIds } }, select: { id: true, freteCents: true, customerUf: true } })
        : [];
      const cartById = new Map(carts.map((c) => [c.id, c]));

      // Pedido dividido em mais de uma loja: o frete cobrado é UM só — conta
      // na primeira linha (mais antiga) e marca as demais como duplicadas.
      const vistos = new Set<string>();
      const ordenadosAsc = [...picks].sort((a, b) => +new Date(a.correiosGeneratedAt) - +new Date(b.correiosGeneratedAt));
      const duplicada = new Map<string, boolean>();
      for (const p of ordenadosAsc) {
        duplicada.set(p.id, vistos.has(p.orderId));
        vistos.add(p.orderId);
      }

      for (const p of picks) {
        const o = p.order;
        const cart = o?.liveCartId ? cartById.get(o.liveCartId) : null;
        let uf: string | null = cart?.customerUf || null;
        if (!uf && o?.shippingAddress) {
          try { const a = JSON.parse(o.shippingAddress); uf = a?.state || a?.uf || null; } catch { /* */ }
        }
        const isTransfer = !!p.isTransfer;
        const rowTipo: 'cliente' | 'loja' = isTransfer ? 'loja' : 'cliente';
        if (tipo !== 'all' && rowTipo !== tipo) continue;

        const itens = (o?.items || []).filter((i: any) => !i.assignedStoreId || i.assignedStoreId === p.storeId);
        const lista = itens.length ? itens : (o?.items || []);
        const pecas = lista.reduce((s: number, i: any) => s + (Number(i.quantity) || 1), 0);

        const servico = servicoDe(p.carrier) || (o ? servicoPagoDoPedido(o, uf || undefined).servico : null);
        const cobrado = isTransfer ? null : this.cobradoDoPedido(o, cart);

        rows.push({
          kind: 'pick',
          id: p.id,
          data: new Date(p.correiosGeneratedAt).toISOString(),
          tipo: rowTipo,
          origemStoreCode: p.store?.code || null,
          origemStoreName: p.store?.name || null,
          destino: isTransfer ? `Loja ${p.transferToStoreCode || '?'}` : (o?.customerName || 'Cliente'),
          destinoUf: uf ? String(uf).toUpperCase() : null,
          referencia: o?.wcOrderNumber ? `#${o.wcOrderNumber}` : String(o?.id || p.id).slice(0, 8),
          canal: isTransfer ? 'transferencia' : String(o?.source || 'site'),
          servico,
          transportador: transportadorDe(p.carrier),
          carrier: p.carrier || null,
          trackingCode: p.trackingCode || null,
          pecas,
          cobradoCents: cobrado,
          cobradoDuplicado: !!duplicada.get(p.id) && cobrado != null,
          pagoCents: p.fretePagoCents ?? null,
          pagoOrigem: p.fretePagoOrigem ?? null,
          pagoEm: p.fretePagoEm ? new Date(p.fretePagoEm).toISOString() : null,
        });
      }
    }

    // ── 2) Remessas entre lojas com etiqueta ──
    if (tipo !== 'cliente') {
      const rems: any[] = await this.prisma.realignmentShipment.findMany({
        where: {
          envioGeneratedAt: { gte: from, lte: to },
          trackingCode: { not: null },
          ...(storeCode ? { fromStoreCode: storeCode } : {}),
        },
        orderBy: { envioGeneratedAt: 'desc' },
      });
      for (const r of rems) {
        rows.push({
          kind: 'remessa',
          id: r.id,
          data: new Date(r.envioGeneratedAt).toISOString(),
          tipo: 'loja',
          origemStoreCode: r.fromStoreCode || null,
          origemStoreName: r.fromStoreName || null,
          destino: r.toStoreName || r.toStoreCode || 'Loja',
          destinoUf: null,
          referencia: r.code || r.id.slice(0, 8),
          canal: String(r.tipo || 'transferencia').toLowerCase(),
          servico: servicoDe(r.carrier) || 'SEDEX',
          transportador: transportadorDe(r.carrier),
          carrier: r.carrier || null,
          trackingCode: r.trackingCode || null,
          pecas: Number(r.totalQty || 0),
          cobradoCents: null,
          cobradoDuplicado: false,
          pagoCents: r.fretePagoCents ?? null,
          pagoOrigem: r.fretePagoOrigem ?? null,
          pagoEm: r.fretePagoEm ? new Date(r.fretePagoEm).toISOString() : null,
        });
      }
    }

    rows.sort((a, b) => +new Date(b.data) - +new Date(a.data));

    // ── Totais ──
    const soma = (arr: FreteRow[], f: (r: FreteRow) => number) => arr.reduce((s, r) => s + f(r), 0);
    const cobrado = (r: FreteRow) => (r.cobradoCents != null && !r.cobradoDuplicado ? r.cobradoCents : 0);
    const pago = (r: FreteRow) => r.pagoCents ?? 0;
    const block = (arr: FreteRow[]) => ({
      envios: arr.length,
      pecas: soma(arr, (r) => r.pecas),
      cobradoCents: soma(arr, cobrado),
      pagoCents: soma(arr, pago),
      semPago: arr.filter((r) => r.pagoCents == null).length,
      semCobrado: arr.filter((r) => r.tipo === 'cliente' && r.cobradoCents == null).length,
      estimados: arr.filter((r) => r.pagoOrigem === 'recotacao').length,
    });
    const cliente = rows.filter((r) => r.tipo === 'cliente');
    const loja = rows.filter((r) => r.tipo === 'loja');
    const totais = { geral: block(rows), cliente: block(cliente), loja: block(loja) };

    // Por loja de origem
    const porLojaMap = new Map<string, FreteRow[]>();
    for (const r of rows) {
      const k = r.origemStoreCode || '—';
      if (!porLojaMap.has(k)) porLojaMap.set(k, []);
      porLojaMap.get(k)!.push(r);
    }
    const porLoja = [...porLojaMap.entries()]
      .map(([code, arr]) => ({ storeCode: code, storeName: arr[0]?.origemStoreName || code, ...block(arr) }))
      .sort((a, b) => b.envios - a.envios);

    // Por transportador × serviço
    const porServicoMap = new Map<string, FreteRow[]>();
    for (const r of rows) {
      const k = `${r.transportador || '?'} ${r.servico || '?'}`;
      if (!porServicoMap.has(k)) porServicoMap.set(k, []);
      porServicoMap.get(k)!.push(r);
    }
    const porServico = [...porServicoMap.entries()].map(([label, arr]) => ({ label, ...block(arr) })).sort((a, b) => b.envios - a.envios);

    return { from: from.toISOString(), to: to.toISOString(), tipo, storeCode: storeCode || null, totais, porLoja, porServico, rows };
  }

  // ─────────────────────────────────────────────────────────────
  // Custo PAGO: edição manual (fatura) e recotação dos pendentes
  // ─────────────────────────────────────────────────────────────

  async setPagoManual(kind: 'pick' | 'remessa', id: string, valorReais: number | null) {
    const cents = valorReais == null ? null : Math.round(Number(valorReais) * 100);
    if (cents != null && (!Number.isFinite(cents) || cents < 0)) throw new BadRequestException('Valor inválido');
    const data = cents == null
      ? { fretePagoCents: null, fretePagoOrigem: null, fretePagoEm: null }
      : { fretePagoCents: cents, fretePagoOrigem: 'manual', fretePagoEm: new Date() };
    if (kind === 'pick') {
      const p = await this.prisma.pickOrder.findUnique({ where: { id } });
      if (!p) throw new NotFoundException('Envio não encontrado');
      await this.prisma.pickOrder.update({ where: { id }, data });
    } else {
      const r = await this.prisma.realignmentShipment.findUnique({ where: { id } });
      if (!r) throw new NotFoundException('Remessa não encontrada');
      await this.prisma.realignmentShipment.update({ where: { id }, data });
    }
    return { ok: true, kind, id, fretePagoCents: cents };
  }

  /** CEP da loja (config fiscal). Null se não tiver. */
  private async cepDaLoja(storeCode: string | null): Promise<string | null> {
    if (!storeCode) return null;
    try {
      const cfg: any = await this.prisma.nfceConfig.findUnique({ where: { storeCode } });
      if (!cfg) return null;
      for (const raw of [cfg.nfeEndereco, cfg.endereco]) {
        if (!raw) continue;
        try { const e = JSON.parse(String(raw)); const cep = digits(e?.cep); if (cep.length === 8) return cep; } catch { /* */ }
      }
    } catch { /* */ }
    return null;
  }

  /** Cota o custo de HOJE pra um envio (origem loja → destino) no provedor que postou. */
  private async cotarCusto(input: {
    transportador: 'Correios' | 'Mais Envios' | null; servico: 'SEDEX' | 'PAC';
    cepOrigem: string | null; cepDestino: string; pesoGramas: number;
  }): Promise<number | null> {
    if (digits(input.cepDestino).length !== 8) return null;
    if (input.transportador === 'Mais Envios') {
      try {
        const cot: any = await this.maisEnvios.calcularFrete({ cepDestino: input.cepDestino, cepOrigem: input.cepOrigem || undefined, pesoGramas: input.pesoGramas });
        const op = (cot?.opcoes || []).find((o: any) => String(o.servico).toUpperCase().includes(input.servico));
        return op?.precoReais ? Number(op.precoReais) : null;
      } catch (e: any) {
        this.logger.warn(`[frete] recotação Mais Envios falhou: ${e?.message || e}`);
        return null;
      }
    }
    return this.correios.cotarCustoEnvio({ servico: input.servico, cepOrigem: input.cepOrigem || undefined, cepDestino: input.cepDestino, pesoGramas: input.pesoGramas });
  }

  /**
   * Recota os envios SEM custo no intervalo (máx `limit` por chamada — cada um
   * é 1-2 chamadas HTTP no transportador). Grava como 'recotacao' (estimado).
   */
  async recotarPendentes(from: Date, to: Date, limit = 25) {
    const max = Math.min(Math.max(1, Number(limit) || 25), 100);
    let feitos = 0, falhas = 0;
    const detalhes: Array<{ kind: string; id: string; referencia: string; precoReais: number | null }> = [];

    const picks: any[] = await this.prisma.pickOrder.findMany({
      where: { correiosGeneratedAt: { gte: from, lte: to }, trackingCode: { not: null }, fretePagoCents: null },
      include: {
        store: { select: { code: true } },
        order: { select: { wcOrderNumber: true, shippingCep: true, shippingAddress: true, liveCartId: true, shippingMethod: true, checkoutInfo: true, items: { select: { quantity: true, assignedStoreId: true } } } },
      },
      orderBy: { correiosGeneratedAt: 'desc' },
      take: max,
    });
    for (const p of picks) {
      const o = p.order;
      let cepDest = digits(o?.shippingCep);
      let uf: string | undefined;
      if (o?.shippingAddress) { try { const a = JSON.parse(o.shippingAddress); if (!cepDest) cepDest = digits(a?.postcode || a?.cep); uf = a?.state || a?.uf; } catch { /* */ } }
      if (!cepDest && o?.liveCartId) {
        const cart: any = await (this.prisma as any).livePdvCart.findUnique({ where: { id: o.liveCartId }, select: { customerCep: true, customerUf: true } });
        cepDest = digits(cart?.customerCep); uf = cart?.customerUf || uf;
      }
      if (p.isTransfer && !cepDest) cepDest = (await this.cepDaLoja(p.transferToStoreCode)) || '';
      const itens = (o?.items || []).filter((i: any) => !i.assignedStoreId || i.assignedStoreId === p.storeId);
      const lista = itens.length ? itens : (o?.items || []);
      const pecas = lista.reduce((s: number, i: any) => s + (Number(i.quantity) || 1), 0) || 1;
      const servico = servicoDe(p.carrier) || (o ? servicoPagoDoPedido(o, uf).servico : 'SEDEX');
      const preco = await this.cotarCusto({
        transportador: transportadorDe(p.carrier), servico, cepOrigem: await this.cepDaLoja(p.store?.code || null),
        cepDestino: cepDest, pesoGramas: Math.max(300, pecas * 200),
      });
      if (preco != null && preco > 0) {
        await this.prisma.pickOrder.update({ where: { id: p.id }, data: { fretePagoCents: Math.round(preco * 100), fretePagoOrigem: 'recotacao', fretePagoEm: new Date() } });
        feitos++;
      } else falhas++;
      detalhes.push({ kind: 'pick', id: p.id, referencia: o?.wcOrderNumber ? `#${o.wcOrderNumber}` : p.id.slice(0, 8), precoReais: preco });
    }

    const restante = max - picks.length;
    if (restante > 0) {
      const rems: any[] = await this.prisma.realignmentShipment.findMany({
        where: { envioGeneratedAt: { gte: from, lte: to }, trackingCode: { not: null }, fretePagoCents: null },
        orderBy: { envioGeneratedAt: 'desc' },
        take: restante,
      });
      for (const r of rems) {
        const cepDest = await this.cepDaLoja(r.toStoreCode);
        const preco = cepDest ? await this.cotarCusto({
          transportador: transportadorDe(r.carrier), servico: servicoDe(r.carrier) || 'SEDEX', cepOrigem: await this.cepDaLoja(r.fromStoreCode),
          cepDestino: cepDest, pesoGramas: Math.max(300, Number(r.totalQty || 1) * 200),
        }) : null;
        if (preco != null && preco > 0) {
          await this.prisma.realignmentShipment.update({ where: { id: r.id }, data: { fretePagoCents: Math.round(preco * 100), fretePagoOrigem: 'recotacao', fretePagoEm: new Date() } });
          feitos++;
        } else falhas++;
        detalhes.push({ kind: 'remessa', id: r.id, referencia: r.code || r.id.slice(0, 8), precoReais: preco });
      }
    }

    const pendentes = await this.prisma.pickOrder.count({ where: { correiosGeneratedAt: { gte: from, lte: to }, trackingCode: { not: null }, fretePagoCents: null } })
      + await this.prisma.realignmentShipment.count({ where: { envioGeneratedAt: { gte: from, lte: to }, trackingCode: { not: null }, fretePagoCents: null } });

    return { ok: true, feitos, falhas, pendentes, detalhes };
  }
}
