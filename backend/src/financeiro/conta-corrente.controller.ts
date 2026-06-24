import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { ContaCorrenteService } from './conta-corrente.service';

/**
 * /financeiro/conta-corrente — conta corrente da franqueada.
 * Só admin (mesma regra do resto do financeiro).
 */
@UseGuards(JwtAuthGuard)
@Controller('financeiro/conta-corrente')
export class ContaCorrenteController {
  constructor(private readonly svc: ContaCorrenteService) {}

  private requireAdmin(req: any) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
  }

  /** GET /financeiro/conta-corrente?from=YYYY-MM-DD&to=YYYY-MM-DD → extrato + saldo */
  @Get()
  extrato(@Req() req: any, @Query('from') from?: string, @Query('to') to?: string) {
    this.requireAdmin(req);
    return this.svc.extrato({ from, to });
  }

  /**
   * POST /financeiro/conta-corrente/lancamentos (multipart/form-data)
   * Campos: data?, tipo (pagamento|ajuste), natureza? (credito|debito),
   *         descricao, valor, file? (documento/comprovante)
   */
  @Post('lancamentos')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  criar(
    @Req() req: any,
    @UploadedFile() file: any,
    @Body()
    body: {
      data?: string;
      tipo: string;
      natureza?: string;
      descricao: string;
      valor: string | number;
    },
  ) {
    this.requireAdmin(req);
    return this.svc.criarLancamento(
      {
        data: body.data,
        tipo: body.tipo,
        natureza: body.natureza,
        descricao: body.descricao,
        valor: Number(body.valor),
      },
      file,
      {
        id: req?.user?.sub || req?.user?.id || null,
        nome: req?.user?.name || req?.user?.email || null,
      },
    );
  }

  /** DELETE /financeiro/conta-corrente/lancamentos/:id → estorna (apaga + doc) */
  @Delete('lancamentos/:id')
  remover(@Req() req: any, @Param('id') id: string) {
    this.requireAdmin(req);
    return this.svc.removerLancamento(id);
  }

  /** POST /financeiro/conta-corrente/sync-giga → sincroniza o espelho sob demanda */
  @Post('sync-giga')
  syncGiga(@Req() req: any) {
    this.requireAdmin(req);
    return this.svc.sincronizarGiga();
  }

  /** GET /financeiro/conta-corrente/transfer-items?controle=&data= → 5º nível */
  @Get('transfer-items')
  transferItems(@Req() req: any, @Query('controle') controle?: string, @Query('data') data?: string) {
    this.requireAdmin(req);
    return this.svc.getTransferItems({ controle, data });
  }
}
