import 'server-only';
import { cookies } from 'next/headers';
import { api, ApiError } from '@/lib/api';

/**
 * CONTA DA CLIENTE — a ponte entre o site e o CRM.
 *
 * O cadastro NÃO nasce aqui: a base de clientes é a `Customer` do FlowOps
 * (mesma pessoa que compra na loja física, deduplicada por CPF). O backend já
 * tinha tudo pronto em `/customers/app` — login, esqueci a senha, endereços,
 * pedidos, cashback. O que faltava era a tela.
 *
 * ONDE MORA O TOKEN: cookie **httpOnly**. Não é localStorage de propósito —
 * qualquer script de terceiro (pixel, tag do GTM, extensão) lê localStorage, e
 * aí o token da cliente vai junto. httpOnly o JavaScript não alcança, e como
 * toda chamada passa pelo BFF (rotas /api/conta/*), o navegador nunca precisa
 * ver o token.
 */

export const COOKIE_CONTA = 'lurds_conta';

/** 30 dias — o mesmo horizonte do app; recompra da Lurd's é mensal. */
const MAX_AGE = 60 * 60 * 24 * 30;

export interface ClienteLogada {
  id: string;
  cpf?: string;
  name?: string;
  email?: string | null;
  phone?: string | null;
  [k: string]: unknown;
}

export async function lerToken(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(COOKIE_CONTA)?.value ?? null;
}

export async function gravarToken(token: string): Promise<void> {
  const jar = await cookies();
  jar.set(COOKIE_CONTA, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: MAX_AGE,
  });
}

export async function apagarToken(): Promise<void> {
  const jar = await cookies();
  jar.delete(COOKIE_CONTA);
}

/**
 * Chama o backend com o token da cliente. Devolve `null` quando não há sessão
 * ou quando o token expirou — quem chama decide se mostra o login ou segue
 * como visitante. Erro de rede NÃO vira null silencioso: sobe, porque "sem
 * sessão" e "backend fora" são coisas diferentes e confundi-las esconde
 * incidente (a lição do [[migracao-giga-3-causas]]).
 */
export async function comoCliente<T>(
  path: string,
  options: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown } = {},
): Promise<T | null> {
  const token = await lerToken();
  if (!token) return null;
  try {
    return await api<T>(path, { ...options, token });
  } catch (e) {
    if (e instanceof ApiError && (e.status === 401 || e.status === 403)) return null;
    throw e;
  }
}

/** Dados da cliente logada, ou null. */
export function getClienteLogada(): Promise<ClienteLogada | null> {
  return comoCliente<ClienteLogada>('/customers/app/me');
}
