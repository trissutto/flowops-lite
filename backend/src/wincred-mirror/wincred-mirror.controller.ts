import {
  Controller, ForbiddenException, Get, Post, Req, UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { WincredMirrorService } from './wincred-mirror.service';

/**
 * Endpoints admin pra disparar e monitorar o sync das 6 tabelas Wincred.
 *
 * Rotas:
 *   GET  /admin/wincred-mirror/status         — counts Postgres + Wincred + ultimo sync
 *   POST /admin/wincred-mirror/sync/all       — sync completo das 6 tabelas
 *   POST /admin/wincred-mirror/sync/produtos  — so produtos
 *   POST /admin/wincred-mirror/sync/estoque   — so estoque
 *   POST /admin/wincred-mirror/sync/grupos
 *   POST /admin/wincred-mirror/sync/subgrupos
 *   POST /admin/wincred-mirror/sync/fornecedores
 *   POST /admin/wincred-mirror/sync/codigos
 */
@Controller('admin/wincred-mirror')
@UseGuards(JwtAuthGuard)
export class WincredMirrorController {
  constructor(private readonly mirror: WincredMirrorService) {}

  private requireAdmin(req: any) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'master') {
      throw new ForbiddenException('Apenas admin/master');
    }
  }

  @Get('status')
  status(@Req() req: any) {
    this.requireAdmin(req);
    return this.mirror.status();
  }

  @Post('sync/all')
  syncAll(@Req() req: any) {
    this.requireAdmin(req);
    // BACKGROUND (02/07): com o catálogo completo (352k linhas) o sync
    // síncrono estourava o timeout do proxy ("Failed to fetch") e morria no
    // meio; clique repetido disparava dois syncs concorrentes. Agora
    // responde na hora e a tela acompanha via GET sync/progress.
    return this.mirror.startSyncAllBackground();
  }

  @Get('sync/progress')
  syncProgress(@Req() req: any) {
    this.requireAdmin(req);
    return this.mirror.getSyncProgress();
  }

  @Post('sync/produtos')
  syncProdutos(@Req() req: any) {
    this.requireAdmin(req);
    return this.mirror.syncProdutos();
  }

  @Post('sync/estoque')
  syncEstoque(@Req() req: any) {
    this.requireAdmin(req);
    // Botão manual = recuperação consciente: força mesmo com o cron desligado
    // (constituição 14/07: Flow é a fonte; usar só pra reconciliar após incidente).
    return this.mirror.syncEstoque(true);
  }

  @Post('sync/grupos')
  syncGrupos(@Req() req: any) {
    this.requireAdmin(req);
    return this.mirror.syncGrupos();
  }

  @Post('sync/subgrupos')
  syncSubgrupos(@Req() req: any) {
    this.requireAdmin(req);
    return this.mirror.syncSubgrupos();
  }

  @Post('sync/fornecedores')
  syncFornecedores(@Req() req: any) {
    this.requireAdmin(req);
    return this.mirror.syncFornecedores();
  }

  @Post('sync/codigos')
  syncCodigos(@Req() req: any) {
    this.requireAdmin(req);
    return this.mirror.syncCodigos();
  }

  /**
   * POST /admin/wincred-mirror/sync/incremental
   * Sync incremental — apenas produtos modificados (DATAALT) e seu estoque.
   * Custo tipico: 1-5s. Roda automaticamente via cron a cada 10min.
   */
  @Post('sync/incremental')
  syncIncremental(@Req() req: any) {
    this.requireAdmin(req);
    return this.mirror.syncIncremental();
  }

  /**
   * GET /admin/wincred-mirror/divergencias
   * Compara totais Wincred vs Mirror + sample de produtos com estoque divergente.
   */
  @Get('divergencias')
  divergencias(@Req() req: any) {
    this.requireAdmin(req);
    return this.mirror.getDivergencias();
  }

  /**
   * GET /admin/wincred-mirror/config
   * Retorna estado das flags WINCRED_MIRROR_CRON_ENABLED + USE_LOCAL_CATALOG
   */
  @Get('config')
  config(@Req() req: any) {
    this.requireAdmin(req);
    return {
      cronEnabled: String(process.env.WINCRED_MIRROR_CRON_ENABLED || '').trim() === '1',
      useLocalCatalog: String(process.env.USE_LOCAL_CATALOG || '').trim() === '1',
      cronSchedule: 'incremental: */10 * * * * | full: 0 3 * * *',
    };
  }

  /**
   * GET /admin/wincred-mirror/peek?ref=VLM-222
   * Debug: retorna produtos do Postgres com REF dado. Util pra verificar
   * se sync pegou o produto e como ficou (TAMANHO com espaco, etc).
   */
  @Get('peek')
  async peek(@Req() req: any) {
    this.requireAdmin(req);
    const ref = String((req.query?.ref || '').toString()).trim().toUpperCase();
    if (!ref) return { error: 'ref obrigatorio' };
    const prisma = (this.mirror as any).prisma;

    const rows: any[] = await prisma.$queryRawUnsafe(
      `SELECT codigo, ref, cor, tamanho, "plusSize", "descricaoCompleta"
         FROM wincred_produtos
        WHERE UPPER(TRIM(ref)) LIKE $1
        ORDER BY cor, tamanho
        LIMIT 100`,
      ref + '%',
    );

    // Pra cada codigo, ver se tem linha em wincred_estoque (com varias estrategias)
    const codigos = rows.map((r) => String(r.codigo));
    const codigosUnique = Array.from(new Set(codigos));
    const sampleCodigo = codigosUnique[0] || '';

    // ESTRATEGIA 1: igualdade exata
    const eqExato: any[] = sampleCodigo
      ? await prisma.$queryRawUnsafe(
          `SELECT codigo, length(codigo) AS len, loja, estoque FROM wincred_estoque WHERE codigo = $1`,
          sampleCodigo,
        )
      : [];

    // ESTRATEGIA 2: LIKE com %codigo%
    const likePartial: any[] = sampleCodigo
      ? await prisma.$queryRawUnsafe(
          `SELECT codigo, length(codigo) AS len, loja, estoque FROM wincred_estoque WHERE codigo LIKE $1 LIMIT 20`,
          `%${sampleCodigo}%`,
        )
      : [];

    // ESTRATEGIA 3: comparacao numerica (BIGINT)
    const numericMatch: any[] = sampleCodigo
      ? await prisma.$queryRawUnsafe(
          `SELECT codigo, length(codigo) AS len, loja, estoque
             FROM wincred_estoque
            WHERE NULLIF(REGEXP_REPLACE(codigo, '\\D', '', 'g'), '')::bigint = $1::bigint LIMIT 20`,
          sampleCodigo,
        )
      : [];

    // ESTRATEGIA 4: amostra geral da tabela estoque (5 linhas)
    const estoqueGeral: any[] = await prisma.$queryRawUnsafe(
      `SELECT codigo, length(codigo) AS len, loja FROM wincred_estoque LIMIT 5`,
    );

    return {
      ref,
      total_produtos: rows.length,
      cores: Array.from(new Set(rows.map((r) => r.cor))),
      diag_codigo_produto: {
        valor: sampleCodigo,
        length: sampleCodigo.length,
      },
      diag_estoque_igualdade_exata: { matches: eqExato.length, sample: eqExato.slice(0, 5) },
      diag_estoque_like_partial: { matches: likePartial.length, sample: likePartial.slice(0, 5) },
      diag_estoque_numeric_match: { matches: numericMatch.length, sample: numericMatch.slice(0, 5) },
      diag_amostra_geral_estoque: estoqueGeral,
    };
  }
}
