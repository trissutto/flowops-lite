import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as mysql from 'mysql2/promise';

/**
 * Cliente direto pro MySQL do WordPress/WooCommerce.
 * SOMENTE LEITURA por enquanto — usado pra puxar dados de plugins que não
 * expõem REST (ex.: "Cart Abandonment Recovery for WooCommerce" da CartFlows).
 *
 * Pool de 5 conexões pra não pressionar o DB do WP.
 */
@Injectable()
export class WpDbService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WpDbService.name);
  private pool: mysql.Pool | null = null;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    const host = this.config.get<string>('WP_DB_HOST');
    if (!host) {
      this.logger.warn('⚠️  WP_DB_HOST não configurado — WpDbService inativo');
      return;
    }

    this.pool = mysql.createPool({
      host,
      port: Number(this.config.get<string>('WP_DB_PORT') ?? 3306),
      user: this.config.get<string>('WP_DB_USER'),
      password: this.config.get<string>('WP_DB_PASSWORD'),
      database: this.config.get<string>('WP_DB_DATABASE'),
      waitForConnections: true,
      connectionLimit: 5,
      queueLimit: 0,
      connectTimeout: 5000,
      timezone: 'Z',
    });

    try {
      const conn = await this.pool.getConnection();
      await conn.ping();
      conn.release();
      this.logger.log('✅ WP MySQL conectado (wordpress)');
    } catch (e) {
      this.logger.warn(`⚠️  WP MySQL não conectou: ${(e as Error).message}`);
    }
  }

  async onModuleDestroy() {
    if (this.pool) await this.pool.end();
  }

  /**
   * Expõe o pool pra outros services que precisam rodar queries no WP.
   * Retorna null se não inicializou (env incompleto ou DB fora do ar).
   */
  getPool(): mysql.Pool | null {
    return this.pool;
  }

  /**
   * Executa uma query simples. Se o pool não estiver pronto, retorna [].
   */
  async query<T = mysql.RowDataPacket>(
    sql: string,
    params: any[] = [],
  ): Promise<T[]> {
    if (!this.pool) return [];
    const [rows] = await this.pool.query<mysql.RowDataPacket[]>(sql, params);
    return rows as unknown as T[];
  }
}
