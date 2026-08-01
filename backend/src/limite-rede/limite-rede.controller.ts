import { Body, Controller, ForbiddenException, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { LimiteRedeService } from './limite-rede.service';

/**
 * Análise e interruptor do LIMITE ÚNICO DA REDE.
 *
 * A tela mostra quem seria travado ANTES de o bloqueio valer, deixa ajustar
 * limite caso a caso, e só então liga. Por isso o interruptor está aqui e não
 * numa env: ligar é decisão com a lista na mão, não deploy.
 */
@Controller('admin/limite-rede')
@UseGuards(JwtAuthGuard)
export class LimiteRedeController {
  constructor(private readonly svc: LimiteRedeService) {}

  private requireAdmin(req: any) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
  }

  /** A prévia: quem seria travado se ligasse agora. */
  @Get('previa')
  previa(@Req() req: any) {
    this.requireAdmin(req);
    return this.svc.previa();
  }

  /** Exposição de uma pessoa — usada também pelo PDV pra explicar a recusa. */
  @Get('pessoa')
  pessoa(@Req() req: any, @Query('cpf') cpf: string) {
    this.requireAdmin(req);
    return this.svc.daPessoa(cpf);
  }

  @Post('ajustar-limite')
  ajustar(@Req() req: any, @Body() body: { cpf: string; limite: number }) {
    this.requireAdmin(req);
    return this.svc.ajustarLimite(body?.cpf, body?.limite, req?.user?.name || req?.user?.email);
  }

  /**
   * LIGA/DESLIGA o bloqueio. Vale na hora, sem deploy.
   *
   * Ligar tira do crediário e do marcado toda cliente acima do limite — 204
   * pessoas na medição de 01/08. Por isso exige confirmação explícita no corpo:
   * não dá pra ligar por engano num clique perdido.
   */
  @Post('ativar')
  ativar(@Req() req: any, @Body() body: { ativo: boolean; confirmo?: boolean }) {
    this.requireAdmin(req);
    if (body?.ativo && !body?.confirmo) {
      throw new ForbiddenException(
        'Ligar o bloqueio exige confirmação — revise a lista de travadas antes.',
      );
    }
    return this.svc.definirAtivo(!!body?.ativo, req?.user?.name || req?.user?.email);
  }
}
