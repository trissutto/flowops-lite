/**
 * O horário GRAVADO das vendas está errado, ou só a LEITURA está?
 *
 * A diferença decide tudo: se o dado está certo, mexer nele destrói informação
 * boa de forma irreversível. Se está errado, aí sim precisa de correção.
 *
 * O teste: `timestamptz` do Postgres guarda um INSTANTE ABSOLUTO, não um
 * relógio de parede. A mesma linha exibida em fusos diferentes mostra horas
 * diferentes — e as duas estão certas. Se o instante gravado, lido em Brasília,
 * bate com a hora em que a vendedora realmente atendeu, o dado está íntegro e o
 * problema é só de quem consulta.
 *
 * Só faz SELECT.
 *
 * Uso (da RAIZ do repo):
 *   railway run --service Postgres -- node backend/scripts/giga-etl/diag-timestamp-esta-certo.js
 */

const { Client } = require('pg');
const brl = (n) => 'R$ ' + Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 });

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL });
  await c.connect();

  console.log('--- O TIPO DA COLUNA ---');
  const t = await c.query(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name = 'pdv_sales'
        AND column_name IN ('created_at','finalized_at','updated_at')
      ORDER BY column_name`,
  );
  for (const r of t.rows) console.log(`  ${r.column_name.padEnd(14)} ${r.data_type}`);
  const comTz = t.rows.every((r) => String(r.data_type).includes('with time zone'));
  console.log('');
  console.log(comTz
    ? '  >> COM fuso (timestamptz): guarda um INSTANTE. Nao existe "hora errada"'
    : '  >> SEM fuso: guarda relogio de parede — aqui SIM pode haver ambiguidade');

  console.log('');
  console.log('--- A MESMA VENDA, VISTA DE TRES JEITOS ---');
  const v = await c.query(
    `SELECT id, store_code, total,
            created_at AS instante,
            created_at AT TIME ZONE 'America/Sao_Paulo' AS visto_em_brasilia,
            created_at AT TIME ZONE 'UTC' AS visto_em_utc
       FROM pdv_sales
      WHERE status = 'finalized' AND created_at > NOW() - INTERVAL '4 hours'
      ORDER BY created_at DESC LIMIT 5`,
  );
  for (const r of v.rows) {
    console.log('');
    console.log(`  loja ${r.store_code} · ${brl(r.total)}`);
    console.log(`    em Brasilia (a hora do balcao): ${String(r.visto_em_brasilia).slice(0, 24)}`);
    console.log(`    em UTC (a hora do servidor):    ${String(r.visto_em_utc).slice(0, 24)}`);
  }

  console.log('');
  console.log('--- O TESTE QUE DECIDE ---');
  // Se o dado estivesse deslocado, a soma do dia lida em Brasilia nao bateria
  // com o que as lojas venderam. Se bate, o dado esta integro.
  const dia = await c.query(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(total),0)::float AS v,
            MIN(created_at AT TIME ZONE 'America/Sao_Paulo') AS primeira,
            MAX(created_at AT TIME ZONE 'America/Sao_Paulo') AS ultima
       FROM pdv_sales
      WHERE status = 'finalized'
        AND (created_at AT TIME ZONE 'America/Sao_Paulo')::date
            = (NOW() AT TIME ZONE 'America/Sao_Paulo')::date`,
  );
  const d = dia.rows[0];
  console.log(`  Vendas de HOJE lidas em horario de Brasilia:`);
  console.log(`    ${d.n} venda(s) · ${brl(d.v)}`);
  console.log(`    primeira: ${String(d.primeira).slice(0, 24)}`);
  console.log(`    ultima:   ${String(d.ultima).slice(0, 24)}`);
  console.log('');
  console.log('  Se a primeira e a ultima batem com o horario real de abertura e');
  console.log('  fechamento das lojas, o dado gravado esta CERTO. Nesse caso');
  console.log('  alterar os timestamps DESTRUIRIA informacao boa — o conserto e');
  console.log('  nas CONSULTAS, que precisam agrupar por dia de Brasilia.');

  await c.end();
})().catch((e) => {
  console.log('ERRO:', e.message);
  process.exit(1);
});
