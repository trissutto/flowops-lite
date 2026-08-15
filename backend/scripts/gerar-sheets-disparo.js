// Gera o CSV do disparo (Google Sheets): nome, telefone, mensagem personalizada, foto, status.
const { Client } = require('pg');
const fs = require('fs');

const FOTO = 'https://pub-84da472609374e0ab161fd54571b5f38.r2.dev/whatsapp-reativacao/linha-conforto-terracota.png';
const VARIANTES = [
  (n) => `Oi ${n}! 💛 Vi que você comprou com a gente em julho. Chegou coisa nova da Linha Conforto no site novo e achei que ia ser a sua cara. Posso te mandar?`,
  (n) => `${n}, tudo bem? 🧡 Aqui é da Lurd's. Saiu a Linha Conforto nova (aquela gostosa de vestir) e lembrei de você. Quer ver?`,
  (n) => `Oi ${n} 💛 Faz um tempinho desde julho! Entrou a Linha Conforto no site novo. Qual número você usa hoje? Te ajudo a achar a sua.`,
  (n) => `${n}, oi! 🧡 Novidade da Linha Conforto no ar — plus do 46 ao 60. Como você comprou em julho, quis te avisar primeiro. Te mostro?`,
];

const primeiroNome = (nome) => {
  const t = String(nome).trim().split(/\s+/)[0] || '';
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
};

(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  const janela = `(last_order_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo') >= '2026-07-01'
              AND (last_order_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo') < '2026-08-01'`;
  const cond = `COALESCE(NULLIF(regexp_replace(COALESCE(whatsapp,''),'\\D','','g'),''), regexp_replace(COALESCE(phone,''),'\\D','','g'))`;
  const r = await db.query(
    `SELECT name, ${cond} AS fone
       FROM "customers"
      WHERE ${janela} AND name IS NOT NULL AND LENGTH(${cond}) >= 10
        AND (gender IS NULL OR gender NOT ILIKE 'm%')
      ORDER BY ltv_cents DESC NULLS LAST
      LIMIT 30`);

  const norm = (d) => { d = String(d).replace(/\D/g, ''); if (d.length <= 11) d = '55' + d; return d; };
  const esc = (s) => `"${String(s).replace(/"/g, '""')}"`;

  const rows = r.rows.map((x, i) => {
    const nome = primeiroNome(x.name);
    const msg = VARIANTES[i % VARIANTES.length](nome);
    return { nome, fone: norm(x.fone), msg, foto: FOTO, status: '' };
  });

  const header = 'nome,telefone,mensagem,foto,status';
  const csv = '﻿' + header + '\n' + rows.map(r => [esc(r.nome), r.fone, esc(r.msg), r.foto, r.status].join(',')).join('\n');
  const out = process.env.OUT || 'disparo-linha-conforto.csv';
  fs.writeFileSync(out, csv);
  // TSV pra colar direto no Google Sheets (sem aspas; dados não têm tab/newline)
  const tsv = [header.replace(/,/g, '\t'), ...rows.map(r => [r.nome, r.fone, r.msg, r.foto, r.status].join('\t'))].join('\n');
  fs.writeFileSync(out.replace(/\.csv$/, '.tsv'), tsv);
  if (process.env.PRINT_TSV) { console.log('===TSV_START==='); console.log(tsv); console.log('===TSV_END==='); }
  console.log('CSV:', out, '|', rows.length, 'linhas');
  console.log('distribuição de variações: cada uma ~', Math.round(rows.length / 4), 'vezes');
  console.log('\nprévia (3 primeiras, fone mascarado):');
  rows.slice(0, 3).forEach(r => console.log(`  ${r.nome} | ${r.fone.slice(0,4)}****${r.fone.slice(-2)} | ${r.msg}`));
  await db.end();
})().catch(e => { console.error(e.message); process.exit(1); });
