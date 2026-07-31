'use client';

/**
 * /retaguarda/convenios — CONVÊNIO com sindicato (dono 21/07).
 *
 * Modelo: sindicato manda a lista de associados (nome + limite POR CICLO);
 * associado compra na loja conveniada sem pagar (pgto CONVÊNIO no PDV, valida
 * limite); a loja fecha a FATURA no dia combinado e o sindicato paga
 * (consolidado, descontando dos associados em folha).
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Handshake, Loader2, Plus, Users, FileText, Check, Printer, X } from 'lucide-react';
import { api } from '@/lib/api';

const brl = (cents: number | null | undefined) =>
  cents == null ? '—' : (Number(cents) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtData = (iso: any) => (iso ? new Date(iso).toLocaleDateString('pt-BR') : '—');

export default function ConveniosPage() {
  const [convenios, setConvenios] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [sel, setSel] = useState<any | null>(null);
  const [criando, setCriando] = useState(false);

  const load = async () => {
    setLoading(true);
    try { setConvenios(await api('/admin/convenios')); } catch { /* mantém */ }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  return (
    <div className="min-h-screen bg-[#FAFAF7] pb-16 text-slate-800">
      <header className="bg-white border-b border-[#E7E2D8] sticky top-0 z-20">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link href="/retaguarda" className="text-slate-500 hover:text-slate-800"><ArrowLeft className="w-5 h-5" /></Link>
          <Handshake className="w-5 h-5 text-[#B8912B]" />
          <div className="flex-1">
            <h1 className="font-bold text-lg">Convênios</h1>
            <p className="text-xs text-slate-500">Sindicato compra faturado — limite por associado, fatura mensal</p>
          </div>
          <button onClick={() => setCriando(true)}
            className="rounded-lg bg-[#B8912B] hover:bg-[#8C7325] text-white text-sm font-bold px-4 py-2 flex items-center gap-1.5">
            <Plus className="w-4 h-4" /> Novo convênio
          </button>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-5 space-y-4">
        {loading ? (
          <div className="text-center py-10 text-slate-400"><Loader2 className="w-6 h-6 animate-spin mx-auto" /></div>
        ) : sel ? (
          <ConvenioDetalhe convenio={sel} onVoltar={() => { setSel(null); load(); }} />
        ) : (
          <>
            <div className="grid md:grid-cols-2 gap-3">
              {convenios.map((c) => (
                <button key={c.id} onClick={() => setSel(c)}
                  className="text-left bg-white rounded-xl border border-[#E7E2D8] p-4 hover:border-[#D4AF37] hover:shadow-md transition">
                  <div className="flex items-center justify-between">
                    <div className="font-bold text-slate-800">{c.nome}</div>
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${c.ativo ? 'bg-emerald-50 border border-emerald-300 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
                      {c.ativo ? 'ATIVO' : 'INATIVO'}
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-slate-500">Loja {c.storeCode} · fecha dia {c.diaFechamento} · {c.membros} associado(s)</div>
                  <div className="mt-2 text-sm">
                    Ciclo aberto: <b className="text-[#2E7D46]">{brl(c.cicloAbertoCents)}</b>
                    <span className="text-slate-400 text-xs"> ({c.cicloAbertoQtd} compra(s))</span>
                  </div>
                </button>
              ))}
            </div>
            {convenios.length === 0 && (
              <div className="text-center py-12 text-slate-400 text-sm">
                Nenhum convênio ainda — clique em <b>Novo convênio</b> pra criar o do sindicato.
              </div>
            )}
          </>
        )}
        {criando && <NovoConvenioModal onClose={() => setCriando(false)} onSaved={() => { setCriando(false); load(); }} />}
      </main>
    </div>
  );
}

function NovoConvenioModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [nome, setNome] = useState('');
  const [storeCode, setStoreCode] = useState('');
  const [dia, setDia] = useState('20');
  const [lojas, setLojas] = useState<Array<{ code: string; name: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api<any[]>('/stores').then(setLojas).catch(() => {}); }, []);

  const salvar = async () => {
    setErr(null); setBusy(true);
    try {
      await api('/admin/convenios', {
        method: 'POST',
        body: JSON.stringify({ nome, storeCode, diaFechamento: Number(dia) || 20 }),
      });
      onSaved();
    } catch (e: any) { setErr(e?.message || 'Erro'); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-sm rounded-2xl bg-white shadow-2xl border border-[#E6DFC8] p-5 space-y-3">
        <h3 className="font-bold text-slate-800 flex items-center gap-2"><Handshake className="w-4 h-4 text-[#B8912B]" /> Novo convênio</h3>
        <div>
          <label className="text-[11px] uppercase font-bold text-slate-400">Nome (ex.: SINDICATO METALÚRGICOS)</label>
          <input value={nome} onChange={(e) => setNome(e.target.value.toUpperCase())}
            className="mt-0.5 w-full rounded-lg border border-[#E7E2D8] px-3 py-2 text-sm focus:border-[#D4AF37] focus:outline-none" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[11px] uppercase font-bold text-slate-400">Loja conveniada</label>
            <select value={storeCode} onChange={(e) => setStoreCode(e.target.value)}
              className="mt-0.5 w-full rounded-lg border border-[#E7E2D8] px-3 py-2 text-sm focus:border-[#D4AF37] focus:outline-none">
              <option value="">Selecione…</option>
              {lojas.map((l) => <option key={l.code} value={l.code}>{l.code} · {l.name}</option>)}
            </select>
          </div>
          <div>
            <label className="text-[11px] uppercase font-bold text-slate-400">Dia do fechamento</label>
            <input value={dia} onChange={(e) => setDia(e.target.value.replace(/\D/g, '').slice(0, 2))} inputMode="numeric"
              className="mt-0.5 w-full rounded-lg border border-[#E7E2D8] px-3 py-2 text-sm focus:border-[#D4AF37] focus:outline-none" />
          </div>
        </div>
        {err && <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700">{err}</div>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-bold text-slate-600">Cancelar</button>
          <button onClick={salvar} disabled={busy || !nome.trim() || !storeCode}
            className="rounded-lg bg-[#2E7D46] text-white px-4 py-2 text-sm font-bold disabled:opacity-50">
            {busy ? '...' : 'Criar convênio'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ConvenioDetalhe({ convenio, onVoltar }: { convenio: any; onVoltar: () => void }) {
  const [membros, setMembros] = useState<any[]>([]);
  const [faturas, setFaturas] = useState<any[]>([]);
  const [novoNome, setNovoNome] = useState('');
  const [novoMat, setNovoMat] = useState('');
  const [novoLim, setNovoLim] = useState('');
  const [lote, setLote] = useState('');
  const [loteAberto, setLoteAberto] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [detFatura, setDetFatura] = useState<any | null>(null);

  const load = async () => {
    try {
      const [m, f] = await Promise.all([
        api<any[]>(`/admin/convenios/${convenio.id}/membros`),
        api<any[]>(`/admin/convenios/${convenio.id}/faturas`),
      ]);
      setMembros(m || []); setFaturas(f || []);
    } catch { /* mantém */ }
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const addMembro = async () => {
    if (!novoNome.trim()) return;
    setBusy(true);
    try {
      await api(`/admin/convenios/${convenio.id}/membros`, {
        method: 'POST',
        body: JSON.stringify({ membros: [{ nome: novoNome, matricula: novoMat || undefined, limiteReais: Number(novoLim.replace(',', '.')) || 0 }] }),
      });
      setNovoNome(''); setNovoMat(''); setNovoLim('');
      await load();
    } catch (e: any) { setMsg(e?.message || 'Erro'); }
    finally { setBusy(false); }
  };

  /** Cola a lista do sindicato: uma linha por associado "NOME;MATRICULA;LIMITE"
   *  (matrícula opcional: "NOME;LIMITE" também funciona). */
  const importarLote = async () => {
    const linhas = lote.split('\n').map((l) => l.trim()).filter(Boolean);
    const membrosLote = linhas.map((l) => {
      const partes = l.split(/[;\t]/).map((p) => p.trim());
      if (partes.length >= 3) return { nome: partes[0], matricula: partes[1], limiteReais: Number(partes[2].replace(/\./g, '').replace(',', '.')) || 0 };
      if (partes.length === 2) return { nome: partes[0], limiteReais: Number(partes[1].replace(/\./g, '').replace(',', '.')) || 0 };
      return { nome: partes[0], limiteReais: 0 };
    }).filter((m) => m.nome);
    if (!membrosLote.length) return;
    setBusy(true);
    try {
      const r = await api<any>(`/admin/convenios/${convenio.id}/membros`, {
        method: 'POST', body: JSON.stringify({ membros: membrosLote }),
      });
      setMsg(`${r.adicionados} associado(s) importado(s)`);
      setLote(''); setLoteAberto(false);
      await load();
    } catch (e: any) { setMsg(e?.message || 'Erro no lote'); }
    finally { setBusy(false); }
  };

  const editarLimite = async (m: any) => {
    const novo = window.prompt(`Novo limite de ${m.nome} (R$):`, (m.limiteCents / 100).toFixed(2).replace('.', ','));
    if (novo == null) return;
    try {
      await api(`/admin/convenios/membros/${m.id}`, {
        method: 'POST', body: JSON.stringify({ limiteReais: Number(novo.replace(/\./g, '').replace(',', '.')) || 0 }),
      });
      await load();
    } catch (e: any) { setMsg(e?.message || 'Erro'); }
  };

  const toggleAtivo = async (m: any) => {
    try {
      await api(`/admin/convenios/membros/${m.id}`, { method: 'POST', body: JSON.stringify({ ativo: !m.ativo }) });
      await load();
    } catch (e: any) { setMsg(e?.message || 'Erro'); }
  };

  const fecharFatura = async () => {
    if (!confirm(`Fechar a fatura do ${convenio.nome} com TODAS as compras em aberto até hoje?\n\nO sindicato passa a dever essa fatura e o limite dos associados renova.`)) return;
    setBusy(true);
    try {
      const r = await api<any>(`/admin/convenios/${convenio.id}/fechar-fatura`, { method: 'POST', body: JSON.stringify({}) });
      setMsg(`Fatura fechada: ${r.compras} compra(s) · ${brl(r.totalCents)}`);
      await load();
    } catch (e: any) { setMsg(e?.message || 'Erro ao fechar'); }
    finally { setBusy(false); }
  };

  const verFatura = async (f: any) => {
    try { setDetFatura(await api(`/admin/convenios/faturas/${f.id}/detalhe`)); } catch { /* */ }
  };

  const marcarPaga = async (f: any) => {
    if (!confirm(`Marcar fatura de ${brl(f.totalCents)} como PAGA pelo sindicato?`)) return;
    try { await api(`/admin/convenios/faturas/${f.id}/pagar`, { method: 'POST' }); await load(); } catch { /* */ }
  };

  const totalAberto = membros.reduce((s, m) => s + (m.usadoCicloCents || 0), 0);

  return (
    <div className="space-y-4">
      <button onClick={onVoltar} className="text-sm text-slate-500 hover:text-slate-800 flex items-center gap-1">
        <ArrowLeft className="w-4 h-4" /> Convênios
      </button>

      <div className="bg-white rounded-2xl border border-[#E7E2D8] shadow-sm p-5 flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-xl font-black text-slate-900">{convenio.nome}</h2>
          <div className="text-xs text-slate-500">Loja {convenio.storeCode} · fecha dia {convenio.diaFechamento}</div>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <div className="text-[10px] uppercase font-bold text-slate-400">Ciclo aberto</div>
            <div className="text-lg font-black text-[#2E7D46]">{brl(totalAberto)}</div>
          </div>
          <button onClick={fecharFatura} disabled={busy || totalAberto === 0}
            className="rounded-lg bg-[#B8912B] hover:bg-[#8C7325] text-white text-sm font-bold px-4 py-2.5 flex items-center gap-1.5 disabled:opacity-40">
            <FileText className="w-4 h-4" /> Fechar fatura
          </button>
        </div>
      </div>

      {msg && <div className="rounded-lg bg-[#FBF6E6] border border-[#E6DFC8] px-3 py-2 text-sm text-[#8C7325] font-bold">{msg}</div>}

      {/* Associados */}
      <div className="bg-white rounded-2xl border border-[#E7E2D8] shadow-sm overflow-hidden">
        <div className="px-5 py-3 border-b border-[#F1EDE3] flex items-center justify-between">
          <h3 className="font-bold text-slate-800 flex items-center gap-2"><Users className="w-4 h-4 text-[#B8912B]" /> Associados ({membros.length})</h3>
          <button onClick={() => setLoteAberto(!loteAberto)} className="text-xs font-bold text-[#8C7325] underline decoration-dotted">
            Colar lista do sindicato
          </button>
        </div>
        {loteAberto && (
          <div className="px-5 py-3 bg-[#FBF6E6]/50 border-b border-[#F1EDE3] space-y-2">
            <p className="text-[11px] text-[#8C7325]">Uma linha por associado: <b>NOME;MATRÍCULA;LIMITE</b> (matrícula opcional: NOME;LIMITE). Pode colar direto do Excel.</p>
            <textarea value={lote} onChange={(e) => setLote(e.target.value)} rows={5}
              placeholder={'MARIA DA SILVA;1234;300,00\nJOSE SANTOS;500,00'}
              className="w-full rounded-lg border border-[#E6DFC8] px-3 py-2 text-xs font-mono focus:border-[#D4AF37] focus:outline-none" />
            <button onClick={importarLote} disabled={busy || !lote.trim()}
              className="rounded-lg bg-[#2E7D46] text-white text-xs font-bold px-3 py-1.5 disabled:opacity-50">Importar lista</button>
          </div>
        )}
        <div className="px-5 py-2.5 border-b border-[#F1EDE3] grid grid-cols-[1fr_120px_110px_auto] gap-2 items-end">
          <input value={novoNome} onChange={(e) => setNovoNome(e.target.value.toUpperCase())} placeholder="Nome do associado"
            className="rounded-lg border border-[#E7E2D8] px-3 py-1.5 text-sm focus:border-[#D4AF37] focus:outline-none" />
          <input value={novoMat} onChange={(e) => setNovoMat(e.target.value)} placeholder="Matrícula"
            className="rounded-lg border border-[#E7E2D8] px-3 py-1.5 text-sm focus:border-[#D4AF37] focus:outline-none" />
          <input value={novoLim} onChange={(e) => setNovoLim(e.target.value)} placeholder="Limite R$" inputMode="decimal"
            className="rounded-lg border border-[#E7E2D8] px-3 py-1.5 text-sm text-right focus:border-[#D4AF37] focus:outline-none" />
          <button onClick={addMembro} disabled={busy || !novoNome.trim()}
            className="rounded-lg bg-[#B8912B] text-white text-sm font-bold px-3 py-1.5 disabled:opacity-40">+ Add</button>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[11px] uppercase text-slate-400 border-b border-[#F1EDE3]">
              <th className="text-left px-5 py-2">Associado</th>
              <th className="text-left px-2 py-2">Matrícula</th>
              <th className="text-right px-2 py-2">Limite</th>
              <th className="text-right px-2 py-2">Usado (ciclo)</th>
              <th className="text-right px-2 py-2">Disponível</th>
              <th className="text-center px-5 py-2">Ativo</th>
            </tr>
          </thead>
          <tbody>
            {membros.map((m) => (
              <tr key={m.id} className={`border-b border-[#F8F5EC] ${!m.ativo ? 'opacity-40' : ''}`}>
                <td className="px-5 py-2 font-medium">{m.nome}</td>
                <td className="px-2 py-2 text-xs text-slate-500 font-mono">{m.matricula || '—'}</td>
                <td className="px-2 py-2 text-right tabular-nums">
                  <button onClick={() => editarLimite(m)} className="underline decoration-dotted hover:text-[#8C7325]" title="Editar limite">
                    {brl(m.limiteCents)}
                  </button>
                </td>
                <td className="px-2 py-2 text-right tabular-nums text-amber-700">{brl(m.usadoCicloCents)}</td>
                <td className="px-2 py-2 text-right tabular-nums font-bold text-[#2E7D46]">{brl(m.disponivelCents)}</td>
                <td className="px-5 py-2 text-center">
                  <button onClick={() => toggleAtivo(m)} className={`rounded-full px-2 py-0.5 text-[10px] font-bold border ${m.ativo ? 'bg-emerald-50 border-emerald-300 text-emerald-700' : 'bg-slate-100 border-slate-300 text-slate-500'}`}>
                    {m.ativo ? 'SIM' : 'NÃO'}
                  </button>
                </td>
              </tr>
            ))}
            {membros.length === 0 && (
              <tr><td colSpan={6} className="px-5 py-6 text-center text-slate-400 text-sm">Nenhum associado ainda — eles aparecem aqui sozinhos conforme o caixa lança compras no convênio (limite R$ 0,00 = conferência online no sindicato).</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Faturas */}
      <div className="bg-white rounded-2xl border border-[#E7E2D8] shadow-sm overflow-hidden">
        <div className="px-5 py-3 border-b border-[#F1EDE3]">
          <h3 className="font-bold text-slate-800 flex items-center gap-2"><FileText className="w-4 h-4 text-[#B8912B]" /> Faturas</h3>
        </div>
        <table className="w-full text-sm">
          <tbody>
            {faturas.map((f) => (
              <tr key={f.id} className="border-b border-[#F8F5EC]">
                <td className="px-5 py-2 text-xs text-slate-500">{fmtData(f.geradaEm)}</td>
                <td className="px-2 py-2 text-xs text-slate-500">{fmtData(f.de)} → {fmtData(f.ate)}</td>
                <td className="px-2 py-2 text-right tabular-nums font-bold">{brl(f.totalCents)}</td>
                <td className="px-2 py-2 text-center">
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${f.status === 'paga' ? 'bg-emerald-50 border border-emerald-300 text-emerald-700' : 'bg-amber-50 border border-amber-300 text-amber-700'}`}>
                    {f.status === 'paga' ? `PAGA ${fmtData(f.pagaEm)}` : 'AGUARDANDO SINDICATO'}
                  </span>
                </td>
                <td className="px-5 py-2 text-right whitespace-nowrap">
                  <button onClick={() => verFatura(f)} className="text-xs font-bold text-[#8C7325] underline decoration-dotted mr-3">detalhe</button>
                  {f.status !== 'paga' && (
                    <button onClick={() => marcarPaga(f)} className="text-xs font-bold text-emerald-700 underline decoration-dotted">marcar paga</button>
                  )}
                </td>
              </tr>
            ))}
            {faturas.length === 0 && (
              <tr><td className="px-5 py-6 text-center text-slate-400 text-sm">Nenhuma fatura fechada ainda.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {detFatura && <FaturaModal det={detFatura} onClose={() => setDetFatura(null)} />}
    </div>
  );
}

/* Detalhe da fatura por associado — imprimível pra mandar pro sindicato */
function FaturaModal({ det, onClose }: { det: any; onClose: () => void }) {
  const f = det.fatura;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-10 overflow-y-auto print:bg-white print:p-0">
      <div className="w-full max-w-2xl rounded-2xl bg-white shadow-2xl border border-[#E6DFC8] overflow-hidden mb-10 print:shadow-none print:border-0">
        <div className="flex items-center justify-between px-5 py-3 border-b border-[#E6DFC8] print:hidden">
          <h3 className="font-bold text-slate-800">Fatura — {f.convenio?.nome}</h3>
          <div className="flex gap-2">
            <button onClick={() => window.print()} className="rounded-lg border border-[#B8912B] px-3 py-1.5 text-xs font-bold text-[#8C7325] flex items-center gap-1">
              <Printer className="w-3.5 h-3.5" /> Imprimir
            </button>
            <button onClick={onClose} className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100"><X className="w-5 h-5" /></button>
          </div>
        </div>
        <div className="p-5">
          <div className="text-center mb-4">
            <div className="text-lg font-black">LURD'S PLUS SIZE — FATURA DE CONVÊNIO</div>
            <div className="text-sm text-slate-600">{f.convenio?.nome} · Loja {f.convenio?.storeCode}</div>
            <div className="text-xs text-slate-500">Período {fmtData(f.de)} a {fmtData(f.ate)} · gerada em {fmtData(f.geradaEm)}</div>
          </div>
          {det.membros.map((m: any) => (
            <div key={m.nome} className="mb-3">
              <div className="flex justify-between font-bold text-sm border-b border-slate-200 pb-0.5">
                <span>{m.nome}{m.matricula ? ` · mat. ${m.matricula}` : ''}</span>
                <span>{brl(m.totalCents)}</span>
              </div>
              {m.compras.map((c: any, i: number) => (
                <div key={i} className="flex justify-between text-xs text-slate-500 pl-3 py-0.5">
                  <span>{fmtData(c.data)}</span>
                  <span>{brl(c.valorCents)}</span>
                </div>
              ))}
            </div>
          ))}
          <div className="flex justify-between text-base font-black border-t-2 border-slate-800 pt-2 mt-4">
            <span>TOTAL DA FATURA</span>
            <span>{brl(f.totalCents)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
