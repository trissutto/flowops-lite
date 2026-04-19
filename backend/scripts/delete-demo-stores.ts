/**
 * Remove DEFINITIVAMENTE as lojas demo (LJxx) criadas pelo seed inicial.
 * - Só apaga se a loja não tiver vínculos (pedidos, itens, separações, usuários).
 * - Se tiver vínculos, só desativa (pra preservar histórico).
 *
 * Uso: npm run delete-demo-stores
 */

import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Removendo lojas demo (LJxx)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const demos = await prisma.store.findMany({
    where: { code: { startsWith: 'LJ' } },
    orderBy: { code: 'asc' },
  });

  if (demos.length === 0) {
    console.log('✓ Nenhuma loja demo encontrada. Nada a fazer.\n');
    return;
  }

  console.log(`Encontradas ${demos.length} loja(s) demo:\n`);
  for (const d of demos) {
    console.log(`  ${d.code}  ${d.name}`);
  }
  console.log();

  let deleted = 0;
  let kept = 0;

  for (const d of demos) {
    // Verifica se tem vínculos
    const [orderItems, pickOrders, users] = await Promise.all([
      prisma.orderItem.count({ where: { assignedStoreId: d.id } }),
      prisma.pickOrder.count({ where: { storeId: d.id } }),
      prisma.user.count({ where: { storeId: d.id } }),
    ]);

    const links = orderItems + pickOrders + users;

    if (links === 0) {
      await prisma.store.delete({ where: { id: d.id } });
      console.log(`  🗑️  ${d.code} ${d.name.padEnd(20)} → DELETADA`);
      deleted++;
    } else {
      await prisma.store.update({
        where: { id: d.id },
        data: { active: false },
      });
      console.log(`  ⚠️  ${d.code} ${d.name.padEnd(20)} → mantida (${links} vínculo[s]), apenas desativada`);
      kept++;
    }
  }

  console.log(`\n✓ ${deleted} loja(s) deletada(s), ${kept} mantida(s) por terem histórico.\n`);

  console.log('Lojas ativas agora (ordem por código):');
  const ativas = await prisma.store.findMany({
    where: { active: true },
    orderBy: { code: 'asc' },
  });
  for (const s of ativas) {
    console.log(`  ${s.code}  ${s.name.padEnd(20)}  prio=${s.priorityScore}  wpp=${s.whatsapp ?? '—'}`);
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Pronto. Recarrega a tela /lojas (F5).');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
