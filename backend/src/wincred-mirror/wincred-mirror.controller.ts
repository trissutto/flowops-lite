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
}
