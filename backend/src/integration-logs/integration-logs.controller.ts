import {
  Controller, ForbiddenException, Get, NotFoundException, Param, ParseIntPipe, Query, Req, UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { IntegrationLogsService, ListIntegrationLogsFilters } from './integration-logs.service';

interface AuthUser {
  userId: string;
  email: string;
  role: string;
  storeId: string | null;
}

/**
 * Auditoria de integrações: baixas ERP, bipagens, publicações WC, etc.
 *
 * Todas as rotas são restritas a admin/operator (matriz). Loja não enxerga.
 *
 * Frontend /retaguarda/baixas-log consome esses endpoints pra investigar:
 *   - Se a baixa foi de verdade (event=debit.real.applied, status=200) ou só shadow
 *   - Por que uma baixa falhou (event=debit.real.failed + campo error)
 *   - Histórico de ações por loja/data
 */
@Controller('integration-logs')
@UseGuards(JwtAuthGuard)
export class IntegrationLogsController {
  constructor(private readonly svc: IntegrationLogsService) {}

  private ensureAdmin(req: any) {
    const user = req.user as AuthUser;
    if (user.role !== 'admin' && user.role !== 'operator') {
      throw new ForbiddenException('Apenas matriz (admin/operator) acessa auditoria de integrações');
    }
  }

  @Get()
  list(
    @Req() req: any,
    @Query('source') source?: string,
    @Query('event') event?: string,
    @Query('eventPrefix') eventPrefix?: string,
    @Query('status') status?: 'success' | 'failed' | 'all',
    @Query('storeCode') storeCode?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    this.ensureAdmin(req);
    const filters: ListIntegrationLogsFilters = {
      source,
      event,
      eventPrefix,
      status,
      storeCode,
      from,
      to,
      q,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    };
    return this.svc.list(filters);
  }

  @Get('events')
  events(@Req() req: any) {
    this.ensureAdmin(req);
    return this.svc.listDistinctEvents();
  }

  @Get('stats')
  stats(@Req() req: any, @Query('eventPrefix') eventPrefix?: string) {
    this.ensureAdmin(req);
    return this.svc.stats({ eventPrefix });
  }

  @Get(':id')
  async findOne(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    this.ensureAdmin(req);
    const row = await this.svc.findOne(id);
    if (!row) throw new NotFoundException('Log não encontrado');
    return row;
  }
}
