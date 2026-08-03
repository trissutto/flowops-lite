import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { DiagnosticoBancoController } from './diagnostico-banco.controller';
import { HealthController } from './health.controller';
import { MigrationFlagsService } from './migration-flags.service';

@Module({
  imports: [PrismaModule],
  controllers: [HealthController, DiagnosticoBancoController],
  providers: [MigrationFlagsService],
  exports: [MigrationFlagsService],
})
export class HealthModule {}
