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
    return this.mirror.syncAll();
  }

  @Post('sync/produtos')
  syncProdutos(@Req() req: any) {
    this.requireAdmin(req);
    return this.mirror.syncProdutos();
  }

  @Post('sync/estoque')
  syncEstoque(@Req() req: any) {
    this.requireAdmin(req);
    return this.mirror.syncEstoque();
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

    // Pra cada codigo, ver se tem linha em wincred_estoque
    const codigos = rows.map((r) => String(r.codigo));
    const estoqueRows: any[] = codigos.length > 0
      ? await prisma.$queryRawUnsafe(
          `SELECT codigo, loja, estoque
             FROM wincred_estoque
            WHERE codigo = ANY($1::text[])
            ORDER BY codigo, loja`,
          codigos,
        )
      : [];

    // Tambem: contar quantas linhas tem na tabela inteira pra esses codigos
    const codigosUnique = Array.from(new Set(codigos));
    const sampleCodigo = codigosUnique[0] || '';
    const estoqueSampleRaw: any[] = sampleCodigo
      ? await prisma.$queryRawUnsafe(
          `SELECT codigo, loja, estoque FROM wincred_estoque WHERE codigo = $1 LIMIT 20`,
          sampleCodigo,
        )
      : [];

    return {
      ref,
      total_produtos: rows.length,
      total_estoque_linhas: estoqueRows.length,
      sample_produtos: rows.slice(0, 5),
      sample_estoque: estoqueRows.slice(0, 20),
      diag_primeiro_codigo: sampleCodigo,
      diag_estoque_pra_esse_codigo: estoqueSampleRaw,
      cores: Array.from(new Set(rows.map((r) => r.cor))),
    };
  }
}
