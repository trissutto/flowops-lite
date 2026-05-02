import { Body, Controller, ForbiddenException, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { MarcadosService } from './marcados.service';

/**
 * /pdv/marcados — sistema de "leva pra provar em casa".
 *
 * Endpoints:
 *   GET  /pdv/marcados/cliente?cpf=XXX  — info cliente + marcados ativos
 *   GET  /pdv/marcados                  — lista geral (admin/operator)
 *   POST /pdv/marcados/devolver         — devolve 1 peça marcada (estorna estoque)
 */
@Controller('pdv/marcados')
@UseGuards(JwtAuthGuard)
export class MarcadosController {
  constructor(private readonly svc: MarcadosService) {}

  private requireRole(req: any) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'operator' && role !== 'store')
      throw new ForbiddenException('Acesso negado');
  }

  /**
   * GET /pdv/marcados/cliente?cpf=XXX
   * Retorna info do cliente + lista de marcados ativos + valida se pode marcar.
   */
  @Get('cliente')
  getClienteInfo(@Req() req: any, @Query('cpf') cpf: string) {
    this.requireRole(req);
    return this.svc.getClienteMarcadorInfo(cpf);
  }

  /**
   * GET /pdv/marcados — lista todos os marcados ativos (visão geral retaguarda).
   * Query: loja, dataInicial, dataFinal, limit
   */
  @Get()
  listAll(
    @Req() req: any,
    @Query('loja') loja?: string,
    @Query('dataInicial') dataInicial?: string,
    @Query('dataFinal') dataFinal?: string,
    @Query('limit') limit?: string,
  ) {
    this.requireRole(req);
    return this.svc.listAllMarcados({
      loja,
      dataInicial,
      dataFinal,
      limit: limit ? Number(limit) : 100,
    });
  }

  /**
   * POST /pdv/marcados/devolver
   * Body: { registro, sku, qty, loja }
   * Devolve 1 peça marcada ao estoque Giga (cliente trouxe de volta).
   */
  @Post('devolver')
  devolver(
    @Req() req: any,
    @Body() body: { registro: number | string; sku: string; qty: number; loja: string },
  ) {
    this.requireRole(req);
    return this.svc.devolverItemMarcado(body);
  }

  /**
   * POST /pdv/marcados/criar
   * Body: { saleId }
   * Cria marcado a partir de uma venda PDV existente — INSERT em caixa
   * com MARCADO='SIM' + baixa estoque + fecha PdvSale.
   */
  @Post('criar')
  criar(
    @Req() req: any,
    @Body() body: { saleId: string },
  ) {
    this.requireRole(req);
    const storeCode = req?.user?.storeCode || req?.user?.storeId;
    if (!storeCode) throw new ForbiddenException('Usuário sem loja vinculada');
    const userId = req?.user?.userId || req?.user?.sub;
    return this.svc.criarMarcadoFromSale({
      saleId: body.saleId,
      storeCode,
      userId,
    });
  }
}
