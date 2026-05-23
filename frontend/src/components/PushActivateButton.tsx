'use client';

/**
 * PushActivateButton — botão fixo pra ativar/ver status de Push Notification.
 *
 * Diferente do PushSubscriptionManager (banner automático que aparece UMA vez),
 * esse componente é um BOTÃO que fica SEMPRE visível no menu da loja. Mostra
 * status atual:
 *   - 🔕 inativo → "Ativar notificações" (clica → pede permissão + subscribe)
 *   - 🔔 ativo  → "Notificações ativas" (verde, info-only)
 *   - 🚫 negado → "Notificações bloqueadas" (instrução pra resetar perm)
 *   - ❌ não suportado → escondido
 *
 * Útil pra vendedora ativar push manualmente, mesmo depois de ter dispensado
 * o banner ou de ter mudado de device.
 */

import { useEffect, useState } from 'react';
import { Bell, BellOff, BellRing, X } from 'lucide-react';
import { api } from '@/lib/api';

type Status = 'unknown' | 'unsupported' | 'denied' | 'inactive' | 'active' | 'subscribing';

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

interface Props {
  /** Tamanho do botão: 'sm' (compacto pra menu) | 'lg' (card destaque) */
  variant?: 'sm' | 'lg';
  /** className extra pra ajustar layout no parent */
  className?: string;
}

export default function PushActivateButton({ variant = 'sm', className = '' }: Props) {
  const [status, setStatus] = useState<Status>('unknown');
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    if (typeof window === 'undefined') return;
    if (
      !('serviceWorker' in navigator) ||
      !('PushManager' in window) ||
      !('Notification' in window)
    ) {
      setStatus('unsupported');
      return;
    }
    if (Notification.permission === 'denied') {
      setStatus('denied');
      return;
    }
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      setStatus(sub ? 'active' : 'inactive');
    } catch {
      setStatus('inactive');
    }
  };

  useEffect(() => {
    refresh();
    // Re-checa ao focar a aba (user pode ter mudado config nas settings)
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  const activate = async () => {
    setError(null);
    setStatus('subscribing');
    try {
      if (Notification.permission === 'default') {
        const result = await Notification.requestPermission();
        if (result !== 'granted') {
          setError('Você negou a permissão');
          setStatus(result === 'denied' ? 'denied' : 'inactive');
          return;
        }
      }
      if (Notification.permission === 'denied') {
        setStatus('denied');
        return;
      }
      const keyRes = await api<{ publicKey: string | null }>('/push/vapid-public-key');
      if (!keyRes?.publicKey) {
        setError('Servidor sem chave VAPID');
        setStatus('inactive');
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(keyRes.publicKey) as BufferSource,
      });
      await api('/push/subscribe', {
        method: 'POST',
        body: JSON.stringify({ subscription: sub.toJSON() }),
      });
      setStatus('active');
    } catch (e: any) {
      console.warn('[push] activate falhou:', e?.message);
      setError(e?.message || 'Falha ao ativar');
      setStatus('inactive');
    }
  };

  const deactivate = async () => {
    setError(null);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await api('/push/unsubscribe', {
          method: 'DELETE',
          body: JSON.stringify({ endpoint: sub.endpoint }),
        }).catch(() => {});
        await sub.unsubscribe();
      }
      setStatus('inactive');
    } catch (e: any) {
      setError(e?.message || 'Falha ao desativar');
    }
  };

  // Browser não suporta — não mostra nada
  if (status === 'unsupported' || status === 'unknown') return null;

  // ── Renderização compacta (variant='sm') pra menu ──
  if (variant === 'sm') {
    if (status === 'active') {
      return (
        <button
          onClick={deactivate}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-100 hover:bg-emerald-200 text-emerald-900 rounded-lg text-xs font-bold transition ${className}`}
          title="Notificações push ativas neste device. Clique pra desativar."
        >
          <BellRing className="w-3.5 h-3.5" />
          Notificações ativas
        </button>
      );
    }
    if (status === 'denied') {
      return (
        <div
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 bg-rose-100 text-rose-900 rounded-lg text-xs font-bold ${className}`}
          title="Você bloqueou notificações. Vai em Configurações do site no navegador → Notificações → Permitir."
        >
          <BellOff className="w-3.5 h-3.5" />
          Bloqueadas
        </div>
      );
    }
    return (
      <button
        onClick={activate}
        disabled={status === 'subscribing'}
        className={`inline-flex items-center gap-1.5 px-3 py-1.5 bg-violet-600 hover:bg-violet-700 disabled:opacity-60 text-white rounded-lg text-xs font-bold transition ${className}`}
        title="Receba alerta de pedido novo no celular, mesmo com app fechado"
      >
        <Bell className="w-3.5 h-3.5" />
        {status === 'subscribing' ? 'Ativando…' : 'Ativar notificações'}
      </button>
    );
  }

  // ── Renderização CARD (variant='lg') ──
  return (
    <div className={`rounded-xl border ${className}`}>
      {status === 'active' && (
        <div className="bg-emerald-50 border-emerald-300 p-4 rounded-xl flex items-center gap-3">
          <BellRing className="w-6 h-6 text-emerald-700 flex-shrink-0" />
          <div className="flex-1">
            <div className="font-bold text-emerald-900">Notificações ativas</div>
            <div className="text-xs text-emerald-700">Este device vai receber alertas de pedido novo.</div>
          </div>
          <button
            onClick={deactivate}
            className="p-1.5 hover:bg-emerald-200 rounded-lg text-emerald-700"
            title="Desativar"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}
      {status === 'denied' && (
        <div className="bg-rose-50 border-rose-300 p-4 rounded-xl">
          <div className="flex items-center gap-3">
            <BellOff className="w-6 h-6 text-rose-700 flex-shrink-0" />
            <div className="flex-1">
              <div className="font-bold text-rose-900">Notificações bloqueadas</div>
              <div className="text-xs text-rose-700 mt-0.5">
                Você bloqueou notificações antes. Pra ativar, vai em <b>Configurações do site</b> no navegador →
                <b> Notificações</b> → <b>Permitir</b>. Depois recarrega a página.
              </div>
            </div>
          </div>
        </div>
      )}
      {(status === 'inactive' || status === 'subscribing') && (
        <div className="bg-violet-50 border-violet-300 p-4 rounded-xl flex items-center gap-3">
          <Bell className="w-6 h-6 text-violet-700 flex-shrink-0" />
          <div className="flex-1">
            <div className="font-bold text-violet-900">Ativar notificações</div>
            <div className="text-xs text-violet-700">
              Receba alerta de <b>pedido novo</b> no celular, mesmo com app fechado.
            </div>
            {error && <div className="text-xs text-rose-700 mt-1">⚠ {error}</div>}
          </div>
          <button
            onClick={activate}
            disabled={status === 'subscribing'}
            className="px-4 py-2 bg-violet-600 hover:bg-violet-700 disabled:opacity-60 text-white rounded-lg font-bold text-sm"
          >
            {status === 'subscribing' ? 'Ativando…' : 'Ativar'}
          </button>
        </div>
      )}
    </div>
  );
}
