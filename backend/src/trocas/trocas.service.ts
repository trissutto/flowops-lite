import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WooCommerceService } from '../woocommerce/woocommerce.service';
import { TrackingService } from '../tracking/tracking.service';
import { EmailService } from '../email/email.service';

/**
 * trocas.service.ts — PORTAL DE TROCAS self-service do e-commerce.
 *
 * A cliente entra em /trocas (página pública), localiza o pedido com
 * nº + CPF/e-mail, escolhe as peças, motivo e aceita a declaração.
 * A solicitação nasce aqui e atravessa o fluxo de status até finalizar.
 *
 * Regras centrais:
 *  - Valor de referência = LÍQUIDO PAGO por item (promoção + cupom rateado
 *    pelo WC + desconto extra do pedido rateado proporcionalmente). Congelado
 *    na solicitação — preço futuro NUNCA muda o cálculo.
 *  - Prazo de 7 dias corridos contados da ENTREGA identificada no rastreio
 *    do pedido (LinkeTrack). Fallback documentado quando não dá pra verificar.
 *  - 1 logística reversa GRÁTIS por CPF (independe de quantos pedidos).
 *    Concessões extras só via admin com justificativa (auditoria).
 *  - Troca da troca: parentId encadeia; wcOrderId sempre aponta pro pedido
 *    original. Histórico (TrocaEvento) nunca é apagado.
 */

export const TROCA_STATUS = [
  'solicitada',
  'aguardando_postagem',
  'aguardando_envio_cliente',
  'postada',
  'em_transporte',
  'recebida',
  'em_conferencia',
  'aguardando_decisao',
  'produto_reservado',
  'aguardando_pagamento_diferenca',
  'reembolso_andamento',
  'finalizada',
  'cancelada',
] as const;

export const TROCA_MOTIVOS = [
  'Tamanho pequeno',
  'Tamanho grande',
  'Não gostei',
  'Cor diferente',
  'Produto com defeito',
  'Produto errado',
  'Arrependimento da compra',
  'Outro',
] as const;

/** Status em que a troca ainda "segura" o item (bloqueia nova solicitação). */
const STATUS_ATIVOS = TROCA_STATUS.filter(
  (s) => s !== 'cancelada',
) as string[];

/** Endereço fixo pra devolução por conta da cliente (2ª reversa em diante). */
export const ENDERECO_DEVOLUCAO = {
  destinatario: "Lurds Plus Size A/C Thiago Rissutto",
  endereco: 'Avenida Harry Forssell, 159',
  bairro: 'Belas Artes',
  cidadeUf: 'Itanhaém/SP',
  cep: '11746-692',
};

function onlyDigits(v: any): string {
  return String(v || '').replace(/\D/g, '');
}

function normEmail(v: any): string {
  return String(v || '').trim().toLowerCase();
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** "22/04/2026" + "14:30" → Date (fuso local do servidor). */
function parseBrDateTime(date: string, time?: string): Date | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((date || '').trim());
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const t = /^(\d{2}):(\d{2})/.exec((time || '').trim());
  const d = new Date(
    Number(yyyy),
    Number(mm) - 1,
    Number(dd),
    t ? Number(t[1]) : 12,
    t ? Number(t[2]) : 0,
  );
  return isNaN(d.getTime()) ? null : d;
}

export function formatTrocaNumero(n: number): string {
  return `T${String(n).padStart(4, '0')}`;
}

@Injectable()
export class TrocasService {
  private readonly logger = new Logger(TrocasService.name);
  private readonly DEFAULT_PRAZO_DIAS = 7;

  constructor(
    private readonly prisma: PrismaService,
    private readonly wc: WooCommerceService,
    private readonly tracking: TrackingService,
    private readonly email: EmailService,
  ) {}

  // ── Config (mesma chave da tela de trocas da equipe) ────────────────

  async getPrazoDias(): Promise<number> {
    try {
      const cfg = await (this.prisma as any).systemSetting.findUnique({
        where: { key: 'troca.prazoDias' },
      });
      const n = parseInt(cfg?.value || '', 10);
      if (Number.isFinite(n) && n > 0) return n;
    } catch {
      /* usa default */
    }
    return this.DEFAULT_PRAZO_DIAS;
  }

  // ── Localizar pedido (identidade = nº pedido + CPF ou e-mail) ───────

  /**
   * Acha o pedido WC e valida a identidade. NUNCA diferencia "pedido não
   * existe" de "dados não conferem" (evita enumeração de pedidos).
   */
  private async findAndVerifyOrder(input: { pedido: string; doc: string }) {
    const pedidoNum = parseInt(onlyDigits(input.pedido), 10);
    const doc = String(input.doc || '').trim();
    if (!pedidoNum || !doc) {
      throw new BadRequestException('Informe o número do pedido e o CPF ou e-mail da compra.');
    }

    let order: any = null;
    try {
      order = await this.wc.getOrder(pedidoNum);
    } catch {
      order = null;
    }
    // Se o "number" exibido difere do id interno, tenta busca textual
    if (!order) {
      try {
        const res = await this.wc.listOrders({ search: String(pedidoNum), perPage: 10, status: 'any' } as any);
        order = (res.data || []).find(
          (o: any) => String(o.number) === String(pedidoNum) || Number(o.id) === pedidoNum,
        ) || null;
      } catch {
        order = null;
      }
    }

    const genericErr = new NotFoundException(
      'Pedido não encontrado ou os dados não conferem. Confira o número do pedido e o CPF/e-mail usados na compra.',
    );
    if (!order) throw genericErr;

    const billing = order.billing || {};
    const docDigits = onlyDigits(doc);
    const cpfPedido = onlyDigits(
      billing.cpf || (order.meta_data || []).find((m: any) => m.key === '_billing_cpf')?.value,
    );
    const emailPedido = normEmail(billing.email);

    const cpfOk = docDigits.length === 11 && cpfPedido && docDigits === cpfPedido;
    const emailOk = doc.includes('@') && emailPedido && normEmail(doc) === emailPedido;
    if (!cpfOk && !emailOk) throw genericErr;

    return { order, cpfPedido, emailPedido };
  }

  /** Extrai código de rastreio do pedido WC (plugins mais comuns no BR). */
  private extractTrackingCode(order: any): string | null {
    const meta: any[] = order.meta_data || [];
    const keys = ['_correios_tracking_code', '_tracking_number', '_melhorenvio_tracking'];
    for (const k of keys) {
      const v = meta.find((m) => m.key === k)?.value;
      if (v && String(v).trim()) return String(v).trim().split(',')[0].trim();
    }
    return null;
  }

  /**
   * Valida o prazo: entrega identificada no rastreio → conta dias corridos.
   * Fallbacks explícitos quando o rastreio não resolve.
   */
  private async checkPrazo(order: any, prazoDias: number) {
    const trackingCode = this.extractTrackingCode(order);
    let deliveredAt: Date | null = null;
    let via: 'rastreio' | 'data_pedido' | 'nao_verificado' = 'nao_verificado';
    let entregue = false;

    if (trackingCode) {
      const t = await this.tracking.fetchTracking(trackingCode);
      if (!t.error && (t.delivered || t.events.length)) {
        entregue = t.delivered;
        const ev = t.events.find((e) => e.isDelivery);
        if (ev) {
          deliveredAt = parseBrDateTime(ev.date, ev.time);
          if (deliveredAt) via = 'rastreio';
        }
        if (t.delivered && !deliveredAt) via = 'nao_verificado';
      }
    }

    // Fallback: sem rastreio útil → conta do date_completed (pedido concluído)
    if (via !== 'rastreio') {
      const base =
        order.date_completed_gmt || order.date_completed ||
        order.date_paid_gmt || order.date_paid || null;
      if (base) {
        deliveredAt = new Date(base);
        via = 'data_pedido';
        // Sem rastreio dizendo o contrário, assume que já chegou se o pedido
        // foi concluído (status completed) — a conferência humana cobre o resto.
        entregue = entregue || String(order.status) === 'completed';
      }
    }

    const dias = deliveredAt
      ? Math.floor((Date.now() - deliveredAt.getTime()) / 86_400_000)
      : null;
    // "data_pedido" conta do envio, não da entrega — dá uma folga de trânsito
    const margem = via === 'data_pedido' ? 10 : 0;
    const dentroDoPrazo = dias == null ? true : dias <= prazoDias + margem;

    return { trackingCode, deliveredAt, via, dias, dentroDoPrazo, entregue };
  }

  /**
   * Calcula o LÍQUIDO PAGO por item:
   *  - line_item.total já vem com promoção + cupom rateado pelo WC;
   *  - desconto extra a nível de pedido (ex.: PIX como fee negativa) é
   *    rateado proporcionalmente entre os itens.
   */
  private computeItemValues(order: any) {
    const lineItems: any[] = order.line_items || [];
    const itemsTotal = lineItems.reduce(
      (s, it) => s + (parseFloat(String(it.total ?? '0')) || 0),
      0,
    );
    // Fees negativas = descontos de pedido (desconto PIX de vários plugins)
    const feeDiscount = (order.fee_lines || []).reduce((s: number, f: any) => {
      const v = parseFloat(String(f.total ?? '0')) || 0;
      return v < 0 ? s + Math.abs(v) : s;
    }, 0);
    const factor = itemsTotal > 0 ? Math.max(0, (itemsTotal - feeDiscount) / itemsTotal) : 1;

    return lineItems.map((it) => {
      const qty = Number(it.quantity) || 1;
      const subtotal = parseFloat(String(it.subtotal ?? it.total ?? '0')) || 0;
      const total = parseFloat(String(it.total ?? '0')) || 0;
      const pago = total * factor;
      return {
        sku: String(it.sku || '').trim(),
        productName: String(it.name || it.sku || ''),
        qty,
        valorOriginalUnit: round2(qty > 0 ? subtotal / qty : subtotal),
        valorPagoUnit: round2(qty > 0 ? pago / qty : pago),
        totalPago: round2(pago),
      };
    });
  }

  // ── Benefício da reversa grátis (por CPF) ───────────────────────────

  async getBeneficioReversa(cpf: string) {
    const cpfDigits = onlyDigits(cpf);
    if (cpfDigits.length !== 11) {
      return { cpf: cpfDigits, disponivel: false, usos: [], concessoes: 0, permitidas: 0, totalTrocas: 0 };
    }
    const [usos, concessoes, totalTrocas] = await Promise.all([
      (this.prisma as any).trocaSolicitacao.findMany({
        where: { customerCpf: cpfDigits, reversaGratis: true, status: { not: 'cancelada' } },
        select: { id: true, numero: true, createdAt: true, reversaEnviadaAt: true },
        orderBy: { createdAt: 'asc' },
      }),
      (this.prisma as any).trocaReversaConcessao.count({ where: { cpf: cpfDigits } }),
      (this.prisma as any).trocaSolicitacao.count({
        where: { customerCpf: cpfDigits, status: { not: 'cancelada' } },
      }),
    ]);
    const permitidas = 1 + concessoes;
    return {
      cpf: cpfDigits,
      disponivel: usos.length < permitidas,
      usos: usos.map((u: any) => ({
        trocaId: u.id,
        numero: formatTrocaNumero(u.numero),
        data: u.createdAt,
      })),
      concessoes,
      permitidas,
      totalTrocas,
    };
  }

  // ── Portal público: localizar ───────────────────────────────────────

  async localizar(input: { pedido: string; doc: string }) {
    const { order } = await this.findAndVerifyOrder(input);
    const prazoDias = await this.getPrazoDias();
    const prazo = await this.checkPrazo(order, prazoDias);
    const itemValues = this.computeItemValues(order);

    // Trocas já existentes desse pedido (histórico + saldo elegível)
    const trocas = await (this.prisma as any).trocaSolicitacao.findMany({
      where: { wcOrderId: Number(order.id) },
      include: { items: true, eventos: { orderBy: { createdAt: 'asc' } } },
      orderBy: { createdAt: 'asc' },
    });

    const solicitadoBySku = new Map<string, number>();
    for (const t of trocas) {
      if (!STATUS_ATIVOS.includes(t.status)) continue;
      for (const it of t.items) {
        solicitadoBySku.set(it.sku, (solicitadoBySku.get(it.sku) || 0) + it.qty);
      }
    }

    const items = itemValues.map((it) => {
      const ja = solicitadoBySku.get(it.sku) || 0;
      return { ...it, jaSolicitado: ja, disponivel: Math.max(0, it.qty - ja) };
    });

    const billing = order.billing || {};
    const cpfDigits = onlyDigits(billing.cpf);
    const beneficio = cpfDigits.length === 11
      ? await this.getBeneficioReversa(cpfDigits)
      : { disponivel: true, usos: [], concessoes: 0, permitidas: 1, totalTrocas: 0 };

    return {
      wcOrderId: Number(order.id),
      wcOrderNumber: String(order.number || order.id),
      status: order.status,
      customerName:
        [billing.first_name, billing.last_name].filter(Boolean).join(' ').trim() || null,
      prazo: {
        prazoDias,
        via: prazo.via,
        entregue: prazo.entregue,
        deliveredAt: prazo.deliveredAt,
        diasDesdeEntrega: prazo.dias,
        dentroDoPrazo: prazo.dentroDoPrazo,
        trackingCode: prazo.trackingCode,
      },
      reversaGratisDisponivel: beneficio.disponivel,
      items,
      motivos: TROCA_MOTIVOS,
      trocas: trocas.map((t: any) => this.formatTrocaPublic(t)),
    };
  }

  /** Visão pública de uma troca (sem dados internos). */
  private formatTrocaPublic(t: any) {
    return {
      id: t.id,
      numero: formatTrocaNumero(t.numero),
      status: t.status,
      motivo: t.motivo,
      valorTotalPago: t.valorTotalPago,
      reversaGratis: t.reversaGratis,
      reversaCodigo: t.reversaCodigo,
      reversaPrazo: t.reversaPrazo,
      clienteTrackingCode: t.clienteTrackingCode,
      createdAt: t.createdAt,
      items: (t.items || []).map((it: any) => ({
        sku: it.sku,
        productName: it.productName,
        qty: it.qty,
        valorPagoUnit: it.valorPagoUnit,
        totalPago: it.totalPago,
      })),
      timeline: (t.eventos || []).map((e: any) => ({
        tipo: e.tipo,
        descricao: e.descricao,
        statusPara: e.statusPara,
        createdAt: e.createdAt,
      })),
    };
  }

  // ── Portal público: criar solicitação ───────────────────────────────

  async solicitar(input: {
    pedido: string;
    doc: string;
    items: Array<{ sku: string; qty: number }>;
    motivo: string;
    motivoDetalhe?: string;
    declaracaoAceita: boolean;
    ip?: string;
  }) {
    if (!input.declaracaoAceita) {
      throw new BadRequestException('É preciso aceitar a declaração pra continuar.');
    }
    const motivo = String(input.motivo || '').trim();
    if (!TROCA_MOTIVOS.includes(motivo as any)) {
      throw new BadRequestException('Escolha um motivo válido pra troca.');
    }
    if (motivo === 'Outro' && !String(input.motivoDetalhe || '').trim()) {
      throw new BadRequestException('Descreva o motivo da troca.');
    }
    if (!input.items?.length) {
      throw new BadRequestException('Selecione ao menos uma peça pra troca.');
    }

    const { order } = await this.findAndVerifyOrder(input);
    const prazoDias = await this.getPrazoDias();
    const prazo = await this.checkPrazo(order, prazoDias);

    // ETAPA 4 — validação automática
    if (prazo.via === 'rastreio' && !prazo.entregue) {
      throw new BadRequestException(
        'Ainda não identificamos a entrega deste pedido no rastreio. Assim que a encomenda for entregue, você poderá solicitar a troca.',
      );
    }
    if (!prazo.dentroDoPrazo) {
      throw new BadRequestException(
        'Infelizmente este pedido não está mais dentro do prazo para troca.',
      );
    }

    // Saldo elegível por SKU (desconta trocas ativas anteriores)
    const detail = await this.localizar(input);
    const bySku = new Map(detail.items.map((it: any) => [it.sku, it]));

    const itemsToCreate: any[] = [];
    let valorTotalPago = 0;
    for (const req of input.items) {
      const sku = String(req.sku || '').trim();
      const original: any = bySku.get(sku);
      if (!original) throw new BadRequestException(`A peça ${sku} não está neste pedido.`);
      const qty = Math.max(1, Math.floor(Number(req.qty) || 0));
      if (qty > original.disponivel) {
        throw new BadRequestException(
          `${original.productName}: já existe troca em andamento pra essa peça (disponível: ${original.disponivel}).`,
        );
      }
      const totalPago = round2(original.valorPagoUnit * qty);
      valorTotalPago += totalPago;
      itemsToCreate.push({
        sku,
        productName: original.productName,
        qty,
        valorOriginalUnit: original.valorOriginalUnit,
        valorPagoUnit: original.valorPagoUnit,
        totalPago,
      });
    }
    valorTotalPago = round2(valorTotalPago);

    const billing = order.billing || {};
    const cpfDigits = onlyDigits(billing.cpf);

    // ETAPAS 6/7 — benefício da reversa decide o status inicial
    const beneficio = await this.getBeneficioReversa(cpfDigits);
    const usaGratis = beneficio.disponivel && cpfDigits.length === 11;
    const status = usaGratis ? 'aguardando_postagem' : 'aguardando_envio_cliente';

    const troca = await (this.prisma as any).trocaSolicitacao.create({
      data: {
        wcOrderId: Number(order.id),
        wcOrderNumber: String(order.number || order.id),
        customerName:
          [billing.first_name, billing.last_name].filter(Boolean).join(' ').trim() || null,
        customerCpf: cpfDigits || null,
        customerEmail: normEmail(billing.email) || null,
        customerPhone: onlyDigits(billing.phone) || null,
        motivo,
        motivoDetalhe: String(input.motivoDetalhe || '').trim() || null,
        status,
        trackingCodePedido: prazo.trackingCode,
        deliveredAt: prazo.deliveredAt,
        prazoVerificadoVia: prazo.via,
        diasDesdeEntrega: prazo.dias,
        dentroDoPrazo: prazo.dentroDoPrazo,
        declaracaoAceitaAt: new Date(),
        declaracaoIp: input.ip || null,
        reversaGratis: usaGratis,
        valorTotalPago,
        items: { create: itemsToCreate },
        eventos: {
          create: [
            {
              tipo: 'solicitacao',
              descricao:
                `Solicitação criada pelo portal. Motivo: ${motivo}` +
                (input.motivoDetalhe ? ` — ${String(input.motivoDetalhe).trim()}` : '') +
                `. Prazo verificado via ${prazo.via}` +
                (prazo.dias != null ? ` (${prazo.dias} dias desde a entrega)` : '') +
                `. Valor elegível: R$ ${valorTotalPago.toFixed(2)}.`,
              statusPara: status,
            },
            {
              tipo: 'reversa',
              descricao: usaGratis
                ? 'Logística reversa GRATUITA reservada (1ª por CPF). Aguardando equipe gerar o código de postagem.'
                : 'Benefício da reversa gratuita já utilizado — devolução por conta da cliente. Endereço exibido no portal.',
            },
          ],
        },
      },
      include: { items: true, eventos: true },
    });

    this.logger.log(
      `[troca] ${formatTrocaNumero(troca.numero)} pedido=${troca.wcOrderId} ` +
        `cpf=${cpfDigits ? cpfDigits.slice(0, 3) + '***' : '-'} status=${status} R$${valorTotalPago.toFixed(2)}`,
    );

    return {
      ok: true,
      numero: formatTrocaNumero(troca.numero),
      status,
      reversaGratis: usaGratis,
      valorTotalPago,
      enderecoDevolucao: usaGratis ? null : ENDERECO_DEVOLUCAO,
      mensagem: usaGratis
        ? 'Solicitação criada! Você vai receber por e-mail o código de postagem gratuita dos Correios pra devolver a peça.'
        : 'Solicitação criada! Como a logística reversa gratuita já foi utilizada neste CPF, a devolução é por sua conta. Envie a peça pro endereço abaixo e informe o código de rastreio aqui no portal.',
    };
  }

  // ── Portal público: cliente informa o rastreio da devolução ─────────

  async informarRastreio(input: { pedido: string; doc: string; trocaId: string; trackingCode: string }) {
    const { order } = await this.findAndVerifyOrder(input);
    const code = String(input.trackingCode || '').trim().toUpperCase();
    if (code.length < 8) throw new BadRequestException('Código de rastreio inválido.');

    const troca = await (this.prisma as any).trocaSolicitacao.findFirst({
      where: { id: input.trocaId, wcOrderId: Number(order.id) },
    });
    if (!troca) throw new NotFoundException('Troca não encontrada pra este pedido.');
    if (!['aguardando_envio_cliente', 'aguardando_postagem'].includes(troca.status)) {
      throw new BadRequestException('Esta troca não está aguardando envio.');
    }

    await (this.prisma as any).trocaSolicitacao.update({
      where: { id: troca.id },
      data: {
        clienteTrackingCode: code,
        status: 'postada',
        eventos: {
          create: {
            tipo: 'rastreio_cliente',
            descricao: `Cliente informou o rastreio da devolução: ${code}`,
            statusDe: troca.status,
            statusPara: 'postada',
          },
        },
      },
    });
    return { ok: true, status: 'postada' };
  }

  // ── Admin: lista / detalhe ───────────────────────────────────────────

  async list(input: {
    status?: string;
    q?: string;
    from?: Date;
    to?: Date;
    limit?: number;
  }) {
    const where: any = {};
    if (input.status) where.status = input.status;
    if (input.from || input.to) {
      where.createdAt = {};
      if (input.from) where.createdAt.gte = input.from;
      if (input.to) where.createdAt.lte = input.to;
    }
    if (input.q) {
      const q = String(input.q).trim();
      const qDigits = onlyDigits(q);
      const or: any[] = [
        { customerName: { contains: q, mode: 'insensitive' } },
        { wcOrderNumber: { contains: qDigits || q } },
      ];
      if (qDigits.length >= 3) or.push({ customerCpf: { contains: qDigits } });
      if (/^t?\d+$/i.test(q)) {
        const n = parseInt(q.replace(/^t/i, ''), 10);
        if (Number.isFinite(n)) or.push({ numero: n });
      }
      where.OR = or;
    }
    const rows = await (this.prisma as any).trocaSolicitacao.findMany({
      where,
      include: { items: true },
      orderBy: { createdAt: 'desc' },
      take: Math.min(300, Math.max(1, input.limit || 100)),
    });
    return rows.map((t: any) => ({ ...t, numeroFmt: formatTrocaNumero(t.numero) }));
  }

  async getDetail(id: string) {
    const t = await (this.prisma as any).trocaSolicitacao.findUnique({
      where: { id },
      include: {
        items: true,
        eventos: { orderBy: { createdAt: 'asc' } },
        filhas: { select: { id: true, numero: true, status: true } },
        parent: { select: { id: true, numero: true, status: true } },
      },
    });
    if (!t) throw new NotFoundException('Troca não encontrada');
    const beneficio = t.customerCpf ? await this.getBeneficioReversa(t.customerCpf) : null;
    return { ...t, numeroFmt: formatTrocaNumero(t.numero), beneficio };
  }

  // ── Admin: colar código da reversa + e-mail automático ──────────────

  async setReversaCodigo(input: {
    id: string;
    codigo: string;
    prazoDias?: number;
    userId?: string;
    userName?: string;
  }) {
    const codigo = String(input.codigo || '').trim().toUpperCase();
    if (codigo.length < 6) throw new BadRequestException('Código de postagem inválido.');

    const troca = await (this.prisma as any).trocaSolicitacao.findUnique({
      where: { id: input.id },
    });
    if (!troca) throw new NotFoundException('Troca não encontrada');

    const prazo = new Date(Date.now() + Math.max(1, input.prazoDias || 15) * 86_400_000);

    // Dispara o e-mail com a mensagem oficial da política
    let emailOk = false;
    if (troca.customerEmail) {
      const numeroFmt = formatTrocaNumero(troca.numero);
      emailOk = await this.email.send(
        troca.customerEmail,
        `Lurds Plus Size — código de postagem da sua troca ${numeroFmt} 💛`,
        `
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#2A2620">
          <h2 style="color:#8C7325">Olá! 💛</h2>
          <p>Sua solicitação de troca <b>${numeroFmt}</b> foi aprovada. Utilize o código abaixo para postar gratuitamente sua devolução em qualquer agência dos Correios:</p>
          <p style="font-size:24px;font-weight:bold;background:#FBF6E6;border:2px dashed #B8912B;border-radius:12px;padding:16px;text-align:center;letter-spacing:2px">${codigo}</p>
          <p>Agora é só embalar o produto de forma segura (de preferência na embalagem original ou em outra que proteja a peça) e levá-lo a qualquer agência dos Correios utilizando o código de postagem informado.</p>
          <p>Lembre-se de que a peça deve estar <b>sem sinais de uso, com a etiqueta original afixada e em perfeitas condições</b>, conforme nossa política de trocas.</p>
          <p>Assim que recebermos e conferirmos o produto, entraremos em contato para que você escolha entre a troca, vale-compras ou reembolso, conforme as opções disponíveis.</p>
          <p>O código é válido até <b>${prazo.toLocaleDateString('pt-BR')}</b>.</p>
          <p>Qualquer dúvida, estamos à disposição! 💛<br/>Equipe Lurds Plus Size</p>
        </div>`,
      );
    }

    const updated = await (this.prisma as any).trocaSolicitacao.update({
      where: { id: troca.id },
      data: {
        reversaCodigo: codigo,
        reversaPrazo: prazo,
        reversaEnviadaAt: emailOk ? new Date() : null,
        status: troca.status === 'solicitada' || troca.status === 'aguardando_envio_cliente'
          ? 'aguardando_postagem'
          : troca.status,
        eventos: {
          create: {
            tipo: 'reversa',
            descricao:
              `Código de postagem reversa registrado: ${codigo} (válido até ${prazo.toLocaleDateString('pt-BR')}).` +
              (emailOk
                ? ' E-mail enviado pra cliente automaticamente.'
                : ' ATENÇÃO: e-mail NÃO enviado (sem e-mail no pedido ou SMTP indisponível) — avisar a cliente manualmente.'),
            statusDe: troca.status,
            statusPara: 'aguardando_postagem',
            userId: input.userId || null,
            userName: input.userName || null,
          },
        },
      },
    });
    return { ok: true, emailEnviado: emailOk, troca: updated };
  }

  // ── Admin: mudar status manualmente ──────────────────────────────────

  async updateStatus(input: {
    id: string;
    status: string;
    nota?: string;
    userId?: string;
    userName?: string;
  }) {
    if (!TROCA_STATUS.includes(input.status as any)) {
      throw new BadRequestException(`Status inválido: ${input.status}`);
    }
    const troca = await (this.prisma as any).trocaSolicitacao.findUnique({ where: { id: input.id } });
    if (!troca) throw new NotFoundException('Troca não encontrada');
    if (troca.status === input.status) return { ok: true, troca };

    const updated = await (this.prisma as any).trocaSolicitacao.update({
      where: { id: troca.id },
      data: {
        status: input.status,
        eventos: {
          create: {
            tipo: 'status',
            descricao:
              `Status alterado de "${troca.status}" pra "${input.status}"` +
              (input.nota ? ` — ${String(input.nota).trim()}` : ''),
            statusDe: troca.status,
            statusPara: input.status,
            userId: input.userId || null,
            userName: input.userName || null,
          },
        },
      },
    });
    return { ok: true, troca: updated };
  }

  // ── Admin: conceder reversa grátis extra (auditada) ──────────────────

  async concederReversa(input: {
    trocaId: string;
    justificativa: string;
    userId?: string;
    userName?: string;
  }) {
    const justificativa = String(input.justificativa || '').trim();
    if (justificativa.length < 5) {
      throw new BadRequestException('Justificativa obrigatória pra conceder nova reversa gratuita.');
    }
    const troca = await (this.prisma as any).trocaSolicitacao.findUnique({ where: { id: input.trocaId } });
    if (!troca) throw new NotFoundException('Troca não encontrada');
    if (!troca.customerCpf) throw new BadRequestException('Troca sem CPF — não dá pra conceder benefício.');
    if (troca.reversaGratis) throw new BadRequestException('Esta troca já está com reversa gratuita.');

    await (this.prisma as any).trocaReversaConcessao.create({
      data: {
        cpf: troca.customerCpf,
        trocaId: troca.id,
        justificativa,
        userId: input.userId || null,
        userName: input.userName || null,
      },
    });
    const updated = await (this.prisma as any).trocaSolicitacao.update({
      where: { id: troca.id },
      data: {
        reversaGratis: true,
        status: troca.status === 'aguardando_envio_cliente' ? 'aguardando_postagem' : troca.status,
        eventos: {
          create: {
            tipo: 'concessao',
            descricao: `Reversa gratuita EXTRA concedida. Justificativa: ${justificativa}`,
            userId: input.userId || null,
            userName: input.userName || null,
          },
        },
      },
    });
    return { ok: true, troca: updated };
  }

  // ── Admin: cancelar ──────────────────────────────────────────────────

  async cancelar(input: { id: string; motivo?: string; userId?: string; userName?: string }) {
    const troca = await (this.prisma as any).trocaSolicitacao.findUnique({ where: { id: input.id } });
    if (!troca) throw new NotFoundException('Troca não encontrada');
    if (troca.status === 'finalizada') {
      throw new BadRequestException('Troca já finalizada — não dá pra cancelar.');
    }
    const updated = await (this.prisma as any).trocaSolicitacao.update({
      where: { id: troca.id },
      data: {
        status: 'cancelada',
        eventos: {
          create: {
            tipo: 'status',
            descricao: `Troca cancelada${input.motivo ? ` — ${String(input.motivo).trim()}` : ''}`,
            statusDe: troca.status,
            statusPara: 'cancelada',
            userId: input.userId || null,
            userName: input.userName || null,
          },
        },
      },
    });
    return { ok: true, troca: updated };
  }
}
