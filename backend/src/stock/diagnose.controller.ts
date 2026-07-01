import { Controller, Get, Query, UnauthorizedException } from '@nestjs/common';
import { ErpService } from '../erp/erp.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * DiagnoseController — endpoints PÚBLICOS de diagnóstico (sem JWT guard).
 *
 * ATENÇÃO: protegidos só por um "secret" na query string. Usados pra investigar
 * o schema do Gigasistemas sem precisar lidar com CORS/JWT do frontend.
 * Depois que o diagnóstico é feito, esses endpoints podem ser removidos.
 *
 * O secret vale via env var DIAGNOSE_SECRET. Se NÃO configurada, os endpoints
 * ficam DESATIVADOS (fail-closed) — sem default hardcoded.
 */
@Controller('diagnose')
export class DiagnoseController {
  constructor(
    private readonly erp: ErpService,
    private readonly prisma: PrismaService,
  ) {}

  private checkSecret(secret: string | undefined) {
    // Fail-closed: sem DIAGNOSE_SECRET configurado, nega tudo (sem default).
    const expected = process.env.DIAGNOSE_SECRET;
    if (!expected || !secret || secret !== expected) {
      throw new UnauthorizedException('secret inválido');
    }
  }

  /**
   * GET /diagnose/giga-tables?secret=XXX&search=credi
   *
   * Retorna tabelas do Gigasistemas21 que batem com o LIKE, com schema + amostra.
   * Sem autenticação JWT — protegido só pelo secret.
   */
  @Get('giga-tables')
  async gigaTables(@Query('secret') secret: string, @Query('search') search: string) {
    this.checkSecret(secret);
    const pattern = (search || '').trim() || 'credi';
    return this.erp.listTablesLike(pattern);
  }

  /**
   * GET /diagnose/giga-crediario?secret=XXX
   *
   * Faz 3 buscas de uma vez (credi, parcel, cobr) pra diagnóstico completo
   * de tabelas relacionadas a crediário/cobrança. Retorna 1 payload só.
   */
  @Get('giga-crediario')
  async gigaCrediario(@Query('secret') secret: string) {
    this.checkSecret(secret);
    const [credi, parcel, cobr, receb] = await Promise.all([
      this.erp.listTablesLike('credi'),
      this.erp.listTablesLike('parcel'),
      this.erp.listTablesLike('cobr'),
      this.erp.listTablesLike('receb'),
    ]);
    return {
      credi,
      parcel,
      cobr,
      receb,
    };
  }

  /**
   * GET /diagnose/pilot-logs?secret=XXX&limit=100
   *
   * Retorna últimos N logs do Piloto Automático — pra diagnosticar
   * por que o Piloto pulou pedidos. Agrupa por `event` pra mostrar
   * contagem de cada tipo (sent, skip, error) + últimos detalhes.
   */
  @Get('pilot-logs')
  async pilotLogs(@Query('secret') secret: string, @Query('limit') limit?: string) {
    this.checkSecret(secret);
    const n = Math.min(Math.max(Number(limit) || 100, 10), 500);
    const rows = await this.prisma.integrationLog.findMany({
      where: { source: 'pilot' },
      orderBy: { createdAt: 'desc' },
      take: n,
    });

    // Agrupa por event + reason pra resumo
    const byEvent: Record<string, number> = {};
    const byReason: Record<string, number> = {};
    for (const r of rows) {
      byEvent[r.event] = (byEvent[r.event] || 0) + 1;
      try {
        const p = r.payload ? JSON.parse(r.payload) : {};
        if (p?.reason) byReason[p.reason] = (byReason[p.reason] || 0) + 1;
      } catch {}
    }

    return {
      total: rows.length,
      summary: {
        byEvent,
        byReason,
      },
      recent: rows.slice(0, 30).map((r) => ({
        id: r.id,
        event: r.event,
        status: r.status,
        createdAt: r.createdAt,
        payload: (() => {
          try { return r.payload ? JSON.parse(r.payload) : null; } catch { return r.payload; }
        })(),
      })),
    };
  }

  /**
   * GET /diagnose/nfce-rejeitadas?secret=XXX
   * Últimas vendas com NFC-e rejeitada: pagamentos reais (method+valor) + a
   * seção <pag> do XML emitido. Pra diagnosticar rejeições de forma de pagamento
   * (ex: cStat 391 cartão) sem precisar de login.
   */
  @Get('nfce-rejeitadas')
  async nfceRejeitadas(@Query('k') k: string) {
    // Exige DIAGNOSE_SECRET (fail-closed), igual aos demais endpoints deste
    // controller. Antes usava chave fixa hardcoded ('nfce391diag2026'), que
    // ficava versionada no repo e expunha vendas + XML de pagamento sem login.
    this.checkSecret(k);
    const sales = await (this.prisma as any).pdvSale.findMany({
      where: { nfceStatus: { in: ['rejected', 'error'] } },
      include: { payments: { select: { method: true, valor: true } } },
      orderBy: { createdAt: 'desc' },
      take: 6,
    });
    return (sales as any[]).map((s) => {
      const xml = String(s.nfceXml || '');
      const pag = (xml.match(/<pag>[\s\S]*?<\/pag>/) || [''])[0];
      return {
        num: s.nfceNumber,
        serie: s.nfceSerie,
        status: s.nfceStatus,
        motivo: s.nfceMotivo,
        total: s.total,
        paymentMethod: s.paymentMethod,
        payments: s.payments,
        pagXml: pag,
        xmlLen: xml.length,
      };
    });
  }
}
