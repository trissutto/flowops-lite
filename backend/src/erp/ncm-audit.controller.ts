import { Controller, Get, GoneException, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { AdminOnlyGuard } from '../auth/admin-only.guard';

/**
 * /api/admin/ncm-audit — APOSENTADA (enterro do Wincred, 09/2026).
 *
 * A auditoria varria a tabela `produtos` do MySQL do Giga e aplicava UPDATE
 * lá. Com o Giga desligado (ERP_GIGA_OFF), as rotas respondiam catálogo
 * ZERADO calado — "0 produtos com problema" com cara de auditoria limpa.
 * Melhor um 410 honesto do que um relatório que mente.
 *
 * O NCM vive na tabela nativa `product` (editor de produtos / NF-e leem de
 * lá). Se um dia precisar de auditoria de NCM de novo, ela nasce sobre a
 * `product` — o NcmAuditService antigo fica no museu como referência das
 * regras de mapeamento por categoria.
 */
@UseGuards(JwtAuthGuard, AdminOnlyGuard)
@Controller('admin/ncm-audit')
export class NcmAuditController {
  private aposentada(): never {
    throw new GoneException(
      'Auditoria NCM aposentada — o NCM vive na tabela nativa product. ' +
        'A rota antiga auditava o MySQL do Giga, que foi desligado.',
    );
  }

  @Get()
  audit() {
    this.aposentada();
  }

  @Post('apply')
  apply() {
    this.aposentada();
  }

  @Get('export-sql')
  exportSql() {
    this.aposentada();
  }
}
