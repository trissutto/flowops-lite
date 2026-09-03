'use client';

/**
 * /retaguarda/divergencias — APOSENTADA (09/26).
 *
 * A tela comparava os totais do Wincred (MySQL) com os do espelho (Postgres)
 * pra provar que o espelho estava fiel antes do cut-over de 30/06. O MySQL do
 * Giga foi desligado em 27/08/2026 e a rota
 * `GET /admin/wincred-mirror/divergencias` saiu do backend — não existe mais o
 * outro lado da comparação.
 *
 * O link do menu já tinha saído; a URL fica de pé só pra bookmark antigo. O
 * estado do espelho continua em /retaguarda/wincred-mirror.
 */

import Link from 'next/link';
import { ArrowLeft, AlertTriangle } from 'lucide-react';

export default function DivergenciasAposentadaPage() {
  return (
    <div className="min-h-screen pastel-page">
      <header className="bg-brand text-white shadow">
        <div className="px-4 py-3 flex items-center gap-3 max-w-3xl mx-auto">
          <Link href="/retaguarda" className="p-2 hover:bg-white/10 rounded" title="Voltar">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="flex items-center gap-2 font-bold">
            <AlertTriangle className="w-5 h-5" />
            Divergências Wincred × espelho
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto p-4">
        <div className="bg-white rounded-xl border border-slate-200 p-6">
          <div className="font-bold text-slate-800 mb-1">
            Comparação aposentada — o Giga foi desligado em 27/08/2026
          </div>
          <p className="text-sm text-slate-600">
            Não há mais Wincred pra comparar com o espelho. O Flow é a fonte do estoque desde
            14/07/2026.
          </p>
          <Link
            href="/retaguarda/wincred-mirror"
            className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-brand text-white font-bold hover:opacity-90"
          >
            Ver o estado do espelho
          </Link>
        </div>
      </main>
    </div>
  );
}
