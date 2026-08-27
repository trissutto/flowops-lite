import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RiscoService } from './risco.service';
import { RiscoChavesService } from './risco-chaves.service';

/**
 * CHARGEBACK — a contestação que o banco da cliente abriu contra a venda.
 *
 * DUAS PORTAS DE ENTRADA, de propósito:
 *
 *   webhook  → a Pagar.me avisa. Barato e imediato, mas cobre só o cartão do
 *              site que passa por ela.
 *   manual   → a matriz cadastra. Existe porque contestação também chega por
 *              e-mail do adquirente, por carta e pelo painel da Stone/PagBank
 *              — e chargeback que o sistema não conhece não ensina nada aos
 *              pedidos seguintes. Sem esta porta o módulo inteiro nasceria
 *              dependendo de um canal só.
 *
 * REGISTRAR UM CHARGEBACK REAVALIA A VIZINHANÇA (item 15): assim que a
 * ocorrência entra, os pedidos que compartilham telefone, endereço, cartão ou
 * aparelho com ele são recalculados. É o que faz o pedido de amanhã já nascer
 * sabendo.
 */

export interface ChargebackInput {
  orderId?: string | null;
  /** Aceita o NÚMERO do pedido (LP-000129) além do id — é o que a matriz tem na mão. */
  numeroPedido?: string | null;
  saleId?: string | null;
  status?: string;
  abertoEm?: string | Date;
  valor?: number;
  motivo?: string | null;
  fraude?: boolean;
  transacaoId?: string | null;
  plataforma?: string | null;
  resultado?: string | null;
  observacoes?: string | null;
  documentos?: Array<{ nome: string; url: string }> | null;
}

const STATUS_VALIDOS = ['em_analise', 'contestado', 'ganho', 'perdido', 'encerrado'] as const;

/** Quantos pedidos vizinhos são recalculados quando um chargeback entra. */
const TETO_REAVALIACAO = 100;

@Injectable()
export class ChargebackService {
  private readonly logger = new Logger(ChargebackService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly risco: RiscoService,
    private readonly chaves: RiscoChavesService,
  ) {}

  async registrar(input: ChargebackInput, autor?: string, origem: 'manual' | 'webhook' = 'manual') {
    const orderId = await this.resolverPedido(input);
    if (!orderId && !input.saleId) {
      throw new BadRequestException(
        'Informe o pedido (número ou id) ou a venda do PDV a que o chargeback se refere.',
      );
    }

    const status = this.validarStatus(input.status);
    const valor = Number(input.valor);
    if (!Number.isFinite(valor) || valor <= 0) {
      throw new BadRequestException('Informe o valor contestado.');
    }

    const cb = await (this.prisma as any).chargeback.create({
      data: {
        orderId: orderId || null,
        saleId: input.saleId || null,
        status,
        abertoEm: input.abertoEm ? new Date(input.abertoEm) : new Date(),
        valor,
        motivo: this.texto(input.motivo, 200),
        fraude: input.fraude === true,
        transacaoId: this.texto(input.transacaoId, 120),
        plataforma: this.texto(input.plataforma, 30),
        resultado: this.texto(input.resultado, 200),
        observacoes: input.observacoes ? String(input.observacoes) : null,
        documentos: (input.documentos as any) ?? undefined,
        origem,
        registradoPor: autor || null,
      },
    });

    if (orderId) {
      await this.trilha(orderId, 'chargeback', `Chargeback registrado (${origem}): ${status}`, autor);
      void this.reavaliarVizinhanca(orderId).catch(() => {
        /* o recálculo é oportunista — a tela recalcula ao abrir de qualquer jeito */
      });
    }

    this.logger.log(
      `[risco] chargeback ${cb.id} pedido=${orderId || '—'} valor=${valor} origem=${origem}`,
    );
    return cb;
  }

  async atualizar(id: string, input: Partial<ChargebackInput>, autor?: string) {
    const atual = await (this.prisma as any).chargeback.findUnique({ where: { id } });
    if (!atual) throw new NotFoundException('Chargeback não encontrado');

    const dados: any = {};
    if (input.status !== undefined) dados.status = this.validarStatus(input.status);
    if (input.valor !== undefined) {
      const v = Number(input.valor);
      if (Number.isFinite(v) && v > 0) dados.valor = v;
    }
    if (input.abertoEm !== undefined) dados.abertoEm = new Date(input.abertoEm);
    if (input.motivo !== undefined) dados.motivo = this.texto(input.motivo, 200);
    if (input.fraude !== undefined) dados.fraude = input.fraude === true;
    if (input.transacaoId !== undefined) dados.transacaoId = this.texto(input.transacaoId, 120);
    if (input.plataforma !== undefined) dados.plataforma = this.texto(input.plataforma, 30);
    if (input.resultado !== undefined) dados.resultado = this.texto(input.resultado, 200);
    if (input.observacoes !== undefined) {
      dados.observacoes = input.observacoes ? String(input.observacoes) : null;
    }
    if (input.documentos !== undefined) dados.documentos = (input.documentos as any) ?? null;

    const cb = await (this.prisma as any).chargeback.update({ where: { id }, data: dados });

    if (cb.orderId && dados.status && dados.status !== atual.status) {
      await this.trilha(
        cb.orderId,
        'chargeback',
        `Chargeback ${atual.status} → ${dados.status}`,
        autor,
      );
    }
    return cb;
  }

  async remover(id: string, autor?: string) {
    const cb = await (this.prisma as any).chargeback.findUnique({ where: { id } });
    if (!cb) throw new NotFoundException('Chargeback não encontrado');
    await (this.prisma as any).chargeback.delete({ where: { id } });
    if (cb.orderId) {
      await this.trilha(cb.orderId, 'chargeback', 'Chargeback removido', autor);
      void this.reavaliarVizinhanca(cb.orderId).catch(() => {});
    }
    return { ok: true };
  }

  async listar(filtros: {
    status?: string;
    de?: string;
    ate?: string;
    busca?: string;
    limite?: number;
  }) {
    const where: any = {};
    if (filtros.status && filtros.status !== 'todos') where.status = filtros.status;
    if (filtros.de || filtros.ate) {
      where.abertoEm = {};
      if (filtros.de) where.abertoEm.gte = new Date(`${filtros.de}T00:00:00`);
      if (filtros.ate) where.abertoEm.lte = new Date(`${filtros.ate}T23:59:59`);
    }
    if (filtros.busca) {
      const b = String(filtros.busca).trim();
      where.OR = [
        { transacaoId: { contains: b, mode: 'insensitive' } },
        { motivo: { contains: b, mode: 'insensitive' } },
        { order: { wcOrderNumber: { contains: b, mode: 'insensitive' } } },
        { order: { customerName: { contains: b, mode: 'insensitive' } } },
      ];
    }

    const linhas = await (this.prisma as any).chargeback.findMany({
      where,
      orderBy: { abertoEm: 'desc' },
      take: Math.min(Math.max(Number(filtros.limite) || 200, 1), 1000),
      include: {
        order: {
          select: {
            id: true,
            wcOrderId: true,
            wcOrderNumber: true,
            customerName: true,
            customerCpf: true,
            customerPhone: true,
            totalAmount: true,
          },
        },
      },
    });
    return { total: linhas.length, chargebacks: linhas };
  }

  /**
   * Os números do item 19 que vêm daqui: quantidade e DINHEIRO por desfecho.
   * "Valor recuperado" é o que a gente ganhou na contestação; "perdido" é o
   * que saiu da conta. Sem separar os dois, o total não diz nada.
   */
  async resumo(de?: string, ate?: string) {
    const where: any = {};
    if (de || ate) {
      where.abertoEm = {};
      if (de) where.abertoEm.gte = new Date(`${de}T00:00:00`);
      if (ate) where.abertoEm.lte = new Date(`${ate}T23:59:59`);
    }
    const linhas: any[] = await (this.prisma as any).chargeback.findMany({
      where,
      select: { status: true, valor: true, fraude: true },
    });

    const soma = (f: (l: any) => boolean) =>
      linhas.filter(f).reduce((s, l) => s + Number(l.valor || 0), 0);
    const conta = (f: (l: any) => boolean) => linhas.filter(f).length;

    return {
      total: linhas.length,
      valorTotal: soma(() => true),
      emAnalise: conta((l) => l.status === 'em_analise'),
      contestados: conta((l) => l.status === 'contestado'),
      ganhos: conta((l) => l.status === 'ganho'),
      perdidos: conta((l) => l.status === 'perdido'),
      encerrados: conta((l) => l.status === 'encerrado'),
      valorRecuperado: soma((l) => l.status === 'ganho'),
      valorPerdido: soma((l) => l.status === 'perdido'),
      emDisputa: soma((l) => l.status === 'em_analise' || l.status === 'contestado'),
      porFraude: conta((l) => l.fraude === true),
    };
  }

  /** Os chargebacks de um pedido — pro painel e pro dossiê. */
  async doPedido(orderId: string) {
    return (this.prisma as any).chargeback.findMany({
      where: { orderId },
      orderBy: { abertoEm: 'desc' },
    });
  }

  /**
   * WEBHOOK DA PAGAR.ME.
   *
   * ⚠️ O `orderId` vem do `PagarmePayment` resolvido pelo `handleWebhook` —
   * NUNCA do `metadata` do corpo. É a mesma trava que existe na confirmação de
   * pagamento e que nasceu de um buraco real: aceitar o metadata cru deixava
   * qualquer POST sem assinatura mexer num pedido cujo UUID é público.
   *
   * O nome do evento varia por versão/configuração da conta, então o
   * reconhecimento é por PADRÃO ('chargeback', 'chargedback', 'dispute') em
   * vez de lista fechada — evento novo não passa despercebido só por ter
   * ganhado um sufixo.
   */
  ehEventoDeChargeback(eventType: string): boolean {
    const e = String(eventType || '').toLowerCase();
    return e.includes('chargeback') || e.includes('chargedback') || e.includes('dispute');
  }

  async doWebhook(eventType: string, orderId: string, corpo: any): Promise<void> {
    const pedido = await (this.prisma as any).order.findUnique({
      where: { id: orderId },
      select: { id: true, totalAmount: true },
    });
    if (!pedido) return;

    const dados = corpo?.data || {};
    const transacaoId =
      dados?.last_transaction?.acquirer_tid ||
      dados?.last_transaction?.id ||
      dados?.id ||
      null;

    // Idempotência: a Pagar.me reenvia o mesmo evento até receber ack, e um
    // reenvio não pode virar dois chargebacks no relatório.
    const jaTem = await (this.prisma as any).chargeback.findFirst({
      where: {
        orderId,
        ...(transacaoId ? { transacaoId: String(transacaoId) } : {}),
      },
      select: { id: true },
    });
    if (jaTem) {
      this.logger.log(`[risco] chargeback já registrado pedido=${orderId} — reenvio ignorado`);
      return;
    }

    const centavos = Number(dados?.amount);
    const valor = Number.isFinite(centavos) && centavos > 0 ? centavos / 100 : Number(pedido.totalAmount || 0);

    await this.registrar(
      {
        orderId,
        // O desfecho ainda não se sabe: a contestação acabou de abrir. Quem
        // fecha "ganho"/"perdido" é a matriz, quando o adquirente responde.
        status: 'em_analise',
        abertoEm: new Date(),
        valor: valor > 0 ? valor : 0.01,
        motivo: this.texto(dados?.reason || dados?.status || eventType, 200),
        // Não presume fraude: o adquirente manda o motivo depois, e "não
        // recebi" é logística, não fraude — marcar errado envenenaria o score
        // da rede inteira.
        fraude: false,
        transacaoId: transacaoId ? String(transacaoId) : null,
        plataforma: 'pagarme',
      },
      'webhook pagar.me',
      'webhook',
    );
  }

  /**
   * ITEM 15 — o aprendizado. Recalcula o score dos pedidos que dividem alguma
   * chave com o pedido contestado, pra que o alerta já esteja lá quando
   * alguém abrir o próximo.
   *
   * Teto e try/catch por pedido: um chargeback num endereço movimentado não
   * pode virar uma tempestade de recálculo.
   */
  async reavaliarVizinhanca(orderId: string): Promise<number> {
    await this.chaves.gravarChavesSeguro(orderId);

    const minhas: Array<{ tipo: string; valor: string }> = await (
      this.prisma as any
    ).orderRiskKey.findMany({ where: { orderId }, select: { tipo: true, valor: true } });
    if (!minhas.length) return 0;

    const vizinhos: Array<{ orderId: string }> = await (this.prisma as any).orderRiskKey.findMany({
      where: {
        OR: minhas.map((m) => ({ tipo: m.tipo, valor: m.valor })),
        orderId: { not: orderId },
      },
      select: { orderId: true },
      distinct: ['orderId'],
      take: TETO_REAVALIACAO,
    });

    let n = 0;
    for (const v of vizinhos) {
      try {
        await this.risco.analisar(v.orderId);
        n += 1;
      } catch (e: any) {
        this.logger.warn(`[risco] reavaliação falhou pedido=${v.orderId}: ${e?.message || e}`);
      }
    }
    // O próprio pedido contestado também tem análise.
    await this.risco.analisar(orderId).catch(() => {});
    this.logger.log(`[risco] chargeback em ${orderId} reavaliou ${n} pedidos relacionados`);
    return n;
  }

  private async resolverPedido(input: ChargebackInput): Promise<string | null> {
    if (input.orderId) {
      const p = await (this.prisma as any).order.findUnique({
        where: { id: input.orderId },
        select: { id: true },
      });
      if (p) return p.id;
    }
    const numero = String(input.numeroPedido || '').trim();
    if (numero) {
      const p = await (this.prisma as any).order.findFirst({
        where: { wcOrderNumber: numero },
        select: { id: true },
      });
      if (p) return p.id;
      // Pedido do site velho é numérico (#198119) e vive em `wcOrderId`.
      const soDigitos = numero.replace(/\D/g, '');
      if (soDigitos) {
        const q = await (this.prisma as any).order.findFirst({
          where: { wcOrderId: Number(soDigitos) },
          select: { id: true },
        });
        if (q) return q.id;
      }
      throw new BadRequestException(`Pedido "${numero}" não encontrado.`);
    }
    return null;
  }

  private validarStatus(s?: string): string {
    const v = String(s || 'em_analise').trim();
    if (!(STATUS_VALIDOS as readonly string[]).includes(v)) {
      throw new BadRequestException(
        `Status inválido: "${v}". Use ${STATUS_VALIDOS.join(', ')}.`,
      );
    }
    return v;
  }

  private texto(v: any, max: number): string | null {
    const s = String(v ?? '').trim();
    return s ? s.slice(0, max) : null;
  }

  private async trilha(orderId: string, acao: string, motivo: string, autor?: string) {
    try {
      await (this.prisma as any).riskDecisionLog.create({
        data: { orderId, acao, motivo, responsavel: autor || null },
      });
    } catch {
      /* trilha é registro, não pode derrubar a operação */
    }
  }
}
