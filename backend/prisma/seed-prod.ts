import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

// Seed de PRODUÇÃO: cria APENAS o usuário admin.
// Nada de lojas fictícias — as lojas reais vêm do sync com o ERP.

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seed prod: garantindo admin...');

  const passwordHash = await bcrypt.hash('admin123', 12);

  const result = await prisma.user.upsert({
    where: { email: 'admin@flowops.local' },
    update: {}, // se já existe, não faz nada (não sobrescreve senha)
    create: {
      email: 'admin@flowops.local',
      passwordHash,
      name: 'Administrador',
      role: 'admin',
    },
  });

  console.log(`✅ Admin OK (id=${result.id}). Login: admin@flowops.local / admin123`);
}

main()
  .catch((e) => {
    console.error('❌ Seed prod falhou:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
