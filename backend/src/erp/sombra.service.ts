import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * MODO SOMBRA — valida uma consulta nova (Postgres) contra a atual (Giga) SEM
 * trocar o que o sistema responde.
 *
 * É a Fase 1 do PLANO-SAIDA-GIGA-NATIVO.md feita do jeito seguro. O problema
 * de migrar leitura não é escrever a consulta nova — é ter CERTEZA de que ela
 * devolve a mesma coisa em todos os casos de canto que 20 anos de dado
 * produziram. Teste artificial não cobre isso; tráfego real cobre.
 *
 * COMO FUNCIONA:
 *   1. A consulta do Giga roda normalmente e é ELA quem responde. Sempre.
 *   2. A consulta nova roda em paralelo, sem bloquear.
 *   3. As duas respostas são comparadas; divergência vira log e contador.
 *   4. Depois de dias sem divergência, aí sim a flag vira e o Postgres passa
 *      a responder.
 *
 * GARANTIAS:
 *   - a consulta nova NUNCA muda a resposta enquanto estiver em sombra;
 *   - erro na consulta nova é engolido (só conta) — não pode derrubar a tela;
 *   - a comparação não espera pela consulta nova: se ela demorar, o usuário
 *     não sente. `void` de propósito.
 *
 * FLAGS:
 *   GIGA_SOMBRA=1            liga a comparação (default: desligada)
 *   GIGA_SOMBRA_VERBOSE=1    loga TODA comparação, não só divergência
 *
 * Ver também `ERP_WRITE_ENABLED`, que faz o mesmo pro lado da escrita — o
 * padrão de sombra já é conhecido nesta casa.
 */

interface Contador {
  iguais: number;
  /**
   * Mesma resposta, grafia diferente: o espelho guarda `codigo` SEM zeros à
   * esquerda (`normalizeCodigo`, decisão do projeto) e o Giga devolve com o
   * padding — '0000269439917' e '269439917' são o MESMO produto.
   *
   * Conta separado de propósito. Se entrasse como divergência, o ruído de
   * formatação afogaria a divergência de verdade; se entrasse como igual,
   * esconderia que o formato muda — e quem consome o retorno precisa saber
   * disso ANTES da virada.
   */
  formato: number;
  diferentes: number;
  erros: number;
  ultimaDivergencia?: string;
  ultimaEm?: string;
}

@Injectable()
export class SombraService {
  private readonly logger = new Logger('GigaSombra');

  /** Placar por método comparado — lido pelo endpoint de acompanhamento. */
  private readonly placar = new Map<string, Contador>();

  constructor(private readonly prisma: PrismaService) {}

  get ligado(): boolean {
    return String(process.env.GIGA_SOMBRA ?? '') === '1';
  }

  /**
   * `GIGA_LEITURA_FLOW=1` — o Postgres passa a RESPONDER, não só comparar.
   *
   * ⚠️ ISTO MUDA O QUE O SISTEMA DEVOLVE. Só ligue depois de olhar o placar
   * da sombra em /retaguarda/giga-sombra.
   *
   * O recuo pro Giga continua valendo (resposta vazia ou erro), então
   * tradução incompleta não deixa a loja sem resposta. O que o recuo NÃO
   * cobre é o Postgres achar OUTRO cadastro do mesmo produto — acontece em
   * produto duplicado quando o estoque do espelho está defasado (sincroniza
   * de hora em hora). Nesse caso a peça sai do cadastro errado.
   *
   * Desligar: apagar a env. Volta na hora, sem deploy de código.
   */
  get respondeDoFlow(): boolean {
    return String(process.env.GIGA_LEITURA_FLOW ?? '') === '1';
  }

  private get verboso(): boolean {
    return String(process.env.GIGA_SOMBRA_VERBOSE ?? '') === '1';
  }

  /**
   * Compara, em segundo plano, o resultado do Giga com o da consulta nova.
   *
   * NÃO retorna nada de propósito: quem chama já tem a resposta do Giga e não
   * deve esperar por isto. Chame com `void this.sombra.comparar(...)`.
   *
   * @param metodo   nome pro placar, ex.: 'findCodigoByRefCorTam'
   * @param entrada  os argumentos, pra reproduzir a divergência depois
   * @param doGiga   o que o Giga respondeu (a verdade de hoje)
   * @param nova     função que produz a resposta do Postgres
   */
  async comparar<T>(
    metodo: string,
    entrada: unknown,
    doGiga: T,
    nova: () => Promise<T>,
  ): Promise<void> {
    if (!this.ligado) return;

    const c = this.placar.get(metodo) ?? { iguais: 0, formato: 0, diferentes: 0, erros: 0 };
    this.placar.set(metodo, c);

    try {
      const doFlow = await nova();

      // JSON estável: a comparação precisa ignorar ordem de chave de objeto,
      // senão duas respostas idênticas apareceriam como divergentes.
      const a = this.estavel(doGiga);
      const b = this.estavel(doFlow);

      if (a === b) {
        c.iguais++;
        if (this.verboso) {
          this.logger.log(`[${metodo}] igual · entrada=${this.curto(entrada)} · valor=${this.curto(doGiga)}`);
        }
        return;
      }

      // Só o zero à esquerda difere? Mesmo produto, outra grafia.
      if (this.soZeroAEsquerda(a, b)) {
        c.formato++;
        if (this.verboso) {
          this.logger.log(`[${metodo}] formato · giga=${this.curto(doGiga)} flow=${this.curto(doFlow)}`);
        }
        return;
      }

      c.diferentes++;
      c.ultimaDivergencia = `entrada=${this.curto(entrada)} giga=${this.curto(doGiga)} flow=${this.curto(doFlow)}`;
      c.ultimaEm = new Date().toISOString();

      // WARN, não ERROR: em sombra, divergência é INFORMAÇÃO, não incidente.
      // O sistema respondeu certo (com o Giga); isto aqui é o aprendizado que
      // impede a virada de dar errado depois.
      this.logger.warn(`[${metodo}] DIVERGENCIA · ${c.ultimaDivergencia}`);
    } catch (e) {
      c.erros++;
      // Erro na consulta NOVA não pode aparecer pro usuário nem virar alarme:
      // o sistema já respondeu, com o Giga, antes disto rodar.
      this.logger.warn(`[${metodo}] erro na consulta nova: ${(e as Error).message}`);
    }
  }

  /** Placar acumulado — alimenta o endpoint de acompanhamento da migração. */
  relatorio(): Array<{
    metodo: string;
    iguais: number;
    formato: number;
    diferentes: number;
    erros: number;
    taxa: string;
    ultimaDivergencia?: string;
    ultimaEm?: string;
  }> {
    return [...this.placar.entries()]
      .map(([metodo, c]) => {
        const total = c.iguais + c.formato + c.diferentes;
        // `formato` conta como acerto na taxa: é o mesmo produto. Fica na
        // coluna própria pra ninguém esquecer que a grafia muda.
        const acertos = c.iguais + c.formato;
        return {
          metodo,
          iguais: c.iguais,
          formato: c.formato,
          diferentes: c.diferentes,
          erros: c.erros,
          taxa: total ? `${((acertos / total) * 100).toFixed(2)}%` : '—',
          ultimaDivergencia: c.ultimaDivergencia,
          ultimaEm: c.ultimaEm,
        };
      })
      .sort((a, b) => b.diferentes - a.diferentes);
  }

  /**
   * True quando os dois valores só diferem por zero à esquerda.
   * Compara token a token pra funcionar tanto em resposta única ('000123' vs
   * '123') quanto em lista serializada do batch.
   */
  private soZeroAEsquerda(a: string, b: string): boolean {
    const limpa = (s: string) => s.replace(/(^|[^0-9])0+(\d)/g, '$1$2');
    return limpa(a) === limpa(b);
  }

  zerar(): void {
    this.placar.clear();
  }

  /* ────────────────────── consultas novas (Postgres) ────────────────────── */

  /**
   * Versão Postgres de `findCodigoByRefCorTam`.
   *
   * Espelha a lógica da consulta do Giga, incluindo a parte que mais importa:
   * quando a mesma REF+COR+TAMANHO existe em CÓDIGOS diferentes (produto
   * recadastrado), ganha o que TEM ESTOQUE — senão o app mostra "sem estoque"
   * e baixa o SKU errado. Empate resolve pelo código maior (o mais novo).
   *
   * Fonte: `wincred_produtos` + `wincred_estoque`, os espelhos CURADOS. Não usa
   * o `giga_raw`: aquele é arquivo cru, sem as regras de normalização.
   */
  async findCodigoByRefCorTam(
    refCode: string,
    cor: string | null,
    tamanho: string | null,
  ): Promise<string | null> {
    const ref = String(refCode || '').trim();
    if (!ref) return null;
    const corClean = (cor || '').trim();
    const tamClean = (tamanho || '').trim();

    // Os QUATRO níveis, na MESMA ordem do Giga. Ordem diferente devolveria
    // resposta diferente em produto ambíguo — e a sombra acusaria divergência
    // que seria culpa da tradução, não do dado.

    // 1. Exato.
    const exato = await this.umaLinha(
      `UPPER(TRIM(COALESCE(p.cor,''))) = UPPER(TRIM($2))
       AND UPPER(TRIM(COALESCE(p.tamanho,''))) = UPPER(TRIM($3))`,
      [ref, corClean, tamClean],
    );
    if (exato) return exato;

    // 2. Cor por aproximação, nos dois sentidos: 'BEGE' casando com
    //    'XADREZ BEGE' e o contrário.
    if (corClean) {
      const contida = await this.umaLinha(
        `UPPER(COALESCE(p.cor,'')) LIKE '%' || UPPER($2) || '%'
         AND UPPER(TRIM(COALESCE(p.tamanho,''))) = UPPER(TRIM($3))`,
        [ref, corClean, tamClean],
      );
      if (contida) return contida;

      const inversa = await this.umaLinha(
        `UPPER($2) LIKE '%' || UPPER(COALESCE(p.cor,'')) || '%'
         AND UPPER(TRIM(COALESCE(p.tamanho,''))) = UPPER(TRIM($3))`,
        [ref, corClean, tamClean],
      );
      if (inversa) return inversa;
    }

    // 3. Só REF + tamanho (ignora cor).
    if (tamClean) {
      const semCor = await this.umaLinha(
        `UPPER(TRIM(COALESCE(p.tamanho,''))) = UPPER(TRIM($3))`,
        [ref, corClean, tamClean],
      );
      if (semCor) return semCor;
    }

    // 4. REF irmã SUFIXADA (padrão Lurd's: 900658 = OFF WHITE, 900658M =
    //    MOSTARDA). A comparação de cor ignora espaço e hífen dos dois lados,
    //    porque a grafia varia entre cadastros irmãos ('OFF WHITE'/'OFF-WHITE').
    //    O `~` do Postgres é o equivalente do REGEXP do MySQL.
    if (corClean && tamClean) {
      const refEscapada = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = `^${refEscapada}[- ]?[A-Z]+$`;
      const corSquash = corClean.toUpperCase().replace(/[\s-]/g, '');

      const linhas: Array<{ codigo: string }> = await (this.prisma as any).$queryRawUnsafe(
        `SELECT p.codigo
           FROM wincred_produtos p
           LEFT JOIN wincred_estoque e ON e.codigo = p.codigo
          WHERE COALESCE(p.ref,'') ~ $1
            AND UPPER(TRIM(COALESCE(p.tamanho,''))) = UPPER(TRIM($2))
            AND (
              REPLACE(REPLACE(UPPER(COALESCE(p.cor,'')),' ',''),'-','') = $3
              OR REPLACE(REPLACE(UPPER(COALESCE(p.cor,'')),' ',''),'-','') LIKE '%' || $3 || '%'
              OR $3 LIKE '%' || REPLACE(REPLACE(UPPER(COALESCE(p.cor,'')),' ',''),'-','') || '%'
            )
          GROUP BY p.codigo
          ORDER BY COALESCE(SUM(e.estoque),0) DESC, p.codigo DESC
          LIMIT 1`,
        regex,
        tamClean,
        corSquash,
      );
      if (linhas?.[0]?.codigo) return String(linhas[0].codigo).trim();
    }

    return null;
  }

  /**
   * Versão Postgres de `batchFindCodigosByRefCorTam`.
   *
   * Resolve N itens (REF+cor+tamanho) numa consulta só. Duas sutilezas do
   * original que PRECISAM ser reproduzidas, ou a sombra acusa divergência que
   * é culpa da tradução:
   *
   *  1. TOLERÂNCIA DE ZERO À ESQUERDA na REF. O Giga tem '012467' e o
   *     TransferOrder tem '12467' (ou o contrário). O original gera variantes
   *     de padding; aqui comparo pelo NÚCLEO (ref sem zeros à esquerda) dos
   *     dois lados, que cobre o mesmo caso sem inventar 5 variantes.
   *
   *  2. DESEMPATE quando a mesma REF+COR+TAM tem CÓDIGOS diferentes (produto
   *     recadastrado): ganha o de maior estoque; empate resolve pelo código
   *     NUMERICAMENTE maior — não pelo texto, senão '9' venceria '10'.
   */
  async batchFindCodigosByRefCorTam(
    items: Array<{ refCode: string; cor?: string | null; tamanho?: string | null }>,
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!items?.length) return out;

    const norm = (s: any) => String(s ?? '').trim().toUpperCase();
    const semZeros = (s: string) => s.replace(/^0+/, '') || '0';

    // Dedup na entrada, igual ao original — item repetido não multiplica a
    // consulta.
    const chaves = new Set<string>();
    const alvos: Array<{ ref: string; nucleo: string; cor: string; tam: string }> = [];
    for (const it of items) {
      const ref = norm(it.refCode);
      if (!ref) continue;
      const cor = norm(it.cor);
      const tam = norm(it.tamanho);
      const k = `${ref}|${cor}|${tam}`;
      if (chaves.has(k)) continue;
      chaves.add(k);
      alvos.push({ ref, nucleo: semZeros(ref), cor, tam });
    }
    if (!alvos.length) return out;

    // Uma consulta por lote de 500, mesma fatia do original.
    const melhor = new Map<string, { codigo: string; estoque: number }>();
    for (let i = 0; i < alvos.length; i += 500) {
      const lote = alvos.slice(i, i + 500);

      // Casa pelo núcleo da REF nos DOIS lados: LTRIM(p.ref,'0') = núcleo do
      // alvo. Resolve o padding sem enumerar variantes.
      const nucleos = [...new Set(lote.map((a) => a.nucleo))];

      const linhas: Array<{ ref: string; cor: string; tamanho: string; codigo: string; total_est: string }> =
        await (this.prisma as any).$queryRawUnsafe(
          `SELECT COALESCE(p.ref,'') AS ref,
                  COALESCE(p.cor,'') AS cor,
                  COALESCE(p.tamanho,'') AS tamanho,
                  p.codigo,
                  COALESCE((SELECT SUM(e.estoque) FROM wincred_estoque e WHERE e.codigo = p.codigo),0)::text AS total_est
             FROM wincred_produtos p
            WHERE COALESCE(NULLIF(LTRIM(UPPER(TRIM(COALESCE(p.ref,''))),'0'),''),'0') = ANY($1::text[])`,
          nucleos,
        );

      for (const r of linhas) {
        const nucleoLinha = semZeros(norm(r.ref));
        const cor = norm(r.cor);
        const tam = norm(r.tamanho);
        const estoque = Number(r.total_est) || 0;
        const codigo = String(r.codigo).trim();

        for (const a of lote) {
          if (a.nucleo !== nucleoLinha || a.cor !== cor || a.tam !== tam) continue;
          const k = `${a.ref}|${a.cor}|${a.tam}`;
          const atual = melhor.get(k);
          if (
            !atual ||
            estoque > atual.estoque ||
            (estoque === atual.estoque && Number(codigo) > Number(atual.codigo))
          ) {
            melhor.set(k, { codigo, estoque });
          }
        }
      }
    }

    for (const [k, v] of melhor) out.set(k, v.codigo);
    return out;
  }

  /**
   * Os níveis 1 a 3 só mudam a condição; o resto da consulta é idêntico —
   * inclusive o desempate por estoque, que é a razão de a consulta original
   * ter JOIN com `estoque` e GROUP BY.
   */
  private async umaLinha(condicao: string, params: [string, string, string]): Promise<string | null> {
    const linhas: Array<{ codigo: string }> = await (this.prisma as any).$queryRawUnsafe(
      `SELECT p.codigo
         FROM wincred_produtos p
         LEFT JOIN wincred_estoque e ON e.codigo = p.codigo
        WHERE UPPER(TRIM(COALESCE(p.ref,''))) = UPPER(TRIM($1))
          AND ${condicao}
        GROUP BY p.codigo
        ORDER BY COALESCE(SUM(e.estoque),0) DESC, p.codigo DESC
        LIMIT 1`,
      ...params,
    );
    return linhas?.[0]?.codigo ? String(linhas[0].codigo).trim() : null;
  }

  /**
   * Versão Postgres de `resolveSkuInfo`. SKU → identidade do produto.
   *
   * O espelho guarda `codigo` SEM zero à esquerda (`normalizeCodigo`), então
   * normalizo a entrada do mesmo jeito em vez de gerar variantes de padding —
   * é o que o original faz com `skuVariants` contra a tabela crua.
   */
  async resolveSkuInfo(sku: string): Promise<{
    codigo: string;
    ref: string | null;
    cor: string | null;
    tamanho: string | null;
    descricao: string | null;
  } | null> {
    const bruto = String(sku ?? '').trim();
    if (!bruto) return null;
    const nucleo = bruto.replace(/^0+/, '') || '0';

    const linhas: Array<{
      codigo: string;
      ref: string | null;
      cor: string | null;
      tamanho: string | null;
      descricao: string | null;
    }> = await (this.prisma as any).$queryRawUnsafe(
      // ⚠️ COLUNAS ENTRE ASPAS: o Prisma criou esta tabela sem @map, então o
      // campo camelCase virou coluna camelCase no Postgres — "descricaoCompleta",
      // não descricao_completa. Sem as aspas, o Postgres rebaixa pra minúsculo
      // e a consulta falha com "column does not exist".
      `SELECT p.codigo,
              p.ref,
              p.cor,
              p.tamanho,
              COALESCE(NULLIF(TRIM(p."descricaoCompleta"),''), p."descricaoPdv") AS descricao
         FROM wincred_produtos p
        WHERE COALESCE(NULLIF(LTRIM(TRIM(p.codigo),'0'),''),'0') = $1
        LIMIT 1`,
      nucleo,
    );
    return linhas?.[0] ?? null;
  }

  /**
   * Versão Postgres de `getProductPricesBySkus`.
   *
   * ⚠️ `vendaUn` está em REAIS — NUNCA dividir por 100. O caminho do Giga
   * PARECE centavos porque o `parsePrice` de lá tira o ponto de "80.00" e
   * divide de volta; o Decimal do espelho já vem certo. Dividir aqui derrubaria
   * preço 100× — foi o bug de 01/07 que fez blusa de R$ 80 virar R$ 0,80.
   *
   * O original escolhe a coluna de preço dinamicamente (PRECOVENDA, PRECO,
   * VENDAUN…, com override por GIGA_PRECO_COL). O espelho só tem `venda_un`,
   * então divergência de preço aqui significa que o Giga está usando OUTRA
   * coluna — e é exatamente o tipo de coisa que a sombra existe pra revelar
   * antes da virada.
   */
  async getProductPricesBySkus(skus: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const limpos = [...new Set((skus ?? []).map((s) => String(s ?? '').trim()).filter(Boolean))];
    if (!limpos.length) return out;

    // núcleo (sem zero à esquerda) → SKU como o chamador pediu, pra devolver
    // a chave no formato que ele espera.
    const porNucleo = new Map<string, string>();
    for (const s of limpos) porNucleo.set(s.replace(/^0+/, '') || '0', s);

    // "vendaUn" entre aspas — ver a nota em resolveSkuInfo sobre camelCase.
    const linhas: Array<{ nucleo: string; preco: string | null }> = await (this.prisma as any).$queryRawUnsafe(
      `SELECT COALESCE(NULLIF(LTRIM(TRIM(p.codigo),'0'),''),'0') AS nucleo,
              p."vendaUn"::text AS preco
         FROM wincred_produtos p
        WHERE COALESCE(NULLIF(LTRIM(TRIM(p.codigo),'0'),''),'0') = ANY($1::text[])`,
      [...porNucleo.keys()],
    );

    for (const l of linhas) {
      const original = porNucleo.get(l.nucleo);
      const preco = Number(l.preco);
      if (original && Number.isFinite(preco) && preco > 0) out.set(original, preco);
    }
    return out;
  }

  /**
   * Versão Postgres de `getStockByRefCorTamInStore`.
   *
   * Devolve o total e TODOS os códigos daquela REF+cor+tamanho na loja — o
   * plural importa: produto recadastrado tem estoque espalhado em códigos
   * diferentes, e somar só um mostraria menos peça do que a loja tem.
   */
  async getStockByRefCorTamInStore(
    refCode: string,
    cor: string | null,
    tamanho: string | null,
    storeCode: string,
  ): Promise<{ totalQty: number; codigos: string[] }> {
    const vazio = { totalQty: 0, codigos: [] as string[] };
    const ref = String(refCode ?? '').trim();
    const loja = String(storeCode ?? '').trim();
    if (!ref || !loja) return vazio;

    // Loja com e sem zero à esquerda: o Giga grava '05' e '5' conforme a época.
    const lojas = [...new Set([loja, loja.replace(/^0+/, '') || '0', loja.padStart(2, '0')])];

    const linhas: Array<{ codigo: string; qtd: string }> = await (this.prisma as any).$queryRawUnsafe(
      `SELECT p.codigo, COALESCE(SUM(e.estoque),0)::text AS qtd
         FROM wincred_produtos p
         JOIN wincred_estoque e ON e.codigo = p.codigo AND e.loja = ANY($4::text[])
        WHERE UPPER(TRIM(COALESCE(p.ref,''))) = UPPER(TRIM($1))
          AND UPPER(TRIM(COALESCE(p.cor,''))) = UPPER(TRIM($2))
          AND UPPER(TRIM(COALESCE(p.tamanho,''))) = UPPER(TRIM($3))
        GROUP BY p.codigo`,
      ref,
      (cor || '').trim(),
      (tamanho || '').trim(),
      lojas,
    );

    if (!linhas?.length) return vazio;
    let total = 0;
    const codigos: string[] = [];
    for (const l of linhas) {
      total += Number(l.qtd) || 0;
      codigos.push(String(l.codigo).trim());
    }
    return { totalQty: total, codigos };
  }

  /* ────────────── customer-info do PDV (crediário) — Postgres ────────────── */

  /**
   * Versão Postgres da busca de cliente do `GET /pdv/customer-info`.
   *
   * PORQUÊ: o caminho do Giga dispara ATÉ 9 CONSULTAS EM CASCATA no MySQL,
   * cada uma com timeout de 10s. Quando o firewall por IP da KingHost derruba
   * o IP dinâmico do Railway, o MySQL PENDURA (não dá erro — `.catch` não
   * pega) e o PDV da loja fica parado até ~90s no meio do fechamento de um
   * crediário. É o pior ponto de latência do sistema.
   *
   * O dado já está todo aqui: `giga_clientes` é a importação COMPLETA da
   * tabela `clientes` do Giga — colunas conhecidas viram campos estruturados e
   * a LINHA ORIGINAL INTEIRA fica em `raw_json`. É `raw_json` que devolvemos
   * como `raw`, com as MESMAS CHAVES que o `SELECT *` do Giga devolveria, pra
   * o formulário de cadastro do PDV continuar preenchendo igual.
   *
   * ⚠️ COLUNAS — a pegadinha aqui é a INVERSA de `wincred_produtos`. Lá o
   * campo camelCase virou coluna camelCase e precisa de aspas
   * (p."descricaoCompleta"). Em `GigaCliente` TODOS os campos camelCase têm
   * `@map`, então as colunas são snake_case: fone_cel, fone_res, raw_json.
   * Sem aspas e em minúsculo — escrever g."foneCel" aqui quebra.
   *
   * A ORDEM das tentativas é a MESMA do Giga (CRM link → CPF → código →
   * CPF LIKE → telefone → nome), e as regras de ambiguidade também: telefone
   * e nome só valem quando a correspondência é ÚNICA (2+ = não arrisca).
   *
   * Devolve `null` quando não acha — e quem chama TEM que cair pro Giga.
   * Vazio não é resposta: pode ser ficha nova que o espelho (sync diário
   * 04:40) ainda não viu, e dizer "cliente não existe" errado faz a vendedora
   * recadastrar alguém que já tem crediário aberto.
   */
  async buscarClienteCustomerInfo(input: {
    /** só dígitos, como o controller já normalizou */
    cpf: string;
    /** 2 dígitos com zero à esquerda, ou null quando não há escopo de loja */
    loja: string | null;
    /** já em UPPER e sanitizado pelo controller */
    nome?: string;
    /** só dígitos */
    telefone?: string;
  }): Promise<{
    codigo: string;
    nome: string | null;
    loja: string | null;
    raw: any;
    viaFallback: 'telefone' | 'nome' | null;
  } | null> {
    const cpf = String(input.cpf ?? '').replace(/\D/g, '').slice(0, 14);
    const loja = input.loja ? String(input.loja).replace(/\D/g, '').padStart(2, '0').slice(0, 2) : null;
    const nome = String(input.nome ?? '').trim();
    const tel = String(input.telefone ?? '').replace(/\D/g, '');

    // 1. CRM determinístico — o Customer do Flow já conhece o (loja, codigo)
    //    do Giga via CustomerGigaLink. Resolve mesmo quando o cadastro do
    //    Wincred está com CPF vazio/errado (cadastro rápido de balcão).
    if (loja && cpf.length === 11) {
      const cpfFmt = `${cpf.slice(0, 3)}.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9)}`;
      const clientes: Array<{ gigaLinks?: Array<{ gigaLoja: string; gigaCodigo: number }> }> =
        await (this.prisma as any).customer.findMany({
          where: { cpf: { in: [cpf, cpfFmt] } },
          include: { gigaLinks: true },
          take: 20,
        });
      const link = clientes
        .flatMap((c) => c.gigaLinks || [])
        .find((l) => String(l.gigaLoja || '').replace(/\D/g, '').padStart(2, '0') === loja);
      if (link) {
        const achado = await this.umCliente(
          `${this.CODIGO_NUCLEO} = $1`,
          [String(Number(link.gigaCodigo))],
          loja,
        );
        if (achado) return { ...achado, viaFallback: null };
      }
    }

    // 2. CPF normalizado igual exato (na loja).
    if (cpf) {
      const achado = await this.umCliente(`${this.CPF_NUCLEO} = $1`, [cpf], loja);
      if (achado) return { ...achado, viaFallback: null };
    }

    // 3. Código direto (caso tenham digitado o código em vez do CPF).
    if (cpf) {
      const achado = await this.umCliente(`${this.CODIGO_NUCLEO} = $1`, [cpf.replace(/^0+/, '') || '0'], loja);
      if (achado) return { ...achado, viaFallback: null };
    }

    // 4. CPF como LIKE — pega mesmo com char escondido no meio (zero-width,
    //    BOM, tab). Aqui a normalização já tira tudo que não é dígito, então
    //    isto cobre sobretudo o cadastro que guardou CPF junto de outra coisa.
    // `$1::text`: dentro de uma concatenação o Postgres não consegue inferir o
    // tipo do parâmetro sozinho ('%' || $1 é unknown || unknown) — o cast
    // explícito evita "could not determine data type of parameter".
    if (cpf.length >= 11) {
      const achado = await this.umCliente(`${this.CPF_NUCLEO} LIKE '%' || $1::text || '%'`, [cpf], loja);
      if (achado) return { ...achado, viaFallback: null };
    }

    // Daqui pra baixo é cadastro do Wincred SEM CPF (balcão) — só com escopo
    // de loja e só quando a correspondência é ÚNICA.
    if (!loja) return null;

    // 5. Telefone: últimos 9 dígitos cobrem celular com e sem DDD.
    if (tel.length >= 8) {
      const last9 = tel.slice(-9);
      const linhas = await this.clientes(
        `(regexp_replace(COALESCE(g.fone_cel,''), '[^0-9]', '', 'g') LIKE '%' || $1::text || '%'
          OR regexp_replace(COALESCE(g.fone_res,''), '[^0-9]', '', 'g') LIKE '%' || $1::text || '%')`,
        [last9],
        loja,
        2,
      );
      if (linhas.length === 1) return { ...this.comoCliente(linhas[0]), viaFallback: 'telefone' };
      // 2+ = ambíguo. Igual ao Giga: não arrisca, segue pro nome.
    }

    // 6. Nome exato e depois LIKE — também só match único.
    if (nome.length >= 5) {
      const exato = await this.clientes(
        `UPPER(TRIM(COALESCE(g.nome,''))) = $1`,
        [nome],
        loja,
        2,
      );
      if (exato.length === 1) return { ...this.comoCliente(exato[0]), viaFallback: 'nome' };
      if (exato.length === 0) {
        const like = await this.clientes(
          `UPPER(COALESCE(g.nome,'')) LIKE '%' || $1::text || '%'`,
          [nome],
          loja,
          2,
        );
        if (like.length === 1) return { ...this.comoCliente(like[0]), viaFallback: 'nome' };
      }
    }

    return null;
  }

  /** CPF só com dígitos — normaliza o lado do BANCO igual o controller
   *  normaliza o lado da busca (o Giga guarda 108.458.788-24, 10845878824,
   *  com espaço invisível... tudo isso é o mesmo CPF). */
  private readonly CPF_NUCLEO = `regexp_replace(COALESCE(g.cpf,''), '[^0-9]', '', 'g')`;

  /** Código sem zero à esquerda — o padding do Giga é inconsistente e o
   *  CustomerGigaLink guarda Int (sem zeros). Compara núcleo com núcleo. */
  private readonly CODIGO_NUCLEO = `COALESCE(NULLIF(LTRIM(TRIM(g.codigo),'0'),''),'0')`;

  /** Loja normalizada pra 2 dígitos: o Giga grava '05' e '5' conforme a época. */
  private readonly LOJA_NUCLEO = `LPAD(COALESCE(NULLIF(regexp_replace(COALESCE(g.loja,''), '[^0-9]', '', 'g'),''),'0'), 2, '0')`;

  /**
   * Roda uma condição contra `giga_clientes`, sempre com o filtro de loja
   * quando há escopo — o CODIGO de cliente do Wincred SE REPETE entre lojas
   * (incidente Piracicaba 03/07: sem o filtro, o LIMIT 1 pegava a ficha de
   * outra loja e listava o crediário de OUTRA pessoa).
   */
  private async clientes(
    condicao: string,
    params: string[],
    loja: string | null,
    limite: number,
  ): Promise<Array<{ codigo: string; nome: string | null; loja: string | null; raw_json: any }>> {
    const filtroLoja = loja ? ` AND ${this.LOJA_NUCLEO} = $${params.length + 1}` : '';
    const args = loja ? [...params, loja] : params;
    // ORDER BY determinístico: o Giga faz LIMIT 1 sem ORDER BY (pega arbitrário).
    // LENGTH antes do texto dá a ordem numérica sem CAST — '9' não passa na
    // frente de '10' e código de 20 dígitos não estoura bigint.
    return (this.prisma as any).$queryRawUnsafe(
      `SELECT g.codigo, g.nome, g.loja, g.raw_json
         FROM giga_clientes g
        WHERE ${condicao}${filtroLoja}
        ORDER BY LENGTH(TRIM(g.codigo)), g.codigo
        LIMIT ${Math.max(1, Math.floor(limite))}`,
      ...args,
    );
  }

  private async umCliente(
    condicao: string,
    params: string[],
    loja: string | null,
  ): Promise<{ codigo: string; nome: string | null; loja: string | null; raw: any } | null> {
    const linhas = await this.clientes(condicao, params, loja, 1);
    return linhas.length ? this.comoCliente(linhas[0]) : null;
  }

  /** Linha do espelho → mesmo formato que o controller já monta do Giga. */
  private comoCliente(l: { codigo: string; nome: string | null; loja: string | null; raw_json: any }) {
    return {
      codigo: String(l.codigo ?? '').trim(),
      nome: l.nome != null ? String(l.nome).trim() : null,
      loja: l.loja != null ? String(l.loja).trim() : null,
      // A linha ORIGINAL do Giga, chave por chave. É o que vai em `raw` — o
      // formulário de cadastro do PDV lê dele.
      raw: l.raw_json ?? {},
    };
  }

  /* ──────────────────────────── utilitários ─────────────────────────────── */

  /** JSON com chaves ordenadas — comparação não pode depender da ordem. */
  private estavel(v: unknown): string {
    if (v === null || v === undefined) return 'null';
    if (typeof v !== 'object') return String(v);
    return JSON.stringify(v, (_k, val) =>
      val && typeof val === 'object' && !Array.isArray(val)
        ? Object.keys(val).sort().reduce((o: any, k) => ((o[k] = val[k]), o), {})
        : val,
    );
  }

  private curto(v: unknown): string {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return (s ?? 'null').slice(0, 200);
  }
}
