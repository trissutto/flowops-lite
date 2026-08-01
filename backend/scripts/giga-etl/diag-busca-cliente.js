/**
 * Por que a busca por CPF traz CNPJ de empresa junto?
 *
 * Buscar 28665529896 no PDV devolveu duas empresas antes da pessoa certa.
 * Resultado errado numa tela de identificação é perigoso: a vendedora clica no
 * primeiro e a venda sai no nome de outro.
 *
 * A busca do CRM casa por: cpf startsWith, cpf formatado, whatsapp/phone
 * endsWith(últimos 8) e registroGiga. Este script testa cada critério
 * isoladamente pra descobrir qual deles está pegando as empresas.
 *
 * Só faz SELECT.
 *
 * Uso (da RAIZ do repo):
 *   railway run --service Postgres -- node backend/scripts/giga-etl/diag-busca-cliente.js [cpf]
 */

const { Client } = require('pg');
const CPF = (process.argv[2] || '28665529896').replace(/\D/g, '');
const ULT8 = CPF.slice(-8);

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL });
  await c.connect();

  console.log(`CPF buscado: ${CPF}   ultimos 8 digitos: ${ULT8}`);
  console.log('');

  const criterios = [
    ['cpf comeca com o termo', `cpf LIKE $1 || '%'`, [CPF]],
    ['whatsapp termina nos ultimos 8', `whatsapp LIKE '%' || $1`, [ULT8]],
    ['phone termina nos ultimos 8', `phone LIKE '%' || $1`, [ULT8]],
  ];

  for (const [nome, cond, params] of criterios) {
    const r = await c.query(
      `SELECT name, cpf, whatsapp, phone FROM customers
        WHERE active = true AND ${cond} LIMIT 6`,
      params,
    );
    console.log(`--- ${nome}: ${r.rows.length} resultado(s) ---`);
    for (const x of r.rows) {
      console.log(`    ${String(x.name || '?').slice(0, 42).padEnd(44)} cpf=${x.cpf || '-'} wpp=${x.whatsapp || '-'} fone=${x.phone || '-'}`);
    }
    console.log('');
  }

  // As duas empresas do print — o que elas tem que casou?
  const emp = await c.query(
    `SELECT name, cpf, whatsapp, phone, registro_giga FROM customers
      WHERE name ILIKE '%DEILSON CARLOS%' OR name ILIKE '%R J DOS PASSOS%' LIMIT 4`,
  );
  console.log('--- AS EMPRESAS QUE APARECERAM ---');
  if (!emp.rows.length) console.log('  (nao estao no CRM — entao vieram do GIGA, nao daqui)');
  for (const x of emp.rows) {
    console.log(`  ${x.name}`);
    console.log(`    cpf=${x.cpf || '-'}  wpp=${x.whatsapp || '-'}  fone=${x.phone || '-'}  regGiga=${x.registro_giga || '-'}`);
  }

  await c.end();
})().catch((e) => {
  console.log('ERRO:', e.message);
  process.exit(1);
});
