import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PagbankModule } from '../pagbank/pagbank.module';
import { PagarmeModule } from '../pagarme/pagarme.module';
import { EmailModule } from '../email/email.module';
import { EstornosController } from './estornos.controller';
import { EstornosService } from './estornos.service';
import { EstornosAcessoService } from './estornos-acesso.service';
import { EstornoComprovanteService } from './estorno-comprovante.service';
import { EstornosExportService } from './estornos-export.service';
import { EstornosCron } from './estornos.cron';

/**
 * ESTORNOS E DEVOLUÇÕES (22/09/2026).
 *
 * Módulo FOLHA de propósito: importa os dois gateways, o Prisma e o e-mail, e
 * ninguém importa ele de volta. Nada aqui é dependência de venda, separação ou
 * catálogo — devolver dinheiro não pode entrar no caminho crítico de nada.
 */
@Module({
  imports: [PrismaModule, PagbankModule, PagarmeModule, EmailModule],
  controllers: [EstornosController],
  providers: [
    EstornosService,
    EstornosAcessoService,
    EstornoComprovanteService,
    EstornosExportService,
    EstornosCron,
  ],
  exports: [EstornosService],
})
export class EstornosModule {}
