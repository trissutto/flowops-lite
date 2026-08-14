import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  NotFoundException,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { CliqueEntrada, EventoEntrada, SiteMetricsService } from './site-metrics.service';

/**
 * A PORTA DO SITE — server-to-server, do BFF do e-commerce pra cá.
 *
 * Mesmo padrão de `public/loja/config`: token compartilhado em `x-loja-token`,
 * comparado em tempo constante, e 404 (nunca 401) quando não confere — não se
 * confirma pra ninguém que a rota existe.
 *
 * Quem chama é o `/api/events` do Next, não o navegador: o evento já passou
 * pelo gate de consentimento do lado de lá antes de chegar aqui.
 */
@Controller('public/site-metrics')
export class SiteMetricsPublicController {
  constructor(private readonly service: SiteMetricsService) {}

  @Post('cliques')
  @HttpCode(204)
  async registrar(
    @Headers('x-loja-token') token: string,
    @Body() body: { cliques?: CliqueEntrada[] },
  ): Promise<void> {
    this.exigirToken(token);
    const cliques = Array.isArray(body?.cliques) ? body.cliques.slice(0, 50) : [];
    if (!cliques.length) return;
    // 204 mesmo se gravar zero: métrica não devolve erro pro site.
    await this.service.registrar(cliques);
  }

  /**
   * TODO evento do site — a cópia de primeira parte (dono, 13/08). Chega
   * inclusive de visitante SEM aceite do banner, já anonimizado na origem;
   * o consentimento aqui governa só o repasse a terceiros, que é do BFF.
   */
  @Post('eventos')
  @HttpCode(204)
  async registrarEventos(
    @Headers('x-loja-token') token: string,
    @Body() body: { eventos?: EventoEntrada[] },
  ): Promise<void> {
    this.exigirToken(token);
    const eventos = Array.isArray(body?.eventos) ? body.eventos.slice(0, 50) : [];
    if (!eventos.length) return;
    await this.service.registrarEventos(eventos);
  }

  /**
   * O LEAD DO WHATSAPP — quem mandou a mensagem carimbada ("vim pelo site").
   * Quem chama é o n8n (Evolution → webhook), com o MESMO x-loja-token.
   */
  @Post('whatsapp-lead')
  async registrarLeadWhatsapp(
    @Headers('x-loja-token') token: string,
    @Body() body: {
      telefone?: string; nome?: string; loja?: string;
      mensagem?: string; instancia?: string;
    },
  ) {
    this.exigirToken(token);
    return this.service.registrarLeadWhatsapp(body ?? {});
  }

  private segredoConfere(recebido: string, esperado: string): boolean {
    const a = crypto.createHash('sha256').update(recebido).digest();
    const b = crypto.createHash('sha256').update(esperado).digest();
    return crypto.timingSafeEqual(a, b);
  }

  private exigirToken(token?: string): void {
    const esperado = process.env.LOJA_ORDER_TOKEN;
    if (!esperado) throw new NotFoundException();
    if (!token || !this.segredoConfere(token, esperado)) throw new NotFoundException();
  }
}

/**
 * O RELATÓRIO — tela da retaguarda, atrás do JWT.
 *
 * Recorte por De/Até como toda tela com período no sistema. Sem parâmetro,
 * devolve os últimos 30 dias.
 */
@Controller('site-metrics')
@UseGuards(JwtAuthGuard)
export class SiteMetricsController {
  constructor(private readonly service: SiteMetricsService) {}

  /**
   * QUEM ESTÁ NO SITE AGORA — o card ao vivo da tela de cliques.
   * Sem parâmetro de propósito: "agora" não tem De/Até.
   */
  @Get('agora')
  async agora(@Req() req: any) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
    return this.service.agora();
  }

  @Get('lojas')
  async lojas(@Req() req: any, @Query('de') de?: string, @Query('ate') ate?: string) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');

    const fim = this.fimDoDia(ate) ?? this.fimDoDia(this.hoje())!;
    const inicio = this.inicioDoDia(de) ?? new Date(fim.getTime() - 29 * 24 * 60 * 60 * 1000);

    const { linhas, totalCliques } = await this.service.porLoja(inicio, fim);
    return {
      de: inicio.toISOString(),
      ate: fim.toISOString(),
      totalCliques,
      linhas,
    };
  }

  /** Leads do WhatsApp (mensagem carimbada) — tela /retaguarda/leads-whatsapp. */
  @Get('whatsapp-leads')
  async whatsappLeads(@Req() req: any, @Query('de') de?: string, @Query('ate') ate?: string) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');

    const fim = this.fimDoDia(ate) ?? this.fimDoDia(this.hoje())!;
    const inicio = this.inicioDoDia(de) ?? new Date(fim.getTime() - 29 * 24 * 60 * 60 * 1000);

    const dados = await this.service.leadsWhatsapp(inicio, fim);
    return { de: inicio.toISOString(), ate: fim.toISOString(), ...dados };
  }

  /** O funil do site (visita → sacola → checkout → compra) — mesma janela De/Até. */
  @Get('funil')
  async funil(@Req() req: any, @Query('de') de?: string, @Query('ate') ate?: string) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');

    const fim = this.fimDoDia(ate) ?? this.fimDoDia(this.hoje())!;
    const inicio = this.inicioDoDia(de) ?? new Date(fim.getTime() - 29 * 24 * 60 * 60 * 1000);

    const [etapas, diagnosticos] = await Promise.all([
      this.service.funil(inicio, fim),
      this.service.diagnosticosFunil(inicio, fim),
    ]);
    return {
      de: inicio.toISOString(),
      ate: fim.toISOString(),
      etapas,
      diagnosticos,
    };
  }

  private hoje(): string {
    return new Date().toISOString().slice(0, 10);
  }

  /**
   * "2026-08-13" → 00:00 e 23:59:59.999 no fuso de SÃO PAULO, não em UTC.
   *
   * `new Date('2026-08-13')` no Node é meia-noite UTC = 21h do dia ANTERIOR
   * aqui. Filtrar "hoje" assim come as 3 primeiras horas do dia e mostra 3
   * horas do dia anterior — o mesmo erro de fuso que já apareceu na tela de
   * devolução do PDV. O deslocamento entra explícito.
   */
  private inicioDoDia(valor?: string): Date | null {
    if (!valor || !/^\d{4}-\d{2}-\d{2}$/.test(valor)) return null;
    return new Date(`${valor}T00:00:00.000-03:00`);
  }

  private fimDoDia(valor?: string): Date | null {
    if (!valor || !/^\d{4}-\d{2}-\d{2}$/.test(valor)) return null;
    return new Date(`${valor}T23:59:59.999-03:00`);
  }
}
