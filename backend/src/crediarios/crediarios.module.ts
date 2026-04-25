import { Module } from '@nestjs/common';
import { ErpModule } from '../erp/erp.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { CrediariosService } from './crediarios.service';
import { CrediariosController } from './crediarios.controller';

@Module({
  imports: [ErpModule, WhatsappModule],
  controllers: [CrediariosController],
  providers: [CrediariosService],
  exports: [CrediariosService],
})
export class CrediariosModule {}
