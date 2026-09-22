import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { CustomerPushService } from './customer-push.service';
import { CashbackService } from '../cashback/cashback.service';

/**
 * A VISÃO DO APP SOBRE O CASHBACK — e só isso.
 *
 * ── O QUE ERA, E POR QUE ENCOLHEU (22/09/2026) ──
 *
 * Este service era um LEDGER inteiro e paralelo: creditava, resgatava,
 * expirava e guardava saldo em `customer_accounts.cashback_balance_cents` +
 * `customer_cashback_txs`. O ganho vinha dos hooks de pedido do WooCommerce
 * (deletados na Onda 3, porque o WP morreu em 27/08) e o gasto, do checkout do
 * app, que batia no mesmo WordPress apagado. Sobrou um saldo que não crescia,
 * não podia ser gasto e mesmo assim aparecia pra cliente com o rótulo
 * "Disponível pra usar".
 *
 * Era o terceiro de TRÊS cashbacks (este, o do CRM e o da rede), cada tela
 * lendo um. Agora existe um só — `CashbackService`, chave = CPF — e este
 * arquivo virou o que sempre deveria ter sido: a ponte entre o app e ele.
 *
 * Ficaram duas coisas, as duas de LEITURA:
 *   · `getStatement` — saldo e extrato pra tela /conta/cashback e pro app;
 *   · `warnExpiringSoon` — o push de D-7.
 *
 * Saíram `earnFromOrder`, `earnWelcomeBonus`, `redeem`, `creditAndUpdate` e o
 * job diário de expirar. Os três primeiros não tinham chamador desde a Onda 3;
 * o bônus de boas-vindas agora entra por `CashbackService.creditarBonus`, e o
 * vencimento é aritmética de data, não estado gravado por cron.
 *
 * As envs CASHBACK_RATE_PCT / CASHBACK_TTL_DAYS / APP_WELCOME_BONUS_CENTS
 * seguem aqui porque o bônus de boas-vindas ainda lê a última. As duas
 * primeiras viraram letra morta: a regra (10% / 3%, validade) é a do
 * `SystemSetting: cashback_rede_config`, editável em /retaguarda/cashback sem
 * deploy.
 */
@Injectable()
export class CustomerCashbackService {
  private readonly logger = new Logger(CustomerCashbackService.name);

  readonly RATE_PCT: number;
  readonly TTL_DAYS: number;
  readonly WELCOME_CENTS: number;
  readonly EXPIRE_WARNING_DAYS: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly cfg: ConfigService,
    private readonly push: CustomerPushService,
    private readonly cashbackRede: CashbackService,
  ) {
    this.RATE_PCT = Number(this.cfg.get('CASHBACK_RATE_PCT') ?? 10);
    this.TTL_DAYS = Number(this.cfg.get('CASHBACK_TTL_DAYS') ?? 30);
    this.WELCOME_CENTS = Number(this.cfg.get('APP_WELCOME_BONUS_CENTS') ?? 2000);
    this.EXPIRE_WARNING_DAYS = Number(this.cfg.get('CASHBACK_WARNING_DAYS') ?? 7);
  }

  /**
   * O EXTRATO QUE A CLIENTE VÊ — site (/conta/cashback) e app.
   *
   * ── MUDOU DE FONTE EM 22/09/2026, e o formato foi mantido de propósito ──
   *
   * Lia `customer_accounts.cashback_balance_cents` + `customer_cashback_txs`:
   * um terceiro ledger, que só a conta do app enxergava. O ganho dele vinha
   * dos hooks de pedido do WooCommerce (`order-app-hooks.service`, deletado na
   * Onda 3) e o gasto, do checkout do app que batia no WordPress apagado em
   * 27/08. Resultado: a tela dizia "Disponível pra usar" sobre um saldo que
   * parou de crescer em agosto e que não tinha onde ser gasto.
   *
   * Agora lê `cashback_creditos` (chave = CPF) — o mesmo saldo que a loja
   * física mostra e aceita. A CHAVE MUDOU junto: era a conta do app, agora é
   * o CPF da pessoa. Quem comprou na loja passa a ver o saldo no site, o que
   * antes não acontecia.
   *
   * O formato de resposta é o mesmo de antes (`balance`, `rate`, `ttlDays`,
   * `nextExpiration`, `transactions`) porque o site e o app já o consomem —
   * trocar a fonte e o contrato no mesmo passo deixaria a tela em branco sem
   * ninguém saber qual das duas mudanças quebrou.
   */
  async getStatement(accountId: string, opts?: { limit?: number }) {
    const limit = Math.min(opts?.limit || 50, 100);

    const account = await this.prisma.customerAccount.findUnique({
      where: { id: accountId },
      select: { cpf: true },
    });
    if (!account) throw new BadRequestException('Conta não encontrada');

    const e = await this.cashbackRede.extrato(account.cpf, limit);

    return {
      balance: e.saldo,
      earned: e.totalGanho,
      spent: e.totalUsado,
      // A taxa é a das PRÓXIMAS compras dela. Mostrar 10% (primeira compra)
      // pra quem já comprou seria prometer o dobro do que ela vai receber.
      rate: e.pctDemais,
      ttlDays: e.validadeDias,
      /** Saldo que existe mas ainda está na carência — a tela avisa a data. */
      aLiberar: e.aLiberar,
      liberaEm: e.liberaEm,
      /** Onde ela pode gastar. É a pergunta que o extrato antigo não respondia. */
      ondeUsar: e.ativo
        ? `Em qualquer loja Lurd's — é só dar o CPF no caixa. Dá pra abater até ${e.usoMaxPctCompra}% da compra, a partir de R$ ${e.minimoUsoReais.toFixed(2)} de saldo.`
        : null,
      ativo: e.ativo,
      nextExpiration:
        e.proximaExpiracao && e.expiraEmBreve > 0
          ? {
              amount: e.expiraEmBreve,
              expiresAt: new Date(`${e.proximaExpiracao}T12:00:00.000Z`),
              daysLeft: Math.max(
                0,
                Math.ceil(
                  (new Date(`${e.proximaExpiracao}T12:00:00.000Z`).getTime() - Date.now()) / 86400000,
                ),
              ),
            }
          : null,
      transactions: e.movimentos.map((m) => ({
        id: m.id,
        // Vocabulário do site: 'earn' entra, 'spend' sai. O ledger novo fala
        // 'ganho'/'usado'/'expirado'/'estorno' — a tradução mora aqui pra a
        // página não precisar aprender duas línguas.
        type:
          m.tipo === 'ganho' ? 'earn'
          : m.tipo === 'usado' ? 'spend'
          : m.tipo === 'expirado' ? 'expire'
          : 'adjust',
        amount: m.valor,
        balanceAfter: null,
        description: m.descricao,
        date: m.data,
        expiresAt: m.expiraEm ? new Date(`${m.expiraEm}T12:00:00.000Z`) : null,
      })),
    };
  }

  /**
   * AVISO DE VENCIMENTO — push em D-7.
   *
   * ── REESCRITO EM 22/09/2026 ──
   *
   * Lia `customer_cashback_txs`, o ledger do app. Depois da unificação isso
   * viraria o pior tipo de notificação: "R$ 30 do seu cashback vencem em 7
   * dias" calculado sobre um saldo que a tela /cashback não mostra mais. A
   * cliente abriria o app e veria outro número — ou nenhum.
   *
   * Agora pergunta ao ledger único, pelo CPF da conta. Quem tem push ativo e
   * saldo vencendo recebe; quem não tem conta no app não recebe nada por aqui
   * (o aviso dela é a vendedora no caixa).
   *
   * O JOB DE EXPIRAR SUMIU e não faz falta: no ledger único o vencimento é
   * ARITMÉTICA de data em cima do crédito (`saldo()` compara com `expiraEm`),
   * não um estado gravado por um cron. Cron que precisa rodar pra um número
   * ficar certo é cron que, quando falha, deixa o número errado — foi assim
   * que o crediário quase ressuscitou dívida paga.
   */
  @Cron('0 0 9 * * *')
  async warnExpiringSoon() {
    // Só quem tem conta no app: o push é o canal, sem conta não há pra onde
    // mandar. A varredura é pelo CPF, que é a chave do ledger.
    const contas = await this.prisma.customerAccount.findMany({
      select: { id: true, cpf: true, name: true },
    });

    let warned = 0;
    for (const conta of contas) {
      try {
        const s = await this.cashbackRede.saldo(conta.cpf);
        if (s.expiraEmBreve <= 0) continue;

        await this.push
          .sendToAccount(conta.id, {
            title: '💸 Seu cashback está expirando',
            body:
              `R$ ${s.expiraEmBreve.toFixed(2).replace('.', ',')} vencem até ` +
              `${new Date(`${s.proximaExpiracao}T12:00:00`).toLocaleDateString('pt-BR')}. ` +
              'Use em qualquer loja Lurd\'s — é só dar o CPF no caixa.',
            url: '/cashback',
            tag: 'cashback-warning',
          })
          .catch(() => null);
        warned++;
      } catch {
        /* uma conta com CPF torto não pode derrubar a varredura inteira */
      }
    }

    this.logger.log(`Cashback expire warnings enviados: ${warned}`);
    return { warned };
  }
}
