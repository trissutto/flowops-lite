import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { PickOrdersService } from './pick-orders.service';
import { corteDaNotaSemEnvio } from '../common/emitente-venda-online';

/**
 * VARREDURA DA NOTA DE RETIRADA E MOTOBOY (04/10/2026).
 *
 * A NF-e da venda online só nascia no "Gerar envio" dos Correios. Retirada e
 * motoboy não geram etiqueta, e a venda online pula o cupom no caixa — a peça
 * saía sem documento fiscal nenhum (77 pedidos pagos no PagBank em 30 dias,
 * R$ 21,1 mil; o caso que o dono viu foi o ON-000592, R$ 2.788,30, retirada
 * em Limeira). Ordem do dono: emitir automática, pela mesma regra do link — a
 * nota sai pela empresa da conta que recebeu.
 *
 * POR QUE VARREDURA e não um gancho no fechamento: o pedido de motoboy fecha
 * DENTRO do finalize do caixa (`PedidoOnlineService`, no PdvModule — que não
 * pode ganhar import de módulo novo: foi um import assim que impediu o backend
 * de subir em 07/08), e a retirada fecha no `updateStatus`, que é a porta mais
 * movimentada da loja. Emitir nota fala com a SEFAZ — segundos, às vezes
 * timeout. Nenhum dos dois caminhos pode esperar por isso nem cair junto.
 * Aqui a nota sai até 5 minutos depois, fora do caminho de todo mundo, e um
 * deploy no meio não perde nada: o próximo ciclo pega.
 *
 * O SQL só ESCOLHE candidatos baratos; quem decide (conta que cobrou, cupom já
 * emitido, uma tentativa só, o que fazer com cadastro sem endereço) é o
 * `PickOrdersService.emitirNotaSemEnvio`.
 *
 * NADA RETROATIVO: só pedido criado depois do corte (`corteDaNotaSemEnvio`,
 * 04/10) e fechado nas últimas 72h. Kill-switch: `NFE_NOTA_SEM_ENVIO=0`.
 */
@Injectable()
export class NotaVendaOnlineCron implements OnApplicationBootstrap {
  private readonly logger = new Logger(NotaVendaOnlineCron.name);
  private running = false;

  /** Quanto tempo depois de fechado o pedido ainda é candidato. */
  private static readonly JANELA_MS = 72 * 60 * 60 * 1000;
  /** Teto de EMISSÕES por ciclo — cada nota é uma chamada à SEFAZ. */
  private static readonly LOTE = 15;
  /** Teto de candidatos lidos por ciclo (rede de segurança; o normal são poucas dezenas). */
  private static readonly MAX_CANDIDATOS = 300;

  constructor(
    private readonly prisma: PrismaService,
    private readonly pickOrders: PickOrdersService,
  ) {}

  private get enabled(): boolean {
    return (
      String(process.env.NFE_NOTA_SEM_ENVIO ?? '1').trim() !== '0' &&
      String(process.env.NFE_ENVIO_ENABLED || '').trim() === '1'
    );
  }

  /** Primeira rodada 2 min depois do boot — o app já está servindo e não disputa a subida. */
  onApplicationBootstrap() {
    const t = setTimeout(() => void this.run(), 120_000);
    (t as any).unref?.();
  }

  @Cron('*/5 * * * *')
  async run(): Promise<void> {
    if (!this.enabled || this.running) return;
    this.running = true;
    try {
      const corte = corteDaNotaSemEnvio();
      const desde = new Date(Math.max(corte.getTime(), Date.now() - NotaVendaOnlineCron.JANELA_MS));

      // Pedido fechado na própria vendedora (motoboy com a peça na mão): sem card.
      const semCard = await this.prisma.order.findMany({
        where: {
          source: 'pdv_online',
          status: { in: ['shipped', 'delivered'] },
          createdAt: { gte: corte },
          shippedAt: { gte: desde },
          pickOrders: { none: {} },
          history: { none: { note: { startsWith: '[nota-auto]' } } },
        },
        select: { id: true },
        orderBy: { shippedAt: 'asc' },
        take: NotaVendaOnlineCron.MAX_CANDIDATOS,
      });

      // Card da cliente fechado em pedido de RETIRADA ou MOTOBOY ("Cliente
      // retirou" / "Entregue por motoboy"). O filtro é pela FORMA DE ENTREGA
      // do pedido, não por "card sem rastreio": a loja às vezes digita
      // qualquer coisa no campo do código pra fechar o card.
      const comCard = await this.prisma.pickOrder.findMany({
        where: {
          status: 'shipped',
          isTransfer: false,
          updatedAt: { gte: desde },
          order: {
            source: 'pdv_online',
            status: { in: ['shipped', 'delivered'] },
            createdAt: { gte: corte },
            OR: [{ isPickup: true }, { shippingMethod: { contains: 'motoboy', mode: 'insensitive' } }],
            history: { none: { note: { startsWith: '[nota-auto]' } } },
          },
        },
        select: { orderId: true },
        orderBy: { updatedAt: 'asc' },
        take: NotaVendaOnlineCron.MAX_CANDIDATOS,
      });

      const ids = Array.from(new Set([...semCard.map((o) => o.id), ...comCard.map((p) => p.orderId)]));
      if (!ids.length) return;

      /**
       * O teto é de EMISSÕES, não de candidatos. Venda paga fora do gateway é
       * "pulada" sem deixar marca (não há o que registrar) e volta a ser
       * candidata a cada ciclo: se o corte fosse nos candidatos, quinze delas
       * na frente da fila deixariam a venda do link sem nota pra sempre.
       */
      const placar: Record<string, number> = {};
      let emissoes = 0;
      for (const id of ids) {
        if (emissoes >= NotaVendaOnlineCron.LOTE) break;
        try {
          const r = await this.pickOrders.emitirNotaSemEnvio(id);
          placar[r.resultado] = (placar[r.resultado] ?? 0) + 1;
          if (r.resultado !== 'pulada') emissoes++;
        } catch (e: any) {
          // Erro que escapou (banco, leitura) — não marca o pedido: o próximo
          // ciclo tenta de novo. Fica o log pra não sumir calado.
          placar.erro = (placar.erro ?? 0) + 1;
          this.logger.warn(`[nota-auto] pedido ${id}: ${e?.message || e}`);
        }
      }
      // "pulada" é o normal (venda paga fora do gateway, cupom já emitido…) —
      // só fala quando algo aconteceu de fato.
      const houve = Object.keys(placar).some((k) => k !== 'pulada');
      if (houve) {
        this.logger.log(
          `[nota-auto] ${ids.length} candidato(s): ` +
            Object.entries(placar).map(([k, v]) => `${v} ${k}`).join(' · '),
        );
      }
    } catch (e: any) {
      this.logger.warn(`[nota-auto] varredura falhou: ${e?.message || e}`);
    } finally {
      this.running = false;
    }
  }
}
