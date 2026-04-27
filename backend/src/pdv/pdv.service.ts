import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';

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
  }) {
    if (!input.storeCode) throw new BadRequestException('storeCode obrigatório');
    const store = await this.prisma.store.findUnique({
      where: { code: input.storeCode },
      select: { code: true, name: true },
    });
    if (!store) throw new BadRequestException(`Loja ${input.storeCode} não cadastrada`);

    const sale = await (this.prisma as any).pdvSale.create({
      data: {
        storeCode: store.code,
        storeName: store.name,
        vendedorUserId: input.vendedorUserId || null,
        vendedorName: input.vendedorName || null,
        status: 'open',
      },
    });
    return sale;
  }

  /**
   * Lê venda + itens (com totais sempre atualizados).
   */
  async getSale(id: string) {
    const sale = await (this.prisma as any).pdvSale.findUnique({
      where: { id },
      include: { items: { orderBy: { createdAt: 'asc' } } },
    });
    if (!sale) throw new NotFoundException('Venda não encontrada');
    return sale;
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
   * Regras hardcoded pra MVP (depois pode virar config admin):
   *
   *   1. Por ano de cadastro do produto (campo dataCadastro):
   *      - 2023 → 20% off
   *      - 2022 → 30% off
   *      - 2021 ou anterior → 50% off
   *
   *   2. "4 LEVA 3":
   *      - Se carrinho tem >= 4 peças (somando qty), a peça de menor preço
   *        unitário (após desconto por ano) sai de graça (1 unidade)
   *      - Aplicado como desconto extra no item da menor peça
   *
   * O desconto fica salvo em item.desconto + item.promoTag (descritivo).
   * Vendedora vê na tela qual promoção bateu.
   */
  private async applyAutoDiscounts(saleId: string) {
    const items = await (this.prisma as any).pdvSaleItem.findMany({
      where: { saleId },
      orderBy: { createdAt: 'asc' },
    });
    if (!items.length) return;

    // ── PROMO 1: por ano de cadastro ──
    const promoByYear = (data: string | null): { pct: number; tag: string } | null => {
      if (!data) return null;
      const year = parseInt(data.slice(0, 4), 10);
      if (isNaN(year)) return null;
      if (year <= 2021) return { pct: 0.50, tag: `PROMO 50% · ${year}` };
      if (year === 2022) return { pct: 0.30, tag: 'PROMO 30% · 2022' };
      if (year === 2023) return { pct: 0.20, tag: 'PROMO 20% · 2023' };
      return null;
    };

    // Calcula desconto base por item (da promo de ano)
    type Calc = {
      id: string;
      qty: number;
      precoUnit: number;
      promoYearPct: number;
      promoTag: string | null;
      bruto: number;
      descontoYear: number;
      descontoFinal: number; // será modificado se "4 leva 3" bater
      precoLiquidoUnit: number;
    };
    const calcs: Calc[] = (items as any[]).map((it) => {
      const promo = promoByYear(it.dataCadastro || null);
      const bruto = it.precoUnit * it.qty;
      const descontoYear = promo ? bruto * promo.pct : 0;
      const precoLiquidoUnit = it.precoUnit - it.precoUnit * (promo?.pct || 0);
      return {
        id: it.id,
        qty: it.qty,
        precoUnit: it.precoUnit,
        promoYearPct: promo?.pct || 0,
        promoTag: promo?.tag || null,
        bruto,
        descontoYear,
        descontoFinal: descontoYear,
        precoLiquidoUnit,
      };
    });

    // ── PROMO 2: 4 LEVA 3 ──
    // Conta total de PEÇAS (qty), não linhas. Se >= 4, "expande" virtualmente
    // todas as peças individuais e dá grátis a de menor preço líquido unitário.
    const totalPecas = calcs.reduce((s, c) => s + c.qty, 0);
    let promo4leva3Aplicada = false;
    if (totalPecas >= 4) {
      // Acha a peça de MENOR preço líquido unitário
      const menorPreco = Math.min(...calcs.map((c) => c.precoLiquidoUnit));
      const menorIdx = calcs.findIndex((c) => c.precoLiquidoUnit === menorPreco);
      if (menorIdx >= 0) {
        // Adiciona desconto extra = preço líquido de 1 unidade dessa peça
        calcs[menorIdx].descontoFinal += calcs[menorIdx].precoLiquidoUnit;
        const tagAtual = calcs[menorIdx].promoTag;
        calcs[menorIdx].promoTag = tagAtual
          ? `${tagAtual} + 4 LEVA 3 (1 grátis)`
          : '4 LEVA 3 · 1 peça grátis';
        promo4leva3Aplicada = true;
      }
    }

    // Persiste cada item com desconto + tag
    for (const c of calcs) {
      await (this.prisma as any).pdvSaleItem.update({
        where: { id: c.id },
        data: {
          desconto: Math.round(c.descontoFinal * 100) / 100,
          total: Math.round((c.bruto - c.descontoFinal) * 100) / 100,
          promoTag: c.promoTag,
        },
      });
    }

    if (promo4leva3Aplicada) {
      this.logger.log(`[pdv] Sale ${saleId}: 4 LEVA 3 aplicado (${totalPecas} peças)`);
    }
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
   * Finaliza venda: registra pagamento + (futuro) emite NFC-e.
   * Por enquanto gera STUB do XML pra preview, sem enviar SEFAZ.
   */
  async finalize(input: {
    saleId: string;
    paymentMethod: string;
    paymentDetails?: any;
  }) {
    const sale = await this.getSale(input.saleId);
    if (sale.status !== 'open')
      throw new BadRequestException(`Venda já está ${sale.status}`);
    if (!sale.items?.length)
      throw new BadRequestException('Carrinho vazio');
    if (!input.paymentMethod)
      throw new BadRequestException('Método de pagamento obrigatório');
    if (sale.total <= 0)
      throw new BadRequestException('Total da venda deve ser > 0');

    // Crediário precisa de cliente identificado
    if (input.paymentMethod === 'crediario' && !sale.customerCpf) {
      throw new BadRequestException('Crediário exige CPF do cliente');
    }

    // Gera STUB do XML NFC-e (preview — não envia SEFAZ ainda)
    const nfceStub = this.buildNfceStub(sale, input.paymentMethod);

    const updated = await (this.prisma as any).pdvSale.update({
      where: { id: sale.id },
      data: {
        status: 'finalized',
        paymentMethod: input.paymentMethod,
        paymentDetails: input.paymentDetails ? JSON.stringify(input.paymentDetails) : null,
        finalizedAt: new Date(),
        // NFC-e stub
        nfceStatus: 'preview',
        nfceXml: nfceStub.xml,
        nfceNumber: nfceStub.numero,
        nfceSerie: nfceStub.serie,
        nfceChave: nfceStub.chave,
      },
    });

    this.logger.log(
      `[pdv] Venda ${sale.id} finalizada: R$${sale.total.toFixed(2)} via ${input.paymentMethod}`,
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
