/** Valida a query nova do crediario-print (cliente via espelho giga_clientes). */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');

const SQL = `SELECT loja, codigo, nome, endereco, numero, complemento, bairro,
        cidade, uf, cep
   FROM giga_clientes
  WHERE regexp_replace(COALESCE(cpf,''),'[^0-9]','','g') = $1
  ORDER BY (arquivado_em IS NULL) DESC, flow_is_source DESC,
           (loja = $2) DESC, synced_at DESC
  LIMIT 1`;

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();

  console.log('TEREZA (16245727820, loja 01):');
  console.log((await db.query(SQL, ['16245727820', '01'])).rows[0] || 'NADA');

  const umFormatado = await db.query(
    `SELECT regexp_replace(cpf,'[^0-9]','','g') d, loja FROM giga_clientes WHERE cpf ~ '[.-]' LIMIT 1`,
  );
  if (umFormatado.rows[0]) {
    const { d, loja } = umFormatado.rows[0];
    console.log(`cliente com CPF formatado (${d}):`);
    console.log((await db.query(SQL, [d, loja])).rows[0] || 'NADA (regexp falhou!)');
  }

  await db.end();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
