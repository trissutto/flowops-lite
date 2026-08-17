import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { PdvService } from './pdv.service';

/**
 * FECHA A VENDA QUANDO O LINK PAGAR.ME É PAGO (17/08).
 *
 * O FURO: nada no sistema fechava a venda de um link pago. Nem o webhook, nem
 * o `PagarmeReconcileService` — não existe `finalize`/`addPayment` em nenhum
 * arquivo do módulo Pagar.me. O que existia só gravava
 * `pagarme_payment.status = 'paid'` e dava baixa de crediário. A venda do PDV
 * ficava `open` PRA SEMPRE, dependendo de alguém ver a lista de "links
 * pendentes" e finalizar na mão.
 *
 * O CUSTO: sem baixa de estoque (a peça sai e o site vende de novo), sem
 * NF-e, fora do caixa e do faturamento, sem comissão pra vendedora — e a
 * cliente que PAGOU não recebe nada e nem é avisada. Palavras do dono:
 * "dinheiro perdido e muitas reclamações".
 *
 * Caso real 17/08: Sandra Micheli, `LURDS-LINK-F77D2D71`, R$ 229,69, PAGO às
 * 12:04:39 no Pagar.me — venda nunca fechou. Não é caso de carrinho
 * recuperado: valia pra TODA venda de link, de qualquer loja.
 *
 * ⚠️ POR QUE ESTE ARQUIVO MORA NO `pdv/` E NÃO NO `pagarme/`:
 * fechar a venda exige o `PdvService`, e injetar ele no módulo do Pagar.me
 * criaria ciclo de MÓDULOS. Foi exatamente um import novo assim que impediu o
 * backend de subir em 07/08 (ver o aviso no `pdv.module.ts`). Então segue o
 * padrão que já resolveu isso no PIX: o serviço entra SÓ como provider do
 * PdvModule e lê a tabela do outro sistema (`pagarme_payment`) pelo Prisma,
 * que este módulo já tem. Zero import de módulo novo.
 *
 * Espelha as defesas do `PixPagbankReconcileService`:
 *  - guard de overlap, teto por ciclo, janela de 72h (venda paga sábado à
 *    noite tem que sobreviver até o caixa abrir na segunda);
 *  - pagamento equivalente já registrado → só re-tenta o finalize, nunca
 *    duplica valor no caixa;
 *  - finalize que falha (caixa fechado, split incompleto) não é erro: o
 *    próximo ciclo tenta de novo e a venda fecha sozinha quando destravar.
 *
 * Kill-switch: `PAGARME_LINK_RECONCILE=0`.
 */
@Injectable()
export class PagarmeLinkReconcileService {
  private readonly logger = new Logger(PagarmeLinkReconcileService.name);
  private running = false;

  /** Teto por ciclo — reconciliação é exceção, não fluxo de massa. */
  private static readonly BATCH = 20;
  /** 72h, igual ao PIX: paga sábado à noite fecha na segunda de manhã. */
  private static readonly JANELA_HORAS = 72;

  /** Motivo da última falha por venda — loga só quando MUDA, senão enche o
   *  log a cada 45s com "caixa fechado" a noite inteira. */
  private readonly ultimaFalha = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly pdv: PdvService,
  ) {}

  private get ligado(): boolean {
    return String(process.env.PAGARME_LINK_RECONCILE ?? '1') !== '0';
  }

  @Cron(CronExpression.EVERY_30_SECONDS, { name: 'pagarme-link-reconcile' })
  async tick(): Promise<void> {
    if (!this.ligado) return;
    if (this.running) return;
    this.running = true;
    try {
      await this.reconciliar();
    } catch (e: any) {
      // Reconciliador que quebra não derruba nada: loga e tenta no próximo.
      this.logger.error(`[pagarme-link] ciclo falhou: ${e?.message || e}`);
    } finally {
      this.running = false;
    }
  }

  private async reconciliar(): Promise<void> {
    const desde = new Date(
      Date.now() - PagarmeLinkReconcileService.JANELA_HORAS * 3600_000,
    );

    /**
     * Link JÁ PAGO no gateway cuja venda continua aberta.
     *
     * Não consulta a API do Pagar.me: quem faz isso é o
     * `PagarmeReconcileService` (cron de 45s, com throttle por pedido) e ele já
     * persiste `status: 'paid'`. Aqui é só o passo que faltava — pegar o que
     * está pago no banco e fechar a venda. Duas responsabilidades separadas,
     * sem duas rotinas martelando a API do gateway.
     */
    const pagos: any[] = await (this.prisma as any).pagarmePayment.findMany({
      where: { status: 'paid', createdAt: { gte: desde } },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        pagarmeOrderId: true,
        pagarmeChargeId: true,
        saleId: true,
        storeCode: true,
        method: true,
        valor: true,
      },
    });
    if (!pagos.length) return;

    // Só as vendas que AINDA estão abertas — 1 query em vez de N.
    const vendas: any[] = await (this.prisma as any).pdvSale.findMany({
      where: { id: { in: pagos.map((p) => p.saleId).filter(Boolean) }, status: 'open' },
      select: { id: true, total: true, storeCode: true },
    });
    if (!vendas.length) return;
    const abertas = new Map<string, any>(vendas.map((v) => [v.id, v]));

    let fechadas = 0;
    let tentadas = 0;
    for (const p of pagos) {
      if (tentadas >= PagarmeLinkReconcileService.BATCH) break;
      const venda = abertas.get(p.saleId);
      if (!venda) continue;
      tentadas++;
      if (await this.fechar(p, venda)) fechadas++;
    }

    if (fechadas > 0) {
      this.logger.log(
        `[pagarme-link] ciclo: ${tentadas} venda(s) paga(s) e aberta(s) · ${fechadas} fechada(s)`,
      );
    }
    if (this.ultimaFalha.size > 500) this.ultimaFalha.clear();
  }

  /** Registra o pagamento na venda e finaliza. Nunca lança. */
  private async fechar(p: any, venda: any): Promise<boolean> {
    try {
      /**
       * Pagamento já registrado? A chave é o `pagarmeOrderId` dentro do
       * `details` — sem essa checagem, um ciclo que rodasse duas vezes
       * dobraria o valor no caixa do dia. Mesma defesa do reconciliador do PIX.
       */
      const existentes: any[] = await (this.prisma as any).pdvSalePayment.findMany({
        where: { saleId: p.saleId },
        select: { valor: true, details: true },
      });
      const jaRegistrado = existentes.some((x) => {
        try {
          const d = JSON.parse(x.details || '{}');
          return (
            d?.pagarmeOrderId === p.pagarmeOrderId || d?.pixTxid === p.pagarmeOrderId
          );
        } catch {
          return false;
        }
      });

      if (!jaRegistrado) {
        // O valor do gateway é a verdade do que a cliente pagou; sem ele
        // (registro antigo sem valor), cai no total da venda.
        const valor = Number(p.valor) > 0 ? Number(p.valor) : Number(venda.total || 0);
        if (valor <= 0) {
          this.avisar(p.saleId, 'sem valor pra registrar');
          return false;
        }
        await this.pdv.addPayment({
          saleId: p.saleId,
          // O link cobra cartão ou PIX — o `method` do registro decide.
          method: String(p.method || '').toLowerCase() === 'pix' ? 'pix' : 'credito',
          valor,
          details: {
            pagarmeOrderId: p.pagarmeOrderId,
            pagarmeChargeId: p.pagarmeChargeId ?? null,
            linkPagarme: true,
            reconciliadoPeloCron: true,
          },
        });
      }

      await this.pdv.finalize({ saleId: p.saleId });
      this.ultimaFalha.delete(p.saleId);
      this.logger.log(
        `[pagarme-link] venda ${p.saleId} FECHADA pelo cron ` +
          `(link ${p.pagarmeOrderId}, loja ${p.storeCode})`,
      );
      return true;
    } catch (e: any) {
      /**
       * Caixa fechado à noite e split incompleto (o link é só parte do total)
       * caem aqui, e os dois são ESPERADOS — não são erro. O próximo ciclo
       * tenta de novo; quando o caixa abre de manhã, fecha sozinha. Loga só
       * quando o motivo muda pra não poluir o log a cada 30s.
       */
      this.avisar(p.saleId, String(e?.message || e));
      return false;
    }
  }

  private avisar(saleId: string, motivo: string): void {
    if (this.ultimaFalha.get(saleId) === motivo) return;
    this.ultimaFalha.set(saleId, motivo);
    this.logger.warn(
      `[pagarme-link] venda ${saleId} PAGA mas não fechou: ${motivo} — re-tento a cada ciclo`,
    );
  }
}
