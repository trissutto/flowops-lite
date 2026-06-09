import { Controller, ForbiddenException, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { FaturamentoService } from './faturamento.service';
import { ErpService } from '../erp/erp.service';

/**
 * /faturamento — admin only. Tela de gráfico de faturamento por loja.
 */
@UseGuards(JwtAuthGuard)
@Controller('faturamento')
export class FaturamentoController {
  constructor(
    private readonly svc: FaturamentoService,
    private readonly erp: ErpService,
  ) {}

  private requireAdmin(req: any) {
    if (req?.user?.role !== 'admin' && req?.user?.role !== 'operator') {
      throw new ForbiddenException('Apenas admin/operator');
    }
  }

  /**
   * GET /faturamento/resumo?from=YYYY-MM-DD&to=YYYY-MM-DD&granularity=day|week|month
   *
   * Default: this month até hoje, day.
   */
  @Get('resumo')
  async resumo(
    @Req() req: any,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('granularity') granularity?: string,
  ) {
    this.requireAdmin(req);
    const today = new Date();
    const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const fmt = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    const f = from || fmt(firstOfMonth);
    const t = to || fmt(today);
    const g = (granularity === 'week' || granularity === 'month') ? granularity : 'day';
    return this.svc.getResumo(f, t, g);
  }

  /**
   * GET /faturamento/auditoria-paridade?from=YYYY-MM-DD&to=YYYY-MM-DD
   *
   * Compara Wincred (Giga) vs PdvSale (flowops) por loja+dia.
   * Detecta divergências em tempo real pra suportar migração 30/06.
   */
  @Get('auditoria-paridade')
  async auditoriaParidade(
    @Req() req: any,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    this.requireAdmin(req);
    const today = new Date();
    const fmt = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const f = from || fmt(today);
    const t = to || fmt(today);
    return this.svc.auditoriaParidade(f, t);
  }

  /**
   * GET /faturamento/loja/:storeCode/vendas?from=YYYY-MM-DD&to=YYYY-MM-DD
   *
   * Lista vendas DETALHADAS (PdvSale) da loja no período pra drill-down.
   * Usado pelo botão expandir na tabela /retaguarda/faturamento.
   * Retorna nº NFCe, hora, vendedora, cliente, total, forma pgto, status.
   */
  @Get('loja/:storeCode/vendas')
  async vendasPorLoja(
    @Req() req: any,
    @Param('storeCode') storeCode: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    this.requireAdmin(req);
    if (!from || !to) {
      return { error: 'from e to obrigatórios (YYYY-MM-DD)' };
    }
    return this.svc.getVendasDetalhadas(storeCode, from, to);
  }

  /**
   * GET /faturamento/schema-caixa?loja=ITANHAEM&from=YYYY-MM-DD&to=YYYY-MM-DD
   *
   * Lista colunas da tabela `caixa` + soma de cada coluna numérica.
   * Usado pra descobrir qual coluna bate com "TOTAL VENDAS R$" do Wincred.
   */
  @Get('schema-caixa')
  async schemaCaixa(
    @Req() req: any,
    @Query('loja') loja: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    this.requireAdmin(req);
    if (!loja || !from || !to) {
      return { error: 'loja, from e to obrigatórios (YYYY-MM-DD)' };
    }
    const dFim = new Date(to);
    dFim.setDate(dFim.getDate() + 1);
    const toExclusive = `${dFim.getFullYear()}-${String(dFim.getMonth() + 1).padStart(2, '0')}-${String(dFim.getDate()).padStart(2, '0')}`;
    return this.erp.getCaixaSchemaDiagnostic(loja.toUpperCase(), from, toExclusive);
  }

  /**
   * GET /faturamento/diagnostico?from=YYYY-MM-DD&to=YYYY-MM-DD&lojas=ITANHAEM,SOROCABA
   *
   * Roda query diagnóstica DIRETO no Giga MySQL pra debugar divergência
   * com Wincred. Quebra por LOJA com contagens de cada categoria de MARCADO,
   * linhas negativas, e 2 variações de soma com filtros diferentes.
   *
   * Uso temporário — pode remover quando alinhar as queries.
   */
  @Get('diagnostico')
  async diagnostico(
    @Req() req: any,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('lojas') lojas?: string,
  ) {
    this.requireAdmin(req);
    if (!from || !to) {
      return { error: 'from e to obrigatórios (YYYY-MM-DD)' };
    }
    // Soma 1 dia no `to` (fim exclusivo)
    const dFim = new Date(to);
    dFim.setDate(dFim.getDate() + 1);
    const toExclusive = `${dFim.getFullYear()}-${String(dFim.getMonth() + 1).padStart(2, '0')}-${String(dFim.getDate()).padStart(2, '0')}`;
    const lojasList = lojas
      ? lojas.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
      : null;
    return this.erp.diagnosticoFaturamento(from, toExclusive, lojasList);
  }
}
