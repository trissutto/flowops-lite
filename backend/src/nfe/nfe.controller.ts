import {
  Body, Controller, ForbiddenException, Get, Param, Post, Query, Req, Res, UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { NfeTransferService } from './nfe-transfer.service';
import { NfeSequenceService } from './nfe-sequence.service';
import { DanfePdfService } from './danfe-pdf.service';

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
    private readonly danfe: DanfePdfService,
  ) {}

  private requireMatriz(req: any) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'operator') {
      throw new ForbiddenException('Apenas matriz (admin/operator) emite NF-e');
    }
  }

  /** Leitura (lista/XML/DANFE): matriz + supervisor + CONTADOR (aba
   *  contabilidade — dono 23/07: notas disponíveis pro contador). */
  private requireLeitura(req: any) {
    const role = req?.user?.role;
    if (!['admin', 'operator', 'supervisor', 'contador'].includes(role)) {
      throw new ForbiddenException('Sem permissão pra consultar NF-e');
    }
  }

  /** Emite a NF-e de transferência de uma remessa (RealignmentShipment). */
  /** PRÉVIA — tudo que a nota vai ter, sem numerar/assinar/transmitir. */
  @Get('transfer/preview/:shipmentId')
  previewTransfer(@Req() req: any, @Param('shipmentId') shipmentId: string) {
    this.requireMatriz(req);
    return this.transfer.previewForShipment(shipmentId);
  }

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
  list(
    @Req() req: any,
    @Query('storeCode') storeCode?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    this.requireLeitura(req);
    return this.transfer.list({ storeCode, status, limit: Number(limit) || undefined });
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

  /** DANFE em PDF (A4, com código de barras da chave). */
  @Get(':id/danfe')
  async getDanfe(@Req() req: any, @Param('id') id: string, @Res() res: Response) {
    this.requireLeitura(req);
    try {
      const { buffer, filename } = await this.danfe.generateForDoc(id);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
      res.setHeader('Content-Length', String(buffer.length));
      res.end(buffer);
    } catch (e: any) {
      console.error('[nfe/danfe] FALHA ao gerar DANFE', id, '\n', e?.stack || e);
      res.status(e?.status === 404 ? 404 : 500).json({ message: e?.message || 'Erro ao gerar DANFE' });
    }
  }

  /** Documento por id (com XMLs). */
  @Get(':id')
  getDoc(@Req() req: any, @Param('id') id: string) {
    this.requireLeitura(req);
    return this.transfer.getDoc(id);
  }
}
