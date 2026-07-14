import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';
import { CrediariosService } from './crediarios.service';

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
    const t0 = Date.now();
    const pool: any = (this.erp as any).pool;
    if (!pool) throw new Error('MySQL pool nao inicializado');

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

    // MESMO critério de "em aberto" do listAllOpenInstallments
    const where: string[] = [];
    if (map.pago) {
      where.push(
        `(\`${map.pago}\` IS NULL OR \`${map.pago}\` = '' OR UPPER(\`${map.pago}\`) IN ('N','NAO','NÃO'))`,
      );
    } else if (map.dataPagamento) {
      where.push(`(\`${map.dataPagamento}\` IS NULL OR \`${map.dataPagamento}\` = '0000-00-00')`);
    }
    where.push(`\`${map.registro}\` IS NOT NULL`);
    where.push(`\`${map.codCliente}\` IS NOT NULL`);
    where.push(`\`${map.codCliente}\` <> ''`);
    where.push(`\`${map.codCliente}\` <> '0'`);

    // Busca TUDO em memória (tipicamente 5-15k linhas) e faz replace atômico.
    const [rows] = await pool.query({
      sql: `SELECT ${sel.join(', ')} FROM \`movimento\` WHERE ${where.join(' AND ')} LIMIT 50000`,
      timeout: 120_000,
    });

    const seen = new Set<string>();
    const data = (rows as any[])
      .filter((r) => {
        const reg = String(r.registro ?? '').trim();
        if (!reg || seen.has(reg)) return false;
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

    this.logger.log(`[abertas] OK — ${data.length} parcelas em ${Date.now() - t0}ms`);
    return { processed: data.length, durationMs: Date.now() - t0 };
  }

  // ── SYNC: CLIENTES SLIM ──────────────────────────────────────────────────

  async syncClientes(): Promise<{ processed: number; durationMs: number }> {
    const t0 = Date.now();
    const pool: any = (this.erp as any).pool;
    if (!pool) throw new Error('MySQL pool nao inicializado');

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
  }

  /** Estorno (markUnpaid) — o próximo ciclo horário re-insere a parcela;
   *  best-effort imediato pra não esperar 1h. */
  async reinserirAposEstorno(): Promise<void> {
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
    return {
      abertas: await q('wincred_movimento_aberto'),
      clientes: await q('wincred_clientes'),
    };
  }
}
