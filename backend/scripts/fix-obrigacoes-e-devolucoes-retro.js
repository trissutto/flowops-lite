/**
 * CORREÇÃO (parecer Márcia 08/09/2026) — 3 consertos de DADOS:
 *  A. inter_store_obligations mai/jun-26 gravadas ÷100 → ×100 (pending).
 *  B. inter_store_obligations com preço R$ 0 → reprecifica em cascata:
 *     snapshot do bipe (transfer_orders.preco_unit_cents) → espelho por
 *     código (wincred_produtos.vendaUn) → média do espelho por REF.
 *  C. Devoluções do PDV Flow ANTERIORES a 25/08 não existiam na caixa
 *     (giga_caixa_mov) → retro-lança linhas negativas r<md5(itemId)>, o
 *     MESMO formato da ponte espelharCaixaMovDoFlow. O corte 25/08 da ponte
 *     garante que ela nunca deleta nem recria essas linhas.
 *
 * Sem argumento = DRY-RUN (só mostra). Com --apply = executa.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');
const APPLY = process.argv.includes('--apply');
const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();
  console.log(APPLY ? '>>> MODO APPLY <<<' : '>>> DRY-RUN (use --apply pra executar) <<<');

  // ── A. ÷100 ──────────────────────────────────────────────────────────────
  // Calibragem do teto: nada legítimo abaixo de R$ 12? (etiqueta mínima real)
  const dist = await db.query(`
    SELECT mes_referencia mes, width_bucket(preco_unitario, 0, 12, 6) faixa,
           MIN(preco_unitario)::float8 mn, MAX(preco_unitario)::float8 mx, COUNT(*)::int n
      FROM inter_store_obligations
     WHERE mes_referencia IN ('2026-05','2026-06') AND preco_unitario > 0 AND preco_unitario < 12
     GROUP BY 1,2 ORDER BY 1,2`);
  console.log('\n[A] distribuição preco_unitario (0–12) em mai/jun:');
  console.table(dist.rows);

  const previewA = await db.query(`
    SELECT mes_referencia mes, status, COUNT(*)::int itens,
           SUM(valor_obrigacao)::float8 antes, SUM(valor_obrigacao*100)::float8 depois
      FROM inter_store_obligations
     WHERE mes_referencia IN ('2026-05','2026-06') AND status='pending'
       AND preco_unitario > 0 AND preco_unitario < 6
     GROUP BY 1,2 ORDER BY 1`);
  console.log('[A] o que o ×100 muda (pending, 0<preco<6):');
  console.table(previewA.rows.map((r) => ({ ...r, antes: fmt(r.antes), depois: fmt(r.depois) })));

  if (APPLY) {
    const upA = await db.query(`
      UPDATE inter_store_obligations
         SET preco_unitario = preco_unitario * 100,
             preco_total    = preco_total * 100,
             valor_obrigacao = valor_obrigacao * 100
       WHERE mes_referencia IN ('2026-05','2026-06') AND status='pending'
         AND preco_unitario > 0 AND preco_unitario < 6`);
    console.log(`[A] ✔ corrigidas ${upA.rowCount} obrigações ×100`);
  }

  // ── B. preço zero ────────────────────────────────────────────────────────
  const previewB = await db.query(`
    WITH alvo AS (
      SELECT o.id, o.qty, o.divisor, o.transfer_order_id, o.ref_code, o.sku
        FROM inter_store_obligations o
       WHERE COALESCE(o.preco_unitario,0) = 0 AND o.status = 'pending'
    ), preco AS (
      SELECT a.id,
             COALESCE(
               NULLIF(t.preco_unit_cents,0)/100.0,
               wp."vendaUn",
               wr.media_ref
             )::float8 AS preco,
             CASE WHEN NULLIF(t.preco_unit_cents,0) IS NOT NULL THEN 'snapshot'
                  WHEN wp."vendaUn" IS NOT NULL THEN 'espelho_sku'
                  WHEN wr.media_ref IS NOT NULL THEN 'media_ref'
                  ELSE 'sem_preco' END AS fonte
        FROM alvo a
        LEFT JOIN transfer_orders t ON t.id = a.transfer_order_id
        LEFT JOIN LATERAL (
          SELECT w."vendaUn" FROM wincred_produtos w
           WHERE w."vendaUn" > 0
             AND ltrim(w.codigo,'0') = ltrim(COALESCE(t.codigo_bipado, a.sku, ''),'0')
           LIMIT 1
        ) wp ON true
        LEFT JOIN LATERAL (
          SELECT AVG(w."vendaUn")::float8 media_ref FROM wincred_produtos w
           WHERE w."vendaUn" > 0 AND UPPER(TRIM(COALESCE(w.ref,''))) = UPPER(TRIM(a.ref_code))
        ) wr ON wp."vendaUn" IS NULL
    )
    SELECT fonte, COUNT(*)::int itens, SUM(COALESCE(preco,0))::float8 soma_precos
      FROM preco GROUP BY 1 ORDER BY 2 DESC`);
  console.log('\n[B] reprecificação dos zeros (pending) por fonte:');
  console.table(previewB.rows.map((r) => ({ ...r, soma_precos: fmt(r.soma_precos) })));

  if (APPLY) {
    const upB = await db.query(`
      WITH alvo AS (
        SELECT o.id, o.qty, o.divisor, o.transfer_order_id, o.ref_code, o.sku
          FROM inter_store_obligations o
         WHERE COALESCE(o.preco_unitario,0) = 0 AND o.status = 'pending'
      ), preco AS (
        SELECT a.id, a.qty, a.divisor,
               COALESCE(NULLIF(t.preco_unit_cents,0)/100.0, wp."vendaUn", wr.media_ref)::float8 AS preco
          FROM alvo a
          LEFT JOIN transfer_orders t ON t.id = a.transfer_order_id
          LEFT JOIN LATERAL (
            SELECT w."vendaUn" FROM wincred_produtos w
             WHERE w."vendaUn" > 0
               AND ltrim(w.codigo,'0') = ltrim(COALESCE(t.codigo_bipado, a.sku, ''),'0')
             LIMIT 1
          ) wp ON true
          LEFT JOIN LATERAL (
            SELECT AVG(w."vendaUn")::float8 media_ref FROM wincred_produtos w
             WHERE w."vendaUn" > 0 AND UPPER(TRIM(COALESCE(w.ref,''))) = UPPER(TRIM(a.ref_code))
          ) wr ON wp."vendaUn" IS NULL
      )
      UPDATE inter_store_obligations o
         SET preco_unitario = p.preco,
             preco_total    = p.preco * p.qty,
             valor_obrigacao = (p.preco * p.qty) / COALESCE(NULLIF(p.divisor,0), 2.5)
        FROM preco p
       WHERE o.id = p.id AND p.preco IS NOT NULL AND p.preco > 0`);
    console.log(`[B] ✔ reprecificadas ${upB.rowCount} obrigações que estavam R$ 0`);
  }

  // ── C. retro-devoluções na caixa ─────────────────────────────────────────
  const jaTem = await db.query(`
    SELECT COUNT(*)::int n FROM giga_caixa_mov
     WHERE registro LIKE 'r%' AND data < '2026-08-25'`);
  console.log(`\n[C] linhas 'r%' já existentes antes de 25/08: ${jaTem.rows[0].n} (esperado 0)`);

  const previewC = await db.query(`
    SELECT to_char(date_trunc('month', r.created_at AT TIME ZONE 'America/Sao_Paulo'),'YYYY-MM') mes,
           lpad(regexp_replace(r.store_code,'[^0-9]','','g'),2,'0') loja,
           COUNT(i.id)::int itens, SUM(i.total)::float8 valor
      FROM pdv_returns r JOIN pdv_return_items i ON i.return_id = r.id
     WHERE COALESCE(r.is_training,false) = false
       AND (r.created_at AT TIME ZONE 'America/Sao_Paulo')::date < DATE '2026-08-25'
     GROUP BY 1,2 ORDER BY 1,2`);
  console.log('[C] devoluções a retro-lançar (negativas) por mês×loja:');
  console.table(previewC.rows.map((r) => ({ ...r, valor: fmt(r.valor) })));
  const totC = previewC.rows.reduce((s, r) => s + Number(r.valor), 0);
  console.log(`[C] total a abater do faturamento histórico: ${fmt(totC)}`);

  if (APPLY) {
    const insC = await db.query(`
      INSERT INTO giga_caixa_mov
        (registro, numero, controle, codigo, data, data_fec, hora, descricao,
         quantidade, valor, valor_total, operador, vendedor, cliente, loja, marcado,
         cod_cliente, nome_cliente, cpf, vendedora, vendedora_code, fpag, obs_pedido, valor_unitario)
      SELECT 'r' || substr(md5(i.id), 1, 19),
             substr(r.id, 1, 8),
             NULL,
             substr(i.sku, 1, 14),
             ((r.created_at AT TIME ZONE 'America/Sao_Paulo')::date)::timestamp AT TIME ZONE 'UTC',
             ((r.created_at AT TIME ZONE 'America/Sao_Paulo')::date)::timestamp AT TIME ZONE 'UTC',
             to_char(r.created_at AT TIME ZONE 'America/Sao_Paulo', 'HH24:MI'),
             substr(i.descricao, 1, 120),
             -i.qty,
             i.preco_unit,
             -i.total,
             NULL, NULL,
             substr(r.customer_name, 1, 80),
             lpad(regexp_replace(r.store_code,'[^0-9]','','g'),2,'0'),
             NULL,
             NULL,
             substr(r.customer_name, 1, 80),
             substr(r.customer_cpf, 1, 20),
             NULL, NULL,
             'DEVOLUCAO',
             substr('flowret-' || r.id, 1, 200),
             i.preco_unit
        FROM pdv_returns r JOIN pdv_return_items i ON i.return_id = r.id
       WHERE COALESCE(r.is_training,false) = false
         AND (r.created_at AT TIME ZONE 'America/Sao_Paulo')::date < DATE '2026-08-25'
      ON CONFLICT (registro) DO NOTHING`);
    console.log(`[C] ✔ inseridas ${insC.rowCount} linhas de devolução retroativa`);
  }

  await db.end();
}
main().catch((e) => { console.error('ERRO:', e && (e.stack || e.message)); process.exit(1); });
