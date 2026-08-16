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
import { DefeitosService, MOTIVOS_DEFEITO } from './defeitos.service';
import { isTrainingRequest } from '../pdv/training.util';

/**
 * /defeitos — registro de peça avariada.
 *
 * Loja registra e fecha a caixa; a matriz recebe e decide (fase 3).
 *
 * A LOJA vem do JWT, nunca do body: senão uma loja poderia baixar estoque
 * de outra. Admin/supervisor podem informar `storeCode` explícito porque a
 * matriz opera em nome das lojas (mesmo critério das outras telas).
 */
@UseGuards(JwtAuthGuard)
@Controller('defeitos')
export class DefeitosController {
  constructor(private readonly svc: DefeitosService) {}

  private user(req: any) {
    return {
      id: req?.user?.id || req?.user?.sub || null,
      nome: req?.user?.name || req?.user?.email || null,
      role: req?.user?.role || '',
      storeCode: req?.user?.storeCode || '',
    };
  }

  /** Loja alvo da operação — do JWT, com override só pra matriz. */
  private resolverLoja(req: any, storeCodeBody?: string): string {
    const u = this.user(req);
    const podeEscolher = ['admin', 'supervisor', 'operator'].includes(u.role);
    const escolhida = String(storeCodeBody || '').trim();
    if (escolhida && escolhida !== u.storeCode && !podeEscolher) {
      throw new ForbiddenException('Sem permissão pra registrar defeito de outra loja');
    }
    const loja = escolhida || u.storeCode;
    if (!loja) throw new BadRequestException('Loja não identificada na sessão');
    return loja;
  }

  /** Lista de motivos pro seletor da tela — fonte única, sem duplicar no front. */
  @Get('motivos')
  motivos() {
    return MOTIVOS_DEFEITO.map((m) => ({
      valor: m,
      label: m
        .split('_')
        .map((p) => p.charAt(0) + p.slice(1).toLowerCase())
        .join(' '),
      exigeObservacao: m === 'OUTRO',
    }));
  }

  /**
   * POST /defeitos — registra a peça e baixa o estoque da loja.
   * Devolve o registro com o número de controle (DEF-AAAA-NNNNNN).
   */
  @Post()
  async registrar(
    @Req() req: any,
    @Body()
    body: {
      sku: string;
      motivo: string;
      observacao?: string;
      fotoUrl?: string;
      storeCode?: string;
      storeName?: string;
      origem?: 'LOJA' | 'DEVOLUCAO_CLIENTE' | 'MATRIZ';
      returnId?: string;
    },
  ) {
    const u = this.user(req);
    return this.svc.registrar({
      sku: body?.sku,
      motivo: body?.motivo,
      observacao: body?.observacao ?? null,
      fotoUrl: body?.fotoUrl ?? null,
      storeCode: this.resolverLoja(req, body?.storeCode),
      storeName: body?.storeName ?? null,
      origem: body?.origem || 'LOJA',
      returnId: body?.returnId ?? null,
      userId: u.id,
      userName: u.nome,
      // Treino nunca toca estoque real — mesma trava do PDV.
      isTraining: isTrainingRequest(req),
    });
  }

  /** GET /defeitos/caixa-atual — a caixa aberta da loja + suas peças. */
  @Get('caixa-atual')
  async caixaAtual(@Req() req: any, @Query('storeCode') storeCode?: string) {
    return this.svc.caixaAtual(this.resolverLoja(req, storeCode));
  }

  /** POST /defeitos/caixas/:id/fechar — congela a caixa pra viajar. */
  @Post('caixas/:id/fechar')
  async fecharCaixa(@Req() req: any, @Param('id') id: string) {
    return this.svc.fecharCaixa(id, this.user(req).nome);
  }

  /** GET /defeitos/caixas/:id/romaneio — lista impressa que vai na caixa. */
  @Get('caixas/:id/romaneio')
  async romaneio(@Param('id') id: string) {
    return this.svc.romaneio(id);
  }

  // ── Matriz ────────────────────────────────────────────────────────────
  // Receber, decidir e o reverso do conserto. Só matriz opera aqui: a loja
  // registra e manda, quem decide o destino da mercadoria é o CD.

  private requireMatriz(req: any) {
    if (!['admin', 'supervisor', 'operator'].includes(this.user(req).role)) {
      throw new ForbiddenException('Apenas matriz (admin/supervisor/operator)');
    }
  }

  /** POST /defeitos/caixas/:id/receber — bipe de conferência na chegada. */
  @Post('caixas/:id/receber')
  async receberPeca(
    @Req() req: any,
    @Param('id') batchId: string,
    @Body() body: { codigo: string },
  ) {
    this.requireMatriz(req);
    return this.svc.receberPeca({
      batchId,
      codigo: body?.codigo,
      userName: this.user(req).nome,
    });
  }

  /**
   * POST /defeitos/caixas/:id/fechar-conferencia
   * Peça não bipada continua EM_TRANSITO de propósito — é assim que "sumiu
   * no caminho" aparece no relatório em vez de virar silêncio.
   */
  @Post('caixas/:id/fechar-conferencia')
  async fecharConferencia(@Req() req: any, @Param('id') batchId: string) {
    this.requireMatriz(req);
    return this.svc.fecharConferencia(batchId, this.user(req).nome);
  }

  /** POST /defeitos/decidir — devolver ao fornecedor · descartar · mandar consertar. */
  @Post('decidir')
  async decidir(
    @Req() req: any,
    @Body() body: { itemIds: string[]; decisao: string; observacao?: string },
  ) {
    this.requireMatriz(req);
    return this.svc.decidir({
      itemIds: body?.itemIds || [],
      decisao: body?.decisao,
      observacao: body?.observacao ?? null,
      userName: this.user(req).nome,
    });
  }

  /**
   * POST /defeitos/:id/recuperar — voltou da costureira.
   * ÚNICO caminho em que o estoque reentra: a peça volta pra loja que a
   * mandou (decisão do dono, 14/08).
   */
  @Post(':id/recuperar')
  async recuperar(
    @Req() req: any,
    @Param('id') itemId: string,
    @Body() body: { observacao?: string },
  ) {
    this.requireMatriz(req);
    return this.svc.recuperarDoConserto({
      itemId,
      observacao: body?.observacao ?? null,
      userName: this.user(req).nome,
    });
  }
}
