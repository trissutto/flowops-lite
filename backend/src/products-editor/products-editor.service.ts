import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';
import { ProductSearchService } from '../product-search/product-search.service';
import { LojaCatalogService } from '../loja-catalog/loja-catalog.service';
import { avisarVitrine } from '../common/avisar-vitrine';

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
};

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
    try {
      const norm = codigos.map((c) => this.normalizeCodigo(c)).filter(Boolean) as string[];
      if (norm.length) {
        const wrows: any[] = await (this.prisma as any).wincredProduto.findMany({
          where: { codigo: { in: norm } },
          select: { codigo: true, custo: true, margem: true },
        });
        const byNorm = new Map(wrows.map((w) => [w.codigo, w]));
        for (const c of codigos) {
          const w = byNorm.get(this.normalizeCodigo(c) as string);
          if (w) {
            custoPorCodigo.set(c, {
              custo: w.custo != null ? Number(w.custo) : null,
              margem: w.margem != null ? Number(w.margem) : null,
            });
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
            `${field.toUpperCase()} "${String(v).trim().slice(0, 30)}…" passa do limite do Giga (${max} caracteres)`,
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
    }

    // ── Valores atuais (espelho) pra auditoria ANTES→DEPOIS ──
    const codigos = edits.map((e) => e.codigo);
    const atuais: any[] = await (this.prisma as any).gigaProduto.findMany({
      where: { codigo: { in: codigos } },
    });
    const atualPorCodigo = new Map(atuais.map((a) => [String(a.codigo).trim(), a]));

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
        if (g.set.ref !== undefined) gp.ref = g.set.ref;
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
      throw new BadRequestException(`MARCA passa do limite do Giga (${LIMITS.marca} caracteres)`);
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

  /** Últimos lotes de auditoria (tela mostra o histórico recente). */
  async auditRecent(limit = 200) {
    return (this.prisma as any).productEditAudit.findMany({
      orderBy: { createdAt: 'desc' },
      take: Math.min(500, Math.max(1, limit)),
    });
  }
}
