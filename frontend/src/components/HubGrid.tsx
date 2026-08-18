'use client';

/**
 * HubGrid — a grade de cards de um hub, COM "Reordenar" (arrastar e soltar).
 *
 * Todo hub (/, /site, /loja, /retaguarda, /config) tinha a mesma `<section
 * className="grid ...">` mapeando o array de itens. A ordem vinha do código:
 * mudar era commit + deploy. O dono pediu pra arrastar (18/08/2026) — e pediu
 * em TODAS as telas de botão, então a regra mora aqui, uma vez. Copiada em
 * cinco arquivos, ela divergiria no primeiro ajuste.
 *
 * ── ONDE A ORDEM FICA (decisão do dono, 18/08) ──
 *
 * No NAVEGADOR (`localStorage`), não no banco: é preferência de quem usa, muda
 * muito no começo e não vale um restart do backend por card movido. O que se
 * assume junto: vale neste computador, e limpar o cache volta pra ordem do
 * código. "Ordem padrão" faz isso de propósito.
 *
 * ── POR QUE UM MODO, E NÃO ARRASTAR DIRETO ──
 *
 * O card é um link. Arrastar um link é um gesto que o navegador já tem (vira
 * arrastar a URL), e clicar é o que a pessoa faz o dia inteiro. Enquanto o modo
 * está desligado nada muda; ligado, o card vira desenho (`pointer-events-none`)
 * e o clique não abre tela nenhuma.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, GripVertical, RotateCcw } from 'lucide-react';
import HubCard, { type HubTone } from './HubCard';
import type { LucideIcon } from 'lucide-react';

export type HubItem = {
  href: string;
  label: string;
  subtitle?: string;
  description?: string;
  tone: HubTone;
  icon: LucideIcon;
  external?: boolean;
};

const GRADE_PADRAO = 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4';

export default function HubGrid({
  chave, itens: itensDoCodigo, className, renderCard,
}: {
  /** Identifica o hub no storage — "site", "loja", "gestao"… */
  chave: string;
  itens: HubItem[];
  /** Classes da grade. Cada hub tem a sua (a home é 7 colunas). */
  className?: string;
  /**
   * A home tem um `HubCard` PRÓPRIO (o tom `rose` dela é mais forte que o do
   * componente compartilhado). Trocar pelo comum mudaria a cor do card do
   * Instagram — mudança visual que ninguém pediu. Então o desenho do card é
   * plugável e só a lógica de arrastar é compartilhada.
   */
  renderCard?: (item: HubItem) => ReactNode;
}) {
  const [ordem, setOrdem] = useState<string[] | null>(null);
  const [reordenando, setReordenando] = useState(false);
  const arrastado = useRef<string | null>(null);
  const storageKey = `flowops:hub-${chave}-ordem`;

  /**
   * Lê DEPOIS de montar: `localStorage` não existe no servidor, e ler durante o
   * render faria o HTML do servidor divergir do cliente (hydration).
   */
  useEffect(() => {
    try {
      const cru = localStorage.getItem(storageKey);
      if (cru) setOrdem(JSON.parse(cru));
    } catch {
      // Ordem corrompida no storage não pode derrubar o hub inteiro.
    }
  }, [storageKey]);

  /**
   * A ordem salva MANDA, mas não é a lista: card novo, adicionado no código
   * depois, entraria invisível se a tela mostrasse só o que está no storage.
   * Então os conhecidos vêm na ordem salva e os novos entram no fim.
   */
  const itens = useMemo(() => {
    if (!ordem?.length) return itensDoCodigo;
    const porHref = new Map(itensDoCodigo.map((i) => [i.href, i]));
    const salvos = ordem.map((h) => porHref.get(h)).filter(Boolean) as HubItem[];
    const vistos = new Set(salvos.map((i) => i.href));
    return [...salvos, ...itensDoCodigo.filter((i) => !vistos.has(i.href))];
  }, [ordem, itensDoCodigo]);

  function guardar(lista: string[]) {
    setOrdem(lista);
    try {
      localStorage.setItem(storageKey, JSON.stringify(lista));
    } catch {
      // Storage cheio ou bloqueado: a ordem vale só nesta sessão, e tudo bem.
    }
  }

  /** Soltou em cima de outro card: o arrastado ocupa a posição dele. */
  function soltarEm(destino: string) {
    const de = arrastado.current;
    arrastado.current = null;
    if (!de || de === destino) return;
    const lista = itens.map((i) => i.href);
    const iDe = lista.indexOf(de);
    const iPara = lista.indexOf(destino);
    if (iDe < 0 || iPara < 0) return;
    lista.splice(iPara, 0, ...lista.splice(iDe, 1));
    guardar(lista);
  }

  function restaurarPadrao() {
    setOrdem(null);
    try {
      localStorage.removeItem(storageKey);
    } catch {
      // idem
    }
  }

  return (
    <>
      <div className="flex items-center gap-2 mb-3">
        {reordenando && (
          <p className="flex-1 text-sm font-semibold text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
            Arraste os cards pra ordem que você quiser. Fica salvo neste computador.
          </p>
        )}
        {reordenando && (
          <button
            type="button"
            onClick={restaurarPadrao}
            className="shrink-0 px-3 py-2 rounded-lg bg-white border border-slate-200 text-sm font-semibold text-slate-600 hover:bg-slate-50 flex items-center gap-1.5"
          >
            <RotateCcw className="w-4 h-4" />
            Ordem padrão
          </button>
        )}
        <button
          type="button"
          onClick={() => setReordenando((v) => !v)}
          className={`shrink-0 px-3 py-2 rounded-lg text-sm font-semibold flex items-center gap-1.5 border ${
            reordenando
              ? 'bg-emerald-600 border-emerald-600 text-white hover:bg-emerald-700'
              : 'ml-auto bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
          }`}
        >
          {reordenando ? <Check className="w-4 h-4" /> : <GripVertical className="w-4 h-4" />}
          {reordenando ? 'Pronto' : 'Reordenar'}
        </button>
      </div>

      <section className={className || GRADE_PADRAO}>
        {itens.map((item) => (
          /**
           * O wrapper é `grid` SEMPRE (não só ao reordenar): ele passa a ser o
           * item da grade e o card estica dentro dele, mantendo a altura igual
           * à de antes. E o arrasto do HTML5 precisa de uma caixa de verdade —
           * em `display:contents` ele não pega.
           */
          <div
            key={item.href}
            className={`relative grid ${reordenando ? 'cursor-grab active:cursor-grabbing' : ''}`}
            draggable={reordenando}
            onDragStart={() => { arrastado.current = item.href; }}
            onDragOver={(e) => { if (reordenando) e.preventDefault(); }}
            onDrop={(e) => { e.preventDefault(); soltarEm(item.href); }}
          >
            {reordenando && (
              <span className="absolute z-10 top-2 right-2 flex items-center gap-1 text-[10px] font-bold uppercase text-white/90 bg-black/25 rounded px-1.5 py-1">
                <GripVertical className="w-3 h-3" /> arraste
              </span>
            )}
            <div className={reordenando ? 'grid pointer-events-none select-none' : 'grid'}>
              {renderCard ? renderCard(item) : (
                <HubCard
                  href={item.href}
                  label={item.label}
                  subtitle={item.subtitle}
                  description={item.description}
                  tone={item.tone}
                  icon={item.icon}
                  external={item.external}
                />
              )}
            </div>
          </div>
        ))}
      </section>
    </>
  );
}
