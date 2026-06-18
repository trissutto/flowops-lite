import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WpDbModule } from '../wp-db/wp-db.module';
import { CarrinhosAbandonadosController } from './carrinhos-abandonados.controller';
import { CarrinhosAbandonadosService } from './carrinhos-abandonados.service';

@Module({
  imports: [AuthModule, WpDbModule],
  controllers: [CarrinhosAbandonadosController],
  providers: [CarrinhosAbandonadosService],
})
export class CarrinhosAbandonadosModule {}
