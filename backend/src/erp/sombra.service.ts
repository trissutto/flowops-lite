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
