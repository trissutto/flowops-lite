import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * PONTOS LURD'S — o extrato do que a cliente ganha por avaliar.
 *
 * ── POR QUE NÃO É CASHBACK ──
 *
 * Cashback é DINHEIRO da compra: percentual sobre o que ela gastou, com
 * carência, validade e teto de uso, e o interruptor dele mora no banco
 * DESLIGADO (`CashbackService.PADRAO.ativo = false`). Pendurar a recompensa da
 * avaliação ali significaria que ligar/desligar cashback liga/desliga também o
 * programa de avaliação — duas decisões comerciais diferentes no mesmo botão.
 *
 * Ponto é benefício de ENGAJAMENTO: ela ganha por fazer algo que ajuda a
 * próxima cliente, não por gastar. Extrato próprio, regra própria.
 *
 * ── A CHAVE É O CPF ──
 *
 * A mesma decisão do cashback da rede: a dona do saldo é a PESSOA, não o
 * cadastro. Conta do site exige senha e a maioria compra como visitante; CPF o
 * checkout já exige (é a nota fiscal). Sem CPF não credita — e quem chama
 * precisa dizer isso pra cliente em vez de fingir que creditou.
 *
 * ── IDEMPOTÊNCIA ──
 *
 * `@@unique([tipo, origem])` no extrato: aprovar duas vezes a mesma avaliação
 * (dois cliques, dois processos no rolling deploy) não credita duas vezes. O
 * conflito é ESPERADO — vira "já creditado", não erro.
 */
@Injectable()
export class PontosService {
  private readonly logger = new Logger(PontosService.name);

  constructor(private readonly prisma: PrismaService) {}

  static digits(v: unknown): string {
    return String(v ?? '').replace(/\D/g, '');
  }

  /** CPF só entra no extrato se for CPF — 11 dígitos, nada de "00000000000". */
  static cpfValido(v: unknown): string | null {
    const d = PontosService.digits(v);
    if (d.length !== 11) return null;
    if (/^(\d)\1{10}$/.test(d)) return null;
    return d;
  }

  /**
   * Credita (ou debita, com `pontos` negativo) e devolve o saldo novo.
   *
   * Tudo numa transação: saldo e extrato não podem divergir nem por um
   * instante — é o extrato que explica o saldo pra cliente.
   */
  async lancar(input: {
    cpf: string;
    pontos: number;
    tipo: string;
    origem?: string | null;
    descricao?: string | null;
    nome?: string | null;
    telefone?: string | null;
    expiraEm?: Date | null;
  }): Promise<{ ok: boolean; saldo: number; jaLancado?: boolean }> {
    const cpf = PontosService.cpfValido(input.cpf);
    if (!cpf) return { ok: false, saldo: 0 };
    const pontos = Math.trunc(Number(input.pontos) || 0);
    if (!pontos) return { ok: false, saldo: 0 };

    try {
      return await this.prisma.$transaction(async (tx: any) => {
        const conta = await tx.pontosSaldo.upsert({
          where: { cpf },
          create: {
            cpf,
            nome: input.nome?.slice(0, 80) ?? null,
            telefone: PontosService.digits(input.telefone).slice(0, 20) || null,
            saldo: 0,
            ganhos: 0,
            gastos: 0,
          },
          update: {
            // Só preenche o que estiver vazio: o nome do cadastro vale mais que
            // o que veio no último pedido.
            ...(input.nome ? { nome: input.nome.slice(0, 80) } : {}),
          },
        });

        const saldo = conta.saldo + pontos;
        if (saldo < 0) throw new BadRequestException('Saldo de pontos insuficiente');

        await tx.pontosTransacao.create({
          data: {
            cpf,
            pontos,
            saldoApos: saldo,
            tipo: input.tipo.slice(0, 20),
            origem: input.origem?.slice(0, 80) ?? null,
            descricao: input.descricao?.slice(0, 160) ?? null,
            expiraEm: input.expiraEm ?? null,
          },
        });

        await tx.pontosSaldo.update({
          where: { cpf },
          data: {
            saldo,
            ...(pontos > 0 ? { ganhos: { increment: pontos } } : { gastos: { increment: -pontos } }),
          },
        });

        return { ok: true, saldo };
      });
    } catch (e: any) {
      // P2002 = já existe lançamento com este (tipo, origem). É a trava
      // funcionando, não uma falha: devolve o saldo atual e segue.
      if (e?.code === 'P2002') {
        const atual = await (this.prisma as any).pontosSaldo.findUnique({ where: { cpf } });
        return { ok: true, saldo: atual?.saldo ?? 0, jaLancado: true };
      }
      if (e instanceof BadRequestException) throw e;
      this.logger.warn(`[pontos] lançamento falhou (${input.tipo}/${input.origem}): ${e?.message || e}`);
      return { ok: false, saldo: 0 };
    }
  }

  async saldo(cpfRaw: string): Promise<number> {
    const cpf = PontosService.cpfValido(cpfRaw);
    if (!cpf) return 0;
    const conta = await (this.prisma as any).pontosSaldo.findUnique({ where: { cpf } });
    return conta?.saldo ?? 0;
  }

  /** Saldo + extrato — o que a tela "Meus pontos" mostra. */
  async extrato(cpfRaw: string, limite = 50) {
    const cpf = PontosService.cpfValido(cpfRaw);
    if (!cpf) return { saldo: 0, ganhos: 0, gastos: 0, transacoes: [] as any[] };
    const [conta, txs] = await Promise.all([
      (this.prisma as any).pontosSaldo.findUnique({ where: { cpf } }),
      (this.prisma as any).pontosTransacao.findMany({
        where: { cpf },
        orderBy: { createdAt: 'desc' },
        take: Math.min(200, Math.max(1, limite)),
      }),
    ]);
    return {
      saldo: conta?.saldo ?? 0,
      ganhos: conta?.ganhos ?? 0,
      gastos: conta?.gastos ?? 0,
      transacoes: (txs || []).map((t: any) => ({
        id: t.id,
        pontos: t.pontos,
        saldoApos: t.saldoApos,
        tipo: t.tipo,
        descricao: t.descricao,
        data: t.createdAt?.toISOString?.() ?? null,
        expiraEm: t.expiraEm?.toISOString?.() ?? null,
      })),
    };
  }

  /**
   * RESGATE — pontos viram um cupom NOMINAL, do CPF dela e de mais ninguém.
   *
   * Reaproveita a máquina do vale-troca (`site_cupons` com `cpf` preenchido),
   * que já é checada pelo `CupomService` no carrinho E no fechamento — quem
   * cobra é quem recalcula. Inventar um segundo tipo de desconto seria criar
   * uma segunda regra de dinheiro pra manter em dia.
   *
   * O débito só acontece DEPOIS que o cupom existe: se a criação falhar, ela
   * não perde ponto. O contrário (debitar e não conseguir criar) deixaria a
   * cliente sem saldo e sem desconto — o pior dos dois lados.
   */
  async resgatar(input: {
    cpf: string;
    pontos: number;
    pontosPorReal: number;
    minimoResgate: number;
    validadeDias?: number;
  }): Promise<{ ok: boolean; code?: string; valor?: number; saldo?: number; erro?: string }> {
    const cpf = PontosService.cpfValido(input.cpf);
    if (!cpf) return { ok: false, erro: 'Sem CPF válido pra resgatar.' };

    const pedidos = Math.trunc(Number(input.pontos) || 0);
    if (pedidos < input.minimoResgate) {
      return { ok: false, erro: `O resgate mínimo é de ${input.minimoResgate} pontos.` };
    }
    // Resgate em múltiplos exatos: ninguém perde fração de ponto no arredondamento.
    if (pedidos % input.pontosPorReal !== 0) {
      return { ok: false, erro: `Resgate em múltiplos de ${input.pontosPorReal} pontos.` };
    }

    const saldo = await this.saldo(cpf);
    if (saldo < pedidos) return { ok: false, erro: 'Saldo insuficiente.' };

    const valor = Math.floor(pedidos / input.pontosPorReal);
    const dias = input.validadeDias ?? 90;
    const code = `PONTOS${cpf.slice(-4)}${Date.now().toString(36).toUpperCase().slice(-5)}`;

    try {
      await (this.prisma as any).siteCupom.create({
        data: {
          code,
          label: `Seus pontos: R$ ${valor},00 de desconto`,
          tipo: 'fixed',
          valor,
          cpf,
          origem: 'pontos',
          usoMaximo: 1,
          ativo: true,
          fimEm: new Date(Date.now() + dias * 86_400_000),
        },
      });
    } catch (e: any) {
      this.logger.warn(`[pontos] cupom de resgate falhou (${cpf}): ${e?.message || e}`);
      return { ok: false, erro: 'Não conseguimos gerar seu cupom agora. Tenta de novo em instantes.' };
    }

    const r = await this.lancar({
      cpf,
      pontos: -pedidos,
      tipo: 'resgate',
      origem: `cupom:${code}`,
      descricao: `Cupom ${code} — R$ ${valor},00`,
    });
    return { ok: true, code, valor, saldo: r.saldo };
  }
}
