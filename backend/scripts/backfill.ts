/**
 * Baixa os últimos N pedidos do WooCommerce e importa no SQLite local.
 *
 * Uso:
 *   npm run backfill          (100 pedidos - padrão)
 *   npm run backfill -- 50    (50 pedidos)
 */

import axios from 'axios';
import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';
import * as path from 'path';

// carrega .env do backend
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const prisma = new PrismaClient();

const WC_URL = process.env.WC_URL;
const WC_KEY = process.env.WC_CONSUMER_KEY;
const WC_SECRET = process.env.WC_CONSUMER_SECRET;

function mapStatus(wc: string): string {
  const s = (wc ?? '').toLowerCase().replace(/^wc-/, '');
  if (['completed', 'delivered', 'entregue', 'finished'].includes(s)) return 'delivered';
  if (['cancelled', 'canceled', 'refunded', 'failed', 'expired', 'pix-expired', 'boleto-expired', 'trash'].includes(s)) return 'cancelled';
  if (['shipped', 'sent', 'enviado', 'dispatched'].includes(s)) return 'shipped';
  if (['ready', 'ready-to-ship', 'pronto'].includes(s)) return 'ready';
  return 'pending';
}

async function upsertOrder(wc: any) {
  const wcOrderId = Number(wc.id);
  const shipping = wc.shipping ?? {};
  const status = mapStatus(wc.status);

  const payload = {
    wcOrderNumber: String(wc.number ?? wc.id),
    status,
    customerName: `${shipping.first_name ?? ''} ${shipping.last_name ?? ''}`.trim() || 'Sem nome',
    customerEmail: wc.billing?.email ?? null,
    customerPhone: wc.billing?.phone ?? null,
    shippingCep: (shipping.postcode ?? '').replace(/\D/g, '') || null,
    shippingAddress: JSON.stringify(shipping),
    totalAmount: wc.total ? Number(wc.total) : null,
  };

  const items = (wc.line_items ?? []).map((li: any) => ({
    sku: String(li.sku || `wc-${li.product_id}`),
    productName: li.name,
    quantity: Number(li.quantity),
    unitPrice: li.price ? Number(li.price) : null,
  }));

  const existing = await prisma.order.findUnique({ where: { wcOrderId } });

  if (existing) {
    await prisma.order.update({ where: { id: existing.id }, data: payload });
    return 'updated';
  }

  await prisma.order.create({
    data: {
      wcOrderId,
      ...payload,
      items: { create: items },
    },
  });
  return 'created';
}

async function main() {
  const qtd = Number(process.argv[2] ?? 100);

  if (!WC_URL || !WC_KEY || !WC_SECRET) {
    console.error('❌ Faltam variáveis WC_URL / WC_CONSUMER_KEY / WC_CONSUMER_SECRET no .env');
    process.exit(1);
  }

  console.log(`\n📥 Baixando últimos ${qtd} pedidos de ${WC_URL}...`);

  let allOrders: any[] = [];
  let page = 1;
  const perPage = Math.min(qtd, 100);

  while (allOrders.length < qtd) {
    const need = qtd - allOrders.length;
    const thisPage = Math.min(need, 100);

    try {
      const res = await axios.get(`${WC_URL}/wp-json/wc/v3/orders`, {
        auth: { username: WC_KEY, password: WC_SECRET },
        params: {
          per_page: thisPage,
          page,
          orderby: 'date',
          order: 'desc',
        },
        timeout: 30000,
      });

      if (!res.data || res.data.length === 0) break;

      allOrders.push(...res.data);
      console.log(`  Página ${page}: ${res.data.length} pedidos (total ${allOrders.length})`);
      page++;

      if (res.data.length < thisPage) break;
    } catch (e: any) {
      console.error(`❌ Erro ao buscar página ${page}: ${e.message}`);
      if (e.response?.data) console.error(JSON.stringify(e.response.data, null, 2));
      break;
    }
  }

  console.log(`\n✅ ${allOrders.length} pedidos baixados. Importando no SQLite...\n`);

  let created = 0, updated = 0, errors = 0;
  for (const wc of allOrders) {
    try {
      const r = await upsertOrder(wc);
      if (r === 'created') created++;
      else updated++;
      process.stdout.write('.');
    } catch (e: any) {
      errors++;
      console.error(`\n  ✗ Erro no pedido #${wc.id}: ${e.message}`);
    }
  }

  console.log(`\n\n───────────────────────────────`);
  console.log(`  Resumo`);
  console.log(`───────────────────────────────`);
  console.log(`  ✓ Criados:    ${created}`);
  console.log(`  ↻ Atualizados: ${updated}`);
  console.log(`  ✗ Erros:      ${errors}`);
  console.log(`───────────────────────────────\n`);
  console.log(`Abre http://localhost:3000/pedidos e aperta F5 pra ver.`);
}

main()
  .catch((e) => {
    console.error('Erro fatal:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
