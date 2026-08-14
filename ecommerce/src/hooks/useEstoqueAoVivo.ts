'use client';

import { useEffect, useRef, useState } from 'react';
import type { CorApi } from '@/services/products';

/**
 * A GRADE NÃO PODE CONGELAR NA HORA EM QUE A PÁGINA ABRIU (dono, 13/08/2026).
 *
 * O servidor já responde estoque de verdade: a PDP é rota dinâmica, o fetch da
 * peça é `no-store` e o HTML sai com `no-store` (conferido ao vivo —
 * `x-vercel-cache: MISS`). O buraco não é cache: é que HTML é uma FOTOGRAFIA.
 * Aberta a página, a grade fica parada pra sempre. Aba deixada aberta meia
 * hora — e nesta casa a cliente abre a peça, vai no WhatsApp perguntar da
 * consultora e volta — continua oferecendo o tamanho que a loja física vendeu
 * no meio disso.
 *
 * Foi o que o dono viu em 13/08: a página mostrava tamanhos compráveis da
 * VOGUE VINHO enquanto a retaguarda mostrava os 8 zerados. Os dois estavam
 * certos; a página é que era de antes.
 *
 * ── COMO ISTO SE COMPORTA ──
 *
 * Reconfere quando a aba VOLTA a aparecer (o caso do WhatsApp) e, enquanto ela
 * está à vista, a cada 45 s. Aba escondida não busca nada: navegador em
 * segundo plano não pode custar requisição, foi polling empilhado que derrubou
 * a live de 01/07.
 *
 * `no-store` no fetch e uma trava de 10 s entre buscas — voltar pra aba dispara
 * `visibilitychange` e `focus` quase juntos, e sem a trava seriam duas.
 *
 * Falhou a busca? Fica o que já estava na tela. Estoque velho por mais 45 s é
 * infinitamente melhor que grade vazia, e o guard do carrinho
 * (`carrinho-guard.service.ts`) reconfere tudo antes de fechar o pedido — esta
 * camada é conforto, não é a trava contra vender o que não existe.
 */

const INTERVALO_MS = 45_000;
const TRAVA_MS = 10_000;

/** O que muda e importa: tamanho, disponibilidade e quanto resta por cor. */
function assinatura(cores: CorApi[]): string {
  return cores
    .map((c) => `${c.nome}:${c.estoque}:${c.tamanhos.map((t) => `${t.label}${t.estoque}`).join(',')}`)
    .join('|');
}

export function useEstoqueAoVivo(slug: string, inicial: CorApi[]): CorApi[] {
  const [cores, setCores] = useState<CorApi[]>(inicial);

  /**
   * O que veio do servidor manda enquanto a página for a mesma. Sem isto, ir
   * pra outra peça pelo feed da PDP deixaria a grade da peça ANTERIOR na tela
   * até a primeira revisita.
   */
  const assinaturaServidor = assinatura(inicial);
  const ultimaAplicada = useRef(assinaturaServidor);
  useEffect(() => {
    setCores(inicial);
    ultimaAplicada.current = assinaturaServidor;
    // `inicial` é array novo a cada render do pai; a assinatura é o que
    // realmente diz se o servidor mandou outra coisa.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, assinaturaServidor]);

  const buscandoDesde = useRef(0);

  useEffect(() => {
    if (!slug) return;
    let vivo = true;

    async function reconferir() {
      if (document.visibilityState !== 'visible') return;
      const agora = Date.now();
      if (agora - buscandoDesde.current < TRAVA_MS) return;
      buscandoDesde.current = agora;

      try {
        const r = await fetch(`/api/loja/produto/${encodeURIComponent(slug)}`, {
          cache: 'no-store',
        });
        if (!r.ok) return;
        const peca = await r.json();
        const novas: CorApi[] = Array.isArray(peca?.cores) ? peca.cores : [];
        if (!vivo || !novas.length) return;

        // Só troca o estado quando a grade REALMENTE mudou: array novo a cada
        // 45 s remontaria a galeria e faria a cliente perder a foto em que
        // estava, sem nada ter mudado.
        const nova = assinatura(novas);
        if (nova === ultimaAplicada.current) return;
        ultimaAplicada.current = nova;
        setCores(novas);
      } catch {
        // Rede oscilou: fica o que está na tela e tenta de novo no próximo ciclo.
      }
    }

    const aoVoltar = () => void reconferir();
    document.addEventListener('visibilitychange', aoVoltar);
    window.addEventListener('focus', aoVoltar);
    const timer = setInterval(aoVoltar, INTERVALO_MS);

    return () => {
      vivo = false;
      document.removeEventListener('visibilitychange', aoVoltar);
      window.removeEventListener('focus', aoVoltar);
      clearInterval(timer);
    };
  }, [slug]);

  return cores;
}
