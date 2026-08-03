import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  ForbiddenException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { ProductPhotosService } from './product-photos.service';
import { CorIaService } from './cor-ia.service';
import { WcFotosImportService } from './wc-fotos-import.service';
import { FotoImportJobService } from './foto-import-job.service';

@UseGuards(JwtAuthGuard)
@Controller('product-photos')
export class ProductPhotosController {
  constructor(
    private readonly svc: ProductPhotosService,
    private readonly corIa: CorIaService,
    private readonly wcImport: WcFotosImportService,
    private readonly lote: FotoImportJobService,
  ) {}

  private requireWrite(req: any) {
    const allowed = ['admin', 'supervisor', 'operator', 'store'];
    if (!allowed.includes(req?.user?.role)) {
      throw new ForbiddenException('Sem permissão');
    }
  }

  /**
   * Busca foto única por REF (+COR opcional).
   * GET /product-photos?ref=7031&cor=PRETO
   */
  @Get()
  async getOne(@Query('ref') ref: string, @Query('cor') cor?: string) {
    return this.svc.getPhoto(ref, cor);
  }

  /**
   * Lista todas fotos de uma REF (várias cores).
   * GET /product-photos/by-ref/7031
   */
  @Get('by-ref/:ref')
  async listByRef(@Param('ref') ref: string) {
    return this.svc.listByRef(decodeURIComponent(ref));
  }

  /**
   * Batch — recebe lista de {ref, cor} e retorna map { "REF|COR": url }.
   * POST /product-photos/batch  body: { items: [{ref, cor?}, ...] }
   */
  @Post('batch')
  async batch(@Body() body: { items: Array<{ ref: string; cor?: string }> }) {
    return this.svc.getBatch(body?.items || []);
  }

  /**
   * Galeria completa de uma cor, na ordem de exibição (capa primeiro).
   * GET /product-photos/galeria?ref=7031&cor=PRETO
   */
  @Get('galeria')
  async galeria(@Query('ref') ref: string, @Query('cor') cor?: string) {
    return this.svc.listPhotos(ref, cor);
  }

  /**
   * Upload de foto pra REF (+COR opcional). ACRESCENTA à galeria (até 6);
   * mandar `substituirId` troca aquela foto específica no lugar de somar.
   *
   * POST /product-photos/upload  multipart com:
   *   - file (image)
   *   - ref (form field)
   *   - cor (form field, opcional)
   *   - substituirId (form field, opcional)
   */
  @Post('upload')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  async upload(
    @Req() req: any,
    @UploadedFile() file: any,
    @Body('ref') ref: string,
    @Body('cor') cor?: string,
    @Body('substituirId') substituirId?: string,
  ) {
    this.requireWrite(req);
    return this.svc.upload({
      ref,
      cor,
      file,
      substituirId: substituirId || undefined,
      userId: req?.user?.id || req?.user?.sub || null,
    });
  }

  /**
   * Reordena a galeria — a primeira da lista vira a capa.
   * POST /product-photos/reorder  body: { ids: ["...", "..."] }
   */
  @Post('reorder')
  async reorder(@Req() req: any, @Body('ids') ids: string[]) {
    this.requireWrite(req);
    return this.svc.reordenar(ids || []);
  }

  /**
   * Lê a COR DA PEÇA na foto (Claude com visão) pra preencher a bolinha do
   * site. O conta-gotas manual continua valendo — isto é o palpite inicial.
   * POST /product-photos/detectar-cor  body: { url }
   */
  /**
   * Puxa do site antigo (WooCommerce) as fotos que JÁ EXISTEM daquela REF,
   * casando cada produto do WC com a COR do catálogo pelo nome.
   * POST /product-photos/importar-wc   body: { ref } ou { refs: [...] }
   */
  @Post('importar-wc')
  async importarWc(@Req() req: any, @Body() body: { ref?: string; refs?: string[] }) {
    this.requireWrite(req);
    const quem = req?.user?.id || req?.user?.sub || undefined;
    if (body?.refs?.length) return this.wcImport.importarLote(body.refs, quem);
    return this.wcImport.importarRef(String(body?.ref || ''), quem);
  }

  /**
   * RAIO-X: o que o site antigo devolve pra esta REF e por que cada produto
   * casou (ou não) com uma cor. GET /product-photos/wc-debug?ref=VOGUE
   */
  @Get('wc-debug')
  async wcDebug(@Req() req: any, @Query('ref') ref: string) {
    this.requireWrite(req);
    return this.wcImport.diagnosticar(ref);
  }

  /**
   * IMPORTAR TUDO — abre o lote (o cron processa em segundo plano).
   * POST /product-photos/importar-tudo  body: { apenasSemFoto?, limite? }
   */
  @Post('importar-tudo')
  async importarTudo(@Req() req: any, @Body() body: { apenasSemFoto?: boolean; limite?: number }) {
    this.requireWrite(req);
    return this.lote.iniciar({
      apenasSemFoto: body?.apenasSemFoto,
      limite: body?.limite,
      usuario: req?.user?.id || req?.user?.sub || undefined,
    });
  }

  /** Progresso do lote — a tela consulta de tempos em tempos. */
  @Get('importar-tudo/status')
  async statusLote(@Req() req: any) {
    this.requireWrite(req);
    return this.lote.status();
  }

  @Post('importar-tudo/cancelar')
  async cancelarLote(@Req() req: any) {
    this.requireWrite(req);
    return this.lote.cancelar();
  }

  @Post('detectar-cor')
  async detectarCor(@Req() req: any, @Body('url') url: string) {
    this.requireWrite(req);
    return this.corIa.detectar(url);
  }

  /**
   * Remove foto.
   * DELETE /product-photos/:id
   */
  @Delete(':id')
  async remove(@Req() req: any, @Param('id') id: string) {
    this.requireWrite(req);
    return this.svc.delete(id);
  }
}
