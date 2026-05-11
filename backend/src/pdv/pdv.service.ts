import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';
import { CashService } from './cash.service';

/**
 * PdvService — frente de caixa (MVP).
 *
 * Fluxo:
 *   1. createSale(storeCode) → abre venda OPEN
 *   2. addItem(saleId, sku/ean) → busca produto Giga + adiciona snapshot
 *   3. updateItemQty / removeItem (se vendedora errou)
 *   4. finalize(saleId, payment) → status=finalized + (futuro) emite NFC-e
 *   5. cancel(saleId) → status=cancelled
 *
 * NFC-e: por enquanto STUB (gera XML preview mas não envia SEFAZ).
 * Pra emitir de verdade, integrar com FocusNFe/WebMania OU implementar
 * cliente SEFAZ direto (Fase 3).
 */
@Injectable()
export class PdvService {
  private readonly logger = new Logger(PdvService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpService,
    private readonly cash: CashService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════
  // VENDA — ciclo de vida
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Cria nova venda OPEN. Vendedora pode ter várias OPEN simultâneas
   * (ex: troca enquanto outra cliente espera).
   */
  async createSale(input: {
    storeCode: string;
    storeId?: string;
    vendedorUserId?: string;
    vendedorName?: string;
    sellerId?: string;
    sellerName?: string;
  }) {
    if (!input.storeCode) throw new BadRequestException('storeCode obrigatório');
    const store = await this.prisma.store.findUnique({
      where: { code: input.storeCode },
      select: { code: true, name: true },
    });
    if (!store) throw new BadRequestException(`Loja ${input.storeCode} não cadastrada`);

    // Vincula a sessão de caixa atual (se houver). Ainda permite criar
    // venda sem caixa aberto (rascunho), mas finalize() vai exigir.
    const cashSession = await this.cash.getCurrentSession(store.code);

    const sale = await (this.prisma as any).pdvSale.create({
      data: {
        storeCode: store.code,
        storeName: store.name,
        cashSessionId: cashSession?.id || null,
        vendedorUserId: input.vendedorUserId || null,
        vendedorName: input.vendedorName || null,
        sellerId: input.sellerId || null,
        sellerName: input.sellerName || null,
        status: 'open',
      },
    });
    return sale;
  }

  /**
   * Atribui ou troca a vendedora (Seller) responsável pela venda.
   * Pode ser feito a qualquer momento ANTES do finalize.
   */
  async setSeller(input: { saleId: string; sellerId: string | null }) {
    const sale = await (this.prisma as any).pdvSale.findUnique({
      where: { id: input.saleId },
      select: { id: true, status: true },
    });
    if (!sale) throw new NotFoundException('Venda não encontrada');
    if (sale.status !== 'open') throw new BadRequestException('Venda já fechada');

    if (!input.sellerId) {
      return (this.prisma as any).pdvSale.update({
        where: { id: input.saleId },
        data: { sellerId: null, sellerName: null },
      });
    }
    const seller = await (this.prisma as any).seller.findUnique({
      where: { id: input.sellerId },
      select: { id: true, name: true, active: true },
    });
    if (!seller) throw new BadRequestException('Vendedora não encontrada');
    if (!seller.active) throw new BadRequestException('Vendedora inativa');
    return (this.prisma as any).pdvSale.update({
      where: { id: input.saleId },
      data: { sellerId: seller.id, sellerName: seller.name },
    });
  }

  /**
   * Lê venda + itens + pagamentos parciais (com totais sempre atualizados).
   */
  async getSale(id: string) {
    const sale = await (this.prisma as any).pdvSale.findUnique({
      where: { id },
      include: {
        items: { orderBy: { createdAt: 'asc' } },
        payments: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!sale) throw new NotFoundException('Venda não encontrada');
    return sale;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SPLIT PAYMENT — múltiplas formas por venda
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Soma o valor já pago (todos os pagamentos parciais).
   */
  private async sumPaidValue(saleId: string): Promise<number> {
    const payments = await (this.prisma as any).pdvSalePayment.findMany({
      where: { saleId },
      select: { valor: true },
    });
    return (payments as any[]).reduce((s, p) => s + (p.valor || 0), 0);
  }

  /**
   * Adiciona um pagamento parcial à venda.
   * Pode ser um único pagamento (R$ 153,10 dinheiro) ou parte de split
   * (R$ 100 dinheiro + R$ 53,10 PIX em 2 chamadas).
   */
  async addPayment(input: {
    saleId: string;
    method: string;
    valor: number;
    details?: any;
  }) {
    if (!input.method) throw new BadRequestException('method obrigatório');
    if (!input.valor || input.valor <= 0) throw new BadRequestException('valor deve ser > 0');

    const sale = await (this.prisma as any).pdvSale.findUnique({
      where: { id: input.saleId },
      select: { id: true, status: true, total: true, customerCpf: true },
    });
    if (!sale) throw new NotFoundException('Venda não encontrada');
    if (sale.status !== 'open') throw new BadRequestException('Venda já fechada');

    // Crediário precisa de cliente
    if (input.method === 'crediario' && !sale.customerCpf) {
      throw new BadRequestException('Crediário exige CPF do cliente');
    }

    // VALE-TROCA: valida o código antes de aceitar como pagamento.
    // Confere existe, não usado, não vencido e tem saldo >= valor.
    if (input.method === 'vale_troca') {
      const code = String(input.details?.creditoCode || '').trim().toUpperCase();
      if (!code) throw new BadRequestException('Código TROCA-XXXXX obrigatório');
      const ret = await (this.prisma as any).pdvReturn.findUnique({
        where: { creditoCode: code },
      });
      if (!ret) throw new BadRequestException(`Vale-troca ${code} não encontrado`);
      if (ret.status === 'used') {
        throw new BadRequestException(
          `Vale-troca ${code} já foi usado em ${ret.creditoUsadoAt ? new Date(ret.creditoUsadoAt).toLocaleString('pt-BR') : 'data desconhecida'}`,
        );
      }
      if (ret.creditoValidade && new Date(ret.creditoValidade).getTime() < Date.now()) {
        throw new BadRequestException(
          `Vale-troca ${code} venceu em ${new Date(ret.creditoValidade).toLocaleDateString('pt-BR')}`,
        );
      }
      const valorVale = Number(ret.valorTotal) || 0;
      if (input.valor > valorVale + 0.01) {
        throw new BadRequestException(
          `Vale-troca ${code} tem saldo R$ ${valorVale.toFixed(2)}, não dá pra cobrir R$ ${input.valor.toFixed(2)}`,
        );
      }
      // Não bloqueia outro vale_troca já adicionado nessa venda — também valida
      // que o mesmo código não tá sendo usado 2x.
      const jaUsouNaVenda = await (this.prisma as any).pdvSalePayment.findFirst({
        where: { saleId: input.saleId, method: 'vale_troca' },
      });
      if (jaUsouNaVenda) {
        try {
          const det = JSON.parse(jaUsouNaVenda.details || '{}');
          if (det.creditoCode === code) {
            throw new BadRequestException(`Vale-troca ${code} já foi adicionado nessa venda`);
          }
        } catch { /* details mal-formado, ignora */ }
      }
    }

    // Não deixa pagar mais que o total
    const jaPago = await this.sumPaidValue(input.saleId);
    const restante = sale.total - jaPago;
    const valor = Math.round(input.valor * 100) / 100;
    if (valor > restante + 0.001) {
      throw new BadRequestException(
        `Valor R$${valor.toFixed(2)} maior que o restante R$${restante.toFixed(2)}`,
      );
    }

    const payment = await (this.prisma as any).pdvSalePayment.create({
      data: {
        saleId: input.saleId,
        method: input.method,
        valor,
        details: input.details ? JSON.stringify(input.details) : null,
      },
    });

    return payment;
  }

  /**
   * AJUSTE DE PAGAMENTO — só admin/supervisor.
   * Permite trocar forma, valor, bandeira de um pagamento (incluindo de venda
   * já FINALIZADA). Toda alteração é auditada em PdvPaymentAudit.
   */
  async updatePayment(input: {
    saleId: string;
    paymentId: string;
    method?: string;
    valor?: number;
    details?: any;
    reason: string;
    changedByUserId?: string;
    changedByUserName?: string;
    changedByRole?: string;
  }) {
    if (!input.reason || input.reason.trim().length < 3) {
      throw new BadRequestException('Razão obrigatória (mínimo 3 caracteres)');
    }
    const payment = await (this.prisma as any).pdvSalePayment.findUnique({
      where: { id: input.paymentId },
    });
    if (!payment || payment.saleId !== input.saleId) {
      throw new NotFoundException('Pagamento não encontrado nessa venda');
    }
    // NÃO bloqueia por status — supervisor pode ajustar venda finalizada.

    const newMethod = input.method ?? payment.method;
    const newValor = input.valor !== undefined
      ? Math.round(input.valor * 100) / 100
      : payment.valor;
    const newDetailsJson = input.details !== undefined
      ? JSON.stringify(input.details)
      : payment.details;

    if (newValor <= 0) {
      throw new BadRequestException('Valor deve ser > 0');
    }

    const sale = await (this.prisma as any).pdvSale.findUnique({
      where: { id: input.saleId },
      select: { total: true },
    });
    if (!sale) throw new NotFoundException('Venda não encontrada');
    const allPayments = await (this.prisma as any).pdvSalePayment.findMany({
      where: { saleId: input.saleId },
    });
    const somaOutros = (allPayments as any[])
      .filter((p) => p.id !== input.paymentId)
      .reduce((s, p) => s + (Number(p.valor) || 0), 0);
    if (somaOutros + newValor > sale.total + 0.01) {
      throw new BadRequestException(
        `Soma dos pagamentos R$${(somaOutros + newValor).toFixed(2)} ultrapassa total R$${sale.total.toFixed(2)}`,
      );
    }

    await (this.prisma as any).pdvPaymentAudit.create({
      data: {
        paymentId: input.paymentId,
        saleId: input.saleId,
        oldMethod: payment.method,
        oldValor: payment.valor,
        oldDetails: payment.details,
        newMethod,
        newValor,
        newDetails: newDetailsJson,
        changedByUserId: input.changedByUserId ?? null,
        changedByUserName: input.changedByUserName ?? null,
        changedByRole: input.changedByRole ?? null,
        reason: input.reason.trim().slice(0, 500),
      },
    });

    const updated = await (this.prisma as any).pdvSalePayment.update({
      where: { id: input.paymentId },
      data: {
        method: newMethod,
        valor: newValor,
        details: newDetailsJson,
      },
    });

    this.logger.warn(
      `[pdv] PAGAMENTO AJUSTADO sale=${input.saleId} payment=${input.paymentId} ` +
      `${payment.method}/${payment.valor} → ${newMethod}/${newValor} ` +
      `por ${input.changedByUserName || input.changedByRole || '?'} · razão: ${input.reason}`,
    );

    return updated;
  }

  async getPaymentAudits(input: { saleId: string; paymentId?: string }) {
    const where: any = { saleId: input.saleId };
    if (input.paymentId) where.paymentId = input.paymentId;
    return (this.prisma as any).pdvPaymentAudit.findMany({
      where,
      orderBy: { changedAt: 'desc' },
    });
  }

  async removePayment(input: { saleId: string; paymentId: string }) {
    const payment = await (this.prisma as any).pdvSalePayment.findUnique({
      where: { id: input.paymentId },
    });
    if (!payment || payment.saleId !== input.saleId) {
      throw new NotFoundException('Pagamento não encontrado nessa venda');
    }
    const sale = await (this.prisma as any).pdvSale.findUnique({
      where: { id: input.saleId },
      select: { status: true },
    });
    if (sale?.status !== 'open') throw new BadRequestException('Venda já fechada');
    await (this.prisma as any).pdvSalePayment.delete({ where: { id: input.paymentId } });
    return { ok: true };
  }

  /**
   * Lista vendas da loja (default últimas 20 do dia).
   */
  async listSales(input: { storeCode: string; status?: string; limit?: number }) {
    const where: any = { storeCode: input.storeCode };
    if (input.status) where.status = input.status;
    return (this.prisma as any).pdvSale.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: input.limit || 20,
      select: {
        id: true,
        storeCode: true,
        status: true,
        total: true,
        paymentMethod: true,
        customerName: true,
        customerCpf: true,
        nfceStatus: true,
        nfceNumber: true,
        createdAt: true,
        finalizedAt: true,
      },
    });
  }

  /**
   * Lista NFC-es emitidas com filtros + agregados.
   * Usado pela tela /minha-loja/pdv/notas.
   */
  async listNfces(input: {
    storeCode?: string;
    startDate?: string;
    endDate?: string;
    status?: string;
    q?: string;
    limit?: number;
  }): Promise<any> {
    const limit = Math.min(500, Math.max(10, input.limit || 100));

    // Default: hoje
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    let dateStart: Date = today;
    let dateEnd: Date = tomorrow;
    if (input.startDate) {
      const [y, m, d] = input.startDate.split('-').map(Number);
      dateStart = new Date(y, m - 1, d, 0, 0, 0, 0);
    }
    if (input.endDate) {
      const [y, m, d] = input.endDate.split('-').map(Number);
      dateEnd = new Date(y, m - 1, d, 23, 59, 59, 999);
    }

    const where: any = {
      nfceStatus: { not: null },
      finalizedAt: { gte: dateStart, lte: dateEnd },
    };
    if (input.storeCode) where.storeCode = input.storeCode;
    if (input.status && input.status !== 'all') {
      where.nfceStatus = input.status;
    }
    if (input.q) {
      const q = String(input.q).trim();
      where.OR = [
        { nfceNumber: { contains: q } },
        { customerCpf: { contains: q } },
        { customerName: { contains: q, mode: 'insensitive' } },
      ];
    }

    const rows = await (this.prisma as any).pdvSale.findMany({
      where,
      orderBy: { nfceAutorizadaEm: 'desc' },
      take: limit,
      select: {
        id: true,
        storeCode: true,
        storeName: true,
        total: true,
        paymentMethod: true,
        customerName: true,
        customerCpf: true,
        nfceStatus: true,
        nfceNumber: true,
        nfceSerie: true,
        nfceChave: true,
        nfceProtocolo: true,
        nfceAutorizadaEm: true,
        nfceCanceladaEm: true,
        nfceCancelamentoMotivo: true,
        finalizedAt: true,
        createdAt: true,
      },
    });

    // Calcula podeCancelar (autorizada + dentro de 30min)
    const now = Date.now();
    const enriched = rows.map((r: any) => {
      const autEm = r.nfceAutorizadaEm ? new Date(r.nfceAutorizadaEm).getTime() : 0;
      const minutosDesde = autEm ? (now - autEm) / 60000 : 999;
      const podeCancelar =
        r.nfceStatus === 'authorized' && !r.nfceCanceladaEm && minutosDesde <= 30;
      return {
        ...r,
        podeCancelar,
        minutosRestantes: podeCancelar ? Math.max(0, Math.floor(30 - minutosDesde)) : 0,
      };
    });

    const summary = {
      totalNotas: enriched.length,
      totalValor: enriched.reduce((s: number, r: any) =>
        s + (r.nfceStatus === 'authorized' ? Number(r.total) : 0), 0),
      autorizadas: enriched.filter((r: any) => r.nfceStatus === 'authorized').length,
      canceladas: enriched.filter((r: any) => r.nfceStatus === 'cancelled' || r.nfceCanceladaEm).length,
      rejeitadas: enriched.filter((r: any) => r.nfceStatus === 'rejected' || r.nfceStatus === 'error').length,
      porLoja: [] as Array<{ storeCode: string; storeName: string | null; count: number; total: number }>,
    };

    const lojaMap = new Map<string, { storeCode: string; storeName: string | null; count: number; total: number }>();
    for (const r of enriched) {
      const key = r.storeCode || '?';
      const cur = lojaMap.get(key) || { storeCode: key, storeName: r.storeName, count: 0, total: 0 };
      cur.count += 1;
      if (r.nfceStatus === 'authorized') cur.total += Number(r.total) || 0;
      lojaMap.set(key, cur);
    }
    summary.porLoja = Array.from(lojaMap.values()).sort((a, b) => b.total - a.total);

    return { rows: enriched, summary };
  }

  /**
   * Estatísticas do dia da loja: vendas finalizadas hoje, total vendido,
   * ticket médio. Usa data local (Brasília).
   */
  async statsToday(storeCode: string): Promise<{
    count: number;
    total: number;
    ticketMedio: number;
  }> {
    if (!storeCode) return { count: 0, total: 0, ticketMedio: 0 };
    // Início do dia em Brasília (UTC-3) → converte pra UTC pra query
    const now = new Date();
    const inicioBrasilia = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      0,
      0,
      0,
    );
    // Ajusta pro timezone local do servidor (Railway = UTC)
    // Brasília hoje 00:00 = UTC hoje 03:00
    const inicioUtc = new Date(inicioBrasilia.getTime() + 3 * 60 * 60 * 1000);

    try {
      const sales = await (this.prisma as any).pdvSale.findMany({
        where: {
          storeCode,
          status: 'finalized',
          finalizedAt: { gte: inicioUtc },
        },
        select: { total: true },
      });
      const count = sales.length;
      const total = sales.reduce(
        (s: number, x: any) => s + Number(x.total || 0),
        0,
      );
      const ticketMedio = count > 0 ? total / count : 0;
      return { count, total, ticketMedio };
    } catch (e: any) {
      this.logger.warn(`[statsToday] falhou: ${e?.message}`);
      return { count: 0, total: 0, ticketMedio: 0 };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ITENS DO CARRINHO
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Adiciona item bipado: busca info no Giga, cria snapshot, recalcula totais.
   *
   * Se já existir o mesmo SKU no carrinho, INCREMENTA qty em vez de duplicar
   * linha (UX melhor pro PDV).
   */
  async addItem(input: { saleId: string; skuOrEan: string; qty?: number }) {
    const sale = await (this.prisma as any).pdvSale.findUnique({
      where: { id: input.saleId },
      select: { id: true, status: true },
    });
    if (!sale) throw new NotFoundException('Venda não encontrada');
    if (sale.status !== 'open')
      throw new BadRequestException(`Venda não está aberta (status=${sale.status})`);

    const info = await this.erp.getPdvProductInfo(input.skuOrEan);
    if (!info) throw new NotFoundException(`Produto "${input.skuOrEan}" não encontrado no Giga`);
    if (info.preco <= 0)
      throw new BadRequestException(`Produto ${info.sku} sem preço cadastrado no Giga`);

    const qty = Math.max(1, Math.min(99, input.qty || 1));

    // Procura item existente do mesmo SKU
    const existing = await (this.prisma as any).pdvSaleItem.findFirst({
      where: { saleId: sale.id, sku: info.sku },
    });

    let item;
    if (existing) {
      const newQty = existing.qty + qty;
      item = await (this.prisma as any).pdvSaleItem.update({
        where: { id: existing.id },
        data: {
          qty: newQty,
          total: info.preco * newQty - (existing.desconto || 0),
        },
      });
    } else {
      item = await (this.prisma as any).pdvSaleItem.create({
        data: {
          saleId: sale.id,
          sku: info.sku,
          ean: info.ean,
          ref: info.ref,
          cor: info.cor,
          tamanho: info.tamanho,
          descricao: info.descricao,
          ncm: info.ncm,
          cfop: info.cfop,
          dataCadastro: info.dataCadastro,
          qty,
          precoUnit: info.preco,
          desconto: 0,
          total: info.preco * qty,
        },
      });
    }

    await this.applyAutoDiscounts(sale.id);
    await this.recalcTotals(sale.id);
    return { ok: true, item };
  }

  /**
   * Adiciona um item MANUAL na venda — descrição livre + valor digitado pela
   * vendedora. Usado quando o produto não passa pelo bipe (cadastro errado,
   * EAN ausente, peça importada sem código, etc). Não toca no Giga e marca
   * o item com promoTag='MANUAL' pra fugir do recálculo automático.
   *
   * Característica:
   *   - SKU gerado: "MANUAL-{epoch}" pra cada item (sempre nova linha, não merge)
   *   - precoUnit = valor digitado · descricao = livre · qty = livre
   *   - Não cai em applyAutoDiscounts (item solto, não tem campanha)
   */
  async addManualItem(input: {
    saleId: string;
    descricao: string;
    valor: number;
    qty?: number;
  }) {
    const sale = await (this.prisma as any).pdvSale.findUnique({
      where: { id: input.saleId },
      select: { id: true, status: true },
    });
    if (!sale) throw new NotFoundException('Venda não encontrada');
    if (sale.status !== 'open')
      throw new BadRequestException(`Venda não está aberta (status=${sale.status})`);

    const descricao = String(input.descricao || '').trim().slice(0, 80);
    if (descricao.length < 2)
      throw new BadRequestException('Descrição obrigatória (mínimo 2 caracteres)');
    const valor = Number(input.valor);
    if (!valor || valor <= 0)
      throw new BadRequestException('Valor deve ser maior que zero');
    const qty = Math.max(1, Math.min(99, Math.floor(input.qty || 1)));
    const sku = `MANUAL-${Date.now()}`;

    const item = await (this.prisma as any).pdvSaleItem.create({
      data: {
        saleId: sale.id,
        sku,
        ean: null,
        ref: 'MANUAL',
        cor: null,
        tamanho: null,
        descricao,
        ncm: null,
        cfop: null,
        dataCadastro: null,
        qty,
        precoUnit: valor,
        desconto: 0,
        total: valor * qty,
        promoTag: 'MANUAL', // tag pra não cair no applyAutoDiscounts
      },
    });

    await this.recalcTotals(sale.id);
    return { ok: true, item };
  }

  async updateItem(input: { saleId: string; itemId: string; qty?: number; desconto?: number }) {
    const item = await (this.prisma as any).pdvSaleItem.findUnique({
      where: { id: input.itemId },
    });
    if (!item || item.saleId !== input.saleId)
      throw new NotFoundException('Item não encontrado nessa venda');

    const newQty = input.qty != null ? Math.max(1, Math.min(99, input.qty)) : item.qty;
    const newDesconto = input.desconto != null ? Math.max(0, input.desconto) : (item.desconto || 0);
    const bruto = item.precoUnit * newQty;
    if (newDesconto > bruto) {
      throw new BadRequestException(`Desconto (${newDesconto.toFixed(2)}) maior que o total do item (${bruto.toFixed(2)})`);
    }

    // Se usuário definiu desconto MANUAL (>0) via PATCH, marca com tag
    // "MANUAL" pra applyAutoDiscounts não sobrescrever depois. Se zerou
    // o desconto, deixa tag null (volta ao automático).
    const isManualDiscount = input.desconto != null && newDesconto > 0;
    const newTag = isManualDiscount
      ? 'MANUAL'
      : input.desconto != null && newDesconto === 0
      ? null
      : item.promoTag;

    const updated = await (this.prisma as any).pdvSaleItem.update({
      where: { id: item.id },
      data: {
        qty: newQty,
        desconto: newDesconto,
        total: bruto - newDesconto,
        promoTag: newTag,
      },
    });
    await this.applyAutoDiscounts(input.saleId);
    await this.recalcTotals(input.saleId);
    return updated;
  }

  /**
   * Aplica desconto na VENDA INTEIRA (additionalDiscount, somado por cima
   * dos descontos individuais dos itens).
   * Salva no campo `desconto` da venda, e o `total` é recalculado.
   */
  /**
   * Aplica desconto EXTRA da venda inteira (independente dos descontos de
   * cada item). Soma com os descontos de item pra formar a economia total.
   *
   * Exemplo: subtotal=100, item1 tem desconto manual de 5, user define
   * setSaleDiscount(10) → economia total = 5+10 = 15, total = 85.
   */
  async setSaleDiscount(input: { saleId: string; desconto: number }) {
    const sale = await (this.prisma as any).pdvSale.findUnique({
      where: { id: input.saleId },
      include: { items: true },
    });
    if (!sale) throw new NotFoundException('Venda não encontrada');
    if (sale.status !== 'open') throw new BadRequestException('Venda já fechada');

    const desconto = Math.max(0, input.desconto || 0);
    // Soma dos itens líquidos (já com descontos individuais aplicados)
    const subtotalLiquido = sale.items.reduce((s: number, i: any) => s + (i.total || 0), 0);
    if (desconto > subtotalLiquido) {
      throw new BadRequestException(
        `Desconto extra (R$${desconto.toFixed(2)}) maior que o subtotal líquido (R$${subtotalLiquido.toFixed(2)})`,
      );
    }

    return (this.prisma as any).pdvSale.update({
      where: { id: sale.id },
      data: {
        desconto,
        total: Math.max(0, subtotalLiquido - desconto),
      },
    });
  }

  async removeItem(input: { saleId: string; itemId: string }) {
    const item = await (this.prisma as any).pdvSaleItem.findUnique({
      where: { id: input.itemId },
    });
    if (!item || item.saleId !== input.saleId)
      throw new NotFoundException('Item não encontrado nessa venda');
    await (this.prisma as any).pdvSaleItem.delete({ where: { id: item.id } });
    await this.applyAutoDiscounts(input.saleId);
    await this.recalcTotals(input.saleId);
    return { ok: true };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ENGINE DE PROMOÇÕES AUTOMÁTICAS
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Aplica APENAS a campanha promocional ATIVA da venda (exclusiva).
   *
   * Campanhas disponíveis (sale.activePromotion):
   *   - 'YEAR_BASED'    → desconto por ano de cadastro do produto
   *                       2023=20%, 2022=30%, ≤2021=50%
   *   - 'FOUR_FOR_THREE' → carrinho com ≥4 peças, a menor sai de graça (1 un)
   *   - null/'NONE'     → SEM promoção (zera todos os descontos auto)
   *
   * As campanhas NÃO são acumulativas — só uma roda por vez.
   * Desconto manual (item ou venda) é separado e não é tocado por aqui.
   *
   * Defensivo: se a coluna `promoTag`/`active_promotion` não existir no DB
   * (db push pendente), tenta sem ela e loga o erro pra debug.
   */
  private async applyAutoDiscounts(saleId: string) {
    const sale = await (this.prisma as any).pdvSale.findUnique({
      where: { id: saleId },
      select: { activePromotion: true },
    });
    const activePromotion = (sale as any)?.activePromotion || 'NONE';

    const items = await (this.prisma as any).pdvSaleItem.findMany({
      where: { saleId },
      orderBy: { createdAt: 'asc' },
    });
    if (!items.length) return;

    // Função pra zerar promo automática de todos itens (preserva desconto manual? não — autodesconto sobrescreve)
    const updates: Array<{ id: string; desconto: number; total: number; tag: string | null }> = [];

    // Helper: item com promoTag='MANUAL' tem desconto fixado pela vendedora.
    // applyAutoDiscounts NUNCA sobrescreve esses — promoção automática só
    // mexe em itens sem manual.
    const isManual = (it: any) => it.promoTag === 'MANUAL';

    if (activePromotion === 'NONE' || !activePromotion) {
      // Zera tudo (apenas resetando o que veio de promo automática)
      for (const it of items as any[]) {
        if (isManual(it)) continue; // preserva manual
        // Se o promoTag começa com "PROMO" ou "4 LEVA", é auto e zera
        const wasAuto = !it.promoTag || /^(PROMO|4 LEVA)/.test(it.promoTag);
        if (wasAuto) {
          const bruto = it.precoUnit * it.qty;
          updates.push({ id: it.id, desconto: 0, total: bruto, tag: null });
        }
      }
    } else if (activePromotion === 'YEAR_BASED') {
      const promoByYear = (data: string | null): { pct: number; tag: string } | null => {
        if (!data) return null;
        const year = parseInt(data.slice(0, 4), 10);
        if (isNaN(year)) return null;
        if (year <= 2021) return { pct: 0.50, tag: `PROMO 50% · ${year}` };
        if (year === 2022) return { pct: 0.30, tag: 'PROMO 30% · 2022' };
        if (year === 2023) return { pct: 0.20, tag: 'PROMO 20% · 2023' };
        return null;
      };
      for (const it of items as any[]) {
        if (isManual(it)) continue; // preserva manual
        const bruto = it.precoUnit * it.qty;
        const promo = promoByYear(it.dataCadastro || null);
        if (promo) {
          const desconto = Math.round(bruto * promo.pct * 100) / 100;
          updates.push({
            id: it.id,
            desconto,
            total: Math.round((bruto - desconto) * 100) / 100,
            tag: promo.tag,
          });
        } else {
          updates.push({
            id: it.id,
            desconto: 0,
            total: bruto,
            tag: it.dataCadastro ? `Sem promo · ${it.dataCadastro.slice(0, 4)}` : 'Sem data cad.',
          });
        }
      }
    } else if (activePromotion === 'FOUR_FOR_THREE') {
      const totalPecas = (items as any[]).reduce((s, i) => s + i.qty, 0);
      // Zera todos os descontos auto primeiro (preserva manuais)
      for (const it of items as any[]) {
        if (isManual(it)) continue;
        const bruto = it.precoUnit * it.qty;
        updates.push({ id: it.id, desconto: 0, total: bruto, tag: null });
      }
      if (totalPecas >= 4) {
        // Acha o item de MENOR preço unitário (ignorando os com desconto MANUAL,
        // que ficam preservados — não pode dar de graça um que já tem desconto fixo)
        const elegiveis = (items as any[]).filter((i) => !isManual(i));
        if (elegiveis.length > 0) {
          const menorPreco = Math.min(...elegiveis.map((i) => i.precoUnit));
          const menorIdx = (items as any[]).findIndex(
            (i) => !isManual(i) && i.precoUnit === menorPreco,
          );
          if (menorIdx >= 0) {
            const it = (items as any[])[menorIdx];
            const bruto = it.precoUnit * it.qty;
            // Desconta 1 unidade
            const desconto = Math.round(it.precoUnit * 100) / 100;
            updates[menorIdx] = {
              id: it.id,
              desconto,
              total: Math.round((bruto - desconto) * 100) / 100,
              tag: '4 LEVA 3 · 1 grátis',
            };
          }
        }
      }
    }

    // Persiste — defensivo contra coluna inexistente
    for (const u of updates) {
      try {
        await (this.prisma as any).pdvSaleItem.update({
          where: { id: u.id },
          data: { desconto: u.desconto, total: u.total, promoTag: u.tag },
        });
      } catch (e: any) {
        // Se promoTag não existe no DB, tenta sem ele
        if (/promoTag|promo_tag|Unknown/i.test(e?.message || '')) {
          this.logger.warn(`[pdv] coluna promo_tag não existe — rodar prisma db push. Salvando sem tag.`);
          try {
            await (this.prisma as any).pdvSaleItem.update({
              where: { id: u.id },
              data: { desconto: u.desconto, total: u.total },
            });
          } catch (e2) {
            this.logger.error(`[pdv] update item ${u.id} falhou: ${(e2 as Error).message}`);
          }
        } else {
          this.logger.error(`[pdv] update item ${u.id} falhou: ${e?.message}`);
        }
      }
    }
  }

  /**
   * Define a campanha promocional ATIVA da venda (exclusiva).
   * Recalcula tudo automaticamente.
   */
  async setPromotion(input: { saleId: string; promotion: string | null }) {
    const allowed = ['YEAR_BASED', 'FOUR_FOR_THREE', 'NONE'];
    const promo = input.promotion && allowed.includes(input.promotion) ? input.promotion : 'NONE';
    const sale = await (this.prisma as any).pdvSale.findUnique({
      where: { id: input.saleId },
    });
    if (!sale) throw new NotFoundException('Venda não encontrada');
    if (sale.status !== 'open') throw new BadRequestException('Venda já fechada');

    try {
      await (this.prisma as any).pdvSale.update({
        where: { id: input.saleId },
        data: { activePromotion: promo === 'NONE' ? null : promo },
      });
    } catch (e: any) {
      // Se coluna não existe, avisa
      if (/activePromotion|active_promotion|Unknown/i.test(e?.message || '')) {
        throw new BadRequestException(
          'Coluna active_promotion não existe no banco — rode `npx prisma db push` no Railway',
        );
      }
      throw e;
    }

    await this.applyAutoDiscounts(input.saleId);
    await this.recalcTotals(input.saleId);
    return this.getSale(input.saleId);
  }

  /**
   * Recalcula totais da venda a partir dos itens.
   * - subtotal = soma bruta dos itens (sem nenhum desconto)
   * - desconto = soma dos descontos individuais dos itens + desconto da venda
   * - total = subtotal - desconto
   *
   * Preserva o desconto manual aplicado na VENDA inteira (campo `desconto`
   * tem dois usos: aqui guarda total geral; setSaleDiscount sobrescreve
   * só com adicional do nível venda).
   *
   * Estratégia simples: total = soma de items.total - extraDescontoVenda
   * (onde extraDescontoVenda é guardado em paymentDetails.saleDiscountExtra).
   * Pra MVP: total = soma items.total. Desconto manual reaplica via setSaleDiscount.
   */
  /**
   * SEMÂNTICA NOVA (corrigida):
   *   sale.desconto = APENAS o desconto EXTRA da venda inteira (não inclui
   *   descontos individuais de cada item). É independente.
   *
   *   subtotal      = soma(precoUnit × qty)              ← bruto da venda
   *   descontoItens = soma(item.desconto)                ← descontos individuais
   *   sale.desconto = extra da venda (definido em setSaleDiscount)
   *   total         = subtotal - descontoItens - sale.desconto
   *
   * Antes a lógica "absorvia" o desconto do item dentro de sale.desconto
   * mantendo o agregado fixo — confuso pra vendedora ("apliquei 10% no item
   * e o total não muda"). Agora os 2 são independentes e somam.
   */
  private async recalcTotals(saleId: string) {
    const sale = await (this.prisma as any).pdvSale.findUnique({
      where: { id: saleId },
      select: { desconto: true, items: { select: { precoUnit: true, qty: true, desconto: true, total: true } } },
    });
    if (!sale) return;
    const items = sale.items;
    const subtotal = items.reduce((s: number, i: any) => s + (i.precoUnit * i.qty), 0);
    const descontoItens = items.reduce((s: number, i: any) => s + (i.desconto || 0), 0);
    const saleExtra = sale.desconto || 0;
    // Garante que extra + descontoItens não excede subtotal (clipa se passar)
    const extraClipado = Math.max(0, Math.min(saleExtra, subtotal - descontoItens));
    const total = Math.max(0, subtotal - descontoItens - extraClipado);
    await (this.prisma as any).pdvSale.update({
      where: { id: saleId },
      // NÃO toca em sale.desconto aqui — só atualiza se foi clipado
      data: extraClipado !== saleExtra
        ? { subtotal, desconto: extraClipado, total }
        : { subtotal, total },
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CLIENTE
  // ═══════════════════════════════════════════════════════════════════════

  async setCustomer(input: {
    saleId: string;
    cpf?: string;
    name?: string;
    email?: string;
    phone?: string;
  }) {
    const sale = await (this.prisma as any).pdvSale.findUnique({
      where: { id: input.saleId },
      select: { id: true, status: true, nfceStatus: true },
    });
    if (!sale) throw new NotFoundException('Venda não encontrada');
    // Permite atualizar customer se:
    //  - Venda em aberto (fluxo normal — antes de finalizar) OU
    //  - Venda finalizada MAS NFC-e ainda não emitida (caso "CPF na nota"
    //    pedido pelo cliente depois do pagamento mas antes da emissão)
    const canUpdate =
      sale.status === 'open' ||
      (sale.status === 'finalized' && !sale.nfceStatus);
    if (!canUpdate) {
      throw new BadRequestException(
        sale.nfceStatus
          ? 'NFC-e já foi emitida — não dá pra alterar dados do cliente'
          : 'Venda já finalizada',
      );
    }

    // Constrói update dinamicamente — só sobrescreve campos enviados.
    // Importante: se vendedora quer só ADICIONAR CPF, não pode zerar nome/email/etc.
    const data: any = {};
    if (input.cpf !== undefined) data.customerCpf = input.cpf?.replace(/\D/g, '') || null;
    if (input.name !== undefined) data.customerName = input.name?.trim() || null;
    if (input.email !== undefined) data.customerEmail = input.email?.trim() || null;
    if (input.phone !== undefined) data.customerPhone = input.phone?.replace(/\D/g, '') || null;

    return (this.prisma as any).pdvSale.update({
      where: { id: sale.id },
      data,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // FINALIZAÇÃO + PAGAMENTO + NFC-e (stub)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Finaliza venda. 2 modos:
   *
   * MODO LEGADO (1 forma só): { paymentMethod, paymentDetails }
   *   → cria 1 pagamento parcial com valor total
   *
   * MODO SPLIT (várias formas): omitir paymentMethod
   *   → usa os pagamentos já adicionados via addPayment()
   *
   * Em ambos, soma(payments) precisa = total da venda.
   */
  async finalize(input: {
    saleId: string;
    paymentMethod?: string;
    paymentDetails?: any;
    /** Loja do usuário logado (vem do JWT) — usada como fallback se o
     *  storeCode da venda divergir do caixa aberto. */
    userStoreCode?: string;
  }) {
    const sale = await this.getSale(input.saleId);
    if (sale.status !== 'open')
      throw new BadRequestException(`Venda já está ${sale.status}`);
    if (!sale.items?.length) throw new BadRequestException('Carrinho vazio');
    if (sale.total <= 0) throw new BadRequestException('Total da venda deve ser > 0');

    // GATE: precisa de caixa aberto na loja pra finalizar.
    // Se a venda foi criada antes do caixa abrir, vincula agora.
    let cashSessionId = sale.cashSessionId;
    if (!cashSessionId) {
      // Tenta primeiro pelo storeCode da venda
      let sess = await this.cash.getCurrentSession(sale.storeCode);

      // Fallback: se não tem caixa pra storeCode da venda mas o usuário
      // tem caixa aberto em OUTRA loja (sua loja vinculada), reconcilia:
      // atualiza o storeCode da venda pra refletir onde a vendedora está
      // operando agora. Isso resolve o caso "venda criada antes do
      // caixa abrir, com storeCode divergente do caixa atual".
      if (!sess && input.userStoreCode && input.userStoreCode !== sale.storeCode) {
        const userSess = await this.cash.getCurrentSession(input.userStoreCode);
        if (userSess) {
          this.logger.warn(
            `[pdv] reconciliando venda ${sale.id}: storeCode ${sale.storeCode} → ${input.userStoreCode} (caixa aberto na loja do usuário)`,
          );
          // Busca a Store pra atualizar storeCode + storeName juntos
          const newStore = await this.prisma.store.findUnique({
            where: { code: input.userStoreCode },
            select: { code: true, name: true },
          });
          await (this.prisma as any).pdvSale.update({
            where: { id: sale.id },
            data: {
              storeCode: input.userStoreCode,
              storeName: newStore?.name || sale.storeName,
            },
          });
          sale.storeCode = input.userStoreCode;
          if (newStore?.name) sale.storeName = newStore.name;
          sess = userSess;
        }
      }

      if (!sess) {
        // Mensagem de erro com diagnóstico — mostra qual storeCode foi consultado
        throw new BadRequestException(
          `Não há caixa aberto na loja ${sale.storeCode}. ` +
            `Abra o caixa antes de finalizar a venda.`,
        );
      }
      cashSessionId = sess.id;
      await (this.prisma as any).pdvSale.update({
        where: { id: sale.id },
        data: { cashSessionId },
      });
    }

    // MODO LEGADO REMOVIDO: antes, se finalize recebesse "paymentMethod" no body,
    // o sistema DELETAVA todos os payments criados via /payments e gravava UM ÚNICO
    // com o método+total da venda. Isso quebrava SPLIT: vendedora fazia R$ 300 dinheiro
    // + R$ 800 cartão crédito, mas se algum trigger enviasse paymentMethod="credito",
    // o sistema deletava o "dinheiro 300" e criava um "credito 1100" — perdia o split.
    // O split agora é a UNICA fonte da verdade (sempre via POST /payments).
    if (input.paymentMethod) {
      this.logger.warn(
        `[pdv] finalize chamado com paymentMethod="${input.paymentMethod}" — IGNORADO. ` +
        `Use POST /payments antes pra registrar formas de pagamento.`,
      );
    }

    // GUARD: precisa ter PELO MENOS 1 forma de pagamento associada.
    // (defesa em profundidade — addPayment já valida, mas garante que ninguém
    // burle chamando finalize direto sem registrar payment.)
    const payments = await (this.prisma as any).pdvSalePayment.findMany({
      where: { saleId: sale.id },
      orderBy: { createdAt: 'asc' },
    });
    if ((payments as any[]).length === 0) {
      throw new BadRequestException(
        'Venda nao pode ser finalizada sem forma de pagamento. ' +
          'Adicione PIX, cartao, dinheiro, crediario ou vale-troca antes.',
      );
    }

    // Verifica que pago = total
    const jaPago = await this.sumPaidValue(sale.id);
    if (Math.abs(jaPago - sale.total) > 0.01) {
      throw new BadRequestException(
        `Total pago R$${jaPago.toFixed(2)} ≠ total venda R$${sale.total.toFixed(2)}. ` +
          `Faltam R$${(sale.total - jaPago).toFixed(2)}.`,
      );
    }
    // 1 pagamento → método dele · N pagamentos → "MULTIPLO"
    const finalMethod =
      (payments as any[]).length === 1
        ? (payments as any[])[0].method
        : 'MULTIPLO';
    const finalDetails =
      (payments as any[]).length === 1
        ? (payments as any[])[0].details
        : JSON.stringify({
            split: (payments as any[]).map((p) => ({
              method: p.method,
              valor: p.valor,
              details: p.details ? JSON.parse(p.details) : null,
            })),
          });

    // Gera STUB do XML NFC-e
    const nfceStub = this.buildNfceStub(sale, finalMethod);

    const updated = await (this.prisma as any).pdvSale.update({
      where: { id: sale.id },
      data: {
        status: 'finalized',
        paymentMethod: finalMethod,
        paymentDetails: finalDetails,
        finalizedAt: new Date(),
        nfceStatus: 'preview',
        nfceXml: nfceStub.xml,
        nfceNumber: nfceStub.numero,
        nfceSerie: nfceStub.serie,
        nfceChave: nfceStub.chave,
      },
    });

    this.logger.log(
      `[pdv] Venda ${sale.id} finalizada: R$${sale.total.toFixed(2)} via ${finalMethod} (${(payments as any[]).length} pagamento(s))`,
    );

    // GRAVAÇÃO NO WINCRED — replica venda na tabela `caixa` do gigasistemas21
    // pra contabilidade/relatórios. Em modo SHADOW por padrão (PDV_ERP_WRITE_ENABLED=false)
    // só LOGA os SQLs sem executar — permite validar antes de ligar real.
    // Erro NÃO bloqueia a venda no flowops (que é a fonte da verdade) — só loga warning.
    try {
      const result = await this.erp.gravarVendaPdv({
        storeCode: sale.storeCode,
        items: (sale.items || []).map((it: any) => ({
          sku: String(it.sku || it.ean || ''),
          qty: Number(it.qty) || 1,
          valorUnit: Number(it.precoUnit) || 0,
          desconto: Number(it.desconto) || 0,
          descricao: String(it.descricao || ''),
          tributo: it.cfop ? String(it.cfop).slice(0, 4) : undefined,
        })),
        // Pagamentos: usa array payments (após split) ou fallback pro paymentMethod legado.
        // Quando método é credito/debito genérico, extrai a bandeira do details
        // (ex: method='credito' + details.bandeira='MASTERCARD' → mapeia como MASTERCARD).
        pagamentos: (payments as any[]).length > 0
          ? (payments as any[]).map((p: any) => {
              let metodo = String(p.method || '');
              const generico = metodo === 'credito' || metodo === 'debito' || metodo === 'cartao';
              if (generico && p.details) {
                try {
                  const det = typeof p.details === 'string' ? JSON.parse(p.details) : p.details;
                  if (det?.bandeira) {
                    metodo = String(det.bandeira); // MASTERCARD, VISA, ELO etc.
                  }
                } catch { /* ignora details inválido */ }
              }
              return { metodo, valor: Number(p.valor) || 0 };
            })
          : [{ metodo: finalMethod, valor: sale.total }],
        clienteCode: 0,
        clienteCpf: sale.customerCpf || undefined,
        nomeCliente: sale.customerName || undefined,
        // Vendedora pra comissão (Seller) tem prioridade. Senão, usa operador
        // (vendedorName = quem digitou). lookup é automático no erp.service.
        vendedorName: sale.sellerName || sale.vendedorName || undefined,
        operadorName: sale.vendedorName || undefined,
        obsPedido: `flowops-${sale.id.slice(0, 8)}`,
      });
      if (!result.ok) {
        this.logger.warn(
          `[pdv→wincred] Venda ${sale.id} NÃO gravada no Wincred (${result.mode}): ${result.error}`,
        );
      } else if (result.mode === 'shadow') {
        this.logger.warn(
          `[pdv→wincred SHADOW] Venda ${sale.id}: ${result.sqlExecuted.length} SQLs gerados (não executados). Set PDV_ERP_WRITE_ENABLED=true pra ativar.`,
        );
      } else {
        this.logger.log(
          `[pdv→wincred REAL] Venda ${sale.id} → caixa NUMERO=${result.numero} (${result.registros?.length} registros)`,
        );
      }
    } catch (e: any) {
      this.logger.warn(
        `[pdv→wincred] Erro ao gravar venda ${sale.id} no Wincred: ${e?.message || e}. Venda no flowops segue OK.`,
      );
    }

    // VALE-TROCA — marca como USED todo pdvReturn cujo creditoCode foi usado
    // como pagamento nessa venda. Idempotente: se já tava 'used', segue.
    try {
      const valeTrocaPayments = (payments as any[]).filter(
        (p: any) => p.method === 'vale_troca',
      );
      for (const p of valeTrocaPayments) {
        let code: string | null = null;
        try {
          const det = typeof p.details === 'string' ? JSON.parse(p.details) : p.details;
          code = String(det?.creditoCode || '').trim().toUpperCase() || null;
        } catch { /* ignora */ }
        if (!code) continue;
        const ret = await (this.prisma as any).pdvReturn.findUnique({
          where: { creditoCode: code },
        });
        if (!ret) {
          this.logger.warn(`[pdv] vale-troca ${code} não achado pra marcar como usado`);
          continue;
        }
        if (ret.status === 'used') continue; // idempotente
        await (this.prisma as any).pdvReturn.update({
          where: { id: ret.id },
          data: {
            status: 'used',
            creditoUsadoEm: sale.id,
            creditoUsadoAt: new Date(),
          },
        });
        this.logger.log(`[pdv] vale-troca ${code} marcado como USED na venda ${sale.id}`);
      }
    } catch (e: any) {
      this.logger.warn(`[pdv] erro ao marcar vale-troca como usado: ${e?.message || e}`);
    }

    return { ok: true, sale: updated, nfcePreview: nfceStub };
  }

  async cancel(input: { saleId: string; reason?: string }) {
    const sale = await (this.prisma as any).pdvSale.findUnique({
      where: { id: input.saleId },
    });
    if (!sale) throw new NotFoundException('Venda não encontrada');
    if (sale.status === 'cancelled')
      throw new BadRequestException('Venda já está cancelada');

    return (this.prisma as any).pdvSale.update({
      where: { id: sale.id },
      data: {
        status: 'cancelled',
        cancelledAt: new Date(),
        cancelReason: input.reason || null,
      },
    });
  }

  /**
   * Stub do XML NFC-e — só pra mostrar na UI o que SERIA enviado pra SEFAZ.
   * Quando integrar SEFAZ real, vira o XML assinado de verdade.
   */
  private buildNfceStub(sale: any, paymentMethod: string) {
    const numero = String(Date.now()).slice(-9);
    const serie = '001';
    // Chave fictícia (44 dígitos) só pra preview
    const chave = `35${new Date().toISOString().slice(2, 7).replace('-', '')}00000000000000550010000000000${numero}`.slice(0, 44);

    const itensXml = sale.items
      .map((it: any, idx: number) => `
    <det nItem="${idx + 1}">
      <prod>
        <cProd>${it.sku}</cProd>
        <cEAN>${it.ean || 'SEM GTIN'}</cEAN>
        <xProd>${this.escapeXml(it.descricao)}</xProd>
        <NCM>${it.ncm || '00000000'}</NCM>
        <CFOP>${it.cfop || '5102'}</CFOP>
        <uCom>UN</uCom>
        <qCom>${it.qty}.00</qCom>
        <vUnCom>${it.precoUnit.toFixed(2)}</vUnCom>
        <vProd>${it.total.toFixed(2)}</vProd>
      </prod>
    </det>`)
      .join('');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<NFe xmlns="http://www.portalfiscal.inf.br/nfe">
  <infNFe Id="NFe${chave}" versao="4.00">
    <ide>
      <cUF>35</cUF>
      <natOp>VENDA AO CONSUMIDOR</natOp>
      <mod>65</mod>
      <serie>${serie}</serie>
      <nNF>${numero}</nNF>
      <dhEmi>${new Date().toISOString()}</dhEmi>
      <tpNF>1</tpNF>
      <tpAmb>2</tpAmb>
    </ide>
    <emit>
      <CNPJ>00000000000000</CNPJ>
      <xNome>LURDS PLUS SIZE - ${this.escapeXml(sale.storeName)}</xNome>
    </emit>
    ${sale.customerCpf ? `<dest><CPF>${sale.customerCpf}</CPF>${sale.customerName ? `<xNome>${this.escapeXml(sale.customerName)}</xNome>` : ''}</dest>` : ''}
    ${itensXml}
    <total>
      <ICMSTot>
        <vProd>${sale.subtotal.toFixed(2)}</vProd>
        <vDesc>${sale.desconto.toFixed(2)}</vDesc>
        <vNF>${sale.total.toFixed(2)}</vNF>
      </ICMSTot>
    </total>
    <pag>
      <detPag>
        <tPag>${this.mapPaymentToTpag(paymentMethod)}</tPag>
        <vPag>${sale.total.toFixed(2)}</vPag>
      </detPag>
    </pag>
  </infNFe>
</NFe>`;
    return { xml, numero, serie, chave };
  }

  private escapeXml(s: string): string {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  private mapPaymentToTpag(method: string): string {
    // Códigos SEFAZ tabela 38
    switch (method) {
      case 'dinheiro': return '01';
      case 'cheque': return '02';
      case 'credito': return '03';
      case 'debito': return '04';
      case 'crediario': return '05';
      case 'pix': return '17';
      case 'vale': return '10';
      default: return '99';
    }
  }
}
