import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ErpModule } from '../erp/erp.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { CrediariosService } from './crediarios.service';
import { CrediariosController } from './crediarios.controller';
import { CobrancaAutoService } from './cobranca-auto.service';

@Module({
  imports: [ScheduleModule.forRoot(), ErpModule, WhatsappModule],
  controllers: [CrediariosController],
  providers: [CrediariosService, CobrancaAutoService],
  exports: [CrediariosService, CobrancaAutoService],
})
export class CrediariosModule {}
