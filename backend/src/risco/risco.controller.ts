import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { AdminOnly, AdminOnlyGuard } from '../auth/admin-only.guard';
import { RiscoService } from './risco.service';
import { RiscoChavesService } from './risco-chaves.service';
import { RiscoPesos, RiscoPesosService } from './risco-pesos.service';
import { RiscoFilaService, FiltrosFila } from './risco-fila.service';
import { ChargebackService, ChargebackInput } from './chargeback.service';
import { DossiePdfService } from './dossie-pdf.service';

/**
 * CENTRAL DE RISCO — /admin/risco. Só matriz.
 *
 * Aqui mora tudo que o módulo oferece: a análise de um pedido, a fila do que
 * pede olho humano, os chargebacks, a régua do score, o dossiê e os
 * relatórios.
 *
 * ⚠️ NENHUMA rota deste controller altera o pedido. A mais "forte" que existe
 * é `POST /pedido/:ref/decisao`, que carimba a ANÁLISE (e pede senha de gerente
 * pra marcar suspeita). Cancelar continua sendo pelo caminho de cancelamento
 * do pedido, que já sabe lidar com peça bipada e caixa fechada.
 */
@Controller('admin/risco')
@UseGuards(JwtAuthGuard, AdminOnlyGuard)
@AdminOnly()
export class RiscoController {
  constructor(
    private readonly risco: RiscoService,
    private readonly chaves: RiscoChavesService,
    private readonly pesos: RiscoPesosService,
    private readonly fila: RiscoFilaService,
    private readonly chargebacks: ChargebackService,
    private readonly dossie: DossiePdfService,
  ) {}

  // ── Análise de um pedido ────────────────────────────────────────────

  /** GET /pedido/:ref — o painel 🛡️ da tela do pedido. `ref` = uuid, wcOrderId ou número. */
  @Get('pedido/:ref')
  async doPedido(@Param('ref') ref: string) {
    return this.risco.analisar(await this.risco.resolverOrderId(ref));
  }

  /** POST /pedido/:ref/recalcular — regrava as chaves e recalcula. */
  @Post('pedido/:ref/recalcular')
  async recalcular(@Param('ref') ref: string) {
    return this.risco.recalcular(await this.risco.resolverOrderId(ref));
  }

  /** POST /pedido/:ref/decisao — itens 12 e 13. */
  @Post('pedido/:ref/decisao')
  async decidir(
    @Req() req: any,
    @Param('ref') ref: string,
    @Body() body: { status: string; observacao?: string; motivo?: string; senha?: string },
  ) {
    const autor = req?.user?.name || req?.user?.email || 'matriz';
    const orderId = await this.risco.resolverOrderId(ref);
    return this.fila.decidir(orderId, body || ({} as any), autor);
  }

  /** GET /pedido/:ref/historico — item 16. */
  @Get('pedido/:ref/historico')
  async historico(@Param('ref') ref: string) {
    return this.fila.historico(await this.risco.resolverOrderId(ref));
  }

  /** GET /pedido/:ref/dossie — item 17, o PDF de defesa. */
  @Get('pedido/:ref/dossie')
  async dossiePdf(@Param('ref') ref: string, @Res() res: Response) {
    const { buffer, filename } = await this.dossie.gerar(await this.risco.resolverOrderId(ref));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.send(buffer);
  }

  // ── Fila e painel ───────────────────────────────────────────────────

  /** GET /fila — item 11. */
  @Get('fila')
  async listarFila(@Query() q: FiltrosFila) {
    return this.fila.fila(q || {});
  }

  /** GET /dashboard — item 19. */
  @Get('dashboard')
  async dashboard(@Query('de') de?: string, @Query('ate') ate?: string) {
    return this.fila.dashboard(de, ate);
  }

  /**
   * GET /relatorio — item 20. `formato=csv` baixa o arquivo; sem ele devolve
   * as linhas em JSON pra tela desenhar.
   */
  @Get('relatorio')
  async relatorio(@Query() q: FiltrosFila & { tipo?: string; formato?: string }, @Res() res: Response) {
    const tipo = String(q.tipo || 'alto_risco');
    const { colunas, linhas } = await this.fila.relatorio(tipo, q);

    if (String(q.formato || '').toLowerCase() !== 'csv') {
      res.json({ tipo, colunas, linhas, total: linhas.length });
      return;
    }

    // BOM na frente: sem ele o Excel em português abre acentuação quebrada, e
    // o relatório volta como "veio tudo errado".
    const csv =
      '﻿' +
      [colunas, ...linhas]
        .map((linha) => linha.map((c: any) => this.celulaCsv(c)).join(';'))
        .join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="risco-${tipo}.csv"`);
    res.send(csv);
  }

  // ── Régua do score ──────────────────────────────────────────────────

  @Get('pesos')
  async getPesos() {
    return this.pesos.get();
  }

  @Post('pesos')
  async setPesos(@Body() body: Partial<RiscoPesos>) {
    return this.pesos.set(body || {});
  }

  // ── Chargebacks ─────────────────────────────────────────────────────

  @Get('chargebacks')
  async listarChargebacks(
    @Query('status') status?: string,
    @Query('de') de?: string,
    @Query('ate') ate?: string,
    @Query('busca') busca?: string,
    @Query('limite') limite?: string,
  ) {
    return this.chargebacks.listar({ status, de, ate, busca, limite: Number(limite) || 200 });
  }

  @Post('chargebacks')
  async criarChargeback(@Req() req: any, @Body() body: ChargebackInput) {
    const autor = req?.user?.name || req?.user?.email || 'matriz';
    return this.chargebacks.registrar(body || {}, autor, 'manual');
  }

  @Patch('chargebacks/:id')
  async atualizarChargeback(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: Partial<ChargebackInput>,
  ) {
    const autor = req?.user?.name || req?.user?.email || 'matriz';
    return this.chargebacks.atualizar(id, body || {}, autor);
  }

  @Delete('chargebacks/:id')
  async removerChargeback(@Req() req: any, @Param('id') id: string) {
    const autor = req?.user?.name || req?.user?.email || 'matriz';
    return this.chargebacks.remover(id, autor);
  }

  // ── Manutenção ──────────────────────────────────────────────────────

  /**
   * GET /status — quanto da base já tem chave. É o termômetro do backfill: sem
   * ele, ninguém sabe se o módulo está enxergando a base inteira ou um pedaço.
   */
  @Get('status')
  async status() {
    const [pesos, semChave] = await Promise.all([
      this.pesos.get(),
      this.chaves.pedidosSemChave(),
    ]);
    return { ativo: pesos.ativo, pedidosSemChave: semChave };
  }

  /**
   * POST /backfill — gera as chaves da base já existente.
   *
   * Roda em lotes e é retomável: chamar de novo continua de onde parou. É
   * pesado de propósito na mão de quem clica, não num cron — a primeira carga
   * é uma decisão, não um efeito colateral de deploy.
   */
  @Post('backfill')
  async backfill(@Body() body: { lote?: number; ciclos?: number }) {
    return this.chaves.backfill(body || {});
  }

  private celulaCsv(v: any): string {
    const s = String(v ?? '');
    // Ponto e vírgula é o separador do Excel pt-BR; aspas e quebra de linha
    // precisam de escape ou a coluna vaza pra linha seguinte.
    return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
}
