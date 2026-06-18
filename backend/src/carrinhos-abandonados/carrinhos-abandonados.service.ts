import { Injectable, Logger } from '@nestjs/common';
import { WpDbService } from '../wp-db/wp-db.service';

/**
 * Service que lê o plugin "Cart Abandonment Recovery for WooCommerce" (CartFlows)
 * direto do MySQL WP.
 *
 * Tabela: wp_cartflows_ca_cart_history
 * Colunas principais:
 *  - id, email, cart_total
 *  - cart_contents (JSON serializado dos produtos no carrinho)
 *  - other_fields (JSON com nome/sobrenome/telefone/endereço — pra recuperação)
 *  - time (timestamp WP do abandono)
 *  - order_status (abandoned | completed | normal_order)
 *  - unsubscribed (0/1 — se cliente pediu pra não receber emails)
 *  - session_id, checkout_id
 *
 * Quando o cliente VOLTA e completa a compra, o plugin atualiza order_status='completed'.
 */
@Injectable()
export class CarrinhosAbandonadosService {
  private readonly logger = new Logger(CarrinhosAbandonadosService.name);

  constructor(private readonly wpDb: WpDbService) {}

  async list(input: { dias: number; status: 'abandoned' | 'completed' | 'all' }) {
    const sql = `
      SELECT
        id,
        email,
        cart_total,
        cart_contents,
        other_fields,
        time,
        order_status,
        unsubscribed,
        session_id,
        checkout_id
      FROM wp_cartflows_ca_cart_history
      WHERE time >= NOW() - INTERVAL ? DAY
        ${input.status === 'all' ? '' : 'AND order_status = ?'}
      ORDER BY time DESC
      LIMIT 500
    `;
    const params: any[] = [input.dias];
    if (input.status !== 'all') params.push(input.status);

    try {
      const rows = await this.wpDb.query<any>(sql, params);
      return rows.map((r) => {
        let nome = '';
        let telefone = '';
        let endereco = '';
        let cidade = '';
        let estado = '';
        let cep = '';
        try {
          const of = typeof r.other_fields === 'string' ? JSON.parse(r.other_fields) : r.other_fields;
          if (of && typeof of === 'object') {
            const first = String(of.wcf_first_name || of.first_name || '').trim();
            const last = String(of.wcf_last_name || of.last_name || '').trim();
            nome = [first, last].filter(Boolean).join(' ');
            telefone = String(of.wcf_phone_number || of.phone || of.billing_phone || '').trim();
            endereco = String(of.wcf_address_1 || of.address_1 || of.billing_address_1 || '').trim();
            cidade = String(of.wcf_city || of.city || of.billing_city || '').trim();
            estado = String(of.wcf_state || of.state || of.billing_state || '').trim();
            cep = String(of.wcf_postcode || of.postcode || of.billing_postcode || '').trim();
          }
        } catch { /* ignora */ }

        // cart_contents é JSON serializado. Pega só os nomes dos produtos.
        let produtos: Array<{ nome: string; qty: number; preco: number }> = [];
        try {
          const cc = typeof r.cart_contents === 'string' ? JSON.parse(r.cart_contents) : r.cart_contents;
          if (cc && typeof cc === 'object') {
            produtos = Object.values(cc).map((item: any) => ({
              nome: String(item?.line_subtotal || item?.product_name || item?.name || 'Produto').slice(0, 80),
              qty: Number(item?.quantity || 1),
              preco: Number(item?.line_total || item?.line_subtotal || 0),
            }));
          }
        } catch { /* ignora */ }

        return {
          id: Number(r.id),
          email: String(r.email || ''),
          nome,
          telefone,
          endereco,
          cidade,
          estado,
          cep,
          total: Number(r.cart_total || 0),
          status: String(r.order_status || ''),
          unsubscribed: Number(r.unsubscribed) === 1,
          abandonadoEm: r.time,
          produtos,
        };
      });
    } catch (e: any) {
      this.logger.error(`[carrinhos-abandonados] query falhou: ${e?.message}`);
      return [];
    }
  }

  async resumo(input: { dias: number }) {
    const sql = `
      SELECT
        order_status,
        COUNT(*) AS qtd,
        SUM(cart_total) AS valor
      FROM wp_cartflows_ca_cart_history
      WHERE time >= NOW() - INTERVAL ? DAY
      GROUP BY order_status
    `;
    try {
      const rows = await this.wpDb.query<any>(sql, [input.dias]);
      let abandonados = 0;
      let valorAbandonado = 0;
      let recuperados = 0;
      let valorRecuperado = 0;
      for (const r of rows) {
        const st = String(r.order_status || '');
        const qtd = Number(r.qtd || 0);
        const val = Number(r.valor || 0);
        if (st === 'abandoned') {
          abandonados = qtd;
          valorAbandonado = val;
        } else if (st === 'completed') {
          recuperados = qtd;
          valorRecuperado = val;
        }
      }
      const taxa = abandonados + recuperados > 0
        ? Math.round((recuperados / (abandonados + recuperados)) * 1000) / 10
        : 0;
      return { abandonados, valorAbandonado, recuperados, valorRecuperado, taxaRecuperacaoPct: taxa, dias: input.dias };
    } catch (e: any) {
      this.logger.error(`[carrinhos-abandonados] resumo falhou: ${e?.message}`);
      return { abandonados: 0, valorAbandonado: 0, recuperados: 0, valorRecuperado: 0, taxaRecuperacaoPct: 0, dias: input.dias };
    }
  }

  /**
   * Diagnostico: verifica conexao + existencia da tabela + sample row.
   * Retorna estrutura clara sobre o que esta ou nao funcionando.
   */
  async diag() {
    const result: any = {
      ok: false,
      step: 'init',
      hasPool: false,
      env: {
        WP_DB_HOST: process.env.WP_DB_HOST ? 'set' : 'MISSING',
        WP_DB_PORT: process.env.WP_DB_PORT ? 'set' : 'default(3306)',
        WP_DB_USER: process.env.WP_DB_USER ? 'set' : 'MISSING',
        WP_DB_PASSWORD: process.env.WP_DB_PASSWORD ? 'set' : 'MISSING',
        WP_DB_DATABASE: process.env.WP_DB_DATABASE ? 'set' : 'MISSING',
      },
    };

    const pool = (this.wpDb as any).getPool ? (this.wpDb as any).getPool() : null;
    if (!pool) {
      result.step = 'no-pool';
      result.error = 'WpDbService nao tem pool. Variaveis WP_DB_* faltando ou nao conectou. Setar no Railway: WP_DB_HOST, WP_DB_PORT, WP_DB_USER, WP_DB_PASSWORD, WP_DB_DATABASE';
      return result;
    }
    result.hasPool = true;

    try {
      result.step = 'ping';
      await pool.query('SELECT 1');
      result.connected = true;
    } catch (e: any) {
      result.step = 'connect-failed';
      result.error = `Falha ao conectar: ${e?.message}. Provavel: IP do Railway nao liberado no hosting do WP. Pedir pro hosting liberar acesso externo MySQL.`;
      return result;
    }

    try {
      result.step = 'show-tables';
      const tables = await this.wpDb.query<any>("SHOW TABLES LIKE '%cartflows%'");
      result.tabelasCartflows = tables.map((t: any) => Object.values(t)[0]);
    } catch (e: any) {
      result.step = 'show-tables-failed';
      result.error = `SHOW TABLES falhou: ${e?.message}`;
      return result;
    }

    try {
      result.step = 'count-cart-history';
      const cnt = await this.wpDb.query<any>('SELECT COUNT(*) as total FROM wp_cartflows_ca_cart_history');
      result.totalRows = Number((cnt as any)[0]?.total ?? 0);
    } catch (e: any) {
      result.step = 'count-failed';
      result.error = `Tabela wp_cartflows_ca_cart_history nao acessivel: ${e?.message}. Talvez prefix nao seja wp_. Veja tabelasCartflows acima.`;
      return result;
    }

    try {
      result.step = 'sample';
      const sample = await this.wpDb.query<any>('SELECT id, email, cart_total, order_status, time FROM wp_cartflows_ca_cart_history ORDER BY time DESC LIMIT 1');
      result.sample = (sample as any)[0] ?? null;
    } catch (e: any) {
      result.error = `Falha ao pegar sample: ${e?.message}`;
      return result;
    }

    try {
      result.step = 'count-last-7d';
      const cnt7 = await this.wpDb.query<any>("SELECT COUNT(*) as total FROM wp_cartflows_ca_cart_history WHERE time >= NOW() - INTERVAL 7 DAY");
      result.rowsUltimos7Dias = Number((cnt7 as any)[0]?.total ?? 0);
      const cnt7ab = await this.wpDb.query<any>("SELECT COUNT(*) as total FROM wp_cartflows_ca_cart_history WHERE time >= NOW() - INTERVAL 7 DAY AND order_status = 'abandoned'");
      result.abandonadosUltimos7Dias = Number((cnt7ab as any)[0]?.total ?? 0);
    } catch (e: any) {
      result.error = `Falha contagem: ${e?.message}`;
    }

    result.ok = true;
    result.step = 'done';
    return result;
  }
}
