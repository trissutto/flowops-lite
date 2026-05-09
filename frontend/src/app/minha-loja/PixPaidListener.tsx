'use client';

/**
 * PixPaidListener — listener GLOBAL pra detectar PIX-link confirmados
 * via webhook (Pagar.me).
 *
 * Roda em qualquer tela de /minha-loja/* (incluído via layout.tsx).
 * A cada 5s consulta /crediarios/baixa/recentes-pagas. Quando detecta
 * baixa nova:
 *   1. Toca beep duplo (Web Audio)
 *   2. Mostra modal verde fullscreen com cliente + valor
 *   3. Imprime recibo automaticamente
 *
 * Funciona estando a vendedora no PDV, no Caixa, em Recebimentos —
 * em qualquer subpágina de minha-loja.
 */

import { useEffect, useRef, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { api } from '@/lib/api';

const brl = (n: number) =>
  Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function printReceipt(baixaId: string) {
  const url = `/minha-loja/pdv/recebimentos/recibo/${baixaId}?autoprint=1`;
  const electron = (window as any).electronAPI;
  if (electron?.silentPrintUrl) {
    electron.silentPrintUrl(window.location.origin + url).catch(() => hiddenIframe(url));
  } else {
    hiddenIframe(url);
  }
}
function hiddenIframe(url: string) {
  try {
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;left:-9999px;top:0;width:300px;height:600px;border:0;';
    iframe.src = url;
    document.body.appendChild(iframe);
    setTimeout(() => { try { iframe.remove(); } catch {} }, 30000);
  } catch {
    window.open(url, 'lurds_recibo', 'width=320,height=520,resizable=yes');
  }
}

export default function PixPaidListener() {
  const [pagoAlerta, setPagoAlerta] = useState<{
    baixaId: string;
    nomeCliente: string;
    valor: number;
    items: Array<{
      parcelaNum: number | null;
      totalParcelas: number | null;
      vencimento: string;
      valorPago: number;
      jurosCalculado: number;
    }>;
  } | null>(null);

  // Inicia 5min atrás — pega baixas que rolaram pouco antes da tela abrir
  const sinceRef = useRef<string>(new Date(Date.now() - 5 * 60 * 1000).toISOString());
  const seenBaixasRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      // Só faz polling se tiver token (vendedora logada)
      if (typeof window === 'undefined') return;
      const token = localStorage.getItem('flowops_token');
      if (!token) return;

      try {
        const since = sinceRef.current;
        const baixas = await api<any[]>(`/crediarios/baixa/recentes-pagas?since=${encodeURIComponent(since)}`);
        if (cancelled || !baixas?.length) return;
        // Atualiza marca pra próximo poll
        sinceRef.current = new Date().toISOString();
        for (const b of baixas) {
          if (seenBaixasRef.current.has(b.id)) continue;
          seenBaixasRef.current.add(b.id);
          // Toca beep alto
          try {
            const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.frequency.value = 880; osc.type = 'sine';
            gain.gain.setValueAtTime(0.3, ctx.currentTime);
            osc.connect(gain); gain.connect(ctx.destination);
            osc.start(); osc.stop(ctx.currentTime + 0.5);
            setTimeout(() => {
              const o2 = ctx.createOscillator();
              const g2 = ctx.createGain();
              o2.frequency.value = 1320; o2.type = 'sine';
              g2.gain.setValueAtTime(0.3, ctx.currentTime);
              o2.connect(g2); g2.connect(ctx.destination);
              o2.start(); o2.stop(ctx.currentTime + 0.4);
            }, 250);
          } catch {/* sem Web Audio — segue */}
          // Mostra alerta com discriminação das parcelas
          setPagoAlerta({
            baixaId: b.id,
            nomeCliente: b.customerName || 'Cliente',
            valor: Number(b.totalPago) || 0,
            items: (b.items || []).map((it: any) => ({
              parcelaNum: it.parcelaNum ?? null,
              totalParcelas: it.totalParcelas ?? null,
              vencimento: it.vencimento || '',
              valorPago: Number(it.valorPago) || 0,
              jurosCalculado: Number(it.jurosCalculado) || 0,
            })),
          });
          // Imprime recibo
          try { printReceipt(b.id); } catch {/* segue */}
        }
      } catch {
        /* erro de rede — silencioso, tenta de novo no próximo poll */
      }
    };

    // Primeira chamada imediata, depois a cada 5s
    poll();
    const interval = setInterval(poll, 5000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  if (!pagoAlerta) return null;

  return (
    <div
      className="fixed inset-0 bg-emerald-600/95 z-[200] flex items-center justify-center p-6 cursor-pointer"
      onClick={() => setPagoAlerta(null)}
    >
      <div className="bg-white rounded-3xl shadow-2xl p-8 max-w-md w-full text-center space-y-4 animate-pulse">
        <div className="w-24 h-24 mx-auto bg-emerald-100 rounded-full flex items-center justify-center">
          <CheckCircle2 size={56} className="text-emerald-600" />
        </div>
        <h2 className="text-3xl font-black text-emerald-700 uppercase tracking-wide">PAGO!</h2>
        <div className="text-lg text-slate-700">
          <div><strong>{pagoAlerta.nomeCliente}</strong></div>
          <div className="text-3xl font-black text-emerald-600 tabular-nums mt-2">{brl(pagoAlerta.valor)}</div>
        </div>

        {/* Discriminação das parcelas pagas */}
        {pagoAlerta.items && pagoAlerta.items.length > 0 && (
          <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-left">
            <div className="text-[10px] uppercase font-bold text-emerald-700 tracking-wide mb-1.5">
              Parcelas baixadas
            </div>
            <div className="space-y-1 max-h-48 overflow-y-auto">
              {pagoAlerta.items.map((it, i) => {
                const venc = it.vencimento ? (() => {
                  try { const s = String(it.vencimento); const d = s.includes('T') ? new Date(s) : new Date(s + 'T00:00:00'); return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('pt-BR'); } catch { return '—'; }
                })() : '—';
                const parcLabel = it.parcelaNum && it.totalParcelas
                  ? `${it.parcelaNum}/${it.totalParcelas}`
                  : `parc ${i + 1}`;
                return (
                  <div key={i} className="flex items-center justify-between text-xs gap-2">
                    <span className="font-bold text-emerald-800 shrink-0">{parcLabel}</span>
                    <span className="text-slate-600 font-mono shrink-0">venc {venc}</span>
                    <span className="font-mono font-black text-emerald-700 tabular-nums ml-auto">{brl(it.valorPago)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="text-xs text-slate-500">
          Recibo enviado pra impressão automaticamente
        </div>
        <button
          onClick={() => setPagoAlerta(null)}
          className="w-full px-4 py-3 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-xl text-lg"
        >
          OK
        </button>
      </div>
    </div>
  );
}
