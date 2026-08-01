/**
 * O índice único novo vai subir, ou vai quebrar o deploy?
 *
 * `@@unique([saleId, parcela])` em `crediario_parcelas` é a defesa principal
 * contra cobrar a cliente duas vezes — imposta pelo BANCO, não por sonda.
 *
 * Mas `start:prod` roda `prisma db push` no deploy: se houver QUALQUER par
 * (saleId, parcela) repetido com saleId preenchido, o índice não cria e o
 * backend não sobe. Melhor descobrir aqui do que com as lojas abrindo.
 *
 * O histórico deve estar salvo: as 710.589 linhas vieram do Giga com
 * saleId NULL, e o Postgres trata NULLs como distintos num índice único.
 * Este script confirma em vez de supor.
 *
 * Só faz SELECT.
 *
 * Uso (da RAIZ do repo):
 *   railway run --service Postgres -- node backend/scripts/giga-etl/checar-unique-parcela.js
 */

const { Client } = require('pg');
const nf = (n) => Number(n || 0).toLocaleString('pt-BR');

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL });
  await c.connect();

  const tot = await c.query('SELECT COUNT(*)::int AS n FROM crediario_parcelas');
  const comSale = await c.query(
    'SELECT COUNT(*)::int AS n FROM crediario_parcelas WHERE sale_id IS NOT NULL',
  );
  console.log(`linhas totais:            ${nf(tot.rows[0].n)}`);
  console.log(`com sale_id preenchido:   ${nf(comSale.rows[0].n)}`);

  if (!comSale.rows[0].n) {
    console.log('');
    console.log('>> Nenhuma linha tem sale_id. O indice unico sobe sem conflito');
    console.log('   (NULL nao colide com NULL no Postgres).');
    await c.end();
    return;
  }

  const dup = await c.query(
    `SELECT sale_id, parcela, COUNT(*)::int AS n
       FROM crediario_parcelas
      WHERE sale_id IS NOT NULL
      GROUP BY sale_id, parcela
     HAVING COUNT(*) > 1
      ORDER BY n DESC LIMIT 20`,
  );

  console.log('');
  if (!dup.rows.length) {
    console.log('>> Nenhum par (sale_id, parcela) repetido. O indice unico sobe.');
  } else {
    console.log(`*** ${nf(dup.rows.length)} par(es) DUPLICADO(S) — o db push VAI FALHAR:`);
    for (const r of dup.rows) {
      console.log(`   sale_id=${r.sale_id} parcela=${r.parcela} -> ${r.n} linhas`);
    }
    console.log('');
    console.log('NAO deployar antes de resolver. E duplicata REAL de divida:');
    console.log('investigar cada caso antes de mexer — pode ser cobranca em dobro');
    console.log('ja registrada, e apagar sem olhar destroi a prova.');
  }

  await c.end();
  process.exit(dup.rows.length ? 1 : 0);
})().catch((e) => {
  console.log('ERRO:', e.message);
  process.exit(1);
});
