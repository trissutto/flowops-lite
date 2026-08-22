import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { TrackingService } from './tracking.service';

/**
 * ACOMPANHA O OBJETO ATÉ CHEGAR (18/08).
 *
 * O ciclo do pedido terminava em "Enviado" e ficava lá pra sempre: nenhum
 * pedido virou `delivered` em 90 dias, a loja que vendeu não sabia dizer se a
 * peça chegou e o prazo de troca não tinha marco zero. Este cron mantém
 * `rastreio_objetos` fresco e, quando a transportadora confirma a entrega,
 * fecha o pedido.
 *
 * ESCADA DE FREQUÊNCIA — objeto postado hoje muda de estado o tempo todo;
 * objeto de três semanas quase nunca. Consultar todos na mesma cadência
 * gastaria a API à toa, então:
 *   até 3 dias no radar → de hora em hora
 *   4 a 10 dias         → de 4 em 4 horas
 *   11 a 30 dias        → 1x por dia
 *   entregue            → nunca mais (o dado já está fechado)
 *
 * Kill-switch `RASTREIO_SYNC=0`. Teto por ciclo em `RASTREIO_SYNC_LOTE`.
 */
@Injectable()
export class RastreioSyncCron {
  private readonly logger = new Logger(RastreioSyncCron.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tracking: TrackingService,
  ) {}

  private get enabled(): boolean {
    return String(process.env.RASTREIO_SYNC ?? '1').trim() !== '0';
  }

  private get lote(): number {
    const n = parseInt(String(process.env.RASTREIO_SYNC_LOTE ?? '60'), 10);
    return Number.isFinite(n) && n > 0 ? n : 60;
  }

  /** Quanto tempo esperar antes de reconsultar, pela idade no radar. */
  private intervaloHoras(desde: Date | null): number {
    if (!desde) return 0;
    const dias = (Date.now() - desde.getTime()) / 86_400_000;
    if (dias <= 3) return 1;
    if (dias <= 10) return 4;
    return 24;
  }

  @Cron('*/30 * * * *', { name: 'rastreio-sync' })
  async run(): Promise<void> {
    if (!this.enabled) return;
    if (this.running) return; // ciclo anterior ainda rodando (API é lenta)
    this.running = true;
    try {
      // Endireita o código torto ANTES de tudo: enquanto ele estiver com
      // espaço/minúscula não passa no `ehCodigoValido`, então nem a fila nem
      // a reconciliação enxergam o objeto.
      await this.normalizarCodigosTortos();

      // Vem ANTES da varredura: é o passo que fecha o pedido cuja entrega já
      // está confirmada no cache e que a fila abaixo nunca mais visita (a
      // fila descarta `entregue` de propósito). Sem isto, o `return` do
      // "nenhum candidato" logo abaixo pularia a reconciliação inteira.
      await this.reconciliarEntregues();

      const candidatos = await this.candidatos();
      if (!candidatos.length) return;

      const cache = await this.tracking.resumoDoCache(candidatos);
      const cru: any[] = await (this.prisma as any).rastreioObjeto.findMany({
        where: { codigo: { in: candidatos } },
        select: { codigo: true, createdAt: true, consultadoEm: true, entregue: true },
      });
      const porCodigo = new Map(cru.map((r) => [r.codigo, r]));

      const fila = candidatos
        .filter((c) => {
          const r = porCodigo.get(c);
          if (!r) return true;                 // nunca olhamos pra ele
          if (r.entregue) return false;        // acabou o ciclo
          if (!r.consultadoEm) return true;
          const esperar = this.intervaloHoras(r.createdAt) * 3_600_000;
          return Date.now() - new Date(r.consultadoEm).getTime() >= esperar;
        })
        // Mais desatualizado primeiro: com teto por ciclo, é o que garante que
        // todo objeto é visitado em vez de sempre os mesmos.
        .sort((a, b) => {
          const ta = porCodigo.get(a)?.consultadoEm ? new Date(porCodigo.get(a)!.consultadoEm).getTime() : 0;
          const tb = porCodigo.get(b)?.consultadoEm ? new Date(porCodigo.get(b)!.consultadoEm).getTime() : 0;
          return ta - tb;
        })
        .slice(0, this.lote);

      if (!fila.length) return;

      const { consultados, entreguesAgora } = await this.tracking.sincronizarLote(fila);
      if (entreguesAgora.length) await this.promoverEntregues(entreguesAgora);

      this.logger.log(
        `[rastreio-sync] ${consultados}/${fila.length} objeto(s) atualizados` +
          `${entreguesAgora.length ? ` · ${entreguesAgora.length} entregue(s) agora` : ''}` +
          ` (fila total: ${candidatos.length})`,
      );
      // `cache` só entra aqui pra manter a leitura numa consulta só; o dado
      // usado é o `cru` acima.
      void cache;
    } catch (e: any) {
      this.logger.error(`[rastreio-sync] ciclo falhou: ${e?.message || e}`);
    } finally {
      this.running = false;
    }
  }

  /**
   * Objetos que ainda importam: despachados nos últimos 30 dias, do pedido ou
   * da separação. Passou disso, os Correios já não têm o que dizer e o custo
   * de perguntar é do nosso lado.
   */
  private async candidatos(): Promise<string[]> {
    const desde = new Date(Date.now() - 30 * 86_400_000);
    const [pedidos, cards] = await Promise.all([
      (this.prisma as any).order.findMany({
        where: { status: 'shipped', trackingCode: { not: null }, updatedAt: { gte: desde } },
        select: { trackingCode: true },
        take: 2000,
      }),
      (this.prisma as any).pickOrder.findMany({
        where: { status: 'shipped', trackingCode: { not: null }, updatedAt: { gte: desde } },
        select: { trackingCode: true },
        take: 2000,
      }),
    ]);
    return [
      ...new Set(
        [...pedidos, ...cards]
          .map((r: any) => String(r.trackingCode || '').trim().toUpperCase())
          .filter((c: string) => TrackingService.ehCodigoValido(c)),
      ),
    ];
  }

  /**
   * 🔴 ETIQUETA CERTA, DIGITADA ERRADA (22/08).
   *
   * A loja digita o rastreio na mão. Medido na base inteira: **1.026 códigos
   * em `orders` fora do padrão dos Correios, e 914 viram etiqueta válida só
   * tirando espaço e subindo pra maiúscula** ("AD 717 071 708 BR",
   * "ad718148023br", "aN856224448BR") — 913 deles em `shipped`. Mais 1.061
   * na `pick_orders`. Enquanto está torto, o `ehCodigoValido` reprova, o
   * objeto NUNCA é consultado, o pedido nunca fecha e ele fica em "Em
   * trânsito" até envelhecer pros 30 dias e cair em "Concluídos" sem
   * ninguém nunca ter confirmado que chegou.
   *
   * A entrada já é arrumada no `marcarEnviado` — isto aqui é o passivo. Roda
   * junto do ciclo e some sozinho: quando não houver mais torto, a consulta
   * volta vazia e o passo custa uma query.
   *
   * ⚠️ NUNCA reescreve pra um código que outro pedido já usa: rastreio
   * repetido faz dois pedidos compartilharem a mesma entrega e um deles
   * fecha por engano. A conferência é por linha, e a que colide fica como
   * está (aparece no log pra alguém olhar).
   *
   * `RASTREIO_NORMALIZA=0` desliga. Teto: `RASTREIO_NORMALIZA_LOTE` (200).
   */
  private async normalizarCodigosTortos(): Promise<void> {
    if (String(process.env.RASTREIO_NORMALIZA ?? '1') === '0') return;
    const n = parseInt(String(process.env.RASTREIO_NORMALIZA_LOTE ?? '200'), 10);
    const lote = Number.isFinite(n) && n > 0 ? n : 200;

    for (const tabela of ['orders', 'pick_orders'] as const) {
      const tortos: Array<{ id: string; tracking_code: string }> = await this.prisma.$queryRawUnsafe(
        `SELECT id, tracking_code FROM ${tabela}
          WHERE tracking_code IS NOT NULL AND tracking_code <> ''
            AND tracking_code !~ '^[A-Z]{2}[0-9]{9}[A-Z]{2}$'
          LIMIT $1`,
        lote,
      );
      let arrumados = 0;
      for (const linha of tortos) {
        const novo = TrackingService.normalizarCodigo(linha.tracking_code);
        // Só mexe no que VIRA etiqueta. "MOTOBOY"/"retirada em loja" ficam.
        if (novo === linha.tracking_code || !TrackingService.ehCodigoValido(novo as string)) continue;
        const colide: Array<{ n: number }> = await this.prisma.$queryRawUnsafe(
          `SELECT COUNT(*)::int AS n FROM ${tabela} WHERE tracking_code = $1 AND id <> $2`,
          novo,
          linha.id,
        );
        if (Number(colide[0]?.n ?? 0) > 0) {
          this.logger.warn(
            `[rastreio-sync] ${tabela} ${linha.id}: "${linha.tracking_code}" viraria ${novo}, que já é de outro registro — deixei como está`,
          );
          continue;
        }
        await this.prisma.$executeRawUnsafe(
          `UPDATE ${tabela} SET tracking_code = $1 WHERE id = $2`,
          novo,
          linha.id,
        );
        arrumados++;
      }
      if (arrumados) {
        this.logger.log(`[rastreio-sync] ${arrumados} código(s) de rastreio endireitados em ${tabela}`);
      }
    }
  }

  /**
   * 🔴 O PEDIDO ENTREGUE QUE NUNCA FECHAVA (22/08) — a regra da estreia estava
   * derrubando a BAIXA junto com o aviso.
   *
   * Medido: 255 pedidos com `status='shipped'` e o cache dizendo `entregue`.
   * Desses, **205 de 206** dentro da janela de 30 dias tinham
   * `entrega_na_estreia = true`. 122 estavam entregues havia mais de 15 dias.
   *
   * O caminho que prendia: `sincronizarLote` só põe o código em
   * `entreguesAgora` se `antes.has(codigo)` — ou seja, se o objeto JÁ existia
   * no cache antes daquela sincronização. Isso é a regra da estreia, e ela é
   * CERTA pro aviso ("seu pedido chegou" pra quem recebeu semana passada é
   * constrangedor). Só que `entreguesAgora` também era o ÚNICO gancho da
   * PROMOÇÃO pra `delivered` — então o objeto que estreou entregue nunca
   * fechava o pedido. E como a fila do cron descarta `entregue` pra sempre
   * (`if (r.entregue) return false`), ele nunca mais era revisitado: estado
   * terminal, sem ninguém pra reconciliar.
   *
   * O estrago: a aba "Em trânsito" mostrava 358 quando o real era ~152;
   * pedido entregue não ganhava `deliveredAt`, então não entrava no pós-venda
   * nem no prazo de troca; e a loja não sabia que tinha chegado.
   *
   * Este passo é a rede: varre pedido `shipped` cujo cache diz entregue e
   * promove pelo MESMO `promoverEntregues` (que respeita pedido dividido).
   * Não toca no caminho do aviso — quem avisa continua sendo o
   * `entreguesAgora`, com a estreia intacta.
   *
   * Kill-switch: `RASTREIO_RECONCILIA=0`. Teto: `RASTREIO_RECONCILIA_LOTE`
   * (default 40) — trickle em vez de fechar 255 pedidos de uma vez.
   */
  private async reconciliarEntregues(): Promise<void> {
    if (String(process.env.RASTREIO_RECONCILIA ?? '1') === '0') return;
    const n = parseInt(String(process.env.RASTREIO_RECONCILIA_LOTE ?? '40'), 10);
    const lote = Number.isFinite(n) && n > 0 ? n : 40;

    /**
     * O código vem do PEDIDO (e do pick-order do pedido dividido), não do
     * cache: é o pedido preso que interessa, e `promoverEntregues` reconfere
     * volume a volume antes de fechar.
     */
    /**
     * ⚠️ SÓ ENTRA QUEM CONSEGUE FECHAR (corrigido na estreia, 22/08).
     *
     * A primeira versão pedia "código entregue" e deixava o
     * `promoverEntregues` decidir. Só que pedido DIVIDIDO com uma caixa
     * entregue e outra na rua não fecha — e, como o pedido continua
     * `shipped`, o código voltava na consulta do ciclo seguinte, e do
     * seguinte, pra sempre. Medido em produção logo depois do deploy: 187
     * pedidos na fila, 171 fechavam e **16 ocupavam vaga sem nunca fechar**
     * (todos divididos). Com teto de 40, isso queimava 40% do lote por
     * ciclo; se um dia os travados passassem de 40, a fila PARAVA e o buraco
     * voltava calado.
     *
     * Agora o `BOOL_AND` resolve no banco: o pedido só aparece quando TODOS
     * os volumes dele estão entregues. O `promoverEntregues` reconfere assim
     * mesmo — proteção em duas camadas, porque fechar pedido cuja caixa
     * ainda está na rua faz a loja dizer pra cliente que chegou tudo.
     */
    const presos: Array<{ codigo: string }> = await this.prisma.$queryRawUnsafe(
      `WITH cod AS (
           SELECT o.id, o.tracking_code AS codigo FROM orders o WHERE o.status='shipped' AND o.tracking_code IS NOT NULL
           UNION ALL
           SELECT o.id, po.tracking_code FROM orders o
             JOIN pick_orders po ON po.order_id = o.id
            WHERE o.status='shipped' AND po.tracking_code IS NOT NULL
         ),
         pedido AS (
           SELECT c.id, BOOL_AND(COALESCE(r.entregue, false)) AS todos_entregues
             FROM cod c LEFT JOIN rastreio_objetos r ON r.codigo = c.codigo
            GROUP BY c.id
         )
       SELECT DISTINCT c.codigo
         FROM cod c JOIN pedido p ON p.id = c.id
        WHERE p.todos_entregues
        ORDER BY c.codigo
        LIMIT $1`,
      lote,
    );
    if (!presos.length) return;

    await this.promoverEntregues(presos.map((p) => p.codigo));
    this.logger.log(
      `[rastreio-sync] reconciliação: ${presos.length} objeto(s) com entrega confirmada revisitados`,
    );
  }

  /**
   * Pedido entregue → `delivered` + `deliveredAt`.
   *
   * ⚠️ PEDIDO DIVIDIDO só fecha quando TODAS as caixas chegam: o pacote da
   * outra loja ainda pode estar em trânsito, e dizer "entregue" ali faria a
   * loja responder pra cliente que já chegou tudo. A data é a da ÚLTIMA
   * entrega — é dela que o prazo de troca corre.
   */
  private async promoverEntregues(codigos: string[]): Promise<void> {
    for (const codigo of codigos) {
      const pedidos: any[] = await (this.prisma as any).order.findMany({
        where: {
          status: 'shipped',
          OR: [{ trackingCode: codigo }, { pickOrders: { some: { trackingCode: codigo } } }],
        },
        select: {
          id: true,
          wcOrderNumber: true,
          trackingCode: true,
          pickOrders: { select: { trackingCode: true } },
        },
        take: 20,
      });

      for (const p of pedidos) {
        const doPedido = [p.trackingCode, ...p.pickOrders.map((x: any) => x.trackingCode)]
          .map((c: any) => String(c || '').trim().toUpperCase())
          .filter((c: string) => TrackingService.ehCodigoValido(c));
        const resumo = await this.tracking.resumoDoCache(doPedido);
        const faltando = doPedido.filter((c) => !resumo.get(c)?.entregue);
        if (faltando.length) {
          this.logger.log(
            `[rastreio-sync] ${p.wcOrderNumber}: ${faltando.length} volume(s) ainda em trânsito — não fecha`,
          );
          continue;
        }
        const entregueEm = doPedido
          .map((c) => resumo.get(c)?.entregueEm)
          .filter(Boolean)
          .sort((a: any, b: any) => new Date(b).getTime() - new Date(a).getTime())[0] ?? new Date();

        // Guard atômico: dois ciclos (ou um restart no meio) não podem
        // escrever histórico duplicado do mesmo fechamento.
        const venceu = await (this.prisma as any).order.updateMany({
          where: { id: p.id, status: 'shipped' },
          data: { status: 'delivered', deliveredAt: new Date(entregueEm as any) },
        });
        if (venceu.count !== 1) continue;

        await (this.prisma as any).orderHistory
          .create({
            data: {
              orderId: p.id,
              fromStatus: 'shipped',
              toStatus: 'delivered',
              note:
                `Entrega confirmada pelo rastreio (${doPedido.join(', ')})` +
                `${doPedido.length > 1 ? ` — ${doPedido.length} volumes` : ''}.`,
            },
          })
          .catch(() => null);
        this.logger.log(`[rastreio-sync] ${p.wcOrderNumber} ENTREGUE em ${new Date(entregueEm as any).toISOString()}`);
      }
    }
  }
}
