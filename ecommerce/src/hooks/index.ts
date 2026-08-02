'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * HOOKS COMPARTILHADOS
 * Comportamento que mais de um componente precisa mora aqui — nunca duplicado
 * dentro do componente. Ver docs/coding-guidelines.md.
 */

/** Trava o scroll do body enquanto um overlay está aberto. */
export function useLockScroll(locked: boolean): void {
  useEffect(() => {
    if (!locked) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [locked]);
}

/** Executa `onEscape` ao pressionar Esc (só quando `active`). */
export function useEscapeKey(active: boolean, onEscape: () => void): void {
  useEffect(() => {
    if (!active) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onEscape();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [active, onEscape]);
}

/**
 * Mantém o foco dentro do container enquanto aberto (WCAG 2.4.3).
 * Devolve o foco ao elemento que abriu o overlay ao fechar.
 */
export function useFocusTrap<T extends HTMLElement>(active: boolean) {
  const ref = useRef<T>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;

    const node = ref.current;
    if (!node) return;

    const selector =
      'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
    const focusables = () => Array.from(node.querySelectorAll<HTMLElement>(selector));

    focusables()[0]?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    node.addEventListener('keydown', onKeyDown);
    return () => {
      node.removeEventListener('keydown', onKeyDown);
      previouslyFocused.current?.focus();
    };
  }, [active]);

  return ref;
}

/** Media query reativa (SSR-safe: começa false e sincroniza no mount). */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(query);
    setMatches(mql.matches);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [query]);

  return matches;
}

/** true quando o usuário passou de `threshold` px de scroll (header sticky). */
export function useScrolled(threshold = 24): boolean {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > threshold);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [threshold]);

  return scrolled;
}

/** Debounce de valor — usado na busca pra não disparar a cada tecla. */
export function useDebounced<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}

/** Chama `onIntersect` quando o sentinela entra na viewport (infinite scroll). */
export function useIntersection(onIntersect: () => void, enabled = true) {
  const ref = useRef<HTMLDivElement>(null);
  const callback = useRef(onIntersect);
  callback.current = onIntersect;

  useEffect(() => {
    const node = ref.current;
    if (!node || !enabled) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) callback.current();
      },
      { rootMargin: '400px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [enabled]);

  return ref;
}

/** Fecha ao clicar fora do elemento (dropdown do mega menu, user menu). */
export function useClickOutside<T extends HTMLElement>(active: boolean, onOutside: () => void) {
  const ref = useRef<T>(null);
  const handler = useCallback(
    (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onOutside();
    },
    [onOutside],
  );

  useEffect(() => {
    if (!active) return;
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [active, handler]);

  return ref;
}

/**
 * `true` a partir do momento em que o elemento chega perto da viewport, e
 * nunca mais volta a `false` (o observer se desliga na primeira vez).
 *
 * Serve pra adiar mídia pesada — vídeo, sobretudo — até que ela tenha alguma
 * chance de ser vista. Diferente de `useIntersection`, que dispara um efeito,
 * aqui o valor entra no render: o `<video>` só é montado depois, então nem a
 * requisição sai enquanto a cliente estiver no topo da página.
 */
export function useNearViewport<T extends HTMLElement>(rootMargin = '300px') {
  const ref = useRef<T>(null);
  const [near, setNear] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node || near) return;
    // Sem suporte a IntersectionObserver, carrega logo — degradar pra "nunca
    // carrega" seria pior do que degradar pra "carrega cedo".
    if (typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [near, rootMargin]);

  return [ref, near] as const;
}

/** Evita hydration mismatch em componentes que dependem de localStorage. */
export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}
