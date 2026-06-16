import { Module, forwardRef } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { PrismaModule } from '../prisma/prisma.module';
import { PagbankService } from './pagbank.service';
import { PagbankController } from './pagbank.controller';
import { CrediariosModule } from '../crediarios/crediarios.module';

@Module({
  // forwardRef pra resolver ciclo: Crediarios importa Pagbank,
  // agora Pagbank precisa do CrediarioBaixaService pra disparar baixa
  // no webhook (fix 16/06/2026 — PIX crediário não dava baixa).
  imports: [PrismaModule, HttpModule, forwardRef(() => CrediariosModule)],
  controllers: [PagbankController],
  providers: [PagbankService],
  exports: [PagbankService],
})
export class PagbankModule {}
