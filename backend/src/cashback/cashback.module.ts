import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CashbackService } from './cashback.service';
import { CashbackPreviaService } from './cashback-previa.service';
import { CashbackController } from './cashback.controller';

/**
 * CASHBACK DA REDE (01/08/2026).
 *
 * Exporta o service porque o PDV precisa chamá-lo na venda e na devolução.
 * Todo ponto de integração é best-effort: erro de cashback vira log, nunca
 * exceção — trocar uma loja parada por centavos de crédito seria péssimo
 * negócio.
 *
 * Nasce DESLIGADO. O interruptor está em SystemSetting, não em env, porque o
 * botão mora na tela de prévia e precisa valer na hora.
 */
@Module({
  imports: [PrismaModule],
  controllers: [CashbackController],
  providers: [CashbackService, CashbackPreviaService],
  exports: [CashbackService],
})
export class CashbackModule {}
