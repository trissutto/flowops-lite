import {
  Controller, ForbiddenException, Get, Query, Req, UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { ProdutosVendidosService, ProdutosVendidosFilters } from './produtos-vendidos.service';

/**
 * GET /pdv/produtos-vendidos
 *
 * Relatório de produtos vendidos + trocas (negativas em vermelho).
 *
 * Scope: vendedora (role=store) vê só os produtos da loja dela.
 *        Matriz (admin/operator/supervisor) vê todas as lojas.
 */
@Controller('pdv')
@UseGuards(JwtAuthGuard)
export class ProdutosVendidosController {
  constructor(private readonly svc: ProdutosVendidosService) {}

  @Get('produtos-vendidos')
  async getProdutosVendidos(
    @Req() req: any,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('storeCode') storeCode?: string,
    @Query('sellerName') sellerName?: string,
    @Query('sku') sku?: string,
    @Query('customerCpf') customerCpf?: string,
    @Query('customerName') customerName?: string,
    @Query('includeReturns') includeReturns?: string,
  ) {
    const role = req?.user?.role;
    const userStoreCode = req?.user?.storeCode;

    // SCOPE: se for vendedora (não matriz), força filtro da loja dela
    let effectiveStoreCode = storeCode;
    if (role === 'store') {
      if (!userStoreCode) {
        throw new ForbiddenException('Usuário sem loja vinculada');
      }
      effectiveStoreCode = userStoreCode;
    }

    const filters: ProdutosVendidosFilters = {
      from: from?.trim() || undefined,
      to: to?.trim() || undefined,
      storeCode: effectiveStoreCode?.trim() || undefined,
      sellerName: sellerName?.trim() || undefined,
      sku: sku?.trim() || undefined,
      customerCpf: customerCpf?.trim() || undefined,
      customerName: customerName?.trim() || undefined,
      includeReturns: includeReturns !== 'false',
    };

    return this.svc.getReport(filters);
  }
}
