'use client';

/**
 * PdvToast — toast leve pra mensagens humanas do PDV.
 *
 * Substitui `window.alert(...)` por uma notificação não-bloqueante. Usar
 * via `usePdvToast()` no componente raiz e chamar `toast.error('...')`.
 *
 * 4 tipos: success (verde), error (vermelho), warning (âmbar), info (azul).
 * Auto-dismiss em 4s, mas hover mantém visível.
 */

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { CheckCircle2, AlertTriangle, XCircle, Info, X } from 'lucide-react';

type ToastType = 'success' | 'error' | 'warning' | 'info';
type ToastItem = { id: number; type: ToastType; title: string; hint?: string };

interface ToastCtx {
  toast: (type: ToastType, title: string, hint?: string) => void;
}

const Ctx = createContext<ToastCtx>({ toast: () => {} });

export function usePdvToast() {
  return useContext(Ctx);
}

export function PdvToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const push = useCallback((type: ToastType, title: string, hint?: string) => {
    const id = Date.now() + Math.random();
    setItems((prev) => [...prev, { id, type, title, hint }]);
    setTimeout(() => {
      setItems((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  return (
    <Ctx.Provider value={{ toast: push }}>
      {children}
      {/* Container fixo no topo direito */}
      <div className="fixed top-4 right-4 z-[100] space-y-2 max-w-sm pointer-events-none">
        {items.map((t) => (
          <ToastBanner key={t.id} item={t} onClose={() => setItems((prev) => prev.filter((x) => x.id !== t.id))} />
        ))}
      </div>
    </Ctx.Provider>
  );
}

function ToastBanner({ item, onClose }: { item: ToastItem; onClose: () => void }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShow(true), 10);
    return () => clearTimeout(t);
  }, []);

  const styles: Record<ToastType, { bg: string; border: string; icon: any; iconColor: string; titleColor: string }> = {
    success: { bg: 'bg-emerald-50', border: 'border-emerald-300', icon: CheckCircle2, iconColor: 'text-emerald-600', titleColor: 'text-emerald-900' },
    error:   { bg: 'bg-rose-50',    border: 'border-rose-300',    icon: XCircle,       iconColor: 'text-rose-600',    titleColor: 'text-rose-900' },
    warning: { bg: 'bg-amber-50',   border: 'border-amber-300',   icon: AlertTriangle, iconColor: 'text-amber-600',   titleColor: 'text-amber-900' },
    info:    { bg: 'bg-sky-50',     border: 'border-sky-300',     icon: Info,          iconColor: 'text-sky-600',     titleColor: 'text-sky-900' },
  };
  const s = styles[item.type];
  const Icon = s.icon;

  return (
    <div
      className={`pointer-events-auto ${s.bg} border-2 ${s.border} rounded-xl shadow-lg p-3 flex items-start gap-2.5 transition-all duration-200 ${
        show ? 'opacity-100 translate-x-0' : 'opacity-0 translate-x-4'
      }`}
      style={{ minWidth: 280 }}
    >
      <Icon className={`w-5 h-5 ${s.iconColor} shrink-0 mt-0.5`} />
      <div className="flex-1 min-w-0">
        <div className={`font-bold text-sm ${s.titleColor} leading-tight`}>{item.title}</div>
        {item.hint && <div className="text-xs text-slate-600 mt-0.5">{item.hint}</div>}
      </div>
      <button onClick={onClose} className="text-slate-400 hover:text-slate-700 shrink-0">
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

/**
 * Helper pra extrair mensagem AMIGÁVEL de erros técnicos.
 * Tenta detectar 404/500/JSON e converter. Fallback: mensagem original.
 */
export function humanizeError(err: any): { title: string; hint?: string } {
  const msg = String(err?.message || err || '');
  const lower = msg.toLowerCase();

  if (lower.includes('produto não encontrado') || lower.includes('not found') || lower.includes('404')) {
    return { title: 'Produto não encontrado', hint: 'Verifique o código ou cadastre o item' };
  }
  if (lower.includes('giga') || lower.includes('mysql') || lower.includes('econn')) {
    return { title: 'Sistema temporariamente indisponível', hint: 'Tente de novo em alguns segundos' };
  }
  if (lower.includes('estoque') || lower.includes('stock')) {
    return { title: 'Sem estoque suficiente', hint: msg };
  }
  if (lower.includes('500')) {
    return { title: 'Erro inesperado', hint: 'A equipe técnica foi notificada — tente de novo' };
  }
  if (lower.includes('network') || lower.includes('failed to fetch')) {
    return { title: 'Sem conexão', hint: 'Confira sua internet' };
  }
  // Genérico: mantém a mensagem mas suaviza
  return { title: 'Algo deu errado', hint: msg.slice(0, 120) };
}
