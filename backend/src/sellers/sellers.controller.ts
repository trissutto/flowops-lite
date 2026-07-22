import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { AdminOnly, AdminOnlyGuard } from '../auth/admin-only.guard';
import { SellersService } from './sellers.service';
import { SellerDocumentsService } from './seller-documents.service';
import { SellersCronService } from './sellers-cron.service';

/**
 * Rotas de vendedoras.
 *
 *   GET  /sellers?includeInactive=0|1        → lista (default só ativas)
 *   POST /sellers                            → { name, whatsapp? } cria
 *   PATCH /sellers/:id                       → { name?, whatsapp?, active? } edita
 *   PATCH /sellers/assign/:wcOrderId         → { sellerId: string | null } atribui
 *   GET  /sellers/report?from=ISO&to=ISO     → relatório do período
 */
@UseGuards(JwtAuthGuard, AdminOnlyGuard)
@Controller('sellers')
export class SellersController {
  constructor(
    private readonly svc: SellersService,
    private readonly docs: SellerDocumentsService,
    private readonly cron: SellersCronService,
  ) {}

  @Get()
  list(@Query('includeInactive') includeInactive?: string) {
    return this.svc.list(includeInactive === '1' || includeInactive === 'true');
  }

  @Post()
  @AdminOnly()
  create(@Body() body: { name: string; apelido?: string; whatsapp?: string }) {
    return this.svc.create(body);
  }

  /**
   * Importa funcionarias do PdvActiveSeller (whitelist do PDV das lojas)
   * pra Seller. Idempotente. Resultado: cria como cargo=VENDEDORA;
   * admin ajusta cargo + loja responsavel depois pra Lideres/Gerentes.
   */
  @Post('import-from-pdv-active')
  @AdminOnly()
  importFromPdvActive() {
    return this.svc.importFromPdvActive();
  }

  /**
   * Importa TODAS as funcionarias diretamente da tabela funcionarios
   * do MySQL Wincred. Cobre as 15 lojas — diferente do PdvActiveSeller
   * que e whitelist manual por loja.
   */
  @Post('import-from-wincred')
  @AdminOnly()
  importFromWincred() {
    return this.svc.importFromWincred();
  }

  /** Detalhe completo do prontuario + documentos. */
  @Get(':id/detail')
  getDetail(@Param('id') id: string) {
    return this.svc.getById(id);
  }

  @Patch(':id')
  @AdminOnly()
  update(
    @Param('id') id: string,
    @Body() body: { name?: string; apelido?: string | null; whatsapp?: string | null; active?: boolean; cargo?: string; responsibleStoreId?: string | null; storeCodeOrigin?: string | null },
  ) {
    return this.svc.update(id, body);
  }

  @Patch('assign/:wcOrderId')
  assign(
    @Param('wcOrderId') wcOrderId: string,
    @Body() body: { sellerId: string | null },
    @Req() req: any,
  ) {
    const by = req?.user?.email || req?.user?.id || 'unknown';
    return this.svc.assignToOrder(Number(wcOrderId), body?.sellerId ?? null, by);
  }

  // ── DOCUMENTOS (RH FASE 2) ──────────────────────────────────────
  /**
   * Lista documentos da funcionaria agrupados por categoria.
   *
   *   GET /sellers/:id/documents
   *
   * Retorna:
   *   { total: 5, grouped: { contrato: [...], atestado: [...], ... } }
   */
  @Get(':id/documents')
  listDocuments(@Param('id') id: string) {
    return this.docs.listBySeller(id);
  }

  /**
   * Upload de documento (multipart/form-data).
   *
   *   POST /sellers/:id/documents
   *   form-data:
   *     file:           File (max 10MB)
   *     categoria:      documento_pessoal | contrato | recibo_pagamento | atestado | ferias | outro
   *     titulo:         string (opcional — usa filename original se vazio)
   *     dataReferencia: ISO date (opcional)
   *     observacoes:    string (opcional)
   */
  @Post(':id/documents')
  @AdminOnly()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  uploadDocument(
    @Param('id') id: string,
    @UploadedFile() file: any,
    @Body('categoria') categoria: string,
    @Body('titulo') titulo?: string,
    @Body('dataReferencia') dataReferencia?: string,
    @Body('observacoes') observacoes?: string,
    @Req() req?: any,
  ) {
    if (!categoria) throw new BadRequestException('categoria obrigatoria');
    const userId = req?.user?.id || req?.user?.sub || req?.user?.email || null;
    return this.docs.upload(
      id,
      file,
      { categoria, titulo, dataReferencia, observacoes },
      userId,
    );
  }

  /**
   * Remove documento (apaga do R2 + DB).
   *
   *   DELETE /sellers/documents/:docId
   */
  @Delete('documents/:docId')
  @AdminOnly()
  deleteDocument(@Param('docId') docId: string) {
    return this.docs.remove(docId);
  }

  // ── FERIAS — ALERTA MANUAL ───────────────────────────────────────
  /**
   * Dispara o check de ferias sob demanda (debug do cron).
   *
   *   GET /sellers/ferias/check
   *
   * Retorna lista de funcionarias com ferias vencendo em <= 60 dias
   * sem dataInicioFerias marcada no ciclo atual.
   * Tambem envia push pros admins (se houver subscriptions).
   */
  @Get('ferias/check')
  checkFerias() {
    return this.cron.checkVacationAlerts();
  }

  @Get('report')
  report(@Query('from') from?: string, @Query('to') to?: string) {
    // Default: mês corrente
    const now = new Date();
    const defFrom = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    const defTo = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    const f = from ? new Date(from) : defFrom;
    const t = to ? new Date(to) : defTo;

    return this.svc.report(f, t);
  }
}
