'use client';
import { useState, useEffect } from 'react';
import { Bell, X, Sparkles, Loader2 } from 'lucide-react';
import { useWebPush } from '@/hooks/useWebPush';

/**
 * Banner sutil "🔔 Ativar promoções no celular" — aparece na home se:
 *   - Cliente está logado
 *   - Suporta push
 *   - Ainda não está inscrito
 *   - Não dispensou nos últimos 3 dias
 */
const DISMISS_KEY = 'lurds_push_dismissed_at';
const DISMISS_DAYS = 3;

export default function PushOptInBanner() {
  const { isSupported, isSubscribed, enable, loading, permission } = useWebPush();
  const [dismissed, setDismissed] = useState(true); // começa true pra não piscar

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const at = window.localStorage.getItem(DISMISS_KEY);
    if (at) {
      const days = (Date.now() - parseInt(at)) / 86400000;
      if (days < DISMISS_DAYS) {
        setDismissed(true);
        return;
      }
    }
    setDismissed(false);
  }, []);

  const handleDismiss = () => {
    window.localStorage.setItem(DISMISS_KEY, Date.now().toString());
    setDismissed(true);
  };

  const handleEnable = async () => {
    try {
      await enable();
      // Sucesso — banner some
    } catch (e: any) {
      alert(e?.message || 'Erro ao ativar');
    }
  };

  if (!isSupported || isSubscribed || dismissed) return null;
  // Se permission já é "denied", mostrar instrução diferente
  const blocked = permission === 'denied';

  return (
    <div className="card-gold-border bg-gradient-to-br from-gold/10 to-transparent flex items-start gap-3">
      <div className="shrink-0 w-10 h-10 rounded-xl bg-gold/20 flex items-center justify-center">
        <Bell className="w-5 h-5 text-gold" />
      </div>
      <div className="flex-1 min-w-0">
        <h4 className="font-bold text-sm text-white flex items-center gap-1.5">
          {blocked ? 'Notificações bloqueadas' : 'Não perca as promoções 💛'}
        </h4>
        <p className="text-xs text-cream/70 mt-0.5">
          {blocked
            ? 'Libera notificações nas configurações do navegador pra receber ofertas.'
            : 'Receba ofertas exclusivas, aviso de live e cashback expirando.'}
        </p>
        {!blocked && (
          <button
            onClick={handleEnable}
            disabled={loading}
            className="mt-2 inline-flex items-center gap-1.5 bg-gold text-ink rounded-full px-3 py-1.5 text-xs font-bold uppercase tracking-wider disabled:opacity-50"
          >
            {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
            Ativar
          </button>
        )}
      </div>
      <button
        onClick={handleDismiss}
        aria-label="Dispensar"
        className="p-1 rounded-full hover:bg-ink-700 transition"
      >
        <X className="w-4 h-4 text-cream/40" />
      </button>
    </div>
  );
}
