import { Controller, ForbiddenException, Get, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { MaisEnviosService } from './mais-envios.service';

@Controller('mais-envios')
@UseGuards(JwtAuthGuard)
export class MaisEnviosController {
  constructor(private readonly svc: MaisEnviosService) {}

  private requireRole(req: any) {
    const role = req?.user?.role;
    if (!['admin', 'operator', 'store'].includes(role)) {
      throw new ForbiddenException('Sem permissão');
    }
  }

  /** Status da integração (configurado? conta?). */
  @Get('status')
  status(@Req() req: any) {
    this.requireRole(req);
    return this.svc.status();
  }

  /** Frete (preço + prazo) por CEP destino. */
  @Get('frete')
  frete(
    @Req() req: any,
    @Query('cep') cep: string,
    @Query('peso') peso?: string,
    @Query('comprimento') comprimento?: string,
    @Query('largura') largura?: string,
    @Query('altura') altura?: string,
  ) {
    this.requireRole(req);
    return this.svc.calcularFrete({
      cepDestino: cep,
      pesoGramas: peso ? Number(peso) : undefined,
      comprimento: comprimento ? Number(comprimento) : undefined,
      largura: largura ? Number(largura) : undefined,
      altura: altura ? Number(altura) : undefined,
    });
  }

  /** Descoberta da conta: serviços disponíveis (pega os códigos de service). */
  @Get('services')
  services(@Req() req: any) {
    this.requireRole(req);
    return this.svc.listarServices();
  }

  /** Descoberta da conta: remetentes/senders cadastrados (pega customer/cardpost). */
  @Get('senders')
  senders(@Req() req: any) {
    this.requireRole(req);
    return this.svc.listarSenders();
  }

  /** Rastreia um objeto pela tag/código. */
  @Get('rastreio')
  rastreio(@Req() req: any, @Query('codigo') codigo: string) {
    this.requireRole(req);
    return this.svc.rastrear(codigo);
  }
}
