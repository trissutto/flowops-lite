import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { publicPropertiesPrisma?: PrismaClient };

export const prisma = globalForPrisma.publicPropertiesPrisma || new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.publicPropertiesPrisma = prisma;
}
