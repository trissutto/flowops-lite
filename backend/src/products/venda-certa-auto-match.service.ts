import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

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
 *   Cron roda a cada 30min procurando VENDA_CERTA com saleStatus='pending'.
 *   Pra cada uma, monta um candidato (lojaDestino + refCode + cor + tamanho +
 *   dataEnvio) e procura em `pdv_sales`/`pdv_sale_items` — as vendas do PDV do
 *   Flow — uma venda BATIDA com esses critérios.
 *
 * ⚠ Até 27/08/2026 esta busca era `erp.findVendaCertaMatches()`, na tabela
 *   `caixa` do Giga. Quando a KingHost passou a recusar o IP do Railway
 *   ("Access denied for user 'gigasistemas21'"), o cron virou 139 tentativas
 *   por ciclo, TODAS falhando em silêncio: a última confirmação automática foi
 *   26/08 03:00 e sobraram 165 VENDA_CERTA penduradas. E a auto-baixa é o ÚNICO
 *   mecanismo que confirma — as 44 confirmadas em 4 meses saíram todas dela,
 *   nenhuma vendedora marcou "Vendi" na mão. O dado sempre esteve aqui: a venda
 *   nasce no Flow desde julho (o Giga só recebia réplica).
 *
 *   Quando encontra → marca saleStatus='confirmed' automaticamente, guarda o
 *   número do cupom PDV em saleNote (pra auditoria + UI mostrar "AUTO:cupom_X").
 *
 * Por que não marca saleStatus='cancelled' automaticamente:
 *   - Pode ser que a cliente ainda esteja pensando. Sem upper time limit
 *     (a cliente pode voltar em dias). Só baixa manualmente quando loja marca.
 *
 * Por que a cada 30min:
 *   - Balanço entre latência do feedback (a cliente confirma rapidinho) e
 *     carga no banco. Hoje é UMA consulta no Postgres com `unnest`, casando
 *     `pdv_sales`/`pdv_sale_items` da loja DESTINO contra os pedidos
 *     pendentes — nada de JOIN em banco externo.
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

    const matches = await this.matchesNasVendasDoFlow(candidates);
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
  /**
   * Procura, nas vendas do PDV do Flow, a peça de cada candidato: mesma LOJA
   * de destino, mesma REF (+ cor/tamanho quando o pedido especificou) e venda
   * DEPOIS do pedido. Uma query só pra lista inteira — o caminho antigo fazia
   * um round-trip ao MySQL do Giga por candidato (139 por ciclo).
   *
   * ⚠ Uma venda não confirma dois pedidos. Três VENDA_CERTA da mesma REF/cor/
   *   tamanho na mesma loja casavam todas com o MESMO cupom de 1 peça — o
   *   caminho do Giga tinha o mesmo furo, e o controle existe justamente pra
   *   não inflar. Por isso o casamento é GULOSO: pedido mais antigo primeiro,
   *   e cada ITEM de venda só cobre `qty` pedidos. Quem sobra fica pending.
   *
   * `numero` é o da NFC-e quando existe; sem nota, o começo do id da venda —
   * a tela lê `AUTO:cupom_X` e continua mostrando o mesmo texto.
   */
  private async matchesNasVendasDoFlow(
    candidates: Array<{
      lojaDestinoCode: string;
      refCode: string;
      cor: string | null;
      tamanho: string | null;
      dataEnvio: Date;
    }>,
  ): Promise<Record<number, { numero: string; data: Date; codigo: string; quantidade: number }>> {
    const out: Record<number, { numero: string; data: Date; codigo: string; quantidade: number }> = {};
    if (!candidates.length) return out;

    const idx: number[] = [];
    const loja: string[] = [];
    const ref: string[] = [];
    const cor: (string | null)[] = [];
    const tam: (string | null)[] = [];
    const desde: Date[] = [];
    candidates.forEach((c, i) => {
      if (!c.lojaDestinoCode || !c.refCode) return;
      idx.push(i);
      loja.push(String(c.lojaDestinoCode).trim());
      ref.push(String(c.refCode).trim().toUpperCase());
      cor.push(c.cor && String(c.cor).trim() ? String(c.cor).trim().toUpperCase() : null);
      tam.push(c.tamanho && String(c.tamanho).trim() ? String(c.tamanho).trim().toUpperCase() : null);
      desde.push(c.dataEnvio);
    });
    if (!idx.length) return out;

    // Até 10 vendas por candidato: dá folga pro guloso trocar de cupom quando
    // o primeiro já está ocupado, sem trazer o histórico inteiro da REF.
    const sql = `
      WITH cand AS (
        SELECT * FROM unnest($1::int[], $2::text[], $3::text[], $4::text[], $5::text[], $6::timestamptz[])
             AS t(idx, loja, ref, cor, tamanho, desde)
      ), hits AS (
        SELECT c.idx, i.id AS item_id, s.id AS sale_id, s.nfce_number,
               COALESCE(s.finalized_at, s.created_at) AS vendida_em,
               i.sku, i.qty,
               row_number() OVER (
                 PARTITION BY c.idx ORDER BY COALESCE(s.finalized_at, s.created_at) ASC
               ) AS rn
          FROM cand c
          JOIN pdv_sale_items i
            ON upper(btrim(i.ref)) = c.ref
           AND (c.cor IS NULL OR upper(btrim(i.cor)) = c.cor)
           AND (c.tamanho IS NULL OR upper(btrim(i.tamanho)) = c.tamanho)
          JOIN pdv_sales s
            ON s.id = i.sale_id
           AND btrim(s.store_code) = c.loja
           AND s.status = 'finalized'
           AND s.cancelled_at IS NULL
           AND COALESCE(s.is_training, false) = false
           AND COALESCE(s.finalized_at, s.created_at) >= c.desde
      )
      SELECT idx, item_id, sale_id, nfce_number, vendida_em, sku, qty
        FROM hits
       WHERE rn <= 10
       ORDER BY idx, vendida_em ASC`;

    const rows: any[] = await (this.prisma as any).$queryRawUnsafe(
      sql,
      idx,
      loja,
      ref,
      cor,
      tam,
      desde,
    );

    const usadoPorItem = new Map<string, number>();
    for (const r of rows) {
      const i = Number(r.idx);
      if (!Number.isFinite(i) || out[i] != null) continue;
      const chave = String(r.item_id);
      const teto = Number(r.qty) || 1;
      const ja = usadoPorItem.get(chave) ?? 0;
      if (ja >= teto) continue; // esse cupom já confirmou outro pedido
      usadoPorItem.set(chave, ja + 1);
      const numero = String(r.nfce_number || '').trim() || String(r.sale_id || '').slice(0, 8);
      out[i] = {
        numero,
        data: r.vendida_em ? new Date(r.vendida_em) : new Date(),
        codigo: String(r.sku || '').trim(),
        quantidade: Number(r.qty) || 1,
      };
    }
    return out;
  }
}
