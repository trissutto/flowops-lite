import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { WooCommerceModule } from '../woocommerce/woocommerce.module';
import { TrackingModule } from '../tracking/tracking.module';
import { EmailModule } from '../email/email.module';
import { ErpModule } from '../erp/erp.module';
// Reversa dos Correios (item 84) e entrega por WhatsApp: até 12/08/2026 a
// etiqueta era emitida na mão no site dos Correios e o aviso saía por e-mail,
// que não existe em produção — ver `gerarReversaCorreios`.
import { CorreiosModule } from '../correios/correios.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { TrocasService } from './trocas.service';
import { TrocasCronService } from './trocas-cron.service';
import { TrocasPublicController } from './trocas-public.controller';
import { TrocasAdminController } from './trocas-admin.controller';

@Module({
  imports: [PrismaModule, WooCommerceModule, TrackingModule, EmailModule, ErpModule, CorreiosModule, WhatsappModule],
  controllers: [TrocasPublicController, TrocasAdminController],
  providers: [TrocasService, TrocasCronService],
  exports: [TrocasService],
})
export class TrocasModule {}
