import {
  BadRequestException, Body, Controller, ForbiddenException, Get, Param, Post, Query, Req, UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { FitService } from './fit.service';

/**
 * LURDS FIT AI — API PÚBLICA (o widget da página do produto chama isto).
 *
 * Sem JWT de propósito: o widget roda no site, pra visitante deslogada. Não
 * expõe nada sensível — só devolve tamanho + explicação. A gravação é de
 * medidas anônimas (anonId do navegador) até a cliente se identificar.
 *
 * Rate limit simples em memória por IP: o widget é chamado 1x por consulta,
 * então 30/min por IP já é folgado e barra script de raspagem.
 */
@Controller('public/fit')
export class FitPublicController {
  private hits = new Map<string, { n: number; janela: number }>();

  constructor(private readonly svc: FitService) {}

  private rate(req: any, limite = 30) {
    const ip = String(
      req?.headers?.['x-forwarded-for']?.toString().split(',')[0]?.trim() || req?.ip || 'sem-ip',
    );
    const agora = Math.floor(Date.now() / 60_000);
    const cur = this.hits.get(ip);
    if (!cur || cur.janela !== agora) {
      this.hits.set(ip, { n: 1, janela: agora });
      if (this.hits.size > 5000) this.hits.clear(); // poda burra, suficiente
      return;
    }
    cur.n += 1;
    if (cur.n > limite) throw new ForbiddenException('Muitas consultas — tente em instantes');
  }

  /** Ficha pública da peça — o widget usa pra saber se tem dados de caimento. */
  @Get('produto/:ref')
  async produto(@Param('ref') ref: string) {
    const f: any = await this.svc.getProduto(ref);
    return {
      ref: f.ref,
      categoria: f.categoria,
      marca: f.marca,
      modelagem: f.modelagem,
      elastano: f.elastano,
      caimento: f.caimento,
      composicao: f.composicao,
      temFicha: !f.semFicha,
    };
  }

  /**
   * O CÉREBRO. Body:
   *   { alturaCm, pesoKg, idade?, preferencia, formatoCorpo?, busto?, quadril?,
   *     tamanhoHabitual?, ref?, categoria?, marca?, tamanhosDisponiveis?,
   *     anonId?, customerId?, origem? }
   */
  @Post('recomendar')
  recomendar(@Body() body: any, @Req() req: any) {
    this.rate(req);
    return this.svc.recomendar(body || {});
  }

  /**
   * Fecha o ciclo pelo próprio site (ex.: cliente clicou em comprar no
   * tamanho recomendado). Compra/troca no PDV alimenta pelo backend.
   */
  @Post('desfecho')
  desfecho(@Body() body: any, @Req() req: any) {
    this.rate(req, 60);
    if (!body?.recomendacaoId) throw new BadRequestException('recomendacaoId obrigatório');
    return this.svc.registrarDesfecho({
      recomendacaoId: body.recomendacaoId,
      desfecho: body.desfecho,
      tamanhoComprado: body.tamanhoComprado,
      tamanhoFinal: body.tamanhoFinal,
    });
  }
}

/**
 * LURDS FIT AI — administração (matriz).
 *   GET  /fit/dashboard?dias=30
 *   GET  /fit/produto/:ref        · POST /fit/produto      (ficha de caimento)
 *   GET  /fit/cliente/:customerId (Body Profile pro CRM)
 *   POST /fit/desfecho            (fechar ciclo pelo backoffice)
 */
@UseGuards(JwtAuthGuard)
@Controller('fit')
export class FitAdminController {
  constructor(private readonly svc: FitService) {}

  private requireAdmin(req: any) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'master' && role !== 'operador') {
      throw new ForbiddenException('Apenas matriz');
    }
  }

  @Get('dashboard')
  dashboard(@Req() req: any, @Query('dias') dias?: string) {
    this.requireAdmin(req);
    return this.svc.dashboard(dias ? Number(dias) : 30);
  }

  @Get('produto/:ref')
  produto(@Req() req: any, @Param('ref') ref: string) {
    this.requireAdmin(req);
    return this.svc.getProduto(ref);
  }

  @Post('produto')
  salvarProduto(@Req() req: any, @Body() body: any) {
    this.requireAdmin(req);
    const usuario = req?.user?.email || req?.user?.name || null;
    return this.svc.salvarProduto(body, usuario);
  }

  @Get('cliente/:customerId')
  cliente(@Req() req: any, @Param('customerId') customerId: string) {
    this.requireAdmin(req);
    return this.svc.perfilDaCliente(customerId);
  }

  @Post('desfecho')
  desfecho(@Req() req: any, @Body() body: any) {
    this.requireAdmin(req);
    return this.svc.registrarDesfecho(body);
  }
}
