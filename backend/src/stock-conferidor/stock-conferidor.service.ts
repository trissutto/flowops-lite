import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';

/**
 * CONFERIDOR DE ESTOQUE — FLOW × GIGA (31/07).
 *
 * Por que existe: desde a CONSTITUIÇÃO 14/07 o Flow é a fonte do estoque e o
 * full Giga→Flow está DESLIGADO (`ESTOQUE_SYNC_GIGA`). O Flow segue replicando
 * tudo pro Giga (write-through + outbox), mas o contrário não acontece mais.
 * Consequência boa: ninguém sobrescreve a verdade do Flow. Consequência ruim:
 * se alguém mexer no Wincred desktop, ou se uma réplica falhar, os dois lados
 * se afastam EM SILÊNCIO — e ninguém enxerga.
 *
 * Esta tela acaba com o silêncio: compara SKU a SKU, loja a loja, e lista só
 * o que diverge. O Flow continua sendo a fonte — o botão "puxar do Giga" é
 * uma correção MANUAL, item a item, pra quando o valor certo estiver lá.
 *
 * Cuidado deliberado: "puxar do Giga" grava SÓ nos espelhos do Flow. Não
 * enfileira réplica de volta pro Giga — senão a correção reescreveria o valor
 * que a gente acabou de considerar correto.
 */

export type LinhaDivergencia = {
  codigo: string;
  loja: string;
  flow: number;
  giga: number;
  diferenca: number; // flow − giga
  tipo: 'DIFERENTE' | 'SO_NO_FLOW' | 'SO_NO_GIGA';
  descricao: string | null;
  ref: string | null;
  /** Última venda registrada no Flow pra esse SKU/loja (contexto do porquê). */
  ultimaVenda?: string | null;
};

export type ResultadoConferencia = {
  geradoEm: string;
  gigaOnline: boolean;
  resumo: {
    linhasFlow: number;
    linhasGiga: number;
    conferidas: number;
    iguais: number;
    divergentes: number;
    diferentes: number;
    soNoFlow: number;
    soNoGiga: number;
    pecasAMais: number; // soma das diferenças positivas (Flow > Giga)
    pecasAMenos: number; // soma das diferenças negativas (Flow < Giga)
    negativosFlow: number;
    negativosGiga: number;
  };
  porLoja: Array<{
    loja: string;
    divergentes: number;
    pecasAMais: number;
    pecasAMenos: number;
    negativosFlow: number;
    negativosGiga: number;
  }>;
  linhas: LinhaDivergencia[];
  truncado: boolean;
};

@Injectable()
export class StockConferidorService {
  private readonly logger = new Logger(StockConferidorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpService,
  ) {}

  /** Mesma normalização do espelho: sem zeros à esquerda, só dígitos. */
  private norm(codigo: string): string {
    const s = String(codigo || '').trim().replace(/\D/g, '');
    return s.replace(/^0+/, '') || s;
  }

  private loja2(loja: string): string {
    const s = String(loja || '').trim();
    return /^\d{1,2}$/.test(s) ? s.padStart(2, '0') : s;
  }

  async conferir(opts: {
    loja?: string;
    /** 'todas' | 'diferente' | 'so_flow' | 'so_giga' | 'negativo' */
    filtro?: string;
    /** Só linhas com |diferença| >= isso. Corta ruído de 1 peça. */
    minDiferenca?: number;
    limite?: number;
  }): Promise<ResultadoConferencia> {
    const t0 = Date.now();
    const lojaFiltro = opts.loja ? this.loja2(opts.loja) : null;
    const filtro = String(opts.filtro || 'todas');
    const minDif = Math.max(1, Number(opts.minDiferenca) || 1);
    const limite = Math.min(Math.max(50, Number(opts.limite) || 500), 3000);

    // 1) LADO FLOW — wincred_estoque é o que o PDV/bipe/site enxergam.
    const flowRows: Array<{ codigo: string; loja: string; estoque: number | null }> =
      await (this.prisma as any).wincredEstoque.findMany({
        where: lojaFiltro ? { loja: lojaFiltro } : undefined,
        select: { codigo: true, loja: true, estoque: true },
      });

    // 2) LADO GIGA — ao vivo, INCLUINDO zero e negativo (o negativo é
    //    justamente o que interessa; o sync normal filtra `> 0`).
    const gigaRows = await this.erp.getEstoqueGigaCompleto();
    const gigaOnline = gigaRows.length > 0;
    if (!gigaOnline) {
      throw new BadRequestException(
        'Giga não respondeu (firewall de IP ou pool pendurado). Conferência abortada pra não acusar divergência falsa.',
      );
    }

    const flow = new Map<string, number>();
    let negativosFlow = 0;
    for (const r of flowRows) {
      const k = `${this.norm(r.codigo)}|${this.loja2(r.loja)}`;
      const v = Number(r.estoque) || 0;
      flow.set(k, (flow.get(k) || 0) + v);
    }
    for (const v of flow.values()) if (v < 0) negativosFlow++;

    const giga = new Map<string, number>();
    let negativosGiga = 0;
    for (const r of gigaRows) {
      const lj = this.loja2(r.loja);
      if (lojaFiltro && lj !== lojaFiltro) continue;
      const k = `${this.norm(r.codigo)}|${lj}`;
      giga.set(k, (giga.get(k) || 0) + (Number(r.estoque) || 0));
    }
    for (const v of giga.values()) if (v < 0) negativosGiga++;

    // 3) COMPARA a união das chaves.
    const chaves = new Set<string>([...flow.keys(), ...giga.keys()]);
    const brutas: LinhaDivergencia[] = [];
    let iguais = 0;
    let pecasAMais = 0;
    let pecasAMenos = 0;
    const porLoja = new Map<string, { divergentes: number; pecasAMais: number; pecasAMenos: number; negativosFlow: number; negativosGiga: number }>();

    for (const k of chaves) {
      const [codigo, loja] = k.split('|');
      const temFlow = flow.has(k);
      const temGiga = giga.has(k);
      const vFlow = flow.get(k) ?? 0;
      const vGiga = giga.get(k) ?? 0;

      const acc = porLoja.get(loja) || { divergentes: 0, pecasAMais: 0, pecasAMenos: 0, negativosFlow: 0, negativosGiga: 0 };
      if (vFlow < 0) acc.negativosFlow++;
      if (vGiga < 0) acc.negativosGiga++;

      if (vFlow === vGiga) {
        iguais++;
        porLoja.set(loja, acc);
        continue;
      }

      // Linha ausente de um lado com saldo ZERO do outro não é divergência
      // real — é só linha que nunca foi criada. Ignora pra não inflar o ruído.
      if (!temFlow && vGiga === 0) { iguais++; porLoja.set(loja, acc); continue; }
      if (!temGiga && vFlow === 0) { iguais++; porLoja.set(loja, acc); continue; }

      const dif = vFlow - vGiga;
      if (dif > 0) pecasAMais += dif;
      else pecasAMenos += Math.abs(dif);
      acc.divergentes++;
      if (dif > 0) acc.pecasAMais += dif;
      else acc.pecasAMenos += Math.abs(dif);
      porLoja.set(loja, acc);

      brutas.push({
        codigo,
        loja,
        flow: vFlow,
        giga: vGiga,
        diferenca: dif,
        tipo: !temGiga ? 'SO_NO_FLOW' : !temFlow ? 'SO_NO_GIGA' : 'DIFERENTE',
        descricao: null,
        ref: null,
      });
    }

    // 4) FILTROS da tela.
    let linhas = brutas;
    if (filtro === 'diferente') linhas = linhas.filter((l) => l.tipo === 'DIFERENTE');
    else if (filtro === 'so_flow') linhas = linhas.filter((l) => l.tipo === 'SO_NO_FLOW');
    else if (filtro === 'so_giga') linhas = linhas.filter((l) => l.tipo === 'SO_NO_GIGA');
    else if (filtro === 'negativo') linhas = linhas.filter((l) => l.flow < 0 || l.giga < 0);
    if (minDif > 1) linhas = linhas.filter((l) => Math.abs(l.diferenca) >= minDif);

    // Maior diferença primeiro: quem some com 20 peças importa mais que quem
    // some com 1.
    linhas.sort((a, b) => Math.abs(b.diferenca) - Math.abs(a.diferenca) || a.codigo.localeCompare(b.codigo));
    const truncado = linhas.length > limite;
    linhas = linhas.slice(0, limite);

    // 5) ENRIQUECE só o que vai pra tela (descrição/REF do espelho).
    if (linhas.length) {
      const cods = Array.from(new Set(linhas.map((l) => l.codigo)));
      const prods: Array<{ codigo: string; descricaoCompleta: string | null; descricaoPdv: string | null; ref: string | null }> =
        await (this.prisma as any).wincredProduto.findMany({
          where: { codigo: { in: cods } },
          select: { codigo: true, descricaoCompleta: true, descricaoPdv: true, ref: true },
        }).catch(() => []);
      const mapa = new Map(prods.map((p) => [this.norm(p.codigo), p]));
      for (const l of linhas) {
        const p = mapa.get(l.codigo);
        if (p) {
          l.descricao = p.descricaoCompleta || p.descricaoPdv || null;
          l.ref = p.ref ?? null;
        }
      }
    }

    this.logger.log(
      `[conferidor] ${flow.size} chaves Flow × ${giga.size} Giga · ${brutas.length} divergentes · ${Date.now() - t0}ms`,
    );

    return {
      geradoEm: new Date().toISOString(),
      gigaOnline,
      resumo: {
        linhasFlow: flow.size,
        linhasGiga: giga.size,
        conferidas: chaves.size,
        iguais,
        divergentes: brutas.length,
        diferentes: brutas.filter((l) => l.tipo === 'DIFERENTE').length,
        soNoFlow: brutas.filter((l) => l.tipo === 'SO_NO_FLOW').length,
        soNoGiga: brutas.filter((l) => l.tipo === 'SO_NO_GIGA').length,
        pecasAMais,
        pecasAMenos,
        negativosFlow,
        negativosGiga,
      },
      porLoja: Array.from(porLoja.entries())
        .map(([loja, v]) => ({ loja, ...v }))
        .filter((l) => l.divergentes > 0 || l.negativosFlow > 0 || l.negativosGiga > 0)
        .sort((a, b) => b.divergentes - a.divergentes),
      linhas,
      truncado,
    };
  }

  /**
   * PUXAR DO GIGA — grava o valor do Giga nos espelhos do Flow, SÓ nesse
   * SKU/loja. Não replica de volta (senão a correção viraria um round-trip
   * que reescreve o valor que acabamos de aceitar como certo).
   *
   * Relê o Giga na hora em vez de confiar no número que veio da tela: entre a
   * conferência e o clique pode ter entrado venda.
   */
  async puxarDoGiga(input: { codigo: string; loja: string; userName?: string | null }) {
    const codigo = this.norm(input.codigo);
    const loja = this.loja2(input.loja);
    if (!codigo || !loja) throw new BadRequestException('codigo e loja são obrigatórios');

    const gigaRows = await this.erp.getEstoqueGigaCompleto();
    if (!gigaRows.length) throw new BadRequestException('Giga não respondeu — tente de novo');
    let valorGiga = 0;
    let achou = false;
    for (const r of gigaRows) {
      if (this.norm(r.codigo) === codigo && this.loja2(r.loja) === loja) {
        valorGiga += Number(r.estoque) || 0;
        achou = true;
      }
    }
    if (!achou) valorGiga = 0;

    const antes: any = await (this.prisma as any).wincredEstoque.findUnique({
      where: { codigo_loja: { codigo, loja } },
      select: { estoque: true },
    }).catch(() => null);
    const valorAntes = Number(antes?.estoque) || 0;

    await (this.prisma as any).wincredEstoque.upsert({
      where: { codigo_loja: { codigo, loja } },
      create: { codigo, loja, estoque: valorGiga },
      update: { estoque: valorGiga, syncedAt: new Date() },
    });

    // giga_estoque (espelho do financeiro) anda junto — senão a próxima
    // conferência mostra os dois espelhos do Flow brigando entre si.
    const upd = await (this.prisma as any).gigaEstoque.updateMany({
      where: { codigo: { in: [codigo, codigo.padStart(6, '0'), codigo.padStart(13, '0')] }, loja },
      data: { estoque: valorGiga, syncedAt: new Date() },
    });
    if (!upd.count) {
      await (this.prisma as any).gigaEstoque.create({ data: { codigo, loja, estoque: valorGiga } });
    }

    await (this.prisma as any).stockMovement.create({
      data: {
        storeCode: loja,
        sku: codigo,
        delta: valorGiga - valorAntes,
        qtyBefore: valorAntes,
        qtyAfter: valorGiga,
        reason: 'CONFERENCIA_GIGA',
        note: `Puxado do Giga por ${input.userName || 'admin'} (Flow ${valorAntes} → ${valorGiga})`,
      },
    }).catch(() => null);

    this.logger.warn(
      `[conferidor] PUXOU DO GIGA ${codigo}/${loja}: Flow ${valorAntes} → ${valorGiga} (${input.userName || 'admin'})`,
    );

    return { codigo, loja, antes: valorAntes, depois: valorGiga, delta: valorGiga - valorAntes };
  }

  /**
   * HISTÓRICO do SKU/loja — o "por quê" de cada divergência. Junta os
   * movimentos que o Flow registrou (venda, devolução, ajuste, transferência)
   * com a última venda no Giga.
   */
  async historico(codigoRaw: string, lojaRaw: string) {
    const codigo = this.norm(codigoRaw);
    const loja = this.loja2(lojaRaw);
    if (!codigo || !loja) throw new BadRequestException('codigo e loja são obrigatórios');

    const movimentos: any[] = await (this.prisma as any).stockMovement.findMany({
      where: { sku: { in: [codigo, codigo.padStart(6, '0'), codigo.padStart(13, '0')] }, storeCode: loja },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { delta: true, qtyBefore: true, qtyAfter: true, reason: true, note: true, createdAt: true },
    }).catch(() => []);

    const vendasGiga = await this.erp
      .runReadOnly(
        `SELECT DATA AS data, QUANTIDADE AS qtd, VENDEDOR AS vendedor, OBS_PEDIDO AS obs
           FROM caixa
          WHERE CAST(CODIGO AS UNSIGNED) = ? AND LOJA = ?
          ORDER BY DATA DESC, HORA DESC
          LIMIT 20`,
        { maxRows: 20, timeoutMs: 20_000 },
        [Number(codigo), loja],
      )
      .then((r) => r.rows || [])
      .catch(() => [] as any[]);

    return { codigo, loja, movimentos, vendasGiga };
  }
}
