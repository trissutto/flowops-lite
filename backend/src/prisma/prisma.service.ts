import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit() {
    this.$connect()
      .then(() => this.logger.log('Prisma conectado ao Postgres'))
      .catch((e) => this.logger.warn('Prisma nao conectou: ' + (e as Error).message));
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
