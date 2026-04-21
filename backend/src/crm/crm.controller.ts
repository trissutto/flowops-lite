import {
  Body, Controller, ForbiddenException, Get, Param, Post, Query, Req, UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { CrmService, SegmentKey } from './crm.service';

interface AuthUser {
  userId: string;
  email: string;
  role: string;
  storeId: string | null;
}

function assertMatriz(user: AuthUser) {
  if (user.role !== 'admin' && user.role !== 'operator') {
    throw new ForbiddenException('Apenas matriz (admin/operator) acessa CRM');
  }
}

const VALID_SEGMENTS: SegmentKey[] = [
  'vip', 'em_risco', 'novos', 'inativos', 'one_shot', 'regulares',
];

@Controller('crm')
@UseGuards(JwtAuthGuard)
export class CrmController {
  constructor(private readonly svc: CrmService) {}

  /** Resumo de todos os segmentos — cards da tela. */
  @Get('segments')
  segments(@Req() req: any): Promise<any> {
    assertMatriz(req.user);
    return this.svc.getSegmentsSummary();
  }

  /** Lista clientes de um segmento específico. */
  @Get('segments/:segment')
  list(
    @Req() req: any,
    @Param('segment') segment: string,
    @Query('search') search?: string,
    @Query('orderBy') orderBy?: 'totalSpent' | 'orderCount' | 'lastOrder' | 'name',
    @Query('order') order?: 'asc' | 'desc',
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ): Promise<any> {
    assertMatriz(req.user);
    if (!VALID_SEGMENTS.includes(segment as SegmentKey)) {
      throw new ForbiddenException(`Segmento inválido: ${segment}`);
    }
    return this.svc.listBySegment(segment as SegmentKey, {
      search,
      orderBy,
      order,
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  /**
   * Lista personalizada — filtros combináveis (POST pra caber JSON grande).
   */
  @Post('custom')
  custom(@Req() req: any, @Body() filters: any): Promise<any> {
    assertMatriz(req.user);
    return this.svc.listCustom(filters ?? {});
  }
}
