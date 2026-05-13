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
    // Janela 90 dias — cobre devolução de venda do mês passado +.
    const dataLimite = new Date();
    dataLimite.setDate(dataLimite.getDate() - 90);

    // VARIANTES: gera todas variacoes do SKU com/sem zeros a esquerda
    // (ex: '5210367', '0005210367', '00000005210367', ...). Sem isso, peca
    // bipada como '5210367' nao bateria em item salvo como '0005210367'.
    // skuVariants foi tornado publico no ErpService pra ser reutilizado aqui.
    const variants = this.erp.skuVariants(cleanSku);

    // Filtro RESTRITIVO: match EXATO contra qualquer variante em sku/ref/ean.
    // `IN` de Prisma usa index — bem mais rapido que startsWith.
    // Mantem startsWith APENAS pra sku/ref (cobrir REF base que tem multiplos
    // SKUs derivados, ex: '5210367' bate em '5210367-XL').
    const useStartsWith = cleanSku.length >= 5;
    const itemFilter: any = {
      OR: [
        { sku: { in: variants } },
        { ref: { in: variants } },
        { ean: { in: variants } },
        ...(useStartsWith ? [
          { sku: { startsWith: cleanSku, mode: 'insensitive' as const } },
          { ref: { startsWith: cleanSku, mode: 'insensitive' as const } },
        ] : []),
      ],
    };

    // 1ª busca: VENDAS FINALIZADAS na janela
    let sales = await (this.prisma as any).pdvSale.findMany({
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

    // 2ª tentativa (fallback): se não achou finalized, tenta vendas RECENTES
    // em qualquer status (open/cancelled). Cobre venda PIX que ainda não
    // confirmou via webhook, ou venda cancelada por engano.
    if (sales.length === 0) {
      const dataRecente = new Date();
      dataRecente.setDate(dataRecente.getDate() - 7);
      const fallback = await (this.prisma as any).pdvSale.findMany({
        where: {
          createdAt: { gte: dataRecente },
          items: { some: itemFilter },
        },
        orderBy: { createdAt: 'desc' },
        take: 5,
        include: {
          items: { where: itemFilter },
        },
      });
      if (fallback.length > 0) {
        this.logger.log(
          `[devolucao/lookup-by-sku] q="${cleanSku}" sem finalized, ` +
          `mas achou ${fallback.length} venda(s) recente(s) status: ` +
          `${fallback.map((f: any) => f.status).join(',')}`,
        );
      }
      sales = fallback;
    }

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
        finalizedAt: s.finalizedAt || s.createdAt, // fallback p/ vendas open
        totalVenda: s.total,
        sellerName: s.sellerName,
        status: s.status, // 'finalized' | 'open' | 'cancelled' — frontend mostra alerta se ≠ finalized
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

    // FLUXO MESMO-DIA (modo='troca'): cria PdvSale nova aberta com customer
    // pre-preenchido + aplica o vale_troca como payment automaticamente.
    // Vendedora vai pro PDV ja com o credito aplicado, so bipa as peças novas
    // e finaliza. Cliente NAO precisa receber codigo nem cupom impresso.
    let directSaleId: string | null = null;
    if (modo === 'troca' && creditoCode) {
      try {
        const store = await this.prisma.store.findUnique({
          where: { code: storeCode },
          select: { code: true, name: true },
        });
        if (store) {
          let cashSessionId: string | null = null;
          try {
            const s = await (this.prisma as any).pdvCashSession.findFirst({
              where: { storeCode: store.code, status: 'open' },
              select: { id: true },
            });
            cashSessionId = s?.id || null;
          } catch { /* segue sem caixa */ }

          const newSale = await (this.prisma as any).pdvSale.create({
            data: {
              storeCode: store.code,
              storeName: store.name,
              cashSessionId,
              vendedorUserId: userId || null,
              vendedorName: userName || null,
              customerCpf: sale.customerCpf || null,
              customerName: sale.customerName || null,
              status: 'open',
            },
          });

          await (this.prisma as any).pdvSalePayment.create({
            data: {
              saleId: newSale.id,
              method: 'vale_troca',
              valor: valorTotal,
              details: JSON.stringify({
                creditoCode,
                fromReturnId: ret.id,
                modo: 'troca-mesmo-dia',
                itemsDevolvidos: itemsToCreate.map((it) => ({
                  sku: it.sku,
                  ref: it.ref,
                  cor: it.cor,
                  tamanho: it.tamanho,
                  descricao: it.descricao,
                  qty: it.qty,
                  valor: it.total,
                })),
              }),
            },
          });

          directSaleId = newSale.id;
          this.logger.log(
            `[devolução/troca-direta] Nova venda ${newSale.id.slice(0, 8)} criada com vale ${creditoCode} R$${valorTotal.toFixed(2)} aplicado`,
          );
        }
      } catch (e: any) {
        this.logger.warn(
          `[devolução/troca-direta] Falha ao criar venda direta: ${e?.message || e}. ` +
          `Vale-troca ${creditoCode} foi gerado normal — vendedora pode aplicar manual no PDV.`,
        );
      }
    }

    return { ...ret, directSaleId };
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

  // ═══════════════════════════════════════════════════════════════════════
  // ADMIN — Diagnostico + retry de estorno de estoque em devolucoes
  //
  // Pra cada PdvReturnItem, stockReturnedAt indica se a peca voltou pro
  // estoque Giga (increaseStock chamado com sucesso). stockError indica
  // erro caso tenha falhado. Estes endpoints listam o status e permitem
  // retry idempotente (so processa os com stockReturnedAt=null).
  // ═══════════════════════════════════════════════════════════════════════

  async getReturnsStockStatus(input: {
    sinceIso?: string;
    untilIso?: string;
    storeCode?: string;
  }): Promise<{
    sinceIso: string;
    untilIso: string;
    storeCode: string | null;
    totalReturns: number;
    totalItems: number;
    itemsOk: number;
    itemsPendentes: number;
    itemsComErro: number;
    pendentes: Array<{
      returnId: string;
      storeCode: string;
      modo: string;
      createdAt: string;
      customerName: string | null;
      itemsPendentes: Array<{ itemId: string; sku: string; descricao: string; qty: number; stockError: string | null }>;
    }>;
  }> {
    const sinceIso = input.sinceIso || new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const untilIso = input.untilIso || new Date().toISOString();
    const since = new Date(sinceIso);
    const until = new Date(untilIso);
    const storeCode = input.storeCode?.trim() || null;

    const where: any = { createdAt: { gte: since, lte: until } };
    if (storeCode) where.storeCode = storeCode;

    const returns = await (this.prisma as any).pdvReturn.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { items: true },
      take: 500,
    });

    let totalItems = 0;
    let itemsOk = 0;
    let itemsPendentes = 0;
    let itemsComErro = 0;
    const pendentes: any[] = [];
    for (const r of returns as any[]) {
      const pendentesDoRet: any[] = [];
      for (const it of (r.items || []) as any[]) {
        totalItems++;
        if (it.stockReturnedAt) {
          itemsOk++;
        } else {
          itemsPendentes++;
          if (it.stockError) itemsComErro++;
          pendentesDoRet.push({
            itemId: it.id,
            sku: it.sku,
            descricao: it.descricao,
            qty: it.qty,
            stockError: it.stockError || null,
          });
        }
      }
      if (pendentesDoRet.length > 0) {
        pendentes.push({
          returnId: r.id,
          storeCode: r.storeCode,
          modo: r.modo,
          createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
          customerName: r.customerName || null,
          itemsPendentes: pendentesDoRet,
        });
      }
    }

    return {
      sinceIso,
      untilIso,
      storeCode,
      totalReturns: (returns as any[]).length,
      totalItems,
      itemsOk,
      itemsPendentes,
      itemsComErro,
      pendentes,
    };
  }

  async retryReturnsStock(input: {
    sinceIso?: string;
    untilIso?: string;
    storeCode?: string;
    dryRun?: boolean;
    limit?: number;
  }): Promise<{
    mode: 'dry-run' | 'executed';
    sinceIso: string;
    untilIso: string;
    totalPendentes: number;
    itemsProcessados: number;
    itemsOk: number;
    itemsFalha: number;
    falhas: Array<{ returnId: string; sku: string; error: string }>;
    finished: boolean;
  }> {
    const sinceIso = input.sinceIso || new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const untilIso = input.untilIso || new Date().toISOString();
    const since = new Date(sinceIso);
    const until = new Date(untilIso);
    const storeCode = input.storeCode?.trim() || null;
    const limit = Math.max(1, Math.min(500, input.limit || 100));
    const dryRun = !!input.dryRun;

    const where: any = {
      createdAt: { gte: since, lte: until },
      stockReturnedAt: null,
    };
    if (storeCode) {
      where.return = { storeCode };
    }

    const totalPendentes = await (this.prisma as any).pdvReturnItem.count({ where });

    const itemsPendentes = await (this.prisma as any).pdvReturnItem.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      take: limit,
      include: { return: { select: { id: true, storeCode: true, modo: true } } },
    });

    let itemsOk = 0;
    let itemsFalha = 0;
    const falhas: Array<{ returnId: string; sku: string; error: string }> = [];

    if (dryRun) {
      return {
        mode: 'dry-run',
        sinceIso,
        untilIso,
        totalPendentes,
        itemsProcessados: (itemsPendentes as any[]).length,
        itemsOk: 0,
        itemsFalha: 0,
        falhas: [],
        finished: (itemsPendentes as any[]).length < limit,
      };
    }

    // Agrupa items pendentes por storeCode pra usar 1 batch increaseStock por loja
    const byStore = new Map<string, Array<{ itemId: string; sku: string; qty: number; returnId: string }>>();
    for (const it of itemsPendentes as any[]) {
      const sc = it.return?.storeCode || '';
      if (!sc || !it.sku) {
        itemsFalha++;
        falhas.push({ returnId: it.return?.id || '', sku: it.sku || '', error: 'sku ou storeCode vazio' });
        continue;
      }
      if (!byStore.has(sc)) byStore.set(sc, []);
      byStore.get(sc)!.push({ itemId: it.id, sku: it.sku, qty: it.qty, returnId: it.return.id });
    }

    for (const [sc, items] of byStore) {
      try {
        const r = await this.erp.increaseStock(
          items.map((i) => ({ sku: i.sku, qty: i.qty, storeCode: sc })),
        );
        if (r.success) {
          // Marca todos os items dessa loja como OK
          const ids = items.map((i) => i.itemId);
          await (this.prisma as any).pdvReturnItem.updateMany({
            where: { id: { in: ids } },
            data: { stockReturnedAt: new Date(), stockError: null },
          });
          itemsOk += items.length;
        } else {
          // Marca todos como erro (com a mesma mensagem do batch)
          const ids = items.map((i) => i.itemId);
          await (this.prisma as any).pdvReturnItem.updateMany({
            where: { id: { in: ids } },
            data: { stockError: r.error || 'falha desconhecida' },
          });
          itemsFalha += items.length;
          for (const i of items) {
            falhas.push({ returnId: i.returnId, sku: i.sku, error: r.error || 'falha' });
          }
        }
      } catch (e: any) {
        const msg = e?.message || String(e);
        const ids = items.map((i) => i.itemId);
        try {
          await (this.prisma as any).pdvReturnItem.updateMany({
            where: { id: { in: ids } },
            data: { stockError: msg },
          });
        } catch { /* segue */ }
        itemsFalha += items.length;
        for (const i of items) falhas.push({ returnId: i.returnId, sku: i.sku, error: msg });
      }
    }

    return {
      mode: 'executed',
      sinceIso,
      untilIso,
      totalPendentes,
      itemsProcessados: (itemsPendentes as any[]).length,
      itemsOk,
      itemsFalha,
      falhas,
      finished: (itemsPendentes as any[]).length < limit,
    };
  }
}
