import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  FitEngineService, FitCorpo, FitPeca, FitResultado, GRADE_PLUS,
} from './fit-engine.service';

/**
 * LURDS FIT AI — orquestração.
 *
 *  - monta o contexto da peça (ficha + o que o sistema aprendeu)
 *  - chama o motor
 *  - grava o Body Profile da cliente e a recomendação (dataset de treino)
 *  - fecha o ciclo quando vira compra/troca/devolução (aprendizado)
 */
@Injectable()
export class FitService {
  private readonly logger = new Logger(FitService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: FitEngineService,
  ) {}

  private normRef(ref?: string | null): string {
    return String(ref || '').trim().toUpperCase().replace(/\s+/g, '');
  }

  private normTamanho(t?: string | null): string | null {
    const v = String(t || '').trim().toUpperCase();
    return GRADE_PLUS.includes(v) ? v : null;
  }

  // ── FICHA DA PEÇA (admin) ───────────────────────────────────────────────

  async getProduto(ref: string) {
    const key = this.normRef(ref);
    if (!key) throw new BadRequestException('ref obrigatória');
    const ficha = await (this.prisma as any).fitProduct.findUnique({ where: { ref: key } });
    // Sem ficha própria? Herda o que dá do espelho do catálogo (marca/categoria)
    if (!ficha) {
      const p = await (this.prisma as any).product.findFirst({
        where: { ref: key },
        select: { marca: true, categoria: true, nomeGrupo: true, fornecedor: true },
      });
      return {
        ref: key,
        marca: p?.marca || null,
        categoria: p?.categoria || p?.nomeGrupo || null,
        fornecedor: p?.fornecedor || null,
        modelagem: null, elastano: null, caimento: null, composicao: null,
        medidas: null, observacao: null,
        semFicha: true,
      };
    }
    return { ...ficha, semFicha: false };
  }

  async salvarProduto(input: any, usuario?: string) {
    const ref = this.normRef(input?.ref);
    if (!ref) throw new BadRequestException('ref obrigatória');
    const opt = (v: any, lista: string[]) => {
      const s = String(v || '').trim().toLowerCase();
      return lista.includes(s) ? s : null;
    };
    const data = {
      categoria: input.categoria ? String(input.categoria).trim().toLowerCase().slice(0, 20) : null,
      marca: input.marca ? String(input.marca).trim().slice(0, 30) : null,
      fornecedor: input.fornecedor ? String(input.fornecedor).trim().slice(0, 40) : null,
      modelagem: opt(input.modelagem, ['pequena', 'normal', 'grande']),
      elastano: opt(input.elastano, ['sem', 'pouco', 'muito']),
      caimento: opt(input.caimento, ['justo', 'normal', 'amplo']),
      composicao: input.composicao ? String(input.composicao).slice(0, 120) : null,
      medidas: input.medidas ?? undefined,
      observacao: input.observacao ? String(input.observacao).slice(0, 2000) : null,
      atualizadoPor: usuario || null,
    };
    return (this.prisma as any).fitProduct.upsert({
      where: { ref },
      create: { ref, ...data },
      update: data,
    });
  }

  // ── APRENDIZADO (leitura) ───────────────────────────────────────────────

  private async lerStats(ref: string, categoria?: string | null, marca?: string | null) {
    const chaves: Array<{ escopo: string; chave: string }> = [{ escopo: 'ref', chave: ref }];
    if (categoria) chaves.push({ escopo: 'categoria', chave: String(categoria).toLowerCase() });
    if (marca) chaves.push({ escopo: 'marca', chave: String(marca).toUpperCase() });

    const rows: any[] = await (this.prisma as any).fitStat.findMany({
      where: { OR: chaves.map((c) => ({ escopo: c.escopo, chave: c.chave })) },
    });
    const byEscopo = new Map(rows.map((r) => [r.escopo, r]));
    const r = byEscopo.get('ref');
    const totalRef = r ? r.acertos + r.trocas + r.devolucoes : 0;
    return {
      viesRef: r?.viesMedio ?? null,
      amostrasRef: r?.amostras ?? 0,
      viesCategoria: byEscopo.get('categoria')?.viesMedio ?? null,
      amostrasCategoria: byEscopo.get('categoria')?.amostras ?? 0,
      viesMarca: byEscopo.get('marca')?.viesMedio ?? null,
      amostrasMarca: byEscopo.get('marca')?.amostras ?? 0,
      taxaTroca: totalRef > 0 ? (r.trocas + r.devolucoes) / totalRef : null,
    };
  }

  // ── RECOMENDAR (o widget chama isto) ────────────────────────────────────

  async recomendar(body: any): Promise<FitResultado & { recomendacaoId: string; profileId: string | null }> {
    const alturaCm = Math.round(Number(body?.alturaCm) || 0);
    const pesoKg = Math.round(Number(body?.pesoKg) || 0);
    if (alturaCm < 120 || alturaCm > 220) throw new BadRequestException('Altura inválida (120–220 cm)');
    if (pesoKg < 35 || pesoKg > 250) throw new BadRequestException('Peso inválido (35–250 kg)');

    const corpo: FitCorpo = {
      alturaCm,
      pesoKg,
      idade: body?.idade ? Math.round(Number(body.idade)) : null,
      preferencia: ['justa', 'normal', 'soltinha'].includes(body?.preferencia) ? body.preferencia : 'normal',
      formatoCorpo: ['ampulheta', 'pera', 'maca', 'retangulo', 'naosei'].includes(body?.formatoCorpo)
        ? body.formatoCorpo : null,
      busto: ['P', 'M', 'G'].includes(String(body?.busto || '').toUpperCase())
        ? String(body.busto).toUpperCase() as any : null,
      quadril: ['P', 'M', 'G'].includes(String(body?.quadril || '').toUpperCase())
        ? String(body.quadril).toUpperCase() as any : null,
      tamanhoHabitual: this.normTamanho(body?.tamanhoHabitual),
    };

    const ref = this.normRef(body?.ref);
    const ficha = ref ? await this.getProduto(ref) : null;
    const peca: FitPeca = {
      ref: ref || null,
      categoria: body?.categoria || ficha?.categoria || null,
      marca: body?.marca || ficha?.marca || null,
      modelagem: (ficha?.modelagem as any) || null,
      elastano: (ficha?.elastano as any) || null,
      caimento: (ficha?.caimento as any) || null,
      composicao: ficha?.composicao || null,
      tamanhosDisponiveis: Array.isArray(body?.tamanhosDisponiveis) ? body.tamanhosDisponiveis : null,
    };

    const aprend = ref ? await this.lerStats(ref, peca.categoria, peca.marca) : {};
    const resultado = this.engine.recomendar(corpo, peca, aprend);

    // ── Body Profile: a cliente passa a ter um perfil (CRM) ──
    const anonId = String(body?.anonId || '').slice(0, 40) || null;
    const customerId = body?.customerId ? String(body.customerId) : null;
    let profileId: string | null = null;
    try {
      const existente = customerId
        ? await (this.prisma as any).fitBodyProfile.findFirst({ where: { customerId } })
        : anonId
          ? await (this.prisma as any).fitBodyProfile.findFirst({ where: { anonId } })
          : null;
      const dadosPerfil = {
        customerId, anonId,
        alturaCm, pesoKg, idade: corpo.idade,
        preferencia: corpo.preferencia,
        formatoCorpo: corpo.formatoCorpo,
        busto: corpo.busto,
        quadril: corpo.quadril,
        tamanhoHabitual: corpo.tamanhoHabitual,
        ultimoRecomendado: resultado.tamanho,
      };
      const perfil = existente
        ? await (this.prisma as any).fitBodyProfile.update({
            where: { id: existente.id },
            data: { ...dadosPerfil, customerId: customerId || existente.customerId },
          })
        : await (this.prisma as any).fitBodyProfile.create({ data: dadosPerfil });
      profileId = perfil.id;
    } catch (e) {
      this.logger.warn(`[fit] perfil não gravado: ${(e as Error).message}`);
    }

    // ── Log da recomendação (dataset de treino) ──
    const rec = await (this.prisma as any).fitRecommendation.create({
      data: {
        profileId, customerId, anonId,
        ref: ref || null,
        categoria: peca.categoria ? String(peca.categoria).slice(0, 20) : null,
        marca: peca.marca ? String(peca.marca).slice(0, 30) : null,
        entrada: { corpo, peca, aprendizado: aprend },
        trilha: resultado.trilha as any,
        tamanho: resultado.tamanho,
        tamanhoAlt: resultado.tamanhoAlt,
        confianca: resultado.confianca,
        origem: String(body?.origem || 'pdp').slice(0, 20),
      },
    });

    return { ...resultado, recomendacaoId: rec.id, profileId };
  }

  // ── FECHAR O CICLO → APRENDER ───────────────────────────────────────────

  /**
   * Registra o desfecho de uma recomendação e move o modelo.
   *   comprou  → acerto (viés 0, reforça a recomendação)
   *   trocou   → viés = passos entre o comprado e o que ficou
   *   devolveu → penaliza sem mover o viés (não sabemos o certo)
   */
  async registrarDesfecho(input: {
    recomendacaoId?: string | null;
    ref?: string | null;
    customerId?: string | null;
    desfecho: 'comprou' | 'trocou' | 'devolveu' | 'ignorou';
    tamanhoComprado?: string | null;
    tamanhoFinal?: string | null;
  }) {
    const desfecho = input.desfecho;
    if (!['comprou', 'trocou', 'devolveu', 'ignorou'].includes(desfecho)) {
      throw new BadRequestException('desfecho inválido');
    }

    let rec: any = null;
    if (input.recomendacaoId) {
      rec = await (this.prisma as any).fitRecommendation.findUnique({ where: { id: input.recomendacaoId } });
    } else if (input.ref && input.customerId) {
      // Sem o id? pega a recomendação mais recente da cliente pra essa peça
      rec = await (this.prisma as any).fitRecommendation.findFirst({
        where: { ref: this.normRef(input.ref), customerId: input.customerId, desfecho: null },
        orderBy: { createdAt: 'desc' },
      });
    }
    if (!rec) return { ok: false, motivo: 'recomendação não encontrada' };

    const comprado = this.normTamanho(input.tamanhoComprado) || rec.tamanho;
    const final = this.normTamanho(input.tamanhoFinal);
    await (this.prisma as any).fitRecommendation.update({
      where: { id: rec.id },
      data: {
        desfecho,
        tamanhoComprado: comprado,
        tamanhoFinal: final,
        desfechoAt: new Date(),
      },
    });

    // Perfil da cliente acompanha o mundo real
    if (rec.profileId) {
      await (this.prisma as any).fitBodyProfile.update({
        where: { id: rec.profileId },
        data: {
          ultimoComprado: comprado,
          ...(desfecho === 'trocou' && final ? { ultimoTrocado: final } : {}),
        },
      }).catch(() => {});
    }

    if (desfecho === 'ignorou') return { ok: true, aprendeu: false };

    // Passos de correção: só a TROCA ensina a direção
    const passos = desfecho === 'trocou' ? (this.engine.passosEntre(comprado, final) ?? 0) : 0;
    const escopos: Array<{ escopo: string; chave: string }> = [];
    if (rec.ref) escopos.push({ escopo: 'ref', chave: rec.ref });
    if (rec.categoria) escopos.push({ escopo: 'categoria', chave: String(rec.categoria).toLowerCase() });
    if (rec.marca) escopos.push({ escopo: 'marca', chave: String(rec.marca).toUpperCase() });

    for (const e of escopos) {
      const atual = await (this.prisma as any).fitStat.findUnique({
        where: { escopo_chave: { escopo: e.escopo, chave: e.chave } },
      });
      const amostras = (atual?.amostras || 0) + 1;
      const viesSoma = (atual?.viesSoma || 0) + passos;
      await (this.prisma as any).fitStat.upsert({
        where: { escopo_chave: { escopo: e.escopo, chave: e.chave } },
        create: {
          escopo: e.escopo, chave: e.chave,
          amostras, viesSoma, viesMedio: viesSoma / amostras,
          acertos: desfecho === 'comprou' ? 1 : 0,
          trocas: desfecho === 'trocou' ? 1 : 0,
          devolucoes: desfecho === 'devolveu' ? 1 : 0,
        },
        update: {
          amostras, viesSoma, viesMedio: viesSoma / amostras,
          acertos: { increment: desfecho === 'comprou' ? 1 : 0 },
          trocas: { increment: desfecho === 'trocou' ? 1 : 0 },
          devolucoes: { increment: desfecho === 'devolveu' ? 1 : 0 },
        },
      });
    }

    this.logger.log(
      `[fit] aprendeu: ${rec.ref || '?'} ${desfecho} ${comprado}${final ? `→${final}` : ''} (${passos >= 0 ? '+' : ''}${passos} passos)`,
    );
    return { ok: true, aprendeu: true, passos };
  }

  // ── PAINEL ──────────────────────────────────────────────────────────────

  async dashboard(dias = 30) {
    const desde = new Date(Date.now() - Math.max(1, dias) * 86400_000);
    const [total, comDesfecho, acertos, trocas, devolucoes, mediaConf] = await Promise.all([
      (this.prisma as any).fitRecommendation.count({ where: { createdAt: { gte: desde } } }),
      (this.prisma as any).fitRecommendation.count({ where: { createdAt: { gte: desde }, desfecho: { not: null } } }),
      (this.prisma as any).fitRecommendation.count({ where: { createdAt: { gte: desde }, desfecho: 'comprou' } }),
      (this.prisma as any).fitRecommendation.count({ where: { createdAt: { gte: desde }, desfecho: 'trocou' } }),
      (this.prisma as any).fitRecommendation.count({ where: { createdAt: { gte: desde }, desfecho: 'devolveu' } }),
      (this.prisma as any).fitRecommendation.aggregate({
        where: { createdAt: { gte: desde } }, _avg: { confianca: true },
      }),
    ]);

    const stats: any[] = await (this.prisma as any).fitStat.findMany({
      where: { escopo: 'ref' },
      orderBy: { amostras: 'desc' },
      take: 200,
    });
    const comTaxa = stats.map((s) => {
      const tot = s.acertos + s.trocas + s.devolucoes;
      return {
        ref: s.chave,
        amostras: s.amostras,
        viesMedio: Number(s.viesMedio.toFixed(2)),
        acertos: s.acertos,
        trocas: s.trocas,
        devolucoes: s.devolucoes,
        precisao: tot > 0 ? Math.round((s.acertos / tot) * 100) : null,
        tendencia: s.viesMedio > 0.3 ? 'veste pequeno' : s.viesMedio < -0.3 ? 'veste grande' : 'fiel',
      };
    });

    const porEscopo = async (escopo: string) => {
      const rows: any[] = await (this.prisma as any).fitStat.findMany({
        where: { escopo }, orderBy: { amostras: 'desc' }, take: 30,
      });
      return rows.map((s) => {
        const tot = s.acertos + s.trocas + s.devolucoes;
        return {
          chave: s.chave,
          amostras: s.amostras,
          precisao: tot > 0 ? Math.round((s.acertos / tot) * 100) : null,
          viesMedio: Number(s.viesMedio.toFixed(2)),
        };
      });
    };

    const fechados = acertos + trocas + devolucoes;
    return {
      periodoDias: dias,
      kpis: {
        recomendacoes: total,
        clientesAtendidas: await (this.prisma as any).fitBodyProfile.count(),
        comDesfecho,
        precisaoGeral: fechados > 0 ? Math.round((acertos / fechados) * 100) : null,
        confiancaMedia: Math.round(Number(mediaConf?._avg?.confianca || 0)),
        trocas,
        devolucoes,
        /** Trocas evitadas: quem seguiu a recomendação e NÃO trocou. */
        trocasEvitadas: acertos,
      },
      maiorTroca: comTaxa.filter((r) => r.trocas > 0).sort((a, b) => b.trocas - a.trocas).slice(0, 15),
      maiorAcerto: comTaxa.filter((r) => (r.precisao ?? 0) >= 80 && r.amostras >= 3).slice(0, 15),
      maiorDuvida: await this.pecasComDuvida(desde),
      porCategoria: await porEscopo('categoria'),
      porMarca: await porEscopo('marca'),
    };
  }

  /** Peças em que a confiança média sai baixa — é onde falta cadastrar ficha. */
  private async pecasComDuvida(desde: Date) {
    const rows: any[] = await (this.prisma as any).fitRecommendation.groupBy({
      by: ['ref'],
      where: { createdAt: { gte: desde }, ref: { not: null } },
      _avg: { confianca: true },
      _count: { _all: true },
      orderBy: { _avg: { confianca: 'asc' } },
      take: 15,
    });
    return rows
      .filter((r) => (r._count?._all || 0) >= 2)
      .map((r) => ({
        ref: r.ref,
        consultas: r._count?._all || 0,
        confiancaMedia: Math.round(Number(r._avg?.confianca || 0)),
      }));
  }

  /** Body Profile pra ficha do CRM. */
  async perfilDaCliente(customerId: string) {
    const perfil = await (this.prisma as any).fitBodyProfile.findFirst({
      where: { customerId },
      orderBy: { updatedAt: 'desc' },
    });
    if (!perfil) return null;
    const historico: any[] = await (this.prisma as any).fitRecommendation.findMany({
      where: { customerId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true, ref: true, tamanho: true, tamanhoAlt: true, confianca: true,
        desfecho: true, tamanhoComprado: true, tamanhoFinal: true, createdAt: true,
      },
    });
    return { perfil, historico };
  }
}
