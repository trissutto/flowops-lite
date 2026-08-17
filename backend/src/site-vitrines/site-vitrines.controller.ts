import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { AdminOnly, AdminOnlyGuard } from '../auth/admin-only.guard';
import { SiteVitrinesService, VitrineInput } from './site-vitrines.service';

/**
 * PÚBLICO — as vitrines da home, na ordem, já com as peças dentro.
 *
 * Uma requisição no lugar das seis que a home fazia (uma por carrossel). Sem
 * token, como o resto de /public/loja.
 */
@Controller('public/loja/home-vitrines')
export class SiteVitrinesPublicController {
  constructor(private readonly svc: SiteVitrinesService) {}

  @Get()
  listar() {
    return this.svc.listarPublico();
  }
}

/**
 * RETAGUARDA — /retaguarda/vitrines-home. Admin only: mexe na home do site.
 */
@Controller('site-vitrines')
@UseGuards(JwtAuthGuard, AdminOnlyGuard)
@AdminOnly()
export class SiteVitrinesController {
  constructor(private readonly svc: SiteVitrinesService) {}

  private usuario(req: any): string {
    return req?.user?.name || req?.user?.email || `user#${req?.user?.sub || '?'}`;
  }

  @Get()
  listar() {
    return this.svc.listarAdmin();
  }

  @Post()
  criar(@Body() body: VitrineInput, @Req() req: any) {
    return this.svc.criar(body, this.usuario(req));
  }

  /**
   * A LISTA INTEIRA de ids na ordem final — ver `reordenar` no service.
   * Vem antes do `:id` porque o Nest casa as rotas na ordem de declaração e
   * `PATCH /site-vitrines/ordem` cairia no `PATCH :id`.
   */
  @Patch('ordem')
  reordenar(@Body() body: { ids: string[] }, @Req() req: any) {
    return this.svc.reordenar(body?.ids ?? [], this.usuario(req));
  }

  @Patch(':id')
  salvar(@Param('id') id: string, @Body() body: VitrineInput, @Req() req: any) {
    return this.svc.salvar(id, body, this.usuario(req));
  }

  @Delete(':id')
  remover(@Param('id') id: string) {
    return this.svc.remover(id);
  }
}
