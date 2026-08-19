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
 * `diasAposEntrega` da tela da matriz (a MESMA régua que libera a peça no
 * centro de avaliação: convidar antes de liberar seria mandar a cliente pra uma
 * tela vazia).
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
 * Kill-switch: o mesmo `ativo` do programa de avaliação, na tela da matriz.
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
            lte: new Date(agora - cfg.diasAposEntrega * 86_400_000),
          },
          // Sem convite ainda. A linha da tabela É a marca — não existe coluna
          // "já convidei" no pedido pra sair de sincronia com ela.
          avaliacaoConvite: null,
          // Sem telefone não há por onde chamar; a retaguarda ainda vê o pedido
          // na aba e pode copiar o link à mão.
          customerPhone: { not: null },
        },
        select: { id: true, wcOrderNumber: true },
        orderBy: { deliveredAt: 'asc' },
        take: PosVendaConviteCron.LOTE,
      });
      if (!pedidos.length) return;

      let enviados = 0;
      for (const p of pedidos) {
        try {
          const convite = await this.posVenda.criarConvite(p.id);
          if (convite.enviadoEm) continue; // já saiu por outro caminho
          if (await this.posVenda.enviarConvite(convite.id, 'whatsapp')) enviados++;
        } catch (e: any) {
          this.logger.warn(`[pos-venda] convite do pedido ${p.wcOrderNumber}: ${e?.message || e}`);
        }
      }
      if (enviados) {
        this.logger.log(`[pos-venda] ${enviados}/${pedidos.length} convite(s) de avaliação enviados`);
      }
    } catch (e: any) {
      this.logger.error(`[pos-venda] ciclo falhou: ${e?.message || e}`);
    } finally {
      this.running = false;
    }
  }
}
