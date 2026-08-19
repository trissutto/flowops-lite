import {
  Body, Controller, Get, Param, Post, Query, Req, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { AvaliacoesFotosService } from '../avaliacoes/avaliacoes-fotos.service';
import { PosVendaService } from './pos-venda.service';

/**
 * A ABA "PÓS-VENDA" DA TELA DE SEPARAÇÃO — o funil depois da entrega.
 *
 * Entregue → convidada → abriu → avaliou. A moderação e a régua de pontos
 * moram em `/retaguarda/avaliacoes`; aqui é o toque na cliente.
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

  /** GET /pos-venda/resumo — só o número do badge (bate a cada 30s). */
  @Get('resumo')
  resumo() {
    return this.svc.resumoDoBadge();
  }

  /**
   * POST /pos-venda/convites/:orderId — chama a cliente AGORA.
   *
   * O botão manual existe pro caso em que o cron não alcança: entrega antiga,
   * pedido sem telefone que a loja acabou de completar, cliente que pediu o
   * link no WhatsApp.
   */
  @Post('convites/:orderId')
  async convidar(@Param('orderId') orderId: string) {
    const convite = await this.svc.criarConvite(orderId);
    const ok = await this.svc.enviarConvite(convite.id, 'manual');
    return { ok, conviteId: convite.id, link: this.svc.linkDoConvite(convite.token) };
  }

  /** POST /pos-venda/convites/:id/reenviar — insistir uma vez mais. */
  @Post('convites/:id/reenviar')
  async reenviar(@Param('id') id: string) {
    return { ok: await this.svc.enviarConvite(id, 'manual') };
  }
}

/**
 * O QUE O LINK DO WHATSAPP ABRE — sem guard, de propósito.
 *
 * A credencial é o TOKEN do convite: ele chega no WhatsApp dela e vale só
 * aquele pedido. Parede de senha na frente de um pedido de favor é o jeito
 * mais rápido de não receber resposta — e a maioria compra como visitante,
 * então "faça login" ali seria "desista".
 */
@Controller('public/avaliar')
export class AvaliarTokenController {
  constructor(
    private readonly svc: PosVendaService,
    private readonly fotos: AvaliacoesFotosService,
  ) {}

  /** GET /public/avaliar/:token — o mesmo centro de avaliação, sem login. */
  @Get(':token')
  abrir(@Param('token') token: string) {
    return this.svc.porToken(token);
  }

  /** POST /public/avaliar/:token — envia (ou corrige) a avaliação de uma peça. */
  @Post(':token')
  registrar(@Param('token') token: string, @Body() body: any) {
    return this.svc.registrarPorToken(token, body || {});
  }

  /**
   * POST /public/avaliar/:token/foto — sobe UMA foto e devolve a URL.
   *
   * Mesmo caminho do centro de avaliação (`AvaliacoesFotosService`): o que muda
   * é só quem prova a identidade — aqui, o token do convite.
   */
  @Post(':token/foto')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 8 * 1024 * 1024 } }))
  async foto(@Param('token') token: string, @UploadedFile() file: any) {
    const accountId = await this.svc.contaPorToken(token);
    return this.fotos.upload(accountId, file);
  }
}
