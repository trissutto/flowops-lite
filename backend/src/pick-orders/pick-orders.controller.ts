import {
  Body, Controller, ForbiddenException, Get, Param, Patch, Post, Query, Req, UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { PickOrdersService, PickStatus } from './pick-orders.service';
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
   * Lista pick-orders da LOJA do user logado.
   * Default: só ativos (new, separating, ready). `?all=true` inclui shipped.
   */
  @Get('mine')
  mine(@Req() req: any, @Query('all') all?: string) {
    const user = req.user as AuthUser;
    if (user.role !== 'store' || !user.storeId) {
      throw new ForbiddenException('Apenas usuários de loja acessam /pick-orders/mine');
    }
    return this.svc.listMine(user.storeId, { all: all === 'true' });
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
   * Filial terminou a bipagem — transiciona pick-order pra `separated`.
   * Body: { scans: Array<{ sku, ean, timestamp }> }
   * Valida que bipou tudo que era esperado antes de confirmar.
   * NÃO toca em Gigasistemas. Apenas muda status + log de auditoria.
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
