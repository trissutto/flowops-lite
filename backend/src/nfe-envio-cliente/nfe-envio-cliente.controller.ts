import { Body, Controller, ForbiddenException, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { NfeEnvioClienteService } from './nfe-envio-cliente.service';

/**
 * ENVIO DA NOTA FISCAL PRA CLIENTE — porta MANUAL.
 *
 * 🚨 Enquanto `NFE_ENVIO_CLIENTE≠1`, estes endpoints NÃO enviam: devolvem o
 * que sairia (`resultado: 'simulado'`), com o PDF já gerado e conferido. É de
 * propósito — dá pra testar em produção sem tocar em cliente nenhuma.
 *
 * Só matriz manda nota: uma nota errada na caixa de entrada da cliente não
 * tem "desfazer", então a loja não decide isso sozinha.
 */
@Controller('nfe-envio-cliente')
@UseGuards(JwtAuthGuard)
export class NfeEnvioClienteController {
  constructor(private readonly svc: NfeEnvioClienteService) {}

  private exigirMatriz(req: any) {
    const role = req?.user?.role;
    if (!['admin', 'operator', 'supervisor'].includes(role)) {
      throw new ForbiddenException('Só a matriz envia nota fiscal pra cliente');
    }
  }

  /** Manda (ou simula) a nota do envio de um card. */
  @Post('card/:pickOrderId')
  enviarCard(
    @Req() req: any,
    @Param('pickOrderId') pickOrderId: string,
    @Body() body: { force?: boolean; email?: string } = {},
  ) {
    this.exigirMatriz(req);
    return this.svc.enviarPorCard(pickOrderId, {
      force: !!body?.force,
      userId: req?.user?.userId ?? req?.user?.id ?? null,
      emailOverride: body?.email,
    });
  }

  /** Manda (ou simula) a nota de todos os envios despachados do pedido. */
  @Post('pedido/:orderId')
  enviarPedido(
    @Req() req: any,
    @Param('orderId') orderId: string,
    @Body() body: { force?: boolean } = {},
  ) {
    this.exigirMatriz(req);
    return this.svc.enviarPorPedido(orderId, {
      force: !!body?.force,
      userId: req?.user?.userId ?? req?.user?.id ?? null,
    });
  }

  /** O que já foi enviado desta nota. */
  @Get('historico')
  historico(@Req() req: any, @Query('nfeDocId') nfeDocId: string) {
    this.exigirMatriz(req);
    return this.svc.historico(nfeDocId);
  }

  /** Estado do módulo — a tela usa pra dizer "desligado" em vez de fingir. */
  @Get('status')
  status(@Req() req: any) {
    this.exigirMatriz(req);
    return {
      ligado: String(process.env.NFE_ENVIO_CLIENTE || '').trim() === '1',
      flag: 'NFE_ENVIO_CLIENTE',
      observacao:
        'Desligado: os endpoints devolvem o que sairia (resultado "simulado"), sem mandar e-mail pra ninguém.',
    };
  }
}
