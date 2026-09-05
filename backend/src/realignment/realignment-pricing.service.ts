import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { gigaDesligado } from '../common/replica-giga';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
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

  constructor(
    private readonly config: ConfigService,
    // ESPELHO (29/08): com o Giga desligado em definitivo o pool nunca nasce e
    // os dois métodos saíam no `!this.pool` com Map VAZIO — toda peça do
    // relatório de transferências ia pra tela como R$ 0,00 e o recálculo da
    // obrigação rede×franquia marcava 100% `semPreco`. O preço vive no
    // espelho (`wincred_produtos.vendaUn`, em REAIS) — é ele a fonte agora.
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit() {
    // Servidor do Giga desligado (27/08): pool nenhum. Ver common/replica-giga.ts.
    if (gigaDesligado()) {
      this.logger.warn('pricing service inativo — servidor do Giga desligado (ERP_GIGA_OFF)');
      return;
    }
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
         * ⚰️ NADA DISTO RODA HOJE — o `gigaDesligado()` acima sai antes de
         * criar o pool. Fica como registro do modo de falha que motivou a
         * fila finita.
         *
         * O `ERP_HOST` era o MySQL do ERP legado, no host do FORNECEDOR —
         * outro servidor que o `WP_DB_HOST` (o WordPress da KingHost). O
         * problema nunca foi o host estar morto: era o modo como ele MORRIA.
         *
         * Aquele MySQL **PENDURAVA** em vez de dar erro quando o firewall por
         * IP derrubava o IP dinâmico do Railway — `.catch` não pegava, porque
         * não havia erro; a conexão só não voltava. Foi assim que a live de
         * 01/07 caiu. Com fila ILIMITADA, um pendurado desses não ficava
         * contido: cada chamada nova entrava na fila pra esperar uma das 2
         * conexões que nunca vagariam, e a fila crescia sem teto até levar o
         * processo junto.
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
    if (codigos.length === 0) return result;

    // ESPELHO primeiro: `ltrim` dos dois lados substitui as variantes de
    // padding (wincred_produtos.codigo é normalizado sem zeros à esquerda).
    try {
      const coreToOriginal = new Map<string, string>();
      for (const original of codigos) {
        const orig = String(original || '').trim();
        if (!orig) continue;
        const core = orig.replace(/^0+/, '') || orig;
        if (!coreToOriginal.has(core)) coreToOriginal.set(core, orig);
      }
      if (coreToOriginal.size) {
        const rows: any[] = await (this.prisma as any).$queryRawUnsafe(
          `SELECT ltrim(codigo, '0') AS core, "vendaUn"::float AS preco
             FROM wincred_produtos
            WHERE ltrim(codigo, '0') = ANY($1::text[])`,
          Array.from(coreToOriginal.keys()),
        );
        for (const r of rows) {
          const original = coreToOriginal.get(String(r.core || '').trim());
          const preco = Number(r.preco) || 0;
          if (original && preco > 0 && !result.has(original)) result.set(original, preco);
        }
        this.logger.log(`getPricesByCodigos (espelho): pediu=${codigos.length}, encontrou=${result.size}`);
        return result;
      }
    } catch (e: any) {
      this.logger.warn(`getPricesByCodigos espelho falhou (${e?.message}) — tentando Giga`);
    }
    if (!this.pool) return result;

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
    if (refs.length === 0) return result;

    // ESPELHO primeiro — média de `vendaUn` por REF, match por UPPER/TRIM.
    try {
      const upperToOriginal = new Map<string, string>();
      for (const r of refs) {
        const orig = String(r || '').trim();
        if (!orig) continue;
        const up = orig.toUpperCase();
        if (!upperToOriginal.has(up)) upperToOriginal.set(up, orig);
      }
      if (upperToOriginal.size) {
        const rows: any[] = await (this.prisma as any).$queryRawUnsafe(
          `SELECT UPPER(TRIM(ref)) AS ref, AVG("vendaUn")::float AS preco
             FROM wincred_produtos
            WHERE UPPER(TRIM(COALESCE(ref, ''))) = ANY($1::text[])
              AND "vendaUn" > 0
            GROUP BY 1`,
          Array.from(upperToOriginal.keys()),
        );
        for (const r of rows) {
          const original = upperToOriginal.get(String(r.ref || '').trim());
          const preco = Number(r.preco) || 0;
          if (original && preco > 0) result.set(original, preco);
        }
        return result;
      }
    } catch (e: any) {
      this.logger.warn(`getPricesByRefs espelho falhou (${e?.message}) — tentando Giga`);
    }
    if (!this.pool) return result;

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
