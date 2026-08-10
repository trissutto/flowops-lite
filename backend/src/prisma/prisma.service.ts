import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * TAMANHO DO POOL DE CONEXÕES — explícito, e não o que o Prisma chutar.
 *
 * ── O PROBLEMA ──
 *
 * A `DATABASE_URL` do Railway nunca teve `connection_limit`, então valia o
 * padrão do Prisma: `núcleos × 2 + 1`. Num container pequeno isso dá algo
 * entre 9 e 17 conexões — e esse punhado atende TUDO ao mesmo tempo: o PDV
 * das lojas, o CRM, a live e o site público.
 *
 * O número em si não é o problema; o problema é ele ser invisível e variar com
 * o hardware que o Railway alocar. Sob um pico de campanha no site, o pool
 * esgota e o Prisma enfileira até estourar `pool_timeout`, devolvendo P2024.
 * Aí o erro não aparece só no site: aparece na tela da vendedora que está com
 * a cliente na frente tentando fechar a venda, porque é o mesmo pool.
 *
 * ── O QUE ISTO FAZ ──
 *
 * Se a `DATABASE_URL` já traz `connection_limit`, respeita — quem escreveu na
 * env sabia o que queria. Se não traz, aplica um valor conhecido e LOGA qual
 * é, pra parar de ser adivinhação.
 *
 * ⚠️ TETO REAL É DO POSTGRES, não daqui. Aumentar `DB_POOL_SIZE` além do
 * `max_connections` do plano contratado troca "fila no app" por "conexão
 * recusada pelo banco", que é pior. Antes de subir este número, conferir o
 * limite do plano no painel do Railway.
 */
function urlComPool(): string | null {
  const bruta = process.env.DATABASE_URL;
  if (!bruta) return null;
  // Já configurado à mão na env: não mexe.
  if (/[?&]connection_limit=/.test(bruta)) return null;

  const tamanho = Number(process.env.DB_POOL_SIZE ?? 20);
  const timeout = Number(process.env.DB_POOL_TIMEOUT ?? 20);
  if (!Number.isFinite(tamanho) || tamanho <= 0) return null;

  try {
    const u = new URL(bruta);
    u.searchParams.set('connection_limit', String(tamanho));
    u.searchParams.set('pool_timeout', String(timeout));
    return u.toString();
  } catch {
    // URL fora do formato esperado (socket unix, por exemplo): melhor seguir
    // com o padrão do Prisma do que arriscar montar uma string inválida e o
    // backend não subir.
    return null;
  }
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    const url = urlComPool();
    super(url ? { datasources: { db: { url } } } : {});
  }

  async onModuleInit() {
    const limite = process.env.DATABASE_URL?.match(/[?&]connection_limit=(\d+)/)?.[1];
    this.logger.log(
      `Pool do Postgres: ${limite ?? process.env.DB_POOL_SIZE ?? 20} conexões ` +
        `(${limite ? 'definido na DATABASE_URL' : 'padrão do app — DB_POOL_SIZE ajusta'})`,
    );
    this.$connect()
      .then(() => this.logger.log('Prisma conectado ao Postgres'))
      .catch((e) => this.logger.warn('Prisma nao conectou: ' + (e as Error).message));
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
