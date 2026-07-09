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
  const tel = cleanParam(params.get('tel')).replace(/\D/g, '');
  const [state, setState] = useState<
    'loading' | 'sem_live' | 'sem_carrinho' | 'erro' | 'challenge' | 'limite'
  >('loading');
  // Desafio: carrinho já tem celular → só a dona sabe os 4 últimos dígitos
  const [last4, setLast4] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [challengeErr, setChallengeErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!ig && !tel) { setState('sem_carrinho'); return; }
      try {
        const r = await api<{ found: boolean; code?: string; reason?: string; challenge?: string }>(
          tel
            ? `/public/live-pay/resolve-tel/${encodeURIComponent(tel)}`
            : `/public/live-pay/resolve-ig/${encodeURIComponent(ig)}`,
        );
        if (!alive) return;
        if (r.found && r.code) {
          router.replace(`/p/${r.code}`);
          return;
        }
        if (r.found && r.challenge === 'tel4') { setState('challenge'); return; }
        setState(r.reason === 'sem_live' ? 'sem_live' : 'sem_carrinho');
      } catch (e: any) {
        if (!alive) return;
        setState(String(e?.message || '').includes('429') ? 'limite' : 'erro');
      }
    })();
    return () => { alive = false; };
  }, [ig, tel, router]);

  async function confirmarLast4(e: React.FormEvent) {
    e.preventDefault();
    const d = last4.replace(/\D/g, '');
    if (d.length !== 4 || verifying) return;
    setVerifying(true); setChallengeErr(null);
    try {
      const r = await api<{ found: boolean; code?: string; reason?: string }>(
        `/public/live-pay/resolve-ig/${encodeURIComponent(ig)}/verify`,
        { method: 'POST', body: JSON.stringify({ last4: d }) },
      );
      if (r.found && r.code) { router.replace(`/p/${r.code}`); return; }
      setChallengeErr('Dígitos não conferem. Confere o número e tenta de novo 💜');
    } catch (e: any) {
      setChallengeErr(
        String(e?.message || '').includes('429')
          ? 'Muitas tentativas — espera uns minutinhos e tenta de novo 💜'
          : 'Deu um soluço aqui. Tenta de novo em instantes 💜',
      );
    } finally { setVerifying(false); }
  }

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
  if (state === 'challenge') {
    return (
      <form onSubmit={confirmarLast4} className={card}>
        <div className="text-4xl mb-3">🔐</div>
        <p className="text-[#2A2620] font-bold">Só pra confirmar que é você{ig ? `, @${ig}` : ''}!</p>
        <p className="text-[#7A7264] text-sm mt-1 mb-4">
          Digite os <b>4 últimos dígitos do seu celular</b> cadastrado.
        </p>
        <input
          value={last4}
          onChange={(e) => setLast4(e.target.value.replace(/\D/g, '').slice(0, 4))}
          placeholder="••••"
          inputMode="numeric"
          autoFocus
          className="w-32 mx-auto block text-center text-2xl tracking-[0.4em] font-bold px-3 py-3 rounded-xl bg-[#FCFBF7] border-[1.5px] border-[#E4DDCB] outline-none focus:border-[#B8912B] focus:ring-2 focus:ring-[#EBD9A6]"
        />
        {challengeErr && <p className="text-[#B4552D] text-xs mt-2">{challengeErr}</p>}
        <button
          type="submit"
          disabled={last4.replace(/\D/g, '').length !== 4 || verifying}
          className="mt-4 w-full py-3 rounded-xl text-white font-bold disabled:opacity-40"
          style={{ background: 'linear-gradient(135deg, #B8912B 0%, #8C7325 100%)' }}
        >
          {verifying ? 'Conferindo…' : 'Abrir minha sacolinha'}
        </button>
        <p className="text-[#B5AC99] text-[11px] mt-3">
          É uma proteção sua: só quem sabe seu número abre sua sacola. 💜
        </p>
      </form>
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
      ) : state === 'limite' ? (
        <>
          <p className="font-bold text-[#2A2620]">Calma, respira! 😅</p>
          <p className="text-[#7A7264] text-sm mt-1">
            Muitas tentativas seguidas. Espera uns minutinhos e tenta de novo 💜
          </p>
        </>
      ) : (
        <>
          <p className="font-bold text-[#2A2620]">
            Não achamos uma sacolinha {tel ? 'nesse celular' : `no seu @${ig ? ` (@${ig})` : ''}`} nesta live.
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
