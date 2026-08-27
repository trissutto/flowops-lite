import { Body, Controller, ForbiddenException, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { PecasExtraviadasService } from './pecas-extraviadas.service';

/**
 * Peças que alguma loja disse não ter achado.
 *
 * Leitura é aberta pra loja também (ela precisa ver o que está marcado na
 * arara dela). "Achei" idem: quem encontra a peça é quem está lá.
 */
@Controller('pecas-extraviadas')
@UseGuards(JwtAuthGuard)
export class PecasExtraviadasController {
  constructor(private readonly svc: PecasExtraviadasService) {}

  private exigirLogin(req: any) {
    const role = req?.user?.role;
    if (!['admin', 'operator', 'supervisor', 'store'].includes(role)) {
      throw new ForbiddenException('Sem permissão');
    }
  }

  /** As abertas — `?skus=a,b,c` filtra (é o que a tela do pedido usa). */
  @Get()
  listar(@Req() req: any, @Query('skus') skus?: string, @Query('loja') loja?: string, @Query('todas') todas?: string) {
    this.exigirLogin(req);
    if (skus) return this.svc.abertasPorSkus(skus.split(',').map((s) => s.trim()).filter(Boolean));
    return this.svc.listar({ incluirAchadas: todas === '1', storeCode: loja || undefined });
  }

  /** "Achei a peça" — volta a valer no roteamento. */
  @Post(':id/achei')
  achei(@Req() req: any, @Param('id') id: string) {
    this.exigirLogin(req);
    return this.svc.marcarAchada(id, req?.user?.userId ?? req?.user?.id ?? null);
  }

  /** "Achei" por loja+SKU — caminho do conferidor, sem precisar do id da linha. */
  @Post('achei')
  acheiPorSku(@Req() req: any, @Body() body: { storeCode: string; sku: string }) {
    this.exigirLogin(req);
    return this.svc.marcarAchadaPorSku(
      body?.storeCode, body?.sku, req?.user?.userId ?? req?.user?.id ?? null,
    );
  }
}
