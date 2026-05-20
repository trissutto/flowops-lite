import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { FiscalReportService } from './fiscal-report.service';

/** Roles permitidos pra ver relatório fiscal e baixar XMLs. */
const FISCAL_ROLES = ['admin', 'supervisor', 'contador'];

/**
 * GET /pdv/relatorio-fiscal?from=YYYY-MM-DD&to=YYYY-MM-DD&...
 *
 * Relatório fiscal pra auditoria — filtros, KPIs e linhas detalhadas.
 * Todos filtros opcionais exceto from/to. Multi-valor passa separado por
 * vírgula: storeCodes=01,06 ou cnpjs=30246592000197,12345678000100.
 */
@Controller('pdv/relatorio-fiscal')
@UseGuards(JwtAuthGuard)
export class FiscalReportController {
  constructor(private readonly svc: FiscalReportService) {}

  @Get()
  async query(
    @Req() req: any,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('storeCodes') storeCodes?: string,
    @Query('cnpjs') cnpjs?: string,
    @Query('series') series?: string,
    @Query('nfceStatus') nfceStatus?: string,
    @Query('paymentMethods') paymentMethods?: string,
    @Query('sellers') sellers?: string,
    @Query('customerCpf') customerCpf?: string,
    @Query('customerName') customerName?: string,
    @Query('chave') chave?: string,
    @Query('minValor') minValor?: string,
    @Query('maxValor') maxValor?: string,
    @Query('onlyInconsistent') onlyInconsistent?: string,
  ) {
    const role = req?.user?.role;
    if (!FISCAL_ROLES.includes(role)) {
      throw new ForbiddenException('Apenas admin, supervisor ou contador');
    }
    if (!from) throw new BadRequestException('Parâmetro "from" obrigatório (YYYY-MM-DD)');
    const dFrom = new Date(from + 'T00:00:00');
    const dTo = to ? new Date(to + 'T00:00:00') : dFrom;
    if (isNaN(dFrom.getTime()) || isNaN(dTo.getTime())) {
      throw new BadRequestException('Data inválida (use YYYY-MM-DD)');
    }
    if (dTo < dFrom) throw new BadRequestException('"to" não pode ser anterior a "from"');

    const split = (v?: string): string[] | null =>
      v ? v.split(',').map((x) => x.trim()).filter(Boolean) : null;

    return this.svc.query({
      from: dFrom,
      to: dTo,
      storeCodes: split(storeCodes),
      cnpjs: split(cnpjs),
      series: split(series),
      nfceStatus: split(nfceStatus),
      paymentMethods: split(paymentMethods),
      sellers: split(sellers),
      customerCpf: customerCpf || null,
      customerName: customerName || null,
      chave: chave || null,
      minValor: minValor ? parseFloat(minValor) : null,
      maxValor: maxValor ? parseFloat(maxValor) : null,
      onlyInconsistent: onlyInconsistent === '1' || onlyInconsistent === 'true',
    });
  }

  /**
   * GET /pdv/relatorio-fiscal/xmls.zip?from=YYYY-MM-DD&to=YYYY-MM-DD&storeCodes=01,06
   *
   * Download ZIP com todos os XMLs autorizados (e canceladados) do período.
   * Estrutura:
   *   LOJA-01-ITANHAEM/
   *     35260530246592...-nfe.xml
   *     35260530246592...-canc.xml
   *   LOJA-06-SOROCABA/
   *     ...
   *
   * Pro contador anexar na apuração fiscal mensal.
   */
  @Get('xmls.zip')
  async downloadXmls(
    @Req() req: any,
    @Res() res: Response,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('storeCodes') storeCodes?: string,
    @Query('cnpjs') cnpjs?: string,
  ) {
    const role = req?.user?.role;
    if (!FISCAL_ROLES.includes(role)) {
      throw new ForbiddenException('Apenas admin, supervisor ou contador');
    }
    if (!from) throw new BadRequestException('Parâmetro "from" obrigatório (YYYY-MM-DD)');
    const dFrom = new Date(from + 'T00:00:00');
    const dTo = to ? new Date(to + 'T00:00:00') : dFrom;
    if (isNaN(dFrom.getTime()) || isNaN(dTo.getTime())) {
      throw new BadRequestException('Data inválida (use YYYY-MM-DD)');
    }
    if (dTo < dFrom) throw new BadRequestException('"to" não pode ser anterior a "from"');

    const split = (v?: string): string[] | null =>
      v ? v.split(',').map((x) => x.trim()).filter(Boolean) : null;

    return this.svc.streamXmlsZip(res, {
      from: dFrom,
      to: dTo,
      storeCodes: split(storeCodes),
      cnpjs: split(cnpjs),
    });
  }
}
