'use client';

/**
 * Banner laranja gigante exibido no topo de qualquer tela do PDV quando o
 * modo treinamento está ativo. Vendedora vê constantemente que está em
 * simulação — nada do que ela fizer vai mexer em estoque, caixa, Giga ou
 * relatórios.
 *
 * Ativação:
 *  - Botão "🎓 Modo Treinamento" no PDV/topbar abre modal pra digitar senha
 *  - Senha bate com TREINAMENTO_PASSWORD no backend (POST /pdv/training/validate)
 *  - sessionStorage.flowops_training = '1' → todas as chamadas API mandam
 *    header x-training-mode: 1 e o backend pula integrações reais
 *
 * Saída:
 *  - Clica em "Sair do treino" no banner
 *  - Logout (fecha aba também limpa sessionStorage)
 */

import { useEffect, useState } from 'react';
import { setTrainingMode } from '@/lib/api';

export default function TrainingModeBanner() {
  const [on, setOn] = useState(false);

  useEffect(() => {
    // Lê estado inicial e escuta mudanças
    const sync = () => {
      try {
        setOn(sessionStorage.getItem('flowops_training') === '1');
      } catch { setOn(false); }
    };
    sync();
    const handler = (e: any) => setOn(!!e?.detail?.on);
    window.addEventListener('flowops:training-mode', handler);
    // Storage event pro caso de outra aba mudar (raro mas seguro)
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener('flowops:training-mode', handler);
      window.removeEventListener('storage', sync);
    };
  }, []);

  if (!on) return null;

  return (
    <div
      className="fixed top-0 left-0 right-0 z-[9998] bg-gradient-to-r from-orange-500 via-amber-500 to-orange-500 text-white shadow-lg animate-pulse-slow"
      style={{ paddingTop: 'env(safe-area-inset-top)' }}
    >
      <div className="max-w-screen-2xl mx-auto px-4 py-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <span className="text-2xl">🎓</span>
          <div className="flex-1 min-w-0">
            <div className="font-black text-sm md:text-base leading-tight">
              MODO TREINAMENTO ATIVO
            </div>
            <div className="text-[10px] md:text-xs leading-tight opacity-95">
              Nada será gravado em estoque, caixa, Giga ou relatórios — você pode praticar à vontade.
            </div>
          </div>
        </div>
        <button
          onClick={() => {
            if (confirm('Sair do modo treinamento?\n\nVendas seguintes voltam a ser REAIS.')) {
              setTrainingMode(false);
              // Reload pra resetar carrinho/venda aberta em memória do PDV
              window.location.reload();
            }
          }}
          className="px-3 py-1.5 bg-white text-orange-700 rounded font-bold text-xs md:text-sm hover:bg-orange-50 shadow"
        >
          Sair do treino
        </button>
      </div>
      <style jsx global>{`
        @keyframes pulse-slow {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.92; }
        }
        .animate-pulse-slow {
          animation: pulse-slow 2.5s ease-in-out infinite;
        }
        /* Compensa o banner empurrando o conteúdo principal pra baixo */
        body:has(.training-banner-host) {
          padding-top: 56px;
        }
      `}</style>
    </div>
  );
}
