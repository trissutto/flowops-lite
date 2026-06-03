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
import { ReturnsService } from './returns.service';

@UseGuards(JwtAuthGuard)
@Controller('pdv/devolucao')
export class ReturnsController {
  constructor(private readonly svc: ReturnsService) {}

  private requireRole(req: any) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'store')
      throw new ForbiddenException('Apenas admin ou loja');
  }

  private resolveStore(req: any, override?: { storeCode?: string; storeName?: string }) {
    const role = req?.user?.role;
    if (role === 'admin') {
      const storeCode = override?.storeCode || req?.user?.storeCode;
      const storeName = override?.storeName || req?.user?.storeName || storeCode || '';
      if (!storeCode) throw new BadRequestException('storeCode obrigatório');
      return { storeCode, storeName };
    }
    const storeCode = req?.user?.storeCode;
    const storeName = req?.user?.storeName || storeCode || '';
    if (!storeCode) throw new BadRequestException('Usuário sem loja vinculada');
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
   * Lista vendas finalizadas que contêm esse SKU, ordenadas da mais recente
   * pra mais antiga. Permite vendedora bipar a peça que voltou (em vez de
   * pedir o cupom da venda original).
   *
   * Modo A2 — FILTRO POR LOJA + OVERRIDE ADMIN:
   *   - Vendedora (role=store): SÓ vê vendas da loja dela (storeCode do JWT)
   *   - Admin/operator: por padrão também filtra (operando uma loja física).
   *     Mas se mandar ?crossStore=1, vê vendas de TODAS as lojas.
   *
   * Regra de negócio: devolução deve ser feita na loja que emitiu a NF
   * original (mesmo CNPJ). Override só pra casos especiais (cliente em
   * trânsito, suporte ao consumidor, etc).
   */
  @Get('lookup-by-sku')
  async lookupBySku(
    @Req() req: any,
    @Query('sku') sku: string,
    @Query('crossStore') crossStore?: string,
  ) {
    this.requireRole(req);
    const role = req?.user?.role;
    const userStoreCode = req?.user?.storeCode || null;
    // crossStore=1 só funciona se for admin/operator. Vendedora comum sempre filtra.
    const isAdmin = role === 'admin' || role === 'operator';
    const wantsCross = crossStore === '1' || crossStore === 'true';
    const storeCodeFilter = isAdmin && wantsCross ? null : userStoreCode;
    return this.svc.lookupSalesBySku(sku, storeCodeFilter);
  }

  /**
   * GET /pdv/devolucao/lookup-manual?sku=XXX
   *
   * DEVOLUÇÃO MANUAL (opção C — peça antiga sem cupom flowops).
   * Verifica se peça foi vendida na loja atual nos últimos 60 dias (Giga).
   * Anti-fraude: vendedora SÓ pode devolver peça que passou pelo caixa
   * daquela loja na janela.
   *
   * Retorna:
   *   { eligible: true, produto, vendas, salesCount } → pode devolver
   *   { eligible: false, reason, message }            → bloqueia com motivo
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
   *   storeCode?, storeName?,                 // admin pode forçar
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
    },
  ) {
    this.requireRole(req);
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
    },
  ) {
    this.requireRole(req);
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
    });
  }

  /**
   * POST /pdv/devolucao/batch
   *
   * Devolução BATCH — peças de VÁRIAS vendas originais em UMA operação.
   * Cliente devolve peças que saíram de 2, 3 ou N compras diferentes.
   *
   * Cria N PdvReturns (1 por venda) mas consolida:
   *  - 1 sangria total (modo dinheiro/pix)
   *  - 1 código vale-troca master (modo troca/credito)
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
    },
  ) {
    this.requireRole(req);
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
    });
  }

  /**
   * GET /pdv/devolucao — lista devoluções da loja
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
   * GET /pdv/devolucao/return/:id — busca dados de UMA devolucao pra imprimir comprovante.
   * Retorna PdvReturn + items + venda original (resumida).
   */
  @Get('return/:id')
  async getReturnById(@Req() req: any, @Param('id') id: string) {
    this.requireRole(req);
    return this.svc.getReturnById(id);
  }

  /**
   * GET /pdv/devolucao/creditos — lista vales emitidos com filtros.
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
   * GET /pdv/devolucao/credito/:code — consulta vale-troca SEM usar
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
