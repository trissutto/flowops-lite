'use client';

/**
 * Banner vermelho fixo no topo quando admin está usando o PDV
 * de uma loja em modo impersonate.
 *
 * Aparece quando:
 *  - sessionStorage.flowops_impersonate === '1'
 *  - OU GET /auth/me retorna impersonatedBy != null
 *
 * Ações:
 *  - "Sair do modo loja" → limpa sessionStorage e fecha a aba
 *    (a aba da matriz continua intacta porque ela tem outro sessionStorage)
 */

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { disconnectSocket } from '@/lib/socket';
import { ShieldAlert, X } from 'lucide-react';

type Me = {
  email?: string;
  storeName?: string | null;
  storeCode?: string | null;
  impersonatedBy?: string | null;
  impersonatedByEmail?: string | null;
  impersonatedByName?: string | null;
};

export default function ImpersonateBanner() {
  const [me, setMe] = useState<Me | null>(null);
  const [active, setActive] = useState(false);

  useEffect(() => {
    // Checa a flag local primeiro (rápido, sem rede)
    let flag = false;
    try {
      flag = window.sessionStorage.getItem('flowops_impersonate') === '1';
    } catch {
      /* noop */
    }
    if (!flag) return;
    setActive(true);

    // Confirma com o backend (e mostra "como X" no banner)
    api<Me>('/auth/me')
      .then((data) => setMe(data))
      .catch(() => {
        /* sem rede ainda, mostra banner genérico */
      });
  }, []);

  if (!active) return null;

  const exitImpersonate = () => {
    if (!confirm('Sair do modo loja? Esta aba vai fechar.')) return;
    try {
      window.sessionStorage.removeItem('flowops_token');
      window.sessionStorage.removeItem('flowops_impersonate');
    } catch {
      /* noop */
    }
    try {
      disconnectSocket();
    } catch {
      /* noop */
    }
    // Tenta fechar a aba (só funciona se foi aberta por window.open)
    try {
      window.close();
    } catch {
      /* noop */
    }
    // Fallback: se não fechou (tab principal, ou navegador bloqueou),
    // redireciona pro login
    setTimeout(() => {
      try {
        window.location.replace('/login');
      } catch {
        /* noop */
      }
    }, 200);
  };

  return (
    <div className="sticky top-0 z-50 bg-red-600 text-white shadow-lg">
      <div className="max-w-screen-2xl mx-auto px-3 py-2 flex items-center gap-3">
        <ShieldAlert className="w-5 h-5 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-bold leading-tight">
            🔴 MODO MASTER ATIVO
            {me?.storeName && (
              <span className="font-normal opacity-95">
                {' '}— você está usando o PDV de <b>{me.storeName}</b>
                {me.storeCode && <span className="opacity-80"> ({me.storeCode})</span>}
              </span>
            )}
          </div>
          {me?.impersonatedByEmail && (
            <div className="text-[11px] opacity-85 leading-tight mt-0.5">
              Sessão temporária (8h) iniciada por {me.impersonatedByName || me.impersonatedByEmail}.
              Toda venda fica registrada como desta loja.
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={exitImpersonate}
          className="shrink-0 px-3 py-1.5 rounded-md bg-white text-red-700 text-xs font-bold hover:bg-red-50 flex items-center gap-1.5"
          title="Sair do modo loja e fechar esta aba"
        >
          <X className="w-3.5 h-3.5" />
          Sair do modo loja
        </button>
      </div>
    </div>
  );
}
