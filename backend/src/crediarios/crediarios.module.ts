import { Module, forwardRef } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ErpModule } from '../erp/erp.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { PagarmeModule } from '../pagarme/pagarme.module';
import { PagbankModule } from '../pagbank/pagbank.module';
import { CrediariosService } from './crediarios.service';
import { CrediariosController } from './crediarios.controller';
import { CobrancaAutoService } from './cobranca-auto.service';
import { CrediarioBaixaService } from './crediario-baixa.service';
import { CrediarioBaixaController } from './crediario-baixa.controller';
import { CrediarioBaixaPublicController } from './crediario-baixa-public.controller';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    ErpModule,
    WhatsappModule,
    forwardRef(() => PagarmeModule),
    forwardRef(() => PagbankModule),
  ],
  controllers: [CrediariosController, CrediarioBaixaController, CrediarioBaixaPublicController],
  providers: [CrediariosService, CobrancaAutoService, CrediarioBaixaService],
  exports: [CrediariosService, CobrancaAutoService, CrediarioBaixaService],
})
export class CrediariosModule {}
