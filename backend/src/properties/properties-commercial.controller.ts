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
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { PropertiesCommercialService } from './properties-commercial.service';
import { PropertiesMediaStorageService } from './properties-media-storage.service';
import { PropertiesPublicationService } from './properties-publication.service';

const supremoEmails = () => (process.env.SUPREMO_EMAILS || 'trissutto@gmail.com')
  .split(',')
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean);

@UseGuards(JwtAuthGuard)
@Controller('properties')
export class PropertiesCommercialController {
  constructor(
    private readonly commercial: PropertiesCommercialService,
    private readonly storage: PropertiesMediaStorageService,
    private readonly publication: PropertiesPublicationService,
  ) {}

  @Get(':id/commercial')
  async get(@Req() req: any, @Param('id') id: string) {
    this.requireSupremo(req);
    return this.commercial.get(id);
  }

  @Patch(':id/commercial')
  async update(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    this.requireSupremo(req);
    return this.commercial.updateProfile(id, body, this.user(req));
  }

  @Post(':id/commercial/media/upload')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  async upload(
    @Req() req: any,
    @Param('id') id: string,
    @UploadedFile() file: any,
    @Body('kind') kind?: string,
    @Body('caption') caption?: string,
  ) {
    this.requireSupremo(req);
    if (!file) throw new BadRequestException('Arquivo obrigatório.');
    const uploaded = await this.storage.upload(id, file);
    try {
      const media = await this.commercial.addMedia(
        id,
        { ...uploaded, kind: kind || (file.mimetype === 'application/pdf' ? 'floorplan' : 'photo'), caption },
        this.user(req),
      );
      return { ok: true, media };
    } catch (error) {
      await this.storage.remove(uploaded.sourceKey);
      throw error;
    }
  }

  @Post(':id/commercial/media/link')
  async addLink(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    this.requireSupremo(req);
    return this.commercial.addMedia(id, body, this.user(req));
  }

  @Patch(':id/commercial/media-order')
  async reorder(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    this.requireSupremo(req);
    return this.commercial.reorderMedia(id, body?.orderedIds, this.user(req));
  }

  @Patch(':id/commercial/media/:mediaId')
  async updateMedia(
    @Req() req: any,
    @Param('id') id: string,
    @Param('mediaId') mediaId: string,
    @Body() body: any,
  ) {
    this.requireSupremo(req);
    return this.commercial.updateMedia(id, mediaId, body, this.user(req));
  }

  @Delete(':id/commercial/media/:mediaId')
  async deleteMedia(
    @Req() req: any,
    @Param('id') id: string,
    @Param('mediaId') mediaId: string,
  ) {
    this.requireSupremo(req);
    const deleted = await this.commercial.deleteMedia(id, mediaId, this.user(req));
    await this.storage.remove(deleted.sourceKey);
    return { ok: true };
  }

  @Get(':id/commercial/preview')
  async preview(@Req() req: any, @Param('id') id: string) {
    this.requireSupremo(req);
    return this.publication.preview(id);
  }

  @Post(':id/commercial/publish')
  async publish(@Req() req: any, @Param('id') id: string) {
    this.requireSupremo(req);
    return this.publication.publish(id, this.user(req));
  }

  @Post(':id/commercial/unpublish')
  async unpublish(@Req() req: any, @Param('id') id: string) {
    this.requireSupremo(req);
    return this.publication.unpublish(id, this.user(req));
  }

  @Post(':id/commercial/rotate-link')
  async rotateLink(@Req() req: any, @Param('id') id: string) {
    this.requireSupremo(req);
    return this.publication.rotateLink(id, this.user(req));
  }

  @Post(':id/commercial/retry')
  async retry(@Req() req: any, @Param('id') id: string) {
    this.requireSupremo(req);
    return this.publication.retry(id, this.user(req));
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
