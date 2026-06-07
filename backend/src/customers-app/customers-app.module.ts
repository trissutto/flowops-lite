import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { CustomersAppService } from './customers-app.service';
import { CustomersAppController } from './customers-app.controller';
import { CustomerJwtGuard } from './customer-jwt.guard';
import { CustomerLinkingService } from './customer-linking.service';

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
  providers: [CustomersAppService, CustomerJwtGuard, CustomerLinkingService],
  controllers: [CustomersAppController],
  // Linking service exportado pra ETL Giga importar e usar quando criar Customer.
  exports: [CustomersAppService, CustomerJwtGuard, CustomerLinkingService],
})
export class CustomersAppModule {}
