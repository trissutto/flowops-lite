import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CashbackService } from './cashback.service';

/**
 * A PRÉVIA — quanto o cashback custaria, medido sobre venda que já aconteceu.
 *
 * É a tela que o dono olha antes de virar a chave. O limite da rede nasceu com
 * uma dessas e funcionou: mostrou que a regra não criava o problema, revelava
 * um que já existia.
 *
 * ── POR QUE NÃO DÁ PRA CONFIAR NUMA SIMULAÇÃO SIMPLES ──
 *
 * A conta ingênua ("10% das primeiras + 3% do resto") superestima MUITO, por
 * dois motivos que só o histórico completo resolve:
 *
 *   1. "primeira compra" dentro de uma janela de 30 dias conta como primeira
 *      quase todo mundo. Contando o histórico inteiro (Flow + fichas do Giga),
 *      o número despenca;
 *   2. cashback que ninguém usa não custa nada. Com carência de 5 dias,
 *      validade de 30 e teto de 30% da compra, boa parte expira.
 *
 * Esta prévia mede (1) de verdade. Pra (2) ela devolve o CUSTO MÁXIMO e o
 * quanto seria efetivamente resgatável dado o teto — o resgate real depende de
 * a cliente voltar, e isso nenhuma simulação sabe.
 */
@Injectable()
export class CashbackPreviaService {
  private readonly logger = new Logger(CashbackPreviaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cashback: CashbackService,
  ) {}

  async previa(dias = 30) {
    const cfg = await this.cashback.config();
    const janela = Math.max(1, Math.min(365, Number(dias) || 30));

    // Vendas com CPF na janela, marcando quem NUNCA comprou antes — nem no
    // Flow (fora da janela também), nem no Giga.
    const linhas: any[] = await (this.prisma as any).$queryRawUnsafe(
      `WITH venda AS (
         SELECT id, store_code,
                regexp_replace(COALESCE(customer_cpf,''), '\\D', '', 'g') AS cpf,
                total, created_at
           FROM pdv_sales
          WHERE status = 'finalized' AND is_training = false
            AND created_at >= NOW() - ($1 || ' days')::interval
            AND regexp_replace(COALESCE(customer_cpf,''), '\\D', '', 'g') <> ''
       ),
       -- Já existia ANTES? Ficha no Giga conta como "já é cliente": no Wincred
       -- a ficha nasce quando alguém compra ou abre crediário.
       conhecida AS (
         SELECT DISTINCT regexp_replace(COALESCE(cpf,''), '\\D', '', 'g') AS cpf
           FROM giga_clientes
          WHERE regexp_replace(COALESCE(cpf,''), '\\D', '', 'g') <> ''
       ),
       antiga AS (
         SELECT DISTINCT regexp_replace(COALESCE(customer_cpf,''), '\\D', '', 'g') AS cpf
           FROM pdv_sales
          WHERE status = 'finalized' AND is_training = false
            AND created_at < NOW() - ($1 || ' days')::interval
            AND regexp_replace(COALESCE(customer_cpf,''), '\\D', '', 'g') <> ''
       ),
       ordenada AS (
         SELECT v.*,
                ROW_NUMBER() OVER (PARTITION BY v.cpf ORDER BY v.created_at) AS ordem,
                (c.cpf IS NOT NULL OR a.cpf IS NOT NULL) AS ja_era_cliente
           FROM venda v
           LEFT JOIN conhecida c ON c.cpf = v.cpf
           LEFT JOIN antiga a ON a.cpf = v.cpf
       )
       SELECT store_code,
              COUNT(*)::int AS vendas,
              COUNT(DISTINCT cpf)::int AS pessoas,
              COALESCE(SUM(total),0)::float AS faturado,
              COUNT(*) FILTER (WHERE ordem = 1 AND NOT ja_era_cliente)::int AS primeiras,
              COALESCE(SUM(total) FILTER (WHERE ordem = 1 AND NOT ja_era_cliente),0)::float AS base_primeira,
              COALESCE(SUM(total) FILTER (WHERE NOT (ordem = 1 AND NOT ja_era_cliente)),0)::float AS base_demais
         FROM ordenada
        GROUP BY store_code
        ORDER BY 4 DESC`,
      String(janela),
    );

    // Alcance: sem CPF não há cashback, e isso decide se a regra tem efeito.
    const [alcance]: any[] = await (this.prisma as any).$queryRawUnsafe(
      `SELECT COUNT(*)::int AS vendas,
              COUNT(*) FILTER (WHERE regexp_replace(COALESCE(customer_cpf,''), '\\D','','g') = '')::int AS sem_cpf,
              COALESCE(SUM(total),0)::float AS faturado,
              COALESCE(SUM(total) FILTER (WHERE regexp_replace(COALESCE(customer_cpf,''), '\\D','','g') = ''),0)::float AS faturado_sem_cpf
         FROM pdv_sales
        WHERE status = 'finalized' AND is_training = false
          AND created_at >= NOW() - ($1 || ' days')::interval`,
      String(janela),
    );

    const porLoja = linhas.map((r) => {
      const custoPrimeira = (Number(r.base_primeira) * cfg.pctPrimeiraCompra) / 100;
      const custoDemais = (Number(r.base_demais) * cfg.pctDemais) / 100;
      return {
        loja: String(r.store_code),
        vendas: Number(r.vendas),
        pessoas: Number(r.pessoas),
        faturado: Number(r.faturado),
        primeirasCompras: Number(r.primeiras),
        custoPrimeira,
        custoDemais,
        custoTotal: custoPrimeira + custoDemais,
        // Quanto do faturamento viraria crédito.
        pctSobreFaturado: Number(r.faturado) > 0
          ? ((custoPrimeira + custoDemais) / Number(r.faturado)) * 100
          : 0,
      };
    });

    const soma = (k: string) => porLoja.reduce((s, x: any) => s + Number(x[k] || 0), 0);
    const custoTotal = soma('custoTotal');
    const faturadoComCpf = soma('faturado');

    const totalVendas = Number(alcance?.vendas || 0);
    const semCpf = Number(alcance?.sem_cpf || 0);

    return {
      janelaDias: janela,
      config: cfg,
      totais: {
        vendasComCpf: soma('vendas'),
        pessoas: soma('pessoas'),
        faturadoComCpf,
        primeirasCompras: soma('primeirasCompras'),
        custoPrimeira: soma('custoPrimeira'),
        custoDemais: soma('custoDemais'),
        custoTotal,
        pctSobreFaturadoComCpf: faturadoComCpf > 0 ? (custoTotal / faturadoComCpf) * 100 : 0,
      },
      alcance: {
        totalVendas,
        semCpf,
        pctSemCpf: totalVendas > 0 ? (semCpf / totalVendas) * 100 : 0,
        faturadoTotal: Number(alcance?.faturado || 0),
        faturadoSemCpf: Number(alcance?.faturado_sem_cpf || 0),
      },
      porLoja,
      avisos: [
        semCpf / Math.max(1, totalVendas) > 0.5
          ? `${((semCpf / totalVendas) * 100).toFixed(1)}% das vendas não têm CPF. ` +
            'O cashback não alcança essas — e talvez o maior valor dele seja ' +
            'justamente dar à vendedora um motivo pra pedir o CPF.'
          : null,
        'Este é o custo MÁXIMO: pressupõe que todo crédito é resgatado. Com ' +
        `carência de ${cfg.carenciaDias} dias, validade de ${cfg.validadeDias} ` +
        `e teto de ${cfg.usoMaxPctCompra}% por compra, parte expira sem uso.`,
        'Crédito de crediário não está aqui: ele nasce conforme a parcela é ' +
        'paga, e depende de pagamento futuro.',
      ].filter(Boolean),
    };
  }

  /** Estado atual do que já foi creditado — vazio enquanto estiver desligado. */
  async extrato() {
    const [t]: any[] = await (this.prisma as any).$queryRawUnsafe(
      `SELECT COUNT(*)::int AS creditos,
              COUNT(DISTINCT cpf)::int AS pessoas,
              COALESCE(SUM(valor),0)::float AS ganho,
              COALESCE(SUM(usado),0)::float AS usado,
              COALESCE(SUM(cancelado),0)::float AS cancelado,
              COALESCE(SUM(valor) FILTER (WHERE valor < 0),0)::float AS negativo
         FROM cashback_creditos WHERE is_training = false`,
    );
    const [d]: any[] = await (this.prisma as any).$queryRawUnsafe(
      `SELECT COALESCE(SUM(valor - usado - cancelado),0)::float AS disponivel
         FROM cashback_creditos
        WHERE is_training = false AND libera_em <= NOW() AND expira_em >= NOW()`,
    );
    return {
      creditos: Number(t?.creditos || 0),
      pessoas: Number(t?.pessoas || 0),
      totalGanho: Number(t?.ganho || 0),
      totalUsado: Number(t?.usado || 0),
      totalCancelado: Number(t?.cancelado || 0),
      saldoNegativo: Number(t?.negativo || 0),
      saldoDisponivel: Number(d?.disponivel || 0),
    };
  }
}
