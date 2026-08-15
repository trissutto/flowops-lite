// Lista de reativação: compradores cujo ULTIMO pedido foi julho/2026, celular valido.
const { Client } = require('pg');
const fs = require('fs');
(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl:{rejectUnauthorized:false} });
  await db.connect();
  const janela = `(last_order_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo') >= '2026-07-01'
              AND (last_order_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo') < '2026-08-01'`;
  // celular: digitos >= 10 (DDD+numero); pega whatsapp senao phone
  const cond = `COALESCE(NULLIF(regexp_replace(COALESCE(whatsapp,''),'\\D','','g'),''), regexp_replace(COALESCE(phone,''),'\\D','','g'))`;
  const universo = await db.query(
    `SELECT COUNT(*)::int n FROM "customers"
      WHERE ${janela} AND name IS NOT NULL AND LENGTH(${cond}) >= 10`);
  console.log('UNIVERSO (compradores de julho c/ celular):', universo.rows[0].n);

  const r = await db.query(
    `SELECT name, ${cond} AS fone, rfv_segment, ROUND(ltv_cents/100.0,2) AS ltv, cpf,
            to_char(last_order_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo','DD/MM') ult
       FROM "customers"
      WHERE ${janela} AND name IS NOT NULL AND LENGTH(${cond}) >= 10
      ORDER BY ltv_cents DESC NULLS LAST
      LIMIT 30`);

  // normaliza pra 55DDDNUMERO
  const norm = (d) => { d = String(d).replace(/\D/g,''); if (d.length<=11) d='55'+d; return d; };
  const linhas = r.rows.map(x => ({ nome: x.name.trim(), fone: norm(x.fone), segmento: x.rfv_segment||'', ltv: x.ltv, ultima_compra: x.ult }));

  const csv = 'nome,fone,segmento,ltv,ultima_compra\n' + linhas.map(l=>`"${l.nome}",${l.fone},${l.segmento},${l.ltv},${l.ultima_compra}`).join('\n');
  const out = process.env.OUT || 'lista-30-julho.csv';
  fs.writeFileSync(out, csv);
  console.log('CSV salvo em', out, '(', linhas.length, 'linhas )\n');
  // preview com fone MASCARADO no log
  for (const l of linhas.slice(0,30)) {
    const f = l.fone; const mask = f.slice(0,4)+'****'+f.slice(-2);
    console.log(`  ${l.nome.padEnd(28).slice(0,28)} ${mask}  ${String(l.segmento).padEnd(12)} LTV ${l.ltv}  ult ${l.ultima_compra}`);
  }
  await db.end();
})().catch(e=>{console.error(e.message);process.exit(1)});
