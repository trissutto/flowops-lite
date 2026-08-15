import { Body, Controller, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { AdminOnly, AdminOnlyGuard } from '../auth/admin-only.guard';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { ProductDraftPayload, SiteContentEditorService } from './site-content-editor.service';

@Controller('site-content-editor')
@UseGuards(JwtAuthGuard, AdminOnlyGuard)
@AdminOnly()
export class SiteContentEditorController {
  constructor(private readonly service: SiteContentEditorService) {}

  @Get('product/:ref')
  getProduct(@Param('ref') ref: string, @Query('marca') marca: string, @Query('cor') cor?: string) {
    return this.service.getProduct(ref, marca, cor);
  }

  @Put('product/:ref/draft')
  saveDraft(
    @Param('ref') ref: string,
    @Query('marca') marca: string,
    @Query('cor') cor: string | undefined,
    @Body() body: Omit<ProductDraftPayload, 'ref' | 'marca' | 'cor'> & { baseVersion?: number },
    @Req() req: any,
  ) {
    return this.service.saveProductDraft({ ...body, ref, marca, cor }, req.user);
  }

  @Post('product/:ref/publish')
  publish(
    @Param('ref') ref: string,
    @Query('marca') marca: string,
    @Query('cor') cor: string | undefined,
    @Body() body: { baseVersion?: number },
    @Req() req: any,
  ) {
    return this.service.publishProduct(ref, marca, cor, Number(body.baseVersion ?? 0), req.user);
  }

  @Get('product/:ref/versions')
  versions(@Param('ref') ref: string, @Query('marca') marca: string, @Query('cor') cor?: string) {
    return this.service.listProductVersions(ref, marca, cor);
  }
}
