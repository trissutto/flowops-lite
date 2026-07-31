import {
  Controller, ForbiddenException, Get, Query, Req, UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { FranquiasService } from './franquias.service';

/**
 * PORTAL DE FRANQUIAS — números das lojas FILIAL (Fases 1 e 2, 15/07).
 *
 * Papéis: 'franquias' (read-only), 'master_franquia' e 'admin'.
 * O escopo FILIAL é imposto no service — nenhum endpoint aceita lista de
 * lojas de fora; no máximo um FILTRO pra UMA loja, revalidado contra as
 * FILIAIS. Só agregados de venda/estoque — fundo/sangria continuam restritos
 * ao super-painel (master_franquia/admin).
 */
@Controller('franquias')
@UseGuards(JwtAuthGuard)
export class FranquiasController {
  constructor(private readonly svc: FranquiasService) {}

  private requireFranquia(req: any) {
    const role = req?.user?.role;
    if (role !== 'franquias' && role !== 'master_franquia' && role !== 'admin') {
      throw new ForbiddenException('Acesso restrito ao portal de franquias');
    }
  }

  @Get('lojas')
  lojas(@Req() req: any) {
    this.requireFranquia(req);
    return this.svc.lojasFilial();
  }

  /** GET /franquias/faturamento?de=YYYY-MM-DD&ate=YYYY-MM-DD&loja=01 */
  @Get('faturamento')
  faturamento(
    @Req() req: any,
    @Query('de') de?: string,
    @Query('ate') ate?: string,
    @Query('loja') loja?: string,
  ) {
    this.requireFranquia(req);
    return this.svc.faturamento(String(de || ''), String(ate || ''), loja || undefined);
  }

  /** GET /franquias/mais-vendidos?de&ate&loja */
  @Get('mais-vendidos')
  maisVendidos(
    @Req() req: any,
    @Query('de') de?: string,
    @Query('ate') ate?: string,
    @Query('loja') loja?: string,
  ) {
    this.requireFranquia(req);
    return this.svc.maisVendidos(String(de || ''), String(ate || ''), loja || undefined);
  }

  /** GET /franquias/estoque — peças + valor (preço de venda) por loja e grupos. */
  @Get('estoque')
  estoque(@Req() req: any) {
    this.requireFranquia(req);
    return this.svc.estoque();
  }

  /** GET /franquias/estoque/busca?term= — produto com estoque por loja FILIAL. */
  @Get('estoque/busca')
  estoqueBusca(@Req() req: any, @Query('term') term?: string) {
    this.requireFranquia(req);
    return this.svc.estoqueBusca(String(term || ''));
  }
}
