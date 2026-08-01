/**
 * As maiores "dívidas" são de pessoas ou de contas-balde?
 *
 * O top de exposição trouxe nomes com 857 a 1.746 parcelas em aberto e limites
 * de R$ 99.999.999,99. Loja de roupa não parcela 1.700 vezes, e limite de 100
 * milhões é valor-sentinela do Wincred pra "sem limite".
 *
 * Suspeita: são códigos genéricos usados como balde — várias vendas de pessoas
 * diferentes penduradas no mesmo cadastro, igual ao VISANET. Se for, essas
 * linhas NÃO podem entrar na conta do limite por pessoa: travariam gente que
 * não deve nada.
 *
 * O teste: um cod_cliente que aparece com MUITOS NOMES diferentes nas parcelas
 * não é uma pessoa.
 *
 * Só faz SELECT.
 *
 * Uso (da RAIZ do repo):
 *   railway run --service Postgres -- node backend/scripts/giga-etl/diag-conta-balde.js
 */

const { Client } = require('pg');
const nf = (n) => Number(n || 0).toLocaleString('pt-BR');
const brl = (n) => 'R$ ' + Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 });

const CPFS = ['47871409816', '07722805841', '33353814833', '34849503829'];

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL });
  await c.connect();

  console.log('--- AS FICHAS DO TOP 4 ---');
  const f = await c.query(
    `SELECT loja, codigo, nome, COALESCE(limite_compras,0)::float AS lim
       FROM giga_clientes
      WHERE regexp_replace(COALESCE(cpf,''),'\\D','','g') = ANY($1::text[])
      ORDER BY nome, loja`,
    [CPFS],
  );
  for (const r of f.rows) {
    console.log(`  loja ${String(r.loja).padEnd(3)} cod ${String(r.codigo).padEnd(8)} lim ${brl(r.lim).padStart(18)}  ${r.nome}`);
  }

  console.log('');
  console.log('--- CODIGOS COM MAIS PARCELAS ABERTAS ---');
  console.log('  (muitos NOMES no mesmo codigo = conta-balde, nao pessoa)');
  const d = await c.query(
    `SELECT cod_cliente, COUNT(*)::int AS n,
            COUNT(DISTINCT nome_cliente)::int AS nomes,
            COUNT(DISTINCT loja)::int AS lojas,
            COALESCE(SUM(valor_parcela),0)::float AS v
       FROM crediario_parcelas
      WHERE pago = false AND cancelado = false
      GROUP BY 1 ORDER BY n DESC LIMIT 12`,
  );
  for (const r of d.rows) {
    const flag = Number(r.nomes) > 5 ? '   *** BALDE' : '';
    console.log(
      `  cod ${String(r.cod_cliente).padEnd(8)} ${String(nf(r.n)).padStart(7)} parcelas · ` +
      `${String(r.nomes).padStart(4)} nome(s) · ${r.lojas} loja(s) · ${brl(r.v).padStart(15)}${flag}`,
    );
  }

  // Quanto da divida total esta em codigos com mais de 5 nomes?
  const balde = await c.query(
    `WITH porcod AS (
       SELECT cod_cliente, COUNT(DISTINCT nome_cliente)::int AS nomes,
              COALESCE(SUM(valor_parcela),0)::float AS v, COUNT(*)::int AS n
         FROM crediario_parcelas WHERE pago = false AND cancelado = false
        GROUP BY 1
     )
     SELECT
       COALESCE(SUM(v) FILTER (WHERE nomes > 5),0)::float AS v_balde,
       COALESCE(SUM(n) FILTER (WHERE nomes > 5),0)::int   AS n_balde,
       COALESCE(SUM(v) FILTER (WHERE nomes <= 5),0)::float AS v_pessoa,
       COALESCE(SUM(n) FILTER (WHERE nomes <= 5),0)::int   AS n_pessoa
     FROM porcod`,
  );
  const b = balde.rows[0];
  console.log('');
  console.log('--- A DIVIDA ABERTA, SEPARADA ---');
  console.log(`  em codigos-BALDE (>5 nomes): ${nf(b.n_balde)} parcelas · ${brl(b.v_balde)}`);
  console.log(`  em codigos de PESSOA:        ${nf(b.n_pessoa)} parcelas · ${brl(b.v_pessoa)}`);

  console.log('');
  console.log('=========================================');
  if (Number(b.v_balde) > Number(b.v_pessoa) * 0.2) {
    console.log('VEREDITO: parte relevante da divida esta em conta-balde.');
    console.log('O limite por pessoa NAO pode somar essas linhas — travaria');
    console.log('clientes que nao devem nada. Precisa excluir os codigos-balde');
    console.log('do calculo, como a tela de recebimentos ja faz com cartao.');
  } else {
    console.log('VEREDITO: a divida esta majoritariamente em codigo de pessoa.');
    console.log('A consolidacao por CPF pode somar direto.');
  }

  await c.end();
})().catch((e) => {
  console.log('ERRO:', e.message);
  process.exit(1);
});
