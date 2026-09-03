'use client';

/**
 * /retaguarda/auditoria-ncm — APOSENTADA (09/26).
 *
 * A tela auditava os NCMs do catálogo DO GIGA e aplicava a correção em lote
 * (UPDATE em `produtos.NCM`, com ERP_WRITE_ENABLED). O MySQL do Giga foi
 * desligado em 27/08/2026 e as rotas `/admin/ncm-audit`, `.../apply` e
 * `.../export-sql` saíram do backend — todos os botões só davam 404.
 *
 * O link do menu já tinha saído; a URL fica de pé só pra bookmark antigo. O
 * NCM da peça hoje se edita no cadastro de produtos do Flow.
 */

import Link from 'next/link';
import { ArrowLeft, FileSearch } from 'lucide-react';

export default function AuditoriaNcmAposentadaPage() {
  return (
    <div className="min-h-screen pastel-page">
      <header className="bg-brand text-white shadow">
        <div className="px-4 py-3 flex items-center gap-3 max-w-3xl mx-auto">
          <Link href="/retaguarda" className="p-2 hover:bg-white/10 rounded" title="Voltar">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="flex items-center gap-2 font-bold">
            <FileSearch className="w-5 h-5" />
            Auditoria NCM
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto p-4">
        <div className="bg-white rounded-xl border border-slate-200 p-6">
          <div className="font-bold text-slate-800 mb-1">
            Auditoria de NCM aposentada — o Giga foi desligado em 27/08/2026
          </div>
          <p className="text-sm text-slate-600">
            A correção em lote escrevia direto no catálogo do Giga. O NCM da peça agora se ajusta
            no cadastro de produtos do Flow.
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
