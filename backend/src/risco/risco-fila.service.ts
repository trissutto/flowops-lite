import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { authorizeMinLevel } from '../auth/auth-levels.util';
import {
  normalizeCpf,
  normalizeEmail,
  normalizePhone,
} from '../person-identity/identity-normalization';
import { chavesDeEndereco } from './endereco-normalizacao';
import { RiscoService } from './risco.service';
import { RiscoPesosService } from './risco-pesos.service';
import { ChargebackService } from './chargeback.service';

/**
 * A FILA DE ANÁLISE, a DECISÃO e os NÚMEROS — itens 11, 12, 13, 16, 19 e 20.
 *
 * ⚠️ O QUE ESTA CLASSE NÃO FAZ: mexer no pedido. Marcar "suspeito" aqui NÃO
 * bloqueia, não cancela, não tira da separação e não segura estoque — é
 * ordem do dono (27/08) e também a única forma segura: o pedido pode já ter
 * peça bipada ou caixa fechada, e a régua disso vive em `troca-bloqueio.ts` e
 * no caminho de cancelamento que já existe. Quem cancela, cancela por lá, com
 * motivo e com a régua que já sabe o que fazer com a peça.
 *
 * Por isso o status daqui se chama `suspeito`, e não `bloqueado`: o nome tinha
 * que dizer a verdade sobre o que o botão faz.
 */

export const STATUS_ANALISE = [
  'aguardando',
  'em_analise',
  'liberado',
  'suspeito',
  'revisar',
] as const;
export type StatusAnalise = (typeof STATUS_ANALISE)[number];

/** Decisão que carimba a suspeita exige senha — é registro que fica. */
const EXIGE_SENHA: StatusAnalise[] = ['suspeito'];

export interface FiltrosFila {
  /** Níveis a mostrar. Padrão: alto e crítico (item 11). */
  nivel?: string;
  status?: string;
  scoreMin?: number;
  de?: string;
  ate?: string;
  valorMin?: number;
  valorMax?: number;
  loja?: string;
  /** 'sim' = só pedidos com chargeback relacionado. */
  comChargeback?: string;
  cpf?: string;
  telefone?: string;
  email?: string;
  endereco?: string;
  cep?: string;
  numero?: string;
  limite?: number;
}

@Injectable()
export class RiscoFilaService {
  private readonly logger = new Logger(RiscoFilaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly risco: RiscoService,
    private readonly pesos: RiscoPesosService,
    private readonly chargebacks: ChargebackService,
  ) {}

  /**
   * ITEM 11 — os pedidos que pedem olho humano.
   *
   * Lê a análise PERSISTIDA, não recalcula: a fila abre com dezenas de linhas e
   * recalcular todas a cada render transformaria a tela numa varredura. O
   * recálculo acontece quando o pedido nasce, quando um chargeback entra e
   * quando alguém abre o pedido.
   */
  async fila(f: FiltrosFila) {
    const where: any = {};

    const niveis =
      f.nivel && f.nivel !== 'todos'
        ? [f.nivel]
        : ['alto', 'critico'];
    where.nivel = { in: niveis };

    if (f.status && f.status !== 'todos') where.status = f.status;
    if (Number.isFinite(Number(f.scoreMin))) where.score = { gte: Number(f.scoreMin) };

    const ordemWhere: any = {};
    if (f.de || f.ate) {
      ordemWhere.createdAt = {};
      if (f.de) ordemWhere.createdAt.gte = new Date(`${f.de}T00:00:00`);
      if (f.ate) ordemWhere.createdAt.lte = new Date(`${f.ate}T23:59:59`);
    }
    if (Number.isFinite(Number(f.valorMin)) || Number.isFinite(Number(f.valorMax))) {
      ordemWhere.totalAmount = {};
      if (Number.isFinite(Number(f.valorMin))) ordemWhere.totalAmount.gte = Number(f.valorMin);
      if (Number.isFinite(Number(f.valorMax))) ordemWhere.totalAmount.lte = Number(f.valorMax);
    }
    if (f.loja) {
      // A loja de um pedido do site é a que VENDE (venda online) ou a da
      // retirada. Quem SEPARA sai do roteamento e pode ser outra — filtrar por
      // ela exigiria varrer pick_orders e mudaria o sentido do filtro.
      ordemWhere.OR = [{ sellerStoreCode: f.loja }, { pickupStoreCode: f.loja }];
    }
    if (f.comChargeback === 'sim') ordemWhere.chargebacks = { some: {} };

    // Filtro por DADO da cliente: normaliza igual ao motor e procura a chave.
    const idsPorChave = await this.idsPorChave(f);
    if (idsPorChave !== null) {
      if (!idsPorChave.length) return { total: 0, pedidos: [] };
      ordemWhere.id = { in: idsPorChave };
    }

    if (Object.keys(ordemWhere).length) where.order = ordemWhere;

    const linhas = await (this.prisma as any).orderRiskAnalysis.findMany({
      where,
      orderBy: [{ score: 'desc' }, { calculadoEm: 'desc' }],
      take: Math.min(Math.max(Number(f.limite) || 200, 1), 1000),
      include: {
        order: {
          select: {
            id: true,
            wcOrderId: true,
            wcOrderNumber: true,
            customerName: true,
            customerCpf: true,
            customerPhone: true,
            customerEmail: true,
            totalAmount: true,
            status: true,
            source: true,
            createdAt: true,
            wcDateCreated: true,
            sellerStoreCode: true,
            pickupStoreCode: true,
            chargebacks: { select: { id: true, status: true } },
          },
        },
      },
    });

    return {
      total: linhas.length,
      pedidos: linhas.map((l: any) => ({
        orderId: l.orderId,
        // O id numérico é o que abre a tela do pedido — ver PedidoRelacionado.
        wcOrderId: l.order?.wcOrderId ?? null,
        numero: l.order?.wcOrderNumber || l.orderId.slice(-8),
        cliente: l.order?.customerName || null,
        cpf: l.order?.customerCpf || null,
        telefone: l.order?.customerPhone || null,
        data: l.order?.wcDateCreated || l.order?.createdAt || null,
        valor: l.order?.totalAmount ?? null,
        loja: l.order?.sellerStoreCode || l.order?.pickupStoreCode || null,
        statusPedido: l.order?.status || null,
        score: l.score,
        nivel: l.nivel,
        // Só os que PONTUAM aparecem no resumo da linha — a fila é pra
        // priorizar, o detalhe está no pedido.
        motivos: ((l.motivos as any[]) || []).filter((m) => m.peso > 0).map((m) => m.texto),
        chargebacksRelacionados: ((l.relacionados as any[]) || []).filter(
          (r) => r.situacao === 'chargeback',
        ).length,
        chargebackNoPedido: (l.order?.chargebacks || []).length > 0,
        status: l.status,
        responsavel: l.responsavel,
        analisadoEm: l.analisadoEm,
      })),
    };
  }

  /**
   * Traduz filtro de CPF/telefone/e-mail/endereço em ids de pedido, passando
   * pela MESMA normalização do motor. Sem isso, procurar "(21) 96541-5633" não
   * acharia o pedido que gravou "21965415633".
   *
   * Devolve `null` quando nenhum filtro de dado foi usado (≠ lista vazia, que
   * significa "filtrou e não achou nada").
   */
  private async idsPorChave(f: FiltrosFila): Promise<string[] | null> {
    const alvos: Array<{ tipo: string; valor: string }> = [];

    const cpf = normalizeCpf(f.cpf);
    if (cpf) alvos.push({ tipo: 'cpf', valor: cpf });

    const email = normalizeEmail(f.email);
    if (email) alvos.push({ tipo: 'email', valor: email });

    const fone = normalizePhone(f.telefone);
    if (fone) alvos.push({ tipo: 'telefone', valor: fone });

    if (f.endereco || (f.cep && f.numero)) {
      const { cepNumero, endereco } = chavesDeEndereco({
        logradouro: f.endereco,
        numero: f.numero,
        cep: f.cep,
      });
      if (endereco) alvos.push({ tipo: 'endereco', valor: endereco });
      if (cepNumero) alvos.push({ tipo: 'cep_numero', valor: cepNumero });
    }

    if (!alvos.length) return null;

    const linhas: Array<{ orderId: string }> = await (this.prisma as any).orderRiskKey.findMany({
      where: { OR: alvos },
      select: { orderId: true },
      distinct: ['orderId'],
      take: 2000,
    });
    return linhas.map((l) => l.orderId);
  }

  /**
   * ITENS 12 e 13 — a decisão humana, com responsável e observação.
   *
   * Marcar SUSPEITO pede senha de gerente ou superior. Não porque a ação seja
   * destrutiva (ela não é — nada acontece com o pedido), mas porque vira
   * registro sobre uma cliente: alguém tem que assinar.
   */
  async decidir(
    orderId: string,
    input: { status: string; observacao?: string; motivo?: string; senha?: string },
    autor: string,
  ) {
    const status = String(input.status || '').trim() as StatusAnalise;
    if (!(STATUS_ANALISE as readonly string[]).includes(status)) {
      throw new BadRequestException(
        `Status inválido: "${status}". Use ${STATUS_ANALISE.join(', ')}.`,
      );
    }

    let assinante = autor;
    if (EXIGE_SENHA.includes(status)) {
      if (!input.motivo || String(input.motivo).trim().length < 3) {
        throw new BadRequestException('Diga o motivo — ele fica no histórico da cliente.');
      }
      const auth = authorizeMinLevel(input.senha, 'GERENTE');
      if (auth.byNome) assinante = `${autor} (autorizado por ${auth.byNome})`;
      else assinante = `${autor} (senha ${auth.level})`;
    }

    const atual = await (this.prisma as any).orderRiskAnalysis.findUnique({ where: { orderId } });
    // Pedido que nunca foi analisado: analisa agora, pra decisão não nascer
    // apoiada em nada.
    if (!atual) await this.risco.recalcular(orderId);

    const salvo = await (this.prisma as any).orderRiskAnalysis.update({
      where: { orderId },
      data: {
        status,
        responsavel: assinante,
        observacao: input.observacao ? String(input.observacao).slice(0, 4000) : atual?.observacao,
        analisadoEm: new Date(),
      },
    });

    await (this.prisma as any).riskDecisionLog.create({
      data: {
        orderId,
        acao: status,
        de: atual?.status || 'aguardando',
        para: status,
        motivo: input.motivo || input.observacao || null,
        responsavel: assinante,
      },
    });

    this.logger.log(`[risco] pedido=${orderId} ${atual?.status || '—'} → ${status} por ${assinante}`);
    return salvo;
  }

  /**
   * ITEM 16 — o histórico de ocorrências do pedido: decisões de risco,
   * chargebacks e o andar do próprio pedido, na mesma linha do tempo.
   */
  async historico(orderId: string) {
    const [decisoes, cbs, pedido] = await Promise.all([
      (this.prisma as any).riskDecisionLog.findMany({
        where: { orderId },
        orderBy: { criadoEm: 'desc' },
        take: 200,
      }),
      this.chargebacks.doPedido(orderId),
      (this.prisma as any).order.findUnique({
        where: { id: orderId },
        select: {
          history: {
            orderBy: { createdAt: 'desc' },
            take: 100,
            select: {
              createdAt: true,
              fromStatus: true,
              toStatus: true,
              note: true,
              user: { select: { name: true, email: true } },
            },
          },
        },
      }),
    ]);

    const eventos = [
      ...decisoes.map((d: any) => ({
        em: d.criadoEm,
        tipo: 'risco',
        texto: d.de && d.para ? `Análise: ${d.de} → ${d.para}` : `Análise: ${d.acao}`,
        detalhe: d.motivo || null,
        responsavel: d.responsavel || null,
      })),
      ...cbs.map((c: any) => ({
        em: c.abertoEm,
        tipo: 'chargeback',
        texto: `Chargeback ${c.status} — R$ ${Number(c.valor || 0).toFixed(2)}`,
        detalhe: c.motivo || null,
        responsavel: c.registradoPor || null,
      })),
      ...((pedido?.history as any[]) || []).map((h: any) => ({
        em: h.createdAt,
        tipo: 'pedido',
        texto:
          h.fromStatus && h.toStatus ? `Pedido: ${h.fromStatus} → ${h.toStatus}` : 'Pedido atualizado',
        detalhe: h.note || null,
        responsavel: h.user?.name || h.user?.email || null,
      })),
    ].sort((a, b) => new Date(b.em).getTime() - new Date(a.em).getTime());

    return { total: eventos.length, eventos };
  }

  /**
   * ITEM 19 — a CENTRAL DE RISCO em números.
   *
   * "Principais fatores de risco" sai dos motivos gravados: é a leitura que
   * diz onde a operação está sangrando (telefone repetido? endereço? cartão?)
   * em vez de só quantos alertas apareceram.
   */
  async dashboard(de?: string, ate?: string) {
    const pesos = await this.pesos.get();
    const janela: any = {};
    if (de) janela.gte = new Date(`${de}T00:00:00`);
    if (ate) janela.lte = new Date(`${ate}T23:59:59`);
    const temJanela = Object.keys(janela).length > 0;

    const whereAnalise: any = temJanela ? { order: { createdAt: janela } } : {};

    const [analises, resumoCb] = await Promise.all([
      (this.prisma as any).orderRiskAnalysis.findMany({
        where: whereAnalise,
        select: { nivel: true, status: true, motivos: true, score: true },
        take: 5000,
      }),
      this.chargebacks.resumo(de, ate),
    ]);

    const conta = (f: (a: any) => boolean) => analises.filter(f).length;

    // Fatores: quantas vezes cada regra COM PESO apareceu.
    const fatores = new Map<string, { texto: string; vezes: number }>();
    for (const a of analises) {
      for (const m of ((a.motivos as any[]) || []).filter((x) => x.peso > 0)) {
        const atual = fatores.get(m.chave) || { texto: this.rotuloFator(m.chave), vezes: 0 };
        atual.vezes += 1;
        fatores.set(m.chave, atual);
      }
    }

    return {
      ativo: pesos.ativo,
      periodo: { de: de || null, ate: ate || null },
      analisados: analises.length,
      moderados: conta((a) => a.nivel === 'moderado'),
      altos: conta((a) => a.nivel === 'alto'),
      criticos: conta((a) => a.nivel === 'critico'),
      aguardando: conta((a) => a.status === 'aguardando' && ['alto', 'critico'].includes(a.nivel)),
      emAnalise: conta((a) => a.status === 'em_analise'),
      liberados: conta((a) => a.status === 'liberado'),
      suspeitos: conta((a) => a.status === 'suspeito'),
      revisar: conta((a) => a.status === 'revisar'),
      chargebacks: resumoCb,
      fatores: Array.from(fatores.entries())
        .map(([chave, v]) => ({ chave, ...v }))
        .sort((a, b) => b.vezes - a.vezes)
        .slice(0, 12),
    };
  }

  /**
   * ITEM 20 — os relatórios, em linhas prontas. Quem vira CSV é o controller
   * (o mesmo caminho que os outros exports da casa já usam).
   */
  async relatorio(tipo: string, f: FiltrosFila): Promise<{ colunas: string[]; linhas: any[][] }> {
    switch (tipo) {
      case 'chargebacks': {
        const { chargebacks } = await this.chargebacks.listar({
          de: f.de,
          ate: f.ate,
          limite: 1000,
        });
        return {
          colunas: [
            'Pedido',
            'Cliente',
            'Aberto em',
            'Valor',
            'Status',
            'Motivo',
            'Fraude',
            'Plataforma',
            'Transação',
          ],
          linhas: chargebacks.map((c: any) => [
            c.order?.wcOrderNumber || '—',
            c.order?.customerName || '—',
            this.data(c.abertoEm),
            Number(c.valor || 0).toFixed(2),
            c.status,
            c.motivo || '',
            c.fraude ? 'sim' : 'não',
            c.plataforma || '',
            c.transacaoId || '',
          ]),
        };
      }
      case 'suspeitos':
      case 'liberados':
      case 'alto_risco':
      default: {
        const filtros: FiltrosFila = { ...f, limite: 1000 };
        if (tipo === 'suspeitos') filtros.status = 'suspeito';
        if (tipo === 'liberados') filtros.status = 'liberado';
        if (tipo === 'alto_risco') filtros.nivel = filtros.nivel || 'todos';
        const { pedidos } = await this.fila(filtros);
        return {
          colunas: [
            'Pedido',
            'Data',
            'Cliente',
            'CPF',
            'Telefone',
            'Valor',
            'Score',
            'Nível',
            'Status da análise',
            'Responsável',
            'Chargebacks relacionados',
            'Motivos',
          ],
          linhas: pedidos.map((p: any) => [
            p.numero,
            this.data(p.data),
            p.cliente || '',
            p.cpf || '',
            p.telefone || '',
            Number(p.valor || 0).toFixed(2),
            String(p.score),
            p.nivel,
            p.status,
            p.responsavel || '',
            String(p.chargebacksRelacionados),
            (p.motivos || []).join(' | '),
          ]),
        };
      }
    }
  }

  private rotuloFator(chave: string): string {
    const mapa: Record<string, string> = {
      cb_cpf: 'CPF relacionado a chargeback',
      cb_telefone: 'Telefone relacionado a chargeback',
      cb_endereco: 'Endereço relacionado a chargeback',
      cb_email: 'E-mail relacionado a chargeback',
      cb_cartao: 'Cartão relacionado a chargeback',
      cb_titular: 'Titular de cartão relacionado a chargeback',
      cb_aparelho: 'Aparelho relacionado a chargeback',
      cb_ip: 'IP relacionado a chargeback',
      combo_telefone_endereco: 'Telefone + endereço no mesmo chargeback',
      combo_cadastro_novo: 'Cadastro novo no mesmo telefone/endereço',
      multi_cartoes: 'Múltiplos cartões',
      multi_cpfs: 'Múltiplos CPFs',
      multi_emails: 'Múltiplos e-mails',
    };
    return mapa[chave] || chave;
  }

  private data(v: any): string {
    if (!v) return '';
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('pt-BR');
  }
}
