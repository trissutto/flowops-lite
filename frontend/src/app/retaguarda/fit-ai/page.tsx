'use client';

/**
 * /retaguarda/fit-ai — painel do LURDS FIT AI.
 *
 * Duas abas:
 *   Dashboard — precisão, trocas evitadas, peças que mais erram/acertam,
 *               precisão por categoria/marca e as peças em que o sistema
 *               está com mais dúvida (= falta cadastrar ficha).
 *   Ficha da peça — cadastro de modelagem/elastano/caimento por REF. É o
 *               que faz a recomendação sair de "boa" pra "cirúrgica".
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, Sparkles, Loader2, Search, Save, TrendingUp, TrendingDown,
  Target, Users, RefreshCw, AlertTriangle, CheckCircle2,
} from 'lucide-react';
import { api } from '@/lib/api';

const OURO = '#B8912B';

type Dash = {
  periodoDias: number;
  kpis: {
    recomendacoes: number; clientesAtendidas: number; comDesfecho: number;
    precisaoGeral: number | null; confiancaMedia: number;
    trocas: number; devolucoes: number; trocasEvitadas: number;
  };
  maiorTroca: Array<any>;
  maiorAcerto: Array<any>;
  maiorDuvida: Array<{ ref: string; consultas: number; confiancaMedia: number }>;
  porCategoria: Array<{ chave: string; amostras: number; precisao: number | null; viesMedio: number }>;
  porMarca: Array<{ chave: string; amostras: number; precisao: number | null; viesMedio: number }>;
};

export default function FitAiPage() {
  const [aba, setAba] = useState<'dash' | 'ficha'>('dash');
  const [dias, setDias] = useState(30);
  const [dash, setDash] = useState<Dash | null>(null);
  const [loading, setLoading] = useState(false);

  const carregar = () => {
    setLoading(true);
    api<Dash>(`/fit/dashboard?dias=${dias}`).then(setDash).catch(() => setDash(null)).finally(() => setLoading(false));
  };
  useEffect(() => { if (aba === 'dash') carregar(); /* eslint-disable-next-line */ }, [aba, dias]);

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="text-white shadow" style={{ background: `linear-gradient(120deg, #8C7325, ${OURO})` }}>
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link href="/retaguarda" className="p-2 hover:bg-white/10 rounded"><ArrowLeft className="w-5 h-5" /></Link>
          <Sparkles className="w-6 h-6" />
          <div className="flex-1">
            <h1 className="text-lg font-black">Lurd&apos;s Fit AI</h1>
            <p className="text-xs text-white/80">Recomendação de tamanho — sistema próprio</p>
          </div>
          {aba === 'dash' && (
            <button onClick={carregar} className="p-2 hover:bg-white/10 rounded">
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
          )}
        </div>
      </header>

      <div className="max-w-6xl mx-auto p-4 space-y-4">
        <div className="flex gap-2">
          {(['dash', 'ficha'] as const).map((a) => (
            <button
              key={a}
              onClick={() => setAba(a)}
              className={`px-4 py-2 rounded-lg font-bold text-sm transition ${
                aba === a ? 'text-white shadow' : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'
              }`}
              style={aba === a ? { background: OURO } : {}}
            >
              {a === 'dash' ? 'Dashboard' : 'Ficha da peça'}
            </button>
          ))}
          {aba === 'dash' && (
            <select
              value={dias}
              onChange={(e) => setDias(Number(e.target.value))}
              className="ml-auto border border-slate-200 rounded-lg px-3 py-2 text-sm bg-white"
            >
              {[7, 30, 90, 365].map((d) => <option key={d} value={d}>Últimos {d} dias</option>)}
            </select>
          )}
        </div>

        {aba === 'dash' ? <Dashboard dash={dash} loading={loading} /> : <FichaPeca />}
      </div>
    </div>
  );
}

function Dashboard({ dash, loading }: { dash: Dash | null; loading: boolean }) {
  if (loading && !dash) {
    return <div className="py-16 text-center"><Loader2 className="w-6 h-6 animate-spin mx-auto" style={{ color: OURO }} /></div>;
  }
  if (!dash) return <Vazio texto="Sem dados ainda — o painel enche conforme as clientes usam o assistente." />;
  const k = dash.kpis;

  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi icone={Target} label="Precisão geral" valor={k.precisaoGeral != null ? `${k.precisaoGeral}%` : '—'}
             sub={`${k.comDesfecho} com desfecho`} destaque />
        <Kpi icone={Users} label="Clientes atendidas" valor={String(k.clientesAtendidas)}
             sub={`${k.recomendacoes} recomendações`} />
        <Kpi icone={CheckCircle2} label="Trocas evitadas" valor={String(k.trocasEvitadas)}
             sub="comprou e ficou" />
        <Kpi icone={TrendingUp} label="Confiança média" valor={`${k.confiancaMedia}%`}
             sub={`${k.trocas} trocas · ${k.devolucoes} devoluções`} />
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <Card titulo="Peças com MAIOR troca" icone={TrendingDown} cor="text-rose-600">
          <Tabela
            cols={['REF', 'Trocas', 'Tendência', 'Precisão']}
            linhas={dash.maiorTroca.map((r) => [
              r.ref, String(r.trocas),
              <span key="t" className={r.viesMedio > 0 ? 'text-amber-700' : 'text-sky-700'}>{r.tendencia}</span>,
              r.precisao != null ? `${r.precisao}%` : '—',
            ])}
            vazio="Nenhuma troca registrada ainda."
          />
        </Card>

        <Card titulo="Peças com MAIOR acerto" icone={CheckCircle2} cor="text-emerald-600">
          <Tabela
            cols={['REF', 'Amostras', 'Precisão']}
            linhas={dash.maiorAcerto.map((r) => [r.ref, String(r.amostras), `${r.precisao}%`])}
            vazio="Ainda juntando amostras."
          />
        </Card>

        <Card titulo="Precisão por categoria" icone={Target} cor="text-slate-600">
          <Tabela
            cols={['Categoria', 'Amostras', 'Precisão', 'Viés']}
            linhas={dash.porCategoria.map((r) => [
              r.chave, String(r.amostras), r.precisao != null ? `${r.precisao}%` : '—', fmtVies(r.viesMedio),
            ])}
            vazio="Sem dados."
          />
        </Card>

        <Card titulo="Precisão por marca" icone={Target} cor="text-slate-600">
          <Tabela
            cols={['Marca', 'Amostras', 'Precisão', 'Viés']}
            linhas={dash.porMarca.map((r) => [
              r.chave, String(r.amostras), r.precisao != null ? `${r.precisao}%` : '—', fmtVies(r.viesMedio),
            ])}
            vazio="Sem dados."
          />
        </Card>
      </div>

      <Card titulo="Peças com MAIOR dúvida — falta cadastrar a ficha" icone={AlertTriangle} cor="text-amber-600">
        <p className="text-xs text-slate-500 mb-2">
          Confiança baixa quase sempre significa peça sem modelagem/elastano cadastrados. Cadastre na aba
          &quot;Ficha da peça&quot; e a precisão sobe na hora.
        </p>
        <Tabela
          cols={['REF', 'Consultas', 'Confiança média']}
          linhas={dash.maiorDuvida.map((r) => [r.ref, String(r.consultas), `${r.confiancaMedia}%`])}
          vazio="Nenhuma peça com dúvida recorrente."
        />
      </Card>
    </>
  );
}

function FichaPeca() {
  const [ref, setRef] = useState('');
  const [f, setF] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const buscar = async () => {
    const r = ref.trim().toUpperCase();
    if (!r) return;
    setBusy(true); setMsg(null);
    try { setF(await api<any>(`/fit/produto/${encodeURIComponent(r)}`)); }
    catch (e: any) { setMsg('Erro: ' + (e?.message || e)); }
    finally { setBusy(false); }
  };

  const salvar = async () => {
    setBusy(true); setMsg(null);
    try {
      await api('/fit/produto', { method: 'POST', body: JSON.stringify({ ...f, ref: f.ref }) });
      setMsg('Ficha salva — a recomendação dessa peça já melhorou.');
    } catch (e: any) { setMsg('Erro: ' + (e?.message || e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      <div className="bg-white border border-slate-200 rounded-xl p-4">
        <label className="block text-xs font-bold uppercase text-slate-500 mb-1.5">REF da peça</label>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              value={ref}
              onChange={(e) => setRef(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && buscar()}
              placeholder="Ex.: 12345"
              className="w-full pl-9 pr-3 py-2.5 border-2 border-slate-200 rounded-lg font-mono focus:outline-none focus:border-[#B8912B]"
            />
          </div>
          <button
            onClick={buscar} disabled={busy}
            className="px-5 rounded-lg text-white font-bold text-sm disabled:opacity-50"
            style={{ background: OURO }}
          >
            {busy ? '...' : 'Buscar'}
          </button>
        </div>
      </div>

      {f && (
        <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-4">
          <div className="flex items-center gap-2">
            <span className="font-black text-slate-800 text-lg font-mono">{f.ref}</span>
            {f.semFicha
              ? <span className="text-[11px] bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full font-bold">SEM FICHA</span>
              : <span className="text-[11px] bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full font-bold">CADASTRADA</span>}
            {f.marca && <span className="text-xs text-slate-500">· {f.marca}</span>}
          </div>

          <Escolha
            label="Modelagem" valor={f.modelagem} onChange={(v) => setF({ ...f, modelagem: v })}
            ops={[
              { v: 'pequena', t: 'Pequena', d: 'veste menor' },
              { v: 'normal', t: 'Normal', d: 'fiel à grade' },
              { v: 'grande', t: 'Grande', d: 'veste maior' },
            ]}
          />
          <Escolha
            label="Elasticidade" valor={f.elastano} onChange={(v) => setF({ ...f, elastano: v })}
            ops={[
              { v: 'sem', t: 'Sem elastano', d: 'não cede' },
              { v: 'pouco', t: 'Pouco elastano', d: 'cede um pouco' },
              { v: 'muito', t: 'Muito elastano', d: 'cede bastante' },
            ]}
          />
          <Escolha
            label="Caimento" valor={f.caimento} onChange={(v) => setF({ ...f, caimento: v })}
            ops={[
              { v: 'justo', t: 'Justo', d: 'marca o corpo' },
              { v: 'normal', t: 'Normal', d: 'padrão' },
              { v: 'amplo', t: 'Amplo', d: 'soltinho' },
            ]}
          />

          <div className="grid md:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-bold uppercase text-slate-500 mb-1.5">Categoria</label>
              <select
                value={f.categoria || ''} onChange={(e) => setF({ ...f, categoria: e.target.value })}
                className="w-full px-3 py-2 border-2 border-slate-200 rounded-lg text-sm"
              >
                <option value="">—</option>
                {['vestido', 'blusa', 'camisa', 'calca', 'legging', 'jaqueta', 'saia', 'macacao', 'short'].map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-bold uppercase text-slate-500 mb-1.5">Composição</label>
              <input
                value={f.composicao || ''} onChange={(e) => setF({ ...f, composicao: e.target.value })}
                placeholder="95% viscose, 5% elastano"
                className="w-full px-3 py-2 border-2 border-slate-200 rounded-lg text-sm"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold uppercase text-slate-500 mb-1.5">Observação da peça</label>
            <textarea
              value={f.observacao || ''} onChange={(e) => setF({ ...f, observacao: e.target.value })}
              rows={2} placeholder="Ex.: manga curta, decote alto, tecido pesado"
              className="w-full px-3 py-2 border-2 border-slate-200 rounded-lg text-sm"
            />
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={salvar} disabled={busy}
              className="px-5 py-2.5 rounded-lg text-white font-bold text-sm flex items-center gap-2 disabled:opacity-50"
              style={{ background: OURO }}
            >
              <Save className="w-4 h-4" /> {busy ? 'Salvando…' : 'Salvar ficha'}
            </button>
            {msg && <span className="text-sm text-slate-600">{msg}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

// ── UI ────────────────────────────────────────────────────────────────
function Kpi({ icone: Icone, label, valor, sub, destaque }: any) {
  return (
    <div className={`rounded-xl p-4 border ${destaque ? 'text-white border-transparent' : 'bg-white border-slate-200'}`}
         style={destaque ? { background: `linear-gradient(135deg, #8C7325, ${OURO})` } : {}}>
      <div className={`flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider ${destaque ? 'text-white/80' : 'text-slate-400'}`}>
        <Icone className="w-3.5 h-3.5" /> {label}
      </div>
      <div className="text-3xl font-black mt-1">{valor}</div>
      <div className={`text-[11px] mt-0.5 ${destaque ? 'text-white/70' : 'text-slate-400'}`}>{sub}</div>
    </div>
  );
}

function Card({ titulo, icone: Icone, cor, children }: any) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
      <div className="px-4 py-2.5 border-b border-slate-100 flex items-center gap-2">
        <Icone className={`w-4 h-4 ${cor}`} />
        <h2 className="text-sm font-black text-slate-800">{titulo}</h2>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

function Tabela({ cols, linhas, vazio }: { cols: string[]; linhas: any[][]; vazio: string }) {
  if (!linhas.length) return <p className="text-xs text-slate-400 py-2">{vazio}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[10px] uppercase text-slate-400 border-b border-slate-100">
            {cols.map((c, i) => <th key={c} className={`py-1.5 ${i === 0 ? 'text-left' : 'text-right'}`}>{c}</th>)}
          </tr>
        </thead>
        <tbody>
          {linhas.map((l, i) => (
            <tr key={i} className="border-b border-slate-50 last:border-0">
              {l.map((c, j) => (
                <td key={j} className={`py-1.5 ${j === 0 ? 'text-left font-mono font-bold text-slate-700' : 'text-right tabular-nums'}`}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Escolha({ label, valor, onChange, ops }: {
  label: string;
  valor: string | null;
  onChange: (v: string | null) => void;
  ops: Array<{ v: string; t: string; d: string }>;
}) {
  return (
    <div>
      <label className="block text-xs font-bold uppercase text-slate-500 mb-1.5">{label}</label>
      <div className="grid grid-cols-3 gap-2">
        {ops.map((o) => {
          const ativo = valor === o.v;
          return (
            <button
              key={o.v}
              onClick={() => onChange(ativo ? null : o.v)}
              className="rounded-xl border-2 px-2 py-2.5 text-center transition hover:bg-[#FBF6E6]"
              style={{ borderColor: ativo ? OURO : '#E7E2D8', background: ativo ? '#FBF6E6' : '#fff' }}
            >
              <div className="font-bold text-[13px] text-slate-800">{o.t}</div>
              <div className="text-[10px] text-slate-500">{o.d}</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Vazio({ texto }: { texto: string }) {
  return (
    <div className="bg-white border border-dashed border-slate-300 rounded-xl p-10 text-center">
      <Sparkles className="w-8 h-8 mx-auto text-slate-300 mb-2" />
      <p className="text-sm text-slate-500">{texto}</p>
    </div>
  );
}

const fmtVies = (v: number) =>
  v > 0.3 ? `+${v.toFixed(1)} (veste pequeno)` : v < -0.3 ? `${v.toFixed(1)} (veste grande)` : 'fiel';
