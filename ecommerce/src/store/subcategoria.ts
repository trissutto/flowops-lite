'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { create } from 'zustand';

/**
 * SUBCATEGORIA ATIVA (`?sub=manga-curta`) — fora do `useSearchParams` de
 * propósito.
 *
 * A página de categoria voltou a ser ISR (06/09): o servidor entrega a
 * categoria INTEIRA pela CDN e o recorte do chip é 100% do navegador. Ler a
 * URL com `useSearchParams` num componente pré-renderizado obrigaria um
 * Suspense por cima — e o fallback do Suspense é o que iria pro HTML
 * estático: a grade sumiria justamente do HTML que é o motivo do ISR.
 *
 * Então a URL continua sendo o endereço (dá pra mandar no WhatsApp, o botão
 * voltar funciona), mas quem a lê é este store: semeado do `location` no
 * mount, atualizado pelo chip via `history.pushState` (o Next 15 aceita) e
 * pelo `popstate` no voltar/avançar. O HTML do servidor nasce sempre com
 * "Tudo" ativo — quem chega por link com `?sub=` vê o recorte aplicar logo
 * após a hidratação.
 *
 * ⚠️ O valor carrega o PATHNAME junto (revisão 06/09): o store é global e
 * sobrevive à navegação client-side — sem a trava, sair de
 * `/categoria/blusas?sub=x` pra `/categoria/vestidos` fazia o PRIMEIRO
 * render da página nova usar o sub velho (fetch inútil + initialData
 * pulada + chip errado por um frame). Com a trava, sub de outra página é
 * ignorado até o effect ressincronizar.
 */
type SubcategoriaState = {
  sub?: string;
  /** Pathname pra quem o `sub` vale — sub de outra página não conta. */
  path?: string;
  setSub: (sub: string | undefined, path: string) => void;
};

export const useSubcategoriaStore = create<SubcategoriaState>((set) => ({
  sub: undefined,
  path: undefined,
  setSub: (sub, path) => set({ sub, path }),
}));

function lerSubDaUrl(): string | undefined {
  const v = new URLSearchParams(window.location.search).get('sub');
  const limpo = v?.trim();
  return limpo ? limpo : undefined;
}

/** O chip chama isto: troca a URL sem round-trip e avisa quem escuta. */
export function navegarParaSub(sub: string | null) {
  const q = new URLSearchParams(window.location.search);
  if (sub) q.set('sub', sub);
  else q.delete('sub');
  const qs = q.toString();
  window.history.pushState(null, '', qs ? `?${qs}` : window.location.pathname);
  useSubcategoriaStore.getState().setSub(sub ?? undefined, window.location.pathname);
}

/**
 * Espelha URL → store e devolve o sub VÁLIDO pra página atual.
 *
 * `ativo: false` desliga tudo (devolve undefined e não sincroniza) — só a
 * página de CATEGORIA lê `?sub=`; sem o gate, uma URL suja tipo
 * `/novidades?sub=x` passaria a filtrar a grade em silêncio, sem chip pra
 * desfazer (mudança de comportamento que ninguém pediu).
 *
 * Sincroniza no mount E na troca de pathname (cobre navegação entre
 * categorias sem remount) e no `popstate` (voltar/avançar do navegador).
 */
export function useSubcategoriaDaUrl(ativo: boolean): string | undefined {
  const pathname = usePathname();
  const sub = useSubcategoriaStore((s) => s.sub);
  const path = useSubcategoriaStore((s) => s.path);
  const setSub = useSubcategoriaStore((s) => s.setSub);

  useEffect(() => {
    if (!ativo) return;
    setSub(lerSubDaUrl(), window.location.pathname);
    const aoVoltar = () => setSub(lerSubDaUrl(), window.location.pathname);
    window.addEventListener('popstate', aoVoltar);
    return () => window.removeEventListener('popstate', aoVoltar);
  }, [ativo, pathname, setSub]);

  if (!ativo) return undefined;
  return path === pathname ? sub : undefined;
}
