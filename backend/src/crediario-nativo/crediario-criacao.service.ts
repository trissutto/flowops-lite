import { Injectable, Logger, ConflictException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

/**
 * CRIAÇÃO DE PARCELAS DE CREDIÁRIO — FLOW PRIMEIRO.
 *
 * Era a última escrita síncrona no caminho crítico da loja: `pdv.controller`
 * chamava `erp.createCrediarioParcelas`, que fazia `MAX(REGISTRO)+1 FOR UPDATE`
 * e INSERT direto na `movimento` do Giga. Giga fora do ar = a loja não vendia a
 * crediário. Agora as parcelas nascem no Postgres e o Giga recebe réplica pela
 * fila.
 *
 * ── AS DUAS FORMAS DE ESTRAGAR, E A DEFESA DE CADA UMA ──
 *
 * DUPLICAR (a cliente é cobrada duas vezes — pior, porque a loja só descobre
 * pela reclamação):
 *   · `@@unique([saleId, parcela])` no banco. Clique duplo, timeout com
 *     repetição, dois PDVs na mesma loja e retry do outbox esbarram todos aí.
 *     É restrição do Postgres, não sonda com janela de tempo.
 *   · Sentinela `crediarioLockId` gravada ANTES de qualquer escrita: fecha a
 *     janela em que o processo morre depois de criar e antes de marcar.
 *   · Repetição devolve as parcelas JÁ criadas em vez de criar outras.
 *
 * PERDER (a loja não cobra):
 *   · A parcela nasce no Postgres, que é a fonte. A fila só replica.
 *   · A leitura da tela de cobrança soma as duas fontes (união aditiva).
 *   · Nada é escrito em `wincred_movimento_aberto`: aquela tabela é apagada
 *     inteira a cada 10 minutos e a parcela nova, por ter o vencimento mais
 *     distante, seria a primeira a sumir.
 *
 * Kill-switch: `CREDIARIO_FLOW_FIRST=0` volta ao INSERT síncrono no Giga.
 */
@Injectable()
export class CrediarioCriacaoService {
  private readonly logger = new Logger(CrediarioCriacaoService.name);

  /**
   * Início da faixa reservada. Medido em 31/07
   * (`scripts/giga-etl/medir-numeracao-crediario.js`): REGISTRO e CONTROLE são
   * `int(11)` no Giga, com maior valor em uso 712.606 e 341.518. A base fica
   * 899 milhões acima do uso e 1,2 bilhão abaixo do teto do tipo.
   */
  private static readonly BASE = 900_000_000n;
  private static readonly TETO = 2_000_000_000n;
  private static readonly SEED_FONTE =
    'medido 31/07/2026: movimento.REGISTRO max 712606, CONTROLE max 341518, int(11) teto 2147483647';

  constructor(private readonly prisma: PrismaService) {}

  get flowFirst(): boolean {
    return String(process.env.CREDIARIO_FLOW_FIRST ?? '1') !== '0';
  }

  /** Base da faixa — o alocador LEGADO lê isto pra EXCLUIR a faixa do MAX+1
   *  dele. Sem essa exclusão, as duas numerações colidem assim que a primeira
   *  parcela do Flow chega no Giga. */
  static get baseFaixa(): number {
    return Number(CrediarioCriacaoService.BASE);
  }

  /**
   * Reserva `n` números da sequência, numa transação. Duas vendas simultâneas
   * nunca recebem o mesmo REGISTRO.
   */
  private async reservar(escopo: 'registro' | 'controle', n: number): Promise<bigint> {
    if (n <= 0) throw new Error('reservar: n precisa ser > 0');
    return this.prisma.$transaction(async (tx: any) => {
      const cur = await tx.crediarioSeq.findUnique({ where: { escopo } });
      const inicio = cur ? BigInt(cur.proximo) : CrediarioCriacaoService.BASE;
      const fim = inicio + BigInt(n);

      const teto = cur ? BigInt(cur.teto) : CrediarioCriacaoService.TETO;
      if (fim >= teto) {
        // Estourar a faixa geraria código que colide com o histórico do Giga.
        // Melhor recusar e cair no legado do que numerar por cima de dívida.
        throw new Error(`sequência de ${escopo} chegou ao teto (${teto}) — não numerar às cegas`);
      }

      if (cur) {
        await tx.crediarioSeq.update({ where: { escopo }, data: { proximo: fim } });
      } else {
        await tx.crediarioSeq.create({
          data: {
            escopo,
            base: CrediarioCriacaoService.BASE,
            proximo: fim,
            teto: CrediarioCriacaoService.TETO,
            seedFonte: CrediarioCriacaoService.SEED_FONTE,
          },
        });
      }
      return inicio;
    });
  }

  /**
   * Cria as N parcelas no Postgres e devolve o que a tela precisa.
   *
   * Idempotente: chamar de novo pra mesma venda devolve as parcelas já
   * existentes em vez de criar outras.
   */
  async criarParcelas(input: {
    saleId: string;
    codCliente: string;
    nomeCliente: string;
    loja: string;
    valorTotal: number;
    parcelas: number;
    primeiroVencimento: Date;
    dataCompra: Date;
    observacao?: string;
  }): Promise<{
    controle: number;
    registros: number[];
    parcelas: Array<{ registro: number; parcela: number; vencimento: Date; valor: number }>;
    jaExistia: boolean;
  }> {
    const n = Math.max(1, Math.floor(Number(input.parcelas) || 1));

    // ── 1. Já existe? Repetição devolve o que está lá ──────────────────────
    const existentes = await this.lerParcelasDaVenda(input.saleId);
    if (existentes.length) {
      this.logger.warn(
        `[crediario-criacao] venda ${input.saleId} já tem ${existentes.length} parcela(s) — devolvendo as existentes`,
      );
      return this.montarResposta(existentes, true);
    }

    // ── 2. Sentinela ANTES de qualquer escrita ─────────────────────────────
    // updateMany com a condição no WHERE é atômico: só UMA chamada concorrente
    // consegue count=1. A perdedora relê e devolve o que a vencedora criou.
    const lockId = randomUUID();
    const tomou = await (this.prisma as any).pdvSale.updateMany({
      where: { id: input.saleId, crediarioLockId: null },
      data: { crediarioLockId: lockId, crediarioLockAt: new Date() },
    });
    if (tomou.count === 0) {
      const outras = await this.lerParcelasDaVenda(input.saleId);
      if (outras.length) return this.montarResposta(outras, true);
      // Sentinela tomada mas sem parcela: tentativa anterior morreu no meio.
      // Recusar é mais seguro que criar por cima — a retaguarda destrava.
      throw new ConflictException(
        'Já existe uma criação de crediário em andamento pra esta venda. ' +
        'Se persistir, a retaguarda precisa destravar (crediarioLockId).',
      );
    }

    // ── 3. Numeração da faixa do Flow ──────────────────────────────────────
    const regInicio = await this.reservar('registro', n);
    const ctlInicio = await this.reservar('controle', 1);
    const controle = Number(ctlInicio);

    // ── 4. Valores: a última parcela absorve a diferença de arredondamento ──
    const total = Math.round(Number(input.valorTotal) * 100);
    const base = Math.floor(total / n);
    const linhas = Array.from({ length: n }, (_, i) => {
      const centavos = i === n - 1 ? total - base * (n - 1) : base;
      const venc = new Date(input.primeiroVencimento);
      venc.setMonth(venc.getMonth() + i);
      return {
        registro: String(regInicio + BigInt(i)),
        controle: String(controle),
        numeroCompra: String(controle),
        loja: String(input.loja || '').padStart(2, '0').slice(-2),
        codCliente: String(input.codCliente),
        nomeCliente: String(input.nomeCliente || '').slice(0, 120) || null,
        parcela: i + 1,
        totalParcelas: n,
        dataCompra: input.dataCompra,
        valorCompra: Number(input.valorTotal),
        vencimento: venc,
        valorParcela: centavos / 100,
        pago: false,
        obs: String(input.observacao || '').slice(0, 300) || null,
        flowIsSource: true,
        saleId: input.saleId,
        gigaOk: false,
      };
    });

    // ── 5. Grava — o unique de (saleId, parcela) é a rede de segurança ──────
    try {
      await (this.prisma as any).crediarioParcela.createMany({ data: linhas });
    } catch (e: any) {
      if (String(e?.code) === 'P2002') {
        // Alguém venceu a corrida entre o passo 1 e aqui. Não é erro: devolve
        // o que existe. Cobrar duas vezes seria o erro.
        const outras = await this.lerParcelasDaVenda(input.saleId);
        if (outras.length) return this.montarResposta(outras, true);
      }
      throw e;
    }

    // ── 6. Enfileira a réplica pro Giga ────────────────────────────────────
    await this.enfileirarReplica(input.saleId, linhas.map((l) => l.registro));

    await (this.prisma as any).pdvSale.update({
      where: { id: input.saleId },
      data: { crediarioControle: String(controle), crediarioCriadoEm: new Date() },
    }).catch((e: any) =>
      this.logger.warn(`[crediario-criacao] controle não gravado na venda ${input.saleId}: ${e?.message}`),
    );

    this.logger.log(
      `[crediario-criacao] venda ${input.saleId}: ${n} parcela(s) no Flow ` +
      `(controle ${controle}, registros ${linhas[0].registro}..${linhas[n - 1].registro}) — réplica na fila`,
    );

    const criadas = await this.lerParcelasDaVenda(input.saleId);
    return this.montarResposta(criadas, false);
  }

  private async lerParcelasDaVenda(saleId: string): Promise<any[]> {
    return (this.prisma as any).crediarioParcela.findMany({
      where: { saleId, cancelado: false },
      orderBy: { parcela: 'asc' },
    });
  }

  private montarResposta(linhas: any[], jaExistia: boolean) {
    return {
      controle: Number(linhas[0]?.controle) || 0,
      registros: linhas.map((l) => Number(l.registro)),
      parcelas: linhas.map((l) => ({
        registro: Number(l.registro),
        parcela: Number(l.parcela),
        vencimento: l.vencimento,
        valor: Number(l.valorParcela),
      })),
      jaExistia,
    };
  }

  private async enfileirarReplica(saleId: string, registros: string[]): Promise<void> {
    try {
      await (this.prisma as any).erpOutbox.create({
        data: {
          kind: 'crediario_criacao',
          // Prefixo evita colidir com o job 'venda' da MESMA venda no
          // unique [kind, saleId].
          saleId: `credcria-${saleId}`,
          payload: { saleId, registros },
          status: 'pending',
        },
      });
    } catch (e: any) {
      if (String(e?.code) === 'P2002') return; // já enfileirado
      // A dívida VALE no Flow mesmo sem a fila — a loja cobra normalmente.
      // O que se perde é a réplica; o log é o que permite reconciliar depois.
      this.logger.error(
        `[crediario-criacao] parcelas da venda ${saleId} criadas no Flow mas NÃO enfileiradas: ${e?.message}. ` +
        `A dívida vale; o Giga vai ficar sem essas linhas até alguém reconciliar.`,
      );
    }
  }
}
