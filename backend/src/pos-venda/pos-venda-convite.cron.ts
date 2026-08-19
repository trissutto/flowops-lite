import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { ORIGENS_POS_VENDA, PosVendaService } from './pos-venda.service';

/**
 * "COMO FICOU?" — o convite que sai sozinho no 5º dia depois da entrega.
 *
 * ── POR QUE D+5 E NÃO NO DIA ──
 *
 * No dia da entrega ela ainda não vestiu. A avaliação útil — serviu? o tecido é
 * o que parecia? a cor é a da foto? — só existe depois de usar. Cinco dias é o
 * ponto em que ela já experimentou e ainda lembra do site.
 *
 * ── A FONTE É O RASTREIO, NÃO O ENVIO ──
 *
 * O marco é `deliveredAt`, carimbado pelo `RastreioSyncCron` quando a
 * transportadora confirma — a mesma fonte do aviso "seu pedido chegou". Pedido
 * dividido só chega a esse estado quando TODAS as caixas foram entregues, então
 * o convite nunca sai com peça ainda no caminhão.
 *
 * ── A REGRA DA ESTREIA VALE AQUI TAMBÉM ──
 *
 * A janela (`janelaDias`, 30 por padrão) impede que o primeiro deploy mande
 * "conta pra gente como ficou" pra quem recebeu em maio. Entrega velha demais é
 * notícia velha: aparece na tela da retaguarda e não vira mensagem.
 *
 * Kill-switch: `POS_VENDA_AVALIACAO=0` ou `ativo:false` na configuração.
 */
@Injectable()
export class PosVendaConviteCron {
  private readonly logger = new Logger(PosVendaConviteCron.name);
  private running = false;

  /** Teto por ciclo — cada linha é uma mensagem pra cliente, não um request. */
  private static readonly LOTE = 25;

  constructor(
    private readonly prisma: PrismaService,
    private readonly posVenda: PosVendaService,
  ) {}

  @Cron('40 * * * *', { name: 'pos-venda-convite' })
  async run(): Promise<void> {
    if (this.running) return; // ciclo anterior ainda rodando
    this.running = true;
    try {
      const cfg = await this.posVenda.lerConfig();
      if (!cfg.ativo) return;

      const agora = Date.now();
      const ate = new Date(agora - cfg.diasAposEntrega * 86_400_000);
      const desde = new Date(agora - cfg.janelaDias * 86_400_000);

      const pedidos: any[] = await (this.prisma as any).order.findMany({
        where: {
          status: 'delivered',
          source: { in: ORIGENS_POS_VENDA },
          deliveredAt: { gte: desde, lte: ate },
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
          const ok = await this.posVenda.enviarConvite(convite.id, 'whatsapp');
          if (ok) enviados++;
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
