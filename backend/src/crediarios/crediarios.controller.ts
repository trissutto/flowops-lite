import {
  BadRequestException, Controller, ForbiddenException, Get, Query, Req, UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { CrediariosService } from './crediarios.service';

interface AuthUser {
  userId: string;
  email: string;
  role: string;
  storeId: string | null;
}

/**
 * /crediarios — Cobrança de parcelas vencidas (matriz/operator only).
 *
 *   GET /crediarios/schema           — diagnose: SHOW COLUMNS + mapeamento
 *   GET /crediarios/vencidos?loja=01 — flat: lista de parcelas vencidas
 *   GET /crediarios/vencidos-clientes?loja=01 — agrupado por cliente
 */
@Controller('crediarios')
@UseGuards(JwtAuthGuard)
export class CrediariosController {
  constructor(private readonly svc: CrediariosService) {}

  private ensureMatriz(req: any) {
    const u = req.user as AuthUser;
    if (u.role !== 'admin' && u.role !== 'operator') {
      throw new ForbiddenException('Apenas matriz acessa cobrança');
    }
  }

  @Get('schema')
  async schema(@Req() req: any) {
    this.ensureMatriz(req);
    const map = await this.svc.detectColumns(true);
    return { columnMap: map };
  }

  @Get('vencidos')
  async vencidos(
    @Req() req: any,
    @Query('loja') loja?: string,
    @Query('daysBack') daysBack?: string,
    @Query('limit') limit?: string,
  ) {
    this.ensureMatriz(req);
    if (!loja) throw new BadRequestException('Parâmetro "loja" é obrigatório (ex: 01)');
    return this.svc.listOverdue({
      storeCode: loja,
      daysBack: daysBack ? Number(daysBack) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('vencidos-clientes')
  async vencidosClientes(
    @Req() req: any,
    @Query('loja') loja?: string,
    @Query('daysBack') daysBack?: string,
  ) {
    this.ensureMatriz(req);
    if (!loja) throw new BadRequestException('Parâmetro "loja" é obrigatório (ex: 01)');
    return this.svc.listOverdueByCustomer({
      storeCode: loja,
      daysBack: daysBack ? Number(daysBack) : undefined,
    });
  }
}
