import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { LojaCatalogModule } from '../loja-catalog/loja-catalog.module';
import { SiteVitrinesController, SiteVitrinesPublicController } from './site-vitrines.controller';
import { SiteVitrinesService } from './site-vitrines.service';

/**
 * AS VITRINES DA HOME — ordem e textos dos carrosséis, sem deploy.
 *
 * `LojaCatalogModule` entra porque o endpoint público devolve as vitrines JÁ
 * COM AS PEÇAS: quem monta a lista de produtos continua sendo o
 * `LojaCatalogService` (com o cache de 60s dele), não uma segunda consulta ao
 * catálogo que poderia divergir da vitrine. Sem ciclo: o catálogo não conhece
 * este módulo.
 */
@Module({
  imports: [PrismaModule, LojaCatalogModule],
  controllers: [SiteVitrinesPublicController, SiteVitrinesController],
  providers: [SiteVitrinesService],
  exports: [SiteVitrinesService],
})
export class SiteVitrinesModule {}
