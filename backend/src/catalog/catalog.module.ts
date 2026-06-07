import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { CatalogService } from './catalog.service';
import { CatalogController } from './catalog.controller';

/**
 * Catalog Module — endpoints públicos pro app cliente (PWA).
 * NÃO usa Prisma (puxa direto do WC REST API).
 */
@Module({
  imports: [HttpModule.register({ timeout: 10000 })],
  providers: [CatalogService],
  controllers: [CatalogController],
})
export class CatalogModule {}
