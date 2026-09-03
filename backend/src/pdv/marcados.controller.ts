import { Body, Controller, ForbiddenException, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { authorizeMinLevel } from '../auth/auth-levels.util';
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

  // (GET /pdv/marcados/restos-giga saiu na Onda 1: era a última leitura ao
  // vivo da `caixa` do MySQL, que morreu em 27/08.)

  /**
   * GET /pdv/marcados/diagnostico-identidade?cpf=XXX — "de quem é de
   * verdade" (07/08, caso Daiana). Read-only: mostra o código bruto de cada
   * marcado com este CPF e toda ficha de QUALQUER loja com esse mesmo
   * código — a lista de candidatas à dona real, quando o CPF gravado veio do
   * fallback errado do sync (corrigido hoje, mas não reprocessa sozinho o
   * que já ficou gravado).
   */
  @Get('diagnostico-identidade')
  diagnosticoIdentidade(@Req() req: any, @Query('cpf') cpf: string) {
    this.requireAdmin(req);
    return this.mirror.diagnosticarIdentidade(cpf || '');
  }

  /**
   * GET /pdv/marcados/diagnostico-cliente?loja=11&codCliente=148 — estado
   * cru de cada marcado (07/08, caso Eliana): status, saleId, se tem
   * registroGiga/numero (marcado 'flow' sem réplica confirmada nasce sem os
   * dois — e a tela antiga de puxar dependia exatamente disso). Read-only.
   */
  @Get('diagnostico-cliente')
  diagnosticoCliente(@Req() req: any, @Query('loja') loja: string, @Query('codCliente') codCliente: string) {
    this.requireAdmin(req);
    return this.svc.diagnosticarCliente(loja || '', codCliente || '');
  }

  /**
   * POST /pdv/marcados/reconciliar-presos — remendo pontual (07/08, caso
   * Limeira): fecha marcados travados em 'puxado' cuja venda já finalizou.
   * Roda na hora (não é fila) — é um lote de correção, não operação de rotina.
   */
  @Post('reconciliar-presos')
  reconciliarPresos(@Req() req: any) {
    this.requireAdmin(req);
    return this.svc.reconciliarPuxadosOrfaos();
  }

  /** GET /pdv/marcados/sync/status — contadores + último resultado. */
  @Get('sync/status')
  syncStatus(@Req() req: any) {
    this.requireAdmin(req);
    return this.mirror.status();
  }

  /**
   * POST /pdv/marcados/dedup { codCliente?, cpf?, dryRun? }
   * Limpa marcações DUPLICADAS de um cliente (linhas-fantasma que o sync criou).
   * dryRun=true (default) só mostra o que fecharia. Admin.
   */
  @Post('dedup')
  dedup(
    @Req() req: any,
    @Body() body: { codCliente?: string; cpf?: string; dryRun?: boolean },
  ) {
    this.requireRole(req);
    return this.svc.dedupMarcadosCliente({
      codCliente: body?.codCliente,
      cpf: body?.cpf,
      dryRun: body?.dryRun,
    });
  }

  /**
   * GET /pdv/marcados/analise?cpf=...  (read-only)
   * Agrupa os marcados ativos do cliente por NUMERO — enxerga a duplicação.
   */
  @Get('analise')
  analise(@Req() req: any, @Query('cpf') cpf?: string, @Query('codCliente') codCliente?: string) {
    this.requireRole(req);
    return this.svc.analisarMarcadosCliente({ cpf, codCliente });
  }

  /**
   * POST /pdv/marcados/desduplicar { cpf?, codCliente?, keepNumero?, dryRun? }
   * Mantém 1 marcação e DEVOLVE as duplicadas (retorna estoque). Admin.
   * dryRun=true (default) só mostra o plano.
   */
  @Post('desduplicar')
  desduplicar(
    @Req() req: any,
    @Body() body: { cpf?: string; codCliente?: string; dryRun?: boolean },
  ) {
    this.requireRole(req);
    return this.svc.desduplicarMarcadosCliente({
      cpf: body?.cpf,
      codCliente: body?.codCliente,
      dryRun: body?.dryRun,
    });
  }

  /**
   * POST /pdv/marcados/baixar — BAIXA SEM FINANCEIRO (clientes-bin: DEFEITOS,
   * FURTO, reservas). Remove a marcação do Giga sem venda/caixa/estoque.
   * Exige senha GERENTE+ (auditável: motivo + quem autorizou).
   */
  @Post('baixar')
  baixar(
    @Req() req: any,
    @Body() body: {
      ids: string[];
      loja?: string;
      motivo: string;
      password: string;
    },
  ) {
    this.requireAdmin(req);
    const auth = authorizeMinLevel(String(body?.password || ''), 'GERENTE', String(body?.loja || req?.user?.storeCode || '') || undefined);
    const quem = auth.byNome || req?.user?.name || req?.user?.email || 'gerente';
    return this.svc.baixarMarcados({
      ids: body?.ids || [],
      motivo: String(body?.motivo || ''),
      autorizadoPor: `[${auth.level}] ${quem}`,
    });
  }

  /**
   * GET /pdv/marcados/cliente?cpf=XXX
   *  ou  /pdv/marcados/cliente?codCliente=6086&loja=01
   *
   * Retorna info do cliente + lista de marcados ativos + valida se pode marcar.
   * O CPF deixou de ser obrigatório (05/08): 1.911 fichas do Wincred não têm
   * CPF e a loja ficava sem conseguir abrir os marcados dessas clientes.
   */
  @Get('cliente')
  getClienteInfo(
    @Req() req: any,
    @Query('cpf') cpf?: string,
    @Query('codCliente') codCliente?: string,
    @Query('loja') loja?: string,
  ) {
    this.requireRole(req);
    return this.svc.getClienteMarcadorInfo({ cpf, codCliente, loja });
  }

  /**
   * GET /pdv/marcados/search?q=...
   * Busca clientes por nome OU CPF parcial — retorna ate 20 matches
   * que TEM marcados ativos. Usado pela tela quando vendedora nao tem
   * o CPF e quer achar pelo nome.
   */
  @Get('search')
  searchClientes(@Req() req: any, @Query('q') q: string, @Query('loja') loja?: string) {
    this.requireRole(req);
    // ESCOPO POR LOJA (23/07): o PDV só vê clientes da própria loja —
    // RESERVAS/DEFEITOS existem em toda loja e misturavam.
    const lojaScope = String(loja || req?.user?.storeCode || '').replace(/\D/g, '');
    return this.svc.searchClientesByNameOrCpf(q || '', lojaScope || undefined);
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
    @Query('status') status?: string,
  ) {
    this.requireRole(req);
    return this.svc.listAllMarcados({
      loja,
      dataInicial,
      dataFinal,
      limit: limit ? Number(limit) : 100,
      status,
    });
  }

  /**
   * POST /pdv/marcados/devolver
   * Body: { id, sku, qty, loja }
   * Devolve 1 peça marcada ao estoque (cliente trouxe de volta). 100% Flow.
   */
  @Post('devolver')
  devolver(
    @Req() req: any,
    @Body() body: { id: string; sku: string; qty: number; loja: string },
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
   * Body: { marcadoIds: string[], customerCpf?, customerName?, customerPhone? }
   * Cria uma PdvSale aberta com as pecas marcadas como itens, retorna saleId.
   * Frontend redireciona pro PDV pra retomar e finalizar a venda.
   *
   * `marcadoIds` são os `id` nativos (07/08) — não REGISTRO do Giga. Ver o
   * comentário grande em `MarcadosService.puxarParaVenda`.
   */
  @Post('puxar-pra-venda')
  puxarParaVenda(
    @Req() req: any,
    @Body() body: {
      marcadoIds: string[];
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
    return this.svc.puxarParaVenda({
      marcadoIds: body?.marcadoIds || [],
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
