import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CorreiosModule } from '../correios/correios.module';
import { MaisEnviosModule } from '../mais-envios/mais-envios.module';
import { TrackingController } from './tracking.controller';
import { TrackingService } from './tracking.service';
import { RastreioSyncCron } from './rastreio-sync.cron';

/**
 * Rastreio do objeto. As DUAS transportadoras entram aqui porque a casa emite
 * etiqueta pelos dois caminhos e cada um só conhece as suas — ver a cascata em
 * `TrackingService`.
 */
@Module({
  imports: [AuthModule, CorreiosModule, MaisEnviosModule],
  controllers: [TrackingController],
  providers: [TrackingService, RastreioSyncCron],
  exports: [TrackingService],
})
export class TrackingModule {}
