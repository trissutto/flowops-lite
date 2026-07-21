import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';

/**
 * MARCADOS NATIVOS — espelho/fonte de leitura no Flow (dono 21/07: "CHEGA DE GIGA").
 *
 * - Import: puxa TODA a caixa com MARCADO='SIM' (poucas centenas de linhas,
 *   mas a query é full-scan — por isso roda 1x/hora, não por request).
 * - Linhas do Giga que sumiram (fechadas/devolvidas direto no Wincred) viram
 *   status='fechado_giga' — nunca apaga histórico.
 * - Linhas criadas pelo Flow (origem='flow', sem registroGiga ainda) NÃO são
 *   tocadas pelo sync.
 * - Enriquece nome/CPF da cliente pelo espelho giga_clientes (loja+codigo).
 *
 * Cron: minuto 40 de cada hora, gated por WINCRED_MIRROR_CRON_ENABLED
 * (mesma flag dos outros espelhos).
 */
@Injectable()
export class MarcadosMirrorService {
  private readonly logger = new Logger(MarcadosMirrorService.name);
  private running = false;
  private lastResult: any = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpService,
  ) {}

  private get cronEnabled(): boolean {
    return String(process.env.WINCRED_MIRROR_CRON_ENABLED ?? '').trim() === '1';
  }

  @Cron('40 * * * *')
  async cronSync() {
    if (!this.cronEnabled) return;
    try {
      await this.syncFromGiga();
    } catch (e: any) {
      this.logger.error(`[marcados-mirror] cron falhou: ${e?.message || e}`);
    }
  }

  async status() {
    const [total, ativos, fechados, devolvidos, fechadosGiga, porLojaRaw] = await Promise.all([
      (this.prisma as any).marcado.count(),
      (this.prisma as any).marcado.count({ where: { status: 'ativo' } }),
      (this.prisma as any).marcado.count({ where: { status: 'fechado' } }),
      (this.prisma as any).marcado.count({ where: { status: 'devolvido' } }),
      (this.prisma as any).marcado.count({ where: { status: 'fechado_giga' } }),
      (this.prisma as any).marcado.groupBy({
        by: ['storeCode'], _count: { _all: true }, where: { status: 'ativo' },
      }),
    ]);
    return {
      total, ativos, fechados, devolvidos, fechadosGiga,
      porLoja: (porLojaRaw as any[])
        .map((r) => ({ loja: r.storeCode, ativos: r._count._all }))
        .sort((a, b) => a.loja.localeCompare(b.loja)),
      running: this.running,
      lastResult: this.lastResult,
    };
  }

  /** Tem espelho utilizável? (nunca importou = 0 linhas → leituras caem pro Giga) */
  async hasMirror(): Promise<boolean> {
    const n = await (this.prisma as any).marcado.count();
    return n > 0;
  }

  async syncFromGiga(): Promise<{ ok: boolean; importados?: number; fechadosGiga?: number; error?: string }> {
    if (this.running) return { ok: false, error: 'sync já em andamento' };
    this.running = true;
    const t0 = Date.now();
    try {
      const r = await this.erp.runReadOnly(
        `SELECT REGISTRO, NUMERO, CODIGO, DATA, DESCRICAO, QUANTIDADE, VALOR, VALORTOTAL,
                VENDEDOR, CLIENTE, LOJA
           FROM caixa
          WHERE UPPER(MARCADO) = 'SIM'
          ORDER BY REGISTRO`,
        { maxRows: 50000, timeoutMs: 90000 },
      );
      const rows: any[] = r.rows || [];
      const vivos = new Set<string>();

      let importados = 0;
      for (const row of rows) {
        const reg = Number(row.REGISTRO);
        if (!Number.isFinite(reg) || reg <= 0) continue;
        vivos.add(String(reg));
        const loja = String(row.LOJA ?? '').trim().padStart(2, '0');
        const qty = Math.max(1, Number(row.QUANTIDADE) || 1);
        const valorTotal = Number(row.VALORTOTAL) || (Number(row.VALOR) || 0) * qty;
        const data: any = {
          storeCode: loja,
          codCliente: String(row.CLIENTE ?? '').trim(),
          numero: Number(row.NUMERO) || null,
          sku: String(row.CODIGO ?? '').trim().slice(0, 60),
          descricao: String(row.DESCRICAO ?? '').slice(0, 160) || null,
          qty,
          valorUnit: Number(row.VALOR) || 0,
          valorTotal,
          vendedor: row.VENDEDOR != null ? String(row.VENDEDOR) : null,
          dataMarcacao: row.DATA ? new Date(row.DATA) : null,
          status: 'ativo',
          origem: 'giga',
        };
        const existente = await (this.prisma as any).marcado.findUnique({
          where: { registroGiga: BigInt(reg) },
          select: { id: true },
        });
        if (existente) {
          // Linha ainda SIM no Giga → segue ativa (reabre se tinha sido
          // marcada fechado_giga por um sync com Giga capenga)
          await (this.prisma as any).marcado.update({ where: { id: existente.id }, data });
        } else {
          // Marcação criada pelo Flow cujo REGISTRO não foi capturado na hora
          // (Giga lento): casa por NUMERO+loja+sku pra não duplicar.
          const orfao = data.numero
            ? await (this.prisma as any).marcado.findFirst({
                where: {
                  registroGiga: null, origem: 'flow', status: 'ativo',
                  numero: data.numero, storeCode: data.storeCode, sku: data.sku,
                },
                select: { id: true },
              })
            : null;
          if (orfao) {
            await (this.prisma as any).marcado.update({
              where: { id: orfao.id },
              data: { registroGiga: BigInt(reg), ...data, origem: 'flow' },
            });
          } else {
            await (this.prisma as any).marcado.create({ data: { registroGiga: BigInt(reg), ...data } });
          }
        }
        importados++;
      }

      // Import é a fonte: quem era 'ativo' vindo do Giga e NÃO está mais SIM
      // lá, foi fechado/devolvido direto no Wincred → fechado_giga.
      // (origem='flow' sem registroGiga nunca entra aqui.)
      const ativosGiga: any[] = await (this.prisma as any).marcado.findMany({
        where: { status: 'ativo', origem: 'giga', registroGiga: { not: null } },
        select: { id: true, registroGiga: true },
      });
      let fechadosGiga = 0;
      for (const m of ativosGiga) {
        if (!vivos.has(String(m.registroGiga))) {
          await (this.prisma as any).marcado.update({
            where: { id: m.id },
            data: { status: 'fechado_giga', fechadoAt: new Date() },
          });
          fechadosGiga++;
        }
      }

      // Enriquece nome/CPF pelo espelho de clientes (loja+codigo)
      await this.enrichClientes();

      const ms = Date.now() - t0;
      this.lastResult = { at: new Date().toISOString(), importados, fechadosGiga, ms };
      this.logger.log(`[marcados-mirror] sync ok: ${importados} ativos, ${fechadosGiga} fechados no Giga, ${ms}ms`);
      return { ok: true, importados, fechadosGiga };
    } catch (e: any) {
      this.lastResult = { at: new Date().toISOString(), error: e?.message || String(e) };
      this.logger.error(`[marcados-mirror] sync falhou: ${e?.message || e}`);
      return { ok: false, error: e?.message || String(e) };
    } finally {
      this.running = false;
    }
  }

  /** Preenche clienteNome/cpf a partir do espelho giga_clientes. */
  private async enrichClientes() {
    const semNome: any[] = await (this.prisma as any).marcado.findMany({
      where: { OR: [{ clienteNome: null }, { cpf: null }] },
      select: { id: true, storeCode: true, codCliente: true },
      take: 5000,
    });
    if (!semNome.length) return;
    const pares = Array.from(new Set(semNome.map((m) => `${m.storeCode}|${m.codCliente}`)));
    const fichas: any[] = await (this.prisma as any).gigaCliente.findMany({
      where: {
        OR: pares.slice(0, 1000).map((p) => {
          const [loja, codigo] = p.split('|');
          return { loja, codigo };
        }),
      },
      select: { loja: true, codigo: true, nome: true, cpf: true },
    });
    const porChave = new Map(fichas.map((f) => [`${f.loja}|${f.codigo}`, f]));
    // Fallback: código bate mas a loja não (ficha só existe em outra loja)
    const porCodigo = new Map<string, any>();
    for (const f of fichas) if (!porCodigo.has(f.codigo)) porCodigo.set(f.codigo, f);
    const codigosFaltando = Array.from(new Set(
      semNome.filter((m) => !porChave.has(`${m.storeCode}|${m.codCliente}`)).map((m) => m.codCliente),
    ));
    if (codigosFaltando.length) {
      const extras: any[] = await (this.prisma as any).gigaCliente.findMany({
        where: { codigo: { in: codigosFaltando.slice(0, 1000) } },
        select: { loja: true, codigo: true, nome: true, cpf: true },
      });
      for (const f of extras) if (!porCodigo.has(f.codigo)) porCodigo.set(f.codigo, f);
    }
    for (const m of semNome) {
      const f = porChave.get(`${m.storeCode}|${m.codCliente}`) || porCodigo.get(m.codCliente);
      if (!f?.nome && !f?.cpf) continue;
      await (this.prisma as any).marcado.update({
        where: { id: m.id },
        data: {
          clienteNome: f.nome || undefined,
          cpf: f.cpf ? String(f.cpf).replace(/\D/g, '') || undefined : undefined,
        },
      });
    }
  }
}
