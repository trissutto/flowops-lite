import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { PdvService } from './pdv.service';
import { ErpService } from '../erp/erp.service';
import { PixService } from './pix.service';
import { NfceService } from './nfce.service';
import { PagarmeService } from '../pagarme/pagarme.service';

/**
 * /pdv — frente de caixa.
 * Acessível por role 'store' (vendedora) e 'admin'.
 */
@UseGuards(JwtAuthGuard)
@Controller('pdv')
export class PdvController {
  constructor(
    private readonly svc: PdvService,
    private readonly erp: ErpService,
    private readonly pix: PixService,
    private readonly nfce: NfceService,
    private readonly pagarme: PagarmeService,
  ) {}

  private requireRole(req: any) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'store')
      throw new ForbiddenException('Apenas admin ou loja');
  }

  /**
   * GET /pdv/product?sku=5358427
   * Busca produto Giga pra pré-visualização (sem adicionar ao carrinho).
   * Útil pra consulta de preço.
   */
  @Get('product')
  product(@Req() req: any, @Query('sku') sku: string) {
    this.requireRole(req);
    if (!sku) throw new BadRequestException('sku obrigatório');
    return this.erp.getPdvProductInfo(sku);
  }

  /**
   * POST /pdv/sales { storeCode }
   * Abre nova venda OPEN.
   */
  @Post('sales')
  createSale(@Req() req: any, @Body() body: { storeCode: string; sellerId?: string; sellerName?: string }) {
    this.requireRole(req);
    return this.svc.createSale({
      storeCode: body?.storeCode,
      vendedorUserId: req?.user?.id || req?.user?.sub,
      vendedorName: req?.user?.name || null,
      sellerId: body?.sellerId,
      sellerName: body?.sellerName,
    });
  }

  /**
   * PATCH /pdv/sales/:id/seller
   * Body: { sellerId: string | null }
   * Atribui ou remove a vendedora (Seller) responsável pela venda.
   */
  @Patch('sales/:id/seller')
  setSeller(@Req() req: any, @Param('id') saleId: string, @Body() body: { sellerId: string | null }) {
    this.requireRole(req);
    return this.svc.setSeller({ saleId, sellerId: body?.sellerId ?? null });
  }

  /**
   * POST /pdv/sales/:id/nfce — emite NFC-e da venda finalizada.
   * Em modo stub (sem certificado A1) retorna XML preview + chave válida.
   */
  @Post('sales/:id/nfce')
  emitNfce(@Req() req: any, @Param('id') id: string) {
    this.requireRole(req);
    return this.nfce.emit(id);
  }

  /**
   * POST /pdv/sales/:id/nfce/cancel { justificativa }
   * Cancela NFC-e autorizada via evento 110111. Janela: 30min após autorização.
   * Justificativa: 15-255 chars (regra SEFAZ).
   */
  @Post('sales/:id/nfce/cancel')
  cancelNfce(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { justificativa: string },
  ) {
    this.requireRole(req);
    if (!body?.justificativa || String(body.justificativa).trim().length < 15) {
      throw new BadRequestException(
        'Justificativa do cancelamento deve ter pelo menos 15 caracteres',
      );
    }
    return this.nfce.cancel(id, body.justificativa);
  }

  /**
   * GET /pdv/nfce/config?storeCode=01 — leitura da config NFC-e da loja.
   */
  @Get('nfce/config')
  async getNfceConfig(@Req() req: any, @Query('storeCode') storeCode: string) {
    this.requireRole(req);
    if (!storeCode) throw new BadRequestException('storeCode obrigatório');
    return this.nfce.getConfig(storeCode);
  }

  /**
   * GET /pdv/nfce/status — status NFC-e de TODAS as lojas (dashboard).
   */
  @Get('nfce/status')
  async listNfceStatus(@Req() req: any) {
    this.requireRole(req);
    return this.nfce.listAllStatus();
  }

  /**
   * POST /pdv/nfce/config — salva config (admin only).
   * Body: { storeCode, ambiente, cnpj, ie, csc..., certPfxB64?, certPfxPass? }
   */
  /**
   * POST /pdv/nfce/test/:storeCode — emite NFC-e fictícia pra testar
   * config + cert + transmissão SEFAZ. Não afeta vendas reais.
   * Admin only.
   */
  @Post('nfce/test/:storeCode')
  testNfce(@Req() req: any, @Param('storeCode') storeCode: string) {
    if (req?.user?.role !== 'admin')
      throw new ForbiddenException('Apenas admin');
    return this.nfce.testEmit(storeCode);
  }

  @Post('nfce/config')
  async setNfceConfig(@Req() req: any, @Body() body: any) {
    if (req?.user?.role !== 'admin') {
      throw new ForbiddenException('Apenas admin pode editar config NFC-e');
    }
    if (!body?.storeCode) throw new BadRequestException('storeCode obrigatório');
    return this.nfce.setConfig(body.storeCode, body);
  }

  /**
   * GET /pdv/stats/today?storeCode=01
   * Vendas finalizadas hoje da loja, total vendido e ticket médio.
   */
  @Get('stats/today')
  statsToday(@Req() req: any, @Query('storeCode') storeCode: string) {
    this.requireRole(req);
    if (!storeCode) throw new BadRequestException('storeCode obrigatório');
    return this.svc.statsToday(storeCode);
  }

  /**
   * GET /pdv/sales?storeCode=01&status=open&limit=20
   */
  @Get('sales')
  listSales(
    @Req() req: any,
    @Query('storeCode') storeCode: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    this.requireRole(req);
    if (!storeCode) throw new BadRequestException('storeCode obrigatório');
    return this.svc.listSales({
      storeCode,
      status,
      limit: limit ? Number(limit) : 20,
    });
  }

  /**
   * GET /pdv/sales/:id
   */
  @Get('sales/:id')
  getSale(@Req() req: any, @Param('id') id: string) {
    this.requireRole(req);
    return this.svc.getSale(id);
  }

  /**
   * POST /pdv/sales/:id/items { skuOrEan, qty? }
   */
  @Post('sales/:id/items')
  addItem(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { skuOrEan: string; qty?: number },
  ) {
    this.requireRole(req);
    return this.svc.addItem({
      saleId: id,
      skuOrEan: body?.skuOrEan,
      qty: body?.qty,
    });
  }

  /**
   * POST /pdv/sales/:id/items/manual { descricao, valor, qty? }
   * Adiciona item MANUAL — usado quando o produto não passa pelo bipe.
   * Vendedora digita descrição + valor livres pra não travar o caixa.
   */
  @Post('sales/:id/items/manual')
  addManualItem(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { descricao: string; valor: number; qty?: number },
  ) {
    this.requireRole(req);
    return this.svc.addManualItem({
      saleId: id,
      descricao: body?.descricao,
      valor: body?.valor,
      qty: body?.qty,
    });
  }

  /**
   * PATCH /pdv/sales/:id/items/:itemId { qty?, desconto? }
   * Atualiza qty e/ou desconto do item.
   */
  @Patch('sales/:id/items/:itemId')
  updateItem(
    @Req() req: any,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() body: { qty?: number; desconto?: number },
  ) {
    this.requireRole(req);
    return this.svc.updateItem({
      saleId: id,
      itemId,
      qty: body?.qty,
      desconto: body?.desconto,
    });
  }

  /**
   * PATCH /pdv/sales/:id/discount { desconto }
   * Aplica desconto na venda inteira (em R$, não percentual).
   */
  @Patch('sales/:id/discount')
  setDiscount(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { desconto: number },
  ) {
    this.requireRole(req);
    return this.svc.setSaleDiscount({ saleId: id, desconto: body?.desconto || 0 });
  }

  /**
   * PATCH /pdv/sales/:id/promotion { promotion }
   * Define campanha promocional ATIVA (exclusiva).
   * Valores: 'YEAR_BASED' | 'FOUR_FOR_THREE' | 'NONE' | null
   */
  @Patch('sales/:id/promotion')
  setPromotion(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { promotion: string | null },
  ) {
    this.requireRole(req);
    return this.svc.setPromotion({ saleId: id, promotion: body?.promotion ?? null });
  }

  /**
   * DELETE /pdv/sales/:id/items/:itemId
   */
  @Delete('sales/:id/items/:itemId')
  removeItem(
    @Req() req: any,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
  ) {
    this.requireRole(req);
    return this.svc.removeItem({ saleId: id, itemId });
  }

  /**
   * PATCH /pdv/sales/:id/customer { cpf, name, email, phone }
   */
  @Patch('sales/:id/customer')
  setCustomer(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { cpf?: string; name?: string; email?: string; phone?: string },
  ) {
    this.requireRole(req);
    return this.svc.setCustomer({ saleId: id, ...body });
  }

  /**
   * POST /pdv/sales/:id/finalize { paymentMethod, paymentDetails? }
   */
  @Post('sales/:id/finalize')
  finalize(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { paymentMethod: string; paymentDetails?: any },
  ) {
    this.requireRole(req);
    return this.svc.finalize({
      saleId: id,
      paymentMethod: body?.paymentMethod,
      paymentDetails: body?.paymentDetails,
      // Passa storeCode do JWT pra reconciliação automática quando a
      // venda foi criada com loja diferente do caixa atual.
      userStoreCode: req?.user?.storeCode,
    });
  }

  /**
   * POST /pdv/sales/:id/payments { method, valor, details? }
   * Adiciona pagamento parcial à venda (split payment).
   */
  @Post('sales/:id/payments')
  addPayment(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { method: string; valor: number; details?: any },
  ) {
    this.requireRole(req);
    return this.svc.addPayment({
      saleId: id,
      method: body?.method,
      valor: body?.valor,
      details: body?.details,
    });
  }

  /**
   * DELETE /pdv/sales/:id/payments/:paymentId
   */
  @Delete('sales/:id/payments/:paymentId')
  removePayment(
    @Req() req: any,
    @Param('id') id: string,
    @Param('paymentId') paymentId: string,
  ) {
    this.requireRole(req);
    return this.svc.removePayment({ saleId: id, paymentId });
  }

  /**
   * POST /pdv/sales/:id/pix-charge
   * Gera BR Code PIX (QR Code com valor cravado) pra pagamento.
   * Não chama API de banco — gera localmente. Cai direto na conta da chave.
   * Vendedora confirma manualmente após ver o pagamento no app do banco.
   */
  /**
   * POST /pdv/sales/:id/pix-charge
   * Gera cobrança PIX dinâmica via Pagar.me (Stone) — usa a integração já
   * configurada em /config/pagarme. Retorna QR Code + BR Code real.
   */
  @Post('sales/:id/pix-charge')
  async pixCharge(@Req() req: any, @Param('id') id: string) {
    this.requireRole(req);
    const sale = await this.svc.getSale(id);
    if (sale.status !== 'open')
      throw new BadRequestException(`Venda já está ${sale.status}`);
    if (sale.total <= 0) throw new BadRequestException('Total da venda deve ser > 0');

    const r = await this.pagarme.createPixCharge({
      saleId: id,
      valor: sale.total,
      storeCode: sale.storeCode,
      customerName: sale.customerName || undefined,
      customerCpf: sale.customerCpf || undefined,
      customerEmail: sale.customerEmail || undefined,
      customerPhone: sale.customerPhone || undefined,
    });

    // Mantém os mesmos nomes de campo que o frontend já espera
    // (qrCodeDataUrl + payload), pra não quebrar o modal.
    return {
      txid: r.pagarmeOrderId,
      valor: r.valor,
      qrCodeDataUrl: r.qrCodeImageUrl,
      payload: r.qrCodeText,
      expiresAt: r.expiresAt,
    };
  }

  /**
   * POST /pdv/sales/:id/cancel { reason? }
   */
  @Post('sales/:id/cancel')
  cancel(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { reason?: string },
  ) {
    this.requireRole(req);
    return this.svc.cancel({ saleId: id, reason: body?.reason });
  }
}
