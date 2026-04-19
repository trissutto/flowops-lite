import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

// Enum em string (SQLite não tem enum nativo)
const Role = { admin: 'admin', operator: 'operator', store: 'store' } as const;

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

  // Admin user
  const passwordHash = await bcrypt.hash('admin123', 12);
  await prisma.user.upsert({
    where: { email: 'admin@flowops.local' },
    update: {},
    create: {
      email: 'admin@flowops.local',
      passwordHash,
      name: 'Administrador',
      role: Role.admin,
    },
  });

  // Sample stores (ajuste os códigos para casar com o ERP)
  const stores = [
    { code: 'LJ01', name: 'Loja Matriz',     cep: '01001-000', city: 'São Paulo',       state: 'SP', priorityScore: 80 },
    { code: 'LJ02', name: 'Loja Campinas',   cep: '13010-001', city: 'Campinas',        state: 'SP', priorityScore: 60 },
    { code: 'LJ03', name: 'Loja Rio',        cep: '20040-002', city: 'Rio de Janeiro',  state: 'RJ', priorityScore: 70 },
    { code: 'LJ04', name: 'Loja BH',         cep: '30110-001', city: 'Belo Horizonte',  state: 'MG', priorityScore: 55 },
    { code: 'LJ05', name: 'Loja Curitiba',   cep: '80010-000', city: 'Curitiba',        state: 'PR', priorityScore: 50 },
    { code: 'LJ06', name: 'Loja Porto Alegre', cep: '90010-100', city: 'Porto Alegre',  state: 'RS', priorityScore: 50 },
  ];

  for (const s of stores) {
    await prisma.store.upsert({
      where: { code: s.code },
      update: {},
      create: s,
    });
  }

  console.log('✅ Seed concluído.');
  console.log('   Login: admin@flowops.local / admin123');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
