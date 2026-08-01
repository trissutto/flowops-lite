/**
 * Valida as consultas NOVAS do `GET /pdv/customer-info` (espelho giga_clientes)
 * direto no Postgres, antes de qualquer deploy — pega erro de nome de coluna,
 * aspas e tipo na hora, em vez de no meio do crediário da loja.
 *
 * São as mesmas consultas de SombraService.buscarClienteCustomerInfo, na mesma
 * ordem em que ele tenta. Substituem as 9 consultas em cascata no MySQL do Giga
 * (10s de timeout cada) que travavam o PDV por até ~90s quando o Giga pendura.
 *
 * ⚠️ COLUNAS: em `giga_clientes` TODOS os campos camelCase do Prisma têm @map,
 * então as colunas são snake_case (fone_cel, fone_res, raw_json) — sem aspas e
 * em minúsculo. É a pegadinha INVERSA de wincred_produtos, onde o camelCase
 * virou coluna camelCase e PRECISA de aspas (p."descricaoCompleta"). Este
 * script existe pra essa diferença estourar aqui, não em produção.
 *
 * Uso: railway run --service Postgres -- node scripts/giga-etl/validar-customer-info.js
 */

const { Client } = require('pg');

// Trechos SQL compartilhados — cópia literal do que o SombraService monta.
const CPF_NUCLEO = `regexp_replace(COALESCE(g.cpf,''), '[^0-9]', '', 'g')`;
const CODIGO_NUCLEO = `COALESCE(NULLIF(LTRIM(TRIM(g.codigo),'0'),''),'0')`;
const LOJA_NUCLEO = `LPAD(COALESCE(NULLIF(regexp_replace(COALESCE(g.loja,''), '[^0-9]', '', 'g'),''),'0'), 2, '0')`;

/** Monta a consulta do jeito que o serviço monta: condição + filtro de loja. */
const buscar = (condicao, limite) =>
  `SELECT g.codigo, g.nome, g.loja, g.raw_json
     FROM giga_clientes g
    WHERE ${condicao} AND ${LOJA_NUCLEO} = $2
    ORDER BY LENGTH(TRIM(g.codigo)), g.codigo
    LIMIT ${limite}`;

const CONSULTAS = [
  {
    // Tentativa 1 (parte Postgres): CustomerGigaLink → (loja, codigo).
    nome: 'customerInfo/crm-link (customer_giga_links)',
    sql: `SELECT l.giga_loja, l.giga_codigo
            FROM customer_giga_links l
            JOIN customers c ON c.id = l.customer_id
           WHERE c.cpf = ANY($1::text[])
           LIMIT 20`,
    params: [['10845878824', '108.458.788-24']],
  },
  {
    nome: 'customerInfo/1 por codigo do link',
    sql: buscar(`${CODIGO_NUCLEO} = $1`, 1),
    params: ['1', '01'],
  },
  {
    nome: 'customerInfo/2 cpf exato',
    sql: buscar(`${CPF_NUCLEO} = $1`, 1),
    params: ['10845878824', '01'],
  },
  {
    nome: 'customerInfo/3 codigo direto',
    sql: buscar(`${CODIGO_NUCLEO} = $1`, 1),
    params: ['1234', '01'],
  },
  {
    // `$1::text` dentro da concatenação: sem o cast o Postgres não infere o
    // tipo ('%' || $1 é unknown || unknown) e a consulta morre em runtime.
    nome: 'customerInfo/4 cpf LIKE',
    sql: buscar(`${CPF_NUCLEO} LIKE '%' || $1::text || '%'`, 1),
    params: ['10845878824', '01'],
  },
  {
    nome: 'customerInfo/5 telefone (fone_cel/fone_res)',
    sql: buscar(
      `(regexp_replace(COALESCE(g.fone_cel,''), '[^0-9]', '', 'g') LIKE '%' || $1::text || '%'
        OR regexp_replace(COALESCE(g.fone_res,''), '[^0-9]', '', 'g') LIKE '%' || $1::text || '%')`,
      2,
    ),
    params: ['999887766', '01'],
  },
  {
    nome: 'customerInfo/6 nome exato',
    sql: buscar(`UPPER(TRIM(COALESCE(g.nome,''))) = $1`, 2),
    params: ['MARIA DA SILVA', '01'],
  },
  {
    nome: 'customerInfo/6 nome LIKE',
    sql: buscar(`UPPER(COALESCE(g.nome,'')) LIKE '%' || $1::text || '%'`, 2),
    params: ['MARIA DA SILVA', '01'],
  },
  {
    // Sem escopo de loja — o caminho de admin que não passa storeCode.
    nome: 'customerInfo/cpf sem filtro de loja',
    sql: `SELECT g.codigo, g.nome, g.loja, g.raw_json
            FROM giga_clientes g
           WHERE ${CPF_NUCLEO} = $1
           ORDER BY LENGTH(TRIM(g.codigo)), g.codigo
           LIMIT 1`,
    params: ['10845878824'],
  },
  {
    // Não é usada em produção, mas prova que raw_json guarda a linha ORIGINAL
    // do Giga (chaves em maiúsculo) — é ela que vira `cliente.raw` na resposta.
    nome: 'customerInfo/raw_json tem as chaves do Giga',
    sql: `SELECT jsonb_object_keys(g.raw_json::jsonb) AS coluna
            FROM giga_clientes g
           WHERE g.raw_json IS NOT NULL
           LIMIT 40`,
    params: [],
  },
];

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL });
  await c.connect();

  let ok = 0;
  const falhas = [];
  for (const q of CONSULTAS) {
    try {
      const r = await c.query(q.sql, q.params);
      console.log(`  OK   ${q.nome.padEnd(44)} (${r.rowCount} linha(s))`);
      ok++;
    } catch (e) {
      console.log(`  ERRO ${q.nome.padEnd(44)} ${e.message}`);
      falhas.push(`${q.nome}: ${e.message}`);
    }
  }

  console.log('');
  console.log(`${ok}/${CONSULTAS.length} consultas validas.`);
  if (falhas.length) {
    console.log('CORRIJA ANTES DE DEPLOYAR:');
    for (const f of falhas) console.log(`  - ${f}`);
  }
  await c.end();
  process.exit(falhas.length ? 1 : 0);
})().catch((e) => {
  console.log('ERRO:', e.message);
  process.exit(1);
});
