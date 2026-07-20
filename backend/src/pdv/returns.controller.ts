import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { validateMinLevel } from '../auth/auth-levels.util';
import { ReturnsService } from './returns.service';
import { isTrainingRequest } from './training.util';

@UseGuards(JwtAuthGuard)
@Controller('pdv/devolucao')
export class ReturnsController {
  constructor(private readonly svc: ReturnsService) {}

  private requireRole(req: any) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'store')
      throw new ForbiddenException('Apenas admin ou loja');
  }

  // Devolução que SAI dinheiro do caixa (dinheiro/pix) exige senha de GERENTE
  // + justificativa. Troca/crédito (vale, não sai dinheiro) seguem livres.
  private requireCashAuth(modo: string | undefined, motivo: string | undefined, password: string | undefined) {
    if (modo === 'dinheiro' || modo === 'pix') {
      if (!motivo || String(motivo).trim().length < 3) {
        throw new BadRequestException('Justificativa obrigatória (mín. 3 caracteres) para devolução em dinheiro/pix');
      }
      validateMinLevel(password, 'GERENTE'); // lança se a senha não for ≥ GERENTE
    }
  }

  private resolveStore(req: any, override?: { storeCode?: string; storeName?: string }) {
    const role = req?.user?.role;
    if (role === 'admin') {
      const storeCode = override?.storeCode || req?.user?.storeCode;
      const storeName = override?.storeName || req?.user?.storeName || storeCode || '';
      if (!storeCode) throw new BadRequestException('storeCode obrigatÃ³rio');
      return { storeCode, storeName };
    }
    const storeCode = req?.user?.storeCode;
    const storeName = req?.user?.storeName || storeCode || '';
    if (!storeCode) throw new BadRequestException('UsuÃ¡rio sem loja vinculada');
    return { storeCode, storeName };
  }

  /**
   * GET /pdv/devolucao/lookup?q=<id ou nfce>
   */
  @Get('lookup')
  async lookup(@Req() req: any, @Query('q') q: string) {
    this.requireRole(req);
    return this.svc.lookupSale(q);
  }

  /**
   * GET /pdv/devolucao/lookup-by-sku?sku=XXX&crossStore=1
   *
   * Lista vendas finalizadas que contÃªm esse SKU, ordenadas da mais recente
   * pra mais antiga. Permite vendedora bipar a peÃ§a que voltou (em vez de
   * pedir o cupom da venda original).
   *
   * Modo A2 â€” FILTRO POR LOJA + OVERRIDE ADMIN:
   *   - Vendedora (role=store): SÃ“ vÃª vendas da loja dela (storeCode do JWT)
   *   - Admin/operator: por padrÃ£o tambÃ©m filtra (operando uma loja fÃ­sica).
   *     Mas se mandar ?crossStore=1, vÃª vendas de TODAS as lojas.
   *
   * Regra de negÃ³cio: devoluÃ§Ã£o deve ser feita na loja que emitiu a NF
   * original (mesmo CNPJ). Override sÃ³ pra casos especiais (cliente em
   * trÃ¢nsito, suporte ao consumidor, etc).
   */
  @Get('lookup-by-sku')
  async lookupBySku(
    @Req() req: any,
    @Query('sku') sku: string,
  ) {
    this.requireRole(req);
    // Regra do dono: SEMPRE traz a rede — vendas da loja ATUAL em destaque e as
    // outras lojas abaixo. A loja do JWT vira a "casa" (sameStore) pro destaque.
    // A devolução em si segue pedindo confirmação cross-store (createReturn).
    const homeStoreCode = req?.user?.storeCode || null;
    return this.svc.lookupSalesBySku(sku, homeStoreCode);
  }

  /**
   * GET /pdv/devolucao/lookup-manual?sku=XXX
   *
   * DEVOLUÃ‡ÃƒO MANUAL (opÃ§Ã£o C â€” peÃ§a antiga sem cupom flowops).
   * Verifica se peÃ§a foi vendida na loja atual nos Ãºltimos 60 dias (Giga).
   * Anti-fraude: vendedora SÃ“ pode devolver peÃ§a que passou pelo caixa
   * daquela loja na janela.
   *
   * Retorna:
   *   { eligible: true, produto, vendas, salesCount } â†’ pode devolver
   *   { eligible: false, reason, message }            â†’ bloqueia com motivo
   */
  @Get('lookup-manual')
  async lookupManual(
    @Req() req: any,
    @Query('sku') sku: string,
    @Query('dias') dias?: string,
  ) {
    this.requireRole(req);
    const { storeCode } = this.resolveStore(req);
    const diasJanela = dias ? Math.max(1, Math.min(3650, Number(dias) || 60)) : 60;
    return this.svc.lookupManualReturnSku(sku, storeCode, diasJanela);
  }

  /**
   * POST /pdv/devolucao/manual
   * Body: {
   *   sku: string,                            // SKU bipado
   *   modo: 'dinheiro'|'troca'|'credito',
   *   motivo?: string,
   *   creditoValidadeDias?: number,
   *   storeCode?, storeName?,                 // admin pode forÃ§ar
   *   attachToSaleId?: string | null,
   * }
   */
  @Post('manual')
  async createManual(
    @Req() req: any,
    @Body()
    body: {
      sku: string;
      modo: 'dinheiro' | 'troca' | 'credito';
      motivo?: string;
      creditoValidadeDias?: number;
      storeCode?: string;
      storeName?: string;
      attachToSaleId?: string | null;
      password?: string;
    },
  ) {
    this.requireRole(req);
    this.requireCashAuth(body.modo, body.motivo, body.password);
    const { storeCode, storeName } = this.resolveStore(req, body);
    const u = req?.user || {};
    return this.svc.createManualReturn({
      sku: body.sku,
      storeCode,
      storeName,
      modo: body.modo,
      motivo: body.motivo,
      creditoValidadeDias: body.creditoValidadeDias,
      attachToSaleId: body.attachToSaleId ?? null,
      userId: u.id || u.sub,
      userName: u.name || u.email,
      // TRAVA DE SEGURANÃ‡A: sessÃ£o em treino (header) â†’ devoluÃ§Ã£o simulada,
      // sem increaseStock no Giga e sem sangria real.
      trainingRequest: isTrainingRequest(req),
    });
  }

  /**
   * POST /pdv/devolucao
   * Body: {
   *   originalSaleId, modo: 'dinheiro'|'troca'|'credito',
   *   items: [{originalItemId, qty}], motivo?, creditoValidadeDias?
   * }
   */
  @Post()
  async create(
    @Req() req: any,
    @Body()
    body: {
      originalSaleId: string;
      modo: 'dinheiro' | 'troca' | 'credito';
      items: Array<{ originalItemId: string; qty: number }>;
      motivo?: string;
      creditoValidadeDias?: number;
      storeCode?: string;
      storeName?: string;
      attachToSaleId?: string | null;
      password?: string;
      /** Frontend manda true quando user clica "Confirmar" no alerta cross-store. */
      confirmCrossStore?: boolean;
    },
  ) {
    this.requireRole(req);
    this.requireCashAuth(body.modo, body.motivo, body.password);
    const { storeCode, storeName } = this.resolveStore(req, body);
    return this.svc.createReturn({
      originalSaleId: body.originalSaleId,
      storeCode,
      storeName,
      modo: body.modo,
      items: body.items,
      motivo: body.motivo,
      creditoValidadeDias: body.creditoValidadeDias,
      attachToSaleId: body.attachToSaleId ?? null,
      userId: req?.user?.sub || req?.user?.id || null,
      userName: req?.user?.name || req?.user?.email || null,
      // TRAVA DE SEGURANÃ‡A: sessÃ£o em treino (header) â†’ devoluÃ§Ã£o tratada
      // como treino MESMO que a venda original seja real.
      trainingRequest: isTrainingRequest(req),
      confirmCrossStore: !!body.confirmCrossStore,
    });
  }

  /**
   * POST /pdv/devolucao/batch
   *
   * DevoluÃ§Ã£o BATCH â€” peÃ§as de VÃRIAS vendas originais em UMA operaÃ§Ã£o.
   * Cliente devolve peÃ§as que saÃ­ram de 2, 3 ou N compras diferentes.
   *
   * Cria N PdvReturns (1 por venda) mas consolida:
   *  - 1 sangria total (modo dinheiro/pix)
   *  - 1 cÃ³digo vale-troca master (modo troca/credito)
   *  - 1 estorno de estoque consolidado
   *
   * Body: {
   *   vendas: [{ originalSaleId, items: [{originalItemId, qty}] }, ...],
   *   modo, motivo?, creditoValidadeDias?,
   *   storeCode?, storeName?, attachToSaleId?
   * }
   */
  @Post('batch')
  async createBatch(
    @Req() req: any,
    @Body()
    body: {
      vendas: Array<{
        originalSaleId: string;
        items: Array<{ originalItemId: string; qty: number }>;
      }>;
      modo: 'dinheiro' | 'pix' | 'troca' | 'credito';
      motivo?: string;
      creditoValidadeDias?: number;
      storeCode?: string;
      storeName?: string;
      attachToSaleId?: string | null;
      password?: string;
    },
  ) {
    this.requireRole(req);
    this.requireCashAuth(body.modo, body.motivo, body.password);
    const { storeCode, storeName } = this.resolveStore(req, body);
    return this.svc.createReturnBatch({
      vendas: body.vendas,
      storeCode,
      storeName,
      modo: body.modo,
      motivo: body.motivo,
      creditoValidadeDias: body.creditoValidadeDias,
      attachToSaleId: body.attachToSaleId ?? null,
      userId: req?.user?.sub || req?.user?.id || null,
      userName: req?.user?.name || req?.user?.email || null,
      // TRAVA DE SEGURANÃ‡A: sessÃ£o em treino (header) â†’ batch inteiro tratado
      // como treino MESMO que as vendas originais sejam reais.
      trainingRequest: isTrainingRequest(req),
    });
  }

  /**
   * GET /pdv/devolucao â€” lista devoluÃ§Ãµes da loja
   */
  @Get()
  async list(
    @Req() req: any,
    @Query('storeCode') storeCodeOverride?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('cpf') cpf?: string,
    @Query('limit') limit?: string,
  ) {
    this.requireRole(req);
    const { storeCode } = this.resolveStore(req, { storeCode: storeCodeOverride });
    return this.svc.list({
      storeCode,
      customerCpf: cpf,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      limit: limit ? parseInt(limit, 10) : 50,
    });
  }

  /**
   * GET /pdv/devolucao/return/:id â€” busca dados de UMA devolucao pra imprimir comprovante.
   * Retorna PdvReturn + items + venda original (resumida).
   */
  @Get('return/:id')
  async getReturnById(@Req() req: any, @Param('id') id: string) {
    this.requireRole(req);
    return this.svc.getReturnById(id);
  }

  /**
   * GET /pdv/devolucao/creditos â€” lista vales emitidos com filtros.
   * Query: from, to, storeCode, status (ativo|usado|vencido), code, customerQ, page, size
   */
  @Get('creditos')
  async listCreditos(
    @Req() req: any,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('storeCode') storeCode?: string,
    @Query('status') status?: 'ativo' | 'usado' | 'vencido' | 'todos',
    @Query('code') code?: string,
    @Query('customerQ') customerQ?: string,
    @Query('page') page?: string,
    @Query('size') size?: string,
  ) {
    this.requireRole(req);
    return this.svc.listCreditos({
      from, to, storeCode, status, code, customerQ,
      page: page ? parseInt(page, 10) : 1,
      size: size ? parseInt(size, 10) : 50,
    });
  }

  /**
   * GET /pdv/devolucao/credito/:code â€” consulta vale-troca SEM usar
   */
  @Get('credito/:code')
  async checkCredit(@Req() req: any, @Param('code') code: string) {
    this.requireRole(req);
    return this.svc.checkCredit(code);
  }

  /**
   * POST /pdv/devolucao/credito/usar
   * Body: { creditoCode, saleId }
   */
  @Post('credito/usar')
  async useCredit(
    @Req() req: any,
    @Body() body: { creditoCode: string; saleId: string },
  ) {
    this.requireRole(req);
    return this.svc.useCredit({
      creditoCode: body.creditoCode,
      usedInSaleId: body.saleId,
    });
  }

  /**
   * POST /pdv/devolucao/dividir-vale-residual
   * Body: { saleId, customerCpf?, customerName?, validadeDias? }
   * AJUSTA o vale_troca payment da venda + CRIA novo vale com o saldo.
   * Usar no PDV quando vale_troca > total e cliente quer guardar o restante.
   */
  @Post('dividir-vale-residual')
  async dividirValeResidual(
    @Req() req: any,
    @Body() body: {
      saleId: string;
      customerCpf?: string;
      customerName?: string;
      validadeDias?: number;
    },
  ) {
    this.requireRole(req);
    return this.svc.dividirValeResidual({
      saleId: body.saleId,
      customerCpf: body.customerCpf,
      customerName: body.customerName,
      validadeDias: body.validadeDias,
      userId: req?.user?.sub || req?.user?.id || null,
      userName: req?.user?.name || req?.user?.email || null,
    });
  }

  /**
   * POST /pdv/devolucao/credito-residual
   * Body: { originalSaleId, valorResidual, customerCpf?, customerName?, validadeDias? }
   * Cria vale-troca residual quando sobra credito apos troca anexada.
   */
  @Post('credito-residual')
  async createCreditoResidual(
    @Req() req: any,
    @Body() body: {
      originalSaleId: string;
      valorResidual: number;
      customerCpf?: string;
      customerName?: string;
      validadeDias?: number;
    },
  ) {
    this.requireRole(req);
    return this.svc.createCreditoResidual({
      originalSaleId: body.originalSaleId,
      valorResidual: Number(body.valorResidual),
      customerCpf: body.customerCpf,
      customerName: body.customerName,
      validadeDias: body.validadeDias,
      userId: req?.user?.sub || req?.user?.id || null,
      userName: req?.user?.name || req?.user?.email || null,
    });
  }
}
