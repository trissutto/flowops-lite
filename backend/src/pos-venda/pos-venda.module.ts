import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { AvaliacoesModule } from '../avaliacoes/avaliacoes.module';
import { PosVendaService } from './pos-venda.service';
import { PosVendaController, AvaliarTokenController } from './pos-venda.controller';
import { PosVendaConviteCron } from './pos-venda-convite.cron';

/**
 * PÓS-VENDA — o convite pra avaliar (D+5 da entrega) e a fila da retaguarda.
 *
 * Não tem service de avaliação própria de propósito: quem grava, calcula ponto
 * e modera é o `AvaliacoesModule`. Aqui mora só o TOQUE — quem chamar, quando,
 * por onde, e o link que abre sem login.
 */
@Module({
  imports: [PrismaModule, AuthModule, HttpModule, WhatsappModule, AvaliacoesModule],
  controllers: [PosVendaController, AvaliarTokenController],
  providers: [PosVendaService, PosVendaConviteCron],
  exports: [PosVendaService],
})
export class PosVendaModule {}
