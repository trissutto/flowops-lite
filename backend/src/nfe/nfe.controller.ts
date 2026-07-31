import {
  Body, Controller, ForbiddenException, Get, Param, Post, Query, Req, Res, UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { NfeTransferService } from './nfe-transfer.service';
import { NfeSequenceService } from './nfe-sequence.service';
import { DanfePdfService } from './danfe-pdf.service';
import { VendaEtiquetaService } from './venda-etiqueta.service';

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
    private readonly vendaEtiqueta: VendaEtiquetaService,
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

  /** Venda no PDV pode emitir a NF-e "nota grande" a pedido da cliente (dono
   *  24/07: vendedora normal). Loja/admin/operator. */
  private requireVenda(req: any) {
    const role = req?.user?.role;
    if (!['admin', 'operator', 'store'].includes(role)) {
      throw new ForbiddenException('Sem permissão pra emitir NF-e de venda');
    }
  }

  /**
   * ETIQUETA da venda online (Correios/Mais Envios). Exige NF-e autorizada —
   * o destinatário sai do <dest> da própria nota e a chave vai na
   * pré-postagem. Idempotente: já gerada → devolve a mesma (reimpressão).
   * POST /nfe/venda/:saleId/etiqueta · { servico?: 'PAC' | 'SEDEX' }
   */
  /**
   * Status da NF-e da venda — o modal "nota grande" checa ISSO ao abrir:
   * já autorizada → mostra o verde na hora, sem pedir os dados de novo
   * (dono 31/07: clicava NF-e numa venda já emitida e via o formulário vazio).
   */
  @Get('venda/:saleId')
  statusVenda(@Req() req: any, @Param('saleId') saleId: string) {
    this.requireVenda(req);
    return this.transfer.findVendaDoc(saleId);
  }

  @Post('venda/:saleId/etiqueta')
  etiquetaVenda(
    @Req() req: any,
    @Param('saleId') saleId: string,
    @Body() body: { servico?: 'PAC' | 'SEDEX' },
  ) {
    this.requireVenda(req);
    const role = req?.user?.role;
    return this.vendaEtiqueta.gerar(saleId, {
      servico: body?.servico,
      lojaPermitida: role === 'store' ? String(req?.user?.storeCode || '') : null,
      userName: req?.user?.name || req?.user?.email || null,
    });
  }

  /** Emite a NF-e (mod 55) de uma VENDA do PDV — caso extremo (cliente pede a
   *  nota grande). Cancela o cupom (dentro de 30min) e emite no lugar. */
  @Post('venda/:saleId')
  emitVenda(
    @Req() req: any,
    @Param('saleId') saleId: string,
    @Body() body: { customer?: any },
  ) {
    this.requireVenda(req);
    return this.transfer.emitVendaForSale(saleId, {
      userId: req?.user?.userId || req?.user?.sub || null,
      customer: body?.customer,
    });
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

  /** Cancela uma NF-e autorizada (evento 110111, prazo SEFAZ 24h). */
  @Post(':id/cancel')
  cancel(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { justificativa?: string },
  ) {
    this.requireMatriz(req);
    return this.transfer.cancelDoc(
      id,
      body?.justificativa || '',
      req?.user?.userId || req?.user?.sub || null,
    );
  }

  /** Lista NF-e emitidas (filtro por loja/status). */
  @Get()
  list(
    @Req() req: any,
    @Query('storeCode') storeCode?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('emitRaiz') emitRaiz?: string,
  ) {
    this.requireLeitura(req);
    return this.transfer.list({ storeCode, status, limit: Number(limit) || undefined, emitRaiz });
  }

  /** Numeração NF-e de TODAS as lojas (tela de gerência). */
  @Get('sequences')
  sequences(@Req() req: any) {
    this.requireMatriz(req);
    return this.seq.listAll();
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

  /**
   * DOWNLOAD EM LOTE (dono 29/07): ZIP com os XMLs e/ou DANFEs das notas
   * AUTORIZADAS do período — pro contador. Query: de/ate (YYYY-MM-DD, vazio =
   * tudo), tipo (xml | danfe | tudo), storeCode (loja origem, opcional).
   * PRECISA vir antes de ':id' (senão o Nest casa 'download-lote' como id).
   */
  @Get('download-lote')
  async downloadLote(
    @Req() req: any,
    @Res() res: Response,
    @Query('de') de?: string,
    @Query('ate') ate?: string,
    @Query('tipo') tipo?: string,
    @Query('storeCode') storeCode?: string,
    @Query('emitRaiz') emitRaiz?: string,
  ) {
    this.requireLeitura(req);
    const t = tipo === 'xml' || tipo === 'danfe' ? tipo : 'tudo';
    const docs = await this.transfer.listDocsParaLote({ de, ate, storeCode, emitRaiz });
    if (!docs.length) {
      res.status(404).json({ message: 'Nenhuma NF-e autorizada no período/filtro.' });
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const archiver = require('archiver');
    const nome = `nfe_${de || 'inicio'}_a_${ate || 'hoje'}_${t}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${nome}"`);
    const zip = archiver('zip', { zlib: { level: 6 } });
    zip.on('error', (e: any) => {
      console.error('[nfe/download-lote] erro no zip', e?.message || e);
      try { res.end(); } catch { /* stream já fechado */ }
    });
    zip.pipe(res);
    for (const d of docs as any[]) {
      const base = `NFe_${String(d.numero).padStart(9, '0')}-${d.serie || '1'}_${d.chave || d.id}`;
      if (t !== 'danfe') {
        const xml = d.xmlAutorizado || d.xmlEnviado;
        if (xml) zip.append(String(xml), { name: `xml/${base}.xml` });
      }
      if (t !== 'xml') {
        try {
          const { buffer } = await this.danfe.generateForDoc(d.id);
          zip.append(buffer, { name: `danfe/${base}.pdf` });
        } catch (e: any) {
          zip.append(`DANFE indisponível: ${e?.message || e}`, { name: `danfe/${base}.ERRO.txt` });
        }
      }
    }
    await zip.finalize();
  }

  /** DANFE em PDF (A4, com código de barras da chave). */
  @Get(':id/danfe')
  async getDanfe(@Req() req: any, @Param('id') id: string, @Res() res: Response) {
    // Loja também abre o DANFE (venda no PDV) — além de matriz/supervisor/contador.
    const role = req?.user?.role;
    if (!['admin', 'operator', 'supervisor', 'contador', 'store'].includes(role)) {
      throw new ForbiddenException('Sem permissão pra abrir o DANFE');
    }
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

  /** NF-e do ENVIO de um pick-order (Reimprimir DANFE na loja). */
  @Get('by-envio/:pickId')
  byEnvio(@Req() req: any, @Param('pickId') pickId: string) {
    const role = req?.user?.role;
    if (!['admin', 'operator', 'supervisor', 'contador', 'store'].includes(role)) {
      throw new ForbiddenException('Sem permissão');
    }
    return this.transfer.findEnvioDoc(pickId);
  }

  /** DANFE em base64 (download via JSON no front, mesmo padrão da etiqueta). */
  @Get(':id/danfe-b64')
  async getDanfeB64(@Req() req: any, @Param('id') id: string) {
    const role = req?.user?.role;
    if (!['admin', 'operator', 'supervisor', 'contador', 'store'].includes(role)) {
      throw new ForbiddenException('Sem permissão pra abrir o DANFE');
    }
    const { buffer, filename } = await this.danfe.generateForDoc(id);
    return { ok: true, filename, pdfBase64: buffer.toString('base64') };
  }

  /** Documento por id (com XMLs). */
  @Get(':id')
  getDoc(@Req() req: any, @Param('id') id: string) {
    this.requireLeitura(req);
    return this.transfer.getDoc(id);
  }
}
