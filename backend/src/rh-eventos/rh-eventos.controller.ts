import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { RhEventosService } from './rh-eventos.service';

/**
 * /rh/eventos — atestado, falta, férias, treinamento, advertência.
 *
 * QUEM LANÇA É A SUPERVISÃO (decisão do dono, 28/08/2026): matriz apenas —
 * `admin`, `operator`, `supervisor`. Não há pedir/aprovar; lançou, vale.
 *
 * A LOJA (`role=store`) só LÊ, e só a própria loja: a gerente precisa saber
 * quem está de atestado hoje pra montar a escala, mas não lança nada — evento
 * de RH mexe em folha e em prova trabalhista.
 *
 *   GET   /rh/eventos/tipos                    lista fechada pro seletor
 *   GET   /rh/eventos?sellerId=&de=&ate=       lista com recorte De/Até
 *   GET   /rh/eventos/hoje?storeId=            quem está fora hoje
 *   POST  /rh/eventos                          lança (supervisão)
 *   PATCH /rh/eventos/:id                      corrige período/horas
 *   POST  /rh/eventos/:id/cancelar             cancela (nunca deleta)
 */
@UseGuards(JwtAuthGuard)
@Controller('rh/eventos')
export class RhEventosController {
  constructor(private readonly svc: RhEventosService) {}

  private user(req: any) {
    return {
      id: req?.user?.id || req?.user?.sub || null,
      nome: req?.user?.name || req?.user?.email || null,
      role: String(req?.user?.role || ''),
      storeId: req?.user?.storeId || null,
    };
  }

  /** Só matriz lança/edita/cancela. */
  private assertSupervisao(req: any) {
    const { role } = this.user(req);
    if (!['admin', 'operator', 'supervisor'].includes(role)) {
      throw new ForbiddenException(
        'Só a supervisão lança evento de RH. Fale com a matriz.',
      );
    }
  }

  @Get('tipos')
  tipos() {
    return this.svc.listarTipos();
  }

  @Get()
  listar(
    @Req() req: any,
    @Query('sellerId') sellerId?: string,
    @Query('storeId') storeId?: string,
    @Query('tipo') tipo?: string,
    @Query('de') de?: string,
    @Query('ate') ate?: string,
    @Query('incluirCancelados') incluirCancelados?: string,
  ) {
    const u = this.user(req);
    // A loja não escolhe a loja: vem do JWT. Sem isso uma gerente leria o
    // atestado da equipe inteira da rede.
    const escopo = u.role === 'store' ? u.storeId : storeId;
    if (u.role === 'store' && !escopo) {
      throw new ForbiddenException('Loja não identificada na sessão');
    }
    return this.svc.listar({
      sellerId,
      storeId: escopo || undefined,
      tipo,
      de,
      ate,
      incluirCancelados: incluirCancelados === '1',
    });
  }

  @Get('hoje')
  hoje(@Req() req: any, @Query('storeId') storeId?: string, @Query('data') data?: string) {
    const u = this.user(req);
    const escopo = u.role === 'store' ? u.storeId : storeId;
    if (u.role === 'store' && !escopo) {
      throw new ForbiddenException('Loja não identificada na sessão');
    }
    return this.svc.foraHoje(escopo || undefined, data);
  }

  /**
   * ANEXO DO EVENTO — a supervisão sobe o atestado antes de lançar.
   *
   * Rota própria do módulo, e não a do prontuário (`POST /sellers/:id/documents`),
   * porque aquela é `@AdminOnly()` = admin+operator. O SUPERVISOR, que é quem o
   * dono mandou lançar evento, levaria 403 lá — conseguiria escolher o tipo
   * "Atestado" e não conseguiria concluir. Porta falsa.
   */
  @Post('documento/:sellerId')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  anexar(
    @Req() req: any,
    @Param('sellerId') sellerId: string,
    @UploadedFile() file: any,
    @Body('tipo') tipo?: string,
    @Body('titulo') titulo?: string,
    @Body('dataReferencia') dataReferencia?: string,
  ) {
    this.assertSupervisao(req);
    if (!file) throw new BadRequestException('Escolha o arquivo do atestado');
    return this.svc.anexarDocumento(
      sellerId, file, { tipo, titulo, dataReferencia }, this.user(req).id,
    );
  }

  /** Caixa de entrada: atestado que chegou e ainda não virou evento. */
  @Get('atestados-pendentes')
  pendentes(@Req() req: any, @Query('dias') dias?: string) {
    this.assertSupervisao(req);
    return this.svc.atestadosPendentes(Number(dias) > 0 ? Number(dias) : 60);
  }

  /** O que o mês desconta — dias + DSR, pela régua do "faltou 1, perdeu 2". */
  @Get('folha')
  folha(
    @Req() req: any,
    @Query('ano') ano: string,
    @Query('mes') mes: string,
    @Query('sellerId') sellerId?: string,
  ) {
    this.assertSupervisao(req);
    const a = Number(ano) || new Date().getFullYear();
    const m = Number(mes) || new Date().getMonth() + 1;
    if (m < 1 || m > 12) throw new BadRequestException('Mês inválido');
    return this.svc.descontosFolha(a, m, sellerId || undefined);
  }

  @Post()
  criar(@Req() req: any, @Body() body: any) {
    this.assertSupervisao(req);
    const u = this.user(req);
    return this.svc.criar(body, { id: u.id, nome: u.nome });
  }

  /**
   * ATESTADO PELO CELULAR — a funcionária fotografa e manda no mesmo dia.
   *
   * Hoje o papel chega na matriz semanas depois, e até chegar o dia dela conta
   * como FALTA. Este é o único caminho aberto pra LOJA no módulo, e ele
   * deliberadamente **não cria evento**: grava o documento no prontuário e a
   * supervisão lança a partir da caixa de entrada. A ordem do dono foi
   * "supervisão lança" — deixar a funcionária abonar o próprio dia seria
   * inverter isso por comodidade.
   *
   * O PWA roda com token de quiosque da loja (`role=store`) e identifica a
   * funcionária por reconhecimento facial, com os descriptors já restritos à
   * loja. Não há aprovação automática nenhuma pendurada nisto: o pior caso de
   * um envio errado é um PDF a mais na caixa de entrada da supervisão.
   */
  @Post('atestado-recebido')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  async atestadoRecebido(
    @Req() req: any,
    @UploadedFile() file: any,
    @Body('sellerId') sellerId: string,
    @Body('dataReferencia') dataReferencia?: string,
  ) {
    const u = this.user(req);
    if (!['store', 'admin', 'operator', 'supervisor'].includes(u.role)) {
      throw new ForbiddenException('Sem permissão');
    }
    if (!sellerId) throw new BadRequestException('Funcionária não identificada');
    if (!file) throw new BadRequestException('Tire a foto do atestado');

    const r = await this.svc.anexarDocumento(
      sellerId,
      file,
      {
        tipo: 'ATESTADO_MEDICO',
        titulo: 'Atestado enviado pelo celular',
        dataReferencia: dataReferencia || null,
      },
      u.id,
    );
    // Resposta enxuta: o PWA não precisa da URL do arquivo, e devolver menos
    // evita expor link de documento de RH numa tela de quiosque.
    return { ok: r.ok };
  }

  @Patch(':id')
  editar(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    this.assertSupervisao(req);
    return this.svc.editar(id, body);
  }

  @Post(':id/cancelar')
  cancelar(@Req() req: any, @Param('id') id: string, @Body() body: { motivo?: string }) {
    this.assertSupervisao(req);
    const u = this.user(req);
    return this.svc.cancelar(id, String(body?.motivo || ''), { id: u.id });
  }
}
