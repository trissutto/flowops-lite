import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { CustomerJwtGuard } from '../customers-app/customer-jwt.guard';
import { ContaResumoService } from './conta-resumo.service';

/** GET /customers/app/resumo — os cinco contadores da barra de "Minha conta". */
@Controller('customers/app/resumo')
@UseGuards(CustomerJwtGuard)
export class ContaResumoController {
  constructor(private readonly svc: ContaResumoService) {}

  @Get()
  async resumo(@Req() req: any) {
    return this.svc.resumo(req.customer.id);
  }
}
