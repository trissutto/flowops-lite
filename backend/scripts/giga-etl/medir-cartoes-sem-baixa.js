/**
 * Os CARTÕES estão entulhando o crediário por falta da baixa automática?
 *
 * No Giga existia uma rotina que liquidava sozinha quando chegava a data:
 * débito D+1, crédito D+29. O Flow não tem essa rotina — então as parcelas de
 * cartão nasceram abertas e nunca fecharam. Se for isso, o "crediário em
 * aberto" da rede é um número que não existe: é recebível de cartão que já
 * caiu na conta há meses, contado como dívida de cliente.
 *
 * Códigos que o dono levantou (fichas que NÃO são pessoa):
 *   REDESHOP 3155 · VISAELECTRON 3156 · CREDICARD 564 · VISANET 26
 *   SISPUMI 3689 · SOROCRED 1733 · CREDSYSTEM 382 · GREMIO 4026
 *   AMEX 5676 · HIPERCARD 5677 · ELO 5162 · CIELO 5476 · CONSUMIDOR 0
 *
 * Só faz SELECT.
 *
 * Uso (da RAIZ do repo):
 *   railway run --service Postgres -- node backend/scripts/giga-etl/medir-cartoes-sem-baixa.js
 */

const { Client } = require('pg');

const BRL = (n) => `R$ ${Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;

// Nome na ficha → como a operação chama. Casamos por NOME e não por código:
// o código se repete entre lojas (cada loja tem sua própria numeração).
const CARTAO = [
  'CREDICARD', 'VISANET', 'VISA ELECTRON', 'VISAELECTRON', 'REDESHOP', 'REDE SHOP',
  'CIELO', 'ELO', 'AMEX', 'HIPERCARD', 'SOROCRED', 'CREDSYSTEM', 'SISPUMI',
  'GREMIO', 'MASTERCARD', 'MAESTRO', 'BANRICOMPRAS', 'GETNET', 'STONE',
];

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL });
  await c.connect();

  const like = CARTAO.map((_, i) => `UPPER(COALESCE(g.nome,'')) LIKE $${i + 1}`).join(' OR ');
  const params = CARTAO.map((n) => `%${n}%`);

  console.log('══════ QUEM SEGURA O "CREDIARIO EM ABERTO" ══════');
  console.log('');

  const r = await c.query(
    `SELECT COALESCE(g.nome, '(ficha nao encontrada)') AS nome,
            COUNT(*)::int AS parcelas,
            COALESCE(SUM(p.valor_parcela),0)::float AS valor,
            MIN(p.vencimento) AS mais_antiga,
            MAX(p.vencimento) AS mais_nova,
            COUNT(*) FILTER (WHERE p.vencimento < CURRENT_DATE)::int AS vencidas
       FROM crediario_parcelas p
       LEFT JOIN giga_clientes g ON g.loja = p.loja AND g.codigo = p.cod_cliente
      WHERE p.pago = false AND p.cancelado = false
      GROUP BY 1
      ORDER BY 3 DESC
      LIMIT 25`,
  );

  console.log('TOP 25 fichas com mais dinheiro em aberto:');
  console.log('');
  for (const x of r.rows) {
    const ehCartao = CARTAO.some((n) => String(x.nome).toUpperCase().includes(n));
    const marca = ehCartao ? '💳' : '  ';
    console.log(
      `${marca} ${String(x.nome).slice(0, 30).padEnd(30)} ${String(x.parcelas).padStart(7)} parc  ${BRL(x.valor).padStart(18)}` +
      `  venc ${String(x.mais_antiga).slice(0, 10)} a ${String(x.mais_nova).slice(0, 10)}`,
    );
  }

  console.log('');
  console.log('══════ CARTAO vs PESSOA ══════');
  const split = await c.query(
    `SELECT (${like}) AS eh_cartao,
            COUNT(*)::int AS parcelas,
            COALESCE(SUM(p.valor_parcela),0)::float AS valor,
            COUNT(DISTINCT p.cod_cliente)::int AS fichas
       FROM crediario_parcelas p
       LEFT JOIN giga_clientes g ON g.loja = p.loja AND g.codigo = p.cod_cliente
      WHERE p.pago = false AND p.cancelado = false
      GROUP BY 1`,
    params,
  );
  let totCartao = 0, totPessoa = 0;
  for (const x of split.rows) {
    const rotulo = x.eh_cartao ? '💳 CARTAO/FINANCEIRA' : '👤 PESSOA (ou nao identificado)';
    console.log(`  ${rotulo.padEnd(34)} ${String(x.parcelas).padStart(8)} parc · ${x.fichas} fichas · ${BRL(x.valor)}`);
    if (x.eh_cartao) totCartao = Number(x.valor); else totPessoa = Number(x.valor);
  }
  const total = totCartao + totPessoa;
  if (total > 0) {
    console.log('');
    console.log(`  Do "crediario em aberto" de ${BRL(total)}, ${BRL(totCartao)} (${((totCartao / total) * 100).toFixed(1)}%) e CARTAO.`);
  }

  // ── A PERGUNTA QUE DECIDE A ROTINA ──
  // Se a regra do Giga (debito D+1, credito D+29) fosse aplicada AGORA, quanto
  // ja teria vencido e deveria estar liquidado?
  console.log('');
  console.log('══════ SE A BAIXA AUTOMATICA RODASSE HOJE ══════');
  const venc = await c.query(
    `SELECT
        COUNT(*) FILTER (WHERE p.vencimento < CURRENT_DATE)::int AS ja_venceu,
        COALESCE(SUM(p.valor_parcela) FILTER (WHERE p.vencimento < CURRENT_DATE),0)::float AS v_venceu,
        COUNT(*) FILTER (WHERE p.vencimento >= CURRENT_DATE)::int AS a_vencer,
        COALESCE(SUM(p.valor_parcela) FILTER (WHERE p.vencimento >= CURRENT_DATE),0)::float AS v_a_vencer,
        MIN(p.vencimento) AS mais_antiga
       FROM crediario_parcelas p
       LEFT JOIN giga_clientes g ON g.loja = p.loja AND g.codigo = p.cod_cliente
      WHERE p.pago = false AND p.cancelado = false AND (${like})`,
    params,
  );
  const v = venc.rows[0];
  console.log(`  cartao JA VENCIDO (liquidaria na hora): ${v.ja_venceu} parcelas · ${BRL(v.v_venceu)}`);
  console.log(`  cartao A VENCER (liquidaria no dia):    ${v.a_vencer} parcelas · ${BRL(v.v_a_vencer)}`);
  console.log(`  parcela de cartao mais antiga em aberto: ${String(v.mais_antiga).slice(0, 10)}`);
  console.log('');
  console.log('  ⚠ liquidar por DATA e aproximacao: antecipacao, feriado e fim de');
  console.log('    semana mudam o dia real. A verdade e o extrato da adquirente.');

  await c.end();
})().catch((e) => {
  console.log('ERRO:', e.message);
  process.exit(1);
});
