import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';

/**
 * VendaCertaAutoMatchService — AUTO-BAIXA de VENDA CERTA via PDV.
 *
 * Contexto do problema (regra do CEO 21/04/26):
 *   Quando uma loja pede uma peça pra outra como VENDA_CERTA, a cliente vai
 *   buscar naquela loja. Às vezes demora dias. Hoje a vendedora TEM que
 *   clicar manualmente em "Vendi" quando a cliente paga — muita gente esquece,
 *   o histórico fica incorreto, e o controle anti-malandragem do CEO perde valor.
 *
 * Solução:
 *   Cron roda a cada 15min procurando VENDA_CERTA com saleStatus='pending'.
 *   Pra cada uma, monta um candidato (lojaDestino + refCode + cor + tamanho +
 *   dataEnvio) e chama erp.findVendaCertaMatches() — que busca na tabela
 *   `caixa` (PDV Gigasistemas) uma venda BATIDA com esses critérios.
 *
 *   Quando encontra → marca saleStatus='confirmed' automaticamente, guarda o
 *   número do cupom PDV em saleNote (pra auditoria + UI mostrar "AUTO:cupom_X").
 *
 * Por que não marca saleStatus='cancelled' automaticamente:
 *   - Pode ser que a cliente ainda esteja pensando. Sem upper time limit
 *     (a cliente pode voltar em dias). Só baixa manualmente quando loja marca.
 *
 * Por que a cada 15min:
 *   - Balanço entre latência do feedback (cliente confirma rapidinho) e
 *     carga no ERP (a cada query faz JOIN caixa×produtos que não é leve).
 *
 * Segurança:
 *   - Só altera VENDA_CERTA pending. Nunca toca REPOSICAO.
 *   - Nunca confirma sem encontrar cupom.
 *   - Nunca cancela — só confirma.
 */
@Injectable()
export class VendaCertaAutoMatchService {
  private readonly logger = new Logger(VendaCertaAutoMatchService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpService,
  ) {}

  /**
   * Cron: a cada 15min. Se o cron anterior ainda está rodando, pula (evita
   * overlap em caso de ERP lento / volume alto de pending).
   */
  @Cron(CronExpression.EVERY_30_MINUTES)
  async run() {
    if (this.running) {
      this.logger.debug('Auto-match VENDA_CERTA já em execução — pulando ciclo.');
      return;
    }
    this.running = true;
    try {
      await this.runInner();
    } catch (e: any) {
      this.logger.error(`Auto-match VENDA_CERTA falhou: ${e?.message ?? e}`);
    } finally {
      this.running = false;
    }
  }

  /** Permite disparar manualmente por endpoint de retaguarda (pra QA). */
  async runManual() {
    if (this.running) {
      return { ok: false, reason: 'Já está rodando.' };
    }
    this.running = true;
    try {
      const result = await this.runInner();
      return { ok: true, ...result };
    } finally {
      this.running = false;
    }
  }

  private async runInner() {
    // Busca TODAS VENDA_CERTA com status pending — sem limite de idade (a cliente
    // pode demorar dias/semanas pra ir buscar na loja, regra do CEO).
    const pending = await (this.prisma as any).transferOrder.findMany({
      where: {
        tipo: 'VENDA_CERTA',
        saleStatus: 'pending',
      },
      orderBy: { createdAt: 'asc' },
      take: 500, // cap de segurança — dezenas a centenas no normal
    });

    if (!pending.length) {
      return { checked: 0, matched: 0 };
    }

    const candidates = pending.map((p: any) => ({
      lojaDestinoCode: p.lojaDestinoCode,
      refCode: p.refCode,
      cor: p.cor,
      tamanho: p.tamanho,
      // Busca a partir da DATA de criação do TransferOrder (só peça enviada depois
      // que o pedido foi feito conta — venda anterior é coincidência).
      dataEnvio: p.createdAt,
    }));

    const matches = await this.erp.findVendaCertaMatches(candidates);
    const matchedIndexes = Object.keys(matches).map((k) => Number(k));

    if (matchedIndexes.length === 0) {
      return { checked: pending.length, matched: 0 };
    }

    let confirmed = 0;
    for (const idx of matchedIndexes) {
      const order = pending[idx];
      const m = matches[idx];
      if (!order || !m) continue;
      try {
        await (this.prisma as any).transferOrder.update({
          where: { id: order.id },
          data: {
            saleStatus: 'confirmed',
            saleConfirmedAt: m.data ?? new Date(),
            // userId null = sistema (auto-match). saleConfirmedByUserId opcional.
            saleConfirmedByUserId: null,
            saleNote: `AUTO:cupom_${m.numero}`,
          },
        });
        confirmed++;
        this.logger.log(
          `Auto-confirmado VENDA_CERTA ${order.id} (REF=${order.refCode} LJ${order.lojaDestinoCode}) → cupom ${m.numero}`,
        );
      } catch (e: any) {
        this.logger.warn(
          `Falha ao confirmar VENDA_CERTA ${order.id}: ${e?.message ?? e}`,
        );
      }
    }

    this.logger.log(
      `Auto-match VENDA_CERTA: checkados=${pending.length} confirmados=${confirmed}`,
    );
    return { checked: pending.length, matched: matchedIndexes.length, confirmed };
  }
}
