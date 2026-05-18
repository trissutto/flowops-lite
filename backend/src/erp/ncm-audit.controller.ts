import { Body, Controller, Get, Header, Post, Query, UseGuards } from '@nestjs/common';
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
}
