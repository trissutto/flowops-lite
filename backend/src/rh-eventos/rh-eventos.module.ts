import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { RhEventosService } from './rh-eventos.service';
import { RhEventosController } from './rh-eventos.controller';

/**
 * EVENTOS DE RH — atestado, falta, férias, treinamento, advertência.
 *
 * O service é EXPORTADO porque o espelho de ponto e o banco de horas
 * (`PontoModule`) precisam do `mapaDoMes` pra parar de chamar de FALTA todo dia
 * sem batida. Régua dos efeitos: `common/eventos-rh.ts`.
 */
@Module({
  imports: [PrismaModule],
  controllers: [RhEventosController],
  providers: [RhEventosService],
  exports: [RhEventosService],
})
export class RhEventosModule {}
