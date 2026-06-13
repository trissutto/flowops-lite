'use client';

/**
 * /impersonate?token=XXX&dest=/minha-loja/pdv
 *
 * Página intermediária quando admin clica "Entrar como PDV" em
 * /retaguarda/lojas. Recebe o JWT temporário pela URL, grava em
 * sessionStorage (isolado por aba) e redireciona pro destino.
 *
 * Por que sessionStorage (e não localStorage):
 *  - localStorage é compartilhado entre TODAS as abas do mesmo domínio.
 *    Se gravássemos lá, abrir aba da loja iria DESLOGAR a aba da matriz.
 *  - sessionStorage é por aba: cada aba tem seu próprio token.
 *
 * A api.ts e socket.ts foram ajustadas pra priorizar sessionStorage
 * sobre localStorage — assim a aba impersonada usa o token de loja
 * e a aba original (matriz) usa o token de admin do localStorage.
 */

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2, AlertTriangle } from 'lucide-react';

export default function ImpersonatePage() {
  const router = useRouter();
  const sp = useSearchParams();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = sp?.get('token');
    const dest = sp?.get('dest') || '/minha-loja/pdv';

    if (!token) {
      setError('Token de impersonate ausente. Volte pra /retaguarda/lojas e clique em "Entrar PDV" de novo.');
      return;
    }

    try {
      // sessionStorage: isolado por aba (não vaza pra outras abas)
      window.sessionStorage.setItem('flowops_token', token);
      // marca que essa aba está em modo impersonate (pro banner saber)
      window.sessionStorage.setItem('flowops_impersonate', '1');
    } catch (e: any) {
      setError(`Não conseguiu salvar sessão: ${e?.message || e}`);
      return;
    }

    // Limpa a URL pra não vazar token em histórico/print, e redireciona.
    // replaceState antes de router.push pra não deixar essa URL no histórico.
    try {
      window.history.replaceState(null, '', '/impersonate');
    } catch {
      /* noop */
    }

    // Pequeno delay pra storage ser visível antes do componente novo montar
    setTimeout(() => {
      router.replace(dest);
    }, 50);
  }, [sp, router]);

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-4">
        <div className="max-w-md w-full bg-white border border-red-200 rounded-xl p-6 shadow">
          <div className="flex items-center gap-2 text-red-700 font-bold mb-2">
            <AlertTriangle className="w-5 h-5" />
            Erro ao entrar como loja
          </div>
          <p className="text-sm text-slate-700">{error}</p>
          <button
            onClick={() => router.replace('/retaguarda/lojas')}
            className="mt-4 w-full bg-slate-800 hover:bg-slate-900 text-white font-bold py-2 rounded-lg"
          >
            Voltar pra Lojas
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 p-4">
      <div className="text-center">
        <Loader2 className="w-8 h-8 animate-spin mx-auto text-emerald-600 mb-3" />
        <div className="text-sm font-bold text-slate-700">Entrando como loja…</div>
        <div className="text-xs text-slate-500 mt-1">Carregando PDV</div>
      </div>
    </div>
  );
}
