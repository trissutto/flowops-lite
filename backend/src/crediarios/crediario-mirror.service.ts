import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { pullGigaLigado } from '../common/replica-giga';
import { ErpService } from '../erp/erp.service';
import { CrediariosService } from './crediarios.service';
import { sqlParcelaAberta } from '../common/crediario-pago';

/** A linha do espelho, já na forma em que é gravada. */
export interface EspelhoAberta {
  registro: string;
  controle: string | null;
  numeroCompra: string | null;
  loja: string | null;
  codCliente: string | null;
  nome: string | null;
  parcela: number | null;
  totalParcelas: number | null;
  vencimento: Date | null;
  /** Prisma Decimal | number | string — comparado por valor numérico. */
  valorParcela: unknown;
  obs: string | null;
}

/**
 * DIFF nativa → espelho: o que inserir, atualizar e apagar pra deixar o
 * espelho igual à fonte SEM reescrever a tabela inteira.
 *
 * Por que existe: o full-replace de 10 em 10 minutos somava ~87 mil escritas
 * por ciclo (delete + insert de ~43 mil linhas) — ~12,6 MILHÕES de escritas
 * por dia no Postgres pra, na maioria dos ciclos, não mudar linha nenhuma
 * (baixa e estorno já têm write-through). Medido em 01/09:
 * `wincred_movimento_aberto` acumulava 32 milhões de escritas nas estatísticas
 * do banco. O diff escreve só a diferença real — tipicamente zero a dezenas.
 *
 * Comparações toleram representação: Decimal/number/string pelo valor
 * numérico, datas por dia (getTime), strings por igualdade estrita com null.
 */
export function diffEspelhoAbertas(
  nativas: EspelhoAberta[],
  espelho: EspelhoAberta[],
): { inserir: EspelhoAberta[]; atualizar: EspelhoAberta[]; apagar: string[] } {
  const num = (v: unknown) => (v == null ? null : Number(v));
  const dia = (v: Date | null) => (v == null ? null : v.getTime());
  const mesma = (a: EspelhoAberta, b: EspelhoAberta) =>
    a.controle === b.controle &&
    a.numeroCompra === b.numeroCompra &&
    a.loja === b.loja &&
    a.codCliente === b.codCliente &&
    a.nome === b.nome &&
    a.parcela === b.parcela &&
    a.totalParcelas === b.totalParcelas &&
    dia(a.vencimento) === dia(b.vencimento) &&
    num(a.valorParcela) === num(b.valorParcela) &&
    a.obs === b.obs;

  const atuais = new Map(espelho.map((e) => [e.registro, e]));
  const inserir: EspelhoAberta[] = [];
  const atualizar: EspelhoAberta[] = [];
  const vistos = new Set<string>();
  for (const n of nativas) {
    vistos.add(n.registro);
    const atual = atuais.get(n.registro);
    if (!atual) inserir.push(n);
    else if (!mesma(n, atual)) atualizar.push(n);
  }
  const apagar = espelho.filter((e) => !vistos.has(e.registro)).map((e) => e.registro);
  return { inserir, atualizar, apagar };
}

/**
 * CrediarioMirrorService — espelha no Postgres o que a COBRANÇA precisa do
 * Giga: parcelas de crediário EM ABERTO (`wincred_movimento_aberto`) e o
 * cadastro slim de clientes (`wincred_clientes`: nome + fones).
 *
 * Por quê: a tela de RECEBIMENTOS varria a tabela `movimento` inteira no
 * Giga (até 5.000 linhas com teto de 30s) — a query mais pesada do sistema —
 * e a lista de clientes fazia outra varredura. Com o espelho, as duas viram
 * consulta local instantânea e a cobrança FUNCIONA com o Giga fora do ar.
 *
 * Estratégia:
 *   - ABERTAS: full replace de hora em hora (min 41 — não colide com os
 *     syncs de estoque :23 e incremental :00/:10/...). Tipicamente 5-15k
 *     linhas. Baixa feita PELO FLOW sai do espelho na hora (write-through
 *     via marcarPagasNoEspelho). Baixa feita no Wincred desktop aparece no
 *     próximo ciclo.
 *   - CLIENTES: full replace 1x/dia (4h) + carona no ciclo horário quando a
 *     tabela ainda está vazia (primeira carga).
 *
 * Reusa a detecção dinâmica de colunas do CrediariosService (nomes variam
 * por instalação do Wincred). Gated por WINCRED_MIRROR_CRON_ENABLED=1,
 * igual aos demais espelhos.
 */
@Injectable()
export class CrediarioMirrorService {
  private readonly logger = new Logger(CrediarioMirrorService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpService,
    private readonly crediarios: CrediariosService,
  ) {}

  private get cronEnabled(): boolean {
    return String(process.env.WINCRED_MIRROR_CRON_ENABLED || '').trim() === '1';
  }

  // ── CRONS ────────────────────────────────────────────────────────────────

  /** Parcelas abertas — A CADA 10 MINUTOS (14/07, pedido do dono: espelho do
   *  crediário fresco pras telas de baixa/cobrança). Guard `running` evita
   *  overlap se o Giga demorar. */
  @Cron('*/10 * * * *', { name: 'crediario-mirror-abertas' })
  async cronAbertas(): Promise<void> {
    if (!this.cronEnabled) return;
    if (this.running) return;
    this.running = true;
    try {
      const r = await this.syncAbertas();
      this.logger.log(`[cron] abertas OK — ${r.processed} parcelas (${r.durationMs}ms)`);
      // Primeira carga de clientes de carona: tabela vazia (nunca sincronizou)
      // OU só linhas legadas com loja='00' (migração da chave composta — o
      // deploy adiciona a coluna mas as linhas antigas ficam sem loja real).
      const temClientesComLoja = await (this.prisma as any).wincredCliente
        .count({ where: { loja: { not: '00' } } })
        .catch(() => 0);
      if (!temClientesComLoja) {
        const c = await this.syncClientes();
        this.logger.log(`[cron] clientes (1ª carga/re-carga pós-migração) OK — ${c.processed} (${c.durationMs}ms)`);
      }
    } catch (e: any) {
      this.logger.error(`[cron] abertas FAIL: ${e?.message || e}`);
    } finally {
      this.running = false;
    }
  }

  /** Clientes slim — 1x/dia às 4h (depois do full geral das 3h). */
  @Cron('0 4 * * *', { name: 'crediario-mirror-clientes' })
  async cronClientes(): Promise<void> {
    if (!this.cronEnabled) return;
    try {
      const r = await this.syncClientes();
      this.logger.log(`[cron] clientes OK — ${r.processed} (${r.durationMs}ms)`);
    } catch (e: any) {
      this.logger.error(`[cron] clientes FAIL: ${e?.message || e}`);
    }
  }

  // ── SYNC: PARCELAS ABERTAS ───────────────────────────────────────────────

  async syncAbertas(): Promise<{ processed: number; durationMs: number }> {
    // Com o pull do Giga desligado (o normal desde 27/08) o espelho passa a
    // ser uma cópia da tabela NATIVA, não do Giga. Ver espelharDaNativa().
    if (!pullGigaLigado()) return this.espelharDaNativa();
    const t0 = Date.now();
    const pool: any = (this.erp as any).pool;
    if (!pool) throw new Error('importacao encerrada: o sistema antigo foi desligado em 27/08/2026 — nao ha nada pra importar');

    const map = await this.crediarios.detectColumns(true);
    if (!map.registro || !map.codCliente || !map.vencimento || !map.valorParcela) {
      throw new Error('detectColumns não achou registro/codCliente/vencimento/valorParcela');
    }

    const sel: string[] = [`\`${map.registro}\` AS registro`];
    const optCol = (logical: keyof typeof map, alias: string) => {
      const col = (map as any)[logical];
      sel.push(col ? `\`${col}\` AS ${alias}` : `NULL AS ${alias}`);
    };
    optCol('controle', 'controle');
    optCol('numeroCompra', 'numeroCompra');
    optCol('loja', 'loja');
    optCol('codCliente', 'codCliente');
    optCol('nome', 'nome');
    optCol('parcela', 'parcela');
    optCol('totalParcelas', 'totalParcelas');
    optCol('vencimento', 'vencimento');
    optCol('valorParcela', 'valorParcela');
    optCol('obs', 'obs'); // observação da promissória — sumia no espelho

    // MESMO critério de "em aberto" do listAllOpenInstallments
    const where: string[] = [];
    where.push(sqlParcelaAberta(map.pago, map.dataPagamento));
    where.push(`\`${map.registro}\` IS NOT NULL`);
    where.push(`\`${map.codCliente}\` IS NOT NULL`);
    where.push(`\`${map.codCliente}\` <> ''`);
    where.push(`\`${map.codCliente}\` <> '0'`);

    // LEITURA PAGINADA, SEM TETO (31/07). Antes era `LIMIT 50000` numa tacada
    // só, com o comentário "tipicamente 5-15k linhas". A realidade era 72.831
    // parcelas em aberto: 22.831 (R$ 2,3 mi) nunca entravam no espelho, sem
    // erro nenhum. Quem ligava CREDIARIO_NATIVE_READS via crediário sumir.
    const leitura = await this.erp.readAllPages(
      `SELECT ${sel.join(', ')} FROM \`movimento\` WHERE ${where.join(' AND ')}`,
      { orderBy: `\`${map.registro}\``, batch: 10_000, timeoutMs: 120_000 },
    );
    const rows = leitura.rows;
    if (leitura.truncado) {
      // NUNCA substituir o espelho por uma leitura incompleta — melhor o
      // espelho velho inteiro que um novo pela metade.
      throw new Error(`leitura do movimento truncada no teto (${rows.length} linhas) — espelho preservado`);
    }

    const seen = new Set<string>();
    let duplicados = 0;
    const data = (rows as any[])
      .filter((r) => {
        const reg = String(r.registro ?? '').trim();
        if (!reg) return false;
        if (seen.has(reg)) { duplicados++; return false; }
        seen.add(reg);
        return true;
      })
      .map((r) => ({
        registro: String(r.registro).trim(),
        controle: r.controle != null ? String(r.controle).trim() : null,
        numeroCompra: r.numeroCompra != null ? String(r.numeroCompra).trim() : null,
        loja: r.loja != null ? String(r.loja).trim() : null,
        codCliente: r.codCliente != null ? String(r.codCliente).trim() : null,
        nome: r.nome != null ? String(r.nome).trim() : null,
        parcela: r.parcela != null && !isNaN(Number(r.parcela)) ? Number(r.parcela) : null,
        totalParcelas:
          r.totalParcelas != null && !isNaN(Number(r.totalParcelas)) ? Number(r.totalParcelas) : null,
        vencimento: r.vencimento ? new Date(r.vencimento) : null,
        valorParcela: r.valorParcela != null ? r.valorParcela : null,
        obs: r.obs != null ? String(r.obs).trim().slice(0, 300) || null : null,
      }))
      .filter((r) => !r.vencimento || !isNaN(r.vencimento.getTime()));

    // Replace atômico — a tela nunca vê o espelho pela metade.
    await this.prisma.$transaction(async (tx: any) => {
      await tx.wincredMovimentoAberto.deleteMany({});
      for (let i = 0; i < data.length; i += 1000) {
        await tx.wincredMovimentoAberto.createMany({
          data: data.slice(i, i + 1000),
          skipDuplicates: true,
        });
      }
    }, { timeout: 60_000 });

    if (duplicados) {
      // `registro` é @id no espelho. Se o Giga tiver o mesmo registro em mais
      // de uma linha, o espelho só guarda uma — e a diferença some calada.
      this.logger.error(
        `[abertas] ${duplicados} linha(s) descartada(s) por REGISTRO repetido — o espelho perde essas parcelas. Investigar antes de confiar no CREDIARIO_NATIVE_READS.`,
      );
    }
    this.logger.log(
      `[abertas] OK — ${data.length} parcelas de ${rows.length} lidas (${leitura.paginas} página(s)) em ${Date.now() - t0}ms`,
    );
    return { processed: data.length, durationMs: Date.now() - t0 };
  }

  // ── SYNC: CLIENTES SLIM ──────────────────────────────────────────────────

  async syncClientes(): Promise<{ processed: number; durationMs: number }> {
    // Nome/telefone do cliente de crediário ainda só existem no Giga. Com o
    // pull desligado o espelho CONGELA no último sync — cliente novo entra
    // sem telefone na tela de recebimentos. É pendência conhecida: a fonte
    // definitiva é a base de clientes do Flow, não este espelho.
    if (!pullGigaLigado()) {
      this.logger.log('[clientes] sync PULADO — pull do Giga desligado (espelho congelado)');
      return { processed: 0, durationMs: 0 };
    }
    const t0 = Date.now();
    const pool: any = (this.erp as any).pool;
    if (!pool) throw new Error('importacao encerrada: o sistema antigo foi desligado em 27/08/2026 — nao ha nada pra importar');

    const cm = await this.crediarios.detectClientesTable(true);
    if (!cm?.table || !cm.codCliente) throw new Error('detectClientesTable falhou');

    const sel = [
      `\`${cm.codCliente}\` AS cod`,
      cm.nome ? `\`${cm.nome}\` AS nome` : 'NULL AS nome',
      cm.telefone ? `\`${cm.telefone}\` AS tel1` : 'NULL AS tel1',
      (cm as any).telefone2 ? `\`${(cm as any).telefone2}\` AS tel2` : 'NULL AS tel2',
      // LOJA: o CODIGO se repete entre lojas — a chave do espelho é (loja, cod).
      // Sem a coluna no Giga (clone antigo), tudo cai em '00'.
      (cm as any).loja ? `\`${(cm as any).loja}\` AS loja` : `'00' AS loja`,
    ];
    const [rows] = await pool.query({
      sql: `SELECT ${sel.join(', ')} FROM \`${cm.table}\` WHERE \`${cm.codCliente}\` IS NOT NULL AND \`${cm.codCliente}\` <> '' LIMIT 300000`,
      timeout: 180_000,
    });

    // Dedup por (loja, cod) — dedup só por cod descartava os clientes das
    // outras lojas que compartilham o mesmo código (mistura de crediário).
    const seen = new Set<string>();
    const data = (rows as any[])
      .map((r) => ({
        loja: String(r.loja ?? '').replace(/\D/g, '').padStart(2, '0').slice(0, 2) || '00',
        codCliente: String(r.cod ?? '').trim(),
        nome: r.nome != null ? String(r.nome).trim().slice(0, 120) : null,
        telefone: r.tel1 != null ? String(r.tel1).trim().slice(0, 30) : null,
        telefone2: r.tel2 != null ? String(r.tel2).trim().slice(0, 30) : null,
      }))
      .filter((r) => {
        if (!r.codCliente) return false;
        const key = `${r.loja}|${r.codCliente}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

    await this.prisma.$transaction(async (tx: any) => {
      await tx.wincredCliente.deleteMany({});
      for (let i = 0; i < data.length; i += 2000) {
        await tx.wincredCliente.createMany({ data: data.slice(i, i + 2000), skipDuplicates: true });
      }
    }, { timeout: 120_000 });

    this.logger.log(`[clientes] OK — ${data.length} em ${Date.now() - t0}ms`);
    return { processed: data.length, durationMs: Date.now() - t0 };
  }

  /**
   * ESPELHO DE ABERTAS A PARTIR DA TABELA NATIVA — sem Giga.
   *
   * `wincred_movimento_aberto` nasceu como cópia da `movimento` do Giga, e
   * dez pontos do crediário leem dela ("presente = em aberto AGORA", com
   * write-through na baixa). Em vez de reescrever esses dez leitores, o
   * espelho passa a ser uma cópia de `crediario_parcelas` — a mesma tabela
   * que a ficha da cliente lê e que já recebe baixa e estorno na hora.
   *
   * Medido em 27/08 antes de trocar a fonte: das 43.740 linhas do espelho,
   * ZERO faltavam na nativa; a nativa tinha 43.746 abertas (as 6 a mais são
   * parcelas nascidas no Flow, que o Giga nunca teve) e estava MAIS FRESCA
   * que o espelho (21:01 contra 05:20). Nome e observação batem em 100% das
   * linhas. Trocar a fonte só melhora.
   *
   * Única diferença: 559 parcelas (R$ 38.723,52) que o Giga não atribuía a
   * loja nenhuma vêm como `00` (o default da nativa) onde o espelho tinha
   * string vazia. As duas formas são "sem loja" e nenhum filtro da tela pede
   * loja 00, então a lista não muda.
   */
  private async espelharDaNativa(): Promise<{ processed: number; durationMs: number }> {
    const t0 = Date.now();
    const abertas: any[] = await (this.prisma as any).crediarioParcela.findMany({
      where: { pago: false, cancelado: false },
      select: {
        registro: true, controle: true, numeroCompra: true, loja: true,
        codCliente: true, nomeCliente: true, parcela: true, totalParcelas: true,
        vencimento: true, valorParcela: true, obs: true,
      },
    });

    const data = abertas.map((r) => ({
      registro: String(r.registro).trim(),
      controle: r.controle != null ? String(r.controle).trim() : null,
      numeroCompra: r.numeroCompra != null ? String(r.numeroCompra).trim() : null,
      loja: r.loja != null ? String(r.loja).trim() : null,
      codCliente: r.codCliente != null ? String(r.codCliente).trim() : null,
      nome: r.nomeCliente != null ? String(r.nomeCliente).trim() : null,
      parcela: r.parcela != null ? Number(r.parcela) : null,
      totalParcelas: r.totalParcelas != null ? Number(r.totalParcelas) : null,
      vencimento: r.vencimento ?? null,
      valorParcela: r.valorParcela ?? null,
      obs: r.obs != null ? String(r.obs).trim().slice(0, 300) || null : null,
    }));

    // Mesma guarda do caminho antigo: leitura vazia não substitui espelho
    // cheio. A nativa nunca está vazia de verdade (711 mil linhas).
    if (!data.length) {
      const tinha = await (this.prisma as any).wincredMovimentoAberto.count();
      if (tinha > 0) {
        throw new Error('nativa devolveu 0 parcelas abertas — espelho preservado');
      }
      return { processed: 0, durationMs: Date.now() - t0 };
    }

    /* ── DIFF, NÃO FULL-REPLACE (01/09) ──────────────────────────────────
     * O replace integral custava ~87 mil escritas por ciclo × 144 ciclos/dia
     * com o resultado quase sempre idêntico (baixa/estorno chegam por
     * write-through). Agora o espelho é lido e só a DIFERENÇA é gravada —
     * e sem o instante em que a tabela ficava vazia no meio da transação.
     */
    const espelho: EspelhoAberta[] = await (this.prisma as any).wincredMovimentoAberto.findMany({
      select: {
        registro: true, controle: true, numeroCompra: true, loja: true,
        codCliente: true, nome: true, parcela: true, totalParcelas: true,
        vencimento: true, valorParcela: true, obs: true,
      },
    });
    const { inserir, atualizar, apagar } = diffEspelhoAbertas(data, espelho);
    const mudancas = inserir.length + atualizar.length + apagar.length;

    /* Rede de segurança: diff acima de 30% da tabela é anomalia (primeira
     * carga, comparação quebrada, fonte trocada) — cai no replace atômico
     * antigo, que é o caminho provado. Nunca fica PIOR que o comportamento
     * anterior; só loga pra ninguém achar que o diff está valendo. */
    const limiarFullReplace = Math.max(2000, Math.floor(data.length * 0.3));
    if (mudancas > limiarFullReplace) {
      this.logger.warn(
        `[abertas] diff de ${mudancas} mudança(s) passou do limiar (${limiarFullReplace}) — full replace de segurança`,
      );
      await this.prisma.$transaction(async (tx: any) => {
        await tx.wincredMovimentoAberto.deleteMany({});
        for (let i = 0; i < data.length; i += 1000) {
          await tx.wincredMovimentoAberto.createMany({
            data: data.slice(i, i + 1000),
            skipDuplicates: true,
          });
        }
      }, { timeout: 60_000 });
    } else if (mudancas > 0) {
      await this.prisma.$transaction(async (tx: any) => {
        if (apagar.length) {
          await tx.wincredMovimentoAberto.deleteMany({ where: { registro: { in: apagar } } });
        }
        for (let i = 0; i < inserir.length; i += 1000) {
          await tx.wincredMovimentoAberto.createMany({
            data: inserir.slice(i, i + 1000),
            skipDuplicates: true,
          });
        }
        for (const a of atualizar) {
          const { registro, ...campos } = a;
          await tx.wincredMovimentoAberto.update({
            where: { registro },
            data: { ...campos, syncedAt: new Date() },
          });
        }
      }, { timeout: 60_000 });
    }

    // Carimbo de frescor SEM reescrever linha: a tela de status lê daqui
    // (antes, o MAX(synced_at) só andava porque o replace reescrevia tudo).
    await this.carimbarSyncAbertas(data.length);

    this.logger.log(
      `[abertas] OK — ${data.length} parcelas da nativa, diff +${inserir.length} ~${atualizar.length} -${apagar.length} em ${Date.now() - t0}ms`,
    );
    return { processed: data.length, durationMs: Date.now() - t0 };
  }

  /** Uma linha em `wincred_sync_state` por ciclo — o "sincronizou às" da tela. */
  private async carimbarSyncAbertas(rowCount: number): Promise<void> {
    try {
      await (this.prisma as any).wincredSyncState.upsert({
        where: { tabela: 'movimento_aberto' },
        create: { tabela: 'movimento_aberto', lastRunAt: new Date(), lastRowCount: rowCount, lastStatus: 'ok' },
        update: { lastRunAt: new Date(), lastRowCount: rowCount, lastStatus: 'ok', lastError: null },
      });
    } catch (e: any) {
      this.logger.warn(`[abertas] carimbo do sync_state falhou: ${e?.message || e}`);
    }
  }

  // ── WRITE-THROUGH ────────────────────────────────────────────────────────

  /** Baixa feita PELO FLOW → tira do espelho na hora (não espera o cron). */
  async marcarPagasNoEspelho(registros: Array<string | number>): Promise<void> {
    const regs = registros.map((r) => String(r).trim()).filter(Boolean);
    if (!regs.length) return;
    try {
      await (this.prisma as any).wincredMovimentoAberto.deleteMany({
        where: { registro: { in: regs } },
      });
    } catch (e: any) {
      this.logger.warn(`[write-through] falha ao remover ${regs.join(',')}: ${e?.message || e}`);
    }

    // SEGUNDA TABELA (31/07). São DUAS cópias de crediário no Postgres com
    // leitores diferentes, e só uma estava recebendo a baixa:
    //   wincred_movimento_aberto → tela de RECEBIMENTOS (era atualizada)
    //   crediario_parcelas       → FICHA DA CLIENTE (não era)
    // A ficha lê `crediario_parcelas` sem flag nenhuma
    // (clientes-giga.service.ts:388) e o full-replace dessa tabela só roda
    // 04:10. Sem isto, a cliente pagava e a ficha dela seguia dizendo que
    // devia até o dia seguinte — mesma família do incidente das 11.001
    // parcelas.
    try {
      await (this.prisma as any).crediarioParcela.updateMany({
        where: { registro: { in: regs } },
        data: { pago: true, dataPagamento: new Date() },
      });
    } catch (e: any) {
      this.logger.warn(`[write-through] falha ao baixar no nativo ${regs.join(',')}: ${e?.message || e}`);
    }
  }

  /** Estorno (markUnpaid) — o próximo ciclo horário re-insere a parcela;
   *  best-effort imediato pra não esperar 1h.
   *
   *  `registros` desfaz a baixa também em `crediario_parcelas` (a tabela da
   *  ficha da cliente). Sem isso o estorno só aparecia na tela de recebimentos
   *  e a ficha seguia dizendo "pago" — o espelho de abertas e o nativo têm
   *  leitores diferentes e precisam ser desfeitos juntos. */
  async reinserirAposEstorno(registros?: Array<string | number>): Promise<void> {
    const regs = (registros || []).map((r) => String(r).trim()).filter(Boolean);
    if (regs.length) {
      try {
        await (this.prisma as any).crediarioParcela.updateMany({
          where: { registro: { in: regs } },
          data: { pago: false, dataPagamento: null, valorPago: null },
        });
      } catch (e: any) {
        this.logger.warn(`[write-through] estorno no nativo falhou (${regs.join(',')}): ${e?.message || e}`);
      }
    }
    try {
      await this.syncAbertas();
    } catch (e: any) {
      this.logger.warn(`[write-through] resync pós-estorno falhou (cron corrige): ${e?.message || e}`);
    }
  }

  // ── STATUS ───────────────────────────────────────────────────────────────

  async status(): Promise<{
    abertas: { count: number; lastSyncedAt: Date | null };
    clientes: { count: number; lastSyncedAt: Date | null };
  }> {
    const q = async (table: string) => {
      try {
        const rows: any[] = await this.prisma.$queryRawUnsafe(
          `SELECT COUNT(*)::int AS c, MAX(synced_at) AS last FROM "${table}"`,
        );
        return { count: Number(rows[0]?.c ?? 0), lastSyncedAt: rows[0]?.last ? new Date(rows[0].last) : null };
      } catch {
        return { count: 0, lastSyncedAt: null };
      }
    };
    const abertas = await q('wincred_movimento_aberto');
    // Com o sync diferencial, MAX(synced_at) só anda quando alguma linha muda.
    // O frescor de verdade é o carimbo do ciclo em wincred_sync_state.
    try {
      const st = await (this.prisma as any).wincredSyncState.findUnique({
        where: { tabela: 'movimento_aberto' },
      });
      if (st?.lastRunAt && (!abertas.lastSyncedAt || st.lastRunAt > abertas.lastSyncedAt)) {
        abertas.lastSyncedAt = st.lastRunAt;
      }
    } catch {
      /* sem carimbo, vale o MAX(synced_at) — comportamento antigo */
    }
    return {
      abertas,
      clientes: await q('wincred_clientes'),
    };
  }
}
