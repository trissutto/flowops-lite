/**
 * QUEM VÊ O MÓDULO IMÓVEIS — quem decide é o BACKEND: o campo `supremo` do
 * /auth/me sai da mesma lista que tranca as rotas /properties
 * (`backend/src/common/supremo.ts`). Tela e porta não podem divergir: antes
 * as duas telas tinham o e-mail do dono escrito aqui, e liberar outra pessoa
 * no backend não bastava — a tela expulsava.
 *
 * Backend anterior ao campo (deploy ainda subindo): regra antiga, só o dono.
 */
export interface MeSupremo {
  email?: string | null;
  impersonatedByEmail?: string | null;
  supremo?: boolean;
}

const DONO = 'trissutto@gmail.com';

export function podeVerImoveis(me: MeSupremo | null | undefined): boolean {
  if (!me) return false;
  if (typeof me.supremo === 'boolean') return me.supremo;
  const eDono = (e?: string | null) => String(e || '').trim().toLowerCase() === DONO;
  return eDono(me.email) || eDono(me.impersonatedByEmail);
}
