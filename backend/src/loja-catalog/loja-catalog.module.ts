import { Module } from '@nestjs/common';
import { LiveModule } from '../live/live.module';
import { HttpModule } from '@nestjs/axios';
import { PrismaModule } from '../prisma/prisma.module';
import { LojaCatalogService } from './loja-catalog.service';
import { InstagramFeedService } from './instagram-feed.service';
import { GrupoRefService } from './grupo-ref.service';
import { ClassificacaoService } from './classificacao.service';
import { SiteSyncService } from './site-sync.service';
import { LojaCatalogPublicController, LojaCatalogAdminController } from './loja-catalog.controller';

/**
 * CATÁLOGO DO E-COMMERCE (sprint 008) — ERP como fonte da verdade.
 *
 * Isolado de propósito: o site novo fala SÓ com este módulo. Preço, grade e
 * estoque saem do espelho do ERP na hora da consulta; nome, descrição, SEO e
 * curadoria saem do cadastro do Flow; foto sai do R2 da Lurd's. O WooCommerce
 * entra apenas como origem de importação enquanto o site antigo existir.
 */
@Module({
  /**
   * `LiveModule` entra por causa do `MetaService`: ele já fala com a Graph API
   * do Instagram e, principalmente, já tem o LIMITADOR de requisição (80/min).
   * Um cliente próprio aqui teria orçamento separado, e os dois somados
   * estourariam a cota da Meta — calando as DMs da live, que usam o mesmo
   * token.
   *
   * ⚠️ Aresta nova no grafo de módulos é o que derrubou o backend em 07/08
   * (ciclo Pagbank→Pdv→Crediarios→Pagbank). Esta foi conferida com boot test
   * real: `LiveModule` não importa `LojaCatalogModule` nem nada que leve a
   * ele. Se um dia importar, o boot quebra — e o teste pega antes do deploy.
   */
  imports: [PrismaModule, HttpModule, LiveModule],
  controllers: [LojaCatalogPublicController, LojaCatalogAdminController],
  providers: [LojaCatalogService, SiteSyncService, InstagramFeedService, GrupoRefService, ClassificacaoService],
  exports: [LojaCatalogService],
})
export class LojaCatalogModule {}
