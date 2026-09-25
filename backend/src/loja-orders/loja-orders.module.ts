import { Module, forwardRef } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { PrismaModule } from '../prisma/prisma.module';
import { PagarmeModule } from '../pagarme/pagarme.module';
// PagBank cobra o site desde 16/09 (`SITE_GATEWAY=pagbank`). Seta de mão
// única: o PagbankModule NÃO conhece este — o webhook de lá avisa por
// `registrarOuvinte` (ver LojaOrdersService.onModuleInit).
import { PagbankModule } from '../pagbank/pagbank.module';
import { CorreiosModule } from '../correios/correios.module';
import { LojaOrdersService } from './loja-orders.service';
import { LojaOrdersController } from './loja-orders.controller';
import { CarrinhoGuardService } from './carrinho-guard.service';
import { CupomService } from './cupom.service';
import { LojaPagamentoReconcileService } from './loja-pagamento-reconcile.service';
import { LojaPurchaseRetryService } from './loja-purchase-retry.service';
import { LojaAdminController } from './loja-admin.controller';
// Painel /retaguarda/cupons: vale de troca manual + campanha (dono, 01/09).
import { CuponsAdminController } from './cupons-admin.controller';
import { FreteService } from './frete.service';
import { PersonIdentityModule } from '../person-identity/person-identity.module';
// A campanha do caixa (promoção por termo): a trava do carrinho tem que cobrar
// o MESMO preço que a vitrine mostrou (módulo folha — não cria aresta nova no grafo).
import { PromoConfigModule } from '../promo-config/promo-config.module';
import { EmailModule } from '../email/email.module';
// WhatsappModule → o WhatsApp direto dos eventos que o n8n descarta
// (pix_nao_pago / pedido_enviado / pedido_entregue). Ver PedidoEmailService.
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { PedidoEmailService } from './pedido-email.service';
import { PixResgateCron } from './pix-resgate.cron';
import { PedidoExpiraCron } from './pedido-expira.cron';
import { EscudoCheckoutService } from './escudo-checkout.service';
import { RetiradaCoberturaService } from './retirada-cobertura.service';
import { ProgressiveDiscountModule } from '../progressive-discount/progressive-discount.module';
import { RiscoModule } from '../risco/risco.module';
// Cashback: o pedido pago credita o saldo da cliente (confirmarPagamento).
import { CashbackModule } from '../cashback/cashback.module';
// SEPARAÇÃO AUTOMÁTICA (25/09): o pedido pago dispara o roteamento sozinho
// (SeparacaoAutomaticaService). Seta de mão única — o RoutingModule não
// conhece este.
import { RoutingModule } from '../routing/routing.module';

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
    PromoConfigModule,
    CashbackModule,
    ProgressiveDiscountModule,
    // Análise de risco: o pedido novo gera as chaves de cruzamento assim que
    // fecha. Seta de mão única — o RiscoModule não conhece este.
    RiscoModule,
    RoutingModule,
    forwardRef(() => PagarmeModule),
    // forwardRef porque o PagbankModule importa CrediariosModule, que importa
    // PagarmeModule, que importa este — o mesmo laço que a Pagar.me já fecha.
    forwardRef(() => PagbankModule),
  ],
  controllers: [LojaOrdersController, LojaAdminController, CuponsAdminController],
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
    LojaPurchaseRetryService,
    // Avisa a cliente: dispara o evento pro fluxo do n8n (que já manda
    // WhatsApp e e-mail no site antigo) e, se ligado, manda o e-mail próprio.
    PedidoEmailService,
    // Resgate do PIX não pago: toque único aos 30min, dentro da validade.
    PixResgateCron,
    PedidoExpiraCron,
    // Escudo anti-teste-de-cartão (28/08): bloqueia ANTES de criar Order e de
    // chamar a Pagar.me quando o checkout vira banco de testes de cartão.
    EscudoCheckoutService,
    RetiradaCoberturaService,
  ],
  exports: [LojaOrdersService, CupomService],
})
export class LojaOrdersModule {}
