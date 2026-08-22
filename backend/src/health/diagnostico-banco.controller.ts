import { Controller, ForbiddenException, Get, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { PrismaService } from '../prisma/prisma.service';

/**
 * RAIO-X DO POSTGRES — perguntas fechadas, sem SQL aberto.
 *
 * Nasceu de duas perguntas de 03/08 que ninguém conseguia responder de fora:
 * "por que o banco cresceu tanto?" e "por que gravar cliente dá 500?". A
 * resposta estava a uma consulta de distância, mas não havia como fazê-la sem
 * abrir o terminal do servidor.
 *
 * NÃO aceita SQL do cliente de propósito: endpoint que executa consulta livre
 * é porta destrancada — basta um token de admin vazado. Aqui as perguntas são
 * fixas, todas de leitura, e o que volta é metadado (tamanho, constraint,
 * índice), nunca dado de cliente.
 */
@Controller('diagnostico/banco')
@UseGuards(JwtAuthGuard)
export class DiagnosticoBancoController {
  constructor(private readonly prisma: PrismaService) {}

  private admin(req: any) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Só admin');
  }

  /** Tamanho do banco e as maiores tabelas — responde "por que cresceu". */
  @Get('tamanho')
  async tamanho(@Req() req: any) {
    this.admin(req);
    const [banco] = await this.prisma.$queryRawUnsafe<Array<{ tamanho: string }>>(
      `SELECT pg_size_pretty(pg_database_size(current_database())) AS tamanho`,
    );
    const tabelas = await this.prisma.$queryRawUnsafe<
      Array<{ tabela: string; total: string; dados: string; indices: string; linhas: number; mortas: number }>
    >(
      `SELECT c.relname                                              AS tabela,
              pg_size_pretty(pg_total_relation_size(c.oid))          AS total,
              pg_size_pretty(pg_table_size(c.oid))                   AS dados,
              pg_size_pretty(pg_indexes_size(c.oid))                 AS indices,
              COALESCE(s.n_live_tup, 0)::int                         AS linhas,
              COALESCE(s.n_dead_tup, 0)::int                         AS mortas
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
        WHERE n.nspname = 'public' AND c.relkind = 'r'
        ORDER BY pg_total_relation_size(c.oid) DESC
        LIMIT 20`,
    );
    return { banco: banco?.tamanho, tabelas };
  }

  /**
   * Constraints, índices e triggers de uma tabela — responde "por que a
   * escrita falha". Índice inválido e constraint não validada são invisíveis
   * pela aplicação e derrubam UPDATE com erro genérico.
   */
  @Get('tabela')
  async tabela(@Req() req: any, @Query('nome') nome: string) {
    this.admin(req);
    const alvo = String(nome || '').replace(/[^a-zA-Z0-9_]/g, '');
    if (!alvo) throw new ForbiddenException('nome da tabela obrigatório');

    const constraints = await this.prisma.$queryRawUnsafe(
      `SELECT conname AS nome, contype AS tipo, convalidated AS validada,
              pg_get_constraintdef(oid) AS definicao
         FROM pg_constraint WHERE conrelid = $1::regclass ORDER BY contype`,
      alvo,
    );
    const indices = await this.prisma.$queryRawUnsafe(
      `SELECT indexrelid::regclass::text AS indice, indisvalid AS valido,
              indisready AS pronto, indisunique AS unico
         FROM pg_index WHERE indrelid = $1::regclass`,
      alvo,
    );
    const triggers = await this.prisma.$queryRawUnsafe(
      `SELECT tgname AS nome, tgenabled AS estado
         FROM pg_trigger WHERE tgrelid = $1::regclass AND NOT tgisinternal`,
      alvo,
    );
    return { tabela: alvo, constraints, indices, triggers };
  }

  /**
   * QUEM ESTÁ SENDO VARRIDO — responde "por que a consulta demora".
   *
   * ── A PERGUNTA (22/08/2026) ──
   *
   * `/api/products/store-search` — a busca de produto que a vendedora usa com
   * a cliente na frente — leva **2,1s de mediana**. A tabela `wincred_produtos`
   * tem 353 mil linhas e um índice em `ref`, então "parece" resolvido.
   *
   * Só que o Prisma traduz `startsWith` pra `LIKE 'termo%'`, e no Postgres
   * `LIKE` com prefixo **só usa índice btree se a collation do banco for C/POSIX
   * ou se o índice tiver sido criado com `varchar_pattern_ops`**. Com collation
   * normal (pt_BR/en_US.UTF-8), o índice é ignorado e vira varredura completa —
   * o índice existe, aparece na lista, e não serve pra essa consulta.
   *
   * ── COMO ISTO RESPONDE ──
   *
   * `seq_scan` vs `idx_scan` do `pg_stat_user_tables` não deixa dúvida: é a
   * contagem real de varreduras desde o último reset. Tabela grande com
   * `seq_scan` alto e `linhasPorVarredura` na casa das centenas de milhares
   * está sendo lida inteira, toda vez.
   *
   * `collation` no retorno é o que decide se `LIKE` pode ou não usar índice.
   *
   * Tudo metadado do próprio Postgres — nenhuma linha de cliente sai daqui.
   */
  @Get('varreduras')
  async varreduras(@Req() req: any) {
    this.admin(req);

    const [banco] = await this.prisma.$queryRawUnsafe<
      Array<{ collation: string; ctype: string; versao: string }>
    >(
      `SELECT datcollate AS collation, datctype AS ctype, version() AS versao
         FROM pg_database WHERE datname = current_database()`,
    );

    /**
     * `LIKE 'x%'` só usa btree se a collation for C/POSIX. Fora disso, o índice
     * precisa de `varchar_pattern_ops` — e é isso que a lista `indicesDeUmPrefixo`
     * abaixo mostra que existe (ou não).
     */
    const likeUsaIndice = /^(C|POSIX)(\.|$)/i.test(String(banco?.collation || ''));

    const tabelas = await this.prisma.$queryRawUnsafe<
      Array<{
        tabela: string;
        varreduraCompleta: number;
        porIndice: number;
        linhas: number;
        linhasLidasVarrendo: number;
      }>
    >(
      `SELECT relname                              AS tabela,
              COALESCE(seq_scan, 0)::int           AS "varreduraCompleta",
              COALESCE(idx_scan, 0)::int           AS "porIndice",
              COALESCE(n_live_tup, 0)::int         AS linhas,
              COALESCE(seq_tup_read, 0)::bigint    AS "linhasLidasVarrendo"
         FROM pg_stat_user_tables
        WHERE COALESCE(n_live_tup, 0) > 1000
        ORDER BY COALESCE(seq_tup_read, 0) DESC
        LIMIT 20`,
    );

    /** Índices que NUNCA foram usados — custam escrita e não pagam leitura. */
    const indicesInuteis = await this.prisma.$queryRawUnsafe(
      `SELECT relname AS tabela, indexrelname AS indice,
              pg_size_pretty(pg_relation_size(indexrelid)) AS tamanho
         FROM pg_stat_user_indexes
        WHERE idx_scan = 0
          AND pg_relation_size(indexrelid) > 1048576
        ORDER BY pg_relation_size(indexrelid) DESC
        LIMIT 20`,
    );

    /** Os índices que servem pra `LIKE 'prefixo%'` em collation normal. */
    const indicesDeUmPrefixo = await this.prisma.$queryRawUnsafe(
      `SELECT c.relname AS tabela, i.relname AS indice, am.amname AS tipo
         FROM pg_index x
         JOIN pg_class c  ON c.oid = x.indrelid
         JOIN pg_class i  ON i.oid = x.indexrelid
         JOIN pg_am   am  ON am.oid = i.relam
         JOIN pg_opclass op ON op.oid = ANY(x.indclass::oid[])
        WHERE op.opcname IN ('varchar_pattern_ops', 'text_pattern_ops', 'bpchar_pattern_ops')
        ORDER BY c.relname`,
    );

    return {
      banco: {
        collation: banco?.collation,
        ctype: banco?.ctype,
        /**
         * false = todo `startsWith`/`LIKE 'x%'` do Prisma ignora os índices
         * normais e varre a tabela inteira, por mais índice que ela tenha.
         */
        likeDePrefixoUsaIndiceComum: likeUsaIndice,
      },
      /** As linhas mais lidas por varredura completa — o topo é o gargalo. */
      tabelas: tabelas.map((t) => ({
        ...t,
        linhasPorVarredura:
          t.varreduraCompleta > 0
            ? Math.round(Number(t.linhasLidasVarrendo) / t.varreduraCompleta)
            : 0,
      })),
      indicesDeUmPrefixo,
      indicesInuteis,
    };
  }
}
