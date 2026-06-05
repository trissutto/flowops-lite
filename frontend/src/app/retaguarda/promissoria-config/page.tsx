'use client';

/**
 * /retaguarda/promissoria-config — painel admin pra ajustar coords da promissória.
 * Usa endpoints /pdv-diag/coords (GET, POST) que já existem há tempos.
 * Coords em MILÍMETROS (mm). Folha A4 = 210x297mm. 3 promissórias por folha.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Save, RotateCcw, Loader2, Eye, AlertCircle } from 'lucide-react';
import { api } from '@/lib/api';

type DiagResponse = {
  json_path_lido: string | null;
  json_existe: boolean;
  blocoY_mm: number[];
  blocoH_pt: number;
  campos_ativos_mm: Record<string, { x: number; y: number; w?: number }>;
  override_ativo?: boolean;
};

type FieldsMm = Record<string, { x: number; y: number; w?: number }>;

const FIELD_LABELS: Record<string, string> = {
  numero: 'Número da promissória',
  parcela: 'Nº parcela / total (Ex: 1/5)',
  valor: 'Valor da parcela',
  vencDia: 'Vencimento - dia',
  vencMes: 'Vencimento - mês',
  vencAno: 'Vencimento - ano',
  vencExtenso: 'Vencimento por extenso',
  beneficiarioA: 'Beneficiário (razão social)',
  cpfDevedor: 'CPF do devedor',
  quantiaExtenso: 'Quantia por extenso',
  pagavelEm: 'Pagável em (cidade)',
  emissaoDia: 'Emissão - dia',
  emissaoMes: 'Emissão - mês',
  emissaoAno: 'Emissão - ano',
  emitente: 'Nome do emitente',
  cpfEmitente: 'CPF do emitente',
  endereco: 'Endereço',
  cep: 'CEP',
};

export default function PromissoriaConfigPage() {
  const [fields, setFields] = useState<FieldsMm | null>(null);
  const [blocosY, setBlocosY] = useState<number[]>([7.76, 100.5, 192.7]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [overrideAtivo, setOverrideAtivo] = useState(false);
  const [testSaleId, setTestSaleId] = useState('');

  const reload = async () => {
    setLoading(true);
    setErr('');
    try {
      const r = await api<DiagResponse>('/pdv-diag/coords');
      setFields(r.campos_ativos_mm);
      if (r.blocoY_mm?.length === 3) setBlocosY(r.blocoY_mm);
      setOverrideAtivo(!!r.override_ativo);
    } catch (e: any) {
      setErr(e?.message || 'Falha ao carregar');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { reload(); }, []);

  const updateField = (key: string, axis: 'x' | 'y' | 'w', value: number) => {
    if (!fields) return;
    setFields({ ...fields, [key]: { ...fields[key], [axis]: value } });
  };

  const updateBlocoY = (idx: 0 | 1 | 2, value: number) => {
    const arr = [...blocosY];
    arr[idx] = value;
    setBlocosY(arr);
  };

  const salvar = async () => {
    if (!fields) return;
    setSaving(true);
    setErr('');
    try {
      const body = { blocosY_mm: blocosY, fields_mm: fields };
      await api('/pdv-diag/coords', { method: 'POST', body: JSON.stringify(body) });
      setSavedAt(new Date());
      setOverrideAtivo(true);
    } catch (e: any) {
      setErr(e?.message || 'Falha ao salvar');
    } finally {
      setSaving(false);
    }
  };

  const resetar = async () => {
    if (!confirm('Restaurar padrão? Vai perder ajustes do override (/tmp).')) return;
    setSaving(true);
    try {
      await api('/pdv-diag/coords/reset', { method: 'POST', body: '{}' });
      await reload();
    } catch (e: any) {
      setErr(e?.message || 'Falha ao resetar');
    } finally {
      setSaving(false);
    }
  };

  const gerarTeste = () => {
    if (!testSaleId.trim()) { alert('Digite um saleId'); return; }
    const apiUrl = process.env.NEXT_PUBLIC_API_URL || '';
    const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_token') : '';
    fetch(`${apiUrl}/pdv/sales/${testSaleId.trim()}/promissorias-pdf`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then((r) => r.ok ? r.blob() : r.json().then((j) => Promise.reject(j)))
      .then((blob: any) => {
        if (blob instanceof Blob) {
          window.open(URL.createObjectURL(blob), '_blank');
        }
      })
      .catch((e: any) => alert(`Falha: ${e?.message || JSON.stringify(e)}`));
  };

  if (loading) {
    return <div className="min-h-screen bg-slate-50 p-6 flex items-center justify-center"><Loader2 className="w-8 h-8 animate-spin text-rose-600" /></div>;
  }
  if (!fields) {
    return (
      <div className="min-h-screen bg-slate-50 p-6">
        <div className="bg-rose-50 border-2 border-rose-300 text-rose-800 rounded-lg p-4">
          <AlertCircle className="inline w-4 h-4 mr-1" /> {err || 'Falha ao carregar'}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 p-4 md:p-6">
      <div className="max-w-5xl mx-auto pb-32">
        <Link href="/retaguarda" className="inline-flex items-center gap-2 text-rose-700 hover:text-rose-900 mb-4">
          <ArrowLeft size={18} /> Voltar
        </Link>
        <h1 className="text-2xl md:text-3xl font-bold text-rose-900 mb-2">Configuração da Promissória</h1>
        <p className="text-sm text-slate-600 mb-2">
          Coordenadas em <b>milímetros (mm)</b>. Folha A4 = 210×297mm. 3 promissórias por folha.
        </p>
        <p className="text-xs text-slate-500 mb-4">
          X = horizontal · Y = vertical (relativo ao topo do bloco) · W = largura máxima do texto
        </p>

        {overrideAtivo && (
          <div className="bg-emerald-50 border-2 border-emerald-300 text-emerald-800 rounded-lg p-3 mb-4 text-sm">
            ✓ Configuração salva no <b>Postgres</b> (tabela <code className="bg-emerald-100 px-1 rounded">app_config</code>). Sobrevive a redeploys do Railway automaticamente.
            Cada impressão de promissória sincroniza o /tmp com o banco antes de gerar o PDF — nunca mais desconfigura.
          </div>
        )}

        {err && (
          <div className="bg-rose-50 border-2 border-rose-300 text-rose-800 rounded-lg p-3 mb-4">
            <AlertCircle className="inline w-4 h-4 mr-1" /> {err}
          </div>
        )}

        <div className="bg-white rounded-2xl shadow-sm p-5 mb-4">
          <h2 className="font-bold text-rose-900 mb-3">Posição Y dos 3 blocos (mm do topo da folha)</h2>
          <div className="grid grid-cols-3 gap-3">
            {[0, 1, 2].map((i) => (
              <div key={i}>
                <label className="text-xs uppercase font-bold text-slate-600">Bloco {i + 1}</label>
                <input type="number" step="0.1" value={blocosY[i]} onChange={(e) => updateBlocoY(i as 0 | 1 | 2, Number(e.target.value))} className="w-full px-3 py-2 border-2 border-slate-200 rounded-lg font-mono" />
              </div>
            ))}
          </div>
        </div>

        <div className="bg-white rounded-2xl shadow-sm p-5 mb-4">
          <h2 className="font-bold text-rose-900 mb-3">Campos da promissória</h2>
          <div className="space-y-2">
            {Object.keys(FIELD_LABELS).map((key) => {
              const f = fields[key];
              if (!f) return null;
              const hasW = f.w !== undefined;
              return (
                <div key={key} className={`grid gap-3 items-center bg-slate-50 rounded-lg p-2 ${hasW ? 'grid-cols-[1fr_100px_100px_100px]' : 'grid-cols-[1fr_120px_120px]'}`}>
                  <span className="text-sm font-bold text-slate-700">{FIELD_LABELS[key]}</span>
                  <div>
                    <label className="text-[10px] uppercase font-bold text-slate-500">X (mm)</label>
                    <input type="number" step="0.1" value={f.x} onChange={(e) => updateField(key, 'x', Number(e.target.value))} className="w-full px-2 py-1 border border-slate-200 rounded font-mono text-sm" />
                  </div>
                  <div>
                    <label className="text-[10px] uppercase font-bold text-slate-500">Y (mm)</label>
                    <input type="number" step="0.1" value={f.y} onChange={(e) => updateField(key, 'y', Number(e.target.value))} className="w-full px-2 py-1 border border-slate-200 rounded font-mono text-sm" />
                  </div>
                  {hasW && (
                    <div>
                      <label className="text-[10px] uppercase font-bold text-slate-500">W (mm)</label>
                      <input type="number" step="0.1" value={f.w} onChange={(e) => updateField(key, 'w', Number(e.target.value))} className="w-full px-2 py-1 border border-slate-200 rounded font-mono text-sm" />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div className="bg-violet-50 border-2 border-violet-300 rounded-2xl p-5 mb-4">
          <h2 className="font-bold text-violet-900 mb-2">Gerar PDF de teste</h2>
          <div className="text-xs text-violet-700 mb-2">Cole um saleId crediário pra gerar o PDF (após salvar).</div>
          <div className="flex gap-2">
            <input value={testSaleId} onChange={(e) => setTestSaleId(e.target.value)} placeholder="saleId (UUID)" className="flex-1 px-3 py-2 border-2 border-violet-200 rounded-lg font-mono" />
            <button onClick={gerarTeste} className="px-4 py-2 bg-violet-600 hover:bg-violet-700 text-white font-bold rounded-lg flex items-center gap-1">
              <Eye size={16} /> Gerar PDF
            </button>
          </div>
        </div>

        <div className="bg-slate-100 border border-slate-200 rounded-lg p-3 text-xs text-slate-600">
          <b>Dica:</b> também existe a tela legada em <code className="bg-white px-1 rounded">/api/pdv-diag/calibrar</code> servida direto pelo backend (sem Next.js).
          Usa a que preferir.
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
