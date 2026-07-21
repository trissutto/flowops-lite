import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Logger,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { validateMinLevel } from '../auth/auth-levels.util';
import { isValidTrainingPassword, isTrainingRequest } from './training.util';
import { PdvService } from './pdv.service';
import { ErpOutboxService } from './erp-outbox.service';
import { ErpService } from '../erp/erp.service';
import { WincredCatalogService } from '../wincred-mirror/wincred-catalog.service';
import { PixService } from './pix.service';
import { NfceService } from './nfce.service';
import { PagarmeService } from '../pagarme/pagarme.service';
import { CrediariosService } from '../crediarios/crediarios.service';
import { CrediarioBaixaService } from '../crediarios/crediario-baixa.service';
import { CrediarioPrintService } from './crediario-print.service';
import { WooCommerceService } from '../woocommerce/woocommerce.service';
import { ReturnsService } from './returns.service';

/**
 * /pdv — frente de caixa.
 * Acessível por role 'store' (vendedora) e 'admin'.
 */
@UseGuards(JwtAuthGuard)
@Controller('pdv')
export class PdvController {
  private readonly logger = new Logger(PdvController.name);

  constructor(
    private readonly svc: PdvService,
    private readonly outbox: ErpOutboxService,
    private readonly erp: ErpService,
    private readonly catalog: WincredCatalogService,
    private readonly pix: PixService,
    private readonly nfce: NfceService,
    private readonly pagarme: PagarmeService,
    private readonly crediarios: CrediariosService,
    private readonly crediarioBaixa: CrediarioBaixaService,
    private readonly crediarioPrint: CrediarioPrintService,
    private readonly woo: WooCommerceService,
    private readonly returns: ReturnsService,
  ) {}

  private requireRole(req: any) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'store')
      throw new ForbiddenException('Apenas admin ou loja');
  }

  /** Papéis de franquia (editam ações de venda, escopados às lojas FILIAL). */
  private ehPapelFranquia(role: string | undefined): boolean {
    return role === 'master_franquia' || role === 'franquias';
  }

  /** Papel de franquia só age em venda de loja FRANQUIA (tipo=FILIAL). */
  private async assertSaleEhFranquia(saleId: string) {
    const prisma = (this.svc as any).prisma;
    const sale = await prisma.pdvSale.findUnique({
      where: { id: saleId },
      select: { storeCode: true },
    });
    const franquia = await prisma.store.findMany({
      where: { tipo: 'FILIAL', active: true },
      select: { code: true },
    });
    const codes = new Set((franquia as any[]).map((s) => s.code));
    if (!sale?.storeCode || !codes.has(sale.storeCode)) {
      throw new ForbiddenException(`Venda de loja ${sale?.storeCode || '?'} não é franquia — acesso negado`);
    }
  }

  // ── CACHE DE DESCOBERTA GIGA ─────────────────────────────────────────────
  // FLAG PDV_GIGA_CACHE (default: false):
  //   false → comportamento atual: delega direto pro crediarios.detectClientesTable()
  //   true  → cacheia o mapa tabela/colunas de clientes em memória por 1h,
  //           evitando redescoberta (SHOW COLUMNS etc) a cada customer-info/
  //           customer-search. Resultado null (Giga fora) NÃO é cacheado.
  private readonly gigaDiscoveryCache = new Map<string, { value: any; expiresAt: number }>();
  private static readonly GIGA_DISCOVERY_TTL_MS = 60 * 60 * 1000; // 1h

  private async detectClientesTableCached(): Promise<any> {
    const enabled =
      String(process.env.PDV_GIGA_CACHE ?? '').trim().toLowerCase() === 'true';
    if (!enabled) return this.crediarios.detectClientesTable();

    const key = 'clientesMap';
    const hit = this.gigaDiscoveryCache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value;

    const value = await this.crediarios.detectClientesTable();
    if (value) {
      this.gigaDiscoveryCache.set(key, {
        value,
        expiresAt: Date.now() + PdvController.GIGA_DISCOVERY_TTL_MS,
      });
    }
    return value;
  }

  /**
   * GET /pdv/product-image?sku=XXX
   * Retorna URL da foto do produto no WooCommerce (cache 1h em memória).
   * Usado pela tabela do carrinho do PDV pra mostrar miniatura ao lado do item.
   */
  @Get('product-image')
  async getProductImage(@Req() req: any, @Query('sku') sku: string) {
    this.requireRole(req);
    if (!sku) return { url: null };
    const url = await this.woo.getProductImageBySku(String(sku).trim());
    return { url };
  }

  /**
   * POST /pdv/training/validate
   * Valida senha de treinamento. Frontend chama uma vez no clique do botão
   * "🎓 Modo Treinamento" — se ok, salva flag no sessionStorage e passa a
   * mandar header `x-training-mode: 1` em todas as requests subsequentes.
   * Senha vem do env TREINAMENTO_PASSWORD.
   */
  @Post('training/validate')
  validateTraining(@Body() body: { password: string }) {
    const ok = isValidTrainingPassword(body?.password || '');
    if (!ok) throw new ForbiddenException('Senha de treinamento inválida');
    return { ok: true, mode: 'training' };
  }

  /**
   * GET /pdv/product?sku=5358427
   * Busca produto pra pré-visualização (sem adicionar ao carrinho).
   * Lê do ESPELHO Postgres com fallback pro Giga ao vivo.
   */
  @Get('product')
  product(@Req() req: any, @Query('sku') sku: string) {
    this.requireRole(req);
    if (!sku) throw new BadRequestException('sku obrigatório');
    return this.catalog.getPdvProductInfo(sku);
  }

  /**
   * GET /pdv/erp-outbox — status da fila de sync ERP (admin).
   * Mostra contagens por status, job pendente mais antigo e últimas falhas.
   */
  @Get('erp-outbox')
  erpOutboxStatus(@Req() req: any) {
    const role = req?.user?.role;
    if (role !== 'admin') throw new ForbiddenException('Apenas admin');
    return this.outbox.status();
  }

  /**
   * POST /pdv/erp-outbox/retry — re-enfileira jobs 'failed' (admin).
   */
  @Post('erp-outbox/retry')
  erpOutboxRetry(@Req() req: any) {
    const role = req?.user?.role;
    if (role !== 'admin') throw new ForbiddenException('Apenas admin');
    return this.outbox.retryFailed();
  }

  /**
   * POST /pdv/sales { storeCode }
   * Abre nova venda OPEN.
   */
  @Post('sales')
  createSale(@Req() req: any, @Body() body: { storeCode: string; sellerId?: string; sellerName?: string }) {
    this.requireRole(req);
    // SEGURANÇA CRÍTICA: pra user role=store, IGNORA o storeCode do body e
    // FORÇA o storeCode do JWT. Senão um localStorage stale no PC da loja
    // X pode fazer vendedora abrir venda como loja Y por engano (e gravar
    // NFC-e no CNPJ errado, sumiço de estoque, etc).
    const userRole = req?.user?.role;
    const userStoreCode = req?.user?.storeCode;
    const effectiveStoreCode = userRole === 'store' && userStoreCode
      ? userStoreCode
      : body?.storeCode;
    return this.svc.createSale({
      storeCode: effectiveStoreCode,
      vendedorUserId: req?.user?.id || req?.user?.sub,
      vendedorName: req?.user?.name || null,
      sellerId: body?.sellerId,
      sellerName: body?.sellerName,
      isTraining: isTrainingRequest(req),
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
   * GET /pdv/nfces — lista NFC-es com filtros + agregados.
   * Query: storeCode (opcional, vazio = todas as lojas / visão geral),
   *        startDate, endDate (YYYY-MM-DD, default: hoje),
   *        status (authorized|cancelled|rejected|all),
   *        q (busca: número, CPF, nome),
   *        limit (default 100, max 500)
   */
  @Get('nfces')
  async listNfces(
    @Req() req: any,
    @Query('storeCode') storeCode?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('status') status?: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
  ) {
    // READ-ONLY: admin/store (requireRole) + 'franquias'/'master_franquia'.
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'store' && role !== 'franquias' && role !== 'master_franquia') {
      throw new ForbiddenException('Apenas admin, loja ou administrador de franquias');
    }

    // ESCOPO POR PAPEL:
    //  - store      → SÓ a própria loja (ignora storeCode da query).
    //  - franquias/master_franquia → SÓ as lojas FILIAL (franqueadas).
    //  - admin/master → todas (ou filtra pelo storeCode escolhido).
    const userStoreCode = req?.user?.storeCode;
    let effectiveStoreCode = role === 'store' && userStoreCode ? userStoreCode : storeCode;
    let storeCodes: string[] | undefined;
    if (role === 'franquias' || role === 'master_franquia') {
      const franq = await (this.svc as any).prisma.store.findMany({
        where: { tipo: 'FILIAL', active: true },
        select: { code: true },
      });
      storeCodes = (franq as any[]).map((s) => s.code);
      effectiveStoreCode = undefined; // o conjunto de franquias prevalece
    }

    return this.svc.listNfces({
      storeCode: effectiveStoreCode,
      storeCodes,
      startDate,
      endDate,
      status,
      q,
      limit: limit ? Number(limit) : 100,
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
   * POST /pdv/sales/:id/master/cancel-zumbi
   * Body: { motivo, password }
   * Cancela uma venda finalizada SEM payment (zumbi). NAO mexe em estoque.
   * Exige senha master (nivel MASTER+).
   */
  @Post('sales/:id/master/cancel-zumbi')
  async masterCancelZumbi(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { motivo: string; password: string },
  ) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'supervisor' && role !== 'operator' && !this.ehPapelFranquia(role)) {
      throw new ForbiddenException('Apenas admin/supervisor/operator');
    }
    if (this.ehPapelFranquia(role)) await this.assertSaleEhFranquia(id);
    const nivel = validateMinLevel(body?.password, 'MASTER');
    const userName = req?.user?.name || req?.user?.email || req?.user?.username || 'admin';
    return this.svc.masterCancelZumbi({
      saleId: id,
      motivo: body?.motivo || '',
      userName: `[${nivel}] ${userName}`,
    });
  }

  /**
   * POST /pdv/sales/:id/master/estornar
   * Body: { motivo, password }
   *
   * ESTORNO COMPLETO — usado pelo botão "ESTORNAR" da tela
   * /retaguarda/faturamento (drill-down). Reverte tudo automaticamente:
   *   - Cancela NFC-e na SEFAZ
   *   - Devolve estoque ao Wincred
   *   - Revoga cashback do cliente
   *   - Marca sale como cancelled
   *
   * Exige senha master + motivo (>=5 chars).
   * Retorna relatório passo-a-passo do que conseguiu reverter.
   */
  @Post('sales/:id/master/estornar')
  async masterEstornar(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { motivo: string; password: string },
  ) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'supervisor' && role !== 'operator' && !this.ehPapelFranquia(role)) {
      throw new ForbiddenException('Apenas admin/supervisor/operator');
    }
    if (this.ehPapelFranquia(role)) await this.assertSaleEhFranquia(id);
    const nivel = validateMinLevel(body?.password, 'MASTER');
    const userName = req?.user?.name || req?.user?.email || req?.user?.username || 'admin';
    return this.svc.masterEstornarVenda({
      saleId: id,
      motivo: body?.motivo || '',
      userName: `[${nivel}] ${userName}`,
    });
  }

  /**
   * POST /pdv/sales/:id/master/cancel-duplicada
   * Body: { motivo, password }
   * Cancela QUALQUER venda finalizada (mesmo com pagamento) — caso da Hellen:
   * mesma venda batida 2x por engano antes de imprimir cupom fiscal.
   * Marca status=cancelled + cancelReason. NAO mexe em estoque (assume que era duplicata).
   * Exige senha master.
   */
  @Post('sales/:id/master/cancel-duplicada')
  async masterCancelDuplicada(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { motivo: string; password: string },
  ) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'supervisor' && role !== 'operator' && !this.ehPapelFranquia(role)) {
      throw new ForbiddenException('Apenas admin/supervisor/operator');
    }
    if (this.ehPapelFranquia(role)) await this.assertSaleEhFranquia(id);
    const nivel = validateMinLevel(body?.password, 'MASTER');
    const userName = req?.user?.name || req?.user?.email || req?.user?.username || 'admin';
    return this.svc.masterCancelDuplicada({
      saleId: id,
      motivo: body?.motivo || '',
      userName: `[${nivel}] ${userName}`,
    });
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
   * POST /pdv/sales/:id/gift-voucher { valor, compradorNome?, presenteadoNome? }
   * VALE PRESENTE: item manual na venda + crédito (trilho do vale-troca) que
   * ativa quando a venda finaliza. Código VP- sai impresso no cupom.
   */
  @Post('sales/:id/gift-voucher')
  addGiftVoucher(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { valor: number; compradorNome?: string; presenteadoNome?: string },
  ) {
    this.requireRole(req);
    return this.svc.addGiftVoucher({
      saleId: id,
      valor: body?.valor,
      compradorNome: body?.compradorNome,
      presenteadoNome: body?.presenteadoNome,
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
    @Body() body: { qty?: number; desconto?: number; password?: string; motivo?: string; excludePromo?: boolean; forcePromo?: boolean },
  ) {
    this.requireRole(req);
    return this.svc.updateItem({
      saleId: id,
      itemId,
      qty: body?.qty,
      desconto: body?.desconto,
      password: body?.password,
      motivo: body?.motivo,
      excludePromo: body?.excludePromo,
      forcePromo: body?.forcePromo,
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
    @Body() body: { desconto: number; password?: string; motivo?: string },
  ) {
    this.requireRole(req);
    return this.svc.setSaleDiscount({
      saleId: id,
      desconto: body?.desconto || 0,
      password: body?.password,
      motivo: body?.motivo,
    });
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
    @Body() body: {
      cpf?: string;
      name?: string;
      email?: string;
      phone?: string;
      // Endereço — opcional, mas essencial pra venda online (WhatsApp/Insta)
      cep?: string;
      endereco?: string;
      numero?: string;
      complemento?: string;
      bairro?: string;
      cidade?: string;
      uf?: string;
    },
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
      // TRAVA DE SEGURANÇA: se a SESSÃO está em treino (header), a venda é
      // tratada como treino MESMO que tenha sido criada antes de ligar o
      // modo (venda aberta reaproveitada ficava sem isTraining e executava
      // Wincred/estoque REAIS com o banner de treino na tela).
      trainingRequest: isTrainingRequest(req),
    });
  }

  /**
   * POST /pdv/sales/:id/frete { valor }
   * FRETE da venda online — soma no que a cliente paga, fora do total de
   * produtos (faturamento/comissão/NFC-e/Giga não veem frete).
   */
  @Post('sales/:id/frete')
  setFrete(@Req() req: any, @Param('id') id: string, @Body() body: { valor: number }) {
    this.requireRole(req);
    return this.svc.setFrete({ saleId: id, valor: Number(body?.valor) });
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
   * PATCH /pdv/sales/:id/payments/:paymentId
   * Ajuste de pagamento (admin/supervisor).
   * Body: { method?, valor?, details?, reason }
   */
  @Patch('sales/:id/payments/:paymentId')
  async updatePayment(
    @Req() req: any,
    @Param('id') id: string,
    @Param('paymentId') paymentId: string,
    @Body() body: { method?: string; valor?: number; details?: any; reason?: string },
  ) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'supervisor') {
      throw new ForbiddenException('Apenas admin ou supervisor pode ajustar pagamento');
    }
    if (!body?.reason) {
      throw new BadRequestException('Razão obrigatória');
    }
    return this.svc.updatePayment({
      saleId: id,
      paymentId,
      method: body.method,
      valor: body.valor,
      details: body.details,
      reason: body.reason,
      changedByUserId: req?.user?.sub,
      changedByUserName: req?.user?.name,
      changedByRole: role,
    });
  }

  /**
   * GET /pdv/sales/:id/payments/audits — histórico de ajustes
   */
  @Get('sales/:id/payments/audits')
  async getPaymentAudits(
    @Req() req: any,
    @Param('id') id: string,
    @Query('paymentId') paymentId?: string,
  ) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'supervisor') {
      throw new ForbiddenException('Apenas admin ou supervisor');
    }
    return this.svc.getPaymentAudits({ saleId: id, paymentId });
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

    // ── MODO TREINAMENTO ──
    // União: venda criada em treino OU sessão atual em treino (header).
    // NÃO cria cobrança real no Pagar.me — retorna cobrança FAKE claramente
    // marcada (payload não é um BR Code válido, nenhum banco aceita).
    if ((sale as any).isTraining || isTrainingRequest(req)) {
      this.logger.log(
        `[pix-charge→TREINO] cobrança simulada — skip pagarme.createPixCharge · ` +
        `saleId=${id} valor=R$${Number(sale.total).toFixed(2)}`,
      );
      return {
        txid: 'TREINO',
        valor: sale.total,
        qrCodeDataUrl: null,
        payload: 'TREINO-SEM-VALOR',
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        training: true,
      };
    }

    const r = await this.pagarme.createPixCharge({
      saleId: id,
      valor: sale.total,
      storeCode: sale.storeCode,
      storeName: sale.storeName,
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

  // ═══════════════════════════════════════════════════════════════════════
  // CREDIÁRIO — busca cliente + pendências, e gera N parcelas no Giga
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * GET /pdv/customer-info?cpf=12345678900[&storeCode=05]
   * Busca cliente no Giga pelo CPF + retorna pendências (parcelas em aberto).
   * Usado pelo PaymentModal aba crediário pra mostrar banner de inadimplência.
   * Não bloqueia venda — só avisa.
   *
   * ⚠️ ESCOPO POR LOJA (incidente Piracicaba 03/07): o CODIGO de cliente do
   * Wincred se REPETE entre lojas — cada loja tem sua numeração e seu
   * crediário. Buscar sem filtrar LOJA misturava clientes: pegava cadastro
   * de outra loja (LIMIT 1 arbitrário) e listava pendências de OUTRA pessoa
   * (mesmo código em loja diferente). Toda busca aqui filtra (LOJA, CPF/CODIGO).
   *
   * Ordem de busca (loja = da vendedora logada; admin pode passar ?storeCode=):
   *   1. CRM determinístico: Customer por CPF → CustomerGigaLink (loja+codigo)
   *      da loja → lookup por (LOJA, CODIGO). Cobre cadastro do Giga com CPF
   *      vazio/errado — caso comum de cadastro rápido no balcão.
   *   2. clientes WHERE cpf normalizado = X AND LOJA
   *   3. clientes WHERE codigo = X AND LOJA (se digitaram código)
   *   4. LIKE do CPF + LOJA (chars invisíveis)
   *   5. Nada na loja? Procura o CPF SEM loja só pra AVISAR "cadastro é da
   *      loja YY" — não usa, porque crediário é por loja.
   */
  @Get('customer-info')
  async getCustomerInfo(
    @Req() req: any,
    @Query('cpf') cpf: string,
    @Query('storeCode') storeCodeQ?: string,
    @Query('nome') nomeQ?: string,
    @Query('telefone') telefoneQ?: string,
  ) {
    this.requireRole(req);
    if (!cpf) {
      throw new BadRequestException('CPF ou código do cliente obrigatório');
    }
    const cleanCpf = cpf.replace(/\D/g, '');
    if (cleanCpf.length < 3) {
      throw new BadRequestException('Mínimo 3 dígitos');
    }
    // Nome/telefone da venda — fallback quando o cadastro do Wincred está SEM
    // CPF (cadastro rápido de balcão, caso Piracicaba 03/07). Mesma estratégia
    // do lookupClienteCode que grava a caixa: CPF → telefone → nome.
    const nomeBusca = String(nomeQ || '').trim().toUpperCase().replace(/['"\\;%_]/g, '').slice(0, 80);
    const telBusca = String(telefoneQ || '').replace(/\D/g, '');

    // Loja do escopo: vendedora usa SEMPRE a própria; admin pode escolher.
    const role = req?.user?.role;
    const lojaRaw = role === 'admin'
      ? (storeCodeQ || req?.user?.storeCode)
      : (req?.user?.storeCode || storeCodeQ);
    const loja = lojaRaw
      ? String(lojaRaw).replace(/\D/g, '').padStart(2, '0').slice(0, 2)
      : null;

    // Busca cliente no Giga (tabela clientes detectada dinamicamente —
    // com cache opcional de 1h via flag PDV_GIGA_CACHE)
    const cm = await this.detectClientesTableCached();
    if (!cm) {
      // Detecção falha quando o Giga está fora (firewall/rede) e não há cache —
      // é erro de conexão, não "cliente não existe".
      return {
        found: false,
        gigaError: true,
        message: 'Giga indisponível no momento — tente de novo em instantes',
      };
    }

    // Filtro de loja aplicado em TODAS as buscas (quando a tabela tem a coluna)
    const lojaFilter = loja && cm.loja ? ` AND \`${cm.loja}\` = '${loja}'` : '';

    // Procura por CPF (coluna detectada dinamicamente — pode chamar CPF, cpf, CPFCGC, etc).
    // BUG FIX: CPF no Giga pode estar FORMATADO (108.458.788-24), só dígitos,
    // ter espaços invisíveis, ou outros caracteres. Normalizamos AMBOS os lados
    // antes de comparar usando REPLACE recursivo + TRIM.
    const safeCpf = cleanCpf.replace(/[^0-9]/g, '').slice(0, 14);
    const cpfCol = cm.cpf || 'CPF';
    // Helper SQL que normaliza coluna CPF: tira pontos, traços, barras, espaços e TRIM
    const normalizeSql = `TRIM(REPLACE(REPLACE(REPLACE(REPLACE(\`${cpfCol}\`, '.', ''), '-', ''), '/', ''), ' ', ''))`;
    let cliente: any = null;
    // Se TODAS as tentativas falharem por erro (Giga fora/firewall), avisa
    // "falha de conexão" em vez de "não encontrado" — senão a vendedora
    // acha que o cliente não existe (e ele existe).
    let queryOk = false;

    // Tentativa 1: CRM determinístico — o Customer do Flow já conhece o
    // (loja, codigo) do Giga via CustomerGigaLink. Resolve mesmo quando o
    // cadastro do Wincred está com CPF vazio/errado.
    if (loja && cm.loja && safeCpf.length === 11) {
      try {
        const prisma = (this.svc as any).prisma;
        const cpfFmt = `${safeCpf.slice(0, 3)}.${safeCpf.slice(3, 6)}.${safeCpf.slice(6, 9)}-${safeCpf.slice(9)}`;
        const crmCustomers = await prisma.customer.findMany({
          where: { cpf: { in: [safeCpf, cpfFmt] } },
          include: { gigaLinks: true },
          take: 20,
        });
        const linkDaLoja = crmCustomers
          .flatMap((c: any) => c.gigaLinks || [])
          .find((l: any) => String(l.gigaLoja || '').replace(/\D/g, '').padStart(2, '0') === loja);
        if (linkDaLoja) {
          const sqlLink =
            `SELECT * FROM \`${cm.table}\` WHERE CONCAT('', \`${cm.codCliente}\`) = '${Number(linkDaLoja.gigaCodigo)}'${lojaFilter} LIMIT 1`;
          const rLink = await this.erp.runReadOnly(sqlLink, { maxRows: 1, timeoutMs: 10000 });
          cliente = rLink.rows[0] || null;
          queryOk = true;
          if (cliente) {
            console.log(`[customer-info] achado via CRM link: loja=${loja} codigo=${linkDaLoja.gigaCodigo}`);
          }
        }
      } catch (e: any) {
        console.warn('[customer-info] lookup via CRM link falhou:', e?.message);
      }
    }

    // Tentativa 2: CPF normalizado igual exato (na loja)
    if (!cliente) {
      try {
        const sql = `SELECT * FROM \`${cm.table}\` WHERE ${normalizeSql} = '${safeCpf}'${lojaFilter} LIMIT 1`;
        const r = await this.erp.runReadOnly(sql, { maxRows: 1, timeoutMs: 10000 });
        cliente = r.rows[0] || null;
        queryOk = true;
      } catch (e: any) {
        console.warn('[customer-info] erro buscando CPF normalizado:', e?.message);
      }
    }

    // Tentativa 3: codCliente direto (caso passou um código em vez de CPF)
    if (!cliente) {
      try {
        const sql2 = `SELECT * FROM \`${cm.table}\` WHERE CONCAT('', \`${cm.codCliente}\`) = '${safeCpf}'${lojaFilter} LIMIT 1`;
        const r2 = await this.erp.runReadOnly(sql2, { maxRows: 1, timeoutMs: 10000 });
        cliente = r2.rows[0] || null;
        queryOk = true;
      } catch {/* ignora */}
    }

    // Tentativa 3: CPF como LIKE — pega mesmo se tem outros chars escondidos
    // (zero-width space, BOM, tabs, etc). Mais permissivo, último recurso.
    if (!cliente && safeCpf.length >= 11) {
      try {
        const sql3 = `SELECT * FROM \`${cm.table}\` WHERE ${normalizeSql} LIKE '%${safeCpf}%'${lojaFilter} LIMIT 1`;
        const r3 = await this.erp.runReadOnly(sql3, { maxRows: 1, timeoutMs: 10000 });
        cliente = r3.rows[0] || null;
        queryOk = true;
        if (cliente) {
          console.log(`[customer-info] cliente achado via LIKE fallback: cpf=${safeCpf}`);
        }
      } catch {/* ignora */}
    }

    // Tentativa 4b/4c: cadastro do Wincred SEM CPF (cadastro rápido de balcão).
    // Procura por TELEFONE e depois por NOME — sempre NA LOJA, e só usa se a
    // correspondência for ÚNICA (2+ resultados = ambíguo, não arrisca).
    let viaFallback: 'telefone' | 'nome' | null = null;
    if (!cliente && loja && cm.loja) {
      // 4b: telefone (FONECEL/FONERES, últimos 9 dígitos cobrem celular sem DDD)
      if (telBusca.length >= 8 && (cm.telefone || cm.telefone2)) {
        try {
          const last9 = telBusca.slice(-9);
          const telNorm = (col: string) =>
            `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(\`${col}\`, '(', ''), ')', ''), '-', ''), ' ', ''), '.', '')`;
          const telConds = [cm.telefone, cm.telefone2]
            .filter(Boolean)
            .map((col) => `${telNorm(col as string)} LIKE '%${last9}%'`);
          const sqlTel = `SELECT * FROM \`${cm.table}\` WHERE (${telConds.join(' OR ')})${lojaFilter} LIMIT 2`;
          const rTel = await this.erp.runReadOnly(sqlTel, { maxRows: 2, timeoutMs: 10000 });
          queryOk = true;
          if (rTel.rows.length === 1) {
            cliente = rTel.rows[0];
            viaFallback = 'telefone';
            console.log(`[customer-info] achado via TELEFONE na loja ${loja} (cpf digitado=${safeCpf})`);
          } else if (rTel.rows.length > 1) {
            console.log(`[customer-info] telefone ${last9} ambíguo na loja ${loja} (${rTel.rows.length} matches) — pulando`);
          }
        } catch {/* ignora */}
      }
      // 4c: nome exato, depois LIKE — só match ÚNICO
      if (!cliente && nomeBusca.length >= 5 && cm.nome) {
        try {
          const sqlNome = `SELECT * FROM \`${cm.table}\` WHERE UPPER(TRIM(\`${cm.nome}\`)) = ?${lojaFilter} LIMIT 2`;
          const rNome = await this.erp.runReadOnly(sqlNome, { maxRows: 2, timeoutMs: 10000 }, [nomeBusca]);
          queryOk = true;
          if (rNome.rows.length === 1) {
            cliente = rNome.rows[0];
            viaFallback = 'nome';
            console.log(`[customer-info] achado via NOME EXATO na loja ${loja}: "${nomeBusca}"`);
          } else if (rNome.rows.length === 0) {
            const sqlLike = `SELECT * FROM \`${cm.table}\` WHERE UPPER(\`${cm.nome}\`) LIKE ?${lojaFilter} LIMIT 2`;
            const rLike = await this.erp.runReadOnly(sqlLike, { maxRows: 2, timeoutMs: 10000 }, [`%${nomeBusca}%`]);
            if (rLike.rows.length === 1) {
              cliente = rLike.rows[0];
              viaFallback = 'nome';
              console.log(`[customer-info] achado via NOME LIKE na loja ${loja}: "${nomeBusca}"`);
            }
          }
        } catch {/* ignora */}
      }
    }

    if (!cliente && !queryOk) {
      console.warn(`[customer-info] GIGA FORA: nenhuma query respondeu (cpf=${safeCpf})`);
      return {
        found: false,
        gigaError: true,
        message: 'Falha consultando o Giga — tente de novo (NÃO significa que o cliente não existe)',
      };
    }

    // Tentativa 5: nada NESTA loja — procura o CPF sem filtro de loja só pra
    // dar a mensagem certa ("cadastro é da loja YY"). NÃO usa o cadastro de
    // outra loja: o crediário é por loja e a numeração de código também.
    if (!cliente && loja && cm.loja && safeCpf.length >= 11) {
      try {
        const sqlOutra =
          `SELECT \`${cm.loja}\` AS loja, \`${cm.codCliente}\` AS cod${cm.nome ? `, \`${cm.nome}\` AS nome` : ''} ` +
          `FROM \`${cm.table}\` WHERE ${normalizeSql} = '${safeCpf}' LIMIT 5`;
        const rOutra = await this.erp.runReadOnly(sqlOutra, { maxRows: 5, timeoutMs: 10000 });
        if (rOutra.rows.length > 0) {
          const lojas = rOutra.rows
            .map((row: any) => String(row.loja || '').trim())
            .filter(Boolean);
          console.log(`[customer-info] CPF ${safeCpf} tem cadastro nas lojas [${lojas.join(',')}] mas não na ${loja}`);
          return {
            found: false,
            outraLoja: {
              lojas,
              codCliente: String(rOutra.rows[0].cod || ''),
              nome: rOutra.rows[0].nome ? String(rOutra.rows[0].nome).trim() : null,
            },
            message:
              `Cliente tem cadastro na loja ${lojas.join(', ')}, mas NÃO na sua loja (${loja}). ` +
              `Crediário é separado por loja — cadastre o cliente no Wincred DESTA loja antes de fechar.`,
          };
        }
      } catch {/* ignora — cai na mensagem genérica */}
    }

    if (!cliente) {
      console.log(
        `[customer-info] NÃO ACHOU: tabela=${cm.table} cpfCol=${cpfCol} cpfBusca=${safeCpf} ` +
        `nome="${nomeBusca}" tel=${telBusca || '—'} loja=${loja || 'todas'}`,
      );
      // DIAGNÓSTICO no log: candidatos da loja pelo primeiro nome — mostra no
      // Railway o que existe lá (loja/código/nome/cpf) quando a busca falha.
      if (loja && cm.loja && cm.nome && nomeBusca) {
        try {
          const primeiroNome = nomeBusca.split(/\s+/)[0];
          if (primeiroNome.length >= 3) {
            const sqlDiag =
              `SELECT \`${cm.loja}\` AS loja, \`${cm.codCliente}\` AS cod, \`${cm.nome}\` AS nome` +
              `${cm.cpf ? `, \`${cm.cpf}\` AS cpf` : ''} FROM \`${cm.table}\` ` +
              `WHERE UPPER(\`${cm.nome}\`) LIKE ?${lojaFilter} LIMIT 5`;
            const rDiag = await this.erp.runReadOnly(sqlDiag, { maxRows: 5, timeoutMs: 10000 }, [`${primeiroNome}%`]);
            console.log(
              `[customer-info][diag] candidatos "${primeiroNome}%" na loja ${loja}: ` +
              (rDiag.rows.length
                ? rDiag.rows.map((r: any) => `[loja=${r.loja} cod=${r.cod} nome="${String(r.nome || '').trim()}" cpf="${String(r.cpf || '').trim()}"]`).join(' ')
                : 'NENHUM'),
            );
          }
        } catch {/* diagnóstico é best-effort */}
      }
      return {
        found: false,
        message: `Cliente não encontrado no Giga${loja ? ` (loja ${loja})` : ''} — cadastre no Wincred antes de fazer crediário`,
      };
    }

    const codCliente = String(cliente[cm.codCliente] || '').trim();
    const nome = cm.nome ? String(cliente[cm.nome] || '').trim() : null;
    const lojaCliente = cm.loja ? String(cliente[cm.loja] || '').trim() : loja;

    // Lista pendências (parcelas em aberto) — ESCOPADAS pela loja do cadastro.
    // Sem o filtro, o mesmo código em outra loja é OUTRA pessoa e as parcelas
    // dela apareciam aqui (mistura de crediário entre lojas).
    let pendencias: any[] = [];
    let totalDevido = 0;
    let totalAtraso = 0;
    try {
      pendencias = await this.crediarioBaixa.listOpenInstallmentsByCustomer({
        busca: codCliente,
        storeCode: lojaCliente || loja || undefined,
      });
      totalDevido = pendencias.reduce((s, p) => s + (p.valorParcela || 0), 0);
      totalAtraso = pendencias.filter((p) => p.diasAtraso > 0).reduce((s, p) => s + (p.valorParcela || 0), 0);
    } catch (e: any) {
      // Se falhar a busca de pendências, ainda retorna o cliente
      console.warn('[pdv/customer-info] erro ao listar pendências:', e?.message);
    }

    return {
      found: true,
      cliente: {
        codCliente,
        nome,
        cpf: cleanCpf,
        loja: lojaCliente || null,
        // 'telefone' | 'nome' quando o cadastro foi achado SEM bater o CPF
        // (Wincred com CPF vazio/errado) — a tela avisa pra completar depois.
        viaFallback,
        raw: cliente, // dados completos pra preencher form de cadastro se precisar
      },
      pendencias: pendencias.map((p) => ({
        registro: p.registro,
        controle: p.controle,
        parcela: p.parcela,
        totalParcelas: p.totalParcelas,
        vencimento: p.vencimento,
        valor: p.valorParcela,
        diasAtraso: p.diasAtraso,
      })),
      totalDevido: Math.round(totalDevido * 100) / 100,
      totalAtraso: Math.round(totalAtraso * 100) / 100,
      qtdPendencias: pendencias.length,
      qtdAtrasadas: pendencias.filter((p) => p.diasAtraso > 0).length,
    };
  }

  /**
   * GET /pdv/customer-search?q=texto&limit=20
   *
   * SEARCH HÍBRIDO — busca PRIMEIRO no Customer (CRM FlowOps), depois cai
   * pro Giga se ainda houver slots livres no limit.
   *
   * Cada resultado tem `source: 'crm' | 'giga'` pra UI decidir o que mostrar.
   * Clientes CRM trazem dados ricos: tier VIP, cashback, tamanho preferido,
   * última compra. Clientes Giga trazem só o cadastro básico.
   *
   * Busca por:
   *  - CPF (se q tiver só dígitos)
   *  - codCliente (Giga)
   *  - Nome (LIKE %q%)
   *
   * Dedup: se o mesmo CPF aparece nos 2 (CRM + Giga), CRM ganha.
   */
  @Get('customer-search')
  async searchCustomers(
    @Req() req: any,
    @Query('q') q: string,
    @Query('limit') limitStr?: string,
  ) {
    this.requireRole(req);
    const term = String(q || '').trim();
    if (term.length < 2) {
      return { results: [] };
    }
    const limit = Math.min(Math.max(Number(limitStr) || 20, 1), 50);

    const onlyDigits = term.replace(/\D/g, '');
    const isNumeric = onlyDigits.length >= 3 && /^\d+$/.test(term.replace(/[\s.\-]/g, ''));

    // ─── 1. BUSCA NO CRM (Customer Prisma) ─────────────────────────────────
    type SearchResult = {
      source: 'crm' | 'giga';
      codCliente: string;
      nome: string;
      cpf: string;
      cidade: string;
      telefone: string;
      // Campos extras do CRM (undefined pra Giga)
      customerId?: string;
      vipTier?: string;
      cashbackBalanceCents?: number;
      orderCount?: number;
      ltvCents?: number;
      lastOrderAt?: string | null;
      sizeDefault?: string | null;
      registroGiga?: number | null;
    };
    const results: SearchResult[] = [];
    const cpfsVistos = new Set<string>(); // dedup CPF entre CRM e Giga

    try {
      const crmWhere: any = { active: true, OR: [] as any[] };
      if (isNumeric) {
        // Busca por CPF (normalizado e formatado)
        const cpfFmt = onlyDigits.length === 11
          ? `${onlyDigits.slice(0, 3)}.${onlyDigits.slice(3, 6)}.${onlyDigits.slice(6, 9)}-${onlyDigits.slice(9)}`
          : '';
        crmWhere.OR.push({ cpf: { startsWith: onlyDigits } });
        if (cpfFmt) crmWhere.OR.push({ cpf: cpfFmt });
        // Por whatsapp também (últimos dígitos)
        if (onlyDigits.length >= 8) {
          crmWhere.OR.push({ whatsapp: { endsWith: onlyDigits.slice(-8) } });
          crmWhere.OR.push({ phone: { endsWith: onlyDigits.slice(-8) } });
        }
        // Por registroGiga (codCliente)
        if (onlyDigits.length <= 10) {
          const n = Number(onlyDigits);
          if (Number.isFinite(n)) crmWhere.OR.push({ registroGiga: n });
        }
      } else {
        // Busca por nome (case-insensitive)
        crmWhere.OR.push({ name: { contains: term, mode: 'insensitive' } });
        crmWhere.OR.push({ nameSocial: { contains: term, mode: 'insensitive' } });
      }
      if (crmWhere.OR.length > 0) {
        const crmCustomers = await (this.svc as any).prisma.customer.findMany({
          where: crmWhere,
          take: limit,
          orderBy: { name: 'asc' },
          select: {
            id: true, name: true, nameSocial: true, cpf: true, whatsapp: true,
            phone: true, vipTier: true, registroGiga: true,
            orderCount: true, ltvCents: true, lastOrderAt: true,
            sizeDefault: true,
            cashbackBalance: { select: { balanceCents: true } },
            originStore: { select: { code: true, name: true } },
          },
        });

        for (const c of crmCustomers as any[]) {
          const cpfNum = String(c.cpf || '').replace(/\D/g, '');
          if (cpfNum && cpfsVistos.has(cpfNum)) continue;
          if (cpfNum) cpfsVistos.add(cpfNum);
          results.push({
            source: 'crm',
            customerId: c.id,
            codCliente: c.registroGiga ? String(c.registroGiga) : '',
            nome: c.nameSocial || c.name || '',
            cpf: cpfNum,
            cidade: c.originStore?.name || '',
            telefone: String(c.whatsapp || c.phone || '').replace(/\D/g, ''),
            vipTier: c.vipTier || 'bronze',
            cashbackBalanceCents: c.cashbackBalance?.balanceCents || 0,
            orderCount: c.orderCount || 0,
            ltvCents: Number(c.ltvCents || 0),
            lastOrderAt: c.lastOrderAt ? c.lastOrderAt.toISOString() : null,
            sizeDefault: c.sizeDefault || null,
            registroGiga: c.registroGiga,
          });
        }
      }
    } catch (e: any) {
      console.warn('[customer-search] CRM falhou:', e?.message);
    }

    // ─── 2. SE AINDA HÁ SLOTS, BUSCA NO GIGA ──────────────────────────────
    const restante = limit - results.length;
    if (restante > 0) {
      const cm = await this.detectClientesTableCached();
      if (cm) {
        const safeText = term.replace(/['"\\;%_]/g, '').slice(0, 80);
        const safeNum = onlyDigits.slice(0, 14);

        const selectCols: string[] = [`\`${cm.codCliente}\``];
        if (cm.nome) selectCols.push(`\`${cm.nome}\``);
        if (cm.cpf) selectCols.push(`\`${cm.cpf}\``);
        if (cm.cidade) selectCols.push(`\`${cm.cidade}\``);
        if (cm.telefone) selectCols.push(`\`${cm.telefone}\``);

        const wheres: string[] = [];
        if (isNumeric) {
          if (cm.cpf) {
            wheres.push(`REPLACE(REPLACE(REPLACE(\`${cm.cpf}\`, '.', ''), '-', ''), '/', '') LIKE '${safeNum}%'`);
          }
          wheres.push(`CONCAT('', \`${cm.codCliente}\`) = '${safeNum}'`);
        }
        if (cm.nome) {
          wheres.push(`UPPER(\`${cm.nome}\`) LIKE UPPER('%${safeText}%')`);
        }

        if (wheres.length > 0) {
          const orderBy = cm.nome ? `ORDER BY \`${cm.nome}\` ASC` : `ORDER BY \`${cm.codCliente}\` ASC`;
          const sql = `SELECT ${selectCols.join(', ')} FROM \`${cm.table}\` WHERE ${wheres.join(' OR ')} ${orderBy} LIMIT ${restante * 2}`;

          try {
            const r = await this.erp.runReadOnly(sql, { maxRows: restante * 2, timeoutMs: 8000 });
            for (const row of (r.rows || [])) {
              const cpfNum = cm.cpf ? String(row[cm.cpf] ?? '').replace(/\D/g, '').trim() : '';
              // Dedup: pula se esse CPF já veio do CRM
              if (cpfNum && cpfsVistos.has(cpfNum)) continue;
              if (cpfNum) cpfsVistos.add(cpfNum);

              results.push({
                source: 'giga',
                codCliente: String(row[cm.codCliente] ?? '').trim(),
                nome: cm.nome ? String(row[cm.nome] ?? '').trim() : '',
                cpf: cpfNum,
                cidade: cm.cidade ? String(row[cm.cidade] ?? '').trim() : '',
                telefone: cm.telefone ? String(row[cm.telefone] ?? '').replace(/\D/g, '').trim() : '',
              });
              if (results.length >= limit) break;
            }
          } catch (e: any) {
            console.warn('[customer-search] Giga falhou:', e?.message);
          }
        }
      }
    }

    return { results: results.slice(0, limit) };
  }

  /**
   * POST /pdv/customer/upsert
   *
   * UPSERT inteligente do cliente capturado no PDV — verifica se CPF já
   * existe e:
   *   - JÁ EXISTE: faz MERGE não-destrutivo (só preenche campos null) e
   *                retorna o cliente existente com flag duplicated=true.
   *                Frontend mostra "Cliente já cadastrado" e identifica.
   *   - NÃO EXISTE: cria novo Customer com originSource='pdv' + storeCode
   *                 da venda. Marca created=true.
   *
   * Campos básicos capturados no PDV (todos opcionais exceto cpf):
   *   - cpf       (obrigatório — chave de dedupe)
   *   - name      (nome completo)
   *   - whatsapp  (com DDD)
   *   - email
   *   - storeCode (loja origem; vem do JWT da vendedora)
   *
   * NÃO faz nada com tier/cashback/sizeDefault — esses são preenchidos
   * depois via tela CRM completo ou comprovação de cashback no checkout.
   *
   * Body: { cpf, name?, whatsapp?, email?, storeCode? }
   */
  @Post('customer/upsert')
  async upsertCustomer(
    @Req() req: any,
    @Body() body: { cpf: string; name?: string; whatsapp?: string; email?: string; storeCode?: string },
  ) {
    this.requireRole(req);

    const cpfDigits = String(body?.cpf || '').replace(/\D/g, '');
    if (cpfDigits.length !== 11) {
      throw new BadRequestException('CPF inválido — precisa de 11 dígitos');
    }
    const cpfFmt = `${cpfDigits.slice(0, 3)}.${cpfDigits.slice(3, 6)}.${cpfDigits.slice(6, 9)}-${cpfDigits.slice(9)}`;

    const name = String(body?.name || '').trim();
    const whatsapp = String(body?.whatsapp || '').replace(/\D/g, '') || null;
    const email = String(body?.email || '').trim().toLowerCase() || null;
    // Loja: prioriza JWT da vendedora; cai pro storeCode do body se admin
    const userRole = req?.user?.role;
    const userStoreCode = req?.user?.storeCode;
    const storeCode = userRole === 'store' && userStoreCode ? userStoreCode : (body?.storeCode || userStoreCode);

    // 1) Busca cliente existente por CPF (formatado OU dígitos)
    //    Regra (jun/2026): mesma pessoa pode ter cadastro em N lojas.
    //    Prioriza Customer DA LOJA ATUAL do PDV; se não tem, qualquer um.
    const prisma = (this.svc as any).prisma;
    const storeIdResolved = userRole === 'store' ? req?.user?.storeId : null;
    let existing: any = null;
    if (storeIdResolved) {
      existing = await prisma.customer.findFirst({
        where: {
          AND: [
            { OR: [{ cpf: cpfDigits }, { cpf: cpfFmt }] },
            { originStoreId: storeIdResolved },
          ],
        },
        select: {
          id: true, name: true, whatsapp: true, phone: true, email: true,
          vipTier: true, registroGiga: true, originSource: true, originStoreId: true,
          cashbackBalance: { select: { balanceCents: true } },
        },
      });
    }
    if (!existing) {
      existing = await prisma.customer.findFirst({
        where: { OR: [{ cpf: cpfDigits }, { cpf: cpfFmt }] },
        select: {
          id: true, name: true, whatsapp: true, phone: true, email: true,
          vipTier: true, registroGiga: true, originSource: true, originStoreId: true,
          cashbackBalance: { select: { balanceCents: true } },
        },
      });
    }

    // 2) JÁ EXISTE — merge não-destrutivo
    if (existing) {
      const updates: any = {};
      if (name && !existing.name) updates.name = name.toUpperCase();
      if (whatsapp && !existing.whatsapp) updates.whatsapp = whatsapp;
      if (email && !existing.email) updates.email = email;

      if (Object.keys(updates).length > 0) {
        await prisma.customer.update({ where: { id: existing.id }, data: updates });
      }

      return {
        customerId: existing.id,
        duplicated: true,
        created: false,
        merged: Object.keys(updates).length > 0,
        mergedFields: Object.keys(updates),
        cliente: {
          id: existing.id,
          name: updates.name || existing.name,
          cpf: cpfFmt,
          whatsapp: updates.whatsapp || existing.whatsapp,
          email: updates.email || existing.email,
          vipTier: existing.vipTier,
          cashbackBalanceCents: existing.cashbackBalance?.balanceCents || 0,
        },
      };
    }

    // 3) NÃO EXISTE — cria novo com originSource='pdv'
    let originStoreId: string | null = null;
    if (storeCode) {
      const store = await prisma.store.findUnique({ where: { code: storeCode } });
      if (store) originStoreId = store.id;
    }

    const created = await prisma.customer.create({
      data: {
        cpf: cpfFmt,
        name: name ? name.toUpperCase() : null,
        whatsapp,
        email,
        originSource: 'pdv',
        originStoreId,
        vipTier: 'bronze',
        active: true,
        cashbackBalance: { create: {} },
      },
      select: {
        id: true, name: true, whatsapp: true, email: true, vipTier: true,
        cashbackBalance: { select: { balanceCents: true } },
      },
    });

    return {
      customerId: created.id,
      duplicated: false,
      created: true,
      cliente: {
        id: created.id,
        name: created.name,
        cpf: cpfFmt,
        whatsapp: created.whatsapp,
        email: created.email,
        vipTier: created.vipTier,
        cashbackBalanceCents: created.cashbackBalance?.balanceCents || 0,
      },
    };
  }

  /**
   * GET /pdv/funcionarios-search?q=texto&limit=20
   * Busca funcionária na tabela `funcionarios` do Giga (vendedora).
   * Usado pelo modal de identificação no início da venda.
   */
  @Get('funcionarios-search')
  async searchFuncionarios(
    @Req() req: any,
    @Query('q') q: string,
    @Query('loja') loja?: string,
    @Query('limit') limitStr?: string,
  ) {
    this.requireRole(req);
    const term = String(q || '').trim();
    const limit = Math.min(Math.max(Number(limitStr) || 20, 1), 50);
    const lojaCode = String(loja || '').trim();

    // Tenta tabelas comuns: funcionarios, vendedores, usuarios
    const candidates = ['funcionarios', 'funcionario', 'vendedores', 'vendedor', 'usuarios'];
    let table: string | null = null;
    let codigoCol: string | null = null;
    let nomeCol: string | null = null;
    let lojaCol: string | null = null;

    for (const tbl of candidates) {
      try {
        const schema = await this.erp.getTableSchema(tbl, 1);
        if (!schema) continue;
        const cols = schema.columns.map((c: any) => c.field);
        const nome = cols.find((c: string) => /^nome$/i.test(c) || /^razao$/i.test(c) || /^funcionario$/i.test(c));
        const codigo = cols.find((c: string) => /^codigo$/i.test(c) || /^cod_?func/i.test(c) || /^id_?func/i.test(c) || /^id$/i.test(c));
        // Loja: pode ser codloja, loja, cod_loja, filial, codfilial
        const lojaC = cols.find((c: string) => /^cod_?loja$/i.test(c) || /^loja$/i.test(c) || /^cod_?filial$/i.test(c) || /^filial$/i.test(c));
        if (!nome || !codigo) continue;
        table = tbl;
        codigoCol = codigo;
        nomeCol = nome;
        lojaCol = lojaC || null;
        break;
      } catch {/* tabela não existe — tenta próxima */}
    }

    if (!table || !codigoCol || !nomeCol) {
      return { results: [], message: 'Tabela de funcionários não encontrada no Giga' };
    }

    const safeText = term.replace(/['"\\;%_]/g, '').slice(0, 80);
    const safeLoja = lojaCode.replace(/[^0-9A-Za-z]/g, '').slice(0, 10);

    // Monta WHERE combinando filtro de nome + filtro de loja
    const wheres: string[] = [];
    if (term.length >= 2) {
      wheres.push(`UPPER(\`${nomeCol}\`) LIKE UPPER('%${safeText}%')`);
    }
    if (lojaCol && safeLoja) {
      // Compara como string (CONCAT) pra evitar problema de tipo INT vs CHAR
      wheres.push(`CONCAT('', \`${lojaCol}\`) = '${safeLoja}'`);
    }
    const where = wheres.length > 0 ? `WHERE ${wheres.join(' AND ')}` : '';

    const sql = `SELECT \`${codigoCol}\` AS codigo, \`${nomeCol}\` AS nome${lojaCol ? `, \`${lojaCol}\` AS loja` : ''} FROM \`${table}\` ${where} ORDER BY \`${nomeCol}\` ASC LIMIT ${limit}`;
    let rows: any[] = [];
    try {
      const r = await this.erp.runReadOnly(sql, { maxRows: limit, timeoutMs: 8000 });
      rows = r.rows || [];
    } catch (e: any) {
      console.warn('[funcionarios-search] erro:', e?.message);
    }

    return {
      table,
      lojaFiltered: !!(lojaCol && safeLoja),
      results: rows.map((r) => ({
        codigo: String(r.codigo ?? '').trim(),
        nome: String(r.nome ?? '').trim(),
        loja: r.loja !== undefined ? String(r.loja ?? '').trim() : '',
      })).filter((r) => r.nome),
    };
  }

  /**
   * PATCH /pdv/sales/:id/vendedora — atribui vendedora à venda.
   * Aceita codigo+nome direto do Giga (sem precisar do Seller cadastrado no Postgres).
   */
  @Patch('sales/:id/vendedora')
  async setVendedora(
    @Req() req: any,
    @Param('id') saleId: string,
    @Body() body: { codigo?: string; nome: string },
  ) {
    this.requireRole(req);
    if (!body?.nome) throw new BadRequestException('Nome da vendedora obrigatório');
    const sale = await (this.svc as any).prisma.pdvSale.findUnique({ where: { id: saleId } });
    if (!sale) throw new NotFoundException('Venda não encontrada');
    if (sale.status !== 'open') throw new BadRequestException('Venda já fechada');

    return (this.svc as any).prisma.pdvSale.update({
      where: { id: saleId },
      data: {
        sellerName: body.nome.trim(),
        // Guarda o código do Giga em sellerId (string livre — não é FK física aqui)
        sellerId: body.codigo?.trim() || null,
      },
    });
  }

  /**
   * POST /pdv/sales/:id/crediario
   * Gera N parcelas no Giga (tabela movimento) pra uma venda do PDV.
   *
   * Recebe:
   *   - parcelas: número (1-24)
   *   - primeiroVencimento: 'YYYY-MM-DD'
   *   - entrada (opcional): valor descontado do total antes de dividir
   *   - observacao (opcional): texto livre
   *
   * Pré-condições: venda OPEN com customerCpf preenchido.
   * O cliente DEVE existir no Giga (use /pdv/customer-info pra validar antes).
   */
  @Post('sales/:id/crediario')
  async createCrediario(
    @Req() req: any,
    @Param('id') saleId: string,
    @Body() body: {
      parcelas: number;
      primeiroVencimento: string; // 'YYYY-MM-DD'
      entrada?: number;
      observacao?: string;
      // Senha de supervisor pra liberar venda acima do limite de crédito
      // (só usada quando a política de limite está ligada e o cliente excede).
      overridePassword?: string;
    },
  ) {
    this.requireRole(req);
    const sale = await this.svc.getSale(saleId);

    // ── IDEMPOTÊNCIA ──
    // Se a venda JÁ teve parcelas criadas no Giga, NÃO recria. O frontend chama
    // este endpoint em 2 fluxos (split e finalize) e retry de rede / duplo-clique
    // gerava parcelas duplicadas no movimento. Retorna sucesso com o controle já
    // gravado — idempotente.
    if ((sale as any).crediarioControle) {
      this.logger.warn(
        `[crediario] IDEMPOTENTE — venda ${saleId} já tem controle=${(sale as any).crediarioControle}, ignorando recriação`,
      );
      return {
        ok: true,
        idempotent: true,
        controle: (sale as any).crediarioControle,
        criadoEm: (sale as any).crediarioCriadoEm || null,
      };
    }

    if (sale.status !== 'open') throw new BadRequestException('Venda já fechada');
    if (!sale.customerCpf) throw new BadRequestException('Cliente sem CPF — identifique antes');
    if (!body?.parcelas || body.parcelas < 1 || body.parcelas > 24) {
      throw new BadRequestException('Parcelas deve estar entre 1 e 24');
    }
    if (!body?.primeiroVencimento || !/^\d{4}-\d{2}-\d{2}$/.test(body.primeiroVencimento)) {
      throw new BadRequestException('primeiroVencimento inválido (formato YYYY-MM-DD)');
    }
    const entrada = Math.max(0, Math.round((body.entrada || 0) * 100) / 100);
    // FIX CRITICO (jun/2026): desconta TAMBEM pagamentos ja registrados na venda
    // (PIX, dinheiro, cartao). Antes: sale.total - entrada (ignorava PIX em split misto)
    // Caso real: venda 2968, PIX 1068, crediario virava 2968/6=494 ao inves de 1900/6=316
    // FIX: exclui 'crediario' do soma pra nao contar o proprio payment que o frontend criou ANTES de chamar este endpoint.
    const jaPago = Math.round((await this.svc.sumPaidValue(saleId, ['crediario'])) * 100) / 100;
    const valorFinanciado = Math.round((sale.total - entrada - jaPago) * 100) / 100;
    if (valorFinanciado <= 0) {
      throw new BadRequestException(
        'Crediario invalido: total=' + sale.total.toFixed(2) +
        ' entrada=' + entrada.toFixed(2) +
        ' jaPago=' + jaPago.toFixed(2) +
        ' financiado=' + valorFinanciado.toFixed(2) +
        '. Venda ja esta toda paga?'
      );
    }
    this.logger.log(
      '[crediario] saleId=' + saleId + ' total=' + sale.total + ' entrada=' + entrada + ' jaPago=' + jaPago + ' -> financiado=' + valorFinanciado + ' em ' + body.parcelas + 'x'
    );

    // ── MODO TREINAMENTO ──
    // União: venda criada em treino OU sessão atual em treino (header).
    // NÃO consulta/grava parcelas no Giga (movimento) — retorna sucesso
    // simulado com o mesmo shape do fluxo normal.
    if ((sale as any).isTraining || isTrainingRequest(req)) {
      this.logger.log(
        `[crediario→TREINO] parcelas simuladas — skip createCrediarioParcelas · ` +
        `saleId=${saleId} parcelas=${body.parcelas} valorFinanciado=R$${valorFinanciado.toFixed(2)}`,
      );
      return {
        ok: true,
        training: true,
        parcelas: body.parcelas,
        controle: 'TREINO',
        registroInicial: null,
        valorFinanciado,
        entrada,
      };
    }

    // Busca cliente no Giga pra pegar codCliente (+ pendências pra checar limite).
    // ESCOPADO pela loja DA VENDA — código de cliente se repete entre lojas;
    // sem isso as parcelas caíam no cadastro de outra loja (cliente errado).
    // Nome/telefone entram como fallback (cadastro do Wincred sem CPF).
    const info = await this.getCustomerInfo(
      req,
      sale.customerCpf,
      sale.storeCode,
      sale.customerName || undefined,
      (sale as any).customerPhone || undefined,
    );
    if (!info.found || !info.cliente) {
      throw new BadRequestException(
        (info as any).message ||
        'Cliente não encontrado no Giga. Cadastre o cliente antes de fazer crediário.',
      );
    }

    // ── POLÍTICA DE LIMITE DE CRÉDITO (default OFF) ──
    // Quando ligada em CrediarioConfig, bloqueia cliente acima do limite.
    // Pode ser liberado com senha de supervisor (overridePassword).
    try {
      const cfg = await this.crediarioBaixa.getConfig();
      if (cfg.limiteEnabled) {
        const motivos: string[] = [];
        const qtdVencidas = Number((info as any).qtdAtrasadas || 0);
        const valorAberto = Number((info as any).totalDevido || 0);
        if (cfg.limiteMaxParcelasVencidas > 0 && qtdVencidas > cfg.limiteMaxParcelasVencidas) {
          motivos.push(
            `${qtdVencidas} parcelas vencidas (máx ${cfg.limiteMaxParcelasVencidas})`,
          );
        }
        if (cfg.limiteMaxValorEmAberto > 0 && valorAberto > cfg.limiteMaxValorEmAberto) {
          motivos.push(
            `R$ ${valorAberto.toFixed(2)} em aberto (máx R$ ${cfg.limiteMaxValorEmAberto.toFixed(2)})`,
          );
        }
        if (motivos.length > 0) {
          // Bloqueado — só passa com senha de supervisor válida.
          let liberado = false;
          if (body?.overridePassword) {
            try {
              const nivel = validateMinLevel(body.overridePassword, 'SUPERVISOR');
              liberado = true;
              this.logger.warn(
                `[crediario] LIMITE liberado por override [${nivel}] — venda ${saleId} cliente=${info.cliente.codCliente} (${motivos.join('; ')})`,
              );
            } catch {
              throw new ForbiddenException('Senha de supervisor inválida pra liberar o limite');
            }
          }
          if (!liberado) {
            throw new ForbiddenException(
              `Cliente acima do limite de crédito: ${motivos.join('; ')}. ` +
              `Libere com senha de supervisor.`,
            );
          }
        }
      }
    } catch (e: any) {
      // Erros de bloqueio (Forbidden) sobem; falha ao LER a config não pode
      // travar a venda — segue sem limite (fail-open, comportamento legado).
      if (e instanceof ForbiddenException) throw e;
      this.logger.warn(`[crediario] checagem de limite ignorada (erro lendo config): ${e?.message}`);
    }

    const cols = await this.crediarios.detectColumns();
    if (!cols.registro || !cols.controle || !cols.codCliente || !cols.vencimento || !cols.valorParcela || !cols.parcela) {
      throw new BadRequestException(
        'Colunas obrigatórias da tabela movimento não detectadas — contate suporte',
      );
    }

    const result = await this.erp.createCrediarioParcelas({
      codCliente: info.cliente.codCliente,
      nomeCliente: info.cliente.nome || sale.customerName || '',
      valorTotal: valorFinanciado,
      parcelas: body.parcelas,
      primeiroVencimento: new Date(`${body.primeiroVencimento}T00:00:00.000Z`),
      dataCompra: new Date(),
      loja: sale.storeCode,
      observacao: body.observacao || `PDV venda #${sale.id.slice(-6).toUpperCase()}`,
      columns: cols,
    });

    if (!result.success) {
      throw new BadRequestException(`Erro ao criar parcelas: ${result.error}`);
    }

    // Grava o controle na venda — TRAVA de idempotência pra próximas chamadas.
    // best-effort: se falhar, a venda fica sem a trava (volta ao risco antigo),
    // mas as parcelas já foram criadas corretamente, então não desfaz nada.
    try {
      await (this.svc as any).prisma.pdvSale.update({
        where: { id: saleId },
        data: {
          crediarioControle: String(result.controleUsado ?? ''),
          crediarioCriadoEm: new Date(),
        },
      });
    } catch (e: any) {
      this.logger.error(
        `[crediario] FALHA ao gravar controle de idempotência na venda ${saleId}: ${e?.message}`,
      );
    }

    return {
      ok: true,
      parcelas: result.parcelas,
      controle: result.controleUsado,
      registroInicial: result.registroInicial,
      valorFinanciado,
      entrada,
    };
  }

  /**
   * GET /pdv/sales/crediario-orfaos?dias=10
   * Lista vendas que TEM pagamento method='crediario' no PdvSalePayment mas
   * NAO tem parcelas correspondentes no Giga (movimento).
   * Usado pra identificar vendas perdidas pelo bug do sumPaidValue.
   */
  @Get('sales/crediario-orfaos')
  async listarCrediariosOrfaos(@Req() req: any, @Query('dias') diasQ?: string) {
    this.requireRole(req);
    const dias = Math.min(60, Math.max(1, Number(diasQ) || 10));
    const since = new Date(Date.now() - dias * 86400000);
    const vendas = await (this.svc as any).prisma.pdvSale.findMany({
      where: {
        status: 'finalized',
        createdAt: { gte: since },
        payments: { some: { method: 'crediario' } },
      },
      select: {
        id: true,
        createdAt: true,
        total: true,
        storeCode: true,
        customerName: true,
        customerCpf: true,
        payments: { select: { method: true, valor: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return {
      ok: true,
      dias,
      total: vendas.length,
      atencao: 'cruze cada venda manualmente com o Giga (modulo movimento) — esta lista mostra vendas com crediario REGISTRADO no PDV, voce precisa conferir caso a caso se as parcelas existem no Giga.',
      vendas: vendas.map((v: any) => ({
        id: v.id,
        numero: v.id.slice(-6).toUpperCase(),
        data: v.createdAt,
        loja: v.storeCode,
        cliente: v.customerName || '-',
        cpf: v.customerCpf || '-',
        total: v.total,
        valorCrediario: v.payments.filter((p: any) => p.method === 'crediario').reduce((s: number, p: any) => s + (p.valor || 0), 0),
        valorOutros: v.payments.filter((p: any) => p.method !== 'crediario').reduce((s: number, p: any) => s + (p.valor || 0), 0),
      })),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // IMPRESSÃO — Promissórias e Carnê pré-impressos da Lurd's
  // ═══════════════════════════════════════════════════════════════════════

  /** GET /pdv/sales/:id/promissorias-pdf — N folhas A4, 3 promissórias por folha */
  @Get('sales/:id/promissorias-pdf')
  async getPromissoriasPdf(
    @Req() req: any,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    this.requireRole(req);
    try {
      const { buffer, filename } = await this.crediarioPrint.generatePromissorias(id);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
      res.setHeader('Content-Length', String(buffer.length));
      res.end(buffer);
    } catch (e: any) {
      console.error('[pdv/promissorias-pdf] FALHA', id, '\n', e?.stack || e);
      res.status(500).json({ statusCode: 500, message: 'Erro ao gerar PDF', detail: e?.message });
    }
  }

  /**
   * GET /pdv/sales/:id/carne-pdf — 1 folha A4, 2 carnês iguais.
   * ?debug=1 → desenha grade + labels [campo] em vermelho pra calibrar.
   */
  @Get('sales/:id/carne-pdf')
  async getCarnePdf(
    @Req() req: any,
    @Param('id') id: string,
    @Query('debug') debug: string,
    @Res() res: Response,
  ) {
    this.requireRole(req);
    try {
      const { buffer, filename } = await this.crediarioPrint.generateCarne(id, {
        debug: debug === '1' || debug === 'true',
      });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
      res.setHeader('Content-Length', String(buffer.length));
      res.end(buffer);
    } catch (e: any) {
      console.error('[pdv/carne-pdf] FALHA', id, '\n', e?.stack || e);
      res.status(500).json({ statusCode: 500, message: 'Erro ao gerar PDF', detail: e?.message });
    }
  }

  /**
   * GET /pdv/sales/:id/credprint-pdf — combinado: promissórias + carnê na ordem
   * que a vendedora carrega na impressora (folhas brancas primeiro, azul por último).
   */
  @Get('sales/:id/credprint-pdf')
  async getCredPrintCompleto(
    @Req() req: any,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    this.requireRole(req);
    try {
      const { buffer, filename } = await this.crediarioPrint.generateImpressaoCompleta(id);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
      res.setHeader('Content-Length', String(buffer.length));
      res.end(buffer);
    } catch (e: any) {
      console.error('[pdv/credprint-pdf] FALHA', id, '\n', e?.stack || e);
      res.status(500).json({ statusCode: 500, message: 'Erro ao gerar PDF', detail: e?.message });
    }
  }

  /**
   * GET /pdv/regua-calibracao — RÉGUA pra calibrar coordenadas da promissória.
   * Imprime em folha BRANCA, sobrepõe na pré-impressa contra a janela e
   * reporta em que Y caem cada label do form.
   */
  @Get('regua-calibracao')
  async getReguaCalibracao(@Req() req: any, @Res() res: Response) {
    this.requireRole(req);
    try {
      const { buffer, filename } = await this.crediarioPrint.generateRegua();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
      res.setHeader('Content-Length', String(buffer.length));
      res.end(buffer);
    } catch (e: any) {
      console.error('[pdv/regua-calibracao] FALHA', e?.stack || e);
      res.status(500).json({ statusCode: 500, message: 'Erro ao gerar régua' });
    }
  }

  /**
   * GET /pdv/promissorias-teste-pdf — gera 3 promissórias com os MESMOS dados
   * do print de referência do WinCred (Thiago/2315/8.90/5.00...). Não depende
   * de venda — só pra calibrar coordenadas e fonte sobre a folha pré-impressa.
   */
  @Get('promissorias-teste-pdf')
  async getPromissoriasTeste(@Res() res: Response) {
    // Sem auth + sem cache: tem que recarregar TODA vez pra refletir o JSON
    try {
      const { buffer, filename } = await this.crediarioPrint.generatePromissoriasTeste();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.setHeader('Content-Length', String(buffer.length));
      res.end(buffer);
    } catch (e: any) {
      console.error('[pdv/promissorias-teste-pdf] FALHA', e?.stack || e);
      res.status(500).json({ statusCode: 500, message: 'Erro ao gerar PDF de teste', detail: e?.message });
    }
  }

  /**
   * GET /pdv/diag-coords — mostra as coordenadas ATIVAS da promissória,
   * o path do JSON lido (ou null se não achou) e da fonte Verdana.
   * Use pra confirmar que sua edição do JSON foi carregada pelo backend.
   *
   * SEM auth: só retorna coordenadas geométricas, zero dado sensível.
   * Pode ser acessado direto pelo navegador.
   */
  @Get('diag-coords')
  async getDiagCoords(@Res() res: Response) {
    try {
      const result = await this.crediarioPrint.diagCoords();
      res.status(200).json(result);
    } catch (e: any) {
      console.error('[pdv/diag-coords] FALHA', e?.stack || e);
      res.status(500).json({ statusCode: 500, message: 'Erro no diag', detail: e?.message });
    }
  }

  /**
   * GET /pdv/diag-cliente?cpf=XXX — diagnóstico do cliente no Giga.
   * Retorna a linha crua + lista de colunas pra identificar por que
   * endereço/CEP/etc não estão vindo.
   */
  @Get('diag-cliente')
  async getDiagCliente(@Req() req: any, @Query('cpf') cpf: string, @Res() res: Response) {
    this.requireRole(req);
    try {
      const result = await this.crediarioPrint.diagCliente(cpf);
      res.status(200).json(result);
    } catch (e: any) {
      console.error('[pdv/diag-cliente] FALHA', e?.stack || e);
      res.status(500).json({ statusCode: 500, message: 'Erro no diag', detail: e?.message });
    }
  }

  /**
   * GET /pdv/promissorias-teste-debug-pdf — promissória de teste COM RÉGUA
   * de fundo. Pra calibração: imprime essa folha SOZINHA, sobrepõe na
   * pré-impressa do Giga e reporta deslocamentos lendo as coordenadas Y/X.
   */
  @Get('promissorias-teste-debug-pdf')
  async getPromissoriasTesteDebug(@Req() req: any, @Res() res: Response) {
    this.requireRole(req);
    try {
      const { buffer, filename } = await this.crediarioPrint.generatePromissoriasTesteDebug();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
      res.setHeader('Content-Length', String(buffer.length));
      res.end(buffer);
    } catch (e: any) {
      console.error('[pdv/promissorias-teste-debug-pdf] FALHA', e?.stack || e);
      res.status(500).json({ statusCode: 500, message: 'Erro ao gerar PDF debug', detail: e?.message });
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // ADMIN — Reconciliacao retroativa de estoque PDV → Wincred
  // ═════════════════════════════════════════════════════════════════════════

  @Get('admin/reconcile-stock/preview')
  async previewReconcileStock(
    @Req() req: any,
    @Query('since') since?: string,
    @Query('until') until?: string,
    @Query('storeCode') storeCode?: string,
    @Query('limit') limit?: string,
  ) {
    if (req?.user?.role !== 'admin') {
      throw new ForbiddenException('Apenas admin pode reconciliar estoque');
    }
    return this.svc.reconcileStockBacklog({
      sinceIso: since,
      untilIso: until,
      storeCode,
      limit: limit ? Number(limit) : 100,
      dryRun: true,
    });
  }

  @Post('admin/reconcile-stock/execute')
  async executeReconcileStock(
    @Req() req: any,
    @Body() body: { since?: string; until?: string; storeCode?: string; limit?: number },
  ) {
    if (req?.user?.role !== 'admin') {
      throw new ForbiddenException('Apenas admin pode reconciliar estoque');
    }
    return this.svc.reconcileStockBacklog({
      sinceIso: body?.since,
      untilIso: body?.until,
      storeCode: body?.storeCode,
      limit: body?.limit || 100,
      dryRun: false,
    });
  }

  /**
   * GET /pdv/admin/reconcile-manual-stock/preview — estoque fantasma "MANUAL":
   * produto REAL vendido com desconto manual (promoTag='MANUAL' + sku/ref reais)
   * que o filtro antigo pulava na baixa. Invisível ao reconcile normal (a venda
   * marcava stockDecreasedAt). Dry-run: só conta/lista, não baixa nada.
   */
  @Get('admin/reconcile-manual-stock/preview')
  async previewReconcileManualStock(
    @Req() req: any,
    @Query('since') since?: string,
    @Query('until') until?: string,
    @Query('storeCode') storeCode?: string,
    @Query('limit') limit?: string,
  ) {
    if (req?.user?.role !== 'admin') {
      throw new ForbiddenException('Apenas admin pode reconciliar estoque');
    }
    return this.svc.reconcileManualStockBacklog({
      sinceIso: since,
      untilIso: until,
      storeCode,
      limit: limit ? Number(limit) : 1000,
      dryRun: true,
    });
  }

  /** POST /pdv/admin/reconcile-manual-stock/execute — baixa os fantasmas MANUAL. */
  @Post('admin/reconcile-manual-stock/execute')
  async executeReconcileManualStock(
    @Req() req: any,
    @Body() body: { since?: string; until?: string; storeCode?: string; limit?: number },
  ) {
    if (req?.user?.role !== 'admin') {
      throw new ForbiddenException('Apenas admin pode reconciliar estoque');
    }
    return this.svc.reconcileManualStockBacklog({
      sinceIso: body?.since,
      untilIso: body?.until,
      storeCode: body?.storeCode,
      limit: body?.limit || 1000,
      dryRun: false,
    });
  }

  /**
   * GET /pdv/admin/cleanup-ghost-sales/preview?olderThanMinutes=30&storeCode=01
   * Lista vendas fantasma (open + sem items + criadas ha > N min). Dry-run.
   */
  @Get('admin/cleanup-ghost-sales/preview')
  async previewCleanupGhost(
    @Req() req: any,
    @Query('olderThanMinutes') olderThanMinutes?: string,
    @Query('storeCode') storeCode?: string,
  ) {
    if (req?.user?.role !== 'admin') {
      throw new ForbiddenException('Apenas admin');
    }
    return this.svc.cleanupGhostSales({
      olderThanMinutes: olderThanMinutes ? Number(olderThanMinutes) : 30,
      storeCode,
      dryRun: true,
    });
  }

  /**
   * POST /pdv/admin/cleanup-ghost-sales/execute
   * Body: { olderThanMinutes?, storeCode? }
   * Cancela todas vendas fantasma (status=cancelled, reason=auto-cleanup-fantasma).
   */
  @Post('admin/cleanup-ghost-sales/execute')
  async executeCleanupGhost(
    @Req() req: any,
    @Body() body: { olderThanMinutes?: number; storeCode?: string },
  ) {
    if (req?.user?.role !== 'admin') {
      throw new ForbiddenException('Apenas admin');
    }
    return this.svc.cleanupGhostSales({
      olderThanMinutes: body?.olderThanMinutes || 30,
      storeCode: body?.storeCode,
      dryRun: false,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ADMIN — Diagnostico + criacao de indices no Wincred
  // ═══════════════════════════════════════════════════════════════════════

  @Get('admin/erp-indexes')
  async inspectErpIndexes(
    @Req() req: any,
    @Query('table') table?: string,
  ) {
    if (req?.user?.role !== 'admin') {
      throw new ForbiddenException('Apenas admin');
    }
    const tables = table ? [table] : ['estoque', 'caixa', 'produtos', 'movimento'];
    const results = await Promise.all(
      tables.map((t) => this.erp.inspectTableIndexes(t)),
    );
    // Avalia se cada tabela tem indice util pra performance
    const analysis = results.map((r) => {
      const tbl = r.table;
      let recommendation: string | null = null;
      let hasCodigoLoja = false;
      let hasRef = false;
      if (r.indexes && r.indexes.length > 0) {
        for (const idx of r.indexes) {
          const cols = idx.columns.map((c) => c.toUpperCase());
          if (cols.includes('CODIGO') && cols.includes('LOJA')) hasCodigoLoja = true;
          if (cols[0] === 'REF') hasRef = true;
        }
      }
      if (tbl === 'estoque' && !hasCodigoLoja) {
        recommendation = 'CRIAR INDICE COMPOSTO (CODIGO, LOJA) — sem isso, SELECT/UPDATE de estoque varre tabela inteira';
      }
      if (tbl === 'produtos' && !hasRef) {
        recommendation = 'CRIAR INDICE em REF — usado em busca por refCode';
      }
      return { ...r, hasCodigoLoja, hasRef, recommendation };
    });
    return { results: analysis };
  }

  @Post('admin/erp-create-index')
  async createErpIndex(
    @Req() req: any,
    @Body() body: { table: string; indexName: string; columns: string[] },
  ) {
    if (req?.user?.role !== 'admin') {
      throw new ForbiddenException('Apenas admin');
    }
    if (!body?.table || !body?.indexName || !body?.columns?.length) {
      throw new BadRequestException('table, indexName e columns sao obrigatorios');
    }
    return this.erp.createIndexIfNotExists({
      table: body.table,
      indexName: body.indexName,
      columns: body.columns,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ADMIN — Diagnostico + retry de estorno de estoque em devolucoes
  // ═══════════════════════════════════════════════════════════════════════

  @Get('admin/returns-stock-status')
  async returnsStockStatus(
    @Req() req: any,
    @Query('since') since?: string,
    @Query('until') until?: string,
    @Query('storeCode') storeCode?: string,
  ) {
    if (req?.user?.role !== 'admin') {
      throw new ForbiddenException('Apenas admin');
    }
    return this.returns.getReturnsStockStatus({ sinceIso: since, untilIso: until, storeCode });
  }

  @Post('admin/returns-stock-retry')
  async returnsStockRetry(
    @Req() req: any,
    @Body() body: { since?: string; until?: string; storeCode?: string; limit?: number; dryRun?: boolean },
  ) {
    if (req?.user?.role !== 'admin') {
      throw new ForbiddenException('Apenas admin');
    }
    return this.returns.retryReturnsStock({
      sinceIso: body?.since,
      untilIso: body?.until,
      storeCode: body?.storeCode,
      limit: body?.limit || 100,
      dryRun: !!body?.dryRun,
    });
  }
}
