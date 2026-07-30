import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { FitEngineService } from './fit-engine.service';
import { FitService } from './fit.service';
import { FitPublicController, FitAdminController } from './fit.controller';

/**
 * LURDS FIT AI — recomendação proprietária de tamanho.
 *
 * Módulo isolado de propósito: o motor (FitEngineService) é função pura e
 * pode ser chamado de qualquer lugar (site, PDV, live, WhatsApp) sem arrastar
 * dependência. O aprendizado vive no FitService.
 */
@Module({
  imports: [PrismaModule],
  controllers: [FitPublicController, FitAdminController],
  providers: [FitEngineService, FitService],
  exports: [FitService, FitEngineService],
})
export class FitModule {}
