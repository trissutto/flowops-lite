import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { EtiquetaConfigController } from './etiqueta-config.controller';
import { EtiquetaConfigService } from './etiqueta-config.service';

@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [EtiquetaConfigController],
  providers: [EtiquetaConfigService],
  exports: [EtiquetaConfigService],
})
export class EtiquetaConfigModule {}
