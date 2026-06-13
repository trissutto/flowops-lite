'use client';

/**
 * /impersonate?token=XXX&dest=/minha-loja/pdv
 *
 * Pagina intermediaria quando admin clica "Entrar PDV" em
 * /retaguarda/lojas. Recebe o JWT temporario pela URL, grava em
 * sessionStorage (isolado por aba) e redireciona pro destino.
 *
 * Por que sessionStorage (e nao localStorage):
 *  - localStorage e compartilhado entre TODAS as abas do mesmo dominio.
 *    Se gravassemos la, abrir aba da loja iria DESLOGAR a aba da matriz.
 *  - sessionStorage e por aba: cada aba tem seu proprio token.
 *
 * NOTA TECNICA Next.js 14:
 * useSearchParams() precisa estar dentro de <Suspense> para pre-render
 * estatico funcionar. Por isso o conteudo fica em componente filho.
 */

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2, AlertTriangle } from 'lucide-react';

// Pagina dinamica — nao tenta pre-render estatico (depende de URL params).
export const dynamic = 'force-dynamic';

function ImpersonateInner() {
  const router = useRouter();
  const sp = useSearchParams();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = sp?.get('token');
    const dest = sp?.get('dest') || '/minha-loja/pdv';

    if (!token) {
      setError(
        'Token de impersonate ausente. Volte pra /retaguarda/lojas e clique em "Entrar PDV" de novo.',
      );
      return;
    }

    try {
      window.sessionStorage.setItem('flowops_token', token);
      window.sessionStorage.setItem('flowops_impersonate', '1');
    } catch (e: any) {
      setError(`Nao conseguiu salvar sessao: ${e?.message || e}`);
      return;
    }

    try {
      window.history.replaceState(null, '', '/impersonate');
    } catch {
      /* noop */
    }

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
        <div className="text-sm font-bold text-slate-700">Entrando como loja...</div>
        <div className="text-xs text-slate-500 mt-1">Carregando PDV</div>
      </div>
    </div>
  );
}

function LoadingFallback() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 p-4">
      <div className="text-center">
        <Loader2 className="w-8 h-8 animate-spin mx-auto text-emerald-600 mb-3" />
        <div className="text-sm font-bold text-slate-700">Preparando...</div>
      </div>
    </div>
  );
}

export default function ImpersonatePage() {
  return (
    <Suspense fallback={<LoadingFallback />}>
      <ImpersonateInner />
    </Suspense>
  );
}
