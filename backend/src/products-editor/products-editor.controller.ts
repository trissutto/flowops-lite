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

  /** Matriz vê custo e margem; loja vê venda e estoque. */
  private ehMatriz(req: any): boolean {
    return ['admin', 'operator', 'supervisor'].includes(String(req?.user?.role || ''));
  }

  /**
   * GET /products-editor/ficha-search?q= — a MESMA busca, para a tela de
   * Produtos (`/retaguarda/produtos`).
   *
   * Existe separada da `search` acima por um motivo de segurança: aquela é
   * `requireAdmin` porque vive num controller que também apaga e movimenta
   * estoque. A tela de Produtos precisa abrir pra gerente de loja, e afrouxar
   * o guard do controller inteiro pra isso abriria junto o que não deve.
   *
   * ⚠️ CUSTO E MARGEM SÃO PODADOS NO SERVIDOR pra quem não é matriz. Esconder
   * só no front deixaria o número viajando na resposta, visível em qualquer
   * aba de rede.
   */
  @Get('ficha-search')
  async fichaSearch(@Req() req: any, @Query('q') q?: string) {
    const resp: any = await this.svc.searchProdutos(String(q || ''));
    if (this.ehMatriz(req)) return resp;
    const rows = (resp?.rows || []).map((r: any) => {
      const { custo, margem, ...semCusto } = r || {};
      return semCusto;
    });
    return { ...resp, rows };
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

  /** GET /products-editor/audit — histórico recente (ANTES→DEPOIS). */
  @Get('audit')
  async audit(@Req() req: any, @Query('limit') limit?: string) {
    this.requireAdmin(req);
    return this.svc.auditRecent(limit ? parseInt(limit, 10) : 200);
  }
}
