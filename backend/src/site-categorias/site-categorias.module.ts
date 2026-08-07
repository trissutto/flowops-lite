import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ProductPhotosModule } from '../product-photos/product-photos.module';
import { SiteCategoriasController, SiteCategoriasPublicController } from './site-categorias.controller';
import { SiteCategoriasService } from './site-categorias.service';

@Module({
  // ProductPhotosModule só pelo CorIaService — a IA que lê o recorte da
  // categoria reusa o mesmo motor que já lê a cor da peça (dono 07/08).
  imports: [PrismaModule, ProductPhotosModule],
  controllers: [SiteCategoriasPublicController, SiteCategoriasController],
  providers: [SiteCategoriasService],
  exports: [SiteCategoriasService],
})
export class SiteCategoriasModule {}
