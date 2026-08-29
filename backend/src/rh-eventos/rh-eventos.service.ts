import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  EVENTOS_RH,
  EventoDoDia,
  descontoFolha,
  tipoEvento,
  tipoEventoValido,
} from '../common/eventos-rh';
import { ymdBR } from '../lib/date-br';
import { SellerDocumentsService } from '../sellers/seller-documents.service';

/**
 * EVENTOS DE RH — o registro de POR QUE o dia ficou vazio.
 *
 * Quem lança é a SUPERVISÃO (decisão do dono, 28/08/2026). Não existe fluxo de
 * pedir/aprovar: a supervisão lança e vale. A loja apenas LÊ, pra saber quem
 * está fora hoje.
 *
 * Os efeitos (abona, desconta, DSR, art. 130) NÃO ficam aqui — ficam no tipo,
 * em `common/eventos-rh.ts`. Este service guarda o fato e responde às contas.
 */
@Injectable()
export class RhEventosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly docs: SellerDocumentsService,
  ) {}

  private get tabela() {
    return (this.prisma as any).sellerEvento;
  }

  /**
   * "YYYY-MM-DD" → Date em MEIA-NOITE UTC.
   *
   * Meia-noite de propósito: `dataInicio`/`dataFim` são `@db.Date`, e o Prisma
   * devolve coluna Date sempre como 00:00Z. Se a âncora fosse meio-dia, a
   * comparação `dataFim >= alvo` daria FALSO no último dia — o atestado
   * perderia justamente o dia em que termina.
   */
  private paraData(v: unknown, campo: string): Date {
    const s = String(v ?? '').trim().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      throw new BadRequestException(`${campo} inválida (use AAAA-MM-DD)`);
    }
    const d = new Date(`${s}T00:00:00.000Z`);
    if (Number.isNaN(d.getTime())) throw new BadRequestException(`${campo} inválida`);
    return d;
  }

  /**
   * Chave YYYY-MM-DD de uma coluna `@db.Date`.
   *
   * Aqui NÃO se usa `ymdBR`: a coluna volta como 00:00Z, que em São Paulo é
   * 21:00 da VÉSPERA — converter pro fuso BR devolveria o dia anterior.
   */
  private chaveData(d: Date | string): string {
    return new Date(d).toISOString().slice(0, 10);
  }

  private validarHora(v: unknown, campo: string): string | null {
    const s = String(v ?? '').trim();
    if (!s) return null;
    if (!/^\d{1,2}:\d{2}$/.test(s)) {
      throw new BadRequestException(`${campo} inválida (use HH:MM)`);
    }
    const [h, m] = s.split(':').map(Number);
    if (h > 23 || m > 59) throw new BadRequestException(`${campo} inválida (use HH:MM)`);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  /** Lista fechada pra tela — fonte única, o front não repete os tipos. */
  listarTipos() {
    return EVENTOS_RH.map((t) => ({
      codigo: t.codigo,
      label: t.label,
      grupo: t.grupo,
      exigeDocumento: t.exigeDocumento,
      admiteParcial: t.admiteParcial,
      abonaJornada: t.abonaJornada,
      descontaSalario: t.descontaSalario,
      descontaDSR: t.descontaDSR,
      contaArt130: t.contaArt130,
      limiteDias: t.limiteDias ?? null,
      esocial: t.esocial,
      nota: t.nota ?? null,
    }));
  }

  /**
   * LANÇAR. A supervisão informa funcionária, tipo e período; o resto o TIPO
   * decide. `storeId` nasce congelado da loja da funcionária pra o relatório
   * não mudar de dono quando ela trocar de loja.
   */
  async criar(input: {
    sellerId: string;
    tipo: string;
    dataInicio: string;
    dataFim?: string;
    diaInteiro?: boolean;
    horaInicio?: string | null;
    horaFim?: string | null;
    documentoId?: string | null;
    observacoes?: string | null;
    storeId?: string | null;
  }, autor: { id: string | null; nome: string | null }) {
    const sellerId = String(input?.sellerId || '').trim();
    if (!sellerId) throw new BadRequestException('Funcionária é obrigatória');

    const codigo = String(input?.tipo || '').trim().toUpperCase();
    if (!tipoEventoValido(codigo)) {
      throw new BadRequestException(`Tipo de evento desconhecido: ${codigo || '(vazio)'}`);
    }
    const tipo = tipoEvento(codigo)!;

    const seller = await (this.prisma as any).seller.findUnique({
      where: { id: sellerId },
      select: { id: true, name: true, responsibleStoreId: true },
    });
    if (!seller) throw new NotFoundException('Funcionária não encontrada');

    const dataInicio = this.paraData(input.dataInicio, 'Data de início');
    const dataFim = input.dataFim
      ? this.paraData(input.dataFim, 'Data de fim')
      : dataInicio;
    if (dataFim < dataInicio) {
      throw new BadRequestException('A data de fim é anterior à de início');
    }

    // Teto legal do art. 473 (2 dias de nojo, 3 de gala, 1 de doação...).
    // Avisa em vez de deixar passar: 5 dias de "gala" é erro de digitação.
    if (tipo.limiteDias) {
      const dias =
        Math.round((dataFim.getTime() - dataInicio.getTime()) / 86_400_000) + 1;
      if (dias > tipo.limiteDias) {
        throw new BadRequestException(
          `${tipo.label} permite no máximo ${tipo.limiteDias} dia(s) — foram pedidos ${dias}.`,
        );
      }
    }

    // Parcial só existe em tipo que admite. Nos outros, hora digitada é ruído
    // e seria ignorada em silêncio pela régua — melhor não gravar.
    const admiteParcial = tipo.admiteParcial;
    const diaInteiro = admiteParcial ? input.diaInteiro !== false : true;
    const horaInicio = admiteParcial && !diaInteiro
      ? this.validarHora(input.horaInicio, 'Hora de início')
      : null;
    const horaFim = admiteParcial && !diaInteiro
      ? this.validarHora(input.horaFim, 'Hora de fim')
      : null;
    if (!diaInteiro && horaInicio && horaFim && horaFim <= horaInicio) {
      throw new BadRequestException('A hora de fim precisa ser maior que a de início');
    }

    if (tipo.exigeDocumento && !input.documentoId) {
      throw new BadRequestException(
        `${tipo.label} exige o documento anexado no prontuário.`,
      );
    }

    return this.tabela.create({
      data: {
        sellerId,
        storeId: input.storeId || seller.responsibleStoreId || null,
        tipo: codigo,
        dataInicio,
        dataFim,
        diaInteiro,
        horaInicio,
        horaFim,
        documentoId: input.documentoId || null,
        observacoes: input.observacoes || null,
        lancadoBy: autor.id,
        lancadoByNome: autor.nome,
      },
    });
  }

  /** Edita período/horas/observação. O TIPO não muda — troca de tipo é evento novo. */
  async editar(id: string, input: {
    dataInicio?: string;
    dataFim?: string;
    diaInteiro?: boolean;
    horaInicio?: string | null;
    horaFim?: string | null;
    documentoId?: string | null;
    observacoes?: string | null;
  }) {
    const atual = await this.tabela.findUnique({ where: { id } });
    if (!atual) throw new NotFoundException('Evento não encontrado');
    if (atual.canceladoAt) throw new BadRequestException('Evento cancelado não se edita');

    const tipo = tipoEvento(atual.tipo);
    const admiteParcial = !!tipo?.admiteParcial;

    const dataInicio = input.dataInicio
      ? this.paraData(input.dataInicio, 'Data de início')
      : atual.dataInicio;
    const dataFim = input.dataFim ? this.paraData(input.dataFim, 'Data de fim') : atual.dataFim;
    if (dataFim < dataInicio) {
      throw new BadRequestException('A data de fim é anterior à de início');
    }

    const diaInteiro = admiteParcial
      ? (input.diaInteiro ?? atual.diaInteiro) !== false
      : true;

    return this.tabela.update({
      where: { id },
      data: {
        dataInicio,
        dataFim,
        diaInteiro,
        horaInicio: admiteParcial && !diaInteiro
          ? this.validarHora(input.horaInicio ?? atual.horaInicio, 'Hora de início')
          : null,
        horaFim: admiteParcial && !diaInteiro
          ? this.validarHora(input.horaFim ?? atual.horaFim, 'Hora de fim')
          : null,
        documentoId: input.documentoId === undefined ? atual.documentoId : (input.documentoId || null),
        observacoes: input.observacoes === undefined ? atual.observacoes : (input.observacoes || null),
      },
    });
  }

  /**
   * CANCELAR — nunca deleta. Histórico de RH é prova em reclamação
   * trabalhista: a linha fica, sai só das contas.
   */
  async cancelar(id: string, motivo: string, autor: { id: string | null }) {
    const atual = await this.tabela.findUnique({ where: { id } });
    if (!atual) throw new NotFoundException('Evento não encontrado');
    if (atual.canceladoAt) return atual;
    const m = String(motivo || '').trim();
    if (!m) throw new BadRequestException('Diga por que está cancelando');
    return this.tabela.update({
      where: { id },
      data: { canceladoAt: new Date(), canceladoBy: autor.id, canceladoMotivo: m },
    });
  }

  /** Lista com filtro De/Até — recorte de tempo do padrão da casa. */
  async listar(filtro: {
    sellerId?: string;
    storeId?: string;
    tipo?: string;
    de?: string;
    ate?: string;
    incluirCancelados?: boolean;
  }) {
    const where: any = {};
    if (filtro.sellerId) where.sellerId = filtro.sellerId;
    if (filtro.storeId) where.storeId = filtro.storeId;
    if (filtro.tipo) where.tipo = String(filtro.tipo).toUpperCase();
    if (!filtro.incluirCancelados) where.canceladoAt = null;

    // Sobreposição de intervalo: o evento TOCA a janela pedida.
    if (filtro.de) where.dataFim = { gte: this.paraData(filtro.de, 'De') };
    if (filtro.ate) where.dataInicio = { lte: this.paraData(filtro.ate, 'Até') };

    const linhas = await this.tabela.findMany({
      where,
      orderBy: [{ dataInicio: 'desc' }, { createdAt: 'desc' }],
      take: 500,
      include: {
        seller: { select: { id: true, name: true, apelido: true } },
        store: { select: { id: true, code: true, name: true } },
        documento: { select: { id: true, titulo: true, fileUrl: true } },
      },
    });

    return linhas.map((e: any) => {
      const t = tipoEvento(e.tipo);
      return {
        ...e,
        tipoLabel: t?.label ?? e.tipo,
        grupo: t?.grupo ?? null,
        abonaJornada: !!t?.abonaJornada,
        descontaSalario: !!t?.descontaSalario,
        descontaDSR: !!t?.descontaDSR,
        contaArt130: !!t?.contaArt130,
      };
    });
  }

  /**
   * QUEM ESTÁ FORA HOJE — pra fila da loja e pro painel da supervisão.
   *
   * Só entra quem tem evento que ABONA: falta injustificada e advertência não
   * são "está fora", são registro. Alarme falso mata a confiança na fila.
   */
  async foraHoje(storeId?: string, dataRef?: string) {
    // Sem data explícita, "hoje" é o dia de São Paulo — o servidor roda em UTC
    // e depois das 21h já virou o dia lá, não aqui.
    const alvo = dataRef
      ? this.paraData(dataRef, 'Data')
      : new Date(`${ymdBR()}T00:00:00.000Z`);

    const where: any = {
      canceladoAt: null,
      dataInicio: { lte: alvo },
      dataFim: { gte: alvo },
    };
    if (storeId) where.storeId = storeId;

    const linhas = await this.tabela.findMany({
      where,
      include: {
        seller: { select: { id: true, name: true, apelido: true } },
        store: { select: { id: true, code: true, name: true } },
      },
      orderBy: { dataInicio: 'asc' },
      take: 200,
    });

    return linhas
      .map((e: any) => ({ e, t: tipoEvento(e.tipo) }))
      .filter(({ t }) => t?.abonaJornada)
      .map(({ e, t }) => ({
        id: e.id,
        sellerId: e.sellerId,
        nome: e.seller?.apelido || e.seller?.name || '',
        storeId: e.storeId,
        lojaCodigo: e.store?.code ?? null,
        tipo: e.tipo,
        tipoLabel: t!.label,
        diaInteiro: e.diaInteiro,
        horaInicio: e.horaInicio,
        horaFim: e.horaFim,
        ate: this.chaveData(e.dataFim),
      }));
  }

  /**
   * MAPA DO MÊS PRO ESPELHO: "YYYY-MM-DD" → eventos daquele dia.
   *
   * O espelho chama isto UMA vez por funcionária e consulta o mapa dia a dia —
   * o caminho antigo faria 31 queries por espelho, e o espelho da loja já roda
   * uma vez por vendedora.
   */
  async mapaDoMes(sellerId: string, ano: number, mes: number): Promise<Record<string, EventoDoDia[]>> {
    // Meia-noite UTC nas duas pontas: coluna `@db.Date` volta como 00:00Z, e
    // meio-dia aqui cortaria eventos que começam ou terminam na borda do mês.
    const inicio = new Date(Date.UTC(ano, mes - 1, 1));
    const fim = new Date(Date.UTC(ano, mes, 0));

    let linhas: any[] = [];
    try {
      linhas = await this.tabela.findMany({
        where: {
          sellerId,
          canceladoAt: null,
          dataInicio: { lte: fim },
          dataFim: { gte: inicio },
        },
        select: {
          tipo: true, dataInicio: true, dataFim: true,
          diaInteiro: true, horaInicio: true, horaFim: true,
        },
      });
    } catch {
      // Tabela ainda não criada no banco (deploy em andamento): o espelho segue
      // funcionando como antes em vez de dar 500 na tela do RH.
      return {};
    }

    const mapa: Record<string, EventoDoDia[]> = {};
    for (const l of linhas) {
      const ini = new Date(l.dataInicio);
      const fimE = new Date(l.dataFim);
      for (let d = new Date(ini); d <= fimE; d.setUTCDate(d.getUTCDate() + 1)) {
        const chave = d.toISOString().slice(0, 10);
        (mapa[chave] ||= []).push({
          tipo: l.tipo,
          diaInteiro: l.diaInteiro,
          horaInicio: l.horaInicio,
          horaFim: l.horaFim,
        });
      }
    }
    return mapa;
  }

  // ── ANEXO ────────────────────────────────────────────────────────

  /**
   * Sobe o atestado e devolve o `documentoId` pro evento.
   *
   * O arquivo vai pro PRONTUÁRIO (`SellerDocument`), não pra uma pasta própria
   * do módulo: o RH já procura documento de funcionária num lugar só, e um
   * segundo lugar viraria "o atestado está no outro sistema".
   *
   * A categoria sai do TIPO, não de quem chama — categoria digitada é como o
   * mesmo atestado acaba arquivado em três gavetas diferentes.
   */
  async anexarDocumento(
    sellerId: string,
    file: any,
    input: { tipo?: string; titulo?: string; dataReferencia?: string | null },
    autorId: string | null,
  ) {
    const t = tipoEvento(input?.tipo);
    const categoria =
      t?.codigo === 'FERIAS' ? 'ferias' : t?.grupo === 'saude' ? 'atestado' : 'outro';

    const r: any = await this.docs.upload(
      sellerId,
      file,
      {
        categoria,
        titulo: input?.titulo || t?.label || 'Documento',
        dataReferencia: input?.dataReferencia ?? null,
      },
      autorId,
    );
    return { ok: true, documentoId: r?.document?.id ?? null, document: r?.document ?? null };
  }

  /**
   * ATESTADOS RECEBIDOS E AINDA NÃO LANÇADOS.
   *
   * É a caixa de entrada da supervisão. Nasceu pro atestado que a funcionária
   * manda pelo celular: sem esta lista o PDF entraria no prontuário e ficaria
   * lá parado, sem virar evento — e o dia dela seguiria como FALTA, que é
   * exatamente o problema que o módulo veio resolver.
   *
   * "Não lançado" = nenhum `SellerEvento` aponta pro documento.
   */
  async atestadosPendentes(dias = 60) {
    const desde = new Date(Date.now() - dias * 86_400_000);
    try {
      const docs = await (this.prisma as any).sellerDocument.findMany({
        where: {
          categoria: 'atestado',
          uploadedAt: { gte: desde },
          // `none` cobre o cancelado também: evento cancelado devolve o
          // atestado pra caixa de entrada, que é o certo — alguém cancelou
          // porque estava errado, e o papel continua valendo.
          eventos: { none: { canceladoAt: null } },
        },
        orderBy: { uploadedAt: 'desc' },
        take: 100,
        include: { seller: { select: { id: true, name: true, apelido: true } } },
      });
      return docs.map((d: any) => ({
        id: d.id,
        sellerId: d.sellerId,
        nome: d.seller?.name ?? '',
        titulo: d.titulo,
        fileUrl: d.fileUrl,
        dataReferencia: d.dataReferencia ? this.chaveData(d.dataReferencia) : null,
        observacoes: d.observacoes,
        uploadedAt: d.uploadedAt,
      }));
    } catch {
      return [];
    }
  }

  // ── FOLHA ────────────────────────────────────────────────────────

  /**
   * O QUE O MÊS DESCONTA, por funcionária.
   *
   * A régua do "faltou 1, perdeu 2" é pura (`descontoFolha`) e testada sem
   * banco: erro aqui sai do bolso da funcionária. Este método só junta os dias.
   *
   * Valor do dia = salário base ÷ 30 (dia de salário mensal, não hora de
   * jornada — o DSR descontado é um dia de REPOUSO, e repouso não tem jornada).
   */
  async descontosFolha(ano: number, mes: number, sellerId?: string) {
    const inicio = new Date(Date.UTC(ano, mes - 1, 1));
    const fim = new Date(Date.UTC(ano, mes, 0));

    let linhas: any[] = [];
    try {
      linhas = await (this.prisma as any).sellerEvento.findMany({
        where: {
          ...(sellerId ? { sellerId } : {}),
          canceladoAt: null,
          dataInicio: { lte: fim },
          dataFim: { gte: inicio },
        },
        select: {
          sellerId: true, tipo: true, dataInicio: true, dataFim: true,
          seller: { select: { id: true, name: true, salarioBase: true } },
        },
      });
    } catch {
      return { ano, mes, itens: [], totalDias: 0, totalValor: 0 };
    }

    // Expande evento → dias, recortando no mês pedido.
    const porSeller = new Map<string, { seller: any; dias: Array<{ data: string; tipo: string }> }>();
    for (const l of linhas) {
      const de = new Date(Math.max(new Date(l.dataInicio).getTime(), inicio.getTime()));
      const ate = new Date(Math.min(new Date(l.dataFim).getTime(), fim.getTime()));
      const alvo = porSeller.get(l.sellerId) ?? { seller: l.seller, dias: [] };
      for (const d = new Date(de); d <= ate; d.setUTCDate(d.getUTCDate() + 1)) {
        alvo.dias.push({ data: d.toISOString().slice(0, 10), tipo: l.tipo });
      }
      porSeller.set(l.sellerId, alvo);
    }

    const itens = [...porSeller.entries()]
      .map(([id, { seller, dias }]) => {
        const d = descontoFolha(dias);
        const salario = Number(seller?.salarioBase ?? 0);
        const valorDia = salario > 0 ? salario / 30 : 0;
        return {
          sellerId: id,
          nome: seller?.name ?? '',
          salarioBase: salario,
          diasDescontados: d.diasDescontados,
          dsrPerdidos: d.dsrPerdidos,
          diasTotais: d.diasTotais,
          semanas: d.semanas,
          valorDia: Math.round(valorDia * 100) / 100,
          valorDesconto: Math.round(d.diasTotais * valorDia * 100) / 100,
        };
      })
      // Mês sem desconto não é linha: a lista é do que a folha tem que fazer.
      .filter((i) => i.diasTotais > 0)
      .sort((a, b) => b.valorDesconto - a.valorDesconto);

    return {
      ano,
      mes,
      itens,
      totalDias: itens.reduce((s, i) => s + i.diasTotais, 0),
      totalValor: Math.round(itens.reduce((s, i) => s + i.valorDesconto, 0) * 100) / 100,
    };
  }

  /**
   * FALTAS INJUSTIFICADAS num período — é o número do art. 130 que o
   * `ferias-clt.ts` avisa no cabeçalho que não tinha.
   */
  async faltasInjustificadas(sellerId: string, deBruto: Date, ateBruto: Date): Promise<number> {
    // Alinha nas bordas do dia UTC: a contagem é `(fim - início) / 1 dia + 1`, e
    // qualquer resto de hora faria um `Math.round` engolir ou inventar um dia.
    const de = new Date(`${new Date(deBruto).toISOString().slice(0, 10)}T00:00:00.000Z`);
    const ate = new Date(`${new Date(ateBruto).toISOString().slice(0, 10)}T00:00:00.000Z`);
    try {
      const linhas = await this.tabela.findMany({
        where: {
          sellerId,
          canceladoAt: null,
          dataInicio: { lte: ate },
          dataFim: { gte: de },
        },
        select: { tipo: true, dataInicio: true, dataFim: true },
      });
      let dias = 0;
      for (const l of linhas) {
        if (!tipoEvento(l.tipo)?.contaArt130) continue;
        const ini = new Date(Math.max(new Date(l.dataInicio).getTime(), de.getTime()));
        const fim = new Date(Math.min(new Date(l.dataFim).getTime(), ate.getTime()));
        dias += Math.round((fim.getTime() - ini.getTime()) / 86_400_000) + 1;
      }
      return dias;
    } catch {
      return 0;
    }
  }
}
