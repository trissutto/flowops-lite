import { Module } from '@nestjs/common';
import { CnpjConsultaService } from './cnpj-consulta.service';

/**
 * Módulo FOLHA de propósito: não importa nenhum outro módulo do app (só fala
 * com a rede), então qualquer um pode importá-lo sem risco de ciclo — a lição
 * de 07/08, quando um import novo no PdvModule impediu o backend de subir.
 */
@Module({
  providers: [CnpjConsultaService],
  exports: [CnpjConsultaService],
})
export class CnpjModule {}
