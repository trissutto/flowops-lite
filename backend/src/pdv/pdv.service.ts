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

    const updated = await (this.prisma as any).pdvSaleItem.update({
      where: { id: item.id },
      data: {
        qty: newQty,
        desconto: newDesconto,
        total: bruto - newDesconto,
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
  async setSaleDiscount(input: { saleId: string; desconto: number }) {
    const sale = await (this.prisma as any).pdvSale.findUnique({
      where: { id: input.saleId },
      include: { items: true },
    });
    if (!sale) throw new NotFoundException('Venda não encontrada');
    if (sale.status !== 'open') throw new BadRequestException('Venda já fechada');

    const desconto = Math.max(0, input.desconto || 0);
    // Soma dos itens (com seus descontos individuais já aplicados)
    const subtotalItens = sale.items.reduce((s: number, i: any) => s + (i.total || 0), 0);
    if (desconto > subtotalItens) {
      throw new BadRequestException(
        `Desconto total (R$${desconto.toFixed(2)}) maior que o subtotal dos itens (R$${subtotalItens.toFixed(2)})`,
      );
    }

    return (this.prisma as any).pdvSale.update({
      where: { id: sale.id },
      data: {
        desconto,
        total: subtotalItens - desconto,
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

    if (activePromotion === 'NONE' || !activePromotion) {
      // Zera tudo (apenas resetando o que veio de promo automática)
      for (const it of items as any[]) {
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
      // Zera todos os descontos auto primeiro
      for (const it of items as any[]) {
        const bruto = it.precoUnit * it.qty;
        updates.push({ id: it.id, desconto: 0, total: bruto, tag: null });
      }
      if (totalPecas >= 4) {
        // Acha o item de MENOR preço unitário (não líquido — não tem outra promo aqui)
        const menorPreco = Math.min(...(items as any[]).map((i) => i.precoUnit));
        const menorIdx = (items as any[]).findIndex((i) => i.precoUnit === menorPreco);
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
  private async recalcTotals(saleId: string) {
    const sale = await (this.prisma as any).pdvSale.findUnique({
      where: { id: saleId },
      select: { desconto: true, items: { select: { precoUnit: true, qty: true, desconto: true, total: true } } },
    });
    if (!sale) return;
    const items = sale.items;
    const subtotal = items.reduce((s: number, i: any) => s + (i.precoUnit * i.qty), 0);
    const descontoItens = items.reduce((s: number, i: any) => s + (i.desconto || 0), 0);
    const subtotalLiquido = items.reduce((s: number, i: any) => s + (i.total || 0), 0);
    // Desconto adicional da venda inteira (aplicado por cima)
    // sale.desconto pode incluir tanto soma de itens quanto extra. Pra simplificar:
    // se desconto atual > descontoItens, considera o excedente como desconto da venda
    const extraSaleDiscount = Math.max(0, (sale.desconto || 0) - descontoItens);
    const totalDesconto = descontoItens + extraSaleDiscount;
    const total = Math.max(0, subtotal - totalDesconto);
    await (this.prisma as any).pdvSale.update({
      where: { id: saleId },
      data: { subtotal, desconto: totalDesconto, total },
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
      select: { id: true, status: true },
    });
    if (!sale) throw new NotFoundException('Venda não encontrada');
    if (sale.status !== 'open')
      throw new BadRequestException('Venda já finalizada');

    return (this.prisma as any).pdvSale.update({
      where: { id: sale.id },
      data: {
        customerCpf: input.cpf?.replace(/\D/g, '') || null,
        customerName: input.name?.trim() || null,
        customerEmail: input.email?.trim() || null,
        customerPhone: input.phone?.replace(/\D/g, '') || null,
      },
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

    // MODO LEGADO: cria 1 pagamento único cobrindo o total
    if (input.paymentMethod) {
      // Limpa pagamentos anteriores (por segurança)
      await (this.prisma as any).pdvSalePayment.deleteMany({
        where: { saleId: sale.id },
      });
      await this.addPayment({
        saleId: sale.id,
        method: input.paymentMethod,
        valor: sale.total,
        details: input.paymentDetails,
      });
    }

    // Verifica que pago = total
    const jaPago = await this.sumPaidValue(sale.id);
    if (Math.abs(jaPago - sale.total) > 0.01) {
      throw new BadRequestException(
        `Total pago R$${jaPago.toFixed(2)} ≠ total venda R$${sale.total.toFixed(2)}. ` +
          `Faltam R$${(sale.total - jaPago).toFixed(2)}.`,
      );
    }

    const payments = await (this.prisma as any).pdvSalePayment.findMany({
      where: { saleId: sale.id },
      orderBy: { createdAt: 'asc' },
    });
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
