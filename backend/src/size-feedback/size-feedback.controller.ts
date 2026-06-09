import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { CustomerJwtGuard } from '../customers-app/customer-jwt.guard';
import { SizeFeedbackService } from './size-feedback.service';

/**
 * Endpoints autenticados de cliente pra Review por Tamanho.
 * GET público de stats foi movido pro CatalogController pra evitar
 * conflito de rota com /catalog/products/:slug.
 */
@Controller('me/size-feedback')
export class SizeFeedbackController {
  constructor(private readonly svc: SizeFeedbackService) {}

  /**
   * POST /me/size-feedback — cliente envia review.
   * Body: { productId, variationId?, orderId?, sizeBought, sizeUsually?, feedback, comment? }
   */
  @UseGuards(CustomerJwtGuard)
  @Post()
  async submit(@Req() req: any, @Body() body: any) {
    return this.svc.submitFeedback({
      customerId: req.customer.id,
      ...body,
    });
  }

  /**
   * GET /me/size-feedback/pending — lista pedidos elegíveis pra review.
   */
  @UseGuards(CustomerJwtGuard)
  @Get('pending')
  async pending(@Req() req: any) {
    return {
      pending: await this.svc.getPendingReviews(req.customer.id),
    };
  }
}
