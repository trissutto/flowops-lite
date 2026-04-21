import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { SuppliesService, SupplyItemInput, SupplyRequestStatus } from './supplies.service';

@Controller('supplies')
@UseGuards(JwtAuthGuard)
export class SuppliesController {
  constructor(private readonly supplies: SuppliesService) {}

  private isAdmin(req: any) {
    const role = req?.user?.role;
    return role === 'admin' || role === 'operator';
  }

  private assertAdmin(req: any) {
    if (!this.isAdmin(req)) {
      throw new ForbiddenException('Acesso restrito à matriz (admin/operator).');
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // ITENS DO ALMOXARIFADO (catálogo)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Lista itens do catálogo.
   *  - Admin vê todos (ativos + inativos).
   *  - Filial vê só ativos (?active=true é forçado).
   */
  @Get('items')
  listItems(@Req() req: any, @Query('active') active?: string) {
    const admin = this.isAdmin(req);
    const onlyActive = admin ? active === 'true' : true;
    return this.supplies.listItems({ onlyActive });
  }

  @Post('items')
  createItem(@Req() req: any, @Body() body: SupplyItemInput) {
    this.assertAdmin(req);
    return this.supplies.createItem(body);
  }

  @Patch('items/:id')
  updateItem(@Req() req: any, @Param('id') id: string, @Body() body: SupplyItemInput) {
    this.assertAdmin(req);
    return this.supplies.updateItem(id, body);
  }

  /**
   * Soft delete (marca active=false). Matém histórico dos pedidos antigos.
   */
  @Delete('items/:id')
  deactivateItem(@Req() req: any, @Param('id') id: string) {
    this.assertAdmin(req);
    return this.supplies.deactivateItem(id);
  }

  // ═══════════════════════════════════════════════════════════════
  // PEDIDOS (fluxo filial → matriz)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Filial cria novo pedido de materiais.
   * Body: { items: [{supplyItemId, qtyRequested}], note? }
   */
  @Post('requests')
  createRequest(
    @Req() req: any,
    @Body()
    body: {
      items: { supplyItemId: string; qtyRequested: number }[];
      note?: string | null;
    },
  ) {
    const user = req.user as { userId: string; role: string; storeId: string | null };
    if (user?.role !== 'store' || !user?.storeId) {
      throw new ForbiddenException('Apenas usuários de loja criam pedidos.');
    }
    return this.supplies.createRequest(user.storeId, user.userId, body);
  }

  /**
   * Lista pedidos:
   *  - Filial (role=store) sempre vê só os próprios.
   *  - Matriz (admin/operator) vê todos. Use ?scope=mine pra ver só da loja dela (se tiver).
   *  - Filtro opcional ?status=pending|approved|separating|shipped|delivered|cancelled
   */
  @Get('requests')
  listRequests(
    @Req() req: any,
    @Query('status') status?: string,
    @Query('scope') scope?: string,
    @Query('limit') limit?: string,
  ) {
    const user = req.user as { userId: string; role: string; storeId: string | null };
    return this.supplies.listRequests({
      userRole: user?.role || '',
      userStoreId: user?.storeId ?? null,
      status,
      scope: scope === 'mine' ? 'mine' : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Get('requests/:id')
  getRequest(@Req() req: any, @Param('id') id: string) {
    const user = req.user as { userId: string; role: string; storeId: string | null };
    return this.supplies.getRequestById(id, user?.role || '', user?.storeId ?? null);
  }

  /**
   * Transição de status (matriz). Body:
   *   { toStatus, trackingCode?, carrier?, adminNote?, items?: [{id, qtyApproved, qtyShipped}] }
   */
  @Patch('requests/:id/status')
  updateRequestStatus(
    @Req() req: any,
    @Param('id') id: string,
    @Body()
    body: {
      toStatus: SupplyRequestStatus;
      trackingCode?: string | null;
      carrier?: string | null;
      adminNote?: string | null;
      items?: { id: string; qtyApproved?: number | null; qtyShipped?: number | null }[];
    },
  ) {
    this.assertAdmin(req);
    if (!body?.toStatus) throw new BadRequestException('toStatus obrigatório.');
    return this.supplies.updateRequestStatus(id, body.toStatus, body);
  }

  /**
   * Filial cancela próprio pedido (só enquanto pending).
   */
  @Post('requests/:id/cancel')
  cancelOwnRequest(@Req() req: any, @Param('id') id: string) {
    const user = req.user as { userId: string; role: string; storeId: string | null };
    if (user?.role !== 'store' || !user?.storeId) {
      throw new ForbiddenException('Apenas a própria loja pode cancelar.');
    }
    return this.supplies.cancelOwnRequest(id, user.storeId);
  }
}
