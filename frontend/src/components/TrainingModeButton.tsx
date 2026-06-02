'use client';

/**
 * Botão "🎓 Modo Treinamento" pro topo do PDV. Clica → modal pede senha →
 * valida no backend (POST /pdv/training/validate) → liga sessionStorage flag
 * e recarrega a tela pra começar do zero (sem venda em andamento).
 *
 * Quando o modo já está ativo, o botão não aparece (o banner global já cobre).
 */

import { useEffect, useState } from 'react';
import { api, setTrainingMode } from '@/lib/api';

export default function TrainingModeButton({ className }: { className?: string }) {
  const [active, setActive] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    try {
      setActive(sessionStorage.getItem('flowops_training') === '1');
    } catch {}
    const handler = (e: any) => setActive(!!e?.detail?.on);
    window.addEventListener('flowops:training-mode', handler);
    return () => window.removeEventListener('flowops:training-mode', handler);
  }, []);

  if (active) return null; // banner global já cobre

  async function enter() {
    setBusy(true);
    setErr('');
    try {
      await api('/pdv/training/validate', {
        method: 'POST',
        body: JSON.stringify({ password }),
      });
      setTrainingMode(true);
      setShowModal(false);
      // Recarrega pra zerar carrinho em memória e começar treino limpo
      setTimeout(() => window.location.reload(), 200);
    } catch (e: any) {
      setErr(e?.message?.includes('403') ? 'Senha incorreta' : (e?.message || 'Falha'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        onClick={() => { setPassword(''); setErr(''); setShowModal(true); }}
        className={className || 'px-3 py-1.5 bg-orange-500 hover:bg-orange-600 text-white rounded font-bold text-xs shadow flex items-center gap-1.5'}
        title="Entrar em modo treinamento — vendas não afetam estoque/caixa/Giga"
      >
        🎓 Treinamento
      </button>

      {showModal && (
        <div className="fixed inset-0 z-[9999] bg-black/60 flex items-center justify-center p-4" onClick={() => !busy && setShowModal(false)}>
          <div
            className="bg-white rounded-xl shadow-2xl max-w-sm w-full p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-center mb-4">
              <div className="text-4xl mb-2">🎓</div>
              <h2 className="text-xl font-bold text-gray-900">Modo Treinamento</h2>
              <p className="text-sm text-gray-600 mt-1">
                Ative pra praticar no PDV sem mexer em estoque, caixa, Giga ou relatórios.
              </p>
            </div>

            <div className="bg-amber-50 border border-amber-200 rounded p-3 text-xs text-amber-900 mb-4">
              <div className="font-bold mb-1">⚠️ O que NÃO acontece em modo treino:</div>
              <ul className="list-disc pl-4 space-y-0.5">
                <li>Estoque das peças não muda</li>
                <li>Nada é gravado no Giga (caixa, marcados)</li>
                <li>Não emite NFC-e</li>
                <li>Não conta em conciliação financeira</li>
                <li>Não credita cashback</li>
              </ul>
            </div>

            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') enter(); }}
              placeholder="Senha de treinamento"
              autoFocus
              disabled={busy}
              className="w-full px-3 py-2 border border-gray-300 rounded text-center font-mono tracking-wider focus:outline-none focus:ring-2 focus:ring-orange-500"
            />
            {err && (
              <div className="mt-2 text-sm text-red-600 text-center">{err}</div>
            )}

            <div className="mt-4 flex gap-2">
              <button
                onClick={() => setShowModal(false)}
                disabled={busy}
                className="flex-1 px-4 py-2 bg-gray-100 hover:bg-gray-200 rounded font-bold text-sm disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                onClick={enter}
                disabled={busy || !password}
                className="flex-1 px-4 py-2 bg-orange-500 hover:bg-orange-600 text-white rounded font-bold text-sm disabled:opacity-50"
              >
                {busy ? 'Validando...' : 'Entrar no treino'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
