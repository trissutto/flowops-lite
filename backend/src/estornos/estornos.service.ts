import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { PagbankService } from '../pagbank/pagbank.service';
import { PagarmeService } from '../pagarme/pagarme.service';
import { AtorEstorno, EstornosAcessoService } from './estornos-acesso.service';
import { saleIdDaTroca, swapIdDoSaleId } from '../common/link-pagamento-pagbank';
import {
  GatewayEstorno,
  MOTIVOS_ESTORNO,
  STATUS_EM_ABERTO,
  STATUS_QUE_SEGURAM_SALDO,
  StatusEstorno,
  TipoEstorno,
  brl,
  lerRespostaPagarme,
  lerRespostaPagbank,
  podeEstornar,
  saldoEstornavelCents,
  validarValorEstorno,
} from '../common/estornos';

export type OrigemPagamento = 'site' | 'pdv_online' | 'live' | 'pdv_balcao' | 'crediario' | 'desconhecido';

/** O dono do dinheiro, pronto pra tela e pro comprovante. */
export interface DonoView {
  origem: OrigemPagamento;
  refId: string;
  refNumero: string | null;
  /** `wcOrderId` do pedido — é por ele que a tela chama o cancelamento. */
  refWcOrderId: number | null;
  refStatus: string | null;
  clienteNome: string | null;
  clienteCpf: string | null;
  clienteEmail: string | null;
  totalCents: number | null;
  pdvSaleId: string | null;
  /** O que o estorno NÃO faz nesta origem — sai na tela de confirmação. */
  aviso?: string;
}

export interface PagamentoView extends DonoView {
  /** `pagbank:<id>` / `pagarme:<id>` — a identidade que a tela devolve. */
  pagamentoId: string;
  gateway: GatewayEstorno;
  chargeId: string | null;
  gatewayOrderId: string | null;
  metodo: string;
  metodoLabel: string;
  storeCode: string | null;
  valorPagoCents: number;
  pagoEm: Date | null;
  estornadoCents: number;
  saldoCents: number;
  pode: boolean;
  motivoBloqueio?: string;
  /** Já existe estorno em andamento nesta cobrança (trava o botão). */
  emAndamento: boolean;
}

const LIMITE_PADRAO = 30;
const LIMITE_MAX = 100;

/**
 * ESTORNOS E DEVOLUÇÕES — o motor (22/09/2026).
 *
 * Devolve dinheiro da cliente PELA API do gateway, sem ninguém abrir a conta
 * do PagBank. Quatro fontes de dinheiro entram aqui, e todas as quatro são
 * cobrança nossa num gateway nosso:
 *
 *   pedido do site (PagBank desde 16/09, Pagar.me antes) · venda online do PDV
 *   (link/PIX) · carrinho da live · diferença de troca de peça.
 *
 * ── AS DUAS REGRAS QUE MANDAM AQUI ──
 *
 * 1. **Quem diz que estornou é o GATEWAY.** Nada de mudar status por conta
 *    própria: cada movimento lê a cobrança de verdade e o nosso registro
 *    copia o que ela respondeu. Resposta ambígua (timeout, 5xx) fica EM
 *    PROCESSAMENTO — o dinheiro pode ter saído.
 * 2. **O saldo vem do gateway, não do nosso histórico.** O dono pode ter
 *    estornado pelo painel do PagBank; se o saldo saísse só das nossas linhas,
 *    a tela ofereceria dinheiro que não existe mais e a cliente levaria um
 *    "recusado" sem explicação.
 */
@Injectable()
export class EstornosService {
  private readonly logger = new Logger(EstornosService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pagbank: PagbankService,
    private readonly pagarme: PagarmeService,
    private readonly acesso: EstornosAcessoService,
  ) {}

  motivos() {
    return MOTIVOS_ESTORNO.map((m) => ({ ...m }));
  }

  // ── Busca ─────────────────────────────────────────────────────────────────

  /**
   * Acha o pagamento a estornar por número do pedido, nome, CPF, e-mail ou
   * código da transação — com os filtros combinados que o dono pediu.
   */
  async buscar(f: {
    termo?: string;
    origem?: string;
    metodo?: string;
    de?: string;
    ate?: string;
    limite?: number;
  }): Promise<{ pagamentos: PagamentoView[]; termo: string; total: number }> {
    const termo = String(f.termo || '').trim();
    const limite = Math.min(LIMITE_MAX, Math.max(1, Number(f.limite) || LIMITE_PADRAO));

    const where: any = { status: 'paid' };
    const pagoEm = this.faixaDeData(f.de, f.ate);
    if (pagoEm) where.paidAt = pagoEm;
    if (f.metodo === 'pix') where.method = 'pix';
    if (f.metodo === 'credit_card') where.method = { not: 'pix' };

    let wherePagbank = where;
    let wherePagarme = where;
    if (termo) {
      const ids = await this.idsDoTermo(termo);
      // Sem dono e sem cara de id de gateway: não devolve a lista inteira.
      const solto = termo.replace(/[^A-Za-z0-9_-]/g, '');
      wherePagbank = {
        ...where,
        OR: [
          ...(ids.length ? [{ saleId: { in: ids } }] : []),
          ...(solto.length >= 6
            ? [
                { pagbankChargeId: { contains: solto, mode: 'insensitive' } },
                { pagbankOrderId: { contains: solto, mode: 'insensitive' } },
                { linkToken: solto },
              ]
            : []),
        ],
      };
      wherePagarme = {
        ...where,
        OR: [
          ...(ids.length ? [{ saleId: { in: ids } }] : []),
          ...(solto.length >= 6
            ? [
                { pagarmeChargeId: { contains: solto, mode: 'insensitive' } },
                { pagarmeOrderId: { contains: solto, mode: 'insensitive' } },
                { linkToken: solto },
              ]
            : []),
        ],
      };
      if (!wherePagbank.OR.length) return { pagamentos: [], termo, total: 0 };
    }

    const [pagbank, pagarme] = await Promise.all([
      (this.prisma as any).pagbankPayment.findMany({
        where: wherePagbank,
        orderBy: { paidAt: 'desc' },
        take: limite,
      }),
      (this.prisma as any).pagarmePayment.findMany({
        where: wherePagarme,
        orderBy: { paidAt: 'desc' },
        take: limite,
      }),
    ]);

    const brutos = [
      ...pagbank.map((p: any) => this.cruDoPagbank(p)),
      ...pagarme.map((p: any) => this.cruDoPagarme(p)),
    ].sort((a, b) => (b.pagoEm?.getTime() || 0) - (a.pagoEm?.getTime() || 0));

    const pagamentos = await this.montarViews(brutos);
    const filtrados = f.origem && f.origem !== 'todos'
      ? pagamentos.filter((p) => p.origem === f.origem)
      : pagamentos;
    return { pagamentos: filtrados.slice(0, limite), termo, total: filtrados.length };
  }

  private faixaDeData(de?: string, ate?: string): any | null {
    const ini = de ? new Date(`${de}T00:00:00.000-03:00`) : null;
    const fim = ate ? new Date(`${ate}T23:59:59.999-03:00`) : null;
    const faixa: any = {};
    if (ini && Number.isFinite(ini.getTime())) faixa.gte = ini;
    if (fim && Number.isFinite(fim.getTime())) faixa.lte = fim;
    return Object.keys(faixa).length ? faixa : null;
  }

  /** Do que a pessoa digitou até os `saleId` que podem ter pagamento. */
  private async idsDoTermo(termo: string): Promise<string[]> {
    const digitos = termo.replace(/\D/g, '');
    const texto = { contains: termo, mode: 'insensitive' as const };
    const ouPessoa: any[] = [{ customerName: texto }, { customerEmail: texto }];
    if (digitos.length >= 6) ouPessoa.push({ customerCpf: { contains: digitos } }, { customerPhone: { contains: digitos } });
    if (termo.includes('.') || termo.includes('-')) ouPessoa.push({ customerCpf: texto });

    const ouPedido: any[] = [...ouPessoa, { wcOrderNumber: texto }];
    if (digitos && digitos.length <= 9) ouPedido.push({ wcOrderId: Number(digitos) });

    const [pedidos, vendas, carrinhos] = await Promise.all([
      (this.prisma as any).order.findMany({
        where: { OR: ouPedido },
        select: { id: true, source: true, liveCartId: true, checkoutInfo: true },
        orderBy: { createdAt: 'desc' },
        take: 60,
      }),
      (this.prisma as any).pdvSale.findMany({
        where: { OR: ouPessoa },
        select: { id: true },
        orderBy: { createdAt: 'desc' },
        take: 60,
      }),
      (this.prisma as any).livePdvCart.findMany({
        where: { OR: [...ouPessoa, { customerInstagram: texto }] },
        select: { id: true },
        orderBy: { createdAt: 'desc' },
        take: 60,
      }),
    ]);

    const ids = new Set<string>();
    const idsPedido: string[] = [];
    for (const p of pedidos as any[]) {
      ids.add(p.id);
      idsPedido.push(p.id);
      if (p.liveCartId) ids.add(p.liveCartId);
      // Pedido ON-: o dinheiro está na VENDA do PDV por trás dele.
      const saleId = this.pdvSaleIdDoPedido(p.checkoutInfo);
      if (saleId) ids.add(saleId);
    }
    for (const v of vendas as any[]) ids.add(v.id);
    for (const c of carrinhos as any[]) ids.add(c.id);

    // A diferença da troca é cobrança à parte, com `saleId = troca:<id>`.
    if (idsPedido.length) {
      const trocas = await (this.prisma as any).orderItemSwap.findMany({
        where: { orderId: { in: idsPedido.slice(0, 60) } },
        select: { id: true },
        take: 100,
      });
      for (const t of trocas as any[]) ids.add(saleIdDaTroca(t.id));
    }
    return Array.from(ids);
  }

  private pdvSaleIdDoPedido(checkoutInfo: string | null | undefined): string | null {
    try {
      const v = JSON.parse(String(checkoutInfo || '{}'))?.pdvSaleId;
      return v ? String(v) : null;
    } catch {
      return null;
    }
  }

  // ── Os dois gateways num formato só ───────────────────────────────────────

  private cruDoPagbank(p: any) {
    return {
      pagamentoId: `pagbank:${p.id}`,
      gateway: 'pagbank' as GatewayEstorno,
      saleId: String(p.saleId || ''),
      chargeId: p.pagbankChargeId ? String(p.pagbankChargeId) : null,
      gatewayOrderId: p.pagbankOrderId ? String(p.pagbankOrderId) : null,
      metodo: String(p.method || ''),
      storeCode: p.storeCode ? String(p.storeCode) : null,
      origemCobranca: p.origem ? String(p.origem) : null,
      valorPagoCents: Math.round(Number(p.valor || 0) * 100),
      pagoEm: p.paidAt ? new Date(p.paidAt) : null,
      status: String(p.status || ''),
    };
  }

  private cruDoPagarme(p: any) {
    return {
      pagamentoId: `pagarme:${p.id}`,
      gateway: 'pagarme' as GatewayEstorno,
      saleId: String(p.saleId || ''),
      chargeId: p.pagarmeChargeId ? String(p.pagarmeChargeId) : null,
      gatewayOrderId: p.pagarmeOrderId ? String(p.pagarmeOrderId) : null,
      metodo: String(p.method || ''),
      storeCode: p.storeCode ? String(p.storeCode) : null,
      origemCobranca: null as string | null,
      valorPagoCents: Math.round(Number(p.valor || 0) * 100),
      pagoEm: p.paidAt ? new Date(p.paidAt) : null,
      status: String(p.status || ''),
    };
  }

  private async pagamentoPorId(pagamentoId: string) {
    const [gw, id] = String(pagamentoId || '').split(':');
    if (!id) throw new BadRequestException('Pagamento não informado.');
    if (gw === 'pagbank') {
      const p = await (this.prisma as any).pagbankPayment.findUnique({ where: { id } });
      if (!p) throw new NotFoundException('Pagamento não encontrado.');
      return this.cruDoPagbank(p);
    }
    if (gw === 'pagarme') {
      const p = await (this.prisma as any).pagarmePayment.findUnique({ where: { id } });
      if (!p) throw new NotFoundException('Pagamento não encontrado.');
      return this.cruDoPagarme(p);
    }
    throw new BadRequestException('Gateway desconhecido.');
  }

  // ── Quem é o dono de cada pagamento ───────────────────────────────────────

  /**
   * O `saleId` aponta pra cinco coisas diferentes, e cada uma sabe um pedaço do
   * que o comprovante precisa (número, cliente, CPF, e-mail). Em lote: a tela
   * mostra dezenas de linhas de uma vez.
   */
  private async resolverDonos(saleIds: string[]): Promise<Map<string, DonoView>> {
    const ids = Array.from(new Set(saleIds.filter(Boolean)));
    const out = new Map<string, DonoView>();
    if (!ids.length) return out;

    const idsTroca = ids.map((s) => swapIdDoSaleId(s)).filter((s): s is string => !!s);
    const [pedidos, vendas, carrinhos, baixas, trocas] = await Promise.all([
      (this.prisma as any).order.findMany({
        where: { id: { in: ids } },
        select: {
          id: true, wcOrderNumber: true, wcOrderId: true, source: true, status: true,
          customerName: true, customerCpf: true, customerEmail: true, totalAmount: true,
        },
      }),
      (this.prisma as any).pdvSale.findMany({
        where: { id: { in: ids } },
        select: {
          id: true, status: true, total: true, entregaTipo: true,
          customerName: true, customerCpf: true, customerEmail: true,
        },
      }),
      (this.prisma as any).livePdvCart.findMany({
        where: { id: { in: ids } },
        select: {
          id: true, status: true, totalCents: true,
          customerName: true, customerCpf: true, customerEmail: true, customerInstagram: true,
        },
      }),
      (this.prisma as any).crediarioBaixa.findMany({
        where: { id: { in: ids } },
        select: { id: true, status: true, totalPago: true, customerName: true },
      }),
      idsTroca.length
        ? (this.prisma as any).orderItemSwap.findMany({
            where: { id: { in: idsTroca } },
            select: {
              id: true, status: true, diffCents: true,
              order: { select: { id: true, wcOrderNumber: true, wcOrderId: true, customerName: true, customerCpf: true, customerEmail: true } },
            },
          })
        : [],
    ]);

    // O pedido ON- que embrulha a venda do PDV, e o LP- do carrinho da live:
    // é o número que a vendedora conhece.
    const idsVenda = (vendas as any[]).map((v) => v.id);
    const idsCarrinho = (carrinhos as any[]).map((c) => c.id);
    const [pedidosOnline, pedidosLive] = await Promise.all([
      idsVenda.length
        ? (this.prisma as any).order.findMany({
            where: { source: 'pdv_online', OR: idsVenda.map((id: string) => ({ checkoutInfo: { contains: `"pdvSaleId":"${id}"` } })) },
            select: { id: true, wcOrderNumber: true, wcOrderId: true, status: true, checkoutInfo: true },
          })
        : [],
      idsCarrinho.length
        ? (this.prisma as any).order.findMany({
            where: { liveCartId: { in: idsCarrinho } },
            select: { id: true, wcOrderNumber: true, wcOrderId: true, status: true, liveCartId: true },
          })
        : [],
    ]);
    const porVenda = new Map<string, any>();
    for (const o of pedidosOnline as any[]) {
      const sid = this.pdvSaleIdDoPedido(o.checkoutInfo);
      if (sid) porVenda.set(sid, o);
    }
    const porCarrinho = new Map<string, any>();
    for (const o of pedidosLive as any[]) porCarrinho.set(String(o.liveCartId), o);

    for (const t of trocas as any[]) {
      const cents = Math.abs(Number(t.diffCents));
      out.set(saleIdDaTroca(t.id), {
        origem: 'site',
        refId: t.order?.id || t.id,
        refNumero: this.numeroDoPedido(t.order),
        refWcOrderId: t.order?.wcOrderId ?? null,
        refStatus: `troca ${String(t.status || '')}`,
        clienteNome: t.order?.customerName || null,
        clienteCpf: t.order?.customerCpf || null,
        clienteEmail: t.order?.customerEmail || null,
        totalCents: Number.isFinite(cents) ? cents : null,
        pdvSaleId: null,
        aviso: 'É a DIFERENÇA de uma troca de peça. Estornar devolve só esse valor — a troca em si continua como está.',
      });
    }
    for (const b of baixas as any[]) {
      out.set(b.id, {
        origem: 'crediario',
        refId: b.id,
        refNumero: null,
        refWcOrderId: null,
        refStatus: b.status || null,
        clienteNome: b.customerName || null,
        clienteCpf: null,
        clienteEmail: null,
        totalCents: Math.round(Number(b.totalPago || 0) * 100),
        pdvSaleId: null,
        aviso: '🚨 É PIX de baixa de crediário. Estornar devolve o dinheiro e NÃO reabre a parcela — a parcela continua paga. Desfazer a baixa é na tela do crediário.',
      });
    }
    for (const c of carrinhos as any[]) {
      const pedido = porCarrinho.get(c.id);
      out.set(c.id, {
        origem: 'live',
        refId: c.id,
        refNumero: this.numeroDoPedido(pedido) || (c.customerInstagram ? `@${String(c.customerInstagram).replace(/^@/, '')}` : null),
        refWcOrderId: pedido?.wcOrderId ?? null,
        refStatus: c.status || null,
        clienteNome: c.customerName || null,
        clienteCpf: c.customerCpf || null,
        clienteEmail: c.customerEmail || null,
        totalCents: Number(c.totalCents) || null,
        pdvSaleId: null,
        aviso: 'Carrinho da live. O estorno devolve o dinheiro; o carrinho e a separação continuam como estão.',
      });
    }
    for (const v of vendas as any[]) {
      const pedido = porVenda.get(v.id);
      // Venda COM entrega é venda online mesmo quando o pedido ON- não nasceu
      // (o cron do link fecha venda com a entrega em branco — caso ON-000105).
      const online = !!pedido || !!String(v.entregaTipo || '').trim();
      out.set(v.id, {
        origem: online ? 'pdv_online' : 'pdv_balcao',
        refId: pedido?.id || v.id,
        refNumero: this.numeroDoPedido(pedido),
        refWcOrderId: pedido?.wcOrderId ?? null,
        refStatus: pedido?.status || v.status || null,
        clienteNome: v.customerName || null,
        clienteCpf: v.customerCpf || null,
        clienteEmail: v.customerEmail || null,
        totalCents: Math.round(Number(v.total || 0) * 100),
        pdvSaleId: v.id,
        aviso: pedido
          ? 'Venda online do PDV. O estorno devolve o dinheiro; a venda, o estoque e a comissão continuam como estão — cancele a venda no PDV se a peça voltou.'
          : 'Venda de BALCÃO. O estorno devolve só o dinheiro: estoque, comissão e NFC-e não mudam. Peça que voltou se resolve pela Devolução do PDV.',
      });
    }
    for (const p of pedidos as any[]) {
      // Pedido do site ganha por último: é o dono mais específico do id.
      out.set(p.id, {
        origem: 'site',
        refId: p.id,
        refNumero: this.numeroDoPedido(p),
        refWcOrderId: p.wcOrderId ?? null,
        refStatus: p.status || null,
        clienteNome: p.customerName || null,
        clienteCpf: p.customerCpf || null,
        clienteEmail: p.customerEmail || null,
        totalCents: Math.round(Number(p.totalAmount || 0) * 100),
        pdvSaleId: null,
        aviso: 'O estorno devolve o dinheiro. O pedido NÃO é cancelado automaticamente — depois do estorno integral a tela oferece cancelar.',
      });
    }
    return out;
  }

  private numeroDoPedido(o: any): string | null {
    if (!o) return null;
    const n = String(o.wcOrderNumber || '').trim();
    if (n) return n;
    return o.wcOrderId ? `#${o.wcOrderId}` : null;
  }

  /** Junta pagamento + dono + o que já foi estornado (pelas NOSSAS linhas). */
  private async montarViews(brutos: any[]): Promise<PagamentoView[]> {
    if (!brutos.length) return [];
    const donos = await this.resolverDonos(brutos.map((b) => b.saleId));
    const chargeIds = brutos.map((b) => b.chargeId).filter(Boolean) as string[];
    const nossos: any[] = chargeIds.length
      ? await (this.prisma as any).estornoPagamento.findMany({
          where: { gatewayChargeId: { in: chargeIds } },
          select: { gatewayChargeId: true, valorCents: true, status: true, estornadoTotalCents: true },
        })
      : [];

    const porCharge = new Map<string, { somaCents: number; maiorTotal: number; emAberto: boolean }>();
    for (const e of nossos) {
      const k = String(e.gatewayChargeId);
      const acc = porCharge.get(k) || { somaCents: 0, maiorTotal: 0, emAberto: false };
      if ((STATUS_QUE_SEGURAM_SALDO as readonly string[]).includes(String(e.status))) {
        acc.somaCents += Number(e.valorCents) || 0;
        acc.maiorTotal = Math.max(acc.maiorTotal, Number(e.estornadoTotalCents) || 0);
      }
      if ((STATUS_EM_ABERTO as readonly string[]).includes(String(e.status))) acc.emAberto = true;
      porCharge.set(k, acc);
    }

    return brutos.map((b) => {
      const dono = donos.get(b.saleId);
      const acc = b.chargeId ? porCharge.get(b.chargeId) : undefined;
      // O maior entre "somei minhas linhas" e "o gateway já disse" — nenhum dos
      // dois sozinho enxerga tudo (estorno pelo painel do PagBank não passa aqui).
      const estornadoCents = Math.max(acc?.somaCents || 0, acc?.maiorTotal || 0);
      const saldoCents = saldoEstornavelCents({ pagoCents: b.valorPagoCents, estornadoCents });
      const elegivel = podeEstornar({ metodo: b.metodo, status: b.status, pagoEm: b.pagoEm, chargeId: b.chargeId });
      return {
        pagamentoId: b.pagamentoId,
        gateway: b.gateway,
        chargeId: b.chargeId,
        gatewayOrderId: b.gatewayOrderId,
        metodo: b.metodo,
        metodoLabel: this.rotuloDoMetodo(b.metodo),
        storeCode: b.storeCode,
        valorPagoCents: b.valorPagoCents,
        pagoEm: b.pagoEm,
        estornadoCents,
        saldoCents,
        pode: elegivel.pode && saldoCents > 0,
        motivoBloqueio: !elegivel.pode
          ? elegivel.motivo
          : saldoCents <= 0
            ? 'Este pagamento já foi estornado por inteiro.'
            : undefined,
        emAndamento: !!acc?.emAberto,
        origem: dono?.origem || 'desconhecido',
        refId: dono?.refId || b.saleId,
        refNumero: dono?.refNumero || null,
        refWcOrderId: dono?.refWcOrderId ?? null,
        refStatus: dono?.refStatus || null,
        clienteNome: dono?.clienteNome || null,
        clienteCpf: dono?.clienteCpf || null,
        clienteEmail: dono?.clienteEmail || null,
        totalCents: dono?.totalCents ?? null,
        pdvSaleId: dono?.pdvSaleId || null,
        aviso: dono?.aviso,
      };
    });
  }

  private rotuloDoMetodo(m: string): string {
    const s = String(m || '').toLowerCase();
    if (s.includes('pix')) return 'PIX';
    if (s.includes('credit') || s.includes('cart')) return 'Cartão de crédito';
    if (s.includes('debit')) return 'Cartão de débito';
    if (s.includes('boleto')) return 'Boleto';
    return m || '—';
  }

  // ── Detalhe (com leitura ao vivo no gateway) ──────────────────────────────

  /**
   * A tela do pagamento. Aqui o saldo vem do GATEWAY — é a única forma de
   * enxergar estorno feito por fora (painel do PagBank) antes de oferecer
   * dinheiro que já não existe.
   */
  async detalhe(pagamentoId: string): Promise<{
    pagamento: PagamentoView;
    gatewayOnline: boolean;
    gatewayErro?: string;
    statusGateway?: string;
    historico: any[];
  }> {
    const bruto = await this.pagamentoPorId(pagamentoId);
    const [view] = await this.montarViews([bruto]);

    let gatewayOnline = false;
    let gatewayErro: string | undefined;
    let statusGateway: string | undefined;
    if (bruto.chargeId) {
      try {
        const atual = await this.lerCobranca(bruto.gateway, bruto.chargeId, bruto.storeCode);
        gatewayOnline = true;
        statusGateway = atual.statusGateway;
        if (atual.estornadoCents !== null && atual.estornadoCents > view.estornadoCents) {
          view.estornadoCents = atual.estornadoCents;
        }
        if (atual.pagoCents && atual.pagoCents > 0) view.valorPagoCents = atual.pagoCents;
        view.saldoCents = saldoEstornavelCents({ pagoCents: view.valorPagoCents, estornadoCents: view.estornadoCents });
        if (view.saldoCents <= 0) {
          view.pode = false;
          view.motivoBloqueio = 'Este pagamento já foi estornado por inteiro (conferido agora no gateway).';
        }
      } catch (e: any) {
        // O gateway não respondeu: a tela DIZ isso em vez de mostrar um saldo
        // que pode estar velho. Estornar continua possível — a checagem final
        // acontece de novo na hora de pedir.
        gatewayErro = this.mensagemDoErro(e);
        this.logger.warn(`[estornos] leitura da cobrança ${bruto.chargeId} falhou: ${gatewayErro}`);
      }
    }

    const historico = await this.historicoDaReferencia(view.refId, bruto.chargeId);
    return { pagamento: view, gatewayOnline, gatewayErro, statusGateway, historico };
  }

  /** Lê a cobrança no gateway e traduz pros nossos centavos. */
  private async lerCobranca(
    gateway: GatewayEstorno,
    chargeId: string,
    storeCode?: string | null,
  ): Promise<{ pagoCents: number | null; estornadoCents: number | null; statusGateway: string; bruto: any }> {
    if (gateway === 'pagbank') {
      const c = await this.pagbank.consultarCobranca(chargeId, storeCode || undefined);
      return {
        pagoCents: this.inteiroOuNull(c?.amount?.summary?.paid) ?? this.inteiroOuNull(c?.amount?.value),
        estornadoCents: this.inteiroOuNull(c?.amount?.summary?.refunded),
        statusGateway: String(c?.status || ''),
        bruto: c,
      };
    }
    const c = await this.pagarme.consultarCobranca(chargeId, storeCode || undefined);
    return {
      pagoCents: this.inteiroOuNull(c?.paid_amount) ?? this.inteiroOuNull(c?.amount),
      estornadoCents: this.inteiroOuNull(c?.canceled_amount),
      statusGateway: String(c?.status || ''),
      bruto: c,
    };
  }

  private inteiroOuNull(v: unknown): number | null {
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n) : null;
  }

  private mensagemDoErro(e: any): string {
    const api = e?.response?.data;
    const detalhe = api?.error_messages?.[0]?.description || api?.message || api?.errors?.[0]?.message;
    return String(detalhe || e?.message || e || 'falha ao falar com o gateway').slice(0, 250);
  }

  /**
   * O bloco da ficha do pedido aceita o `wcOrderId` (o número que a tela do
   * pedido tem na mão) ou o uuid — quem chama não precisa saber qual dos dois
   * o módulo de estornos guardou.
   */
  async historicoDoPedido(ref: string) {
    let refId = String(ref || '').trim();
    if (/^\d+$/.test(refId)) {
      const o = await (this.prisma as any).order.findUnique({
        where: { wcOrderId: Number(refId) },
        select: { id: true },
      });
      if (o?.id) refId = o.id;
    }
    return this.historicoDaReferencia(refId);
  }

  async historicoDaReferencia(refId: string, chargeId?: string | null) {
    const ou: any[] = [{ refId }];
    if (chargeId) ou.push({ gatewayChargeId: chargeId });
    return (this.prisma as any).estornoPagamento.findMany({
      where: { OR: ou },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  // ── Pedir o estorno ───────────────────────────────────────────────────────

  /**
   * A OPERAÇÃO. A senha já foi conferida pelo controller; aqui manda a régua:
   * saldo conferido AO VIVO, nada de estorno em cima de estorno em andamento,
   * e o status copiando o que o gateway respondeu.
   */
  async solicitar(input: {
    pagamentoId: string;
    tipo: TipoEstorno;
    valorCents?: number;
    motivo: string;
    motivoTexto?: string;
    observacao?: string;
    operacaoId?: string;
    ator: AtorEstorno;
    nivel: string;
    autorizadoPorNome?: string | null;
    autorizadoPorCpf?: string | null;
  }) {
    const bruto = await this.pagamentoPorId(input.pagamentoId);
    if (!bruto.chargeId) {
      throw new BadRequestException('Este pagamento não tem cobrança no gateway — não há o que estornar.');
    }
    const motivo = String(input.motivo || '').trim();
    if (!MOTIVOS_ESTORNO.some((m) => m.codigo === motivo)) {
      throw new BadRequestException('Escolha o motivo do estorno.');
    }
    if (motivo === 'outros' && String(input.motivoTexto || '').trim().length < 5) {
      throw new BadRequestException('Motivo "Outros" exige a descrição do que aconteceu.');
    }

    const elegivel = podeEstornar({
      metodo: bruto.metodo,
      status: bruto.status,
      pagoEm: bruto.pagoEm,
      chargeId: bruto.chargeId,
    });
    if (!elegivel.pode) throw new BadRequestException(elegivel.motivo);

    // ── Trava do duplo clique ──
    // A chave da operação vem da tela (um clique = uma chave). Se a mesma
    // chegar de novo — clique duplo, rede lenta, F5 — a linha já existe e o
    // que volta é ELA, sem cobrar o gateway outra vez.
    const idempotencyKey = `est_${String(input.operacaoId || '').trim() || randomUUID()}`.slice(0, 80);
    const jaExiste = await (this.prisma as any).estornoPagamento.findUnique({ where: { idempotencyKey } });
    if (jaExiste) return { estorno: jaExiste, repetida: true };

    const emAndamento = await (this.prisma as any).estornoPagamento.findFirst({
      where: { gatewayChargeId: bruto.chargeId, status: { in: [...STATUS_EM_ABERTO] } },
      orderBy: { createdAt: 'desc' },
    });
    if (emAndamento) {
      throw new BadRequestException(
        `Já existe um estorno em andamento nesta cobrança (${brl(emAndamento.valorCents)}, ${emAndamento.status}). Atualize o status antes de pedir outro.`,
      );
    }

    // ── Saldo AO VIVO ──
    // Nada de confiar no que a tela mandou: entre abrir e clicar pode ter
    // entrado estorno pelo painel do PagBank.
    const atual = await this.lerCobranca(bruto.gateway, bruto.chargeId, bruto.storeCode).catch((e) => {
      throw new BadRequestException(
        `Não deu pra confirmar o saldo no gateway agora (${this.mensagemDoErro(e)}). Tente de novo em instantes — estorno não sai no escuro.`,
      );
    });
    const pagoCents = atual.pagoCents && atual.pagoCents > 0 ? atual.pagoCents : bruto.valorPagoCents;
    const jaEstornadoCents = Math.max(0, atual.estornadoCents || 0);
    const saldoCents = saldoEstornavelCents({ pagoCents, estornadoCents: jaEstornadoCents });
    const valido = validarValorEstorno({ valorCents: Number(input.valorCents) || 0, saldoCents, tipo: input.tipo });
    if (!valido.ok) throw new BadRequestException(valido.erro);

    const donos = await this.resolverDonos([bruto.saleId]);
    const dono = donos.get(bruto.saleId);

    const estorno = await (this.prisma as any).estornoPagamento.create({
      data: {
        origem: dono?.origem || 'desconhecido',
        refId: dono?.refId || bruto.saleId,
        refNumero: dono?.refNumero || null,
        pdvSaleId: dono?.pdvSaleId || null,
        clienteNome: dono?.clienteNome || null,
        clienteCpf: dono?.clienteCpf || null,
        clienteEmail: dono?.clienteEmail || null,
        gateway: bruto.gateway,
        metodo: bruto.metodo,
        gatewayOrderId: bruto.gatewayOrderId,
        gatewayChargeId: bruto.chargeId,
        storeCode: bruto.storeCode,
        valorPagoCents: pagoCents,
        jaEstornadoCents,
        valorCents: valido.valorCents,
        tipo: input.tipo,
        motivo,
        motivoTexto: String(input.motivoTexto || '').trim().slice(0, 300) || null,
        observacao: String(input.observacao || '').trim().slice(0, 500) || null,
        status: 'iniciado' as StatusEstorno,
        idempotencyKey,
        usuarioId: input.ator.userId,
        usuarioNome: input.ator.nome,
        nivelAutorizacao: input.nivel,
        autorizadoPorNome: input.autorizadoPorNome || null,
        autorizadoPorCpf: input.autorizadoPorCpf || null,
        ip: input.ator.ip,
        dispositivo: input.ator.dispositivo,
      },
    });
    await this.acesso.registrar({
      tipo: 'solicitado',
      ator: input.ator,
      nivel: input.nivel,
      estornoId: estorno.id,
      refId: estorno.refId,
      refNumero: estorno.refNumero,
      statusPara: 'iniciado',
      detalhe: `${input.tipo} de ${brl(valido.valorCents)} · ${motivo} · cobrança ${bruto.chargeId} (${bruto.gateway})`,
    });

    return { estorno: await this.enviarAoGateway(estorno, input.ator), repetida: false };
  }

  /** Manda a requisição e grava o que voltou — sem inventar nada. */
  private async enviarAoGateway(estorno: any, ator?: AtorEstorno) {
    await this.mudarStatus(estorno, 'enviado', { ator, detalhe: 'requisição enviada ao gateway' });

    const r =
      estorno.gateway === 'pagbank'
        ? await this.pagbank.estornarCobranca({
            chargeId: estorno.gatewayChargeId,
            valorCents: estorno.valorCents,
            idempotencyKey: estorno.idempotencyKey,
            storeCode: estorno.storeCode || undefined,
          })
        : await this.pagarme.estornarCobranca({
            chargeId: estorno.gatewayChargeId,
            valorCents: estorno.valorCents,
            storeCode: estorno.storeCode || undefined,
          });

    if (r.ok) {
      const leitura =
        estorno.gateway === 'pagbank'
          ? lerRespostaPagbank(r.charge, estorno.valorCents, estorno.jaEstornadoCents)
          : lerRespostaPagarme(r.charge, estorno.valorCents, estorno.jaEstornadoCents);
      return this.gravarLeitura(estorno, leitura, r.charge, ator);
    }

    // Resposta ambígua (timeout/5xx) NÃO é erro: o dinheiro pode ter saído.
    if (r.ambigua) {
      const leitura = r.charge
        ? estorno.gateway === 'pagbank'
          ? lerRespostaPagbank(r.charge, estorno.valorCents, estorno.jaEstornadoCents)
          : lerRespostaPagarme(r.charge, estorno.valorCents, estorno.jaEstornadoCents)
        : { status: 'processando' as const, estornadoTotalCents: null, statusGateway: 'sem resposta', mensagem: r.detalhe };
      return this.gravarLeitura(estorno, leitura, r.charge || { erro: r.detalhe }, ator);
    }

    return this.gravarLeitura(
      estorno,
      { status: 'recusado', estornadoTotalCents: null, statusGateway: `http ${r.httpStatus ?? '—'}`, mensagem: r.detalhe },
      { erro: r.detalhe, httpStatus: r.httpStatus },
      ator,
    );
  }

  private async gravarLeitura(estorno: any, leitura: any, resposta: any, ator?: AtorEstorno) {
    const status: StatusEstorno = leitura.status;
    const atualizado = await (this.prisma as any).estornoPagamento.update({
      where: { id: estorno.id },
      data: {
        status,
        statusGateway: String(leitura.statusGateway || '').slice(0, 40) || null,
        mensagemGateway: leitura.mensagem ? String(leitura.mensagem).slice(0, 300) : null,
        estornadoTotalCents: leitura.estornadoTotalCents ?? undefined,
        respostaGateway: this.jsonCurto(resposta),
        processadoEm: status === 'processado' ? new Date() : estorno.processadoEm ?? null,
        consultadoEm: new Date(),
      },
    });
    await this.acesso.registrar({
      tipo: 'status',
      ator,
      estornoId: estorno.id,
      refId: estorno.refId,
      refNumero: estorno.refNumero,
      statusDe: estorno.status,
      statusPara: status,
      detalhe: `${leitura.statusGateway || '—'}${leitura.mensagem ? ` · ${leitura.mensagem}` : ''}`,
    });
    return atualizado;
  }

  private async mudarStatus(estorno: any, status: StatusEstorno, opts: { ator?: AtorEstorno; detalhe?: string } = {}) {
    await (this.prisma as any).estornoPagamento.update({ where: { id: estorno.id }, data: { status } });
    await this.acesso.registrar({
      tipo: 'status',
      ator: opts.ator,
      estornoId: estorno.id,
      refId: estorno.refId,
      refNumero: estorno.refNumero,
      statusDe: estorno.status,
      statusPara: status,
      detalhe: opts.detalhe,
    });
    estorno.status = status;
    return estorno;
  }

  private jsonCurto(v: any): string {
    try {
      return JSON.stringify(v).slice(0, 12000);
    } catch {
      return String(v).slice(0, 2000);
    }
  }

  // ── Consultar de novo (botão "atualizar" e o cron) ─────────────────────────

  /**
   * Relê a cobrança e atualiza o estorno. É o que fecha o "em processamento":
   * o PagBank não avisa a conclusão do estorno por webhook, então quem pergunta
   * somos nós.
   */
  async consultar(estornoId: string, ator?: AtorEstorno) {
    const estorno = await (this.prisma as any).estornoPagamento.findUnique({ where: { id: estornoId } });
    if (!estorno) throw new NotFoundException('Estorno não encontrado.');
    if (!(STATUS_EM_ABERTO as readonly string[]).includes(String(estorno.status))) {
      return estorno;
    }
    try {
      const atual = await this.lerCobranca(estorno.gateway, estorno.gatewayChargeId, estorno.storeCode);
      const leitura =
        estorno.gateway === 'pagbank'
          ? lerRespostaPagbank(atual.bruto, estorno.valorCents, estorno.jaEstornadoCents)
          : lerRespostaPagarme(atual.bruto, estorno.valorCents, estorno.jaEstornadoCents);
      // Consultar NUNCA recusa: a cobrança não guarda "o estorno falhou", ela
      // guarda quanto já voltou. Sem prova de devolução o estorno segue aberto
      // até o prazo — carimbar "recusado" aqui esconderia dinheiro a caminho.
      if (leitura.status === 'recusado') {
        await (this.prisma as any).estornoPagamento.update({
          where: { id: estorno.id },
          data: { consultadoEm: new Date(), statusGateway: String(leitura.statusGateway || '').slice(0, 40) || null },
        });
        return (this.prisma as any).estornoPagamento.findUnique({ where: { id: estorno.id } });
      }
      return this.gravarLeitura(estorno, leitura, atual.bruto, ator);
    } catch (e: any) {
      await (this.prisma as any).estornoPagamento.update({
        where: { id: estorno.id },
        data: { consultadoEm: new Date() },
      });
      this.logger.warn(`[estornos] consulta do estorno ${estornoId} falhou: ${this.mensagemDoErro(e)}`);
      return estorno;
    }
  }

  /** Um por um, os que ainda podem mudar sozinhos (o cron chama). */
  async consultarPendentes(limite = 30): Promise<{ olhados: number; mudaram: number }> {
    const abertos = await (this.prisma as any).estornoPagamento.findMany({
      where: { status: { in: [...STATUS_EM_ABERTO] }, createdAt: { gte: new Date(Date.now() - 30 * 86400_000) } },
      orderBy: { consultadoEm: 'asc' },
      take: limite,
    });
    let mudaram = 0;
    for (const e of abertos as any[]) {
      const depois = await this.consultar(e.id).catch(() => null);
      if (depois && depois.status !== e.status) mudaram++;
    }
    return { olhados: abertos.length, mudaram };
  }

  async porId(id: string) {
    const e = await (this.prisma as any).estornoPagamento.findUnique({ where: { id } });
    if (!e) throw new NotFoundException('Estorno não encontrado.');
    return e;
  }

  // ── Histórico geral ───────────────────────────────────────────────────────

  async historico(f: {
    termo?: string;
    origem?: string;
    metodo?: string;
    status?: string;
    de?: string;
    ate?: string;
    limite?: number;
  }) {
    const where: any = {};
    const faixa = this.faixaDeData(f.de, f.ate);
    if (faixa) where.createdAt = faixa;
    if (f.origem && f.origem !== 'todos') where.origem = f.origem;
    if (f.status && f.status !== 'todos') where.status = f.status;
    if (f.metodo === 'pix') where.metodo = 'pix';
    if (f.metodo === 'credit_card') where.metodo = { not: 'pix' };
    const termo = String(f.termo || '').trim();
    if (termo) {
      const t = { contains: termo, mode: 'insensitive' as const };
      where.OR = [
        { refNumero: t },
        { clienteNome: t },
        { clienteCpf: { contains: termo.replace(/\D/g, '') || termo } },
        { clienteEmail: t },
        { gatewayChargeId: t },
        { gatewayOrderId: t },
        { usuarioNome: t },
      ];
    }
    const limite = Math.min(500, Math.max(1, Number(f.limite) || 100));
    const linhas = await (this.prisma as any).estornoPagamento.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limite,
    });
    return { linhas, resumo: this.resumo(linhas), total: linhas.length };
  }

  /** Os totais que o dono pediu no painel — contados sobre o MESMO recorte. */
  private resumo(linhas: any[]) {
    const conta = (fn: (l: any) => boolean) => linhas.filter(fn);
    const soma = (ls: any[]) => ls.reduce((s, l) => s + (Number(l.valorCents) || 0), 0);
    const valeu = conta((l) => l.status === 'processado' || l.status === 'processando');
    const pix = conta((l) => String(l.metodo || '').includes('pix') && (l.status === 'processado' || l.status === 'processando'));
    const cartao = valeu.filter((l) => !String(l.metodo || '').includes('pix'));
    const pendentes = conta((l) => (STATUS_EM_ABERTO as readonly string[]).includes(String(l.status)));
    const erros = conta((l) => l.status === 'erro' || l.status === 'recusado');
    return {
      quantidade: linhas.length,
      totalCents: soma(valeu),
      pixCents: soma(pix),
      pixQtd: pix.length,
      cartaoCents: soma(cartao),
      cartaoQtd: cartao.length,
      pendentes: pendentes.length,
      pendentesCents: soma(pendentes),
      erros: erros.length,
    };
  }

  /** O log de segurança — insert-only, e nenhuma rota apaga linha daqui. */
  async auditoria(f: { estornoId?: string; tipo?: string; limite?: number }) {
    const where: any = {};
    if (f.estornoId) where.estornoId = f.estornoId;
    if (f.tipo && f.tipo !== 'todos') where.tipo = f.tipo;
    return (this.prisma as any).estornoEvento.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(500, Math.max(1, Number(f.limite) || 200)),
    });
  }
}
