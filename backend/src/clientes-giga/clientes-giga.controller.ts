import { Body, Controller, ForbiddenException, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { authorizeMinLevel } from '../auth/auth-levels.util';
import { ClientesGigaService } from './clientes-giga.service';

/**
 * /admin/clientes-giga — importação completa da tabela `clientes` do Giga.
 * Matriz-only. Primeira carga: POST /sync (pode levar alguns minutos).
 * GET /sample mostra TODAS as colunas originais — insumo pra tela de consulta.
 */
@Controller('admin/clientes-giga')
@UseGuards(JwtAuthGuard)
export class ClientesGigaController {
  constructor(private readonly svc: ClientesGigaService) {}

  private requireAdmin(req: any) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'operator') {
      throw new ForbiddenException('Apenas matriz (admin/operator)');
    }
  }

  /** Dispara em background — responde na hora; acompanhar em GET /status. */
  @Post('sync')
  sync(@Req() req: any) {
    this.requireAdmin(req);
    return this.svc.startBackground();
  }

  @Get('status')
  status(@Req() req: any) {
    this.requireAdmin(req);
    return this.svc.status();
  }

  /** Re-roda só a vinculação com o Customer mestre (ex.: após dedup no CRM). */
  @Post('vincular')
  vincular(@Req() req: any) {
    this.requireAdmin(req);
    return this.svc.vincular();
  }

  @Get('sample')
  sample(@Req() req: any, @Query('limit') limit?: string) {
    this.requireAdmin(req);
    return this.svc.sample(Number(limit) || 3);
  }

  /** Busca unificada (nome/CPF/fone/código) — agrupada por PESSOA. */
  @Get('search')
  search(@Req() req: any, @Query('q') q?: string) {
    this.requireAdmin(req);
    return this.svc.search(q || '');
  }

  /** Ficha completa da pessoa (todas as lojas + CRM + parcelas em aberto). */
  @Get('pessoa')
  pessoa(@Req() req: any, @Query('loja') loja?: string, @Query('codigo') codigo?: string) {
    this.requireAdmin(req);
    return this.svc.pessoa(String(loja || ''), String(codigo || ''));
  }

  /** Histórico completo (lojas espelhadas + PDV + site + live + devoluções). */
  @Get('historico')
  historico(@Req() req: any, @Query('loja') loja?: string, @Query('codigo') codigo?: string) {
    this.requireAdmin(req);
    return this.svc.historico(String(loja || ''), String(codigo || ''));
  }

  /** EDITA uma ficha (Flow = fonte; Giga recebe réplica via outbox). */
  @Post('ficha/editar')
  editar(
    @Req() req: any,
    @Body() body: { loja: string; codigo: string; campos: Record<string, any> },
  ) {
    this.requireAdmin(req);
    return this.svc.editarFicha(
      String(body?.loja || ''), String(body?.codigo || ''), body?.campos || {},
      req?.user?.name || req?.user?.email || null,
    );
  }

  /** CADASTRA cliente novo no Flow (código 500001+; réplica pro Giga). */
  @Post('cadastro')
  cadastrar(@Req() req: any, @Body() body: { loja: string; campos: Record<string, any> }) {
    this.requireAdmin(req);
    return this.svc.cadastrar(
      String(body?.loja || ''), body?.campos || {},
      req?.user?.name || req?.user?.email || null,
    );
  }

  /** RESUMO da cliente: crediário, marcados AO VIVO, limite, cashback, pode marcar. */
  /** Histórico COMPLETO de marcados da pessoa (ativos + fechados + devolvidos
   *  + baixados com motivo/quem) — tabela nativa `marcados`. */
  @Get('marcados-historico')
  marcadosHistorico(@Req() req: any, @Query('loja') loja?: string, @Query('codigo') codigo?: string) {
    this.requireAdmin(req);
    return this.svc.marcadosHistorico(String(loja || ''), String(codigo || ''));
  }

  @Get('resumo')
  resumo(@Req() req: any, @Query('loja') loja?: string, @Query('codigo') codigo?: string) {
    this.requireAdmin(req);
    return this.svc.resumo(String(loja || ''), String(codigo || ''));
  }

  /** Campos SENSÍVEIS (limite/avaliação/bloqueado) — exige senha GERENTE+.
   *  Registra QUEM autorizou (PIN pessoal) na ficha. */
  @Post('ficha/restrito')
  restrito(
    @Req() req: any,
    @Body() body: {
      loja: string; codigo: string; password: string;
      campos: { LIMITECOMPRAS?: string; AVALIACAO?: string; BLOQUEADO?: string };
    },
  ) {
    this.requireAdmin(req);
    // Lança 403 se senha inválida ou nível < GERENTE; devolve quem autorizou.
    const auth = authorizeMinLevel(String(body?.password || ''), 'GERENTE');
    const permitidos: Record<string, any> = {};
    for (const k of ['LIMITECOMPRAS', 'AVALIACAO', 'BLOQUEADO'] as const) {
      if (body?.campos?.[k] !== undefined) permitidos[k] = body.campos[k];
    }
    const quem = auth.byNome || req?.user?.name || req?.user?.email || 'gerente';
    return this.svc.editarFicha(
      String(body?.loja || ''), String(body?.codigo || ''), permitidos,
      `[${auth.level}] ${quem}`,
    );
  }
}
