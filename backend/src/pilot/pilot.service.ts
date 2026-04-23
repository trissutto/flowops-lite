import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { RoutingService } from '../routing/routing.service';
import { OrdersService } from '../orders/orders.service';
import { WooCommerceService } from '../woocommerce/woocommerce.service';
import { extractVariantFromLineItem, detectPickup, extractCpf } from '../woocommerce/wc-order-extract.util';

/**
 * PilotService — Piloto Automático server-side.
 *
 * Roda no backend, ouvindo `order:new` interno (disparado pelo WcPoller).
 * Quando ligado, faz TUDO sozinho:
 *   1. Calcula rota (previewSeparationForWc)
 *   2. Dispara WhatsApp pra loja(s) via Baileys (WhatsappService)
 *   3. Cria pick-orders locais (ensurePickOrdersForWc → routing.confirmRoute)
 *   4. Muda status no WC pra 'separacao' + nota
 *   5. Grava audit log em integration_logs
 *
 * SEGURANÇA (3 camadas de kill-switch):
 *   - env PILOT_DISABLED=1 → ignora tudo (nem consulta DB, reset imediato)
 *   - SystemSetting `pilot_automatic_on` = '0' → desliga sem redeploy
 *   - Dedup por wcOrderId (flag em memória + verifica pick-order existente)
 *
 * Gates (não dispara mesmo ligado):
 *   - WhatsApp desconectado → aborta (não marca separação sem enviar)
 *   - Multi-store split → aborta (requer aprovação manual na retaguarda)
 *   - Ruptura total → aborta (sem estoque em nenhuma loja)
 *   - Pedido já tem pick-order ativo → aborta (operador manual já agiu)
 *   - Pedido mais velho que PILOT_MAX_AGE_MIN (default 30min) → aborta
 *     (evita disparar em pedidos antigos que vieram no poll por overlap)
 *
 * Rate limit: máximo N disparos/minuto (default 30) pra não banir Baileys.
 */
@Injectable()
export class PilotService {
  private readonly logger = new Logger(PilotService.name);

  /** Dedup em memória — evita disparo duplo se o poll pegar 2x o mesmo wcOrderId */
  private readonly inflight = new Set<number>();

  /** Rate limit — timestamps dos disparos da última janela de 60s */
  private recentFires: number[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsapp: WhatsappService,
    private readonly routing: RoutingService,
    @Inject(forwardRef(() => OrdersService))
    private readonly orders: OrdersService,
    @Inject(forwardRef(() => WooCommerceService))
    private readonly wc: WooCommerceService,
  ) {}

  // ───────────────────────────────────────────────────────────────────────
  // FLAGS
  // ───────────────────────────────────────────────────────────────────────

  /** Desligar via env var (emergency). Nem consulta DB se ligado. */
  private isKillSwitchOn(): boolean {
    return process.env.PILOT_DISABLED === '1';
  }

  /** Lê flag DB pilot_automatic_on (default: false). */
  async isOn(): Promise<boolean> {
    if (this.isKillSwitchOn()) return false;
    const row = await this.prisma.systemSetting.findUnique({
      where: { key: 'pilot_automatic_on' },
    });
    return row?.value === '1';
  }

  /** Liga/desliga via API. Atualiza DB (single source of truth). */
  async setOn(on: boolean, by?: string): Promise<void> {
    await this.prisma.systemSetting.upsert({
      where: { key: 'pilot_automatic_on' },
      update: { value: on ? '1' : '0' },
      create: { key: 'pilot_automatic_on', value: on ? '1' : '0' },
    });
    this.logger.log(`Piloto Automático ${on ? 'LIGADO' : 'DESLIGADO'}${by ? ` por ${by}` : ''}`);
    await this.audit('toggle', { on, by }, on ? 200 : 0);
  }

  /** Status consolidado: flag + kill-switch + wa connected. */
  async getStatus() {
    const on = await this.isOn();
    const killSwitch = this.isKillSwitchOn();
    const wa = this.whatsapp.getStatus();
    return {
      on,
      killSwitch,
      whatsappConnected: wa.connected,
      whatsappNumber: wa.phoneNumber,
      rateLimit: {
        window: '60s',
        fires: this.recentFires.length,
        max: this.rateLimitMax(),
      },
    };
  }

  // ───────────────────────────────────────────────────────────────────────
  // CONFIG
  // ───────────────────────────────────────────────────────────────────────

  private rateLimitMax(): number {
    const n = Number(process.env.PILOT_RATE_LIMIT_PER_MIN);
    return Number.isFinite(n) && n > 0 ? n : 30;
  }

  private maxAgeMs(): number {
    const n = Number(process.env.PILOT_MAX_AGE_MIN);
    const min = Number.isFinite(n) && n > 0 ? n : 30;
    return min * 60_000;
  }

  private canFire(): boolean {
    const now = Date.now();
    this.recentFires = this.recentFires.filter((t) => now - t < 60_000);
    return this.recentFires.length < this.rateLimitMax();
  }

  private registerFire() {
    this.recentFires.push(Date.now());
  }

  // ───────────────────────────────────────────────────────────────────────
  // ENTRY POINT — chamado pelo WcPoller quando detecta order:new
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Tenta auto-enviar o pedido pra loja. Silencioso em caso de flag off
   * ou gate bloqueado — só loga. Nunca lança exceção pra fora (pra não
   * quebrar o fluxo do poller).
   */
  async handleNewOrder(wcOrderId: number, orderCreatedAtIso?: string | null): Promise<void> {
    if (!wcOrderId || Number.isNaN(wcOrderId)) return;

    try {
      // Gate 0: kill-switch + flag
      if (!(await this.isOn())) return;

      // Gate 1: dedup em memória
      if (this.inflight.has(wcOrderId)) {
        this.logger.debug(`[pilot] #${wcOrderId} já em execução, pulando`);
        return;
      }
      this.inflight.add(wcOrderId);

      try {
        // Gate 2: rate limit
        if (!this.canFire()) {
          this.logger.warn(`[pilot] rate limit atingido (${this.recentFires.length}/${this.rateLimitMax()} em 60s), pulando #${wcOrderId}`);
          await this.audit('skip', { wcOrderId, reason: 'rate-limit' }, 429);
          return;
        }

        // Gate 3: pedido muito antigo (overlap de poll)
        if (orderCreatedAtIso) {
          const ageMs = Date.now() - new Date(orderCreatedAtIso).getTime();
          if (ageMs > this.maxAgeMs()) {
            this.logger.debug(`[pilot] #${wcOrderId} velho demais (${Math.round(ageMs/60000)}min), pulando`);
            return;
          }
        }

        // Gate 4: WhatsApp conectado?
        const waStatus = this.whatsapp.getStatus();
        if (!waStatus.connected) {
          this.logger.warn(`[pilot] #${wcOrderId} → WhatsApp desconectado, abortando`);
          await this.audit('skip', { wcOrderId, reason: 'wa-disconnected' }, 503);
          return;
        }

        // Gate 5: já tem pick-order ativo? (outro caminho já agiu)
        const already = await this.prisma.order.findFirst({
          where: { wcOrderId },
          include: { pickOrders: { select: { id: true, status: true } } },
        });
        if (already && already.pickOrders.length > 0) {
          this.logger.debug(`[pilot] #${wcOrderId} já tem pick-order, pulando`);
          return;
        }

        // ═══════ EXECUÇÃO ═══════
        this.registerFire();
        await this.executeAutoSend(wcOrderId);
      } finally {
        this.inflight.delete(wcOrderId);
      }
    } catch (e: any) {
      this.logger.error(`[pilot] erro inesperado em #${wcOrderId}: ${e?.message}`, e?.stack);
      await this.audit('error', { wcOrderId, message: e?.message }, 500);
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // EXECUÇÃO REAL
  // ───────────────────────────────────────────────────────────────────────

  private async executeAutoSend(wcOrderId: number): Promise<void> {
    // 1) Puxa dados do WC pra montar preview
    const wcOrder = await this.wc.getOrder(wcOrderId);
    const input = await this.buildPreviewInput(wcOrder, wcOrderId);

    // 2) Preview — grupos + mensagens WhatsApp + telefones
    const preview = await this.routing.previewSeparationForWc(input);

    if (!preview.success) {
      this.logger.warn(`[pilot] #${wcOrderId} → routing não-success (${preview.strategy}), abortando`);
      await this.audit('skip', {
        wcOrderId,
        reason: preview.strategy === 'insufficient-stock' ? 'no-stock' : preview.strategy,
        missing: preview.missing?.map((m: any) => m.sku),
      }, preview.strategy === 'insufficient-stock' ? 409 : 400);
      return;
    }

    // 3) Gate multi-store: requer aprovação manual
    if (preview.strategy === 'multi-store') {
      this.logger.warn(`[pilot] #${wcOrderId} → split ${preview.groups.length} lojas, requer aprovação manual`);
      await this.audit('skip', {
        wcOrderId,
        reason: 'split-needs-approval',
        groupCount: preview.groups.length,
      }, 409);
      return;
    }

    // 4) Verifica que tem pelo menos 1 grupo com WhatsApp
    const groupsWithWa = preview.groups.filter((g: any) => g.whatsapp && g.whatsappMessage);
    if (groupsWithWa.length === 0) {
      this.logger.warn(`[pilot] #${wcOrderId} → nenhuma loja com WhatsApp`);
      await this.audit('skip', { wcOrderId, reason: 'no-whatsapp' }, 400);
      return;
    }

    // 5) Dispara WhatsApp — se qualquer um falhar, aborta antes do PATCH
    const sendFailures: Array<{ store: string; error: string }> = [];
    for (const g of groupsWithWa) {
      // filter acima já garantiu que whatsapp e whatsappMessage são strings.
      const r = await this.whatsapp.sendText(g.whatsapp as string, g.whatsappMessage as string);
      if (!r.ok) sendFailures.push({ store: g.storeCode, error: r.error || 'falha' });
    }

    if (sendFailures.length > 0) {
      this.logger.warn(`[pilot] #${wcOrderId} → falha envio WA: ${JSON.stringify(sendFailures)}`);
      await this.audit('send-failed', { wcOrderId, failures: sendFailures }, 502);
      return;
    }

    // 6) Persiste pick-orders (mesma lógica do controller ensurePickOrdersForWc)
    try {
      const { orderId } = await this.orders.upsertFromWooCommerce(wcOrder);
      const rpreview = await this.routing.previewRoute(orderId);
      if (!rpreview.success) {
        this.logger.error(`[pilot] #${wcOrderId} → routing falhou na persistência (estoque mudou entre preview e commit)`);
        await this.audit('persist-failed', { wcOrderId, reason: 'routing-race' }, 409);
        return;
      }
      await this.routing.confirmRoute(orderId, rpreview as any);
    } catch (e: any) {
      this.logger.error(`[pilot] #${wcOrderId} → erro persistindo pick-order: ${e?.message}`);
      await this.audit('persist-failed', { wcOrderId, error: e?.message }, 500);
      return;
    }

    // 7) Atualiza WC: status → separacao + nota
    const storesLabel = preview.groups.map((g: any) => `${g.storeName} (${g.storeCode})`).join(', ');
    try {
      await this.wc.updateOrder(wcOrderId, { status: 'separacao' });
      await this.wc.addOrderNote(
        wcOrderId,
        `Separação enviada via WhatsApp pra: ${storesLabel}. [Piloto Automático]`,
        false,
      );
    } catch (e: any) {
      this.logger.error(`[pilot] #${wcOrderId} → WhatsApp OK mas PATCH WC falhou: ${e?.message}`);
      await this.audit('patch-wc-failed', { wcOrderId, error: e?.message }, 502);
      return;
    }

    this.logger.log(`[pilot] ✅ #${wcOrderId} auto-enviado pra ${storesLabel}`);
    await this.audit('sent', { wcOrderId, stores: preview.groups.map((g: any) => g.storeCode), shippingMethod: preview.shippingMethod }, 200);
  }

  // ───────────────────────────────────────────────────────────────────────
  // HELPERS
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Monta o input esperado pelo `routing.previewSeparationForWc` a partir
   * do payload cru do WooCommerce. Replica a lógica do
   * OrdersController.prepareSeparation.
   */
  private async buildPreviewInput(wcOrder: any, wcOrderId: number) {
    const items = (wcOrder.line_items ?? []).map((li: any) => {
      const variant = extractVariantFromLineItem(li);
      return {
        sku: String(li.sku ?? '').trim(),
        quantity: Number(li.quantity ?? 0),
        productName: String(li.name ?? ''),
        variant,
      };
    });

    const shipping = wcOrder.shipping ?? {};
    const billing = wcOrder.billing ?? {};
    const shippingMethod = (wcOrder.shipping_lines ?? [])[0]?.method_title ?? 'Não informado';
    const customerName = [shipping.first_name || billing.first_name, shipping.last_name || billing.last_name]
      .filter(Boolean)
      .join(' ')
      .trim();

    const activeStores = await this.prisma.store.findMany({
      where: { active: true },
      select: { code: true, name: true, city: true },
    });
    const pickup = detectPickup(wcOrder, activeStores);
    const customerCpf = extractCpf(wcOrder);

    return {
      wcOrderId,
      wcOrderNumber: String(wcOrder.number ?? wcOrderId),
      orderDateIso: wcOrder.date_created_gmt ?? wcOrder.date_created ?? new Date().toISOString(),
      totalAmount: Number(wcOrder.total ?? 0),
      paymentMethod: wcOrder.payment_method_title ?? '',
      items,
      customerName,
      customerPhone: billing.phone ?? null,
      customerEmail: billing.email ?? null,
      customerCpf,
      shippingMethod,
      isPickup: pickup.isPickup,
      pickupStoreCode: pickup.pickupStoreCode,
      address: {
        street: shipping.address_1 ?? billing.address_1 ?? null,
        number: (shipping as any).number ?? (billing as any).number ?? null,
        complement: shipping.address_2 ?? billing.address_2 ?? null,
        neighborhood: (shipping as any).neighborhood ?? (billing as any).neighborhood ?? null,
        city: shipping.city ?? billing.city ?? null,
        state: shipping.state ?? billing.state ?? null,
        postcode: shipping.postcode ?? billing.postcode ?? null,
      },
    };
  }

  /** Grava audit no integration_logs. Nunca falha — silencia erros de DB. */
  private async audit(event: string, payload: any, status: number) {
    try {
      await this.prisma.integrationLog.create({
        data: {
          source: 'pilot',
          direction: 'out',
          event,
          payload: JSON.stringify(payload),
          status,
        },
      });
    } catch (e: any) {
      this.logger.warn(`[pilot] falha gravando audit log: ${e?.message}`);
    }
  }

  /** Últimos N audit logs (pra UI de observabilidade). */
  async recentLogs(limit = 50) {
    const rows = await this.prisma.integrationLog.findMany({
      where: { source: 'pilot' },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 200),
    });
    return rows.map((r) => ({
      id: r.id,
      event: r.event,
      status: r.status,
      createdAt: r.createdAt,
      payload: (() => {
        try { return r.payload ? JSON.parse(r.payload) : null; } catch { return r.payload; }
      })(),
    }));
  }
}
