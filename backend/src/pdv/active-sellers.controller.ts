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
import { ErpService } from '../erp/erp.service';

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
  constructor(
    private readonly svc: ActiveSellersService,
    private readonly erp: ErpService,
  ) {}

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

  /**
   * GET /pdv/vendedoras-ativas/wincred?storeCode=X
   * Lê funcionários ATIVOS direto do Wincred (não popular tabela local).
   */
  @Get('wincred')
  async wincredList(@Req() req: any, @Query('storeCode') storeCode: string) {
    this.requireRole(req);
    if (!storeCode) throw new BadRequestException('storeCode obrigatório');
    const codes = Array.from(
      new Set([storeCode.toUpperCase(), storeCode.padStart(2, '0').slice(-2)]),
    );
    return this.erp.getFuncionariosAtivosByLoja(codes);
  }

  /**
   * POST /pdv/vendedoras-ativas/sync-from-wincred
   * Body: { storeCode } | { storeCodes: [] }
   * Sync REPLACE-ALL: substitui a lista local pela atual do Wincred.
   * Cuidado: remove vendedoras que não estão mais ativas no Wincred.
   */
  @Post('sync-from-wincred')
  async syncFromWincred(
    @Req() req: any,
    @Body() body: { storeCode?: string; storeCodes?: string[] },
  ) {
    this.requireRole(req);
    const stores = body.storeCodes && body.storeCodes.length > 0
      ? body.storeCodes
      : body.storeCode
        ? [body.storeCode]
        : (req?.user?.storeCode ? [req.user.storeCode] : []);
    if (stores.length === 0) throw new BadRequestException('storeCode(s) obrigatório');

    const results: Array<{ storeCode: string; total: number; error?: string }> = [];

    for (const sc of stores) {
      const scUpper = String(sc).toUpperCase();
      const codes = Array.from(
        new Set([scUpper, scUpper.padStart(2, '0').slice(-2)]),
      );
      try {
        const funcs = await this.erp.getFuncionariosAtivosByLoja(codes);
        const sellers = funcs.map((f) => ({
          codigo: f.codigo,
          nome: f.apelido || f.nome,
        }));
        await this.svc.replaceAll({ storeCode: scUpper, sellers });
        results.push({ storeCode: scUpper, total: sellers.length });
      } catch (e: any) {
        results.push({ storeCode: scUpper, total: 0, error: e?.message || String(e) });
      }
    }
    return { results, when: new Date().toISOString() };
  }
}
