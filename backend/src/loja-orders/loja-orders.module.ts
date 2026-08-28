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
// A promoção de 50% do caixa: a trava do carrinho tem que cobrar o MESMO
// preço que a vitrine mostrou (módulo folha — não cria aresta nova no grafo).
import { PromoSiteModule } from '../promo-site/promo-site.module';
import { EmailModule } from '../email/email.module';
// WhatsappModule → o WhatsApp direto dos eventos que o n8n descarta
// (pix_nao_pago / pedido_enviado / pedido_entregue). Ver PedidoEmailService.
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { PedidoEmailService } from './pedido-email.service';
import { PixResgateCron } from './pix-resgate.cron';
import { PedidoExpiraCron } from './pedido-expira.cron';
import { EscudoCheckoutService } from './escudo-checkout.service';
import { ProgressiveDiscountModule } from '../progressive-discount/progressive-discount.module';
import { RiscoModule } from '../risco/risco.module';

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
    PrismaModule, HttpModule, CorreiosModule, PersonIdentityModule, EmailModule, WhatsappModule,
    PromoSiteModule,
    ProgressiveDiscountModule,
    // Análise de risco: o pedido novo gera as chaves de cruzamento assim que
    // fecha. Seta de mão única — o RiscoModule não conhece este.
    RiscoModule,
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
    // Resgate do PIX não pago: toque único aos 30min, dentro da validade.
    PixResgateCron,
    PedidoExpiraCron,
    // Escudo anti-teste-de-cartão (28/08): bloqueia ANTES de criar Order e de
    // chamar a Pagar.me quando o checkout vira banco de testes de cartão.
    EscudoCheckoutService,
  ],
  exports: [LojaOrdersService, CupomService],
})
export class LojaOrdersModule {}
