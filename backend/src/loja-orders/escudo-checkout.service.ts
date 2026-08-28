import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * ESCUDO ANTI-TESTE-DE-CARTÃO do checkout do site (28/08/2026).
 *
 * Na noite de 28/08 um bot de "card testing" passou ~650 cobranças de cartão
 * pelo checkout em 3 horas: nome/CPF/e-mail gerados (todos os CPFs com dígito
 * verificador VÁLIDO — validar CPF não resolve), botnet com 1 IP por tentativa
 * (rate-limit por IP não enxerga), carrinho fixo (R$ 95,35 / R$ 99,89) e
 * cardToken novo por tentativa. TODAS chegaram na Pagar.me — custo por
 * transação, antifraude queimado e risco real de a operadora suspender a
 * conta por excesso de recusa. Três cartões roubados foram APROVADOS e
 * viraram pedido com etiqueta.
 *
 * A defesa NÃO é heurística de dado (nome/e-mail/CPF gerados são
 * indistinguíveis de gente de verdade um a um) — é o COMPORTAMENTO:
 * loja normal tem ~1 recusa de cartão por DIA (medido: 10 em 8 dias);
 * teste de cartão são dezenas por minuto. Daí o desenho em camadas:
 *
 *  1. IP na lista `CHECKOUT_BLOQUEIO_IPS` → bloqueia (os IPs fixos do
 *     aquecimento do ataque; a botnet rotativa passa batida daqui).
 *  2. Cartão de IP fora do Brasil → bloqueia (`CHECKOUT_CARTAO_SO_BRASIL`).
 *     A loja só entrega no Brasil; a botnet era ~toda estrangeira. O país vem
 *     do `x-vercel-ip-country` repassado pelo BFF — sem o header, PASSA
 *     (fail-open: site antigo no ar não pode derrubar venda).
 *  3. VELOCITY: recusas reais de cartão + bloqueios na janela de
 *     `CHECKOUT_ESCUDO_JANELA_MIN` ≥ `CHECKOUT_ESCUDO_RECUSAS` → escudo
 *     ARMADO. Armado, cartão só passa pra cliente CONHECIDA (CPF, e-mail ou
 *     telefone com pedido PAGO antes). Cliente nova de cartão na janela do
 *     ataque leva `payment_unavailable` — o site oferece PIX, que não serve
 *     pra testar cartão e continua aberto SEMPRE.
 *
 * Bloqueio acontece ANTES de qualquer efeito: sem Order (não polui LP nem as
 * telas), sem upsert no CRM e sem chamada ao gateway. Cada bloqueio vira uma
 * linha em `checkout_bloqueios` e REALIMENTA a janela — enquanto o bot
 * insiste, o escudo não baixa.
 *
 * Modo manual em AppConfig `checkout-escudo` = { modo: 'auto'|'on'|'off' }
 * (tela/endpoint do admin): 'on' arma na mão (pânico), 'off' desarma o
 * velocity sem deploy (as camadas 1 e 2 continuam). Kill-switch total:
 * `CHECKOUT_ESCUDO=0`.
 */

export interface EscudoContexto {
  metodo: string;
  ip?: string | null;
  /** ISO-3166 do `x-cliente-pais` (BFF ← `x-vercel-ip-country`). */
  pais?: string | null;
  nome?: string | null;
  email?: string | null;
  cpf?: string | null;
  fone?: string | null;
  total?: number | null;
}

export interface EscudoBloqueio {
  error: string;
  code: 'payment_unavailable';
}

/**
 * Janela no `globalThis` pelo mesmo motivo do balde de rate-limit do
 * controller: o Nest recria providers em hot-reload e uma instância nova
 * zeraria a contagem no meio de um ataque.
 */
const JANELA_KEY = '__flowopsEscudoCheckoutJanela__';

type Janela = { eventos: number[]; seedFeito: boolean };

function janela(): Janela {
  const g = globalThis as any;
  if (!g[JANELA_KEY]) g[JANELA_KEY] = { eventos: [], seedFeito: false } as Janela;
  return g[JANELA_KEY];
}

@Injectable()
export class EscudoCheckoutService {
  private readonly logger = new Logger(EscudoCheckoutService.name);

  /** Cache do modo manual (AppConfig) — 30s pra não bater no banco por pedido. */
  private modoCache: { at: number; modo: 'auto' | 'on' | 'off' } | null = null;

  /**
   * A frase NÃO diz que foi bloqueio e NÃO fala do cartão: pro bot é
   * indistinguível de gateway fora do ar (nenhum resultado de teste vaza), e
   * pra cliente real que cair aqui durante um ataque o caminho do PIX segue
   * aberto — aprovação na hora, 5% de desconto.
   */
  private static readonly MSG_BLOQUEIO =
    'Não conseguimos processar pagamentos por cartão neste momento. ' +
    'Finalize com PIX (aprovação na hora) ou tente novamente mais tarde. 💜';

  constructor(private readonly prisma: PrismaService) {}

  private static ligado(): boolean {
    return process.env.CHECKOUT_ESCUDO !== '0';
  }

  private static soBrasil(): boolean {
    return process.env.CHECKOUT_CARTAO_SO_BRASIL !== '0';
  }

  static limiar(): number {
    const n = Number(process.env.CHECKOUT_ESCUDO_RECUSAS);
    return Number.isFinite(n) && n >= 2 ? n : 5;
  }

  static janelaMin(): number {
    const n = Number(process.env.CHECKOUT_ESCUDO_JANELA_MIN);
    return Number.isFinite(n) && n >= 1 ? n : 10;
  }

  /** Prefixos de IP bloqueados na mão (`200.219.50.` pega a faixa inteira). */
  private static ipsBloqueados(): string[] {
    return String(process.env.CHECKOUT_BLOQUEIO_IPS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  private async modo(): Promise<'auto' | 'on' | 'off'> {
    const agora = Date.now();
    if (this.modoCache && agora - this.modoCache.at < 30_000) return this.modoCache.modo;
    let modo: 'auto' | 'on' | 'off' = 'auto';
    try {
      const row = await (this.prisma as any).appConfig.findUnique({ where: { key: 'checkout-escudo' } });
      const v = row ? JSON.parse(row.valueJson) : null;
      if (v?.modo === 'on' || v?.modo === 'off') modo = v.modo;
    } catch {
      /* sem config = auto */
    }
    this.modoCache = { at: agora, modo };
    return modo;
  }

  async salvarModo(modo: 'auto' | 'on' | 'off'): Promise<void> {
    await (this.prisma as any).appConfig.upsert({
      where: { key: 'checkout-escudo' },
      create: { key: 'checkout-escudo', valueJson: JSON.stringify({ modo }) },
      update: { valueJson: JSON.stringify({ modo }) },
    });
    this.modoCache = null;
  }

  /**
   * Recusa REAL da operadora (`cobrarCartao` → kind 'recusa'). É quem arma o
   * escudo no modo auto — bloqueio também realimenta, em `bloquear()`.
   */
  registrarRecusa(): void {
    janela().eventos.push(Date.now());
  }

  /**
   * Eventos vivos na janela. No primeiro uso após um deploy, SEMEIA do banco
   * (recusas `payment_failed` recentes): reiniciar o backend no meio do
   * ataque não pode desarmar o escudo.
   */
  private async eventosNaJanela(): Promise<number> {
    const j = janela();
    const corte = Date.now() - EscudoCheckoutService.janelaMin() * 60_000;
    j.eventos = j.eventos.filter((t) => t > corte);
    if (!j.seedFeito) {
      j.seedFeito = true;
      try {
        const desde = new Date(corte);
        const [recusas, bloqueios] = await Promise.all([
          (this.prisma as any).order.count({
            where: { status: 'payment_failed', createdAt: { gt: desde } },
          }),
          (this.prisma as any).checkoutBloqueio.count({ where: { criadoEm: { gt: desde } } }),
        ]);
        for (let i = 0; i < recusas + bloqueios; i++) j.eventos.push(Date.now());
      } catch (e: any) {
        this.logger.warn(`[escudo] seed da janela falhou: ${e?.message || e}`);
      }
    }
    return j.eventos.length;
  }

  /** Já pagou alguma vez? CPF, e-mail ou telefone com pedido de `paidAt` carimbado. */
  private async clienteConhecida(ctx: EscudoContexto): Promise<boolean> {
    const cpf = String(ctx.cpf || '').replace(/\D/g, '');
    const email = String(ctx.email || '').trim();
    const fone = String(ctx.fone || '').replace(/\D/g, '');
    const or: any[] = [];
    if (cpf.length === 11) or.push({ customerCpf: cpf });
    if (email) or.push({ customerEmail: { equals: email, mode: 'insensitive' } });
    if (fone.length >= 10) or.push({ customerPhone: fone });
    if (!or.length) return false;
    try {
      const hit = await (this.prisma as any).order.findFirst({
        where: { paidAt: { not: null }, OR: or },
        select: { id: true },
      });
      return !!hit;
    } catch {
      // Na dúvida o banco decide COM o pedido, não contra: quem responde por
      // negar venda boa é o escudo, então erro de consulta = deixa passar.
      return true;
    }
  }

  private async bloquear(ctx: EscudoContexto, motivo: string): Promise<EscudoBloqueio> {
    // Bloqueio conta na janela: enquanto o bot martela, o escudo fica de pé.
    janela().eventos.push(Date.now());
    try {
      await (this.prisma as any).checkoutBloqueio.create({
        data: {
          ip: ctx.ip || null,
          pais: ctx.pais || null,
          nome: String(ctx.nome || '').slice(0, 120) || null,
          email: String(ctx.email || '').slice(0, 140) || null,
          cpf: String(ctx.cpf || '').replace(/\D/g, '').slice(0, 14) || null,
          total: Number(ctx.total) || null,
          metodo: String(ctx.metodo || '').slice(0, 10) || null,
          motivo,
        },
      });
    } catch (e: any) {
      this.logger.warn(`[escudo] não registrou bloqueio (${e?.message || e}) — bloqueando mesmo assim`);
    }
    this.logger.warn(
      `[escudo] checkout BLOQUEADO (${motivo}) ip=${ctx.ip || '?'} pais=${ctx.pais || '?'} email=${ctx.email || '?'} total=${ctx.total ?? '?'}`,
    );
    return { error: EscudoCheckoutService.MSG_BLOQUEIO, code: 'payment_unavailable' };
  }

  /**
   * Chamado no TOPO do `criarPedido`, antes de reprecificar/CRM/Order/gateway.
   * `null` = segue o baile; objeto = recusa pronta pro site.
   */
  async avaliar(ctx: EscudoContexto): Promise<EscudoBloqueio | null> {
    if (!EscudoCheckoutService.ligado()) return null;
    // PIX nunca bloqueia: não existe "teste de PIX" — dinheiro só se pagar.
    if (ctx.metodo !== 'card') return null;

    const ip = String(ctx.ip || '');
    if (ip && EscudoCheckoutService.ipsBloqueados().some((p) => ip.startsWith(p))) {
      return this.bloquear(ctx, 'ip_bloqueado');
    }

    const pais = String(ctx.pais || '').trim().toUpperCase();
    if (EscudoCheckoutService.soBrasil() && pais && pais !== 'BR') {
      return this.bloquear(ctx, 'pais');
    }

    const modo = await this.modo();
    if (modo === 'off') return null;
    const armado =
      modo === 'on' || (await this.eventosNaJanela()) >= EscudoCheckoutService.limiar();
    if (!armado) return null;

    if (await this.clienteConhecida(ctx)) return null;
    return this.bloquear(ctx, 'escudo');
  }

  /** Pro endpoint do admin: o estado que explica "por que travou/não travou". */
  async status() {
    const [naJanela, modo] = await Promise.all([this.eventosNaJanela(), this.modo()]);
    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);
    const [bloqueiosHoje, ultimos] = await Promise.all([
      (this.prisma as any).checkoutBloqueio.count({ where: { criadoEm: { gte: hoje } } }),
      (this.prisma as any).checkoutBloqueio.findMany({
        orderBy: { criadoEm: 'desc' },
        take: 50,
      }),
    ]);
    return {
      ligado: EscudoCheckoutService.ligado(),
      soBrasil: EscudoCheckoutService.soBrasil(),
      modo,
      armado: modo === 'on' || naJanela >= EscudoCheckoutService.limiar(),
      eventosNaJanela: naJanela,
      limiar: EscudoCheckoutService.limiar(),
      janelaMin: EscudoCheckoutService.janelaMin(),
      ipsBloqueados: EscudoCheckoutService.ipsBloqueados(),
      bloqueiosHoje,
      ultimos,
    };
  }
}
