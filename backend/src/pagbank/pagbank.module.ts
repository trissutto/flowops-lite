import { Module, forwardRef } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { PrismaModule } from '../prisma/prisma.module';
import { PagbankService } from './pagbank.service';
import { PagbankController } from './pagbank.controller';
import { PixLinkPublicController } from './pix-link-public.controller';
import { CrediariosModule } from '../crediarios/crediarios.module';
import { PagbankPixReconcileService } from './pagbank-pix-reconcile.service';

@Module({
  // forwardRef pra resolver ciclo: Crediarios importa Pagbank,
  // agora Pagbank precisa do CrediarioBaixaService pra disparar baixa
  // no webhook (fix 16/06/2026 — PIX crediário não dava baixa).
  imports: [PrismaModule, HttpModule, forwardRef(() => CrediariosModule)],
  controllers: [PagbankController, PixLinkPublicController],
  // `PagbankPixReconcileService` entra SÓ como provider e usa as dependências
  // que este módulo já tem (Prisma, PagbankService, CrediarioBaixaService via
  // forwardRef). Nenhum import de módulo novo — foi um import novo que fechou
  // o ciclo e impediu o backend de subir em 07/08.
  providers: [PagbankService, PagbankPixReconcileService],
  exports: [PagbankService],
})
export class PagbankModule {}
