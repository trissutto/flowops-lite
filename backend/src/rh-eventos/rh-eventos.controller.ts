import {
  Body,
  Controller,
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
import { RhEventosService } from './rh-eventos.service';

/**
 * /rh/eventos — atestado, falta, férias, treinamento, advertência.
 *
 * QUEM LANÇA É A SUPERVISÃO (decisão do dono, 28/08/2026): matriz apenas —
 * `admin`, `operator`, `supervisor`. Não há pedir/aprovar; lançou, vale.
 *
 * A LOJA (`role=store`) só LÊ, e só a própria loja: a gerente precisa saber
 * quem está de atestado hoje pra montar a escala, mas não lança nada — evento
 * de RH mexe em folha e em prova trabalhista.
 *
 *   GET   /rh/eventos/tipos                    lista fechada pro seletor
 *   GET   /rh/eventos?sellerId=&de=&ate=       lista com recorte De/Até
 *   GET   /rh/eventos/hoje?storeId=            quem está fora hoje
 *   POST  /rh/eventos                          lança (supervisão)
 *   PATCH /rh/eventos/:id                      corrige período/horas
 *   POST  /rh/eventos/:id/cancelar             cancela (nunca deleta)
 */
@UseGuards(JwtAuthGuard)
@Controller('rh/eventos')
export class RhEventosController {
  constructor(private readonly svc: RhEventosService) {}

  private user(req: any) {
    return {
      id: req?.user?.id || req?.user?.sub || null,
      nome: req?.user?.name || req?.user?.email || null,
      role: String(req?.user?.role || ''),
      storeId: req?.user?.storeId || null,
    };
  }

  /** Só matriz lança/edita/cancela. */
  private assertSupervisao(req: any) {
    const { role } = this.user(req);
    if (!['admin', 'operator', 'supervisor'].includes(role)) {
      throw new ForbiddenException(
        'Só a supervisão lança evento de RH. Fale com a matriz.',
      );
    }
  }

  @Get('tipos')
  tipos() {
    return this.svc.listarTipos();
  }

  @Get()
  listar(
    @Req() req: any,
    @Query('sellerId') sellerId?: string,
    @Query('storeId') storeId?: string,
    @Query('tipo') tipo?: string,
    @Query('de') de?: string,
    @Query('ate') ate?: string,
    @Query('incluirCancelados') incluirCancelados?: string,
  ) {
    const u = this.user(req);
    // A loja não escolhe a loja: vem do JWT. Sem isso uma gerente leria o
    // atestado da equipe inteira da rede.
    const escopo = u.role === 'store' ? u.storeId : storeId;
    if (u.role === 'store' && !escopo) {
      throw new ForbiddenException('Loja não identificada na sessão');
    }
    return this.svc.listar({
      sellerId,
      storeId: escopo || undefined,
      tipo,
      de,
      ate,
      incluirCancelados: incluirCancelados === '1',
    });
  }

  @Get('hoje')
  hoje(@Req() req: any, @Query('storeId') storeId?: string, @Query('data') data?: string) {
    const u = this.user(req);
    const escopo = u.role === 'store' ? u.storeId : storeId;
    if (u.role === 'store' && !escopo) {
      throw new ForbiddenException('Loja não identificada na sessão');
    }
    return this.svc.foraHoje(escopo || undefined, data);
  }

  @Post()
  criar(@Req() req: any, @Body() body: any) {
    this.assertSupervisao(req);
    const u = this.user(req);
    return this.svc.criar(body, { id: u.id, nome: u.nome });
  }

  @Patch(':id')
  editar(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    this.assertSupervisao(req);
    return this.svc.editar(id, body);
  }

  @Post(':id/cancelar')
  cancelar(@Req() req: any, @Param('id') id: string, @Body() body: { motivo?: string }) {
    this.assertSupervisao(req);
    const u = this.user(req);
    return this.svc.cancelar(id, String(body?.motivo || ''), { id: u.id });
  }
}
