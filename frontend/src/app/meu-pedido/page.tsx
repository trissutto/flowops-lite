'use client';

/**
 * /meu-pedido?ig=@dela — LINK MÁGICO da live (público).
 *
 * É o link que o ManyChat manda quando a cliente comenta "PAGAR": o backend
 * acha o carrinho DELA na live ativa (pelo @) e esta página redireciona pro
 * checkout exclusivo (/p/<code>) — peças, frete, PIX/cartão. Sem depender de
 * vínculo nem de operadora enviando link na mão (sempre dentro da janela de
 * 24h, porque ela acabou de comentar).
 */

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';

// Ignora placeholder não-resolvido do ManyChat ({{...}})
function cleanParam(v: string | null): string {
  const s = (v || '').trim();
  if (!s || s.includes('{{') || s.includes('}}')) return '';
  return s;
}

function Resolver() {
  const params = useSearchParams();
  const router = useRouter();
  const ig = cleanParam(params.get('ig')).replace(/^@/, '');
  const [state, setState] = useState<'loading' | 'sem_live' | 'sem_carrinho' | 'erro'>('loading');

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!ig) { setState('sem_carrinho'); return; }
      try {
        const r = await api<{ found: boolean; code?: string; reason?: string }>(
          `/public/live-pay/resolve-ig/${encodeURIComponent(ig)}`,
        );
        if (!alive) return;
        if (r.found && r.code) {
          router.replace(`/p/${r.code}`);
          return;
        }
        setState(r.reason === 'sem_live' ? 'sem_live' : 'sem_carrinho');
      } catch {
        if (alive) setState('erro');
      }
    })();
    return () => { alive = false; };
  }, [ig, router]);

  const card = 'w-full max-w-[420px] bg-white border border-[#EDE7D6] rounded-3xl p-6 text-center shadow-[0_10px_30px_rgba(140,115,37,0.08)]';

  if (state === 'loading') {
    return (
      <div className={card}>
        <div className="text-4xl mb-3">🛍️</div>
        <p className="text-[#2A2620] font-bold">Achando sua sacolinha…</p>
        <p className="text-[#7A7264] text-sm mt-1">{ig ? `@${ig}` : ''}</p>
      </div>
    );
  }
  return (
    <div className={card}>
      <div className="text-4xl mb-3">💜</div>
      {state === 'sem_live' ? (
        <>
          <p className="font-bold text-[#2A2620]">A live já foi encerrada.</p>
          <p className="text-[#7A7264] text-sm mt-1">
            Chama a gente no Direct que te mandamos o link certinho da sua sacolinha!
          </p>
        </>
      ) : state === 'erro' ? (
        <>
          <p className="font-bold text-[#2A2620]">Deu um soluço aqui.</p>
          <p className="text-[#7A7264] text-sm mt-1">Tenta de novo em instantes 💜</p>
        </>
      ) : (
        <>
          <p className="font-bold text-[#2A2620]">
            Não achamos uma sacolinha no seu @{ig ? ` (@${ig})` : ''} nesta live.
          </p>
          <p className="text-[#7A7264] text-sm mt-1">
            Comenta <b>CARRINHO</b> na live pra abrir a sua, ou chama a gente no Direct! 💜
          </p>
        </>
      )}
    </div>
  );
}

export default function MeuPedidoPage() {
  return (
    <div className="min-h-screen bg-[#FAFAF7] flex items-start justify-center px-4 pt-[8vh] pb-12 font-sans">
      <Suspense fallback={<div className="text-[#7A7264] text-sm mt-10">Carregando…</div>}>
        <Resolver />
      </Suspense>
    </div>
  );
}
