import {
  Body, Controller, Get, Param, Patch, Post, Req,
  UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { AdminOnly, AdminOnlyGuard } from '../auth/admin-only.guard';
import { CategoriaInput, SiteCategoriasService } from './site-categorias.service';

/**
 * PÚBLICO — o que a vitrine consome (menu, home e /categoria). Sem token,
 * como o resto de /public/loja: é conteúdo visível pra qualquer pessoa.
 */
@Controller('public/loja/categorias')
export class SiteCategoriasPublicController {
  constructor(private readonly svc: SiteCategoriasService) {}

  @Get()
  listar() {
    return this.svc.listarPublico();
  }
}

/**
 * RETAGUARDA — /retaguarda/categorias. Admin only: mexe na cara do site.
 *
 * A rota é por SLUG, não por id: a categoria nasce do catálogo, e o registro
 * de configuração pode nem existir ainda quando a tela abre.
 */
@Controller('site-categorias')
@UseGuards(JwtAuthGuard, AdminOnlyGuard)
@AdminOnly()
export class SiteCategoriasController {
  constructor(private readonly svc: SiteCategoriasService) {}

  private usuario(req: any): string {
    return req?.user?.name || req?.user?.email || `user#${req?.user?.sub || '?'}`;
  }

  @Get()
  listar() {
    return this.svc.listarAdmin();
  }

  @Patch(':slug')
  salvar(@Param('slug') slug: string, @Body() body: CategoriaInput, @Req() req: any) {
    return this.svc.salvar(slug, body, this.usuario(req));
  }

  /** POST /site-categorias/:slug/imagem — multipart, campo `file`. */
  @Post(':slug/imagem')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 12 * 1024 * 1024 } }))
  subirImagem(@Param('slug') slug: string, @UploadedFile() file: any, @Req() req: any) {
    return this.svc.subirImagem(slug, file, this.usuario(req));
  }

  /** Tira só a foto — a categoria continua existindo (ela é do catálogo). */
  @Post(':slug/imagem/remover')
  removerImagem(@Param('slug') slug: string) {
    return this.svc.removerImagem(slug);
  }
}
