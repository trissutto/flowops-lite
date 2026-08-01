/**
 * O endereço digitado no PDV chegou no banco?
 *
 * O dono relatou duas vezes que "não salvou". Antes de continuar lendo código,
 * olhar o dado: se está gravado, o problema é de LEITURA (a tela não recarrega);
 * se não está, é de ESCRITA.
 *
 * Só faz SELECT.
 *
 * Uso (da RAIZ do repo):
 *   railway run --service Postgres -- node backend/scripts/giga-etl/diag-endereco-salvou.js [cpf]
 */

const { Client } = require('pg');
const CPF = (process.argv[2] || '28665529896').replace(/\D/g, '');

/**
 * Hora de BRASÍLIA, sempre.
 *
 * As colunas guardam UTC. Imprimir o valor cru mostra 11:48 para algo que
 * aconteceu às 08:48 no balcão — e quem lê acha que foi outro horário, ou pior,
 * outro dia. Já aconteceu neste próprio diagnóstico.
 */
const hora = (d) => (d ? new Date(new Date(d).getTime() - 3 * 3600_000).toISOString().replace('T', ' ').slice(0, 19) : '-');

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL });
  await c.connect();

  console.log('--- VENDAS COM CLIENTE (ultimas 6h) ---');
  const v = await c.query(
    `SELECT store_code, status, customer_cpf, customer_name, customer_email,
            customer_cep, customer_endereco, customer_cidade, created_at
       FROM pdv_sales
      WHERE customer_cpf IS NOT NULL
        AND created_at > NOW() - INTERVAL '6 hours'
      ORDER BY created_at DESC LIMIT 8`,
  );
  if (!v.rows.length) console.log('  (nenhuma)');
  for (const r of v.rows) {
    console.log('');
    console.log(`  ${hora(r.created_at)} (Brasilia) · loja ${r.store_code} · ${r.status}`);
    console.log(`    cpf=${r.customer_cpf} nome=${r.customer_name || '-'}`);
    console.log(`    email=${r.customer_email || '(vazio)'}`);
    console.log(`    cep=${r.customer_cep || '(vazio)'} · rua=${r.customer_endereco || '(vazio)'} · cidade=${r.customer_cidade || '(vazio)'}`);
  }

  console.log('');
  console.log(`--- FICHA NO CRM (CPF ${CPF}) ---`);
  const cli = await c.query(
    'SELECT id, name, email, whatsapp, updated_at FROM customers WHERE cpf = $1',
    [CPF],
  );
  if (!cli.rows.length) console.log('  (nao existe no CRM)');
  for (const r of cli.rows) {
    console.log(`  ${r.name} · email=${r.email || '-'} · wpp=${r.whatsapp || '-'}`);
    console.log(`  atualizada em: ${hora(r.updated_at)} (Brasilia)`);
    const end = await c.query(
      'SELECT cep, street, number, district, city, state, is_primary FROM customer_addresses WHERE customer_id = $1',
      [r.id],
    );
    console.log(`  enderecos: ${end.rows.length}`);
    for (const e of end.rows) {
      console.log(`    cep=${e.cep || '-'} rua=${e.street || '-'} nº=${e.number || '-'} bairro=${e.district || '-'} ${e.city || '-'}/${e.state || '-'} principal=${e.is_primary}`);
    }
  }

  await c.end();
})().catch((e) => {
  console.log('ERRO:', e.message);
  process.exit(1);
});
