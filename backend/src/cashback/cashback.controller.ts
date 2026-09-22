import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { AdminOnly, AdminOnlyGuard } from '../auth/admin-only.guard';
import { CashbackService } from './cashback.service';
import { CashbackPreviaService } from './cashback-previa.service';
import { CashbackMigracaoService } from './cashback-migracao.service';

/**
 * Rotas do cashback da rede.
 *
 *   GET  /cashback/config                 → configuração atual (inclui ativo)
 *   POST /cashback/config                 → salva; é aqui que o botão LIGAR bate
 *   GET  /cashback/previa?dias=30         → quanto custaria, sobre venda real
 *   GET  /cashback/extrato                → o que já foi creditado
 *   GET  /cashback/saldo/:cpf             → saldo de uma pessoa
 *   GET  /cashback/pode-usar/:cpf?total=  → quanto dá pra abater nesta compra
 *
 * Não há rota que CREDITE por fora: crédito nasce de venda ou de parcela paga,
 * pelos pontos de integração. Endpoint de crédito manual viraria porta pra
 * saldo aparecer sem lastro.
 */
@UseGuards(JwtAuthGuard)
@Controller('cashback')
export class CashbackController {
  constructor(
    private readonly svc: CashbackService,
    private readonly previa: CashbackPreviaService,
    private readonly migracao: CashbackMigracaoService,
  ) {}

  @Get('config')
  config() {
    return this.svc.config();
  }

  @Post('config')
  @UseGuards(AdminOnlyGuard)
  @AdminOnly()
  salvarConfig(@Body() body: any, @Req() req: any) {
    const usuario = req?.user?.email || req?.user?.id || 'desconhecido';
    return this.svc.salvarConfig(body || {}, usuario);
  }

  @Get('previa')
  @UseGuards(AdminOnlyGuard)
  @AdminOnly()
  verPrevia(@Query('dias') dias?: string) {
    return this.previa.previa(Number(dias) || 30);
  }

  @Get('extrato')
  @UseGuards(AdminOnlyGuard)
  @AdminOnly()
  extrato() {
    return this.previa.extrato();
  }

  /** Consultado pelo PDV com a cliente na frente — precisa ser rápido. */
  @Get('saldo/:cpf')
  saldo(@Param('cpf') cpf: string) {
    return this.svc.saldo(cpf);
  }

  /**
   * A MUDANÇA DE CASA DO SALDO ANTIGO — ver CashbackMigracaoService.
   *
   * A prévia mostra a conta ANTES: quantas pessoas, quanto em cada fonte, e
   * quanto sai somando × pegando o maior. O aplicar só roda por clique.
   */
  @Get('migracao/previa')
  @UseGuards(AdminOnlyGuard)
  @AdminOnly()
  migracaoPrevia() {
    return this.migracao.previa();
  }

  @Post('migracao/aplicar')
  @UseGuards(AdminOnlyGuard)
  @AdminOnly()
  migracaoAplicar(@Body() body: any, @Req() req: any) {
    return this.migracao.aplicar({
      modo: body?.modo === 'maior' ? 'maior' : 'soma',
      teto: Number(body?.teto) || 0,
      usuario: req?.user?.email || req?.user?.id || 'desconhecido',
    });
  }

  @Get('pode-usar/:cpf')
  podeUsar(@Param('cpf') cpf: string, @Query('total') total?: string) {
    return this.svc.quantoPodeUsar(cpf, Number(total) || 0);
  }
}
