import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Operação do Contas a Pagar 100% Flow (Fase 2 — telas do mockup aprovado
 * 11/07). Regras herdadas do dossiê (docs/GIGA-CONTAS-DESCOBERTA.md):
 *  - busca por QUALQUER parte (fornecedor, funcionária, NF, obs, banco, valor, nº);
 *  - filtro De/Até (convenção do dono) + loja + espécie + status + em mãos;
 *  - baixa pede JUROS e DESCONTO (P3);
 *  - espécies RESTRITAS (RH/VALE/SALARIO/COMISSAO) só pra autorizadas —
 *    v1: módulo inteiro é admin/master (matriz), o filtro fica pronto;
 *  - toda alteração vira ContaPagarLog (campo, antes → depois, quem);
 *  - excluir = soft delete.
 */

export interface ListFilters {
  search?: string;
  de?: string;   // YYYY-MM-DD (vencimento)
  ate?: string;
  lojaCode?: string;
  especieId?: string;
  status?: 'pendentes' | 'pagas' | 'todas';
  emMaos?: boolean;
  incluirRestritas?: boolean;
  page?: number;
  perPage?: number;
}

const CAMPOS_EDITAVEIS = new Set([
  'lojaCode', 'fornecedorNome', 'fornecedorGigaCodigo', 'sellerId', 'sellerNome', 'sellerCpf',
  'beneficiarioTipo', 'especieId', 'notaFiscal', 'banco', 'cheque', 'emissao', 'vencimento',
  'valorCents', 'observacao', 'emMaos',
]);

@Injectable()
export class ContasPagarService {
  private readonly logger = new Logger(ContasPagarService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── helpers ────────────────────────────────────────────────────────────────
  private dia(d = new Date()): Date {
    // Datas do módulo são @db.Date — compara sempre no "dia" UTC.
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  }

  private async log(contaId: string, campo: string, antigo: any, novo: any, usuario?: string, origem = 'tela') {
    await (this.prisma as any).contaPagarLog.create({
      data: {
        contaId,
        campo,
        valorAntigo: antigo == null ? null : String(antigo).slice(0, 300),
        valorNovo: novo == null ? null : String(novo).slice(0, 300),
        usuario: usuario || null,
        origem,
      },
    });
  }

  private async especiesRestritasIds(): Promise<Set<string>> {
    const rows: any[] = await (this.prisma as any).especieConta.findMany({ where: { restrita: true }, select: { id: true } });
    return new Set(rows.map((r) => r.id));
  }

  // ── catálogos/opções ──────────────────────────────────────────────────────
  especies() {
    return (this.prisma as any).especieConta.findMany({ orderBy: { nome: 'asc' } });
  }

  async lojas() {
    const [distinctRaw, stores] = await Promise.all([
      this.prisma.$queryRawUnsafe(`SELECT DISTINCT loja_code AS code FROM conta_pagar WHERE deleted_at IS NULL ORDER BY 1`),
      (this.prisma as any).store.findMany({ select: { code: true, name: true } }),
    ]);
    const distinct = distinctRaw as any[];
    const nameByCode = new Map<string, string>(stores.map((s) => [String(s.code), s.name]));
    return distinct.map((d) => ({
      code: String(d.code),
      nome: nameByCode.get(String(d.code)) || `LOJA ${d.code} — HISTÓRICO`,
    }));
  }

  fornecedoresOptions(q?: string) {
    const term = String(q || '').trim();
    return (this.prisma as any).wincredFornecedor.findMany({
      where: term
        ? {
            OR: [
              { razaoSocial: { contains: term, mode: 'insensitive' } },
              { fantasia: { contains: term, mode: 'insensitive' } },
              { cnpj: { contains: term } },
            ],
          }
        : {},
      select: { codigo: true, razaoSocial: true, fantasia: true, cnpj: true },
      orderBy: { razaoSocial: 'asc' },
      take: 20,
    });
  }

  funcionariasOptions(q?: string) {
    const term = String(q || '').trim();
    return (this.prisma as any).seller.findMany({
      where: {
        active: true,
        ...(term ? { name: { contains: term, mode: 'insensitive' } } : {}),
      },
      select: { id: true, name: true, cpf: true, storeId: true },
      orderBy: { name: 'asc' },
      take: 20,
    });
  }

  // ── painel: cards de resumo ───────────────────────────────────────────────
  async stats() {
    const hoje = this.dia();
    const em7 = new Date(hoje.getTime() + 7 * 86400000);
    const mesIni = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), 1));
    const mesFim = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth() + 1, 1));
    const base = { deletedAt: null } as any;
    const cp = (this.prisma as any).contaPagar;
    const [vencidas, vencidasSum, doDia, doDiaSum, prox7, prox7Sum, pagasMes, pagasMesSum, pend, pendSum] =
      await Promise.all([
        cp.count({ where: { ...base, status: 'aberta', vencimento: { lt: hoje } } }),
        cp.aggregate({ _sum: { valorCents: true }, where: { ...base, status: 'aberta', vencimento: { lt: hoje } } }),
        cp.count({ where: { ...base, status: 'aberta', vencimento: hoje } }),
        cp.aggregate({ _sum: { valorCents: true }, where: { ...base, status: 'aberta', vencimento: hoje } }),
        cp.count({ where: { ...base, status: 'aberta', vencimento: { gt: hoje, lte: em7 } } }),
        cp.aggregate({ _sum: { valorCents: true }, where: { ...base, status: 'aberta', vencimento: { gt: hoje, lte: em7 } } }),
        cp.count({ where: { ...base, status: 'paga', pagamento: { gte: mesIni, lt: mesFim } } }),
        cp.aggregate({ _sum: { valorCents: true }, where: { ...base, status: 'paga', pagamento: { gte: mesIni, lt: mesFim } } }),
        cp.count({ where: { ...base, status: 'aberta' } }),
        cp.aggregate({ _sum: { valorCents: true }, where: { ...base, status: 'aberta' } }),
      ]);
    const c = (n: any) => Number(n?._sum?.valorCents || 0);
    return {
      vencidas: { qtd: vencidas, cents: c(vencidasSum) },
      hoje: { qtd: doDia, cents: c(doDiaSum) },
      prox7: { qtd: prox7, cents: c(prox7Sum) },
      pagasMes: { qtd: pagasMes, cents: c(pagasMesSum) },
      pendenteTotal: { qtd: pend, cents: c(pendSum) },
    };
  }

  // ── filtros → where (compartilhado entre list e baixa em lote) ────────────
  private async montarWhere(f: ListFilters): Promise<any> {
    const where: any = { deletedAt: null };
    if (f.status === 'pendentes' || !f.status) where.status = 'aberta';
    else if (f.status === 'pagas') where.status = 'paga';
    if (f.lojaCode) where.lojaCode = f.lojaCode;
    if (f.especieId) where.especieId = f.especieId;
    if (f.emMaos) where.emMaos = true;
    if (f.de || f.ate) {
      where.vencimento = {};
      if (f.de) where.vencimento.gte = new Date(`${f.de}T00:00:00.000Z`);
      if (f.ate) where.vencimento.lte = new Date(`${f.ate}T00:00:00.000Z`);
    }
    if (!f.incluirRestritas) {
      const restritas = await this.especiesRestritasIds();
      if (restritas.size) where.NOT = { especieId: { in: Array.from(restritas) } };
    }

    // BUSCA POR QUALQUER PARTE: cada palavra precisa casar em ALGUM campo.
    const words = String(f.search || '').trim().split(/\s+/).filter((w) => w.length >= 1).slice(0, 8);
    if (words.length) {
      where.AND = words.map((w) => {
        const or: any[] = [
          { fornecedorNome: { contains: w, mode: 'insensitive' } },
          { sellerNome: { contains: w, mode: 'insensitive' } },
          { notaFiscal: { contains: w, mode: 'insensitive' } },
          { observacao: { contains: w, mode: 'insensitive' } },
          { banco: { contains: w, mode: 'insensitive' } },
          { cheque: { contains: w, mode: 'insensitive' } },
          { especieOriginal: { contains: w, mode: 'insensitive' } },
        ];
        // palavra numérica: também casa nº da conta e VALOR ("1.250" / "1250,00")
        const digits = w.replace(/[^\d,\.]/g, '');
        if (digits && digits === w) {
          const asInt = parseInt(digits.replace(/[\.,]/g, ''), 10);
          if (!isNaN(asInt)) or.push({ numero: asInt }, { gigaRegistro: asInt });
          const cents = Math.round(parseFloat(digits.replace(/\./g, '').replace(',', '.')) * 100);
          if (!isNaN(cents) && cents > 0) or.push({ valorCents: cents });
        }
        return { OR: or };
      });
    }
    return where;
  }

  // ── painel: listagem ──────────────────────────────────────────────────────
  async list(f: ListFilters) {
    const where = await this.montarWhere(f);
    const page = Math.max(1, f.page || 1);
    const perPage = Math.min(100, Math.max(10, f.perPage || 50));
    const cp = (this.prisma as any).contaPagar;
    const [total, soma, rows] = await Promise.all([
      cp.count({ where }),
      cp.aggregate({ _sum: { valorCents: true }, where }),
      cp.findMany({
        where,
        include: { especie: { select: { nome: true, restrita: true } } },
        orderBy: f.status === 'pagas' ? [{ pagamento: 'desc' }] : [{ vencimento: 'asc' }, { numero: 'asc' }],
        skip: (page - 1) * perPage,
        take: perPage,
      }),
    ]);
    const hoje = this.dia().getTime();
    return {
      total,
      somaCents: Number(soma?._sum?.valorCents || 0),
      page,
      perPage,
      rows: rows.map((r: any) => ({
        id: r.id,
        numero: r.numero,
        gigaRegistro: r.gigaRegistro,
        lojaCode: r.lojaCode,
        beneficiarioTipo: r.beneficiarioTipo,
        beneficiario: r.beneficiarioTipo === 'funcionaria' ? r.sellerNome : r.fornecedorNome,
        especie: r.especie?.nome || r.especieOriginal || '—',
        especieRestrita: !!r.especie?.restrita,
        notaFiscal: r.notaFiscal,
        banco: r.banco,
        emissao: r.emissao,
        vencimento: r.vencimento,
        pagamento: r.pagamento,
        valorCents: r.valorCents,
        jurosCents: r.jurosCents,
        descontoCents: r.descontoCents,
        emMaos: r.emMaos,
        observacao: r.observacao,
        parcela: r.parcelaNum && r.parcelaTotal ? `${r.parcelaNum}/${r.parcelaTotal}` : null,
        status: r.status,
        vencida: r.status === 'aberta' && r.vencimento && new Date(r.vencimento).getTime() < hoje,
        hoje: r.status === 'aberta' && r.vencimento && new Date(r.vencimento).getTime() === hoje,
        favorecidoOrfao: r.favorecidoOrfao,
        dataSuspeita: r.dataSuspeita,
      })),
    };
  }

  // ── criar (com parcelas) ─────────────────────────────────────────────────
  async criar(body: any, usuario?: string) {
    const lojaCode = String(body.lojaCode || '').trim();
    if (!lojaCode) throw new BadRequestException('Informe a loja');
    const valorTotal = Math.round(Number(body.valorCents || 0));
    if (!valorTotal || valorTotal <= 0) throw new BadRequestException('Valor inválido');
    const venc1 = body.vencimento ? new Date(`${body.vencimento}T00:00:00.000Z`) : null;
    if (!venc1 || isNaN(venc1.getTime())) throw new BadRequestException('Informe o 1º vencimento');

    const tipo = body.beneficiarioTipo === 'funcionaria' ? 'funcionaria' : 'fornecedor';
    if (tipo === 'funcionaria' && !body.sellerId && !String(body.sellerNome || '').trim()) {
      throw new BadRequestException('Escolha a funcionária');
    }
    if (tipo === 'fornecedor' && !String(body.fornecedorNome || '').trim()) {
      throw new BadRequestException('Informe o fornecedor');
    }

    // Parcelas: usa as customizadas da PRÉVIA se vieram; senão gera mensal.
    let parcelas: Array<{ vencimento: Date; valorCents: number; emMaos: boolean }> = [];
    if (Array.isArray(body.parcelasCustom) && body.parcelasCustom.length) {
      parcelas = body.parcelasCustom.map((p: any) => ({
        vencimento: new Date(`${p.vencimento}T00:00:00.000Z`),
        valorCents: Math.round(Number(p.valorCents || 0)),
        emMaos: !!p.emMaos,
      }));
      const soma = parcelas.reduce((s, p) => s + p.valorCents, 0);
      if (Math.abs(soma - valorTotal) > parcelas.length) {
        throw new BadRequestException(`Parcelas somam R$ ${(soma / 100).toFixed(2)} ≠ total R$ ${(valorTotal / 100).toFixed(2)}`);
      }
    } else {
      const n = Math.min(60, Math.max(1, Number(body.parcelas || 1)));
      const base = Math.floor(valorTotal / n);
      for (let i = 0; i < n; i++) {
        const v = new Date(venc1);
        v.setUTCMonth(v.getUTCMonth() + i);
        parcelas.push({
          vencimento: v,
          valorCents: i === n - 1 ? valorTotal - base * (n - 1) : base,
          emMaos: i === 0 ? !!body.emMaos : false,
        });
      }
    }

    const grupoParcelaId = parcelas.length > 1 ? `cp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` : null;
    const criadas: any[] = [];
    for (let i = 0; i < parcelas.length; i++) {
      const p = parcelas[i];
      const conta = await (this.prisma as any).contaPagar.create({
        data: {
          lojaCode,
          beneficiarioTipo: tipo,
          fornecedorGigaCodigo: tipo === 'fornecedor' ? (body.fornecedorGigaCodigo ?? null) : null,
          fornecedorNome: tipo === 'fornecedor' ? String(body.fornecedorNome).trim() : null,
          sellerId: tipo === 'funcionaria' ? body.sellerId || null : null,
          sellerNome: tipo === 'funcionaria' ? String(body.sellerNome || '').trim() || null : null,
          sellerCpf: tipo === 'funcionaria' ? String(body.sellerCpf || '').replace(/\D/g, '') || null : null,
          especieId: body.especieId || null,
          notaFiscal: body.notaFiscal || null,
          banco: body.banco || null,
          emissao: body.emissao ? new Date(`${body.emissao}T00:00:00.000Z`) : null,
          vencimento: p.vencimento,
          valorCents: p.valorCents,
          emMaos: p.emMaos,
          observacao: body.observacao || null,
          parcelaNum: parcelas.length > 1 ? i + 1 : null,
          parcelaTotal: parcelas.length > 1 ? parcelas.length : null,
          grupoParcelaId,
          status: 'aberta',
          createdBy: usuario || null,
        },
      });
      await this.log(conta.id, 'criada', null, `R$ ${(p.valorCents / 100).toFixed(2)} venc ${p.vencimento.toISOString().slice(0, 10)}`, usuario);
      criadas.push(conta);
    }
    this.logger.log(`[contas] criadas ${criadas.length} conta(s) por ${usuario || '?'} (loja ${lojaCode})`);
    return { ok: true, criadas: criadas.length, ids: criadas.map((c) => c.id) };
  }

  // ── baixa / reabrir / em mãos / editar / excluir ──────────────────────────
  private async getConta(id: string) {
    const c = await (this.prisma as any).contaPagar.findUnique({ where: { id } });
    if (!c || c.deletedAt) throw new NotFoundException('Conta não encontrada');
    return c;
  }

  async pagar(id: string, body: any, usuario?: string) {
    const c = await this.getConta(id);
    if (c.status === 'paga') throw new BadRequestException('Conta já está paga');
    const pagamento = body?.pagamento ? new Date(`${body.pagamento}T00:00:00.000Z`) : this.dia();
    const jurosCents = Math.max(0, Math.round(Number(body?.jurosCents || 0)));
    const descontoCents = Math.max(0, Math.round(Number(body?.descontoCents || 0)));
    const upd = await (this.prisma as any).contaPagar.update({
      where: { id },
      data: { status: 'paga', pagamento, jurosCents, descontoCents, pagoPor: usuario || null, updatedBy: usuario || null },
    });
    await this.log(id, 'pagamento', null, `${pagamento.toISOString().slice(0, 10)} (juros ${(jurosCents / 100).toFixed(2)}, desc ${(descontoCents / 100).toFixed(2)})`, usuario);
    return upd;
  }

  async reabrir(id: string, usuario?: string) {
    const c = await this.getConta(id);
    if (c.status !== 'paga') throw new BadRequestException('Só conta PAGA pode reabrir');
    const upd = await (this.prisma as any).contaPagar.update({
      where: { id },
      data: { status: 'aberta', pagamento: null, jurosCents: 0, descontoCents: 0, pagoPor: null, updatedBy: usuario || null },
    });
    await this.log(id, 'reaberta', c.pagamento ? new Date(c.pagamento).toISOString().slice(0, 10) : null, null, usuario);
    return upd;
  }

  async toggleEmMaos(id: string, usuario?: string) {
    const c = await this.getConta(id);
    const upd = await (this.prisma as any).contaPagar.update({
      where: { id },
      data: { emMaos: !c.emMaos, updatedBy: usuario || null },
    });
    await this.log(id, 'emMaos', c.emMaos ? 'SIM' : 'NÃO', !c.emMaos ? 'SIM' : 'NÃO', usuario);
    return upd;
  }

  async atualizar(id: string, patch: any, usuario?: string) {
    const c = await this.getConta(id);
    const data: any = {};
    for (const [k, v] of Object.entries(patch || {})) {
      if (!CAMPOS_EDITAVEIS.has(k)) continue;
      let novo: any = v;
      if (k === 'vencimento' || k === 'emissao') novo = v ? new Date(`${v}T00:00:00.000Z`) : null;
      if (k === 'valorCents') novo = Math.round(Number(v || 0));
      data[k] = novo;
      const antigo = (c as any)[k];
      const fmt = (x: any) => (x instanceof Date ? x.toISOString().slice(0, 10) : x);
      if (String(fmt(antigo)) !== String(fmt(novo))) {
        await this.log(id, k, fmt(antigo), fmt(novo), usuario);
      }
    }
    if (!Object.keys(data).length) return c;
    data.updatedBy = usuario || null;
    return (this.prisma as any).contaPagar.update({ where: { id }, data });
  }

  async excluir(id: string, usuario?: string) {
    await this.getConta(id);
    const upd = await (this.prisma as any).contaPagar.update({
      where: { id },
      data: { deletedAt: new Date(), deletedBy: usuario || null },
    });
    await this.log(id, 'excluida', null, `por ${usuario || '?'}`, usuario);
    return { ok: true, id: upd.id };
  }

  async logs(id: string) {
    return (this.prisma as any).contaPagarLog.findMany({
      where: { contaId: id },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  // ── BAIXA EM LOTE (11/07 — "precisa verificar e baixar") ─────────────────
  // O GIGA veio com 6.452 contas em aberto acumuladas em 20+ anos (1977,
  // 2000, testes de R$0,01…) — pagas na vida real, nunca baixadas no WinCred.
  // Baixa TODAS as contas ABERTAS do filtro atual de uma vez, com motivo
  // OBRIGATÓRIO e auditoria individual (quem, quando, motivo).
  async baixaEmLote(f: ListFilters, body: any, usuario?: string) {
    const motivo = String(body?.motivo || '').trim();
    if (motivo.length < 5) throw new BadRequestException('Informe o motivo da baixa em lote (mín. 5 caracteres)');
    const pagamento = body?.pagamento ? new Date(`${body.pagamento}T00:00:00.000Z`) : this.dia();

    const where = await this.montarWhere({ ...f, status: 'pendentes' });
    const alvo: any[] = await (this.prisma as any).contaPagar.findMany({
      where,
      select: { id: true, valorCents: true },
    });
    if (!alvo.length) throw new BadRequestException('Nenhuma conta aberta no filtro atual');
    if (alvo.length > 20000) throw new BadRequestException('Filtro pega contas demais — refine antes de baixar');

    const ids = alvo.map((a) => a.id);
    const somaCents = alvo.reduce((s, a) => s + a.valorCents, 0);

    // Baixa + observação do motivo (updateMany não concatena — motivo vai no log)
    await (this.prisma as any).contaPagar.updateMany({
      where: { id: { in: ids } },
      data: { status: 'paga', pagamento, jurosCents: 0, descontoCents: 0, pagoPor: usuario || null, updatedBy: usuario || null },
    });

    // Auditoria individual em lotes (1 log por conta)
    const logMsg = `${pagamento.toISOString().slice(0, 10)} — BAIXA EM LOTE: ${motivo}`.slice(0, 300);
    for (let i = 0; i < ids.length; i += 1000) {
      await (this.prisma as any).contaPagarLog.createMany({
        data: ids.slice(i, i + 1000).map((contaId) => ({
          contaId,
          campo: 'pagamento',
          valorAntigo: null,
          valorNovo: logMsg,
          usuario: usuario || null,
          origem: 'lote',
        })),
      });
    }
    this.logger.log(`[contas] BAIXA EM LOTE por ${usuario || '?'}: ${ids.length} conta(s), R$ ${(somaCents / 100).toFixed(2)} — ${motivo}`);
    return { ok: true, baixadas: ids.length, somaCents };
  }

  // ── aba FUNCIONÁRIAS (restrita) ───────────────────────────────────────────
  async funcionariasResumo(mes?: string) {
    const m = /^\d{4}-\d{2}$/.test(String(mes || '')) ? String(mes) : new Date().toISOString().slice(0, 7);
    const ini = new Date(`${m}-01T00:00:00.000Z`);
    const fim = new Date(Date.UTC(ini.getUTCFullYear(), ini.getUTCMonth() + 1, 1));
    const rows: any[] = await (this.prisma as any).contaPagar.findMany({
      where: {
        deletedAt: null,
        beneficiarioTipo: 'funcionaria',
        vencimento: { gte: ini, lt: fim },
      },
      include: { especie: { select: { nome: true } } },
      orderBy: [{ sellerNome: 'asc' }, { vencimento: 'asc' }],
    });
    const porPessoa = new Map<string, { nome: string; sellerId: string | null; totalCents: number; itens: any[] }>();
    for (const r of rows) {
      const key = r.sellerId || r.sellerNome || '?';
      let p = porPessoa.get(key);
      if (!p) porPessoa.set(key, (p = { nome: r.sellerNome || '?', sellerId: r.sellerId, totalCents: 0, itens: [] }));
      p.totalCents += r.valorCents;
      p.itens.push({
        id: r.id,
        especie: r.especie?.nome || r.especieOriginal || '—',
        lojaCode: r.lojaCode,
        vencimento: r.vencimento,
        pagamento: r.pagamento,
        valorCents: r.valorCents,
        status: r.status,
        observacao: r.observacao,
      });
    }
    return {
      mes: m,
      pessoas: Array.from(porPessoa.values()).sort((a, b) => b.totalCents - a.totalCents),
      totalCents: rows.reduce((s, r) => s + r.valorCents, 0),
      qtd: rows.length,
    };
  }
}
