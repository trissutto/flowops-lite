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
import { hojeBrasilia } from '../common/tz';
import { ConferenciaTicketsService } from './conferencia-tickets.service';

const LIMITE_FOTO = { limits: { fileSize: 15 * 1024 * 1024 } };

/**
 * /admin/conferencia-tickets — o checklist da MATRIZ.
 *
 * Mesma régua de acesso do Super Painel de caixas: admin e supervisor veem a
 * rede; os papéis de franquia veem só as lojas FILIAL. Releitura por IA (gasta)
 * e configuração do resumo diário são de admin.
 */
@UseGuards(JwtAuthGuard)
@Controller('admin/conferencia-tickets')
export class ConferenciaTicketsAdminController {
  constructor(private readonly svc: ConferenciaTicketsService) {}

  private usuario(req: any): string | null {
    return req?.user?.name || req?.user?.email || null;
  }

  /** undefined = rede toda; lista = só essas lojas. */
  private async escopo(req: any): Promise<string[] | undefined> {
    const role = req?.user?.role;
    if (role === 'admin' || role === 'supervisor') return undefined;
    if (role === 'master_franquia' || role === 'franquias') return this.svc.codigosDaFranquia();
    throw new ForbiddenException('Apenas matriz (admin/supervisor) ou franquia');
  }

  private exigirAdmin(req: any) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
  }

  private exigirAdminOuSupervisor(req: any) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'supervisor') throw new ForbiddenException('Apenas admin ou supervisor');
  }

  private async loteNoEscopo(req: any, loteId: string) {
    const lojas = await this.escopo(req);
    const lote = await this.svc.loteDaLoja(loteId, null);
    if (lojas && !lojas.includes(lote.storeCode)) throw new ForbiddenException('Loja fora do seu acesso');
    return lote;
  }

  /** GET /admin/conferencia-tickets/lista?de=YYYY-MM-DD&ate=YYYY-MM-DD */
  @Get('lista')
  async lista(@Req() req: any, @Query('de') de?: string, @Query('ate') ate?: string) {
    const lojas = await this.escopo(req);
    const hoje = hojeBrasilia();
    return this.svc.listar(de || hoje, ate || de || hoje, lojas);
  }

  @Get('lote/:id')
  async detalhe(@Req() req: any, @Param('id') id: string) {
    return this.svc.detalhe(id, await this.escopo(req));
  }

  /**
   * POST /admin/conferencia-tickets/lote { storeCode, dia } — a matriz abre o
   * lote de uma loja pra anexar fotos que chegaram por outro caminho
   * (WhatsApp da loja, por exemplo).
   */
  @Post('lote')
  async abrirLote(@Req() req: any, @Body() body: { storeCode?: string; dia?: string }) {
    const lojas = await this.escopo(req);
    const storeCode = String(body?.storeCode || '').trim();
    const dia = String(body?.dia || '').trim();
    if (!storeCode || !dia) throw new BadRequestException('Informe a loja e o dia');
    if (lojas && !lojas.includes(storeCode)) throw new ForbiddenException('Loja fora do seu acesso');
    const painel = await this.svc.painelAbertura(storeCode, this.usuario(req), dia);
    if (!painel.dia) throw new BadRequestException('Nada a conferir neste dia');
    const lote = await this.svc.obterOuCriarLote(storeCode, dia, this.usuario(req));
    return { loteId: lote.id };
  }

  @Post('lote/:id/fotos')
  @UseInterceptors(FileInterceptor('file', LIMITE_FOTO))
  async enviarFoto(@Req() req: any, @Param('id') id: string, @UploadedFile() file: any) {
    const lote = await this.loteNoEscopo(req, id);
    return this.svc.receberFoto(lote, file, 'pc', this.usuario(req));
  }

  @Delete('foto/:id')
  async removerFoto(@Req() req: any, @Param('id') id: string) {
    const lojas = await this.escopo(req);
    return this.svc.removerFoto(id, (loja) => !lojas || lojas.includes(loja), this.usuario(req));
  }

  /** Recalcula o checklist sem ler de novo (ex.: venda corrigida depois). */
  @Post('lote/:id/reconferir')
  async reconferir(@Req() req: any, @Param('id') id: string) {
    await this.loteNoEscopo(req, id);
    return this.svc.reconferir(id);
  }

  /** Lê de novo todas as fotos com a IA — custa, por isso só matriz. */
  @Post('lote/:id/reler')
  async reler(@Req() req: any, @Param('id') id: string) {
    this.exigirAdminOuSupervisor(req);
    return this.svc.relerLote(id, this.usuario(req));
  }

  @Post('lote/:id/revisar')
  async revisar(@Req() req: any, @Param('id') id: string, @Body() body: { nota?: string }) {
    await this.loteNoEscopo(req, id);
    return this.svc.revisar(id, String(body?.nota || ''), this.usuario(req));
  }

  @Get('config')
  async config(@Req() req: any) {
    await this.escopo(req);
    return this.svc.config();
  }

  @Post('config')
  salvarConfig(@Req() req: any, @Body() body: { ativo?: boolean; destinos?: string[]; hora?: number }) {
    this.exigirAdmin(req);
    return this.svc.salvarConfig(body || {}, this.usuario(req));
  }

  @Get('resumo-diario/previa')
  async previa(@Req() req: any) {
    this.exigirAdminOuSupervisor(req);
    return { texto: await this.svc.textoResumoDiario() };
  }

  @Post('resumo-diario/enviar')
  enviarResumo(@Req() req: any) {
    this.exigirAdmin(req);
    return this.svc.enviarResumoDiario('manual', this.usuario(req));
  }
}
