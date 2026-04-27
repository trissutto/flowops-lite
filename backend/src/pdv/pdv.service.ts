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
          qty,
          precoUnit: info.preco,
          desconto: 0,
          total: info.preco * qty,
        },
      });
    }

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
    await this.recalcTotals(input.saleId);
    return { ok: true };
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
