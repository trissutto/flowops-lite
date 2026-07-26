import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { MigrationFlagsService } from './migration-flags.service';

@Module({
  controllers: [HealthController],
  providers: [MigrationFlagsService],
  exports: [MigrationFlagsService],
})
export class HealthModule {}
