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
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { PrismaService } from '../prisma/prisma.service';
import { CupomService } from './cupom.service';
import { LojaPagamentoReconcileService } from './loja-pagamento-reconcile.service';

/**
 * RETAGUARDA DO SITE — conciliação financeira e cupons.
 *
 * Duas coisas que até 06/08/2026 só existiam em código ou em lugar nenhum:
 *
 *  - **Conciliação** (item 12): bate pago no gateway × pago no Flow. O cron
 *    roda todo dia 07h05 e grita no log; aqui é a mesma conta sob demanda,
 *    com o período que quem está conferindo quiser.
 *  - **Cupons** (itens 3 e 55): a regra de desconto era um array no código do
 *    e-commerce — criar cupom de campanha exigia deploy. Agora é cadastro.
 *
 * Filtro de período no padrão da casa: **De/Até** (`?de=&ate=`, YYYY-MM-DD),
 * nunca dropdown de períodos fixos.
 */
@Controller('admin/loja')
@UseGuards(JwtAuthGuard)
export class LojaAdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cupons: CupomService,
    private readonly reconcile: LojaPagamentoReconcileService,
  ) {}

  private exigirAdmin(req: any): string {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'master') throw new ForbiddenException('Apenas admin/master');
    return String(req?.user?.name || req?.user?.username || 'admin');
  }

  /** `2026-08-06` → Date local no início do dia. Vazio → fallback. */
  private dia(v: any, fallback: Date): Date {
    const s = String(v || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return fallback;
    const [a, m, d] = s.split('-').map(Number);
    return new Date(a, m - 1, d, 0, 0, 0, 0);
  }

  /* ────────────────────────── CONCILIAÇÃO ──────────────────────────────── */

  /**
   * GET /admin/loja/conciliacao?de=2026-08-01&ate=2026-08-06
   *
   * Sem parâmetro, olha ONTEM — é a pergunta de quem abre a tela de manhã.
   * `ate` é INCLUSIVO (a tela pede "até dia 6" e espera o dia 6 dentro).
   */
  @Get('conciliacao')
  async conciliacao(@Req() req: any, @Query('de') de?: string, @Query('ate') ate?: string) {
    this.exigirAdmin(req);

    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);
    const inicio = this.dia(de, new Date(hoje.getTime() - 24 * 3600_000));
    const fimDia = this.dia(ate, new Date(hoje.getTime() - 24 * 3600_000));
    const fim = new Date(fimDia.getTime() + 24 * 3600_000); // exclusivo no filtro

    return { ok: true, ...(await this.reconcile.conciliar(inicio, fim)) };
  }

  /* ──────────────────────────── CUPONS ─────────────────────────────────── */

  @Get('cupons')
  async listarCupons(@Req() req: any) {
    this.exigirAdmin(req);
    const itens = await (this.prisma as any).siteCupom
      .findMany({ orderBy: [{ ativo: 'desc' }, { createdAt: 'desc' }] })
      .catch(() => []);
    return { ok: true, itens };
  }

  /**
   * POST /admin/loja/cupons — cria ou atualiza (o `code` é a chave).
   *
   * O código é normalizado (MAIÚSCULO, sem espaço) antes de gravar: a cliente
   * digita "bemvinda10" e tem que funcionar.
   */
  @Post('cupons')
  async salvarCupom(@Req() req: any, @Body() body: any) {
    const quem = this.exigirAdmin(req);

    const code = String(body?.code || '').trim().toUpperCase().replace(/\s+/g, '');
    if (!code) return { ok: false, error: 'Informe o código do cupom.' };
    if (code.length > 30) return { ok: false, error: 'Código muito longo (máximo 30 caracteres).' };

    const tipo = ['percent', 'fixed', 'shipping'].includes(body?.tipo) ? body.tipo : 'percent';
    const valor = Number(body?.valor) || 0;
    if (tipo === 'percent' && (valor <= 0 || valor > 90)) {
      return { ok: false, error: 'Percentual precisa ficar entre 1 e 90.' };
    }
    if (tipo === 'fixed' && valor <= 0) {
      return { ok: false, error: 'Valor do desconto precisa ser maior que zero.' };
    }

    const dados = {
      label: String(body?.label || code).trim().slice(0, 80),
      tipo,
      valor,
      minSubtotal: body?.minSubtotal == null || body.minSubtotal === '' ? null : Number(body.minSubtotal),
      primeiraCompra: !!body?.primeiraCompra,
      categorias: String(body?.categorias || '').trim().toLowerCase().slice(0, 300) || null,
      inicioEm: body?.inicioEm ? new Date(body.inicioEm) : null,
      fimEm: body?.fimEm ? new Date(body.fimEm) : null,
      usoMaximo: body?.usoMaximo == null || body.usoMaximo === '' ? null : Number(body.usoMaximo),
      ativo: body?.ativo === undefined ? true : !!body.ativo,
      atualizadoPor: quem,
    };

    const salvo = await (this.prisma as any).siteCupom.upsert({
      where: { code },
      update: dados,
      create: { code, ...dados },
    });

    // Sem isto o cupom novo só valeria depois do TTL — e quem acabou de criar
    // vai testar na hora.
    this.cupons.invalidarCache();
    return { ok: true, cupom: salvo };
  }

  @Delete('cupons/:code')
  async removerCupom(@Req() req: any, @Param('code') code: string) {
    this.exigirAdmin(req);
    const c = String(code || '').trim().toUpperCase();
    /**
     * DESATIVA, não apaga. O cupom já usado é a explicação de por que aquele
     * pedido saiu mais barato — apagar a linha deixaria a conciliação sem
     * resposta seis meses depois.
     */
    await (this.prisma as any).siteCupom
      .update({ where: { code: c }, data: { ativo: false } })
      .catch(() => undefined);
    this.cupons.invalidarCache();
    return { ok: true };
  }
}
