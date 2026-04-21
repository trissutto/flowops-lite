import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AbandonedCartsService } from '../abandoned-carts/abandoned-carts.service';

/**
 * Marketing Recovery — recuperação de carrinho via WhatsApp.
 *
 * FASE 1 (atual): MODO MANUAL
 *   - Lista candidatos elegíveis por estágio (T1 = 1h, T2 = 24h, T3 = 72h)
 *   - Operadora clica "Abrir WhatsApp Web" → envia → "Marcar como enviado"
 *   - Service registra WaMessage com sendMode=manual, status=sent
 *   - Cross-reference com Order recente pra detectar conversão
 *
 * FASE 2 (futuro): automático via Meta Cloud API
 *   - Cron roda a cada 5min, pega candidatos, dispara via template Meta
 *   - Webhook recebe status de entrega/leitura/resposta
 *   - Cupom único via WC REST
 */

export const STEPS = [
  { index: 0, key: 'T1', label: '1h — Lembrete suave', delayMinutes: 60, couponPct: 0 },
  { index: 1, key: 'T2', label: '24h — Cupom leve', delayMinutes: 24 * 60, couponPct: 5 },
  { index: 2, key: 'T3', label: '72h — Última cartada', delayMinutes: 72 * 60, couponPct: 10 },
] as const;

export type StepIndex = 0 | 1 | 2;

// Templates padrão (editáveis via UI mais tarde). Tom amigável/pessoal.
// Placeholders: {nome} {produto} {valor} {cupom} {link}
const DEFAULT_TEMPLATES: Record<number, string> = {
  0:
    'Oi {nome}! 💕 Vi que você separou {produto} no nosso site e acabou não finalizando.\n' +
    '\n' +
    'Ficou alguma dúvida sobre o tamanho ou a peça? Posso te ajudar a escolher a numeração certinha 😉\n' +
    '\n' +
    'Seu carrinho ainda tá aqui: {link}',
  1:
    'Oi {nome}! Passando pra avisar que seu carrinho ainda tá guardadinho aqui pra você 💖\n' +
    '\n' +
    'Como um agrado, liberei um cupom de 5% OFF pra você finalizar: *{cupom}*\n' +
    '\n' +
    'É só aplicar no checkout: {link}',
  2:
    '{nome}, última chance 💝\n' +
    '\n' +
    'Ainda tenho {produto} separado pra você, mas o estoque tá indo embora rápido.\n' +
    '\n' +
    'Liberei um cupom exclusivo de *10% OFF* só pra você hoje: *{cupom}*\n' +
    '\n' +
    'Clica aqui e finaliza: {link}',
};

interface CandidateRow {
  // Identificação do carrinho
  sourceType: 'cart' | 'wc-pending';
  sourceId: string;
  // Cliente
  name: string | null;
  email: string | null;
  phone: string;        // E.164 normalizado (dígitos só)
  phoneFormatted: string;
  // Conteúdo do carrinho
  productSummary: string;     // "Vestido Plus Size Preto (e mais 2)"
  amount: number | null;
  itemCount: number;
  // Tempo
  abandonedAt: string;        // ISO
  ageMinutes: number;
  // Estado de recuperação
  nextStepIndex: StepIndex | null;    // estágio que pode ser enviado agora
  alreadySentSteps: number[];         // quais estágios já foram mandados
  optedOut: boolean;
  converted: boolean;
  lastMessageAt: string | null;
}

@Injectable()
export class MarketingRecoveryService {
  private readonly logger = new Logger(MarketingRecoveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly abandoned: AbandonedCartsService,
  ) {}

  // ==========================================================================
  // Util — normalização de telefone BR
  // ==========================================================================

  /**
   * Normaliza telefone BR pra formato E.164 sem +. Aceita:
   *   "(11) 98765-4321" → "5511987654321"
   *   "11987654321"     → "5511987654321"
   *   "5511987654321"   → "5511987654321"
   * Retorna null se inválido.
   */
  normalizePhoneBR(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const digits = String(raw).replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 13) return null;
    // Se já começa com 55 e tem 12 ou 13 dígitos, mantém
    if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) {
      return digits;
    }
    // Se tem 10 ou 11 dígitos, adiciona o 55
    if (digits.length === 10 || digits.length === 11) {
      return '55' + digits;
    }
    return null;
  }

  formatPhoneBR(e164: string): string {
    // 5511987654321 → +55 (11) 98765-4321
    const d = e164.replace(/\D/g, '');
    if (d.length === 13 && d.startsWith('55')) {
      return `+55 (${d.slice(2, 4)}) ${d.slice(4, 9)}-${d.slice(9)}`;
    }
    if (d.length === 12 && d.startsWith('55')) {
      return `+55 (${d.slice(2, 4)}) ${d.slice(4, 8)}-${d.slice(8)}`;
    }
    return e164;
  }

  // ==========================================================================
  // Templates
  // ==========================================================================

  getStepsConfig() {
    return STEPS.map((s) => ({
      ...s,
      template: DEFAULT_TEMPLATES[s.index],
    }));
  }

  renderTemplate(
    stepIndex: number,
    ctx: {
      name?: string | null;
      product?: string | null;
      amount?: number | null;
      coupon?: string | null;
      link?: string | null;
    },
  ): string {
    const tpl = DEFAULT_TEMPLATES[stepIndex] ?? '';
    const firstName = (ctx.name ?? '').split(' ')[0]?.trim() || 'tudo bem';
    const product = ctx.product ?? 'seus itens';
    const valor = ctx.amount != null ? `R$ ${Number(ctx.amount).toFixed(2).replace('.', ',')}` : '';
    const cupom = ctx.coupon ?? 'VOLTA10';
    const link = ctx.link ?? '';
    return tpl
      .replace(/\{nome\}/g, firstName)
      .replace(/\{produto\}/g, product)
      .replace(/\{valor\}/g, valor)
      .replace(/\{cupom\}/g, cupom)
      .replace(/\{link\}/g, link);
  }

  // ==========================================================================
  // Candidatos a abordagem (= carrinhos abandonados elegíveis)
  // ==========================================================================

  /**
   * Lista candidatos agregando:
   *  1. Carrinhos do plugin WP (abandoned-carts.list)
   *  2. Estado local (WaMessage já enviadas) pra decidir próximo step
   *  3. Opt-outs
   *  4. Marcação de converted
   */
  async listCandidates(opts: {
    stepFilter?: 'all' | 'T1' | 'T2' | 'T3' | 'pending' | 'sent';
    limit?: number;
  } = {}): Promise<CandidateRow[]> {
    const limit = Math.min(opts.limit ?? 200, 500);

    // Tenta plugin WP primeiro, fallback pra WC REST
    let raw = await this.abandoned.list({ perPage: limit, status: 'abandoned' });
    if ((raw as any)?.ok === false || !Array.isArray((raw as any)?.items)) {
      raw = await this.abandoned.listWcPending({ perPage: limit, status: 'abandoned' });
    }
    const items: any[] = (raw as any)?.items ?? [];
    if (items.length === 0) return [];

    // Coleta todos os telefones normalizados pra fazer 1 query só de WaMessage + opt-outs
    const normalized: Array<{ src: any; phone: string }> = [];
    for (const it of items) {
      const phone = this.normalizePhoneBR(it.phone ?? it.customerPhone ?? null);
      if (!phone) continue;
      normalized.push({ src: it, phone });
    }
    if (normalized.length === 0) return [];

    const phones = Array.from(new Set(normalized.map((n) => n.phone)));
    const sourceIds = Array.from(
      new Set(normalized.map((n) => String(n.src.id ?? n.src.orderId ?? n.src.cartId))),
    );

    const [sentMessages, optOuts] = await Promise.all([
      (this.prisma as any).waMessage
        .findMany({
          where: {
            OR: [
              { customerPhone: { in: phones } },
              { sourceId: { in: sourceIds } },
            ],
            status: { in: ['sent', 'delivered', 'read', 'converted'] },
          },
          orderBy: { scheduledFor: 'desc' },
        })
        .catch(() => [] as any[]),
      (this.prisma as any).waOptOut
        .findMany({ where: { phone: { in: phones } } })
        .catch(() => [] as any[]),
    ]);
    const optOutSet = new Set((optOuts as any[]).map((o) => o.phone));
    // Index: sourceId → list de msgs; phone → list de msgs
    const msgByKey = new Map<string, any[]>();
    for (const m of sentMessages as any[]) {
      const k1 = `src:${m.sourceId}`;
      const k2 = `ph:${m.customerPhone}`;
      if (!msgByKey.has(k1)) msgByKey.set(k1, []);
      if (!msgByKey.has(k2)) msgByKey.set(k2, []);
      msgByKey.get(k1)!.push(m);
      msgByKey.get(k2)!.push(m);
    }

    const now = Date.now();
    const rows: CandidateRow[] = [];

    for (const { src, phone } of normalized) {
      const sourceId = String(src.id ?? src.orderId ?? src.cartId ?? '');
      if (!sourceId) continue;

      const byKey = [
        ...(msgByKey.get(`src:${sourceId}`) ?? []),
        ...(msgByKey.get(`ph:${phone}`) ?? []),
      ];
      const relevant = byKey.filter((m) => m.sourceId === sourceId);
      const alreadySent: number[] = Array.from(
        new Set(relevant.map((m) => m.stepIndex)),
      );
      const converted = relevant.some((m) => m.status === 'converted');

      const abandonedRaw = src.created_at ?? src.abandonedAt ?? src.date_created ?? null;
      const abandonedAt = abandonedRaw ? new Date(abandonedRaw).toISOString() : new Date().toISOString();
      const ageMinutes = Math.floor((now - new Date(abandonedAt).getTime()) / 60000);

      // Próximo step elegível = primeiro step não enviado cujo delay já passou
      let nextStepIndex: StepIndex | null = null;
      for (const s of STEPS) {
        if (alreadySent.includes(s.index)) continue;
        if (ageMinutes >= s.delayMinutes) {
          nextStepIndex = s.index as StepIndex;
          break;
        }
      }

      const productSummary = (() => {
        const list: any[] = src.items ?? [];
        if (list.length === 0) return '—';
        const first = list[0]?.name ?? list[0]?.product_name ?? list[0]?.productName ?? 'item';
        if (list.length === 1) return String(first);
        return `${first} (e mais ${list.length - 1})`;
      })();

      const amount =
        typeof src.total === 'number' ? src.total :
        typeof src.value === 'number' ? src.value :
        typeof src.amount === 'number' ? src.amount :
        typeof src.total === 'string' ? Number(src.total) :
        null;

      rows.push({
        sourceType: (src.source === 'wc-pending' ? 'wc-pending' : 'cart') as any,
        sourceId,
        name: src.customer_name ?? src.name ?? null,
        email: src.email ?? src.customer_email ?? null,
        phone,
        phoneFormatted: this.formatPhoneBR(phone),
        productSummary,
        amount: amount != null && !Number.isNaN(amount) ? amount : null,
        itemCount: Array.isArray(src.items) ? src.items.length : 0,
        abandonedAt,
        ageMinutes,
        nextStepIndex,
        alreadySentSteps: alreadySent,
        optedOut: optOutSet.has(phone),
        converted,
        lastMessageAt: relevant[0]?.sentAt
          ? new Date(relevant[0].sentAt).toISOString()
          : relevant[0]?.createdAt
          ? new Date(relevant[0].createdAt).toISOString()
          : null,
      });
    }

    // Filtros
    const filter = opts.stepFilter ?? 'all';
    let filtered = rows;
    if (filter === 'T1') filtered = rows.filter((r) => r.nextStepIndex === 0);
    else if (filter === 'T2') filtered = rows.filter((r) => r.nextStepIndex === 1);
    else if (filter === 'T3') filtered = rows.filter((r) => r.nextStepIndex === 2);
    else if (filter === 'pending') filtered = rows.filter((r) => r.nextStepIndex != null && !r.optedOut && !r.converted);
    else if (filter === 'sent') filtered = rows.filter((r) => r.alreadySentSteps.length > 0);

    // Ordena: pending primeiro (por urgência = nextStepIndex desc, ageMinutes desc), depois já enviados
    filtered.sort((a, b) => {
      if (a.optedOut !== b.optedOut) return a.optedOut ? 1 : -1;
      if (a.converted !== b.converted) return a.converted ? 1 : -1;
      const aHas = a.nextStepIndex != null;
      const bHas = b.nextStepIndex != null;
      if (aHas !== bHas) return aHas ? -1 : 1;
      if (aHas && bHas) {
        if (a.nextStepIndex !== b.nextStepIndex) {
          return (b.nextStepIndex as number) - (a.nextStepIndex as number);
        }
      }
      return b.ageMinutes - a.ageMinutes;
    });

    return filtered;
  }

  // ==========================================================================
  // Registrar envio manual
  // ==========================================================================

  async registerManualSent(dto: {
    sourceType: string;
    sourceId: string;
    stepIndex: number;
    customerPhone: string;
    customerName?: string | null;
    customerEmail?: string | null;
    bodyRendered: string;
    amount?: number | null;
    couponCode?: string | null;
    couponPct?: number | null;
    sentByUserId?: string;
  }) {
    const phone = this.normalizePhoneBR(dto.customerPhone);
    if (!phone) throw new BadRequestException('Telefone inválido');
    if (dto.stepIndex < 0 || dto.stepIndex > 2) {
      throw new BadRequestException('stepIndex inválido (0-2)');
    }

    // Dedup: se já enviou esse step pro mesmo source, bloqueia
    const existing = await (this.prisma as any).waMessage.findFirst({
      where: {
        sourceType: dto.sourceType,
        sourceId: dto.sourceId,
        stepIndex: dto.stepIndex,
        status: { in: ['sent', 'delivered', 'read', 'converted'] },
      },
    });
    if (existing) {
      throw new BadRequestException(
        `Estágio T${dto.stepIndex + 1} já foi enviado pra esse carrinho em ${new Date(existing.sentAt ?? existing.createdAt).toLocaleString('pt-BR')}`,
      );
    }

    // Opt-out
    const optOut = await (this.prisma as any).waOptOut.findUnique({ where: { phone } });
    if (optOut) {
      throw new BadRequestException('Cliente está na lista de opt-out (não quer mais receber)');
    }

    const now = new Date();
    const msg = await (this.prisma as any).waMessage.create({
      data: {
        stepIndex: dto.stepIndex,
        customerPhone: phone,
        customerEmail: dto.customerEmail ?? null,
        customerName: dto.customerName ?? null,
        sourceType: dto.sourceType,
        sourceId: dto.sourceId,
        sourceAmount: dto.amount ?? null,
        status: 'sent',
        scheduledFor: now,
        sentAt: now,
        bodyRendered: dto.bodyRendered,
        sendMode: 'manual',
        sentBy: dto.sentByUserId ?? null,
        couponCode: dto.couponCode ?? null,
        couponPct: dto.couponPct ?? null,
      },
    });
    return msg;
  }

  // ==========================================================================
  // Opt-out
  // ==========================================================================

  async addOptOut(phone: string, reason?: string) {
    const e164 = this.normalizePhoneBR(phone);
    if (!e164) throw new BadRequestException('Telefone inválido');
    return (this.prisma as any).waOptOut.upsert({
      where: { phone: e164 },
      update: { reason: reason ?? null },
      create: { phone: e164, reason: reason ?? null },
    });
  }

  async removeOptOut(phone: string) {
    const e164 = this.normalizePhoneBR(phone);
    if (!e164) throw new BadRequestException('Telefone inválido');
    try {
      await (this.prisma as any).waOptOut.delete({ where: { phone: e164 } });
      return { ok: true };
    } catch {
      throw new NotFoundException('Telefone não está na lista de opt-out');
    }
  }

  async listOptOuts() {
    return (this.prisma as any).waOptOut.findMany({ orderBy: { createdAt: 'desc' } });
  }

  // ==========================================================================
  // KPIs + histórico
  // ==========================================================================

  async stats(windowDays = 30) {
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
    const messages = await (this.prisma as any).waMessage.findMany({
      where: { createdAt: { gte: since } },
    });

    const sent = messages.length;
    const delivered = messages.filter((m: any) => m.deliveredAt).length;
    const read = messages.filter((m: any) => m.readAt).length;
    const converted = messages.filter((m: any) => m.status === 'converted' || m.convertedOrderId);
    const convertedCount = converted.length;
    const recoveredRevenue = converted.reduce(
      (sum: number, m: any) => sum + (Number(m.convertedAmount) || 0),
      0,
    );
    const pendingRevenue = messages
      .filter((m: any) => m.status !== 'converted' && !m.convertedOrderId)
      .reduce((sum: number, m: any) => sum + (Number(m.sourceAmount) || 0), 0);

    // Contagens por estágio
    const byStage = [0, 1, 2].map((si) => {
      const stageMsgs = messages.filter((m: any) => m.stepIndex === si);
      return {
        stepIndex: si,
        stepKey: STEPS[si].key,
        sent: stageMsgs.length,
        converted: stageMsgs.filter((m: any) => m.status === 'converted').length,
      };
    });

    return {
      windowDays,
      sent,
      delivered,
      read,
      convertedCount,
      conversionRate: sent > 0 ? Number(((convertedCount / sent) * 100).toFixed(2)) : 0,
      recoveredRevenue: Number(recoveredRevenue.toFixed(2)),
      pendingRevenue: Number(pendingRevenue.toFixed(2)),
      byStage,
    };
  }

  async history(limit = 100) {
    const rows = await (this.prisma as any).waMessage.findMany({
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 500),
    });
    return rows;
  }

  // ==========================================================================
  // Tracking de conversão — cross-reference mensagens enviadas com Orders
  // ==========================================================================

  /**
   * Rodar periodicamente (manual ou cron). Busca WaMessage dos últimos 7 dias
   * que ainda não foram marcadas como converted e cruza com Order criado
   * DEPOIS do envio, com mesmo phone OU mesmo email.
   */
  async scanConversions() {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const candidates = await (this.prisma as any).waMessage.findMany({
      where: {
        createdAt: { gte: sevenDaysAgo },
        status: { in: ['sent', 'delivered', 'read'] },
        convertedOrderId: null,
      },
    });
    if (candidates.length === 0) return { scanned: 0, matched: 0 };

    let matched = 0;
    for (const m of candidates) {
      const sentAt = m.sentAt ?? m.createdAt;
      // Busca Order criado DEPOIS do envio, com mesmo phone ou email
      const phone7 = (m.customerPhone as string).slice(-11); // últimos 11 dígitos
      const candidateOrders = await this.prisma.order.findMany({
        where: {
          createdAt: { gte: new Date(sentAt) },
          status: { in: ['processing', 'completed', 'ready', 'separating', 'separated'] },
          OR: [
            m.customerEmail ? { customerEmail: m.customerEmail } : undefined,
            { customerPhone: { contains: phone7 } },
          ].filter(Boolean) as any,
        },
        select: { id: true, totalAmount: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
        take: 1,
      });
      if (candidateOrders.length > 0) {
        const ord = candidateOrders[0];
        await (this.prisma as any).waMessage.update({
          where: { id: m.id },
          data: {
            status: 'converted',
            convertedAt: new Date(),
            convertedOrderId: ord.id,
            convertedAmount: ord.totalAmount ?? null,
          },
        });
        matched += 1;
      }
    }
    this.logger.log(`scanConversions: ${candidates.length} scanned, ${matched} matched`);
    return { scanned: candidates.length, matched };
  }
}
