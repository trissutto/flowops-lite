import { Body, Controller, ForbiddenException, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { ConveniosService } from './convenios.service';

/** /admin/convenios — gestão do convênio (matriz). */
@Controller('admin/convenios')
@UseGuards(JwtAuthGuard)
export class ConveniosAdminController {
  constructor(private readonly svc: ConveniosService) {}

  private requireAdmin(req: any) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'operator') {
      throw new ForbiddenException('Apenas matriz (admin/operator)');
    }
  }

  @Get()
  listar(@Req() req: any) {
    this.requireAdmin(req);
    return this.svc.listar();
  }

  @Post()
  criar(@Req() req: any, @Body() body: { nome: string; storeCode: string; diaFechamento?: number; obs?: string }) {
    this.requireAdmin(req);
    return this.svc.criar(body || ({} as any));
  }

  @Post(':id')
  editar(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    this.requireAdmin(req);
    return this.svc.editar(id, body || {});
  }

  @Get(':id/membros')
  membros(@Req() req: any, @Param('id') id: string) {
    this.requireAdmin(req);
    return this.svc.membros(id);
  }

  @Post(':id/membros')
  addMembros(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { membros: Array<{ nome: string; matricula?: string; limiteReais?: number }> },
  ) {
    this.requireAdmin(req);
    return this.svc.addMembros(id, body?.membros || []);
  }

  @Post('membros/:membroId')
  editarMembro(@Req() req: any, @Param('membroId') membroId: string, @Body() body: any) {
    this.requireAdmin(req);
    return this.svc.editarMembro(membroId, body || {});
  }

  @Post(':id/fechar-fatura')
  fecharFatura(@Req() req: any, @Param('id') id: string, @Body() body: { de?: string; ate?: string; obs?: string }) {
    this.requireAdmin(req);
    return this.svc.fecharFatura(id, body || {});
  }

  @Get(':id/faturas')
  faturas(@Req() req: any, @Param('id') id: string) {
    this.requireAdmin(req);
    return this.svc.faturas(id);
  }

  @Get('faturas/:faturaId/detalhe')
  faturaDetalhe(@Req() req: any, @Param('faturaId') faturaId: string) {
    this.requireAdmin(req);
    return this.svc.faturaDetalhe(faturaId);
  }

  @Post('faturas/:faturaId/pagar')
  marcarPaga(@Req() req: any, @Param('faturaId') faturaId: string) {
    this.requireAdmin(req);
    return this.svc.marcarPaga(faturaId);
  }
}

/** /pdv/convenio — usado pelo CAIXA da loja conveniada (JWT, sem gate de papel:
 *  operadora da loja precisa acessar; validação real acontece no addPayment). */
@Controller('pdv/convenio')
@UseGuards(JwtAuthGuard)
export class ConveniosPdvController {
  constructor(private readonly svc: ConveniosService) {}

  /** Convênio ativo da loja (null = loja sem convênio → PDV não mostra o botão). */
  @Get('ativo')
  ativo(@Query('storeCode') storeCode?: string) {
    return this.svc.ativoPorLoja(String(storeCode || ''));
  }

  /** Busca associado por nome/matrícula, com limite disponível do ciclo. */
  @Get(':id/membros')
  membros(@Param('id') id: string, @Query('q') q?: string) {
    return this.svc.buscarMembros(id, q);
  }
}
