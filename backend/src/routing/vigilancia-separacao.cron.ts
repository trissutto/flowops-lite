import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

/**
 * VIGILÂNCIA SEMANAL DA SEPARAÇÃO (dono, 29/08 — sugestão nº 17).
 *
 * Os diagnósticos que acharam os problemas desta semana (pedido dividido à
 * toa, estoque divergente entre tabelas) rodavam UMA vez, quando alguém
 * lembrava. Este cron roda os mesmos números toda segunda de manhã e grava o
 * resumo — a tela de Remessas mostra o último. Problema aparece em 7 dias,
 * não num mês.
 *
 * O que mede (7 dias):
 *  - pedidos divididos, e quantos com juntada (1 pacote só);
 *  - pedidos fora de SP que saíram SEM juntada (deveria ser ZERO com a
 *    política de 29/08 — se subir, a regra furou);
 *  - divergência wincred_estoque × giga_estoque (pares codigo+loja com
 *    saldo diferente) — as duas deviam andar juntas via write-through.
 *
 * Kill-switch: VIGILANCIA_SEPARACAO=0.
 */
@Injectable()
export class VigilanciaSeparacaoCron {
  private readonly logger = new Logger(VigilanciaSeparacaoCron.name);

  constructor(private readonly prisma: PrismaService) {}

  // Segunda 06:00 BRT (09:00 UTC) — antes da loja abrir.
  @Cron('0 9 * * 1')
  async tick() {
    if (String(process.env.VIGILANCIA_SEPARACAO ?? '').trim() === '0') return;
    try {
      const resumo = await this.medir();
      await this.prisma.integrationLog.create({
        data: {
          source: 'vigilancia',
          direction: 'internal',
          event: 'vigilancia.separacao',
          payload: JSON.stringify(resumo),
          status: 200,
        },
      });
      this.logger.log(`[vigilancia] resumo semanal gravado: ${JSON.stringify(resumo)}`);
    } catch (e: any) {
      this.logger.error(`[vigilancia] falhou: ${e?.message || e}`);
    }
  }

  /** Público: a tela pode pedir uma medição na hora (GET com ?agora=1). */
  async medir() {
    const dias = 7;
    // Pedidos divididos da semana + juntada + fora de SP sem juntada.
    const divididos: any[] = await this.prisma.$queryRawUnsafe(`
      SELECT o.wc_order_number AS numero, o.shipping_cep AS cep, o.routing_result AS rr,
             COUNT(DISTINCT p.store_id)::int AS lojas
        FROM orders o JOIN pick_orders p ON p.order_id = o.id
       WHERE o.created_at >= NOW() - interval '${dias} days' AND o.is_pickup = false
       GROUP BY o.id HAVING COUNT(DISTINCT p.store_id) > 1`);
    let comJuntada = 0;
    let foraSpSemJuntada = 0;
    for (const d of divididos) {
      let rr: any = null;
      try { rr = JSON.parse(d.rr || 'null'); } catch { /* rr torto conta como sem juntada */ }
      const juntou = !!rr?.consolidateStoreCode;
      if (juntou) comJuntada++;
      const digito = String(d.cep || '').replace(/\D/g, '')[0];
      const foraSp = digito != null && digito !== '0' && digito !== '1';
      if (foraSp && !juntou) foraSpSemJuntada++;
    }

    // Divergência entre as duas tabelas de estoque (normalizando padding).
    const div: any[] = await this.prisma.$queryRawUnsafe(`
      SELECT COUNT(*)::int AS pares
        FROM (SELECT NULLIF(ltrim(codigo, '0'), '') AS cod,
                     lpad(regexp_replace(upper(loja), '^LJ', ''), 2, '0') AS lj,
                     SUM(estoque)::int AS est
                FROM wincred_estoque GROUP BY 1, 2) w
        FULL JOIN (SELECT NULLIF(ltrim(codigo, '0'), '') AS cod,
                          lpad(regexp_replace(upper(loja), '^LJ', ''), 2, '0') AS lj,
                          SUM(estoque)::int AS est
                     FROM giga_estoque GROUP BY 1, 2) g USING (cod, lj)
       WHERE COALESCE(w.est, 0) <> COALESCE(g.est, 0) AND cod IS NOT NULL`);

    const pedidos: any[] = await this.prisma.$queryRawUnsafe(`
      SELECT COUNT(*)::int AS n FROM orders
       WHERE created_at >= NOW() - interval '${dias} days' AND is_pickup = false
         AND id IN (SELECT order_id FROM pick_orders)`);

    return {
      medidoEm: new Date().toISOString(),
      dias,
      pedidosComSeparacao: Number(pedidos[0]?.n) || 0,
      divididos: divididos.length,
      comJuntada,
      foraSpSemJuntada, // meta: ZERO (política 29/08)
      estoqueDivergente: Number(div[0]?.pares) || 0,
    };
  }
}
