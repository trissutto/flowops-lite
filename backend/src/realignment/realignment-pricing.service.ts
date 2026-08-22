import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as mysql from 'mysql2/promise';

/**
 * RealignmentPricingService — busca preços de venda (VENDAUN) no Giga
 * em batch pra alimentar o relatório de transferências.
 *
 * Por que separado do ErpService:
 *  - ErpService é gigante e nem todos os métodos cabem lá
 *  - Esse service tem seu próprio pool com max 2 conexões (uso esporádico)
 *  - Pode ser desabilitado independente sem afetar fluxo PDV
 *
 * Estratégia:
 *  1. Recebe lista de CODIGOs Giga (SKUs com padding)
 *  2. Bulk SELECT em UMA query (WHERE CODIGO IN ...)
 *  3. Trata variantes de zero-padding (igual ErpService.skuVariants)
 *  4. Retorna Map<codigo, preco em reais>
 *  5. VENDAUN está em CENTAVOS no Giga — divide por 100
 */
@Injectable()
export class RealignmentPricingService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RealignmentPricingService.name);
  private pool: mysql.Pool | null = null;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    const host = this.config.get<string>('ERP_HOST');
    if (!host) {
      this.logger.warn('ERP_HOST não configurado — pricing service inativo');
      return;
    }
    try {
      this.pool = mysql.createPool({
        host,
        port: Number(this.config.get<string>('ERP_PORT') ?? 3306),
        user: this.config.get<string>('ERP_USER'),
        password: this.config.get<string>('ERP_PASSWORD'),
        database: this.config.get<string>('ERP_DATABASE'),
        waitForConnections: true,
        connectionLimit: 2,
        /**
         * ⚠️ FILA FINITA. Era `0` — que no mysql2 quer dizer ILIMITADA, não
         * "sem fila".
         *
         * O host aqui (`ERP_HOST`) está VIVO — não confundir com o
         * `WP_DB_HOST`, que é outro servidor e esse sim está fora do ar. O
         * problema não é o host estar morto: é o modo como ele MORRE.
         *
         * O CLAUDE.md registra que o Giga **PENDURA** em vez de dar erro
         * quando o firewall por IP da KingHost derruba o IP dinâmico do
         * Railway — `.catch` não pega, porque não há erro; a conexão só não
         * volta. Foi assim que a live de 01/07 caiu. Com fila ILIMITADA, um
         * pendurado desses não fica contido: cada chamada nova entra na fila
         * pra esperar uma das 2 conexões que nunca vão vagar, e a fila cresce
         * sem teto até levar o processo junto.
         *
         * Fila finita transforma "app congela" em "esta chamada falhou" — que
         * é um resultado que o chamador já sabe tratar: os dois métodos
         * públicos daqui fazem catch por chunk e devolvem Map, então a peça
         * sai sem preço em vez de derrubar a tela.
         *
         * Teto baixo de propósito: com 2 conexões, fila de 10 já é mais espera
         * do que qualquer chamador destas telas tolera.
         */
        queueLimit: 10,
        connectTimeout: 12000,
      });
      this.logger.log(`pool pricing inicializado (host=${host})`);
    } catch (e) {
      this.logger.error(`falha ao iniciar pool: ${(e as Error).message}`);
    }
  }

  async onModuleDestroy() {
    if (this.pool) {
      try {
        await this.pool.end();
      } catch {}
    }
  }

  /**
   * Gera variantes de SKU com padding (3 a 14 chars).
   * Replica a lógica de ErpService.skuVariants pra não duplicar
   * a dependência (esse service tem que ser independente).
   */
  private skuVariants(sku: string): string[] {
    const trimmed = String(sku || '').trim();
    if (!trimmed) return [];
    const out = new Set<string>([trimmed]);
    const stripped = trimmed.replace(/^0+/, '');
    if (stripped) out.add(stripped);
    const base = stripped || trimmed;
    if (/^\d+$/.test(base)) {
      for (let len = Math.max(3, base.length); len <= 14; len++) {
        out.add(base.padStart(len, '0'));
      }
    }
    return Array.from(out);
  }

  /**
   * Busca preço de venda (VENDAUN) em batch.
   * Retorna Map<codigoOriginal, precoEmReais>.
   * SKUs não encontrados não aparecem no Map (caller trata como sem preço).
   *
   * Exemplo: getPricesByCodigos(['11132233', '0005394104'])
   * Retorna Map { '11132233' => 189.90, '0005394104' => 119.90 }
   */
  async getPricesByCodigos(codigos: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (!this.pool || codigos.length === 0) return result;

    // Gera todas as variantes pra UMA query massiva
    const variantToOriginal = new Map<string, string>();
    const allVariants = new Set<string>();
    for (const original of codigos) {
      const orig = String(original || '').trim();
      if (!orig) continue;
      for (const v of this.skuVariants(orig)) {
        allVariants.add(v);
        if (!variantToOriginal.has(v)) variantToOriginal.set(v, orig);
      }
    }
    if (allVariants.size === 0) return result;

    const variants = Array.from(allVariants);
    // Chunk de 5000 placeholders pra não estourar limite SQL
    const CHUNK = 5000;
    for (let i = 0; i < variants.length; i += CHUNK) {
      const slice = variants.slice(i, i + CHUNK);
      const placeholders = slice.map(() => '?').join(',');
      const sql = `SELECT CODIGO, VENDAUN AS preco FROM produtos WHERE CODIGO IN (${placeholders})`;
      try {
        const [rows] = await this.pool.query<mysql.RowDataPacket[]>(sql, slice);
        for (const r of rows as any[]) {
          const codigo = String(r.CODIGO).trim();
          // VENDAUN no Wincred Lurd's está em REAIS direto (decimal),
          // não em centavos. Ex: 199.90 = R$ 199,90.
          const preco = Number(r.preco) || 0;
          const original = variantToOriginal.get(codigo);
          if (original && !result.has(original)) {
            result.set(original, preco);
          }
        }
      } catch (e: any) {
        this.logger.warn(`getPricesByCodigos chunk falhou: ${e.message}`);
      }
    }

    this.logger.log(
      `getPricesByCodigos: pediu=${codigos.length}, encontrou=${result.size}`,
    );
    return result;
  }

  /**
   * Fallback: busca preço médio por REF (quando codigoBipado não existe).
   * Útil pra items antigos sem CODIGO resolvido.
   */
  async getPricesByRefs(refs: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (!this.pool || refs.length === 0) return result;

    const uniqueRefs = Array.from(new Set(refs.map((r) => String(r).trim()).filter(Boolean)));
    if (uniqueRefs.length === 0) return result;

    const CHUNK = 5000;
    for (let i = 0; i < uniqueRefs.length; i += CHUNK) {
      const slice = uniqueRefs.slice(i, i + CHUNK);
      const placeholders = slice.map(() => '?').join(',');
      const sql = `
        SELECT REF, AVG(VENDAUN) AS preco
          FROM produtos
         WHERE REF IN (${placeholders})
           AND VENDAUN > 0
         GROUP BY REF
      `;
      try {
        const [rows] = await this.pool.query<mysql.RowDataPacket[]>(sql, slice);
        for (const r of rows as any[]) {
          const ref = String(r.REF).trim();
          // VENDAUN em REAIS direto (decimal), não em centavos
          const preco = Number(r.preco) || 0;
          if (preco > 0) result.set(ref, preco);
        }
      } catch (e: any) {
        this.logger.warn(`getPricesByRefs chunk falhou: ${e.message}`);
      }
    }
    return result;
  }
}
