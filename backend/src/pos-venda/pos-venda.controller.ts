import { BadRequestException, Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { PosVendaService } from './pos-venda.service';

/**
 * A ABA "PÓS-VENDA" DA TELA DE SEPARAÇÃO — a retaguarda do ciclo.
 *
 * Uma tela só pro que acontece DEPOIS da entrega: quem já pode ser chamado pra
 * avaliar, quem foi chamado e não respondeu, e o que está esperando aprovação
 * pra entrar na página do produto.
 *
 * Sem essa fila, "ninguém avalia" e "ninguém foi convidado" viram o mesmo
 * silêncio — e são problemas opostos (um é de mensagem, outro de produto).
 */
@Controller('pos-venda')
@UseGuards(JwtAuthGuard)
export class PosVendaController {
  constructor(private readonly svc: PosVendaService) {}

  /** GET /pos-venda?de=&ate=&situacao=&busca= — a fila da aba. */
  @Get()
  fila(
    @Query('de') de?: string,
    @Query('ate') ate?: string,
    @Query('situacao') situacao?: string,
    @Query('busca') busca?: string,
  ) {
    return this.svc.fila({ de, ate, situacao, busca });
  }

  /** GET /pos-venda/resumo — só os dois números do badge (bate a cada 30s). */
  @Get('resumo')
  resumo() {
    return this.svc.resumoDoBadge();
  }

  @Get('config')
  config() {
    return this.svc.lerConfig();
  }

  @Post('config')
  salvarConfig(@Req() req: any, @Body() body: any) {
    return this.svc.salvarConfig(body ?? {}, req?.user?.email ?? req?.user?.sub);
  }

  /**
   * POST /pos-venda/convites/:orderId — chama a cliente AGORA.
   *
   * O botão manual existe pro caso em que o cron não alcança: entrega antiga,
   * pedido sem telefone que a loja acabou de completar, cliente que pediu o
   * link no WhatsApp. Cria o convite se ainda não existir.
   */
  @Post('convites/:orderId')
  async convidar(@Param('orderId') orderId: string) {
    const convite = await this.svc.criarConvite(orderId);
    const ok = await this.svc.enviarConvite(convite.id, 'manual');
    return { ok, conviteId: convite.id, link: this.svc.linkDoConvite(convite.token) };
  }

  /** POST /pos-venda/convites/:id/reenviar — insistir, com teto. */
  @Post('convites/:id/reenviar')
  async reenviar(@Param('id') id: string) {
    const cfg = await this.svc.lerConfig();
    const ok = await this.svc.enviarConvite(id, 'manual');
    return { ok, maxReenvios: cfg.maxReenvios };
  }

  /** POST /pos-venda/avaliacoes/:id/moderar — { decisao: 'approved'|'rejected', motivo? } */
  @Post('avaliacoes/:id/moderar')
  moderar(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    const decisao = String(body?.decisao || '').trim();
    if (decisao !== 'approved' && decisao !== 'rejected') {
      throw new BadRequestException('decisao deve ser "approved" ou "rejected"');
    }
    return this.svc.moderar(id, decisao, {
      motivo: body?.motivo,
      quem: req?.user?.email ?? req?.user?.sub,
    });
  }

  /** POST /pos-venda/avaliacoes/moderar-lote — { ids: string[], decisao } */
  @Post('avaliacoes/moderar-lote')
  moderarLote(@Req() req: any, @Body() body: any) {
    const ids = Array.isArray(body?.ids) ? body.ids.map((i: any) => String(i)) : [];
    const decisao = String(body?.decisao || '').trim();
    if (!ids.length) throw new BadRequestException('Nenhuma avaliação selecionada');
    if (decisao !== 'approved' && decisao !== 'rejected') {
      throw new BadRequestException('decisao deve ser "approved" ou "rejected"');
    }
    return this.svc.moderarLote(ids, decisao, req?.user?.email ?? req?.user?.sub);
  }
}
