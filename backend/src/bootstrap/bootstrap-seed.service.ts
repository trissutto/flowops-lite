import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Garante que o usuário admin existe na primeira vez que o app sobe.
 * Roda DENTRO do próprio Nest, depois de conectar no Postgres — então
 * funciona em qualquer ambiente (Railway, local, etc) sem precisar de
 * startCommand extra.
 */
@Injectable()
export class BootstrapSeedService implements OnApplicationBootstrap {
  private readonly logger = new Logger(BootstrapSeedService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onApplicationBootstrap() {
    try {
      const email = 'admin@flowops.local';
      const existing = await this.prisma.user.findUnique({ where: { email } });

      if (existing) {
        this.logger.log(`Admin já existe (id=${existing.id}), pulando seed.`);
        return;
      }

      const passwordHash = await bcrypt.hash('admin123', 12);
      const created = await this.prisma.user.create({
        data: {
          email,
          passwordHash,
          name: 'Administrador',
          role: 'admin',
        },
      });

      this.logger.log(`Admin criado (id=${created.id}). Login: ${email} / admin123`);
    } catch (err) {
      // Nunca deixa o seed quebrar o boot do app.
      this.logger.error('Falha no bootstrap seed (seguindo sem bloquear):', err);
    }
  }
}
