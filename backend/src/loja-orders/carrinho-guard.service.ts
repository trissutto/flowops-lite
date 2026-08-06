import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

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

  constructor(private readonly prisma: PrismaService) {}

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
      const precoCatalogo = Math.min(...precos);

      // 4) Item 5 — ESTOQUE no fechamento, não só ao adicionar.
      const estoque = variacoes.reduce((s, l) => s + (l.estoque || 0), 0);
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
