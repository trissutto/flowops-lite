import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';
import { WooCommerceService } from '../woocommerce/woocommerce.service';

/**
 * Troca/devolução de pedido feito no SITE (WooCommerce).
 *
 * Cenário de uso real:
 *   Cliente comprou pelo lurds.com.br → recebeu em casa → tamanho errado →
 *   manda de volta → loja física recebe a peça → registra a troca aqui →
 *   estoque entra no Giga DAQUELA loja (a que recebeu fisicamente).
 *
 * Diferente do PDV (que é venda balcão), aqui:
 *   - A venda original NÃO está em PdvSale, está só no WooCommerce
 *   - Estoque já saiu da loja que separou (talvez outra loja)
 *   - A peça pode voltar pra QUALQUER loja física (a mais perto do cliente)
 *
 * Prazo de troca: configurável via SystemSetting `troca.prazoDias`
 * (default 7 dias do recebimento — fallback: 30 dias do envio).
 */
@Injectable()
export class WcReturnsService {
  private readonly logger = new Logger(WcReturnsService.name);

  // Default: 7 dias úteis do envio. Configurável via SystemSetting
  private readonly DEFAULT_PRAZO_DIAS = 7;

  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpService,
    private readonly wc: WooCommerceService,
  ) {}

  // ── Config ──────────────────────────────────────────────────────────

  async getPrazoDias(): Promise<number> {
    try {
      const cfg = await (this.prisma as any).systemSetting.findUnique({
        where: { key: 'troca.prazoDias' },
      });
      const n = parseInt(cfg?.value || '', 10);
      if (Number.isFinite(n) && n > 0) return n;
    } catch {
      // ignore — usa default
    }
    return this.DEFAULT_PRAZO_DIAS;
  }

  async setPrazoDias(dias: number): Promise<number> {
    if (!Number.isFinite(dias) || dias <= 0 || dias > 365) {
      throw new BadRequestException('Prazo inválido (1-365 dias)');
    }
    await (this.prisma as any).systemSetting.upsert({
      where: { key: 'troca.prazoDias' },
      create: { key: 'troca.prazoDias', value: String(dias) },
      update: { value: String(dias) },
    });
    return dias;
  }

  // ── Busca pedidos WC pra troca ──────────────────────────────────────

  /**
   * Busca pedidos do WC por nome do cliente OU número do pedido.
   * Retorna lista enxuta com status, prazo, itens.
   */
  async search(input: { q: string; limit?: number }) {
    const q = String(input.q || '').trim();
    if (!q || q.length < 2) {
      throw new BadRequestException('Busque por nome ou nº do pedido (mínimo 2 caracteres)');
    }

    const prazoDias = await this.getPrazoDias();

    // Estratégia 1: se for só dígitos, tenta como número de pedido (mais rápido)
    const isNumeric = /^\d+$/.test(q);
    let wcOrders: any[] = [];

    if (isNumeric) {
      try {
        const o = await this.wc.getOrder(parseInt(q, 10));
        if (o) wcOrders = [o];
      } catch {
        // não achou por ID — segue pra busca por nome
      }
    }

    // Estratégia 2: busca textual no WC (search aceita nome/email/nº)
    if (wcOrders.length === 0) {
      try {
        const res = await this.wc.listOrders({
          search: q,
          perPage: Math.min(50, Math.max(5, input.limit || 20)),
          status: 'any',
        });
        wcOrders = res.data || [];
      } catch (e: any) {
        this.logger.warn(`WC search falhou pra "${q}": ${e?.message || e}`);
        wcOrders = [];
      }
    }

    // Devoluções já registradas pra esses pedidos (evita duplo crédito)
    const wcOrderIds = wcOrders.map((o) => Number(o.id)).filter(Boolean);
    const previousReturns: any[] = wcOrderIds.length
      ? await (this.prisma as any).wcReturnRequest.findMany({
          where: { wcOrderId: { in: wcOrderIds } },
          include: { items: true },
        })
      : [];
    const returnsByOrder = new Map<number, any[]>();
    for (const r of previousReturns) {
      const list = returnsByOrder.get(r.wcOrderId) || [];
      list.push(r);
      returnsByOrder.set(r.wcOrderId, list);
    }

    return wcOrders.map((o) => this.formatOrder(o, prazoDias, returnsByOrder.get(Number(o.id)) || []));
  }

  /**
   * Detalhe de UM pedido WC pra tela de troca (com itens disponíveis).
   */
  async getOrderForReturn(wcOrderId: number) {
    const o = await this.wc.getOrder(wcOrderId);
    if (!o) throw new NotFoundException(`Pedido WC ${wcOrderId} não encontrado`);

    const prazoDias = await this.getPrazoDias();

    const previousReturns = await (this.prisma as any).wcReturnRequest.findMany({
      where: { wcOrderId },
      include: { items: true },
    });

    return this.formatOrder(o, prazoDias, previousReturns, /*detailed*/ true);
  }

  /**
   * Formata pedido WC pra resposta consistente.
   */
  private formatOrder(
    o: any,
    prazoDias: number,
    previousReturns: any[],
    detailed = false,
  ) {
    // Datas: usamos date_paid OU date_completed pra base do prazo.
    // Fallback: date_created.
    const dataBase =
      o.date_paid_gmt ||
      o.date_completed_gmt ||
      o.date_paid ||
      o.date_completed ||
      o.date_created_gmt ||
      o.date_created;
    const baseDate = dataBase ? new Date(dataBase) : null;
    const hoje = new Date();
    const diasDesde = baseDate
      ? Math.floor((hoje.getTime() - baseDate.getTime()) / 86_400_000)
      : null;
    const dentroDoPrazo =
      diasDesde != null ? diasDesde <= prazoDias : true; // sem data → assume sim

    // Quantidades já devolvidas por SKU
    const devolvidoBySku = new Map<string, number>();
    for (const r of previousReturns as any[]) {
      for (const it of r.items || []) {
        devolvidoBySku.set(it.sku, (devolvidoBySku.get(it.sku) || 0) + (it.qty || 0));
      }
    }

    const items = (o.line_items || []).map((it: any) => {
      const sku = String(it.sku || '').trim();
      const qty = Number(it.quantity) || 1;
      const jaDev = devolvidoBySku.get(sku) || 0;
      const disponivel = Math.max(0, qty - jaDev);
      // total/qty = preço unit (com desconto rateado se houver)
      const total = parseFloat(String(it.total ?? '0')) || 0;
      const precoUnit = qty > 0 ? total / qty : total;
      return {
        sku,
        productName: it.name || sku,
        qty,
        precoUnit: Math.round(precoUnit * 100) / 100,
        total: Math.round(total * 100) / 100,
        jaDevolvido: jaDev,
        disponivel,
      };
    });

    const billing = o.billing || {};
    const shipping = o.shipping || {};

    return {
      wcOrderId: Number(o.id),
      wcOrderNumber: o.number ? String(o.number) : String(o.id),
      status: o.status,
      total: parseFloat(String(o.total ?? '0')) || 0,
      // Datas
      dateCreated: o.date_created_gmt || o.date_created || null,
      datePaid: o.date_paid_gmt || o.date_paid || null,
      dateCompleted: o.date_completed_gmt || o.date_completed || null,
      diasDesde,
      prazoDias,
      dentroDoPrazo,
      diasRestantes:
        diasDesde != null ? Math.max(0, prazoDias - diasDesde) : null,
      // Cliente
      customerName: [billing.first_name, billing.last_name].filter(Boolean).join(' ').trim() || null,
      customerCpf: billing.cpf || null,
      customerEmail: billing.email || null,
      customerPhone: billing.phone || null,
      shippingCity: shipping.city || billing.city || null,
      shippingState: shipping.state || billing.state || null,
      // Itens
      items: detailed ? items : items.slice(0, 5),
      itemCount: items.length,
      // Devoluções anteriores
      previousReturnsCount: previousReturns.length,
      previousReturnsValor: (previousReturns as any[]).reduce(
        (s, r) => s + (Number(r.valorTotal) || 0),
        0,
      ),
    };
  }

  // ── Aceitar troca / devolução ───────────────────────────────────────

  private genCreditoCode(): string {
    const hex = Math.random()
      .toString(36)
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 8);
    return `TROCA-${hex.padEnd(8, '0')}`;
  }

  /**
   * Aceita a troca/devolução: estorna estoque Giga DA LOJA receptora +
   * cria registro WcReturnRequest. Se modo=troca/credito, gera vale.
   */
  async accept(input: {
    wcOrderId: number;
    receivingStoreCode: string;
    modo: 'devolucao' | 'troca' | 'credito';
    items: Array<{ sku: string; qty: number; productName?: string }>;
    motivo?: string;
    obs?: string;
    creditoValidadeDias?: number;
    forceOutOfPrazo?: boolean;  // admin pode aceitar mesmo fora do prazo
    userId?: string;
    userName?: string;
  }) {
    const { wcOrderId, receivingStoreCode, modo, items, motivo, obs, userId, userName } = input;

    if (!['devolucao', 'troca', 'credito'].includes(modo)) {
      throw new BadRequestException(`Modo inválido: ${modo}`);
    }
    if (!items?.length) throw new BadRequestException('Selecione ao menos uma peça');

    // Loja receptora
    const store = await this.prisma.store.findUnique({
      where: { code: receivingStoreCode },
      select: { code: true, name: true } as any,
    });
    if (!store) {
      throw new BadRequestException(`Loja ${receivingStoreCode} não cadastrada`);
    }

    // Carrega pedido WC + valida prazo + saldo disponível
    const detail = await this.getOrderForReturn(wcOrderId);

    if (!detail.dentroDoPrazo && !input.forceOutOfPrazo) {
      throw new BadRequestException(
        `Pedido fora do prazo de troca (${detail.diasDesde} dias desde envio · prazo ${detail.prazoDias}). ` +
          `Pra forçar mesmo assim, marque "Aceitar fora do prazo".`,
      );
    }

    // Mapa de items disponíveis
    const itemBySku = new Map<string, any>();
    for (const it of detail.items) itemBySku.set(it.sku, it);

    // Valida cada item solicitado
    const itemsToCreate: any[] = [];
    let valorTotal = 0;
    for (const reqItem of items) {
      const sku = String(reqItem.sku || '').trim();
      if (!sku) throw new BadRequestException('Item sem SKU');
      const original = itemBySku.get(sku);
      if (!original) {
        throw new BadRequestException(`SKU ${sku} não está no pedido ${wcOrderId}`);
      }
      const qty = Math.max(1, Math.floor(Number(reqItem.qty) || 0));
      if (qty > original.disponivel) {
        throw new BadRequestException(
          `${original.productName} (${sku}): pediu ${qty} mas só tem ${original.disponivel} disponível pra devolução.`,
        );
      }
      const totalItem = original.precoUnit * qty;
      valorTotal += totalItem;
      itemsToCreate.push({
        sku,
        productName: reqItem.productName || original.productName,
        qty,
        precoUnit: original.precoUnit,
        total: Math.round(totalItem * 100) / 100,
      });
    }
    valorTotal = Math.round(valorTotal * 100) / 100;

    // Estorna estoque Giga na loja receptora
    const stockAttempts: Array<{ sku: string; ok: boolean; error?: string }> = [];
    try {
      const result = await this.erp.increaseStock(
        itemsToCreate.map((it) => ({
          sku: it.sku,
          qty: it.qty,
          storeCode: receivingStoreCode,
        })),
      );
      if (result.success) {
        for (const it of itemsToCreate) stockAttempts.push({ sku: it.sku, ok: true });
      } else {
        for (const it of itemsToCreate)
          stockAttempts.push({ sku: it.sku, ok: false, error: result.error });
      }
    } catch (e: any) {
      for (const it of itemsToCreate)
        stockAttempts.push({ sku: it.sku, ok: false, error: e?.message || String(e) });
    }

    // Crédito (se troca/credito)
    let creditoCode: string | null = null;
    let creditoValidade: Date | null = null;
    if (modo === 'troca' || modo === 'credito') {
      creditoCode = this.genCreditoCode();
      const dias = modo === 'troca' ? 1 : Math.max(1, input.creditoValidadeDias || 90);
      creditoValidade = new Date(Date.now() + dias * 86400_000);
    }

    // Persiste
    const ret = await (this.prisma as any).wcReturnRequest.create({
      data: {
        wcOrderId,
        wcOrderNumber: detail.wcOrderNumber || String(wcOrderId),
        customerName: detail.customerName,
        customerCpf: detail.customerCpf,
        customerEmail: detail.customerEmail,
        receivingStoreCode: (store as any).code,
        receivingStoreName: (store as any).name,
        modo,
        valorTotal,
        status: 'completed',
        diasDesdeEnvio: detail.diasDesde ?? null,
        dentroDoPrazo: detail.dentroDoPrazo,
        creditoCode,
        creditoValidade,
        userId: userId || null,
        userName: userName || null,
        motivo: motivo || null,
        obs: obs || null,
        items: {
          create: itemsToCreate.map((it, idx) => ({
            sku: it.sku,
            productName: it.productName,
            qty: it.qty,
            precoUnit: it.precoUnit,
            total: it.total,
            stockReturnedAt: stockAttempts[idx]?.ok ? new Date() : null,
            stockError: stockAttempts[idx]?.ok ? null : stockAttempts[idx]?.error || null,
          })),
        },
      },
      include: { items: true },
    });

    this.logger.log(
      `[wc-return] ${ret.id.slice(0, 8)} pedido=${wcOrderId} loja=${receivingStoreCode} ` +
        `modo=${modo} R$${valorTotal.toFixed(2)} ` +
        (creditoCode ? `código=${creditoCode}` : ''),
    );

    return ret;
  }

  // ── Listagem ────────────────────────────────────────────────────────

  async list(input: {
    storeCode?: string;
    customerCpf?: string;
    from?: Date;
    to?: Date;
    limit?: number;
  }) {
    const where: any = {};
    if (input.storeCode) where.receivingStoreCode = input.storeCode;
    if (input.customerCpf) where.customerCpf = input.customerCpf;
    if (input.from || input.to) {
      where.createdAt = {};
      if (input.from) where.createdAt.gte = input.from;
      if (input.to) where.createdAt.lte = input.to;
    }
    return (this.prisma as any).wcReturnRequest.findMany({
      where,
      include: { items: true },
      orderBy: { createdAt: 'desc' },
      take: Math.min(200, Math.max(1, input.limit || 50)),
    });
  }
}
