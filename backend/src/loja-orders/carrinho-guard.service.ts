import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PromoSiteService } from '../promo-site/promo-site.service';

/**
 * GUARD DO CARRINHO — reconfere no CATÁLOGO tudo que o checkout mandou.
 *
 * Itens 1, 4, 5 e 6 da lista de lançamento. Até aqui o backend só conferia se
 * os números do e-commerce fechavam ENTRE SI: quem mandasse `unitPrice: 1` num
 * vestido de R$ 300 e o subtotal coerente passava reto, porque nada era
 * comparado com o preço de verdade. O BFF é server-to-server e autenticado,
 * mas token vaza — e preço inventado é o furo mais caro que existe.
 *
 * O QUE ESTE SERVIÇO RESPONDE, peça a peça:
 *   preço  → o `vendaUn` do espelho Wincred, que é a MESMA fonte da vitrine
 *   promo  → `precoPromo` digitado na retaguarda ou os 50% do caixa
 *            (`PromoSiteService`) — o mesmo serviço que a vitrine consulta
 *   estoque→ soma de `wincred_estoque` (todas as lojas), no momento de fechar
 *   gate   → `site_produto.publicado` — despublicou no meio da sessão, não vende
 *
 * REGRA DA CASA que este arquivo respeita à risca:
 *
 *  a) **Só barra o que a vitrine também barraria.** Peça SEM linha em
 *     `site_produto` não é "despublicada": o `porSlug` do catálogo deixa abrir
 *     pela REF enquanto a curadoria não passou, e travar aqui derrubaria venda
 *     boa. Barra só o `publicado = false` explícito.
 *
 *  b) **Dedupe igual ao do catálogo** (mesma cor+tamanho em códigos
 *     diferentes): vale o de MAIOR estoque, empate no código menor. Somar
 *     inflaria o estoque de um erro de cadastro e venderia peça inexistente.
 *
 *  c) **`vendaUn` está em REAIS.** Nunca dividir por 100 — foi o bug de 01/07
 *     que derrubou preço 100× (blusa de R$ 80 virou R$ 0,80).
 *
 * O `sku` que chega do site é a REF (o carrinho carrega `product.id`, que o
 * `mapPeca` preenche com a REF). Mesmo assim o guard aceita CÓDIGO também: a
 * grade por cor já expõe `sku` = código por tamanho, e o dia que o carrinho
 * passar a mandar aquilo, isto aqui continua funcionando sem tocar em nada.
 */

/* ────────────────────────────── contrato ─────────────────────────────── */

export interface ItemCarrinho {
  sku: string;
  name?: string;
  size?: string;
  color?: string;
  quantity: number;
  unitPrice: number;
}

export interface ItemConferido {
  /** Índice no array original — o chamador reescreve o item certo. */
  indice: number;
  /** Preço REAL do catálogo, em reais. */
  precoCatalogo: number;
  /** Preço que o site mandou (o que a cliente viu). */
  precoInformado: number;
  /** Estoque somado de todas as lojas para a variação. */
  estoque: number;
  /** Código do ERP da variação escolhida (o que a separação bipa). */
  codigo: string | null;
  ref: string;
}

export type ResultadoGuard =
  | { ok: false; erro: string }
  | { ok: true; itens: ItemConferido[]; subtotal: number };

/** Linha crua do espelho. */
type LinhaCatalogo = {
  ref: string;
  codigo: string;
  cor: string | null;
  tamanho: string | null;
  preco: number;
  estoque: number;
};

@Injectable()
export class CarrinhoGuardService {
  private readonly logger = new Logger(CarrinhoGuardService.name);

  /** Um centavo de folga — arredondamento de float no navegador. */
  private static readonly TOLERANCIA = 0.011;

  constructor(
    private readonly prisma: PrismaService,
    /**
     * A promoção de 50% do caixa. É o MESMO serviço que a vitrine consulta —
     * de propósito: se os dois discordassem, o preço da página ficaria abaixo
     * do preço "real" e o pedido seria RECUSADO aqui embaixo, na cara da
     * cliente que já escolheu tudo.
     */
    private readonly promoSite: PromoSiteService,
  ) {}

  private norm(v: any): string {
    return String(v ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '') // marcas de acento soltas pelo NFD
      .trim()
      .toUpperCase();
  }

  private normRef(v: any): string {
    return this.norm(v).replace(/\s+/g, '');
  }

  private dinheiro(v: any): number {
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
  }

  /**
   * Mesma junção que a vitrine usa (`LojaCatalogService.SQL_VARIACOES`), só
   * com as colunas que interessam pra cobrar. Busca por REF **ou** por código
   * na mesma ida ao banco — o carrinho manda REF hoje, código amanhã.
   */
  private async carregar(refs: string[], codigos: string[]): Promise<LinhaCatalogo[]> {
    if (!refs.length && !codigos.length) return [];
    const sql = `
      SELECT
        UPPER(TRIM(p.ref))            AS ref,
        p.codigo                      AS codigo,
        NULLIF(TRIM(p.cor), '')       AS cor,
        NULLIF(TRIM(p.tamanho), '')   AS tamanho,
        COALESCE(p."vendaUn", 0)::float8 AS preco,
        COALESCE(e.total, 0)::int     AS estoque
      FROM wincred_produtos p
      LEFT JOIN (
        SELECT codigo, SUM(COALESCE(estoque, 0)) AS total
          FROM wincred_estoque GROUP BY codigo
      ) e ON e.codigo = p.codigo
      WHERE UPPER(TRIM(p.ref)) = ANY($1) OR p.codigo = ANY($2)
    `;
    return this.prisma.$queryRawUnsafe<LinhaCatalogo[]>(sql, refs, codigos);
  }

  /**
   * Gate de publicação. Devolve o conjunto de REFs EXPLICITAMENTE
   * despublicadas — ausência de linha não conta (ver regra (a) no topo).
   */
  /**
   * PREÇO PROMOCIONAL DO SITE por REF (14/08). Quando setado, é o preço que a
   * loja REALMENTE cobra no site — a trava passa a compará-lo, não o do ERP,
   * senão recusaria a venda promocional como fraude. Ref sem promo não entra
   * no Map (cai no preço normal do ERP).
   */
  private async precosPromo(refs: string[]): Promise<Map<string, number>> {
    const m = new Map<string, number>();
    if (!refs.length) return m;
    try {
      const rows: any[] = await (this.prisma as any).siteProduto.findMany({
        where: { ref: { in: refs }, precoPromo: { not: null } },
        select: { ref: true, precoPromo: true },
      });
      for (const r of rows) {
        const p = this.dinheiro(r.precoPromo);
        if (p > 0) m.set(this.normRef(r.ref), p);
      }
    } catch (e: any) {
      this.logger.warn(`[guard] preços promo indisponíveis (segue no ERP): ${e?.message || e}`);
    }
    return m;
  }

  private async despublicadas(refs: string[]): Promise<Set<string>> {
    if (!refs.length) return new Set();
    try {
      const rows: any[] = await (this.prisma as any).siteProduto.findMany({
        where: { ref: { in: refs }, publicado: false },
        select: { ref: true },
      });
      return new Set(rows.map((r) => this.normRef(r.ref)));
    } catch (e: any) {
      // Falha de leitura não pode derrubar a venda: o gate é uma trava a mais,
      // não a única. Registra alto e deixa passar.
      this.logger.warn(`[guard] não consegui conferir publicação (segue): ${e?.message || e}`);
      return new Set();
    }
  }

  /**
   * ESTOQUE JÁ PROMETIDO A OUTRA CLIENTE — a peça vendida que ainda não saiu
   * da arara.
   *
   * ── O PROBLEMA ──
   *
   * O estoque de um pedido do site só baixa quando a loja BIPA a peça na
   * separação. Entre "cliente pagou" e "loja bipou" passam horas, e nessa
   * janela `wincred_estoque` ainda conta a peça como disponível. Duas clientes
   * comprando a última unidade com meia hora de diferença passam as duas: o
   * sistema cobra as duas, e alguém liga pra uma delas desmarcando a compra.
   *
   * Não é só corrida de milissegundos entre dois checkouts simultâneos — essa
   * é a versão rara. A versão comum é a janela de horas, e numa live ou
   * campanha em peça de estoque baixo ela é quase garantida.
   *
   * ── POR QUE DEDUZIR EM VEZ DE RESERVAR ──
   *
   * A alternativa seria baixar o estoque na hora do pedido, ou manter uma
   * tabela de reservas. As duas criam estado novo pra sincronizar, e estado
   * que precisa ser liberado (pedido cancelado, PIX expirado, separação
   * concluída) é estado que uma hora vaza: reserva órfã trava peça boa e
   * ninguém descobre até a peça "sumir" da vitrine com estoque na arara.
   *
   * Aqui não há o que liberar. O compromisso é DERIVADO dos pedidos que
   * existem: o pedido sai da lista de status vivos e para de reservar
   * sozinho, no mesmo instante, sem cron e sem compensação.
   *
   * ── QUAIS PEDIDOS CONTAM ──
   *
   * Pago e ainda não separado conta sempre. Aguardando pagamento conta só
   * dentro da janela do PIX (2h, `PIX_EXPIRA_MIN`): carrinho abandonado não
   * pode segurar peça pra sempre. Enviado/entregue não conta — ali o estoque
   * JÁ baixou, e contar de novo tiraria a peça duas vezes.
   *
   * Kill-switch: `CARRINHO_RESERVA=0` volta ao comportamento antigo.
   */
  private static readonly STATUS_QUE_RESERVAM = [
    'processing',
    'routing',
    'awaiting_stock',
    'separating',
  ];
  /** Janela do PIX + folga — igual à validade que o backend gera. */
  private static readonly HORAS_PENDENTE = 3;

  private async reservado(codigos: string[]): Promise<Map<string, number>> {
    const vazio = new Map<string, number>();
    if (String(process.env.CARRINHO_RESERVA ?? '1') === '0') return vazio;
    if (!codigos.length) return vazio;

    const desde = new Date(Date.now() - CarrinhoGuardService.HORAS_PENDENTE * 3600_000);
    try {
      const rows = await this.prisma.$queryRawUnsafe<Array<{ sku: string; qtd: number }>>(
        `
        SELECT oi.sku AS sku, SUM(oi.quantity)::int AS qtd
          FROM order_items oi
          JOIN orders o ON o.id = oi.order_id
         WHERE oi.sku = ANY($1)
           AND (
                 o.status = ANY($2)
              OR (o.status = 'pending' AND o.created_at >= $3)
           )
         GROUP BY oi.sku
        `,
        codigos,
        CarrinhoGuardService.STATUS_QUE_RESERVAM,
        desde,
      );
      const m = new Map<string, number>();
      for (const r of rows) m.set(String(r.sku), Number(r.qtd) || 0);
      return m;
    } catch (e: any) {
      // Mesma postura do gate de publicação: esta é uma trava A MAIS. Se a
      // consulta falhar, vender com o estoque bruto é melhor do que recusar
      // pedido bom — o risco vira o de antes, não um risco novo.
      this.logger.warn(`[guard] não consegui conferir reservas (segue): ${e?.message || e}`);
      return vazio;
    }
  }

  /**
   * Dedupe do catálogo: uma linha por cor+tamanho, vencendo a de maior
   * estoque (empate → código menor, pra resposta ser sempre a mesma).
   */
  private dedupe(linhas: LinhaCatalogo[]): LinhaCatalogo[] {
    const melhor = new Map<string, LinhaCatalogo>();
    for (const l of linhas) {
      const k = `${this.norm(l.cor)}|${this.norm(l.tamanho)}`;
      const atual = melhor.get(k);
      if (
        !atual ||
        (l.estoque || 0) > (atual.estoque || 0) ||
        ((l.estoque || 0) === (atual.estoque || 0) && String(l.codigo) < String(atual.codigo))
      ) {
        melhor.set(k, l);
      }
    }
    return Array.from(melhor.values());
  }

  /**
   * Confere o carrinho inteiro. Devolve a primeira recusa (a cliente resolve
   * uma coisa por vez) ou os preços/estoques reais de cada linha.
   *
   * A mensagem de erro é sempre pronta pra tela: nada de SKU, tabela ou código
   * de erro na frente de quem está comprando.
   */
  async conferir(itens: ItemCarrinho[]): Promise<ResultadoGuard> {
    if (!Array.isArray(itens) || !itens.length) {
      return { ok: false, erro: 'Sua sacola está vazia.' };
    }

    const chaves = itens.map((it) => this.normRef(it.sku));
    const linhas = await this.carregar(chaves, chaves).catch((e) => {
      this.logger.error(`[guard] catálogo indisponível: ${e?.message || e}`);
      return null;
    });

    if (linhas === null) {
      // Catálogo fora do ar. NÃO cobra no escuro: sem preço de referência, a
      // única coisa que dá pra garantir é que ninguém pagou errado.
      return {
        ok: false,
        erro: 'Não conseguimos confirmar os preços da sua sacola agora. Tente de novo em instantes — nada foi cobrado. 💜',
      };
    }

    const porRef = new Map<string, LinhaCatalogo[]>();
    const porCodigo = new Map<string, LinhaCatalogo>();
    for (const l of linhas) {
      const r = this.normRef(l.ref);
      if (!porRef.has(r)) porRef.set(r, []);
      porRef.get(r)!.push(l);
      porCodigo.set(this.normRef(l.codigo), l);
    }

    const bloqueadas = await this.despublicadas(Array.from(porRef.keys()));
    const promo = await this.precosPromo(Array.from(porRef.keys()));
    /**
     * Os 50% de peça antiga (a promoção do caixa). Vem pelas MESMAS chaves que
     * a vitrine usou pra montar a peça — a resposta tem que ser a mesma dos
     * dois lados, senão o guard recusa o pedido por "preço atualizado".
     */
    const promo50 = await this.promoSite.porChaves([
      ...porRef.keys(),
      ...itens.map((it) => this.normRef(it.sku)),
    ]);
    // Uma consulta só pra sacola inteira: os códigos de TODAS as variações das
    // REFs do carrinho, resolvidos ou não. Consultar dentro do laço faria uma
    // ida ao banco por item.
    const reservas = await this.reservado(linhas.map((l) => String(l.codigo)));

    const conferidos: ItemConferido[] = [];
    let subtotal = 0;

    for (let i = 0; i < itens.length; i++) {
      const it = itens[i];
      const chave = this.normRef(it.sku);
      const nomePeca = String(it.name || '').trim() || 'uma peça da sua sacola';
      const qtd = Math.max(1, Number(it.quantity) || 1);

      // 1) A peça existe no catálogo?
      let candidatas = porRef.get(chave) ?? [];
      const porCod = porCodigo.get(chave);
      if (!candidatas.length && porCod) candidatas = [porCod];

      if (!candidatas.length) {
        this.logger.warn(`[guard] SKU "${it.sku}" não existe no catálogo — pedido recusado`);
        return {
          ok: false,
          erro: `Não encontramos mais "${nomePeca}" no nosso catálogo. Atualize a página e monte a sacola de novo. 💜`,
        };
      }

      const ref = this.normRef(candidatas[0].ref);

      // 2) Item 6 — despublicada durante a sessão não fecha pedido.
      if (bloqueadas.has(ref)) {
        this.logger.warn(`[guard] REF ${ref} despublicada — pedido recusado`);
        return {
          ok: false,
          erro: `"${nomePeca}" saiu do site enquanto você comprava. Remova da sacola pra continuar — e desculpa por isso. 💜`,
        };
      }

      // 3) Achar a VARIAÇÃO: cor (quando o site mandou) + tamanho.
      let variacoes = this.dedupe(candidatas);

      const cor = this.norm(it.color);
      if (cor) {
        const daCor = variacoes.filter((l) => this.norm(l.cor) === cor);
        if (!daCor.length) {
          this.logger.warn(`[guard] REF ${ref} sem a cor "${it.color}" no catálogo`);
          return {
            ok: false,
            erro: `A cor escolhida de "${nomePeca}" não está mais disponível. Escolha outra cor pra continuar. 💜`,
          };
        }
        variacoes = daCor;
      }

      const tam = this.norm(it.size);
      if (tam) {
        const doTam = variacoes.filter((l) => this.norm(l.tamanho) === tam);
        if (!doTam.length) {
          this.logger.warn(`[guard] REF ${ref} sem o tamanho "${it.size}"`);
          return {
            ok: false,
            erro: `O tamanho ${it.size} de "${nomePeca}" não está mais disponível. Escolha outro tamanho pra continuar. 💜`,
          };
        }
        variacoes = doTam;
      }

      /**
       * PREÇO: o MENOR entre as variações que sobraram — é exatamente o que a
       * vitrine mostra (`montarPeca` usa `Math.min` dos preços). Cobrar o maior
       * seria cobrar diferente da página que a cliente leu.
       *
       * Preço zerado no cadastro NÃO vira venda: é erro de ERP, e "de graça"
       * não é promoção que alguém aprovou.
       */
      const precos = variacoes.map((l) => this.dinheiro(l.preco)).filter((p) => p > 0);
      if (!precos.length) {
        this.logger.error(`[guard] REF ${ref} com preço zerado no catálogo — pedido recusado`);
        return {
          ok: false,
          erro: `"${nomePeca}" está com o preço em atualização. Tente de novo em instantes ou fale com a gente pelo WhatsApp. 💜`,
        };
      }
      /**
       * PROMO DO SITE VENCE O ERP (14/08): se a REF tem `precoPromo`, é ele o
       * preço que a loja cobra no site — a trava compara contra ele, não
       * contra o `vendaUn`. Sem promo, segue o menor do catálogo (ERP).
       *
       * Sem `precoPromo` digitado, entra a promoção de 50% do caixa (15/08):
       * peça de MODA cadastrada até 2023 sai por metade na vitrine, e a
       * cobrança tem que fechar com a página. A ordem é a mesma do catálogo —
       * preço digitado à mão vence a regra automática.
       */
      const precoCheio = Math.min(...precos);
      const daPromo50 = !!(promo50.get(chave) ?? promo50.get(ref))?.elegivel;
      const precoCatalogo =
        promo.get(chave) ?? (daPromo50 ? this.promoSite.precoComDesconto(precoCheio) : precoCheio);

      /**
       * 4) Item 5 — ESTOQUE no fechamento, não só ao adicionar.
       *
       * Do estoque bruto sai o que já foi prometido a outra cliente e ainda
       * não saiu da arara (ver `reservado`). Sem isso, a última peça é vendida
       * quantas vezes couberem na janela entre o pedido e a separação.
       *
       * Piso em zero: reserva maior que o estoque significa que já houve
       * venda a mais (ou que a peça foi baixada por outro caminho). Número
       * negativo aqui só produziria mensagem sem sentido pra cliente.
       */
      const estoqueBruto = variacoes.reduce((s, l) => s + (l.estoque || 0), 0);
      const jaPrometido = variacoes.reduce(
        (s, l) => s + (reservas.get(String(l.codigo)) || 0),
        0,
      );
      const estoque = Math.max(0, estoqueBruto - jaPrometido);
      if (jaPrometido > 0) {
        this.logger.log(
          `[guard] REF ${ref}: estoque ${estoqueBruto} − ${jaPrometido} prometido = ${estoque}`,
        );
      }
      if (estoque <= 0) {
        return {
          ok: false,
          erro: `"${nomePeca}"${tam ? ` no tamanho ${it.size}` : ''} acabou de esgotar. Remova da sacola pra fechar o resto do pedido. 💜`,
        };
      }
      if (estoque < qtd) {
        return {
          ok: false,
          erro:
            estoque === 1
              ? `Sobrou só 1 unidade de "${nomePeca}"${tam ? ` no tamanho ${it.size}` : ''}. Ajuste a quantidade pra continuar. 💜`
              : `Temos ${estoque} unidades de "${nomePeca}"${tam ? ` no tamanho ${it.size}` : ''}. Ajuste a quantidade pra continuar. 💜`,
        };
      }

      // 5) Itens 1 e 4 — o preço cobrado é o do CATÁLOGO, nunca o do cliente.
      const precoInformado = this.dinheiro(it.unitPrice);
      const dif = precoCatalogo - precoInformado;
      if (Math.abs(dif) > CarrinhoGuardService.TOLERANCIA) {
        if (dif > 0) {
          /**
           * Catálogo MAIS CARO que a página que a cliente leu. Não cobra a
           * diferença em silêncio — isso é o que gera chargeback e reclamação.
           * Manda recarregar e mostra o preço novo.
           */
          this.logger.warn(
            `[guard] REF ${ref} subiu de ${precoInformado.toFixed(2)} pra ${precoCatalogo.toFixed(2)} — pedido recusado`,
          );
          return {
            ok: false,
            erro: `O preço de "${nomePeca}" foi atualizado enquanto você comprava. Atualize a página pra ver o valor certo antes de pagar. 💜`,
          };
        }
        /**
         * Catálogo MAIS BARATO. Segue a venda cobrando o menor — a cliente
         * paga menos do que viu, e recusar aqui só perderia pedido bom.
         */
        this.logger.log(
          `[guard] REF ${ref} baixou de ${precoInformado.toFixed(2)} pra ${precoCatalogo.toFixed(2)} — cobrando o menor`,
        );
      }

      subtotal += precoCatalogo * qtd;
      conferidos.push({
        indice: i,
        precoCatalogo,
        precoInformado,
        estoque,
        codigo: variacoes.length === 1 ? variacoes[0].codigo : null,
        ref,
      });
    }

    return { ok: true, itens: conferidos, subtotal: this.dinheiro(subtotal) };
  }
}
