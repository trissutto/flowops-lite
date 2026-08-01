/**
 * Quantas PESSOAS o limite único trava — agora com a base classificada.
 *
 * A medição anterior deu 204 travadas, mas estava contaminada: somava
 * recebível de cartão (CREDICARD, VISANET, CIELO…), venda de canal
 * (VENDA ONLINE) e venda à vista (código 0 = CONSUMIDOR) como se fosse
 * dívida de cliente. Dos R$ 10 mi, só R$ 956 mil são de pessoa física.
 *
 * Aqui a conta refeita, contando SÓ o que é dívida de gente.
 */
const { Client } = require('pg');
const nf = (n) => Number(n || 0).toLocaleString('pt-BR');
const brl = (n) => 'R$ ' + Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 });

// Nomes que NÃO são pessoa. Âncora nas pontas — 'ELO' não pode pegar 'ANGELO'.
const NAO_PESSOA = '^(REDESHOP|VISAELECTRON|CREDICARD|VISANET|SISPUMI|SOROCRED|CREDSYSTEM|GREMIO|AMEX|HIPERCARD|ELO|CIELO|VINHECARD|VENDA ONLINE|CONSUMIDOR)$';

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL });
  await c.connect();

  const q = await c.query(
    `WITH parc AS (
       SELECT loja, cod_cliente, valor_parcela
         FROM crediario_parcelas
        WHERE pago = false AND cancelado = false
          AND COALESCE(TRIM(nome_cliente),'') <> ''
          AND UPPER(TRIM(nome_cliente)) !~ $1
     ),
     ficha AS (
       SELECT regexp_replace(COALESCE(cpf,''),'\D','','g') AS cpf, loja, codigo,
              COALESCE(limite_compras,0)::float AS limite, nome
         FROM giga_clientes
        WHERE regexp_replace(COALESCE(cpf,''),'\D','','g') <> ''
          AND UPPER(TRIM(COALESCE(nome,''))) !~ $1
     ),
     cred AS (
       SELECT f.cpf, COALESCE(SUM(p.valor_parcela),0)::float AS v
         FROM ficha f JOIN parc p ON p.loja = f.loja AND p.cod_cliente = f.codigo
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
       SELECT cpf, MAX(limite) AS limite, (ARRAY_AGG(nome))[1] AS nome FROM ficha GROUP BY cpf
     )
     SELECT p.cpf, p.nome, p.limite,
            COALESCE(c.v,0) AS cred, COALESCE(m.v,0) AS marc,
            COALESCE(c.v,0)+COALESCE(m.v,0) AS exposicao
       FROM pessoa p
       LEFT JOIN cred c ON c.cpf = p.cpf
       LEFT JOIN marc m ON m.cpf = p.cpf
      WHERE COALESCE(c.v,0)+COALESCE(m.v,0) > 0
      ORDER BY 6 DESC`,
    [NAO_PESSOA],
  );

  const linhas = q.rows.map((r) => ({ ...r, limite: Number(r.limite), exposicao: Number(r.exposicao) }));
  const travadas = linhas.filter((l) => l.exposicao > l.limite);
  const semLim = linhas.filter((l) => l.limite <= 0);
  const soma = (a, k) => a.reduce((s, x) => s + Number(x[k] || 0), 0);

  console.log('--- SO PESSOA FISICA ---');
  console.log(`  com divida:        ${nf(linhas.length)} pessoa(s) · ${brl(soma(linhas,'exposicao'))}`);
  console.log(`    crediario: ${brl(soma(linhas,'cred'))}   marcados: ${brl(soma(linhas,'marc'))}`);
  console.log('');
  console.log(`  ACIMA do limite:   ${nf(travadas.length)} pessoa(s) · ${brl(soma(travadas,'exposicao'))}`);
  console.log(`  SEM limite:        ${nf(semLim.length)} pessoa(s) · ${brl(soma(semLim,'exposicao'))}`);
  console.log('');
  console.log('--- AS 10 MAIORES QUE SERIAM TRAVADAS ---');
  for (const l of travadas.slice(0, 10)) {
    console.log(`  ${String(l.nome || '?').slice(0,32).padEnd(34)} limite ${brl(l.limite).padStart(13)}  deve ${brl(l.exposicao).padStart(13)}`);
  }
  await c.end();
})().catch((e) => { console.log('ERRO:', e.message); process.exit(1); });
