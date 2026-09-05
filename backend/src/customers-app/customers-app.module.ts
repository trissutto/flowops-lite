import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { EmailModule } from '../email/email.module';
import { CustomersAppService } from './customers-app.service';
import { CustomersAppController } from './customers-app.controller';
import { CustomerJwtGuard } from './customer-jwt.guard';
import { CustomerLinkingService } from './customer-linking.service';
import { CustomerPushService } from './customer-push.service';
import { CustomerCashbackService } from './customer-cashback.service';
import { AppInviteService } from './app-invite.service';
import { CustomerPasswordResetService } from './customer-password-reset.service';

/**
 * Módulo do app cliente final (PWA app.lurds.com.br).
 * Separado de:
 *   - AuthModule    → operador/admin (login email)
 *   - CustomersModule → CRM interno (lista/edição pela equipe)
 *
 * Compartilha JWT_SECRET com AuthModule mas usa scope='customer' no payload
 * pra evitar cross-uso de tokens. TTL 30 dias (UX cliente final = menos login).
 */
@Module({
  imports: [
    PrismaModule,
    WhatsappModule,
    EmailModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        secret: cfg.get<string>('JWT_SECRET'),
        // Default 30 dias — cliente final raramente quer relogar.
        // Em troca, scope='customer' impede uso indevido em rotas operador.
        signOptions: { expiresIn: cfg.get<string>('APP_CUSTOMER_TTL') ?? '30d' },
      }),
    }),
  ],
  providers: [
    CustomersAppService,
    CustomerJwtGuard,
    CustomerLinkingService,
    CustomerPushService,
    CustomerCashbackService,
    AppInviteService,
    CustomerPasswordResetService,
  ],
  controllers: [CustomersAppController],
  exports: [
    CustomersAppService,
    CustomerJwtGuard,
    CustomerLinkingService,
    CustomerPushService,
    CustomerCashbackService,
    AppInviteService,
    CustomerPasswordResetService,
    // O OrderAppHooksService foi DELETADO em 09/2026: ele era chamado depois
    // de cada `upsertFromWooCommerce` (cashback + push do app cliente a partir
    // do pedido WC), e ficou sem chamador quando o WooCommerce saiu do ar. O
    // cashback e o push do app continuam existindo nos seus próprios services.
    // Exporta JwtModule pra módulos externos (SizeFeedbackModule etc) que
    // usem o CustomerJwtGuard — sem isso o Nest não resolve JwtService.
    JwtModule,
  ],
})
export class CustomersAppModule {}
