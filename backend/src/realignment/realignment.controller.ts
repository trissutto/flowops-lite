import { Body, Controller, ForbiddenException, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { RealignmentService } from './realignment.service';

/**
 * Rotas do realinhamento de estoques.
 *
 *   POST  /realignment/preview     → calcula o plano (sem persistir) · retaguarda
 *   POST  /realignment/confirm     → persiste plano + emite socket alerta · retaguarda
 *   GET   /realignment/mine        → ordens pendentes pra separar (loja origem) · filial
 *   PATCH /realignment/:id/sent    → loja marca ordem como enviada · filial
 */
@UseGuards(JwtAuthGuard)
@Controller('realignment')
export class RealignmentController {
  constructor(private readonly svc: RealignmentService) {}

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
}
