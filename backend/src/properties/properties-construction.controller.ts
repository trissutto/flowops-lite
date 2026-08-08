import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { PropertiesConstructionService } from './properties-construction.service';
import { PropertiesConstructionStorageService } from './properties-construction-storage.service';

const supremoEmails = () => (process.env.SUPREMO_EMAILS || 'trissutto@gmail.com')
  .split(',')
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean);

@UseGuards(JwtAuthGuard)
@Controller('properties')
export class PropertiesConstructionController {
  constructor(
    private readonly construction: PropertiesConstructionService,
    private readonly storage: PropertiesConstructionStorageService,
  ) {}

  @Get(':propertyId/construction')
  bootstrap(@Req() req: any, @Param('propertyId') propertyId: string) {
    this.requireSupremo(req);
    return this.construction.bootstrap(propertyId);
  }

  @Post(':propertyId/construction/projects')
  createProject(@Req() req: any, @Param('propertyId') propertyId: string, @Body() body: any) {
    this.requireSupremo(req);
    return this.construction.createProject(propertyId, body, this.user(req));
  }

  @Get(':propertyId/construction/projects/:projectId')
  getProject(
    @Req() req: any,
    @Param('propertyId') propertyId: string,
    @Param('projectId') projectId: string,
  ) {
    this.requireSupremo(req);
    return this.construction.getProject(propertyId, projectId);
  }

  @Patch(':propertyId/construction/projects/:projectId')
  updateProject(
    @Req() req: any,
    @Param('propertyId') propertyId: string,
    @Param('projectId') projectId: string,
    @Body() body: any,
  ) {
    this.requireSupremo(req);
    return this.construction.updateProject(propertyId, projectId, body, this.user(req));
  }

  @Post(':propertyId/construction/categories')
  createCategory(@Req() req: any, @Param('propertyId') propertyId: string, @Body() body: any) {
    this.requireSupremo(req);
    return this.construction.createCategory(propertyId, body, this.user(req));
  }

  @Post(':propertyId/construction/vendors')
  createVendor(@Req() req: any, @Param('propertyId') propertyId: string, @Body() body: any) {
    this.requireSupremo(req);
    return this.construction.createVendor(propertyId, body, this.user(req));
  }

  @Patch(':propertyId/construction/vendors/:vendorId')
  updateVendor(
    @Req() req: any,
    @Param('propertyId') propertyId: string,
    @Param('vendorId') vendorId: string,
    @Body() body: any,
  ) {
    this.requireSupremo(req);
    return this.construction.updateVendor(propertyId, vendorId, body, this.user(req));
  }

  @Post(':propertyId/construction/projects/:projectId/stages')
  createStage(
    @Req() req: any,
    @Param('propertyId') propertyId: string,
    @Param('projectId') projectId: string,
    @Body() body: any,
  ) {
    this.requireSupremo(req);
    return this.construction.createStage(propertyId, projectId, body, this.user(req));
  }

  @Patch(':propertyId/construction/projects/:projectId/stages/:stageId')
  updateStage(
    @Req() req: any,
    @Param('propertyId') propertyId: string,
    @Param('projectId') projectId: string,
    @Param('stageId') stageId: string,
    @Body() body: any,
  ) {
    this.requireSupremo(req);
    return this.construction.updateStage(propertyId, projectId, stageId, body, this.user(req));
  }

  @Post(':propertyId/construction/projects/:projectId/commitments')
  createCommitment(
    @Req() req: any,
    @Param('propertyId') propertyId: string,
    @Param('projectId') projectId: string,
    @Body() body: any,
  ) {
    this.requireSupremo(req);
    return this.construction.createCommitment(propertyId, projectId, body, this.user(req));
  }

  @Patch(':propertyId/construction/projects/:projectId/commitments/:commitmentId/cancel')
  cancelCommitment(
    @Req() req: any,
    @Param('propertyId') propertyId: string,
    @Param('projectId') projectId: string,
    @Param('commitmentId') commitmentId: string,
    @Body() body: any,
  ) {
    this.requireSupremo(req);
    return this.construction.cancelCommitment(propertyId, projectId, commitmentId, body, this.user(req));
  }

  @Post(':propertyId/construction/projects/:projectId/payments')
  createPayment(
    @Req() req: any,
    @Param('propertyId') propertyId: string,
    @Param('projectId') projectId: string,
    @Body() body: any,
  ) {
    this.requireSupremo(req);
    return this.construction.createPayment(propertyId, projectId, body, this.user(req));
  }

  @Post(':propertyId/construction/projects/:projectId/payments/:paymentId/reversals')
  reversePayment(
    @Req() req: any,
    @Param('propertyId') propertyId: string,
    @Param('projectId') projectId: string,
    @Param('paymentId') paymentId: string,
    @Body() body: any,
  ) {
    this.requireSupremo(req);
    return this.construction.reversePayment(propertyId, projectId, paymentId, body, this.user(req));
  }

  @Post(':propertyId/construction/projects/:projectId/entries')
  createEntry(
    @Req() req: any,
    @Param('propertyId') propertyId: string,
    @Param('projectId') projectId: string,
    @Body() body: any,
  ) {
    this.requireSupremo(req);
    return this.construction.createEntry(propertyId, projectId, body, this.user(req));
  }

  @Patch(':propertyId/construction/projects/:projectId/entries/:entryId/cancel')
  cancelEntry(
    @Req() req: any,
    @Param('propertyId') propertyId: string,
    @Param('projectId') projectId: string,
    @Param('entryId') entryId: string,
    @Body() body: any,
  ) {
    this.requireSupremo(req);
    return this.construction.cancelEntry(propertyId, projectId, entryId, body, this.user(req));
  }

  @Get(':propertyId/construction/projects/:projectId/ledger')
  ledger(
    @Req() req: any,
    @Param('propertyId') propertyId: string,
    @Param('projectId') projectId: string,
    @Query() query: any,
  ) {
    this.requireSupremo(req);
    return this.construction.ledger(propertyId, projectId, query);
  }

  @Get(':propertyId/construction/projects/:projectId/audits')
  audits(
    @Req() req: any,
    @Param('propertyId') propertyId: string,
    @Param('projectId') projectId: string,
  ) {
    this.requireSupremo(req);
    return this.construction.audits(propertyId, projectId);
  }

  @Post(':propertyId/construction/projects/:projectId/documents')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  async uploadDocument(
    @Req() req: any,
    @Param('propertyId') propertyId: string,
    @Param('projectId') projectId: string,
    @UploadedFile() file: any,
    @Body() body: any,
  ) {
    this.requireSupremo(req);
    if (!file) throw new BadRequestException('Arquivo obrigatório.');
    const uploaded = await this.storage.upload(propertyId, projectId, file);
    try {
      return await this.construction.addDocument(propertyId, projectId, body, uploaded, this.user(req));
    } catch (error) {
      await this.storage.remove(uploaded.objectKey);
      throw error;
    }
  }

  @Get(':propertyId/construction/projects/:projectId/documents/:documentId/download')
  async downloadDocument(
    @Req() req: any,
    @Res() res: any,
    @Param('propertyId') propertyId: string,
    @Param('projectId') projectId: string,
    @Param('documentId') documentId: string,
  ) {
    this.requireSupremo(req);
    const document = await this.construction.documentForDownload(propertyId, projectId, documentId);
    const object = await this.storage.download(document.objectKey);
    const fallbackName = String(document.fileName || 'documento').replace(/[\r\n"]/g, '_');
    res.setHeader('Content-Type', document.mimeType || object.ContentType || 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodeURIComponent(document.fileName)}`,
    );
    res.setHeader('Cache-Control', 'private, no-store');
    if (object.ContentLength) res.setHeader('Content-Length', String(object.ContentLength));
    const body: any = object.Body;
    if (body?.pipe) return body.pipe(res);
    const bytes = body?.transformToByteArray ? await body.transformToByteArray() : [];
    return res.end(Buffer.from(bytes));
  }

  @Delete(':propertyId/construction/projects/:projectId/documents/:documentId')
  removeDocument(
    @Req() req: any,
    @Param('propertyId') propertyId: string,
    @Param('projectId') projectId: string,
    @Param('documentId') documentId: string,
  ) {
    this.requireSupremo(req);
    return this.construction.removeDocument(propertyId, projectId, documentId, this.user(req));
  }

  private requireSupremo(req: any) {
    const email = String(req?.user?.email || '').trim().toLowerCase();
    if (!supremoEmails().includes(email)) {
      throw new ForbiddenException('Acesso restrito ao módulo imobiliário (SUPREMO).');
    }
  }

  private user(req: any) {
    return {
      id: req?.user?.id || req?.user?.sub || null,
      name: req?.user?.name || req?.user?.email || null,
    };
  }
}
