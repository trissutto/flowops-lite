/**
 * Sincroniza as lojas do FlowOps com a tabela `lojas` do ERP gigasistemas21.
 * - Pega todas as lojas reais
 * - Upsert no SQLite do FlowOps
 * - Desativa as que foram removidas do ERP
 *
 * Uso: npm run sync-stores
 */

import * as mysql from 'mysql2/promise';
import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const prisma = new PrismaClient();

async function main() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Sincronizando lojas do ERP gigasistemas21');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const conn = await mysql.createConnection({
    host: process.env.ERP_HOST,
    port: Number(process.env.ERP_PORT ?? 3306),
    user: process.env.ERP_USER,
    password: process.env.ERP_PASSWORD,
    database: process.env.ERP_DATABASE,
    connectTimeout: 10000,
  });

  const [rows] = await conn.query<any[]>(
    `SELECT l.CODIGO as code,
            l.NOME   as name,
            l.ABREVIATURA as abbr,
            l.GRUPO  as groupId,
            g.GRUPO  as groupName
       FROM lojas l
       LEFT JOIN grupos_lojas g ON g.CODIGO = l.GRUPO
       ORDER BY l.CODIGO`
  );

  console.log(`📥 ${rows.length} loja(s) encontrada(s) no ERP:\n`);

  const codigosERP = new Set<string>();
  let created = 0, updated = 0;

  for (const r of rows) {
    const code = String(r.code).trim();
    const name = String(r.name ?? '').trim() || `Loja ${code}`;
    codigosERP.add(code);

    // Loja "SITE" tem prioridade maior (atende e-commerce)
    const isSite = /site/i.test(name);

    const existing = await prisma.store.findUnique({ where: { code } });
    if (existing) {
      await prisma.store.update({
        where: { code },
        data: {
          name,
          active: true,
          // mantém whatsapp, cep, city, state se já preenchidos
        },
      });
      updated++;
    } else {
      await prisma.store.create({
        data: {
          code,
          name,
          active: true,
          priorityScore: isSite ? 90 : 50,
        },
      });
      created++;
    }

    console.log(`  ${code}  ${name.padEnd(20)}  (grupo ${r.groupId}: ${r.groupName ?? '—'})`);
  }

  // Desativa lojas que não estão mais no ERP (exceto as fake LJxx antigas, já desativadas)
  const orphans = await prisma.store.updateMany({
    where: {
      code: { notIn: Array.from(codigosERP) },
      active: true,
      NOT: { code: { startsWith: 'LJ' } },
    },
    data: { active: false },
  });

  console.log(`\n✓ ${created} criada(s), ${updated} atualizada(s), ${orphans.count} desativada(s) (removida do ERP).`);

  // Também desativa as fake LJxx que possam ter sobrado
  await prisma.store.updateMany({
    where: { code: { startsWith: 'LJ' } },
    data: { active: false },
  });

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Sincronização concluída.');
  console.log('  Abra http://localhost:3000/lojas e aperte F5.');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  await conn.end();
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
