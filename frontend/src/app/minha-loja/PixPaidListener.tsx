'use client';

/**
 * PixPaidListener — listener GLOBAL pra PIX-link confirmados via webhook.
 *
 * UX: badge discreto FLUTUANTE no canto inferior direito (não obstrui tela).
 *   - Pulsa quando chega pagamento novo
 *   - Click → abre painel lateral com lista de parcelas pagas
 *   - Botão "Imprimir recibo" silencioso (sem preview)
 *   - Toca 1 beep curto (não 2 estridentes)
 *
 * Roda em qualquer subpágina de /minha-loja/* (incluído via layout.tsx).
 * Polling a cada 5s em /crediarios/baixa/recentes-pagas.
 */

import { useEffect, useRef, useState } from 'react';
import { Bell, X, Printer, CheckCircle2 } from 'lucide-react';
import { api } from '@/lib/api';

const brl = (n: number) =>
  Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

type BaixaInfo = {
  baixaId: string;
  nomeCliente: string;
  valor: number;
  recebidoAt: number; // ms
  printed: boolean;    // ja foi enviado pra impressao? (controle pra nao reimprimir auto)
  items: Array<{
    parcelaNum: number | null;
    totalParcelas: number | null;
    vencimento: string;
    valorPago: number;
    jurosCalculado: number;
  }>;
};

/**
 * Tenta imprimir via ELECTRON (silent). Retorna true se conseguiu disparar.
 * Em browser puro retorna false — caller precisa esperar interacao do user
 * (click no badge) pra abrir POPUP de impressao.
 */
function trySilentPrint(baixaId: string): boolean {
  const url = `/minha-loja/pdv/recebimentos/recibo/${baixaId}?autoprint=1`;
  // Roteia via printer-router (kind=recibo_pix → profile=termica).
  // Setar impressora e disparar em background — não aguarda.
  try {
    import('@/lib/printer-router').then(({ routePrint, isElectron }) => {
      if (!isElectron()) return;
      routePrint({ kind: 'recibo_pix', url }).catch((e) =>
        console.warn('[PixPaidListener] routePrint falhou:', e),
      );
    });
    const electron = (window as any).electronAPI;
    return !!electron?.silentPrintUrl;
  } catch {
    return false;
  }
}

/**
 * Abre POPUP visivel pra imprimir. Disparado a partir de click do user
 * (que libera o browser pra abrir janela e disparar window.print()).
 * Iframe oculto offscreen NAO funciona — Chrome bloqueia print silencioso
 * em iframes sem interacao.
 */
function printReceipt(baixaId: string) {
  const url = `/minha-loja/pdv/recebimentos/recibo/${baixaId}?autoprint=1`;
  // 1) Electron — print silencioso direto na termica
  if (trySilentPrint(baixaId)) return;
  // 2) Browser — abre popup pequeno visivel. O recibo dispara window.print()
  // sozinho no useEffect e fecha apos afterprint.
  const w = window.open(
    url,
    `lurds_recibo_${baixaId}`,
    'width=420,height=620,resizable=yes,scrollbars=yes',
  );
  if (!w) {
    // Popup blocker — fallback abre em nova aba
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

export default function PixPaidListener() {
  // Fila de baixas recebidas nessa sessão (todas ficam até user dispensar)
  const [baixas, setBaixas] = useState<BaixaInfo[]>([]);
  // Estado UI: badge fechado ou painel aberto
  const [open, setOpen] = useState(false);
  // Pulsa quando chega novo
  const [pulse, setPulse] = useState(false);

  // Persistência: `since` e `seen` ficam no localStorage pra sobreviver a
  // recarregamentos da página. ANTES: ao recarregar, since virava "agora -5min"
  // e perdia alertas de pagamentos do começo do dia. AGORA: pega tudo desde a
  // última visita (cap 12h pra não acumular antigo demais).
  const LAST_SEEN_KEY = 'lurds_pix_listener_last_seen_iso';
  const SEEN_IDS_KEY = 'lurds_pix_listener_seen_ids';
  const sinceRef = useRef<string>('');
  const seenRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    // ESTRATEGIA: since SEMPRE 30min atras (janela larga) + deduplicacao via
    // seenRef. Antes: since ia avancando a cada poll e em PCs com aba em
    // background + Chrome throttling, alertas podiam ser pulados.
    // Agora: janela larga pega tudo dos ultimos 30min, seen impede duplicar.
    sinceRef.current = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    try {
      const seenRaw = localStorage.getItem(SEEN_IDS_KEY);
      if (seenRaw) {
        const arr = JSON.parse(seenRaw);
        if (Array.isArray(arr)) {
          seenRef.current = new Set(arr.slice(-200));
        }
      }
    } catch { /* segue com defaults */ }

    const beepCurto = () => {
      try {
        const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = 880; osc.type = 'sine';
        gain.gain.setValueAtTime(0.18, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
        osc.connect(gain); gain.connect(ctx.destination);
        osc.start(); osc.stop(ctx.currentTime + 0.25);
      } catch {/* sem Web Audio — segue */}
    };

    const poll = async () => {
      if (typeof window === 'undefined') return;
      const token = localStorage.getItem('flowops_token');
      if (!token) return;

      try {
        // since FIXO em 30min atras — janela larga garante que mesmo se aba
        // ficou em background e Chrome suspendeu polling, ao voltar pega
        // tudo que aconteceu. Deduplicacao via seenRef impede repetir alertas.
        const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();
        sinceRef.current = since;
        const apiBaixas = await api<any[]>(`/crediarios/baixa/recentes-pagas?since=${encodeURIComponent(since)}`);
        try { localStorage.setItem(LAST_SEEN_KEY, new Date().toISOString()); } catch {}
        if (cancelled || !apiBaixas?.length) return;

        const novas: BaixaInfo[] = [];
        for (const b of apiBaixas) {
          if (seenRef.current.has(b.id)) continue;
          seenRef.current.add(b.id);
          try { localStorage.setItem(SEEN_IDS_KEY, JSON.stringify([...seenRef.current].slice(-200))); } catch {}
          // Tenta silent print via Electron. Se rolar, ja marca como printed.
          // Em browser puro retorna false — fica printed=false ate user clicar.
          let silentOk = false;
          try { silentOk = trySilentPrint(b.id); } catch { /* segue */ }
          novas.push({
            baixaId: b.id,
            nomeCliente: b.customerName || 'Cliente',
            valor: Number(b.totalPago) || 0,
            recebidoAt: Date.now(),
            printed: silentOk,
            items: (b.items || []).map((it: any) => ({
              parcelaNum: it.parcelaNum ?? null,
              totalParcelas: it.totalParcelas ?? null,
              vencimento: it.vencimento || '',
              valorPago: Number(it.valorPago) || 0,
              jurosCalculado: Number(it.jurosCalculado) || 0,
            })),
          });
        }
        if (novas.length > 0) {
          setBaixas((prev) => [...novas, ...prev].slice(0, 20)); // limita histórico
          beepCurto();
          setPulse(true);
          setTimeout(() => setPulse(false), 4000);
        }
      } catch {
        /* erro de rede — silencioso */
      }
    };

    poll();
    const interval = setInterval(poll, 5000);

    // VISIBILITY: quando aba volta ao foco, dispara poll imediato.
    // Chrome/Edge suspendem setInterval em abas em background pra economizar
    // bateria — sem isso, vendedora podia voltar pra aba e nao receber alerta
    // do pagamento que entrou enquanto estava em outra aba.
    const onVisible = () => {
      if (!cancelled && document.visibilityState === 'visible') {
        poll();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    // Tambem dispara em window focus (mais robusto, alguns navegadores)
    window.addEventListener('focus', onVisible);

    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, []);

  const dispensarTodos = () => {
    setBaixas([]);
    setOpen(false);
  };

  const dispensarUm = (id: string) => {
    setBaixas((prev) => prev.filter((b) => b.baixaId !== id));
  };

  /**
   * Click do badge — interacao DO USER (libera popup do browser).
   * Aproveita pra disparar print das baixas ainda nao impressas, com
   * pequeno delay entre cada pra browser nao engasgar.
   */
  const abrirEImprimir = () => {
    setOpen(true);
    setPulse(false);
    const pendentes = baixas.filter((b) => !b.printed);
    pendentes.forEach((b, idx) => {
      setTimeout(() => {
        try { printReceipt(b.baixaId); } catch { /* segue */ }
      }, idx * 600);
    });
    if (pendentes.length > 0) {
      setBaixas((prev) => prev.map((b) => ({ ...b, printed: true })));
    }
  };

  const naoImpressas = baixas.filter((b) => !b.printed).length;

  if (baixas.length === 0) return null;

  return (
    <>
      {/* BADGE FLUTUANTE — canto inferior direito, sem obstruir.
          Click DISPARA IMPRESSAO das pendentes (browser libera popup quando
          rola interacao do user). */}
      {!open && (
        <button
          type="button"
          onClick={abrirEImprimir}
          className={`fixed bottom-4 right-4 z-[200] flex items-center gap-2 px-4 py-3 rounded-full shadow-2xl border-2 border-white transition-transform ${
            naoImpressas > 0
              ? 'bg-rose-600 hover:bg-rose-700 text-white'
              : 'bg-emerald-600 hover:bg-emerald-700 text-white'
          } ${pulse ? 'animate-bounce' : ''}`}
          title={naoImpressas > 0 ? 'CLICA pra imprimir os recibos pendentes' : 'Pagamentos PIX confirmados'}
        >
          <Bell className="w-5 h-5" />
          <span className="font-black text-sm tabular-nums">{baixas.length}</span>
          <span className="text-xs font-bold uppercase tracking-wider hidden sm:inline">
            {naoImpressas > 0 ? `${naoImpressas} pra imprimir` : 'PIX recebido'}
          </span>
          {naoImpressas > 0 && (
            <Printer className="w-4 h-4 animate-pulse" />
          )}
        </button>
      )}

      {/* PAINEL LATERAL — só aparece quando user clica no badge */}
      {open && (
        <div className="fixed inset-0 z-[200] flex items-end justify-end p-0 sm:p-4 pointer-events-none">
          {/* Backdrop transparente (clica fora pra fechar — não escurece tela toda) */}
          <div
            className="absolute inset-0 pointer-events-auto"
            onClick={() => setOpen(false)}
          />
          {/* Painel */}
          <div
            className="relative w-full sm:w-[400px] max-h-[80vh] bg-white sm:rounded-2xl shadow-2xl border-2 border-emerald-300 overflow-hidden flex flex-col pointer-events-auto"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="bg-emerald-600 text-white px-4 py-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-5 h-5" />
                <div>
                  <div className="font-black text-sm uppercase tracking-wide">PIX recebido</div>
                  <div className="text-[11px] opacity-90">{baixas.length} pagamento(s) pendente(s)</div>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={dispensarTodos}
                  className="text-[10px] font-bold uppercase px-2 py-1 bg-white/15 hover:bg-white/25 rounded"
                  title="Dispensar todos"
                >
                  Limpar
                </button>
                <button
                  onClick={() => setOpen(false)}
                  className="p-1 hover:bg-white/15 rounded"
                  title="Fechar"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Lista de baixas */}
            <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
              {baixas.map((b) => (
                <div key={b.baixaId} className="p-3 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="font-bold text-slate-800 truncate" title={b.nomeCliente}>
                        {b.nomeCliente}
                      </div>
                      <div className="text-[10px] text-slate-500">
                        {new Date(b.recebidoAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                      </div>
                    </div>
                    <div className="text-xl font-black text-emerald-700 tabular-nums shrink-0">
                      {brl(b.valor)}
                    </div>
                  </div>
                  {/* Parcelas */}
                  {b.items.length > 0 && (
                    <div className="bg-emerald-50 border border-emerald-100 rounded p-2 space-y-0.5">
                      {b.items.map((it, i) => {
                        const venc = it.vencimento ? (() => {
                          try { const s = String(it.vencimento); const d = s.includes('T') ? new Date(s) : new Date(s + 'T00:00:00'); return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('pt-BR'); } catch { return '—'; }
                        })() : '—';
                        const lbl = it.parcelaNum && it.totalParcelas ? `${it.parcelaNum}/${it.totalParcelas}` : `parc ${i + 1}`;
                        return (
                          <div key={i} className="flex items-center justify-between text-[11px] gap-2">
                            <span className="font-bold text-emerald-800 shrink-0 w-12">{lbl}</span>
                            <span className="text-slate-600 font-mono shrink-0">venc {venc}</span>
                            <span className="font-mono font-bold text-emerald-700 tabular-nums ml-auto">{brl(it.valorPago)}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {/* Botões */}
                  <div className="flex gap-2">
                    <button
                      onClick={() => printReceipt(b.baixaId)}
                      className="flex-1 px-3 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold rounded flex items-center justify-center gap-1.5"
                    >
                      <Printer className="w-3.5 h-3.5" /> Imprimir
                    </button>
                    <button
                      onClick={() => dispensarUm(b.baixaId)}
                      className="px-3 py-2 border border-slate-300 text-slate-600 text-xs font-bold rounded hover:bg-slate-50"
                    >
                      OK
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
