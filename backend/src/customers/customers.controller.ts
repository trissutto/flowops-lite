import { Controller, Get, HttpCode, NotFoundException, Param, Post, Query, UseGuards } from '@nestjs/common';
import { CustomersService, CustomersQuery } from './customers.service';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { AdminOnly, AdminOnlyGuard } from '../auth/admin-only.guard';

@Controller('customers')
@UseGuards(JwtAuthGuard, AdminOnlyGuard)
@AdminOnly()
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  // === SYNC HISTÓRICO WOOCOMMERCE ===
  // Rotas específicas ANTES das rotas parametrizadas (/:email) pra não colidir.

  @Get('sync/status')
  syncStatus() {
    return this.customers.getSyncState();
  }

  @Post('sync')
  @HttpCode(202)
  startSync() {
    const started = this.customers.startSync();
    return {
      started,
      message: started
        ? 'Sincronização iniciada em background. Consulte /customers/sync/status pra progresso.'
        : 'Sincronização já em andamento. Consulte /customers/sync/status.',
      state: this.customers.getSyncState(),
    };
  }

  @Get()
  list(
    @Query('search') search?: string,
    @Query('orderBy') orderBy?: CustomersQuery['orderBy'],
    @Query('order') order?: CustomersQuery['order'],
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.customers.list({
      search,
      orderBy,
      order,
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Get(':email')
  async detail(@Param('email') email: string) {
    // email vem URL-encoded
    const decoded = decodeURIComponent(email);
    const data = await this.customers.getByEmail(decoded);
    if (!data) throw new NotFoundException('Cliente não encontrado');
    return data;
  }
}
