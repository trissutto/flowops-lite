import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';
import { ProductSearchService } from '../product-search/product-search.service';
import { LojaCatalogService } from '../loja-catalog/loja-catalog.service';
import { avisarVitrine } from '../common/avisar-vitrine';
import { refBaseOf } from '../common/ref-base';
import { diaISO } from '../common/promo-por-termo';
import { hojeBrasilia } from '../common/tz';

/**
 * EDITOR DE PRODUTOS (/retaguarda/editor-produtos) — padronizar REF, corrigir
 * descrição/marca/cor/tamanho e alterar preço, linha a linha ou em bloco.
 *
 * REGRA DE OURO: o Flow é ESPELHO do Giga. Toda edição é gravada NO GIGA
 * (UPDATE produtos, com DATAALT=hoje pro sync incremental enxergar) e os
 * espelhos (giga_produto + wincred_produtos) são atualizados na sequência —
 * PDV/live/consulta refletem na hora, e o próximo sync full confirma.
 *
 * Shadow mode: EDITOR_PRODUTOS_WRITE=0 → loga a intenção na auditoria
 * (applied=false) SEM tocar o Giga. Auditoria sempre: cada campo alterado
 * vira uma linha ANTES→DEPOIS agrupada por batchId.
 */

export type EditChanges = {
  ref?: string;
  descricao?: string;
  marca?: string;
  cor?: string;
  tamanho?: string;
  preco?: number;
  /**
   * PREÇO "DE" da promoção (dono, 26/08): o preço original registrado. O POR
   * é o próprio `preco`/`vendaUn`. `null` = LIMPAR (encerrar a promoção).
   * Vive SÓ na tabela nativa `product` — o espelho é recriado pelo sync e o
   * Giga nem tem a coluna (a réplica ignora, `updateProdutosCampos` pula
   * set sem campo conhecido).
   */
  precoDe?: number | null;
  /**
   * DATA DE CADASTRO da peça (`YYYY-MM-DD`) — a coluna `dataAlt` de
   * `wincred_produtos` E de `product` (as duas, sempre juntas: a campanha do
   * site/PDV lê o espelho, a promoção dos antigos e o bipe leem a nativa).
   *
   * É a ÚNICA porta que muda essa data de propósito. No ERP a coluna chamava
   * DATAALT ("data de alteração") e era carimbada com a data da EDIÇÃO: toda
   * mexida de preço ou descrição rejuvenescia a peça — foi assim que o
   * incidente de 14/07 tirou milhares de peças antigas da promoção, e é por
   * isso que a Black Friday de 26/11 achou peça de 2023 "cadastrada em 2026".
   * O editor NÃO toca a data em nenhuma outra edição; quem corrige é a
   * matriz, aqui, com ANTES→DEPOIS na auditoria (`DATA_CADASTRO`).
   */
  dataCadastro?: string;
};

/** Piso de sanidade da data de cadastro: a rede não tem peça anterior a isto. */
const CADASTRO_MINIMO = '1990-01-01';

/** `YYYY-MM-DD` → Date em meia-noite UTC — o que o Prisma grava numa `@db.Date`. */
const dataSoUTC = (dia: string) => new Date(`${dia}T00:00:00.000Z`);

// Limites reais das colunas do Giga (ver inserirProdutosBatch).
const LIMITS: Record<string, number> = {
  ref: 10,
  descricao: 100,
  marca: 30,
  cor: 15,
  tamanho: 20,
};

@Injectable()
export class ProductsEditorService {
  private readonly logger = new Logger(ProductsEditorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpService,
    private readonly search: ProductSearchService,
    private readonly catalogo: LojaCatalogService,
  ) {}

  /**
   * SALVOU AQUI, O SITE MUDA (13/08).
   *
   * Esta tela renomeia REF, troca preço e marca em bloco — mexe no que a
   * vitrine mostra. E não avisava ninguém: o catálogo montado do backend tem
   * cache de 60 s e a página, ISR. O dono renomeou VOGUE-PD → VOGUE pra juntar
   * a cor na peça, foi conferir no site e não viu nada mudar.
   *
   * As DUAS pontas, sempre juntas: derrubar o cache do site não adianta se o
   * backend responder do dele — a página revalidaria e receberia exatamente a
   * mesma resposta velha (a lição da classificação, 10/08).
   */
  private avisarSite() {
    this.catalogo.invalidarCache();
    avisarVitrine(['catalogo', 'vitrine', 'filtros'], this.logger, 'editor-produtos');
  }

  private get shadowMode(): boolean {
    return String(process.env.EDITOR_PRODUTOS_WRITE ?? '').trim() === '0';
  }

  /**
   * P3 da migração de produtos: PRODUCT_NATIVE_WRITES=1 → o FLOW vira a fonte
   * da verdade do cadastro. A edição grava PRIMEIRO na tabela nativa `product`
   * (com flowIsSource=true — o sync do espelho nunca mais sobrescreve a linha)
   * e REPLICA pro Giga na sequência (dual-write: o Wincred continua enxergando
   * tudo). Se a replicação falhar, a edição VALE (fonte é o Flow) e a falha
   * fica auditada (field=REPLICA_GIGA_ERRO) pra retry manual.
   * DEFAULT LIGADO desde o enterro do Wincred (09/2026): env ausente = nativo.
   * O default antigo (ausente = Giga primeiro) faria TODA edição virar 500 num
   * ambiente sem a env — o "modo atual" de rollback era gravar num MySQL que
   * não existe mais. `PRODUCT_NATIVE_WRITES=0` ainda desliga (não use).
   */
  private get nativeWrites(): boolean {
    return String(process.env.PRODUCT_NATIVE_WRITES ?? '1').trim() !== '0';
  }

  /** Mesma normalização do espelho Wincred: só dígitos perdem zeros à esquerda. */
  private normalizeCodigo(raw: any): string | null {
    const s = String(raw ?? '').trim();
    if (!s) return null;
    if (!/^\d+$/.test(s)) return s;
    return s.replace(/^0+/, '') || '0';
  }

  /**
   * Busca pela rotina ÚNICA (diretriz 10/07) e enriquece com MARCA/preço:
   * 1º tenta o Giga ao vivo (tem MARCA, que o espelho giga_produto não tem);
   * se o Giga falhar/demorar, cai pro espelho Wincred (tem marca, mas só
   * produtos plus) e por fim segue sem marca — a tela nunca trava.
   */
  async searchProdutos(q: string) {
    const term = String(q || '').trim();
    if (!term) throw new BadRequestException('Informe o termo de busca');

    // Teto 5.000 variações (pedido do dono 13/07: "deixar livre" — o teto é só
    // proteção pro navegador; nenhuma família real chega perto disso).
    // PERF (13/07, caso ROVITEX): com a tabela nativa ativa, marca/preço saem
    // DELA (1 query no Postgres) — nada de enriquecer via Giga ao vivo em
    // lotes sequenciais (17 idas à KingHost deixavam a busca em dezenas de
    // segundos pra marcas grandes).
    // Default LIGADO (09/2026): env ausente = lê a nativa; só '0' desliga.
    const nativeReads = String(process.env.PRODUCT_NATIVE_READS ?? '1').trim() !== '0';

    const base = await this.search.resolveRows(term, { fallbackTake: 5000 });
    if (!base.length) return { rows: [], fonte: 'espelho', warnings: { legendaAtiva: [], classificacao: [] } };

    const codigos = Array.from(
      new Set(base.map((r: any) => String(r.codigo || '').trim()).filter(Boolean)),
    ).slice(0, 5000);

    // ── Enriquecimento (MARCA + preço + descrição frescos) ──
    let fonte: 'giga' | 'espelho' | 'flow' = 'espelho';
    const extra = new Map<string, { marca: string | null; vendaUn: number | null; descricao: string | null; ref: string | null; cor: string | null; tamanho: string | null }>();
    if (nativeReads) {
      // Tabela nativa é a fonte: 1 query no Postgres resolve tudo.
      const prows: any[] = await (this.prisma as any).product.findMany({
        where: { codigo: { in: codigos } },
        select: { codigo: true, marca: true, vendaUn: true, descricaoCompleta: true, ref: true, cor: true, tamanho: true },
      });
      for (const r of prows) {
        extra.set(String(r.codigo).trim(), {
          marca: r.marca != null ? String(r.marca).trim() : null,
          vendaUn: r.vendaUn != null ? Number(r.vendaUn) : null,
          descricao: r.descricaoCompleta != null ? String(r.descricaoCompleta) : null,
          ref: r.ref != null ? String(r.ref).trim() : null,
          cor: r.cor != null ? String(r.cor).trim() : null,
          tamanho: r.tamanho != null ? String(r.tamanho).trim() : null,
        });
      }
      fonte = 'flow';
    } else {
    try {
      for (let i = 0; i < codigos.length; i += 300) {
        const chunk = codigos.slice(i, i + 300);
        const placeholders = chunk.map(() => '?').join(',');
        const res = await this.erp.runReadOnly(
          `SELECT CODIGO, REF, DESCRICAOCOMPLETA, MARCA, COR, TAMANHO, VENDAUN
             FROM produtos WHERE CODIGO IN (${placeholders})`,
          { maxRows: 1000, timeoutMs: 8000 },
          chunk,
        );
        for (const r of res.rows as any[]) {
          extra.set(String(r.CODIGO).trim(), {
            marca: r.MARCA != null ? String(r.MARCA).trim() : null,
            vendaUn: r.VENDAUN != null ? Number(r.VENDAUN) : null,
            descricao: r.DESCRICAOCOMPLETA != null ? String(r.DESCRICAOCOMPLETA) : null,
            ref: r.REF != null ? String(r.REF).trim() : null,
            cor: r.COR != null ? String(r.COR).trim() : null,
            tamanho: r.TAMANHO != null ? String(r.TAMANHO).trim() : null,
          });
        }
      }
      fonte = 'giga';
    } catch (e) {
      this.logger.warn(`searchProdutos: Giga ao vivo falhou (${(e as Error).message}) — marca via espelho Wincred`);
      try {
        const norm = codigos.map((c) => this.normalizeCodigo(c)!).filter(Boolean);
        const wrows: any[] = await (this.prisma as any).wincredProduto.findMany({
          where: { codigo: { in: norm } },
          select: { codigo: true, marca: true, vendaUn: true },
        });
        const byNorm = new Map(wrows.map((w) => [w.codigo, w]));
        for (const c of codigos) {
          const w = byNorm.get(this.normalizeCodigo(c)!);
          if (w) extra.set(c, { marca: w.marca ?? null, vendaUn: w.vendaUn != null ? Number(w.vendaUn) : null, descricao: null, ref: null, cor: null, tamanho: null });
        }
      } catch { /* segue sem marca */ }
    }
    }

    // ── Estoque (espelho = fonte desde 14/07): total + POR LOJA ──
    const estoquePorCodigo = new Map<string, number>();
    const estoqueLojasPorCodigo = new Map<string, Record<string, number>>();
    try {
      const est: any[] = await (this.prisma as any).gigaEstoque.findMany({
        where: { codigo: { in: codigos } },
        select: { codigo: true, loja: true, estoque: true },
      });
      for (const e of est) {
        const qtd = Number(e.estoque) || 0;
        estoquePorCodigo.set(e.codigo, (estoquePorCodigo.get(e.codigo) || 0) + qtd);
        const loja = String(e.loja || '').trim().padStart(2, '0');
        const m = estoqueLojasPorCodigo.get(e.codigo) || {};
        m[loja] = (m[loja] || 0) + qtd;
        estoqueLojasPorCodigo.set(e.codigo, m);
      }
    } catch { /* informativo */ }

    /**
     * ── Custo e margem (espelho) ──
     *
     * Consulta à parte de propósito: o enriquecimento acima tem três caminhos
     * (tabela nativa, Giga ao vivo, espelho) e acrescentar dois campos nos três
     * multiplicaria a chance de divergirem. Custo não muda por caminho — sai
     * sempre do espelho.
     *
     * ⚠️ `custo` e `margem` já estão em REAIS, mesma regra do `vendaUn`:
     * NUNCA dividir por 100. Dividir o Decimal do Prisma foi o que derrubou
     * preços 100× em 01/07.
     *
     * Quem pode VER isso é decidido no controller (`ficha-search` poda pra quem
     * não é matriz) — aqui só é buscado.
     */
    const custoPorCodigo = new Map<string, { custo: number | null; margem: number | null }>();
    // Data de cadastro (`dataAlt` do espelho — a que a campanha lê), em
    // `YYYY-MM-DD`: a coluna editável da tela. Ver EditChanges.dataCadastro.
    const cadastroPorCodigo = new Map<string, string | null>();
    try {
      const norm = codigos.map((c) => this.normalizeCodigo(c)).filter(Boolean) as string[];
      if (norm.length) {
        const wrows: any[] = await (this.prisma as any).wincredProduto.findMany({
          where: { codigo: { in: norm } },
          select: { codigo: true, custo: true, margem: true, dataAlt: true },
        });
        const byNorm = new Map(wrows.map((w) => [w.codigo, w]));
        for (const c of codigos) {
          const w = byNorm.get(this.normalizeCodigo(c) as string);
          if (w) {
            custoPorCodigo.set(c, {
              custo: w.custo != null ? Number(w.custo) : null,
              margem: w.margem != null ? Number(w.margem) : null,
            });
            cadastroPorCodigo.set(c, diaISO(w.dataAlt));
          }
        }
      }
    } catch { /* custo é informativo — nunca derruba a busca */ }

    // ── Preço DE registrado (só a nativa tem — ver EditChanges.precoDe) ──
    const precoDePorCodigo = new Map<string, number>();
    try {
      const prods: any[] = await (this.prisma as any).product.findMany({
        where: { codigo: { in: codigos }, precoDe: { not: null } },
        select: { codigo: true, precoDe: true },
      });
      for (const p of prods) {
        const v = Number(p.precoDe);
        if (isFinite(v) && v > 0) precoDePorCodigo.set(String(p.codigo).trim(), v);
      }
    } catch { /* DE é informativo — nunca derruba a busca */ }

    // ── Monta linhas: Giga fresco > espelho ──
    const rows = base
      .filter((r: any) => String(r.codigo || '').trim() && codigos.includes(String(r.codigo).trim()))
      .map((r: any) => {
        const codigo = String(r.codigo).trim();
        const ex = extra.get(codigo);
        const cm = custoPorCodigo.get(codigo);
        return {
          codigo,
          ref: (ex?.ref ?? (r.ref != null ? String(r.ref).trim() : '')) || '',
          descricao: ex?.descricao ?? (r.descricao != null ? String(r.descricao) : ''),
          marca: ex?.marca ?? null,
          cor: ex?.cor ?? (r.cor != null ? String(r.cor).trim() : ''),
          tamanho: ex?.tamanho ?? (r.tamanho != null ? String(r.tamanho).trim() : ''),
          preco: ex?.vendaUn ?? (r as any).vendaUn ?? null,
          precoDe: precoDePorCodigo.get(codigo) ?? null,
          dataCadastro: cadastroPorCodigo.get(codigo) ?? null,
          custo: cm?.custo ?? null,
          margem: cm?.margem ?? null,
          estoque: estoquePorCodigo.get(codigo) ?? null,
          estoqueLojas: estoqueLojasPorCodigo.get(codigo) ?? {},
        };
      })
      .sort((a, b) =>
        (a.ref || '').localeCompare(b.ref || '') ||
        (a.descricao || '').localeCompare(b.descricao || '') ||
        (a.cor || '').localeCompare(b.cor || '') ||
        (a.tamanho || '').localeCompare(b.tamanho || ''),
      );

    // ── Avisos: REF em legenda de live ATIVA + classificação existente ──
    const refs = Array.from(new Set(rows.map((r) => r.ref).filter(Boolean)));
    let legendaAtiva: Array<{ refCode: string; atalho: string }> = [];
    let classificacao: Array<{ ref: string; tipoProduto: number }> = [];
    if (refs.length) {
      try {
        legendaAtiva = await (this.prisma as any).livePdvAtalho.findMany({
          where: { refCode: { in: refs }, session: { NOT: { status: 'ended' } } },
          select: { refCode: true, atalho: true },
        });
      } catch { /* aviso opcional */ }
      try {
        classificacao = await (this.prisma as any).productClassification.findMany({
          where: { ref: { in: refs } },
          select: { ref: true, tipoProduto: true },
        });
      } catch { /* aviso opcional */ }
    }

    return { rows, fonte, shadowMode: this.shadowMode, warnings: { legendaAtiva, classificacao } };
  }

  /**
   * Colisão de REF: quantas variações JÁ usam a REF destino (fora as que estão
   * sendo renomeadas). >0 = a renomeação vai FUNDIR com outro produto.
   */
  async refInfo(ref: string, excludeCodigos: string[]) {
    const target = String(ref || '').trim().toUpperCase();
    if (!target) throw new BadRequestException('Informe a REF');
    // Colisão não olha caixa: renomear pra "VLM-126" tem que enxergar um
    // "vlm-126" já existente, senão a fusão acontece sem aviso.
    const where: any = { ref: { equals: target, mode: 'insensitive' } };
    if (excludeCodigos.length) where.codigo = { notIn: excludeCodigos };
    const [count, sample] = await Promise.all([
      (this.prisma as any).gigaProduto.count({ where }),
      (this.prisma as any).gigaProduto.findFirst({ where, select: { descricao: true } }),
    ]);
    return { ref: target, existentes: count, exemploDescricao: sample?.descricao ?? null };
  }

  /**
   * HISTÓRICO DE UMA VARIAÇÃO (código/SKU) — quando vendeu, pra quem, quem
   * vendeu, e se voltou (devolução/troca). Pedido do dono (16/07).
   *
   * Fontes:
   *  - VENDAS/MARCADOS: `caixa` do Giga (histórico completo, TODAS as lojas).
   *    MARCADO='SIM' = "provar em casa"; linha negativa = devolução legada.
   *  - DEVOLUÇÕES/TROCAS: `PdvReturn` do Flow (da era FlowOps pra cá) que
   *    tocaram este SKU. Troca antiga só-no-Giga não tem registro estruturado.
   *  - Nome da vendedora: espelho `wincred_funcionarios` (VENDEDOR = código).
   */
  async historicoProduto(codigoRaw: string) {
    const codigo = String(codigoRaw || '').replace(/\D/g, '');
    if (!codigo) throw new BadRequestException('Informe o código da variação');
    const codNum = Number(codigo);
    const skuNorm = codigo.replace(/^0+/, '') || codigo;

    // 1) Vendas/marcados — ESPELHO `giga_caixa_mov` (29/08). Era `runReadOnly`
    // na `caixa` do Giga vivo: com o pool trancado (atestado 28/08) o erro era
    // engolido e o histórico saía SEMPRE vazio. O espelho tem o histórico
    // sincronizado do Giga até 24/08 e, dali em diante, nasce do `pdv_sales`
    // (espelharCaixaMovDoFlow) — pro histórico mais fundo que o espelho,
    // existe o dump completo do Giga guardado offline.
    let caixaRows: any[] = [];
    void codNum; // era o parâmetro do CAST no MySQL; o match agora é por ltrim
    try {
      caixaRows = await (this.prisma as any).$queryRawUnsafe(
        `SELECT registro AS "REGISTRO", data AS "DATA", hora AS "HORA", loja AS "LOJA",
                COALESCE(nome_cliente, cliente) AS "NOMECLIENTE",
                COALESCE(vendedora_code, vendedor) AS "VENDEDOR",
                quantidade::float AS "QUANTIDADE",
                valor_total::float AS "VALORTOTAL",
                marcado AS "MARCADO"
           FROM giga_caixa_mov
          WHERE ltrim(COALESCE(codigo, ''), '0') = $1
          ORDER BY data DESC, hora DESC
          LIMIT 500`,
        skuNorm,
      );
    } catch (e: any) {
      this.logger.warn(`[historico] caixa (espelho) falhou p/ ${codigo}: ${e?.message || e}`);
    }

    // 2) Nome da vendedora (espelho) + nome da loja.
    const vendCodes = Array.from(
      new Set(caixaRows.map((r) => String(r.VENDEDOR ?? '').trim()).filter(Boolean)),
    );
    // O CODIGO repete entre lojas (espelho agora tem 1 linha por codigo×loja):
    // chave codigo|loja primeiro; codigo solto fica como fallback.
    const nomeVend = new Map<string, string>();
    if (vendCodes.length) {
      const funcs = await (this.prisma as any).wincredFuncionario
        .findMany({ where: { codigo: { in: vendCodes } }, select: { codigo: true, nome: true, loja: true } })
        .catch(() => []);
      for (const f of funcs as any[]) {
        const cod = String(f.codigo).trim();
        const loja = String(f.loja || '').trim().replace(/^0+/, '');
        nomeVend.set(`${cod}|${loja}`, f.nome || '');
        if (!nomeVend.has(cod)) nomeVend.set(cod, f.nome || '');
      }
    }
    const stores = await (this.prisma as any).store
      .findMany({ select: { code: true, name: true } })
      .catch(() => []);
    const storeName = new Map<string, string>(
      (stores as any[]).map((s) => [String(s.code).trim().replace(/^0+/, ''), s.name]),
    );
    const lojaNome = (loja: any) => {
      const c = String(loja ?? '').trim().replace(/^0+/, '');
      return storeName.get(c) || (loja ? `Loja ${loja}` : '—');
    };

    const vendas = caixaRows.map((r) => {
      const marcado = String(r.MARCADO ?? '').toUpperCase() === 'SIM';
      const valor = Number(r.VALORTOTAL) || 0;
      const qty = Number(r.QUANTIDADE) || 1;
      const devolucaoLegada = valor < 0 || qty < 0;
      return {
        tipo: marcado ? 'marcado' : devolucaoLegada ? 'devolucao' : 'venda',
        data: r.DATA ? new Date(r.DATA).toISOString() : null,
        hora: r.HORA ? String(r.HORA) : null,
        loja: lojaNome(r.LOJA),
        cliente: (String(r.NOMECLIENTE || '').trim()) || null,
        vendedora:
          nomeVend.get(`${String(r.VENDEDOR ?? '').trim()}|${String(r.LOJA ?? '').trim().replace(/^0+/, '')}`) ||
          nomeVend.get(String(r.VENDEDOR ?? '').trim()) ||
          (r.VENDEDOR ? `Cód ${r.VENDEDOR}` : null),
        qty: Math.abs(qty),
        valor: Math.abs(valor),
        fonte: 'giga',
      };
    });

    // 3) Devoluções/trocas no Flow (PdvReturn) que tocaram este SKU.
    let devolucoes: any[] = [];
    try {
      const items = await (this.prisma as any).pdvReturnItem.findMany({
        where: { sku: { in: Array.from(new Set([codigo, skuNorm])) } },
        select: {
          qty: true,
          total: true,
          return: {
            select: {
              storeCode: true, storeName: true, modo: true, valorTotal: true,
              customerName: true, motivo: true, createdAt: true, status: true,
            },
          },
        },
        take: 300,
      });
      devolucoes = (items as any[])
        .filter((it) => it.return && it.return.status !== 'cancelled')
        .map((it) => ({
          tipo: it.return.modo === 'troca' ? 'troca' : 'devolucao',
          data: it.return.createdAt ? new Date(it.return.createdAt).toISOString() : null,
          hora: null,
          loja: it.return.storeName || lojaNome(it.return.storeCode),
          cliente: it.return.customerName || null,
          vendedora: null,
          qty: it.qty || 1,
          valor: Math.abs(Number(it.total) || 0),
          modo: it.return.modo,
          motivo: it.return.motivo || null,
          fonte: 'flow',
        }));
    } catch (e: any) {
      this.logger.warn(`[historico] returns falhou p/ ${codigo}: ${e?.message || e}`);
    }

    const movimentos = [...vendas, ...devolucoes].sort((a, b) =>
      String(b.data || '').localeCompare(String(a.data || '')),
    );

    return {
      codigo,
      resumo: {
        vendas: vendas.filter((v) => v.tipo === 'venda').length,
        devolucoes:
          devolucoes.filter((d) => d.tipo === 'devolucao').length +
          vendas.filter((v) => v.tipo === 'devolucao').length,
        trocas: devolucoes.filter((d) => d.tipo === 'troca').length,
        marcados: vendas.filter((v) => v.tipo === 'marcado').length,
      },
      movimentos,
    };
  }

  /**
   * Aplica um lote de edições. Cada item: { codigo, changes }.
   * Valida limites → grava no GIGA (transação única) → atualiza espelhos →
   * audita campo a campo. Em shadow mode só audita (applied=false).
   */
  async apply(input: {
    edits: Array<{ codigo: string; changes: EditChanges }>;
    userName?: string | null;
  }) {
    const edits = (input.edits || []).filter((e) => e && e.codigo && e.changes);
    if (!edits.length) throw new BadRequestException('Nenhuma edição informada');
    if (edits.length > 5000) throw new BadRequestException('Máximo 5.000 variações por lote');

    // ── Validação de campos/limites ──
    for (const e of edits) {
      const c = e.changes;
      for (const [field, max] of Object.entries(LIMITS)) {
        const v = (c as any)[field];
        if (v !== undefined && String(v).trim().length > max) {
          throw new BadRequestException(
            `${field.toUpperCase()} "${String(v).trim().slice(0, 30)}…" passa do limite do cadastro (${max} caracteres)`,
          );
        }
      }
      if (c.ref !== undefined && !String(c.ref).trim()) {
        throw new BadRequestException(`REF não pode ficar vazia (código ${e.codigo})`);
      }
      if (c.descricao !== undefined && !String(c.descricao).trim()) {
        throw new BadRequestException(`Descrição não pode ficar vazia (código ${e.codigo})`);
      }
      if (c.preco !== undefined) {
        const n = Number(c.preco);
        if (!isFinite(n) || n <= 0) {
          throw new BadRequestException(`Preço inválido no código ${e.codigo} — informe em REAIS (ex: 129.90)`);
        }
        // Guard-rail do bug ÷100: preço de roupa não é centavos nem milhões.
        if (n > 100000) throw new BadRequestException(`Preço R$ ${n} no código ${e.codigo} parece errado (limite 100.000)`);
      }
      if (c.precoDe !== undefined && c.precoDe !== null) {
        const n = Number(c.precoDe);
        if (!isFinite(n) || n <= 0) {
          throw new BadRequestException(`Preço DE inválido no código ${e.codigo} — informe em REAIS ou deixe vazio pra limpar`);
        }
        if (n > 100000) throw new BadRequestException(`Preço DE R$ ${n} no código ${e.codigo} parece errado (limite 100.000)`);
        // DE tem que ser MAIOR que o POR do MESMO lote — "de 99 por 129" é
        // anti-promoção. Quando o POR não veio no lote, quem confere é a
        // exibição (DE <= vendaUn atual é simplesmente ignorado nas telas).
        if (c.preco !== undefined && n <= Number(c.preco)) {
          throw new BadRequestException(
            `Preço DE (R$ ${n}) precisa ser MAIOR que o POR (R$ ${Number(c.preco)}) no código ${e.codigo}`,
          );
        }
      }
      if (c.dataCadastro !== undefined) {
        // Data que não existe ("2025-13-40") virando null calado tiraria a peça
        // de toda promoção por data ("peça sem data fica fora") — recusa alto.
        const dia = diaISO(String(c.dataCadastro ?? ''));
        if (!dia) {
          throw new BadRequestException(`Data de cadastro inválida no código ${e.codigo}: "${c.dataCadastro}". Use AAAA-MM-DD.`);
        }
        if (dia > hojeBrasilia()) {
          throw new BadRequestException(`Data de cadastro no futuro (${dia}) no código ${e.codigo} — peça não nasce amanhã.`);
        }
        if (dia < CADASTRO_MINIMO) {
          throw new BadRequestException(`Data de cadastro ${dia} no código ${e.codigo} é anterior a ${CADASTRO_MINIMO} — confira o ano.`);
        }
      }
    }

    // ── Valores atuais (espelho) pra auditoria ANTES→DEPOIS ──
    const codigos = edits.map((e) => e.codigo);
    const atuais: any[] = await (this.prisma as any).gigaProduto.findMany({
      where: { codigo: { in: codigos } },
    });
    const atualPorCodigo = new Map(atuais.map((a) => [String(a.codigo).trim(), a]));

    // Data de cadastro atual (espelho) — ANTES→DEPOIS da auditoria. Só pros
    // códigos cuja data está sendo editada.
    const cadastroAtualPorCodigo = new Map<string, string | null>();
    const comData = edits.filter((e) => e.changes.dataCadastro !== undefined).map((e) => e.codigo);
    if (comData.length) {
      const norm = Array.from(new Set(comData.map((c) => this.normalizeCodigo(c)).filter(Boolean))) as string[];
      const wrows: any[] = await (this.prisma as any).wincredProduto.findMany({
        where: { codigo: { in: norm } },
        select: { codigo: true, dataAlt: true },
      });
      const byNorm = new Map(wrows.map((w) => [String(w.codigo), diaISO(w.dataAlt)]));
      for (const c of comData) cadastroAtualPorCodigo.set(c, byNorm.get(this.normalizeCodigo(c) as string) ?? null);
    }

    // DE atual (só a nativa tem a coluna) — pro ANTES→DEPOIS da auditoria.
    const deAtualPorCodigo = new Map<string, number | null>();
    try {
      const prods: any[] = await (this.prisma as any).product.findMany({
        where: { codigo: { in: codigos } },
        select: { codigo: true, precoDe: true },
      });
      for (const p of prods) {
        deAtualPorCodigo.set(String(p.codigo).trim(), p.precoDe != null ? Number(p.precoDe) : null);
      }
    } catch { /* auditoria fica sem o ANTES — nunca trava a edição */ }

    const batchId = randomUUID();
    const auditRows: any[] = [];
    const erpRows: Array<{ codigo: string; set: any }> = [];

    for (const e of edits) {
      const atual = atualPorCodigo.get(e.codigo);
      const c = e.changes;
      const set: any = {};
      const push = (field: string, oldV: any, newV: any) => {
        auditRows.push({
          batchId,
          codigo: e.codigo,
          ref: atual?.ref ?? null,
          field,
          oldValue: oldV != null ? String(oldV).slice(0, 200) : null,
          newValue: newV != null ? String(newV).slice(0, 200) : null,
          userName: input.userName || null,
          applied: !this.shadowMode,
        });
      };
      if (c.ref !== undefined) { const v = String(c.ref).trim().toUpperCase(); set.ref = v; push('REF', atual?.ref, v); }
      if (c.descricao !== undefined) { const v = String(c.descricao).trim().toUpperCase(); set.descricaoCompleta = v; push('DESCRICAO', atual?.descricao, v); }
      if (c.marca !== undefined) { const v = String(c.marca).trim().toUpperCase(); set.marca = v; push('MARCA', null, v); }
      if (c.cor !== undefined) { const v = String(c.cor).trim().toUpperCase(); set.cor = v; push('COR', atual?.cor, v); }
      if (c.tamanho !== undefined) { const v = String(c.tamanho).trim().toUpperCase(); set.tamanho = v; push('TAMANHO', atual?.tamanho, v); }
      if (c.preco !== undefined) { const v = Math.round(Number(c.preco) * 100) / 100; set.vendaUn = v; push('PRECO', atual?.vendaUn, v); }
      if (c.precoDe !== undefined) {
        const v = c.precoDe === null ? null : Math.round(Number(c.precoDe) * 100) / 100;
        set.precoDe = v;
        push('PRECO_DE', deAtualPorCodigo.get(e.codigo) ?? null, v);
      }
      if (c.dataCadastro !== undefined) {
        const v = diaISO(String(c.dataCadastro)) as string; // validado acima
        set.dataCadastro = v;
        push('DATA_CADASTRO', cadastroAtualPorCodigo.get(e.codigo) ?? null, v);
      }
      if (Object.keys(set).length) erpRows.push({ codigo: e.codigo, set });
    }

    if (!erpRows.length) throw new BadRequestException('Nenhum campo alterado');

    // ── SHADOW MODE: só audita, não grava ──
    if (this.shadowMode) {
      await (this.prisma as any).productEditAudit.createMany({ data: auditRows });
      this.logger.warn(`[editor-produtos] SHADOW MODE: ${erpRows.length} updates NÃO gravados (EDITOR_PRODUTOS_WRITE=0), batch ${batchId}`);
      return { ok: true, shadow: true, batchId, atualizados: 0, planejados: erpRows.length };
    }

    // ── GRAVAÇÃO ──
    // PERF (13/07): agrupa por payload IGUAL — ação em bloco (marca/preço
    // igual em N variações) vira UMA query por tabela em vez de N (era o
    // "preenchimento lento" na troca de marcas).
    const buildData = (set: any) => {
      const data: any = {};
      if (set.ref !== undefined) data.ref = set.ref;
      if (set.descricaoCompleta !== undefined) {
        data.descricaoCompleta = set.descricaoCompleta;
        data.descricaoPdv = String(set.descricaoCompleta).slice(0, 50);
      }
      if (set.marca !== undefined) data.marca = set.marca;
      if (set.cor !== undefined) data.cor = set.cor;
      if (set.tamanho !== undefined) data.tamanho = set.tamanho;
      if (set.vendaUn !== undefined) data.vendaUn = set.vendaUn;
      return data;
    };
    const grupos = new Map<string, { set: any; codigos: string[] }>();
    for (const r of erpRows) {
      const key = JSON.stringify(r.set);
      const g = grupos.get(key);
      if (g) g.codigos.push(r.codigo);
      else grupos.set(key, { set: r.set, codigos: [r.codigo] });
    }
    const comNormalizados = (codigos: string[]) =>
      Array.from(new Set(codigos.flatMap((c) => [c, this.normalizeCodigo(c)!].filter(Boolean))));

    // Modo NATIVO (P3): Flow primeiro (fonte da verdade) + réplica pro Giga.
    // Modo padrão: Giga primeiro (fonte da verdade) — comportamento original.
    let atualizados = 0;
    // `precoDe` vive SÓ na nativa (espelho é recriado pelo sync; Giga nem tem
    // a coluna) — entra à parte do `buildData` pros espelhos não o receberem.
    const dataNativa = (set: any) => ({
      ...buildData(set),
      ...(set.precoDe !== undefined ? { precoDe: set.precoDe } : {}),
      // Data de cadastro: a nativa recebe a mesma data do espelho (abaixo).
      ...(set.dataCadastro !== undefined ? { dataAlt: dataSoUTC(set.dataCadastro) } : {}),
    });

    if (this.nativeWrites) {
      const now = new Date();
      for (const g of grupos.values()) {
        const res = await (this.prisma as any).product.updateMany({
          where: { codigo: { in: comNormalizados(g.codigos) } },
          data: { ...dataNativa(g.set), flowIsSource: true, editedAt: now },
        });
        atualizados += Number(res.count) || 0;
      }
      // Réplica pro Giga (dual-write). Falha NÃO desfaz a edição — audita.
      try {
        await this.erp.updateProdutosCampos(erpRows);
      } catch (eGiga) {
        const msg = (eGiga as Error).message?.slice(0, 180) || 'erro';
        this.logger.error(`[editor-produtos] réplica pro Giga FALHOU (${msg}) — edição vale no Flow, batch ${batchId}`);
        auditRows.push({
          batchId,
          codigo: 'BATCH',
          ref: null,
          field: 'REPLICA_GIGA_ERRO',
          oldValue: null,
          newValue: msg,
          userName: input.userName || null,
          applied: true,
        });
      }
    } else {
      // ── GRAVA NO GIGA (fonte da verdade no modo padrão) ──
      const r = await this.erp.updateProdutosCampos(erpRows);
      atualizados = r.atualizados;
      // Mantém a tabela nativa fresca (sem flowIsSource — Giga segue como fonte).
      for (const g of grupos.values()) {
        await (this.prisma as any).product
          .updateMany({
            where: { codigo: { in: comNormalizados(g.codigos) } },
            data: dataNativa(g.set),
          })
          .catch(() => null);
      }
    }

    // ── ESPELHOS: reflete na hora (o sync incremental confirma depois) ──
    for (const g of grupos.values()) {
      try {
        const gp: any = {};
        // A REF-BASE vai junto com a REF: a grade da live abre a família pela
        // `ref_base` do espelho, e o backfill do GigaMirror só preenche linha
        // VAZIA. Sem isto a peça renomeada continuava na família antiga — caso
        // da saia 207279 cadastrada como 207282 (16/09/2026).
        if (g.set.ref !== undefined) {
          gp.ref = g.set.ref;
          gp.refBase = refBaseOf(g.set.ref);
        }
        if (g.set.descricaoCompleta !== undefined) gp.descricao = g.set.descricaoCompleta;
        if (g.set.cor !== undefined) gp.cor = g.set.cor;
        if (g.set.tamanho !== undefined) gp.tamanho = g.set.tamanho;
        if (g.set.vendaUn !== undefined) gp.vendaUn = g.set.vendaUn;
        if (Object.keys(gp).length) {
          await (this.prisma as any).gigaProduto.updateMany({
            where: { codigo: { in: g.codigos } },
            data: gp,
          });
        }
        const w = buildData(g.set);
        // A ÚNICA edição que muda a data de cadastro é a edição DA DATA
        // (campo "Cadastro" da tela, com ANTES→DEPOIS na auditoria). As outras
        // nunca a tocam — ver EditChanges.dataCadastro e o incidente 14/07.
        if (g.set.dataCadastro !== undefined) w.dataAlt = dataSoUTC(g.set.dataCadastro);
        if (Object.keys(w).length) {
          // ⚠️ NÃO tocar dataAlt (incidente 14/07): é a data de CADASTRO que
          // a promoção Liquida Antigos usa. Edição não muda idade da peça.
          await (this.prisma as any).wincredProduto.updateMany({
            where: { codigo: { in: g.codigos.map((c) => this.normalizeCodigo(c)!).filter(Boolean) } },
            data: w,
          });
        }
      } catch (e2) {
        // Espelho desatualizado não é fatal: o sync incremental corrige (DATAALT foi tocada no Giga).
        this.logger.warn(`[editor-produtos] espelho não atualizou (grupo de ${g.codigos.length}): ${(e2 as Error).message}`);
      }
    }

    await (this.prisma as any).productEditAudit.createMany({ data: auditRows });
    this.logger.log(`[editor-produtos] batch ${batchId}: ${atualizados} produtos gravados no Giga por ${input.userName || '?'}`);
    this.avisarSite();
    return { ok: true, shadow: false, batchId, atualizados, planejados: erpRows.length };
  }

  /**
   * MARCA EM MASSA NO SERVIDOR (13/07): aplica a marca em TODOS os resultados
   * da busca, SEM o teto de 5.000 da tela (marcas com dezenas de milhares de
   * variações não cabem no navegador). Mesma ordem de gravação do apply():
   * nativo-primeiro com réplica quando PRODUCT_NATIVE_WRITES=1; senão
   * Giga-primeiro. Auditoria em UMA linha-resumo por lote (o detalhe linha a
   * linha de 20k+ variações não agrega — o resumo diz busca, marca e volume).
   */
  async applyMarcaBySearch(input: { q: string; marca: string; userName?: string | null }) {
    const q = String(input.q || '').trim();
    const marca = String(input.marca || '').trim().toUpperCase();
    if (!q) throw new BadRequestException('Informe o termo de busca');
    if (!marca) throw new BadRequestException('Informe a marca');
    if (marca.length > LIMITS.marca) {
      throw new BadRequestException(`MARCA passa do limite do cadastro (${LIMITS.marca} caracteres)`);
    }

    const rows = await this.search.resolveRows(q, { fallbackTake: 200000 });
    const codigos = Array.from(
      new Set(rows.map((r: any) => String(r.codigo || '').trim()).filter(Boolean)),
    );
    if (!codigos.length) throw new BadRequestException(`Busca "${q}" não encontrou nada`);

    const batchId = randomUUID();
    const auditResumo = {
      batchId,
      codigo: 'MASSA',
      ref: null,
      field: 'MARCA_EM_MASSA',
      oldValue: `busca "${q.slice(0, 80)}" → ${codigos.length} variações`,
      newValue: marca,
      userName: input.userName || null,
      applied: !this.shadowMode,
    };

    if (this.shadowMode) {
      await (this.prisma as any).productEditAudit.createMany({ data: [auditResumo] });
      return { ok: true, shadow: true, batchId, atualizados: 0, planejados: codigos.length };
    }

    const erpRows = codigos.map((c) => ({ codigo: c, set: { marca } }));
    let atualizados = 0;
    let replicaErro: string | null = null;

    if (this.nativeWrites) {
      const now = new Date();
      for (let i = 0; i < codigos.length; i += 10000) {
        const chunk = codigos.slice(i, i + 10000);
        const res = await (this.prisma as any).product.updateMany({
          where: { codigo: { in: Array.from(new Set(chunk.flatMap((c) => [c, this.normalizeCodigo(c)!].filter(Boolean)))) } },
          data: { marca, flowIsSource: true, editedAt: now },
        });
        atualizados += Number(res.count) || 0;
      }
      try {
        await this.erp.updateProdutosCampos(erpRows);
      } catch (eGiga) {
        replicaErro = (eGiga as Error).message?.slice(0, 180) || 'erro';
        this.logger.error(`[editor-produtos] réplica em massa pro Giga FALHOU (${replicaErro}), batch ${batchId}`);
      }
    } else {
      const r = await this.erp.updateProdutosCampos(erpRows);
      atualizados = r.atualizados;
      for (let i = 0; i < codigos.length; i += 10000) {
        const chunk = codigos.slice(i, i + 10000);
        await (this.prisma as any).product
          .updateMany({
            where: { codigo: { in: Array.from(new Set(chunk.flatMap((c) => [c, this.normalizeCodigo(c)!].filter(Boolean)))) } },
            data: { marca },
          })
          .catch(() => null);
      }
    }

    // Espelho Wincred (o giga_produto não tem coluna de marca).
    for (let i = 0; i < codigos.length; i += 10000) {
      const chunk = codigos.slice(i, i + 10000);
      await (this.prisma as any).wincredProduto
        .updateMany({
          where: { codigo: { in: chunk.map((c) => this.normalizeCodigo(c)!).filter(Boolean) } },
          data: { marca }, // ⚠️ sem dataAlt (incidente 14/07 — data de cadastro/promo)
        })
        .catch(() => null);
    }

    const audits: any[] = [auditResumo];
    if (replicaErro) {
      audits.push({
        batchId, codigo: 'BATCH', ref: null, field: 'REPLICA_GIGA_ERRO',
        oldValue: null, newValue: replicaErro, userName: input.userName || null, applied: true,
      });
    }
    await (this.prisma as any).productEditAudit.createMany({ data: audits });
    this.logger.log(`[editor-produtos] MARCA EM MASSA "${marca}" em ${codigos.length} variações (busca "${q}") por ${input.userName || '?'}`);
    // Marca é o que agrupa a peça no card da vitrine ([[busca-agrupa-por-marca]]):
    // trocar em bloco e não avisar deixa o site com o agrupamento anterior.
    this.avisarSite();
    return { ok: true, shadow: false, batchId, atualizados: atualizados || codigos.length, planejados: codigos.length };
  }

  // ── INCIDENTE 14/07 (DATAALT) — RESTAURADORES REMOVIDOS EM 09/26 ────────
  //
  // As quatro levas de restauração da DATAALT (nativo/ref, backup, primeira
  // venda no caixa e auditoria pelo arquivo de 12/07) saíram junto com o
  // diagnóstico e o /restaurar-dataalt/progresso. Todas gravavam a data DE
  // VOLTA no MySQL do Giga (erp.restoreDataAlt) e liam o catálogo dele
  // (runReadOnly, caixaCodigoIndexed, getFirstSaleDatesChunk) pra provar
  // idade da peça — com o Giga morto desde 27/08 elas não têm nem fonte nem
  // destino. O incidente foi fechado em julho; a tela nunca chamou nenhuma
  // dessas rotas (eram disparadas na mão) e o que sobrou vivo é o
  // restaurarDataAltNativoDoEspelho, 100% Postgres, mais abaixo.

  /**
   * EXCLUSÃO de produtos (tela do editor). Trava de segurança: código com
   * ESTOQUE > 0 em qualquer loja só sai com forcar=true. Apaga do Flow
   * (product, wincred_produtos, espelhos de estoque) na hora e replica a
   * exclusão pro Giga inline — Giga fora → outbox kind produto_exclusao.
   * Tudo auditado (ANTES da exclusão) em product_edit_audit.
   */
  async excluirProdutos(input: { codigos: string[]; forcar?: boolean; userName?: string | null }) {
    const codigos = Array.from(
      new Set(
        (input.codigos || [])
          .map((c) => this.normalizeCodigo(String(c || '')))
          .filter((c): c is string => !!c),
      ),
    );
    if (!codigos.length) throw new BadRequestException('Nenhum código informado');
    if (codigos.length > 500) throw new BadRequestException('Máximo de 500 produtos por exclusão');

    // Trava: estoque > 0 em alguma loja (espelho)
    if (!input.forcar) {
      const rows: any[] = await (this.prisma as any).wincredEstoque.findMany({
        where: { codigo: { in: codigos }, estoque: { gt: 0 } },
        select: { codigo: true, loja: true, estoque: true },
      });
      if (rows.length) {
        const bloqueados = Array.from(new Set(rows.map((r) => String(r.codigo))));
        return {
          ok: false,
          bloqueados,
          mensagem: `${bloqueados.length} código(s) com ESTOQUE > 0 — confirme com "forçar" pra excluir mesmo assim`,
        };
      }
    }

    // Auditoria ANTES de apagar (registra o que era)
    const antes: any[] = await (this.prisma as any).product.findMany({
      where: { codigo: { in: codigos } },
      select: { codigo: true, ref: true, descricaoCompleta: true },
    });
    const infoPorCodigo = new Map(antes.map((p) => [String(p.codigo), p]));
    const batchId = randomUUID();
    await (this.prisma as any).productEditAudit.createMany({
      data: codigos.map((c) => ({
        batchId,
        codigo: c,
        ref: infoPorCodigo.get(c)?.ref || null,
        field: 'EXCLUIDO',
        oldValue: (infoPorCodigo.get(c)?.descricaoCompleta || '').slice(0, 100) || null,
        newValue: input.forcar ? 'excluído (forçado, com estoque)' : 'excluído',
        userName: input.userName || null,
        applied: true,
      })),
    }).catch(() => null);

    // Flow primeiro (efeito imediato em busca/bipe/grade)
    await (this.prisma as any).product.deleteMany({ where: { codigo: { in: codigos } } }).catch(() => null);
    await (this.prisma as any).wincredProduto.deleteMany({ where: { codigo: { in: codigos } } }).catch(() => null);
    await (this.prisma as any).wincredEstoque.deleteMany({ where: { codigo: { in: codigos } } }).catch(() => null);
    await (this.prisma as any).gigaEstoque.deleteMany({ where: { codigo: { in: codigos } } }).catch(() => null);

    // Réplica no Giga: inline com fallback pro outbox
    let excluidosGiga = 0;
    let gigaEnfileirado = false;
    try {
      const r = await this.erp.deleteProdutos(codigos);
      excluidosGiga = r.excluidos;
    } catch (e) {
      gigaEnfileirado = true;
      await (this.prisma as any).erpOutbox.create({
        data: {
          kind: 'produto_exclusao',
          saleId: `del-${batchId}`,
          payload: { codigos },
          status: 'pending',
        },
      }).catch(() => null);
      this.logger.warn(`[editor] exclusão: Giga indisponível (${(e as Error).message}) — enfileirada no outbox`);
    }
    this.logger.log(
      `[editor] EXCLUSÃO: ${codigos.length} código(s) no Flow` +
        (gigaEnfileirado ? ' + Giga via outbox' : ` + ${excluidosGiga} no Giga`) +
        ` (por ${input.userName || '?'})`,
    );
    // Peça excluída tem que SUMIR do site na hora — é o caso em que servir a
    // página velha vende o que não existe mais.
    this.avisarSite();
    return { ok: true, excluidos: codigos.length, excluidosGiga, gigaEnfileirado, batchId };
  }

  /**
   * INCIDENTE DATAALT — passo final (14/07): a tabela NATIVA `product` guarda
   * cópia PRÓPRIA da data de cadastro, e o bipe do PDV lê DELA quando
   * PRODUCT_NATIVE_READS=1 — por isso a promo "Liquida antigos" continuava
   * mostrando "Sem promo · 2026" mesmo com Giga e espelho já restaurados.
   *
   * Copia a data DO ESPELHO wincred_produtos (ressincronizado do Giga já
   * corrigido pelo backup 12/07) pra nativa, SÓ nas linhas sujas:
   *   nativa >= 13/07 (carimbo do incidente)  E  espelho < 13/07 (data real).
   * NUNCA toca: o Giga, datas já corretas na nativa (< 13/07), e produtos
   * genuinamente novos (espelho também >= 13/07 → fora do WHERE).
   * Dry-run por padrão: devolve contagem + amostra SEM escrever nada.
   */
  async restaurarDataAltNativoDoEspelho(executar: boolean) {
    const whereSujo = `
      FROM product p
      JOIN wincred_produtos w ON w.codigo = p.codigo
     WHERE p."dataAlt" IS NOT NULL
       AND p."dataAlt" >= DATE '2026-07-13'
       AND w."dataAlt" IS NOT NULL
       AND w."dataAlt" < DATE '2026-07-13'`;
    const cand: any[] = await this.prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS c ${whereSujo}`,
    );
    const candidatos = Number(cand?.[0]?.c || 0);
    const amostra: any[] = await this.prisma.$queryRawUnsafe(
      `SELECT p.codigo, p.ref, p."dataAlt"::text AS nativa_suja, w."dataAlt"::text AS espelho_correto
       ${whereSujo}
       ORDER BY p.codigo
       LIMIT 10`,
    );
    if (!executar) return { dryRun: true, candidatos, amostra };
    const atualizados: number = await this.prisma.$executeRawUnsafe(
      `UPDATE product p
          SET "dataAlt" = w."dataAlt"
         FROM wincred_produtos w
        WHERE w.codigo = p.codigo
          AND p."dataAlt" IS NOT NULL
          AND p."dataAlt" >= DATE '2026-07-13'
          AND w."dataAlt" IS NOT NULL
          AND w."dataAlt" < DATE '2026-07-13'`,
    );
    this.logger.log(`[dataalt] nativa ← espelho: ${atualizados} linhas corrigidas`);
    return { dryRun: false, atualizados };
  }

  /**
   * RESTAURAR A DATA DE CADASTRO POR EVIDÊNCIA (Black Friday, 26/11/2026).
   *
   * "Muitos itens estão com data de 2026 e são mais antigos." A data de
   * cadastro é a `dataAlt` de `wincred_produtos` — no ERP ela chamava DATAALT
   * ("data de alteração") e era carimbada com a data da EDIÇÃO: mexeu no
   * preço em março/2026, a peça de 2023 virou "cadastrada em 2026". O editor
   * do Flow parou de fazer isso em 14/07, mas o que o ERP carimbou antes de
   * morrer (e o que escapou da restauração daquele incidente) continua lá.
   *
   * Ninguém tem a data original — o ERP só tinha essa coluna. O que existe
   * é PROVA de que a peça é mais velha do que a data diz, e cada prova dá um
   * TETO pra data de cadastro (a peça nasceu NO MÁXIMO naquele dia):
   *
   *  - `venda`   — a peça VENDEU antes da data gravada (`giga_caixa_mov`, o
   *                histórico do caixa do ERP + do Flow). Fato: quem vendeu em
   *                2024 foi cadastrada em 2024 ou antes. A data vira a da
   *                PRIMEIRA venda — mais nova que o cadastro real, mas
   *                verdadeira, e mais velha que o carimbo errado.
   *  - `id`      — `idWincred` é o auto-incremento da tabela `produtos` do
   *                Wincred: nasce na hora do cadastro e nunca muda com edição.
   *                Se uma peça de ID MAIOR tem data plausível ≤ corte, esta
   *                (de ID menor) nasceu antes dela. O teto é a MENOR data
   *                plausível entre as 200 linhas seguintes na ordem do ID
   *                (janela curta pra um lixo isolado não contaminar tudo).
   *                Vale só pra peça que nasceu no ERP (as do Flow não têm ID).
   *  - `familia` — outra numeração/cor da MESMA REF tem data ≤ corte. NÃO é
   *                teto (numeração nova de modelo antigo é cadastro novo de
   *                verdade) — por isso só entra quando pedida.
   *
   * Prioridade: a MENOR data entre `venda` e `id` (o teto mais apertado);
   * `familia` só quando as duas faltam. Só desce a data, nunca sobe. Só
   * peça COM ESTOQUE na rede e data DEPOIS do corte entra na conta (é o que
   * a campanha enxerga; peça sem estoque não vende e pode ser corrigida
   * depois, pela tela). Dry-run por padrão: devolve contagens, a conferência
   * da ordem do ID e uma amostra. `executar: true` grava nas DUAS tabelas
   * (`wincred_produtos` e `product`) com ANTES→DEPOIS em `product_edit_audit`
   * (campo `DATA_CADASTRO`, um `batchId` por rodada) e derruba o cache do site.
   */
  async restaurarDataCadastro(input: {
    executar: boolean;
    corte?: string | null;
    criterios?: string[] | null;
    userName?: string | null;
    amostra?: number | null;
  }) {
    const corte = diaISO(input.corte ?? '2025-12-31');
    if (!corte) throw new BadRequestException('Corte inválido — use AAAA-MM-DD (ex.: 2025-12-31).');
    const pedidos = (input.criterios && input.criterios.length ? input.criterios : ['venda', 'id']).map((c) => String(c).toLowerCase());
    const desconhecidos = pedidos.filter((c) => !['venda', 'id', 'familia'].includes(c));
    if (desconhecidos.length) throw new BadRequestException(`Critério desconhecido: ${desconhecidos.join(', ')} (vale venda, id, familia).`);
    const usa = { venda: pedidos.includes('venda'), id: pedidos.includes('id'), familia: pedidos.includes('familia') };
    const amostra = Math.min(Math.max(Number(input.amostra) || 30, 1), 200);
    // Data "plausível": antes disto é lixo de migração (ano 1900, 2001-01-01…).
    const PISO = '2005-01-01';
    const batchId = randomUUID();
    const t0 = Date.now();

    // BigInt (idWincred) e Date não passam no JSON da resposta — achata.
    const plain = (v: any): any => {
      if (typeof v === 'bigint') return Number(v);
      if (v instanceof Date) return diaISO(v);
      if (Array.isArray(v)) return v.map(plain);
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
      return v;
    };
    const sqlBool = (b: boolean) => (b ? 'TRUE' : 'FALSE');

    const resultado = await this.prisma.$transaction(
      async (tx) => {
        const q = (sql: string, ...params: any[]): Promise<any[]> => (tx as any).$queryRawUnsafe(sql, ...params);
        const x = (sql: string, ...params: any[]): Promise<number> => (tx as any).$executeRawUnsafe(sql, ...params);

        // 1) Candidatas: com estoque na rede e data DEPOIS do corte.
        await x(
          `CREATE TEMP TABLE dc_cand ON COMMIT DROP AS
           SELECT w.codigo,
                  UPPER(TRIM(COALESCE(w.ref, ''))) AS ref,
                  w."dataAlt"   AS atual,
                  w."idWincred" AS id,
                  e.estoque
             FROM wincred_produtos w
             JOIN (SELECT codigo, SUM(COALESCE(estoque, 0))::int AS estoque
                     FROM wincred_estoque GROUP BY codigo
                   HAVING SUM(COALESCE(estoque, 0)) > 0) e ON e.codigo = w.codigo
            WHERE w."dataAlt" IS NOT NULL AND w."dataAlt" > $1::date`,
          corte,
        );
        await x(`CREATE INDEX ON dc_cand (codigo)`);

        // 2) Primeira venda por código (histórico do caixa inteiro, uma passada).
        //    O código do caixa pode vir com zero à esquerda; o do espelho não.
        await x(
          `CREATE TEMP TABLE dc_pv ON COMMIT DROP AS
           SELECT LTRIM(COALESCE(m.codigo, ''), '0') AS codigo, MIN(m.data) AS primeira_venda
             FROM giga_caixa_mov m
            WHERE m.data >= $1::date
            GROUP BY 1`,
          PISO,
        );
        await x(`CREATE INDEX ON dc_pv (codigo)`);

        // 3) Teto pela ordem do ID: menor data plausível (≤ corte) nas 200
        //    linhas SEGUINTES do auto-incremento.
        await x(
          `CREATE TEMP TABLE dc_id ON COMMIT DROP AS
           SELECT codigo, id,
                  MIN(CASE WHEN "dataAlt" >= $1::date AND "dataAlt" <= $2::date THEN "dataAlt" END)
                    OVER (ORDER BY id ROWS BETWEEN 1 FOLLOWING AND 200 FOLLOWING) AS teto
             FROM (SELECT codigo, "idWincred" AS id, "dataAlt"
                     FROM wincred_produtos WHERE "idWincred" IS NOT NULL) s`,
          PISO,
          corte,
        );
        await x(`CREATE INDEX ON dc_id (codigo)`);

        // 4) Família: a data mais velha plausível da MESMA REF.
        await x(
          `CREATE TEMP TABLE dc_fam ON COMMIT DROP AS
           SELECT c.codigo, MIN(w2."dataAlt") AS familia_min
             FROM dc_cand c
             JOIN wincred_produtos w2 ON UPPER(TRIM(COALESCE(w2.ref, ''))) = c.ref
            WHERE c.ref <> '' AND w2."dataAlt" >= $1::date AND w2."dataAlt" <= $2::date
            GROUP BY c.codigo`,
          PISO,
          corte,
        );

        // 5) A decisão por código.
        await x(
          `CREATE TEMP TABLE dc_sug ON COMMIT DROP AS
           SELECT c.codigo, c.ref, c.atual, c.estoque, c.id,
                  v.primeira_venda, i.teto AS teto_id, f.familia_min,
                  LEAST(CASE WHEN ${sqlBool(usa.venda)} AND v.primeira_venda < c.atual THEN v.primeira_venda END,
                        CASE WHEN ${sqlBool(usa.id)}    AND i.teto < c.atual          THEN i.teto END) AS teto,
                  CASE WHEN ${sqlBool(usa.familia)} AND f.familia_min < c.atual THEN f.familia_min END AS pela_familia
             FROM dc_cand c
             LEFT JOIN dc_pv  v ON v.codigo = c.codigo
             LEFT JOIN dc_id  i ON i.codigo = c.codigo
             LEFT JOIN dc_fam f ON f.codigo = c.codigo`,
        );
        await x(`ALTER TABLE dc_sug ADD COLUMN sugerida date, ADD COLUMN criterio text`);
        await x(
          `UPDATE dc_sug SET
             sugerida = COALESCE(teto, pela_familia),
             criterio = CASE WHEN teto IS NOT NULL AND teto = primeira_venda THEN 'venda'
                             WHEN teto IS NOT NULL THEN 'id'
                             WHEN pela_familia IS NOT NULL THEN 'familia' END`,
        );

        // ── Contagens ──
        const [tot] = await q(
          `SELECT COUNT(*)::int AS codigos, COALESCE(SUM(estoque), 0)::int AS pecas FROM dc_cand`,
        );
        const porCriterio = await q(
          `SELECT COALESCE(criterio, 'sem_prova') AS criterio,
                  COUNT(*)::int AS codigos, COALESCE(SUM(estoque), 0)::int AS pecas,
                  COUNT(*) FILTER (WHERE sugerida <= $1::date)::int AS codigos_entram,
                  COALESCE(SUM(estoque) FILTER (WHERE sugerida <= $1::date), 0)::int AS pecas_entram
             FROM dc_sug GROUP BY 1 ORDER BY 1`,
          corte,
        );
        // O que cada critério NÃO pedido acrescentaria (pra decidir com número).
        const [extra] = await q(
          `SELECT COUNT(*) FILTER (WHERE sugerida IS NULL AND primeira_venda IS NOT NULL AND primeira_venda < atual)::int AS venda_codigos,
                  COALESCE(SUM(estoque) FILTER (WHERE sugerida IS NULL AND primeira_venda IS NOT NULL AND primeira_venda < atual), 0)::int AS venda_pecas,
                  COUNT(*) FILTER (WHERE sugerida IS NULL AND teto_id IS NOT NULL)::int AS id_codigos,
                  COALESCE(SUM(estoque) FILTER (WHERE sugerida IS NULL AND teto_id IS NOT NULL), 0)::int AS id_pecas,
                  COUNT(*) FILTER (WHERE sugerida IS NULL AND familia_min IS NOT NULL)::int AS familia_codigos,
                  COALESCE(SUM(estoque) FILTER (WHERE sugerida IS NULL AND familia_min IS NOT NULL), 0)::int AS familia_pecas,
                  COUNT(*) FILTER (WHERE primeira_venda IS NOT NULL AND teto_id IS NOT NULL AND teto_id < primeira_venda)::int AS id_mais_apertado_que_venda,
                  COUNT(*) FILTER (WHERE primeira_venda IS NOT NULL AND teto_id IS NOT NULL)::int AS com_venda_e_id
             FROM dc_sug`,
        );
        // Até onde vai o histórico do caixa (a prova `venda` só alcança isto).
        const [caixa] = await q(
          `SELECT MIN(data) AS primeira_data, COUNT(*)::int AS codigos FROM dc_pv`,
        );
        // A ordem do ID é mesmo a ordem do cadastro? Se for, a mediana da
        // primeira venda SOBE a cada decil do ID.
        const ordemDoId = await q(
          `SELECT dec, COUNT(*)::int AS codigos, MIN(id) AS id_min, MAX(id) AS id_max,
                  percentile_disc(0.5) WITHIN GROUP (ORDER BY pv) AS primeira_venda_mediana
             FROM (SELECT w."idWincred" AS id, p.primeira_venda AS pv,
                          NTILE(10) OVER (ORDER BY w."idWincred") AS dec
                     FROM wincred_produtos w JOIN dc_pv p ON p.codigo = w.codigo
                    WHERE w."idWincred" IS NOT NULL) s
            GROUP BY dec ORDER BY dec`,
        );
        const amostraRows = await q(
          `SELECT codigo, ref, atual, sugerida, criterio, primeira_venda, teto_id, familia_min, estoque, id
             FROM dc_sug WHERE sugerida IS NOT NULL ORDER BY estoque DESC, codigo LIMIT ${amostra}`,
        );
        const semProvaRows = await q(
          `SELECT codigo, ref, atual, estoque, id, primeira_venda, familia_min
             FROM dc_sug WHERE sugerida IS NULL ORDER BY estoque DESC, codigo LIMIT ${Math.min(amostra, 30)}`,
        );

        let gravacao: any = null;
        if (input.executar) {
          const auditadas = await x(
            `INSERT INTO product_edit_audit (id, batch_id, codigo, ref, field, old_value, new_value, user_name, applied, created_at)
             SELECT gen_random_uuid()::text, $1, codigo, NULLIF(ref, ''), 'DATA_CADASTRO',
                    atual::text, sugerida::text || ' (' || criterio || ')', $2, TRUE, now()
               FROM dc_sug WHERE sugerida IS NOT NULL AND sugerida < atual`,
            batchId,
            input.userName || 'restaurar-data-cadastro',
          );
          const espelho = await x(
            `UPDATE wincred_produtos w SET "dataAlt" = s.sugerida
               FROM dc_sug s
              WHERE w.codigo = s.codigo AND s.sugerida IS NOT NULL AND s.sugerida < w."dataAlt"`,
          );
          const nativa = await x(
            `UPDATE product p
                SET "dataAlt" = s.sugerida, flow_is_source = TRUE, edited_at = now(), updated_at = now()
               FROM dc_sug s
              WHERE p.codigo = s.codigo AND s.sugerida IS NOT NULL
                AND (p."dataAlt" IS NULL OR s.sugerida < p."dataAlt")`,
          );
          gravacao = { batchId, auditadas, espelho, nativa };
        }

        return {
          dryRun: !input.executar,
          corte,
          criterios: pedidos,
          piso: PISO,
          candidatas: tot,
          porCriterio,
          acrescentariam: extra,
          historicoCaixa: caixa,
          ordemDoId,
          amostra: amostraRows,
          semProva: semProvaRows,
          gravacao,
          ms: Date.now() - t0,
        };
      },
      { timeout: 10 * 60_000, maxWait: 15_000 },
    );

    const r = plain(resultado);
    if (input.executar) {
      this.logger.log(
        `[data-cadastro] restauração ${r.gravacao?.batchId}: ${r.gravacao?.espelho} no espelho, ` +
          `${r.gravacao?.nativa} na nativa, ${r.gravacao?.auditadas} auditadas · corte ${corte} · ` +
          `critérios ${pedidos.join('+')} · ${r.ms}ms · por ${input.userName || '?'}`,
      );
      // A campanha do site decide pela data: a vitrine tem que remontar.
      this.avisarSite();
    } else {
      this.logger.log(`[data-cadastro] prévia: ${r.candidatas?.codigos} candidatas · ${r.ms}ms`);
    }
    return r;
  }

  /**
   * MOVIMENTAÇÃO MANUAL de estoque (tela do editor, 15/07): entrada/saída com
   * loja + quantidade + MOTIVO obrigatório. Flow é a fonte (erp.increase/
   * decreaseStock já aplicam o delta no espelho primeiro e replicam pro Giga
   * inline/outbox). Tudo auditado em product_edit_audit.
   */
  async movimentarEstoque(input: {
    movimentos: Array<{ codigo: string; loja: string; qtd: number; tipo: 'entrada' | 'saida'; motivo: string }>;
    userName?: string | null;
  }) {
    const movs = (input.movimentos || [])
      .map((m) => ({
        codigo: this.normalizeCodigo(String(m?.codigo || '')) || '',
        loja: String(m?.loja || '').trim().padStart(2, '0'),
        qtd: Math.floor(Math.abs(Number(m?.qtd) || 0)),
        tipo: m?.tipo === 'saida' ? 'saida' as const : 'entrada' as const,
        motivo: String(m?.motivo || '').trim().slice(0, 60),
      }))
      .filter((m) => m.codigo && m.loja && m.qtd > 0);
    if (!movs.length) throw new BadRequestException('Nenhum movimento válido');
    if (movs.length > 200) throw new BadRequestException('Máximo de 200 movimentos por vez');
    if (movs.some((m) => !m.motivo)) throw new BadRequestException('Motivo é obrigatório em todo movimento');

    const batchId = randomUUID();
    const resultados: Array<{ codigo: string; loja: string; tipo: string; qtd: number; antes: number | null; depois: number | null; ok: boolean; erro?: string }> = [];

    const entradas = movs.filter((m) => m.tipo === 'entrada').map((m) => ({ sku: m.codigo, qty: m.qtd, storeCode: m.loja }));
    const saidas = movs.filter((m) => m.tipo === 'saida').map((m) => ({ sku: m.codigo, qty: m.qtd, storeCode: m.loja }));

    const aplicadoPorChave = new Map<string, { previousStock: number; newStock: number }>();
    let erroGeral: string | null = null;
    try {
      if (entradas.length) {
        const r = await this.erp.increaseStock(entradas);
        for (const a of r.applied || []) aplicadoPorChave.set(`entrada|${this.normalizeCodigo(a.sku)}|${String(a.storeCode).padStart(2, '0')}`, a);
        if (!r.success) erroGeral = r.error || 'falha na entrada';
      }
      if (saidas.length) {
        const r = await this.erp.decreaseStock(saidas, { allowNegative: false });
        for (const a of r.applied || []) aplicadoPorChave.set(`saida|${this.normalizeCodigo(a.sku)}|${String(a.storeCode).padStart(2, '0')}`, a);
        if (!r.success) erroGeral = erroGeral || r.error || 'falha na saída';
      }
    } catch (e) {
      erroGeral = (e as Error).message;
    }

    for (const m of movs) {
      const ap = aplicadoPorChave.get(`${m.tipo}|${m.codigo}|${m.loja}`);
      resultados.push({
        codigo: m.codigo, loja: m.loja, tipo: m.tipo, qtd: m.qtd,
        antes: ap ? ap.previousStock : null,
        depois: ap ? ap.newStock : null,
        ok: !!ap,
        erro: ap ? undefined : (erroGeral || 'não aplicado'),
      });
    }

    await (this.prisma as any).productEditAudit.createMany({
      data: movs.map((m) => {
        const ap = aplicadoPorChave.get(`${m.tipo}|${m.codigo}|${m.loja}`);
        return {
          batchId,
          codigo: m.codigo,
          ref: null,
          field: m.tipo === 'entrada' ? 'ESTOQUE_ENTRADA' : 'ESTOQUE_SAIDA',
          oldValue: ap ? `loja ${m.loja}: ${ap.previousStock}` : `loja ${m.loja}`,
          newValue: `${ap ? ap.newStock : '?'} (${m.tipo} ${m.qtd} — ${m.motivo})`,
          userName: input.userName || null,
          applied: !!ap,
        };
      }),
    }).catch(() => null);

    /**
     * O ajuste manual entra TAMBÉM em `stock_movements` (21/08).
     *
     * Antes ele vivia só em `productEditAudit`, enquanto `stock_movements`
     * recebia venda, conferência e sync. Nenhuma das duas era o histórico
     * completo da peça, e a aba Histórico da ficha nasceria mostrando meia
     * verdade — justamente sem os ajustes que a própria tela cria.
     *
     * Só entra o que foi APLICADO de fato: `qtyBefore/qtyAfter` vêm do
     * resultado do ERP, não do que a tela pediu. Movimento que falhou fica na
     * auditoria com `applied: false` e não polui o histórico de estoque.
     *
     * Não propaga erro: histórico que derruba a operação é pior que histórico
     * incompleto — mesma postura da telemetria.
     */
    const paraHistorico = movs.flatMap((m) => {
      const ap = aplicadoPorChave.get(`${m.tipo}|${m.codigo}|${m.loja}`);
      if (!ap) return [];
      return [{
        storeCode: m.loja,
        sku: m.codigo,
        delta: m.tipo === 'entrada' ? m.qtd : -m.qtd,
        qtyBefore: ap.previousStock,
        qtyAfter: ap.newStock,
        reason: 'ajuste_manual',
        refId: batchId,
        note: m.motivo,
        userId: input.userName || null,
      }];
    });
    if (paraHistorico.length) {
      await (this.prisma as any).stockMovement
        .createMany({ data: paraHistorico })
        .catch((e: any) =>
          this.logger.warn(`[editor] histórico de estoque não gravou: ${e?.message || e}`),
        );
    }

    const aplicados = resultados.filter((r) => r.ok).length;
    this.logger.log(`[editor] movimentação: ${aplicados}/${movs.length} aplicado(s) (por ${input.userName || '?'})`);
    return { ok: aplicados > 0, aplicados, total: movs.length, resultados, batchId };
  }

  /**
   * TROCAR O CÓDIGO (SKU) de uma variação — pedido do dono em 01/10/2026
   * ("deixe editável o SKU"). A tela dizia "SKU nunca muda" porque o código é
   * a CHAVE de tudo: cadastro, estoque por loja, venda, marcado, card de
   * separação, inventário… Trocar só no cadastro deixaria o estoque e o
   * histórico órfãos (peça "some" da Consulta e do site, venda antiga aponta
   * pra código que não existe). Então a troca é UMA transação que reescreve
   * TODAS as tabelas que carregam o código — cadastro, estoque e histórico —
   * e, se nada falhar, commita tudo junto.
   *
   * Regras:
   * - o código novo NÃO pode existir em nenhuma tabela de cadastro/estoque
   *   (seria fundir duas peças: estoque somado, histórico misturado);
   * - normalização do catálogo (só dígitos perdem zeros à esquerda), teto de
   *   14 caracteres (coluna), só letras/números/hífen;
   * - se o código antigo tem cara de código de barras (8+ dígitos) e a peça
   *   não tem `ean`, o antigo vira o `ean` — a etiqueta que já está na peça
   *   continua bipando (caso 7891186984207 → código da família 5397xxx);
   * - `executar=false` é a PRÉVIA: devolve quantas linhas cada tabela vai
   *   reescrever, sem gravar. A tela mostra isso antes do confirmar.
   *
   * Auditoria: linha `CODIGO` ANTES→DEPOIS no `product_edit_audit`, gravada
   * já sob o código NOVO (as linhas antigas migram junto, pro histórico da
   * peça seguir inteiro).
   */
  async trocarCodigo(input: { de: string; para: string; executar: boolean; userName?: string | null }) {
    const de = this.normalizeCodigo(input.de);
    const paraRaw = String(input.para ?? '').trim().toUpperCase();
    const para = this.normalizeCodigo(paraRaw);
    if (!de) throw new BadRequestException('Código atual não informado');
    if (!para) throw new BadRequestException('Informe o código novo');
    if (!/^[A-Z0-9-]{1,14}$/.test(para)) {
      throw new BadRequestException('Código novo: só letras, números e hífen, até 14 caracteres');
    }
    if (para === de) throw new BadRequestException('O código novo é igual ao atual');

    const p: any = this.prisma;
    const [nativo, espelho] = await Promise.all([
      p.product.findUnique({ where: { codigo: de } }),
      p.wincredProduto.findUnique({ where: { codigo: de } }),
    ]);
    if (!nativo && !espelho) throw new BadRequestException(`Código ${de} não existe no cadastro`);

    // Colisão: o novo não pode existir em NENHUMA tabela de cadastro/estoque.
    const colisao = await Promise.all([
      p.product.count({ where: { codigo: para } }),
      p.wincredProduto.count({ where: { codigo: para } }),
      p.gigaProduto.count({ where: { codigo: para } }),
      p.gigaEstoque.count({ where: { codigo: para } }),
      p.wincredEstoque.count({ where: { codigo: para } }),
      p.stock.count({ where: { sku: para } }),
    ]);
    if (colisao.some((n) => n > 0)) {
      throw new BadRequestException(
        `Código ${para} já existe no cadastro ou no estoque — trocar fundiria duas peças. Escolha outro.`,
      );
    }

    // Tudo que carrega o código, com o nome da coluna em cada tabela.
    // [model, coluna, rótulo pra tela]
    const TABELAS: Array<[string, string, string]> = [
      ['product', 'codigo', 'cadastro (product)'],
      ['wincredProduto', 'codigo', 'cadastro (espelho)'],
      ['gigaProduto', 'codigo', 'cadastro (giga_produto)'],
      ['gigaEstoque', 'codigo', 'estoque por loja (giga_estoque)'],
      ['wincredEstoque', 'codigo', 'estoque por loja (wincred_estoque)'],
      ['stock', 'sku', 'estoque (stock)'],
      ['stockMovement', 'sku', 'movimentos de estoque'],
      ['pdvSaleItem', 'sku', 'itens de venda do PDV'],
      ['pdvReturnItem', 'sku', 'itens de devolução'],
      ['pdvReturn', 'manualSku', 'devoluções (peça digitada)'],
      ['orderItem', 'sku', 'itens de pedido do site'],
      ['orderItemSwap', 'oldSku', 'trocas de item (peça antiga)'],
      ['orderItemSwap', 'newSku', 'trocas de item (peça nova)'],
      ['marcado', 'sku', 'marcados'],
      ['pickOrderScan', 'sku', 'bipes de separação'],
      ['pickOrderItemReport', 'sku', 'reportes de separação'],
      ['pecaExtraviada', 'sku', 'peças extraviadas'],
      ['interStoreObligation', 'sku', 'acertos entre lojas'],
      ['livePdvItem', 'codigoBipado', 'itens da live'],
      ['transferOrder', 'codigoBipado', 'transferências'],
      ['trocaItem', 'sku', 'itens de troca'],
      ['trocaSolicitacao', 'novaSku', 'solicitações de troca'],
      ['defectItem', 'sku', 'defeitos'],
      ['supplyItem', 'sku', 'itens de suprimento'],
      ['wcReturnRequestItem', 'sku', 'devoluções do site'],
      ['inventarioEsperado', 'sku', 'inventário (esperado)'],
      ['inventarioBipe', 'sku', 'inventário (bipes)'],
      ['inventarioAjuste', 'sku', 'inventário (ajustes)'],
      ['gigaTransferenciaItem', 'codigo', 'transferências (histórico)'],
      ['gigaCaixaMov', 'codigo', 'caixa (espelho do financeiro)'],
      ['productEditAudit', 'codigo', 'auditoria do editor'],
    ];

    // Prévia: conta linha a linha. Vazio e quebrado têm caras diferentes —
    // erro de contagem SOBE.
    const previa: Array<{ tabela: string; linhas: number }> = [];
    for (const [model, col, rotulo] of TABELAS) {
      const n: number = await p[model].count({ where: { [col]: de } });
      if (n > 0) previa.push({ tabela: rotulo, linhas: n });
    }
    const totalLinhas = previa.reduce((s, x) => s + x.linhas, 0);

    const eanAtual = String(nativo?.ean ?? espelho?.ean ?? '').trim();
    const guardarComoEan = /^\d{8,}$/.test(de) && !eanAtual;

    const peca = {
      codigo: de,
      ref: String(nativo?.ref ?? espelho?.ref ?? '').trim(),
      cor: String(nativo?.cor ?? espelho?.cor ?? '').trim(),
      tamanho: String(nativo?.tamanho ?? espelho?.tamanho ?? '').trim(),
      descricao: String(nativo?.descricaoCompleta ?? espelho?.descricaoCompleta ?? '').trim(),
    };

    if (!input.executar) {
      return { ok: true, previa: true, de, para, peca, tabelas: previa, totalLinhas, guardarComoEan };
    }

    const batchId = randomUUID();
    const resultado: Array<{ tabela: string; linhas: number }> = [];
    await p.$transaction(async (tx: any) => {
      for (const [model, col, rotulo] of TABELAS) {
        const r = await tx[model].updateMany({ where: { [col]: de }, data: { [col]: para } });
        const n = Number(r.count) || 0;
        if (n > 0) resultado.push({ tabela: rotulo, linhas: n });
      }
      if (guardarComoEan) {
        await tx.product.updateMany({ where: { codigo: para }, data: { ean: de } });
        await tx.wincredProduto.updateMany({ where: { codigo: para }, data: { ean: de } });
      }
      if (nativo) {
        await tx.product.update({ where: { codigo: para }, data: { flowIsSource: true, editedAt: new Date() } });
      }
      await tx.productEditAudit.create({
        data: {
          batchId,
          codigo: para,
          ref: peca.ref || null,
          field: 'CODIGO',
          oldValue: de,
          newValue: para,
          userName: input.userName || null,
          applied: true,
        },
      });
    });

    this.logger.log(
      `[editor-produtos] CODIGO ${de} → ${para} por ${input.userName || '?'}: ` +
      `${resultado.reduce((s, x) => s + x.linhas, 0)} linha(s) em ${resultado.length} tabela(s)` +
      (guardarComoEan ? ` (antigo guardado como EAN)` : ''),
    );
    this.avisarSite();
    return { ok: true, previa: false, de, para, peca, tabelas: resultado, totalLinhas, guardarComoEan, batchId };
  }

  /** Últimos lotes de auditoria (tela mostra o histórico recente). */
  async auditRecent(limit = 200) {
    return (this.prisma as any).productEditAudit.findMany({
      orderBy: { createdAt: 'desc' },
      take: Math.min(500, Math.max(1, limit)),
    });
  }
}
