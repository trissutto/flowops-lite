import {
  Body, Controller, Delete, ForbiddenException, Get, Param, Patch, Post, Query, Req, UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { PickOrdersService, PickStatus } from './pick-orders.service';
import { JuntadaService } from './juntada.service';
import { ErpService } from '../erp/erp.service';

interface AuthUser {
  userId: string;
  email: string;
  role: string;
  storeId: string | null;
}

@Controller('pick-orders')
@UseGuards(JwtAuthGuard)
export class PickOrdersController {
  constructor(
    private readonly svc: PickOrdersService,
    private readonly erp: ErpService,
    private readonly juntada: JuntadaService,
  ) {}

  /**
   * Retorna o modo atual de escrita no ERP (Gigasistemas).
   * - writeEnabled=false → SHADOW (só log, não toca no estoque)
   * - writeEnabled=true  → LIVE (UPDATE real em estoque)
   * Frontend usa pra trocar banner/cor/copy do modal de confirmação.
   */
  @Get('erp-mode')
  erpMode(@Req() req: any) {
    const user = req.user as AuthUser;
    if (user.role !== 'admin' && user.role !== 'operator') {
      throw new ForbiddenException('Apenas matriz acessa essa rota');
    }
    return { writeEnabled: this.erp.isWriteEnabled };
  }

  /**
   * TESTE: força a criação de um pick-order pra uma loja específica, sem passar pelo
   * roteador (ignora estoque). Admin only. Útil pra validar o socket fim-a-fim
   * enquanto ERP/estoque ainda não foram sincronizados em prod.
   *
   * Body:
   *  - storeCode: ex "LJ15" (preferido — mais amigável)
   *  - orderId?:  id de um Order local (se tiver)  — senão cria um pedido fake
   */
  @Post('test-create')
  testCreate(@Req() req: any, @Body() body: { storeCode: string; orderId?: string }) {
    const user = req.user as AuthUser;
    if (user.role !== 'admin') {
      throw new ForbiddenException('Apenas admin pode criar pick-order de teste');
    }
    return this.svc.forceCreateForStore(body.storeCode, body.orderId);
  }

  /**
   * DELETE /pick-orders/:id — remove um pick-order específico do pedido.
   *
   * Caso de uso: retaguarda resolveu o problema MANUALMENTE (ex: cliente
   * pegou na outra loja), e quer "limpar" o card da loja problemática que
   * ficou no pedido. Os items dela ficam SEM atribuição (órfãos), mas isso
   * é OK porque o pedido foi resolvido fora do sistema.
   *
   * Comportamento:
   *  - Só permite se status = new/separating/issue (não shipped/delivered)
   *  - Limpa assignedStoreId dos items que estavam atribuídos a essa loja
   *  - Notifica a loja por socket pra remover o card
   *  - Loga no histórico
   *
   * Permite admin/operator. Não permite vendedora (role 'store').
   */
  @Delete(':id')
  async removePickOrder(@Req() req: any, @Param('id') id: string) {
    const user = req.user as AuthUser;
    if (user.role !== 'admin' && user.role !== 'operator') {
      throw new ForbiddenException('Apenas matriz pode remover pick-order');
    }
    // QUEM removeu (26/08) — o remove do ON-000106 saiu como "[sistema]" e a
    // pergunta "quem tirou o card?" ficou sem resposta possível.
    const u: any = req.user ?? {};
    return this.svc.removePickOrder(id, {
      userId: u.userId ?? u.sub ?? u.id ?? null,
      nome: (u.name ?? u.nome ?? u.email ?? null) as string | null,
    });
  }

  /**
   * Lista pick-orders da LOJA do user logado.
   * Default: só ativos (new, separating, ready). `?all=true` inclui shipped.
   */
  @Get('mine')
  mine(
    @Req() req: any,
    @Query('all') all?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const user = req.user as AuthUser;
    if (user.role !== 'store' || !user.storeId) {
      throw new ForbiddenException('Apenas usuários de loja acessam /pick-orders/mine');
    }
    // from/to (YYYY-MM-DD) = aba ENVIADOS: só os despachados no período.
    return this.svc.listMine(user.storeId, { all: all === 'true', from, to });
  }

  /**
   * PEÇA SEM BIPE (29/08) — cards já fechados/enviados que têm peça sem bipe
   * ativo. Alimenta a linha VERMELHA da fila "O QUE FAZER AGORA" da loja
   * (role=store devolve só os dela) e o mutirão da matriz (admin devolve a
   * rede inteira). O destravamento é o bipe tardio no próprio card.
   */
  @Get('sem-bipe')
  async cardsSemBipe(@Req() req: any) {
    const user = req.user as AuthUser;
    const storeId = user.role === 'store' ? user.storeId ?? undefined : undefined;
    return this.svc.cardsComPecaSemBipe(storeId);
  }

  /**
   * GARGALO POR LOJA (29/08) — tempo médio nascer→bipar e nascer→enviar por
   * loja. Matriz vê quem atrasa a rede; a fila da loja mostra a idade card a
   * card, aqui é o AGREGADO.
   */
  @Get('gargalo')
  async gargalo(@Query('dias') dias?: string) {
    return this.svc.gargaloPorLoja(Number(dias) || 30);
  }

  /**
   * Loja — o que ELA VENDEU online (não o que ela separa). `/mine` é a fila de
   * quem ATENDE; esta é a de quem VENDEU: a vendedora fecha no WhatsApp, o
   * card nasce em outra loja e ela precisa saber em que pé está pra responder
   * a cliente sem ligar pra matriz.
   *
   * Query: ?from=YYYY-MM-DD&to=YYYY-MM-DD (opcionais — sem eles, 30 dias +
   * tudo que ainda está em aberto).
   */
  @Get('vendi-online')
  vendiOnline(
    @Req() req: any,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const user = req.user as AuthUser;
    if (user.role !== 'store' || !user.storeId) {
      throw new ForbiddenException('Apenas usuários de loja acessam /pick-orders/vendi-online');
    }
    return this.svc.listVendidosOnline(user.storeId, { from, to });
  }

  /**
   * Matriz — lista pick-orders aguardando aprovação da baixa de estoque.
   * Status `separated` = filial bipou tudo, aguardando operadora matriz aprovar.
   * Ordenação FIFO (mais antigo primeiro).
   */
  @Get('pending-approval')
  pendingApproval(@Req() req: any) {
    const user = req.user as AuthUser;
    if (user.role !== 'admin' && user.role !== 'operator') {
      throw new ForbiddenException('Apenas matriz (admin/operator) aprova baixa de estoque');
    }
    return this.svc.listPendingApproval();
  }

  /**
   * Matriz — lista compacta de pick-orders com issueReason ativo (problema reportado
   * pela filial: sem estoque físico, defeito, divergência). Consumida pela /separacao
   * pra badge vermelho nas linhas afetadas. Rota estática — fica antes das dinâmicas.
   */
  @Get('issues-active')
  issuesActive(@Req() req: any) {
    const user = req.user as AuthUser;
    if (user.role !== 'admin' && user.role !== 'operator') {
      throw new ForbiddenException('Apenas matriz (admin/operator) acessa essa rota');
    }
    return this.svc.listIssuesActive();
  }

  /**
   * Matriz — lista pick-orders com status=shipped num intervalo (default HOJE),
   * agrupados por loja. Cada grupo traz: storeCode/Name, total, totalPeças, valorTotal
   * e rows[] com dados do pedido WC (#numero, cliente, rastreio, carrier, valor,
   * horário envio, forma envio, transferência). Fonte da verdade pra cobrar "o que
   * cada filial enviou hoje?".
   *
   * Query: ?from=YYYY-MM-DD&to=YYYY-MM-DD (ambos opcionais — default HOJE SP)
   */
  @Get('shipped-by-store')
  shippedByStore(
    @Req() req: any,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const user = req.user as AuthUser;
    if (user.role !== 'admin' && user.role !== 'operator') {
      throw new ForbiddenException('Apenas matriz (admin/operator) acessa essa rota');
    }
    return this.svc.listShippedByStore({ from, to });
  }

  /**
   * Matriz aprova baixa de estoque — transiciona separated → ready.
   * SHADOW MODE: grava intenção em integration_logs, NÃO toca no Gigasistemas ainda.
   */
  @Post(':id/approve-debit')
  approveDebit(@Req() req: any, @Param('id') id: string) {
    const user = req.user as AuthUser;
    if (user.role !== 'admin' && user.role !== 'operator') {
      throw new ForbiddenException('Apenas matriz (admin/operator) aprova baixa');
    }
    return this.svc.approveDebit(id, user.userId);
  }

  /**
   * Matriz aprova baixa em LOTE — aceita array de pickOrderIds e aprova tudo.
   * Retorna summary (approved/skipped/errors) pra UI decidir o que mostrar.
   * Rota estática — fica antes das dinâmicas.
   */
  @Post('bulk-approve-debit')
  bulkApproveDebit(@Req() req: any, @Body() body: { pickOrderIds: string[] }) {
    const user = req.user as AuthUser;
    if (user.role !== 'admin' && user.role !== 'operator') {
      throw new ForbiddenException('Apenas matriz (admin/operator) aprova baixa em lote');
    }
    return this.svc.bulkApproveDebit(body?.pickOrderIds ?? [], user.userId);
  }

  /**
   * Reabre baixa em LOTE — aceita array de pickOrderIds e devolve cada um pra fila.
   * Rota estática — vem ANTES da rota dinâmica `:id/reopen-debit`.
   */
  @Post('bulk-reopen-debit')
  bulkReopenDebit(
    @Req() req: any,
    @Body() body: { pickOrderIds: string[]; reason?: string },
  ) {
    const user = req.user as AuthUser;
    if (user.role !== 'admin' && user.role !== 'operator') {
      throw new ForbiddenException('Apenas matriz (admin/operator) reabre baixa em lote');
    }
    return this.svc.bulkReopenDebit(body?.pickOrderIds ?? [], user.userId, body?.reason);
  }

  /**
   * Matriz rejeita baixa — volta pra separating, loja revisa.
   * Body: { reason: string }
   */
  @Post(':id/reject-debit')
  rejectDebit(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { reason?: string },
  ) {
    const user = req.user as AuthUser;
    if (user.role !== 'admin' && user.role !== 'operator') {
      throw new ForbiddenException('Apenas matriz (admin/operator) rejeita baixa');
    }
    return this.svc.rejectDebit(id, user.userId, body?.reason ?? '');
  }

  /**
   * Reabre baixa aprovada — devolve o pick-order pra fila /baixa-estoque.
   * Usado quando baixa foi SHADOW e precisa re-tentar em LIVE.
   * Bloqueia se já existe log `debit.real.applied` pra evitar baixa dupla.
   */
  @Post(':id/reopen-debit')
  reopenDebit(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { reason?: string },
  ) {
    const user = req.user as AuthUser;
    if (user.role !== 'admin' && user.role !== 'operator') {
      throw new ForbiddenException('Apenas matriz (admin/operator) reabre baixa');
    }
    return this.svc.reopenDebit(id, user.userId, body?.reason);
  }

  /**
   * RETRY de baixa automática que falhou (LIVE FALHOU).
   * Usado pelo botão "Retry" no log de baixas quando autoDebit caiu por
   * ETIMEDOUT/ECONNRESET e o pick-order ficou shipped mas sem aprovação.
   * Re-dispara autoDebitOnShipped (que agora tem retry no ERP service).
   */
  @Post(':id/retry-auto-debit')
  retryAutoDebit(@Req() req: any, @Param('id') id: string) {
    const user = req.user as AuthUser;
    if (user.role !== 'admin' && user.role !== 'operator') {
      throw new ForbiddenException('Apenas matriz (admin/operator) pode reexecutar baixa automática');
    }
    return this.svc.retryAutoDebit(id, user.userId);
  }

  @Get(':id')
  getOne(@Req() req: any, @Param('id') id: string) {
    const user = req.user as AuthUser;
    if (user.role !== 'store' || !user.storeId) {
      throw new ForbiddenException('Apenas usuários de loja acessam essa rota');
    }
    return this.svc.getOne(id, user.storeId);
  }

  /**
   * Transiciona status. Body: { status: 'separating'|'ready'|'shipped', trackingCode?, carrier? }
   */
  @Patch(':id/status')
  updateStatus(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { status: PickStatus; trackingCode?: string; carrier?: string },
  ) {
    const user = req.user as AuthUser;
    if (user.role !== 'store' || !user.storeId) {
      throw new ForbiddenException('Apenas usuários de loja atualizam pick-orders');
    }
    return this.svc.updateStatus(id, user.storeId, user.userId, body);
  }

  /** Gera a pré-postagem dos Correios pro pedido da live (NÃO marca enviado —
   *  o cron marca quando os Correios registram a postagem). */
  @Post(':id/correios-envio')
  correiosEnvio(@Req() req: any, @Param('id') id: string) {
    const user = req.user as AuthUser;
    if (user.role !== 'store' || !user.storeId) {
      throw new ForbiddenException('Apenas usuários de loja postam');
    }
    return this.svc.gerarEnvioCorreios(id, user.storeId, user.userId);
  }

  /** Documentos do envio num PDF único: etiqueta + DANFE (nessa ordem). */
  @Get(':id/docs-envio')
  docsEnvio(@Req() req: any, @Param('id') id: string) {
    const user = req.user as AuthUser;
    if (user.role !== 'store' || !user.storeId) {
      throw new ForbiddenException('Apenas usuários de loja');
    }
    return this.svc.docsEnvioMerged(id, user.storeId);
  }

  /**
   * JUNTADA (21/08) — documentos da CAIXA do card feeder num PDF só:
   * etiqueta pra loja âncora + DANFE da NF de transferência (trecho
   * Correios) + romaneio carimbado "PEÇAS DO PEDIDO #X". Rota própria
   * (carro da rede) sai só o romaneio. Retaguarda também pode baixar.
   */
  @Get(':id/juntada-docs')
  juntadaDocs(@Req() req: any, @Param('id') id: string) {
    const user = req.user as AuthUser;
    const storeId = user.role === 'store' ? user.storeId ?? null : null;
    return this.juntada.docsDaCaixa(id, storeId, user.userId);
  }

  /** Reabre (desfaz) a pré-postagem gerada pra refazer — ex.: modalidade errada. */
  @Post(':id/correios-reabrir')
  correiosReabrir(@Req() req: any, @Param('id') id: string) {
    const user = req.user as AuthUser;
    if (user.role !== 'store' || !user.storeId) {
      throw new ForbiddenException('Apenas usuários de loja');
    }
    return this.svc.reabrirEnvioCorreios(id, user.storeId);
  }

  /**
   * Retorna items do pick-order com EAN13 resolvido do Gigasistemas.
   * Usado pela tela de bipagem — frontend monta mapa EAN→SKU pra validar bips.
   */
  @Get(':id/scan-data')
  getScanData(@Req() req: any, @Param('id') id: string) {
    const user = req.user as AuthUser;
    if (user.role !== 'store' || !user.storeId) {
      throw new ForbiddenException('Apenas usuários de loja acessam essa rota');
    }
    return this.svc.getScanData(id, user.storeId);
  }

  /**
   * Fallback da bipagem — quando o EAN bipado não bateu no mapa local,
   * filial chama esse endpoint pra resolver via busca ampla no ERP.
   * Body: { ean: string }
   * Resposta: { found: true, sku } | { found: false, debug: [...] }
   */
  @Post(':id/scan-resolve')
  scanResolve(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { ean: string },
  ) {
    const user = req.user as AuthUser;
    if (user.role !== 'store' || !user.storeId) {
      throw new ForbiddenException('Apenas usuários de loja acessam essa rota');
    }
    return this.svc.resolveScan(id, user.storeId, body?.ean ?? '');
  }

  /**
   * UMA PEÇA BIPADA — registra o bipe E BAIXA O ESTOQUE, na mesma transação.
   * Body: { scanUid, sku, ean? }
   *
   * `scanUid` é gerado pela TELA antes do POST: é ele que faz o reenvio do
   * mesmo bipe (rede caiu, clique duplo) responder `duplicate: true` em vez de
   * tirar outra peça do estoque. A tela só pinta a peça de verde depois do
   * 200 — se o estoque não baixou, a peça não está bipada.
   */
  @Post(':id/scan')
  registerScan(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { scanUid: string; sku: string; ean?: string },
  ) {
    const user = req.user as AuthUser;
    if (user.role !== 'store' || !user.storeId) {
      throw new ForbiddenException('Apenas usuários de loja bipam peça');
    }
    return this.svc.registerScan(id, user.storeId, user.userId, body ?? ({} as any));
  }

  /**
   * DESFAZ um bipe e DEVOLVE a peça pro estoque da loja. Body: { scanUid }.
   * Idempotente: chamar duas vezes devolve uma peça só.
   */
  @Post(':id/scan-undo')
  undoScan(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { scanUid: string },
  ) {
    const user = req.user as AuthUser;
    if (user.role !== 'store' || !user.storeId) {
      throw new ForbiddenException('Apenas usuários de loja desfazem bipe');
    }
    return this.svc.undoScan(id, user.storeId, user.userId, body?.scanUid ?? '');
  }

  /**
   * Filial terminou a bipagem — transiciona pick-order pra `separated`.
   * Body: { scans: [...] } — só FALLBACK pros cards que já estavam abertos
   * quando a baixa-no-bipe subiu (18/08); a contagem oficial vem dos bipes
   * gravados no servidor.
   * Continua EXIGINDO 100% bipado. O estoque já saiu peça a peça no bipe —
   * aqui só fecha a diferença (bipe em shadow, card legado).
   */
  @Post(':id/finish-separation')
  finishSeparation(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { scans: Array<{ sku: string; ean: string; timestamp: string }> },
  ) {
    const user = req.user as AuthUser;
    if (user.role !== 'store' || !user.storeId) {
      throw new ForbiddenException('Apenas usuários de loja finalizam separação');
    }
    return this.svc.finishSeparation(id, user.storeId, user.userId, body.scans ?? []);
  }

  /**
   * LOJA reporta problema no pick-order (sem estoque físico, defeito, divergência).
   * Body: { reason: 'out_of_stock' | 'defective' | 'divergence' | 'other', note?: string }
   *
   * Card some da fila da loja (listMine filtra issueReason != null).
   * Matriz vê badge em /pedidos e /separacao e clica "Recalcular" → reroteia
   * auto-excluindo a loja que reportou.
   */
  @Post(':id/report-issue')
  reportIssue(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { reason: string; note?: string },
  ) {
    const user = req.user as AuthUser;
    if (user.role !== 'store' || !user.storeId) {
      throw new ForbiddenException('Apenas usuários de loja reportam problema');
    }
    return this.svc.reportIssue(id, user.storeId, user.userId, body ?? { reason: '' });
  }

  /**
   * LOJA reporta UMA PEÇA na bipagem ("não achei a peça") sem travar o resto.
   * Body: { orderItemId, reason: 'out_of_stock' | 'defective' | 'divergence' | 'other', note? }
   *
   * O item sai do card (fica sem loja, esperando a matriz) e — no motivo
   * "sem estoque físico" — a quantidade fantasma sai do estoque da loja na
   * mesma transação, pro site parar de vender peça que não existe. O
   * "Finalizar separação" destrava com o resto bipado.
   */
  @Post(':id/report-item')
  reportItem(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { orderItemId: string; reason: string; note?: string },
  ) {
    const user = req.user as AuthUser;
    if (user.role !== 'store' || !user.storeId) {
      throw new ForbiddenException('Apenas usuários de loja reportam peça');
    }
    return this.svc.reportItem(id, user.storeId, user.userId, body ?? ({} as any));
  }

  /**
   * Matriz: reportes de peça ainda sem destino de um pedido WC — banner do
   * /pedidos/wc/[id]. Reporte se auto-resolve quando o item ganha loja de novo.
   */
  @Get('item-reports/by-wc/:wcOrderId')
  itemReportsByWc(@Req() req: any, @Param('wcOrderId') wcOrderId: string) {
    const user = req.user as AuthUser;
    if (user.role !== 'admin' && user.role !== 'operator') {
      throw new ForbiddenException('Apenas matriz (admin/operator) acessa essa rota');
    }
    const id = Number(wcOrderId);
    if (!Number.isFinite(id)) {
      throw new ForbiddenException('wcOrderId inválido');
    }
    return this.svc.listItemReportsByWc(id);
  }

  /**
   * Matriz resolve um reporte de peça. `modo` diz o DESFECHO:
   *   'reembolso' (default) → o dinheiro volta por fora; aqui só apaga o alarme
   *   'credito'             → emite vale nominal SEM PRAZO no CPF da cliente
   * `valor` só vale no crédito (default: o preço da peça que faltou).
   *
   * Sem body, o comportamento é o de sempre — a aba velha que ainda mandar
   * POST vazio continua funcionando como reembolso.
   */
  @Post('item-reports/:reportId/resolve')
  resolveItemReport(
    @Req() req: any,
    @Param('reportId') reportId: string,
    @Body() body?: { modo?: string; valor?: number },
  ) {
    const user = req.user as AuthUser;
    if (user.role !== 'admin' && user.role !== 'operator') {
      throw new ForbiddenException('Apenas matriz (admin/operator) resolve reporte');
    }
    return this.svc.resolveItemReport(reportId, user.userId, {
      modo: body?.modo,
      valor: body?.valor == null ? undefined : Number(body.valor),
      userName: (user as any).name || user.userId,
    });
  }

  /** Créditos já emitidos por peça faltante neste pedido (painel que sobrevive ao F5). */
  @Get('item-reports/creditos/by-wc/:wcOrderId')
  creditosByWc(@Req() req: any, @Param('wcOrderId') wcOrderId: string) {
    const user = req.user as AuthUser;
    if (user.role !== 'admin' && user.role !== 'operator') {
      throw new ForbiddenException('Apenas matriz (admin/operator) acessa essa rota');
    }
    const id = Number(wcOrderId);
    if (!Number.isFinite(id)) throw new ForbiddenException('wcOrderId inválido');
    return this.svc.listCreditosByWc(id);
  }

  /**
   * LOJA troca uma peça manualmente na separação (produto não encontrado / trocar
   * por outro). Só antes da baixa de estoque. Se o preço da peça nova difere,
   * exige senha GERENTE+ (a service devolve needsPassword quando falta senha).
   * Body: { orderItemId, codigo, ref?, cor?, tamanho?, descricao?, password? }
   */
  @Post(':id/swap-item')
  swapItem(
    @Req() req: any,
    @Param('id') id: string,
    @Body()
    body: {
      orderItemId: string;
      codigo: string;
      ref?: string;
      cor?: string;
      tamanho?: string;
      descricao?: string;
      password?: string;
    },
  ) {
    const user = req.user as AuthUser;
    if (user.role !== 'store' || !user.storeId) {
      throw new ForbiddenException('Apenas usuários de loja trocam peça na separação');
    }
    return this.svc.swapItem(id, user.storeId, body ?? ({} as any), user.userId);
  }

  /**
   * Matriz consulta todos os pick-orders de um pedido WC (por wcOrderId).
   * Usado na tela /pedidos/wc/[id] pra mostrar status ao vivo de cada loja,
   * incluindo rastreio quando shipped. Retorna array vazio se não tem pick-orders.
   */
  @Get('by-wc/:wcOrderId')
  byWcOrderId(@Req() req: any, @Param('wcOrderId') wcOrderId: string) {
    const user = req.user as AuthUser;
    if (user.role !== 'admin' && user.role !== 'operator') {
      throw new ForbiddenException('Apenas matriz (admin/operator) acessa essa rota');
    }
    const id = Number(wcOrderId);
    if (!Number.isFinite(id)) {
      throw new ForbiddenException('wcOrderId inválido');
    }
    return this.svc.listByWcOrderId(id);
  }

  /**
   * Matriz dispara impressão REMOTA do cupom na térmica da loja.
   * Fluxo: backend valida → verifica presença → emite socket pro Electron da loja →
   * Electron abre hidden window /minha-loja/imprimir/{id}?autoprint=1 → print silencioso.
   * Retorna erro claro se loja offline.
   */
  @Post(':id/print')
  printRemote(@Req() req: any, @Param('id') id: string) {
    const user = req.user as AuthUser;
    if (user.role !== 'admin' && user.role !== 'operator') {
      throw new ForbiddenException('Apenas matriz (admin/operator) imprime remotamente');
    }
    return this.svc.triggerRemotePrint(id);
  }
}
