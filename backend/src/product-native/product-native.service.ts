import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

/**
 * PRODUTO NATIVO (P1 da migração de produtos) — mantém a tabela `product`
 * (fonte futura da verdade) sincronizada A PARTIR DO ESPELHO wincred_produtos.
 *
 * Tudo roda DENTRO do Postgres (INSERT..SELECT..ON CONFLICT) — não toca o
 * Giga, não depende de rede, 350k linhas em segundos.
 *
 * Curadoria automática na carga:
 *   genero  = MASCULINO/INFANTIL se a descrição diz; FEMININO se plus (1,2)
 *   liveOk  = plus (1,2) + não masc/inf + tamanho 46–60/46-48/50-52 (ou vazio)
 * Linhas com curadoManual=true nunca têm genero/liveOk recalculados.
 * Linhas com flowIsSource=true (editadas no Flow, P3) NUNCA são sobrescritas.
 *
 * Cron de hora em hora (minuto 38 — depois do sync do espelho no minuto 23),
 * gated pela mesma env do espelho (WINCRED_MIRROR_CRON_ENABLED=1).
 */
@Injectable()
export class ProductNativeService {
  private readonly logger = new Logger(ProductNativeService.name);
  private syncing = false;

  constructor(private readonly prisma: PrismaService) {}

  private get cronEnabled(): boolean {
    return String(process.env.WINCRED_MIRROR_CRON_ENABLED ?? '').trim() === '1';
  }

  /** SQL de upsert espelho→nativo. `incremental` limita às linhas recentes. */
  private buildUpsertSql(incremental: boolean): string {
    const where = incremental
      ? `WHERE w."dataAlt" >= CURRENT_DATE - INTERVAL '3 days'`
      : '';
    return `
      INSERT INTO product (
        codigo, grupo, "nomeGrupo", "descricaoPdv", "descricaoCompleta", custo, "vendaUn",
        fornecedor, unidade, estoque, margem, "dataAlt", subgrupo, cor, tamanho, marca, ref,
        ncm, tributo, cfop, "plusSize",
        genero, "liveOk", ativo, curado_manual, flow_is_source, edited_at, synced_at, updated_at
      )
      SELECT
        w.codigo, w.grupo, w."nomeGrupo", w."descricaoPdv", w."descricaoCompleta", w.custo, w."vendaUn",
        w.fornecedor, w.unidade, w.estoque, w.margem, w."dataAlt", w.subgrupo, w.cor, w.tamanho, w.marca, w.ref,
        w.ncm, w.tributo, w.cfop, w."plusSize",
        CASE
          WHEN upper(coalesce(w."descricaoCompleta", '')) LIKE '%MASCULIN%' THEN 'MASCULINO'
          WHEN upper(coalesce(w."descricaoCompleta", '')) LIKE '%INFANTIL%' THEN 'INFANTIL'
          WHEN w."plusSize" IN (1, 2) THEN 'FEMININO'
          ELSE NULL
        END,
        -- COALESCE obrigatório: PLUS_SIZE nulo (cadastro antigo) deixaria a
        -- expressão NULL e a coluna liveOk é NOT NULL → derrubava o lote inteiro.
        COALESCE((
          w."plusSize" IN (1, 2)
          AND upper(coalesce(w."descricaoCompleta", '')) NOT LIKE '%MASCULIN%'
          AND upper(coalesce(w."descricaoCompleta", '')) NOT LIKE '%INFANTIL%'
          AND (
            coalesce(trim(w.tamanho), '') = ''
            OR trim(w.tamanho) IN ('46','48','50','52','54','56','58','60','46/48','50/52')
          )
        ), false),
        true, false, false, NULL, now(), now()
      FROM wincred_produtos w
      ${where}
      ON CONFLICT (codigo) DO UPDATE SET
        grupo = EXCLUDED.grupo,
        "nomeGrupo" = EXCLUDED."nomeGrupo",
        "descricaoPdv" = EXCLUDED."descricaoPdv",
        "descricaoCompleta" = EXCLUDED."descricaoCompleta",
        custo = EXCLUDED.custo,
        "vendaUn" = EXCLUDED."vendaUn",
        fornecedor = EXCLUDED.fornecedor,
        unidade = EXCLUDED.unidade,
        estoque = EXCLUDED.estoque,
        margem = EXCLUDED.margem,
        "dataAlt" = EXCLUDED."dataAlt",
        subgrupo = EXCLUDED.subgrupo,
        cor = EXCLUDED.cor,
        tamanho = EXCLUDED.tamanho,
        marca = EXCLUDED.marca,
        ref = EXCLUDED.ref,
        ncm = EXCLUDED.ncm,
        tributo = EXCLUDED.tributo,
        cfop = EXCLUDED.cfop,
        "plusSize" = EXCLUDED."plusSize",
        genero = CASE WHEN product.curado_manual THEN product.genero ELSE EXCLUDED.genero END,
        "liveOk" = CASE WHEN product.curado_manual THEN product."liveOk" ELSE EXCLUDED."liveOk" END,
        synced_at = now(),
        updated_at = now()
      WHERE product.flow_is_source = false
    `;
  }

  async syncFull(): Promise<{ upserted: number; ms: number }> {
    if (this.syncing) return { upserted: 0, ms: 0 };
    this.syncing = true;
    const t0 = Date.now();
    try {
      const upserted = await this.prisma.$executeRawUnsafe(this.buildUpsertSql(false));
      const ms = Date.now() - t0;
      this.logger.log(`[product-native] sync FULL: ${upserted} linhas em ${ms}ms`);
      return { upserted: Number(upserted), ms };
    } catch (e) {
      this.logger.error(`[product-native] sync FULL falhou: ${(e as Error).message}`);
      throw e;
    } finally {
      this.syncing = false;
    }
  }

  async syncIncremental(): Promise<{ upserted: number; ms: number }> {
    if (this.syncing) return { upserted: 0, ms: 0 };
    this.syncing = true;
    const t0 = Date.now();
    try {
      const upserted = await this.prisma.$executeRawUnsafe(this.buildUpsertSql(true));
      const ms = Date.now() - t0;
      this.logger.log(`[product-native] sync incremental: ${upserted} linhas em ${ms}ms`);
      return { upserted: Number(upserted), ms };
    } catch (e) {
      this.logger.error(`[product-native] sync incremental falhou: ${(e as Error).message}`);
      throw e;
    } finally {
      this.syncing = false;
    }
  }

  /** Hora em hora, minuto 38 (espelho Wincred roda no 23 — pegamos ele fresco). */
  @Cron('0 38 * * * *')
  async cronHourly() {
    if (!this.cronEnabled) return;
    try {
      // Se a tabela ainda está vazia (primeira vez), faz a carga cheia.
      const total = await (this.prisma as any).product.count();
      if (total === 0) await this.syncFull();
      else await this.syncIncremental();
    } catch (e) {
      this.logger.warn(`[product-native] cron falhou: ${(e as Error).message}`);
    }
  }

  async status() {
    const p: any = this.prisma;
    const [total, liveOk, femin, masc, inf, semGenero, flowSource, curados, espelho] = await Promise.all([
      p.product.count(),
      p.product.count({ where: { liveOk: true } }),
      p.product.count({ where: { genero: 'FEMININO' } }),
      p.product.count({ where: { genero: 'MASCULINO' } }),
      p.product.count({ where: { genero: 'INFANTIL' } }),
      p.product.count({ where: { genero: null } }),
      p.product.count({ where: { flowIsSource: true } }),
      p.product.count({ where: { curadoManual: true } }),
      p.wincredProduto.count(),
    ]);
    return {
      total,
      espelhoWincred: espelho,
      cobertura: espelho > 0 ? Number(((total / espelho) * 100).toFixed(1)) : 0,
      liveOk,
      genero: { feminino: femin, masculino: masc, infantil: inf, semGenero },
      editadosNoFlow: flowSource,
      curadosManualmente: curados,
      flags: {
        PRODUCT_NATIVE_READS: String(process.env.PRODUCT_NATIVE_READS ?? '') === '1',
        PRODUCT_NATIVE_WRITES: String(process.env.PRODUCT_NATIVE_WRITES ?? '') === '1',
        cronEnabled: this.cronEnabled,
      },
    };
  }
}
