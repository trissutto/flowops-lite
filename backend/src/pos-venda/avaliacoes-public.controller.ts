import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { CustomerJwtGuard } from '../customers-app/customer-jwt.guard';
import { PosVendaService } from './pos-venda.service';
import { PontosService } from './pontos.service';

/**
 * O QUE O SITE CONSOME — página de avaliação e bloco da PDP.
 *
 * Sem guard de propósito: a credencial é o TOKEN do convite, que chega no
 * WhatsApp e vai ser aberto no celular por cliente que muitas vezes comprou
 * como visitante. Parede de senha na frente de um pedido de favor é o jeito
 * mais rápido de não receber resposta nenhuma.
 *
 * Caminhos separados (`convite/:token` e `produto/:ref`) em vez de um
 * `:parametro` na raiz: rota ambígua é a que um dia engole a outra em silêncio.
 */
@Controller('public/avaliacoes')
export class AvaliacoesPublicController {
  constructor(private readonly svc: PosVendaService) {}

  /** GET /public/avaliacoes/produto/:ref — média + distribuição pra PDP. */
  @Get('produto/:ref')
  async doProduto(@Param('ref') ref: string, @Query('limite') limite?: string) {
    const [resumo, avaliacoes] = await Promise.all([
      this.svc.resumoDoProduto(ref),
      this.svc.avaliacoesDoProduto(ref, limite ? Number(limite) : 12),
    ]);
    return { ...resumo, avaliacoes };
  }

  /** GET /public/avaliacoes/convite/:token — o que a cliente vê ao abrir o link. */
  @Get('convite/:token')
  porToken(@Param('token') token: string) {
    return this.svc.porToken(token);
  }

  /** POST /public/avaliacoes/convite/:token/foto — endereço de upload direto. */
  @Post('convite/:token/foto')
  foto(@Param('token') token: string, @Body() body: any) {
    return this.svc.prepararFoto(token, String(body?.filename || 'foto.jpg'));
  }

  /** POST /public/avaliacoes/convite/:token — grava as respostas. */
  @Post('convite/:token')
  registrar(@Param('token') token: string, @Body() body: any) {
    return this.svc.registrarAvaliacoes(token, body ?? {});
  }
}

/**
 * MEUS PONTOS — a tela da conta da cliente.
 *
 * Saldo sem extrato é um número que ela não sabe de onde veio; e número que ela
 * não entende, ela não gasta. A mesma lição da tela de cashback.
 */
@Controller('me/pontos')
@UseGuards(CustomerJwtGuard)
export class PontosClienteController {
  constructor(
    private readonly pontos: PontosService,
    private readonly posVenda: PosVendaService,
  ) {}

  @Get()
  async extrato(@Req() req: any) {
    const cfg = await this.posVenda.lerConfig();
    const extrato = await this.pontos.extrato(req.customer?.cpf);
    return {
      ...extrato,
      regras: {
        pontosPorAvaliacao: cfg.pontosPorAvaliacao,
        pontosComFoto: cfg.pontosPorAvaliacao * cfg.multiplicadorFoto,
        pontosPorReal: cfg.pontosPorReal,
        minimoResgate: cfg.minimoResgate,
      },
      /** Quanto o saldo vale HOJE, em reais — a conta feita pra ela. */
      valeEmReais: Math.floor(extrato.saldo / cfg.pontosPorReal),
    };
  }

  /** POST /me/pontos/resgatar — { pontos } → cupom nominal, só do CPF dela. */
  @Post('resgatar')
  async resgatar(@Req() req: any, @Body() body: any) {
    const cfg = await this.posVenda.lerConfig();
    return this.pontos.resgatar({
      cpf: req.customer?.cpf,
      pontos: Number(body?.pontos) || 0,
      pontosPorReal: cfg.pontosPorReal,
      minimoResgate: cfg.minimoResgate,
    });
  }
}
