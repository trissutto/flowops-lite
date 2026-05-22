import {
  Body, Controller, Get, Param, Patch, Post, Query, UseGuards,
} from '@nestjs/common';
// @TODO_VALIDATE_VS_LOJA — caminho do guard pode ter mudado
import { JwtAuthGuard } from '../auth/jwt.guard';

import { LiveService } from './live.service';
import { ReservationService } from './reservation.service';
import { StartLiveDto } from './dto/start-live.dto';
import { CreateLiveDto } from './dto/create-live.dto';
import { AddProductDto } from './dto/add-product.dto';
import { SetCurrentProductDto } from './dto/set-current-product.dto';
import { ReserveDto } from './dto/reserve.dto';

/**
 * Controller principal do módulo LIVE OS.
 *
 * Endpoints autenticados (JWT). Painel master consome todos. Painel operacional
 * consome lista de reservas e GET de comments.
 *
 * @TODO_VALIDATE_VS_LOJA: confirmar que JwtAuthGuard ainda está em ../auth/jwt.guard
 */
@Controller('lives')
@UseGuards(JwtAuthGuard)
export class LiveController {
  constructor(
    private readonly liveService: LiveService,
    private readonly reservationService: ReservationService,
  ) {}

  // ─────────── Lifecycle da live ───────────

  @Post()
  async create(@Body() dto: CreateLiveDto) {
    return this.liveService.create(dto);
  }

  @Get()
  async list(@Query('status') status?: string) {
    return this.liveService.list(status);
  }

  @Get(':id')
  async detail(@Param('id') id: string) {
    return this.liveService.detail(id);
  }

  @Patch(':id/start')
  async start(@Param('id') id: string, @Body() dto: StartLiveDto) {
    return this.liveService.start(id, dto);
  }

  @Patch(':id/end')
  async end(@Param('id') id: string) {
    return this.liveService.end(id);
  }

  @Get(':id/stats')
  async stats(@Param('id') id: string) {
    return this.liveService.realtimeStats(id);
  }

  // ─────────── Produtos da live ───────────

  @Post(':id/products')
  async addProduct(@Param('id') id: string, @Body() dto: AddProductDto) {
    return this.liveService.addProduct(id, dto);
  }

  @Patch(':id/products/:pid/show')
  async setCurrent(
    @Param('id') id: string,
    @Param('pid') pid: string,
    @Body() dto: SetCurrentProductDto,
  ) {
    return this.liveService.setCurrentProduct(id, pid, dto);
  }

  @Get(':id/products')
  async listProducts(@Param('id') id: string) {
    return this.liveService.listProducts(id);
  }

  // ─────────── IA toggle ───────────

  @Patch(':id/ai')
  async toggleAi(
    @Param('id') id: string,
    @Body() body: { enabled: boolean },
  ) {
    return this.liveService.setAiEnabled(id, body.enabled);
  }

  // ─────────── Comentários (leitura) ───────────

  @Get(':id/comments')
  async listComments(
    @Param('id') id: string,
    @Query('intent') intent?: string,
    @Query('limit') limit?: string,
  ) {
    return this.liveService.listComments(id, {
      intent,
      limit: limit ? Number(limit) : 200,
    });
  }

  // ─────────── Reservas (operacional) ───────────

  @Post(':id/reservations/manual')
  async manualReserve(@Param('id') id: string, @Body() dto: ReserveDto) {
    return this.reservationService.createManual(id, dto);
  }

  @Get(':id/reservations')
  async listReservations(
    @Param('id') id: string,
    @Query('status') status?: string,
  ) {
    return this.reservationService.list(id, status);
  }

  @Patch('reservations/:rid/confirm')
  async confirm(@Param('rid') rid: string) {
    return this.reservationService.confirm(rid);
  }

  @Patch('reservations/:rid/cancel')
  async cancel(@Param('rid') rid: string) {
    return this.reservationService.cancel(rid, 'manual');
  }

  // ─────────── Fechamento da live ───────────

  @Post(':id/close-carts')
  async closeCarts(@Param('id') id: string) {
    return this.liveService.closeCarts(id);
  }
}
