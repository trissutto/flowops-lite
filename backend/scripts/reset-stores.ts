/**
 * Substitui as lojas fake do seed pelas lojas REAIS do WinCred (gigasistemas21).
 *
 * - Desativa as lojas antigas (LJ01..LJ06) — preserva histórico de pedidos.
 * - Faz upsert das 18 lojas reais + loja "SITE" (13).
 *
 * Uso: npm run reset-stores
 */

import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

// Extraído do WinCred - códigos e nomes conforme cadastrados no ERP
const LOJAS = [
  { code: '01', name: 'Itanhaém',    city: 'Itanhaém',       state: 'SP' },
  { code: '02', name: 'Santos',      city: 'Santos',         state: 'SP' },
  { code: '03', name: 'Vinhedo',     city: 'Vinhedo',        state: 'SP' },
  { code: '04', name: 'Indaiatuba',  city: 'Indaiatuba',     state: 'SP' },
  { code: '05', name: 'Piracicaba',  city: 'Piracicaba',     state: 'SP' },
  { code: '06', name: 'Sorocaba',    city: 'Sorocaba',       state: 'SP' },
  { code: '07', name: 'Campinas',    city: 'Campinas',       state: 'SP' },
  { code: '08', name: 'São José',    city: 'São José dos Campos', state: 'SP' },
  { code: '09', name: 'Santos 2',    city: 'Santos',         state: 'SP' },
  { code: '10', name: 'Jundiaí',     city: 'Jundiaí',        state: 'SP' },
  { code: '11', name: 'Limeira',     city: 'Limeira',        state: 'SP' },
  { code: '13', name: 'SITE',        city: null,             state: null   }, // estoque do e-commerce
  { code: '14', name: 'Praia Grande', city: 'Praia Grande',  state: 'SP' },
  { code: '15', name: 'Moema',       city: 'São Paulo',      state: 'SP' },
  { code: '17', name: 'Suzano',      city: 'Suzano',         state: 'SP' },
  { code: '18', name: 'Mogi',        city: 'Mogi das Cruzes', state: 'SP' },
  { code: '19', name: 'Itu',         city: 'Itu',            state: 'SP' },
  { code: '20', name: 'PF',          city: null,             state: null },
];

async function main() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Reset de lojas — WinCred / gigasistemas21');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // 1. Desativa todas as lojas com códigos fake (LJxx) pra sumirem da UI
  const fakes = await prisma.store.updateMany({
    where: { code: { startsWith: 'LJ' } },
    data: { active: false, name: { set: undefined } as any },
  });
  console.log(`✓ ${fakes.count} loja(s) fake(s) desativada(s) (LJxx).`);

  // 2. Upsert das reais
  let created = 0, updated = 0;
  for (const l of LOJAS) {
    const existing = await prisma.store.findUnique({ where: { code: l.code } });
    if (existing) {
      await prisma.store.update({
        where: { code: l.code },
        data: {
          name: l.name,
          city: l.city ?? undefined,
          state: l.state ?? undefined,
          active: true,
          // mantém priorityScore e whatsapp se já tiverem sido preenchidos
        },
      });
      updated++;
    } else {
      await prisma.store.create({
        data: {
          code: l.code,
          name: l.name,
          city: l.city,
          state: l.state,
          active: true,
          priorityScore: l.code === '13' ? 90 : 50, // SITE tem prioridade maior (estoque central)
        },
      });
      created++;
    }
  }

  console.log(`✓ Lojas reais: ${created} criada(s), ${updated} atualizada(s).\n`);
  console.log('Total de lojas ativas agora:');
  const ativas = await prisma.store.findMany({ where: { active: true }, orderBy: { code: 'asc' } });
  for (const s of ativas) {
    console.log(`  ${s.code}  ${s.name.padEnd(20)}  ${s.city ?? '—'}/${s.state ?? '—'}`);
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Pronto. Abra http://localhost:3000/lojas e aperte F5.');
  console.log('  Depois cadastre o WhatsApp de cada loja pelo painel.');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
