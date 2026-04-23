import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { RealignmentService } from './realignment.service';

/**
 * Rotas do realinhamento de estoques.
 *
 *   POST /realignment/preview   → calcula o plano (sem persistir)
 *   POST /realignment/confirm   → persiste o plano e opcionalmente dispara WhatsApp
 *
 * Exemplo preview:
 *   {
 *     "skus": ["VMS-223-PRETO-M", "VMS-223-PRETO-G"],
 *     "originStoreCodes": ["LJ01","LJ02","LJ05"],
 *     "destStoreCodes":   ["LJ03","LJ04"],
 *     "minPerDest": 2,
 *     "keepMinOrigin": 2
 *   }
 *
 * Exemplo confirm (reenvia o plan retornado do preview, pode editar qty):
 *   {
 *     "plan": [
 *       { "sku":"VMS-223-PRETO-M", "fromCode":"LJ05", "toCode":"LJ03", "qty":2, "stockFromBefore":7 }
 *     ],
 *     "sendWhatsapp": true,
 *     "note": "pro lançamento do sábado"
 *   }
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
      sendWhatsapp?: boolean;
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
}
