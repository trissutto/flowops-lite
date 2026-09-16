import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { ConciliacaoCartaoController } from './conciliacao-cartao.controller';
import { ConciliacaoCartaoService } from './conciliacao-cartao.service';
import { StoneArquivosService } from './stone-arquivos.service';

/** Conferência de cartões × Stone (16/09/2026) — ver conciliacao-cartao.service.ts. */
@Module({
  imports: [PrismaModule, WhatsappModule],
  providers: [ConciliacaoCartaoService, StoneArquivosService],
  controllers: [ConciliacaoCartaoController],
})
export class ConciliacaoCartaoModule {}
