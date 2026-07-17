'use client';

/**
 * SwapModal — troca manual de peça na separação (pedido do site ou da LIVE).
 *
 * Fluxo:
 *   1. Vendedora busca a peça nova no espelho (/products/erp-search).
 *   2. Clica no resultado → o modal tenta a troca SEM senha (onSwap).
 *   3. Se o preço bate → troca aplicada na hora, fecha.
 *      Se o preço DIFERE → o backend devolve { needsPassword, diff } e o modal
 *      mostra a diferença + campo de senha. SEM senha de nível GERENTE+ não passa.
 *   4. Senha confirmada → onSwap de novo com a senha; 403 = senha inválida.
 *
 * O modal não conhece o endpoint — quem chama passa `onSwap(payload)` já apontando
 * pro pick-order (site) ou pro item da live. `onDone` recarrega a lista.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { X, Search, KeyRound, ArrowRight, AlertTriangle, CheckCircle2 } from 'lucide-react';

type ErpSearchHit = {
  CODIGO: string;
  REF: string;
  DESCRICAOCOMPLETA?: string;
  COR?: string | null;
  TAMANHO?: string | null;
  ESTOQUE?: number;
  qtyMyStore?: number;
  qtyTotal?: number;
};

export type SwapPayload = {
  codigo: string;
  ref?: string | null;
  cor?: string | null;
  tamanho?: string | null;
  descricao?: string | null;
  password?: string;
};

export type SwapResponse = {
  ok: boolean;
  needsPassword?: boolean;
  oldPrice?: number;
  newPrice?: number;
  diff?: number;
  newDescricao?: string;
  authorizedBy?: string | null;
};

const brl = (v?: number | null) =>
  typeof v === 'number'
    ? v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
    : '—';

export default function SwapModal({
  currentLabel,
  onSwap,
  onDone,
  onClose,
}: {
  currentLabel: string;
  onSwap: (payload: SwapPayload) => Promise<SwapResponse>;
  onDone: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ErpSearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<ErpSearchHit | null>(null);
  const [diffInfo, setDiffInfo] = useState<SwapResponse | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  // Busca no espelho (debounce 300ms). q com 2+ chars.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const term = query.trim();
    if (term.length < 2) { setResults([]); setLoading(false); return; }
    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await api<ErpSearchHit[]>(`/products/erp-search?q=${encodeURIComponent(term)}`);
        setResults(Array.isArray(res) ? res.slice(0, 40) : []);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query]);

  const payloadFor = (hit: ErpSearchHit, pwd?: string): SwapPayload => ({
    codigo: hit.CODIGO,
    ref: hit.REF ?? null,
    cor: hit.COR ?? null,
    tamanho: hit.TAMANHO ?? null,
    descricao: (hit.DESCRICAOCOMPLETA || '').trim() || null,
    ...(pwd ? { password: pwd } : {}),
  });

  async function attempt(hit: ErpSearchHit, pwd?: string) {
    setBusy(true);
    setError(null);
    try {
      const r = await onSwap(payloadFor(hit, pwd));
      if (r?.ok) {
        setOk(
          r.authorizedBy
            ? `Troca autorizada por ${r.authorizedBy}. Peça trocada ✓`
            : 'Peça trocada ✓',
        );
        setTimeout(() => { onDone(); onClose(); }, 750);
        return;
      }
      if (r?.needsPassword) {
        // Diferença de valor — precisa de senha GERENTE+.
        setDiffInfo(r);
        return;
      }
      setError('Não foi possível trocar. Tente de novo.');
    } catch (e: any) {
      const raw = String(e?.message || '');
      let msg = 'Erro ao trocar a peça.';
      // api joga Error("<status>: <corpo>"). 403 = senha inválida/insuficiente.
      try {
        const body = raw.slice(raw.indexOf(': ') + 2);
        const j = JSON.parse(body);
        if (j?.message) msg = Array.isArray(j.message) ? j.message[0] : j.message;
      } catch {
        if (raw) msg = raw;
      }
      if (/^403/.test(raw)) msg = 'Senha inválida ou nível insuficiente (precisa GERENTE ou acima).';
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  function pick(hit: ErpSearchHit) {
    setSelected(hit);
    setDiffInfo(null);
    setPassword('');
    setError(null);
    void attempt(hit); // 1ª tentativa sem senha
  }

  const needsPwd = !!diffInfo?.needsPassword;
  const diff = diffInfo?.diff ?? 0;
  const maisCaro = diff > 0;

  const selectedLabel = useMemo(() => {
    if (!selected) return '';
    const parts = [
      (selected.DESCRICAOCOMPLETA || selected.REF || selected.CODIGO).trim(),
      [selected.COR, selected.TAMANHO].filter(Boolean).join(' '),
    ].filter(Boolean);
    return parts.join(' · ');
  }, [selected]);

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-black/40 p-4 pt-10 sm:pt-20">
      <div className="w-full max-w-lg rounded-2xl bg-[#FAFAF7] shadow-2xl border border-[#E6DFC8] overflow-hidden">
        {/* Cabeçalho */}
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-[#E6DFC8] bg-white">
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-wide font-bold text-[#8C7325]">
              Trocar peça
            </div>
            <div className="text-sm text-slate-600 truncate">
              Saindo: <span className="font-semibold text-slate-800">{currentLabel}</span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 rounded-lg p-2 text-slate-500 hover:bg-slate-100"
            title="Fechar"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Sucesso */}
        {ok && (
          <div className="m-4 flex items-center gap-2 rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-3 text-emerald-800 font-semibold">
            <CheckCircle2 className="w-5 h-5" /> {ok}
          </div>
        )}

        {!ok && (
          <div className="p-4 space-y-3">
            {/* Busca */}
            <div className="relative">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Buscar peça nova (código, ref ou descrição)…"
                className="w-full rounded-lg border border-[#E6DFC8] bg-white py-2.5 pl-9 pr-3 text-sm outline-none focus:border-[#D4AF37] focus:ring-2 focus:ring-[#FBF6E6]"
              />
            </div>

            {/* Resultados — some quando já escolheu e está no passo da senha */}
            {!needsPwd && (
              <div className="max-h-64 overflow-y-auto rounded-lg border border-[#E6DFC8] bg-white divide-y divide-slate-50">
                {loading && (
                  <div className="px-3 py-4 text-sm text-slate-400">Buscando…</div>
                )}
                {!loading && query.trim().length >= 2 && results.length === 0 && (
                  <div className="px-3 py-4 text-sm text-slate-400">Nenhuma peça encontrada.</div>
                )}
                {!loading && query.trim().length < 2 && (
                  <div className="px-3 py-4 text-sm text-slate-400">
                    Digite ao menos 2 caracteres pra buscar.
                  </div>
                )}
                {results.map((r) => {
                  const estoque = Number(r.qtyMyStore ?? r.ESTOQUE) || 0;
                  const isSel = selected?.CODIGO === r.CODIGO;
                  return (
                    <button
                      key={r.CODIGO}
                      onClick={() => pick(r)}
                      disabled={busy}
                      className={`w-full text-left px-3 py-2.5 hover:bg-[#FBF6E6] disabled:opacity-50 flex items-start gap-3 ${
                        isSel ? 'bg-[#FBF6E6]' : ''
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-slate-800 truncate">
                          {(r.DESCRICAOCOMPLETA || r.REF || r.CODIGO).trim()}
                        </div>
                        <div className="text-xs text-slate-500">
                          {r.REF ? `REF ${r.REF}` : ''}
                          {r.COR ? ` · ${r.COR}` : ''}
                          {r.TAMANHO ? ` ${r.TAMANHO}` : ''}
                          <span className="font-mono text-slate-400"> · cód {r.CODIGO}</span>
                        </div>
                      </div>
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${
                          estoque > 0
                            ? 'bg-emerald-100 text-emerald-700'
                            : 'bg-red-100 text-red-700'
                        }`}
                        title="Estoque na sua loja"
                      >
                        {estoque} un
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            {/* Passo da senha — diferença de valor */}
            {needsPwd && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 space-y-3">
                <div className="flex items-start gap-2 text-amber-900">
                  <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
                  <div className="text-sm">
                    <div className="font-bold">Diferença de valor — precisa de autorização</div>
                    <div className="mt-1 truncate">Nova peça: <span className="font-semibold">{selectedLabel}</span></div>
                  </div>
                </div>

                <div className="flex items-center justify-center gap-3 text-sm">
                  <span className="text-slate-500">{brl(diffInfo?.oldPrice)}</span>
                  <ArrowRight className="w-4 h-4 text-slate-400" />
                  <span className="font-semibold text-slate-800">{brl(diffInfo?.newPrice)}</span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-bold ${
                      maisCaro ? 'bg-red-100 text-red-700' : 'bg-emerald-100 text-emerald-700'
                    }`}
                  >
                    {maisCaro ? '+' : '−'}{brl(Math.abs(diff)).replace('R$', 'R$ ').trim()}
                  </span>
                </div>

                <div className="relative">
                  <KeyRound className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input
                    type="password"
                    value={password}
                    autoFocus
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && password.trim() && selected && !busy) {
                        void attempt(selected, password.trim());
                      }
                    }}
                    placeholder="Senha ou PIN (GERENTE ou acima)"
                    className="w-full rounded-lg border border-amber-300 bg-white py-2.5 pl-9 pr-3 text-sm outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-100"
                  />
                </div>

                <div className="flex gap-2">
                  <button
                    onClick={() => { setDiffInfo(null); setPassword(''); setError(null); }}
                    disabled={busy}
                    className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                  >
                    Voltar
                  </button>
                  <button
                    onClick={() => selected && attempt(selected, password.trim())}
                    disabled={busy || !password.trim()}
                    className="flex-1 rounded-lg bg-[#B8912B] px-3 py-2 text-sm font-bold text-white hover:bg-[#8C7325] disabled:opacity-50"
                  >
                    {busy ? 'Autorizando…' : 'Autorizar e trocar'}
                  </button>
                </div>
              </div>
            )}

            {error && (
              <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
                {error}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
