import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { SiteCategoriasController, SiteCategoriasPublicController } from './site-categorias.controller';
import { SiteCategoriasService } from './site-categorias.service';

@Module({
  imports: [PrismaModule],
  controllers: [SiteCategoriasPublicController, SiteCategoriasController],
  providers: [SiteCategoriasService],
  exports: [SiteCategoriasService],
})
export class SiteCategoriasModule {}
