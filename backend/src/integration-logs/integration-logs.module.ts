import { Module } from '@nestjs/common';
import { IntegrationLogsController } from './integration-logs.controller';
import { IntegrationLogsService } from './integration-logs.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [IntegrationLogsController],
  providers: [IntegrationLogsService],
  exports: [IntegrationLogsService],
})
export class IntegrationLogsModule {}
