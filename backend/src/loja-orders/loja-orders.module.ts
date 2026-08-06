import { Module, forwardRef } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { PrismaModule } from '../prisma/prisma.module';
import { PagarmeModule } from '../pagarme/pagarme.module';
import { CorreiosModule } from '../correios/correios.module';
import { LojaOrdersService } from './loja-orders.service';
import { LojaOrdersController } from './loja-orders.controller';

/**
 * PEDIDOS DO E-COMMERCE NOVO (sprint 011).
 *
 * O pedido da loja nasce no Postgres do Flow e entra no MESMO trilho do
 * pedido do site/live (`Order` com `source='ecommerce'`) — roteamento, separação,
 * etiqueta e faturamento continuam sendo os de sempre.
 *
 * `forwardRef` no PagarmeModule porque a dependência é mútua: aqui a gente
 * usa o `PagarmeService` pra cobrar, e o webhook público que mora lá
 * (`POST /pagarme/webhook`) chama o `confirmarPagamento` daqui quando o
 * dinheiro entra.
 */
@Module({
  imports: [PrismaModule, HttpModule, CorreiosModule, forwardRef(() => PagarmeModule)],
  controllers: [LojaOrdersController],
  providers: [LojaOrdersService],
  exports: [LojaOrdersService],
})
export class LojaOrdersModule {}
