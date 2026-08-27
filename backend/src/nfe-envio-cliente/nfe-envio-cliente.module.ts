import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { EmailModule } from '../email/email.module';
import { NfeModule } from '../nfe/nfe.module';
import { NfeEnvioClienteService } from './nfe-envio-cliente.service';
import { NfeEnvioClienteController } from './nfe-envio-cliente.controller';

/**
 * Módulo do envio da NF pra cliente.
 *
 * `NfeModule` entra só pelo `DanfePdfService` (que ele já exporta) — o PDF é
 * gerado pelo mesmo caminho que o relatório fiscal e a tela do pedido usam.
 * Nada aqui reimplementa DANFE.
 *
 * 🚨 Sem cron e sem gancho: o módulo não se ativa sozinho. Ver a trava
 * `NFE_ENVIO_CLIENTE` no serviço.
 */
@Module({
  imports: [PrismaModule, EmailModule, NfeModule],
  controllers: [NfeEnvioClienteController],
  providers: [NfeEnvioClienteService],
  exports: [NfeEnvioClienteService],
})
export class NfeEnvioClienteModule {}
