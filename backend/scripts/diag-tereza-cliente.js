/** TEREZA (CPF 16245727820) existe no espelho giga_clientes? + formato de CPF na tabela. */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();

  const r = await db.query(
    `SELECT loja, codigo, cpf, nome, endereco, numero, bairro, cidade, uf, cep,
            limite_compras, pontos, flow_is_source, arquivado_em, synced_at
       FROM giga_clientes
      WHERE regexp_replace(COALESCE(cpf,''),'[^0-9]','','g')='16245727820'`,
  );
  console.log('TEREZA no espelho:', JSON.stringify(r.rows, null, 1));

  const fmt = await db.query(
    `SELECT COUNT(*) FILTER (WHERE cpf ~ '[.-]')::int formatados,
            COUNT(*) FILTER (WHERE cpf ~ '^[0-9]+$')::int so_digitos,
            COUNT(*)::int total
       FROM giga_clientes WHERE cpf IS NOT NULL AND cpf <> ''`,
  );
  console.table(fmt.rows);

  const novos = await db.query(
    `SELECT COUNT(*)::int criados_no_flow FROM giga_clientes WHERE flow_is_source = true`,
  );
  console.table(novos.rows);

  await db.end();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
