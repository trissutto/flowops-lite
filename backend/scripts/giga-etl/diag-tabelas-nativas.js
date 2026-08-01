/**
 * O que JÁ existe no Postgres para os três bloqueios duros?
 *
 * Antes de construir tabela nativa de crediário, grupos/subgrupos e fechamento,
 * conferir no banco de PRODUÇÃO se elas já existem e se têm dado dentro. Tabela
 * criada e vazia é pior que tabela ausente: parece pronta e responde nada.
 *
 * Só faz SELECT.
 *
 * Uso (da RAIZ do repo):
 *   railway run --service Postgres -- node backend/scripts/giga-etl/diag-tabelas-nativas.js
 */

const { Client } = require('pg');

// Candidatas por assunto. Nomes variados de propósito — não sei qual convenção
// cada módulo usou, e chutar errado daria "não existe" falso.
const ASSUNTOS = [
  { assunto: 'CREDIARIO (parcelas)', like: ["crediario%", "%parcela%", "%carne%"] },
  { assunto: 'GRUPOS / SUBGRUPOS', like: ["%grupo%", "%categoria%", "%subgrupo%"] },
  { assunto: 'FECHAMENTO DE CAIXA', like: ["%fechamento%", "%caixa%", "%cash%"] },
  { assunto: 'PRODUTO NATIVO', like: ["product%", "produto%"] },
  { assunto: 'CLIENTE NATIVO', like: ["customer%", "cliente%"] },
];

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL });
  await c.connect();

  for (const a of ASSUNTOS) {
    console.log('');
    console.log('=== ' + a.assunto + ' ===');
    const cond = a.like.map((_, i) => `table_name LIKE $${i + 1}`).join(' OR ');
    const t = await c.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema='public' AND (${cond}) ORDER BY 1`,
      a.like,
    );
    if (!t.rows.length) {
      console.log('  (nenhuma tabela)');
      continue;
    }
    for (const r of t.rows) {
      let n = '?';
      try {
        const q = await c.query(`SELECT COUNT(*)::int AS n FROM "${r.table_name}"`);
        n = q.rows[0].n.toLocaleString('pt-BR');
      } catch (e) {
        n = 'erro: ' + e.message.slice(0, 40);
      }
      // Espelho (wincred_/giga_) e tabela nativa contam histórias diferentes:
      // espelho cheio só prova que o Giga tem o dado, não que o Flow é dono.
      const tipo = /^wincred_|^giga_/.test(r.table_name) ? 'ESPELHO ' : 'nativa  ';
      console.log(`  ${tipo} ${r.table_name.padEnd(38)} ${n.padStart(12)} linhas`);
    }
  }

  // Sequências nativas — o que substitui o MAX(CODIGO)+1 do Giga.
  console.log('');
  console.log('=== SEQUENCIAS / GERADORES NATIVOS ===');
  const s = await c.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema='public'
        AND (table_name LIKE '%sequence%' OR table_name LIKE '%seq%' OR table_name LIKE '%counter%')
      ORDER BY 1`,
  );
  if (!s.rows.length) console.log('  (nenhuma)');
  for (const r of s.rows) {
    let n = '?';
    try {
      const q = await c.query(`SELECT COUNT(*)::int AS n FROM "${r.table_name}"`);
      n = String(q.rows[0].n);
    } catch (e) { n = 'erro'; }
    console.log(`  ${r.table_name.padEnd(46)} ${n.padStart(6)} linhas`);
  }

  await c.end();
})().catch((e) => {
  console.log('ERRO:', e.message);
  process.exit(1);
});
