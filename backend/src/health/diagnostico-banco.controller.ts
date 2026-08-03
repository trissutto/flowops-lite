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
}
