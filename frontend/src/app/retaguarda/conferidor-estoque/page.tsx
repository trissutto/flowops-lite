'use client';

/**
 * /retaguarda/conferidor-estoque — APOSENTADA (09/26).
 *
 * A tela comparava o estoque SKU a SKU, loja a loja, entre o Flow e o Giga, e
 * listava só o que discordava. Ela existia porque o Flow virou a fonte do
 * estoque em 14/07 e o pull Giga→Flow foi desligado: os dois lados podiam se
 * afastar em silêncio, e este relatório era quem enxergava.
 *
 * Não há mais dois lados. O MySQL do Giga foi desligado em 27/08/2026 e
 * `getEstoqueGigaCompleto()` devolve lista vazia com o pool trancado — o que
 * fazia `GET /stock-conferidor/conferir` abortar em 100% das chamadas com
 * "Giga não respondeu", justamente pra não acusar divergência falsa. A tela
 * nunca mais carregou um resultado.
 *
 * Os links do menu saíram na Onda 1; a URL fica de pé só pra bookmark antigo
 * (era item de menu em três lugares até 03/09). Divergência de estoque hoje se
 * resolve contando a arara e corrigindo no Flow, que é a fonte — nunca
 * copiando de outro banco. Peça que sumiu vira registro em
 * /retaguarda/pecas-extraviadas.
 */

import Link from 'next/link';
import { ArrowLeft, Scale } from 'lucide-react';

export default function ConferidorEstoqueAposentadoPage() {
  return (
    <div className="min-h-screen pastel-page">
      <header className="bg-brand text-white shadow">
        <div className="px-4 py-3 flex items-center gap-3 max-w-3xl mx-auto">
          <Link href="/retaguarda" className="p-2 hover:bg-white/10 rounded" title="Voltar">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="flex items-center gap-2 font-bold">
            <Scale className="w-5 h-5" />
            Conferidor de Estoque
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto p-4">
        <div className="bg-white rounded-xl border border-slate-200 p-6">
          <div className="font-bold text-slate-800 mb-1">
            Conferidor Flow × Giga aposentado — o Giga foi desligado em 27/08/2026
          </div>
          <p className="text-sm text-slate-600">
            A tela só fazia sentido enquanto existiam dois estoques pra comparar. Agora o Flow é o
            único, e a conferência é contar a arara e corrigir o saldo no Flow. Peça que sumiu de
            verdade vira registro em Peças extraviadas.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link
              href="/retaguarda"
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-brand text-white font-bold hover:opacity-90"
            >
              <ArrowLeft className="w-4 h-4" />
              Voltar pra Retaguarda
            </Link>
            <Link
              href="/retaguarda/pecas-extraviadas"
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-slate-300 font-bold text-slate-700 hover:bg-slate-50"
            >
              Peças extraviadas
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
