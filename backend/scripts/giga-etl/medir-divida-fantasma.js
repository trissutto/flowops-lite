/**
 * Das 198 pessoas acima do limite, quantas na verdade JÁ PAGARAM?
 *
 * Duas descobertas de hoje se cruzam aqui:
 *   · 11.018 parcelas têm DATA DE PAGAMENTO preenchida mas a flag PAGO nula —
 *     o dinheiro entrou, só a baixa ficou pela metade (bug antigo, documentado
 *     em erp.service.ts:2420).
 *   · 198 pessoas estão acima do limite e seriam travadas pela regra nova.
 *
 * Se a dívida delas for justamente dessas parcelas, travá-las é injusto — e a
 * loja descobriria pelo balcão, com a cliente na frente.
 *
 * Só faz SELECT. Compara a dívida "como está" com a dívida "descontando o que
 * tem pagamento registrado".
 *
 * Uso (da RAIZ do repo):
 *   railway run --service Postgres -- node backend/scripts/giga-etl/medir-divida-fantasma.js
 */

const { Client } = require('pg');
const nf = (n) => Number(n || 0).toLocaleString('pt-BR');
const brl = (n) => 'R$ ' + Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 });

const NAO_PESSOA =
  '^(REDESHOP|VISAELECTRON|CREDICARD|VISANET|SISPUMI|SOROCRED|CREDSYSTEM|GREMIO|' +
  'AMEX|HIPERCARD|ELO|CIELO|VINHECARD|VENDA ONLINE|CONSUMIDOR)$';

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL });
  await c.connect();

  const q = await c.query(
    `WITH ficha AS (
       SELECT regexp_replace(COALESCE(cpf,''),'\\D','','g') AS cpf, loja, codigo,
              COALESCE(limite_compras,0)::float AS limite, nome
         FROM giga_clientes
        WHERE regexp_replace(COALESCE(cpf,''),'\\D','','g') <> ''
          AND UPPER(TRIM(COALESCE(nome,''))) !~ $1
     ),
     parc AS (
       SELECT f.cpf,
              -- Como está hoje: tudo que não tem flag PAGO conta como dívida.
              COALESCE(SUM(p.valor_parcela),0)::float AS bruto,
              -- Descontando o que TEM data de pagamento (dinheiro que entrou).
              COALESCE(SUM(p.valor_parcela) FILTER (WHERE p.data_pagamento IS NULL),0)::float AS real,
              COUNT(*) FILTER (WHERE p.data_pagamento IS NOT NULL)::int AS parcelas_pagas
         FROM ficha f
         JOIN crediario_parcelas p
           ON p.loja = f.loja AND p.cod_cliente = f.codigo
          AND p.pago = false AND p.cancelado = false
          AND COALESCE(TRIM(p.nome_cliente),'') <> ''
          AND UPPER(TRIM(p.nome_cliente)) !~ $1
        GROUP BY 1
     ),
     marc AS (
       SELECT f.cpf, COALESCE(SUM(m.valor_total),0)::float AS v
         FROM ficha f JOIN marcados m
           ON m.store_code = f.loja AND m.cod_cliente = f.codigo
          AND m.status = 'ativo' AND m.is_training = false
        GROUP BY 1
     ),
     pessoa AS (
       SELECT cpf, MAX(limite) AS limite, (ARRAY_AGG(nome))[1] AS nome
         FROM ficha GROUP BY cpf
     )
     SELECT p.cpf, p.nome, p.limite,
            COALESCE(pa.bruto,0) + COALESCE(m.v,0) AS exp_hoje,
            COALESCE(pa.real,0)  + COALESCE(m.v,0) AS exp_real,
            COALESCE(pa.parcelas_pagas,0) AS pagas
       FROM pessoa p
       LEFT JOIN parc pa ON pa.cpf = p.cpf
       LEFT JOIN marc m ON m.cpf = p.cpf
      WHERE COALESCE(pa.bruto,0) + COALESCE(m.v,0) > 0`,
    [NAO_PESSOA],
  );

  const L = q.rows.map((r) => ({
    nome: r.nome, limite: Number(r.limite),
    hoje: Number(r.exp_hoje), real: Number(r.exp_real), pagas: Number(r.pagas),
  }));

  const travHoje = L.filter((x) => x.hoje > x.limite);
  const travReal = L.filter((x) => x.real > x.limite);
  const salvas = travHoje.filter((x) => x.real <= x.limite);
  const soma = (a, k) => a.reduce((s, x) => s + x[k], 0);

  console.log('--- TRAVADAS PELO NUMERO DE HOJE ---');
  console.log(`  ${nf(travHoje.length)} pessoa(s) · ${brl(soma(travHoje, 'hoje'))}`);
  console.log('');
  console.log('--- TRAVADAS DESCONTANDO O QUE JA FOI PAGO ---');
  console.log(`  ${nf(travReal.length)} pessoa(s) · ${brl(soma(travReal, 'real'))}`);
  console.log('');
  console.log(`  >> ${nf(salvas.length)} pessoa(s) SERIAM TRAVADAS POR DIVIDA QUE NAO EXISTE`);
  console.log(`     (pagaram, mas ninguem deu baixa)`);

  if (salvas.length) {
    console.log('');
    console.log('--- EXEMPLOS DE DIVIDA FANTASMA ---');
    for (const s of salvas.sort((a, b) => (b.hoje - b.real) - (a.hoje - a.real)).slice(0, 10)) {
      console.log(
        `  ${String(s.nome || '?').slice(0, 30).padEnd(32)} limite ${brl(s.limite).padStart(11)}` +
        ` · consta ${brl(s.hoje).padStart(11)} · deve mesmo ${brl(s.real).padStart(11)}` +
        ` (${s.pagas} parcela[s] paga[s] sem baixa)`,
      );
    }
  }

  const totalFantasma = soma(L, 'hoje') - soma(L, 'real');
  console.log('');
  console.log('=========================================');
  console.log(`  Divida de pessoa fisica como consta:  ${brl(soma(L, 'hoje'))}`);
  console.log(`  Ja paga, so nao baixada:              ${brl(totalFantasma)}`);
  console.log(`  DIVIDA REAL:                          ${brl(soma(L, 'real'))}`);

  await c.end();
})().catch((e) => {
  console.log('ERRO:', e.message);
  process.exit(1);
});
