import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { AvaliacoesService } from '../avaliacoes/avaliacoes.service';
import { AvaliacoesConfigService } from '../avaliacoes/avaliacoes-config.service';

/**
 * O CONVITE PRA AVALIAR — o toque que faltava pra fila encher.
 *
 * O centro de avaliação (`/conta/avaliacoes`) já existe e funciona, mas é
 * PASSIVO: descobre a fila quem entra na conta. A maioria compra como
 * visitante e não volta ao site depois de receber a peça — a fila ficava
 * esperando alguém aparecer.
 *
 * Aqui está a parte ativa:
 *   · **D+5 da ENTREGA CONFIRMADA** (`cfg.diasConvite`, régua da tela da
 *     matriz, padrão 5). O marco é o `deliveredAt` que o `RastreioSyncCron`
 *     carimba — pedido dividido só chega nesse estado quando TODAS as caixas
 *     chegam, então o convite nunca sai com peça ainda no caminhão.
 *   · **link SEM LOGIN**. O link chega no WhatsApp e vai ser aberto no
 *     celular; parede de senha na frente de um pedido de favor é o jeito mais
 *     rápido de não receber resposta.
 *   · **e cai no MESMO formulário e nas MESMAS tabelas** do centro de
 *     avaliação. Nada de segunda régua de pontos pra divergir da primeira.
 *
 * ── COMO O LINK VIRA CONTA ──
 *
 * `product_reviews` é chaveado por `CustomerAccount` (a conta do site). Quem
 * comprou como visitante não tem uma. Então o convite RESOLVE a conta pelo CPF
 * do pedido e, se não existir, cria uma conta-casca: mesmos dados do pedido,
 * vinculada aos cadastros da rede, com senha impossível de acertar. Ela vira
 * conta de verdade no dia em que a cliente usar "esqueci a senha" — e o
 * histórico dela já está lá esperando.
 */
@Injectable()
export class PosVendaService {
  private readonly logger = new Logger(PosVendaService.name);

  /** Validade do link. Longo de propósito: WhatsApp fica sem ler por semanas. */
  private static readonly LINK_DIAS = 45;
  /** Entrega mais velha que isto não vira convite — notícia velha. */
  private static readonly JANELA_DIAS = 30;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly http: HttpService,
    private readonly whats: WhatsappService,
    private readonly avaliacoes: AvaliacoesService,
    private readonly cfgSvc: AvaliacoesConfigService,
  ) {}

  static digits(v: unknown): string {
    return String(v ?? '').replace(/\D/g, '');
  }

  /** CPF só vale se for CPF — 11 dígitos e nada de "00000000000". */
  static cpfValido(v: unknown): string | null {
    const d = PosVendaService.digits(v);
    if (d.length !== 11) return null;
    if (/^(\d)\1{10}$/.test(d)) return null;
    return d;
  }

  // ─────────────────────────── o convite ───────────────────────────

  /** Endereço da vitrine — a mesma env que o revalidate usa. Aceita lista. */
  private baseDoSite(): string {
    const bruto = String(this.config.get<string>('ECOMMERCE_URL') || '').split(',')[0].trim();
    return (bruto || 'https://www.lurdsplussize.com.br').replace(/\/+$/, '');
  }

  linkDoConvite(token: string): string {
    return `${this.baseDoSite()}/avaliar/${token}`;
  }

  /**
   * Cria o convite do pedido (ou devolve o que já existe).
   *
   * `orderId` unique na tabela é a trava: dois processos (o cron reentrando
   * depois de um restart) não criam dois convites — e o link que já foi pro
   * WhatsApp continua valendo.
   */
  async criarConvite(orderId: string): Promise<any> {
    const pedido = await (this.prisma as any).order.findUnique({
      where: { id: orderId },
      select: {
        id: true, wcOrderNumber: true, customerName: true, customerPhone: true,
        customerCpf: true, deliveredAt: true, avaliacaoConvite: true,
      },
    });
    if (!pedido) throw new NotFoundException('Pedido não encontrado');
    if (pedido.avaliacaoConvite) return pedido.avaliacaoConvite;

    return (this.prisma as any).avaliacaoConvite.create({
      data: {
        orderId: pedido.id,
        token: randomBytes(24).toString('base64url'),
        cpf: PosVendaService.cpfValido(pedido.customerCpf),
        telefone: PosVendaService.digits(pedido.customerPhone).slice(0, 20) || null,
        nomeCliente: pedido.customerName ?? null,
        entregueEm: pedido.deliveredAt ?? null,
        expiraEm: new Date(Date.now() + PosVendaService.LINK_DIAS * 86_400_000),
      },
    });
  }

  /**
   * Manda o convite. Dois canais, como todo aviso de pedido da casa: o webhook
   * do n8n (onde vivem os fluxos) e o WhatsApp direto (o plano B liberado pelo
   * dono em 14/08). Devolve se ALGUM canal saiu.
   *
   * Carimba `enviadoEm` só quando algo saiu de verdade — carimbo sem mensagem
   * é pior que retry: o pedido some do radar pra sempre.
   */
  async enviarConvite(conviteId: string, canal: 'whatsapp' | 'manual' = 'whatsapp'): Promise<boolean> {
    const cfg = await this.cfgSvc.get();
    const convite = await (this.prisma as any).avaliacaoConvite.findUnique({
      where: { id: conviteId },
      include: { order: { select: { wcOrderNumber: true, customerName: true, customerPhone: true } } },
    });
    if (!convite) throw new NotFoundException('Convite não encontrado');

    const telefone = PosVendaService.digits(convite.telefone || convite.order?.customerPhone);
    const nome = String(convite.nomeCliente || convite.order?.customerName || '')
      .trim().split(/\s+/)[0] || 'tudo bem';
    const numero = convite.order?.wcOrderNumber ? ` ${convite.order.wcOrderNumber}` : '';
    const link = this.linkDoConvite(convite.token);
    // O TETO, não o piso: "ganhe até N" é o que faz ela abrir. A régua de
    // quanto cada parte vale é do backend e aparece na própria tela.
    const teto = cfg.pontosEnvio + cfg.pontosTexto + cfg.pontosFoto + cfg.pontosMedidas;

    const texto =
      `Oi, ${nome}! 💛\n\nSeu pedido${numero} chegou faz alguns dias — conta pra gente como ficou?\n\n` +
      `Você ganha até *${teto} pontos* por peça: as estrelas já valem, e sobe se você escrever como ` +
      `serviu e mandar uma foto usando. Os pontos viram desconto na próxima compra.\n\n` +
      `Leva menos de um minuto:\n${link}`;

    const n8nOk = await this.avisarN8n(convite, link, texto);
    let whatsOk = false;
    if (telefone.length >= 10) {
      try {
        const r = await this.whats.sendText(telefone, texto);
        whatsOk = !!r?.ok;
        if (!whatsOk) this.logger.warn(`[pos-venda] convite não saiu (${convite.id}): ${r?.error}`);
      } catch (e: any) {
        this.logger.warn(`[pos-venda] WhatsApp falhou (${convite.id}): ${e?.message || e}`);
      }
    }

    if (!n8nOk && !whatsOk) return false;
    await (this.prisma as any).avaliacaoConvite.update({
      where: { id: convite.id },
      data: { enviadoEm: new Date(), canal, tentativas: { increment: 1 } },
    });
    return true;
  }

  /**
   * O payload imita o dos outros avisos de pedido (`PedidoEmailService`): é o
   * formato que os fluxos do n8n já sabem ler. `evento` distingue o ramo.
   */
  private async avisarN8n(convite: any, link: string, texto: string): Promise<boolean> {
    const url = String(this.config.get<string>('N8N_PEDIDO_WEBHOOK_URL') || '').trim();
    if (!url) return false;
    const nomeCompleto = String(convite.nomeCliente || '').trim();
    const [primeiro, ...resto] = nomeCompleto.split(/\s+/);
    try {
      await firstValueFrom(
        this.http.post(
          url,
          {
            id: convite.order?.wcOrderNumber ?? convite.orderId,
            status: 'delivered',
            evento: 'avaliar_pedido',
            billing: {
              first_name: primeiro || '',
              last_name: resto.join(' '),
              phone: PosVendaService.digits(convite.telefone),
            },
            avaliacao: { link, token: convite.token, texto },
          },
          { timeout: 8_000 },
        ),
      );
      return true;
    } catch (e: any) {
      this.logger.warn(`[pos-venda] n8n recusou o convite ${convite.id}: ${e?.message || e}`);
      return false;
    }
  }

  // ─────────────────────── o link sem login ───────────────────────

  /**
   * Token → conta do site. Cria a conta-casca quando a cliente comprou como
   * visitante (ver o cabeçalho da classe).
   *
   * A senha é 64 bytes aleatórios gravados como hash — nenhuma senha digitada
   * bate com isso, então a conta NÃO fica aberta: ela só é alcançável por este
   * link, ou depois que a própria cliente definir uma senha pelo "esqueci a
   * minha senha". Deixar `passwordHash` vazio seria o contrário disso.
   */
  private async contaDoConvite(convite: any): Promise<string> {
    const cpf =
      PosVendaService.cpfValido(convite.cpf) ??
      PosVendaService.cpfValido(convite.order?.customerCpf);
    if (!cpf) {
      throw new BadRequestException(
        'Esse pedido está sem CPF, então não temos onde guardar seus pontos. Fala com a gente no WhatsApp que a gente resolve.',
      );
    }

    const existente = await (this.prisma as any).customerAccount.findUnique({
      where: { cpf },
      select: { id: true },
    });
    if (existente) return existente.id;

    const cadastros = await (this.prisma as any).customer.findMany({
      where: { cpf },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: 20,
    });

    const conta = await (this.prisma as any).$transaction(async (tx: any) => {
      const acc = await tx.customerAccount.create({
        data: {
          cpf,
          name: convite.nomeCliente ?? convite.order?.customerName ?? null,
          phone: PosVendaService.digits(convite.telefone || convite.order?.customerPhone) || null,
          passwordHash: randomBytes(64).toString('hex'),
        },
      });
      if (cadastros.length) {
        await tx.customerAccountLink.createMany({
          data: cadastros.map((c: any, i: number) => ({
            accountId: acc.id,
            customerId: c.id,
            isPrimary: i === 0,
          })),
          skipDuplicates: true,
        });
      }
      return acc;
    });
    this.logger.log(`[pos-venda] conta criada pelo convite (cpf ***${cpf.slice(-4)})`);
    return conta.id;
  }

  private async conviteValido(token: string) {
    const convite = await (this.prisma as any).avaliacaoConvite.findUnique({
      where: { token: String(token || '').trim() },
      include: {
        order: {
          select: { id: true, wcOrderNumber: true, customerName: true, customerCpf: true, deliveredAt: true },
        },
      },
    });
    if (!convite) throw new NotFoundException('Link inválido ou expirado');
    if (convite.expiraEm && convite.expiraEm.getTime() < Date.now()) {
      throw new BadRequestException('Este link de avaliação expirou.');
    }
    return convite;
  }

  /** O que a cliente vê ao abrir o link: o MESMO centro de avaliação, sem login. */
  async porToken(token: string) {
    const convite = await this.conviteValido(token);

    // Primeira abertura: registra pra medir quem abre e não responde — sem
    // isso, "ninguém avalia" e "ninguém abriu" viram o mesmo número.
    if (!convite.abertoEm) {
      await (this.prisma as any).avaliacaoConvite
        .updateMany({ where: { id: convite.id, abertoEm: null }, data: { abertoEm: new Date() } })
        .catch(() => null);
    }

    const accountId = await this.contaDoConvite(convite);
    const centro = await this.avaliacoes.centro(accountId);
    return {
      token: convite.token,
      pedido: convite.order?.wcOrderNumber ?? null,
      cliente: String(convite.nomeCliente || convite.order?.customerName || '').split(/\s+/)[0] || null,
      entregueEm: convite.entregueEm?.toISOString?.() ?? convite.order?.deliveredAt?.toISOString?.() ?? null,
      respondidoEm: convite.respondidoEm?.toISOString?.() ?? null,
      ...centro,
    };
  }

  /** Grava a avaliação pelo link — mesma service, mesma régua, mesma tabela. */
  async registrarPorToken(token: string, dto: any) {
    const convite = await this.conviteValido(token);
    const accountId = await this.contaDoConvite(convite);
    const r = await this.avaliacoes.criar(accountId, dto || {});
    await (this.prisma as any).avaliacaoConvite
      .updateMany({ where: { id: convite.id }, data: { respondidoEm: new Date() } })
      .catch(() => null);
    return r;
  }

  /** A conta por trás do token — o upload de foto precisa dela. */
  async contaPorToken(token: string): Promise<string> {
    return this.contaDoConvite(await this.conviteValido(token));
  }

  // ─────────────────────────── a retaguarda ───────────────────────────

  /**
   * SÓ O NÚMERO DO BADGE: entregas que já passaram do prazo e ninguém chamou.
   *
   * Separado da fila porque a tela de separação recarrega os contadores a cada
   * 30 segundos, em todo PC de matriz aberto: puxar a lista inteira nesse ritmo
   * seria gastar banco pra desenhar um número de dois dígitos.
   */
  async resumoDoBadge(): Promise<{ aEnviar: number }> {
    const cfg = await this.cfgSvc.get();
    const agora = Date.now();
    const aEnviar = await (this.prisma as any).order.count({
      where: {
        status: 'delivered',
        source: { in: ORIGENS_POS_VENDA },
        deliveredAt: {
          gte: new Date(agora - PosVendaService.JANELA_DIAS * 86_400_000),
          lte: new Date(agora - cfg.diasConvite * 86_400_000),
        },
        // Sem convite, ou com convite que nunca saiu — os dois são "ninguém
        // chamou essa cliente ainda".
        OR: [{ avaliacaoConvite: null }, { avaliacaoConvite: { enviadoEm: null } }],
      },
    });
    return { aEnviar };
  }

  /**
   * A aba "Pós-venda": o funil inteiro numa lista só — quem foi entregue, quem
   * já foi chamado, quem abriu e quem respondeu.
   *
   * A MODERAÇÃO não mora aqui: ela tem tela própria em `/retaguarda/avaliacoes`,
   * junto da régua de pontos. Duas telas decidindo o que publica seria duas
   * políticas divergindo sozinhas.
   */
  async fila(params: { de?: string; ate?: string; situacao?: string; busca?: string }) {
    const cfg = await this.cfgSvc.get();
    const de = params.de ? new Date(`${params.de}T00:00:00`) : new Date(Date.now() - 30 * 86_400_000);
    const ate = params.ate ? new Date(`${params.ate}T23:59:59`) : new Date();

    const pedidos: any[] = await (this.prisma as any).order.findMany({
      where: {
        AND: [
          { status: 'delivered' },
          { deliveredAt: { gte: de, lte: ate } },
          { source: { in: ORIGENS_POS_VENDA } },
          ...(params.busca
            ? [
                {
                  OR: [
                    { wcOrderNumber: { contains: params.busca, mode: 'insensitive' } },
                    { customerName: { contains: params.busca, mode: 'insensitive' } },
                    { customerPhone: { contains: params.busca } },
                  ],
                },
              ]
            : []),
        ],
      },
      select: {
        id: true, wcOrderNumber: true, customerName: true, customerPhone: true,
        customerCpf: true, deliveredAt: true, source: true, totalAmount: true,
        items: { select: { id: true } },
        avaliacaoConvite: {
          select: {
            id: true, token: true, enviadoEm: true, abertoEm: true,
            respondidoEm: true, tentativas: true,
          },
        },
      },
      orderBy: { deliveredAt: 'desc' },
      take: 300,
    });

    // As avaliações que já existem pra esses pedidos — uma consulta só.
    const ids = pedidos.map((p) => p.id);
    const reviews: any[] = ids.length
      ? await (this.prisma as any).productReview.findMany({
          where: { orderId: { in: ids } },
          select: {
            id: true, orderId: true, nota: true, texto: true, fotos: true,
            produtoNome: true, cor: true, tamanho: true, status: true, pontos: true,
          },
        })
      : [];
    const porPedido = new Map<string, any[]>();
    for (const r of reviews) {
      const lista = porPedido.get(r.orderId) ?? [];
      lista.push(r);
      porPedido.set(r.orderId, lista);
    }

    const prazo = cfg.diasConvite * 86_400_000;
    const linhas = pedidos.map((p) => {
      const c = p.avaliacaoConvite;
      const avaliacoes = porPedido.get(p.id) ?? [];
      const venceEm = p.deliveredAt ? new Date(p.deliveredAt).getTime() + prazo : null;
      const situacao = !c || !c.enviadoEm
        ? venceEm && venceEm <= Date.now()
          ? 'a_enviar'
          : 'aguardando_prazo'
        : avaliacoes.length
          ? 'avaliou'
          : 'convidada';
      return {
        orderId: p.id,
        pedido: p.wcOrderNumber,
        cliente: p.customerName,
        telefone: p.customerPhone,
        temCpf: !!PosVendaService.cpfValido(p.customerCpf),
        origem: p.source,
        total: p.totalAmount ?? null,
        pecas: p.items?.length ?? 0,
        entregueEm: p.deliveredAt?.toISOString?.() ?? null,
        convidarEm: venceEm ? new Date(venceEm).toISOString() : null,
        conviteId: c?.id ?? null,
        link: c ? this.linkDoConvite(c.token) : null,
        enviadoEm: c?.enviadoEm?.toISOString?.() ?? null,
        abertoEm: c?.abertoEm?.toISOString?.() ?? null,
        respondidoEm: c?.respondidoEm?.toISOString?.() ?? null,
        tentativas: c?.tentativas ?? 0,
        situacao,
        avaliacoes: avaliacoes.map((a) => ({
          id: a.id,
          nota: a.nota,
          texto: a.texto,
          fotos: this.lerFotos(a.fotos),
          produto: a.produtoNome,
          cor: a.cor,
          tamanho: a.tamanho,
          status: a.status,
          pontos: a.pontos,
        })),
      };
    });

    const filtradas = params.situacao ? linhas.filter((l) => l.situacao === params.situacao) : linhas;
    return {
      config: {
        ativo: cfg.ativo,
        diasConvite: cfg.diasConvite,
        pontosEnvio: cfg.pontosEnvio,
        pontosTexto: cfg.pontosTexto,
        pontosFoto: cfg.pontosFoto,
        pontosMedidas: cfg.pontosMedidas,
        pontosPorReal: cfg.pontosPorReal,
      },
      resumo: {
        entregues: linhas.length,
        aEnviar: linhas.filter((l) => l.situacao === 'a_enviar').length,
        aguardandoPrazo: linhas.filter((l) => l.situacao === 'aguardando_prazo').length,
        convidadas: linhas.filter((l) => l.situacao === 'convidada').length,
        avaliaram: linhas.filter((l) => l.situacao === 'avaliou').length,
        abriram: linhas.filter((l) => !!l.abertoEm).length,
      },
      linhas: filtradas,
    };
  }

  /** `fotos` é JSON em coluna de texto — a convenção da casa. */
  private lerFotos(raw: any): string[] {
    if (!raw) return [];
    try {
      const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return Array.isArray(v) ? v.filter((u) => typeof u === 'string') : [];
    } catch {
      return [];
    }
  }
}

/**
 * Origens que entram no pós-venda.
 *
 * O site ANTIGO (`source: 'site'`, WooCommerce) fica de fora de propósito: o
 * pedido de lá nasce de um espelho e o item nem sempre tem REF/cor confiáveis —
 * a avaliação cairia na família errada, que é pior que não existir (a lição da
 * REF reciclada). Ele aparece em "Em trânsito", que só depende do rastreio, e
 * não aqui, que depende de saber QUAL peça a cliente recebeu.
 */
export const ORIGENS_POS_VENDA = ['ecommerce', 'pdv_online', 'live'];
