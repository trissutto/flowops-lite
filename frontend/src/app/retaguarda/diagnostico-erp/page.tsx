'use client';

/**
 * /retaguarda/diagnostico-erp — APOSENTADA (09/26).
 *
 * A tela inspecionava o schema das tabelas do Gigasistemas (PRODVENDIDOS, pra
 * montar o auto-match da VENDA CERTA). O MySQL do Giga foi desligado em
 * 27/08/2026 e a rota `GET /products/erp-schema/produtos-vendidos` saiu do
 * backend — o botão só devolvia 404.
 *
 * A URL fica de pé só pra bookmark antigo não dar tela branca. O link do menu
 * (SideNav > Retaguarda) foi removido junto.
 */

import Link from 'next/link';
import { ArrowLeft, Database } from 'lucide-react';

export default function DiagnosticoErpAposentadoPage() {
  return (
    <div className="min-h-screen pastel-page">
      <header className="bg-brand text-white shadow">
        <div className="px-4 py-3 flex items-center gap-3 max-w-3xl mx-auto">
          <Link href="/retaguarda" className="p-2 hover:bg-white/10 rounded" title="Voltar">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="flex items-center gap-2 font-bold">
            <Database className="w-5 h-5" />
            Diagnóstico ERP
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto p-4">
        <div className="bg-white rounded-xl border border-slate-200 p-6">
          <div className="font-bold text-slate-800 mb-1">
            Diagnóstico do ERP aposentado — o Giga foi desligado em 27/08/2026
          </div>
          <p className="text-sm text-slate-600">
            Esta tela lia o schema das tabelas do Gigasistemas. Não existe mais banco do
            outro lado pra consultar.
          </p>
          <Link
            href="/retaguarda"
            className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-brand text-white font-bold hover:opacity-90"
          >
            <ArrowLeft className="w-4 h-4" />
            Voltar pra Retaguarda
          </Link>
        </div>
      </main>
    </div>
  );
}
