import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { Cron, Interval } from '@nestjs/schedule';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { RealtimeGateway } from '../websocket/realtime.gateway';
import {
  agoraBrasilia,
  diaBrasiliaDe,
  fimDoDiaUtcExclusivo,
  hojeBrasilia,
  inicioDoDiaUtc,
  utcParaBrasilia,
} from '../common/tz';
import { cruzar, Esperado, OperacaoTicket, OrigemTicket, Resultado, TicketEntrada } from './cruzamento';
import { ErroLeitura, LeitorTicketsService } from './leitor-tickets.service';
import { MimeFoto, TicketsArmazenamentoService } from './tickets-armazenamento.service';
import { diaCurto, frasesDoResultado } from './resumo-texto';

/**
 * CONFERÊNCIA DE TICKETS POR FOTO (16/09/2026).
 *
 * Fluxo: a operadora abre o caixa → a etapa "tickets do movimento anterior"
 * cria/abre o LOTE (loja × dia) → fotos chegam pelo PC ou pelo celular (QR)
 * → a fila lê cada foto com IA → o lote é RECONFERIDO a cada foto lida
 * (`cruzamento.ts`) → a retaguarda vê o checklist e o WhatsApp recebe o
 * resumo diário.
 *
 * Regras que valem ouro aqui:
 *  - Nada disso trava a venda: abrir o caixa nunca depende da foto nem da IA.
 *  - A foto nunca some: erro de leitura fica escrito na foto e volta pra fila
 *    sozinho quando é temporário.
 *  - Envs: `TICKETS_IA=0` para a fila de leitura (as fotos continuam chegando
 *    e esperam). Destinos e hora do resumo ficam na TELA (app_config).
 */

export type StatusLote =
  | 'aguardando_fotos'
  | 'lendo'
  | 'confere'
  | 'atencao'
  | 'divergente'
  | 'sem_movimento';

export interface ConfigConferencia {
  ativo: boolean;
  destinos: string[];
  /** hora de Brasília do resumo diário (0–23) */
  hora: number;
}

interface ArquivoRecebido {
  buffer: Buffer;
  mimetype?: string;
  size?: number;
  originalname?: string;
}

const CONFIG_CHAVE = 'conferencia-tickets';
const CONFIG_ENVIO_CHAVE = 'conferencia-tickets-resumo-enviado';
const CONFIG_PADRAO: ConfigConferencia = { ativo: true, destinos: [], hora: 11 };

const TOKEN_VALIDADE_MS = 36 * 60 * 60_000;
const MAX_FOTOS_LOTE = 200;
const MAX_BYTES = 15 * 1024 * 1024;
const MAX_TENTATIVAS = 4;
const LEVA = 6;
const CONCORRENCIA = 3;
const TRAVADA_MS = 10 * 60_000;
const DIAS_PENDENCIA = 7;

const round2 = (n: number) => Math.round(n * 100) / 100;

function detalhes(raw: unknown): Record<string, any> {
  if (!raw) return {};
  if (typeof raw === 'object') return raw as Record<string, any>;
  try {
    const d = JSON.parse(String(raw));
    return d && typeof d === 'object' ? d : {};
  } catch {
    return {};
  }
}

function horaBr(d: Date | null | undefined): string | null {
  if (!d) return null;
  return utcParaBrasilia(d).toISOString().slice(11, 16);
}

function minutoBr(d: Date | null | undefined): number | null {
  if (!d) return null;
  const b = utcParaBrasilia(d);
  return b.getUTCHours() * 60 + b.getUTCMinutes();
}

@Injectable()
export class ConferenciaTicketsService implements OnModuleInit {
  private readonly logger = new Logger(ConferenciaTicketsService.name);
  private rodando = false;
  private deNovo = false;
  private lojasCache: { em: number; porCodigo: Map<string, { id: string; name: string; tipo: string }> } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly leitor: LeitorTicketsService,
    private readonly armazenamento: TicketsArmazenamentoService,
    private readonly whatsapp: WhatsappService,
    private readonly realtime: RealtimeGateway,
  ) {}

  private get db(): any {
    return this.prisma as any;
  }

  private get filaLigada(): boolean {
    return String(process.env.TICKETS_IA ?? '1') !== '0';
  }

  onModuleInit() {
    this.logger.log(
      `[tickets] fila de leitura ${this.filaLigada ? 'LIGADA' : 'DESLIGADA (TICKETS_IA=0)'} · modelo ${this.leitor.modelo}` +
        (this.leitor.configurado ? '' : ' · ⚠ sem ANTHROPIC_API_KEY — fotos vão esperar'),
    );
  }

  // ───────────────────────── lojas ─────────────────────────

  private async lojas() {
    if (this.lojasCache && Date.now() - this.lojasCache.em < 10 * 60_000) return this.lojasCache.porCodigo;
    const rows = await this.db.store.findMany({ select: { id: true, code: true, name: true, tipo: true } });
    const porCodigo = new Map<string, { id: string; name: string; tipo: string }>();
    for (const r of rows as any[]) porCodigo.set(String(r.code), { id: r.id, name: r.name, tipo: r.tipo });
    this.lojasCache = { em: Date.now(), porCodigo };
    return porCodigo;
  }

  async codigosDaFranquia(): Promise<string[]> {
    const rows = await this.db.store.findMany({ where: { tipo: 'FILIAL', active: true }, select: { code: true } });
    return (rows as any[]).map((r) => String(r.code));
  }

  // ───────────────────────── lote ─────────────────────────

  /** O dia do movimento que a abertura de HOJE confere: o da última sessão aberta antes de hoje. */
  async diaParaConferir(storeCode: string): Promise<string | null> {
    const ultima = await this.db.pdvCashSession.findFirst({
      where: { storeCode, isTraining: false, openedAt: { lt: inicioDoDiaUtc(hojeBrasilia()) } },
      orderBy: { openedAt: 'desc' },
      select: { openedAt: true },
    });
    return ultima ? diaBrasiliaDe(ultima.openedAt) : null;
  }

  private novoToken(): string {
    return randomBytes(24).toString('base64url');
  }

  async obterOuCriarLote(storeCode: string, dia: string, usuario: string | null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) throw new BadRequestException('Dia inválido (use AAAA-MM-DD)');
    const existente = await this.db.ticketLote.findUnique({ where: { storeCode_dia: { storeCode, dia } } });
    if (existente) {
      if (new Date(existente.tokenExpiraEm).getTime() < Date.now()) {
        return this.db.ticketLote.update({
          where: { id: existente.id },
          data: { token: this.novoToken(), tokenExpiraEm: new Date(Date.now() + TOKEN_VALIDADE_MS) },
        });
      }
      return existente;
    }
    const loja = (await this.lojas()).get(storeCode);
    try {
      return await this.db.ticketLote.create({
        data: {
          storeCode,
          storeName: loja?.name || null,
          dia,
          token: this.novoToken(),
          tokenExpiraEm: new Date(Date.now() + TOKEN_VALIDADE_MS),
          criadoPor: usuario,
        },
      });
    } catch (e: any) {
      if (e?.code === 'P2002') {
        return this.db.ticketLote.findUnique({ where: { storeCode_dia: { storeCode, dia } } });
      }
      throw e;
    }
  }

  async loteDaLoja(loteId: string, storeCode: string | null) {
    const lote = await this.db.ticketLote.findUnique({ where: { id: loteId } });
    if (!lote) throw new NotFoundException('Conferência de tickets não encontrada');
    if (storeCode && lote.storeCode !== storeCode) throw new ForbiddenException('Esta conferência é de outra loja');
    return lote;
  }

  async loteDoToken(token: string) {
    const lote = token ? await this.db.ticketLote.findUnique({ where: { token } }) : null;
    if (!lote || new Date(lote.tokenExpiraEm).getTime() < Date.now()) {
      throw new NotFoundException('Este link venceu. Abra de novo a etapa de tickets no PDV e leia o QR novo.');
    }
    return lote;
  }

  private async contagemFotos(loteId: string) {
    const rows = await this.db.ticketFoto.groupBy({ by: ['status'], where: { loteId }, _count: { _all: true } });
    const c = { total: 0, pendentes: 0, lidas: 0, erro: 0, ilegiveis: 0 };
    for (const r of rows as any[]) {
      const n = r._count._all as number;
      c.total += n;
      if (r.status === 'pendente' || r.status === 'lendo') c.pendentes += n;
      else if (r.status === 'lida') c.lidas += n;
      else if (r.status === 'erro') c.erro += n;
      else if (r.status === 'ilegivel') c.ilegiveis += n;
    }
    return c;
  }

  /**
   * O que a tela de abertura do caixa precisa: qual dia conferir, quanto papel
   * o sistema espera e o link do celular. `dia: null` = nada a conferir.
   */
  async painelAbertura(storeCode: string, usuario: string | null, diaEscolhido?: string) {
    let dia: string | null;
    if (diaEscolhido) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(diaEscolhido)) throw new BadRequestException('Dia inválido (use AAAA-MM-DD)');
      if (diaEscolhido >= hojeBrasilia()) {
        throw new BadRequestException('Os tickets de hoje são conferidos amanhã, na abertura do caixa');
      }
      const teve = await this.db.pdvCashSession.count({
        where: {
          storeCode,
          isTraining: false,
          openedAt: { gte: inicioDoDiaUtc(diaEscolhido), lt: fimDoDiaUtcExclusivo(diaEscolhido) },
        },
      });
      if (!teve) throw new BadRequestException(`A loja ${storeCode} não abriu o caixa em ${diaCurto(diaEscolhido)}`);
      dia = diaEscolhido;
    } else {
      dia = await this.diaParaConferir(storeCode);
    }
    if (!dia) return { dia: null };
    const { esperados, sistema } = await this.montarEsperados(storeCode, dia);
    const obrigatorios = esperados.filter((e) => e.obrigatorio);
    let lote = await this.db.ticketLote.findUnique({ where: { storeCode_dia: { storeCode, dia } } });
    if (!lote && obrigatorios.length === 0) {
      return { dia, diaCurto: diaCurto(dia), semMovimento: true };
    }
    lote = await this.obterOuCriarLote(storeCode, dia, usuario);
    return {
      dia,
      diaCurto: diaCurto(dia),
      semMovimento: false,
      loteId: lote.id,
      token: lote.token,
      linkCelular: this.linkCelular(lote.token),
      status: lote.status as StatusLote,
      semTicketsMotivo: lote.semTicketsMotivo,
      finalizadoEm: lote.finalizadoEm,
      fotos: await this.contagemFotos(lote.id),
      esperado: {
        cartoes: obrigatorios.filter((e) => e.tipo === 'cartao').length,
        cupons: obrigatorios.filter((e) => e.tipo === 'cupom').length,
        pix: obrigatorios.filter((e) => e.tipo === 'pix').length,
        recibos: obrigatorios.filter((e) => e.tipo === 'crediario').length,
        total: obrigatorios.length,
      },
      sistema,
    };
  }

  linkCelular(token: string): string | null {
    const base = String(process.env.FRONTEND_URL || '').trim().replace(/\/+$/, '');
    return base ? `${base}/tickets/${token}` : null;
  }

  async estadoDoLote(loteId: string) {
    const lote = await this.db.ticketLote.findUnique({ where: { id: loteId } });
    if (!lote) throw new NotFoundException('Conferência de tickets não encontrada');
    const fotos = await this.db.ticketFoto.findMany({
      where: { loteId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, status: true, erro: true, observacao: true, origem: true, createdAt: true, _count: { select: { tickets: true } } },
    });
    return {
      loteId: lote.id,
      storeCode: lote.storeCode,
      storeName: lote.storeName,
      dia: lote.dia,
      diaCurto: diaCurto(lote.dia),
      status: lote.status as StatusLote,
      finalizadoEm: lote.finalizadoEm,
      semTicketsMotivo: lote.semTicketsMotivo,
      fotos: (fotos as any[]).map((f) => ({
        id: f.id,
        status: f.status,
        erro: f.erro,
        observacao: f.observacao,
        origem: f.origem,
        tickets: f._count.tickets,
        enviadaEm: f.createdAt,
      })),
    };
  }

  // ───────────────────────── fotos ─────────────────────────

  async receberFoto(lote: any, arquivo: ArquivoRecebido | undefined, origem: 'pc' | 'celular', usuario: string | null) {
    if (!arquivo?.buffer?.length) throw new BadRequestException('Nenhuma foto recebida');
    if ((arquivo.size || arquivo.buffer.length) > MAX_BYTES) {
      throw new BadRequestException('Foto grande demais (máx. 15 MB)');
    }
    const mime = String(arquivo.mimetype || '').toLowerCase();
    if (mime && !mime.startsWith('image/') && mime !== 'application/octet-stream') {
      throw new BadRequestException('Envie só fotos (JPG, PNG ou HEIC)');
    }
    if ((lote.fotosEnviadas || 0) >= MAX_FOTOS_LOTE) {
      throw new BadRequestException(`Limite de ${MAX_FOTOS_LOTE} fotos por dia atingido`);
    }

    const hash = this.armazenamento.hash(arquivo.buffer);
    const repetida = await this.db.ticketFoto.findUnique({ where: { loteId_hash: { loteId: lote.id, hash } } });
    if (repetida) return { ok: true, duplicada: true, fotoId: repetida.id, fotos: await this.contagemFotos(lote.id) };

    const pronta = await this.armazenamento.preparar(arquivo.buffer, mime);
    const chave = await this.armazenamento.salvar(lote.storeCode, lote.dia, pronta.buffer, pronta.mime);
    let foto: any;
    try {
      foto = await this.db.ticketFoto.create({
        data: {
          loteId: lote.id,
          chave,
          hash,
          bytes: pronta.buffer.length,
          mime: pronta.mime,
          origem,
          enviadaPor: usuario,
        },
      });
    } catch (e: any) {
      await this.armazenamento.apagar(chave);
      if (e?.code === 'P2002') {
        const outra = await this.db.ticketFoto.findUnique({ where: { loteId_hash: { loteId: lote.id, hash } } });
        return { ok: true, duplicada: true, fotoId: outra?.id, fotos: await this.contagemFotos(lote.id) };
      }
      throw e;
    }
    await this.db.ticketLote.update({
      where: { id: lote.id },
      data: { fotosEnviadas: { increment: 1 }, status: 'lendo' },
    });
    const fotos = await this.contagemFotos(lote.id);
    await this.avisar(lote.id);
    this.chutarFila();
    return { ok: true, duplicada: false, fotoId: foto.id, fotos };
  }

  async removerFoto(fotoId: string, podeMexer: (storeCode: string) => boolean, usuario: string | null) {
    const foto = await this.db.ticketFoto.findUnique({ where: { id: fotoId }, include: { lote: true } });
    if (!foto) throw new NotFoundException('Foto não encontrada');
    if (!podeMexer(foto.lote.storeCode)) throw new ForbiddenException('Foto de outra loja');
    await this.db.ticketFoto.delete({ where: { id: fotoId } });
    await this.db.ticketLote.update({
      where: { id: foto.loteId },
      data: { fotosEnviadas: { decrement: 1 } },
    });
    await this.armazenamento.apagar(foto.chave);
    this.logger.log(`[tickets] foto ${fotoId} removida de ${foto.lote.storeCode} ${foto.lote.dia} por ${usuario || '?'}`);
    await this.reconferir(foto.loteId);
    return { ok: true };
  }

  async marcarSemTickets(loteId: string, motivo: string, usuario: string | null) {
    const texto = String(motivo || '').trim();
    if (texto.length < 3) throw new BadRequestException('Diga por que os tickets não vão ser enviados agora');
    await this.db.ticketLote.update({
      where: { id: loteId },
      data: { semTicketsMotivo: texto.slice(0, 500), semTicketsPor: usuario, semTicketsEm: new Date() },
    });
    await this.avisar(loteId);
    return { ok: true };
  }

  async finalizar(loteId: string, usuario: string | null) {
    await this.db.ticketLote.update({
      where: { id: loteId },
      data: { finalizadoEm: new Date(), finalizadoPor: usuario },
    });
    return this.reconferir(loteId);
  }

  async imagemAssinada(fotoId: string, exp: string, sig: string): Promise<{ buffer: Buffer; mime: string }> {
    if (!this.armazenamento.assinaturaValida(fotoId, exp, sig)) {
      throw new ForbiddenException('Link da foto vencido — recarregue a tela');
    }
    const foto = await this.db.ticketFoto.findUnique({ where: { id: fotoId }, select: { chave: true, mime: true } });
    if (!foto) throw new NotFoundException('Foto não encontrada');
    return { buffer: await this.armazenamento.ler(foto.chave), mime: foto.mime };
  }

  // ───────────────────────── fila de leitura ─────────────────────────

  @Interval('conferencia-tickets-fila', 30_000)
  async cicloDaFila() {
    this.chutarFila();
  }

  chutarFila() {
    if (!this.filaLigada) return;
    if (this.rodando) {
      this.deNovo = true;
      return;
    }
    this.rodando = true;
    setImmediate(() => {
      this.rodarFila()
        .catch((e) => this.logger.error(`[tickets] fila falhou: ${e?.message || e}`))
        .finally(() => {
          this.rodando = false;
        });
    });
  }

  private async rodarFila() {
    let voltas = 0;
    do {
      this.deNovo = false;
      const lidas = await this.processarLeva();
      if (lidas >= LEVA) this.deNovo = true;
      voltas++;
    } while (this.deNovo && voltas < 20);
  }

  private async processarLeva(): Promise<number> {
    const agora = new Date();
    await this.db.ticketFoto.updateMany({
      where: { status: 'lendo', lendoDesde: { lt: new Date(agora.getTime() - TRAVADA_MS) } },
      data: { status: 'pendente', lendoDesde: null },
    });
    const fila = await this.db.ticketFoto.findMany({
      where: {
        status: 'pendente',
        OR: [{ proximaTentativaEm: null }, { proximaTentativaEm: { lte: agora } }],
      },
      orderBy: { createdAt: 'asc' },
      take: LEVA,
      include: { lote: { select: { id: true, storeCode: true, storeName: true, dia: true } } },
    });
    if (!fila.length) return 0;

    const minhas: any[] = [];
    for (const f of fila as any[]) {
      const r = await this.db.ticketFoto.updateMany({
        where: { id: f.id, status: 'pendente' },
        data: { status: 'lendo', lendoDesde: new Date() },
      });
      if (r.count === 1) minhas.push(f);
    }

    const lotes = new Set<string>();
    let i = 0;
    const trabalhar = async () => {
      while (i < minhas.length) {
        const f = minhas[i++];
        await this.lerFoto(f);
        lotes.add(f.loteId);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCORRENCIA, minhas.length) }, trabalhar));
    for (const loteId of lotes) {
      await this.reconferir(loteId).catch((e) =>
        this.logger.warn(`[tickets] reconferência do lote ${loteId} falhou: ${e?.message || e}`),
      );
    }
    return minhas.length;
  }

  private async lerFoto(foto: any) {
    try {
      const imagem = await this.armazenamento.ler(foto.chave);
      const r = await this.leitor.ler(imagem, foto.mime as MimeFoto, {
        storeCode: foto.lote.storeCode,
        storeName: foto.lote.storeName,
        dia: foto.lote.dia,
      });
      const semNada = r.leitura.tickets.length === 0;
      await this.db.$transaction([
        this.db.ticketLido.deleteMany({ where: { fotoId: foto.id } }),
        this.db.ticketLido.createMany({
          data: r.leitura.tickets.map((t, ordem) => ({
            loteId: foto.loteId,
            fotoId: foto.id,
            ordem,
            origem: t.origem,
            operacao: t.operacao,
            valor: t.valor,
            data: t.data,
            hora: t.hora,
            nsu: t.nsu,
            autorizacao: t.autorizacao,
            bandeira: t.bandeira,
            finalCartao: t.finalCartao,
            parcelas: t.parcelas,
            adquirente: t.adquirente,
            numero: t.numero,
            formas: t.formas,
            cliente: t.cliente,
            legivel: t.legivel,
            confianca: t.confianca,
            observacao: t.observacao,
          })),
        }),
        this.db.ticketFoto.update({
          where: { id: foto.id },
          data: {
            status: semNada && !r.leitura.fotoLegivel ? 'ilegivel' : 'lida',
            lidaEm: new Date(),
            lendoDesde: null,
            erro: null,
            proximaTentativaEm: null,
            observacao:
              r.leitura.observacao || (semNada ? 'nenhum comprovante encontrado nesta foto' : null),
            modelo: r.modelo,
            tokensEntrada: r.tokensEntrada,
            tokensSaida: r.tokensSaida,
          },
        }),
      ]);
      this.logger.log(
        `[tickets] ${foto.lote.storeCode} ${foto.lote.dia} foto ${foto.id.slice(0, 8)}: ` +
          `${r.leitura.tickets.length} ticket(s) · ${r.tokensEntrada}+${r.tokensSaida} tokens · ${r.modelo}`,
      );
    } catch (e: any) {
      const erro = e instanceof ErroLeitura ? e : new ErroLeitura(`falha lendo a foto: ${e?.message || e}`, true);
      const tentativas = (foto.tentativas || 0) + 1;
      const volta = erro.temporario && tentativas < MAX_TENTATIVAS;
      await this.db.ticketFoto.update({
        where: { id: foto.id },
        data: {
          status: volta ? 'pendente' : 'erro',
          tentativas,
          lendoDesde: null,
          erro: erro.message.slice(0, 500),
          proximaTentativaEm: volta ? new Date(Date.now() + erro.esperaMs * tentativas) : null,
        },
      });
      this.logger.warn(
        `[tickets] ${foto.lote.storeCode} ${foto.lote.dia} foto ${foto.id.slice(0, 8)} ` +
          `(tentativa ${tentativas}${volta ? ', volta pra fila' : ', desistiu'}): ${erro.message}`,
      );
    }
  }

  /** Lê de novo TODAS as fotos do lote (gasta IA — só a matriz). */
  async relerLote(loteId: string, usuario: string | null) {
    const r = await this.db.ticketFoto.updateMany({
      where: { loteId, status: { not: 'lendo' } },
      data: { status: 'pendente', tentativas: 0, proximaTentativaEm: null, erro: null },
    });
    this.logger.log(`[tickets] releitura de ${r.count} foto(s) do lote ${loteId} pedida por ${usuario || '?'}`);
    await this.db.ticketLote.update({ where: { id: loteId }, data: { status: 'lendo' } });
    await this.avisar(loteId);
    this.chutarFila();
    return { ok: true, fotos: r.count };
  }

  // ───────────────────────── o lado do sistema ─────────────────────────

  /**
   * O que o Flow gravou pra loja × dia, no formato do cruzamento. A janela é a
   * das SESSÕES de caixa abertas no dia — a mesma do fechamento
   * (`CashService.computeSessionTotals`).
   */
  async montarEsperados(storeCode: string, dia: string) {
    const sessoes = await this.db.pdvCashSession.findMany({
      where: {
        storeCode,
        isTraining: false,
        openedAt: { gte: inicioDoDiaUtc(dia), lt: fimDoDiaUtcExclusivo(dia) },
      },
      select: { id: true, openedAt: true, closedAt: true, status: true },
      orderBy: { openedAt: 'asc' },
    });
    const sistema = {
      sessoes: sessoes.length,
      sessaoAberta: (sessoes as any[]).some((s) => s.status === 'open'),
      vendas: 0,
      cartao: { qtd: 0, total: 0 },
      dinheiro: { qtd: 0, total: 0 },
      pixBanco: { qtd: 0, total: 0 },
      pixExterno: { qtd: 0, total: 0 },
      crediario: { qtd: 0, total: 0 },
      estornadas: 0,
    };
    const esperados: Esperado[] = [];
    if (!sessoes.length) return { esperados, sistema };

    const vendas = await this.db.pdvSale.findMany({
      where: {
        cashSessionId: { in: (sessoes as any[]).map((s) => s.id) },
        isTraining: false,
        status: { in: ['finalized', 'cancelled'] },
        finalizedAt: { not: null },
      },
      select: {
        id: true,
        total: true,
        status: true,
        paymentMethod: true,
        finalizedAt: true,
        customerName: true,
        vendedorName: true,
        sellerName: true,
        stoneNsu: true,
        payments: { select: { id: true, method: true, valor: true, details: true, createdAt: true } },
      },
    });

    for (const v of vendas as any[]) {
      if (String(v.paymentMethod || '').toUpperCase() === 'MARCADO') continue;
      const cancelada = v.status === 'cancelled';
      if (cancelada) sistema.estornadas++;
      else sistema.vendas++;
      const numero = String(v.id).slice(-8).toLowerCase();
      const quem = v.vendedorName || v.sellerName || null;
      const pagamentos = ((v.payments || []) as any[]).filter((p) => Number(p.valor) > 0);
      const metodos = pagamentos.map((p) => String(p.method || '').toLowerCase());
      const cartoes = pagamentos.filter((p) => ['credito', 'debito'].includes(String(p.method).toLowerCase()));

      for (const p of pagamentos) {
        const metodo = String(p.method || '').toLowerCase();
        const valor = round2(Number(p.valor) || 0);
        const det = detalhes(p.details);
        const quando = p.createdAt || v.finalizedAt;
        if (metodo === 'credito' || metodo === 'debito') {
          const parcelas = metodo === 'credito' ? Number(det.parcelas) || 1 : null;
          const bandeira = det.bandeira ? String(det.bandeira).toUpperCase().trim() : null;
          if (!cancelada) {
            sistema.cartao.qtd++;
            sistema.cartao.total += valor;
          }
          esperados.push({
            chave: `cartao:${p.id}`,
            tipo: 'cartao',
            obrigatorio: !cancelada,
            valor,
            minuto: minutoBr(quando),
            operacao: metodo,
            bandeira,
            parcelas,
            // NSU da Stone só identifica o pagamento quando a venda tem UM cartão
            nsu: cartoes.length === 1 ? v.stoneNsu || null : null,
            cancelada,
            titulo: [
              `Venda #${numero.toUpperCase()}`,
              horaBr(v.finalizedAt),
              `${metodo === 'debito' ? 'Débito' : `Crédito${parcelas && parcelas > 1 ? ` ${parcelas}x` : ''}`}${bandeira ? ` ${bandeira}` : ''}`,
              quem,
            ]
              .filter(Boolean)
              .join(' · '),
            ref: { saleId: v.id, paymentId: p.id },
          });
        } else if (metodo === 'pix') {
          const externo =
            det.pixExterno === true ||
            det.pixProvider === 'externo' ||
            !(det.pixTxid || det.pixPaidByWebhook || det.reconciliadoPeloCron);
          if (!cancelada) {
            const alvo = externo ? sistema.pixExterno : sistema.pixBanco;
            alvo.qtd++;
            alvo.total += valor;
          }
          esperados.push({
            chave: `pix:${p.id}`,
            tipo: 'pix',
            obrigatorio: externo && !cancelada,
            valor,
            minuto: minutoBr(quando),
            pixExterno: externo,
            cancelada,
            titulo: [
              `Venda #${numero.toUpperCase()}`,
              horaBr(v.finalizedAt),
              externo ? 'PIX sem confirmação do banco' : 'PIX confirmado pelo banco',
              quem,
            ]
              .filter(Boolean)
              .join(' · '),
            ref: { saleId: v.id, paymentId: p.id },
          });
        } else if (metodo === 'dinheiro' && !cancelada) {
          sistema.dinheiro.qtd++;
          sistema.dinheiro.total += valor;
        }
      }

      // O cupom imprime sozinho quando a venda é 100% dinheiro ou 100% PIX
      // (pdv/page.tsx, impressão automática) — é aí que a falta dele é pendência.
      const soDinheiro = metodos.length > 0 && metodos.every((m) => m === 'dinheiro');
      const soPix = metodos.length > 0 && metodos.every((m) => m === 'pix');
      esperados.push({
        chave: `cupom:${v.id}`,
        tipo: 'cupom',
        obrigatorio: (soDinheiro || soPix) && !cancelada,
        valor: round2(Number(v.total) || 0),
        minuto: minutoBr(v.finalizedAt),
        numero,
        formas: [...new Set(metodos)],
        cancelada,
        titulo: [
          `Venda #${numero.toUpperCase()}`,
          horaBr(v.finalizedAt),
          soDinheiro ? 'Dinheiro' : soPix ? 'PIX' : [...new Set(metodos)].join(' + ').toUpperCase(),
          quem,
        ]
          .filter(Boolean)
          .join(' · '),
        ref: { saleId: v.id },
      });
    }

    // Recebimentos de crediário na janela de cada sessão (mesma régua do fechamento)
    const vistos = new Set<string>();
    for (const s of sessoes as any[]) {
      const baixas = await this.db.crediarioBaixa.findMany({
        where: {
          lojaCode: storeCode,
          status: 'paid',
          createdAt: { gte: s.openedAt, ...(s.closedAt ? { lte: s.closedAt } : {}) },
        },
        select: {
          id: true,
          totalPago: true,
          formaPagamento: true,
          customerName: true,
          paidAt: true,
          createdAt: true,
          userName: true,
        },
      });
      for (const b of baixas as any[]) {
        if (vistos.has(b.id)) continue;
        vistos.add(b.id);
        const forma = String(b.formaPagamento || '').toLowerCase();
        const valor = round2(Number(b.totalPago) || 0);
        if (valor <= 0) continue;
        sistema.crediario.qtd++;
        sistema.crediario.total += valor;
        const numero = String(b.id).slice(0, 8).toLowerCase();
        esperados.push({
          chave: `crediario:${b.id}`,
          tipo: 'crediario',
          obrigatorio: true,
          valor,
          minuto: minutoBr(b.paidAt || b.createdAt),
          numero,
          formas: forma === 'misto' ? ['dinheiro', 'pix'] : [forma || 'dinheiro'],
          cliente: b.customerName || null,
          titulo: [
            `Baixa #${numero.toUpperCase()}`,
            horaBr(b.paidAt || b.createdAt),
            b.customerName,
            (forma || 'dinheiro').toUpperCase(),
          ]
            .filter(Boolean)
            .join(' · '),
          ref: { baixaId: b.id },
        });
      }
    }

    for (const k of ['cartao', 'dinheiro', 'pixBanco', 'pixExterno', 'crediario'] as const) {
      sistema[k].total = round2(sistema[k].total);
    }
    return { esperados, sistema };
  }

  // ───────────────────────── reconferência ─────────────────────────

  async reconferir(loteId: string) {
    const lote = await this.db.ticketLote.findUnique({ where: { id: loteId } });
    if (!lote) throw new NotFoundException('Conferência de tickets não encontrada');
    const [{ esperados, sistema }, tickets, fotos] = await Promise.all([
      this.montarEsperados(lote.storeCode, lote.dia),
      this.db.ticketLido.findMany({ where: { loteId }, orderBy: [{ createdAt: 'asc' }, { ordem: 'asc' }] }),
      this.contagemFotos(loteId),
    ]);

    const entrada: TicketEntrada[] = (tickets as any[]).map((t) => ({
      id: t.id,
      fotoId: t.fotoId,
      origem: t.origem as OrigemTicket,
      operacao: t.operacao as OperacaoTicket,
      valor: t.valor == null ? null : Number(t.valor),
      data: t.data,
      hora: t.hora,
      nsu: t.nsu,
      autorizacao: t.autorizacao,
      finalCartao: t.finalCartao,
      bandeira: t.bandeira,
      parcelas: t.parcelas,
      numero: t.numero,
      formas: Array.isArray(t.formas) ? (t.formas as string[]) : [],
      cliente: t.cliente,
      legivel: t.legivel,
      confianca: (t.confianca as 'alta' | 'media' | 'baixa') || 'media',
    }));
    const resultado = cruzar(esperados, entrada, lote.dia);

    let status: StatusLote;
    const obrigatorios = esperados.filter((e) => e.obrigatorio).length;
    if (fotos.total === 0) status = obrigatorios > 0 ? 'aguardando_fotos' : 'sem_movimento';
    else if (fotos.pendentes > 0) status = 'lendo';
    else status = resultado.status;
    const fotosComProblema = fotos.erro + fotos.ilegiveis;
    if (status === 'confere' && fotosComProblema > 0) status = 'atencao';

    const divergencias = fotos.total === 0 ? 0 : resultado.contagem.divergencia;
    const atencoes = fotos.total === 0 ? 0 : resultado.contagem.atencao + fotosComProblema;

    await this.db.ticketLote.update({
      where: { id: loteId },
      data: {
        status,
        divergencias,
        atencoes,
        conferidoEm: new Date(),
        resultado: JSON.parse(
          JSON.stringify({
            versao: 1,
            resultado,
            sistema,
            fotos,
            esperados: esperados.map((e) => ({
              chave: e.chave,
              tipo: e.tipo,
              obrigatorio: e.obrigatorio,
              valor: e.valor,
              titulo: e.titulo,
              ref: e.ref,
            })),
          }),
        ),
      },
    });
    await this.avisar(loteId, { status, fotos, divergencias, atencoes });
    return { ok: true, status, divergencias, atencoes, fotos };
  }

  private async avisar(
    loteId: string,
    pronto?: { status: StatusLote; fotos: any; divergencias: number; atencoes: number },
  ) {
    try {
      const lote = await this.db.ticketLote.findUnique({
        where: { id: loteId },
        select: { id: true, storeCode: true, dia: true, status: true, divergencias: true, atencoes: true, semTicketsMotivo: true },
      });
      if (!lote) return;
      const payload = {
        loteId,
        storeCode: lote.storeCode,
        dia: lote.dia,
        status: pronto?.status ?? lote.status,
        divergencias: pronto?.divergencias ?? lote.divergencias,
        atencoes: pronto?.atencoes ?? lote.atencoes,
        semTicketsMotivo: lote.semTicketsMotivo,
        fotos: pronto?.fotos ?? (await this.contagemFotos(loteId)),
      };
      const loja = (await this.lojas()).get(lote.storeCode);
      if (loja) this.realtime.emitToStore(loja.id, 'conferencia-tickets:lote', payload);
      this.realtime.emitToAdmins('conferencia-tickets:lote', payload);
    } catch (e: any) {
      this.logger.warn(`[tickets] aviso em tempo real falhou: ${e?.message || e}`);
    }
  }

  // ───────────────────────── retaguarda ─────────────────────────

  /**
   * Uma linha por loja × dia com sessão de caixa no período — inclusive as que
   * NÃO mandaram foto (é a ausência que precisa gritar).
   */
  async listar(de: string, ate: string, lojasPermitidas?: string[]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(de) || !/^\d{4}-\d{2}-\d{2}$/.test(ate)) {
      throw new BadRequestException('Período inválido (use AAAA-MM-DD)');
    }
    if (ate < de) throw new BadRequestException('"Até" não pode ser antes de "De"');
    const filtroLoja = lojasPermitidas ? { storeCode: { in: lojasPermitidas } } : {};
    const hoje = hojeBrasilia();

    const [sessoes, lotes, ultimas, lojas] = await Promise.all([
      this.db.pdvCashSession.findMany({
        where: { ...filtroLoja, isTraining: false, openedAt: { gte: inicioDoDiaUtc(de), lt: fimDoDiaUtcExclusivo(ate) } },
        select: { id: true, storeCode: true, storeName: true, openedAt: true },
      }),
      this.db.ticketLote.findMany({
        where: { ...filtroLoja, dia: { gte: de, lte: ate } },
        select: {
          id: true,
          storeCode: true,
          storeName: true,
          dia: true,
          status: true,
          fotosEnviadas: true,
          divergencias: true,
          atencoes: true,
          semTicketsMotivo: true,
          finalizadoEm: true,
          revisadoEm: true,
          revisadoPor: true,
          conferidoEm: true,
          resultado: true,
        },
      }),
      this.db.pdvCashSession.groupBy({
        by: ['storeCode'],
        where: { ...filtroLoja, isTraining: false },
        _max: { openedAt: true },
      }),
      this.lojas(),
    ]);

    const vendasPorSessao = new Map<string, number>();
    if (sessoes.length) {
      const contagens = await this.db.pdvSale.groupBy({
        by: ['cashSessionId'],
        where: {
          cashSessionId: { in: (sessoes as any[]).map((s) => s.id) },
          status: 'finalized',
          isTraining: false,
        },
        _count: { _all: true },
      });
      for (const c of contagens as any[]) vendasPorSessao.set(c.cashSessionId, c._count._all);
    }
    const ultimaAbertura = new Map<string, Date>();
    for (const u of ultimas as any[]) if (u._max?.openedAt) ultimaAbertura.set(u.storeCode, u._max.openedAt);

    type Linha = {
      loteId: string | null;
      storeCode: string;
      storeName: string;
      dia: string;
      diaCurto: string;
      status: string;
      vendas: number;
      fotos: number;
      divergencias: number;
      atencoes: number;
      frases: string[];
      totais: Resultado['totais'] | null;
      semTicketsMotivo: string | null;
      revisadoEm: Date | null;
      revisadoPor: string | null;
      conferidoEm: Date | null;
    };
    const linhas = new Map<string, Linha>();
    const nomeDe = (code: string, fallback?: string | null) => lojas.get(code)?.name || fallback || code;

    for (const s of sessoes as any[]) {
      const dia = diaBrasiliaDe(s.openedAt);
      const k = `${s.storeCode}|${dia}`;
      const l = linhas.get(k) || {
        loteId: null,
        storeCode: s.storeCode,
        storeName: nomeDe(s.storeCode, s.storeName),
        dia,
        diaCurto: diaCurto(dia),
        status: '',
        vendas: 0,
        fotos: 0,
        divergencias: 0,
        atencoes: 0,
        frases: [],
        totais: null,
        semTicketsMotivo: null,
        revisadoEm: null,
        revisadoPor: null,
        conferidoEm: null,
      };
      l.vendas += vendasPorSessao.get(s.id) || 0;
      linhas.set(k, l);
    }
    for (const lote of lotes as any[]) {
      const k = `${lote.storeCode}|${lote.dia}`;
      const r = (lote.resultado as any)?.resultado as Resultado | undefined;
      const l = linhas.get(k) || {
        loteId: null,
        storeCode: lote.storeCode,
        storeName: nomeDe(lote.storeCode, lote.storeName),
        dia: lote.dia,
        diaCurto: diaCurto(lote.dia),
        status: '',
        vendas: 0,
        fotos: 0,
        divergencias: 0,
        atencoes: 0,
        frases: [],
        totais: null,
        semTicketsMotivo: null,
        revisadoEm: null,
        revisadoPor: null,
        conferidoEm: null,
      };
      Object.assign(l, {
        loteId: lote.id,
        status: lote.status,
        fotos: lote.fotosEnviadas,
        divergencias: lote.divergencias,
        atencoes: lote.atencoes,
        frases: lote.fotosEnviadas > 0 ? frasesDoResultado(r) : [],
        totais: r?.totais || null,
        semTicketsMotivo: lote.semTicketsMotivo,
        revisadoEm: lote.revisadoEm,
        revisadoPor: lote.revisadoPor,
        conferidoEm: lote.conferidoEm,
      });
      linhas.set(k, l);
    }
    for (const l of linhas.values()) {
      if (l.status) continue;
      const reabriu = (ultimaAbertura.get(l.storeCode)?.getTime() || 0) >= fimDoDiaUtcExclusivo(l.dia).getTime();
      if (l.dia >= hoje) l.status = 'em_andamento';
      else if (l.vendas === 0) l.status = 'sem_movimento';
      else if (!reabriu) l.status = 'aguardando_abertura';
      else l.status = 'sem_fotos';
    }

    const lista = [...linhas.values()].sort(
      (a, b) => b.dia.localeCompare(a.dia) || a.storeCode.localeCompare(b.storeCode, 'pt-BR', { numeric: true }),
    );
    const contagem: Record<string, number> = {};
    for (const l of lista) contagem[l.status] = (contagem[l.status] || 0) + 1;
    return { de, ate, linhas: lista, contagem };
  }

  async detalhe(loteId: string, lojasPermitidas?: string[]) {
    const lote = await this.db.ticketLote.findUnique({ where: { id: loteId } });
    if (!lote) throw new NotFoundException('Conferência de tickets não encontrada');
    if (lojasPermitidas && !lojasPermitidas.includes(lote.storeCode)) {
      throw new ForbiddenException('Loja fora do seu acesso');
    }
    if (!lote.resultado) await this.reconferir(loteId);
    const [atual, fotos, tickets] = await Promise.all([
      this.db.ticketLote.findUnique({ where: { id: loteId } }),
      this.db.ticketFoto.findMany({ where: { loteId }, orderBy: { createdAt: 'asc' } }),
      this.db.ticketLido.findMany({ where: { loteId }, orderBy: [{ createdAt: 'asc' }, { ordem: 'asc' }] }),
    ]);
    const custo = (fotos as any[]).reduce(
      (s, f) => ({ entrada: s.entrada + (f.tokensEntrada || 0), saida: s.saida + (f.tokensSaida || 0) }),
      { entrada: 0, saida: 0 },
    );
    return {
      lote: {
        id: atual.id,
        storeCode: atual.storeCode,
        storeName: (await this.lojas()).get(atual.storeCode)?.name || atual.storeName,
        dia: atual.dia,
        diaCurto: diaCurto(atual.dia),
        status: atual.status,
        divergencias: atual.divergencias,
        atencoes: atual.atencoes,
        semTicketsMotivo: atual.semTicketsMotivo,
        semTicketsPor: atual.semTicketsPor,
        semTicketsEm: atual.semTicketsEm,
        finalizadoEm: atual.finalizadoEm,
        finalizadoPor: atual.finalizadoPor,
        revisadoEm: atual.revisadoEm,
        revisadoPor: atual.revisadoPor,
        revisadoNota: atual.revisadoNota,
        conferidoEm: atual.conferidoEm,
        criadoPor: atual.criadoPor,
        linkCelular: this.linkCelular(atual.token),
        token: atual.token,
      },
      conferencia: atual.resultado,
      frases: frasesDoResultado((atual.resultado as any)?.resultado, 8),
      fotos: (fotos as any[]).map((f) => ({
        id: f.id,
        status: f.status,
        erro: f.erro,
        observacao: f.observacao,
        origem: f.origem,
        enviadaPor: f.enviadaPor,
        enviadaEm: f.createdAt,
        tentativas: f.tentativas,
        url: this.armazenamento.linkAssinado(f.id),
      })),
      tickets: (tickets as any[]).map((t) => ({
        id: t.id,
        fotoId: t.fotoId,
        origem: t.origem,
        operacao: t.operacao,
        valor: t.valor,
        data: t.data,
        hora: t.hora,
        nsu: t.nsu,
        autorizacao: t.autorizacao,
        bandeira: t.bandeira,
        finalCartao: t.finalCartao,
        parcelas: t.parcelas,
        adquirente: t.adquirente,
        numero: t.numero,
        formas: t.formas,
        cliente: t.cliente,
        legivel: t.legivel,
        confianca: t.confianca,
        observacao: t.observacao,
      })),
      ia: { modelo: this.leitor.modelo, configurada: this.leitor.configurado, filaLigada: this.filaLigada, tokens: custo },
    };
  }

  /**
   * O que a LOJA precisa ver pra resolver: vendas/recebimentos sem ticket e as
   * fotos que não deu pra ler. Nada de ticket sem registro — isso é da matriz.
   */
  async faltandoDaLoja(loteId: string) {
    const lote = await this.db.ticketLote.findUnique({ where: { id: loteId } });
    if (!lote) throw new NotFoundException('Conferência de tickets não encontrada');
    const r = (lote.resultado as any)?.resultado as Resultado | undefined;
    const fotos = await this.db.ticketFoto.findMany({
      where: { loteId, status: { in: ['erro', 'ilegivel'] } },
      select: { id: true, status: true, erro: true, observacao: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    return {
      loteId,
      dia: lote.dia,
      diaCurto: diaCurto(lote.dia),
      status: lote.status,
      semTicketsMotivo: lote.semTicketsMotivo,
      faltando: (r?.linhas || [])
        .filter((l) => l.situacao === 'sem_ticket')
        .map((l) => ({ titulo: l.titulo, valor: l.valorSistema, grupo: l.grupo, nota: l.notas[0] || null })),
      fotosComProblema: (fotos as any[]).map((f) => ({
        id: f.id,
        status: f.status,
        motivo: f.status === 'ilegivel' ? f.observacao || 'não deu pra ler' : f.erro,
        enviadaEm: f.createdAt,
      })),
    };
  }

  async revisar(loteId: string, nota: string, usuario: string | null) {
    await this.db.ticketLote.update({
      where: { id: loteId },
      data: {
        revisadoEm: new Date(),
        revisadoPor: usuario,
        revisadoNota: String(nota || '').trim().slice(0, 1000) || null,
      },
    });
    await this.avisar(loteId);
    return { ok: true };
  }

  // ───────────────────────── fila da loja ─────────────────────────

  /**
   * Pendências REAIS da loja nos últimos dias (a fila "O QUE FAZER AGORA" da
   * home). Só entra o que a própria loja resolve: mandar foto, refotografar,
   * completar os tickets que faltam — ou dizer que não tem.
   */
  async pendenciasDaLoja(storeCode: string) {
    const hoje = hojeBrasilia();
    const inicio = new Date(inicioDoDiaUtc(hoje).getTime() - DIAS_PENDENCIA * 24 * 60 * 60_000);
    const [sessoes, lotes] = await Promise.all([
      this.db.pdvCashSession.findMany({
        where: { storeCode, isTraining: false, openedAt: { gte: inicio, lt: inicioDoDiaUtc(hoje) } },
        select: { id: true, openedAt: true },
      }),
      this.db.ticketLote.findMany({
        where: { storeCode, dia: { gte: diaBrasiliaDe(inicio), lt: hoje } },
        select: { id: true, dia: true, status: true, token: true, semTicketsMotivo: true, resultado: true, fotosEnviadas: true },
      }),
    ]);
    if (!sessoes.length) return [];
    const vendas = await this.db.pdvSale.groupBy({
      by: ['cashSessionId'],
      where: { cashSessionId: { in: (sessoes as any[]).map((s) => s.id) }, status: 'finalized', isTraining: false },
      _count: { _all: true },
    });
    const comVenda = new Set((vendas as any[]).filter((v) => v._count._all > 0).map((v) => v.cashSessionId));
    const dias = new Set<string>();
    for (const s of sessoes as any[]) if (comVenda.has(s.id)) dias.add(diaBrasiliaDe(s.openedAt));
    const porDia = new Map((lotes as any[]).map((l) => [l.dia, l]));

    const ontem = diaBrasiliaDe(new Date(inicioDoDiaUtc(hoje).getTime() - 60_000));
    const tarefas: any[] = [];
    for (const dia of [...dias].sort().reverse()) {
      const lote = porDia.get(dia);
      if (!lote || lote.status === 'aguardando_fotos') {
        // O motivo explica a demora, não dispensa a foto: a tarefa fica, só
        // deixa de ser vermelha.
        tarefas.push({
          tipo: 'enviar',
          dia,
          diaCurto: diaCurto(dia),
          urgencia: dia < ontem && !lote?.semTicketsMotivo ? 'red' : 'yellow',
          loteId: lote?.id || null,
          titulo: `Fotografar os tickets de ${diaCurto(dia)}`,
          detalhe: lote?.semTicketsMotivo
            ? `motivo informado: ${String(lote.semTicketsMotivo).slice(0, 80)}`
            : 'maquininha, cupons de dinheiro/PIX, recibos de crediário e comprovantes de PIX',
        });
        continue;
      }
      if (lote.status === 'lendo') continue;
      const fotos = (lote.resultado as any)?.fotos;
      const problemas = (fotos?.erro || 0) + (fotos?.ilegiveis || 0);
      if (problemas > 0) {
        tarefas.push({
          tipo: 'refotografar',
          dia,
          diaCurto: diaCurto(dia),
          urgencia: 'yellow',
          loteId: lote.id,
          titulo: `Tirar de novo ${problemas} foto${problemas > 1 ? 's' : ''} dos tickets de ${diaCurto(dia)}`,
          detalhe: 'a leitura não conseguiu ler — foto mais perto, com luz e sem reflexo',
        });
      }
      const faltam = (lote.resultado as any)?.resultado?.contagem?.semTicket || 0;
      if (faltam > 0 && !lote.semTicketsMotivo) {
        tarefas.push({
          tipo: 'faltam',
          dia,
          diaCurto: diaCurto(dia),
          urgencia: 'yellow',
          loteId: lote.id,
          titulo: `Faltam ${faltam} ticket${faltam > 1 ? 's' : ''} de ${diaCurto(dia)}`,
          detalhe: 'fotografe os que faltam — ou diga por que não tem',
        });
      }
    }
    return tarefas.slice(0, 5);
  }

  // ───────────────────────── resumo diário (WhatsApp) ─────────────────────────

  async config(): Promise<ConfigConferencia> {
    const row = await this.db.appConfig.findUnique({ where: { key: CONFIG_CHAVE } });
    if (!row) return { ...CONFIG_PADRAO };
    const v = JSON.parse(row.valueJson || '{}');
    return {
      ativo: v.ativo !== false,
      destinos: Array.isArray(v.destinos) ? v.destinos.map(String) : [],
      hora: Number.isInteger(v.hora) && v.hora >= 0 && v.hora <= 23 ? v.hora : CONFIG_PADRAO.hora,
    };
  }

  async salvarConfig(dto: Partial<ConfigConferencia>, usuario: string | null) {
    const atual = await this.config();
    const destinos = Array.isArray(dto.destinos)
      ? [...new Set(dto.destinos.map((d) => String(d).replace(/\D/g, '')).filter((d) => d.length >= 10 && d.length <= 13))]
      : atual.destinos;
    const hora = dto.hora == null ? atual.hora : Number(dto.hora);
    if (!Number.isInteger(hora) || hora < 0 || hora > 23) throw new BadRequestException('Hora inválida (0 a 23)');
    const nova: ConfigConferencia = { ativo: dto.ativo == null ? atual.ativo : !!dto.ativo, destinos, hora };
    await this.db.appConfig.upsert({
      where: { key: CONFIG_CHAVE },
      create: { key: CONFIG_CHAVE, valueJson: JSON.stringify(nova) },
      update: { valueJson: JSON.stringify(nova) },
    });
    this.logger.log(`[tickets] config do resumo diário salva por ${usuario || '?'}: ${JSON.stringify(nova)}`);
    return nova;
  }

  /**
   * O resumo do dia: cada loja que ABRIU hoje, com o movimento que ela
   * conferiu nessa abertura. Loja que não abriu ainda não deve nada.
   */
  async textoResumoDiario(hoje = hojeBrasilia()): Promise<string | null> {
    const abriram = await this.db.pdvCashSession.findMany({
      where: { isTraining: false, openedAt: { gte: inicioDoDiaUtc(hoje), lt: fimDoDiaUtcExclusivo(hoje) } },
      select: { storeCode: true },
      distinct: ['storeCode'],
    });
    if (!abriram.length) return null;
    const lojas = await this.lojas();

    type Item = { codigo: string; nome: string; dia: string; status: string; frases: string[] };
    const itens: Item[] = [];
    for (const { storeCode } of abriram as any[]) {
      const anterior = await this.db.pdvCashSession.findFirst({
        where: { storeCode, isTraining: false, openedAt: { lt: inicioDoDiaUtc(hoje) } },
        orderBy: { openedAt: 'desc' },
        select: { openedAt: true },
      });
      if (!anterior) continue;
      const dia = diaBrasiliaDe(anterior.openedAt);
      const lote = await this.db.ticketLote.findUnique({ where: { storeCode_dia: { storeCode, dia } } });
      let status: string = lote?.status || 'sem_fotos';
      if (!lote) {
        const { esperados } = await this.montarEsperados(storeCode, dia);
        if (!esperados.some((e) => e.obrigatorio)) status = 'sem_movimento';
      }
      if (status === 'sem_movimento') continue;
      itens.push({
        codigo: storeCode,
        nome: lojas.get(storeCode)?.name || lote?.storeName || storeCode,
        dia,
        status,
        frases: lote?.fotosEnviadas ? frasesDoResultado((lote.resultado as any)?.resultado, 3) : [],
      });
      if (lote?.semTicketsMotivo && status === 'aguardando_fotos') {
        itens[itens.length - 1].frases = [`sem tickets: "${String(lote.semTicketsMotivo).slice(0, 80)}"`];
      }
    }
    if (!itens.length) return null;

    const diaMaisComum = [...itens.reduce((m, i) => m.set(i.dia, (m.get(i.dia) || 0) + 1), new Map<string, number>())]
      .sort((a, b) => b[1] - a[1])[0][0];
    const rotulo = (i: Item) => `${i.codigo} ${i.nome}${i.dia !== diaMaisComum ? ` (${diaCurto(i.dia)})` : ''}`;
    const grupo = (st: string[]) => itens.filter((i) => st.includes(i.status)).sort((a, b) => a.codigo.localeCompare(b.codigo, 'pt-BR', { numeric: true }));

    const linhas: string[] = [`🧾 *CONFERÊNCIA DE TICKETS* — ${diaCurto(hoje)}`, `movimento de ${diaCurto(diaMaisComum)}`, ''];
    const divergentes = grupo(['divergente']);
    if (divergentes.length) {
      linhas.push(`🔴 *Divergência (${divergentes.length})*`);
      for (const i of divergentes) linhas.push(`• ${rotulo(i)}: ${i.frases.join(' · ') || 'ver checklist'}`);
      linhas.push('');
    }
    const semFotos = grupo(['sem_fotos', 'aguardando_fotos']);
    if (semFotos.length) {
      linhas.push(`⏳ *Sem fotos (${semFotos.length})*`);
      for (const i of semFotos) linhas.push(`• ${rotulo(i)}${i.frases.length ? ` — ${i.frases[0]}` : ''}`);
      linhas.push('');
    }
    const atencao = grupo(['atencao']);
    if (atencao.length) {
      linhas.push(`🟡 *Atenção (${atencao.length})*`);
      for (const i of atencao) linhas.push(`• ${rotulo(i)}: ${i.frases.join(' · ') || 'ver checklist'}`);
      linhas.push('');
    }
    const lendo = grupo(['lendo']);
    if (lendo.length) linhas.push(`🔄 Ainda lendo: ${lendo.map(rotulo).join(', ')}`);
    const ok = grupo(['confere']);
    if (ok.length) linhas.push(`✅ Batem (${ok.length}): ${ok.map((i) => i.codigo).join(', ')}`);
    const base = String(process.env.FRONTEND_URL || '').trim().replace(/\/+$/, '');
    if (base) linhas.push('', `Checklist: ${base}/retaguarda/conferencia-tickets`);
    return linhas.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  async enviarResumoDiario(motivo: 'cron' | 'manual', usuario: string | null = null) {
    const cfg = await this.config();
    if (!cfg.destinos.length) {
      throw new BadRequestException('Cadastre ao menos um WhatsApp que recebe o resumo');
    }
    const hoje = hojeBrasilia();
    const texto = await this.textoResumoDiario(hoje);
    if (!texto) return { ok: true, enviado: false, motivo: 'nenhuma loja abriu o caixa hoje com movimento a conferir' };
    const falhas: string[] = [];
    for (const numero of cfg.destinos) {
      const r = await this.whatsapp.sendText(numero, texto).catch((e: any) => ({ ok: false, error: e?.message }));
      if (!r?.ok) falhas.push(`${numero}: ${(r as any)?.error || 'falhou'}`);
    }
    await this.db.appConfig.upsert({
      where: { key: CONFIG_ENVIO_CHAVE },
      create: { key: CONFIG_ENVIO_CHAVE, valueJson: JSON.stringify({ dia: hoje, em: new Date(), motivo, usuario, falhas }) },
      update: { valueJson: JSON.stringify({ dia: hoje, em: new Date(), motivo, usuario, falhas }) },
    });
    this.logger.log(
      `[tickets] resumo diário (${motivo}) → ${cfg.destinos.length - falhas.length}/${cfg.destinos.length} destino(s)` +
        (falhas.length ? ` · falhas: ${falhas.join('; ')}` : ''),
    );
    return { ok: falhas.length === 0, enviado: true, destinos: cfg.destinos.length, falhas, texto };
  }

  @Cron('5 * * * *', { name: 'conferencia-tickets-resumo', timeZone: 'America/Sao_Paulo' })
  async cronResumoDiario() {
    try {
      const cfg = await this.config();
      if (!cfg.ativo || !cfg.destinos.length) return;
      if (agoraBrasilia().getUTCHours() !== cfg.hora) return;
      const marca = await this.db.appConfig.findUnique({ where: { key: CONFIG_ENVIO_CHAVE } });
      const ultimo = marca ? JSON.parse(marca.valueJson || '{}') : {};
      if (ultimo.dia === hojeBrasilia()) return;
      await this.enviarResumoDiario('cron');
    } catch (e: any) {
      this.logger.warn(`[tickets] resumo diário falhou: ${e?.message || e}`);
    }
  }
}
