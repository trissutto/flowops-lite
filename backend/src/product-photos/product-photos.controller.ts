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

@UseGuards(JwtAuthGuard)
@Controller('product-photos')
export class ProductPhotosController {
  constructor(private readonly svc: ProductPhotosService) {}

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
   * Upload de foto pra REF (+COR opcional).
   * POST /product-photos/upload  multipart com:
   *   - file (image)
   *   - ref (form field)
   *   - cor (form field, opcional)
   */
  @Post('upload')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  async upload(
    @Req() req: any,
    @UploadedFile() file: any,
    @Body('ref') ref: string,
    @Body('cor') cor?: string,
  ) {
    this.requireWrite(req);
    return this.svc.upload({
      ref,
      cor,
      file,
      userId: req?.user?.id || req?.user?.sub || null,
    });
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
