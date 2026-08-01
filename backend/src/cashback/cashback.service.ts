import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { hojeBrasilia } from '../common/tz';

/**
 * CASHBACK DA REDE — o motor.
 *
 * Regra fechada com o dono em 01/08/2026:
 *   · 10% na PRIMEIRA compra da pessoa, 3% nas seguintes
 *   · libera no 5º dia e vale 30 dias a partir dali
 *   · vale na rede inteira + site + live (chave = CPF)
 *   · paga no máximo 30% de uma compra
 *   · devolveu a peça, perde o cashback dela — e o saldo pode ficar NEGATIVO
 *   · crediário/marcado credita conforme a parcela é PAGA, não no fechamento
 *   · "primeira compra" = CPF sem NENHUMA compra, contando o histórico do Giga
 *
 * ── NASCE DESLIGADO ──
 *
 * O interruptor mora no BANCO (SystemSetting), não em env: o botão está na tela
 * de prévia e precisa valer na hora, sem deploy nem restart. Mesmo padrão do
 * limite da rede.
 *
 * ── O QUE A MEDIÇÃO DE 01/08 MOSTROU, E MUDA A EXPECTATIVA ──
 *
 * 76,3% das vendas NÃO têm CPF (R$ 865 mil de R$ 1,14 milhão em 30 dias). O
 * cashback só alcança um quarto do faturamento. Talvez o maior valor dele seja
 * dar à vendedora um motivo pra pedir o CPF — e a tela de prévia mostra esse
 * número junto do custo, pra a decisão ser tomada com os dois na mesa.
 *
 * ── DINHEIRO NÃO PODE DERRUBAR VENDA ──
 *
 * Todo ponto chamado pelo fluxo de venda é best-effort: erro aqui vira log, não
 * exceção. Uma falha de cashback travando o PDV seria trocar centavos por uma
 * loja parada.
 */
@Injectable()
export class CashbackService {
  private readonly logger = new Logger(CashbackService.name);

  private static readonly CHAVE = 'cashback_rede_config';

  constructor(private readonly prisma: PrismaService) {}

  // ─────────────────────────── configuração ───────────────────────────

  private static readonly PADRAO = {
    /** Nasce DESLIGADO de propósito. */
    ativo: false,
    pctPrimeiraCompra: 10,
    pctDemais: 3,
    /** Carência: o crédito só pode ser usado a partir do 5º dia. */
    carenciaDias: 5,
    /** Depois de liberado, vale 30 dias. */
    validadeDias: 30,
    /** Teto de quanto de uma compra pode ser pago com saldo. */
    usoMaxPctCompra: 30,
    /** Abaixo disso não vale a pena mexer no caixa. */
    minimoUsoReais: 5,
    /** Venda no crediário credita conforme a parcela é paga. */
    crediarioNoPagamento: true,
  };

  async config(): Promise<typeof CashbackService.PADRAO> {
    try {
      const s = await (this.prisma as any).systemSetting.findUnique({
        where: { key: CashbackService.CHAVE },
      });
      if (!s?.value) return { ...CashbackService.PADRAO };
      return { ...CashbackService.PADRAO, ...JSON.parse(s.value) };
    } catch (e: any) {
      // Falha lendo a configuração NÃO pode ligar o cashback sozinha.
      this.logger.warn(`[cashback] config ilegível, usando padrão: ${e?.message}`);
      return { ...CashbackService.PADRAO };
    }
  }

  async salvarConfig(patch: Partial<typeof CashbackService.PADRAO>, usuario?: string) {
    const atual = await this.config();
    const novo = { ...atual, ...patch };

    const erro = this.validar(novo);
    if (erro) return { ok: false, erro };

    await (this.prisma as any).systemSetting.upsert({
      where: { key: CashbackService.CHAVE },
      create: { key: CashbackService.CHAVE, value: JSON.stringify(novo) },
      update: { value: JSON.stringify(novo) },
    });
    if (atual.ativo !== novo.ativo) {
      this.logger.warn(`[cashback] ${novo.ativo ? 'LIGADO' : 'DESLIGADO'} por ${usuario || '?'}`);
    }
    return { ok: true, config: novo };
  }

  private validar(c: typeof CashbackService.PADRAO): string | null {
    const pct = (v: number, nome: string) =>
      !Number.isFinite(v) || v < 0 || v > 100 ? `${nome} deve ficar entre 0 e 100` : null;
    return (
      pct(c.pctPrimeiraCompra, 'Percentual da primeira compra') ||
      pct(c.pctDemais, 'Percentual das demais') ||
      pct(c.usoMaxPctCompra, 'Teto de uso por compra') ||
      (c.carenciaDias < 0 ? 'Carência não pode ser negativa' : null) ||
      (c.validadeDias < 1 ? 'Validade tem que ser de pelo menos 1 dia' : null) ||
      (c.minimoUsoReais < 0 ? 'Mínimo de uso não pode ser negativo' : null)
    );
  }

  // ─────────────────────────── utilidades ───────────────────────────

  private soDigitos(v: any): string {
    return String(v ?? '').replace(/\D/g, '');
  }

  /** CPF válido o bastante pra ser chave. Não valida dígito — cadastro antigo
   *  tem CPF torto e recusar aqui esconderia saldo de gente real. */
  private cpfChave(v: any): string | null {
    const d = this.soDigitos(v);
    return d.length === 11 ? d : null;
  }

  private hoje(): Date {
    return new Date(`${hojeBrasilia()}T12:00:00.000Z`);
  }

  private maisDias(d: Date, dias: number): Date {
    const r = new Date(d);
    r.setUTCDate(r.getUTCDate() + dias);
    return r;
  }

  /** Centavos, sempre. Float acumulado em ledger vira centavo perdido. */
  private cent(v: number): number {
    return Math.round((Number(v) || 0) * 100) / 100;
  }

  // ─────────────────────────── saldo ───────────────────────────

  /**
   * Saldo de uma pessoa, com a origem de cada real.
   *
   * `disponivel` já desconta o que foi usado, o que foi cancelado por devolução
   * e o que está negativo. `aLiberar` é o que existe mas ainda está na carência
   * — a tela mostra porque a cliente pergunta, e a vendedora precisa saber
   * responder "libera dia tal".
   */
  async saldo(cpfRaw: string): Promise<{
    cpf: string;
    disponivel: number;
    aLiberar: number;
    liberaEm: string | null;
    expiraEmBreve: number;
    proximaExpiracao: string | null;
    totalGanho: number;
    totalUsado: number;
    totalExpirado: number;
  }> {
    const cpf = this.cpfChave(cpfRaw);
    const vazio = {
      cpf: cpf || '', disponivel: 0, aLiberar: 0, liberaEm: null,
      expiraEmBreve: 0, proximaExpiracao: null,
      totalGanho: 0, totalUsado: 0, totalExpirado: 0,
    };
    if (!cpf) return vazio;

    const agora = this.hoje();
    const creditos: any[] = await (this.prisma as any).cashbackCredito.findMany({
      where: { cpf, isTraining: false },
      orderBy: { expiraEm: 'asc' },
    });
    if (!creditos.length) return vazio;

    let disponivel = 0, aLiberar = 0, expirado = 0, ganho = 0, usado = 0;
    let liberaEm: Date | null = null;
    let proximaExpiracao: Date | null = null;
    let expiraEmBreve = 0;
    const em7dias = this.maisDias(agora, 7);

    for (const c of creditos) {
      const saldoDele = this.cent(Number(c.valor) - Number(c.usado) - Number(c.cancelado));
      if (Number(c.valor) > 0) ganho += Number(c.valor);
      usado += Number(c.usado);

      if (saldoDele === 0) continue;

      // Estorno (negativo) pesa SEMPRE: não tem carência nem expira. Se
      // expirasse, a dívida sumiria sozinha e a brecha do comprar-ganhar-
      // devolver voltaria a valer.
      if (saldoDele < 0) { disponivel += saldoDele; continue; }

      if (agora < c.liberaEm) {
        aLiberar += saldoDele;
        if (!liberaEm || c.liberaEm < liberaEm) liberaEm = c.liberaEm;
        continue;
      }
      if (agora > c.expiraEm) { expirado += saldoDele; continue; }

      disponivel += saldoDele;
      if (!proximaExpiracao || c.expiraEm < proximaExpiracao) proximaExpiracao = c.expiraEm;
      if (c.expiraEm <= em7dias) expiraEmBreve += saldoDele;
    }

    return {
      cpf,
      // Saldo negativo é dívida, não crédito: a tela mostra 0 e o negativo
      // continua guardado, abatendo o próximo ganho.
      disponivel: Math.max(0, this.cent(disponivel)),
      aLiberar: this.cent(aLiberar),
      liberaEm: liberaEm ? (liberaEm as Date).toISOString().slice(0, 10) : null,
      expiraEmBreve: this.cent(expiraEmBreve),
      proximaExpiracao: proximaExpiracao ? (proximaExpiracao as Date).toISOString().slice(0, 10) : null,
      totalGanho: this.cent(ganho),
      totalUsado: this.cent(usado),
      totalExpirado: this.cent(expirado),
    };
  }

  // ─────────────────────────── é primeira compra? ───────────────────────────

  /**
   * A pessoa nunca comprou — nem no Flow, nem no Giga.
   *
   * O sinal do Giga é a EXISTÊNCIA de ficha em `giga_clientes`: no Wincred a
   * ficha nasce quando alguém compra ou abre crediário. É um proxy, não uma
   * prova — mas errar pra menos aqui custa 7 pontos percentuais numa venda, e
   * errar pra mais daria 10% pra base antiga inteira.
   */
  async ehPrimeiraCompra(cpfRaw: string): Promise<boolean> {
    const cpf = this.cpfChave(cpfRaw);
    if (!cpf) return false;

    const [vendaFlow, fichaGiga, creditoAnterior] = await Promise.all([
      (this.prisma as any).pdvSale.count({
        where: {
          customerCpf: { contains: cpf.slice(0, 3) }, // filtro grosso, refinado abaixo
          status: 'finalized', isTraining: false,
        },
        take: 1,
      }).catch(() => 0),
      (this.prisma as any).$queryRawUnsafe(
        `SELECT 1 FROM giga_clientes
          WHERE regexp_replace(COALESCE(cpf,''), '\\D', '', 'g') = $1 LIMIT 1`,
        cpf,
      ).catch(() => []),
      (this.prisma as any).cashbackCredito.count({
        where: { cpf, origem: 'venda', isTraining: false },
        take: 1,
      }).catch(() => 0),
    ]);

    if ((fichaGiga as any[])?.length) return false;
    if (creditoAnterior > 0) return false;

    // O `contains` acima é só pra baratear; a checagem que vale é exata.
    if (vendaFlow > 0) {
      const exato: any[] = await (this.prisma as any).$queryRawUnsafe(
        `SELECT 1 FROM pdv_sales
          WHERE regexp_replace(COALESCE(customer_cpf,''), '\\D', '', 'g') = $1
            AND status = 'finalized' AND is_training = false LIMIT 1`,
        cpf,
      );
      if (exato.length) return false;
    }
    return true;
  }

  // ─────────────────────────── ganhar ───────────────────────────

  /**
   * Credita o cashback de uma venda. Best-effort: nunca lança.
   *
   * Idempotente por (origem, saleId): rodar duas vezes na mesma venda não
   * credita duas vezes — o índice único do banco garante, não a checagem.
   */
  async creditarVenda(input: {
    saleId: string;
    cpf?: string | null;
    storeCode: string;
    total: number;
    isTraining?: boolean;
    /** Quanto dessa venda foi pago COM cashback — não gera cashback de novo. */
    pagoComCashback?: number;
    customerId?: string | null;
  }): Promise<{ creditado: number; primeira: boolean } | null> {
    try {
      const cfg = await this.config();
      if (!cfg.ativo) return null;
      if (input.isTraining) return null;

      const cpf = this.cpfChave(input.cpf);
      if (!cpf) return null;

      // Base = o que entrou de dinheiro NOVO. Dar cashback sobre o pedaço pago
      // com cashback seria pagar juros sobre o próprio benefício.
      const base = this.cent(Number(input.total) - Number(input.pagoComCashback || 0));
      if (base <= 0) return null;

      const primeira = await this.ehPrimeiraCompra(cpf);
      const pct = primeira ? cfg.pctPrimeiraCompra : cfg.pctDemais;
      const valor = this.cent((base * pct) / 100);
      if (valor <= 0) return null;

      const agora = this.hoje();
      const liberaEm = this.maisDias(agora, cfg.carenciaDias);
      const expiraEm = this.maisDias(liberaEm, cfg.validadeDias);

      await (this.prisma as any).cashbackCredito.create({
        data: {
          cpf, customerId: input.customerId || null,
          origem: 'venda', saleId: input.saleId,
          storeCode: input.storeCode,
          percentual: pct, base, valor,
          liberaEm, expiraEm,
          primeiraCompra: primeira,
        },
      });
      return { creditado: valor, primeira };
    } catch (e: any) {
      // Único caso esperado: corrida gravando a mesma venda duas vezes. O
      // índice barra e a segunda vira log — que é exatamente o que se quer.
      if (String(e?.code) === 'P2002') return null;
      this.logger.error(`[cashback] creditarVenda(${input.saleId}) falhou: ${e?.message}`);
      return null;
    }
  }

  // ─────────────────────────── usar ───────────────────────────

  /** Quanto dá pra usar nesta compra, sem efeito colateral. */
  async quantoPodeUsar(cpfRaw: string, totalCompra: number): Promise<{
    permitido: number;
    saldo: number;
    teto: number;
    motivo: string | null;
    ativo: boolean;
  }> {
    const cfg = await this.config();
    const s = await this.saldo(cpfRaw);
    const teto = this.cent((Number(totalCompra) || 0) * (cfg.usoMaxPctCompra / 100));
    let permitido = Math.min(s.disponivel, teto);
    let motivo: string | null = null;

    if (!cfg.ativo) { permitido = 0; motivo = 'Cashback desligado'; }
    else if (s.disponivel <= 0) { permitido = 0; motivo = 'Sem saldo disponível'; }
    else if (s.disponivel < cfg.minimoUsoReais) {
      permitido = 0;
      motivo = `Saldo abaixo do mínimo de R$ ${cfg.minimoUsoReais.toFixed(2)}`;
    } else if (permitido < s.disponivel) {
      motivo = `Limitado a ${cfg.usoMaxPctCompra}% da compra`;
    }

    return { permitido: this.cent(Math.max(0, permitido)), saldo: s.disponivel, teto, motivo, ativo: cfg.ativo };
  }

  /**
   * Consome saldo numa venda, em FIFO pelo que vence primeiro.
   *
   * Numa transação: sem ela, duas vendas simultâneas da mesma cliente gastariam
   * o mesmo crédito. Cada linha de uso aponta pro crédito que a bancou — é o
   * que torna o acerto entre lojas possível se o dono ligar um dia.
   */
  async usar(input: {
    cpf: string;
    saleId: string;
    storeCode: string;
    valor: number;
  }): Promise<{ usado: number; erro?: string }> {
    const cpf = this.cpfChave(input.cpf);
    if (!cpf) return { usado: 0, erro: 'CPF inválido' };
    const pedido = this.cent(input.valor);
    if (pedido <= 0) return { usado: 0 };

    try {
      return await (this.prisma as any).$transaction(async (tx: any) => {
        const agora = this.hoje();
        const creditos: any[] = await tx.cashbackCredito.findMany({
          where: {
            cpf, isTraining: false,
            liberaEm: { lte: agora },
            expiraEm: { gte: agora },
          },
          orderBy: { expiraEm: 'asc' },
        });

        let falta = pedido;
        let usado = 0;
        for (const c of creditos) {
          if (falta <= 0) break;
          const livre = this.cent(Number(c.valor) - Number(c.usado) - Number(c.cancelado));
          if (livre <= 0) continue;
          const pega = this.cent(Math.min(livre, falta));

          await tx.cashbackCredito.update({
            where: { id: c.id },
            data: { usado: { increment: pega } },
          });
          await tx.cashbackUso.create({
            data: {
              cpf, creditoId: c.id, saleId: input.saleId,
              storeCode: input.storeCode, valor: pega,
            },
          });
          falta = this.cent(falta - pega);
          usado = this.cent(usado + pega);
        }

        if (usado < pedido) {
          // Não é erro: o saldo pode ter mudado entre a tela e o clique. A
          // venda usa o que deu e cobra o resto em dinheiro.
          this.logger.warn(`[cashback] pedido R$ ${pedido} mas só havia R$ ${usado} (venda ${input.saleId})`);
        }
        return { usado };
      });
    } catch (e: any) {
      this.logger.error(`[cashback] usar(${input.saleId}) falhou: ${e?.message}`);
      return { usado: 0, erro: e?.message };
    }
  }

  // ─────────────────────────── devolução ───────────────────────────

  /**
   * A peça voltou: o cashback dela some.
   *
   * Se já foi gasto, o saldo fica NEGATIVO — decisão do dono, e é o que fecha a
   * brecha de comprar caro, pegar 10%, gastar e devolver.
   *
   * Devolução parcial cancela proporcionalmente ao que voltou.
   */
  async estornarDevolucao(input: {
    saleId: string;
    returnId: string;
    valorDevolvido: number;
    storeCode: string;
  }): Promise<{ cancelado: number } | null> {
    try {
      const credito = await (this.prisma as any).cashbackCredito.findFirst({
        where: { origem: 'venda', saleId: input.saleId, isTraining: false },
      });
      if (!credito) return null;

      const base = Number(credito.base) || 0;
      if (base <= 0) return null;

      // Proporção do que voltou. Devolução total → cancela tudo.
      const proporcao = Math.min(1, this.cent(Number(input.valorDevolvido)) / base);
      const aCancelar = this.cent(Number(credito.valor) * proporcao);
      if (aCancelar <= 0) return null;

      const jaCancelado = Number(credito.cancelado);
      const usado = Number(credito.usado);
      const valor = Number(credito.valor);
      const cancelavel = this.cent(Math.max(0, valor - usado - jaCancelado));
      const cancelaAgora = this.cent(Math.min(aCancelar, cancelavel));
      const descoberto = this.cent(aCancelar - cancelaAgora);

      await (this.prisma as any).$transaction(async (tx: any) => {
        if (cancelaAgora > 0) {
          await tx.cashbackCredito.update({
            where: { id: credito.id },
            data: { cancelado: { increment: cancelaAgora } },
          });
        }
        // O pedaço que ela JÁ GASTOU vira crédito negativo: dívida que não
        // expira e abate o próximo ganho.
        if (descoberto > 0) {
          await tx.cashbackCredito.create({
            data: {
              cpf: credito.cpf, customerId: credito.customerId,
              origem: 'estorno_devolucao',
              saleId: input.saleId, returnId: input.returnId,
              storeCode: input.storeCode,
              percentual: 0, base: 0, valor: -descoberto,
              liberaEm: this.hoje(),
              // Data distante: estorno não expira de propósito.
              expiraEm: new Date('2099-12-31T00:00:00.000Z'),
            },
          });
        }
      });

      this.logger.log(
        `[cashback] devolução ${input.returnId}: cancelou R$ ${cancelaAgora}` +
        (descoberto > 0 ? ` + R$ ${descoberto} vira saldo negativo` : ''),
      );
      return { cancelado: this.cent(cancelaAgora + descoberto) };
    } catch (e: any) {
      if (String(e?.code) === 'P2002') return null;
      this.logger.error(`[cashback] estornarDevolucao(${input.returnId}) falhou: ${e?.message}`);
      return null;
    }
  }

  // ─────────────────────────── crediário ───────────────────────────

  /**
   * Parcela paga credita o cashback dela.
   *
   * Decisão do dono: crediário/marcado NÃO credita no fechamento da venda —
   * credita conforme entra o dinheiro. Há R$ 739 mil de dívida real em aberto;
   * creditar no fechamento premiaria quem ainda não pagou.
   */
  async creditarParcelaPaga(input: {
    parcelaId: string;
    cpf?: string | null;
    storeCode: string;
    valorPago: number;
    isTraining?: boolean;
  }): Promise<{ creditado: number } | null> {
    try {
      const cfg = await this.config();
      if (!cfg.ativo || !cfg.crediarioNoPagamento || input.isTraining) return null;

      const cpf = this.cpfChave(input.cpf);
      if (!cpf) return null;
      const base = this.cent(input.valorPago);
      if (base <= 0) return null;

      // A parcela é continuação de uma compra que já aconteceu; o bônus de
      // primeira compra não se aplica de novo a cada parcela.
      const primeira = await this.ehPrimeiraCompra(cpf);
      const pct = primeira ? cfg.pctPrimeiraCompra : cfg.pctDemais;
      const valor = this.cent((base * pct) / 100);
      if (valor <= 0) return null;

      const agora = this.hoje();
      const liberaEm = this.maisDias(agora, cfg.carenciaDias);

      await (this.prisma as any).cashbackCredito.create({
        data: {
          cpf, origem: 'crediario_parcela', parcelaId: input.parcelaId,
          storeCode: input.storeCode,
          percentual: pct, base, valor,
          liberaEm, expiraEm: this.maisDias(liberaEm, cfg.validadeDias),
          primeiraCompra: primeira,
        },
      });
      return { creditado: valor };
    } catch (e: any) {
      if (String(e?.code) === 'P2002') return null;
      this.logger.error(`[cashback] creditarParcelaPaga(${input.parcelaId}) falhou: ${e?.message}`);
      return null;
    }
  }
}
