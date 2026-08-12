import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { PagbankService } from './pagbank.service';
import { CrediarioBaixaService } from '../crediarios/crediario-baixa.service';

/**
 * PIX PAGBANK PENDENTE — O SERVIDOR PERGUNTA (12/08/2026).
 *
 * ── O QUE FALTAVA ──
 *
 * Sorocaba, 12/08, R$139,80: "cliente pagou pelo código de pix que eu gerei no
 * sistema e não finalizou a venda". Terceira vez.
 *
 * O reconciliador do PDV (`PixPagbankReconcileService`, 07/08) fecha venda
 * cujo pagamento está `paid` na nossa tabela. O buraco é UM NÍVEL ANTES: quem
 * escreve `paid` ali é o webhook do PagBank — e só ele. Se o webhook não
 * chega (rede, retry esgotado, deploy no meio, `notification_urls` vazia
 * porque faltou BACKEND_PUBLIC_URL, assinatura recusada), a cobrança fica
 * `pending` PRA SEMPRE e o reconciliador nunca a enxerga. Do lado da loja é
 * pior que um erro: a tela diz "Aguardando pagamento PIX" com o dinheiro já
 * na conta, e a vendedora não tem como sair dali.
 *
 * O polling da tela cobre isso enquanto a aba está aberta — e só. Fecha a aba,
 * troca de PC, cai a luz, a cliente paga o código que recebeu por WhatsApp
 * meia hora depois: ninguém mais pergunta.
 *
 * O Pagar.me já resolveu isso em 31/07 (`PagarmeReconcileService`). O PagBank
 * nunca ganhou o dele. É este arquivo.
 *
 * ── ONDE ELE MORA (e por que aqui) ──
 *
 * No PagbankModule, dependendo só de Prisma + PagbankService. NÃO no PdvModule:
 * pra consultar o gateway ele precisaria do PagbankService lá dentro, e foi
 * exatamente um import assim que fechou o ciclo Pagbank→Pdv→Crediarios→Pagbank
 * e impediu o backend de SUBIR em 07/08.
 *
 * A divisão de trabalho fica limpa e sem acoplamento novo:
 *   este cron  → descobre que foi pago e grava `status='paid'` (fonte: gateway)
 *   cron do PDV → vê `paid` com venda aberta e fecha a venda
 *   este cron  → dispara a baixa de crediário (mesmo efeito do webhook)
 *
 * ── CUIDADO COM VOLUME (a live de 01/07 caiu de flood) ──
 *
 * Todo QR abandonado fica `pending` pra sempre, então a fila só cresce. Sem
 * freio, o cron martelaria a API do PagBank por centenas de cobranças mortas.
 * Por isso o intervalo de consulta CRESCE com a idade da cobrança (1min no
 * minuto que importa, 1h no rabo da janela) e, quando o QR venceu há horas e o
 * PagBank confirma que não foi pago, a linha vira `expired` e sai da fila de
 * vez.
 *
 * Kill-switch: `PAGBANK_RECONCILE=0`.
 */
@Injectable()
export class PagbankPixReconcileService {
  private readonly logger = new Logger(PagbankPixReconcileService.name);
  private rodando = false;
  /** Última consulta ao vivo por order — base do backoff. */
  private readonly ultimaChecagem = new Map<string, number>();

  /** Janela igual à do reconciliador do PDV: PIX pago no sábado à noite tem
   *  que sobreviver até o caixa abrir na segunda. */
  private static readonly JANELA_H = 72;
  private static readonly MAX_POR_CICLO = 25;

  constructor(
    private readonly prisma: PrismaService,
    private readonly pagbank: PagbankService,
    @Inject(forwardRef(() => CrediarioBaixaService))
    private readonly crediarioBaixa: CrediarioBaixaService,
  ) {}

  /**
   * Intervalo entre consultas da MESMA cobrança, por idade.
   *
   * Os primeiros minutos são os que a vendedora está olhando pra tela — aí
   * vale perguntar de minuto em minuto. Depois disso ninguém está esperando em
   * pé, e o que importa é só não perder o pagamento: de 10 em 10 minutos, e
   * depois de hora em hora, resolve com uma fração das chamadas.
   */
  private throttleMs(idadeMs: number): number {
    if (idadeMs < 30 * 60_000) return 60_000; // < 30min → 1 min
    if (idadeMs < 6 * 3600_000) return 10 * 60_000; // < 6h → 10 min
    return 60 * 60_000; // resto da janela → 1 h
  }

  @Cron('*/40 * * * * *', { name: 'pagbank-pix-reconcile' })
  async reconciliar(): Promise<void> {
    if (process.env.PAGBANK_RECONCILE === '0') return;
    if (this.rodando) return; // guard de overlap — nunca empilha ciclo
    this.rodando = true;
    try {
      await this.rodar();
    } catch (e: any) {
      // Reconciliador que quebra não derruba nada: o estado no banco não muda
      // com a falha e o próximo ciclo tenta de novo.
      this.logger.error(`[pagbank-reconcile] ciclo falhou: ${e?.message || e}`);
    } finally {
      this.rodando = false;
    }
  }

  private async rodar(): Promise<void> {
    const agora = Date.now();
    const desde = new Date(agora - PagbankPixReconcileService.JANELA_H * 3600_000);

    const pendentes: Array<{
      pagbankOrderId: string;
      saleId: string;
      storeCode: string;
      valor: number;
      createdAt: Date;
      expiresAt: Date | null;
    }> = await (this.prisma as any).pagbankPayment.findMany({
      where: { status: 'pending', method: 'pix', createdAt: { gte: desde } },
      orderBy: { createdAt: 'desc' },
      take: 300,
      select: {
        pagbankOrderId: true,
        saleId: true,
        storeCode: true,
        valor: true,
        createdAt: true,
        expiresAt: true,
      },
    });
    if (!pendentes.length) return;

    let consultadas = 0;
    let confirmadas = 0;

    for (const p of pendentes) {
      if (consultadas >= PagbankPixReconcileService.MAX_POR_CICLO) break;
      if (!p.pagbankOrderId) continue;

      const idade = agora - new Date(p.createdAt).getTime();
      const ultima = this.ultimaChecagem.get(p.pagbankOrderId) || 0;
      if (agora - ultima < this.throttleMs(idade)) continue;
      this.ultimaChecagem.set(p.pagbankOrderId, agora);
      consultadas++;

      try {
        // `checkOrderStatus` já persiste `paid` — é ele que alimenta o
        // reconciliador do PDV, que fecha a venda no ciclo seguinte.
        const r: any = await this.pagbank.checkOrderStatus(p.pagbankOrderId);

        if (!r?.isPaid) {
          await this.aposentarSeVencida(p, agora);
          continue;
        }

        confirmadas++;
        this.logger.log(
          `[pagbank-reconcile] PAGO fora do webhook: order=${p.pagbankOrderId} ` +
            `sale=${p.saleId} loja=${p.storeCode} R$${Number(p.valor || 0).toFixed(2)} ` +
            `(${Math.round(idade / 60_000)}min depois de gerado)`,
        );

        /**
         * Mesmo efeito colateral do webhook. A venda de PDV NÃO é fechada
         * aqui de propósito — quem faz isso é o `PixPagbankReconcileService`
         * lá no PdvModule, que já enxerga esta linha agora que ela está
         * `paid`. Chamar o PDV daqui recriaria o ciclo de módulos que
         * derrubou o backend em 07/08.
         */
        try {
          await this.crediarioBaixa.confirmBaixaPixIfExists(p.saleId);
        } catch (e: any) {
          this.logger.warn(
            `[pagbank-reconcile] baixa de crediário falhou (${p.saleId}): ${e?.message || e}`,
          );
        }
      } catch (e: any) {
        // Rede caiu / order sumiu do gateway: não derruba o ciclo.
        this.logger.warn(
          `[pagbank-reconcile] consulta falhou (${p.pagbankOrderId}): ${e?.message || e}`,
        );
      }
    }

    if (confirmadas > 0) {
      this.logger.log(
        `[pagbank-reconcile] ciclo: ${consultadas} consultadas · ${confirmadas} confirmadas`,
      );
    }
    // Poda o mapa de throttle pra não crescer sem fim.
    if (this.ultimaChecagem.size > 2000) this.ultimaChecagem.clear();
  }

  /**
   * QR vencido há horas + PagBank dizendo que não foi pago = cobrança morta.
   *
   * Marca `expired` pra ela sair da fila. As 6h de folga depois do vencimento
   * são de propósito: o pagamento pode ter entrado nos últimos segundos de
   * validade e demorar a aparecer na consulta. Enquanto essa folga não passa,
   * a linha continua sendo perguntada (cada vez mais devagar).
   */
  private async aposentarSeVencida(
    p: { pagbankOrderId: string; expiresAt: Date | null },
    agora: number,
  ): Promise<void> {
    if (!p.expiresAt) return;
    const vencidaHa = agora - new Date(p.expiresAt).getTime();
    if (vencidaHa < 6 * 3600_000) return;
    await this.pagbank.marcarExpirado(p.pagbankOrderId);
  }
}
