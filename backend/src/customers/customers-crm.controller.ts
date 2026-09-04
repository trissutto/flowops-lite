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
import { JwtAuthGuard } from '../auth/jwt.guard';
import { AdminOnly, AdminOnlyGuard } from '../auth/admin-only.guard';
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
    private readonly identityReview: CustomerIdentityReviewService,
  ) {}

  /*
   * MUSEU (04/09/2026): as rotas `cpf-woo/*` e `cpf-rest/*` saíram daqui.
   *
   * Elas garimpavam CPF das clientes do site ANTIGO — uma pelo MySQL do
   * WordPress (`CpfWooService`), outra pela REST do WooCommerce
   * (`CpfRestService`). Os dois lados moravam na KingHost, que foi desligada
   * em 27/08/2026: o pool do WP nem é criado (`wordpressLegadoLigado()`) e a
   * REST não responde. Nenhuma tela chamava as rotas.
   */

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

  /*
   * MUSEU (04/09/2026): as 7 rotas `etl/giga*` saíram daqui junto com o
   * `CustomersGigaEtlService`.
   *
   * Eram o ETL `clientes` do MySQL Wincred → `Customer` do Postgres: sync
   * full, cancelar, status, diagnóstico de colunas, diagnóstico de lojas,
   * debug de cliente e loja-principal. Todas abriam com
   * `if (!pool) throw new Error('Pool Giga não inicializado')` sobre um pool
   * que `ErpService.onModuleInit` não cria desde que o servidor da KingHost
   * foi desligado (27/08/2026) — 100% das chamadas eram 500.
   *
   * `etl/giga/reset` era a única 100% Postgres, e foi junto DE PROPÓSITO: ela
   * apagava todo Customer com `originSource` giga/giga_sistema pra "começar do
   * zero antes de sincronizar". Sem sync possível, ela só sabe destruir a
   * ÚLTIMA cópia da base de clientes das lojas, sem volta.
   *
   * ⚠️ A tela `/clientes-crm/sincronizacao` chamava 6 dessas rotas e não tem
   * mais backend — é museu de frontend (ver relatório do enterro).
   */

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

  /** Lista beta: uma linha por pessoa, com registros de origem expansíveis. */
  @Get('beta-list')
  betaList(@Req() req: any, @Query() query: ListQuery) {
    return this.svc.betaList(query, this.actor(req));
  }

  /** Retira somente uma origem duplicada; nunca apaga a pessoa consolidada. */
  @Delete('beta-duplicates/:id')
  @AdminOnly({ strict: true })
  archiveDuplicate(@Req() req: any, @Param('id') id: string) {
    return this.svc.archiveDuplicate(id, this.actor(req));
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
