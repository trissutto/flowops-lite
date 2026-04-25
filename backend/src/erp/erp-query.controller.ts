import {
  BadRequestException, Body, Controller, ForbiddenException, Get,
  NotFoundException, Param, Post, Query, Req, UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { ErpService } from './erp.service';

interface AuthUser {
  userId: string;
  email: string;
  role: string;
  storeId: string | null;
}

/**
 * /erp-query — Explorer genérico do MySQL Gigasistemas (matriz only).
 *
 * Usado pela tela /relatorios/giga pra rodar queries READ-ONLY contra o
 * banco do ERP em tempo real, com limite e validação. Permite:
 *   GET  /erp-query/tables                 — lista todas as tabelas + tamanhos
 *   GET  /erp-query/tables/:name           — colunas + amostra + count
 *   POST /erp-query/run  { sql, maxRows? } — executa SELECT/SHOW/DESCRIBE/EXPLAIN
 *
 * Camadas de segurança:
 *   - JwtAuthGuard
 *   - role admin/operator (loja não acessa)
 *   - Whitelist + blacklist no service (bloqueia INSERT/UPDATE/DELETE/DROP/etc)
 *   - LIMIT automático (default 1000, max 50000)
 *   - Timeout 30s
 */
@Controller('erp-query')
@UseGuards(JwtAuthGuard)
export class ErpQueryController {
  constructor(private readonly erp: ErpService) {}

  private ensureAdmin(req: any) {
    const user = req.user as AuthUser;
    if (user.role !== 'admin' && user.role !== 'operator') {
      throw new ForbiddenException('Apenas matriz (admin/operator) acessa o explorer ERP');
    }
  }

  @Get('tables')
  async listTables(@Req() req: any) {
    this.ensureAdmin(req);
    const tables = await this.erp.listAllTables();
    return { count: tables.length, tables };
  }

  @Get('tables/:name')
  async tableSchema(
    @Req() req: any,
    @Param('name') name: string,
    @Query('sample') sample?: string,
  ) {
    this.ensureAdmin(req);
    const sampleLim = sample != null ? Number(sample) : 5;
    const schema = await this.erp.getTableSchema(name, sampleLim);
    if (!schema) throw new NotFoundException(`Tabela "${name}" não encontrada`);
    return schema;
  }

  @Post('run')
  async run(
    @Req() req: any,
    @Body() body: { sql?: string; maxRows?: number; timeoutMs?: number },
  ) {
    this.ensureAdmin(req);
    if (!body?.sql || typeof body.sql !== 'string') {
      throw new BadRequestException('Body precisa de { sql: string }');
    }
    try {
      const result = await this.erp.runReadOnly(body.sql, {
        maxRows: body.maxRows,
        timeoutMs: body.timeoutMs,
      });
      return result;
    } catch (e: any) {
      throw new BadRequestException(e?.message ?? 'Erro ao executar SQL');
    }
  }
}
