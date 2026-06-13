import { Body, Controller, ForbiddenException, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { ErpService } from './erp.service';

/**
 * Endpoint de auto-descoberta do schema Wincred.
 *
 * Uso interno (admin only). Conecta no MySQL Wincred (mesma conexao do
 * ErpService), lista TODAS as tabelas, retorna DDL + count + amostra de
 * cada uma. Saida vira input pra gerar migrations Prisma equivalentes
 * no Postgres.
 *
 * NAO ESCREVE NADA no Wincred. So leitura.
 */
@Controller('admin/wincred-discovery')
@UseGuards(JwtAuthGuard)
export class WincredDiscoveryController {
  constructor(private readonly erp: ErpService) {}

  private requireAdmin(req: any) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'master') {
      throw new ForbiddenException('Apenas admin/master');
    }
  }

  /**
   * GET /admin/wincred-discovery/schema
   * Query:
   *   sampleRows: 0-10 (default 3) — quantas linhas de amostra trazer por tabela
   *   skipCounts: 'true' pra pular COUNT(*) (mais rapido em DBs gigantes)
   *   onlyPrefix: filtra tabelas que comecam com o prefixo (ex: 'prod')
   *
   * Retorna JSON com a estrutura completa do banco Wincred.
   */
  @Get('schema')
  async schema(
    @Req() req: any,
    @Query('sampleRows') sampleRows?: string,
    @Query('skipCounts') skipCounts?: string,
    @Query('onlyPrefix') onlyPrefix?: string,
  ) {
    this.requireAdmin(req);
    return this.erp.dumpWincredSchema({
      sampleRows: sampleRows ? Number(sampleRows) : undefined,
      skipCounts: skipCounts === 'true',
      onlyPrefix: onlyPrefix || undefined,
    });
  }

  /**
   * GET /admin/wincred-discovery/tables
   * Versao mais leve: so o nome das tabelas + count. Sem DDL, sem sample.
   * Util pra primeiro overview rapido.
   */
  @Get('tables')
  async tables(@Req() req: any) {
    this.requireAdmin(req);
    const dump = await this.erp.dumpWincredSchema({
      sampleRows: 0,
      skipCounts: false,
    });
    return {
      connectedTo: dump.connectedTo,
      totalTables: dump.totalTables,
      durationMs: dump.durationMs,
      tables: dump.tables.map((t) => ({
        name: t.name,
        rowCount: t.rowCount,
        error: t.error,
      })),
    };
  }
}
