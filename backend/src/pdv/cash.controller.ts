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
import { validateMinLevel } from '../auth/auth-levels.util';
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
    @Body() body: { dinheiroFisico?: number; observacao?: string; storeCode?: string },
  ) {
    this.requireRole(req);
    const { storeCode } = this.resolveStore(req, { storeCode: body.storeCode });
    // dinheiroFisico agora é opcional — vendedora conta no DIA SEGUINTE quando
    // abre o caixa. Se vier preenchido (fluxo legado), aceita.
    const fisico = body.dinheiroFisico != null ? Number(body.dinheiroFisico) : null;
    return this.svc.closeCash({
      storeCode,
      dinheiroFisico: fisico != null && !isNaN(fisico) ? fisico : null,
      closedByName: req?.user?.name || req?.user?.email || null,
      observacao: body.observacao,
    });
  }

  /**
   * POST /pdv/caixa/admin/auto-close-expired
   *
   * Fecha TODAS as sessões abertas desde dia anterior (lojas que esqueceram
   * de fechar o caixa). Apenas admin pode chamar. Usado pra arrumar quando
   * vendedora esquece de fechar e o dia seguinte começa.
   *
   * Idealmente esse método é chamado por um cron diário ~23:55, mas
   * enquanto não tem cron, admin clica pra rodar manualmente.
   */
  @Post('admin/auto-close-expired')
  async adminAutoCloseExpired(@Req() req: any) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'operator') {
      throw new ForbiddenException('Apenas admin/operator');
    }
    return this.svc.autoCloseExpiredSessions();
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
    @Body() body: { dinheiroFisico?: number; observacao?: string; reason?: string; storeCode?: string },
  ) {
    this.requireRole(req);
    const { storeCode } = this.resolveStore(req, { storeCode: body.storeCode });
    const fisico = body.dinheiroFisico != null ? Number(body.dinheiroFisico) : null;
    return this.svc.forceCloseCash({
      storeCode,
      dinheiroFisico: fisico != null && !isNaN(fisico) ? fisico : null,
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

  /**
   * GET /pdv/caixa/super-painel-historico?from=YYYY-MM-DD&to=YYYY-MM-DD
   * Painel agregado por DATA/PERIODO. Pra ver dias passados.
   * Sem polling — snapshot da data.
   */
  @Get('super-painel-historico')
  async getSuperPainelHistorico(
    @Req() req: any,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'supervisor') {
      throw new ForbiddenException('Apenas admin ou supervisor');
    }
    if (!from) {
      throw new BadRequestException('Parametro "from" obrigatorio (YYYY-MM-DD)');
    }
    const dFrom = new Date(from + 'T00:00:00');
    const dTo = to ? new Date(to + 'T00:00:00') : dFrom;
    if (isNaN(dFrom.getTime()) || isNaN(dTo.getTime())) {
      throw new BadRequestException('Data invalida (use YYYY-MM-DD)');
    }
    if (dTo < dFrom) {
      throw new BadRequestException('"to" nao pode ser anterior a "from"');
    }
    return this.svc.getSuperPainelHistorico(dFrom, dTo);
  }

  /**
   * POST /pdv/caixa/admin/check-sessions
   * Body: { sessionIds: string[], note?: string }
   *
   * Admin/supervisor marca uma ou mais sessões de caixa como CONFERIDAS
   * (bateu valores contra Wincred e validou). Fica registrado quem e quando
   * pra auditoria.
   */
  @Post('admin/check-sessions')
  async checkSessions(
    @Req() req: any,
    @Body() body: { sessionIds: string[]; note?: string },
  ) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'supervisor') {
      throw new ForbiddenException('Apenas admin ou supervisor');
    }
    return this.svc.markSessionsAsChecked({
      sessionIds: body.sessionIds || [],
      userId: req?.user?.userId || null,
      userName: req?.user?.name || req?.user?.username || 'admin',
      note: body.note,
    });
  }

  /**
   * POST /pdv/caixa/admin/uncheck-sessions
   * Desfaz a conferência (caso marque por engano).
   */
  @Post('admin/uncheck-sessions')
  async uncheckSessions(
    @Req() req: any,
    @Body() body: { sessionIds: string[] },
  ) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'supervisor') {
      throw new ForbiddenException('Apenas admin ou supervisor');
    }
    return this.svc.unmarkSessionsAsChecked({
      sessionIds: body.sessionIds || [],
    });
  }

  // ═════════════════════════════════════════════════════════════════════
  // MASTER ADJUST — admin/supervisor com SENHA MASTER
  // Usado no super-painel pra corrigir fundo/sangria pos-fechamento.
  // ═════════════════════════════════════════════════════════════════════

  /**
   * Valida senha contra a hierarquia de niveis (SUPREMA > MASTER > GERENTE > ...).
   * Lanca 403 se senha invalida ou nivel insuficiente.
   * Retorna o nivel detectado pra audit log.
   */
  private validateLevel(password: string | undefined, minLevel: any) {
    return validateMinLevel(password, minLevel);
  }

  private requireMasterRole(req: any) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'supervisor' && role !== 'operator') {
      throw new ForbiddenException('Apenas admin/supervisor/operator');
    }
  }

  /**
   * PATCH /pdv/caixa/master/fundo
   * Body: { storeCode, valor, motivo, password }
   * Sobrescreve fundoTroco da sessao do dia (aberta ou fechada).
   */
  @Patch('master/fundo')
  async masterFundo(
    @Req() req: any,
    @Body() body: { storeCode: string; valor: number; motivo: string; password: string; date?: string },
  ) {
    this.requireMasterRole(req);
    const nivel = this.validateLevel(body?.password, 'MASTER');
    if (!body?.storeCode) throw new BadRequestException('storeCode obrigatorio');
    const userName = req?.user?.name || req?.user?.email || req?.user?.username || 'admin';
    return this.svc.masterAdjustFundo({
      storeCode: body.storeCode,
      valor: Number(body.valor),
      motivo: body.motivo,
      userName: `[${nivel}] ${userName}`,
      // Painel HISTÓRICO manda a data — ajusta a 1ª sessão daquele dia
      date: body.date || null,
    });
  }

  /**
   * POST /pdv/caixa/master/movement
   * Body: { storeCode, tipo: 'sangria'|'suprimento', valor, motivo, password }
   */
  @Post('master/movement')
  async masterMovement(
    @Req() req: any,
    @Body() body: {
      storeCode: string;
      tipo: 'sangria' | 'suprimento';
      valor: number;
      motivo: string;
      password: string;
      date?: string;
    },
  ) {
    this.requireMasterRole(req);
    const nivel = this.validateLevel(body?.password, 'MASTER');
    if (!body?.storeCode) throw new BadRequestException('storeCode obrigatorio');
    const userName = req?.user?.name || req?.user?.email || req?.user?.username || 'admin';
    return this.svc.masterAddMovement({
      storeCode: body.storeCode,
      tipo: body.tipo,
      valor: Number(body.valor),
      motivo: body.motivo,
      userName: `[${nivel}] ${userName}`,
      // Painel HISTÓRICO manda a data — grava na sessão daquele dia (senão o
      // lançamento ia pra sessão de hoje e não aparecia no dia filtrado).
      date: body.date || null,
    });
  }

  /**
   * DELETE /pdv/caixa/master/movement/:id
   * Body: { password }
   * Estorna (deleta) uma sangria/suprimento.
   */
  @Delete('master/movement/:id')
  async masterDeleteMovement(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { password: string },
  ) {
    this.requireMasterRole(req);
    const nivel = this.validateLevel(body?.password, 'MASTER');
    const userName = req?.user?.name || req?.user?.email || req?.user?.username || 'admin';
    return this.svc.masterDeleteMovement({
      movementId: id,
      userName: `[${nivel}] ${userName}`,
    });
  }

  /**
   * GET /pdv/caixa/master/audit
   * Query: ?storeCode=&action=&from=YYYY-MM-DD&to=YYYY-MM-DD&userName=&page=1&size=50
   * Lista log de auditoria master. Apenas admin/supervisor.
   */
  @Get('master/audit')
  async listAudit(
    @Req() req: any,
    @Query('storeCode') storeCode?: string,
    @Query('action') action?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('userName') userName?: string,
    @Query('page') page?: string,
    @Query('size') size?: string,
  ) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'supervisor' && role !== 'operator') {
      throw new ForbiddenException('Apenas admin/supervisor/operator');
    }
    return this.svc.listMasterAudit({
      storeCode,
      action,
      fromDate: from,
      toDate: to,
      userName,
      page: page ? parseInt(page, 10) : 1,
      size: size ? parseInt(size, 10) : 50,
    });
  }

  /**
   * PATCH /pdv/caixa/master/sale/:id/seller
   * Body: { sellerName, motivo, password, keepItemOverrides? }
   * Troca a vendedora da venda inteira (e por padrao limpa overrides nos items).
   * Senha minima: GERENTE (comissao nao eh financeiro, eh operacional).
   */
  @Patch('master/sale/:id/seller')
  async masterUpdateSaleSeller(
    @Req() req: any,
    @Param('id') saleId: string,
    @Body() body: { sellerName: string; motivo: string; password: string; keepItemOverrides?: boolean },
  ) {
    this.requireMasterRole(req);
    const nivel = this.validateLevel(body?.password, 'GERENTE');
    const userName = req?.user?.name || req?.user?.email || req?.user?.username || 'admin';
    return this.svc.masterUpdateSaleSeller({
      saleId,
      novoSellerName: body?.sellerName,
      motivo: body?.motivo,
      keepItemOverrides: !!body?.keepItemOverrides,
      userName: `[${nivel}] ${userName}`,
    });
  }

  /**
   * PATCH /pdv/caixa/master/sale-item/:id/seller
   * Body: { sellerName, motivo, password }
   * Troca vendedora de UM item (override). sellerName=null limpa o override.
   */
  @Patch('master/sale-item/:id/seller')
  async masterUpdateItemSeller(
    @Req() req: any,
    @Param('id') itemId: string,
    @Body() body: { sellerName: string | null; motivo: string; password: string },
  ) {
    this.requireMasterRole(req);
    const nivel = this.validateLevel(body?.password, 'GERENTE');
    const userName = req?.user?.name || req?.user?.email || req?.user?.username || 'admin';
    return this.svc.masterUpdateItemSeller({
      itemId,
      novoSellerName: body?.sellerName ?? null,
      motivo: body?.motivo,
      userName: `[${nivel}] ${userName}`,
    });
  }

  /**
   * PATCH /pdv/caixa/master/payment/:id
   * Body: { method?, valor?, bandeira?, motivo, password }
   * Edita pagamento — troca metodo (dinheiro->pix), valor, ou bandeira.
   * Audit + recalculo da sessao se ja fechou.
   */
  @Patch('master/payment/:id')
  async masterEditPayment(
    @Req() req: any,
    @Param('id') paymentId: string,
    @Body() body: {
      method?: string;
      valor?: number;
      bandeira?: string;
      motivo: string;
      password: string;
    },
  ) {
    this.requireMasterRole(req);
    const nivel = this.validateLevel(body?.password, 'MASTER');
    const userName = req?.user?.name || req?.user?.email || req?.user?.username || 'admin';
    return this.svc.masterEditPayment({
      paymentId,
      novoMethod: body?.method,
      novoValor: body?.valor != null ? Number(body.valor) : undefined,
      novaBandeira: body?.bandeira,
      motivo: body?.motivo,
      userName: `[${nivel}] ${userName}`,
    });
  }

  /**
   * PATCH /pdv/caixa/payments/:paymentId/bandeira
   * Admin troca bandeira de um pagamento (ex: operadora errou MASTERCARD em vez de VISANET).
   * Atualiza Postgres + audit + Wincred (fechamento).
   * Body: { bandeira: 'VISANET', reason?: 'operadora errou' }
   */
  @Patch('payments/:paymentId/bandeira')
  async updatePaymentBandeira(
    @Req() req: any,
    @Param('paymentId') paymentId: string,
    @Body() body: { bandeira: string; reason?: string },
  ) {
    if (req?.user?.role !== 'admin') {
      throw new ForbiddenException('Apenas admin pode editar bandeira');
    }
    return this.svc.updatePaymentBandeira(
      paymentId,
      body?.bandeira,
      body?.reason,
      req?.user,
    );
  }
}

