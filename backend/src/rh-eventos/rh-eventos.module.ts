import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { SellerDocumentsService } from '../sellers/seller-documents.service';
import { RhEventosService } from './rh-eventos.service';
import { RhEventosController } from './rh-eventos.controller';

/**
 * EVENTOS DE RH — atestado, falta, férias, treinamento, advertência.
 *
 * O service é EXPORTADO porque o espelho de ponto e o banco de horas
 * (`PontoModule`) precisam do `mapaDoMes` pra parar de chamar de FALTA todo dia
 * sem batida. Régua dos efeitos: `common/eventos-rh.ts`.
 */
/**
 * `SellerDocumentsService` entra como PROVIDER, não via `SellersModule`.
 *
 * Ele só depende do Prisma, e importar o SellersModule fecharia um ciclo:
 * Sellers precisa deste módulo pra contar as faltas do art. 130 nas férias.
 * Provendo direto, a dependência anda numa direção só.
 */
@Module({
  imports: [PrismaModule],
  controllers: [RhEventosController],
  providers: [RhEventosService, SellerDocumentsService],
  exports: [RhEventosService],
})
export class RhEventosModule {}
