import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PromoConfigModule } from '../promo-config/promo-config.module';
import { PromoSiteService } from './promo-site.service';

/**
 * Módulo FOLHA de propósito: só Prisma e a config de promoção.
 *
 * Quem depende dele são o catálogo (mostra o preço) e os pedidos (cobram o
 * preço) — dois módulos que não podem passar a se importar por causa disto.
 * Aresta nova no grafo já derrubou o boot em 07/08 (ciclo
 * Pagbank→Pdv→Crediarios→Pagbank); aqui não há como criar ciclo, porque este
 * módulo não importa nenhum dos dois.
 */
@Module({
  imports: [PrismaModule, PromoConfigModule],
  providers: [PromoSiteService],
  exports: [PromoSiteService],
})
export class PromoSiteModule {}
