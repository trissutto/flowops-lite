import {
  Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, UseGuards,
} from '@nestjs/common';
import {
  CustomersCrmService,
  CreateCustomerDto,
  UpdateCustomerDto,
  UpdateCustomerCreditDto,
  CreateAddressDto,
  ConsentDto,
  CreditCashbackDto,
  RedeemCashbackDto,
  ListQuery,
  RequestActor,
} from './customers-crm.service';
import { CustomersEtlService } from './customers-etl.service';
import { CustomersGigaEtlService } from './customers-giga-etl.service';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { AdminOnly, AdminOnlyGuard } from '../auth/admin-only.guard';
import { CpfWooService } from './cpf-woo.service';
import { CpfRestService } from './cpf-rest.service';
import { CustomerIdentityReviewService } from './customer-identity-review.service';

/**
 * Rotas do CRM real (model Customer no banco).
 *
 * SCOPE POR LOJA:
 *  • admin/operator (matriz)  → vê e edita TODOS os clientes
 *  • store (loja)             → vê e edita só clientes com originStoreId = sua loja
 *
 * O scope é aplicado no service (single source of truth).
 * Endpoints sensíveis (criar tag global, ETL) levam @AdminOnly() individualmente.
 */
@Controller('customers-crm')
@UseGuards(JwtAuthGuard, AdminOnlyGuard)
export class CustomersCrmController {
  constructor(
    private readonly svc: CustomersCrmService,
    private readonly etl: CustomersEtlService,
    private readonly gigaEtl: CustomersGigaEtlService,
    private readonly cpfWoo: CpfWooService,
    private readonly cpfRest: CpfRestService,
    private readonly identityReview: CustomerIdentityReviewService,
  ) {}

  /**
   * CPF DAS CLIENTES DO SITE ANTIGO — ver `CpfWooService`.
   *
   * Vive aqui, e não num script, porque o MySQL do WordPress está atrás do
   * firewall por IP da KingHost: só o Railway passa.
   *
   * `GET .../diagnostico` mostra o que existe do outro lado (HPOS? qual chave
   * de meta o plugin usou?) sem cruzar nada — é o primeiro comando a rodar,
   * porque supor o schema devolveria "nenhum CPF" num banco cheio deles.
   */
  @Get('cpf-woo/diagnostico')
  @AdminOnly()
  cpfWooDiagnostico() {
    return this.cpfWoo.diagnostico();
  }

  /**
   * SECO por padrão. `?aplicar=1` grava — são 14 mil cadastros e não há
   * desfazer barato, então a confirmação é explícita.
   */
  @Post('cpf-woo/backfill')
  @AdminOnly()
  cpfWooBackfill(@Query('aplicar') aplicar?: string) {
    return this.cpfWoo.backfill(aplicar === '1' || aplicar === 'true');
  }


  /**
   * CPF DOS PEDIDOS ANTIGOS pela API REST do WooCommerce — ver CpfRestService.
   * O caminho por MySQL morreu (o WordPress mudou de servidor); a REST responde.
   */
  @Post('cpf-rest/sync')
  @AdminOnly()
  @HttpCode(202)
  cpfRestIniciar(@Query('de') de?: string) {
    return this.cpfRest.iniciar(Math.max(1, Number(de) || 1));
  }

  @Get('cpf-rest/status')
  @AdminOnly()
  cpfRestStatus() {
    return this.cpfRest.status();
  }

  @Post('cpf-rest/cancelar')
  @AdminOnly()
  cpfRestCancelar() {
    return this.cpfRest.cancelar();
  }

  /** Leva o CPF do pedido pro cadastro. SECO por padrão; ?aplicar=1 grava. */
  @Post('cpf-rest/propagar')
  @AdminOnly()
  cpfRestPropagar(@Query('aplicar') aplicar?: string) {
    return this.cpfRest.propagarParaClientes(aplicar === '1' || aplicar === 'true');
  }

  // ─── ETL Woo → Customers (só admin) ──────────────────────────────────────
  @Get('etl/status')
  @AdminOnly()
  etlStatus() {
    return this.etl.getState();
  }

  @Post('etl/woo')
  @AdminOnly()
  @HttpCode(202)
  startWooSync() {
    const started = this.etl.startWooSync();
    return {
      started,
      message: started
        ? 'Sync WooCommerce → Customer iniciado em background. GET /customers-crm/etl/status pra acompanhar.'
        : 'Sync já em andamento. GET /customers-crm/etl/status.',
      state: this.etl.getState(),
    };
  }

  // ─── ETL Giga → Customers (só admin) ────────────────────────────────────
  /** Status do sync Giga (polling pelo frontend). */
  @Get('etl/giga/status')
  @AdminOnly()
  gigaEtlStatus() {
    return this.gigaEtl.getState();
  }

  /**
   * Diagnóstico de colunas — lista TODAS as colunas da tabela `clientes`
   * do Giga + 3 amostras + sugestão de mapeamento pro Customer.
   * Útil pra decidir quais campos importar além dos básicos.
   */
  @Get('etl/giga/colunas')
  @AdminOnly()
  async gigaEtlColunas() {
    return this.gigaEtl.diagnosticarColunas();
  }

  /**
   * POST /customers-crm/etl/giga/loja-principal
   * Atualiza originStoreId dos clientes Giga lendo o campo LOJA char(2)
   * da tabela `clientes` do Giga.
   *
   * Query param ?sobrescrever=1 força recálculo (inclui clientes que já
   * tinham loja, exceto WC que sempre fica 13). Default: só preenche null.
   */
  @Post('etl/giga/loja-principal')
  @AdminOnly()
  async gigaAtualizarLoja(@Query('sobrescrever') sobrescrever?: string) {
    return this.gigaEtl.atualizarLojaPrincipal({
      sobrescrever: sobrescrever === '1' || sobrescrever === 'true',
    });
  }

  /**
   * GET /customers-crm/etl/giga/diagnostico-lojas
   * Cruza Stores FlowOps × LOJA Giga × originStoreId Customer pra entender
   * por que clientes não aparecem no filtro de loja.
   */
  @Get('etl/giga/diagnostico-lojas')
  @AdminOnly()
  async gigaDiagnosticoLojas() {
    return this.gigaEtl.diagnosticarLojas();
  }

  /**
   * GET /customers-crm/etl/giga/debug-cliente/:codCliente
   * Mostra dado bruto Giga + Customer atual + store que deveria ser, pra
   * entender por que cliente específico está com loja errada.
   * Exemplo: GET /etl/giga/debug-cliente/1 (TATIANA ROMAGNOLI Santos)
   */
  @Get('etl/giga/debug-cliente/:codCliente')
  @AdminOnly()
  async gigaDebugCliente(@Param('codCliente') codCliente: string) {
    const cod = parseInt(codCliente, 10);
    if (!Number.isFinite(cod) || cod <= 0) {
      return { erro: 'codCliente inválido' };
    }
    return this.gigaEtl.debugClienteGiga(cod);
  }

  /**
   * POST /customers-crm/etl/giga/reset
   * APAGA TODOS os Customers Giga + links. Usar antes do Sincronizar pra
   * começar do zero. WC/PDV/manual preservados.
   */
  @Post('etl/giga/reset')
  @AdminOnly()
  async gigaReset() {
    return this.gigaEtl.resetClientesGiga();
  }

  /**
   * POST /customers-crm/seed-cep-ranges
   * Cadastra ranges de CEP padrão pras 15 lojas conhecidas (Correios).
   * NÃO sobrescreve ranges já cadastrados — só preenche vazios.
   */
  @Post('seed-cep-ranges')
  @AdminOnly()
  async seedCepRanges() {
    return this.svc.seedCepRangesPadrao();
  }

  /**
   * POST /customers-crm/assign-target-stores
   * Pra cada Customer WC com CEP, acha a Store cujo cepRanges cobre o CEP
   * e atribui como targetStoreId (loja física "candidata"). Vendedora
   * passa a ver esses clientes na lista da sua loja com badge "🌐 SITE".
   */
  @Post('assign-target-stores')
  @AdminOnly()
  async assignTargetStores() {
    return this.svc.assignTargetStoresByCep();
  }

  /**
   * POST /customers-crm/etl/giga/cancelar
   * Solicita cancelamento do sync Giga em andamento. Os loops checam essa
   * flag em cada iteração e param graciosamente. Os dados já gravados ficam.
   */
  @Post('etl/giga/cancelar')
  @AdminOnly()
  @HttpCode(202)
  cancelGigaSync() {
    const state = this.gigaEtl.requestAbort();
    return {
      cancelled: !!state.abortRequested,
      message: state.running
        ? 'Cancelamento solicitado. Os loops vão parar na próxima iteração (alguns segundos).'
        : 'Não há sync em andamento.',
      state,
    };
  }

  /**
   * POST /customers-crm/etl/giga
   * Inicia sync FULL Giga (MySQL Wincred) → Customer (Postgres FlowOps).
   * 3 fases: clientes → histórico (LTV/orderCount/lastOrderAt) → tier.
   * Roda em background, polling em GET /etl/giga/status.
   */
  @Post('etl/giga')
  @AdminOnly()
  @HttpCode(202)
  startGigaSync() {
    const started = this.gigaEtl.startFullSync();
    return {
      started,
      message: started
        ? 'Sync Giga → Customer iniciado em background. GET /customers-crm/etl/giga/status pra acompanhar.'
        : 'Sync já em andamento.',
      state: this.gigaEtl.getState(),
    };
  }

  /** Extrai o actor do req.user (preenchido pelo JwtStrategy). */
  private actor(req: any): RequestActor {
    const u = req.user ?? {};
    return {
      userId: u.userId ?? u.sub ?? u.id,
      role: u.role,
      storeId: u.storeId ?? null,
    };
  }

  // ─── Listagem ─────────────────────────────────────────────────────────────
  @Get()
  list(
    @Req() req: any,
    @Query('search') search?: string,
    @Query('tier') tier?: string,
    @Query('rfvSegment') rfvSegment?: string,
    @Query('storeId') storeId?: string,
    @Query('hasWhatsapp') hasWhatsapp?: string,
    @Query('hasCashbackBalance') hasCashbackBalance?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('orderBy') orderBy?: ListQuery['orderBy'],
    @Query('order') order?: ListQuery['order'],
  ) {
    return this.svc.list(
      {
        search,
        tier,
        rfvSegment,
        storeId,
        hasWhatsapp: hasWhatsapp === 'true',
        hasCashbackBalance: hasCashbackBalance === 'true',
        page: page ? parseInt(page, 10) : undefined,
        limit: limit ? parseInt(limit, 10) : undefined,
        orderBy,
        order,
      },
      this.actor(req),
    );
  }

  // ─── Tags ─ ENDPOINTS ESPECÍFICOS antes de /:id ──────────────────────────
  @Get('tags')
  listTags() {
    return this.svc.listTags();
  }

  @Post('tags')
  @AdminOnly()                                            // criar tag é da matriz
  createTag(@Body() body: { name: string; description?: string; color?: string }) {
    return this.svc.createTag(body.name, body.description, body.color);
  }

  @Get('identity-review')
  @AdminOnly()
  identityReviewList(
    @Query('page') page?: string, @Query('limit') limit?: string,
    @Query('priority') priority?: string, @Query('type') type?: string,
    @Query('channel') channel?: string, @Query('linkState') linkState?: string,
    @Query('search') search?: string,
  ) {
    return this.identityReview.list({ page: page ? Number(page) : 1, limit: limit ? Number(limit) : 20, priority, type, channel, linkState, search });
  }

  @Get('identity-review-history')
  @AdminOnly()
  identityReviewHistory(@Query('page') page?: string, @Query('limit') limit?: string) {
    return this.identityReview.history(page ? Number(page) : 1, limit ? Number(limit) : 30);
  }

  @Get('identity-review/:key')
  @AdminOnly()
  identityReviewDetail(@Param('key') key: string) {
    return this.identityReview.detail(key);
  }

  @Post('identity-review/:key/confirm')
  @AdminOnly()
  identityReviewConfirm(@Req() req: any, @Param('key') key: string, @Body() body: { reason: string }) {
    return this.identityReview.confirm(key, body.reason, this.actor(req));
  }

  @Post('identity-review/:key/reject')
  @AdminOnly()
  identityReviewReject(@Req() req: any, @Param('key') key: string, @Body() body: { reason: string }) {
    return this.identityReview.reject(key, body.reason, this.actor(req));
  }

  @Post('identity-review/decisions/:id/rollback')
  @AdminOnly()
  identityReviewRollback(@Req() req: any, @Param('id') id: string) {
    return this.identityReview.rollback(id, this.actor(req));
  }

  // ─── CRUD principal ──────────────────────────────────────────────────────
  @Post()
  create(@Req() req: any, @Body() dto: CreateCustomerDto) {
    return this.svc.create(dto, this.actor(req));
  }

  @Get(':id')
  detail(@Req() req: any, @Param('id') id: string) {
    return this.svc.detail(id, this.actor(req));
  }

  /** Ficha beta: visão canônica da Person, mantendo os registros de origem. */
  @Get(':id/beta')
  betaDetail(@Req() req: any, @Param('id') id: string) {
    return this.svc.betaDetail(id, this.actor(req));
  }

  @Patch(':id/beta/credit')
  @AdminOnly({ strict: true })
  updateBetaCredit(@Req() req: any, @Param('id') id: string, @Body() dto: UpdateCustomerCreditDto) {
    return this.svc.updateCredit(id, dto, this.actor(req));
  }

  /**
   * GET /customers-crm/:id/by-person
   * Caminho C: retorna TODOS os outros Customers que compartilham o mesmo
   * personKey (chave de pessoa) — útil pro drawer mostrar "esta pessoa
   * também tem cadastro em Santos, Sorocaba e WC".
   */
  @Get(':id/by-person')
  async byPerson(@Req() req: any, @Param('id') id: string) {
    return this.svc.byPerson(id, this.actor(req));
  }

  /** Histórico cronológico do cliente: compras + devoluções + vales + marcados Giga */
  @Get(':id/historico')
  historico(@Req() req: any, @Param('id') id: string) {
    return this.svc.historico(id, this.actor(req));
  }

  @Patch(':id')
  update(@Req() req: any, @Param('id') id: string, @Body() dto: UpdateCustomerDto) {
    return this.svc.update(id, dto, this.actor(req));
  }

  // ─── Endereços ───────────────────────────────────────────────────────────
  @Post(':id/addresses')
  addAddress(@Req() req: any, @Param('id') id: string, @Body() dto: CreateAddressDto) {
    return this.svc.addAddress(id, dto, this.actor(req));
  }

  // ─── Consentimentos LGPD ─────────────────────────────────────────────────
  @Post(':id/consents')
  registerConsent(@Req() req: any, @Param('id') id: string, @Body() dto: ConsentDto) {
    return this.svc.registerConsent(id, dto, this.actor(req));
  }

  // ─── Cashback ────────────────────────────────────────────────────────────
  @Post(':id/cashback/credit')
  creditCashback(@Req() req: any, @Param('id') id: string, @Body() dto: CreditCashbackDto) {
    return this.svc.creditCashback(id, dto, this.actor(req));
  }

  @Post(':id/cashback/redeem')
  redeemCashback(@Req() req: any, @Param('id') id: string, @Body() dto: RedeemCashbackDto) {
    return this.svc.redeemCashback(id, dto, this.actor(req));
  }

  // ─── Tags de um cliente ──────────────────────────────────────────────────
  @Post(':id/tags/:tagId')
  applyTag(
    @Req() req: any,
    @Param('id') id: string,
    @Param('tagId') tagId: string,
    @Body() body: { appliedBy?: string } = {},
  ) {
    return this.svc.applyTag(id, tagId, body.appliedBy, this.actor(req));
  }

  @Delete(':id/tags/:tagId')
  removeTag(@Req() req: any, @Param('id') id: string, @Param('tagId') tagId: string) {
    return this.svc.removeTag(id, tagId, this.actor(req));
  }
}
