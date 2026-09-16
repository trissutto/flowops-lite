/**
 * SUPREMO — QUEM ENTRA NO MÓDULO IMOBILIÁRIO (/imobiliario, rotas /properties).
 *
 * Régua única porque TRÊS portas e DUAS telas perguntam a mesma coisa: os
 * controllers de /properties (cadastro, comercial, obras) e o `/auth/me`, que
 * diz pra home se mostra o hub "Imóveis" e pra /imobiliario se deixa entrar.
 * Até 16/09 o backend lia a env e as duas telas tinham o e-mail do dono
 * escrito no código — liberar uma segunda pessoa só no backend não bastava:
 * a tela expulsava com "Você não tem acesso ao módulo Imobiliário".
 *
 * Lista = SUPREMOS_FIXOS (versionados aqui) ∪ env `SUPREMO_EMAILS` (CSV,
 * opcional). O dono está SEMPRE na lista, mesmo se a env existir sem ele.
 *
 * ⚠️ Não confundir com o nível de senha SUPREMA do PDV (`auth-levels.util.ts`,
 * PIN de operador) — aquele autoriza desconto/caixa/devolução e não abre
 * imóveis; este abre imóveis e não autoriza nada no PDV.
 */
const SUPREMOS_FIXOS = [
  'trissutto@gmail.com', // dono
  'atendimento@lurds.com.br', // Taline (login dela) — liberada pelo dono em 16/09/2026
];

function normalizar(email: unknown): string {
  return String(email ?? '').trim().toLowerCase();
}

export function supremoEmails(): string[] {
  const daEnv = String(process.env.SUPREMO_EMAILS ?? '').split(',');
  return [...new Set([...SUPREMOS_FIXOS, ...daEnv].map(normalizar).filter(Boolean))];
}

export function isSupremo(email: unknown): boolean {
  const e = normalizar(email);
  return e !== '' && supremoEmails().includes(e);
}
