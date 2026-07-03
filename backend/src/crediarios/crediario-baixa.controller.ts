/**
 * /crediarios/baixa — endpoints da tela RECEBIMENTOS no PDV.
 *
 * Acesso: vendedora (role=store) opera a própria loja (storeCode do JWT).
 * Admin pode passar storeCode explícito via query.
 */

import {
  BadRequestException, Body, Controller, ForbiddenException, Get, Param, Post, Query, Req, UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { CrediarioBaixaService } from './crediario-baixa.service';
import { CrediarioMirrorService } from './crediario-mirror.service';
import { ErpService } from '../erp/erp.service';
import { CrediariosService } from './crediarios.service';

@UseGuards(JwtAuthGuard)
@Controller('crediarios/baixa')
export class CrediarioBaixaController {
  constructor(
    private readonly svc: CrediarioBaixaService,
    private readonly mirror: CrediarioMirrorService,
    private readonly erp: ErpService,
    private readonly crediarios: CrediariosService,
  ) {}

  // ── ESPELHO do crediário (admin): 1ª carga manual + status ────────
  // O cron horário (min 41) mantém depois; estes endpoints servem pra
  // carregar sem esperar e pra conferir idade/contagem do espelho.

  @Post('espelho/sync')
  async espelhoSync(@Req() req: any) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
    const abertas = await this.mirror.syncAbertas();
    const clientes = await this.mirror.syncClientes();
    // Caches antigos podem estar servindo dados velhos/misturados — limpa os 2
    // (parcelas E lista de clientes, senão a recarga só aparece em 30min).
    this.svc.clearListCache();
    this.svc.clearClientesCache();
    return { ok: true, abertas, clientes };
  }

  @Get('espelho/status')
  async espelhoStatus(@Req() req: any) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
    return this.mirror.status();
  }

  private requireRole(req: any) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'store')
      throw new ForbiddenException('Apenas admin ou loja');
  }

  private resolveStore(req: any, override?: string): { code: string; name: string } {
    const role = req?.user?.role;
    if (role === 'admin') {
      const code = override || req?.user?.storeCode || '';
      const name = req?.user?.storeName || code;
      if (!code) throw new BadRequestException('storeCode obrigatório pra admin');
      return { code, name };
    }
    const code = req?.user?.storeCode;
    const name = req?.user?.storeName || code || '';
    if (!code) throw new BadRequestException('Usuário sem loja vinculada');
    return { code, name };
  }

  // ── Admin: cria índice composto na tabela movimento do Giga ──────
  // Acelera 10-100x as queries de listagem de parcelas em aberto.
  // Idempotente — se já existir, retorna ok sem fazer nada.

  @Post('admin/create-index-movimento')
  async createIndexMovimento(@Req() req: any) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');

    // Detecta colunas reais (PAGO e VENCIMENTO podem ter nome diferente
    // dependendo da instalação Giga)
    const map = await this.crediarios.detectColumns(true);
    if (!map.pago || !map.vencimento) {
      return {
        ok: false,
        error: `Colunas pago/vencimento não detectadas. Detectadas: ${
          Object.entries(map).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(', ')
        }`,
      };
    }

    return this.erp.createIndexIfNotExists({
      table: 'movimento',
      indexName: 'idx_lurdsorder_pago_vencimento',
      columns: [map.pago, map.vencimento],
    });
  }

  // ── Config (admin) ────────────────────────────────────────────────

  @Get('config')
  async getConfig(@Req() req: any) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
    return this.svc.getConfig();
  }

  @Post('config')
  async setConfig(
    @Req() req: any,
    @Body() body: {
      diasCarencia?: number;
      taxaMensalPercent?: number;
      enabled?: boolean;
      multaPercent?: number;
      jurosMaxPercentParcela?: number;
      limiteEnabled?: boolean;
      limiteMaxParcelasVencidas?: number;
      limiteMaxValorEmAberto?: number;
    },
  ) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
    return this.svc.setConfig(body);
  }

  // ── Lista TODOS clientes do Giga (com ou sem parcelas) ───────────
  // Query LEVE — só lê tabela `clientes`, não toca em `movimento`.
  // Frontend filtra local + ao clicar carrega parcelas sob demanda.
  // ESCOPO POR LOJA: cada loja tem sua base de clientes e seu crediário
  // (o CODIGO se repete entre lojas — mesmo código = outra pessoa).
  // Vendedora vê SEMPRE só a própria loja; admin pode passar ?storeCode=
  // ou ?todasLojas=1.
  @Get('clientes-todos')
  async listAllClientes(
    @Req() req: any,
    @Query('storeCode') storeCodeOverride?: string,
    @Query('todasLojas') todasLojas?: string,
  ) {
    this.requireRole(req);
    const role = req?.user?.role;
    let storeCode: string | undefined;
    if (role === 'admin') {
      storeCode = todasLojas === '1' ? undefined : (storeCodeOverride || undefined);
    } else {
      storeCode = req?.user?.storeCode;
    }
    return this.svc.listAllClientesGiga(storeCode);
  }

  // ── Lista TUDO (todos clientes com parcelas em aberto) ──────────
  // KILL-SWITCH: desligado por padrão. Reativar setando env var
  //   CREDIARIO_BAIXA_TODAS_ENABLED=true
  // no Railway. A query é cara (varre tabela movimento de 700k+ linhas)
  // e estava saturando o pool MySQL Giga, derrubando o resto do sistema
  // (consulta estoque, PDV, etc). Quando reativado, garantir que tem
  // índice em (pago, vencimento) na tabela movimento.
  @Get('todas')
  async listAll(
    @Req() req: any,
    @Query('storeCode') storeCodeOverride?: string,
    @Query('todasLojas') todasLojas?: string,
  ) {
    this.requireRole(req);
    if (process.env.CREDIARIO_BAIXA_TODAS_ENABLED !== 'true') {
      return {
        parcelas: [],
        clientes: [],
        _disabled: true,
        _message:
          'Endpoint desligado pra proteger o servidor. Reative com CREDIARIO_BAIXA_TODAS_ENABLED=true.',
      };
    }
    let storeCode: string | undefined;
    if (todasLojas !== '1') {
      const role = req?.user?.role;
      if (role === 'admin') storeCode = storeCodeOverride || undefined;
      else storeCode = req?.user?.storeCode;
    }
    return this.svc.listAllOpenInstallments({ storeCode });
  }

  // ── Autocomplete cliente (rápido) ─────────────────────────────────
  // Mesmo kill-switch que /todas — protege contra saturação do pool MySQL
  @Get('clientes-autocomplete')
  async searchClientes(@Req() req: any, @Query('q') q: string) {
    this.requireRole(req);
    if (process.env.CREDIARIO_BAIXA_TODAS_ENABLED !== 'true') {
      return [];
    }
    // Vendedora busca só na base da própria loja (código repete entre lojas)
    const storeCode = req?.user?.role === 'admin' ? undefined : req?.user?.storeCode;
    return this.svc.searchClientes({ q: q || '', storeCode });
  }

  // ── Lista parcelas de 1 cliente específico ────────────────────────
  // Query LEVE — WHERE codCliente=X (com índice na tabela movimento por
  // cliente é instantâneo).
  //
  // ESCOPO POR LOJA (03/07): o codCliente se REPETE entre lojas — sem filtrar
  // a loja, o código X da loja da vendedora listava também as parcelas do
  // código X de OUTRA loja (outra pessoa!) e dava pra baixar parcela errada.
  // O recebimento em outra filial continua possível: a vendedora escolhe o
  // cliente DA LOJA DELE (admin passa ?storeCode=) — a identidade é sempre
  // (loja, codigo).
  @Get('parcelas')
  async listByCodCliente(
    @Req() req: any,
    @Query('codCliente') codCliente: string,
    @Query('storeCode') storeCodeOverride?: string,
  ) {
    this.requireRole(req);
    const role = req?.user?.role;
    const storeCode = role === 'admin'
      ? (storeCodeOverride || undefined)
      : (req?.user?.storeCode || undefined);
    return this.svc.listInstallmentsByCodCliente({ codCliente, storeCode });
  }

  // ── Busca cliente + parcelas em aberto ────────────────────────────

  @Get('cliente')
  async listOpenInstallments(
    @Req() req: any,
    @Query('busca') busca: string,
    @Query('storeCode') storeCodeOverride?: string,
    @Query('todasLojas') todasLojas?: string,
  ) {
    this.requireRole(req);
    if (process.env.CREDIARIO_BAIXA_TODAS_ENABLED !== 'true') {
      return [];
    }
    const role = req?.user?.role;
    let storeCode: string | undefined;
    if (todasLojas !== '1') {
      // Vendedora SEMPRE filtra pela própria loja. Admin pode escolher.
      if (role === 'admin') {
        storeCode = storeCodeOverride || undefined;
      } else {
        storeCode = req?.user?.storeCode;
      }
    }
    return this.svc.listOpenInstallmentsByCustomer({ busca, storeCode });
  }

  // ── Preview ──────────────────────────────────────────────────────

  @Post('preview')
  async preview(
    @Req() req: any,
    @Body() body: { parcelas: Array<{ registro: string; controle: string }> },
  ) {
    this.requireRole(req);
    return this.svc.previewBaixa({ parcelas: body?.parcelas || [] });
  }

  // ── Aplicar baixa (DINHEIRO) ─────────────────────────────────────

  @Post('dinheiro')
  async aplicarDinheiro(
    @Req() req: any,
    @Body()
    body: {
      parcelas: Array<{ registro: string; controle: string }>;
      storeCode?: string;
    },
  ) {
    this.requireRole(req);
    const { code, name } = this.resolveStore(req, body?.storeCode);
    return this.svc.applyBaixaDinheiro({
      parcelas: body?.parcelas || [],
      lojaCode: code,
      lojaName: name,
      userId: req?.user?.sub || req?.user?.id || null,
      userName: req?.user?.name || req?.user?.email || null,
    });
  }

  // ── Gerar PIX-LINK (cliente remoto — recebe URL pelo WhatsApp) ───
  // Mesmo fluxo do PIX presencial, mas com validade 24h pra dar tempo
  // do cliente abrir o link e pagar com calma.
  @Post('pix-link')
  async gerarPixLink(
    @Req() req: any,
    @Body()
    body: {
      parcelas: Array<{ registro: string; controle: string }>;
      storeCode?: string;
      customerName?: string;
      customerCpf?: string;
      customerEmail?: string;
      customerPhone?: string;
    },
  ) {
    this.requireRole(req);
    const { code, name } = this.resolveStore(req, body?.storeCode);
    const result = await this.svc.createPendingBaixaPix({
      parcelas: body?.parcelas || [],
      lojaCode: code,
      lojaName: name,
      userId: req?.user?.sub || req?.user?.id || null,
      userName: req?.user?.name || req?.user?.email || null,
      customerName: body?.customerName,
      customerCpf: body?.customerCpf,
      customerPhone: body?.customerPhone,
      customerEmail: body?.customerEmail,
      expiresInMinutes: 1440, // 24h pra link compartilhável
      origem: 'link', // alerta global mostra so essas baixas
    });
    return result;
  }

  // ── Aplicar baixa SPLIT (parte dinheiro + parte PIX) ─────────────────
  // Cliente paga UMA parte na hora em dinheiro e o resto via QR PIX.
  // Backend cria baixa pending → gera QR Pagar.me apenas pelo valorPix.
  // Quando PIX confirma, marca tudo como pago (incluindo dinheiro).
  @Post('split')
  async aplicarSplit(
    @Req() req: any,
    @Body()
    body: {
      parcelas: Array<{ registro: string; controle: string }>;
      valorDinheiro: number;
      valorPix: number;
      storeCode?: string;
      customerName?: string;
      customerCpf?: string;
      customerEmail?: string;
      customerPhone?: string;
    },
  ) {
    this.requireRole(req);
    const { code, name } = this.resolveStore(req, body?.storeCode);
    return this.svc.createPendingBaixaSplit({
      parcelas: body?.parcelas || [],
      valorDinheiro: Number(body?.valorDinheiro) || 0,
      valorPix: Number(body?.valorPix) || 0,
      lojaCode: code,
      lojaName: name,
      userId: req?.user?.sub || req?.user?.id || null,
      userName: req?.user?.name || req?.user?.email || null,
      customerName: body?.customerName,
      customerCpf: body?.customerCpf,
      customerPhone: body?.customerPhone,
      customerEmail: body?.customerEmail,
    });
  }

  // ── Aplicar baixa (PIX — gera Pagar.me) ──────────────────────────

  @Post('pix')
  async aplicarPix(
    @Req() req: any,
    @Body()
    body: {
      parcelas: Array<{ registro: string; controle: string }>;
      storeCode?: string;
      customerName?: string;
      customerCpf?: string;
      customerEmail?: string;
      customerPhone?: string;
    },
  ) {
    this.requireRole(req);
    const { code, name } = this.resolveStore(req, body?.storeCode);
    return this.svc.createPendingBaixaPix({
      parcelas: body?.parcelas || [],
      lojaCode: code,
      lojaName: name,
      userId: req?.user?.sub || req?.user?.id || null,
      userName: req?.user?.name || req?.user?.email || null,
      customerName: body?.customerName,
      customerCpf: body?.customerCpf,
      customerPhone: body?.customerPhone,
      customerEmail: body?.customerEmail,
      origem: 'presencial', // QR loja — vendedora ve o cliente pagar, sem alerta global
    });
  }

  // ── Status (polling) ─────────────────────────────────────────────

  @Get('status/:id')
  async status(@Req() req: any, @Param('id') id: string) {
    this.requireRole(req);
    return this.svc.getBaixaStatus(id);
  }

  // ── Histórico de baixas ──────────────────────────────────────────
  // GET /crediarios/baixa/historico?storeCode=X&dias=30&status=all
  // Lista baixas pagas/estornadas pra tela de auditoria.

  /**
   * GET /crediarios/baixa/recentes-pagas?since=ISO&storeCode=X
   * Polling pela tela de Recebimentos pra detectar pagamentos via webhook.
   */
  @Get('recentes-pagas')
  async getRecentesPagas(
    @Req() req: any,
    @Query('storeCode') storeCode?: string,
    @Query('since') since?: string,
  ) {
    this.requireRole(req);
    const lojaCode = (storeCode || req?.user?.storeCode || req?.user?.lojaCode || '').toString().trim() || undefined;
    return this.svc.listRecentlyPaid({ sinceIso: since, lojaCode });
  }

  @Get('historico')
  async getHistorico(
    @Req() req: any,
    @Query('storeCode') storeCode?: string,
    @Query('dias') dias?: string,
    @Query('status') statusQ?: string,
  ) {
    this.requireRole(req);
    // Resolve loja: prioriza query param, senão usa do JWT
    const lojaCode = (storeCode || req?.user?.storeCode || req?.user?.lojaCode || '').toString().trim() || undefined;
    const statusOk: 'paid' | 'canceled' | 'all' =
      statusQ === 'paid' || statusQ === 'canceled' ? statusQ : 'all';
    return this.svc.listHistorico({
      lojaCode,
      dias: dias ? Number(dias) : 30,
      status: statusOk,
    });
  }

  @Post(':id/estornar')
  async estornar(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { reason?: string },
  ) {
    this.requireRole(req);
    return this.svc.estornarBaixa({
      baixaId: id,
      userId: req?.user?.sub,
      userName: req?.user?.name,
      reason: body?.reason || undefined,
    });
  }

  // ── Detalhe (recibo) ─────────────────────────────────────────────

  @Get(':id')
  async detail(@Req() req: any, @Param('id') id: string) {
    this.requireRole(req);
    return this.svc.getBaixaDetail(id);
  }
}
