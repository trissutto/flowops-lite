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
import { CashService } from './cash.service';

/**
 * /pdv/caixa — fluxo de caixa diário (abertura, sangria, fechamento).
 *
 * Vendedora (role=store) só pode operar a própria loja (req.user.storeCode).
 * Admin pode operar qualquer loja passando ?storeCode= explícito.
 */
@UseGuards(JwtAuthGuard)
@Controller('pdv/caixa')
export class CashController {
  constructor(private readonly svc: CashService) {}

  private requireRole(req: any) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'store')
      throw new ForbiddenException('Apenas admin ou loja');
  }

  /**
   * Resolve a loja a ser usada: vendedora usa o que vem do JWT,
   * admin pode passar via body/query.
   */
  private resolveStore(req: any, override?: { storeCode?: string; storeName?: string }): {
    storeCode: string;
    storeName: string;
  } {
    const role = req?.user?.role;
    if (role === 'admin') {
      const storeCode = override?.storeCode || req?.user?.storeCode;
      const storeName = override?.storeName || req?.user?.storeName || storeCode || '';
      if (!storeCode) throw new BadRequestException('storeCode é obrigatório pra admin');
      return { storeCode, storeName };
    }
    // Vendedora: trava na loja do JWT
    const storeCode = req?.user?.storeCode;
    const storeName = req?.user?.storeName || storeCode || '';
    if (!storeCode) throw new BadRequestException('Usuário sem loja vinculada');
    return { storeCode, storeName };
  }

  /**
   * GET /pdv/caixa/atual — sessão aberta da loja (ou null).
   */
  @Get('atual')
  async getCurrent(@Req() req: any, @Query('storeCode') storeCodeOverride?: string) {
    this.requireRole(req);
    const { storeCode } = this.resolveStore(req, { storeCode: storeCodeOverride });
    const session = await this.svc.getCurrentSession(storeCode);
    if (!session) return { open: false, session: null };
    const totals = await this.svc.computeSessionTotals(session.id);
    return { open: true, session, totals };
  }

  /**
   * POST /pdv/caixa/abrir
   * Body: { fundoTroco, observacao?, storeCode? (admin) }
   */
  @Post('abrir')
  async open(
    @Req() req: any,
    @Body() body: { fundoTroco: number; observacao?: string; storeCode?: string; storeName?: string },
  ) {
    this.requireRole(req);
    const { storeCode, storeName } = this.resolveStore(req, body);
    return this.svc.openCash({
      storeCode,
      storeName,
      fundoTroco: Number(body.fundoTroco),
      openedByUserId: req?.user?.sub || req?.user?.id || null,
      openedByName: req?.user?.name || req?.user?.email || null,
      observacao: body.observacao,
    });
  }

  /**
   * GET /pdv/caixa/movimento/:id — dados pra cupom de sangria/suprimento.
   */
  @Get('movimento/:id')
  async getMovimento(@Req() req: any, @Param('id') id: string) {
    this.requireRole(req);
    return this.svc.getMovement(id);
  }

  /**
   * POST /pdv/caixa/sangria
   * Body: { valor, motivo }
   */
  @Post('sangria')
  async sangria(
    @Req() req: any,
    @Body() body: { valor: number; motivo: string; storeCode?: string },
  ) {
    this.requireRole(req);
    const { storeCode } = this.resolveStore(req, { storeCode: body.storeCode });
    return this.svc.addMovement({
      storeCode,
      tipo: 'sangria',
      valor: Number(body.valor),
      motivo: body.motivo,
      userId: req?.user?.sub || req?.user?.id || null,
      userName: req?.user?.name || req?.user?.email || null,
    });
  }

  /**
   * POST /pdv/caixa/suprimento
   * Body: { valor, motivo }
   */
  @Post('suprimento')
  async suprimento(
    @Req() req: any,
    @Body() body: { valor: number; motivo: string; storeCode?: string },
  ) {
    this.requireRole(req);
    const { storeCode } = this.resolveStore(req, { storeCode: body.storeCode });
    return this.svc.addMovement({
      storeCode,
      tipo: 'suprimento',
      valor: Number(body.valor),
      motivo: body.motivo,
      userId: req?.user?.sub || req?.user?.id || null,
      userName: req?.user?.name || req?.user?.email || null,
    });
  }

  /**
   * GET /pdv/caixa/movimentos — lista todas as sangrias/suprimentos da sessão atual.
   */
  @Get('movimentos')
  async movements(@Req() req: any, @Query('storeCode') storeCodeOverride?: string) {
    this.requireRole(req);
    const { storeCode } = this.resolveStore(req, { storeCode: storeCodeOverride });
    return this.svc.listMovements(storeCode);
  }

  /**
   * GET /pdv/caixa/relatorio-x — snapshot SEM fechar.
   */
  @Get('relatorio-x')
  async xReport(@Req() req: any, @Query('storeCode') storeCodeOverride?: string) {
    this.requireRole(req);
    const { storeCode } = this.resolveStore(req, { storeCode: storeCodeOverride });
    return this.svc.getXReport(storeCode);
  }

  /**
   * GET /pdv/caixa/relatorio-detalhado — snapshot detalhado com breakdown
   * por bandeira de cartão. Usado pela tela /minha-loja/pdv/fechamento.
   */
  @Get('relatorio-detalhado')
  async detailedReport(@Req() req: any, @Query('storeCode') storeCodeOverride?: string) {
    this.requireRole(req);
    const { storeCode } = this.resolveStore(req, { storeCode: storeCodeOverride });
    return this.svc.getRelatorioDetalhado(storeCode);
  }

  /**
   * POST /pdv/caixa/fechar
   * Body: { dinheiroFisico, observacao? }
   */
  @Post('fechar')
  async close(
    @Req() req: any,
    @Body() body: { dinheiroFisico: number; observacao?: string; storeCode?: string },
  ) {
    this.requireRole(req);
    const { storeCode } = this.resolveStore(req, { storeCode: body.storeCode });
    return this.svc.closeCash({
      storeCode,
      dinheiroFisico: Number(body.dinheiroFisico),
      closedByName: req?.user?.name || req?.user?.email || null,
      observacao: body.observacao,
    });
  }

  /**
   * GET /pdv/caixa/pendencias — lista vendas em aberto da sessão atual.
   * Útil pra debugar quando o fechamento bloqueia.
   */
  @Get('pendencias')
  async listPendencias(@Req() req: any, @Query('storeCode') storeCodeOverride?: string) {
    this.requireRole(req);
    const { storeCode } = this.resolveStore(req, { storeCode: storeCodeOverride });
    return this.svc.listOpenSalesInCurrentSession(storeCode);
  }

  /**
   * POST /pdv/caixa/forcar-fechar — cancela vendas em aberto e fecha o caixa.
   * Use quando o fechamento normal bloqueia por venda zumbi.
   * Body: { dinheiroFisico, observacao?, reason? }
   */
  @Post('forcar-fechar')
  async forceClose(
    @Req() req: any,
    @Body() body: { dinheiroFisico: number; observacao?: string; reason?: string; storeCode?: string },
  ) {
    this.requireRole(req);
    const { storeCode } = this.resolveStore(req, { storeCode: body.storeCode });
    return this.svc.forceCloseCash({
      storeCode,
      dinheiroFisico: Number(body.dinheiroFisico),
      closedByName: req?.user?.name || req?.user?.email || null,
      observacao: body.observacao,
      reason: body.reason,
    });
  }

  /**
   * GET /pdv/caixa/sessoes — histórico de sessões fechadas.
   */
  @Get('sessoes')
  async listSessions(
    @Req() req: any,
    @Query('storeCode') storeCodeOverride?: string,
    @Query('limit') limit?: string,
  ) {
    this.requireRole(req);
    const { storeCode } = this.resolveStore(req, { storeCode: storeCodeOverride });
    return this.svc.listSessions(storeCode, limit ? parseInt(limit, 10) : 30);
  }

  /**
   * GET /pdv/caixa/sessoes/:id — detalhe de uma sessão específica.
   */
  @Get('sessoes/:id')
  async getSessionDetail(@Req() req: any, @Param('id') id: string) {
    this.requireRole(req);
    return this.svc.getSessionDetail(id);
  }

  /**
   * GET /pdv/caixa/super-painel — Retaguarda: agregado de TODAS as lojas
   * Restrito a admin/supervisor.
   */
  @Get('super-painel')
  async getSuperPainel(@Req() req: any) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'supervisor') {
      throw new ForbiddenException('Apenas admin ou supervisor');
    }
    return this.svc.getSuperPainelCaixas();
  }
}
