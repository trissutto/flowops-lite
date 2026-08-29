import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { PushModule } from '../push/push.module';
import { RhEventosModule } from '../rh-eventos/rh-eventos.module';
import { PontoController } from './ponto.controller';
import { PontoService } from './ponto.service';
import { PontoCronService } from './ponto-cron.service';

// RhEventosModule entra aqui porque o espelho e o banco de horas precisam saber
// POR QUE o dia ficou vazio — sem isso os dois chamam atestado de falta.
@Module({
  imports: [AuthModule, PrismaModule, PushModule, RhEventosModule],
  controllers: [PontoController],
  providers: [PontoService, PontoCronService],
  exports: [PontoService],
})
export class PontoModule {}
