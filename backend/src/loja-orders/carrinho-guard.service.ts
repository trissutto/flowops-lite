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
  | { ok: false; erro: string; motivo: MotivoRecusa; ref?: string; item?: ItemRecusado }
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
   * Pago e ainda não separado conta sempre. AGUARDANDO PAGAMENTO NÃO CONTA
   * MAIS (dono, 17/08: "não separa nada, se vender eu estorno") — pedido sem
   * dinheiro na conta não tira peça da vitrine de ninguém. Enviado/entregue
   * não conta — ali o estoque JÁ baixou, e contar de novo tiraria a peça
   * duas vezes.
   *
   * Kill-switch: `CARRINHO_RESERVA=0` volta ao comportamento antigo.
   */
  private static readonly STATUS_QUE_RESERVAM = [
    'processing',
    'routing',
    'awaiting_stock',
    'separating',
  ];
  /**
   * ZERO. PEDIDO NÃO PAGO NÃO SEGURA PEÇA (dono, 17/08).
   *
   * Eram 3 horas. A decisão do dono foi explícita: "não separa nada, se
   * vender eu estorno".
   *
   * A troca, dita por quem paga a conta: peça parada na vitrine por causa de
   * um PIX que talvez nunca seja pago é venda perdida CERTA; venda dupla é
   * um risco que existe, é raro, e tem conserto — estorno. Entre perder
   * venda todo dia e estornar de vez em quando, ele escolhe estornar.
   *
   * Vale ainda mais com a validade do PIX em 24h: reservar por um dia
   * inteiro tiraria da vitrine boa parte do catálogo de número escasso.
   *
   * Zero desliga a janela: nenhum `awaiting_payment` entra na conta do
   * reservado, em nenhum momento. O que continua reservando é só pedido
   * PAGO e ainda não separado — esse é compromisso de verdade.
   */
  private static readonly HORAS_PENDENTE = 0;

  /**
   * 🔴 TETO DE IDADE DA RESERVA (22/08) — reserva eterna é reserva errada.
   *
   * O que aconteceu: 103 pedidos parados em `separating`, o mais antigo de
   * 27/04 (quase 4 meses), segurando 225 peças. Como `separating` reserva pra
   * sempre, o disponível de 61 variações ficava <= 0 — e 25 delas tinham peça
   * DE VERDADE na arara. O checkout recusava com `catalog_unavailable`, a
   * frase mandava "atualize a página", e atualizar não mudava nada porque a
   * recusa é server-side e determinística. Caso medido: cliente de anúncio
   * pago, sacola de 4 peças, 11 tentativas de PIX em 7 minutos, zero compra.
   *
   * O conserto NÃO mexe em pedido nenhum (ordem do dono, 22/08: "não mexa em
   * pedidos em separação"). O pedido continua exatamente como está — o que
   * muda é que a CONFERÊNCIA DO CARRINHO para de contar reserva velha.
   * Reversível por env, sem migração e sem UPDATE.
   *
   * Por que 15 dias: a separação real leva 4,1 dias em média (medição das 639
   * caixas em 30 dias) e o lote recente mais antigo tem 7. Quinze dias é o
   * dobro da pior separação legítima. Medido no banco: destrava 15 das 16
   * variações que dá pra destravar (10 dias destravaria 16, e 30 só 10) sem
   * deixar de honrar nenhum pedido dentro do prazo normal.
   *
   * O risco assumido é o MESMO que o dono já escolheu pro `HORAS_PENDENTE`:
   * peça de pedido esquecido pode ser vendida duas vezes e isso tem conserto
   * (estorno); recusar venda todo dia não tem.
   *
   * `CARRINHO_RESERVA_DIAS=0` desliga o teto (volta a reservar pra sempre).
   */
  private get diasDeReserva(): number {
    const v = Number(process.env.CARRINHO_RESERVA_DIAS);
    return Number.isFinite(v) && v >= 0 ? v : 15;
  }

  private async reservado(codigos: string[]): Promise<Map<string, number>> {
    const vazio = new Map<string, number>();
    if (String(process.env.CARRINHO_RESERVA ?? '1') === '0') return vazio;
    if (!codigos.length) return vazio;

    const desde = new Date(Date.now() - CarrinhoGuardService.HORAS_PENDENTE * 3600_000);
    // Zero = sem teto: uma data no passado remoto faz todo pedido passar.
    const dias = this.diasDeReserva;
    const reservaDesde = dias > 0 ? new Date(Date.now() - dias * 86_400_000) : new Date(0);
    try {
      const rows = await this.prisma.$queryRawUnsafe<Array<{ sku: string; qtd: number }>>(
        `
        SELECT oi.sku AS sku, SUM(oi.quantity)::int AS qtd
          FROM order_items oi
          JOIN orders o ON o.id = oi.order_id
         WHERE oi.sku = ANY($1)
           AND (
                 (o.status = ANY($2) AND o.created_at >= $4)
              OR (o.status = 'pending' AND o.created_at >= $3)
           )
         GROUP BY oi.sku
        `,
        codigos,
        CarrinhoGuardService.STATUS_QUE_RESERVAM,
        desde,
        reservaDesde,
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
          ok: false, motivo: 'esgotou', ref,
          erro: `"${nomePeca}"${tam ? ` no tamanho ${it.size}` : ''} acabou de esgotar. Remova da sacola pra fechar o resto do pedido. 💜`,
        };
      }
      if (estoque < qtd) {
        return {
          ok: false, motivo: 'estoque_insuficiente', ref,
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
