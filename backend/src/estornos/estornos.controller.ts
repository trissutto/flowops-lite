import { Body, Controller, Get, Headers, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { AdminOnly, AdminOnlyGuard } from '../auth/admin-only.guard';
import { EstornosService } from './estornos.service';
import { EstornoComprovanteService } from './estorno-comprovante.service';
import { AtorEstorno, EstornosAcessoService } from './estornos-acesso.service';
import { EstornosExportService } from './estornos-export.service';
import { MOTIVOS_ESTORNO, TipoEstorno, rotuloDoMotivo } from '../common/estornos';

/**
 * ESTORNOS E DEVOLUÇÕES — `/admin/estornos`. Matriz + senha (22/09/2026).
 *
 * Duas portas em série, as duas pedidas pelo dono:
 *   1. **a role** — `@AdminOnly()` (admin/operator da matriz). Vendedora de
 *      loja não enxerga a tela nem a rota;
 *   2. **a senha MASTER ou SUPREMA** — na entrada (que devolve um bilhete de
 *      15 min pras LEITURAS) e **de novo em cada operação de dinheiro**:
 *      pedir estorno e mandar o comprovante pra cliente.
 *
 * A senha viaja no CORPO do POST, nunca na URL, e não é gravada em lugar
 * nenhum — só o nível usado e, quando foi PIN pessoal, quem autorizou. Toda
 * tentativa, inclusive a que falhou, vira linha em `estornos_eventos`.
 */
@Controller('admin/estornos')
@UseGuards(JwtAuthGuard, AdminOnlyGuard)
@AdminOnly()
export class EstornosController {
  constructor(
    private readonly estornos: EstornosService,
    private readonly comprovantes: EstornoComprovanteService,
    private readonly acesso: EstornosAcessoService,
    private readonly exportacao: EstornosExportService,
  ) {}

  /** Quem está operando — vai inteiro pro log (usuário, IP e aparelho). */
  private ator(req: any): AtorEstorno {
    const u = req?.user || {};
    const encaminhado = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
    return {
      userId: u.userId || u.sub || u.id || null,
      nome: u.name || u.email || null,
      ip: encaminhado || String(req?.ip || '').trim() || null,
      dispositivo: String(req?.headers?.['user-agent'] || '').slice(0, 200) || null,
    };
  }

  // ── Porta ─────────────────────────────────────────────────────────────────

  /** POST /sessao — a senha da entrada. Devolve o bilhete de 15 min. */
  @Post('sessao')
  async abrirSessao(@Body() body: { password?: string }, @Req() req: any) {
    return this.acesso.abrirSessao(body?.password, this.ator(req));
  }

  /** GET /motivos — a lista fechada + quem exige descrição. */
  @Get('motivos')
  motivos() {
    return { motivos: MOTIVOS_ESTORNO.map((m) => ({ ...m, exigeTexto: m.codigo === 'outros' })) };
  }

  // ── Busca e detalhe (leitura: exige o bilhete) ────────────────────────────

  /** GET /buscar — pedido, nome, CPF, e-mail ou código da transação. */
  @Get('buscar')
  async buscar(@Query() q: any, @Headers('x-estorno-sessao') token: string) {
    this.acesso.exigirSessao(token);
    return this.estornos.buscar({
      termo: q?.termo,
      origem: q?.origem,
      metodo: q?.metodo,
      de: q?.de,
      ate: q?.ate,
      limite: q?.limite ? Number(q.limite) : undefined,
    });
  }

  /** GET /pagamento/:id — a ficha, com o saldo lido AO VIVO no gateway. */
  @Get('pagamento/:pagamentoId')
  async pagamento(@Param('pagamentoId') pagamentoId: string, @Headers('x-estorno-sessao') token: string) {
    this.acesso.exigirSessao(token);
    return this.estornos.detalhe(pagamentoId);
  }

  // ── A operação (senha de novo) ────────────────────────────────────────────

  /**
   * POST /solicitar — pede o estorno ao gateway.
   *
   * `operacaoId` é a trava do duplo clique: a tela sorteia um por clique e a
   * mesma chave nunca cobra duas vezes (vale de ponta a ponta — é ela que vira
   * o `x-idempotency-key` do PagBank).
   */
  @Post('solicitar')
  async solicitar(
    @Body()
    body: {
      pagamentoId: string;
      tipo: TipoEstorno;
      valorCents?: number;
      motivo: string;
      motivoTexto?: string;
      observacao?: string;
      operacaoId?: string;
      password?: string;
    },
    @Req() req: any,
  ) {
    const ator = this.ator(req);
    const auth = await this.acesso.autorizar({
      password: body?.password,
      ator,
      acao: `estorno ${body?.tipo || '?'} · ${rotuloDoMotivo(body?.motivo)}`,
    });
    const r = await this.estornos.solicitar({
      pagamentoId: body.pagamentoId,
      tipo: body.tipo === 'integral' ? 'integral' : 'parcial',
      valorCents: body.valorCents,
      motivo: body.motivo,
      motivoTexto: body.motivoTexto,
      observacao: body.observacao,
      operacaoId: body.operacaoId,
      ator,
      nivel: auth.level,
      autorizadoPorNome: auth.byNome,
      autorizadoPorCpf: auth.byCpf,
    });
    return { ...r, mensagem: this.fraseDoResultado(r.estorno) };
  }

  /** A frase que a tela mostra — a do GATEWAY, não a nossa vontade. */
  private fraseDoResultado(e: any): string {
    switch (String(e?.status)) {
      case 'processado':
        return 'Estorno processado pelo gateway.';
      case 'processando':
      case 'enviado':
        return 'Estorno solicitado e aguardando processamento do PagBank.';
      case 'recusado':
        return `O gateway recusou o estorno${e?.mensagemGateway ? `: ${e.mensagemGateway}` : '.'}`;
      default:
        return 'Não foi possível concluir o estorno agora. Nada foi marcado como devolvido — consulte o status.';
    }
  }

  /** POST /:id/consultar — relê a cobrança e atualiza o status. */
  @Post(':id/consultar')
  async consultar(@Param('id') id: string, @Headers('x-estorno-sessao') token: string, @Req() req: any) {
    this.acesso.exigirSessao(token);
    return this.estornos.consultar(id, this.ator(req));
  }

  /** GET /:id — o estorno em si (a tela de resultado). */
  @Get('estorno/:id')
  async porId(@Param('id') id: string, @Headers('x-estorno-sessao') token: string) {
    this.acesso.exigirSessao(token);
    return this.estornos.porId(id);
  }

  /**
   * GET /pedido/:refId — o bloco "Estornos deste pedido" da ficha do pedido.
   *
   * Esta é a ÚNICA rota do módulo sem o bilhete de 15 min, e de propósito: é
   * leitura de "quanto já voltou neste pedido" pra quem já está olhando o
   * pedido inteiro (matriz, mesma role). Sem ela, a pessoa que atende a
   * cliente não enxerga o estorno e pede outro — pagar duas vezes o mesmo
   * estorno é o erro que a tela existe pra evitar. Operação continua pedindo
   * senha.
   */
  @Get('pedido/:refId')
  async doPedido(@Param('refId') refId: string) {
    const linhas = await this.estornos.historicoDoPedido(refId);
    return {
      estornos: linhas.map((e: any) => ({
        id: e.id,
        status: e.status,
        tipo: e.tipo,
        valorCents: e.valorCents,
        metodo: e.metodo,
        motivo: e.motivo,
        motivoLabel: rotuloDoMotivo(e.motivo),
        criadoEm: e.createdAt,
        processadoEm: e.processadoEm,
        usuarioNome: e.usuarioNome,
      })),
    };
  }

  // ── Comprovante ───────────────────────────────────────────────────────────

  /**
   * GET /:id/comprovante — o PDF. Só sai com o gateway tendo confirmado ou
   * aceitado (estorno em aberto é reconsultado no gateway antes de imprimir).
   *
   * É LEITURA: falhou, a pessoa clica de novo — nada do estorno é criado,
   * repetido ou alterado por esta rota. As três portas continuam na frente:
   * JWT + role da matriz (guards da classe) + o bilhete de 15 min.
   */
  @Get(':id/comprovante')
  async comprovante(
    @Param('id') id: string,
    @Headers('x-estorno-sessao') token: string,
    @Req() req: any,
    @Res() res: Response,
  ) {
    this.acesso.exigirSessao(token);
    const { buffer, filename } = await this.comprovantes.gerar(id, this.ator(req));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Content-Length', String(buffer.length));
    // Dado pessoal da cliente: nenhum proxy ou navegador guarda cópia.
    res.setHeader('Cache-Control', 'no-store');
    res.send(buffer);
  }

  /** POST /:id/comprovante/email — manda pra cliente com o PDF anexado. */
  @Post(':id/comprovante/email')
  async enviarComprovante(
    @Param('id') id: string,
    @Body() body: { para?: string; password?: string },
    @Req() req: any,
  ) {
    const ator = this.ator(req);
    await this.acesso.autorizar({ password: body?.password, ator, acao: 'enviar comprovante de estorno' });
    return this.comprovantes.enviarPorEmail(id, body?.para, ator);
  }

  // ── Histórico geral, exportação e auditoria ───────────────────────────────

  /** GET /historico — a tela "Histórico Geral", com os totais do MESMO recorte. */
  @Get('historico')
  async historico(@Query() q: any, @Headers('x-estorno-sessao') token: string) {
    this.acesso.exigirSessao(token);
    return this.estornos.historico({
      termo: q?.termo,
      origem: q?.origem,
      metodo: q?.metodo,
      status: q?.status,
      de: q?.de,
      ate: q?.ate,
      limite: q?.limite ? Number(q.limite) : undefined,
    });
  }

  /** GET /historico/exportar?formato=csv|xlsx|pdf — respeitando os filtros da tela. */
  @Get('historico/exportar')
  async exportar(@Query() q: any, @Headers('x-estorno-sessao') token: string, @Res() res: Response) {
    this.acesso.exigirSessao(token);
    const { linhas } = await this.estornos.historico({ ...q, limite: 5000 });
    const formato = String(q?.formato || 'csv').toLowerCase();
    const { buffer, filename, contentType } = await this.exportacao.exportar(formato, linhas, {
      de: q?.de,
      ate: q?.ate,
    });
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }

  /**
   * GET /auditoria — o log de segurança, inteiro e só de leitura.
   *
   * Não existe rota de apagar linha daqui, nem pra admin: "o histórico de
   * auditoria não deverá ser apagável por usuários comuns" (ordem do dono) —
   * então ninguém apaga pela aplicação.
   */
  @Get('auditoria')
  async auditoria(@Query() q: any, @Headers('x-estorno-sessao') token: string) {
    this.acesso.exigirSessao(token);
    return { eventos: await this.estornos.auditoria({ estornoId: q?.estornoId, tipo: q?.tipo, limite: q?.limite }) };
  }
}
