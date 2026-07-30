import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { PrismaModule } from '../prisma/prisma.module';
import { LojaCatalogService } from './loja-catalog.service';
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
  imports: [PrismaModule, HttpModule],
  controllers: [LojaCatalogPublicController, LojaCatalogAdminController],
  providers: [LojaCatalogService, SiteSyncService],
  exports: [LojaCatalogService],
})
export class LojaCatalogModule {}
