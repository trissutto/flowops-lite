'use client';

/**
 * /retaguarda/clientes-duplicados — APOSENTADA (09/26).
 *
 * A tela unificava cadastros duplicados DO GIGA por loja (caso Livia, 03/07,
 * Piracicaba): movia parcelas da `movimento`, histórico da `caixa` e campos
 * vazios pro cadastro escolhido. O MySQL do Giga foi desligado em 27/08/2026 e
 * as rotas `/crediarios/baixa/clientes-duplicados` e `.../unificar-clientes`
 * saíram do backend — a tela inteira só dava 404.
 *
 * Quem faz esse trabalho agora é a LIMPEZA DE CLIENTES
 * (/retaguarda/clientes-limpeza), que trabalha nas fichas do Flow.
 */

import Link from 'next/link';
import { ArrowLeft, Users } from 'lucide-react';

export default function ClientesDuplicadosAposentadoPage() {
  return (
    <div className="min-h-screen pastel-page">
      <header className="bg-brand text-white shadow">
        <div className="px-4 py-3 flex items-center gap-3 max-w-3xl mx-auto">
          <Link href="/retaguarda" className="p-2 hover:bg-white/10 rounded" title="Voltar">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="flex items-center gap-2 font-bold">
            <Users className="w-5 h-5" />
            Clientes duplicados
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto p-4">
        <div className="bg-white rounded-xl border border-slate-200 p-6">
          <div className="font-bold text-slate-800 mb-1">
            Unificação de cadastros do Giga aposentada — o Giga foi desligado em 27/08/2026
          </div>
          <p className="text-sm text-slate-600">
            Cadastro repetido agora se resolve nas fichas do Flow: a Limpeza de Clientes junta as
            duplicadas da mesma loja e ainda completa o CPF que falta.
          </p>
          <Link
            href="/retaguarda/clientes-limpeza"
            className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-brand text-white font-bold hover:opacity-90"
          >
            <Users className="w-4 h-4" />
            Ir pra Limpeza de Clientes
          </Link>
        </div>
      </main>
    </div>
  );
}
