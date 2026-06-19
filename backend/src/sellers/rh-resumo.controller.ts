import { Controller, Get, UseGuards } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { startOfDayBR, startOfNextDayBR } from '../lib/date-br';

/**
 * /rh/resumo — dashboard do hub /retaguarda/rh.
 * Retorna 4 KPIs principais:
 *  - ponto batido hoje (%)
 *  - comissão pendente (R$ do mês corrente, fechamentos open)
 *  - aniversariantes esta semana
 *  - férias vencendo nos próximos 30 dias
 *  - total de funcionárias ativas
 *
 * Tudo em UMA chamada pra evitar 5 queries do frontend.
 */
@Controller('rh')
@UseGuards(JwtAuthGuard)
export class RhResumoController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('resumo')
  async resumo() {
    const today = startOfDayBR();
    const tomorrow = startOfNextDayBR();

    // Semana atual (segunda → domingo)
    const dow = today.getDay() || 7; // 1..7
    const monday = new Date(today);
    monday.setDate(today.getDate() - (dow - 1));
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);

    // 30 dias à frente
    const in30 = new Date(today);
    in30.setDate(in30.getDate() + 30);

    // ── 1. Total de funcionárias ATIVAS ──
    let totalAtivas: number | null = null;
    try {
      totalAtivas = await (this.prisma as any).seller.count({ where: { active: true } });
    } catch { /* schema sem seller? deixa null */ }

    // ── 2. Ponto batido hoje (%) ──
    let pontoBatidoHojePct: number | null = null;
    try {
      if (totalAtivas && totalAtivas > 0) {
        const batidasHoje = await (this.prisma as any).pontoRegistro?.findMany({
          where: { dia: { gte: today, lt: tomorrow } },
          select: { sellerId: true },
          distinct: ['sellerId'],
        }).catch(() => null);
        if (Array.isArray(batidasHoje)) {
          pontoBatidoHojePct = Math.round((batidasHoje.length / totalAtivas) * 100);
        }
      }
    } catch { /* sem schema ponto? null */ }

    // ── 3. Comissão pendente do mês corrente ──
    let comissaoPendenteMes: number | null = null;
    try {
      const inicioMes = new Date(today.getFullYear(), today.getMonth(), 1);
      const fimMes = new Date(today.getFullYear(), today.getMonth() + 1, 1);
      const fechamentos = await (this.prisma as any).commissionFechamento?.findMany({
        where: {
          status: { in: ['open', 'aberto'] },
          periodoInicio: { gte: inicioMes, lt: fimMes },
        },
        select: { totalComissao: true },
      }).catch(() => null);
      if (Array.isArray(fechamentos)) {
        comissaoPendenteMes = fechamentos.reduce(
          (s: number, f: any) => s + Number(f.totalComissao || 0),
          0,
        );
      }
    } catch { /* sem schema commission? null */ }

    // ── 4. Aniversariantes esta semana ──
    let aniversariantesSemana: number | null = null;
    try {
      // Compara MES+DIA ignorando ano (FILTER em JS porque MM-DD em Prisma é chato)
      const todasAtivas = await (this.prisma as any).seller.findMany({
        where: { active: true, birthDate: { not: null } },
        select: { birthDate: true },
      }).catch(() => []);
      if (Array.isArray(todasAtivas) && todasAtivas.length > 0) {
        const mmddSet = new Set<string>();
        for (let d = new Date(monday); d <= sunday; d.setDate(d.getDate() + 1)) {
          mmddSet.add(`${d.getMonth() + 1}-${d.getDate()}`);
        }
        aniversariantesSemana = todasAtivas.filter((s: any) => {
          if (!s.birthDate) return false;
          const b = new Date(s.birthDate);
          return mmddSet.has(`${b.getMonth() + 1}-${b.getDate()}`);
        }).length;
      } else if (Array.isArray(todasAtivas)) {
        aniversariantesSemana = 0;
      }
    } catch { /* null */ }

    // ── 5. Férias vencendo em 30 dias ──
    let feriasVencendo30d: number | null = null;
    try {
      const ferias = await (this.prisma as any).sellerFerias?.findMany({
        where: {
          dataLimite: { gte: today, lte: in30 },
          gozadoEm: null,
        },
        select: { id: true },
      }).catch(() => null);
      if (Array.isArray(ferias)) {
        feriasVencendo30d = ferias.length;
      }
    } catch { /* null */ }

    return {
      totalAtivas,
      pontoBatidoHojePct,
      comissaoPendenteMes,
      aniversariantesSemana,
      feriasVencendo30d,
    };
  }
}
