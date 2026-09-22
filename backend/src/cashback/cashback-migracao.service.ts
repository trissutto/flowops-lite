import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CashbackService } from './cashback.service';
import { hojeBrasilia } from '../common/tz';

/**
 * A MUDANÇA DE CASA DO SALDO ANTIGO.
 *
 * Até 22/09/2026 o Flow tinha TRÊS cashbacks, cada tela lendo um:
 *
 *   1. `cashback_creditos`  — este, o da regra fechada em 01/08 (chave = CPF).
 *   2. `cashback_balances`  — o do CRM, por ficha de Customer. É o número que
 *      o PDV anunciava pra vendedora ("pode usar R$ X, até 30% da compra").
 *   3. `customer_accounts.cashback_balance_cents` — o do app/site, que a tela
 *      /conta/cashback mostra com o rótulo "Disponível pra usar".
 *
 * Nenhum dos três tinha porta de saída: o resgate do (2) existia como rota mas
 * nenhum botão chamava, e o do (3) passava pelo checkout do WordPress apagado
 * em 27/08. A cliente via o número em três telas e não conseguia gastar em
 * lugar nenhum — foi isso que a fez xingar, com razão.
 *
 * Agora (1) é a fonte única. Este serviço traz o saldo de (2) e (3) pra dentro
 * dele, como crédito de `origem='migracao'`.
 *
 * ── POR QUE NÃO RODA SOZINHO ──
 *
 * Porque custa dinheiro e o número não é meu. `previa()` mostra a conta ANTES
 * (quantas pessoas, quanto em cada fonte, quanto somado), e `aplicar()` só
 * roda por clique na tela. Mesmo padrão da prévia do próprio cashback e do
 * limite da rede.
 *
 * ── AS GARANTIAS ──
 *
 *   · Só saldo POSITIVO entra. Saldo zerado não vira linha.
 *   · Idempotente por CPF: o índice único (origem, sale_id, parcela_id) com
 *     `sale_id = 'mig:<cpf>'` barra a segunda rodada. Clicar duas vezes não
 *     credita duas vezes — o banco garante, não a checagem.
 *   · Nada é apagado das tabelas antigas. Elas param de ser LIDAS; o saldo
 *     continua lá pra auditoria e pra conferir a migração depois.
 *   · CPF é a chave. Ficha sem CPF não migra — sem chave não há como a pessoa
 *     reencontrar o saldo dela em outra loja, que é o ponto do programa.
 */
@Injectable()
export class CashbackMigracaoService {
  private readonly logger = new Logger(CashbackMigracaoService.name);

  /** Marcador de "de onde veio", no lugar da loja que gerou. */
  private static readonly STORE = 'MIG';

  constructor(
    private readonly prisma: PrismaService,
    private readonly cashback: CashbackService,
  ) {}

  /**
   * Saldo positivo por CPF nas duas fontes antigas, já descontado o que ESTA
   * migração já trouxe (pra prévia não repetir o que já foi aplicado).
   */
  private async levantar(): Promise<
    Array<{ cpf: string; crm: number; app: number; jaMigrado: boolean }>
  > {
    const [crm, app, feitos]: [any[], any[], any[]] = await Promise.all([
      // CRM: o saldo é por FICHA e a pessoa tem uma ficha por loja — soma
      // todas as fichas do mesmo CPF, que é exatamente o que o PDV já fazia
      // ao anunciar o número (aggregatePerson).
      (this.prisma as any).$queryRawUnsafe(
        `SELECT regexp_replace(COALESCE(c.cpf,''), '\\D', '', 'g') AS cpf,
                SUM(b.balance_cents)::bigint AS cents
           FROM cashback_balances b
           JOIN customers c ON c.id = b.customer_id
          WHERE b.balance_cents > 0
            AND length(regexp_replace(COALESCE(c.cpf,''), '\\D', '', 'g')) = 11
          GROUP BY 1`,
      ).catch((e: any) => {
        this.logger.warn(`[cashback-migracao] CRM ilegível: ${e?.message}`);
        return [];
      }),
      (this.prisma as any).$queryRawUnsafe(
        `SELECT regexp_replace(COALESCE(cpf,''), '\\D', '', 'g') AS cpf,
                SUM(cashback_balance_cents)::bigint AS cents
           FROM customer_accounts
          WHERE cashback_balance_cents > 0
            AND length(regexp_replace(COALESCE(cpf,''), '\\D', '', 'g')) = 11
          GROUP BY 1`,
      ).catch((e: any) => {
        this.logger.warn(`[cashback-migracao] app ilegível: ${e?.message}`);
        return [];
      }),
      (this.prisma as any).cashbackCredito.findMany({
        where: { origem: 'migracao' },
        select: { cpf: true },
      }).catch(() => []),
    ]);

    const jaFeito = new Set((feitos as any[]).map((r) => String(r.cpf)));
    const mapa = new Map<string, { cpf: string; crm: number; app: number; jaMigrado: boolean }>();
    const pega = (cpf: string) => {
      if (!mapa.has(cpf)) mapa.set(cpf, { cpf, crm: 0, app: 0, jaMigrado: jaFeito.has(cpf) });
      return mapa.get(cpf)!;
    };
    for (const r of crm as any[]) pega(String(r.cpf)).crm = Number(r.cents) / 100;
    for (const r of app as any[]) pega(String(r.cpf)).app = Number(r.cents) / 100;
    return [...mapa.values()];
  }

  /**
   * A conta antes de pagar.
   *
   * `totalSomado` × `totalMaior` é a decisão que o dono toma na tela: quem
   * tinha saldo nas DUAS fontes recebe os dois (soma) ou só o maior deles?
   * Somar é o que a cliente entende — ela viu os dois números e os dois diziam
   * "seu cashback". Pegar o maior é o que não paga duas vezes pelo mesmo
   * benefício, quando as duas fontes creditaram a mesma compra.
   */
  async previa() {
    const linhas = (await this.levantar()).filter((l) => !l.jaMigrado);
    const soma = (f: (l: any) => number) =>
      Math.round(linhas.reduce((s, l) => s + f(l), 0) * 100) / 100;

    const nosDois = linhas.filter((l) => l.crm > 0 && l.app > 0);
    return {
      pendentes: linhas.length,
      crm: { pessoas: linhas.filter((l) => l.crm > 0).length, total: soma((l) => l.crm) },
      app: { pessoas: linhas.filter((l) => l.app > 0).length, total: soma((l) => l.app) },
      nasDuasFontes: { pessoas: nosDois.length, total: soma((l) => Math.min(l.crm, l.app)) },
      totalSomado: soma((l) => l.crm + l.app),
      totalMaior: soma((l) => Math.max(l.crm, l.app)),
      jaMigrados: (await this.levantar()).filter((l) => l.jaMigrado).length,
      /** Maiores saldos — pra conferir se algum número está absurdo. */
      maiores: [...linhas]
        .sort((a, b) => b.crm + b.app - (a.crm + a.app))
        .slice(0, 10)
        .map((l) => ({ cpf: l.cpf.slice(0, 3) + '******' + l.cpf.slice(-2), crm: l.crm, app: l.app })),
    };
  }

  /**
   * Traz o saldo pra cá. Só por clique na tela.
   *
   * @param modo 'soma' = CRM + app; 'maior' = o maior dos dois.
   * @param teto Teto por pessoa, em reais. Saldo acima disso entra cortado e
   *   sai na lista de `cortados` — rede de segurança contra o saldo torto que
   *   ninguém auditou nas tabelas antigas (crédito manual digitado errado,
   *   bônus repetido). `0` desliga o teto.
   */
  async aplicar(input: { modo?: 'soma' | 'maior'; teto?: number; usuario?: string }) {
    const modo = input.modo === 'maior' ? 'maior' : 'soma';
    const teto = Math.max(0, Number(input.teto) || 0);
    const cfg = await this.cashback.config();

    const hoje = new Date(`${hojeBrasilia()}T12:00:00.000Z`);
    const expiraEm = new Date(hoje);
    // Sem carência: não é ganho novo, é saldo que a pessoa já tinha e já podia
    // usar. Cobrar 5 dias de espera de quem está esperando desde agosto seria
    // a segunda promessa quebrada seguida.
    expiraEm.setUTCDate(expiraEm.getUTCDate() + cfg.validadeDias);

    const linhas = (await this.levantar()).filter((l) => !l.jaMigrado);
    let migrados = 0;
    let total = 0;
    let pulados = 0;
    const cortados: Array<{ cpf: string; de: number; para: number }> = [];

    for (const l of linhas) {
      const bruto = modo === 'soma' ? l.crm + l.app : Math.max(l.crm, l.app);
      let valor = Math.round(bruto * 100) / 100;
      if (valor <= 0) continue;
      if (teto > 0 && valor > teto) {
        cortados.push({ cpf: l.cpf, de: valor, para: teto });
        valor = teto;
      }

      try {
        await (this.prisma as any).cashbackCredito.create({
          data: {
            cpf: l.cpf,
            origem: 'migracao',
            saleId: `mig:${l.cpf}`,
            storeCode: CashbackMigracaoService.STORE,
            percentual: 0,
            base: 0,
            valor,
            liberaEm: hoje,
            expiraEm,
            primeiraCompra: false,
          },
        });
        migrados += 1;
        total = Math.round((total + valor) * 100) / 100;
      } catch (e: any) {
        // P2002 = outra rodada já trouxe este CPF. É o que se quer.
        if (String(e?.code) === 'P2002') { pulados += 1; continue; }
        this.logger.error(`[cashback-migracao] CPF ${l.cpf} falhou: ${e?.message}`);
        pulados += 1;
      }
    }

    this.logger.warn(
      `[cashback-migracao] ${migrados} pessoas, R$ ${total.toFixed(2)} ` +
      `(modo=${modo}, teto=${teto || 'sem'}, pulados=${pulados}) por ${input.usuario || '?'}`,
    );
    return { ok: true, modo, teto, migrados, total, pulados, cortados: cortados.slice(0, 50) };
  }
}
