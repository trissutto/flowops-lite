'use client';

/**
 * TRACKING PROVIDER — liga o Event Manager e cuida do que é automático:
 * page_view por rota, profundidade de rolagem e tempo na página.
 *
 * Fica no layout público, dentro dos Providers. Não renderiza nada além do
 * banner de consentimento.
 *
 * DECISÃO: não usamos `useSearchParams` aqui. Ele obriga a página inteira a
 * virar dinâmica ou a ficar dentro de um <Suspense> — preço alto pra ganhar a
 * query string, que dá pra ler de `window.location` dentro do efeito (que só
 * roda no cliente, então não interfere na renderização estática).
 */

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { initTracking } from '@/lib/tracking/event-manager';
import { trackPageView, trackScrollDepth, trackTimeOnPage } from '@/lib/tracking/events';
import { ConsentBanner } from './ConsentBanner';

/** Marcos de rolagem, do maior pro menor (ver o porquê em `onScroll`). */
const MARCOS = [100, 75, 50, 25] as const;

/** Abaixo disso a "leitura" foi um quique, não uma visita. */
const TEMPO_MINIMO_S = 3;

export function TrackingProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const entradaRef = useRef<number>(Date.now());
  const marcosVistosRef = useRef<Set<number>>(new Set());
  const pathRef = useRef<string>(pathname);

  // Liga uma vez por carregamento.
  useEffect(() => {
    initTracking();
  }, []);

  // Page view + reinício dos contadores a cada rota.
  useEffect(() => {
    const anterior = pathRef.current;
    const decorrido = (Date.now() - entradaRef.current) / 1000;

    // Fecha a página anterior antes de abrir a nova.
    if (anterior !== pathname && decorrido >= TEMPO_MINIMO_S) {
      trackTimeOnPage(Math.round(decorrido), anterior);
    }

    pathRef.current = pathname;
    entradaRef.current = Date.now();
    marcosVistosRef.current = new Set();

    trackPageView({ path: pathname + (typeof window !== 'undefined' ? window.location.search : ''), title: document.title });
  }, [pathname]);

  // Profundidade de rolagem.
  useEffect(() => {
    let travado = false;

    const onScroll = () => {
      // rAF simples: o evento de scroll dispara dezenas de vezes por segundo e
      // ler `scrollHeight` força layout. Uma medição por quadro basta.
      if (travado) return;
      travado = true;
      requestAnimationFrame(() => {
        travado = false;
        const doc = document.documentElement;
        const alcance = doc.scrollHeight - window.innerHeight;
        if (alcance <= 0) return;

        const percent = ((window.scrollY / alcance) * 100);
        // Do maior pro menor e sai no primeiro: rolagem rápida (ou âncora) pula
        // marcos, e disparar só o mais alto evita quatro eventos num quadro só.
        for (const marco of MARCOS) {
          if (percent >= marco) {
            if (!marcosVistosRef.current.has(marco)) {
              marcosVistosRef.current.add(marco);
              trackScrollDepth(marco, pathRef.current);
            }
            break;
          }
        }
      });
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Tempo na página quando a aba some (o único gancho confiável no mobile).
  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState !== 'hidden') return;
      const decorrido = (Date.now() - entradaRef.current) / 1000;
      if (decorrido >= TEMPO_MINIMO_S) trackTimeOnPage(Math.round(decorrido), pathRef.current);
    };
    document.addEventListener('visibilitychange', onHidden);
    return () => document.removeEventListener('visibilitychange', onHidden);
  }, []);

  return (
    <>
      {children}
      <ConsentBanner />
    </>
  );
}
