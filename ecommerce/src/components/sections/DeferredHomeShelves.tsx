'use client';

import { useEffect, useRef, useState } from 'react';
import { HomeShelf } from '@/components/sections/HomeShelf';
import type { VitrineHome } from '@/services/vitrines-home';

type Status = 'idle' | 'loading' | 'ready' | 'error';

async function buscarPrateleiras(signal: AbortSignal): Promise<VitrineHome[]> {
  const response = await fetch('/api/home/prateleiras', { signal });
  if (!response.ok) throw new Error(`Falha ao carregar vitrines (${response.status})`);
  const body = await response.json() as { carrosseis?: VitrineHome[] };
  return Array.isArray(body.carrosseis) ? body.carrosseis : [];
}

/**
 * Mantém as prateleiras longas fora do HTML/RSC crítico. O gatilho fica 200px
 * antes da região: numa rolagem normal os cards chegam antes de entrar na tela,
 * sem disputar rede e CPU com a imagem LCP no carregamento inicial.
 */
export function DeferredHomeShelves() {
  const markerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [vitrines, setVitrines] = useState<VitrineHome[]>([]);
  const [tentativa, setTentativa] = useState(0);

  useEffect(() => {
    const marker = markerRef.current;
    if (!marker || status !== 'idle') return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        observer.disconnect();
        setStatus('loading');
      },
      { rootMargin: '200px 0px' },
    );
    observer.observe(marker);
    return () => observer.disconnect();
  }, [status, tentativa]);

  useEffect(() => {
    if (status !== 'loading') return;
    const controller = new AbortController();
    buscarPrateleiras(controller.signal)
      .then((resultado) => {
        setVitrines(resultado);
        setStatus('ready');
      })
      .catch((error: unknown) => {
        if ((error as { name?: string })?.name !== 'AbortError') setStatus('error');
      });
    return () => controller.abort();
  }, [status, tentativa]);

  if (status === 'ready') {
    return <>{vitrines.map((vitrine) => <HomeShelf key={vitrine.id} vitrine={vitrine} />)}</>;
  }

  return (
    <div ref={markerRef} className="mx-auto w-full max-w-wide px-4 py-8 sm:px-6 sm:py-12 lg:px-10">
      {status === 'error' ? (
        <div className="rounded-md border border-border bg-surface px-5 py-8 text-center">
          <p className="text-small text-ink-soft">Não foi possível carregar o restante da vitrine.</p>
          <button
            type="button"
            onClick={() => {
              setStatus('idle');
              setTentativa((valor) => valor + 1);
            }}
            className="mt-4 rounded-pill border border-border-strong px-5 py-2.5 text-[0.6875rem] font-medium tracking-[0.14em] text-ink uppercase"
          >
            Tentar novamente
          </button>
        </div>
      ) : (
        <div className="min-h-40 animate-pulse rounded-md bg-surface-alt" aria-hidden />
      )}
    </div>
  );
}
