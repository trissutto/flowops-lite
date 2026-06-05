/**
 * Helpers de agregação de cliente POR PESSOA.
 *
 * Com a regra "1 Customer por loja Giga", uma mesma pessoa pode ter N
 * Customers no banco (1 em cada loja onde se cadastrou). Esses helpers
 * agregam dados por PESSOA (chave: personKey).
 *
 * Regra de cashback (jun/2026): saldo é DA PESSOA — disponível em qualquer
 * loja física E no site. Sempre operar sobre o saldo agregado.
 */

import { PrismaService } from '../prisma/prisma.service';

export interface CustomerAgg {
  /** Customers que compõem a pessoa (todos com mesmo personKey ou CPF). */
  customers: any[];
  /** Customer "primário" — preferência: loja da venda > primeira loja física > qualquer. */
  primary: any | null;
  /** Total acumulado entre todos. */
  ltvCents: number;
  orderCount: number;
  ticketMedioCents: number;
  /** Tier mais alto entre os Customers. */
  vipTier: 'bronze' | 'prata' | 'ouro' | 'diamante';
  /** Soma de saldo de cashback entre todos os balances. */
  cashbackBalanceCents: number;
  /** Data mais futura de expiração entre os balances. */
  cashbackExpiraEm: Date | null;
  /** Última compra (mais recente entre os Customers). */
  lastOrderAt: Date | null;
  firstOrderAt: Date | null;
  /** personKey unificada (se algum Customer tiver). */
  personKey: string | null;
}

const TIER_RANK = { bronze: 0, prata: 1, ouro: 2, diamante: 3 } as const;

/**
 * Calcula o personKey a partir de um CPF digitado.
 * Hierarquia: CPF (digits) é o mais forte.
 */
export function computePersonKeyFromCpf(cpfRaw: string | null | undefined): string | null {
  const digits = String(cpfRaw || '').replace(/\D/g, '');
  if (digits.length === 11) return `cpf:${digits}`;
  return null;
}

/**
 * Busca TODOS os Customers de uma pessoa (mesmo CPF ou mesmo personKey),
 * incluindo cashbackBalance. Retorna lista vazia se não acha.
 */
export async function findAllCustomersByCpf(
  prisma: PrismaService,
  cpfRaw: string,
): Promise<any[]> {
  const digits = String(cpfRaw || '').replace(/\D/g, '');
  if (digits.length !== 11) return [];

  const personKey = `cpf:${digits}`;
  const cpfFmt = `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`;

  // Busca por personKey OR cpf (cobre casos onde personKey ainda não foi seteado)
  const customers = await (prisma as any).customer.findMany({
    where: {
      OR: [
        { personKey },
        { cpf: digits },
        { cpf: cpfFmt },
      ],
    },
    include: {
      cashbackBalance: true,
      originStore: { select: { id: true, code: true, name: true } },
    },
  });
  return customers as any[];
}

/**
 * Agrega N Customers em 1 visão unificada da pessoa.
 *
 * @param customers — lista de Customers (com cashbackBalance incluído)
 * @param preferStoreId — se passado, marca o Customer dessa loja como "primary"
 *                       (pra escritas como LTV update e redeem).
 */
export function aggregatePerson(
  customers: any[],
  preferStoreId?: string | null,
): CustomerAgg {
  if (!customers || customers.length === 0) {
    return {
      customers: [],
      primary: null,
      ltvCents: 0,
      orderCount: 0,
      ticketMedioCents: 0,
      vipTier: 'bronze',
      cashbackBalanceCents: 0,
      cashbackExpiraEm: null,
      lastOrderAt: null,
      firstOrderAt: null,
      personKey: null,
    };
  }

  // Acumula
  let ltvCents = 0;
  let orderCount = 0;
  let cashbackBalanceCents = 0;
  let vipTier: keyof typeof TIER_RANK = 'bronze';
  let cashbackExpiraEm: Date | null = null;
  let lastOrderAt: Date | null = null;
  let firstOrderAt: Date | null = null;
  let personKey: string | null = null;

  for (const c of customers) {
    ltvCents += Number(c.ltvCents || 0);
    orderCount += Number(c.orderCount || 0);
    cashbackBalanceCents += Number(c.cashbackBalance?.balanceCents || 0);

    // Tier máximo
    const tier = (c.vipTier || 'bronze') as keyof typeof TIER_RANK;
    if (TIER_RANK[tier] > TIER_RANK[vipTier]) vipTier = tier;

    // Expiração mais futura
    const exp = c.cashbackBalance?.nextExpirationAt;
    if (exp && (!cashbackExpiraEm || new Date(exp) > cashbackExpiraEm)) {
      cashbackExpiraEm = new Date(exp);
    }

    // Datas
    if (c.lastOrderAt && (!lastOrderAt || new Date(c.lastOrderAt) > lastOrderAt)) {
      lastOrderAt = new Date(c.lastOrderAt);
    }
    if (c.firstOrderAt && (!firstOrderAt || new Date(c.firstOrderAt) < firstOrderAt)) {
      firstOrderAt = new Date(c.firstOrderAt);
    }

    if (c.personKey && !personKey) personKey = c.personKey;
  }

  const ticketMedioCents = orderCount > 0 ? Math.round(ltvCents / orderCount) : 0;

  // PRIMARY: prefere Customer da loja atual; depois originSource=giga; depois 1º
  let primary: any | null = null;
  if (preferStoreId) {
    primary = customers.find((c) => c.originStoreId === preferStoreId) || null;
  }
  if (!primary) {
    primary = customers.find((c) => c.originSource === 'giga') || customers[0];
  }

  return {
    customers,
    primary,
    ltvCents,
    orderCount,
    ticketMedioCents,
    vipTier,
    cashbackBalanceCents,
    cashbackExpiraEm,
    lastOrderAt,
    firstOrderAt,
    personKey,
  };
}
