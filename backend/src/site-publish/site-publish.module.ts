import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { SitePublishController } from './site-publish.controller';
import { SitePublishService } from './site-publish.service';
import { AiEnrichmentService } from './ai-enrichment.service';
import { WcCatalogService } from './wc-catalog.service';
import { PrismaModule } from '../prisma/prisma.module';
import { ErpModule } from '../erp/erp.module';

/**
 * SitePublishModule — integração Wincred → WooCommerce em 3 fases.
 *
 * Fase 1 (queued):     CEO marca REFs/cores no LURDS ORDER ONE.
 * Fase 2 (enriched):   CEO (ou IA) enriquece com título, descrição, tags,
 *                      categorias, imagens, atributos.
 * Fase 3 (published):  Sistema publica no WC como rascunho (draft).
 *
 * Serviços:
 *   - SitePublishService     — orquestra tudo, fala com Prisma
 *   - AiEnrichmentService    — gera conteúdo via Claude (precisa ANTHROPIC_API_KEY)
 *   - WcCatalogService       — lista categorias/tags/uploads/cria produtos no WC
 */
@Module({
  imports: [
    PrismaModule,
    ErpModule,
    // HttpModule compartilhado entre AiEnrichment (Anthropic) e WcCatalog (WC).
    // Timeout padrão curto; chamadas específicas sobrescrevem.
    HttpModule.register({
      timeout: 30000,
      maxRedirects: 3,
    }),
  ],
  providers: [SitePublishService, AiEnrichmentService, WcCatalogService],
  controllers: [SitePublishController],
  exports: [SitePublishService],
})
export class SitePublishModule {}
