import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../websocket/realtime.gateway';
import { RealignmentShipmentService } from '../realignment/shipment.service';
import { RemessaEnvioService } from '../realignment/remessa-envio.service';
import { ShipmentPdfService } from '../realignment/shipment-pdf.service';
import { ehItemSemEstoque } from '../common/item-sem-estoque';
import { PickOrdersService } from './pick-orders.service';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  JUNTADA DE PEDIDO DIVIDIDO (21/08 — pedido do dono)
 *
 *  O problema: pedido quebrado em 3 lojas = 3 fretes pra mesma cliente.
 *  Fora do estado isso mata a margem. A solução: escolher uma LOJA ÂNCORA
 *  que envia TUDO — as outras (feeders) mandam as peças delas PRA ÂNCORA,
 *  não pra cliente.
 *
 *  O ciclo:
 *   1. Matriz escolhe a âncora na tela do pedido (ou o routing escolhe
 *      sozinho quando Itanhaém/Praia Grande/Santos cobrem entre si — carro
 *      da rede, frete interno zero).
 *   2. Cards feeder viram `isTransfer` → âncora. A loja bipa NORMALMENTE
 *      (o bipe baixa o estoque = a peça fica reservada).
 *   3. No "Finalizar" do feeder nasce a CAIXA (RealignmentShipment em
 *      trânsito) com NF de transferência + etiqueta pra loja (ou aviso de
 *      carro da rede) + romaneio carimbado "PEÇAS DO PEDIDO #X".
 *   4. A âncora dá entrada na caixa pelo fluxo de remessa de sempre —
 *      SEM somar estoque (a peça está vendida). O card feeder fecha
 *      (shipped) e o acerto ÷2,5 feeder→âncora roda no afterShipped.
 *   5. Só com TODAS as caixas recebidas a âncora consegue gerar o envio
 *      final — etiqueta + NF-e de venda do pedido INTEIRO.
 *
 *  O acerto financeiro NÃO muda de dono: o canal (13) paga a âncora pelo
 *  pedido todo (perna 2 do afterShipped) e a âncora paga cada feeder
 *  (perna 1) — decisão do dono 21/08: "a cobrança é do site; a nota de
 *  transferência vai pra loja que junta".
 * ═══════════════════════════════════════════════════════════════════════════
 */
@Injectable()
export class JuntadaService {
  private readonly logger = new Logger(JuntadaService.name);
  private cronRodando = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: RealtimeGateway,
    private readonly shipments: RealignmentShipmentService,
    private readonly remessaEnvio: RemessaEnvioService,
    private readonly shipmentPdf: ShipmentPdfService,
    @Inject(forwardRef(() => PickOrdersService))
    private readonly pickOrders: PickOrdersService,
  ) {}

  /** Status de pick que ainda aceitam virar feeder/âncora. */
  private static readonly STATUS_ATIVOS = ['new', 'separating', 'separated', 'ready'];

  // ─────────────────────────────────────────────────────────────────────────
  //  ESCOLHER / DESFAZER A ÂNCORA
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Marca a loja âncora de um pedido JÁ CONFIRMADO: os outros cards ativos
   * viram feeder (`isTransfer` → âncora). Card que já enviou direto pra
   * cliente fica de fora (a peça já foi).
   */
  async juntarPedido(wcOrderId: number, anchorStoreCode: string, userId?: string | null) {
    const order: any = await this.prisma.order.findFirst({
      where: { wcOrderId },
      include: {
        pickOrders: { include: { store: { select: { code: true, name: true } } } },
      },
    });
    if (!order) throw new NotFoundException('Pedido não encontrado no banco local.');
    if (order.isPickup) {
      throw new BadRequestException('Pedido de RETIRADA já junta sozinho na loja da retirada.');
    }

    const ativos = order.pickOrders.filter((p: any) => JuntadaService.STATUS_ATIVOS.includes(p.status));
    const ancora = ativos.find((p: any) => p.store?.code === anchorStoreCode);
    if (!ancora) {
      throw new BadRequestException(
        `A loja ${anchorStoreCode} não tem card ativo neste pedido — a âncora precisa ser uma das lojas da separação.`,
      );
    }
    const feeders = ativos.filter((p: any) => p.id !== ancora.id);
    if (!feeders.length) {
      throw new BadRequestException('Só existe um card ativo — não há o que juntar.');
    }

    /**
     * CAIXA QUE JÁ SAIU NÃO MUDA DE DESTINO NO MEIO DO VOO.
     *
     * Trocar a âncora depois que um feeder despachou é legítimo (foi o que o
     * LP-000244 pediu), mas a caixa física continua indo pro endereço da
     * âncora ANTIGA. Antes isso acontecia em silêncio: a REM-2026-001480 saiu
     * de Vinhedo pra Limeira, Limeira saiu do pedido, e ninguém soube que uma
     * peça vendida estava a caminho de uma loja sem card. Agora a troca
     * acontece — mas dizendo em voz alta qual caixa ficou apontada pro lugar
     * errado, pra alguém combinar o reencaminhamento.
     */
    const caixasEmVoo: any[] = await (this.prisma as any).realignmentShipment.findMany({
      where: { orderId: order.id, status: { in: ['open', 'in_transit'] } },
      select: { code: true, toStoreCode: true, toStoreName: true, status: true, trackingCode: true },
    });
    const caixasDesalinhadas = caixasEmVoo.filter((c) => c.toStoreCode !== anchorStoreCode);

    const snapshot = JSON.stringify({
      name: order.customerName,
      cpf: order.customerCpf,
      email: order.customerEmail,
      phone: order.customerPhone,
      shippingMethod: order.shippingMethod,
      wcOrderId: order.wcOrderId,
      wcOrderNumber: order.wcOrderNumber,
      juntadaAncoraStoreCode: anchorStoreCode,
    });

    await this.prisma.$transaction(async (tx) => {
      await tx.pickOrder.update({
        where: { id: ancora.id },
        data: { isTransfer: false, transferToStoreCode: null, customerSnapshot: null },
      });
      for (const f of feeders) {
        await tx.pickOrder.update({
          where: { id: f.id },
          data: { isTransfer: true, transferToStoreCode: anchorStoreCode, customerSnapshot: snapshot },
        });
      }
      await tx.orderHistory.create({
        data: {
          orderId: order.id,
          fromStatus: order.status,
          toStatus: order.status,
          note:
            `JUNTANDO PEÇAS na loja ${ancora.store?.name ?? anchorStoreCode}: ` +
            `${feeders.map((f: any) => f.store?.name ?? f.storeId).join(', ')} agora mandam pra ela em vez de pra cliente.` +
            (caixasDesalinhadas.length
              ? ` ⚠️ Caixa(s) JÁ DESPACHADA(S) pra outra loja: ` +
                caixasDesalinhadas
                  .map((c) => `${c.code} → ${c.toStoreName || c.toStoreCode}${c.trackingCode ? ` (${c.trackingCode})` : ''}`)
                  .join(', ') +
                ` — combinar o reencaminhamento pra ${anchorStoreCode}.`
              : ''),
        },
      });
    });

    // Feeder que JÁ terminou de bipar ganha a caixa na hora.
    const caixas: any[] = [];
    for (const f of feeders) {
      if (!['separated', 'ready'].includes(f.status)) continue;
      try {
        const r = await this.criarCaixaDoFeederSePreciso(f.id, userId ?? undefined);
        if (r?.shipment) caixas.push({ pickOrderId: f.id, code: r.shipment.code, transporte: r.transporte });
      } catch (e: any) {
        this.logger.warn(`[juntada] caixa do feeder ${f.id} falhou no juntar: ${e?.message || e}`);
      }
    }

    for (const p of [ancora, ...feeders]) {
      try {
        this.gateway.emitPickOrderStatus(p.storeId, { id: p.id, status: p.status });
      } catch { /* best-effort */ }
    }

    this.logger.log(
      `[juntada] pedido ${order.wcOrderNumber}: âncora ${anchorStoreCode}, ${feeders.length} feeder(s), ${caixas.length} caixa(s) criada(s) na hora`,
    );
    if (caixasDesalinhadas.length) {
      this.logger.warn(
        `[juntada] ${order.wcOrderNumber}: ${caixasDesalinhadas.length} caixa(s) já despachada(s) pra outra âncora — ` +
          caixasDesalinhadas.map((c) => `${c.code}→${c.toStoreCode}`).join(', '),
      );
    }
    return {
      ok: true,
      ancoraStoreCode: anchorStoreCode,
      feeders: feeders.map((f: any) => f.store?.code),
      caixasCriadas: caixas,
      // Caixa que já saiu pra âncora ANTIGA: a tela avisa pra alguém combinar
      // o reencaminhamento — a etiqueta não se refaz sozinha.
      caixasDesalinhadas: caixasDesalinhadas.map((c) => ({
        code: c.code,
        toStoreCode: c.toStoreCode,
        toStoreName: c.toStoreName,
        status: c.status,
        trackingCode: c.trackingCode ?? null,
      })),
    };
  }

  /**
   * Desfaz a juntada — cada loja volta a enviar direto pra cliente. Só
   * enquanto NENHUMA caixa nasceu: com caixa em trânsito, a peça já viaja
   * pra âncora e voltar atrás viraria caos físico.
   */
  async desfazerJuntada(wcOrderId: number, _userId?: string | null) {
    const order: any = await this.prisma.order.findFirst({
      where: { wcOrderId },
      include: { pickOrders: { include: { store: { select: { code: true, name: true } } } } },
    });
    if (!order) throw new NotFoundException('Pedido não encontrado no banco local.');
    if (order.isPickup) throw new BadRequestException('Pedido de retirada não usa juntada manual.');

    const feeders = order.pickOrders.filter((p: any) => p.isTransfer);
    if (!feeders.length) return { ok: true, jaDesfeita: true };

    const caixas: any[] = await (this.prisma as any).realignmentShipment.findMany({
      where: { pickOrderId: { in: feeders.map((f: any) => f.id) }, status: { not: 'cancelled' } },
      select: { code: true, status: true },
    });
    if (caixas.length) {
      throw new BadRequestException(
        `Não dá mais pra desfazer: ${caixas.map((c) => `${c.code} (${c.status === 'in_transit' ? 'em trânsito' : c.status})`).join(', ')} já existe(m). ` +
          'A peça já está viajando pra âncora — siga o fluxo e a âncora envia tudo junto.',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      for (const f of feeders) {
        await tx.pickOrder.update({
          where: { id: f.id },
          data: { isTransfer: false, transferToStoreCode: null, customerSnapshot: null },
        });
      }
      await tx.orderHistory.create({
        data: {
          orderId: order.id,
          fromStatus: order.status,
          toStatus: order.status,
          note: 'Juntada DESFEITA — cada loja volta a enviar direto pra cliente.',
        },
      });
    });
    for (const f of feeders) {
      try {
        this.gateway.emitPickOrderStatus(f.storeId, { id: f.id, status: f.status });
      } catch { /* best-effort */ }
    }
    return { ok: true, desfeitos: feeders.length };
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  A CAIXA DO FEEDER
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Cria a caixa (remessa) do card feeder — chamada no fim da bipagem e no
   * "juntar" pra card que já estava bipado. No-op para card que não é
   * feeder de juntada. Idempotente (a remessa é única por pick).
   */
  async criarCaixaDoFeederSePreciso(pickOrderId: string, userId?: string) {
    const pick: any = await this.prisma.pickOrder.findUnique({
      where: { id: pickOrderId },
      include: { store: { select: { code: true, name: true } }, order: true },
    });
    if (!pick?.isTransfer || !pick.transferToStoreCode) return null;
    if (pick.order?.isPickup) return null; // retirada tem o próprio trilho (sem caixa automática)
    if (!['separated', 'ready'].includes(pick.status)) return null;

    const destino: any = await this.prisma.store.findUnique({
      where: { code: pick.transferToStoreCode },
      select: { code: true, name: true },
    });
    if (!destino) {
      this.logger.warn(`[juntada] loja âncora ${pick.transferToStoreCode} não existe — caixa não criada`);
      return null;
    }

    const itens = (
      await this.prisma.orderItem.findMany({
        where: { orderId: pick.orderId, assignedStoreId: pick.storeId },
      })
    ).filter((i: any) => !ehItemSemEstoque(i));
    if (!itens.length) {
      this.logger.warn(`[juntada] feeder ${pickOrderId} sem itens atribuídos — caixa não criada`);
      return null;
    }

    const { shipment, jaExistia } = await this.shipments.criarCaixaJuntada({
      fromStoreCode: pick.store.code,
      fromStoreName: pick.store.name,
      toStoreCode: destino.code,
      toStoreName: destino.name,
      orderId: pick.orderId,
      pickOrderId: pick.id,
      wcOrderNumber: String(pick.order?.wcOrderNumber || pick.order?.wcOrderId || ''),
      userId: userId ?? null,
      itens: itens.map((i: any) => ({
        sku: String(i.sku || ''),
        ref: i.ref ?? null,
        cor: i.cor ?? null,
        tamanho: i.tamanho ?? null,
        descricao: i.productName ?? null,
        qty: Number(i.quantity) || 1,
        precoUnitCents: Math.round((Number(i.baseUnitPrice ?? i.unitPrice ?? 0) || 0) * 100) || null,
      })),
    });

    const transporte = await this.remessaEnvio.transporteEfetivo(shipment);

    // Trecho Correios: NF de transferência + etiqueta já saem aqui, pra
    // estarem prontas quando a loja clicar em "Documentos da caixa".
    // Best-effort — falha não trava o Finalizar; o botão de docs re-tenta.
    if (transporte === 'correios' && !shipment.trackingCode) {
      try {
        await this.remessaEnvio.gerarEnvio(shipment.id, null, userId ?? null);
      } catch (e: any) {
        this.logger.warn(`[juntada] envio da caixa ${shipment.code} não gerou agora: ${e?.message || e}`);
      }
    }

    return { shipment, transporte, jaExistia };
  }

  /**
   * DOCUMENTOS DA CAIXA do feeder, num PDF só:
   *   etiqueta pra loja âncora + DANFE da transferência (trecho Correios)
   *   + romaneio carimbado "PEÇAS DO PEDIDO #X".
   * Rota própria (carro da rede): sai só o romaneio — etiqueta seria papel
   * jogado fora.
   */
  async docsDaCaixa(pickOrderId: string, storeId: string | null, userId?: string) {
    const pick: any = await this.prisma.pickOrder.findUnique({
      where: { id: pickOrderId },
      include: { store: { select: { code: true } }, order: { select: { isPickup: true } } },
    });
    if (!pick) throw new NotFoundException('Card não encontrado');
    if (storeId && pick.storeId !== storeId) throw new ForbiddenException('Card de outra loja');
    if (!pick.isTransfer || pick.order?.isPickup) {
      throw new BadRequestException('Este card não é de juntada — use o envio normal.');
    }

    let shipment: any = await (this.prisma as any).realignmentShipment.findFirst({
      where: { pickOrderId, status: { not: 'cancelled' } },
    });
    if (!shipment) {
      const criado = await this.criarCaixaDoFeederSePreciso(pickOrderId, userId);
      shipment = criado?.shipment;
      if (!shipment) {
        throw new BadRequestException('Termine a bipagem do card primeiro — a caixa nasce no Finalizar.');
      }
    }

    const transporte = await this.remessaEnvio.transporteEfetivo(shipment);
    const pdfs: Buffer[] = [];
    let temEtiqueta = false;
    let temNota = false;
    let aviso: string | null = null;

    if (transporte === 'correios') {
      if (!shipment.trackingCode) {
        try {
          await this.remessaEnvio.gerarEnvio(shipment.id, null, userId ?? null);
          shipment = await (this.prisma as any).realignmentShipment.findUnique({ where: { id: shipment.id } });
        } catch (e: any) {
          aviso = `Etiqueta/NF da caixa ainda não saíram: ${String(e?.message || e).slice(0, 200)}`;
        }
      }
      if (shipment.trackingCode) {
        try {
          const docs = await this.remessaEnvio.docsEnvio(shipment.id, null);
          if (docs?.pdfBase64) {
            pdfs.push(Buffer.from(String(docs.pdfBase64), 'base64'));
            temEtiqueta = !!docs.temEtiqueta;
            temNota = !!docs.temNota;
          }
        } catch (e: any) {
          aviso = `Etiqueta/DANFE indisponíveis agora: ${String(e?.message || e).slice(0, 200)}`;
        }
      }
    }

    // Romaneio carimbado — sai SEMPRE (é o impresso que explica a caixa).
    const { buffer } = await this.shipmentPdf.generateForShipment(shipment.id);
    pdfs.push(buffer);

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { PDFDocument } = require('pdf-lib');
    const out = await PDFDocument.create();
    for (const b of pdfs) {
      const src = await PDFDocument.load(b, { ignoreEncryption: true });
      const pages = await out.copyPages(src, src.getPageIndices());
      for (const p of pages) out.addPage(p);
    }
    const bytes = await out.save();

    return {
      ok: true,
      pdfBase64: Buffer.from(bytes).toString('base64'),
      shipmentCode: shipment.code,
      transporte,
      trackingCode: shipment.trackingCode ?? null,
      carrier: shipment.carrier ?? null,
      temEtiqueta,
      temNota,
      aviso,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  STATUS PRA RETAGUARDA / CARDS
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Raio-X da juntada de um pedido: âncora, cada caixa feeder e se o envio
   * final já está liberado. Null quando o pedido não está juntando.
   */
  async statusJuntada(wcOrderId: number) {
    const order: any = await this.prisma.order.findFirst({
      where: { wcOrderId },
      include: { pickOrders: { include: { store: { select: { code: true, name: true } } } } },
    });
    if (!order || order.isPickup) return null;
    const feeders = order.pickOrders.filter((p: any) => p.isTransfer && p.transferToStoreCode);
    if (!feeders.length) return null;

    const ancoraCode = feeders[0].transferToStoreCode;
    const ancoraPick = order.pickOrders.find((p: any) => p.store?.code === ancoraCode && !p.isTransfer);
    const shipments: any[] = await (this.prisma as any).realignmentShipment.findMany({
      where: { pickOrderId: { in: feeders.map((f: any) => f.id) }, status: { not: 'cancelled' } },
    });
    const porPick = new Map(shipments.map((s) => [s.pickOrderId, s]));

    const caixas = [] as any[];
    for (const f of feeders) {
      const cx = porPick.get(f.id) ?? null;
      caixas.push({
        pickOrderId: f.id,
        storeCode: f.store?.code ?? null,
        storeName: f.store?.name ?? null,
        pickStatus: f.status,
        caixa: cx
          ? {
              code: cx.code,
              status: cx.status,
              trackingCode: cx.trackingCode ?? null,
              carrier: cx.carrier ?? null,
              transporte: await this.remessaEnvio.transporteEfetivo(cx),
              sentAt: cx.sentAt ?? null,
              receivedAt: cx.receivedAt ?? null,
            }
          : null,
      });
    }
    const recebidas = caixas.filter((c) => c.caixa?.status === 'received').length;
    return {
      juntando: true,
      ancoraStoreCode: ancoraCode,
      ancoraStoreName: ancoraPick?.store?.name ?? null,
      ancoraPickId: ancoraPick?.id ?? null,
      ancoraPickStatus: ancoraPick?.status ?? null,
      caixas,
      totalCaixas: caixas.length,
      recebidas,
      completa: recebidas === caixas.length,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  RECONCILIAÇÃO — caixa chegou na âncora → fecha o card feeder
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * A entrada da caixa acontece no módulo de remessa (que não pode chamar o
   * pick-orders sem criar ciclo). Este cron fecha o elo: caixa de juntada
   * `received` com card feeder ainda aberto → marca shipped + acerto.
   * Roda a cada minuto, barato (poucas caixas de juntada por dia) e
   * naturalmente retentável.
   */
  @Cron('*/1 * * * *', { name: 'juntada-reconcile' })
  async reconcileCaixasRecebidas() {
    if (this.cronRodando) return;
    this.cronRodando = true;
    try {
      const caixas: any[] = await (this.prisma as any).realignmentShipment.findMany({
        where: { orderId: { not: null }, pickOrderId: { not: null }, status: 'received' },
        select: { pickOrderId: true, code: true },
        orderBy: { receivedAt: 'desc' },
        take: 200,
      });
      if (!caixas.length) return;
      const abertos = await this.prisma.pickOrder.findMany({
        where: { id: { in: caixas.map((c) => c.pickOrderId) }, status: { not: 'shipped' } },
        select: { id: true },
      });
      for (const p of abertos) {
        try {
          await this.pickOrders.marcarCaixaJuntadaRecebida(p.id);
        } catch (e: any) {
          this.logger.warn(`[juntada-reconcile] feeder ${p.id}: ${e?.message || e}`);
        }
      }
      if (abertos.length) {
        this.logger.log(`[juntada-reconcile] ${abertos.length} card(s) feeder fechados (caixa recebida)`);
      }
    } finally {
      this.cronRodando = false;
    }
  }
}
