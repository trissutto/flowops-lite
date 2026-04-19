import { Injectable } from '@nestjs/common';

/**
 * Cache em memória simples — substitui Redis na versão Lite.
 * Para volumes de até ~1000 pedidos/dia funciona perfeitamente.
 * Se reiniciar o processo o cache é perdido (aceitável para estoque com TTL curto).
 */
@Injectable()
export class MemoryCacheService {
  private store = new Map<string, { value: any; expiresAt: number }>();

  get(key: string): string | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return String(entry.value);
  }

  set(key: string, value: any, ttlSeconds: number): void {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  del(key: string): void {
    this.store.delete(key);
  }

  /**
   * Compatibilidade com API do ioredis usada em outros serviços.
   */
  get client() {
    const self = this;
    return {
      async get(key: string) {
        return self.get(key);
      },
      async set(key: string, value: any, _mode?: string, ttl?: number) {
        self.set(key, value, ttl ?? 60);
        return 'OK';
      },
      async del(key: string) {
        self.del(key);
        return 1;
      },
      pipeline() {
        const ops: Array<() => void> = [];
        return {
          set(key: string, value: any, _mode?: string, ttl?: number) {
            ops.push(() => self.set(key, value, ttl ?? 60));
            return this;
          },
          async exec() {
            for (const op of ops) op();
            return [];
          },
        };
      },
    };
  }
}
