import { Body, Controller, ForbiddenException, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { CorreiosService } from './correios.service';

@Controller('correios')
@UseGuards(JwtAuthGuard)
export class CorreiosController {
  constructor(private readonly svc: CorreiosService) {}

  private requireRole(req: any) {
    const role = req?.user?.role;
    if (!['admin', 'operator', 'store'].includes(role)) {
      throw new ForbiddenException('Sem permissão');
    }
  }

  /** Status da integração (configurado? ambiente? cartão?). */
  @Get('status')
  status(@Req() req: any) {
    this.requireRole(req);
    return this.svc.status();
  }

  /** Frete (preço + prazo) por CEP destino. */
  @Get('frete')
  frete(
    @Req() req: any,
    @Query('cep') cep: string,
    @Query('peso') peso?: string,
    @Query('comprimento') comprimento?: string,
    @Query('largura') largura?: string,
    @Query('altura') altura?: string,
  ) {
    this.requireRole(req);
    return this.svc.calcularFrete({
      cepDestino: cep,
      pesoGramas: peso ? Number(peso) : undefined,
      comprimento: comprimento ? Number(comprimento) : undefined,
      largura: largura ? Number(largura) : undefined,
      altura: altura ? Number(altura) : undefined,
    });
  }

  /** Cria a pré-postagem de um envio (gera o código de rastreio). */
  @Post('prepostagem')
  prepostagem(@Req() req: any, @Body() body: any) {
    this.requireRole(req);
    return this.svc.criarPrepostagem(body);
  }

  /** Baixa a etiqueta (rótulo PDF) de uma pré-postagem. */
  @Post('etiqueta')
  etiqueta(@Req() req: any, @Body() body: { idPrepostagem: string }) {
    this.requireRole(req);
    return this.svc.baixarEtiqueta(body?.idPrepostagem);
  }

  /** Baixa a declaração de conteúdo (PDF) de uma pré-postagem. */
  @Post('declaracao')
  declaracao(@Req() req: any, @Body() body: { idPrepostagem: string }) {
    this.requireRole(req);
    return this.svc.baixarDeclaracaoConteudo(body?.idPrepostagem);
  }

  /** DEBUG: pré-postagem crua da Correios (pra inspecionar se a DC-e/QR foi emitida). */
  @Get('prepostagem-debug')
  prepostagemDebug(@Req() req: any, @Query('id') id: string) {
    this.requireRole(req);
    return this.svc.prepostagemRaw(id);
  }

  /** Rastreia um objeto pelo código. */
  @Get('rastreio')
  rastreio(@Req() req: any, @Query('codigo') codigo: string) {
    this.requireRole(req);
    return this.svc.rastrear(codigo);
  }

  /** Busca endereço por CEP (autopreenchimento de remetente/destinatário). */
  @Get('cep')
  cep(@Req() req: any, @Query('cep') cep: string) {
    this.requireRole(req);
    return this.svc.buscarCep(cep);
  }

  /** DEBUG PRC-124: mostra a que contrato/DR o token de acesso pertence. */
  @Get('token-debug')
  tokenDebug(@Req() req: any) {
    this.requireRole(req);
    return this.svc.tokenDebug();
  }
}
