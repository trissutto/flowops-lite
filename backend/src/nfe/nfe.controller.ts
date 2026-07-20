import {
  Body, Controller, ForbiddenException, Get, Param, Post, Query, Req, UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { NfeTransferService } from './nfe-transfer.service';
import { NfeSequenceService } from './nfe-sequence.service';

/**
 * /nfe — emissão de NF-e modelo 55 (transferência entre lojas). Matriz-only.
 * Fase 1: emissão manual por remessa, em homologação (ambiente do NfceConfig).
 */
@Controller('nfe')
@UseGuards(JwtAuthGuard)
export class NfeController {
  constructor(
    private readonly transfer: NfeTransferService,
    private readonly seq: NfeSequenceService,
  ) {}

  private requireMatriz(req: any) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'operator') {
      throw new ForbiddenException('Apenas matriz (admin/operator) emite NF-e');
    }
  }

  /** Emite a NF-e de transferência de uma remessa (RealignmentShipment). */
  @Post('transfer/emit/:shipmentId')
  emitTransfer(
    @Req() req: any,
    @Param('shipmentId') shipmentId: string,
    @Body() body: { serie?: string; startNumero?: number },
  ) {
    this.requireMatriz(req);
    return this.transfer.emitForShipment(shipmentId, {
      userId: req?.user?.userId || req?.user?.sub || null,
      serie: body?.serie,
      startNumero: body?.startNumero,
    });
  }

  /** Lista NF-e emitidas (filtro por loja/status). */
  @Get()
  list(@Req() req: any, @Query('storeCode') storeCode?: string, @Query('status') status?: string) {
    this.requireMatriz(req);
    return this.transfer.list({ storeCode, status });
  }

  /** Status da numeração NF-e de uma loja. */
  @Get('sequence/:storeCode')
  sequence(@Req() req: any, @Param('storeCode') storeCode: string) {
    this.requireMatriz(req);
    return this.seq.status(storeCode);
  }

  /** Ajusta o próximo número de uma série (config inicial). */
  @Post('sequence/:storeCode')
  setSequence(
    @Req() req: any,
    @Param('storeCode') storeCode: string,
    @Body() body: { serie: string; proximo: number },
  ) {
    this.requireMatriz(req);
    return this.seq.setProximo(storeCode, body?.serie || '1', Number(body?.proximo) || 1);
  }

  /** Documento por id (com XMLs). */
  @Get(':id')
  getDoc(@Req() req: any, @Param('id') id: string) {
    this.requireMatriz(req);
    return this.transfer.getDoc(id);
  }
}
