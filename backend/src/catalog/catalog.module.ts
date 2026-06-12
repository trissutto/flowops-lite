import { Module, forwardRef } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { CatalogService } from './catalog.service';
import { CatalogController } from './catalog.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { ErpModule } from '../erp/erp.module';
import { SizeFeedbackModule } from '../size-feedback/size-feedback.module';

/**
 * Catalog Module — endpoints públicos pro app cliente (PWA).
 * Usa Prisma pra listar lojas físicas como opção de "Retirar em loja".
 * Usa ErpService pra consultar estoque por loja (feature "perto de mim").
 * Usa SizeFeedbackService pra retornar stats de tamanho no endpoint público.
 * Puxa produtos do WC REST API.
 */
@Module({
  imports: [
    HttpModule.register({ timeout: 10000 }),
    PrismaModule,
    ErpModule,
    forwardRef(() => SizeFeedbackModule),
  ],
  providers: [CatalogService],
  controllers: [CatalogController],
})
export class CatalogModule {}
