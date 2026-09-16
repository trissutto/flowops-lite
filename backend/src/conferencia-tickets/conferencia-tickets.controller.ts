import {
  BadRequestException,
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
import { ConferenciaTicketsService } from './conferencia-tickets.service';

const LIMITE_FOTO = { limits: { fileSize: 15 * 1024 * 1024 } };

function usuarioDe(req: any): string | null {
  return req?.user?.name || req?.user?.email || null;
}

/**
 * /pdv/conferencia-tickets — a ponta da LOJA: a etapa de tickets da abertura
 * do caixa e as pendências da home. Loja opera só a própria loja (JWT); admin
 * pode passar `storeCode`, igual ao /pdv/caixa.
 */
@UseGuards(JwtAuthGuard)
@Controller('pdv/conferencia-tickets')
export class ConferenciaTicketsController {
  constructor(private readonly svc: ConferenciaTicketsService) {}

  private loja(req: any, override?: string): { storeCode: string; admin: boolean } {
    const role = req?.user?.role;
    if (role === 'admin') {
      const storeCode = String(override || req?.user?.storeCode || '').trim();
      if (!storeCode) throw new BadRequestException('storeCode é obrigatório pra admin');
      return { storeCode, admin: true };
    }
    if (role !== 'store') throw new ForbiddenException('Apenas admin ou loja');
    const storeCode = String(req?.user?.storeCode || '').trim();
    if (!storeCode) throw new BadRequestException('Usuário sem loja vinculada');
    return { storeCode, admin: false };
  }

  private async lotePermitido(req: any, loteId: string) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'store') throw new ForbiddenException('Apenas admin ou loja');
    return this.svc.loteDaLoja(loteId, role === 'admin' ? null : req?.user?.storeCode || '__sem_loja__');
  }

  /** GET /pdv/conferencia-tickets/abertura?storeCode=&dia= — a etapa da abertura do caixa. */
  @Get('abertura')
  abertura(@Req() req: any, @Query('storeCode') storeCode?: string, @Query('dia') dia?: string) {
    const loja = this.loja(req, storeCode);
    return this.svc.painelAbertura(loja.storeCode, usuarioDe(req), dia || undefined);
  }

  /** GET /pdv/conferencia-tickets/pendencias — tarefas da fila "O QUE FAZER AGORA". */
  @Get('pendencias')
  pendencias(@Req() req: any, @Query('storeCode') storeCode?: string) {
    const loja = this.loja(req, storeCode);
    return this.svc.pendenciasDaLoja(loja.storeCode);
  }

  @Get('lote/:id')
  async estado(@Req() req: any, @Param('id') id: string) {
    await this.lotePermitido(req, id);
    return this.svc.estadoDoLote(id);
  }

  @Get('lote/:id/faltando')
  async faltando(@Req() req: any, @Param('id') id: string) {
    await this.lotePermitido(req, id);
    return this.svc.faltandoDaLoja(id);
  }

  @Post('lote/:id/fotos')
  @UseInterceptors(FileInterceptor('file', LIMITE_FOTO))
  async enviarFoto(@Req() req: any, @Param('id') id: string, @UploadedFile() file: any) {
    const lote = await this.lotePermitido(req, id);
    return this.svc.receberFoto(lote, file, 'pc', usuarioDe(req));
  }

  @Post('lote/:id/sem-tickets')
  async semTickets(@Req() req: any, @Param('id') id: string, @Body() body: { motivo?: string }) {
    await this.lotePermitido(req, id);
    return this.svc.marcarSemTickets(id, String(body?.motivo || ''), usuarioDe(req));
  }

  @Post('lote/:id/terminei')
  async terminei(@Req() req: any, @Param('id') id: string) {
    await this.lotePermitido(req, id);
    return this.svc.finalizar(id, usuarioDe(req));
  }

  @Delete('foto/:id')
  removerFoto(@Req() req: any, @Param('id') id: string) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'store') throw new ForbiddenException('Apenas admin ou loja');
    const minha = String(req?.user?.storeCode || '');
    return this.svc.removerFoto(id, (loja) => role === 'admin' || (!!minha && loja === minha), usuarioDe(req));
  }
}
