import { Body, Controller, ForbiddenException, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { authorizeMinLevel } from '../auth/auth-levels.util';
import { ClientesGigaService } from './clientes-giga.service';
import { ClientesLimpezaService } from './clientes-limpeza.service';

/**
 * /admin/clientes-giga — importação completa da tabela `clientes` do Giga.
 * Matriz-only. Primeira carga: POST /sync (pode levar alguns minutos).
 * GET /sample mostra TODAS as colunas originais — insumo pra tela de consulta.
 */
@Controller('admin/clientes-giga')
@UseGuards(JwtAuthGuard)
export class ClientesGigaController {
  constructor(
    private readonly svc: ClientesGigaService,
    private readonly limpeza: ClientesLimpezaService,
  ) {}

  private requireAdmin(req: any) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'operator') {
      throw new ForbiddenException('Apenas matriz (admin/operator)');
    }
  }

  /** Dispara em background — responde na hora; acompanhar em GET /status. */
  @Post('sync')
  sync(@Req() req: any) {
    this.requireAdmin(req);
    return this.svc.startBackground();
  }

  @Get('status')
  status(@Req() req: any) {
    this.requireAdmin(req);
    return this.svc.status();
  }

  /** Re-roda só a vinculação com o Customer mestre (ex.: após dedup no CRM). */
  @Post('vincular')
  vincular(@Req() req: any) {
    this.requireAdmin(req);
    return this.svc.vincular();
  }

  // ── LIMPEZA DE CLIENTES (painel, 20/08) ──

  /** Grupos de fichas duplicadas na MESMA loja (mesmo CPF), com sugestão. */
  @Get('limpeza/duplicatas')
  limpezaDuplicatas(@Req() req: any) {
    this.requireAdmin(req);
    return this.limpeza.duplicatas();
  }

  /** Mantém uma ficha do grupo e arquiva as demais (copia o valioso antes). */
  @Post('limpeza/duplicatas/resolver')
  limpezaResolver(
    @Req() req: any,
    @Body() body: { loja: string; cpf: string; manterCodigo: string },
  ) {
    this.requireAdmin(req);
    const usuario = req?.user?.name || req?.user?.email || 'matriz';
    return this.limpeza.resolverDuplicata({ ...body, usuario });
  }

  /** Fichas sem CPF + candidatos do CRM (telefone/nome). */
  @Get('limpeza/sem-cpf')
  limpezaSemCpf(@Req() req: any, @Query('page') page?: string) {
    this.requireAdmin(req);
    return this.limpeza.semCpf(Number(page) || 1);
  }

  /** Copia o CPF da pessoa do CRM pra ficha (caso Rafaela). */
  @Post('limpeza/copiar-cpf')
  limpezaCopiarCpf(
    @Req() req: any,
    @Body() body: { loja: string; codigo: string; customerId: string },
  ) {
    this.requireAdmin(req);
    const usuario = req?.user?.name || req?.user?.email || 'matriz';
    return this.limpeza.copiarCpf({ ...body, usuario });
  }

  @Get('sample')
  sample(@Req() req: any, @Query('limit') limit?: string) {
    this.requireAdmin(req);
    return this.svc.sample(Number(limit) || 3);
  }

  /** Busca unificada (nome/CPF/fone/código) — agrupada por PESSOA. */
  @Get('search')
  search(@Req() req: any, @Query('q') q?: string) {
    this.requireAdmin(req);
    return this.svc.search(q || '');
  }

  /** Ficha completa da pessoa (todas as lojas + CRM + parcelas em aberto). */
  @Get('pessoa')
  pessoa(@Req() req: any, @Query('loja') loja?: string, @Query('codigo') codigo?: string) {
    this.requireAdmin(req);
    return this.svc.pessoa(String(loja || ''), String(codigo || ''));
  }

  /** Histórico completo (lojas espelhadas + PDV + site + live + devoluções). */
  @Get('historico')
  historico(@Req() req: any, @Query('loja') loja?: string, @Query('codigo') codigo?: string) {
    this.requireAdmin(req);
    return this.svc.historico(String(loja || ''), String(codigo || ''));
  }

  /** EDITA uma ficha (Flow = fonte; Giga recebe réplica via outbox). */
  @Post('ficha/editar')
  editar(
    @Req() req: any,
    @Body() body: { loja: string; codigo: string; campos: Record<string, any> },
  ) {
    this.requireAdmin(req);
    return this.svc.editarFicha(
      String(body?.loja || ''), String(body?.codigo || ''), body?.campos || {},
      req?.user?.name || req?.user?.email || null,
    );
  }

  /** CADASTRA cliente novo no Flow (código 500001+; réplica pro Giga). */
  @Post('cadastro')
  cadastrar(@Req() req: any, @Body() body: { loja: string; campos: Record<string, any> }) {
    this.requireAdmin(req);
    return this.svc.cadastrar(
      String(body?.loja || ''), body?.campos || {},
      req?.user?.name || req?.user?.email || null,
    );
  }

  /** RESUMO da cliente: crediário, marcados AO VIVO, limite, cashback, pode marcar. */
  /** Histórico COMPLETO de marcados da pessoa (ativos + fechados + devolvidos
   *  + baixados com motivo/quem) — tabela nativa `marcados`. */
  @Get('marcados-historico')
  marcadosHistorico(@Req() req: any, @Query('loja') loja?: string, @Query('codigo') codigo?: string) {
    this.requireAdmin(req);
    return this.svc.marcadosHistorico(String(loja || ''), String(codigo || ''));
  }

  @Get('resumo')
  resumo(@Req() req: any, @Query('loja') loja?: string, @Query('codigo') codigo?: string) {
    this.requireAdmin(req);
    return this.svc.resumo(String(loja || ''), String(codigo || ''));
  }

  /** Campos SENSÍVEIS (limite/avaliação/bloqueado) — exige senha GERENTE+.
   *  Registra QUEM autorizou (PIN pessoal) na ficha. */
  @Post('ficha/restrito')
  restrito(
    @Req() req: any,
    @Body() body: {
      loja: string; codigo: string; password: string;
      campos: { LIMITECOMPRAS?: string; AVALIACAO?: string; BLOQUEADO?: string };
    },
  ) {
    this.requireAdmin(req);
    // Lança 403 se senha inválida ou nível < GERENTE; devolve quem autorizou.
    const auth = authorizeMinLevel(String(body?.password || ''), 'GERENTE', String(body?.loja || req?.user?.storeCode || '') || undefined);
    const permitidos: Record<string, any> = {};
    for (const k of ['LIMITECOMPRAS', 'AVALIACAO', 'BLOQUEADO'] as const) {
      if (body?.campos?.[k] !== undefined) permitidos[k] = body.campos[k];
    }
    const quem = auth.byNome || req?.user?.name || req?.user?.email || 'gerente';
    return this.svc.editarFicha(
      String(body?.loja || ''), String(body?.codigo || ''), permitidos,
      `[${auth.level}] ${quem}`,
    );
  }
}

/**
 * /pdv/clientes-giga — operações de cliente acessíveis do CAIXA (role store).
 * Caso Jéssica (23/07): cliente com ficha em OUTRA loja precisa de ficha
 * NESTA loja pro crediário — o caixa copia com 1 clique no banner.
 */
@Controller('pdv/clientes-giga')
@UseGuards(JwtAuthGuard)
export class ClientesGigaPdvController {
  constructor(private readonly svc: ClientesGigaService) {}

  private requireRole(req: any) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'operator' && role !== 'store') {
      throw new ForbiddenException('Acesso negado');
    }
  }

  /** Copia a ficha de outra loja pra loja informada (idempotente por CPF). */
  @Post('copiar-para-loja')
  copiarParaLoja(
    @Req() req: any,
    @Body() body: {
      lojaOrigem: string;
      codigoOrigem: string;
      lojaDestino?: string;
      nome?: string;
      cpf?: string;
    },
  ) {
    this.requireRole(req);
    const lojaDestino = String(body?.lojaDestino || req?.user?.storeCode || '');
    return this.svc.copiarParaLoja({
      lojaOrigem: String(body?.lojaOrigem || ''),
      codigoOrigem: String(body?.codigoOrigem || ''),
      lojaDestino,
      nome: body?.nome || null,
      cpf: body?.cpf || null,
      userName: req?.user?.name || req?.user?.email || null,
    });
  }

  /**
   * NÍVEL 3 — ficha de CREDIÁRIO criada do BALCÃO (01/08/2026).
   *
   * Até agora o cadastro completo era `requireAdmin`, então a vendedora via
   * "cadastre no Wincred antes de fazer crediário" — num Wincred que ninguém
   * usa mais. A ficha de crediário é por loja (o crediário é cobrado por loja),
   * por isso nasce aqui e não no CRM.
   *
   * ── POR QUE O LIMITE PEDE SENHA ──
   * Preencher emprego e renda é trabalho de atendimento. Definir LIMITE e
   * AVALIAÇÃO é decisão de crédito — quanto a cliente pode dever. Deixar isso
   * na mão de quem está com a cliente na frente é pressão que não se deve
   * colocar em ninguém. A senha põe a decisão em quem responde por ela, sem
   * mandar a cliente voltar outro dia.
   *
   * Sem senha, a ficha é criada com limite ZERO e avaliação em branco: a
   * cliente fica cadastrada e a retaguarda libera depois.
   */
  @Post('cadastro-crediario')
  async cadastroCrediario(
    @Req() req: any,
    @Body() body: {
      loja?: string;
      campos: Record<string, any>;
      /** Senha de supervisor — obrigatória só pra definir limite/avaliação. */
      senhaSupervisor?: string;
    },
  ) {
    this.requireRole(req);
    const loja = String(body?.loja || req?.user?.storeCode || '');
    if (!loja) throw new ForbiddenException('Usuário sem loja vinculada');

    const campos = { ...(body?.campos || {}) };
    const querLimite =
      Number(String(campos.LIMITECOMPRAS ?? '').replace(',', '.')) > 0 ||
      String(campos.AVALIACAO ?? '').trim() !== '';

    let liberadoPor: string | null = null;
    if (querLimite) {
      if (!body?.senhaSupervisor) {
        // Não recusa a ficha: cria sem crédito e avisa. A cliente sai
        // cadastrada e a venda à vista segue normal.
        delete campos.LIMITECOMPRAS;
        delete campos.AVALIACAO;
      } else {
        // Lança 403 se a senha for inválida ou de nível insuficiente.
        // Mesmo mecanismo que a retaguarda já usa pra editar limite —
        // e registra QUEM liberou, não só que alguém liberou.
        const auth = authorizeMinLevel(String(body.senhaSupervisor), 'SUPERVISOR', loja);
        liberadoPor = `[${auth.level}] ${auth.byNome || 'supervisor'}`;
      }
    }

    const r = await this.svc.cadastrar(
      loja,
      campos,
      req?.user?.name || req?.user?.email || null,
    );

    return {
      ...r,
      // A tela usa isto pra dizer à vendedora o que de fato aconteceu, em vez
      // de ela descobrir na hora de fechar o crediário.
      limiteDefinido: !!liberadoPor,
      liberadoPor,
      aviso: querLimite && !liberadoPor
        ? 'Ficha criada SEM limite de crédito — precisa de senha de supervisor. A retaguarda pode liberar depois.'
        : null,
    };
  }
}
