import { Body, Controller, ForbiddenException, Get, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { DceEmitService, DceDestInput, DceItemInput } from './dce-emit.service';
import { DacePdfService } from './dace-pdf.service';

/**
 * DC-e (Declaração de Conteúdo eletrônica) — emissão, consulta e DACE (PDF).
 * Homologação primeiro: emitir com ambienteOverride '2' até validar o fluxo;
 * produção só depois do OK do contador.
 */
@Controller('dce')
@UseGuards(JwtAuthGuard)
export class DceController {
  constructor(
    private readonly svc: DceEmitService,
    private readonly dace: DacePdfService,
  ) {}

  private requireRole(req: any) {
    const role = req?.user?.role;
    if (!['admin', 'operator', 'store'].includes(role)) throw new ForbiddenException('Sem permissão');
  }

  /** Emite uma DC-e (avulsa ou vinculada a um pick-order). */
  @Post('emitir')
  emitir(
    @Req() req: any,
    @Body() body: {
      storeCode: string;
      dest: DceDestInput;
      itens: DceItemInput[];
      pickOrderId?: string;
      ambiente?: '1' | '2';
    },
  ) {
    this.requireRole(req);
    return this.svc.emitir({
      storeCode: body.storeCode,
      dest: body.dest,
      itens: body.itens,
      pickOrderId: body.pickOrderId || null,
      ambienteOverride: body.ambiente,
    });
  }

  /** Lista as DC-e emitidas (retaguarda/diagnóstico). */
  @Get()
  list(@Req() req: any, @Query('store') store?: string, @Query('limit') limit?: string) {
    this.requireRole(req);
    return this.svc.list({ storeCode: store || undefined, limit: limit ? Number(limit) : undefined });
  }

  /** Detalhe de uma DC-e (inclui XMLs pra diagnóstico). */
  @Get(':id')
  get(@Req() req: any, @Param('id') id: string) {
    this.requireRole(req);
    return this.svc.get(id);
  }

  /** DACE em PDF (a folha com QR que vai no pacote). */
  @Get(':id/dace')
  async dacePdf(@Req() req: any, @Param('id') id: string, @Res() res: any) {
    this.requireRole(req);
    const pdf = await this.dace.gerar(id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="dace-${id}.pdf"`);
    res.send(pdf);
  }
}
