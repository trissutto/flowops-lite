import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { ProductsEditorService, EditChanges } from './products-editor.service';

/**
 * EDITOR DE PRODUTOS — só ADMIN (mexe no cadastro do Giga, fonte da verdade).
 */
@Controller('products-editor')
@UseGuards(JwtAuthGuard)
export class ProductsEditorController {
  constructor(private readonly svc: ProductsEditorService) {}

  private requireAdmin(req: any) {
    const role = req?.user?.role;
    if (role !== 'admin') throw new ForbiddenException('Apenas admin');
  }

  /** GET /products-editor/search?q= — variações com campos separados. */
  @Get('search')
  async search(@Req() req: any, @Query('q') q?: string) {
    this.requireAdmin(req);
    return this.svc.searchProdutos(String(q || ''));
  }

  /**
   * GET /products-editor/ref-info?ref=&exclude=cod1,cod2
   * Checa colisão antes de renomear REF (destino já usada por outro produto?).
   */
  @Get('ref-info')
  async refInfo(@Req() req: any, @Query('ref') ref?: string, @Query('exclude') exclude?: string) {
    this.requireAdmin(req);
    const excludeCodigos = String(exclude || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return this.svc.refInfo(String(ref || ''), excludeCodigos);
  }

  /**
   * GET /products-editor/historico?codigo=XXX — linha do tempo da variação:
   * vendas (Giga caixa) + devoluções/trocas (Flow), com loja, cliente e vendedora.
   */
  @Get('historico')
  async historico(@Req() req: any, @Query('codigo') codigo?: string) {
    this.requireAdmin(req);
    return this.svc.historicoProduto(String(codigo || ''));
  }

  /** POST /products-editor/apply — Body: { edits: [{ codigo, changes }] } */
  @Post('apply')
  async apply(
    @Req() req: any,
    @Body() body: { edits: Array<{ codigo: string; changes: EditChanges }> },
  ) {
    this.requireAdmin(req);
    return this.svc.apply({
      edits: body?.edits || [],
      userName: req?.user?.name || req?.user?.email || null,
    });
  }

  /**
   * POST /products-editor/apply-marca-todos — Body: { q, marca }
   * MARCA EM MASSA: aplica em TODOS os resultados da busca no servidor,
   * sem o teto de 5.000 da tela (marcas com dezenas de milhares de variações).
   */
  @Post('apply-marca-todos')
  async applyMarcaTodos(@Req() req: any, @Body() body: { q: string; marca: string }) {
    this.requireAdmin(req);
    return this.svc.applyMarcaBySearch({
      q: String(body?.q || ''),
      marca: String(body?.marca || ''),
      userName: req?.user?.name || req?.user?.email || null,
    });
  }

  /**
   * POST /products-editor/excluir — Body: { codigos: string[], forcar?: boolean }
   * Exclui produtos do Flow (imediato) e replica pro Giga (inline/outbox).
   * Código com estoque > 0 exige forcar=true. Máx. 500 por chamada. Auditado.
   */
  @Post('excluir')
  async excluir(@Req() req: any, @Body() body: { codigos?: string[]; forcar?: boolean }) {
    this.requireAdmin(req);
    return this.svc.excluirProdutos({
      codigos: body?.codigos || [],
      forcar: !!body?.forcar,
      userName: req?.user?.name || req?.user?.email || null,
    });
  }

  /**
   * POST /products-editor/movimentar
   * Body: { movimentos: [{codigo, loja, qtd, tipo: 'entrada'|'saida', motivo}] }
   * Entrada/saída manual com motivo obrigatório. Flow é a fonte; Giga réplica.
   */
  @Post('movimentar')
  async movimentar(
    @Req() req: any,
    @Body() body: { movimentos?: Array<{ codigo: string; loja: string; qtd: number; tipo: 'entrada' | 'saida'; motivo: string }> },
  ) {
    this.requireAdmin(req);
    return this.svc.movimentarEstoque({
      movimentos: body?.movimentos || [],
      userName: req?.user?.name || req?.user?.email || null,
    });
  }

  /** INCIDENTE 14/07 — diagnóstico do estrago da DATAALT. */
  @Get('dataalt-diagnostico')
  async dataAltDiag(@Req() req: any) {
    this.requireAdmin(req);
    return this.svc.dataAltDiagnostico();
  }

  /**
   * POST /products-editor/restaurar-dataalt
   * Body: { source: 'native' } OU { pairs: [{codigo, dataAlt:'YYYY-MM-DD'}] }
   * Restaura a data de cadastro original (promo Liquida Antigos).
   */
  @Post('restaurar-dataalt')
  async restaurarDataAlt(
    @Req() req: any,
    @Body() body: { source?: 'native' | 'ref'; pairs?: Array<{ codigo: string; dataAlt: string }> },
  ) {
    this.requireAdmin(req);
    return this.svc.restaurarDataAlt({
      source: body?.source,
      pairs: body?.pairs,
      userName: req?.user?.name || req?.user?.email || null,
    });
  }

  /**
   * POST /products-editor/restaurar-dataalt-backup — Body: { url }
   * Lê codigo→dataAlt do Postgres TEMPORÁRIO (restaurado do backup) e
   * restaura os códigos ainda sujos. Roda em background.
   */
  @Post('restaurar-dataalt-backup')
  async restaurarDataAltBackup(@Req() req: any, @Body() body: { url?: string }) {
    this.requireAdmin(req);
    return this.svc.restaurarDataAltDeBackup({
      url: String(body?.url || ''),
      userName: req?.user?.name || req?.user?.email || null,
    });
  }

  /**
   * POST /products-editor/restaurar-dataalt-caixa — Leva 4: prova de idade
   * pela primeira venda no caixa (espelho + Giga read-only em chunks).
   */
  @Post('restaurar-dataalt-caixa')
  async restaurarDataAltCaixa(@Req() req: any) {
    this.requireAdmin(req);
    return this.svc.restaurarDataAltPorCaixa({
      userName: req?.user?.name || req?.user?.email || null,
    });
  }

  /**
   * POST /products-editor/restaurar-dataalt-arquivo
   * Body: { pairs: [{codigo, dataAlt}], zerar?: boolean }
   * PASSO 1 da auditoria por arquivo (backup 12/07): só carrega em memória,
   * NÃO escreve nada. Pode ser chamado em partes (zerar=true na primeira).
   */
  @Post('restaurar-dataalt-arquivo')
  async restaurarDataAltArquivo(
    @Req() req: any,
    @Body() body: { pairs?: Array<{ codigo: string; dataAlt: string }>; zerar?: boolean },
  ) {
    this.requireAdmin(req);
    return this.svc.carregarArquivoDataAlt(body?.pairs || [], { zerar: !!body?.zerar });
  }

  /**
   * POST /products-editor/restaurar-dataalt-arquivo/executar
   * PASSO 2: compara o catálogo inteiro do Giga com o arquivo carregado e
   * corrige toda divergência (background).
   */
  @Post('restaurar-dataalt-arquivo/executar')
  async restaurarDataAltArquivoExecutar(@Req() req: any) {
    this.requireAdmin(req);
    return this.svc.executarAuditoriaArquivo(req?.user?.name || req?.user?.email || null);
  }

  /**
   * POST /products-editor/restaurar-dataalt-nativo-espelho
   * Passo final do incidente DATAALT (14/07): corrige a data na tabela NATIVA
   * `product` (fonte do bipe com PRODUCT_NATIVE_READS=1) copiando do espelho
   * wincred_produtos já restaurado. Dry-run por padrão; { executar: true } grava.
   */
  @Post('restaurar-dataalt-nativo-espelho')
  async restaurarDataAltNativoEspelho(@Req() req: any, @Body() body: { executar?: boolean }) {
    this.requireAdmin(req);
    return this.svc.restaurarDataAltNativoDoEspelho(!!body?.executar);
  }

  /** Progresso da restauração em background. */
  @Get('restaurar-dataalt/progresso')
  async restaurarProgresso(@Req() req: any) {
    this.requireAdmin(req);
    return this.svc.restauracaoProgresso();
  }

  /** GET /products-editor/audit — histórico recente (ANTES→DEPOIS). */
  @Get('audit')
  async audit(@Req() req: any, @Query('limit') limit?: string) {
    this.requireAdmin(req);
    return this.svc.auditRecent(limit ? parseInt(limit, 10) : 200);
  }
}
