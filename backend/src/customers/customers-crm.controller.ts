import {
  Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards,
} from '@nestjs/common';
import {
  CustomersCrmService,
  CreateCustomerDto,
  UpdateCustomerDto,
  CreateAddressDto,
  ConsentDto,
  CreditCashbackDto,
  RedeemCashbackDto,
  ListQuery,
} from './customers-crm.service';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { AdminOnly, AdminOnlyGuard } from '../auth/admin-only.guard';

/**
 * Rotas do CRM real (model Customer no banco).
 * Coexiste com /customers (antigo, agrega via Order) até o ETL completar.
 */
@Controller('customers-crm')
@UseGuards(JwtAuthGuard, AdminOnlyGuard)
@AdminOnly()
export class CustomersCrmController {
  constructor(private readonly svc: CustomersCrmService) {}

  // ─── Listagem ─────────────────────────────────────────────────────────────
  @Get()
  list(
    @Query('search') search?: string,
    @Query('tier') tier?: string,
    @Query('rfvSegment') rfvSegment?: string,
    @Query('storeId') storeId?: string,
    @Query('hasWhatsapp') hasWhatsapp?: string,
    @Query('hasCashbackBalance') hasCashbackBalance?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('orderBy') orderBy?: ListQuery['orderBy'],
    @Query('order') order?: ListQuery['order'],
  ) {
    return this.svc.list({
      search,
      tier,
      rfvSegment,
      storeId,
      hasWhatsapp: hasWhatsapp === 'true',
      hasCashbackBalance: hasCashbackBalance === 'true',
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      orderBy,
      order,
    });
  }

  // ─── Tags ─ENDPOINTS ESPECÍFICOS antes de /:id ───────────────────────────
  @Get('tags')
  listTags() {
    return this.svc.listTags();
  }

  @Post('tags')
  createTag(@Body() body: { name: string; description?: string; color?: string }) {
    return this.svc.createTag(body.name, body.description, body.color);
  }

  // ─── CRUD principal ──────────────────────────────────────────────────────
  @Post()
  create(@Body() dto: CreateCustomerDto) {
    return this.svc.create(dto);
  }

  @Get(':id')
  detail(@Param('id') id: string) {
    return this.svc.detail(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateCustomerDto) {
    return this.svc.update(id, dto);
  }

  // ─── Endereços ───────────────────────────────────────────────────────────
  @Post(':id/addresses')
  addAddress(@Param('id') id: string, @Body() dto: CreateAddressDto) {
    return this.svc.addAddress(id, dto);
  }

  // ─── Consentimentos LGPD ─────────────────────────────────────────────────
  @Post(':id/consents')
  registerConsent(@Param('id') id: string, @Body() dto: ConsentDto) {
    return this.svc.registerConsent(id, dto);
  }

  // ─── Cashback ────────────────────────────────────────────────────────────
  @Post(':id/cashback/credit')
  creditCashback(@Param('id') id: string, @Body() dto: CreditCashbackDto) {
    return this.svc.creditCashback(id, dto);
  }

  @Post(':id/cashback/redeem')
  redeemCashback(@Param('id') id: string, @Body() dto: RedeemCashbackDto) {
    return this.svc.redeemCashback(id, dto);
  }

  // ─── Tags de um cliente ──────────────────────────────────────────────────
  @Post(':id/tags/:tagId')
  applyTag(
    @Param('id') id: string,
    @Param('tagId') tagId: string,
    @Body() body: { appliedBy?: string } = {},
  ) {
    return this.svc.applyTag(id, tagId, body.appliedBy);
  }

  @Delete(':id/tags/:tagId')
  removeTag(@Param('id') id: string, @Param('tagId') tagId: string) {
    return this.svc.removeTag(id, tagId);
  }
}
