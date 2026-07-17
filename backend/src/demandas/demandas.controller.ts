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

  // ── TAGS (catálogo do dono: RH, CONTAS A PAGAR, PDV…) — rotas ANTES de :id ──
  private static readonly TAG_CORES = [
    'amber', 'sky', 'emerald', 'rose', 'violet', 'orange', 'teal', 'pink', 'slate', 'lime',
  ];

  @Get('tags')
  async tags(@Req() req: any) {
    this.requireAdmin(req);
    return (this.prisma as any).demandaTag.findMany({ orderBy: { nome: 'asc' } });
  }

  @Post('tags')
  async criarTag(@Req() req: any, @Body() body: { nome?: string }) {
    this.requireAdmin(req);
    const nome = String(body?.nome || '').trim().toUpperCase().slice(0, 30);
    if (!nome) throw new BadRequestException('Nome da tag vazio');
    const existente = await (this.prisma as any).demandaTag.findUnique({ where: { nome } });
    if (existente) return existente;
    const qtd = await (this.prisma as any).demandaTag.count();
    return (this.prisma as any).demandaTag.create({
      data: { nome, cor: DemandasController.TAG_CORES[qtd % DemandasController.TAG_CORES.length] },
    });
  }

  @Delete('tags/:id')
  async removerTag(@Req() req: any, @Param('id') id: string) {
    this.requireAdmin(req);
    const tag = await (this.prisma as any).demandaTag.delete({ where: { id } });
    // tira o nome das demandas que a usavam (best-effort)
    const usando: any[] = await (this.prisma as any).demanda.findMany({
      where: { tags: { has: tag.nome } }, select: { id: true, tags: true },
    });
    for (const d of usando) {
      await (this.prisma as any).demanda.update({
        where: { id: d.id },
        data: { tags: (d.tags || []).filter((t: string) => t !== tag.nome) },
      }).catch(() => null);
    }
    return { ok: true };
  }

  @Get()
  async list(
    @Req() req: any,
    @Query('status') status?: string,
    @Query('criticidade') criticidade?: string,
    @Query('tag') tag?: string,
  ) {
    this.requireAdmin(req);
    const where: any = {};
    if (status === 'aberta' || status === 'concluida') where.status = status;
    if (criticidade && CRITICIDADES.includes(criticidade as any)) where.criticidade = criticidade;
    if (tag) where.tags = { has: String(tag).toUpperCase() };
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
      tags?: string[];
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
        tags: (body?.tags || []).map((t) => String(t).trim().toUpperCase().slice(0, 30)).filter(Boolean).slice(0, 10),
        userName: req?.user?.name || req?.user?.email || null,
        imagens: imagens.length ? { create: imagens } : undefined,
      },
    });
  }

  @Patch(':id')
  async update(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { status?: string; prompt?: string; titulo?: string; criticidade?: string; tags?: string[] },
  ) {
    this.requireAdmin(req);
    const data: any = {};
    if (body?.status === 'concluida') { data.status = 'concluida'; data.finishedAt = new Date(); }
    if (body?.status === 'aberta') { data.status = 'aberta'; data.finishedAt = null; }
    if (body?.prompt !== undefined) data.prompt = String(body.prompt).trim();
    if (body?.titulo !== undefined) data.titulo = String(body.titulo).trim().slice(0, 120) || null;
    if (body?.criticidade && CRITICIDADES.includes(body.criticidade as any)) data.criticidade = body.criticidade;
    if (Array.isArray(body?.tags)) data.tags = body!.tags!.map((t) => String(t).trim().toUpperCase().slice(0, 30)).filter(Boolean).slice(0, 10);
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
