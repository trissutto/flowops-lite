import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { CustomerJwtGuard } from '../customers-app/customer-jwt.guard';
import { SizeFeedbackService } from './size-feedback.service';

@Controller()
export class SizeFeedbackController {
  constructor(private readonly svc: SizeFeedbackService) {}

  /**
   * POST /me/size-feedback — cliente envia review.
   * Body: { productId, variationId?, orderId?, sizeBought, sizeUsually?, feedback, comment? }
   */
  @UseGuards(CustomerJwtGuard)
  @Post('me/size-feedback')
  async submit(@Req() req: any, @Body() body: any) {
    return this.svc.submitFeedback({
      customerId: req.customer.id,
      ...body,
    });
  }

  /**
   * GET /catalog/products/:productId/size-stats?size=48
   * Público — mostra estatísticas na página de produto.
   */
  @Get('catalog/products/:productId/size-stats')
  async stats(
    @Param('productId') productId: string,
    @Query('size') size?: string,
  ) {
    const id = Number(productId);
    if (!id) return { total: 0, recommendation: 'no_data' };
    return this.svc.getStats(id, size);
  }

  /**
   * GET /me/size-feedback/pending — lista pedidos elegíveis pra review.
   * Usado pela tela de coleta in-app.
   */
  @UseGuards(CustomerJwtGuard)
  @Get('me/size-feedback/pending')
  async pending(@Req() req: any) {
    return {
      pending: await this.svc.getPendingReviews(req.customer.id),
    };
  }
}
