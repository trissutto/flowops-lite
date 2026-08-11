import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { TelemetriaController } from './telemetria.controller';

/**
 * TELEMETRIA DE TELAS — qual rota do CRM foi usada, quando, por quem.
 *
 * Nasceu em 11/08/2026, quando o dono pediu a reorganização dos módulos e a
 * pergunta "que telas ninguém usa?" não tinha resposta: 223 rotas, zero
 * registro de uso em qualquer lugar (a Vercel Web Analytics nunca foi ligada).
 * A partir daqui, cada visita atualiza `page_access` — e a decisão de matar
 * tela passa a ser feita com número.
 */
@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [TelemetriaController],
})
export class TelemetriaModule {}
