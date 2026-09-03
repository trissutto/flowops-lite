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
import { MOTIVOS_DESLIGAMENTO } from '../common/motivos-desligamento';

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

  /** `storeCode` = só as funcionárias daquela loja (origem, atuação ou chefia). */
  @Get()
  list(
    @Query('includeInactive') includeInactive?: string,
    @Query('storeCode') storeCode?: string,
  ) {
    return this.svc.list(
      includeInactive === '1' || includeInactive === 'true',
      storeCode,
    );
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

  // POST /sellers/import-from-wincred foi REMOVIDA no enterro do Wincred
  // (09/2026) — lia o MySQL do Giga, morto. Vendedora nova nasce no Flow.

  /**
   * UNIFICA GRAFIAS de uma vendedora numa loja (dono 29/07). Body:
   *   { storeCode: '07', from: ['MIRELLA','MIRELA DA SILVA'], to: 'MIRELA', dryRun?: true }
   * dryRun devolve o preview (contagens + fichas afetadas) sem alterar nada.
   */
  @Post('unify')
  @AdminOnly()
  unify(
    @Body() body: { storeCode: string; from: string[]; to: string; dryRun?: boolean },
    @Req() req: any,
  ) {
    return this.svc.unifySpellings({
      storeCode: body?.storeCode,
      from: Array.isArray(body?.from) ? body.from : [],
      to: body?.to,
      dryRun: !!body?.dryRun,
      by: req?.user?.email || req?.user?.id || 'unknown',
    });
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
    // O ValidationPipe global tem whitelist, mas ela só corta campo em DTO com
    // decorators — este body é tipo inline, então tudo passa. A lista abaixo
    // existe pra documentar o que a rota realmente aceita.
    @Body() body: {
      name?: string; apelido?: string | null; whatsapp?: string | null;
      active?: boolean; cargo?: string; responsibleStoreId?: string | null;
      storeCodeOrigin?: string | null; lojasAtuacao?: string[] | null;
      // Prontuário RH
      cpf?: string | null; rg?: string | null; email?: string | null;
      endereco?: string | null; cidade?: string | null; uf?: string | null; cep?: string | null;
      dataNascimento?: string | null; dataAdmissao?: string | null;
      contratoTipo?: string | null; cargoFuncao?: string | null; salarioBase?: number | null;
      horarioTrabalho?: any; observacoes?: string | null;
      dataInicioFerias?: string | null; dataFimFerias?: string | null;
      // Desligamento (dono 01/08). Data até hoje INATIVA a funcionária.
      dataDesligamento?: string | null; motivoDesligamento?: string | null;
    },
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

  /** Lista fechada de motivos de desligamento — a tela monta o select com ela,
   *  pra a opção nunca divergir do que o backend aceita. */
  @Get('desligamento/motivos')
  motivosDesligamento() {
    return { motivos: MOTIVOS_DESLIGAMENTO };
  }

  /**
   * MAPA DE FÉRIAS — período aquisitivo, concessivo e a data limite de cada uma.
   *
   * Diferente do `ferias/check`, que só devolve quem está perto de vencer. Aqui
   * vem a folha inteira, ordenada pelo prazo mais apertado, pra o RH programar
   * ao invés de apagar incêndio.
   */
  @Get('ferias/mapa')
  mapaFerias(@Query('storeCode') storeCode?: string, @Query('incluirInativas') incluirInativas?: string) {
    return this.svc.mapaFerias({
      storeCode: storeCode || undefined,
      incluirInativas: incluirInativas === '1' || incluirInativas === 'true',
    });
  }

  /** CONFERIDOR Flow × Giga por loja (dono 29/07): componentes do Flow
   *  (bruto/marcados/desconto/devoluções) + caixa do Giga lado a lado. */
  @Get('report-conferidor')
  reportConferidor(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('storeCode') storeCode?: string,
  ) {
    const now = new Date();
    const f = from ? new Date(from) : new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    const t = to ? new Date(to) : new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    return this.svc.conferidorLoja(f, t, String(storeCode || '').trim());
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
