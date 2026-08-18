import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * VENDAS POR PRODUTO (REF + COR) — o relatório que o dono pediu em 18/08/2026.
 *
 * ── POR QUE EXISTIA UM BURACO ──
 *
 * O sistema já mostrava "top produtos" em duas telas, mas as duas liam SÓ o
 * caixa do ERP antigo (`giga_caixa_mov`) — sem o PDV do Flow, sem o site, e
 * **sem descontar a réplica**. Medido na produção em 18/08, só em 2026:
 *
 *   · caixa antigo, venda de verdade ......... 59.312 linhas
 *   · caixa antigo, RÉPLICA do PDV do Flow ... 19.982 linhas / 20.198 peças
 *   · PDV do Flow ........................... 20.047 linhas / 20.261 peças
 *
 * As duas últimas são a MESMA venda: enquanto os sistemas conviveram, o outbox
 * do PDV replicava tudo no caixa. Somar sem filtrar dobra ~20 mil peças no ano.
 * O que separa é `obs_pedido LIKE 'flowops%'`, e é por isso que este serviço
 * nasce com a regra dentro, e não como mais um SELECT solto.
 *
 * ── AS QUATRO FONTES ──
 *
 *   1. `giga_caixa_mov`  — histórico do ERP antigo (jan/25 → ago/26)
 *   2. `pdv_sale_items`  — PDV do Flow (finalizada, fora do treino, sem MARCADO)
 *   3. `pdv_return_items`— devolução, entra NEGATIVA (decisão do dono: abate)
 *   4. `order_items`     — site e live, só quando **paga** (`paid_at`), não cancelada
 *
 * ── O QUE MEDI ANTES DE ESCREVER (produção, 18/08) ──
 *
 *   · 96,9% das linhas do caixa antigo casam com o cadastro pelo código NU
 *     (78.575 de 81.079 em 2026). Tirar o zero à esquerda muda 4 linhas: o
 *     `giga_caixa_mov` já chega normalizado, então NÃO precisa de LTRIM.
 *   · 97,7% das linhas casadas têm COR — a quebra por cor que ele pediu se
 *     sustenta no histórico, não só no PDV novo.
 *   · Só 75,9% têm MARCA. O filtro por marca é honesto, mas quem não tem marca
 *     no cadastro cai no balde "(sem marca)" em vez de sumir da lista.
 */

export interface FiltroVendasProduto {
  /** YYYY-MM-DD. Vazio = desde sempre (o padrão que o dono pediu). */
  de?: string;
  ate?: string;
  /** Código da loja física, ou `SITE` pro canal online (site + live). */
  loja?: string;
  marca?: string;
  /** Texto livre: REF, pedaco da descricao ou cor. */
  busca?: string;
  /** REFs que a busca resolveu — o motor de busca é o mesmo da tela Consultar. */
  refs?: string[];
  ordenar?: 'pecas' | 'valor' | 'ultima';
  page?: number;
  perPage?: number;
}

type LinhaCrua = {
  ref: string;
  cor: string;
  nome: string | null;
  marca: string | null;
  pecas: number;
  devolvidas: number;
  valor: number;
  primeira: Date | null;
  ultima: Date | null;
};

@Injectable()
export class VendasProdutoService {
  private readonly logger = new Logger(VendasProdutoService.name);

  /** Teto de linhas agregadas. Acima disso a tela avisa em vez de mentir. */
  private static readonly TETO = 5000;

  /**
   * REFs QUE NÃO SÃO PRODUTO — o PDV usa como linha de serviço/ajuste.
   *
   * Achado com a tela já no ar (dono, 18/08: "o que é este MANUAL?"). Medido
   * em 2026:
   *
   *   · MANUAL  — 415 linhas, **−R$ 24.343**. É o item digitado à mão. A loja
   *     registra TROCA assim: a peça devolvida entra como linha NEGATIVA pra
   *     venda fechar em zero ("Troca cliente Fulana Jaqueta jeans ref 15315
   *     tam 52", −419,90, pagamento `troca_par`, venda total 0). São 248
   *     linhas negativas contra 167 positivas.
   *   · FRETE   — 113 linhas. O relatório dizia "vendeu 113 peças de FRETE".
   *   · MARCADO — 12 linhas. Marcado não é venda em lugar nenhum do sistema.
   *
   * Ficavam no topo da lista e ainda puxavam o VALOR do período pro negativo.
   * Some daqui, não da venda: o caixa continua fechando com elas.
   */
  private static readonly NAO_E_PRODUTO = ['MANUAL', 'FRETE', 'MARCADO'];

  constructor(private readonly prisma: PrismaService) {}

  /**
   * A UNIÃO DAS QUATRO FONTES, já com as exclusões.
   *
   * Os parâmetros entram posicionados (`$1`…) e nunca concatenados: este SQL é
   * montado por string, e string com valor do usuário dentro é injeção.
   *
   * `$1` de · `$2` ate · `$3` loja · `$4` só-site · `$5` refs (array)
   */
  private sqlUniao(comTamanho = false): string {
    // Recortes que se repetem nas quatro fontes. `$1`/`$2` nulos = desde sempre.
    const janela = (col: string) => `($1::date IS NULL OR ${col} >= $1::date)
        AND ($2::date IS NULL OR ${col} <= $2::date)`;
    const porRef = (col: string) => `($5::text[] IS NULL OR ${col} = ANY($5::text[]))`;

    /**
     * O TAMANHO só entra como chave quando a grade é pedida. Fora dela ele nem
     * é lido: agrupar por algo que a tela não mostra multiplicaria as linhas do
     * relatório por 9 (a grade da casa vai do 44 ao 60) e o teto de 5.000
     * estouraria com um punhado de peças.
     */
    const tam = (expr: string) => (comTamanho ? expr : `''`);
    const grupo = comTamanho ? 'GROUP BY 1, 2, 3' : 'GROUP BY 1, 2';

    return `
      -- 1) HISTORICO DO ERP ANTIGO.
      --
      -- obs_pedido LIKE 'flowops%' e a REPLICA do PDV do Flow: a mesma venda
      -- gravada nos dois sistemas enquanto conviveram. Sem este NOT LIKE, todo
      -- o periodo de convivencia conta em dobro (20.198 pecas so em 2026).
      --
      -- As aspas em "descricaoCompleta" nao sao enfeite: a tabela do espelho
      -- tem coluna em camelCase, e sem aspas o Postgres procura minuscula.
      SELECT UPPER(TRIM(w.ref)) AS ref,
             UPPER(TRIM(COALESCE(w.cor, ''))) AS cor,
             ${tam(`UPPER(TRIM(COALESCE(w.tamanho, '')))`)} AS tamanho,
             MAX(COALESCE(w."descricaoCompleta", w."descricaoPdv")) AS nome,
             MAX(NULLIF(TRIM(COALESCE(w.marca, '')), '')) AS marca,
             SUM(COALESCE(m.quantidade, 0))::numeric AS pecas,
             0::numeric AS devolvidas,
             SUM(COALESCE(m.valor_total, m.valor, 0))::numeric AS valor,
             MIN(m.data)::date AS primeira,
             MAX(m.data)::date AS ultima
        FROM giga_caixa_mov m
        JOIN wincred_produtos w ON w.codigo = TRIM(m.codigo)
       WHERE COALESCE(m.obs_pedido, '') NOT LIKE 'flowops%'
         AND (m.marcado IS NULL OR TRIM(m.marcado) = '')
         AND ${janela('m.data')}
         AND ($3::text IS NULL OR TRIM(m.loja) = $3::text)
         AND $4::boolean IS NOT TRUE
         AND ${porRef('UPPER(TRIM(w.ref))')}
       ${grupo}

      UNION ALL

      -- 2) PDV DO FLOW. A REF e a cor vêm na própria linha da venda; o cadastro
      -- entra só pra completar marca/descrição quando o item foi gravado cru.
      SELECT UPPER(TRIM(COALESCE(i.ref, w.ref))),
             UPPER(TRIM(COALESCE(i.cor, w.cor, ''))),
             ${tam(`UPPER(TRIM(COALESCE(i.tamanho, w.tamanho, '')))`)},
             MAX(COALESCE(i.descricao, w."descricaoCompleta", w."descricaoPdv")),
             MAX(NULLIF(TRIM(COALESCE(w.marca, '')), '')),
             SUM(i.qty)::numeric,
             0::numeric,
             SUM(i.qty * i.preco_unit)::numeric,
             MIN(s.finalized_at)::date,
             MAX(s.finalized_at)::date
        FROM pdv_sale_items i
        JOIN pdv_sales s ON s.id = i.sale_id
        LEFT JOIN wincred_produtos w ON w.codigo = TRIM(i.sku)
       WHERE s.status = 'finalized'
         AND s.is_training = false
         AND (s.payment_method IS NULL OR s.payment_method <> 'MARCADO')
         AND ${janela('s.finalized_at')}
         AND ($3::text IS NULL OR s.store_code = $3::text)
         AND $4::boolean IS NOT TRUE
         AND ${porRef('UPPER(TRIM(COALESCE(i.ref, w.ref)))')}
       ${grupo}

      UNION ALL

      -- 3) DEVOLUÇÃO — negativa (decisão do dono: abate do que vendeu). Vai
      -- também na coluna própria: peça que volta muito é sinal de que "foi mal"
      -- mesmo tendo vendido bem.
      SELECT UPPER(TRIM(COALESCE(i.ref, w.ref))),
             UPPER(TRIM(COALESCE(i.cor, w.cor, ''))),
             ${tam(`UPPER(TRIM(COALESCE(i.tamanho, w.tamanho, '')))`)},
             MAX(COALESCE(i.descricao, w."descricaoCompleta", w."descricaoPdv")),
             MAX(NULLIF(TRIM(COALESCE(w.marca, '')), '')),
             -SUM(i.qty)::numeric,
             SUM(i.qty)::numeric,
             -SUM(i.qty * i.preco_unit)::numeric,
             NULL::date,
             NULL::date
        FROM pdv_return_items i
        JOIN pdv_returns r ON r.id = i.return_id
        LEFT JOIN wincred_produtos w ON w.codigo = TRIM(i.sku)
       WHERE ${janela('r.created_at')}
         AND ($3::text IS NULL OR r.store_code = $3::text)
         AND $4::boolean IS NOT TRUE
         AND ${porRef('UPPER(TRIM(COALESCE(i.ref, w.ref)))')}
       ${grupo}

      UNION ALL

      -- 4) SITE E LIVE. Conta pela data do PAGAMENTO (escolha do dono), não da
      -- criação: pedido criado e não pago não é venda.
      SELECT UPPER(TRIM(COALESCE(i.ref, w.ref))),
             UPPER(TRIM(COALESCE(i.cor, w.cor, ''))),
             ${tam(`UPPER(TRIM(COALESCE(i.tamanho, w.tamanho, '')))`)},
             MAX(COALESCE(i.product_name, w."descricaoCompleta", w."descricaoPdv")),
             MAX(NULLIF(TRIM(COALESCE(w.marca, '')), '')),
             SUM(i.quantity)::numeric,
             0::numeric,
             SUM(i.quantity * COALESCE(i.unit_price, 0))::numeric,
             MIN(o.paid_at)::date,
             MAX(o.paid_at)::date
        FROM order_items i
        JOIN orders o ON o.id = i.order_id
        LEFT JOIN wincred_produtos w ON w.codigo = TRIM(i.sku)
       WHERE o.paid_at IS NOT NULL
         AND o.status <> 'cancelled'
         AND ${janela('o.paid_at')}
         AND ($3::text IS NULL OR $4::boolean IS TRUE)
         AND ${porRef('UPPER(TRIM(COALESCE(i.ref, w.ref)))')}
       ${grupo}
    `;
  }

  async listar(f: FiltroVendasProduto) {
    const page = Math.max(1, Number(f.page) || 1);
    const perPage = Math.min(200, Math.max(10, Number(f.perPage) || 50));

    /**
     * `SITE` não é uma loja: o pedido do site tem loja que retira, loja que
     * vende e loja que envia, e fingir que ele pertence a uma unidade daria um
     * número que não bate com nada. Então ele é um CANAL — escolher "Site"
     * mostra só o online, e escolher uma loja física esconde o online.
     */
    const soSite = String(f.loja || '').toUpperCase() === 'SITE';
    const loja = soSite ? null : (f.loja || null) || null;
    const refs = f.refs?.length ? f.refs.map((r) => String(r).trim().toUpperCase()) : null;

    const params = [f.de || null, f.ate || null, loja, soSite, refs];

    const ordem =
      f.ordenar === 'valor' ? 'valor DESC' : f.ordenar === 'ultima' ? 'ultima DESC NULLS LAST' : 'pecas DESC';

    /**
     * A união agrupa DENTRO de cada fonte e o de fora soma os quatro pedaços —
     * é o que evita um GROUP BY sobre a união inteira (dezenas de milhares de
     * linhas cruas) só pra devolver algumas centenas.
     *
     * `(sem marca)` em vez de somem: 24% do catálogo não tem marca cadastrada
     * (medido), e esconder essas peças faria o relatório não bater com o caixa.
     */
    /**
     * BUSCA POR TEXTO — a mesma semântica da tela Consultar do PDV, que é a que
     * eles já têm no dedo: palavras em QUALQUER ORDEM (AND), pedaço de palavra
     * vale, e o termo bate em REF, nome ou cor. Teto de 6 palavras, igual lá.
     *
     * Uma diferença assumida: lá a busca roda no cadastro e traz a peça mesmo
     * sem venda; aqui ela filtra o que VENDEU, porque é um relatório de vendas.
     */
    const palavras = String(f.busca || '')
      .trim()
      .split(/\s+/)
      .filter((p) => p.length >= 2)
      .slice(0, 6);
    const filtroBusca = palavras.length
      ? 'AND ' +
        palavras
          .map(
            (_, i) =>
              `(ref ILIKE $${8 + i} OR COALESCE(nome,'') ILIKE $${8 + i} OR cor ILIKE $${8 + i})`,
          )
          .join(' AND ')
      : '';

    const sql = `
      WITH bruto AS (${this.sqlUniao()}),
      agregado AS (
        SELECT ref,
               cor,
               MAX(nome) AS nome,
               COALESCE(MAX(marca), '') AS marca,
               SUM(pecas)::int AS pecas,
               SUM(devolvidas)::int AS devolvidas,
               ROUND(SUM(valor), 2)::float8 AS valor,
               MIN(primeira) AS primeira,
               MAX(ultima) AS ultima
          FROM bruto
         WHERE ref IS NOT NULL AND ref <> ''
           -- Linha de serviço do PDV fora: ver NAO_E_PRODUTO.
           AND ref <> ALL($7::text[])
         GROUP BY ref, cor
      )
      SELECT * FROM agregado
       WHERE ($6::text IS NULL
              OR ($6::text = '(sem marca)' AND marca = '')
              OR UPPER(marca) = UPPER($6::text))
         ${filtroBusca}
       ORDER BY ${ordem}, ref
       LIMIT ${VendasProdutoService.TETO}`;

    const linhas: LinhaCrua[] = await this.prisma.$queryRawUnsafe(
      sql,
      ...params,
      f.marca || null,
      VendasProdutoService.NAO_E_PRODUTO,
      ...palavras.map((w) => `%${w}%`),
    );

    // Estoque de HOJE, por REF+COR — a coluna que decide recompra. Vem em uma
    // consulta só, sobre as REFs que a página vai mostrar.
    const daPagina = linhas.slice((page - 1) * perPage, page * perPage);
    const estoque = await this.estoquePorRefCor(daPagina.map((l) => l.ref));

    const dias = this.diasDaJanela(f.de, f.ate, linhas);

    return {
      total: linhas.length,
      limitado: linhas.length >= VendasProdutoService.TETO,
      page,
      perPage,
      totalPages: Math.max(1, Math.ceil(linhas.length / perPage)),
      resumo: {
        pecas: linhas.reduce((s, l) => s + (l.pecas || 0), 0),
        valor: Math.round(linhas.reduce((s, l) => s + (l.valor || 0), 0) * 100) / 100,
        devolvidas: linhas.reduce((s, l) => s + (l.devolvidas || 0), 0),
      },
      itens: daPagina.map((l) => {
        const pecas = Number(l.pecas) || 0;
        const brutas = pecas + (Number(l.devolvidas) || 0);
        return {
          ref: l.ref,
          cor: l.cor || null,
          nome: l.nome,
          marca: l.marca || null,
          pecas,
          devolvidas: Number(l.devolvidas) || 0,
          /** Devolução sobre o que saiu — o sinal de "vendeu mas voltou". */
          devolucaoPct: brutas > 0 ? Math.round(((Number(l.devolvidas) || 0) / brutas) * 1000) / 10 : 0,
          valor: Number(l.valor) || 0,
          precoMedio: pecas > 0 ? Math.round((Number(l.valor) / pecas) * 100) / 100 : 0,
          estoque: estoque.get(`${l.ref}|${l.cor}`) ?? 0,
          primeiraVenda: l.primeira,
          ultimaVenda: l.ultima,
          /** Ritmo: peças por mês na janela. É o que diz se vale recomprar. */
          pecasPorMes: dias > 0 ? Math.round((pecas / dias) * 30 * 10) / 10 : 0,
        };
      }),
    };
  }

  /**
   * A GRADE DE UMA PEÇA — quanto vendeu de cada TAMANHO e quanto tem hoje.
   *
   * É a cascata que abre ao clicar na linha (pedido do dono, 18/08). Ele pediu
   * as DUAS coisas juntas de propósito: vendeu 30 e tem 81 não diz nada; vendeu
   * 12 no 52 e tem ZERO no 52 diz o que comprar amanhã.
   *
   * Reusa o MESMO `sqlUniao` do relatório, só ligando o tamanho como chave —
   * uma segunda query com regra própria acabaria divergindo da linha de cima,
   * e aí a soma da grade não bateria com o total que a pessoa acabou de ler.
   */
  async grade(ref: string, cor: string, f: FiltroVendasProduto) {
    const alvoRef = String(ref || '').trim().toUpperCase();
    const alvoCor = String(cor || '').trim().toUpperCase();
    if (!alvoRef) return { tamanhos: [] };

    const soSite = String(f.loja || '').toUpperCase() === 'SITE';
    const loja = soSite ? null : (f.loja || null) || null;
    // A REF entra no `$5` pra união já nascer estreita: sem isso o Postgres
    // agregaria o catálogo inteiro por tamanho pra devolver 9 linhas.
    const params = [f.de || null, f.ate || null, loja, soSite, [alvoRef], alvoRef, alvoCor];

    const vendas: Array<{ tamanho: string; pecas: number; devolvidas: number }> =
      await this.prisma.$queryRawUnsafe(
        `WITH bruto AS (${this.sqlUniao(true)})
         SELECT tamanho,
                SUM(pecas)::int AS pecas,
                SUM(devolvidas)::int AS devolvidas
           FROM bruto
          WHERE ref = $6::text AND cor = $7::text
          GROUP BY tamanho`,
        ...params,
      );

    const estoque: Array<{ tamanho: string; estoque: number }> = await this.prisma.$queryRawUnsafe(
      `SELECT UPPER(TRIM(COALESCE(w.tamanho, ''))) AS tamanho,
              COALESCE(SUM(e.estoque), 0)::int AS estoque
         FROM wincred_estoque e
         JOIN wincred_produtos w ON w.codigo = e.codigo
        WHERE UPPER(TRIM(w.ref)) = $1::text
          AND UPPER(TRIM(COALESCE(w.cor, ''))) = $2::text
        GROUP BY 1`,
      alvoRef,
      alvoCor,
    );

    /**
     * A união dos dois lados: tamanho que VENDEU e zerou tem que aparecer com
     * estoque 0 (é o caso mais importante da tela), e tamanho que só existe no
     * estoque aparece com venda 0 (é o encalhe).
     */
    const mapa = new Map<string, { tamanho: string; pecas: number; devolvidas: number; estoque: number }>();
    const pegar = (t: string) => {
      const chave = t || '—';
      if (!mapa.has(chave)) mapa.set(chave, { tamanho: chave, pecas: 0, devolvidas: 0, estoque: 0 });
      return mapa.get(chave)!;
    };
    for (const v of vendas) {
      const l = pegar(v.tamanho);
      l.pecas += Number(v.pecas) || 0;
      l.devolvidas += Number(v.devolvidas) || 0;
    }
    for (const e of estoque) pegar(e.tamanho).estoque = Number(e.estoque) || 0;

    return { ref: alvoRef, cor: alvoCor || null, tamanhos: [...mapa.values()] };
  }

  /**
   * ESTOQUE ATUAL somado por REF+COR (todas as lojas, todos os tamanhos).
   *
   * Sai do espelho `wincred_estoque` × cadastro, que é a mesma fonte que a
   * Consultar do PDV usa — dois números diferentes de estoque na mesma casa
   * seria pior do que não ter a coluna.
   */
  private async estoquePorRefCor(refs: string[]): Promise<Map<string, number>> {
    const mapa = new Map<string, number>();
    const alvo = [...new Set(refs.filter(Boolean))];
    if (!alvo.length) return mapa;
    try {
      const linhas: Array<{ ref: string; cor: string; estoque: number }> =
        await this.prisma.$queryRawUnsafe(
          `SELECT UPPER(TRIM(w.ref)) AS ref,
                  UPPER(TRIM(COALESCE(w.cor, ''))) AS cor,
                  COALESCE(SUM(e.estoque), 0)::int AS estoque
             FROM wincred_estoque e
             JOIN wincred_produtos w ON w.codigo = e.codigo
            WHERE UPPER(TRIM(w.ref)) = ANY($1::text[])
            GROUP BY 1, 2`,
          alvo,
        );
      for (const l of linhas) mapa.set(`${l.ref}|${l.cor}`, Number(l.estoque) || 0);
    } catch (e: any) {
      // Sem estoque a tela continua respondendo "quanto vendeu" — que é a
      // pergunta principal. A coluna some, o relatório não.
      this.logger.warn(`[vendas-produto] estoque indisponível: ${e?.message || e}`);
    }
    return mapa;
  }

  /**
   * Quantos dias a janela cobre — divisor do "peças por mês".
   *
   * Sem data escolhida a janela é "desde sempre", e aí ela vale da primeira
   * venda encontrada até hoje: dividir por um número fixo faria peça antiga
   * parecer que vende todo mês.
   */
  private diasDaJanela(de?: string, ate?: string, linhas?: LinhaCrua[]): number {
    const fim = ate ? new Date(ate) : new Date();
    let ini = de ? new Date(de) : null;
    if (!ini && linhas?.length) {
      const datas = linhas.map((l) => l.primeira).filter(Boolean) as Date[];
      if (datas.length) ini = new Date(Math.min(...datas.map((d) => new Date(d).getTime())));
    }
    if (!ini) return 0;
    const dias = Math.ceil((fim.getTime() - new Date(ini).getTime()) / 86_400_000);
    return Math.max(1, dias);
  }

  /** As marcas que existem nas vendas — alimenta o seletor da tela. */
  async marcas(): Promise<string[]> {
    const linhas: Array<{ marca: string }> = await this.prisma.$queryRawUnsafe(
      `SELECT DISTINCT NULLIF(TRIM(marca), '') AS marca
         FROM wincred_produtos
        WHERE NULLIF(TRIM(marca), '') IS NOT NULL
        ORDER BY 1`,
    );
    return linhas.map((l) => l.marca).filter(Boolean);
  }
}
