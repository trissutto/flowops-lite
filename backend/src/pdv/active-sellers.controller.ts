import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { ActiveSellersService } from './active-sellers.service';

/**
 * Endpoints de whitelist de vendedoras ATIVAS no PDV.
 *
 *  GET  /pdv/vendedoras-ativas?storeCode=X  → lista da loja
 *  POST /pdv/vendedoras-ativas              → { storeCode, codigo, nome }
 *  DELETE /pdv/vendedoras-ativas/:id        → remove uma
 *  PUT  /pdv/vendedoras-ativas/bulk         → { storeCode, sellers: [...] }
 *                                             substitui toda lista da loja
 */
@UseGuards(JwtAuthGuard)
@Controller('pdv/vendedoras-ativas')
export class ActiveSellersController {
  constructor(private readonly svc: ActiveSellersService) {}

  private requireRole(req: any) {
    const role = req?.user?.role;
    if (!['admin', 'store', 'supervisor'].includes(role)) {
      throw new BadRequestException('Sem permissão');
    }
  }

  @Get()
  async list(@Req() req: any, @Query('storeCode') storeCode: string) {
    this.requireRole(req);
    const code = storeCode || req?.user?.storeCode;
    return this.svc.list(code);
  }

  @Post()
  async add(
    @Req() req: any,
    @Body() body: { storeCode?: string; codigo: string; nome: string },
  ) {
    this.requireRole(req);
    const storeCode = body.storeCode || req?.user?.storeCode;
    return this.svc.add({
      storeCode,
      codigo: body.codigo,
      nome: body.nome,
    });
  }

  @Delete(':id')
  async remove(@Req() req: any, @Param('id') id: string) {
    this.requireRole(req);
    return this.svc.remove(id);
  }

  @Put('bulk')
  async bulk(
    @Req() req: any,
    @Body() body: { storeCode?: string; sellers: Array<{ codigo: string; nome: string }> },
  ) {
    this.requireRole(req);
    const storeCode = body.storeCode || req?.user?.storeCode;
    return this.svc.replaceAll({
      storeCode,
      sellers: body.sellers || [],
    });
  }
}
