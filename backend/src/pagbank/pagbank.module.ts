import { Module, forwardRef } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { PrismaModule } from '../prisma/prisma.module';
import { PagbankService } from './pagbank.service';
import { PagbankController } from './pagbank.controller';
import { CrediariosModule } from '../crediarios/crediarios.module';
import { PdvModule } from '../pdv/pdv.module';

@Module({
  // forwardRef pra resolver ciclo: Crediarios importa Pagbank,
  // agora Pagbank precisa do CrediarioBaixaService pra disparar baixa
  // no webhook (fix 16/06/2026 — PIX crediário não dava baixa).
  // PdvModule TAMBÉM entra em forwardRef (dono 07/08 — auto-confirma venda
  // normal no webhook): Pdv já importa Crediarios com forwardRef, que por
  // sua vez importa Pagbank — fechando o ciclo Pagbank→Pdv→Crediarios→Pagbank.
  imports: [
    PrismaModule,
    HttpModule,
    forwardRef(() => CrediariosModule),
    forwardRef(() => PdvModule),
  ],
  controllers: [PagbankController],
  providers: [PagbankService],
  exports: [PagbankService],
})
export class PagbankModule {}
