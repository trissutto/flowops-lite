/**
 * CORREÇÃO PONTUAL — REM-2026-000852 (LIMEIRA → SÃO JOSÉ DOS CAMPOS).
 *
 * O QUE ACONTECEU: o plano mandou a LIMEIRA enviar `124131 GOIABA 54`
 * (CODIGO 7891426031883). Ela separou `124131 ROSE 54` (CODIGO 7891426031890)
 * — mesma REF, mesmo tamanho, rosa quase igual e código de barras VIZINHO.
 * O "Fechar e enviar" baixou a GOIABA da LIMEIRA (1→0); a ROSE, que é a peça
 * que realmente viajou, continua com saldo 1 lá. SJC não consegue bipar porque
 * `scanItem` casa REF+COR+TAM e a cor não bate.
 *
 * O QUE ESTE SCRIPT FAZ (confirmado com o dono 31/08 — a GOIABA está na arara):
 *   1. reescreve o item da remessa pra ROSE 54 / 7891426031890 (a verdade
 *      física da caixa). A partir daí o bipe casa por E1 (codigoBipado) e a
 *      entrada em SJC sai como ROSE, porque `confirmReceived` dá entrada pelo
 *      `codigoBipado` — não pela cor escrita no pedido;
 *   2. devolve GOIABA 54 pra 1 na LIMEIRA (peça que nunca saiu da loja);
 *   3. zera ROSE 54 na LIMEIRA (peça que saiu e está na caixa em SJC).
 *
 * A entrada da ROSE em SJC NÃO é feita aqui — sai sozinha quando a loja bipar
 * e clicar "dar entrada". Somar aqui criaria peça do nada.
 *
 * Escreve nas DUAS tabelas que o `mirrorStockApplyDelta` escreve: `giga_estoque`
 * (fonte) e `wincred_estoque` (a que site/PDV leem). Réplica pro Giga está
 * DESLIGADA desde 27/08 (common/replica-giga.ts), então não há terceiro lado.
 *
 *   railway run --service Postgres node backend/scripts/fix-rem852-goiaba-para-rose.js         # dry-run
 *   railway run --service Postgres node backend/scripts/fix-rem852-goiaba-para-rose.js --apply
 */
const { Client } = require('pg');

const ITEM_ID = 'f41fd726-6301-4acf-b418-04d59b0a7479';
const GOIABA = '7891426031883';
const ROSE = '7891426031890';
const LOJA_ORIGEM = '11'; // LIMEIRA
const APPLY = process.argv.includes('--apply');

async function saldo(c, codigo) {
  const g = await c.query(`SELECT id, estoque FROM giga_estoque WHERE codigo = $1 AND loja = $2`, [codigo, LOJA_ORIGEM]);
  const w = await c.query(`SELECT estoque FROM wincred_estoque WHERE codigo = $1 AND loja = $2`, [codigo, LOJA_ORIGEM]);
  return { giga: g.rows[0] ?? null, wincred: w.rows[0] ?? null };
}

async function setSaldo(c, codigo, novo) {
  const s = await saldo(c, codigo);
  if (s.giga) {
    await c.query(`UPDATE giga_estoque SET estoque = $1, synced_at = NOW() WHERE id = $2`, [novo, s.giga.id]);
  } else {
    await c.query(`INSERT INTO giga_estoque (id, codigo, loja, estoque, synced_at) VALUES (gen_random_uuid()::text, $1, $2, $3, NOW())`, [codigo, LOJA_ORIGEM, novo]);
  }
  await c.query(
    `INSERT INTO wincred_estoque (codigo, loja, estoque, synced_at) VALUES ($1, $2, $3, NOW())
     ON CONFLICT (codigo, loja) DO UPDATE SET estoque = EXCLUDED.estoque, synced_at = NOW()`,
    [codigo, LOJA_ORIGEM, novo]);
}

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();

  const it = await c.query(
    `SELECT id, ref_code, cor, tamanho, codigo_bipado, descricao, realignment_status
       FROM transfer_orders WHERE id = $1`, [ITEM_ID]);
  if (!it.rows.length) throw new Error('Item não encontrado');
  const item = it.rows[0];

  console.log('=== ANTES ===');
  console.table([item]);
  console.table([
    { o: 'GOIABA 54 na LIMEIRA', ...(await saldo(c, GOIABA)) && {} },
  ]);
  const sg = await saldo(c, GOIABA);
  const sr = await saldo(c, ROSE);
  console.table([
    { peca: 'GOIABA 54', codigo: GOIABA, giga_estoque: sg.giga?.estoque ?? '(sem linha)', wincred_estoque: sg.wincred?.estoque ?? '(sem linha)' },
    { peca: 'ROSE 54', codigo: ROSE, giga_estoque: sr.giga?.estoque ?? '(sem linha)', wincred_estoque: sr.wincred?.estoque ?? '(sem linha)' },
  ]);

  if (item.cor === 'ROSE' && String(item.codigo_bipado) === ROSE) {
    console.log('\n⚠ Item JÁ está como ROSE — nada a fazer no pedido.');
  }
  if (item.realignment_status === 'received') {
    throw new Error('Item já foi recebido — pare e reveja à mão antes de mexer.');
  }

  console.log('\n=== O QUE VAI MUDAR ===');
  console.table([
    { alvo: 'item da remessa', de: `${item.cor} / ${item.codigo_bipado}`, para: `ROSE / ${ROSE}` },
    { alvo: `GOIABA 54 na LIMEIRA (${LOJA_ORIGEM})`, de: sg.giga?.estoque ?? 0, para: 1 },
    { alvo: `ROSE 54 na LIMEIRA (${LOJA_ORIGEM})`, de: sr.giga?.estoque ?? 0, para: 0 },
  ]);

  if (!APPLY) { console.log('\nDRY-RUN. Rode com --apply pra gravar.'); await c.end(); return; }

  await c.query('BEGIN');
  try {
    await c.query(
      `UPDATE transfer_orders
          SET cor = 'ROSE', codigo_bipado = $1,
              descricao = 'SOUTIEN SEM BOJO 124131 DILADY ROSE 54'
        WHERE id = $2`, [ROSE, ITEM_ID]);
    await setSaldo(c, GOIABA, 1);
    await setSaldo(c, ROSE, 0);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; }

  console.log('\n=== DEPOIS ===');
  const it2 = await c.query(`SELECT ref_code, cor, tamanho, codigo_bipado, descricao, realignment_status FROM transfer_orders WHERE id = $1`, [ITEM_ID]);
  console.table(it2.rows);
  const sg2 = await saldo(c, GOIABA);
  const sr2 = await saldo(c, ROSE);
  console.table([
    { peca: 'GOIABA 54', giga_estoque: sg2.giga?.estoque, wincred_estoque: sg2.wincred?.estoque },
    { peca: 'ROSE 54', giga_estoque: sr2.giga?.estoque, wincred_estoque: sr2.wincred?.estoque },
  ]);
  await c.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
