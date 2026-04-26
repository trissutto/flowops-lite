import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { RealignmentService } from './realignment.service';
import { RealignmentShipmentService } from './shipment.service';
import { RealignmentAutoService } from './realignment-auto.service';
import { ErpService } from '../erp/erp.service';

/**
 * Rotas do realinhamento de estoques.
 *
 *   POST  /realignment/preview     → calcula o plano (sem persistir) · retaguarda
 *   POST  /realignment/confirm     → persiste plano + emite socket alerta · retaguarda
 *   GET   /realignment/mine        → ordens pendentes pra separar (loja origem) · filial
 *   GET   /realignment/mine-sent   → ordens já enviadas hoje (conferência) · filial
 *   PATCH /realignment/:id/sent    → loja marca ordem como enviada · filial
 */
@UseGuards(JwtAuthGuard)
@Controller('realignment')
export class RealignmentController {
  constructor(
    private readonly svc: RealignmentService,
    private readonly shipment: RealignmentShipmentService,
    private readonly auto: RealignmentAutoService,
    private readonly erp: ErpService,
  ) {}

  // ════════════════════════════════════════════════════════════════════
  // AUTO-REALINHAMENTO (cron diário com sugestões pendentes)
  // ════════════════════════════════════════════════════════════════════

  /** GET /realignment/auto/config — admin lê config atual */
  @Get('auto/config')
  autoGetConfig(@Req() req: any) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
    return this.auto.getConfig();
  }

  /** POST /realignment/auto/config — admin atualiza config */
  @Post('auto/config')
  async autoUpdateConfig(
    @Req() req: any,
    @Body() body: { enabled?: boolean; diasAtras?: number; descricaoFilter?: string },
  ) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
    await this.auto.updateConfig(body || {});
    return this.auto.getConfig();
  }

  /** GET /realignment/auto/pending — lista REFs sugeridas pendentes */
  @Get('auto/pending')
  autoGetPending(@Req() req: any) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
    return this.auto.getPending();
  }

  /** POST /realignment/auto/dismiss — descarta sugestões pendentes */
  @Post('auto/dismiss')
  async autoDismiss(@Req() req: any) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
    await this.auto.dismissPending();
    return { ok: true };
  }

  /** POST /realignment/auto/run-now — gatilho manual (testar config) */
  @Post('auto/run-now')
  autoRunNow(@Req() req: any) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
    return this.auto.runManual();
  }

  /**
   * GET /realignment/search-refs?term=blusa preta
   *
   * Busca no Gigasistemas por REFs cuja DESCRICAOCOMPLETA contenha TODAS as
   * palavras do termo (AND LIKE). Uso: a retaguarda precisa achar REFs por
   * nome ("vestido boho", "blusa azul 48") porque a mesma REF pode se repetir
   * pra produtos diferentes (ex: BL-5512 blusa + BL-5512 calça) — filtrar
   * também pela descrição evita criar realinhamento do produto errado.
   *
   * Retorna Array<{REF, DESCRICAOCOMPLETA, VARIANT_COUNT}> limitado a 200.
   */
  @Get('search-refs')
  searchRefs(@Query('term') term: string) {
    const t = String(term || '').trim();
    if (t.length < 2) return [];
    return this.erp.searchByDescriptionGrouped(t);
  }

  /**
   * GET /realignment/search-refs-by-date?from=2026-01-01&to=2026-01-31&desc=PLUS+SIZE
   *
   * Lista REFs cadastradas no Giga entre `from` e `to` (inclusive em from,
   * exclusive em to+1). Filtra por substring na descrição se `desc` fornecido.
   *
   * Uso: vendedora quer realinhar todas peças plus size que chegaram em
   * janeiro/2026 → busca aqui, copia REFs pro buscador.
   */
  @Get('search-refs-by-date')
  async searchRefsByDate(
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('desc') desc?: string,
  ) {
    if (!from || !to) {
      throw new BadRequestException('Query params from e to são obrigatórios (YYYY-MM-DD)');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      throw new BadRequestException('Datas inválidas (use YYYY-MM-DD)');
    }
    // fim = dia SEGUINTE ao "to" pra ser intervalo half-open (>=from, <fim)
    // Assim "31/01" como "to" inclui o dia 31 inteiro.
    const fimDate = new Date(`${to}T00:00:00.000Z`);
    fimDate.setUTCDate(fimDate.getUTCDate() + 1);
    const fimStr = fimDate.toISOString().slice(0, 10);
    return this.erp.searchRefsByDateRange({
      inicio: from,
      fim: fimStr,
      descricaoContains: desc?.trim() || undefined,
    });
  }

  /**
   * GET /realignment/search-refs-by-date-debug — diagnóstico
   * Mostra todas as colunas, qual data foi detectada, contagens, sample.
   * Use quando search-refs-by-date retorna 0 pra entender por quê.
   */
  @Get('search-refs-by-date-debug')
  async searchRefsByDateDebug(
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('desc') desc?: string,
    @Req() req?: any,
  ) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
    if (!from || !to) throw new BadRequestException('from e to obrigatórios (YYYY-MM-DD)');
    const fimDate = new Date(`${to}T00:00:00.000Z`);
    fimDate.setUTCDate(fimDate.getUTCDate() + 1);
    return this.erp.diagnoseRefsByDate({
      inicio: from,
      fim: fimDate.toISOString().slice(0, 10),
      descricaoContains: desc?.trim() || undefined,
    });
  }

  @Post('preview')
  preview(
    @Body()
    body: {
      refs?: string[];
      skus?: string[];
      originStoreCodes: string[];
      destStoreCodes: string[];
      minPerDest: number;
      keepMinOrigin?: number;
    },
  ) {
    return this.svc.preview(body);
  }

  @Post('confirm')
  confirm(
    @Body()
    body: {
      plan: Array<{
        sku: string;
        ref?: string | null;
        cor?: string | null;
        tamanho?: string | null;
        desc?: string;
        fromCode: string;
        toCode: string;
        qty: number;
        stockFromBefore?: number;
      }>;
      note?: string;
    },
    @Req() req: any,
  ) {
    const createdByUserId = req?.user?.id || req?.user?.sub || null;
    const createdByName =
      req?.user?.name || req?.user?.email || 'Retaguarda';
    return this.svc.confirm({
      ...body,
      createdByUserId,
      createdByName,
    });
  }

  /**
   * Lista as ordens de realinhamento pendentes da loja do JWT.
   * Retorna [] se o usuário não for role=store.
   */
  @Get('mine')
  mine(@Req() req: any) {
    const role = req?.user?.role;
    const storeId = req?.user?.storeId;
    if (role !== 'store' || !storeId) return [];
    return this.svc.listPendingForStore(storeId);
  }

  /**
   * Ordens de realinhamento JÁ ENVIADAS HOJE pela loja do JWT.
   * Usada pela aba "Enviados hoje" — conferência pra vendedora.
   */
  @Get('mine-sent')
  mineSent(@Req() req: any) {
    const role = req?.user?.role;
    const storeId = req?.user?.storeId;
    if (role !== 'store' || !storeId) return [];
    return this.svc.listSentTodayForStore(storeId);
  }

  /**
   * Loja marca 1 ordem como enviada.
   * Valida role=store + matching storeCode no service.
   */
  @Patch(':id/sent')
  async markSent(@Param('id') id: string, @Req() req: any) {
    const role = req?.user?.role;
    const storeId = req?.user?.storeId;
    const userId = req?.user?.id || req?.user?.userId || req?.user?.sub || null;
    if (role !== 'store' || !storeId) {
      throw new ForbiddenException('Apenas loja pode marcar como enviado');
    }
    return this.svc.markAsSent({
      transferId: id,
      storeId,
      userId,
    });
  }

  /**
   * Loja REVERTE uma ordem já marcada como enviada — volta pra fila de
   * pendentes. Usada quando o operador clicou errado em "Enviei".
   */
  @Patch(':id/unsent')
  async markUnsent(@Param('id') id: string, @Req() req: any) {
    const role = req?.user?.role;
    const storeId = req?.user?.storeId;
    if (role !== 'store' || !storeId) {
      throw new ForbiddenException('Apenas loja pode reverter envio');
    }
    return this.svc.markAsUnsent({
      transferId: id,
      storeId,
    });
  }

  // ════════════════════════════════════════════════════════════════════
  // SHIPMENT (Remessa) — agrupamento físico de itens em trânsito
  // ════════════════════════════════════════════════════════════════════

  /**
   * Lista as remessas ABERTAS da loja origem (vendedora ainda montando).
   * GET /realignment/shipments/open · filial
   */
  @Get('shipments/open')
  listOpenShipments(@Req() req: any) {
    const role = req?.user?.role;
    const storeId = req?.user?.storeId;
    if (role !== 'store' || !storeId) return [];
    return this.shipment.listOpenShipmentsForOrigin(storeId);
  }

  /**
   * Lista remessas chegando na loja destino (status=in_transit).
   * GET /realignment/shipments/incoming · filial
   */
  @Get('shipments/incoming')
  listIncomingShipments(@Req() req: any) {
    const role = req?.user?.role;
    const storeId = req?.user?.storeId;
    if (role !== 'store' || !storeId) return [];
    return this.shipment.listIncomingShipments(storeId);
  }

  /**
   * Detalhe de uma remessa (todos itens com status individual).
   * GET /realignment/shipments/:id · filial
   */
  @Get('shipments/:id')
  getShipmentDetail(@Param('id') id: string, @Req() req: any) {
    const role = req?.user?.role;
    const storeId = req?.user?.storeId;
    if (role !== 'store' || !storeId)
      throw new ForbiddenException('Apenas loja');
    return this.shipment.getShipmentDetail({ shipmentId: id, storeId });
  }

  /**
   * Adiciona um item (TransferOrder pendente) à remessa aberta do par.
   * POST /realignment/shipments/add-item { transferOrderId } · filial origem
   */
  @Post('shipments/add-item')
  addItemToShipment(@Body() body: { transferOrderId: string }, @Req() req: any) {
    const role = req?.user?.role;
    const storeId = req?.user?.storeId;
    const userId = req?.user?.id || req?.user?.sub || null;
    if (role !== 'store' || !storeId)
      throw new ForbiddenException('Apenas loja origem');
    return this.shipment.addItemToShipment({
      transferOrderId: body?.transferOrderId,
      storeId,
      userId,
    });
  }

  /**
   * Remove um item de uma remessa aberta (vendedora errou, quer tirar).
   * DELETE /realignment/shipments/items/:transferOrderId · filial origem
   */
  @Delete('shipments/items/:transferOrderId')
  removeItemFromShipment(@Param('transferOrderId') id: string, @Req() req: any) {
    const role = req?.user?.role;
    const storeId = req?.user?.storeId;
    if (role !== 'store' || !storeId)
      throw new ForbiddenException('Apenas loja origem');
    return this.shipment.removeItemFromShipment({ transferOrderId: id, storeId });
  }

  /**
   * Fecha a remessa, baixa estoque Giga origem em batch e envia.
   * POST /realignment/shipments/:id/close-and-send · filial origem
   */
  @Post('shipments/:id/close-and-send')
  closeAndSendShipment(@Param('id') id: string, @Req() req: any) {
    const role = req?.user?.role;
    const storeId = req?.user?.storeId;
    const userId = req?.user?.id || req?.user?.sub || null;
    if (role !== 'store' || !storeId)
      throw new ForbiddenException('Apenas loja origem');
    return this.shipment.closeAndSend({ shipmentId: id, storeId, userId });
  }

  /**
   * Bipa um SKU pra marcar item como conferido na remessa.
   * POST /realignment/shipments/:id/scan { sku } · filial destino
   */
  @Post('shipments/:id/scan')
  scanItem(@Param('id') id: string, @Body() body: { sku: string }, @Req() req: any) {
    const role = req?.user?.role;
    const storeId = req?.user?.storeId;
    const userId = req?.user?.id || req?.user?.sub || null;
    if (role !== 'store' || !storeId)
      throw new ForbiddenException('Apenas loja destino');
    return this.shipment.scanItem({
      shipmentId: id,
      sku: body?.sku || '',
      storeId,
      userId,
    });
  }

  /**
   * Marca um item como FALTANTE (não chegou). Cancela obrigação financeira.
   * POST /realignment/shipments/:id/missing { transferOrderId, note? } · filial destino
   */
  @Post('shipments/:id/missing')
  markMissing(
    @Param('id') id: string,
    @Body() body: { transferOrderId: string; note?: string },
    @Req() req: any,
  ) {
    const role = req?.user?.role;
    const storeId = req?.user?.storeId;
    const userId = req?.user?.id || req?.user?.sub || null;
    if (role !== 'store' || !storeId)
      throw new ForbiddenException('Apenas loja destino');
    return this.shipment.markItemMissing({
      shipmentId: id,
      transferOrderId: body?.transferOrderId,
      storeId,
      note: body?.note,
      userId,
    });
  }

  /**
   * "Dar Entrada" — finaliza recebimento, +1 estoque Giga destino.
   * POST /realignment/shipments/:id/confirm-received · filial destino
   */
  @Post('shipments/:id/confirm-received')
  confirmReceived(@Param('id') id: string, @Req() req: any) {
    const role = req?.user?.role;
    const storeId = req?.user?.storeId;
    const userId = req?.user?.id || req?.user?.sub || null;
    if (role !== 'store' || !storeId)
      throw new ForbiddenException('Apenas loja destino');
    return this.shipment.confirmReceived({ shipmentId: id, storeId, userId });
  }

  // ════════════════════════════════════════════════════════════════════
  // WIPE / DESTRUTIVOS (admin)
  // ════════════════════════════════════════════════════════════════════

  /**
   * GET /realignment/wipe-preview · admin
   *
   * Conta quantos realinhamentos existem hoje (por status e por loja).
   * NÃO deleta nada — usado pra UI mostrar preview antes do wipe.
   */
  @Get('wipe-preview')
  wipePreview(@Req() req: any) {
    const role = req?.user?.role;
    if (role !== 'admin') {
      throw new ForbiddenException('Apenas admin');
    }
    return this.svc.wipePreview();
  }

  /**
   * DELETE /realignment/wipe-all?confirm=YES · admin
   *
   * ⚠️ DELETA TODOS os realinhamentos do banco (todas lojas, todos status).
   * Preserva REPOSICAO e VENDA_CERTA (mesma tabela, tipos diferentes).
   *
   * Proteção dupla:
   *   - role=admin no JWT
   *   - query string ?confirm=YES (evita curl acidental)
   */
  @Delete('wipe-all')
  async wipeAll(@Req() req: any, @Query('confirm') confirm?: string) {
    const role = req?.user?.role;
    if (role !== 'admin') {
      throw new ForbiddenException('Apenas admin');
    }
    if (confirm !== 'YES') {
      throw new BadRequestException(
        'Faltou confirm=YES na query. Ação destrutiva, sem rollback.',
      );
    }
    return this.svc.wipeAll();
  }
}
