import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { PrismaService } from '../prisma/prisma.service';

const CRITICIDADES = ['URGENTE', 'IMPORTANTE', 'MELHORIA'] as const;
const RANK: Record<string, number> = { URGENTE: 0, IMPORTANTE: 1, MELHORIA: 2 };

/**
 * DEMANDAS — backlog do dono na aba Gestão (15/07). Prompt + prints colados
 * (base64 no Postgres), criticidade URGENTE/IMPORTANTE/MELHORIA, datas de
 * criação e finalização. Só admin.
 */
@Controller('demandas')
@UseGuards(JwtAuthGuard)
export class DemandasController {
  constructor(private readonly prisma: PrismaService) {}

  private requireAdmin(req: any) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
  }

  @Get()
  async list(@Req() req: any, @Query('status') status?: string, @Query('criticidade') criticidade?: string) {
    this.requireAdmin(req);
    const where: any = {};
    if (status === 'aberta' || status === 'concluida') where.status = status;
    if (criticidade && CRITICIDADES.includes(criticidade as any)) where.criticidade = criticidade;
    const rows: any[] = await (this.prisma as any).demanda.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { imagens: { select: { id: true } } },
    });
    // Abertas primeiro, depois por criticidade (urgente no topo), depois recentes
    rows.sort((a, b) =>
      (a.status === 'concluida' ? 1 : 0) - (b.status === 'concluida' ? 1 : 0) ||
      (RANK[a.criticidade] ?? 9) - (RANK[b.criticidade] ?? 9) ||
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    return rows.map((d) => ({ ...d, imagens: undefined, nImagens: d.imagens.length }));
  }

  @Get(':id')
  async one(@Req() req: any, @Param('id') id: string) {
    this.requireAdmin(req);
    return (this.prisma as any).demanda.findUnique({ where: { id }, include: { imagens: true } });
  }

  @Post()
  async create(
    @Req() req: any,
    @Body() body: {
      titulo?: string;
      prompt?: string;
      criticidade?: string;
      imagens?: Array<{ mime: string; dataB64: string }>;
    },
  ) {
    this.requireAdmin(req);
    const prompt = String(body?.prompt || '').trim();
    if (!prompt) throw new BadRequestException('Escreva a demanda (prompt)');
    const criticidade = CRITICIDADES.includes(body?.criticidade as any) ? body!.criticidade! : 'IMPORTANTE';
    const imagens = (body?.imagens || [])
      .filter((i) => i?.dataB64 && /^image\//.test(String(i?.mime || '')))
      .slice(0, 10)
      .map((i) => ({ mime: String(i.mime).slice(0, 40), dataB64: String(i.dataB64).slice(0, 4_000_000) }));
    return (this.prisma as any).demanda.create({
      data: {
        titulo: String(body?.titulo || '').trim().slice(0, 120) || null,
        prompt,
        criticidade,
        userName: req?.user?.name || req?.user?.email || null,
        imagens: imagens.length ? { create: imagens } : undefined,
      },
    });
  }

  @Patch(':id')
  async update(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { status?: string; prompt?: string; titulo?: string; criticidade?: string },
  ) {
    this.requireAdmin(req);
    const data: any = {};
    if (body?.status === 'concluida') { data.status = 'concluida'; data.finishedAt = new Date(); }
    if (body?.status === 'aberta') { data.status = 'aberta'; data.finishedAt = null; }
    if (body?.prompt !== undefined) data.prompt = String(body.prompt).trim();
    if (body?.titulo !== undefined) data.titulo = String(body.titulo).trim().slice(0, 120) || null;
    if (body?.criticidade && CRITICIDADES.includes(body.criticidade as any)) data.criticidade = body.criticidade;
    if (!Object.keys(data).length) throw new BadRequestException('Nada pra atualizar');
    return (this.prisma as any).demanda.update({ where: { id }, data });
  }

  @Delete(':id')
  async remove(@Req() req: any, @Param('id') id: string) {
    this.requireAdmin(req);
    await (this.prisma as any).demanda.delete({ where: { id } });
    return { ok: true };
  }
}
