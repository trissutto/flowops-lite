import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { reservaLigada, sqlReservadoPorSku } from '../common/estoque-reservado';
import { PromoSiteService } from '../promo-site/promo-site.service';
import { SQL_SEM_LOJA_CANAL } from '../common/loja-canal';

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
 *   preço  → o `vendaUn` do espelho Wincred, que é a MESMA fonte da vitrine —
 *            e o MESMO preço do caixa das 14 lojas ("o site segue o da loja
 *            SEMPRE", ordem do dono 26/08; o `precoPromo` digitado morreu)
 *   promo  → só os 50% do caixa (`PromoSiteService`) — o mesmo serviço que a
 *            vitrine consulta
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
  /**
   * Id da peça no e-commerce (o mesmo que o carrinho usa em `lineKey`). Não
   * entra na conferência — só volta na recusa por preço, pra sacola achar a
   * linha certa e atualizar sozinha (ver `ItemRecusado`).
   */
  productId?: string;
  name?: string;
  size?: string;
  color?: string;
  quantity: number;
  unitPrice: number;
}

/**
 * A PEÇA QUE BARROU O PEDIDO POR PREÇO — devolvida junto com a recusa.
 *
 * Por que existe: o preço da sacola mora no localStorage do navegador e
 * NINGUÉM o renova — nem F5, nem re-adicionar pela página do produto (o
 * `add()` do carrinho só soma quantidade). Quando a promoção acaba entre o
 * "adicionar" e o "pagar", a recusa dizia "atualize a página" e a página
 * atualizada mandava o MESMO preço velho: recusa de novo, sem saída, até a
 * cliente adivinhar que precisa remover a peça e colocar de volta.
 *
 * Com o índice, a variação e o `precoAtual` na resposta, o site corrige a
 * linha na hora e mostra "passou de A pra B" — a compra volta a ficar a um
 * clique. Nada disso cria pedido nem cobrança: a recusa acontece ANTES do
 * `criarOrder`, e o preço que vale continua sendo o do catálogo.
 */
export interface ItemRecusado {
  /** Índice no array que o site mandou. */
  indice: number;
  productId: string;
  size: string | null;
  color: string | null;
  /** Preço que o catálogo cobra AGORA (o que a sacola precisa passar a mostrar). */
  precoAtual: number;
  /** Preço que a sacola mandou (o que a cliente viu). */
  precoInformado: number;
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

/**
 * POR QUE o carrinho foi recusado — em código, não em frase (22/08).
 *
 * A frase é pra cliente e muda quando a gente quiser; isto é pro funil. Até
 * agora o `checkout_error` gravava só `reason: catalog_unavailable`, então a
 * tela de Alertas mostrava "Produto, estoque ou preço alterado" sem dizer
 * qual das SETE recusas disparou nem em qual peça. Descobrir que era reserva
 * velha de pedido parado exigiu refazer a conta do guard na mão, no banco.
 */
export type MotivoRecusa =
  | 'sacola_vazia'
  | 'catalogo_fora'
  | 'sku_inexistente'
  | 'despublicada'
  | 'sem_cor'
  | 'sem_tamanho'
  | 'preco_zerado'
  | 'esgotou'
  | 'estoque_insuficiente'
  | 'preco_subiu'
  /** Não vem do guard: o TETO do `reprecificar` (nossa conta passou do que a cliente leu). */
  | 'total_acima';

export type ResultadoGuard =
  /** `item` só vem na recusa por PREÇO — as outras recusas (esgotou, saiu do
   *  site, cor/tamanho sumiu) já dizem o que fazer e não têm valor a corrigir.
   *  `motivo`/`ref` vêm SEMPRE: são o que a tela de Alertas lê. */
  | {
      ok: false;
      erro: string;
      motivo: MotivoRecusa;
      ref?: string;
      item?: ItemRecusado;
      /**
       * Só em `estoque_insuficiente`: QUANTAS sobraram de verdade.
       *
       * Existe pro site poder oferecer "deixar N unidades e continuar" em vez
       * de mandar a cliente sair do checkout, abrir a sacola, achar a peça e
       * ajustar a quantidade na mão. Medido em 31/08: 151 tentativas de pagar
       * em 41 sessões — 3,7 por pessoa — batendo nessa parede.
       */
      disponivel?: number;
    }
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
        -- SEM A LOJA-CANAL (dono, 24/08). É esta soma que a trava do carrinho
        -- usa pra deixar (ou não) a cliente comprar: contar o saldo de quem não
        -- tem arara é aceitar pedido que ninguém consegue separar.
        SELECT codigo, SUM(COALESCE(estoque, 0)) AS total
          FROM wincred_estoque ${SQL_SEM_LOJA_CANAL} GROUP BY codigo
      ) e ON e.codigo = p.codigo
      WHERE UPPER(TRIM(p.ref)) = ANY($1) OR p.codigo = ANY($2)
    `;
    return this.prisma.$queryRawUnsafe<LinhaCatalogo[]>(sql, refs, codigos);
  }

  /**
   * Gate de publicação. Devolve o conjunto de REFs EXPLICITAMENTE
   * despublicadas — ausência de linha não conta (ver regra (a) no topo).
   *
   * (O `precosPromo` que morava aqui morreu em 26/08 junto com o
   * `precoPromo` da vitrine — o preço do site é o da loja, sempre.)
   */
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
   * ⚠️ A REGRA NÃO MORA MAIS AQUI. Ela é `common/estoque-reservado.ts`, e é a
   * MESMA que a VITRINE lê desde 31/08 (`LojaCatalogService.SQL_VARIACOES`).
   *
   * Enquanto eram dois textos de SQL, a grade da peça mostrava disponível e
   * este guarda recusava no clique de pagar: **151 recusas por "esgotou" em 41
   * sessões numa semana, 30 delas sem comprar nada**, e 108 dessas recusas numa
   * peça só — a BMM-100, com 582 unidades na rede. O motivo, o porquê de
   * deduzir em vez de reservar e os kill-switches estão documentados lá.
   *
   * O filtro por SKU fica por FORA da consulta compartilhada porque aquele
   * trecho não pode ter placeholder (ele é interpolado no `SQL_VARIACOES`, que
   * já usa os seus). A consulta inteira custa 0,9 ms; filtrar depois não pesa.
   */
  private async reservado(codigos: string[]): Promise<Map<string, number>> {
    const vazio = new Map<string, number>();
    if (!reservaLigada()) return vazio;
    if (!codigos.length) return vazio;

    try {
      const rows = await this.prisma.$queryRawUnsafe<Array<{ sku: string; qtd: number }>>(
        `SELECT z.sku, z.qtd FROM (${sqlReservadoPorSku()}) z WHERE z.sku = ANY($1)`,
        codigos,
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
      return { ok: false, motivo: 'sacola_vazia', erro: 'Sua sacola está vazia.' };
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
        ok: false, motivo: 'catalogo_fora',
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
          ok: false, motivo: 'sku_inexistente', ref: chave,
          erro: `Não encontramos mais "${nomePeca}" no nosso catálogo. Atualize a página e monte a sacola de novo. 💜`,
        };
      }

      const ref = this.normRef(candidatas[0].ref);

      // 2) Item 6 — despublicada durante a sessão não fecha pedido.
      if (bloqueadas.has(ref)) {
        this.logger.warn(`[guard] REF ${ref} despublicada — pedido recusado`);
        return {
          ok: false, motivo: 'despublicada', ref,
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
            ok: false, motivo: 'sem_cor', ref,
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
            ok: false, motivo: 'sem_tamanho', ref,
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
          ok: false, motivo: 'preco_zerado', ref,
          erro: `"${nomePeca}" está com o preço em atualização. Tente de novo em instantes ou fale com a gente pelo WhatsApp. 💜`,
        };
      }
      /**
       * O PREÇO É O DA LOJA (26/08): `vendaUn` — o mesmo do caixa das 14
       * lojas. O `precoPromo` digitado só no site saiu da fórmula junto com a
       * vitrine (CHIC/SMILE a 59,90 no site com o caixa em 79,90 foi a gota).
       * A única promoção é a de 50% do caixa (15/08): peça de MODA cadastrada
       * até 2023 sai por metade na vitrine, e a cobrança tem que fechar com a
       * página — a regra é a MESMA do catálogo, pelo MESMO serviço.
       */
      const precoCheio = Math.min(...precos);
      const daPromo50 = !!(promo50.get(chave) ?? promo50.get(ref))?.elegivel;
      const precoCatalogo = daPromo50 ? this.promoSite.precoComDesconto(precoCheio) : precoCheio;

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
      const itemDaSacola = {
        indice: i,
        productId: String(it.productId || it.sku),
        size: it.size ? String(it.size) : null,
        color: it.color ? String(it.color) : null,
        precoAtual: precoCatalogo,
        precoInformado: this.dinheiro(it.unitPrice),
      };
      if (estoque <= 0) {
        return {
          ok: false, motivo: 'esgotou', ref, item: itemDaSacola,
          erro: `"${nomePeca}"${tam ? ` no tamanho ${it.size}` : ''} acabou de esgotar enquanto você comprava. Toque em "Tirar da sacola e continuar" aqui embaixo — o resto do pedido segue normal. 💜`,
        };
      }
      if (estoque < qtd) {
        return {
          ok: false, motivo: 'estoque_insuficiente', ref, disponivel: estoque, item: itemDaSacola,
          erro:
            estoque === 1
              ? `Sobrou só 1 unidade de "${nomePeca}"${tam ? ` no tamanho ${it.size}` : ''}. Toque em "Deixar 1 e continuar" aqui embaixo. 💜`
              : `Temos ${estoque} unidades de "${nomePeca}"${tam ? ` no tamanho ${it.size}` : ''}. Toque em "Deixar ${estoque} e continuar" aqui embaixo. 💜`,
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
           *
           * A frase antiga mandava "atualizar a página", e atualizar não
           * mudava nada: o preço fica congelado no localStorage da sacola
           * (auditoria de 17/08 — só remover a peça e adicionar de novo saía
           * do loop, e ninguém dizia isso). Agora a recusa leva o preço novo
           * e a variação exata em `item`: o site corrige a linha sozinho e a
           * cliente só confere o total. A frase serve de rede pra quem ainda
           * não recebeu essa correção da sacola.
           */
          this.logger.warn(
            `[guard] REF ${ref} subiu de ${precoInformado.toFixed(2)} pra ${precoCatalogo.toFixed(2)} — pedido recusado`,
          );
          const brl = (v: number) => v.toFixed(2).replace('.', ',');
          return {
            ok: false, motivo: 'preco_subiu', ref,
            erro:
              `O preço de "${nomePeca}" passou de R$ ${brl(precoInformado)} para R$ ${brl(precoCatalogo)} enquanto você comprava. ` +
              `Confira o novo total antes de pagar — se a sacola não atualizar, remova a peça e adicione de novo. 💜`,
            item: {
              indice: i,
              productId: String(it.productId || it.sku),
              size: it.size ? String(it.size) : null,
              color: it.color ? String(it.color) : null,
              precoAtual: precoCatalogo,
              precoInformado,
            },
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
