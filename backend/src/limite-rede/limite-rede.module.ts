import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { LimiteRedeController } from './limite-rede.controller';
import { LimiteRedeService } from './limite-rede.service';

/**
 * Limite único da rede. Entregue INERTE de propósito: o serviço existe e os
 * endpoints de análise respondem, mas o bloqueio não está plugado em nenhuma
 * venda nem em nenhum marcado, e o interruptor nasce desligado.
 *
 * Ligar é decisão com a lista das 197 pessoas na mão — não efeito de deploy.
 */
@Module({
  imports: [PrismaModule],
  controllers: [LimiteRedeController],
  providers: [LimiteRedeService],
  exports: [LimiteRedeService],
})
export class LimiteRedeModule {}
