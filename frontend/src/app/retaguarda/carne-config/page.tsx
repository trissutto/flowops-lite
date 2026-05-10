'use client';

/**
 * /retaguarda/carne-config — painel admin pra ajustar coords do carnê.
 * Salva em /tmp/carne-coords-override.json. Hot-reload no service.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Save, RotateCcw, Loader2, Eye, AlertCircle } from 'lucide-react';
import { api } from '@/lib/api';

type Coords = {
  blocoY: number[];
  blocoH: number;
  fields: Record<string, { x: number; dy: number; w?: number }>;
  parcelaEsq: { xValor: number; xData: number; dy0: number; dyStep: number };
  parcelaDir: { xValor: number; xData: number; dy0: number; dyStep: number };
  totalAVencer: {
    col1: { x: number; yStart: number; dyStep: number };
    col2: { x: number; yStart: number; dyStep: number };
    col3: { x: number; yStart: number; dyStep: number };
  };
};

const FIELD_LABELS: Record<string, string> = {
  numero: '1. Número do cliente',
  data: '2. Data da compra',
  cliente: '3. Nome do cliente',
  ultimaCompra: '4. Data da última compra',
  limite: '5. Limite de crédito',
  pontos: 'Pontos (extra)',
  total: '6. Total da compra',
  entrada: '7. Entrada',
};

export default function CarneConfigPage() {
  const [coords, setCoords] = useState<Coords | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [testSaleId, setTestSaleId] = useState('');

  const reload = async () => {
    setLoading(true);
    setErr('');
    try {
      const r = await api<Coords>('/pdv/carne/coords');
      setCoords(r);
    } catch (e: any) {
      setErr(e?.message || 'Falha ao carregar');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { reload(); }, []);

  const updateField = (key: string, axis: 'x' | 'dy', value: number) => {
    if (!coords) return;
    setCoords({
      ...coords,
      fields: { ...coords.fields, [key]: { ...coords.fields[key], [axis]: value } },
    });
  };

  const updateParcela = (lado: 'parcelaEsq' | 'parcelaDir', key: string, value: number) => {
    if (!coords) return;
    setCoords({ ...coords, [lado]: { ...coords[lado], [key]: value } });
  };

  const updateColuna = (col: 'col1' | 'col2' | 'col3', key: string, value: number) => {
    if (!coords) return;
    setCoords({
      ...coords,
      totalAVencer: { ...coords.totalAVencer, [col]: { ...coords.totalAVencer[col], [key]: value } },
    });
  };

  const updateBlocoY = (idx: 0 | 1, value: number) => {
    if (!coords) return;
    const arr = [...coords.blocoY];
    arr[idx] = value;
    setCoords({ ...coords, blocoY: arr });
  };

  const salvar = async () => {
    if (!coords) return;
    setSaving(true);
    setErr('');
    try {
      await api('/pdv/carne/coords', { method: 'PUT', body: JSON.stringify(coords) });
      setSavedAt(new Date());
    } catch (e: any) {
      setErr(e?.message || 'Falha ao salvar');
    } finally {
      setSaving(false);
    }
  };

  const resetar = async () => {
    if (!confirm('Restaurar padrão?')) return;
    setSaving(true);
    try {
      await api('/pdv/carne/coords', { method: 'DELETE' });
      await reload();
    } catch (e: any) {
      setErr(e?.message || 'Falha ao resetar');
    } finally {
      setSaving(false);
    }
  };

  const gerarTeste = (debug: boolean) => {
    if (!testSaleId.trim()) { alert('Digite um saleId'); return; }
    const apiUrl = process.env.NEXT_PUBLIC_API_URL || '';
    const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_token') : '';
    const url = `${apiUrl}/pdv/sales/${testSaleId.trim()}/carne-pdf${debug ? '?debug=1' : ''}`;
    fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then((r) => r.ok ? r.blob() : r.json().then((j) => Promise.reject(j)))
      .then((blob: any) => {
        if (blob instanceof Blob) {
          const blobUrl = URL.createObjectURL(blob);
          window.open(blobUrl, '_blank');
        }
      })
      .catch((e: any) => alert(`Falha: ${e?.message || JSON.stringify(e)}`));
  };

  if (loading) {
    return <div className="min-h-screen bg-slate-50 p-6 flex items-center justify-center"><Loader2 className="w-8 h-8 animate-spin text-rose-600" /></div>;
  }
  if (!coords) {
    return (
      <div className="min-h-screen bg-slate-50 p-6">
        <div className="bg-rose-50 border-2 border-rose-300 text-rose-800 rounded-lg p-4">
          <AlertCircle className="inline w-4 h-4 mr-1" /> {err || 'Falha ao carregar'}
        </div>
        <button onClick={reload} className="mt-3 px-4 py-2 bg-rose-600 text-white rounded">Tentar novamente</button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 p-4 md:p-6">
      <div className="max-w-5xl mx-auto pb-32">
        <Link href="/retaguarda" className="inline-flex items-center gap-2 text-rose-700 hover:text-rose-900 mb-4">
          <ArrowLeft size={18} /> Voltar
        </Link>
        <h1 className="text-2xl md:text-3xl font-bold text-rose-900 mb-2">Configuração do Carnê</h1>
        <p className="text-sm text-slate-600 mb-6">
          Coordenadas em <b>pontos (pt)</b>. Folha A4 = 595×842pt. Salvar aplica imediatamente.
        </p>

        {err && (
          <div className="bg-rose-50 border-2 border-rose-300 text-rose-800 rounded-lg p-3 mb-4">
            <AlertCircle className="inline w-4 h-4 mr-1" /> {err}
          </div>
        )}

        <div className="bg-white rounded-2xl shadow-sm p-5 mb-4">
          <h2 className="font-bold text-rose-900 mb-3">Posição vertical dos blocos</h2>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs uppercase font-bold text-slate-600">Bloco 1 (Y)</label>
              <input type="number" value={coords.blocoY[0]} onChange={(e) => updateBlocoY(0, Number(e.target.value))} className="w-full px-3 py-2 border-2 border-slate-200 rounded-lg font-mono" />
            </div>
            <div>
              <label className="text-xs uppercase font-bold text-slate-600">Bloco 2 (Y)</label>
              <input type="number" value={coords.blocoY[1]} onChange={(e) => updateBlocoY(1, Number(e.target.value))} className="w-full px-3 py-2 border-2 border-slate-200 rounded-lg font-mono" />
            </div>
          </div>
        </div>

        <div className="bg-white rounded-2xl shadow-sm p-5 mb-4">
          <h2 className="font-bold text-rose-900 mb-3">Campos do cabeçalho (Bloco 1 e 2)</h2>
          <div className="text-xs text-slate-500 mb-3">
            X = horizontal · dY = vertical relativo ao topo do bloco
          </div>
          <div className="space-y-2">
            {Object.keys(FIELD_LABELS).map((key) => {
              const f = coords.fields[key];
              if (!f) return null;
              return (
                <div key={key} className="grid grid-cols-[1fr_120px_120px] gap-3 items-center bg-slate-50 rounded-lg p-2">
                  <span className="text-sm font-bold text-slate-700">{FIELD_LABELS[key]}</span>
                  <div>
                    <label className="text-[10px] uppercase font-bold text-slate-500">X</label>
                    <input type="number" value={f.x} onChange={(e) => updateField(key, 'x', Number(e.target.value))} className="w-full px-2 py-1 border border-slate-200 rounded font-mono text-sm" />
                  </div>
                  <div>
                    <label className="text-[10px] uppercase font-bold text-slate-500">dY</label>
                    <input type="number" value={f.dy} onChange={(e) => updateField(key, 'dy', Number(e.target.value))} className="w-full px-2 py-1 border border-slate-200 rounded font-mono text-sm" />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="bg-white rounded-2xl shadow-sm p-5 mb-4">
          <h2 className="font-bold text-rose-900 mb-3">8. Parcelas (5 esquerda + 5 direita)</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {(['parcelaEsq', 'parcelaDir'] as const).map((lado) => (
              <div key={lado} className="bg-slate-50 rounded-lg p-3 space-y-2">
                <div className="font-bold text-slate-800">{lado === 'parcelaEsq' ? 'Esquerda (1-5)' : 'Direita (6-10)'}</div>
                {(['xValor', 'xData', 'dy0', 'dyStep'] as const).map((k) => (
                  <div key={k} className="grid grid-cols-[1fr_120px] items-center gap-2">
                    <label className="text-xs font-bold text-slate-600">
                      {k === 'xValor' ? 'X do valor' : k === 'xData' ? 'X da data' : k === 'dy0' ? 'dY inicial' : 'dY entre linhas'}
                    </label>
                    <input type="number" value={coords[lado][k]} onChange={(e) => updateParcela(lado, k, Number(e.target.value))} className="px-2 py-1 border border-slate-200 rounded font-mono text-sm" />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>

        <div className="bg-white rounded-2xl shadow-sm p-5 mb-4">
          <h2 className="font-bold text-rose-900 mb-1">Bloco 3 — Parcelas antigas pendentes</h2>
          <div className="text-xs text-slate-500 mb-3">3 colunas com valor + vencimento (ordenadas por data).</div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {(['col1', 'col2', 'col3'] as const).map((col) => (
              <div key={col} className="bg-slate-50 rounded-lg p-3 space-y-2">
                <div className="font-bold text-slate-800">{col === 'col1' ? 'Coluna 1' : col === 'col2' ? 'Coluna 2' : 'Coluna 3'}</div>
                {(['x', 'yStart', 'dyStep'] as const).map((k) => (
                  <div key={k}>
                    <label className="text-[10px] uppercase font-bold text-slate-500">
                      {k === 'x' ? 'X' : k === 'yStart' ? 'Y inicial' : 'Espaço linhas'}
                    </label>
                    <input type="number" value={coords.totalAVencer[col][k]} onChange={(e) => updateColuna(col, k, Number(e.target.value))} className="w-full px-2 py-1 border border-slate-200 rounded font-mono text-sm" />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>

        <div className="bg-violet-50 border-2 border-violet-300 rounded-2xl p-5 mb-4">
          <h2 className="font-bold text-violet-900 mb-2">Gerar PDF de teste</h2>
          <div className="text-xs text-violet-700 mb-2">
            Cole o ID de uma venda crediário pra gerar PDF (após salvar).
          </div>
          <div className="flex flex-col gap-2">
            <input value={testSaleId} onChange={(e) => setTestSaleId(e.target.value)} placeholder="saleId (UUID)" className="px-3 py-2 border-2 border-violet-200 rounded-lg font-mono" />
            <div className="flex gap-2">
              <button onClick={() => gerarTeste(false)} className="flex-1 px-4 py-2 bg-violet-600 hover:bg-violet-700 text-white font-bold rounded-lg flex items-center justify-center gap-1">
                <Eye size={16} /> PDF normal
              </button>
              <button onClick={() => gerarTeste(true)} className="flex-1 px-4 py-2 bg-amber-500 hover:bg-amber-600 text-white font-bold rounded-lg flex items-center justify-center gap-1">
                <Eye size={16} /> PDF com grade (debug)
              </button>
            </div>
            <div className="text-[11px] text-violet-700">
              <b>PDF com grade</b> — bordas, régua de coords e labels [campo] em vermelho.
            </div>
          </div>
        </div>
      </div>

      <div className="fixed bottom-0 left-0 right-0 bg-white border-t-2 border-slate-200 shadow-2xl p-3 flex items-center justify-between gap-3 z-10">
        <button onClick={resetar} disabled={saving} className="px-4 py-3 border-2 border-slate-300 text-slate-700 font-bold rounded-xl hover:bg-slate-50 disabled:opacity-50 flex items-center gap-2">
          <RotateCcw size={16} /> Restaurar padrão
        </button>
        {savedAt && <span className="text-xs text-emerald-700 font-semibold">✓ Salvo às {savedAt.toLocaleTimeString('pt-BR')}</span>}
        <button onClick={salvar} disabled={saving} className="px-6 py-3 bg-emerald-600 hover:bg-emerald-700 text-white font-black rounded-xl flex items-center gap-2 disabled:opacity-50">
          {saving ? <Loader2 className="w-5 h-5 animate-spin" /> : <Save className="w-5 h-5" />}
          Salvar configuração
        </button>
      </div>
    </div>
  );
}
