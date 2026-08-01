/**
 * Quantas clientes o LIMITE ÚNICO DA REDE trava?
 *
 * Hoje o limite é por loja: a mesma pessoa tem ficha e limite em cada uma, e
 * ninguém soma. Passando pra limite de rede, a exposição vira:
 *
 *     crediário em aberto (todas as lojas) + marcados ativos (todas as lojas)
 *
 * contra UM limite por pessoa. Quem já estourou nessa conta deixa de levar
 * marcado e de fechar crediário — inclusive em loja onde nunca comprou.
 *
 * Isso é mudança que a loja sente no balcão. Melhor saber o tamanho ANTES:
 * se travar 30 clientes, é ajuste; se travar 3.000, precisa de plano.
 *
 * A pessoa é identificada por CPF. Ficha sem CPF não entra na consolidação —
 * e quantas são disso também é resposta deste script.
 *
 * Só faz SELECT.
 *
 * Uso (da RAIZ do repo):
 *   railway run --service Postgres -- node backend/scripts/giga-etl/medir-exposicao-rede.js
 */

const { Client } = require('pg');

const nf = (n) => Number(n || 0).toLocaleString('pt-BR');
const brl = (n) => 'R$ ' + Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 });

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL });
  await c.connect();

  // ── 1. Quem tem ficha em mais de uma loja? É aí que a soma muda algo. ──
  console.log('--- PESSOAS x FICHAS ---');
  const p = await c.query(
    `SELECT COUNT(*)::int AS fichas,
            COUNT(*) FILTER (WHERE COALESCE(cpf,'') = '')::int AS sem_cpf,
            COUNT(DISTINCT NULLIF(regexp_replace(COALESCE(cpf,''), '\\D', '', 'g'), ''))::int AS pessoas
       FROM giga_clientes`,
  );
  const r0 = p.rows[0];
  console.log(`  fichas cadastradas: ${nf(r0.fichas)}`);
  console.log(`  pessoas (CPF distinto): ${nf(r0.pessoas)}`);
  console.log(`  fichas SEM CPF: ${nf(r0.sem_cpf)}  <- nao entram na consolidacao`);

  const multi = await c.query(
    `SELECT COUNT(*)::int AS n FROM (
       SELECT regexp_replace(cpf,'\\D','','g') AS d, COUNT(DISTINCT loja) AS lojas
         FROM giga_clientes WHERE COALESCE(cpf,'') <> ''
        GROUP BY 1 HAVING COUNT(DISTINCT loja) > 1
     ) t`,
  );
  console.log(`  pessoas com ficha em MAIS DE UMA loja: ${nf(multi.rows[0].n)}`);
  console.log('    (so nessas o limite unico muda alguma coisa)');

  // ── 2. Exposição consolidada por pessoa ────────────────────────────────
  // Crediário aberto vem de crediario_parcelas (por loja+codCliente);
  // marcados ativos vêm da tabela marcados. Ambos ligados à pessoa pelo CPF
  // da ficha.
  console.log('');
  console.log('--- EXPOSICAO CONSOLIDADA (crediario + marcados) ---');
  const exp = await c.query(
    `WITH ficha AS (
       SELECT regexp_replace(cpf,'\\D','','g') AS cpf, loja, codigo,
              MAX(COALESCE(limite_compras,0))::float AS limite
         FROM giga_clientes WHERE COALESCE(cpf,'') <> ''
        GROUP BY 1,2,3
     ),
     cred AS (
       SELECT f.cpf, COALESCE(SUM(p.valor_parcela),0)::float AS v
         FROM ficha f
         JOIN crediario_parcelas p
           ON p.loja = f.loja AND p.cod_cliente = f.codigo
          AND p.pago = false AND p.cancelado = false
        GROUP BY 1
     ),
     marc AS (
       SELECT f.cpf, COALESCE(SUM(m.valor_total),0)::float AS v
         FROM ficha f
         JOIN marcados m
           ON m.store_code = f.loja AND m.cod_cliente = f.codigo
          AND m.status = 'ativo' AND m.is_training = false
        GROUP BY 1
     ),
     lim AS (SELECT cpf, MAX(limite) AS limite FROM ficha GROUP BY 1)
     SELECT l.cpf, l.limite,
            COALESCE(c.v,0) AS cred, COALESCE(m.v,0) AS marc,
            COALESCE(c.v,0) + COALESCE(m.v,0) AS exposicao
       FROM lim l
       LEFT JOIN cred c ON c.cpf = l.cpf
       LEFT JOIN marc m ON m.cpf = l.cpf`,
  );

  const linhas = exp.rows.filter((r) => Number(r.exposicao) > 0 || Number(r.limite) > 0);
  const comExposicao = linhas.filter((r) => Number(r.exposicao) > 0);
  const estourados = linhas.filter((r) => Number(r.exposicao) > Number(r.limite));
  const semLimite = comExposicao.filter((r) => Number(r.limite) <= 0);

  const soma = (arr, k) => arr.reduce((s, r) => s + Number(r[k] || 0), 0);

  console.log(`  pessoas com exposicao > 0: ${nf(comExposicao.length)}`);
  console.log(`    crediario: ${brl(soma(comExposicao, 'cred'))}`);
  console.log(`    marcados:  ${brl(soma(comExposicao, 'marc'))}`);
  console.log(`    TOTAL:     ${brl(soma(comExposicao, 'exposicao'))}`);

  console.log('');
  console.log('--- QUEM SERIA TRAVADO ---');
  console.log(`  acima do limite consolidado: ${nf(estourados.length)} pessoa(s)`);
  console.log(`    exposicao delas: ${brl(soma(estourados, 'exposicao'))}`);
  console.log(`  COM divida mas SEM limite definido: ${nf(semLimite.length)} pessoa(s)`);
  console.log(`    exposicao delas: ${brl(soma(semLimite, 'exposicao'))}`);
  if (semLimite.length) {
    console.log('    >> ATENCAO: limite 0 + regra nova = travadas na hora.');
    console.log('       Precisam de limite antes da virada, ou a loja para.');
  }

  // Quanto do estouro so aparece PORQUE somou as lojas?
  const soPorSomar = estourados.filter((r) => Number(r.cred) + Number(r.marc) > Number(r.limite)
    && Number(r.marc) > 0 && Number(r.cred) > 0);
  console.log('');
  console.log(`  travadas por somar crediario COM marcado: ${nf(soPorSomar.length)}`);
  console.log('    (essas passariam se cada um fosse contado separado)');

  console.log('');
  console.log('--- AMOSTRA DAS MAIS EXPOSTAS ---');
  for (const r of estourados.sort((a, b) => b.exposicao - a.exposicao).slice(0, 10)) {
    const cpfMask = String(r.cpf).slice(0, 3) + '***' + String(r.cpf).slice(-2);
    console.log(
      `  ${cpfMask}  limite ${brl(r.limite).padStart(14)}  ` +
      `cred ${brl(r.cred).padStart(14)}  marc ${brl(r.marc).padStart(12)}  ` +
      `exposicao ${brl(r.exposicao).padStart(14)}`,
    );
  }

  await c.end();
})().catch((e) => {
  console.log('ERRO:', e.message);
  process.exit(1);
});
