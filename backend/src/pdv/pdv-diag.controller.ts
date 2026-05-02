import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CrediarioPrintService } from './crediario-print.service';

/**
 * /pdv-diag — endpoints de DIAGNÓSTICO da impressão de promissória.
 * Controller separado SEM JwtAuthGuard pra poder ser acessado direto pelo
 * navegador durante calibração (sem token JWT).
 *
 * SEGURO porque só retorna dados geométricos (coordenadas, paths de arquivo)
 * sem informação de cliente/venda. Cliente fica em /pdv/diag-cliente que
 * continua protegido.
 */
@Controller('pdv-diag')
export class PdvDiagController {
  constructor(private readonly crediarioPrint: CrediarioPrintService) {}

  /**
   * GET /pdv-diag/coords — coordenadas ATIVAS da promissória + path do JSON
   * lido + path da fonte Verdana. Pra confirmar que o JSON foi carregado.
   */
  @Get('coords')
  async getCoords(@Res() res: Response) {
    try {
      const result = this.crediarioPrint.diagCoords();
      res.status(200).json(result);
    } catch (e: any) {
      console.error('[pdv-diag/coords] FALHA', e?.stack || e);
      res.status(500).json({ statusCode: 500, message: 'Erro no diag', detail: e?.message });
    }
  }
}
