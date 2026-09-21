import { Body, Controller, ForbiddenException, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { VitaliciosService } from './vitalicios.service';

/**
 * /compras-vitalicios — a aba "Vitalícios" de PEDIDOS (21/09/2026).
 *
 * Rota própria (e não `/purchase-orders/vitalicios`) de propósito: o
 * `PurchaseOrdersController` tem `GET /purchase-orders/:id`, e o Express
 * casaria "vitalicios" como id de pedido — 404 "Pedido não encontrado".
 *
 * Mesmas permissões dos pedidos de compra: ler é de quem está logado;
 * marcar/desmarcar e gerar pedido é da retaguarda (admin, supervisor,
 * operator). O mínimo/ideal se edita pela rota que a matriz já usa
 * (`PUT /produto-ficha/reposicao`).
 */
@UseGuards(JwtAuthGuard)
@Controller('compras-vitalicios')
export class VitaliciosController {
  constructor(private readonly svc: VitaliciosService) {}

  private requireWrite(req: any) {
    const allowed = ['admin', 'supervisor', 'operator'];
    if (!allowed.includes(req?.user?.role)) throw new ForbiddenException('Sem permissão');
  }

  private quem(req: any): string {
    const u = req?.user || {};
    return String(u.name || u.email || u.sub || '').slice(0, 120);
  }

  /** GET /compras-vitalicios?marca=&busca= — as REFs vitalícias com a grade calculada. */
  @Get()
  listar(@Query('marca') marca?: string, @Query('busca') busca?: string) {
    return this.svc.listar({ marca, busca });
  }

  /** GET /compras-vitalicios/buscar?q= — pra "Adicionar vitalício". */
  @Get('buscar')
  buscar(@Query('q') q: string) {
    return this.svc.buscar(q);
  }

  /** GET /compras-vitalicios/status?ref=&marca= — o selo na ficha do produto. */
  @Get('status')
  status(@Query('ref') ref: string, @Query('marca') marca: string) {
    return this.svc.status(ref, marca);
  }

  @Post('marcar')
  marcar(@Req() req: any, @Body() body: { itens?: Array<{ ref?: string; marca?: string }> }) {
    this.requireWrite(req);
    return this.svc.marcar(body?.itens || [], this.quem(req));
  }

  @Post('desmarcar')
  desmarcar(@Req() req: any, @Body() body: { itens?: Array<{ ref?: string; marca?: string }> }) {
    this.requireWrite(req);
    return this.svc.desmarcar(body?.itens || [], this.quem(req));
  }

  /**
   * POST /compras-vitalicios/gerar-pedidos — UM pedido por marca, rascunho.
   * body: { itens: [{ ref, marca, cor, tamanhos: { "46": 3, … } }] }
   */
  @Post('gerar-pedidos')
  gerar(
    @Req() req: any,
    @Body() body: { itens?: Array<{ ref?: string; marca?: string; cor?: string; tamanhos?: Record<string, number> }> },
  ) {
    this.requireWrite(req);
    const userId = req?.user?.id || req?.user?.sub || null;
    return this.svc.gerarPedidos(body?.itens || [], userId, this.quem(req));
  }
}
