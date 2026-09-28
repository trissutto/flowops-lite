import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { InventarioService } from './inventario.service';

/**
 * /inventario — contagem de loja.
 *
 * Quem faz o quê:
 *   · LOJA  → bipa, corrige e encerra a própria contagem. Nunca vê o esperado:
 *             a contagem é cega, senão vira conferência do que o sistema diz.
 *   · MATRIZ → abre, lê a divergência, pede recontagem, aplica o ajuste e
 *             decide o que fazer com quem não apareceu no bipe.
 *
 * A loja vem do JWT, nunca do body — senão uma loja contaria por cima do
 * estoque de outra. Matriz pode operar em nome da loja (mesmo critério das
 * outras telas).
 */
@UseGuards(JwtAuthGuard)
@Controller('inventario')
export class InventarioController {
  constructor(private readonly svc: InventarioService) {}

  private user(req: any) {
    return {
      id: req?.user?.id || req?.user?.sub || null,
      nome: req?.user?.name || req?.user?.email || null,
      role: String(req?.user?.role || ''),
      storeCode: String(req?.user?.storeCode || ''),
    };
  }

  private ehMatriz(req: any): boolean {
    return ['admin', 'operator', 'supervisor'].includes(this.user(req).role);
  }

  private exigirMatriz(req: any) {
    if (!this.ehMatriz(req)) {
      throw new ForbiddenException('Só a matriz abre, ajusta e fecha inventário');
    }
  }

  private resolverLoja(req: any, storeCodeBody?: string): string {
    const u = this.user(req);
    const escolhida = String(storeCodeBody || '').trim();
    if (escolhida && escolhida !== u.storeCode && !this.ehMatriz(req)) {
      throw new ForbiddenException('Sem permissão pra contar o estoque de outra loja');
    }
    const loja = escolhida || u.storeCode;
    if (!loja) throw new BadRequestException('Loja não identificada na sessão');
    return loja;
  }

  // ── loja ──────────────────────────────────────────────────────────────

  /** GET /inventario/loja — a contagem aberta desta loja (sem o esperado). */
  @Get('loja')
  async painelLoja(@Req() req: any, @Query('storeCode') storeCode?: string) {
    return this.svc.painelLoja(this.resolverLoja(req, storeCode));
  }

  /**
   * POST /inventario/bipar — Body: { codigo, clientId?, storeCode? }
   * `clientId` é o UUID que a tela gera ANTES do POST: reenvio por rede caída
   * não conta a peça duas vezes.
   */
  @Post('bipar')
  async bipar(
    @Req() req: any,
    @Body() body: { codigo?: string; clientId?: string; storeCode?: string; origem?: string },
  ) {
    const u = this.user(req);
    return this.svc.bipar({
      storeCode: this.resolverLoja(req, body?.storeCode),
      codigo: String(body?.codigo || ''),
      clientId: body?.clientId ?? null,
      userName: u.nome,
      origem: body?.origem === 'celular' ? 'celular' : 'pc',
    });
  }

  /** POST /inventario/corrigir — Body: { sku? } · tira 1 (o último, se sem sku). */
  @Post('corrigir')
  async corrigir(@Req() req: any, @Body() body: { sku?: string; storeCode?: string }) {
    const u = this.user(req);
    return this.svc.corrigir({
      storeCode: this.resolverLoja(req, body?.storeCode),
      sku: body?.sku,
      userName: u.nome,
    });
  }

  // ── matriz ────────────────────────────────────────────────────────────

  /** GET /inventario — as contagens, mais recente primeiro. */
  @Get()
  async listar(@Req() req: any, @Query('storeCode') storeCode?: string, @Query('limit') limit?: string) {
    /* Loja só vê as próprias; matriz vê todas. */
    const escopo = this.ehMatriz(req) ? storeCode : this.user(req).storeCode;
    return this.svc.listar({ storeCode: escopo || undefined, limit: Number(limit) || undefined });
  }

  /** POST /inventario/abrir — Body: { storeCode, nota? } */
  @Post('abrir')
  async abrir(@Req() req: any, @Body() body: { storeCode?: string; nota?: string }) {
    this.exigirMatriz(req);
    if (!body?.storeCode) throw new BadRequestException('Informe a loja do inventário');
    return this.svc.abrir({
      storeCode: body.storeCode,
      nota: body?.nota ?? null,
      userName: this.user(req).nome,
    });
  }

  /** GET /inventario/:id — o relatório: divergência, R$, não contados. */
  @Get(':id')
  async relatorio(@Req() req: any, @Param('id') id: string) {
    this.exigirMatriz(req);
    return this.svc.relatorio(id);
  }

  /** POST /inventario/:id/encerrar — a loja terminou de contar. */
  @Post(':id/encerrar')
  async encerrar(@Req() req: any, @Param('id') id: string) {
    return this.svc.encerrar(id, this.user(req).nome);
  }

  /** POST /inventario/:id/reabrir — faltou uma parte da loja. */
  @Post(':id/reabrir')
  async reabrir(@Req() req: any, @Param('id') id: string) {
    this.exigirMatriz(req);
    return this.svc.reabrir(id, this.user(req).nome);
  }

  /** POST /inventario/:id/recontagem — Body: { skus: string[] } */
  @Post(':id/recontagem')
  async recontagem(@Req() req: any, @Param('id') id: string, @Body() body: { skus?: string[] }) {
    this.exigirMatriz(req);
    return this.svc.pedirRecontagem({
      sessaoId: id,
      skus: body?.skus || [],
      userName: this.user(req).nome,
    });
  }

  /** POST /inventario/:id/aplicar — a contagem vira estoque. */
  @Post(':id/aplicar')
  async aplicar(@Req() req: any, @Param('id') id: string) {
    this.exigirMatriz(req);
    const u = this.user(req);
    return this.svc.aplicar({ sessaoId: id, userName: u.nome, userId: u.id });
  }

  /** POST /inventario/:id/zerar-nao-contados — Body: { skus: string[], motivo? } */
  @Post(':id/zerar-nao-contados')
  async zerar(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { skus?: string[]; motivo?: string },
  ) {
    this.exigirMatriz(req);
    return this.svc.zerarNaoContados({
      sessaoId: id,
      skus: body?.skus || [],
      motivo: body?.motivo ?? null,
      userName: this.user(req).nome,
    });
  }

  /** POST /inventario/:id/cancelar */
  @Post(':id/cancelar')
  async cancelar(@Req() req: any, @Param('id') id: string) {
    this.exigirMatriz(req);
    return this.svc.cancelar(id, this.user(req).nome);
  }
}
