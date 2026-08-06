import { Body, Controller, Delete, ForbiddenException, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { FornecedoresService } from './fornecedores.service';

/**
 * Cadastro de fornecedor. Usado pelo Contas a Pagar e pelos pedidos de compra,
 * que antes só conseguiam LISTAR o que veio do Giga.
 */
@Controller('fornecedores')
@UseGuards(JwtAuthGuard)
export class FornecedoresController {
  constructor(private readonly svc: FornecedoresService) {}

  /** Cadastro de fornecedor mexe em quem a empresa paga — restrito a admin. */
  private requireAdmin(req: any) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
  }

  @Get()
  listar(@Req() req: any, @Query('q') q?: string, @Query('apenasFlow') apenasFlow?: string) {
    this.requireAdmin(req);
    return this.svc.listar(q, apenasFlow === '1');
  }

  @Get('checar-cnpj')
  checarCnpj(@Req() req: any, @Query('cnpj') cnpj: string, @Query('ignorar') ignorar?: string) {
    this.requireAdmin(req);
    return this.svc.checarCnpj(cnpj, ignorar ? Number(ignorar) : undefined);
  }

  @Get(':codigo')
  buscar(@Req() req: any, @Param('codigo') codigo: string) {
    this.requireAdmin(req);
    return this.svc.buscar(Number(codigo));
  }

  @Post()
  criar(@Req() req: any, @Body() body: any) {
    this.requireAdmin(req);
    return this.svc.criar(body, req?.user?.name || req?.user?.email);
  }

  @Put(':codigo')
  atualizar(@Req() req: any, @Param('codigo') codigo: string, @Body() body: any) {
    this.requireAdmin(req);
    return this.svc.atualizar(Number(codigo), body, req?.user?.name || req?.user?.email);
  }

  /** Bloqueado quando há Conta a Pagar vinculada; réplica da exclusão vai pro Giga. */
  @Delete(':codigo')
  excluir(@Req() req: any, @Param('codigo') codigo: string) {
    this.requireAdmin(req);
    return this.svc.excluir(Number(codigo), req?.user?.name || req?.user?.email);
  }
}
