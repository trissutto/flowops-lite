import { Body, Controller, ForbiddenException, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { MarcadosService } from './marcados.service';
import { MarcadosMirrorService } from './marcados-mirror.service';
import { isTrainingRequest } from './training.util';

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
  constructor(
    private readonly svc: MarcadosService,
    private readonly mirror: MarcadosMirrorService,
  ) {}

  private requireRole(req: any) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'operator' && role !== 'store')
      throw new ForbiddenException('Acesso negado');
  }

  private requireAdmin(req: any) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'operator')
      throw new ForbiddenException('Acesso negado');
  }

  /**
   * POST /pdv/marcados/sync — dispara o import Giga → tabela nativa `marcados`
   * em background (acompanha pelo status). Admin/operator.
   */
  @Post('sync')
  startSync(@Req() req: any) {
    this.requireAdmin(req);
    void this.mirror.syncFromGiga();
    return { started: true };
  }

  /** GET /pdv/marcados/sync/status — contadores + último resultado. */
  @Get('sync/status')
  syncStatus(@Req() req: any) {
    this.requireAdmin(req);
    return this.mirror.status();
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
   * GET /pdv/marcados/search?q=...
   * Busca clientes por nome OU CPF parcial — retorna ate 20 matches
   * que TEM marcados ativos. Usado pela tela quando vendedora nao tem
   * o CPF e quer achar pelo nome.
   */
  @Get('search')
  searchClientes(@Req() req: any, @Query('q') q: string) {
    this.requireRole(req);
    return this.svc.searchClientesByNameOrCpf(q || '');
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
    @Body() body: { saleId: string; force?: boolean },
  ) {
    this.requireRole(req);
    const storeCode = req?.user?.storeCode || req?.user?.storeId;
    if (!storeCode) throw new ForbiddenException('Usuário sem loja vinculada');
    const userId = req?.user?.userId || req?.user?.sub;
    const userName = req?.user?.name || req?.user?.email || null;
    return this.svc.criarMarcadoFromSale({
      saleId: body.saleId,
      storeCode,
      userId,
      userName,
      force: !!body.force,
      // TRAVA DE SEGURANÇA: sessão em treino (header) → marcado simulado,
      // sem INSERT em caixa do Giga e sem baixa de estoque.
      trainingRequest: isTrainingRequest(req),
    });
  }

  /**
   * POST /pdv/marcados/puxar-pra-venda
   * Body: { registros: number[], customerCpf?, customerName?, customerPhone? }
   * Cria uma PdvSale aberta com as pecas marcadas como itens, retorna saleId.
   * Frontend redireciona pro PDV pra retomar e finalizar a venda.
   */
  @Post('puxar-pra-venda')
  puxarParaVenda(
    @Req() req: any,
    @Body() body: {
      registros: Array<number | string>;
      customerCpf?: string;
      customerName?: string;
      customerPhone?: string;
    },
  ) {
    this.requireRole(req);
    const storeCode = req?.user?.storeCode || req?.user?.storeId;
    if (!storeCode) throw new ForbiddenException('Usuário sem loja vinculada');
    const vendedorUserId = req?.user?.sub || req?.user?.id;
    const vendedorName = req?.user?.name || req?.user?.email;
    const registros = (body?.registros || []).map((r) => Number(r)).filter((r) => Number.isFinite(r) && r > 0);
    return this.svc.puxarParaVenda({
      registros,
      storeCode,
      customerCpf: body?.customerCpf,
      customerName: body?.customerName,
      customerPhone: body?.customerPhone,
      vendedorUserId,
      vendedorName,
      isTraining: isTrainingRequest(req),
    });
  }
}
