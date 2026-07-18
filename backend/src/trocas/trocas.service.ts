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
import { ErpService } from '../erp/erp.service';

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

export const CONFERENCIA_CHECKLIST = [
  'Produto correto',
  'Sem uso',
  'Etiqueta presente',
  'Sem avarias',
  'Conforme política',
] as const;

export const CONFERENCIA_REPROVACAO_MOTIVOS = [
  'Produto usado',
  'Sem etiqueta',
  'Produto danificado',
  'Produto diferente',
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
    private readonly erp: ErpService,
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
      // Fase 2 — visão pública da decisão/andamento
      decisao: t.decisao,
      novaSku: t.novaSku,
      novaProductName: t.novaProductName,
      novaCor: t.novaCor,
      novaTamanho: t.novaTamanho,
      valeCode: t.valeCode,
      valeValidade: t.valeValidade,
      reembolsoForma: t.reembolsoForma,
      envioTrackingCode: t.envioTrackingCode,
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

  // ═══ FASE 2: recebimento → conferência → decisão → envio ═══════════

  private portalUrl(): string {
    const front = (process.env.FRONTEND_URL || '').split(',')[0].trim();
    return `${front || 'https://www.lurdsplussize.com.br'}/trocas`;
  }

  /** Etapa 9 — "Produto Recebido" → automaticamente Em Conferência. */
  async receber(input: { id: string; userId?: string; userName?: string }) {
    const troca = await (this.prisma as any).trocaSolicitacao.findUnique({ where: { id: input.id } });
    if (!troca) throw new NotFoundException('Troca não encontrada');
    if (['finalizada', 'cancelada'].includes(troca.status)) {
      throw new BadRequestException(`Troca ${troca.status} — não dá pra receber.`);
    }
    const updated = await (this.prisma as any).trocaSolicitacao.update({
      where: { id: troca.id },
      data: {
        status: 'em_conferencia',
        recebidaAt: troca.recebidaAt || new Date(),
        eventos: {
          create: {
            tipo: 'status',
            descricao: 'Produto recebido — enviado pra conferência.',
            statusDe: troca.status,
            statusPara: 'em_conferencia',
            userId: input.userId || null,
            userName: input.userName || null,
          },
        },
      },
    });
    return { ok: true, troca: updated };
  }

  /**
   * Etapas 10-12 — conferência com checklist.
   * Aprovada: entrada de estoque na loja que RECEBEU (increaseStock) +
   * e-mail "escolha a solução" + status aguardando_decisao.
   * Reprovada: e-mail com o motivo + WhatsApp do atendimento; status fica
   * em_conferencia com flag reprovada (equipe resolve manualmente).
   */
  async conferir(input: {
    id: string;
    aprovado: boolean;
    checklist?: Record<string, boolean>;
    motivoReprovacao?: string;
    storeCode?: string;
    userId?: string;
    userName?: string;
  }) {
    const troca = await (this.prisma as any).trocaSolicitacao.findUnique({
      where: { id: input.id },
      include: { items: true },
    });
    if (!troca) throw new NotFoundException('Troca não encontrada');
    if (!['em_conferencia', 'recebida'].includes(troca.status)) {
      throw new BadRequestException('Troca não está em conferência.');
    }

    // ── REPROVADA ──
    if (!input.aprovado) {
      const motivo = String(input.motivoReprovacao || '').trim();
      if (!CONFERENCIA_REPROVACAO_MOTIVOS.includes(motivo as any)) {
        throw new BadRequestException('Escolha o motivo da reprovação.');
      }
      let emailOk = false;
      if (troca.customerEmail) {
        emailOk = await this.email.send(
          troca.customerEmail,
          `Lurds Plus Size — conferência da troca ${formatTrocaNumero(troca.numero)}`,
          `
          <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#2A2620">
            <h2 style="color:#8C7325">Olá! 💛</h2>
            <p>Recebemos a peça da sua troca <b>${formatTrocaNumero(troca.numero)}</b>, mas infelizmente ela <b>não passou na conferência</b>.</p>
            <p>Motivo: <b>${motivo}</b></p>
            <p>Por favor, entre em contato com nosso atendimento pelo WhatsApp <b>(13) 99625-6238</b> pra gente resolver juntas a melhor solução.</p>
            <p>Equipe Lurds Plus Size 💛</p>
          </div>`,
        );
      }
      const updated = await (this.prisma as any).trocaSolicitacao.update({
        where: { id: troca.id },
        data: {
          conferenciaAt: new Date(),
          conferenciaAprovada: false,
          conferenciaReprovadaMotivo: motivo,
          conferenciaChecklist: input.checklist || null,
          eventos: {
            create: {
              tipo: 'conferencia',
              descricao:
                `Conferência REPROVADA — ${motivo}.` +
                (emailOk ? ' Cliente comunicada por e-mail (contato via WhatsApp).' : ' E-mail NÃO enviado — comunicar a cliente manualmente.'),
              userId: input.userId || null,
              userName: input.userName || null,
            },
          },
        },
      });
      return { ok: true, aprovado: false, emailEnviado: emailOk, troca: updated };
    }

    // ── APROVADA ──
    const storeCode = String(input.storeCode || '').trim();
    if (!storeCode) throw new BadRequestException('Informe a loja que recebeu a peça (entrada de estoque).');
    const store = await this.prisma.store.findUnique({
      where: { code: storeCode },
      select: { code: true, name: true } as any,
    });
    if (!store) throw new BadRequestException(`Loja ${storeCode} não cadastrada`);

    // Etapa 11 — entrada automática no estoque da loja receptora
    const stockAttempts: Array<{ ok: boolean; error?: string }> = [];
    try {
      const result = await this.erp.increaseStock(
        troca.items.map((it: any) => ({ sku: it.sku, qty: it.qty, storeCode })),
      );
      for (const _ of troca.items) {
        stockAttempts.push(result.success ? { ok: true } : { ok: false, error: result.error });
      }
    } catch (e: any) {
      for (const _ of troca.items) stockAttempts.push({ ok: false, error: e?.message || String(e) });
    }
    for (let i = 0; i < troca.items.length; i++) {
      await (this.prisma as any).trocaItem.update({
        where: { id: troca.items[i].id },
        data: {
          stockReturnedAt: stockAttempts[i]?.ok ? new Date() : null,
          stockError: stockAttempts[i]?.ok ? null : stockAttempts[i]?.error || null,
        },
      });
    }
    const stockOk = stockAttempts.every((a) => a.ok);

    // Etapa 12 — e-mail "escolha a solução"
    let emailOk = false;
    if (troca.customerEmail) {
      emailOk = await this.email.send(
        troca.customerEmail,
        `Lurds Plus Size — recebemos seu produto! Escolha como finalizar a troca ${formatTrocaNumero(troca.numero)} 💛`,
        `
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#2A2620">
          <h2 style="color:#8C7325">Olá! 💛</h2>
          <p>Recebemos e conferimos o produto da sua troca <b>${formatTrocaNumero(troca.numero)}</b> — está tudo certo!</p>
          <p><b>Agora é sua vez de escolher</b> como deseja finalizar: trocar o tamanho, trocar a cor, receber um vale-compras ou solicitar reembolso.</p>
          <p style="text-align:center;margin:24px 0">
            <a href="${this.portalUrl()}" style="background:#B8912B;color:#fff;font-weight:bold;padding:14px 28px;border-radius:12px;text-decoration:none">Escolher minha solução</a>
          </p>
          <p>Valor disponível pra troca: <b>R$ ${Number(troca.valorTotalPago).toFixed(2).replace('.', ',')}</b> (valor efetivamente pago).</p>
          <p>Qualquer dúvida, estamos à disposição! 💛<br/>Equipe Lurds Plus Size</p>
        </div>`,
      );
    }

    const updated = await (this.prisma as any).trocaSolicitacao.update({
      where: { id: troca.id },
      data: {
        status: 'aguardando_decisao',
        conferenciaAt: new Date(),
        conferenciaAprovada: true,
        conferenciaChecklist: input.checklist || null,
        receivingStoreCode: (store as any).code,
        receivingStoreName: (store as any).name,
        eventos: {
          create: {
            tipo: 'conferencia',
            descricao:
              `Conferência APROVADA. Entrada de estoque na loja ${(store as any).name} (${storeCode})` +
              (stockOk ? ' concluída.' : ' com ERRO em pelo menos um item — verificar (retry manual).') +
              (emailOk ? ' Cliente avisada por e-mail pra escolher a solução.' : ' E-mail NÃO enviado — avisar a cliente manualmente.'),
            statusDe: troca.status,
            statusPara: 'aguardando_decisao',
            userId: input.userId || null,
            userName: input.userName || null,
          },
        },
      },
    });
    return { ok: true, aprovado: true, stockOk, emailEnviado: emailOk, troca: updated };
  }

  // ── Grade de variações (ref × cor × tamanho) pelo ESPELHO ───────────

  /** Qtd reservada logicamente por outras trocas ativas (produto_reservado). */
  private async reservedQty(codigos: string[]): Promise<Map<string, number>> {
    if (!codigos.length) return new Map();
    const rows = await (this.prisma as any).trocaSolicitacao.findMany({
      where: { novaSku: { in: codigos }, status: 'produto_reservado' },
      select: { novaSku: true },
    });
    const map = new Map<string, number>();
    for (const r of rows) map.set(r.novaSku, (map.get(r.novaSku) || 0) + 1);
    return map;
  }

  /**
   * Variações da peça devolvida (mesma REF no espelho Wincred), com
   * disponibilidade = soma do estoque de TODAS as lojas − reservas lógicas.
   * Regra: decisão de tamanho/cor só pra troca de 1 item (multi-item → vale/reembolso).
   */
  async getVariacoes(input: { pedido: string; doc: string; trocaId: string }) {
    const { order } = await this.findAndVerifyOrder(input);
    const troca = await (this.prisma as any).trocaSolicitacao.findFirst({
      where: { id: input.trocaId, wcOrderId: Number(order.id) },
      include: { items: true },
    });
    if (!troca) throw new NotFoundException('Troca não encontrada pra este pedido.');
    if (troca.items.length !== 1) {
      return { ok: false, motivo: 'multi_itens', variacoes: [] };
    }

    const codigo = String(troca.items[0].sku || '').replace(/^0+/, '');
    const produto = await (this.prisma as any).wincredProduto.findUnique({ where: { codigo } });
    if (!produto?.ref) {
      return { ok: false, motivo: 'sem_ref', variacoes: [] };
    }

    const variacoes = await (this.prisma as any).wincredProduto.findMany({
      where: { ref: produto.ref },
      select: { codigo: true, descricaoPdv: true, cor: true, tamanho: true, vendaUn: true },
    });
    const codigos = variacoes.map((v: any) => v.codigo);
    const [estoques, reservas] = await Promise.all([
      (this.prisma as any).wincredEstoque.groupBy({
        by: ['codigo'],
        where: { codigo: { in: codigos } },
        _sum: { estoque: true },
      }),
      this.reservedQty(codigos),
    ]);
    const estoqueByCodigo = new Map<string, number>(
      estoques.map((e: any) => [e.codigo, Number(e._sum?.estoque) || 0]),
    );

    return {
      ok: true,
      ref: produto.ref,
      atual: { codigo, cor: produto.cor, tamanho: produto.tamanho },
      variacoes: variacoes
        .map((v: any) => {
          const disp = Math.max(
            0,
            (estoqueByCodigo.get(v.codigo) || 0) - (reservas.get(v.codigo) || 0),
          );
          return {
            sku: v.codigo,
            nome: v.descricaoPdv,
            cor: v.cor || '—',
            tamanho: v.tamanho || '—',
            disponivel: disp,
          };
        })
        .filter((v: any) => v.disponivel > 0 || v.sku === codigo),
    };
  }

  // ── Etapas 12-17: decisão da cliente ─────────────────────────────────

  async decidir(input: {
    pedido: string;
    doc: string;
    trocaId: string;
    decisao: 'trocar_tamanho' | 'trocar_cor' | 'vale' | 'reembolso';
    novaSku?: string;
    chavePix?: string;
  }) {
    const { order } = await this.findAndVerifyOrder(input);
    const troca = await (this.prisma as any).trocaSolicitacao.findFirst({
      where: { id: input.trocaId, wcOrderId: Number(order.id) },
      include: { items: true },
    });
    if (!troca) throw new NotFoundException('Troca não encontrada pra este pedido.');
    if (troca.status !== 'aguardando_decisao') {
      throw new BadRequestException('Esta troca não está aguardando a sua decisão.');
    }

    // ── Trocar tamanho/cor: reserva lógica da nova peça ──
    if (input.decisao === 'trocar_tamanho' || input.decisao === 'trocar_cor') {
      const novaSku = String(input.novaSku || '').replace(/^0+/, '');
      if (!novaSku) throw new BadRequestException('Escolha a nova peça.');
      const grade = await this.getVariacoes(input);
      if (!grade.ok) throw new BadRequestException('Troca de tamanho/cor indisponível pra esta solicitação.');
      const opcao = (grade.variacoes as any[]).find((v) => v.sku === novaSku);
      if (!opcao || opcao.disponivel <= 0) {
        throw new BadRequestException('Essa opção acabou de ficar indisponível. Escolha outra, por favor.');
      }
      const updated = await (this.prisma as any).trocaSolicitacao.update({
        where: { id: troca.id },
        data: {
          decisao: input.decisao,
          decisaoAt: new Date(),
          novaSku,
          novaProductName: opcao.nome,
          novaCor: opcao.cor,
          novaTamanho: opcao.tamanho,
          reservaAt: new Date(),
          status: 'produto_reservado',
          eventos: {
            create: {
              tipo: 'decisao',
              descricao: `Cliente escolheu ${input.decisao === 'trocar_tamanho' ? 'trocar o TAMANHO' : 'trocar a COR'}: ${opcao.nome} (${opcao.cor} · ${opcao.tamanho}, SKU ${novaSku}). Peça reservada.`,
              statusDe: 'aguardando_decisao',
              statusPara: 'produto_reservado',
            },
          },
        },
      });
      return {
        ok: true,
        status: 'produto_reservado',
        mensagem: `Prontinho! Reservamos a peça ${opcao.cor} · tamanho ${opcao.tamanho} pra você. Assim que enviarmos, o rastreio aparece aqui no portal.`,
        troca: this.formatTrocaPublic({ ...updated, items: troca.items, eventos: [] }),
      };
    }

    // ── Vale-compras: cupom WC + registro local (90 dias) ──
    if (input.decisao === 'vale') {
      const valeCode = `TROCA-${Math.random().toString(36).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8).padEnd(8, '0')}`;
      const validade = new Date(Date.now() + 90 * 86_400_000);
      let cupomOk = false;
      try {
        const r = await this.wc.createDiscountCoupon({
          code: valeCode,
          amount: Number(troca.valorTotalPago),
          expiresAt: validade,
          description: `Vale-compras troca ${formatTrocaNumero(troca.numero)} (pedido #${troca.wcOrderNumber})`,
          customerEmail: troca.customerEmail || undefined,
        });
        cupomOk = !!r.ok;
      } catch { /* segue — vale local vale mesmo sem cupom no site */ }

      let emailOk = false;
      if (troca.customerEmail) {
        emailOk = await this.email.send(
          troca.customerEmail,
          `Lurds Plus Size — seu vale-compras de R$ ${Number(troca.valorTotalPago).toFixed(2).replace('.', ',')} 💛`,
          `
          <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#2A2620">
            <h2 style="color:#8C7325">Olá! 💛</h2>
            <p>Sua troca <b>${formatTrocaNumero(troca.numero)}</b> foi finalizada com um vale-compras:</p>
            <p style="font-size:24px;font-weight:bold;background:#FBF6E6;border:2px dashed #B8912B;border-radius:12px;padding:16px;text-align:center;letter-spacing:2px">${valeCode}</p>
            <p>Valor: <b>R$ ${Number(troca.valorTotalPago).toFixed(2).replace('.', ',')}</b> · válido até <b>${validade.toLocaleDateString('pt-BR')}</b>.</p>
            <p>Use no site aplicando o código no carrinho, ou apresente em uma de nossas lojas físicas.</p>
            <p>Equipe Lurds Plus Size 💛</p>
          </div>`,
        );
      }

      const updated = await (this.prisma as any).trocaSolicitacao.update({
        where: { id: troca.id },
        data: {
          decisao: 'vale',
          decisaoAt: new Date(),
          valeCode,
          valeValidade: validade,
          status: 'finalizada',
          eventos: {
            create: {
              tipo: 'decisao',
              descricao:
                `Cliente escolheu VALE-COMPRAS de R$ ${Number(troca.valorTotalPago).toFixed(2)} — código ${valeCode}, válido até ${validade.toLocaleDateString('pt-BR')}.` +
                (cupomOk ? ' Cupom criado no site.' : ' ATENÇÃO: cupom NÃO criado no WC — criar manualmente.') +
                (emailOk ? ' E-mail enviado.' : ' E-mail NÃO enviado.'),
              statusDe: 'aguardando_decisao',
              statusPara: 'finalizada',
            },
          },
        },
      });
      return {
        ok: true,
        status: 'finalizada',
        valeCode,
        valeValidade: validade,
        mensagem: `Seu vale-compras ${valeCode} de R$ ${Number(troca.valorTotalPago).toFixed(2).replace('.', ',')} está pronto! Vale no site ou em qualquer loja física até ${validade.toLocaleDateString('pt-BR')}.`,
        troca: this.formatTrocaPublic({ ...updated, items: troca.items, eventos: [] }),
      };
    }

    // ── Reembolso: identifica a forma de pagamento e organiza ──
    if (input.decisao === 'reembolso') {
      const metodo = String(order.payment_method || '').toLowerCase();
      const isPix = metodo.includes('pix');
      const forma = isPix ? 'pix' : metodo.includes('card') || metodo.includes('credit') || metodo.includes('cart') ? 'cartao' : 'outro';
      const chavePix = String(input.chavePix || '').trim();
      if (isPix && chavePix.length < 5) {
        throw new BadRequestException('Informe a chave PIX pra receber o reembolso.');
      }
      const updated = await (this.prisma as any).trocaSolicitacao.update({
        where: { id: troca.id },
        data: {
          decisao: 'reembolso',
          decisaoAt: new Date(),
          reembolsoForma: forma,
          reembolsoChavePix: isPix ? chavePix : null,
          status: 'reembolso_andamento',
          eventos: {
            create: {
              tipo: 'decisao',
              descricao:
                `Cliente escolheu REEMBOLSO de R$ ${Number(troca.valorTotalPago).toFixed(2)} — forma: ${forma.toUpperCase()}` +
                (isPix ? ` (chave PIX informada).` : forma === 'cartao' ? ' (estorno no cartão — solicitar no gateway).' : '.'),
              statusDe: 'aguardando_decisao',
              statusPara: 'reembolso_andamento',
            },
          },
        },
      });
      return {
        ok: true,
        status: 'reembolso_andamento',
        mensagem: isPix
          ? 'Reembolso solicitado! Faremos o PIX pra chave informada em até 3 dias úteis.'
          : 'Reembolso solicitado! O estorno será feito na mesma forma de pagamento da compra (o prazo de aparecer na fatura depende da operadora do cartão).',
        troca: this.formatTrocaPublic({ ...updated, items: troca.items, eventos: [] }),
      };
    }

    throw new BadRequestException('Escolha uma opção válida.');
  }

  // ── Admin: envio da nova peça / conclusão do reembolso ──────────────

  /** Etapas 18-19 — registra o rastreio do reenvio e finaliza. */
  async registrarEnvio(input: { id: string; trackingCode: string; userId?: string; userName?: string }) {
    const code = String(input.trackingCode || '').trim().toUpperCase();
    if (code.length < 8) throw new BadRequestException('Código de rastreio inválido.');
    const troca = await (this.prisma as any).trocaSolicitacao.findUnique({ where: { id: input.id } });
    if (!troca) throw new NotFoundException('Troca não encontrada');
    if (troca.status !== 'produto_reservado') {
      throw new BadRequestException('Troca não está com produto reservado aguardando envio.');
    }

    let emailOk = false;
    if (troca.customerEmail) {
      emailOk = await this.email.send(
        troca.customerEmail,
        `Lurds Plus Size — sua nova peça está a caminho! 💛`,
        `
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#2A2620">
          <h2 style="color:#8C7325">Olá! 💛</h2>
          <p>A nova peça da sua troca <b>${formatTrocaNumero(troca.numero)}</b> (${troca.novaProductName || ''} ${troca.novaCor || ''} · ${troca.novaTamanho || ''}) já foi postada!</p>
          <p>Código de rastreio: <b>${code}</b></p>
          <p><a href="https://rastreamento.correios.com.br/app/index.php?objetos=${encodeURIComponent(code)}">Acompanhar entrega nos Correios</a></p>
          <p>Equipe Lurds Plus Size 💛</p>
        </div>`,
      );
    }

    const updated = await (this.prisma as any).trocaSolicitacao.update({
      where: { id: troca.id },
      data: {
        envioTrackingCode: code,
        envioAt: new Date(),
        status: 'finalizada',
        eventos: {
          create: {
            tipo: 'envio',
            descricao:
              `Nova peça enviada — rastreio ${code}. Troca finalizada.` +
              (emailOk ? ' Cliente avisada por e-mail.' : ' E-mail NÃO enviado — avisar a cliente.'),
            statusDe: troca.status,
            statusPara: 'finalizada',
            userId: input.userId || null,
            userName: input.userName || null,
          },
        },
      },
    });
    return { ok: true, emailEnviado: emailOk, troca: updated };
  }

  /** Etapa 17 — equipe executou o PIX/estorno no gateway e conclui. */
  async concluirReembolso(input: { id: string; userId?: string; userName?: string }) {
    const troca = await (this.prisma as any).trocaSolicitacao.findUnique({ where: { id: input.id } });
    if (!troca) throw new NotFoundException('Troca não encontrada');
    if (troca.status !== 'reembolso_andamento') {
      throw new BadRequestException('Troca não está com reembolso em andamento.');
    }
    const updated = await (this.prisma as any).trocaSolicitacao.update({
      where: { id: troca.id },
      data: {
        status: 'finalizada',
        reembolsoConcluidoAt: new Date(),
        eventos: {
          create: {
            tipo: 'status',
            descricao: `Reembolso de R$ ${Number(troca.valorTotalPago).toFixed(2)} concluído (${(troca.reembolsoForma || '').toUpperCase()}). Troca finalizada.`,
            statusDe: 'reembolso_andamento',
            statusPara: 'finalizada',
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
