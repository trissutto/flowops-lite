import { Controller, ForbiddenException, Get, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { resolvePdvSummaryStoreCode } from './store-summary.controller';
import { normalizePdvSummaryStoreCode } from './store-summary.service';
import { MetasService } from './metas.service';

/**
 * /pdv/metas — gamificação de vendas no balcão (dono, 29/08/2026).
 *
 *  GET /pdv/metas                → meta do mês da loja (= mesmo mês do ano
 *                                  anterior), quebrada por vendedora e por dia
 *                                  de venda, com o realizado em tempo real.
 *  GET /pdv/metas/ranking        → quanto cada loja COLABOROU com as vendas
 *                                  globais da rede nos últimos 30 dias —
 *                                  participação em % (soma = 100). Só %: a
 *                                  vendedora vê a fatia de cada loja sem ver
 *                                  o faturamento em reais de nenhuma.
 *
 * `store` só enxerga a própria loja (mesma regra do /pdv/store-summary);
 * admin passa `?storeCode=`. O ranking é da rede inteira de propósito.
 */
@UseGuards(JwtAuthGuard)
@Controller('pdv')
export class MetasController {
  constructor(private readonly metas: MetasService) {}

  @Get('metas')
  getMetas(@Req() req: any, @Query('storeCode') storeCode?: string) {
    const effectiveStoreCode = resolvePdvSummaryStoreCode(req?.user, storeCode);
    return this.metas.getMetas(effectiveStoreCode);
  }

  @Get('metas/ranking')
  getRanking(@Req() req: any) {
    const role = String(req?.user?.role || '');
    if (role !== 'store' && role !== 'admin') {
      throw new ForbiddenException('Apenas admin ou loja');
    }
    const minha = normalizePdvSummaryStoreCode(req?.user?.storeCode);
    return this.metas.getRanking(minha || null);
  }
}
