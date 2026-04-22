import { Module } from '@nestjs/common';
import { SitePublishController } from './site-publish.controller';
import { SitePublishService } from './site-publish.service';
import { PrismaModule } from '../prisma/prisma.module';
import { ErpModule } from '../erp/erp.module';

/**
 * SitePublishModule — integração Wincred → WooCommerce em 3 fases.
 *
 * Fase 1 (queued):    CEO marca REFs/cores no LURDS ORDER ONE.
 * Fase 2 (enriched):  CEO adiciona descrição, categorias, imagens, tags.
 * Fase 3 (published): Sistema publica no WC via REST (endpoint separado).
 *
 * Este módulo implementa Fase 1. Fase 2 e 3 virão depois, reusando o mesmo
 * service e model Prisma SitePublishQueue.
 */
@Module({
  imports: [PrismaModule, ErpModule],
  providers: [SitePublishService],
  controllers: [SitePublishController],
  exports: [SitePublishService],
})
export class SitePublishModule {}
