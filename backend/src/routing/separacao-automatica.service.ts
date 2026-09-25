import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { ehItemSemEstoque } from '../common/item-sem-estoque';
import { RoutingService } from './routing.service';
import { buildWhatsappMessage } from './whatsapp-message.util';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  SEPARAÇÃO AUTOMÁTICA DO SITE (teste do dono, 25/09/2026)
 *
 *  Até aqui TODO pedido pago do site esperava um humano abrir a retaguarda e
 *  clicar "Confirmar separação" (o Piloto Automático antigo ficou sem gatilho
 *  quando o WordPress morreu — ele lia o pedido no WooCommerce). Este serviço
 *  faz o mesmo que o clique faz, assim que o pagamento confirma:
 *
 *    1. previewRoute(orderId)   → a MESMA engine, com as regras do dono
 *                                 (franquia primeiro; Indaiatuba só em último
 *                                 caso — `common/prioridade-lojas.ts`);
 *    2. confirmRoute(...)       → cria os cards, socket + push pra loja;
 *    3. WhatsApp pra cada loja  → a mesma mensagem do "1-clique" da tela.
 *
 *  O que NÃO faz sozinho (regra 4 do dono: "pedido reportado como erro,
 *  sempre pra atendimento humano", e o que a engine não resolve):
 *    - retirada em loja SEM a peça na própria loja (`pickup-transfer`);
 *    - ruptura (`insufficient-stock`) e `pickup-blocked`;
 *    - pedido que já tem reporte de problema;
 *    - qualquer recusa do `confirmRoute` (pagamento sem prova, troca pendente…).
 *  Nesses casos ele deixa uma nota no histórico ("🤖 não aplicada: …") e o
 *  pedido segue pra retaguarda como sempre.
 *
 *  TAG: o `routingResult` gravado ganha `automatico: { em, origem }` e o
 *  histórico recebe "🤖 SEPARAÇÃO AUTOMÁTICA — …". A lista da retaguarda e
 *  a tela do pedido mostram o chip a partir daí.
 *
 *  Chaves: SystemSetting `pilot_automatic_on` (a mesma do piloto antigo —
 *  `PATCH /pilot/toggle`, botão na tela de separação) + kill-switch por env
 *  `SEPARACAO_AUTOMATICA=0`.
 * ═══════════════════════════════════════════════════════════════════════════
 */
@Injectable()
export class SeparacaoAutomaticaService {
  private readonly logger = new Logger(SeparacaoAutomaticaService.name);
  static readonly CHAVE = 'pilot_automatic_on';
  /** Estratégias que a máquina pode fechar sozinha. O resto é gente. */
  static readonly ESTRATEGIAS_AUTOMATICAS = new Set(['single-store', 'multi-store', 'pickup-lock']);

  constructor(
    private readonly prisma: PrismaService,
    private readonly routing: RoutingService,
    private readonly whatsapp: WhatsappService,
  ) {}

  async ligada(): Promise<boolean> {
    if (String(process.env.SEPARACAO_AUTOMATICA ?? '').trim() === '0') return false;
    const row = await this.prisma.systemSetting.findUnique({
      where: { key: SeparacaoAutomaticaService.CHAVE },
    });
    return row?.value === '1';
  }

  /**
   * Fire-and-forget SEGURO: quem chama é o webhook do gateway, e nada aqui
   * pode segurar ou derrubar o ack do pagamento. Nunca lança.
   */
  disparar(orderId: string, origem: string): void {
    this.tentar(orderId, origem).catch((e) =>
      this.logger.error(`[auto-sep] pedido ${orderId}: ${(e as Error)?.message}`),
    );
  }

  async tentar(orderId: string, origem = 'pagamento'): Promise<{ aplicado: boolean; motivo: string }> {
    if (!(await this.ligada())) return { aplicado: false, motivo: 'desligada' };

    const order: any = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true, pickOrders: { select: { id: true, status: true } } },
    });
    if (!order) return this.pular(orderId, null, 'pedido-nao-encontrado');
    const rot = String(order.wcOrderNumber ?? order.wcOrderId ?? orderId);

    // Só o site novo entra no teste (venda online do PDV já roteia por conta
    // própria — PEDIDO_ONLINE_ROTEAMENTO — e a live tem o trilho dela).
    if (order.source !== 'ecommerce') return this.pular(orderId, rot, 'origem-nao-e-site');
    if (!order.paidAt) return this.pular(orderId, rot, 'nao-pago');
    if (order.pickOrders?.length) return this.pular(orderId, rot, 'ja-tem-card');
    if (['separating', 'awaiting_stock', 'shipped', 'delivered', 'cancelled'].includes(String(order.status))) {
      return this.pular(orderId, rot, `status-${order.status}`);
    }
    // REGRA 4: pedido reportado como erro é assunto de gente — nunca da máquina.
    const reportes = await (this.prisma as any).pickOrderItemReport.count({ where: { orderId } });
    if (reportes > 0) return this.pular(orderId, rot, 'reportado', true);

    const itens = (order.items ?? []).filter((i: any) => !i.cancelledAt && !ehItemSemEstoque(i));
    if (!itens.length) return this.pular(orderId, rot, 'sem-itens');

    const preview: any = await this.routing.previewRoute(orderId);
    if (!preview?.success || !SeparacaoAutomaticaService.ESTRATEGIAS_AUTOMATICAS.has(String(preview.strategy))) {
      const motivo = this.motivoHumano(preview);
      return this.pular(orderId, rot, motivo, true);
    }

    // A TAG vai dentro do routingResult (confirmRoute grava o preview inteiro).
    preview.automatico = { em: new Date().toISOString(), origem, versao: 1 };
    try {
      await this.routing.confirmRoute(orderId, preview);
    } catch (e) {
      // confirmRoute recusa com motivo humano (pagamento sem prova, troca
      // pendente, pedido fechado…). Fica pra retaguarda, com a razão escrita.
      return this.pular(orderId, rot, `confirm: ${(e as Error)?.message ?? 'recusado'}`, true);
    }

    const lojas = (preview.assignments ?? [])
      .map((a: any) => `${a.storeName ?? a.storeCode} (${a.storeCode})${a.isTransfer ? ` → ${a.transferToStoreName ?? a.transferToStoreCode}` : ''}`)
      .join(', ');
    await this.historico(
      orderId,
      `🤖 SEPARAÇÃO AUTOMÁTICA — enviado pra ${lojas}. Regras: franquia primeiro (mesmo nº de caixas); ` +
        `Indaiatuba só pra peça que ninguém mais tem; pedido com problema volta pra matriz.`,
    );
    this.logger.log(`[auto-sep] ${rot} → ${preview.strategy}: ${lojas}`);

    await this.avisarLojas(order, preview.assignments ?? []);
    return { aplicado: true, motivo: String(preview.strategy) };
  }

  /** Por que a máquina não fechou — em português, pra nota do histórico. */
  private motivoHumano(preview: any): string {
    const s = String(preview?.strategy ?? '');
    if (s === 'insufficient-stock') {
      const faltam = (preview?.missing ?? []).map((m: any) => m.sku).join(', ');
      return `sem estoque na rede${faltam ? ` (${faltam})` : ''}`;
    }
    if (s === 'pickup-transfer') return 'retirada em loja que NÃO tem a peça (precisa de transferência)';
    if (s === 'pickup-blocked') return 'retirada em loja sem cobertura na rede';
    return `roteamento devolveu "${s || 'vazio'}"`;
  }

  private async pular(orderId: string, rot: string | null, motivo: string, anotar = false) {
    this.logger.log(`[auto-sep] ${rot ?? orderId} pulado: ${motivo}`);
    if (anotar) {
      await this.historico(orderId, `🤖 Separação automática NÃO aplicada: ${motivo}. Fica pra retaguarda decidir.`);
    }
    return { aplicado: false, motivo };
  }

  private async historico(orderId: string, note: string): Promise<void> {
    try {
      await this.prisma.orderHistory.create({ data: { orderId, note } });
    } catch (e) {
      this.logger.warn(`[auto-sep] histórico falhou (${orderId}): ${(e as Error)?.message}`);
    }
  }

  /**
   * WhatsApp pra loja — a MESMA mensagem que o 1-clique da tela manda
   * (`buildWhatsappMessage`), pelo mesmo canal (`WhatsappService.sendText`,
   * Evolution primeiro). Best-effort: a loja já viu o card pelo socket/push.
   */
  private async avisarLojas(order: any, assignments: any[]): Promise<void> {
    let addr: any = {};
    try {
      addr = JSON.parse(order.shippingAddress || '{}');
    } catch {
      addr = {};
    }
    const itensDoPedido = (order.items ?? []).filter((i: any) => !i.cancelledAt);
    for (const a of assignments) {
      const numero = String(a.whatsapp ?? '').trim();
      if (!numero) continue;
      const skus = new Set((a.items ?? []).map((i: any) => String(i.sku)));
      const itens = itensDoPedido
        .filter((i: any) => skus.has(String(i.sku)))
        .map((i: any) => ({
          sku: String(i.sku ?? '').trim(),
          quantity: Number(i.quantity ?? 1),
          productName: String(i.productName ?? ''),
          variant: [i.cor, i.tamanho].filter(Boolean).join(' ') || undefined,
        }));
      const texto = buildWhatsappMessage({
        wcOrderNumber: String(order.wcOrderNumber ?? order.wcOrderId ?? ''),
        orderDateIso: (order.wcDateCreated ?? order.createdAt ?? new Date()).toISOString(),
        totalAmount: Number(order.totalAmount ?? 0),
        paymentMethod: 'Site',
        items: itens,
        customerName: order.customerName ?? '',
        customerPhone: order.customerPhone ?? null,
        customerCpf: order.customerCpf ?? null,
        customerEmail: order.customerEmail ?? null,
        shippingMethod: order.shippingMethod ?? 'Entrega',
        address: {
          street: addr.address_1 ?? null,
          number: null,
          complement: addr.address_2 ?? null,
          neighborhood: addr.neighborhood ?? null,
          city: addr.city ?? null,
          state: addr.state ?? null,
          postcode: addr.postcode ?? null,
        },
        storeName: a.storeName,
        isTransfer: !!a.isTransfer,
        transferToStoreName: a.transferToStoreName ?? null,
      } as any);
      try {
        const r: any = await this.whatsapp.sendText(numero, `${texto}\n\n🤖 _Separação automática_`);
        if (!r?.ok) this.logger.warn(`[auto-sep] WhatsApp pra ${a.storeCode} falhou: ${r?.error ?? '?'}`);
      } catch (e) {
        this.logger.warn(`[auto-sep] WhatsApp pra ${a.storeCode} falhou: ${(e as Error)?.message}`);
      }
    }
  }
}
