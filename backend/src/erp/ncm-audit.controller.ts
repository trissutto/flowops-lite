import { Body, Controller, Get, Header, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { AdminOnlyGuard } from '../auth/admin-only.guard';
import { NcmAuditService } from './ncm-audit.service';

/**
 * /api/admin/ncm-audit — Auditoria e correção de NCMs no ERP.
 *
 * Endpoints:
 *  GET  /                  → lista produtos com NCM problemático + sugestão
 *  POST /apply             → aplica fixes em batch (UPDATE produtos.NCM)
 *
 * Requer auth + role admin. Aplicação respeita ERP_WRITE_ENABLED.
 */
@UseGuards(JwtAuthGuard, AdminOnlyGuard)
@Controller('admin/ncm-audit')
export class NcmAuditController {
  constructor(private readonly ncmAudit: NcmAuditService) {}

  @Get()
  @Header('Cache-Control', 'no-store, no-cache, must-revalidate')
  @Header('Pragma', 'no-cache')
  @Header('Expires', '0')
  async audit(
    @Query('limit') limit?: string,
    @Query('includeOk') includeOk?: string,
    @Query('onlyIssue') onlyIssue?: 'empty' | 'invalid_format' | 'wrong_category',
  ) {
    return this.ncmAudit.auditCatalog({
      limit: limit ? Number(limit) : undefined,
      includeOk: includeOk === 'true',
      onlyIssue: onlyIssue,
    });
  }

  @Post('apply')
  async apply(@Body() body: { items: Array<{ ref: string; ncm: string }> }) {
    if (!Array.isArray(body?.items) || body.items.length === 0) {
      return { applied: 0, skipped: 0, errors: [{ ref: '*', error: 'items vazio' }] };
    }
    if (body.items.length > 50000) {
      return {
        applied: 0,
        skipped: body.items.length,
        errors: [{ ref: '*', error: 'Máximo 50.000 itens por batch' }],
      };
    }
    return this.ncmAudit.applyFixes(body.items);
  }

  /**
   * GET /api/admin/ncm-audit/export-sql
   *
   * Gera arquivo .sql com TODOS os UPDATEs prontos pra rodar direto no
   * MySQL Workbench / DBeaver / phpMyAdmin. Bypassa HTTP/lock issues.
   *
   * Estratégia: agrupa por NCM destino → 1 statement por NCM com
   * WHERE REF IN (...) — eficiente e atômico.
   */
  @Get('export-sql')
  async exportSql(
    @Query('onlyIssue') onlyIssue: 'empty' | 'invalid_format' | 'wrong_category' | undefined,
    @Res() res: Response,
  ) {
    const audit = await this.ncmAudit.auditCatalog({
      limit: 200000,
      onlyIssue,
    });

    // Agrupa REFs por NCM destino
    const byNcm: Map<string, { ncm: string; ruleDesc: string; refs: string[] }> = new Map();
    for (const item of audit.items) {
      if (item.issue === 'ok') continue;
      const key = item.suggestedNcm;
      const bucket = byNcm.get(key) || {
        ncm: item.suggestedNcm,
        ruleDesc: item.suggestedRule,
        refs: [],
      };
      bucket.refs.push(item.ref);
      byNcm.set(key, bucket);
    }

    const ncmCol = audit.schema.ncmCol || 'NCM';
    const lines: string[] = [];
    lines.push(`-- =====================================================`);
    lines.push(`-- AUDITORIA DE NCM — Catálogo Giga (Lurd's Plus Size)`);
    lines.push(`-- Gerado em: ${new Date().toISOString()}`);
    lines.push(`-- Total de produtos com problema: ${audit.summary.total - audit.summary.ok}`);
    lines.push(`--   Vazios: ${audit.summary.empty}`);
    lines.push(`--   Formato inválido: ${audit.summary.invalid_format}`);
    lines.push(`--   Categoria errada: ${audit.summary.wrong_category}`);
    lines.push(`-- =====================================================`);
    lines.push(``);
    lines.push(`-- IMPORTANTE: faça backup da tabela produtos antes de rodar:`);
    lines.push(`-- CREATE TABLE produtos_backup AS SELECT * FROM produtos;`);
    lines.push(``);
    lines.push(`-- Para rodar TUDO numa transação atômica, descomente as linhas:`);
    lines.push(`-- START TRANSACTION;`);
    lines.push(``);

    // Sort by NCM pra leitura organizada
    const sorted = Array.from(byNcm.values()).sort((a, b) => a.ncm.localeCompare(b.ncm));

    let totalRefs = 0;
    for (const bucket of sorted) {
      totalRefs += bucket.refs.length;
      lines.push(`-- ${bucket.ruleDesc} (${bucket.refs.length} REFs)`);
      // Quebra em chunks de 1000 REFs por statement (limite MySQL na cláusula IN)
      for (let i = 0; i < bucket.refs.length; i += 1000) {
        const slice = bucket.refs.slice(i, i + 1000);
        const escaped = slice.map((r) => `'${r.replace(/'/g, "''")}'`).join(',');
        lines.push(
          `UPDATE produtos SET \`${ncmCol}\` = '${bucket.ncm}' WHERE REF IN (${escaped});`,
        );
      }
      lines.push(``);
    }

    lines.push(`-- COMMIT;`);
    lines.push(``);
    lines.push(`-- Total de UPDATEs: ${sorted.length} statements afetando ${totalRefs} REFs`);
    lines.push(`-- Para reverter: DROP TABLE produtos; RENAME TABLE produtos_backup TO produtos;`);

    const filename = `ncm-fix-${new Date().toISOString().slice(0, 10)}.sql`;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(lines.join('\n'));
  }
}
