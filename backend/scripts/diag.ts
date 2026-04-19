/**
 * Script de diagnóstico — mostra o estado do banco local.
 * Uso: npm run diag
 */
import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';
import * as path from 'path';
import axios from 'axios';

dotenv.config({ path: path.join(__dirname, '..', '.env') });
const prisma = new PrismaClient();

async function main() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  FlowOps Lite — Diagnóstico');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // 1. Banco
  const orderCount = await prisma.order.count();
  const storeCount = await prisma.store.count();
  const userCount = await prisma.user.count();
  const itemCount = await prisma.orderItem.count();
  console.log('📦 BANCO SQLite (backend/prisma/dev.db)');
  console.log(`   Users:       ${userCount}`);
  console.log(`   Stores:      ${storeCount}`);
  console.log(`   Orders:      ${orderCount}`);
  console.log(`   Order items: ${itemCount}`);

  if (orderCount > 0) {
    console.log('\n   Status dos pedidos:');
    const byStatus = await prisma.order.groupBy({
      by: ['status'],
      _count: true,
    });
    for (const s of byStatus) {
      console.log(`     ${s.status}: ${s._count}`);
    }

    console.log('\n   Últimos 5 pedidos:');
    const last = await prisma.order.findMany({
      take: 5,
      orderBy: { createdAt: 'desc' },
      select: { wcOrderId: true, wcOrderNumber: true, status: true, customerName: true, totalAmount: true, createdAt: true },
    });
    for (const o of last) {
      console.log(`     #${o.wcOrderNumber}  ${o.status}  ${o.customerName ?? '—'}  R$ ${o.totalAmount ?? '—'}  ${o.createdAt.toISOString().slice(0, 16)}`);
    }
  }

  // 2. WC connection
  console.log('\n🔌 CONEXÃO COM WOOCOMMERCE');
  const wcUrl = process.env.WC_URL;
  const wcKey = process.env.WC_CONSUMER_KEY;
  const wcSecret = process.env.WC_CONSUMER_SECRET;
  console.log(`   URL:     ${wcUrl}`);
  console.log(`   Key:     ${wcKey?.slice(0, 10)}...`);
  console.log(`   Secret:  ${wcSecret?.slice(0, 10)}...`);

  if (wcUrl && wcKey && wcSecret) {
    try {
      const res = await axios.get(`${wcUrl}/wp-json/wc/v3/orders`, {
        auth: { username: wcKey, password: wcSecret },
        params: { per_page: 3, orderby: 'date', order: 'desc' },
        timeout: 10_000,
      });
      console.log(`   ✅ OK — recebidos ${res.data.length} pedidos de teste`);
      if (res.data.length > 0) {
        const first = res.data[0];
        console.log(`      Exemplo: #${first.id} (status WC: "${first.status}")`);
        console.log(`               Itens: ${first.line_items?.length ?? 0}`);
        console.log(`               Total: ${first.total}`);
        console.log(`               Cliente: ${first.shipping?.first_name ?? ''} ${first.shipping?.last_name ?? ''}`);
      }
    } catch (e: any) {
      console.log(`   ❌ ERRO: ${e.message}`);
      if (e.response?.status) console.log(`      HTTP ${e.response.status}`);
      if (e.response?.data) console.log(`      Body: ${JSON.stringify(e.response.data).slice(0, 300)}`);
    }
  } else {
    console.log('   ⚠  Credenciais WC não carregadas do .env');
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Diagnóstico concluído.');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

main()
  .catch((e) => { console.error('ERRO FATAL:', e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
