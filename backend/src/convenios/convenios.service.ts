import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * CONVÊNIO (sindicato) — "cartão" da loja conveniada (dono 21/07).
 *
 * Modelo: sindicato manda a lista de associados (nome + limite POR CICLO);
 * associado compra sem pagar (pgto 'convenio' no PDV, só na loja do convênio,
 * validando limite); a loja fecha a FATURA no dia combinado (consolidada, por
 * associado) e o sindicato paga. Fechou a fatura → limite renova.
 */
@Injectable()
export class ConveniosService {
  private readonly logger = new Logger(ConveniosService.name);
  constructor(private readonly prisma: PrismaService) {}

  private normLoja(s: string): string {
    return String(s || '').replace(/^LJ/i, '').padStart(2, '0');
  }

  // ── ADMIN: convênios ─────────────────────────────────────────────────────

  async listar() {
    const convenios: any[] = await (this.prisma as any).convenio.findMany({
      orderBy: { nome: 'asc' },
      include: { _count: { select: { membros: true } } },
    });
    // Resumo do ciclo aberto por convênio
    const out: any[] = [];
    for (const c of convenios) {
      const aberto = await (this.prisma as any).convenioCompra.aggregate({
        _sum: { valorCents: true }, _count: { _all: true },
        where: { convenioId: c.id, faturaId: null },
      });
      out.push({
        ...c,
        membros: c._count.membros,
        cicloAbertoCents: Number(aberto?._sum?.valorCents || 0),
        cicloAbertoQtd: Number(aberto?._count?._all || 0),
      });
    }
    return out;
  }

  async criar(input: { nome: string; storeCode: string; diaFechamento?: number; obs?: string }) {
    if (!String(input.nome || '').trim()) throw new BadRequestException('Nome obrigatório');
    if (!String(input.storeCode || '').trim()) throw new BadRequestException('Loja obrigatória');
    return (this.prisma as any).convenio.create({
      data: {
        nome: String(input.nome).trim().toUpperCase(),
        storeCode: this.normLoja(input.storeCode),
        diaFechamento: Math.min(31, Math.max(1, Number(input.diaFechamento) || 20)),
        obs: input.obs?.trim() || null,
      },
    });
  }

  async editar(id: string, patch: { nome?: string; diaFechamento?: number; ativo?: boolean; obs?: string }) {
    const data: any = {};
    if (patch.nome !== undefined) data.nome = String(patch.nome).trim().toUpperCase();
    if (patch.diaFechamento !== undefined) data.diaFechamento = Math.min(31, Math.max(1, Number(patch.diaFechamento) || 20));
    if (patch.ativo !== undefined) data.ativo = !!patch.ativo;
    if (patch.obs !== undefined) data.obs = patch.obs?.trim() || null;
    return (this.prisma as any).convenio.update({ where: { id }, data });
  }

  // ── ADMIN: membros (lista do sindicato) ──────────────────────────────────

  async membros(convenioId: string) {
    const membros: any[] = await (this.prisma as any).convenioMembro.findMany({
      where: { convenioId },
      orderBy: { nome: 'asc' },
    });
    // Usado no ciclo aberto por membro (pra tela mostrar disponível)
    const abertos: any[] = await (this.prisma as any).convenioCompra.groupBy({
      by: ['membroId'], _sum: { valorCents: true },
      where: { convenioId, faturaId: null },
    });
    const usado = new Map(abertos.map((a) => [a.membroId, Number(a._sum?.valorCents || 0)]));
    return membros.map((m) => ({
      ...m,
      usadoCicloCents: usado.get(m.id) || 0,
      disponivelCents: Math.max(0, m.limiteCents - (usado.get(m.id) || 0)),
    }));
  }

  /** Adiciona 1..N membros (a lista colada do sindicato: [{nome, matricula?, limite}] ). */
  async addMembros(convenioId: string, membros: Array<{ nome: string; matricula?: string; limiteReais?: number }>) {
    const conv = await (this.prisma as any).convenio.findUnique({ where: { id: convenioId } });
    if (!conv) throw new NotFoundException('Convênio não encontrado');
    const validos = (membros || [])
      .map((m) => ({
        convenioId,
        nome: String(m.nome || '').trim().toUpperCase(),
        matricula: m.matricula ? String(m.matricula).trim() : null,
        limiteCents: Math.max(0, Math.round((Number(m.limiteReais) || 0) * 100)),
      }))
      .filter((m) => m.nome);
    if (!validos.length) throw new BadRequestException('Nenhum membro válido');
    await (this.prisma as any).convenioMembro.createMany({ data: validos });
    return { ok: true, adicionados: validos.length };
  }

  async editarMembro(membroId: string, patch: { nome?: string; matricula?: string; limiteReais?: number; ativo?: boolean }) {
    const data: any = {};
    if (patch.nome !== undefined) data.nome = String(patch.nome).trim().toUpperCase();
    if (patch.matricula !== undefined) data.matricula = patch.matricula?.trim() || null;
    if (patch.limiteReais !== undefined) data.limiteCents = Math.max(0, Math.round((Number(patch.limiteReais) || 0) * 100));
    if (patch.ativo !== undefined) data.ativo = !!patch.ativo;
    return (this.prisma as any).convenioMembro.update({ where: { id: membroId }, data });
  }

  // ── PDV: convênio ativo da loja + busca de membro com limite ─────────────

  async ativoPorLoja(storeCode: string) {
    const loja = this.normLoja(storeCode);
    return (this.prisma as any).convenio.findFirst({
      where: { storeCode: loja, ativo: true },
      select: { id: true, nome: true, storeCode: true, diaFechamento: true },
    });
  }

  async buscarMembros(convenioId: string, q?: string) {
    const term = String(q || '').trim();
    const membros: any[] = await (this.prisma as any).convenioMembro.findMany({
      where: {
        convenioId, ativo: true,
        ...(term ? {
          OR: [
            { nome: { contains: term, mode: 'insensitive' } },
            { matricula: { contains: term } },
          ],
        } : {}),
      },
      orderBy: { nome: 'asc' },
      take: 20,
    });
    const abertos: any[] = await (this.prisma as any).convenioCompra.groupBy({
      by: ['membroId'], _sum: { valorCents: true },
      where: { convenioId, faturaId: null, membroId: { in: membros.map((m) => m.id) } },
    });
    const usado = new Map(abertos.map((a) => [a.membroId, Number(a._sum?.valorCents || 0)]));
    return membros.map((m) => ({
      id: m.id, nome: m.nome, matricula: m.matricula,
      limiteCents: m.limiteCents,
      disponivelCents: Math.max(0, m.limiteCents - (usado.get(m.id) || 0)),
    }));
  }

  /**
   * Acha o associado pelo nome ou CRIA na hora (dono 21/07: o sindicato NÃO
   * manda lista — a conferência do limite é ONLINE no sistema do sindicato).
   * Associado criado assim entra com limite 0 = "sem controle de limite no
   * Flow" (validarCompra não trava; só registra pra fatura).
   */
  async obterOuCriarMembro(convenioId: string, nome: string, matricula?: string | null) {
    const nomeNorm = String(nome || '').trim().toUpperCase().replace(/\s+/g, ' ');
    if (!nomeNorm) throw new BadRequestException('Convênio: informe o nome do associado');
    const existente = await (this.prisma as any).convenioMembro.findFirst({
      where: { convenioId, nome: { equals: nomeNorm, mode: 'insensitive' } },
    });
    if (existente) {
      if (!existente.ativo) throw new BadRequestException(`Associado ${existente.nome} está INATIVO no convênio`);
      return existente;
    }
    return (this.prisma as any).convenioMembro.create({
      data: { convenioId, nome: nomeNorm, matricula: String(matricula || '').trim() || null, limiteCents: 0 },
    });
  }

  /** Validação usada pelo addPayment do PDV. Lança se não puder. */
  async validarCompra(input: { convenioId: string; membroId: string; storeCode: string; valorCents: number }) {
    const conv = await (this.prisma as any).convenio.findUnique({ where: { id: input.convenioId } });
    if (!conv || !conv.ativo) throw new BadRequestException('Convênio inválido ou inativo');
    if (conv.storeCode !== this.normLoja(input.storeCode)) {
      throw new BadRequestException(`Convênio ${conv.nome} só vale na loja ${conv.storeCode}`);
    }
    const membro = await (this.prisma as any).convenioMembro.findUnique({ where: { id: input.membroId } });
    if (!membro || membro.convenioId !== conv.id) throw new BadRequestException('Associado não encontrado no convênio');
    if (!membro.ativo) throw new BadRequestException(`Associado ${membro.nome} está INATIVO no convênio`);
    // Limite 0 = sem controle de limite no Flow — o caixa confere ONLINE no
    // sistema do sindicato. Só registra (fatura), não trava.
    if (!membro.limiteCents || membro.limiteCents <= 0) {
      return { conv, membro, disponivel: null };
    }
    const aberto = await (this.prisma as any).convenioCompra.aggregate({
      _sum: { valorCents: true },
      where: { convenioId: conv.id, membroId: membro.id, faturaId: null },
    });
    const usado = Number(aberto?._sum?.valorCents || 0);
    const disponivel = membro.limiteCents - usado;
    if (input.valorCents > disponivel) {
      throw new BadRequestException(
        `Limite do associado insuficiente: disponível R$ ${(disponivel / 100).toFixed(2)} ` +
        `(limite R$ ${(membro.limiteCents / 100).toFixed(2)}, já usado R$ ${(usado / 100).toFixed(2)} no ciclo)`,
      );
    }
    return { conv, membro, disponivel };
  }

  /** Registra a compra (chamado no FINALIZE da venda — idempotente por saleId+membro). */
  async registrarCompra(input: { convenioId: string; membroId: string; storeCode: string; saleId: string; valorCents: number }) {
    const jaTem = await (this.prisma as any).convenioCompra.findFirst({
      where: { saleId: input.saleId, membroId: input.membroId },
      select: { id: true },
    });
    if (jaTem) return jaTem; // idempotente (retry do finalize não duplica)
    return (this.prisma as any).convenioCompra.create({
      data: {
        convenioId: input.convenioId,
        membroId: input.membroId,
        storeCode: this.normLoja(input.storeCode),
        saleId: input.saleId,
        valorCents: Math.round(input.valorCents),
      },
    });
  }

  // ── ADMIN: fechamento / faturas ──────────────────────────────────────────

  /** Fecha a fatura do ciclo: pega TODAS as compras em aberto até `ate`. */
  async fecharFatura(convenioId: string, input: { de?: string; ate?: string; obs?: string }) {
    const conv = await (this.prisma as any).convenio.findUnique({ where: { id: convenioId } });
    if (!conv) throw new NotFoundException('Convênio não encontrado');
    const ate = input.ate ? new Date(`${input.ate}T23:59:59.999Z`) : new Date();
    const de = input.de ? new Date(`${input.de}T00:00:00.000Z`) : new Date(0);
    const compras: any[] = await (this.prisma as any).convenioCompra.findMany({
      where: { convenioId, faturaId: null, createdAt: { gte: de, lte: ate } },
      select: { id: true, valorCents: true },
    });
    if (!compras.length) throw new BadRequestException('Nenhuma compra em aberto no período');
    const totalCents = compras.reduce((s, c) => s + c.valorCents, 0);
    const fatura = await (this.prisma as any).$transaction(async (tx: any) => {
      const f = await tx.convenioFatura.create({
        data: { convenioId, de, ate, totalCents, obs: input.obs?.trim() || null },
      });
      await tx.convenioCompra.updateMany({
        where: { id: { in: compras.map((c) => c.id) } },
        data: { faturaId: f.id },
      });
      return f;
    });
    this.logger.log(`[convenio] fatura fechada: ${conv.nome} · ${compras.length} compras · R$ ${(totalCents / 100).toFixed(2)}`);
    return { ok: true, fatura, compras: compras.length, totalCents };
  }

  async faturas(convenioId: string) {
    return (this.prisma as any).convenioFatura.findMany({
      where: { convenioId },
      orderBy: { geradaEm: 'desc' },
      take: 36,
    });
  }

  /** Detalhe da fatura POR ASSOCIADO (pra imprimir/mandar pro sindicato). */
  async faturaDetalhe(faturaId: string) {
    const fatura = await (this.prisma as any).convenioFatura.findUnique({
      where: { id: faturaId },
      include: { convenio: { select: { nome: true, storeCode: true } } },
    });
    if (!fatura) throw new NotFoundException('Fatura não encontrada');
    const compras: any[] = await (this.prisma as any).convenioCompra.findMany({
      where: { faturaId },
      include: { membro: { select: { nome: true, matricula: true } } },
      orderBy: { createdAt: 'asc' },
    });
    const porMembro = new Map<string, { nome: string; matricula: string | null; qtd: number; totalCents: number; compras: any[] }>();
    for (const c of compras) {
      let m = porMembro.get(c.membroId);
      if (!m) porMembro.set(c.membroId, (m = { nome: c.membro?.nome || '?', matricula: c.membro?.matricula || null, qtd: 0, totalCents: 0, compras: [] }));
      m.qtd++; m.totalCents += c.valorCents;
      m.compras.push({ data: c.createdAt, valorCents: c.valorCents, saleId: c.saleId });
    }
    return {
      fatura,
      membros: Array.from(porMembro.values()).sort((a, b) => a.nome.localeCompare(b.nome)),
    };
  }

  async marcarPaga(faturaId: string) {
    return (this.prisma as any).convenioFatura.update({
      where: { id: faturaId },
      data: { status: 'paga', pagaEm: new Date() },
    });
  }
}
