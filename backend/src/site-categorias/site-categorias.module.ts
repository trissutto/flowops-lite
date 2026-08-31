import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ProductPhotosModule } from '../product-photos/product-photos.module';
import { LojaCatalogModule } from '../loja-catalog/loja-catalog.module';
import { SiteCategoriasController, SiteCategoriasPublicController } from './site-categorias.controller';
import { SiteCategoriasService } from './site-categorias.service';

@Module({
  // ProductPhotosModule só pelo CorIaService — a IA que lê o recorte da
  // categoria reusa o mesmo motor que já lê a cor da peça (dono 07/08).
  // `LojaCatalogModule` entra só pelo `invalidarCache()`: gravar categoria tem
  // de derrubar a taxonomia em cache do catálogo na hora. Aresta conferida no
  // boot test — nada na cadeia do LojaCatalog importa este módulo (só o
  // app.module importa), então não há ciclo (a lição de 07/08).
  imports: [PrismaModule, ProductPhotosModule, LojaCatalogModule],
  controllers: [SiteCategoriasPublicController, SiteCategoriasController],
  providers: [SiteCategoriasService],
  exports: [SiteCategoriasService],
})
export class SiteCategoriasModule {}
