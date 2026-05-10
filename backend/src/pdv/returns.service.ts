import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';
import { CashService } from './cash.service';

/**
 * Devolução / Troca de venda finalizada.
 *
 * 3 modos:
 *   - 'dinheiro' → estorna estoque + sangria automática no caixa
 *   - 'troca'    → estorna estoque + gera vale-troca consumido no mesmo dia
 *                  (cliente já leva nova peça, ajuste vai pra split de pgto)
 *   - 'credito'  → estorna estoque + gera vale-troca com prazo (90d default)
 *                  cliente pode usar em outra venda futura
 *
 * Estoque sempre volta pro Giga via ErpService.increaseStock (mesma loja).
 *
 * Vale-troca tem código único (TROCA-XXXXX) que pode ser bipado no PDV em
 * qualquer venda futura — o ReturnsService.useCredit valida e marca como usado.
 */
@Injectable()
export class ReturnsService {
  private readonly logger = new Logger(ReturnsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpService,
    private readonly cash: CashService,
  ) {}

  // ── Lookup ─────────────────────────────────────────────────────────

  /**
   * Busca venda finalizada pra montar tela de devolução.
   * Aceita id (uuid) OU número do cupom (futuramente).
   */
  async lookupSale(query: string) {
    const cleanQ = String(query || '').trim();
    if (!cleanQ) throw new BadRequestException('Informe o ID/cupom da venda');

    let sale: any = null;

    // Tenta como UUID (id direto)
    if (/^[0-9a-f-]{20,}$/i.test(cleanQ)) {
      sale = await (this.prisma as any).pdvSale.findUnique({
        where: { id: cleanQ },
        include: {
          items: { orderBy: { createdAt: 'asc' } },
          payments: true,
        },
      });
    }

    // Tenta como número de NFC-e
    if (!sale) {
      sale = await (this.prisma as any).pdvSale.findFirst({
        where: { nfceNumber: cleanQ },
        include: {
          items: { orderBy: { createdAt: 'asc' } },
          payments: true,
        },
      });
    }

    if (!sale) throw new NotFoundException('Venda não encontrada');
    if (sale.status !== 'finalized') {
      throw new BadRequestException(`Venda está ${sale.status}, não dá pra devolver`);
    }

    // Já tem devolução? Quanto sobrou pra devolver?
    const previousReturns = await (this.prisma as any).pdvReturn.findMany({
      where: { originalSaleId: sale.id },
      include: { items: true },
    });

    const devolvidoPorItem = new Map<string, number>();
    for (const ret of previousReturns as any[]) {
      for (const it of ret.items) {
        const id = it.originalItemId || it.sku;
        devolvidoPorItem.set(id, (devolvidoPorItem.get(id) || 0) + (it.qty || 0));
      }
    }

    const itemsComSaldo = (sale.items as any[]).map((it: any) => {
      const jaDev = devolvidoPorItem.get(it.id) || 0;
      const disponivel = Math.max(0, (it.qty || 0) - jaDev);
      return {
        id: it.id,
        sku: it.sku,
        ref: it.ref,
        cor: it.cor,
        tamanho: it.tamanho,
        descricao: it.descricao,
        qty: it.qty,
        precoUnit: it.precoUnit,
        desconto: it.desconto,
        total: it.total,
        jaDevolvido: jaDev,
        disponivel,
      };
    });

    return {
      sale: {
        id: sale.id,
        storeCode: sale.storeCode,
        storeName: sale.storeName,
        customerName: sale.customerName,
        customerCpf: sale.customerCpf,
        total: sale.total,
        finalizedAt: sale.finalizedAt,
        nfceNumber: sale.nfceNumber,
      },
      items: itemsComSaldo,
      previousReturns: previousReturns.length,
    };
  }

  /**
   * Busca vendas FINALIZADAS que contém o SKU informado, ordenadas
   * da mais recente pra mais antiga. Permite vendedora bipar a peça
   * de volta sem precisar do cupom da venda original.
   *
   * Retorna até 20 vendas. Se houver MUITAS, vendedora pode digitar
   * o nome do cliente ou o cupom específico no campo busca tradicional.
   *
   * Cada venda já vem com info se o item específico foi totalmente
   * devolvido em devoluções anteriores (pra desabilitar essa venda
   * na UI se já foi devolvida).
   */
  async lookupSalesBySku(sku: string) {
    const cleanSku = String(sku || '').trim();
    if (!cleanSku) throw new BadRequestException('Informe o SKU/REF da peça');

    // Busca vendas finalizadas que tem item com esse SKU/REF/EAN.
    // Janela 90 dias (era 60) — cobre devolução de venda do mês passado +.
    const dataLimite = new Date();
    dataLimite.setDate(dataLimite.getDate() - 90);

    // Filtro abrangente: bate em sku, ref OU ean — exato, contains ou
    // startsWith pra cobrir variações ("5210367" vs "5210367-XL-AZUL")
    const itemFilter: any = {
      OR: [
        { sku: cleanSku },
        { ref: cleanSku },
        { ean: cleanSku },
        { sku: { contains: cleanSku, mode: 'insensitive' } },
        { ref: { contains: cleanSku, mode: 'insensitive' } },
        { ean: { contains: cleanSku, mode: 'insensitive' } },
      ],
    };

    const sales = await (this.prisma as any).pdvSale.findMany({
      where: {
        status: 'finalized',
        finalizedAt: { gte: dataLimite },
        items: { some: itemFilter },
      },
      orderBy: { finalizedAt: 'desc' },
      take: 20,
      include: {
        items: { where: itemFilter },
      },
    });

    if (sales.length === 0) {
      return { sku: cleanSku, sales: [] };
    }

    // Pra cada venda, calcula quanto desse SKU ainda pode ser devolvido
    // (qty original - qty já devolvida em devoluções anteriores)
    const saleIds = sales.map((s: any) => s.id);
    const previousReturns = await (this.prisma as any).pdvReturn.findMany({
      where: { originalSaleId: { in: saleIds } },
      include: { items: true },
    });
    const devolvidoPorItem = new Map<string, number>();
    for (const ret of previousReturns as any[]) {
      for (const it of ret.items) {
        const id = it.originalItemId || it.sku;
        devolvidoPorItem.set(id, (devolvidoPorItem.get(id) || 0) + (it.qty || 0));
      }
    }

    const result = sales.map((s: any) => {
      // Pode ter mais de 1 item matching (ex: vendeu 2 cores diferentes da mesma ref)
      const matchedItems = s.items.map((it: any) => {
        const jaDev = devolvidoPorItem.get(it.id) || 0;
        const disponivel = Math.max(0, (it.qty || 0) - jaDev);
        return {
          id: it.id,
          sku: it.sku,
          ref: it.ref,
          cor: it.cor,
          tamanho: it.tamanho,
          descricao: it.descricao,
          qty: it.qty,
          precoUnit: it.precoUnit,
          total: it.total,
          jaDevolvido: jaDev,
          disponivel,
        };
      });
      return {
        saleId: s.id,
        nfceNumber: s.nfceNumber,
        storeCode: s.storeCode,
        storeName: s.storeName,
        customerName: s.customerName,
        customerCpf: s.customerCpf,
        finalizedAt: s.finalizedAt,
        totalVenda: s.total,
        sellerName: s.sellerName,
        matchedItems,
        // Se TODOS os items matching já foram devolvidos, marca como indisponível
        totalmenteDevolvido: matchedItems.every((it: any) => it.disponivel === 0),
      };
    });

    return { sku: cleanSku, sales: result };
  }

  // ── Criar devolução ─────────────────────────────────────────────────

  /**
   * Gera código único TROCA-XXXXX (8 chars hex).
   */
  private genCreditoCode(): string {
    const hex = Math.random().toString(36).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    return `TROCA-${hex.padEnd(8, '0')}`;
  }

  /**
   * Cria a devolução completa.
   *
   * Steps:
   *  1. Valida quantidade disponível por item
   *  2. Calcula valor total (proporcional ao item original)
   *  3. Estorna estoque Giga (increaseStock) — se falhar, salva error e continua
   *  4. Cria PdvReturn + PdvReturnItem
   *  5. Se modo=dinheiro → cria sangria automática no caixa atual
   *  6. Se modo=credito ou troca → gera código TROCA-XXXXX
   */
  async createReturn(input: {
    originalSaleId: string;
    storeCode: string;
    storeName: string;
    modo: 'dinheiro' | 'troca' | 'credito';
    items: Array<{ originalItemId: string; qty: number }>;
    motivo?: string;
    creditoValidadeDias?: number;
    userId?: string;
    userName?: string;
  }) {
    const { originalSaleId, storeCode, storeName, modo, items, motivo, userId, userName } = input;

    if (!['dinheiro', 'troca', 'credito'].includes(modo)) {
      throw new BadRequestException(`Modo inválido: ${modo}`);
    }
    if (!items?.length) throw new BadRequestException('Selecione ao menos uma peça');

    // Carrega venda original com itens
    const sale = await (this.prisma as any).pdvSale.findUnique({
      where: { id: originalSaleId },
      include: { items: true },
    });
    if (!sale) throw new NotFoundException('Venda original não encontrada');
    if (sale.status !== 'finalized') {
      throw new BadRequestException(`Venda está ${sale.status}, não dá pra devolver`);
    }

    // Mapeia disponibilidade já considerando devoluções anteriores
    const previousReturns = await (this.prisma as any).pdvReturn.findMany({
      where: { originalSaleId },
      include: { items: true },
    });
    const devolvidoPorItem = new Map<string, number>();
    for (const ret of previousReturns as any[]) {
      for (const it of ret.items) {
        const id = it.originalItemId || it.sku;
        devolvidoPorItem.set(id, (devolvidoPorItem.get(id) || 0) + (it.qty || 0));
      }
    }

    // Valida cada item solicitado e calcula valor
    const itemsToCreate: any[] = [];
    let valorTotal = 0;
    for (const reqItem of items) {
      const original = (sale.items as any[]).find((i: any) => i.id === reqItem.originalItemId);
      if (!original) {
        throw new BadRequestException(`Item ${reqItem.originalItemId} não pertence à venda`);
      }
      const jaDev = devolvidoPorItem.get(original.id) || 0;
      const disponivel = (original.qty || 0) - jaDev;
      const qty = Math.max(1, Math.floor(Number(reqItem.qty) || 0));
      if (qty > disponivel) {
        throw new BadRequestException(
          `${original.descricao}: pediu ${qty} mas só tem ${disponivel} disponível pra devolução`,
        );
      }
      // Valor proporcional do item (preço unit já considera desconto rateado)
      const valorUnit = original.qty > 0 ? original.total / original.qty : original.precoUnit;
      const totalItem = valorUnit * qty;
      valorTotal += totalItem;
      itemsToCreate.push({
        originalItemId: original.id,
        sku: original.sku,
        ref: original.ref,
        cor: original.cor,
        tamanho: original.tamanho,
        descricao: original.descricao,
        qty,
        precoUnit: valorUnit,
        total: totalItem,
      });
    }

    valorTotal = Math.round(valorTotal * 100) / 100;

    // Sessão de caixa atual (necessária pra dinheiro → sangria)
    const cashSession = await this.cash.getCurrentSession(storeCode);
    if (modo === 'dinheiro' && !cashSession) {
      throw new BadRequestException(
        'Modo dinheiro exige caixa aberto pra registrar a sangria.',
      );
    }

    // Tenta estornar estoque Giga (não bloqueia se falhar — registra erro)
    const stockAttempts: Array<{ sku: string; ok: boolean; error?: string }> = [];
    try {
      const erpResult = await this.erp.increaseStock(
        itemsToCreate.map((it) => ({
          sku: it.sku,
          qty: it.qty,
          storeCode,
        })),
      );
      if (erpResult.success) {
        for (const it of itemsToCreate) {
          stockAttempts.push({ sku: it.sku, ok: true });
        }
      } else {
        for (const it of itemsToCreate) {
          stockAttempts.push({ sku: it.sku, ok: false, error: erpResult.error || 'falha na baixa' });
        }
      }
    } catch (e: any) {
      for (const it of itemsToCreate) {
        stockAttempts.push({ sku: it.sku, ok: false, error: e?.message || String(e) });
      }
    }

    // Crédito (se modo=troca ou credito)
    let creditoCode: string | null = null;
    let creditoValidade: Date | null = null;
    if (modo === 'troca' || modo === 'credito') {
      creditoCode = this.genCreditoCode();
      const dias = modo === 'troca' ? 1 : Math.max(1, input.creditoValidadeDias || 90);
      creditoValidade = new Date(Date.now() + dias * 86400_000);
    }

    // Persiste tudo
    const ret = await (this.prisma as any).pdvReturn.create({
      data: {
        originalSaleId,
        originalSaleNumber: sale.nfceNumber || null,
        storeCode,
        storeName,
        cashSessionId: cashSession?.id || null,
        modo,
        valorTotal,
        status: 'completed',
        customerCpf: sale.customerCpf || null,
        customerName: sale.customerName || null,
        creditoCode,
        creditoValidade,
        userId: userId || null,
        userName: userName || null,
        motivo: motivo || null,
        items: {
          create: itemsToCreate.map((it, idx) => ({
            originalItemId: it.originalItemId,
            sku: it.sku,
            ref: it.ref,
            cor: it.cor,
            tamanho: it.tamanho,
            descricao: it.descricao,
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

    // Sangria automática se for em dinheiro
    if (modo === 'dinheiro' && cashSession) {
      await this.cash.addMovement({
        storeCode,
        tipo: 'sangria',
        valor: valorTotal,
        motivo: `Devolução venda ${sale.nfceNumber || sale.id.slice(0, 8)} — ${motivo || 'sem motivo'}`,
        userId,
        userName,
      });
    }

    this.logger.log(
      `[devolução] ${ret.id} loja=${storeCode} venda=${originalSaleId.slice(0, 8)} ` +
        `modo=${modo} R$${valorTotal.toFixed(2)} ` +
        (creditoCode ? `código=${creditoCode}` : ''),
    );

    return ret;
  }

  // ── Listagem ────────────────────────────────────────────────────────

  /**
   * Lista devoluções (filtros opcionais por loja/cliente/data).
   */
  async list(input: {
    storeCode?: string;
    customerCpf?: string;
    from?: Date;
    to?: Date;
    limit?: number;
  }) {
    const where: any = {};
    if (input.storeCode) where.storeCode = input.storeCode;
    if (input.customerCpf) where.customerCpf = input.customerCpf;
    if (input.from || input.to) {
      where.createdAt = {};
      if (input.from) where.createdAt.gte = input.from;
      if (input.to) where.createdAt.lte = input.to;
    }
    return (this.prisma as any).pdvReturn.findMany({
      where,
      include: { items: true },
      orderBy: { createdAt: 'desc' },
      take: Math.min(200, Math.max(1, input.limit || 50)),
    });
  }

  // ── Vale-troca ──────────────────────────────────────────────────────

  /**
   * Valida e marca um vale-troca como usado em uma venda.
   * Chamado pelo PDV quando vendedora bipa o código TROCA-XXXXX.
   */
  async useCredit(input: { creditoCode: string; usedInSaleId: string }) {
    const ret = await (this.prisma as any).pdvReturn.findUnique({
      where: { creditoCode: input.creditoCode },
    });
    if (!ret) throw new NotFoundException('Vale-troca não encontrado');
    if (ret.status === 'used') {
      throw new BadRequestException(
        `Vale-troca já foi usado em ${ret.creditoUsadoAt ? new Date(ret.creditoUsadoAt).toLocaleString('pt-BR') : 'data desconhecida'}`,
      );
    }
    if (ret.creditoValidade && new Date(ret.creditoValidade).getTime() < Date.now()) {
      throw new BadRequestException(
        `Vale-troca venceu em ${new Date(ret.creditoValidade).toLocaleDateString('pt-BR')}`,
      );
    }

    return (this.prisma as any).pdvReturn.update({
      where: { id: ret.id },
      data: {
        status: 'used',
        creditoUsadoEm: input.usedInSaleId,
        creditoUsadoAt: new Date(),
      },
    });
  }

  /**
   * Consulta saldo/validade de um vale-troca SEM marcar como usado.
   */
  async checkCredit(creditoCode: string) {
    const ret = await (this.prisma as any).pdvReturn.findUnique({
      where: { creditoCode },
    });
    if (!ret) throw new NotFoundException('Vale-troca não encontrado');
    return {
      code: ret.creditoCode,
      valor: ret.valorTotal,
      status: ret.status,
      validade: ret.creditoValidade,
      vencido: ret.creditoValidade ? new Date(ret.creditoValidade).getTime() < Date.now() : false,
      usado: ret.status === 'used',
      usadoEm: ret.creditoUsadoAt,
      origem: { saleId: ret.originalSaleId, store: ret.storeCode },
    };
  }
}
