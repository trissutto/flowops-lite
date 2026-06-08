'use client';

import { useEffect, useState } from 'react';
import { Bell, X, Sparkles } from 'lucide-react';
import { useWebPush } from '@/hooks/useWebPush';
import { isLoggedIn } from '@/lib/api';

/**
 * PushPrePrompt — modal in-app perguntando ANTES de chamar Notification.requestPermission.
 *
 * Problema clássico: no iPhone, você tem UMA chance única de pedir permissão.
 * Se a cliente clicar "Não Permitir" no dialog nativo, NUNCA MAIS o navegador
 * pede de novo — ela tem que ir nos Ajustes manualmente.
 *
 * Solução: pre-prompt in-app. Mostra um modal NOSSO antes do nativo da Apple.
 *   - Cliente clica "Sim, claro" → AÍ chamamos requestPermission (já decidida = aceita)
 *   - Cliente clica "Agora não" → NÃO chamamos, preservamos a chance única
 *
 * Resultado: dobra/triplica conversão de push.
 *
 * Uso (in-context — pedir no momento certo, não em /conta):
 *   <PushPrePrompt
 *     context="order-placed"
 *     reward="Te aviso na hora que seu pedido for postado 📦"
 *     onClose={() => setShow(false)}
 *   />
 *
 * Contextos sugeridos:
 *   - "order-placed"   → após criar pedido
 *   - "favorited"      → após adicionar favorito
 *   - "cashback-earned" → após cashback cair
 *   - "live-coming"    → home (lembrança próxima live)
 *   - "general"        → home depois de 3 visitas
 */

const DISMISS_KEY_PREFIX = 'lurds_push_pre_dismissed_';
const DISMISS_HOURS = 48;

type Props = {
  context: 'order-placed' | 'favorited' | 'cashback-earned' | 'live-coming' | 'general';
  reward: string;
  onClose: () => void;
  /** Se true, ignora se já dispensou — força mostrar (ex: clique manual em botão) */
  force?: boolean;
};

export default function PushPrePrompt({ context, reward, onClose, force }: Props) {
  const { isSupported, isSubscribed, permission, loading, enable, needsInstallFirst } = useWebPush();
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    // GUARD CRÍTICO: não mostra pra cliente não logada
    if (!isLoggedIn()) return;
    // Não mostra se: já tá inscrita, não suporta, ou iOS sem PWA (mostra outro fluxo)
    if (isSubscribed || !isSupported || needsInstallFirst) return;
    // Não mostra se cliente JÁ CONCEDEU permissão antes (mesmo que sub backend tenha falhado).
    // Se ela já clicou "Permitir" no dialog nativo, NUNCA mais perguntamos —
    // resub silenciosa fica por conta do useWebPush no mount.
    if (permission === 'granted') return;
    // Não mostra se já negou no nativo (permission === 'denied')
    if (permission === 'denied') return;
    // Não mostra se dispensou recentemente nesse contexto
    if (!force) {
      const dismissed = window.localStorage.getItem(DISMISS_KEY_PREFIX + context);
      if (dismissed && Date.now() - parseInt(dismissed) < DISMISS_HOURS * 3600 * 1000) {
        return;
      }
    }
    setOpen(true);
  }, [isSubscribed, isSupported, permission, needsInstallFirst, force, context]);

  const handleYes = async () => {
    setErr(null);
    try {
      await enable();
      // Marca em TODOS os contextos como dispensado — não pergunta de novo
      // independente do gatilho (order-placed, cashback, geral, etc).
      ['order-placed', 'favorited', 'cashback-earned', 'live-coming', 'general'].forEach((ctx) => {
        window.localStorage.setItem(DISMISS_KEY_PREFIX + ctx, String(Date.now() + 1000 * 60 * 60 * 24 * 365));
      });
      setSuccess(true);
      setTimeout(() => {
        setOpen(false);
        onClose();
      }, 1800);
    } catch (e: any) {
      if (e?.message === 'LOGIN_REQUIRED') {
        setErr('Faz login pra continuar');
        return;
      }
      setErr(e?.message || 'Erro ao ativar');
    }
  };

  const handleNo = () => {
    window.localStorage.setItem(DISMISS_KEY_PREFIX + context, String(Date.now()));
    setOpen(false);
    onClose();
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[200] bg-ink/85 backdrop-blur-sm flex items-end sm:items-center justify-center"
      onClick={handleNo}
    >
      <div
        className="w-full max-w-md mx-4 mb-4 sm:mb-0 bg-ink-800 border border-gold/40 rounded-3xl p-6 shadow-2xl animate-slide-up"
        onClick={(e) => e.stopPropagation()}
        style={{ marginBottom: 'calc(1rem + env(safe-area-inset-bottom))' }}
      >
        <button
          aria-label="Fechar"
          onClick={handleNo}
          className="absolute top-3 right-3 p-2 rounded-full bg-ink-700"
        >
          <X className="w-4 h-4 text-cream" />
        </button>

        {success ? (
          <div className="text-center py-4">
            <div className="text-5xl mb-2">🎉</div>
            <h3 className="font-serif text-xl font-black text-gold">
              Pronto! Avisamos por aqui
            </h3>
            <p className="text-sm text-cream/70 mt-2">
              Não vai perder nada mais 💛
            </p>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-3 mb-3">
              <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-gold via-gold-light to-gold flex items-center justify-center shadow-gold">
                <Bell className="w-7 h-7 text-ink" />
              </div>
              <div className="flex-1">
                <h3 className="font-serif text-lg font-black text-gold leading-tight">
                  Quer receber avisos?
                </h3>
              </div>
            </div>

            <p className="text-sm text-cream/85 leading-relaxed mb-1">
              {reward}
            </p>

            <div className="mt-3 p-3 bg-gold/10 border border-gold/30 rounded-xl text-xs text-cream/80 flex gap-2">
              <Sparkles className="w-4 h-4 text-gold shrink-0 mt-0.5" />
              <div>
                Você só recebe coisas importantes: pedido, cashback, promoções de verdade. <strong className="text-gold">Sem spam.</strong>
              </div>
            </div>

            {err && (
              <div className="mt-3 p-2 bg-rose-900/30 border border-rose-700/50 rounded text-xs text-rose-200">
                {err}
              </div>
            )}

            <div className="mt-5 space-y-2">
              <button
                onClick={handleYes}
                disabled={loading}
                className="btn-gold-lg w-full"
              >
                {loading ? 'Ativando...' : 'Sim, quero receber 💛'}
              </button>
              <button
                onClick={handleNo}
                className="w-full py-3 text-sm text-cream/50 underline"
              >
                Agora não
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
