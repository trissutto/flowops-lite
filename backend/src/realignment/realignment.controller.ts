import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { RealignmentService } from './realignment.service';
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
    private readonly erp: ErpService,
  ) {}

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
