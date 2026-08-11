import { Body, Controller, ForbiddenException, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { PrismaService } from '../prisma/prisma.service';

/**
 * POST /telemetria/pagina — o beacon que o layout do CRM dispara a cada troca
 * de rota. GET /telemetria/paginas — o relatório (admin).
 *
 * Decisões:
 * · Fire-and-forget de verdade: NUNCA lança. Telemetria que quebra tela é
 *   pior que não ter telemetria — qualquer erro vira 204 do mesmo jeito.
 * · A rota chega NORMALIZADA do front (ids viram [id]) e é revalidada aqui:
 *   uuid/número que escapar não pode virar linha própria, senão a tabela
 *   cresce uma linha por pedido aberto.
 * · Sem tabela de eventos: um upsert por rota. A pergunta é "última vez e
 *   quantas", não trilha de auditoria.
 */
@Controller('telemetria')
@UseGuards(JwtAuthGuard)
export class TelemetriaController {
  constructor(private readonly prisma: PrismaService) {}

  @Post('pagina')
  @HttpCode(204)
  async registrar(@Req() req: any, @Body() body: { path?: string }) {
    try {
      const path = this.normalizar(body?.path);
      if (!path) return;
      await (this.prisma as any).pageAccess.upsert({
        where: { path },
        create: {
          path,
          hits: 1,
          lastAt: new Date(),
          lastRole: String(req?.user?.role || '') || null,
          lastStore: String(req?.user?.storeCode || '') || null,
        },
        update: {
          hits: { increment: 1 },
          lastAt: new Date(),
          lastRole: String(req?.user?.role || '') || null,
          lastStore: String(req?.user?.storeCode || '') || null,
        },
      });
    } catch {
      /* telemetria nunca propaga erro */
    }
  }

  @Get('paginas')
  async listar(@Req() req: any) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
    return (this.prisma as any).pageAccess.findMany({ orderBy: { lastAt: 'desc' } });
  }

  /** `/pedidos/3f2a.../etiquetas` → `/pedidos/[id]/etiquetas`. */
  private normalizar(raw?: string): string | null {
    let p = String(raw || '').trim();
    if (!p.startsWith('/') || p.length > 200) return null;
    p = p.split('?')[0].split('#')[0];
    p = p
      .split('/')
      .map((seg) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg) || /^\d{2,}$/.test(seg)
          ? '[id]'
          : seg,
      )
      .join('/');
    return p.slice(0, 160) || null;
  }
}
