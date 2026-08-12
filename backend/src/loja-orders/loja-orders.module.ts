import { Module, forwardRef } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { PrismaModule } from '../prisma/prisma.module';
import { PagarmeModule } from '../pagarme/pagarme.module';
import { CorreiosModule } from '../correios/correios.module';
import { LojaOrdersService } from './loja-orders.service';
import { LojaOrdersController } from './loja-orders.controller';
import { CarrinhoGuardService } from './carrinho-guard.service';
import { CupomService } from './cupom.service';
import { LojaPagamentoReconcileService } from './loja-pagamento-reconcile.service';
import { LojaAdminController } from './loja-admin.controller';
import { FreteService } from './frete.service';
import { PersonIdentityModule } from '../person-identity/person-identity.module';
import { EmailModule } from '../email/email.module';
import { PedidoEmailService } from './pedido-email.service';

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
  imports: [
    PrismaModule, HttpModule, CorreiosModule, PersonIdentityModule, EmailModule,
    forwardRef(() => PagarmeModule),
  ],
  controllers: [LojaOrdersController, LojaAdminController],
  providers: [
    LojaOrdersService,
    CarrinhoGuardService,
    CupomService,
    // Fonte única do frete: tabela promocional + cotação do contrato + régua
    // do frete grátis. O site não decide mais preço de entrega.
    FreteService,
    // Rede de segurança do pagamento: o webhook não pode ser a única
    // confirmação, e a conciliação diária é quem descobre o que ninguém viu.
    LojaPagamentoReconcileService,
    // Avisa a cliente: dispara o evento pro fluxo do n8n (que já manda
    // WhatsApp e e-mail no site antigo) e, se ligado, manda o e-mail próprio.
    PedidoEmailService,
  ],
  exports: [LojaOrdersService, CupomService],
})
export class LojaOrdersModule {}
