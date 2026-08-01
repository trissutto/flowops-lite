/**
 * Onde ficam as operadoras do Wincred, e em que FORMATO a senha é guardada?
 *
 * Antes de trocar senha em massa é preciso saber se a coluna guarda texto puro
 * ou algo codificado. Gravar '794652' cru numa coluna que espera hash deixa
 * TODO MUNDO sem conseguir entrar — inclusive o dono — e o Wincred é software
 * de terceiro: não dá pra ler o código dele pra descobrir depois.
 *
 * Este script NÃO altera nada e NÃO imprime senha nenhuma por extenso: mostra
 * só o formato (tamanho, tipo de caractere, quantos valores distintos), que é
 * o suficiente pra decidir.
 *
 * Uso (da RAIZ do repo):
 *   railway run --service Postgres -- node backend/scripts/giga-etl/diag-operadoras.js
 */

const path = require('path');
const mysql = require('mysql2/promise');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(path.resolve(__dirname, '..', '..'), '.env'), override: false });

const nf = (n) => Number(n || 0).toLocaleString('pt-BR');

/** Descreve um valor sem revelá-lo. */
function formatoDe(v) {
  if (v == null) return 'NULL';
  const s = String(v);
  if (!s.length) return 'vazio';
  let classe;
  if (/^[0-9]+$/.test(s)) classe = 'só dígitos';
  else if (/^[a-fA-F0-9]+$/.test(s)) classe = 'hexadecimal (cheiro de hash)';
  else if (/^[A-Za-z0-9+/=]+$/.test(s)) classe = 'alfanumérico (pode ser base64)';
  else if (/^[\x20-\x7E]+$/.test(s)) classe = 'texto imprimível';
  else classe = 'BINÁRIO / não imprimível';
  return `${s.length} chars · ${classe}`;
}

(async () => {
  const my = await mysql.createConnection({
    host: process.env.ERP_HOST,
    port: Number(process.env.ERP_PORT || 3306),
    user: process.env.ERP_USER,
    password: process.env.ERP_PASSWORD,
    database: process.env.ERP_DATABASE,
  });

  // 1. Que tabelas podem guardar usuário do sistema?
  const [tabelas] = await my.query(
    `SELECT TABLE_NAME, TABLE_ROWS FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND (TABLE_NAME LIKE '%operador%' OR TABLE_NAME LIKE '%usuario%'
          OR TABLE_NAME LIKE '%user%'     OR TABLE_NAME LIKE '%funcionario%'
          OR TABLE_NAME LIKE '%senha%'    OR TABLE_NAME LIKE '%acesso%'
          OR TABLE_NAME LIKE '%login%')
      ORDER BY TABLE_NAME`,
  );
  console.log('--- TABELAS CANDIDATAS ---');
  if (!tabelas.length) console.log('  (nenhuma pelo nome — procurando pela COLUNA)');
  for (const t of tabelas) console.log(`  ${t.TABLE_NAME} (~${nf(t.TABLE_ROWS)} linhas)`);

  // 2. Qualquer tabela com coluna de senha, independente do nome.
  const [colunas] = await my.query(
    `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND (COLUMN_NAME LIKE '%senha%' OR COLUMN_NAME LIKE '%password%'
          OR COLUMN_NAME LIKE '%pwd%'   OR COLUMN_NAME LIKE '%pass%')
      ORDER BY TABLE_NAME, COLUMN_NAME`,
  );
  console.log('');
  console.log('--- COLUNAS DE SENHA NO BANCO INTEIRO ---');
  if (!colunas.length) console.log('  (nenhuma)');
  for (const c of colunas) console.log(`  ${c.TABLE_NAME}.${c.COLUMN_NAME}  ${c.COLUMN_TYPE}`);

  // 3. Pra cada uma, o FORMATO dos valores — sem revelar as senhas.
  for (const c of colunas) {
    console.log('');
    console.log(`=== ${c.TABLE_NAME}.${c.COLUMN_NAME} ===`);
    try {
      const [cols] = await my.query(`SHOW COLUMNS FROM \`${c.TABLE_NAME}\``);
      console.log('  colunas da tabela: ' + cols.map((x) => x.Field).join(', '));

      const [[stat]] = await my.query(
        `SELECT COUNT(*) AS n,
                COUNT(DISTINCT \`${c.COLUMN_NAME}\`) AS distintas,
                MIN(CHAR_LENGTH(\`${c.COLUMN_NAME}\`)) AS menor,
                MAX(CHAR_LENGTH(\`${c.COLUMN_NAME}\`)) AS maior
           FROM \`${c.TABLE_NAME}\``,
      );
      console.log(`  linhas: ${nf(stat.n)} · senhas distintas: ${nf(stat.distintas)}`);
      console.log(`  tamanho: de ${stat.menor} a ${stat.maior} caracteres`);
      if (Number(stat.maior) >= 32 && Number(stat.menor) === Number(stat.maior)) {
        console.log('  *** todas do MESMO tamanho e longas — tem cara de HASH');
      }

      const [amostra] = await my.query(
        `SELECT \`${c.COLUMN_NAME}\` AS v FROM \`${c.TABLE_NAME}\` LIMIT 5`,
      );
      console.log('  formato dos valores (sem revelar):');
      for (const r of amostra) console.log(`    - ${formatoDe(r.v)}`);
    } catch (e) {
      console.log('  erro: ' + e.message);
    }
  }

  await my.end();
})().catch((e) => {
  console.log('ERRO:', e.message);
  process.exit(1);
});
