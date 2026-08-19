import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CorreiosModule } from '../correios/correios.module';
import { MaisEnviosModule } from '../mais-envios/mais-envios.module';
import { FreteReportService } from './frete-report.service';
import { FreteController } from './frete.controller';

/** Gestão › Frete: envios SEDEX/PAC (cliente + entre lojas) — cobrado × pago. */
@Module({
  imports: [AuthModule, CorreiosModule, MaisEnviosModule],
  providers: [FreteReportService],
  controllers: [FreteController],
})
export class FreteModule {}
