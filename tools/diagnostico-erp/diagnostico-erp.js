/**
 * diagnostico-erp.js — Script standalone para inspecionar tabelas do Gigasistemas.
 *
 * Não precisa do backend NestJS rodando. Conecta direto no MySQL usando as
 * credenciais do backend/.env e cospe o schema + amostra de linhas.
 *
 * Uso:
 *   1. Garanta que o backend tem .env com ERP_HOST/PORT/USER/PASSWORD/DATABASE
 *   2. node diagnostico-erp.js                  → tabela PRODVENDIDOS (default)
 *   3. node diagnostico-erp.js NOME_DA_TABELA   → qualquer outra tabela
 *
 * Gera resultado.json no mesmo diretório.
 */

const path = require('path');
const fs = require('fs');

// Resolve caminho do backend/.env e do node_modules/mysql2
const BACKEND_DIR = path.resolve(__dirname, '..', '..', 'backend');
const ENV_PATH = path.join(BACKEND_DIR, '.env');
const MYSQL_PATH = path.join(BACKEND_DIR, 'node_modules', 'mysql2', 'promise.js');

// Parser simples de .env (sem depender de dotenv)
function parseEnv(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`\n[ERRO] Arquivo .env não encontrado em:\n   ${filePath}\n`);
    console.error('Esperado estar em flowops-lite/backend/.env com as chaves ERP_*');
    process.exit(1);
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

async function main() {
  const env = parseEnv(ENV_PATH);

  const required = ['ERP_HOST', 'ERP_USER', 'ERP_PASSWORD', 'ERP_DATABASE'];
  const missing = required.filter((k) => !env[k]);
  if (missing.length) {
    console.error(`\n[ERRO] Variáveis faltando no backend/.env: ${missing.join(', ')}`);
    process.exit(1);
  }

  if (!fs.existsSync(MYSQL_PATH)) {
    console.error(`\n[ERRO] mysql2 não está instalado no backend.`);
    console.error(`Rode: cd backend && npm install`);
    process.exit(1);
  }
  const mysql = require(MYSQL_PATH);

  // Primeiro arg: nome da tabela OU comando especial ("--list" / "--find <padrao>")
  const arg1 = (process.argv[2] || '').trim();
  const arg2 = (process.argv[3] || '').trim();

  // Modo especial: listar tabelas
  const modoListar = arg1 === '--list' || arg1 === '-l' || arg1.toUpperCase() === 'LIST';
  // Modo especial: procurar tabelas por padrão
  const modoBuscar = arg1 === '--find' || arg1 === '-f' || arg1.toUpperCase() === 'FIND';
  const padraoBusca = modoBuscar ? arg2 : '';

  const tabela = (!arg1 || modoListar || modoBuscar) ? 'PRODVENDIDOS' : arg1;

  console.log(`\n==============================================`);
  console.log(`  DIAGNÓSTICO ERP — Gigasistemas`);
  console.log(`==============================================`);
  console.log(`  Host     : ${env.ERP_HOST}:${env.ERP_PORT || 3306}`);
  console.log(`  Database : ${env.ERP_DATABASE}`);
  console.log(`  User     : ${env.ERP_USER}`);
  if (modoListar) {
    console.log(`  Modo     : LISTAR TODAS AS TABELAS`);
  } else if (modoBuscar) {
    console.log(`  Modo     : BUSCAR TABELAS com "${padraoBusca}"`);
  } else {
    console.log(`  Tabela   : ${tabela}`);
  }
  console.log(`==============================================\n`);

  let pool;
  try {
    pool = mysql.createPool({
      host: env.ERP_HOST,
      port: Number(env.ERP_PORT || 3306),
      user: env.ERP_USER,
      password: env.ERP_PASSWORD,
      database: env.ERP_DATABASE,
      waitForConnections: true,
      connectionLimit: 2,
      connectTimeout: 10000,
    });

    console.log('[1/3] Testando conexão...');
    const conn = await pool.getConnection();
    conn.release();
    console.log('      OK — MySQL respondendo\n');

    // ============ MODO LISTAR TABELAS ============
    if (modoListar || modoBuscar) {
      const termos = modoBuscar
        ? padraoBusca.split(/[,\s]+/).filter(Boolean)
        : [];

      let sql = 'SHOW TABLES';
      const params = [];
      if (termos.length === 1) {
        sql = `SHOW TABLES LIKE ?`;
        params.push(`%${termos[0]}%`);
      }

      console.log(`[2/2] Listando tabelas...`);
      const [rows] = await pool.query(sql, params);
      // SHOW TABLES retorna um objeto tipo { Tables_in_<db>: 'NOME' }
      let tabelas = rows.map((r) => Object.values(r)[0]);

      // Se tem múltiplos termos, filtra localmente (OR entre eles)
      if (termos.length > 1) {
        const up = termos.map((t) => t.toUpperCase());
        tabelas = tabelas.filter((n) => up.some((t) => String(n).toUpperCase().includes(t)));
      }

      console.log(`      OK — ${tabelas.length} tabela(s)\n`);

      console.log(`TABELAS:`);
      console.log(`------------------------------------------`);
      for (const t of tabelas) console.log(`  ${t}`);
      console.log('');

      const outPath = path.join(__dirname, 'resultado.json');
      fs.writeFileSync(outPath, JSON.stringify({ modo: modoListar ? 'list' : 'find', padrao: padraoBusca, total: tabelas.length, tabelas }, null, 2), 'utf8');

      console.log(`==============================================`);
      console.log(`  JSON salvo em:`);
      console.log(`  ${outPath}`);
      console.log(``);
      console.log(`  Pra inspecionar uma tabela específica:`);
      console.log(`    diagnostico-erp.bat NOME_DA_TABELA`);
      console.log(`==============================================\n`);

      await pool.end();
      process.exit(0);
    }

    // ============ MODO INSPECIONAR TABELA ============
    console.log(`[2/3] Lendo colunas de ${tabela}...`);
    const [cols] = await pool.query(`SHOW COLUMNS FROM ${tabela}`);
    const columns = cols.map((c) => ({ field: c.Field, type: c.Type, null: c.Null, key: c.Key }));
    console.log(`      OK — ${columns.length} colunas\n`);

    console.log(`[3/3] Buscando 3 linhas de amostra...`);
    const [sample] = await pool.query(`SELECT * FROM ${tabela} LIMIT 3`);
    console.log(`      OK — ${sample.length} linha(s)\n`);

    const result = { tabela, columns, sample };

    // Salva arquivo JSON
    const outPath = path.join(__dirname, 'resultado.json');
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');

    // Imprime resumo legível
    console.log(`COLUNAS (${columns.length}):`);
    console.log(`------------------------------------------`);
    for (const c of columns) {
      console.log(`  ${c.field.padEnd(30)} ${c.type}${c.key ? '  [' + c.key + ']' : ''}`);
    }
    console.log('');

    console.log(`AMOSTRA (${sample.length} linha(s)):`);
    console.log(`------------------------------------------`);
    console.log(JSON.stringify(sample, null, 2));
    console.log('');

    console.log(`==============================================`);
    console.log(`  JSON completo salvo em:`);
    console.log(`  ${outPath}`);
    console.log(`==============================================\n`);

    await pool.end();
    process.exit(0);
  } catch (err) {
    console.error(`\n[FALHA] ${err.code || ''} ${err.message}`);
    if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT') {
      console.error('\nDica: verifique se ERP_HOST está acessível desta máquina.');
      console.error('      Gigasistemas precisa estar ligado e na mesma rede.');
    }
    if (err.code === 'ER_NO_SUCH_TABLE') {
      console.error(`\nDica: tabela '${tabela}' não existe.`);
      console.error(`      Rode:  diagnostico-erp.bat --list           (lista TODAS as tabelas)`);
      console.error(`             diagnostico-erp.bat --find VEND      (procura por palavra-chave)`);
    }
    if (err.code === 'ER_ACCESS_DENIED_ERROR') {
      console.error('\nDica: usuário/senha do ERP_USER/ERP_PASSWORD não batem.');
    }
    if (pool) await pool.end().catch(() => {});
    process.exit(1);
  }
}

main();
