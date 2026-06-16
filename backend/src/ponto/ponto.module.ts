import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { PushModule } from '../push/push.module';
import { PontoController } from './ponto.controller';
import { PontoService } from './ponto.service';
import { PontoCronService } from './ponto-cron.service';

@Module({
  imports: [AuthModule, PrismaModule, PushModule],
  controllers: [PontoController],
  providers: [PontoService, PontoCronService],
  exports: [PontoService],
})
export class PontoModule {}
