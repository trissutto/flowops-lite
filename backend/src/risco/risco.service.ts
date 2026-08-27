import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { pedidoCancelado, pedidoPago } from '../common/pedido-pago';
import { RiscoChavesService, TipoChave } from './risco-chaves.service';
import { NivelRisco, RiscoPesos, RiscoPesosService } from './risco-pesos.service';

/**
 * O MOTOR — "este pedido tem relação com pedido anterior que deu problema?"
 *
 * Três compromissos que vêm do documento e que o código tem que honrar linha a
 * linha:
 *
 *   1. NUNCA afirmar fraude. O módulo devolve RELAÇÃO e INDÍCIO. A palavra
 *      "fraude" não aparece em nenhum texto gerado aqui.
 *   2. NUNCA mostrar score sem motivo (item 24). Por isso `motivos` é a saída
 *      principal e `score` é só o resumo dela — se um dia discordarem, quem
 *      manda é a lista.
 *   3. NUNCA mexer no pedido (ordem do dono, 27/08). Nada aqui escreve em
 *      `orders`: não muda status, não cancela, não tira da fila, não toca
 *      estoque. Alerta e registra decisão humana.
 */

export type CorMotivo = 'vermelho' | 'laranja' | 'amarelo';

export interface MotivoRisco {
  /** Identificador estável da regra — a tela não depende do texto. */
  chave: string;
  cor: CorMotivo;
  texto: string;
  peso: number;
  /** Números dos pedidos que geraram este motivo. */
  pedidos: string[];
}

export type SituacaoRelacionado = 'chargeback' | 'cancelado' | 'nao_pago' | 'pago';

export interface PedidoRelacionado {
  id: string;
  /**
   * O id NUMÉRICO do pedido — é por ele que a rota `/pedidos/wc/[id]` abre a
   * tela, não pelo número impresso. Sem isto o link do pedido relacionado
   * apontaria pra "/pedidos/wc/LP-000129" e cairia em 404: exatamente o
   * clique que o analista mais vai dar.
   */
  wcOrderId: number | null;
  numero: string;
  data: string | null;
  cliente: string | null;
  valor: number | null;
  /** Rótulos legíveis do que casou: ['telefone', 'endereço']. */
  relacao: string[];
  situacao: SituacaoRelacionado;
  situacaoTexto: string;
  chargebackStatus: string | null;
}

export interface AnaliseRisco {
  ativo: boolean;
  orderId: string;
  numero: string | null;
  score: number;
  nivel: NivelRisco;
  resumo: string;
  motivos: MotivoRisco[];
  relacionados: PedidoRelacionado[];
  chargebacksRelacionados: number;
  /** Chaves que o pedido tem — pra tela mostrar o que dá e o que não dá cruzar. */
  chaves: Array<{ tipo: TipoChave; rotulo: string }>;
  /** Chaves ignoradas por serem difusas demais (ver CHAVE_DIFUSA_LIMITE). */
  chavesIgnoradas: string[];
  status: string;
  responsavel: string | null;
  observacao: string | null;
  analisadoEm: Date | null;
  calculadoEm: Date;
}

const ROTULO: Record<string, string> = {
  cpf: 'CPF',
  email: 'e-mail',
  telefone: 'telefone',
  endereco: 'endereço',
  cep_numero: 'CEP + número',
  cartao: 'cartão',
  titular: 'titular do cartão',
  ip: 'IP',
  aparelho: 'aparelho',
};

/**
 * CHAVE QUE BATE EM MUITA GENTE NÃO IDENTIFICA NINGUÉM.
 *
 * IP de operadora móvel, NAT de prédio, e-mail de condomínio: uma chave dessas
 * liga dezenas de pedidos sem relação nenhuma e, sem trava, viraria um
 * "CRÍTICO" pra toda cliente que compra do mesmo bairro. Passou daqui, a chave
 * é DESCARTADA do cruzamento e aparece na tela como ignorada — o analista vê
 * que ela existe e por que não contou.
 */
const CHAVE_DIFUSA_LIMITE = 30;

/** Chaves que servem de âncora pras regras de multiplicidade (itens 5, 6, 7). */
const ANCORAS: TipoChave[] = ['telefone', 'endereco', 'cep_numero'];

@Injectable()
export class RiscoService {
  private readonly logger = new Logger(RiscoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly chavesSvc: RiscoChavesService,
    private readonly pesosSvc: RiscoPesosService,
  ) {}

  /**
   * A análise completa de um pedido. Recalcula do zero — é barato (todas as
   * consultas entram por índice) e evita o pior dos mundos, que é a tela
   * mostrar um score congelado de antes do chargeback ter sido registrado.
   */
  async analisar(orderId: string, opts: { persistir?: boolean } = {}): Promise<AnaliseRisco> {
    const pesos = await this.pesosSvc.get();
    const order = await (this.prisma as any).order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        wcOrderNumber: true,
        customerCpf: true,
        customerEmail: true,
        createdAt: true,
        wcDateCreated: true,
      },
    });
    if (!order) throw new Error(`Pedido ${orderId} não encontrado`);

    const analiseSalva = await (this.prisma as any).orderRiskAnalysis.findUnique({
      where: { orderId },
    });

    const base = {
      ativo: pesos.ativo,
      orderId,
      numero: order.wcOrderNumber || null,
      status: analiseSalva?.status || 'aguardando',
      responsavel: analiseSalva?.responsavel || null,
      observacao: analiseSalva?.observacao || null,
      analisadoEm: analiseSalva?.analisadoEm || null,
      calculadoEm: new Date(),
    };

    if (!pesos.ativo) {
      return {
        ...base,
        score: 0,
        nivel: 'baixo',
        resumo: 'Análise de risco desligada na configuração.',
        motivos: [],
        relacionados: [],
        chargebacksRelacionados: 0,
        chaves: [],
        chavesIgnoradas: [],
      };
    }

    // ── 1. As chaves deste pedido ────────────────────────────────────────
    const chaves: Array<{ tipo: TipoChave; valor: string }> = await (
      this.prisma as any
    ).orderRiskKey.findMany({
      where: { orderId },
      select: { tipo: true, valor: true },
    });

    if (!chaves.length) {
      return {
        ...base,
        score: 0,
        nivel: 'baixo',
        resumo: 'Este pedido não tem dado suficiente pra cruzar com outros.',
        motivos: [],
        relacionados: [],
        chargebacksRelacionados: 0,
        chaves: [],
        chavesIgnoradas: [],
      };
    }

    // ── 2. Quem mais tem essas chaves ────────────────────────────────────
    const desde =
      pesos.janelaDias > 0
        ? new Date(Date.now() - pesos.janelaDias * 24 * 60 * 60 * 1000)
        : new Date(0);

    const batidas: Array<{ tipo: TipoChave; valor: string; orderId: string }> = await (
      this.prisma as any
    ).orderRiskKey.findMany({
      where: {
        OR: chaves.map((c) => ({ tipo: c.tipo, valor: c.valor })),
        orderId: { not: orderId },
        pedidoEm: { gte: desde },
      },
      select: { tipo: true, valor: true, orderId: true },
      // Teto duro: chave difusa não pode fazer a consulta trazer meia base.
      take: CHAVE_DIFUSA_LIMITE * chaves.length + 1,
    });

    // Chave difusa cai fora antes de qualquer conta.
    const porChave = new Map<string, Set<string>>();
    for (const b of batidas) {
      const k = `${b.tipo}:${b.valor}`;
      if (!porChave.has(k)) porChave.set(k, new Set());
      porChave.get(k)!.add(b.orderId);
    }
    const chavesIgnoradas: string[] = [];
    const difusas = new Set<string>();
    for (const [k, pedidos] of porChave) {
      if (pedidos.size > CHAVE_DIFUSA_LIMITE) {
        difusas.add(k);
        const tipo = k.split(':')[0];
        chavesIgnoradas.push(
          `${ROTULO[tipo] || tipo} — bate em ${pedidos.size} pedidos, difuso demais pra dizer alguma coisa`,
        );
      }
    }

    const uteis = batidas.filter((b) => !difusas.has(`${b.tipo}:${b.valor}`));
    if (!uteis.length) {
      return {
        ...base,
        score: 0,
        nivel: 'baixo',
        resumo: 'Nenhum pedido anterior tem relação com este.',
        motivos: [],
        relacionados: [],
        chargebacksRelacionados: 0,
        chaves: this.listarChaves(chaves),
        chavesIgnoradas,
      };
    }

    // ── 3. Os pedidos relacionados, com situação ─────────────────────────
    const idsRelacionados = Array.from(new Set(uteis.map((u) => u.orderId))).slice(
      0,
      pesos.maxRelacionados,
    );

    const pedidos: any[] = await (this.prisma as any).order.findMany({
      where: { id: { in: idsRelacionados } },
      select: {
        id: true,
        wcOrderId: true,
        wcOrderNumber: true,
        customerName: true,
        customerCpf: true,
        customerEmail: true,
        totalAmount: true,
        status: true,
        source: true,
        paidAt: true,
        createdAt: true,
        wcDateCreated: true,
        chargebacks: { select: { id: true, status: true, fraude: true, abertoEm: true } },
      },
    });
    const porId = new Map(pedidos.map((p) => [p.id, p]));

    /** tipo de chave → ids de pedidos relacionados por ela. */
    const porTipo = new Map<TipoChave, Set<string>>();
    for (const u of uteis) {
      if (!porId.has(u.orderId)) continue;
      if (!porTipo.has(u.tipo)) porTipo.set(u.tipo, new Set());
      porTipo.get(u.tipo)!.add(u.orderId);
    }

    const comChargeback = new Set(
      pedidos.filter((p) => (p.chargebacks || []).length > 0).map((p) => p.id),
    );

    const relacionados: PedidoRelacionado[] = pedidos
      .map((p) => {
        const rel = Array.from(porTipo.entries())
          .filter(([, ids]) => ids.has(p.id))
          .map(([tipo]) => ROTULO[tipo] || tipo);
        const cb = (p.chargebacks || [])[0];
        const situacao: SituacaoRelacionado = cb
          ? 'chargeback'
          : pedidoCancelado(p)
            ? 'cancelado'
            : pedidoPago(p)
              ? 'pago'
              : 'nao_pago';
        return {
          id: p.id,
          wcOrderId: p.wcOrderId ?? null,
          numero: p.wcOrderNumber || p.id.slice(-8),
          data: (p.wcDateCreated || p.createdAt || null)?.toISOString?.() || null,
          cliente: p.customerName || null,
          valor: p.totalAmount ?? null,
          relacao: rel,
          situacao,
          situacaoTexto: this.textoSituacao(situacao, cb?.status),
          chargebackStatus: cb?.status || null,
        };
      })
      .sort((a, b) => {
        // Chargeback primeiro — é o que o analista precisa ver sem rolar tela.
        const peso = { chargeback: 0, cancelado: 1, nao_pago: 2, pago: 3 };
        const d = peso[a.situacao] - peso[b.situacao];
        return d !== 0 ? d : String(b.data || '').localeCompare(String(a.data || ''));
      });

    // ── 4. Motivos e score ───────────────────────────────────────────────
    const { motivos, score } = await this.montarMotivos({
      order,
      pesos,
      porTipo,
      comChargeback,
      porId,
      chaves,
      idsRelacionados,
    });

    const nivel = this.pesosSvc.nivel(score, pesos);
    const nCb = relacionados.filter((r) => r.situacao === 'chargeback').length;
    const resumo = this.montarResumo(relacionados.length, nCb);

    const analise: AnaliseRisco = {
      ...base,
      score,
      nivel,
      resumo,
      motivos,
      relacionados,
      chargebacksRelacionados: nCb,
      chaves: this.listarChaves(chaves),
      chavesIgnoradas,
    };

    if (opts.persistir !== false) await this.persistir(analise);
    return analise;
  }

  /**
   * As REGRAS, uma por uma. Cada uma vira no máximo um motivo, e cada motivo
   * pontua uma vez só — é a "duplicidade de pontuação" que o item 4 manda
   * evitar.
   */
  private async montarMotivos(ctx: {
    order: any;
    pesos: RiscoPesos;
    porTipo: Map<TipoChave, Set<string>>;
    comChargeback: Set<string>;
    porId: Map<string, any>;
    chaves: Array<{ tipo: TipoChave; valor: string }>;
    idsRelacionados: string[];
  }): Promise<{ motivos: MotivoRisco[]; score: number }> {
    const { pesos, porTipo, comChargeback, porId, order } = ctx;
    const motivos: MotivoRisco[] = [];
    const num = (id: string) => porId.get(id)?.wcOrderNumber || id.slice(-8);

    /** Pedidos COM chargeback alcançados por um tipo de chave. */
    const cbPor = (tipo: TipoChave): Set<string> => {
      const ids = porTipo.get(tipo);
      if (!ids) return new Set();
      return new Set(Array.from(ids).filter((id) => comChargeback.has(id)));
    };

    /**
     * REINCIDÊNCIA — dois pedidos contestados no mesmo dado pesam mais que um.
     *
     * Sem isto o motor empata "azar" com "padrão": o telefone que aparece em
     * UM chargeback vale o mesmo que o que aparece em TRÊS. O bônus é por
     * ocorrência adicional e tem teto, pra reincidência não virar sozinha um
     * score máximo automático.
     */
    const comReincidencia = (base: number, quantos: number): number => {
      if (quantos <= 1) return base;
      const mult = Math.min(
        1 + (pesos.reincidenciaBonus / 100) * (quantos - 1),
        pesos.reincidenciaTeto,
      );
      return Math.round(base * mult);
    };

    const cbCpf = cbPor('cpf');
    const cbEmail = cbPor('email');
    const cbTel = cbPor('telefone');
    const cbCartao = cbPor('cartao');
    const cbTitular = cbPor('titular');
    const cbAparelho = cbPor('aparelho');
    const cbIp = cbPor('ip');
    // Endereço textual e CEP+número são a MESMA informação por dois caminhos —
    // pontuar os dois seria contar a mesma casa duas vezes.
    const cbEnd = new Set([...cbPor('endereco'), ...cbPor('cep_numero')]);

    // ── COMBO telefone + endereço ────────────────────────────────────────
    // Substitui os dois pesos individuais nos pedidos onde os dois batem.
    const comboIds = new Set(Array.from(cbTel).filter((id) => cbEnd.has(id)));
    if (comboIds.size) {
      motivos.push({
        chave: 'combo_telefone_endereco',
        cor: 'vermelho',
        peso: comReincidencia(pesos.comboTelefoneEndereco, comboIds.size),
        texto: `Telefone E endereço batem ${comboIds.size === 1 ? 'no mesmo pedido' : `nos mesmos ${comboIds.size} pedidos`} com chargeback`,
        pedidos: Array.from(comboIds).map(num),
      });
      for (const id of comboIds) {
        cbTel.delete(id);
        cbEnd.delete(id);
      }
    }

    // ── CADASTRO NOVO no mesmo telefone/endereço ─────────────────────────
    // O padrão exato do exemplo do documento: mesma casa, mesmo celular, ficha
    // nova pra escapar do casamento por CPF.
    const ancoraCb = new Set([...comboIds, ...cbTel, ...cbEnd]);
    const cpfAtual = String(order.customerCpf || '').replace(/\D/g, '');
    const emailAtual = String(order.customerEmail || '').trim().toLowerCase();
    const cadastroNovo = Array.from(ancoraCb).filter((id) => {
      const p = porId.get(id);
      if (!p) return false;
      const outroCpf = String(p.customerCpf || '').replace(/\D/g, '');
      const outroEmail = String(p.customerEmail || '').trim().toLowerCase();
      const cpfDiferente = !!cpfAtual && !!outroCpf && cpfAtual !== outroCpf;
      const emailDiferente = !!emailAtual && !!outroEmail && emailAtual !== outroEmail;
      return cpfDiferente || emailDiferente;
    });
    if (cadastroNovo.length) {
      motivos.push({
        chave: 'combo_cadastro_novo',
        cor: 'vermelho',
        peso: pesos.comboCadastroNovo,
        texto:
          'Dados cadastrais DIFERENTES (CPF ou e-mail) usando o mesmo telefone/endereço de pedido com chargeback',
        pedidos: cadastroNovo.map(num),
      });
    }

    // ── Relações diretas com chargeback ──────────────────────────────────
    const direta = (
      chave: string,
      ids: Set<string>,
      peso: number,
      rotulo: string,
      cor: CorMotivo = 'vermelho',
    ) => {
      if (!ids.size) return;
      motivos.push({
        chave,
        cor,
        peso: comReincidencia(peso, ids.size),
        texto: `${rotulo} relacionado a ${this.plural(ids.size, 'pedido', 'pedidos')} com chargeback`,
        pedidos: Array.from(ids).map(num),
      });
    };

    direta('cb_cpf', cbCpf, pesos.cbCpf, 'CPF');
    direta('cb_telefone', cbTel, pesos.cbTelefone, 'Telefone');
    direta('cb_endereco', cbEnd, pesos.cbEndereco, 'Endereço');
    direta('cb_cartao', cbCartao, pesos.cbCartao, 'Cartão');
    direta('cb_titular', cbTitular, pesos.cbTitular, 'Titular do cartão');
    direta('cb_aparelho', cbAparelho, pesos.cbAparelho, 'Aparelho');
    direta('cb_email', cbEmail, pesos.cbEmail, 'E-mail', 'laranja');
    direta('cb_ip', cbIp, pesos.cbIp, 'IP', 'amarelo');

    // ── Multiplicidade (itens 5, 6 e 7) ──────────────────────────────────
    const multi = await this.multiplicidade(ctx);
    motivos.push(...multi);

    // ── Relação SEM ocorrência — contexto, peso zero ─────────────────────
    // O item 3 manda mostrar exatamente o que gerou a relação. Pedido anterior
    // limpo é justamente o que costuma inocentar a cliente: "sim, é o mesmo
    // endereço, e os outros 4 pedidos de lá foram todos entregues".
    for (const [tipo, ids] of porTipo) {
      const semOcorrencia = Array.from(ids).filter((id) => !comChargeback.has(id));
      if (!semOcorrencia.length) continue;
      motivos.push({
        chave: `rel_${tipo}`,
        cor: 'amarelo',
        peso: 0,
        texto: `${this.maiuscula(ROTULO[tipo] || tipo)} relacionado a ${this.plural(
          semOcorrencia.length,
          'pedido anterior',
          'pedidos anteriores',
        )} sem ocorrência`,
        pedidos: semOcorrencia.map(num),
      });
    }

    motivos.sort((a, b) => b.peso - a.peso);
    const score = Math.min(
      100,
      motivos.reduce((s, m) => s + m.peso, 0),
    );
    return { motivos, score };
  }

  /**
   * ITENS 5, 6 e 7 — "mesmo endereço/telefone usado por gente diferente" e
   * "vários cartões no mesmo conjunto de dados".
   *
   * Não depende de chargeback: é padrão que merece o olho humano por si só. E
   * é exatamente onde mora o risco de acusar inocente — mãe e filha dividem
   * telefone, marido e esposa dividem endereço e usam cartões diferentes. Por
   * isso o texto gerado aqui é sempre descritivo ("foram identificados"),
   * nunca conclusivo, e o peso é menor que o de uma relação com chargeback.
   */
  private async multiplicidade(ctx: {
    pesos: RiscoPesos;
    porTipo: Map<TipoChave, Set<string>>;
    chaves: Array<{ tipo: TipoChave; valor: string }>;
    idsRelacionados: string[];
    porId: Map<string, any>;
  }): Promise<MotivoRisco[]> {
    const { pesos, porTipo, idsRelacionados, porId } = ctx;
    const motivos: MotivoRisco[] = [];

    // Só os pedidos ligados a este por uma ÂNCORA (telefone/endereço).
    const ancorados = new Set<string>();
    for (const a of ANCORAS) for (const id of porTipo.get(a) || []) ancorados.add(id);
    if (!ancorados.size) return motivos;

    const desde = new Date(Date.now() - pesos.multiJanelaDias * 24 * 60 * 60 * 1000);
    const dentroDaJanela = Array.from(ancorados).filter((id) => {
      const p = porId.get(id);
      const d = p?.wcDateCreated || p?.createdAt;
      return d ? new Date(d) >= desde : false;
    });
    if (!dentroDaJanela.length) return motivos;

    // Todas as chaves dos pedidos ancorados + as deste pedido.
    const todas: Array<{ tipo: TipoChave; valor: string; orderId: string }> = await (
      this.prisma as any
    ).orderRiskKey.findMany({
      where: { orderId: { in: dentroDaJanela.slice(0, pesos.maxRelacionados) } },
      select: { tipo: true, valor: true, orderId: true },
    });

    const distintos = (tipo: TipoChave) => {
      const set = new Set<string>();
      for (const t of todas) if (t.tipo === tipo) set.add(t.valor);
      for (const c of ctx.chaves) if (c.tipo === tipo) set.add(c.valor);
      return set;
    };

    const regra = (
      tipo: TipoChave,
      peso: number,
      chave: string,
      singular: string,
      plural: string,
    ) => {
      const set = distintos(tipo);
      if (set.size < pesos.multiMinimo) return;
      motivos.push({
        chave,
        cor: 'laranja',
        peso,
        texto: `Foram identificados ${set.size} ${set.size === 1 ? singular : plural} no mesmo telefone/endereço nos últimos ${pesos.multiJanelaDias} dias`,
        pedidos: dentroDaJanela.map((id) => porId.get(id)?.wcOrderNumber || id.slice(-8)),
      });
    };

    regra('cartao', pesos.multiCartoes, 'multi_cartoes', 'cartão diferente', 'cartões diferentes');
    regra('cpf', pesos.multiCpfs, 'multi_cpfs', 'CPF diferente', 'CPFs diferentes');
    regra('email', pesos.multiEmails, 'multi_emails', 'e-mail diferente', 'e-mails diferentes');

    return motivos;
  }

  private async persistir(a: AnaliseRisco): Promise<void> {
    try {
      await (this.prisma as any).orderRiskAnalysis.upsert({
        where: { orderId: a.orderId },
        create: {
          orderId: a.orderId,
          score: a.score,
          nivel: a.nivel,
          motivos: a.motivos as any,
          relacionados: a.relacionados as any,
          calculadoEm: a.calculadoEm,
        },
        update: {
          score: a.score,
          nivel: a.nivel,
          motivos: a.motivos as any,
          relacionados: a.relacionados as any,
          calculadoEm: a.calculadoEm,
        },
      });
    } catch (e: any) {
      this.logger.warn(`[risco] análise não persistiu pedido=${a.orderId}: ${e?.message || e}`);
    }
  }

  /**
   * DE QUALQUER JEITO QUE A TELA TENHA O PEDIDO NA MÃO.
   *
   * A tela do pedido do site navega por `wcOrderId` (o número do site, que
   * no pedido nativo é sintético) — ela não tem o UUID. A matriz, por sua
   * vez, tem o NÚMERO impresso ("LP-000129"). Resolver os três aqui evita
   * espalhar essa tradução por cada chamador.
   */
  async resolverOrderId(ref: string): Promise<string> {
    const r = String(ref || '').trim();
    if (!r) throw new NotFoundException('Pedido não informado');

    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(r)) return r;

    if (/^d+$/.test(r)) {
      const porWc = await (this.prisma as any).order.findUnique({
        where: { wcOrderId: Number(r) },
        select: { id: true },
      });
      if (porWc) return porWc.id;
    }

    const porNumero = await (this.prisma as any).order.findFirst({
      where: { wcOrderNumber: r },
      select: { id: true },
    });
    if (porNumero) return porNumero.id;

    throw new NotFoundException(`Pedido "${r}" não encontrado`);
  }

  /**
   * Recalcula um pedido do zero, garantindo as chaves antes. É o caminho que
   * a tela usa: pedido antigo que nunca passou pelo backfill ganha chave na
   * hora em que alguém abre a análise dele.
   */
  async recalcular(orderId: string): Promise<AnaliseRisco> {
    await this.chavesSvc.gravarChavesSeguro(orderId);
    return this.analisar(orderId);
  }

  private listarChaves(chaves: Array<{ tipo: TipoChave; valor: string }>) {
    const vistos = new Set<TipoChave>();
    const saida: Array<{ tipo: TipoChave; rotulo: string }> = [];
    for (const c of chaves) {
      if (vistos.has(c.tipo)) continue;
      vistos.add(c.tipo);
      saida.push({ tipo: c.tipo, rotulo: ROTULO[c.tipo] || c.tipo });
    }
    return saida;
  }

  private montarResumo(relacionados: number, chargebacks: number): string {
    if (!relacionados) return 'Nenhum pedido anterior tem relação com este.';
    const rel = `Este pedido tem ${this.plural(relacionados, 'relação', 'relações')} com ${
      relacionados === 1 ? 'um pedido anterior' : 'pedidos anteriores'
    }.`;
    if (!chargebacks) return rel;
    return `${rel} ${this.plural(chargebacks, 'Um deles sofreu', 'Deles sofreram')} chargeback.`;
  }

  private textoSituacao(s: SituacaoRelacionado, cbStatus?: string | null): string {
    if (s === 'chargeback') {
      const mapa: Record<string, string> = {
        em_analise: 'Chargeback em análise',
        contestado: 'Chargeback contestado',
        ganho: 'Chargeback ganho',
        perdido: 'Chargeback perdido',
        encerrado: 'Chargeback encerrado',
      };
      return mapa[String(cbStatus || '')] || 'Chargeback';
    }
    if (s === 'cancelado') return 'Cancelado';
    if (s === 'nao_pago') return 'Não pago';
    return 'Pago';
  }

  private plural(n: number, singular: string, plural: string): string {
    return `${n} ${n === 1 ? singular : plural}`;
  }

  private maiuscula(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
}
