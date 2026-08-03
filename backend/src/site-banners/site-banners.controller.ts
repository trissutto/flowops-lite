import {
  Body, Controller, Delete, Get, Param, Patch, Post, Query, Req,
  UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { AdminOnly, AdminOnlyGuard } from '../auth/admin-only.guard';
import { BannerInput, SiteBannersService, SLOTS } from './site-banners.service';

/**
 * PÚBLICO — é o que o site consome. Sem token, como o resto de /public/loja:
 * banner é conteúdo de vitrine, já vai estar visível pra qualquer pessoa.
 */
@Controller('public/loja/banners')
export class SiteBannersPublicController {
  constructor(private readonly svc: SiteBannersService) {}

  @Get()
  listar(@Query('slot') slot: string) {
    return this.svc.listarPublico(slot);
  }
}

/**
 * RETAGUARDA — /retaguarda/banners. Admin only: banner é a cara da home.
 */
@Controller('site-banners')
@UseGuards(JwtAuthGuard, AdminOnlyGuard)
@AdminOnly()
export class SiteBannersController {
  constructor(private readonly svc: SiteBannersService) {}

  private usuario(req: any): string {
    return req?.user?.name || req?.user?.email || `user#${req?.user?.sub || '?'}`;
  }

  @Get('slots')
  slots() {
    return SLOTS;
  }

  @Get()
  listar(@Query('slot') slot?: string) {
    return this.svc.listarAdmin(slot);
  }

  @Post()
  criar(@Body() body: BannerInput, @Req() req: any) {
    return this.svc.criar(body, this.usuario(req));
  }

  @Patch(':id')
  atualizar(@Param('id') id: string, @Body() body: BannerInput, @Req() req: any) {
    return this.svc.atualizar(id, body, this.usuario(req));
  }

  @Delete(':id')
  remover(@Param('id') id: string) {
    return this.svc.remover(id);
  }

  /** POST /site-banners/:id/imagem?variante=mobile — multipart, campo `file`. */
  @Post(':id/imagem')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 12 * 1024 * 1024 } }))
  subirImagem(
    @Param('id') id: string,
    @UploadedFile() file: any,
    @Query('variante') variante?: string,
  ) {
    return this.svc.subirImagem(id, file, variante === 'mobile' ? 'mobile' : 'desktop');
  }
}
