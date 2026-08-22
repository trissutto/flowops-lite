import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { AvaliacoesConfigService } from '../avaliacoes/avaliacoes-config.service';
import { ORIGENS_POS_VENDA, PosVendaService } from './pos-venda.service';

/**
 * "COMO FICOU?" — o convite que sai sozinho depois da entrega.
 *
 * ── POR QUE DEPOIS, E NÃO NO DIA ──
 *
 * No dia da entrega ela ainda não vestiu. A avaliação útil — serviu? o tecido é
 * o que parecia? a cor é a da foto? — só existe depois de usar. O prazo é o
 * `diasConvite` da tela da matriz (padrão 5, pedido do dono) — que é OUTRO
 * número do `diasAposEntrega`: esse diz quando a peça LIBERA pra avaliação, e
 * zero está certo lá (se ela entrar na conta no dia da entrega, a peça tem que
 * estar esperando). Amarrar os dois no mesmo número fazia o convite sair junto
 * com a entrega.
 *
 * ── A FONTE É O RASTREIO ──
 *
 * O marco é `deliveredAt`, carimbado pelo `RastreioSyncCron` quando a
 * transportadora confirma — a mesma fonte do aviso "seu pedido chegou". Pedido
 * dividido só chega nesse estado quando TODAS as caixas foram entregues.
 *
 * ── A REGRA DA ESTREIA VALE AQUI TAMBÉM ──
 *
 * A janela de 30 dias impede que o primeiro deploy mande "conta pra gente como
 * ficou" pra quem recebeu em maio. Entrega velha demais é notícia velha:
 * aparece na tela da retaguarda e não vira mensagem.
 *
 * 🔴 E A JANELA SOZINHA NÃO BASTA (22/08). A reconciliação do
 * `RastreioSyncCron` fechou de uma vez 255 pedidos que estavam entregues havia
 * semanas e presos em `shipped` — e 68 deles caíam DENTRO da janela de 30
 * dias, prontos pra virar 68 WhatsApps de "como ficou?" pra quem recebeu a
 * peça há duas semanas. **Decisão do dono, 22/08: não mandar.**
 *
 * A trava não é a data, é a PROCEDÊNCIA da entrega: objeto marcado
 * `entregaNaEstreia` é aquele que já estava entregue na PRIMEIRA vez que o
 * sistema olhou pra ele. A gente descobriu tarde — pra cliente, isso é notícia
 * velha, exatamente como no aviso "seu pedido chegou", que já não sai nesse
 * caso. Entrega acompanhada ao vivo (o caminho normal) não tem a marca e
 * continua convidando igual.
 *
 * Kill-switch: o mesmo `ativo` do programa de avaliação, na tela da matriz.
 * `POS_VENDA_CONVIDA_ESTREIA=1` derruba esta trava (volta a convidar quem
 * entrou no radar já entregue).
 */
@Injectable()
export class PosVendaConviteCron {
  private readonly logger = new Logger(PosVendaConviteCron.name);
  private running = false;

  /** Teto por ciclo — cada linha é uma mensagem pra cliente, não um request. */
  private static readonly LOTE = 25;
  private static readonly JANELA_DIAS = 30;

  constructor(
    private readonly prisma: PrismaService,
    private readonly posVenda: PosVendaService,
    private readonly cfgSvc: AvaliacoesConfigService,
  ) {}

  /**
   * Tira da fila o pedido cuja entrega a gente DESCOBRIU tarde (22/08).
   *
   * `entregaNaEstreia` marca o objeto que já estava entregue na primeira vez
   * que o sistema olhou pra ele. O `deliveredAt` desse pedido é a data real da
   * entrega, então ele passa na janela de 30 dias como se fosse recente — mas
   * pra cliente é notícia velha, e mandar "como ficou?" duas semanas depois,
   * em lote, é o que o dono vetou quando a reconciliação fechou 255 pedidos de
   * uma vez.
   *
   * Basta UMA caixa marcada pra segurar o pedido: num pedido dividido, se
   * qualquer volume só apareceu depois de entregue, a entrega inteira foi
   * descoberta tarde.
   *
   * Falhou a consulta? Convida — a trava é uma proteção A MAIS, e perder
   * avaliação boa por causa de um erro de banco é pior que o risco que ela
   * cobre. Mesma postura do guard do carrinho.
   */
  private async semEntregaVelha<T extends { trackingCode?: string | null; pickOrders?: Array<{ trackingCode: string | null }> }>(
    pedidos: T[],
  ): Promise<T[]> {
    if (String(process.env.POS_VENDA_CONVIDA_ESTREIA ?? '0') === '1') return pedidos;
    const codigos = [
      ...new Set(
        pedidos
          .flatMap((p) => [p.trackingCode, ...(p.pickOrders ?? []).map((x) => x.trackingCode)])
          .map((c) => String(c || '').trim().toUpperCase())
          .filter(Boolean),
      ),
    ];
    if (!codigos.length) return pedidos;

    let velhos = new Set<string>();
    try {
      const linhas: any[] = await (this.prisma as any).rastreioObjeto.findMany({
        where: { codigo: { in: codigos }, entregaNaEstreia: true },
        select: { codigo: true },
      });
      velhos = new Set(linhas.map((l) => String(l.codigo).toUpperCase()));
    } catch (e: any) {
      this.logger.warn(`[pos-venda] não consegui conferir a procedência da entrega (convida): ${e?.message || e}`);
      return pedidos;
    }
    if (!velhos.size) return pedidos;

    const elegiveis = pedidos.filter(
      (p) =>
        ![p.trackingCode, ...(p.pickOrders ?? []).map((x) => x.trackingCode)]
          .map((c) => String(c || '').trim().toUpperCase())
          .filter(Boolean)
          .some((c) => velhos.has(c)),
    );
    const segurados = pedidos.length - elegiveis.length;
    if (segurados) {
      this.logger.log(
        `[pos-venda] ${segurados} convite(s) segurados — entrega descoberta já concluída (notícia velha)`,
      );
    }
    return elegiveis;
  }

  @Cron('40 * * * *', { name: 'pos-venda-convite' })
  async run(): Promise<void> {
    if (this.running) return; // ciclo anterior ainda rodando
    this.running = true;
    try {
      const cfg = await this.cfgSvc.get();
      if (!cfg.ativo) return;

      const agora = Date.now();
      const pedidos: any[] = await (this.prisma as any).order.findMany({
        where: {
          status: 'delivered',
          source: { in: ORIGENS_POS_VENDA },
          deliveredAt: {
            gte: new Date(agora - PosVendaConviteCron.JANELA_DIAS * 86_400_000),
            lte: new Date(agora - cfg.diasConvite * 86_400_000),
          },
          // Sem convite ainda. A linha da tabela É a marca — não existe coluna
          // "já convidei" no pedido pra sair de sincronia com ela.
          avaliacaoConvite: null,
          // Sem telefone não há por onde chamar; a retaguarda ainda vê o pedido
          // na aba e pode copiar o link à mão.
          customerPhone: { not: null },
        },
        select: {
          id: true,
          wcOrderNumber: true,
          // Precisam vir junto pra conferir a procedência da entrega logo
          // abaixo — pedido dividido tem um código por caixa.
          trackingCode: true,
          pickOrders: { select: { trackingCode: true } },
        },
        orderBy: { deliveredAt: 'asc' },
        take: PosVendaConviteCron.LOTE,
      });
      if (!pedidos.length) return;

      const elegiveis = await this.semEntregaVelha(pedidos);
      if (!elegiveis.length) return;

      let enviados = 0;
      for (const p of elegiveis) {
        try {
          const convite = await this.posVenda.criarConvite(p.id);
          if (convite.enviadoEm) continue; // já saiu por outro caminho
          if (await this.posVenda.enviarConvite(convite.id, 'whatsapp')) enviados++;
        } catch (e: any) {
          this.logger.warn(`[pos-venda] convite do pedido ${p.wcOrderNumber}: ${e?.message || e}`);
        }
      }
      if (enviados) {
        this.logger.log(`[pos-venda] ${enviados}/${elegiveis.length} convite(s) de avaliação enviados`);
      }
    } catch (e: any) {
      this.logger.error(`[pos-venda] ciclo falhou: ${e?.message || e}`);
    } finally {
      this.running = false;
    }
  }
}
