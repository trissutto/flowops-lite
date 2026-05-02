'use client';

import Link from 'next/link';
import { ArrowLeft, Printer, Check } from 'lucide-react';

/**
 * Instruções de configuração de impressora ELGIN — Plano A.
 *
 * Plano A (atual): Chrome lembra a última impressora escolhida por origem.
 * Vendedora escolhe ELGIN UMA VEZ, próximas vendas é só Enter.
 * Sem QZ Tray, sem instalação extra, sem setup de IP da impressora.
 *
 * Plano B (futuro): app desktop dedicado com auto-update.
 */
export default function ConfigImpressoraPage() {
  return (
    <div className="max-w-2xl mx-auto p-4 space-y-4">
      <div className="flex items-center gap-3">
        <Link
          href="/minha-loja/pdv"
          className="text-slate-600 hover:text-slate-900"
        >
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <h1 className="text-xl font-bold text-slate-800 flex items-center gap-2">
          <Printer className="w-5 h-5" /> Como imprimir cupom NFC-e na ELGIN
        </h1>
      </div>

      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-sm text-blue-900">
        <strong>Setup rápido (5 minutos por loja):</strong> instala a ELGIN como impressora normal no Windows e ensina a vendedora a escolher ela <em>uma única vez</em> no diálogo do Chrome. Pronto.
      </div>

      {/* Passo 1 */}
      <div className="bg-white border rounded-lg p-4 space-y-2">
        <div className="font-bold text-slate-800 flex items-center gap-2">
          <span className="bg-emerald-600 text-white rounded-full w-6 h-6 flex items-center justify-center text-xs">1</span>
          Instala a ELGIN no Windows (uma vez por PC)
        </div>
        <ul className="text-sm text-slate-700 list-disc ml-5 space-y-1">
          <li>Pluga a ELGIN <b>via USB</b> no PC do PDV (ou Ethernet se preferir)</li>
          <li>Windows reconhece automático. Se não, baixa driver em <a href="https://www.elgin.com.br/automacao/downloads" target="_blank" rel="noreferrer" className="text-blue-600 underline">elgin.com.br/automacao/downloads</a></li>
          <li><strong>NÃO marca como impressora padrão</strong> (você tem outras laser na loja)</li>
        </ul>
      </div>

      {/* Passo 2 */}
      <div className="bg-white border rounded-lg p-4 space-y-2">
        <div className="font-bold text-slate-800 flex items-center gap-2">
          <span className="bg-emerald-600 text-white rounded-full w-6 h-6 flex items-center justify-center text-xs">2</span>
          Configura o Chrome (uma vez por PC)
        </div>
        <ul className="text-sm text-slate-700 list-disc ml-5 space-y-1">
          <li>Abre o Chrome</li>
          <li>Clica nos <b>3 pontinhos</b> (canto superior direito) → <b>Configurações</b></li>
          <li>Pesquisa por &quot;<b>pop-ups</b>&quot;</li>
          <li>Em <b>Pop-ups e redirecionamentos</b>, em <b>&quot;Comportamento padrão&quot;</b>:
            adiciona <code className="bg-slate-100 px-1 rounded text-xs">flowops-lite.vercel.app</code> em <b>&quot;Sites com permissão&quot;</b>
          </li>
        </ul>
      </div>

      {/* Passo 3 */}
      <div className="bg-white border rounded-lg p-4 space-y-2">
        <div className="font-bold text-slate-800 flex items-center gap-2">
          <span className="bg-emerald-600 text-white rounded-full w-6 h-6 flex items-center justify-center text-xs">3</span>
          Primeira venda do dia (treina a vendedora)
        </div>
        <ul className="text-sm text-slate-700 list-disc ml-5 space-y-1">
          <li>Faz uma venda normal e emite NFC-e</li>
          <li>Quando o cupom autorizar, abre o <b>diálogo de impressão do Chrome</b></li>
          <li>No campo <b>&quot;Destino&quot;</b>, escolhe a <b>ELGIN</b></li>
          <li>Marca <b>&quot;Mais configurações&quot;</b> → <b>tamanho do papel: 80mm</b> (se a opção existir)</li>
          <li>Clica <b>Imprimir</b> (ou aperta <b>Enter</b>)</li>
        </ul>
      </div>

      {/* Resultado */}
      <div className="bg-emerald-50 border-2 border-emerald-300 rounded-lg p-4">
        <div className="font-bold text-emerald-900 flex items-center gap-2 mb-2">
          <Check className="w-5 h-5" /> Pronto. Da próxima venda em diante:
        </div>
        <ul className="text-sm text-emerald-800 list-disc ml-5 space-y-1">
          <li>Emite NFC-e</li>
          <li>Cupom abre no diálogo de impressão</li>
          <li>ELGIN <b>já vem selecionada</b> (Chrome lembra)</li>
          <li>Vendedora aperta <b>Enter</b> → cupom sai</li>
        </ul>
        <p className="text-xs text-emerald-700 mt-2">
          Tempo por venda: <strong>1 tecla</strong>.
        </p>
      </div>

      {/* Aviso de evolução */}
      <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-900">
        <strong>Em breve:</strong> app desktop dedicado pra impressão silent (zero clicks). Por enquanto, esse fluxo cobre 100% das lojas sem instalar nada extra.
      </div>

      <Link
        href="/minha-loja/pdv"
        className="block text-center px-3 py-3 bg-violet-600 hover:bg-violet-700 text-white font-bold rounded"
      >
        ← Voltar pro PDV
      </Link>
    </div>
  );
}
