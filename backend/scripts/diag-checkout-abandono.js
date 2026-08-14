/**
 * ONDE A CLIENTE MORRE NO CHECKOUT — sessão por sessão.
 *
 * O funil agregado diz "11 começaram, 3 pagaram". Ele não diz ONDE os 8
 * pararam. Aqui a gente lê a fita de eventos de cada sessão que chegou no
 * /checkout e mostra a sequência inteira: dá pra ver se ela parou na
 * identificação (nunca veio add_shipping_info), no frete (veio shipping e não
 * veio payment) ou no PIX (veio purchase? o pedido ficou awaiting?).
 *
 *   railway run --service Postgres node backend/scripts/diag-checkout-abandono.js [dias]
 */
const { Client } = require('pg');

const DIAS = Number(process.argv[2] || 7);

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();

  const JANELA = `criado_em > NOW() - INTERVAL '${DIAS} days'`;

  console.log(`══════ SESSÕES QUE ABRIRAM O CHECKOUT (${DIAS}d) ══════\n`);

  const sessoes = await db.query(
    `SELECT DISTINCT session_id FROM site_eventos
      WHERE ${JANELA} AND evento = 'begin_checkout' AND session_id IS NOT NULL`,
  );

  const marcos = ['begin_checkout', 'add_shipping_info', 'add_payment_info', 'purchase'];
  const parou = { identificacao: 0, entrega: 0, pagamento: 0, comprou: 0 };

  for (const { session_id } of sessoes.rows) {
    const fita = await db.query(
      `SELECT evento, path, valor, dados, criado_em FROM site_eventos
        WHERE session_id = $1 AND ${JANELA}
        ORDER BY criado_em`,
      [session_id],
    );
    const teve = (e) => fita.rows.some((r) => r.evento === e);

    let onde;
    if (teve('purchase')) { onde = 'COMPROU'; parou.comprou++; }
    else if (teve('add_payment_info')) { onde = 'parou no PAGAMENTO'; parou.pagamento++; }
    else if (teve('add_shipping_info')) { onde = 'parou na ENTREGA/frete'; parou.entrega++; }
    else { onde = 'parou na IDENTIFICAÇÃO (nome/e-mail/CPF/celular)'; parou.identificacao++; }

    const inicio = fita.rows[0].criado_em;
    const fim = fita.rows[fita.rows.length - 1].criado_em;
    const minutos = Math.round((fim - inicio) / 60000);
    // Depois do begin_checkout, o que ela ainda fez?
    const idx = fita.rows.findIndex((r) => r.evento === 'begin_checkout');
    const depois = fita.rows.slice(idx).map((r) => r.evento);

    console.log(`  ${session_id.slice(0, 12)}  ${onde}`);
    console.log(`     sessão de ${minutos}min | ${fita.rows.length} eventos | depois do checkout: ${depois.join(' → ')}`);
    const ultimo = fita.rows[fita.rows.length - 1];
    console.log(`     último: ${ultimo.evento} em ${ultimo.path ?? '?'} às ${ultimo.criado_em.toISOString().slice(11, 16)}\n`);
  }

  console.log('══════ RESUMO ══════');
  console.log(`  ${sessoes.rows.length} sessões abriram o checkout`);
  console.log(`  → pararam na IDENTIFICAÇÃO: ${parou.identificacao}`);
  console.log(`  → pararam na ENTREGA:       ${parou.entrega}`);
  console.log(`  → pararam no PAGAMENTO:     ${parou.pagamento}`);
  console.log(`  → COMPRARAM:                ${parou.comprou}`);

  console.log('\n══════ MARCOS AGREGADOS ══════');
  for (const m of marcos) {
    const r = await db.query(
      `SELECT COUNT(DISTINCT session_id)::int AS n FROM site_eventos WHERE ${JANELA} AND evento = $1`,
      [m],
    );
    console.log(`  ${m.padEnd(20)} ${r.rows[0].n} sessões`);
  }

  console.log('\n══════ ADD_TO_CART SEM CHECKOUT — pararam na SACOLA ══════');
  const naSacola = await db.query(
    `SELECT COUNT(DISTINCT session_id)::int AS n FROM site_eventos e
      WHERE ${JANELA} AND evento = 'add_to_cart'
        AND NOT EXISTS (SELECT 1 FROM site_eventos b
                         WHERE b.session_id = e.session_id AND b.evento = 'begin_checkout')`,
  );
  console.log(`  ${naSacola.rows[0].n} sessões puseram na sacola e nunca abriram o checkout`);

  await db.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
