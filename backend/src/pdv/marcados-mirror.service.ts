import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';

/**
 * MARCADOS — hoje 100% Flow (07/08, regra do dono: "nunca marque ou puxe
 * nada do Giga"). Este service NAO grava mais nada aqui vindo do Giga — nem
 * em cron, nem sob pedido. O que resta e:
 *
 * - `varrerRestosDoGiga()`: leitura PURA e sob demanda de `caixa
 *   WHERE MARCADO='SIM'` — so pra referencia/duvida ("essa peca antiga ainda
 *   esta marcada la?"), nunca grava nada no Flow. Botao "Restos dos marcados
 *   do Giga" na retaguarda.
 * - `lookupNomes()`: casa nome/CPF olhando o ESPELHO `giga_clientes` (ja
 *   sincronizado no nosso Postgres) — nao e leitura do Giga ao vivo.
 * - `diagnosticarIdentidade()`: mesma ideia, pra investigar atribuicao
 *   errada de cliente (caso Daiana, 07/08).
 *
 * ATE 07/08 existia aqui um sync horario que IMPORTAVA `caixa` pro Flow
 * (`syncFromGiga`, cron `40 * * * *`) — removido. Cada peca marcada hoje
 * nasce e morre 100% no Postgres; nao sobra Giga nenhum pra "puxar".
 */
@Injectable()
export class MarcadosMirrorService {
  private readonly logger = new Logger(MarcadosMirrorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpService,
  ) {}

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
    };
  }

  /** Tem espelho utilizavel? (nunca importou = 0 linhas) */
  async hasMirror(): Promise<boolean> {
    const n = await (this.prisma as any).marcado.count();
    return n > 0;
  }

  /**
   * "RESTOS DOS MARCADOS DO GIGA" — sob demanda, NUNCA grava nada. Mostra o
   * que ainda esta com `MARCADO='SIM'` na `caixa` — sobras de antes de
   * 07/08 (ou peca que alguem fechou direto no Wincred, que ninguem mais
   * usa, e nunca vai sumir sozinha de la). Cada linha diz se JA existe um
   * `Marcado` nativo pro mesmo REGISTRO, pra distinguir "so existe no Giga,
   * morto" de "tambem esta rastreado no Flow".
   */
  async varrerRestosDoGiga(limite = 500): Promise<{
    total: number;
    truncado: boolean;
    itens: Array<{
      registro: number; numero: number | null; sku: string; descricao: string | null;
      qty: number; valor: number; valorTotal: number; loja: string; codCliente: string;
      data: string | null; jaNoFlow: boolean; statusNoFlow: string | null;
    }>;
  }> {
    const teto = Math.min(Math.max(limite, 1), 2000);
    const r = await this.erp.runReadOnly(
      `SELECT REGISTRO, NUMERO, CODIGO, DATA, DESCRICAO, QUANTIDADE, VALOR, VALORTOTAL, CLIENTE, LOJA
         FROM caixa
        WHERE UPPER(MARCADO) = 'SIM'
        ORDER BY DATA DESC, REGISTRO DESC
        LIMIT ${teto}`,
      { maxRows: teto, timeoutMs: 20000 },
    );
    const rows: any[] = r.rows || [];
    const regs = rows.map((row) => Number(row.REGISTRO)).filter((n) => Number.isFinite(n) && n > 0);
    const nativos: any[] = regs.length
      ? await (this.prisma as any).marcado.findMany({
          where: { registroGiga: { in: regs.map((n) => BigInt(n)) } },
          select: { registroGiga: true, status: true },
        })
      : [];
    const statusPorReg = new Map(nativos.map((n) => [String(n.registroGiga), n.status]));

    const itens = rows.map((row) => {
      const registro = Number(row.REGISTRO) || 0;
      const st = statusPorReg.get(String(registro)) ?? null;
      return {
        registro,
        numero: row.NUMERO != null ? Number(row.NUMERO) : null,
        sku: String(row.CODIGO || ''),
        descricao: row.DESCRICAO ? String(row.DESCRICAO) : null,
        qty: Number(row.QUANTIDADE) || 1,
        valor: Number(row.VALOR) || 0,
        valorTotal: Number(row.VALORTOTAL) || 0,
        loja: String(row.LOJA || ''),
        codCliente: String(row.CLIENTE ?? '').trim(),
        data: row.DATA ? new Date(row.DATA).toISOString() : null,
        jaNoFlow: st != null,
        statusNoFlow: st,
      };
    });
    return { total: itens.length, truncado: itens.length >= teto, itens };
  }

  /**
   * DIAGNOSTICO — "de quem e de verdade" (caso Daiana, 07/08).
   *
   * Pra cada marcado com este CPF (o CPF pode estar errado — e resultado do
   * bug), mostra: o codigo bruto do cliente gravado na peca, se existe ficha
   * EXATA na loja de origem (se nao, e POR ISSO que o fallback antigo
   * disparou), e TODA ficha de QUALQUER loja com esse mesmo codigo — a lista
   * de candidatas a dona real. Read-only, nao muda nada.
   */
  async diagnosticarIdentidade(cpf: string): Promise<{
    marcados: Array<{
      id: string; sku: string; descricao: string | null; storeCode: string; codCliente: string;
      fichaExataNaLoja: { nome: string | null; cpf: string | null } | null;
      candidatas: Array<{ loja: string; nome: string | null; cpf: string | null }>;
    }>;
  }> {
    const safeCpf = String(cpf || '').replace(/\D/g, '');
    const marcados: any[] = await (this.prisma as any).marcado.findMany({
      where: safeCpf ? { cpf: safeCpf } : undefined,
      select: { id: true, sku: true, descricao: true, storeCode: true, codCliente: true },
      take: 100,
    });
    const out: any[] = [];
    for (const m of marcados) {
      const codNorm = this.normNum(m.codCliente);
      const todasComEsseCodigo: any[] = await (this.prisma as any).gigaCliente.findMany({
        where: { codigo: { in: [m.codCliente, codNorm] } },
        select: { loja: true, codigo: true, nome: true, cpf: true },
      });
      const exata = todasComEsseCodigo.find((f) => this.normNum(f.loja) === this.normNum(m.storeCode));
      out.push({
        id: m.id, sku: m.sku, descricao: m.descricao, storeCode: m.storeCode, codCliente: m.codCliente,
        fichaExataNaLoja: exata ? { nome: exata.nome, cpf: exata.cpf } : null,
        candidatas: todasComEsseCodigo.map((f) => ({ loja: f.loja, nome: f.nome, cpf: f.cpf })),
      });
    }
    return { marcados: out };
  }

  /** Normaliza codigo/loja pra casar contra o espelho giga_clientes (padding
   *  de zeros e inconsistente no Giga — mesma regra do CAST AS UNSIGNED dos
   *  produtos). */
  private normNum(s: any): string {
    const d = String(s ?? '').replace(/\D/g, '').replace(/^0+/, '');
    return d || '0';
  }

  /**
   * Busca nome/CPF no ESPELHO giga_clientes (nosso Postgres, ja
   * sincronizado — nao e leitura do Giga ao vivo) pros pares
   * (loja, codCliente), casando por LOJA+CODIGO exato — nunca so pelo
   * codigo. Retorna Map por `${loja}|${cod}` normalizado.
   *
   * ATE 07/08 tinha um fallback "sem loja" (achado caso Daiana Lucena: 5
   * pecas da loja 11/Limeira apareceram atribuidas a ela, e a equipe nao
   * reconhecia). `codCliente` e sequencia POR LOJA (`GigaClienteSeq`), nao
   * globalmente unico — cod. 148 existe em varias lojas, cada uma sendo uma
   * pessoa diferente. O fallback pegava "qualquer ficha com esse numero, de
   * qualquer loja" pra preencher nome/CPF, e a marcacao de OUTRA cliente virava
   * a Daiana na tela.
   *
   * Mesma familia de bug ja corrigida em `listAllMarcados` (21/07) e
   * documentada em `getClienteMarcadorInfo` — so nao tinha chegado aqui.
   *
   * Sem ficha exata, o marcado fica SEM nome/CPF — pior pra tela (aparece so
   * o codigo), melhor que aparecer com o nome de uma pessoa errada.
   */
  async lookupNomes(pares: Array<{ storeCode: string; codCliente: string }>): Promise<Map<string, { nome: string | null; cpf: string | null }>> {
    const out = new Map<string, { nome: string | null; cpf: string | null }>();
    const codsNorm = Array.from(new Set(pares.map((p) => this.normNum(p.codCliente)))).filter((c) => c !== '0');
    if (!codsNorm.length) return out;
    // Busca por codigo cru E sem zeros (cobre os dois jeitos de gravar)
    const variantes = Array.from(new Set([
      ...codsNorm,
      ...pares.map((p) => String(p.codCliente).trim()),
    ])).slice(0, 2000);
    const fichas: any[] = await (this.prisma as any).gigaCliente.findMany({
      where: { codigo: { in: variantes } },
      select: { loja: true, codigo: true, nome: true, cpf: true },
    });
    const byExact = new Map<string, any>();
    for (const f of fichas) {
      const k = `${this.normNum(f.loja)}|${this.normNum(f.codigo)}`;
      if (!byExact.has(k)) byExact.set(k, f);
    }
    for (const p of pares) {
      const k = `${this.normNum(p.storeCode)}|${this.normNum(p.codCliente)}`;
      const f = byExact.get(k);
      if (f) {
        out.set(k, {
          nome: f.nome || null,
          cpf: f.cpf ? String(f.cpf).replace(/\D/g, '') || null : null,
        });
      }
    }
    return out;
  }
}
