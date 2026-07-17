'use client';

/**
 * /retaguarda/demandas — DEMANDAS (backlog do dono, 15/07).
 * Prompt + prints colados (Ctrl+V) ou arquivo, criticidade URGENTE /
 * IMPORTANTE / MELHORIA, data de criação e de finalização. Só admin.
 */

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, ClipboardList, Check, Loader2, Plus, Trash2, X, ImagePlus, RotateCcw } from 'lucide-react';
import { api } from '@/lib/api';

type Demanda = {
  id: string;
  titulo: string | null;
  prompt: string;
  criticidade: 'URGENTE' | 'IMPORTANTE' | 'MELHORIA';
  status: 'aberta' | 'concluida';
  createdAt: string;
  finishedAt: string | null;
  nImagens: number;
};

const CRIT_STYLE: Record<string, string> = {
  URGENTE: 'bg-red-100 text-red-800 border-red-300',
  IMPORTANTE: 'bg-amber-100 text-amber-800 border-amber-300',
  MELHORIA: 'bg-sky-100 text-sky-800 border-sky-300',
};

const fmtData = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';

export default function DemandasPage() {
  const router = useRouter();
  const [allowed, setAllowed] = useState(false);
  const [list, setList] = useState<Demanda[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [filtroStatus, setFiltroStatus] = useState<'todas' | 'aberta' | 'concluida'>('aberta');
  const [filtroCrit, setFiltroCrit] = useState<string>('');

  // Formulário
  const [titulo, setTitulo] = useState('');
  const [prompt, setPrompt] = useState('');
  const [criticidade, setCriticidade] = useState<'URGENTE' | 'IMPORTANTE' | 'MELHORIA'>('IMPORTANTE');
  const [imagens, setImagens] = useState<Array<{ mime: string; dataB64: string }>>([]);
  const [salvando, setSalvando] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Detalhe (imagens grandes)
  const [detalhe, setDetalhe] = useState<any | null>(null);

  useEffect(() => {
    api<{ role: string }>('/auth/me')
      .then((me) => { if (me.role !== 'admin') { router.push('/'); return; } setAllowed(true); })
      .catch(() => router.push('/login'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = async () => {
    setBusy(true); setErr('');
    try {
      const qs = new URLSearchParams();
      if (filtroStatus !== 'todas') qs.set('status', filtroStatus);
      if (filtroCrit) qs.set('criticidade', filtroCrit);
      setList(await api<Demanda[]>(`/demandas?${qs.toString()}`));
    } catch (e: any) { setErr(e?.message || 'Falha ao carregar'); }
    finally { setBusy(false); }
  };
  useEffect(() => { if (allowed) load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [allowed, filtroStatus, filtroCrit]);

  const addFiles = (files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      if (!f.type.startsWith('image/')) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const b64 = String(reader.result || '').split(',')[1] || '';
        if (b64) setImagens((prev) => [...prev, { mime: f.type, dataB64: b64 }].slice(0, 10));
      };
      reader.readAsDataURL(f);
    }
  };

  const criar = async () => {
    if (!prompt.trim()) { setErr('Escreva a demanda'); return; }
    setSalvando(true); setErr('');
    try {
      await api('/demandas', { method: 'POST', body: JSON.stringify({ titulo, prompt, criticidade, imagens }) });
      setTitulo(''); setPrompt(''); setImagens([]); setCriticidade('IMPORTANTE');
      await load();
    } catch (e: any) { setErr(e?.message || 'Falha ao criar'); }
    finally { setSalvando(false); }
  };

  const mudarStatus = async (d: Demanda) => {
    await api(`/demandas/${d.id}`, { method: 'PATCH', body: JSON.stringify({ status: d.status === 'aberta' ? 'concluida' : 'aberta' }) }).catch(() => null);
    await load();
  };

  const excluir = async (d: Demanda) => {
    if (!window.confirm(`Excluir a demanda "${d.titulo || d.prompt.slice(0, 40)}"?`)) return;
    await api(`/demandas/${d.id}`, { method: 'DELETE' }).catch(() => null);
    await load();
  };

  const abrirDetalhe = async (d: Demanda) => {
    const full = await api<any>(`/demandas/${d.id}`).catch(() => null);
    if (full) setDetalhe(full);
  };

  if (!allowed) return <div className="min-h-screen flex items-center justify-center text-slate-400 text-sm">Carregando…</div>;

  return (
    <div className="min-h-screen bg-slate-50 pb-16">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-20">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link href="/retaguarda" className="text-slate-500 hover:text-slate-800"><ArrowLeft className="w-5 h-5" /></Link>
          <ClipboardList className="w-5 h-5 text-amber-600" />
          <h1 className="font-bold text-slate-800 text-lg">Demandas</h1>
          <span className="text-[11px] text-slate-500">prompt + prints · criticidade · criação e finalização</span>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-5">
        {err && <div className="mb-3 bg-red-50 border border-red-200 text-red-800 px-3 py-2 rounded-lg text-sm">{err}</div>}

        {/* Nova demanda */}
        <div
          className="bg-white rounded-xl border-2 border-slate-200 p-4 mb-5"
          onPaste={(e) => { if (e.clipboardData?.files?.length) { e.preventDefault(); addFiles(e.clipboardData.files); } }}
        >
          <div className="flex gap-2 mb-2">
            <input value={titulo} onChange={(e) => setTitulo(e.target.value)} maxLength={120}
              placeholder="Título (opcional)"
              className="flex-1 px-3 py-2 border-2 border-slate-200 rounded-xl text-sm font-semibold focus:border-amber-400 focus:outline-none" />
            <div className="flex gap-1">
              {(['URGENTE', 'IMPORTANTE', 'MELHORIA'] as const).map((c) => (
                <button key={c} onClick={() => setCriticidade(c)}
                  className={`px-3 py-2 rounded-xl text-[11px] font-black border-2 ${criticidade === c ? CRIT_STYLE[c] : 'border-slate-200 text-slate-400'}`}>
                  {c}
                </button>
              ))}
            </div>
          </div>
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3}
            placeholder="Escreve a demanda como se fosse um prompt… (cola prints aqui com Ctrl+V)"
            className="w-full px-3 py-2 border-2 border-slate-200 rounded-xl text-sm focus:border-amber-400 focus:outline-none" />
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            {imagens.map((img, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <span key={i} className="relative">
                <img src={`data:${img.mime};base64,${img.dataB64}`} alt="" className="h-14 rounded-lg border border-slate-200" />
                <button onClick={() => setImagens((prev) => prev.filter((_, j) => j !== i))}
                  className="absolute -top-1.5 -right-1.5 bg-red-600 text-white rounded-full w-4 h-4 text-[10px] leading-4" aria-label="Remover">×</button>
              </span>
            ))}
            <button onClick={() => fileRef.current?.click()}
              className="px-3 py-1.5 rounded-lg border-2 border-slate-300 text-slate-500 text-xs font-bold flex items-center gap-1.5">
              <ImagePlus className="w-3.5 h-3.5" /> Imagem
            </button>
            <input ref={fileRef} type="file" accept="image/*" multiple className="hidden"
              onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }} />
            <div className="flex-1" />
            <button onClick={criar} disabled={salvando || !prompt.trim()}
              className="px-5 py-2 rounded-xl text-white text-sm font-black flex items-center gap-2 disabled:opacity-40"
              style={{ background: '#B8912B' }}>
              {salvando ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Criar demanda
            </button>
          </div>
        </div>

        {/* Filtros */}
        <div className="flex gap-2 mb-3 flex-wrap">
          {([['aberta', 'Abertas'], ['concluida', 'Concluídas'], ['todas', 'Todas']] as const).map(([k, label]) => (
            <button key={k} onClick={() => setFiltroStatus(k)}
              className={`px-3 py-1.5 rounded-full text-xs font-bold border-2 ${filtroStatus === k ? 'bg-slate-800 text-white border-slate-800' : 'border-slate-300 text-slate-500'}`}>
              {label}
            </button>
          ))}
          <span className="w-2" />
          {['', 'URGENTE', 'IMPORTANTE', 'MELHORIA'].map((c) => (
            <button key={c || 'todas'} onClick={() => setFiltroCrit(c)}
              className={`px-3 py-1.5 rounded-full text-xs font-bold border-2 ${filtroCrit === c ? (c ? CRIT_STYLE[c] : 'bg-slate-800 text-white border-slate-800') : 'border-slate-300 text-slate-500'}`}>
              {c || 'Todas criticidades'}
            </button>
          ))}
        </div>

        {/* Lista */}
        {busy && <div className="text-center text-slate-400 py-8 text-sm">Carregando…</div>}
        {!busy && !list.length && <div className="text-center text-slate-400 py-8 text-sm">Nenhuma demanda aqui.</div>}
        <div className="space-y-2">
          {list.map((d) => (
            <div key={d.id}
              className={`bg-white rounded-xl border-2 p-3 flex items-start gap-3 ${d.status === 'concluida' ? 'border-slate-100 opacity-60' : 'border-slate-200'}`}>
              <span className={`px-2 py-1 rounded-lg text-[10px] font-black border ${CRIT_STYLE[d.criticidade]}`}>{d.criticidade}</span>
              <div className="flex-1 min-w-0 cursor-pointer" onClick={() => abrirDetalhe(d)}>
                {d.titulo && <div className="font-bold text-slate-800 text-sm">{d.titulo}</div>}
                <div className={`text-sm text-slate-600 whitespace-pre-wrap ${d.status === 'concluida' ? 'line-through' : ''}`}>{d.prompt.slice(0, 300)}{d.prompt.length > 300 ? '…' : ''}</div>
                <div className="text-[11px] text-slate-400 mt-1">
                  criada {fmtData(d.createdAt)}
                  {d.finishedAt ? <> · <span className="text-emerald-700 font-semibold">finalizada {fmtData(d.finishedAt)}</span></> : null}
                  {d.nImagens > 0 ? <> · 📷 {d.nImagens}</> : null}
                </div>
              </div>
              <button onClick={() => mudarStatus(d)}
                title={d.status === 'aberta' ? 'Marcar como concluída' : 'Reabrir'}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold border-2 flex items-center gap-1 ${d.status === 'aberta' ? 'border-emerald-300 bg-emerald-50 text-emerald-800' : 'border-slate-300 text-slate-500'}`}>
                {d.status === 'aberta' ? <><Check className="w-3.5 h-3.5" /> Concluir</> : <><RotateCcw className="w-3.5 h-3.5" /> Reabrir</>}
              </button>
              <button onClick={() => excluir(d)} className="p-1.5 text-slate-300 hover:text-red-600" aria-label="Excluir">
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      </main>

      {/* Detalhe com imagens grandes */}
      {detalhe && (
        <div className="fixed inset-0 z-40 bg-black/50 flex items-center justify-center p-4" onClick={() => setDetalhe(null)}>
          <div className="bg-white rounded-2xl max-w-2xl w-full max-h-[85vh] overflow-y-auto p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 mb-2">
              <span className={`px-2 py-1 rounded-lg text-[10px] font-black border ${CRIT_STYLE[detalhe.criticidade]}`}>{detalhe.criticidade}</span>
              <h3 className="font-bold text-slate-800">{detalhe.titulo || 'Demanda'}</h3>
              <div className="flex-1" />
              <button onClick={() => setDetalhe(null)} className="text-slate-400"><X className="w-5 h-5" /></button>
            </div>
            <p className="text-sm text-slate-700 whitespace-pre-wrap mb-3">{detalhe.prompt}</p>
            <div className="text-[11px] text-slate-400 mb-3">criada {fmtData(detalhe.createdAt)} · {detalhe.finishedAt ? `finalizada ${fmtData(detalhe.finishedAt)}` : 'em aberto'}</div>
            {(detalhe.imagens || []).map((img: any) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={img.id} src={`data:${img.mime};base64,${img.dataB64}`} alt="" className="w-full rounded-xl border border-slate-200 mb-3" />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
