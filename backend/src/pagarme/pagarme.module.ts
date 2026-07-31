import { Module, forwardRef } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { PrismaModule } from '../prisma/prisma.module';
import { PagarmeService } from './pagarme.service';
import { PagarmeReconcileService } from './pagarme-reconcile.service';
import { PagarmeController } from './pagarme.controller';
import { CrediariosModule } from '../crediarios/crediarios.module';
import { LojaOrdersModule } from '../loja-orders/loja-orders.module';

// forwardRef no LojaOrdersModule: o loja-orders usa o PagarmeService pra
// cobrar e o webhook daqui chama o confirmarPagamento de lá — dependência
// mútua por desenho (o webhook é um só pra toda a casa).
@Module({
  imports: [
    PrismaModule,
    HttpModule,
    forwardRef(() => CrediariosModule),
    forwardRef(() => LojaOrdersModule),
  ],
  controllers: [PagarmeController],
  providers: [PagarmeService, PagarmeReconcileService],
  exports: [PagarmeService],
})
export class PagarmeModule {}
