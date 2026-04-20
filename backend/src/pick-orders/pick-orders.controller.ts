import {
  Body, Controller, ForbiddenException, Get, Param, Patch, Query, Req, UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { PickOrdersService, PickStatus } from './pick-orders.service';

interface AuthUser {
  userId: string;
  email: string;
  role: string;
  storeId: string | null;
}

@Controller('pick-orders')
@UseGuards(JwtAuthGuard)
export class PickOrdersController {
  constructor(private readonly svc: PickOrdersService) {}

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
}
