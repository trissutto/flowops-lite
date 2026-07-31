import { Body, Controller, ForbiddenException, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { StockConferidorService } from './stock-conferidor.service';

/**
 * CONFERIDOR DE ESTOQUE FLOW × GIGA — só ADMIN.
 * A conferência lê a tabela `estoque` inteira do Giga (pesada): não é pra ficar
 * chamando em loop, e a tela só dispara no clique.
 */
@Controller('stock-conferidor')
@UseGuards(JwtAuthGuard)
export class StockConferidorController {
  constructor(private readonly svc: StockConferidorService) {}

  private requireAdmin(req: any) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
  }

  /** GET /stock-conferidor/conferir?loja=&filtro=&minDiferenca=&limite= */
  @Get('conferir')
  async conferir(
    @Req() req: any,
    @Query('loja') loja?: string,
    @Query('filtro') filtro?: string,
    @Query('minDiferenca') minDiferenca?: string,
    @Query('limite') limite?: string,
  ) {
    this.requireAdmin(req);
    return this.svc.conferir({
      loja: loja || undefined,
      filtro: filtro || undefined,
      minDiferenca: Number(minDiferenca) || undefined,
      limite: Number(limite) || undefined,
    });
  }

  /** GET /stock-conferidor/historico?codigo=&loja= — o porquê da divergência. */
  @Get('historico')
  async historico(@Req() req: any, @Query('codigo') codigo?: string, @Query('loja') loja?: string) {
    this.requireAdmin(req);
    return this.svc.historico(String(codigo || ''), String(loja || ''));
  }

  /**
   * POST /stock-conferidor/importar-negativos { loja?, simular? }
   * Traz de uma vez o passivo negativo que o Giga tem e o Flow nunca viu.
   */
  @Post('importar-negativos')
  async importarNegativos(@Req() req: any, @Body() body: { loja?: string; simular?: boolean }) {
    this.requireAdmin(req);
    return this.svc.importarNegativos({
      loja: body?.loja || undefined,
      simular: !!body?.simular,
      userName: req?.user?.name || req?.user?.email || null,
    });
  }

  /** POST /stock-conferidor/puxar-giga { codigo, loja } */
  @Post('puxar-giga')
  async puxarGiga(@Req() req: any, @Body() body: { codigo?: string; loja?: string }) {
    this.requireAdmin(req);
    return this.svc.puxarDoGiga({
      codigo: String(body?.codigo || ''),
      loja: String(body?.loja || ''),
      userName: req?.user?.name || req?.user?.email || null,
    });
  }
}
