import 'server-only';

/**
 * HASH DO DADO PESSOAL antes de sair daqui — a regra que vale pra Meta e pro
 * Google igual.
 *
 * Nenhum e-mail ou telefone em texto claro atravessa a rede: as duas
 * plataformas comparam hash contra hash, então elas conseguem casar a venda
 * com o anúncio sem nunca receber o dado da cliente. Isso é o que torna
 * Advanced Matching (Meta) e Enhanced Conversions (Google) aceitáveis do ponto
 * de vista de LGPD, e é obrigatório nos dois contratos.
 *
 * A NORMALIZAÇÃO É PARTE DO CONTRATO, não detalhe. Hash é tudo-ou-nada:
 * "Maria@Gmail.com " e "maria@gmail.com" geram hashes completamente
 * diferentes, e o casamento simplesmente não acontece — sem erro, sem aviso,
 * só uma taxa de match baixa que ninguém sabe explicar. Por isso normalizar e
 * hashear moram no MESMO módulo: quem usar um sem o outro está errado.
 *
 * Estava tudo dentro de `meta-capi.ts`, privado. Saiu pra cá quando o GA4
 * passou a mandar `user_data` também — duas cópias da normalização é o começo
 * de duas normalizações diferentes.
 */

/** SHA-256 em hex via Web Crypto — funciona em Node e no runtime Edge. */
export async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export const normEmail = (v: string) => v.trim().toLowerCase();

/** Telefone: só dígitos, com DDI. Brasileiro sem 55 não casa na base da Meta. */
export function normPhone(v: string): string {
  const digits = v.replace(/\D/g, '');
  if (!digits) return '';
  return digits.startsWith('55') ? digits : `55${digits}`;
}

/** E-mail normalizado e hasheado, ou `undefined` se não houver e-mail. */
export async function hashEmail(v: string | undefined): Promise<string | undefined> {
  if (!v) return undefined;
  const norm = normEmail(v);
  return norm ? sha256(norm) : undefined;
}

/** Telefone normalizado e hasheado, ou `undefined` se não houver telefone. */
export async function hashPhone(v: string | undefined): Promise<string | undefined> {
  if (!v) return undefined;
  const norm = normPhone(v);
  return norm ? sha256(norm) : undefined;
}
