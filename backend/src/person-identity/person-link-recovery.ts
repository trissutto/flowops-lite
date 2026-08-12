type RecoveryTarget = 'giga_cliente' | 'crediario_parcela';

type RawPrisma = {
  $queryRawUnsafe<T = unknown>(query: string): Promise<T>;
  $executeRawUnsafe(query: string): Promise<number>;
};

const TARGET_SQL: Record<RecoveryTarget, { table: string; join: string }> = {
  giga_cliente: {
    table: 'giga_clientes',
    join: "concat_ws('|', t.loja, t.codigo) = a.entity_id",
  },
  crediario_parcela: {
    table: 'crediario_parcelas',
    join: 't.registro::text = a.entity_id',
  },
};

/**
 * Reidrata somente vínculos previamente comprovados e auditados. Os espelhos
 * do Giga fazem full-replace e, sem esta etapa, perdem `person_id` ao recriar
 * as linhas. Nunca sobrescreve vínculo existente e bloqueia qualquer entidade
 * que tenha sido auditada para mais de uma Person.
 */
export async function restoreAuditedPersonLinks(
  prisma: RawPrisma,
  target: RecoveryTarget,
): Promise<number> {
  const config = TARGET_SQL[target];
  const conflicts = await prisma.$queryRawUnsafe<Array<{ count: bigint | number | string }>>(`
    SELECT count(*) AS count
      FROM (
        SELECT entity_id
          FROM person_link_audits
         WHERE entity_type = '${target}'
         GROUP BY entity_id
        HAVING count(DISTINCT person_id) > 1
      ) conflicting
  `);
  if (Number(conflicts[0]?.count ?? 0) > 0) {
    throw new Error(`Restauração de person_id bloqueada: auditorias conflitantes em ${target}`);
  }

  return prisma.$executeRawUnsafe(`
    UPDATE ${config.table} t
       SET person_id = a.person_id
      FROM (
        SELECT entity_id, min(person_id) AS person_id
          FROM person_link_audits
         WHERE entity_type = '${target}'
         GROUP BY entity_id
        HAVING count(DISTINCT person_id) = 1
      ) a
     WHERE ${config.join}
       AND t.person_id IS NULL
  `);
}

