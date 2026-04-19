// Seed de PRODUÇÃO em JS puro (sem TypeScript/ts-node).
// Cria APENAS o usuário admin. Idempotente via upsert.

const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');

console.log('==> [seed-prod] iniciando...');

const prisma = new PrismaClient();

async function main() {
  const passwordHash = await bcrypt.hash('admin123', 12);

  const result = await prisma.user.upsert({
    where: { email: 'admin@flowops.local' },
    update: {}, // se já existe, não mexe
    create: {
      email: 'admin@flowops.local',
      passwordHash,
      name: 'Administrador',
      role: 'admin',
    },
  });

  console.log(`==> [seed-prod] Admin OK. id=${result.id}`);
}

main()
  .catch((e) => {
    console.error('==> [seed-prod] ERRO:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
