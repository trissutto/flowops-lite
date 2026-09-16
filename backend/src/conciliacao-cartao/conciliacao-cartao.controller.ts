import { BadRequestException, Body, Controller, ForbiddenException, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { hojeBrasilia } from '../common/tz';
import { ConciliacaoCartaoService, ConfigConciliacao } from './conciliacao-cartao.service';

/**
 * /admin/conciliacao-cartao — checklist da matriz: vendas no cartão × Stone.
 *
 * Mesma régua de acesso do Super Painel de caixas: admin e supervisor veem a
 * rede; os papéis de franquia veem só as lojas FILIAL. Configurar StoneCodes,
 * rodar carga e mandar o resumo é de admin.
 */
@UseGuards(JwtAuthGuard)
@Controller('admin/conciliacao-cartao')
export class ConciliacaoCartaoController {
  constructor(private readonly svc: ConciliacaoCartaoService) {}

  private usuario(req: any): string | null {
    return req?.user?.name || req?.user?.email || null;
  }

  private async escopo(req: any): Promise<string[] | undefined> {
    const role = req?.user?.role;
    if (role === 'admin' || role === 'supervisor') return undefined;
    if (role === 'master_franquia' || role === 'franquias') return this.svc.codigosDaFranquia();
    throw new ForbiddenException('Apenas matriz (admin/supervisor) ou franquia');
  }

  private exigirAdmin(req: any) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
  }

  private async lojaNoEscopo(req: any, storeCode: string) {
    const lojas = await this.escopo(req);
    if (lojas && !lojas.includes(storeCode)) throw new ForbiddenException('Loja fora do seu acesso');
    return lojas;
  }

  /** GET /admin/conciliacao-cartao/lista?de=YYYY-MM-DD&ate=YYYY-MM-DD */
  @Get('lista')
  async lista(@Req() req: any, @Query('de') de?: string, @Query('ate') ate?: string) {
    const lojas = await this.escopo(req);
    const hoje = hojeBrasilia();
    return this.svc.listar(de || hoje, ate || de || hoje, lojas);
  }

  @Get('dia/:storeCode/:dia')
  async detalhe(@Req() req: any, @Param('storeCode') storeCode: string, @Param('dia') dia: string) {
    const lojas = await this.lojaNoEscopo(req, storeCode);
    return this.svc.detalhe(storeCode, dia, lojas);
  }

  @Post('dia/:storeCode/:dia/revisar')
  async revisar(
    @Req() req: any,
    @Param('storeCode') storeCode: string,
    @Param('dia') dia: string,
    @Body() body: { nota?: string },
  ) {
    await this.lojaNoEscopo(req, storeCode);
    return this.svc.revisar(storeCode, dia, String(body?.nota || ''), this.usuario(req));
  }

  /** Baixa o arquivo da Stone de novo (a Stone reprocessa o dia quando há ajuste). */
  @Post('dia/:storeCode/:dia/baixar-de-novo')
  async baixarDeNovo(@Req() req: any, @Param('storeCode') storeCode: string, @Param('dia') dia: string) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'supervisor') throw new ForbiddenException('Apenas admin ou supervisor');
    return this.svc.rebaixarDia(storeCode, dia);
  }

  @Get('integracao')
  async integracao(@Req() req: any) {
    const lojas = await this.escopo(req);
    const estado = await this.svc.estadoDaIntegracao();
    if (!lojas) return estado;
    return {
      ...estado,
      lojas: estado.lojas.filter((l) => lojas.includes(l.code)),
      arquivos: estado.arquivos.filter((a) => a.storeCode && lojas.includes(a.storeCode)),
      whats: undefined,
    };
  }

  @Post('config')
  salvarConfig(@Req() req: any, @Body() body: Partial<ConfigConciliacao>) {
    this.exigirAdmin(req);
    return this.svc.salvarConfig(body || {}, this.usuario(req));
  }

  /** Carga retroativa: POST { de, ate, lojas? } — roda em segundo plano. */
  @Post('carga')
  carga(@Req() req: any, @Body() body: { de?: string; ate?: string; lojas?: string[] }) {
    this.exigirAdmin(req);
    if (!body?.de || !body?.ate) throw new BadRequestException('Informe o período (de/até)');
    return this.svc.iniciarCarga(body.de, body.ate, Array.isArray(body.lojas) && body.lojas.length ? body.lojas : undefined);
  }

  @Get('resumo/previa')
  async previa(@Req() req: any, @Query('dia') dia?: string) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'supervisor') throw new ForbiddenException('Apenas admin ou supervisor');
    return { texto: await this.svc.textoResumo(dia || undefined) };
  }

  @Post('resumo/enviar')
  enviarResumo(@Req() req: any) {
    this.exigirAdmin(req);
    return this.svc.enviarResumo('manual', this.usuario(req));
  }
}
