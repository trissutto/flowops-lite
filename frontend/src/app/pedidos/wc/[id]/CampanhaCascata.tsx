'use client';

import { useState } from 'react';
import { ChevronRight, Megaphone } from 'lucide-react';

/**
 * DE QUAL CAMPANHA VEIO ESTE PEDIDO — fechado mostra o NOME da campanha,
 * clicado abre a cascata inteira (plataforma → campanha → anúncio →
 * posicionamento → página de entrada → etiqueta crua).
 *
 * Fica fechado por padrão de propósito: quem abre o pedido está separando
 * peça, não analisando mídia. O nome da campanha é a única linha que a
 * retaguarda precisa ver sem pedir; o resto é pra quem foi ali investigar.
 *
 * Os degraus vêm PRONTOS do backend (`montarCascataAtribuicao`) — a tela não
 * decide o que existe nem inventa rótulo. Pedido sem etiqueta chega com um
 * degrau só e o bloco não abre.
 */

export type DegrauAtribuicao = {
  rotulo: string;
  valor: string;
  detalhe?: string | null;
  mono?: boolean;
};

export type Atribuicao = {
  titulo: string;
  resumo: string | null;
  pago: boolean;
  plataforma: 'meta' | 'google' | null;
  degraus: DegrauAtribuicao[];
  temDetalhe: boolean;
  /** false = o título é "Direto", "Live Commerce"… — não é nome de campanha. */
  temCampanha?: boolean;
};

export default function CampanhaCascata({ atribuicao }: { atribuicao?: Atribuicao | null }) {
  const [aberto, setAberto] = useState(false);
  if (!atribuicao) return null;

  const podeAbrir = atribuicao.temDetalhe && atribuicao.degraus.length > 0;
  const icone = atribuicao.plataforma === 'meta' ? '📣' : atribuicao.plataforma === 'google' ? '🔎' : null;

  return (
    <div className="mb-4 rounded-lg border border-slate-200 bg-white shadow-sm overflow-hidden">
      <button
        type="button"
        onClick={() => podeAbrir && setAberto((v) => !v)}
        disabled={!podeAbrir}
        className={`w-full text-left px-4 py-3 flex items-center gap-3 ${
          podeAbrir ? 'hover:bg-slate-50 cursor-pointer' : 'cursor-default'
        }`}
      >
        <div className="text-2xl leading-none">{icone ?? <Megaphone className="w-6 h-6 text-slate-400" />}</div>

        <div className="flex-1 min-w-0">
          <div className="text-[10px] uppercase tracking-widest text-slate-400">
            {atribuicao.temCampanha ? 'Veio da campanha' : 'De onde veio o pedido'}
          </div>
          <div className="font-bold text-slate-800 leading-tight break-words">{atribuicao.titulo}</div>
          {atribuicao.resumo && (
            <div className="text-xs text-slate-500 mt-0.5 break-words">{atribuicao.resumo}</div>
          )}
        </div>

        {atribuicao.pago && (
          <span className="shrink-0 px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-800 text-[11px] font-bold uppercase tracking-wide">
            Pago
          </span>
        )}

        {podeAbrir && (
          <ChevronRight
            className={`w-5 h-5 text-slate-400 shrink-0 transition-transform ${aberto ? 'rotate-90' : ''}`}
          />
        )}
      </button>

      {aberto && (
        <div className="px-4 pb-4 pt-1 border-t border-slate-100">
          {atribuicao.degraus.map((d, i) => (
            <div
              key={`${d.rotulo}-${i}`}
              /* A indentação é o que faz a cascata ser cascata; em style
                 porque classe Tailwind montada por interpolação não existe
                 no CSS gerado (o compilador só vê string literal). */
              style={{ marginLeft: i * 16 }}
              className="border-l-2 border-slate-200 pl-3 py-1.5"
            >
              <div className="text-[10px] uppercase tracking-wider text-slate-400">{d.rotulo}</div>
              <div
                className={
                  d.mono
                    ? 'font-mono text-xs text-slate-700 break-all'
                    : 'text-sm font-semibold text-slate-800 break-words'
                }
              >
                {d.valor}
              </div>
              {d.detalhe && <div className="text-[11px] text-slate-500 break-words">{d.detalhe}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
