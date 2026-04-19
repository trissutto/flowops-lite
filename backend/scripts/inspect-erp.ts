/**
 * Conecta no MySQL gigasistemas21, lista todas as tabelas
 * e mostra a estrutura + amostra das que parecem ser de LOJAS / FILIAIS / EMPRESAS / ESTOQUE.
 *
 * Uso: npm run inspect-erp
 */

import * as mysql from 'mysql2/promise';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

dotenv.config({ path: path.join(__dirname, '..', '.env') });

// Espelha tudo no console + grava em arquivo
const OUT_FILE = path.join(__dirname, '..', '..', 'erp-inspect.txt');
fs.writeFileSync(OUT_FILE, ''); // limpa
const origLog = console.log;
console.log = (...args: any[]) => {
  origLog(...args);
  fs.appendFileSync(OUT_FILE, args.map(String).join(' ') + '\n');
};

const HOST = process.env.ERP_HOST!;
const PORT = Number(process.env.ERP_PORT ?? 3306);
const USER = process.env.ERP_USER!;
const PASSWORD = process.env.ERP_PASSWORD!;
const DATABASE = process.env.ERP_DATABASE!;

// Palavras-chave que indicam tabelas relevantes
const KEYWORDS = ['loja', 'filial', 'unidade', 'empresa', 'store', 'branch', 'estoque', 'stock', 'produto', 'product', 'sku'];

async function main() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Inspecionando ERP gigasistemas21');
  console.log(`  ${USER}@${HOST}:${PORT} / ${DATABASE}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  let conn: mysql.Connection;
  try {
    conn = await mysql.createConnection({
      host: HOST, port: PORT, user: USER, password: PASSWORD, database: DATABASE,
      connectTimeout: 10000,
    });
    console.log('✅ Conectado.\n');
  } catch (e: any) {
    console.error(`❌ Não consegui conectar: ${e.message}`);
    console.error(`   Verifique:`);
    console.error(`   - Credenciais corretas no .env`);
    console.error(`   - Firewall do gigasistemas21 libera o IP da sua máquina`);
    process.exit(1);
  }

  // 1. Lista TODAS as tabelas
  const [tables] = await conn.query<any[]>('SHOW TABLES');
  const tableNames = tables.map((row) => Object.values(row)[0] as string);
  console.log(`📋 Total de tabelas no banco: ${tableNames.length}\n`);

  // 2. Filtra só as que importam (nome com keyword)
  const relevant = tableNames.filter((name) =>
    KEYWORDS.some((kw) => name.toLowerCase().includes(kw))
  );

  if (relevant.length === 0) {
    console.log('Nenhuma tabela com nome contendo: loja/filial/empresa/estoque/produto/sku');
    console.log('\nListando TODAS as tabelas pra você decidir manualmente:\n');
    for (const t of tableNames) console.log(`   ${t}`);
    await conn.end();
    return;
  }

  console.log(`📌 ${relevant.length} tabela(s) potencialmente relevante(s):\n`);

  // 3. Pra cada uma, mostra estrutura + amostra
  for (const tableName of relevant) {
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`📦 TABELA: ${tableName}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

    try {
      // estrutura
      const [cols] = await conn.query<any[]>(`SHOW COLUMNS FROM \`${tableName}\``);
      console.log('\n  Colunas:');
      for (const c of cols) {
        console.log(`    ${(c.Field as string).padEnd(30)} ${c.Type}${c.Null === 'NO' ? ' NOT NULL' : ''}${c.Key === 'PRI' ? ' [PK]' : ''}`);
      }

      // total
      const [cnt] = await conn.query<any[]>(`SELECT COUNT(*) as n FROM \`${tableName}\``);
      console.log(`\n  Total de registros: ${cnt[0].n}`);

      // amostra (5 linhas)
      const [rows] = await conn.query<any[]>(`SELECT * FROM \`${tableName}\` LIMIT 5`);
      if (rows.length > 0) {
        console.log('\n  Primeiras linhas:');
        for (const row of rows) {
          const summary = Object.entries(row)
            .slice(0, 8)
            .map(([k, v]) => `${k}=${String(v).slice(0, 30)}`)
            .join(' | ');
          console.log(`    ${summary}`);
        }
      }
    } catch (e: any) {
      console.log(`  ⚠ Erro inspecionando: ${e.message}`);
    }
  }

  // Lista TODAS as tabelas no final (pra eu ver as não-detectadas)
  console.log('\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  TODAS AS TABELAS DO BANCO (pra debug):');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  for (const t of tableNames) console.log(`   ${t}`);

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Inspeção concluída.');
  console.log(`  Output salvo em: ${OUT_FILE}`);
  console.log('  Me mande esse arquivo (anexar no chat) pra eu adaptar a importação.');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  await conn.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
