'use client';

/**
 * /retaguarda/contas-pagar — Contas a Pagar 100% Flow (mockup aprovado 11/07).
 *
 * 4 visões: PAINEL (cards + busca por qualquer parte + tabela) · NOVA CONTA
 * (modal com prévia de parcelas) · FUNCIONÁRIAS (restrita — total por pessoa/mês)
 * · DIVERGÊNCIAS (migração GIGA×FLOW: espelho, migrar, validação).
 * Módulo admin/master (matriz). GIGA congelado — lançamento novo só aqui.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, Plus, Search, Loader2, Check, X, Wallet, AlertTriangle,
  CalendarDays, Users, Scale, RefreshCw, Trash2, Pencil, History,
  ListChecks, Printer,
} from 'lucide-react';
import { api } from '@/lib/api';

const brl = (cents: number | null | undefined) =>
  (Number(cents || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtData = (s: string | null | undefined) =>
  s ? new Date(s).toLocaleDateString('pt-BR', { timeZone: 'UTC' }) : '—';
const hojeStr = () => new Date().toISOString().slice(0, 10);

type Aba = 'painel' | 'hoje' | 'funcionarias' | 'associacao' | 'divergencias';

export default function ContasPagarPage() {
  const [aba, setAba] = useState<Aba>('painel');
  const [showNova, setShowNova] = useState(false);
  const [toast, setToast] = useState<{ tipo: 'ok' | 'erro'; msg: string } | null>(null);
  const avisar = (tipo: 'ok' | 'erro', msg: string) => {
    setToast({ tipo, msg });
    setTimeout(() => setToast(null), 4000);
  };

  return (
    <div className="min-h-screen bg-[#FAFAF7] text-slate-800">
      <header className="bg-white border-b border-[#E7E2D8] sticky top-0 z-20">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link href="/retaguarda" className="p-2 hover:bg-[#FBF6E6] rounded-lg"><ArrowLeft className="w-5 h-5" /></Link>
          <Wallet className="w-6 h-6 text-[#B8912B]" />
          <div className="flex-1">
            <h1 className="text-lg font-extrabold">Contas a Pagar</h1>
            <p className="text-xs text-slate-500">100% Flow · GIGA congelado pra consulta</p>
          </div>
          <button
            onClick={() => setShowNova(true)}
            className="bg-[#B8912B] hover:bg-[#8C7325] text-white font-bold px-4 py-2 rounded-lg flex items-center gap-2 text-sm"
          >
            <Plus className="w-4 h-4" /> Nova conta
          </button>
        </div>
        <div className="max-w-7xl mx-auto px-4 pb-2 flex gap-2">
          {([
            ['painel', 'Painel', CalendarDays],
            ['hoje', 'A fazer hoje', ListChecks],
            ['funcionarias', 'Funcionárias', Users],
            ['associacao', 'Associação', Users],
            ['divergencias', 'Divergências GIGA × FLOW', Scale],
          ] as any[]).map(([k, label, Icon]) => (
            <button
              key={k}
              onClick={() => setAba(k)}
              className={`px-4 py-1.5 rounded-full text-sm font-semibold flex items-center gap-1.5 border ${
                aba === k ? 'bg-[#B8912B] border-[#B8912B] text-white' : 'bg-white border-[#E7E2D8] text-slate-500 hover:bg-[#FBF6E6]'
              }`}
            >
              <Icon className="w-4 h-4" /> {label}
            </button>
          ))}
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-5">
        {aba === 'painel' && <Painel avisar={avisar} />}
        {aba === 'hoje' && <AFazerHoje avisar={avisar} />}
        {aba === 'funcionarias' && <Funcionarias />}
        {aba === 'associacao' && <Associacao avisar={avisar} />}
        {aba === 'divergencias' && <Divergencias avisar={avisar} />}
      </main>

      {showNova && <NovaContaModal onClose={() => setShowNova(false)} avisar={avisar} />}

      {toast && (
        <div className={`fixed bottom-5 right-5 z-50 px-4 py-3 rounded-xl shadow-lg text-sm font-bold text-white ${toast.tipo === 'ok' ? 'bg-[#2E7D46]' : 'bg-rose-600'}`}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}

/* ═══════════════════ PAINEL ═══════════════════ */
function Painel({ avisar }: { avisar: (t: 'ok' | 'erro', m: string) => void }) {
  const [stats, setStats] = useState<any>(null);
  const [lojas, setLojas] = useState<any[]>([]);
  const [especies, setEspecies] = useState<any[]>([]);
  const [busca, setBusca] = useState('');
  const [de, setDe] = useState('');
  const [ate, setAte] = useState('');
  const [lojaCode, setLojaCode] = useState('');
  const [especieId, setEspecieId] = useState('');
  const [status, setStatus] = useState<'pendentes' | 'pagas' | 'todas'>('pendentes');
  const [soEmMaos, setSoEmMaos] = useState(false);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [pagando, setPagando] = useState<any | null>(null); // conta no modal de baixa
  const [logsDe, setLogsDe] = useState<any | null>(null);
  const [showLote, setShowLote] = useState(false);
  const [editando, setEditando] = useState<any | null>(null);

  const carregarBase = useCallback(() => {
    api<any>('/admin/contas-pagar/stats').then(setStats).catch(() => {});
    api<any[]>('/admin/contas-pagar/lojas').then(setLojas).catch(() => {});
    api<any[]>('/admin/contas-pagar/especies').then(setEspecies).catch(() => {});
  }, []);
  useEffect(() => { carregarBase(); }, [carregarBase]);

  const carregar = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams();
      if (busca.trim()) p.set('search', busca.trim());
      if (de) p.set('de', de);
      if (ate) p.set('ate', ate);
      if (lojaCode) p.set('lojaCode', lojaCode);
      if (especieId) p.set('especieId', especieId);
      p.set('status', status);
      if (soEmMaos) p.set('emMaos', '1');
      p.set('page', String(page));
      p.set('perPage', '200'); // quebra de página de 200 em 200 (pedido do dono)
      const r = await api<any>(`/admin/contas-pagar/list?${p}`);
      setData(r);
    } catch (e: any) {
      avisar('erro', e?.message || 'Falha ao carregar');
    } finally {
      setLoading(false);
    }
  }, [busca, de, ate, lojaCode, especieId, status, soEmMaos, page, avisar]);
  useEffect(() => { carregar(); }, [carregar]);

  const atalho = (dias: number | 'hoje' | 'ontem' | 'mes') => {
    const h = new Date();
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    if (dias === 'hoje') { setDe(iso(h)); setAte(iso(h)); }
    else if (dias === 'ontem') { const o = new Date(h.getTime() - 86400000); setDe(iso(o)); setAte(iso(o)); }
    else if (dias === 'mes') { setDe(iso(new Date(h.getFullYear(), h.getMonth(), 1))); setAte(iso(new Date(h.getFullYear(), h.getMonth() + 1, 0))); }
    else { setDe(iso(h)); setAte(iso(new Date(h.getTime() + dias * 86400000))); }
    setPage(1);
  };

  const acao = async (fn: () => Promise<any>, ok: string) => {
    try { await fn(); avisar('ok', ok); carregar(); carregarBase(); }
    catch (e: any) { avisar('erro', e?.message || 'Falhou'); }
  };

  return (
    <div className="space-y-4">
      {/* cards */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <CardStat titulo="Vencidas" cents={stats.vencidas.cents} qtd={stats.vencidas.qtd} cor="text-rose-600" />
          <CardStat titulo="Vencem hoje" cents={stats.hoje.cents} qtd={stats.hoje.qtd} cor="text-amber-600" />
          <CardStat titulo="Próximos 7 dias" cents={stats.prox7.cents} qtd={stats.prox7.qtd} cor="text-slate-800" />
          <CardStat titulo="Pagas no mês" cents={stats.pagasMes.cents} qtd={stats.pagasMes.qtd} cor="text-[#2E7D46]" />
          <CardStat titulo="Pendente total" cents={stats.pendenteTotal.cents} qtd={stats.pendenteTotal.qtd} cor="text-slate-800" />
        </div>
      )}

      {/* filtros */}
      <div className="bg-white border border-[#E7E2D8] rounded-xl p-4 space-y-3">
        <div className="flex gap-2">
          <div className="flex-1 relative">
            <Search className="w-4 h-4 absolute left-3 top-3 text-slate-400" />
            <input
              value={busca}
              onChange={(e) => { setBusca(e.target.value); setPage(1); }}
              placeholder="Busque por QUALQUER parte: fornecedor, funcionária, nota, observação, banco, valor, nº…"
              className="w-full border border-[#E7E2D8] rounded-lg pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#B8912B]"
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <label className="text-slate-500 font-semibold">De</label>
          <input type="date" value={de} onChange={(e) => { setDe(e.target.value); setPage(1); }} className="border border-[#E7E2D8] rounded-lg px-2 py-1" />
          <label className="text-slate-500 font-semibold">Até</label>
          <input type="date" value={ate} onChange={(e) => { setAte(e.target.value); setPage(1); }} className="border border-[#E7E2D8] rounded-lg px-2 py-1" />
          <button onClick={() => atalho('hoje')} className="px-3 py-1 rounded-full border border-[#E7E2D8] hover:bg-[#FBF6E6] font-semibold text-slate-600">Hoje</button>
          <button onClick={() => atalho('ontem')} className="px-3 py-1 rounded-full border border-[#E7E2D8] hover:bg-[#FBF6E6] font-semibold text-slate-600">Ontem</button>
          <button onClick={() => atalho(7)} className="px-3 py-1 rounded-full border border-[#E7E2D8] hover:bg-[#FBF6E6] font-semibold text-slate-600">7 dias</button>
          <button onClick={() => atalho('mes')} className="px-3 py-1 rounded-full border border-[#E7E2D8] hover:bg-[#FBF6E6] font-semibold text-slate-600">Mês</button>
          <button onClick={() => { setDe(''); setAte(''); setPage(1); }} className="px-3 py-1 rounded-full border border-[#E7E2D8] hover:bg-[#FBF6E6] text-slate-500">Limpar datas</button>
          <select value={lojaCode} onChange={(e) => { setLojaCode(e.target.value); setPage(1); }} className="border border-[#E7E2D8] rounded-lg px-2 py-1">
            <option value="">Loja: todas</option>
            {lojas.map((l) => <option key={l.code} value={l.code}>{l.code} · {l.nome}</option>)}
          </select>
          <select value={especieId} onChange={(e) => { setEspecieId(e.target.value); setPage(1); }} className="border border-[#E7E2D8] rounded-lg px-2 py-1">
            <option value="">Espécie: todas</option>
            {especies.map((e) => <option key={e.id} value={e.id}>{e.nome}{e.restrita ? ' 🔒' : ''}</option>)}
          </select>
          {(['pendentes', 'pagas', 'todas'] as const).map((s) => (
            <button
              key={s}
              onClick={() => { setStatus(s); setPage(1); }}
              className={`px-3 py-1 rounded-full border font-semibold capitalize ${status === s ? 'bg-[#FBF6E6] border-[#B8912B] text-[#8C7325]' : 'border-[#E7E2D8] text-slate-500 hover:bg-[#FBF6E6]'}`}
            >{s}</button>
          ))}
          <button
            onClick={() => { setSoEmMaos(!soEmMaos); setPage(1); }}
            className={`px-3 py-1 rounded-full border font-semibold ${soEmMaos ? 'bg-[#FBF6E6] border-[#B8912B] text-[#8C7325]' : 'border-[#E7E2D8] text-slate-500 hover:bg-[#FBF6E6]'}`}
          >✋ Só em mãos</button>
        </div>
      </div>

      {/* tabela */}
      <div className="bg-white border border-[#E7E2D8] rounded-xl overflow-x-auto">
        {loading && !data ? (
          <div className="p-10 text-center text-slate-400"><Loader2 className="w-6 h-6 animate-spin mx-auto" /></div>
        ) : (
          <table className="w-full text-sm min-w-[900px]">
            <thead>
              <tr className="bg-[#FAFAF7] text-[11px] uppercase tracking-wide text-slate-500 border-b border-[#E7E2D8]">
                <th className="text-left px-3 py-2">Vencimento</th>
                <th className="text-left px-3 py-2">Beneficiário</th>
                <th className="text-left px-3 py-2">Espécie</th>
                <th className="text-left px-3 py-2">Nota</th>
                <th className="text-left px-3 py-2">Loja</th>
                <th className="text-left px-3 py-2">Parc.</th>
                <th className="text-right px-3 py-2">Valor</th>
                <th className="text-center px-3 py-2">Em mãos</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {(data?.rows || []).map((r: any) => (
                <tr key={r.id} className="border-b border-[#F1EDE3] hover:bg-[#FBF6E6]">
                  <td className="px-3 py-2 whitespace-nowrap">
                    {r.status === 'paga' ? (
                      <span className="text-[11px] font-extrabold px-2 py-0.5 rounded bg-emerald-50 text-[#2E7D46]">PAGA · {fmtData(r.pagamento)}</span>
                    ) : r.vencida ? (
                      <span className="text-[11px] font-extrabold px-2 py-0.5 rounded bg-rose-50 text-rose-600">VENCIDA · {fmtData(r.vencimento)}</span>
                    ) : r.hoje ? (
                      <span className="text-[11px] font-extrabold px-2 py-0.5 rounded bg-amber-50 text-amber-600">HOJE</span>
                    ) : (
                      <span className="text-slate-600">{fmtData(r.vencimento)}</span>
                    )}
                    {r.dataSuspeita && <span title="Data suspeita vinda do GIGA" className="ml-1">⚠️</span>}
                  </td>
                  <td className="px-3 py-2">
                    <div className="font-bold flex items-center gap-1.5">
                      {r.beneficiario || '—'}
                      {r.beneficiarioTipo === 'funcionaria' && (
                        <span className="text-[10px] font-extrabold px-1.5 py-0.5 rounded bg-[#FBF6E6] border border-[#B8912B] text-[#8C7325]">👤</span>
                      )}
                      {r.favorecidoOrfao && <span title="Favorecido órfão no GIGA">⚠️</span>}
                    </div>
                    {r.observacao && <div className="text-[11px] text-slate-400">{r.observacao}</div>}
                  </td>
                  <td className="px-3 py-2">
                    <span className="text-[11px] font-bold px-2 py-0.5 rounded bg-[#FAFAF7] border border-[#E7E2D8] text-slate-500">
                      {r.especie}{r.especieRestrita ? ' 🔒' : ''}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-slate-600">{r.notaFiscal || '—'}</td>
                  <td className="px-3 py-2 text-slate-600">{r.lojaCode}</td>
                  <td className="px-3 py-2 text-slate-500">{r.parcela || '—'}</td>
                  <td className="px-3 py-2 text-right font-extrabold text-[#2E7D46] whitespace-nowrap">{brl(r.valorCents)}</td>
                  <td className="px-3 py-2 text-center">
                    <button
                      onClick={() => acao(() => api(`/admin/contas-pagar/${r.id}/em-maos`, { method: 'PATCH' }), 'Em mãos atualizado')}
                      className={`text-[11px] font-extrabold px-2 py-0.5 rounded-full border ${r.emMaos ? 'bg-emerald-50 border-[#2E7D46] text-[#2E7D46]' : 'border-[#E7E2D8] text-slate-400'}`}
                    >{r.emMaos ? 'SIM' : 'NÃO'}</button>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-right">
                    {r.status === 'aberta' ? (
                      <button onClick={() => setPagando(r)} className="text-[12px] font-bold px-2.5 py-1 rounded-lg border border-[#2E7D46] text-[#2E7D46] hover:bg-emerald-50 mr-1">💰 Pagar</button>
                    ) : (
                      <button onClick={() => acao(() => api(`/admin/contas-pagar/${r.id}/reabrir`, { method: 'PATCH' }), 'Conta reaberta')} className="text-[12px] font-bold px-2.5 py-1 rounded-lg border border-[#E7E2D8] text-slate-500 hover:bg-[#FBF6E6] mr-1">Reabrir</button>
                    )}
                    <button onClick={() => setEditando(r)} title="Editar lançamento" className="p-1.5 rounded-lg border border-[#E7E2D8] text-slate-400 hover:bg-[#FBF6E6] mr-1"><Pencil className="w-3.5 h-3.5" /></button>
                    <button onClick={() => setLogsDe(r)} title="Histórico/auditoria" className="p-1.5 rounded-lg border border-[#E7E2D8] text-slate-400 hover:bg-[#FBF6E6] mr-1"><History className="w-3.5 h-3.5" /></button>
                    <button
                      onClick={() => { if (confirm(`Excluir a conta ${r.beneficiario || ''} ${brl(r.valorCents)}? (fica no histórico, com seu nome)`)) acao(() => api(`/admin/contas-pagar/${r.id}`, { method: 'DELETE' }), 'Conta excluída'); }}
                      className="p-1.5 rounded-lg border border-[#E7E2D8] text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                    ><Trash2 className="w-3.5 h-3.5" /></button>
                  </td>
                </tr>
              ))}
              {data && !data.rows?.length && (
                <tr><td colSpan={9} className="text-center text-slate-400 py-10">Nenhuma conta encontrada.</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {data && (
        <div className="flex items-center justify-between text-sm text-slate-500">
          <span className="flex items-center gap-3">
            {data.total} conta(s) · soma <b className="text-[#2E7D46]">{brl(data.somaCents)}</b>
            {status === 'pendentes' && data.total > 0 && (
              <button
                onClick={() => setShowLote(true)}
                className="px-3 py-1.5 rounded-lg border border-[#2E7D46] text-[#2E7D46] font-bold hover:bg-emerald-50"
              >✓ Baixar TODAS do filtro ({data.total})</button>
            )}
          </span>
          <span className="flex items-center gap-2">
            <button disabled={page <= 1} onClick={() => setPage(page - 1)} className="px-3 py-1 rounded-lg border border-[#E7E2D8] disabled:opacity-40">‹</button>
            Pág. {data.page} / {Math.max(1, Math.ceil(data.total / data.perPage))}
            <button disabled={page >= Math.ceil(data.total / data.perPage)} onClick={() => setPage(page + 1)} className="px-3 py-1 rounded-lg border border-[#E7E2D8] disabled:opacity-40">›</button>
          </span>
        </div>
      )}

      {pagando && (
        <PagarModal
          conta={pagando}
          onClose={() => setPagando(null)}
          onOk={() => { setPagando(null); carregar(); carregarBase(); }}
          avisar={avisar}
        />
      )}
      {logsDe && <LogsModal conta={logsDe} onClose={() => setLogsDe(null)} />}
      {editando && (
        <EditarModal
          conta={editando}
          lojas={lojas}
          especies={especies}
          onClose={() => setEditando(null)}
          onOk={() => { setEditando(null); carregar(); carregarBase(); }}
          avisar={avisar}
        />
      )}
      {showLote && data && (
        <BaixaLoteModal
          total={data.total}
          somaCents={data.somaCents}
          filtros={{ search: busca.trim() || undefined, de: de || undefined, ate: ate || undefined, lojaCode: lojaCode || undefined, especieId: especieId || undefined, emMaos: soEmMaos }}
          onClose={() => setShowLote(false)}
          onOk={() => { setShowLote(false); carregar(); carregarBase(); }}
          avisar={avisar}
        />
      )}
    </div>
  );
}

/* ═══════════ MODAL: EDITAR LANÇAMENTO (auditoria por campo no backend) ═══════════ */
function EditarModal({ conta, lojas, especies, onClose, onOk, avisar }: any) {
  const isFunc = conta.beneficiarioTipo === 'funcionaria';
  const [beneficiario, setBeneficiario] = useState(conta.beneficiario || '');
  const [lojaCode, setLojaCode] = useState(conta.lojaCode || '');
  const [especieId, setEspecieId] = useState(conta.especieId || '');
  const [notaFiscal, setNotaFiscal] = useState(conta.notaFiscal || '');
  const [banco, setBanco] = useState(conta.banco || '');
  const [emissao, setEmissao] = useState(conta.emissao ? String(conta.emissao).slice(0, 10) : '');
  const [vencimento, setVencimento] = useState(conta.vencimento ? String(conta.vencimento).slice(0, 10) : '');
  const [valor, setValor] = useState((conta.valorCents / 100).toFixed(2).replace('.', ','));
  const [obs, setObs] = useState(conta.observacao || '');
  const [saving, setSaving] = useState(false);

  const salvar = async () => {
    const valorCents = Math.round((parseFloat(valor.replace(/\./g, '').replace(',', '.')) || 0) * 100);
    if (!valorCents || valorCents <= 0) { avisar('erro', 'Valor inválido'); return; }
    if (!vencimento) { avisar('erro', 'Informe o vencimento'); return; }
    setSaving(true);
    try {
      await api(`/admin/contas-pagar/${conta.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          [isFunc ? 'sellerNome' : 'fornecedorNome']: beneficiario.trim() || null,
          lojaCode,
          especieId: especieId || null,
          notaFiscal: notaFiscal || null,
          banco: banco || null,
          emissao: emissao || null,
          vencimento,
          valorCents,
          observacao: obs || null,
        }),
      });
      avisar('ok', 'Lançamento atualizado (mudanças na auditoria)');
      onOk();
    } catch (e: any) {
      avisar('erro', e?.message || 'Falha ao salvar');
    } finally { setSaving(false); }
  };

  return (
    <Modal titulo={`Editar — conta nº ${conta.numero}${conta.gigaRegistro ? ` (GIGA ${conta.gigaRegistro})` : ''}`} onClose={onClose} largo>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <div className="col-span-2">
          <Campo label={isFunc ? 'Funcionária' : 'Fornecedor'}>
            <input value={beneficiario} onChange={(e) => setBeneficiario(e.target.value)} className="inp" />
          </Campo>
        </div>
        <Campo label="Loja">
          <select value={lojaCode} onChange={(e) => setLojaCode(e.target.value)} className="inp">
            {!lojas.some((l: any) => l.code === lojaCode) && lojaCode && <option value={lojaCode}>{lojaCode}</option>}
            {lojas.map((l: any) => <option key={l.code} value={l.code}>{l.code} · {l.nome}</option>)}
          </select>
        </Campo>
        <Campo label="Espécie">
          <select value={especieId} onChange={(e) => setEspecieId(e.target.value)} className="inp">
            <option value="">—</option>
            {especies.map((e: any) => <option key={e.id} value={e.id}>{e.nome}{e.restrita ? ' 🔒' : ''}</option>)}
          </select>
        </Campo>
        <Campo label="Nota fiscal"><input value={notaFiscal} onChange={(e) => setNotaFiscal(e.target.value)} className="inp" /></Campo>
        <Campo label="Banco"><input value={banco} onChange={(e) => setBanco(e.target.value)} className="inp" /></Campo>
        <Campo label="Emissão"><input type="date" value={emissao} onChange={(e) => setEmissao(e.target.value)} className="inp" /></Campo>
        <Campo label="Vencimento"><input type="date" value={vencimento} onChange={(e) => setVencimento(e.target.value)} className="inp" /></Campo>
        <Campo label="Valor (R$)"><input value={valor} onChange={(e) => setValor(e.target.value)} className="inp font-bold text-[#2E7D46]" /></Campo>
      </div>
      <div className="mt-3">
        <Campo label="Observações"><input value={obs} onChange={(e) => setObs(e.target.value)} className="inp" /></Campo>
      </div>
      <p className="text-[11px] text-slate-400 mt-2">Cada campo alterado entra na auditoria da conta (antes → depois, com seu nome).</p>
      <div className="flex justify-end gap-2 mt-4">
        <button onClick={onClose} className="px-4 py-2 rounded-lg border border-[#E7E2D8] text-slate-500 font-bold text-sm">Cancelar</button>
        <button onClick={salvar} disabled={saving} className="px-4 py-2 rounded-lg bg-[#2E7D46] text-white font-bold text-sm flex items-center gap-2 disabled:opacity-50">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Salvar alterações
        </button>
      </div>
    </Modal>
  );
}

/* ═══════════ MODAL: BAIXA EM LOTE (regularização histórica) ═══════════ */
function BaixaLoteModal({ total, somaCents, filtros, onClose, onOk, avisar }: any) {
  const [pagamento, setPagamento] = useState(hojeStr());
  const [motivo, setMotivo] = useState('Regularização histórica — contas antigas já pagas fora do sistema (herança GIGA)');
  const [confirmo, setConfirmo] = useState('');
  const [saving, setSaving] = useState(false);
  const confirmar = async () => {
    setSaving(true);
    try {
      const r = await api<any>('/admin/contas-pagar/baixa-em-lote', {
        method: 'POST',
        body: JSON.stringify({ filtros, pagamento, motivo }),
      });
      avisar('ok', `${r.baixadas} conta(s) baixada(s) — ${brl(r.somaCents)}`);
      onOk();
    } catch (e: any) {
      avisar('erro', e?.message || 'Falhou');
    } finally { setSaving(false); }
  };
  return (
    <Modal titulo="Baixar TODAS as contas abertas do filtro" onClose={onClose}>
      <div className="space-y-3">
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800">
          ⚠️ Vai marcar como <b>PAGA</b>: <b>{total} conta(s)</b> · soma <b>{brl(somaCents)}</b> — exatamente
          o que o filtro atual mostra. Cada uma recebe registro de auditoria com seu nome e o motivo.
          Dá pra reabrir individualmente se precisar.
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Campo label="Data do pagamento"><input type="date" value={pagamento} onChange={(e) => setPagamento(e.target.value)} className="inp" /></Campo>
          <Campo label={`Digite BAIXAR pra confirmar`}><input value={confirmo} onChange={(e) => setConfirmo(e.target.value)} placeholder="BAIXAR" className="inp" /></Campo>
        </div>
        <Campo label="Motivo (obrigatório — vai pra auditoria de cada conta)">
          <input value={motivo} onChange={(e) => setMotivo(e.target.value)} className="inp" />
        </Campo>
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 rounded-lg border border-[#E7E2D8] text-slate-500 font-bold text-sm">Cancelar</button>
          <button
            onClick={confirmar}
            disabled={saving || confirmo.trim().toUpperCase() !== 'BAIXAR' || motivo.trim().length < 5}
            className="px-4 py-2 rounded-lg bg-[#2E7D46] text-white font-bold text-sm flex items-center gap-2 disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Baixar {total} conta(s)
          </button>
        </div>
      </div>
    </Modal>
  );
}

function CardStat({ titulo, cents, qtd, cor }: { titulo: string; cents: number; qtd: number; cor: string }) {
  return (
    <div className="bg-white border border-[#E7E2D8] rounded-xl px-4 py-3">
      <div className="text-[10px] uppercase tracking-wider font-bold text-slate-400">{titulo}</div>
      <div className={`text-lg font-extrabold ${cor}`}>{brl(cents)}</div>
      <div className="text-[11px] text-slate-400">{qtd} conta(s)</div>
    </div>
  );
}

/* ═══════════════════ MODAL: PAGAR (juros + desconto — P3) ═══════════════════ */
function PagarModal({ conta, onClose, onOk, avisar }: any) {
  const [pagamento, setPagamento] = useState(hojeStr());
  const [juros, setJuros] = useState('');
  const [desconto, setDesconto] = useState('');
  const [saving, setSaving] = useState(false);
  const toCents = (s: string) => Math.round((parseFloat(String(s).replace(/\./g, '').replace(',', '.')) || 0) * 100);
  const confirmar = async () => {
    setSaving(true);
    try {
      await api(`/admin/contas-pagar/${conta.id}/pagar`, {
        method: 'PATCH',
        body: JSON.stringify({ pagamento, jurosCents: toCents(juros), descontoCents: toCents(desconto) }),
      });
      avisar('ok', 'Pagamento registrado');
      onOk();
    } catch (e: any) {
      avisar('erro', e?.message || 'Falhou');
    } finally { setSaving(false); }
  };
  return (
    <Modal titulo={`Pagar — ${conta.beneficiario || ''} · ${brl(conta.valorCents)}`} onClose={onClose}>
      <div className="grid grid-cols-3 gap-3">
        <Campo label="Data do pagamento"><input type="date" value={pagamento} onChange={(e) => setPagamento(e.target.value)} className="inp" /></Campo>
        <Campo label="Juros (R$)"><input value={juros} onChange={(e) => setJuros(e.target.value)} placeholder="0,00" className="inp" /></Campo>
        <Campo label="Desconto (R$)"><input value={desconto} onChange={(e) => setDesconto(e.target.value)} placeholder="0,00" className="inp" /></Campo>
      </div>
      <div className="flex justify-end gap-2 mt-4">
        <button onClick={onClose} className="px-4 py-2 rounded-lg border border-[#E7E2D8] text-slate-500 font-bold text-sm">Cancelar</button>
        <button onClick={confirmar} disabled={saving} className="px-4 py-2 rounded-lg bg-[#2E7D46] text-white font-bold text-sm flex items-center gap-2">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Confirmar pagamento
        </button>
      </div>
    </Modal>
  );
}

/* ═══════════════════ MODAL: LOGS/AUDITORIA ═══════════════════ */
function LogsModal({ conta, onClose }: any) {
  const [logs, setLogs] = useState<any[] | null>(null);
  useEffect(() => {
    api<any[]>(`/admin/contas-pagar/${conta.id}/logs`).then(setLogs).catch(() => setLogs([]));
  }, [conta.id]);
  return (
    <Modal titulo={`Auditoria — conta nº ${conta.numero}${conta.gigaRegistro ? ` (GIGA ${conta.gigaRegistro})` : ''}`} onClose={onClose}>
      {!logs ? (
        <div className="text-center py-6 text-slate-400"><Loader2 className="w-5 h-5 animate-spin mx-auto" /></div>
      ) : logs.length === 0 ? (
        <p className="text-sm text-slate-400 py-4">Sem alterações registradas.</p>
      ) : (
        <div className="max-h-80 overflow-y-auto divide-y divide-[#F1EDE3]">
          {logs.map((l) => (
            <div key={l.id} className="py-2 text-sm flex gap-3">
              <span className="text-[11px] text-slate-400 whitespace-nowrap w-28">{new Date(l.createdAt).toLocaleString('pt-BR')}</span>
              <span>
                <b>{l.usuario || l.origem}</b> · {l.campo}
                {l.valorAntigo != null && <> — <s className="text-slate-400">{l.valorAntigo}</s></>}
                {l.valorNovo != null && <> → <b>{l.valorNovo}</b></>}
              </span>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

/* ═══════════════════ MODAL: NOVA CONTA (prévia de parcelas) ═══════════════════ */
function NovaContaModal({ onClose, avisar }: any) {
  const [tipo, setTipo] = useState<'fornecedor' | 'funcionaria'>('fornecedor');
  const [lojas, setLojas] = useState<any[]>([]);
  const [especies, setEspecies] = useState<any[]>([]);
  const [lojaCode, setLojaCode] = useState('');
  const [especieId, setEspecieId] = useState('');
  const [benefQ, setBenefQ] = useState('');
  const [benefOpts, setBenefOpts] = useState<any[]>([]);
  const [benefSel, setBenefSel] = useState<any | null>(null);
  const [notaFiscal, setNotaFiscal] = useState('');
  const [banco, setBanco] = useState('');
  const [emissao, setEmissao] = useState(hojeStr());
  const [valor, setValor] = useState('');
  const [venc1, setVenc1] = useState('');
  const [nParcelas, setNParcelas] = useState(1);
  const [emMaos, setEmMaos] = useState(false);
  const [obs, setObs] = useState('');
  const [previa, setPrevia] = useState<any[] | null>(null);
  const [saving, setSaving] = useState(false);
  const buscaRef = useRef<any>(null);

  useEffect(() => {
    api<any[]>('/admin/contas-pagar/lojas').then(setLojas).catch(() => {});
    api<any[]>('/admin/contas-pagar/especies').then(setEspecies).catch(() => {});
  }, []);

  // autocomplete beneficiário (qualquer parte)
  useEffect(() => {
    clearTimeout(buscaRef.current);
    if (!benefQ.trim() || benefSel) { setBenefOpts([]); return; }
    buscaRef.current = setTimeout(async () => {
      try {
        const rota = tipo === 'fornecedor' ? 'opcoes/fornecedores' : 'opcoes/funcionarias';
        const r = await api<any[]>(`/admin/contas-pagar/${rota}?q=${encodeURIComponent(benefQ.trim())}`);
        setBenefOpts(r || []);
      } catch { setBenefOpts([]); }
    }, 250);
  }, [benefQ, tipo, benefSel]);

  const valorCents = Math.round((parseFloat(valor.replace(/\./g, '').replace(',', '.')) || 0) * 100);

  // Espécies com comportamento próprio: DUPLICATA numera NF/1, NF/2… por
  // parcela; DEPOSITO pede banco·agência·conta e cai na aba "A fazer hoje".
  const especieNome = especies.find((e) => e.id === especieId)?.nome || '';
  const isDuplicata = especieNome === 'DUPLICATA';
  const isDeposito = especieNome === 'DEPOSITO';

  const gerarPrevia = () => {
    if (!valorCents || !venc1) { avisar('erro', 'Preencha valor e 1º vencimento'); return; }
    const n = Math.min(60, Math.max(1, nParcelas));
    const base = Math.floor(valorCents / n);
    const rows: any[] = [];
    for (let i = 0; i < n; i++) {
      const d = new Date(`${venc1}T00:00:00.000Z`);
      d.setUTCMonth(d.getUTCMonth() + i);
      rows.push({
        vencimento: d.toISOString().slice(0, 10),
        valorCents: i === n - 1 ? valorCents - base * (n - 1) : base,
        emMaos: i === 0 ? emMaos : false,
        notaFiscal: isDuplicata && notaFiscal.trim() && n > 1 ? `${notaFiscal.trim()}/${i + 1}` : undefined,
      });
    }
    setPrevia(rows);
  };

  const salvar = async () => {
    setSaving(true);
    try {
      await api('/admin/contas-pagar', {
        method: 'POST',
        body: JSON.stringify({
          lojaCode,
          beneficiarioTipo: tipo,
          fornecedorNome: tipo === 'fornecedor' ? (benefSel?.razaoSocial || benefQ.trim()) : undefined,
          fornecedorGigaCodigo: tipo === 'fornecedor' ? benefSel?.codigo : undefined,
          sellerId: tipo === 'funcionaria' ? benefSel?.id : undefined,
          sellerNome: tipo === 'funcionaria' ? (benefSel?.name || benefQ.trim()) : undefined,
          sellerCpf: tipo === 'funcionaria' ? benefSel?.cpf : undefined,
          especieId: especieId || undefined,
          notaFiscal: notaFiscal || undefined,
          banco: banco || undefined,
          emissao: emissao || undefined,
          valorCents,
          vencimento: venc1,
          parcelas: nParcelas,
          emMaos,
          observacao: obs || undefined,
          parcelasCustom: previa || undefined,
          numerarDuplicatas: isDuplicata,
        }),
      });
      avisar('ok', `Conta criada (${previa?.length || nParcelas} parcela(s))`);
      onClose();
    } catch (e: any) {
      avisar('erro', e?.message || 'Falha ao salvar');
    } finally { setSaving(false); }
  };

  return (
    <Modal titulo="Nova conta a pagar" onClose={onClose} largo>
      <div className="space-y-3">
        <div className="flex gap-0 border border-[#E7E2D8] rounded-lg overflow-hidden w-max">
          {(['fornecedor', 'funcionaria'] as const).map((t) => (
            <button
              key={t}
              onClick={() => { setTipo(t); setBenefSel(null); setBenefQ(''); }}
              className={`px-5 py-2 text-sm font-bold ${tipo === t ? 'bg-[#B8912B] text-white' : 'bg-white text-slate-500'}`}
            >{t === 'fornecedor' ? '🏭 Fornecedor' : '👤 Funcionária'}</button>
          ))}
        </div>

        <div className="relative">
          <Campo label={tipo === 'fornecedor' ? 'Fornecedor (busque por qualquer parte do nome/CNPJ)' : 'Funcionária (busque pelo nome)'}>
            <input
              value={benefSel ? (benefSel.razaoSocial || benefSel.name) : benefQ}
              onChange={(e) => { setBenefSel(null); setBenefQ(e.target.value); }}
              placeholder={tipo === 'fornecedor' ? 'Ex.: 767, malwee, celeiro…' : 'Ex.: juliana…'}
              className="inp"
            />
          </Campo>
          {benefOpts.length > 0 && (
            <div className="absolute z-10 bg-white border border-[#E7E2D8] rounded-lg shadow-lg w-full max-h-48 overflow-y-auto">
              {benefOpts.map((o) => (
                <button
                  key={o.codigo ?? o.id}
                  onClick={() => { setBenefSel(o); setBenefOpts([]); }}
                  className="block w-full text-left px-3 py-2 text-sm hover:bg-[#FBF6E6]"
                >
                  <b>{o.razaoSocial || o.name}</b>
                  <span className="text-slate-400 text-xs ml-2">{o.cnpj || o.cpf || ''}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <Campo label="Loja">
            <select value={lojaCode} onChange={(e) => setLojaCode(e.target.value)} className="inp">
              <option value="">Selecione…</option>
              {lojas.map((l) => <option key={l.code} value={l.code}>{l.code} · {l.nome}</option>)}
            </select>
          </Campo>
          <Campo label="Espécie">
            <select value={especieId} onChange={(e) => { setEspecieId(e.target.value); setPrevia(null); }} className="inp">
              <option value="">Selecione…</option>
              {especies.filter((e) => e.ativa).map((e) => <option key={e.id} value={e.id}>{e.nome}{e.restrita ? ' 🔒' : ''}</option>)}
            </select>
          </Campo>
          <Campo label={isDuplicata ? 'Nota fiscal (base das duplicatas)' : 'Nota fiscal'}>
            <input value={notaFiscal} onChange={(e) => { setNotaFiscal(e.target.value); if (isDuplicata) setPrevia(null); }} className="inp" />
          </Campo>
          <Campo label={isDeposito ? 'Banco · agência · conta' : 'Banco'}>
            <input value={banco} onChange={(e) => setBanco(e.target.value)} placeholder={isDeposito ? 'Ex.: Itaú · ag 1234 · cc 56789-0' : ''} className="inp" />
          </Campo>
          <Campo label="Emissão"><input type="date" value={emissao} onChange={(e) => setEmissao(e.target.value)} className="inp" /></Campo>
          <Campo label="Valor TOTAL (R$)"><input value={valor} onChange={(e) => { setValor(e.target.value); setPrevia(null); }} placeholder="0,00" className="inp font-bold text-[#2E7D46]" /></Campo>
          <Campo label="1º vencimento"><input type="date" value={venc1} onChange={(e) => { setVenc1(e.target.value); setPrevia(null); }} className="inp" /></Campo>
          <Campo label="Parcelas"><input type="number" min={1} max={60} value={nParcelas} onChange={(e) => { setNParcelas(Number(e.target.value)); setPrevia(null); }} className="inp" /></Campo>
          <Campo label="Boleto em mãos?">
            <button onClick={() => setEmMaos(!emMaos)} className={`px-4 py-2 rounded-lg border font-bold text-sm w-full ${emMaos ? 'bg-emerald-50 border-[#2E7D46] text-[#2E7D46]' : 'border-[#E7E2D8] text-slate-400'}`}>
              {emMaos ? 'SIM' : 'NÃO'}
            </button>
          </Campo>
        </div>
        <Campo label="Observações"><input value={obs} onChange={(e) => setObs(e.target.value)} className="inp" /></Campo>

        {isDuplicata && (
          <div className="bg-[#FBF6E6] border border-[#E7E2D8] rounded-lg px-3 py-2 text-[12px] text-[#8C7325]">
            📄 <b>Duplicata:</b> com nota fiscal + mais de 1 parcela, cada parcela ganha o número
            <b> {notaFiscal.trim() || 'NF'}/1, {notaFiscal.trim() || 'NF'}/2…</b> automaticamente (dá pra editar na prévia).
          </div>
        )}
        {isDeposito && (
          <div className="bg-[#FBF6E6] border border-[#E7E2D8] rounded-lg px-3 py-2 text-[12px] text-[#8C7325]">
            🏦 <b>Depósito a fazer:</b> entra na aba <b>“A fazer hoje”</b> no dia do vencimento — quem for ao banco
            marca como feito lá. Preencha banco · agência · conta pra sair na lista impressa.
          </div>
        )}

        {/* prévia de parcelas */}
        <div className="border border-dashed border-[#B8912B] bg-[#FBF6E6] rounded-xl p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-bold text-[#8C7325]">Prévia das parcelas — confira antes de salvar (datas/valores editáveis)</span>
            <button onClick={gerarPrevia} className="text-sm font-bold px-3 py-1 rounded-lg bg-[#B8912B] text-white">Gerar prévia</button>
          </div>
          {previa ? (
            <table className="w-full text-sm bg-white rounded-lg overflow-hidden">
              <thead><tr className="text-[11px] uppercase text-slate-400 border-b border-[#F1EDE3]">
                <th className="text-left px-3 py-1.5">#</th>{isDuplicata && <th className="text-left px-3 py-1.5">Duplicata nº</th>}<th className="text-left px-3 py-1.5">Vencimento</th><th className="text-right px-3 py-1.5">Valor (R$)</th><th className="text-center px-3 py-1.5">Em mãos</th>
              </tr></thead>
              <tbody>
                {previa.map((p, i) => (
                  <tr key={i} className="border-b border-[#F1EDE3]">
                    <td className="px-3 py-1.5 text-slate-500">{i + 1}/{previa.length}</td>
                    {isDuplicata && (
                      <td className="px-3 py-1.5">
                        <input
                          value={p.notaFiscal || ''}
                          onChange={(e) => { const c = [...previa]; c[i] = { ...p, notaFiscal: e.target.value }; setPrevia(c); }}
                          placeholder={`${notaFiscal.trim() || 'NF'}/${i + 1}`}
                          className="border border-[#E7E2D8] rounded px-2 py-0.5 w-28"
                        />
                      </td>
                    )}
                    <td className="px-3 py-1.5">
                      <input type="date" value={p.vencimento} onChange={(e) => { const c = [...previa]; c[i] = { ...p, vencimento: e.target.value }; setPrevia(c); }} className="border border-[#E7E2D8] rounded px-2 py-0.5" />
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <input
                        value={(p.valorCents / 100).toFixed(2).replace('.', ',')}
                        onChange={(e) => { const c = [...previa]; c[i] = { ...p, valorCents: Math.round((parseFloat(e.target.value.replace(/\./g, '').replace(',', '.')) || 0) * 100) }; setPrevia(c); }}
                        className="border border-[#E7E2D8] rounded px-2 py-0.5 w-24 text-right font-bold text-[#2E7D46]"
                      />
                    </td>
                    <td className="px-3 py-1.5 text-center">
                      <button onClick={() => { const c = [...previa]; c[i] = { ...p, emMaos: !p.emMaos }; setPrevia(c); }} className={`text-[11px] font-extrabold px-2 py-0.5 rounded-full border ${p.emMaos ? 'bg-emerald-50 border-[#2E7D46] text-[#2E7D46]' : 'border-[#E7E2D8] text-slate-400'}`}>
                        {p.emMaos ? 'SIM' : 'NÃO'}
                      </button>
                    </td>
                  </tr>
                ))}
                <tr><td colSpan={isDuplicata ? 3 : 2} className="px-3 py-1.5 font-bold text-slate-500">Soma</td>
                  <td className="px-3 py-1.5 text-right font-extrabold text-[#2E7D46]">{brl(previa.reduce((s, p) => s + p.valorCents, 0))}</td><td></td></tr>
              </tbody>
            </table>
          ) : (
            <p className="text-xs text-[#8C7325]">Preencha valor + 1º vencimento + nº de parcelas e clique em “Gerar prévia”.</p>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 rounded-lg border border-[#E7E2D8] text-slate-500 font-bold text-sm">Cancelar</button>
          <button
            onClick={salvar}
            disabled={saving || !lojaCode || !valorCents || !venc1}
            className="px-5 py-2 rounded-lg bg-[#2E7D46] text-white font-bold text-sm flex items-center gap-2 disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Processar
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* ═══════════════ A FAZER HOJE — checklist de pagamentos/depósitos do dia ═══════════════
   Atrasadas + vencendo hoje, com filtro rápido (depósitos / em mãos), baixa em
   1 clique (reversível pelo "Reabrir" do painel) e lista pra levar ao banco. */
function AFazerHoje({ avisar }: { avisar: (t: 'ok' | 'erro', m: string) => void }) {
  const [especies, setEspecies] = useState<any[]>([]);
  const [filtro, setFiltro] = useState<'tudo' | 'depositos' | 'emMaos'>('tudo');
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [marcando, setMarcando] = useState<string | null>(null);

  useEffect(() => {
    api<any[]>('/admin/contas-pagar/especies').then(setEspecies).catch(() => {});
  }, []);
  const depositoId = especies.find((e) => e.nome === 'DEPOSITO')?.id;

  const carregar = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams();
      p.set('status', 'pendentes');
      p.set('ate', hojeStr());
      p.set('perPage', '200');
      if (filtro === 'depositos' && depositoId) p.set('especieId', depositoId);
      if (filtro === 'emMaos') p.set('emMaos', '1');
      setData(await api<any>(`/admin/contas-pagar/list?${p}`));
    } catch (e: any) {
      avisar('erro', e?.message || 'Falha ao carregar');
    } finally { setLoading(false); }
  }, [filtro, depositoId, avisar]);
  useEffect(() => { carregar(); }, [carregar]);

  const rows: any[] = data?.rows || [];
  const atrasadas = rows.filter((r) => r.vencida);
  const doDia = rows.filter((r) => !r.vencida);
  const soma = (l: any[]) => l.reduce((s, r) => s + r.valorCents, 0);

  const feito = async (r: any) => {
    setMarcando(r.id);
    try {
      await api(`/admin/contas-pagar/${r.id}/pagar`, { method: 'PATCH', body: JSON.stringify({ pagamento: hojeStr() }) });
      avisar('ok', `Feito: ${r.beneficiario || ''} ${brl(r.valorCents)} (reabre pelo Painel se precisar)`);
      carregar();
    } catch (e: any) {
      avisar('erro', e?.message || 'Falhou');
    } finally { setMarcando(null); }
  };

  const imprimir = () => {
    const linha = (r: any) =>
      `<tr><td class="cb">☐</td><td>${fmtData(r.vencimento)}</td><td><b>${r.beneficiario || '—'}</b>${r.observacao ? `<br><small>${r.observacao}</small>` : ''}</td><td>${r.especie}</td><td>${r.banco || '—'}</td><td>${r.lojaCode}</td><td class="v">${brl(r.valorCents)}</td></tr>`;
    const bloco = (titulo: string, l: any[]) => l.length
      ? `<h2>${titulo} — ${l.length} conta(s) · ${brl(soma(l))}</h2><table><tr><th></th><th>Venc.</th><th>Beneficiário</th><th>Espécie</th><th>Banco</th><th>Loja</th><th>Valor</th></tr>${l.map(linha).join('')}</table>`
      : '';
    const w = window.open('', 'lurds_a_fazer', 'width=760,height=640');
    if (!w) { avisar('erro', 'Popup bloqueado — libere popups pra imprimir'); return; }
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>A fazer — ${new Date().toLocaleDateString('pt-BR')}</title>
      <style>
        body{font-family:Arial,sans-serif;font-size:13px;color:#111;margin:20px}
        h1{font-size:16px;margin:0 0 2px} .sub{color:#666;font-size:11px;margin-bottom:14px}
        h2{font-size:13px;margin:16px 0 6px;border-bottom:1.5px solid #111;padding-bottom:3px}
        table{width:100%;border-collapse:collapse} th{font-size:10px;text-transform:uppercase;color:#666;text-align:left;padding:3px 6px}
        td{padding:4px 6px;border-bottom:1px solid #ddd;vertical-align:top} td.cb{font-size:16px;width:22px} td.v{text-align:right;font-weight:bold;white-space:nowrap}
        small{color:#888} .tot{margin-top:14px;text-align:right;font-weight:bold;font-size:14px}
      </style></head><body>
      <h1>Lurd's Plus Size — contas a fazer</h1>
      <div class="sub">${new Date().toLocaleDateString('pt-BR')} · filtro: ${filtro === 'depositos' ? 'só depósitos' : filtro === 'emMaos' ? 'só em mãos' : 'tudo'}</div>
      ${bloco('ATRASADAS', atrasadas)}
      ${bloco('VENCEM HOJE', doDia)}
      <div class="tot">TOTAL: ${rows.length} conta(s) · ${brl(soma(rows))}</div>
      </body></html>`);
    w.document.close();
    w.focus();
    w.print();
  };

  const Grupo = ({ titulo, cor, lista }: { titulo: string; cor: string; lista: any[] }) => (
    <div className="bg-white border border-[#E7E2D8] rounded-xl overflow-x-auto">
      <div className={`px-4 py-2.5 flex items-center justify-between border-b border-[#E7E2D8] ${cor === 'rose' ? 'bg-rose-50' : 'bg-amber-50'}`}>
        <span className={`text-sm font-extrabold ${cor === 'rose' ? 'text-rose-600' : 'text-amber-700'}`}>{titulo} · {lista.length} conta(s)</span>
        <span className="text-sm font-extrabold text-[#2E7D46]">{brl(soma(lista))}</span>
      </div>
      <table className="w-full text-sm min-w-[820px]">
        <tbody>
          {lista.map((r) => (
            <tr key={r.id} className="border-b border-[#F1EDE3] hover:bg-[#FBF6E6]">
              <td className="px-3 py-2 whitespace-nowrap text-slate-600 w-24">{fmtData(r.vencimento)}</td>
              <td className="px-3 py-2">
                <div className="font-bold">{r.beneficiario || '—'}{r.beneficiarioTipo === 'funcionaria' ? ' 👤' : ''}</div>
                {r.observacao && <div className="text-[11px] text-slate-400">{r.observacao}</div>}
              </td>
              <td className="px-3 py-2 whitespace-nowrap">
                <span className="text-[11px] font-bold px-2 py-0.5 rounded bg-[#FAFAF7] border border-[#E7E2D8] text-slate-500">{r.especie}</span>
              </td>
              <td className="px-3 py-2 text-slate-500 text-[12px]">{r.banco || '—'}</td>
              <td className="px-3 py-2 text-slate-600 w-14">{r.lojaCode}</td>
              <td className="px-3 py-2 text-slate-500 w-16">{r.parcela || ''}</td>
              <td className="px-3 py-2 text-center w-20">{r.emMaos && <span className="text-[11px] font-extrabold px-2 py-0.5 rounded-full border bg-emerald-50 border-[#2E7D46] text-[#2E7D46]">✋ em mãos</span>}</td>
              <td className="px-3 py-2 text-right font-extrabold text-[#2E7D46] whitespace-nowrap">{brl(r.valorCents)}</td>
              <td className="px-3 py-2 text-right w-28">
                <button
                  onClick={() => feito(r)}
                  disabled={marcando === r.id}
                  className="text-[12px] font-bold px-3 py-1.5 rounded-lg border border-[#2E7D46] text-[#2E7D46] hover:bg-emerald-50 disabled:opacity-50"
                >{marcando === r.id ? <Loader2 className="w-3.5 h-3.5 animate-spin inline" /> : '✓ Feito'}</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="bg-white border border-[#E7E2D8] rounded-xl p-4 flex flex-wrap items-center gap-2 text-sm">
        {([['tudo', '📋 Tudo'], ['depositos', '🏦 Só depósitos'], ['emMaos', '✋ Só em mãos']] as const).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setFiltro(k)}
            className={`px-3 py-1.5 rounded-full border font-semibold ${filtro === k ? 'bg-[#FBF6E6] border-[#B8912B] text-[#8C7325]' : 'border-[#E7E2D8] text-slate-500 hover:bg-[#FBF6E6]'}`}
          >{label}</button>
        ))}
        {data && (
          <span className="text-slate-500 ml-1">
            {data.total} conta(s) até hoje · <b className="text-[#2E7D46]">{brl(data.somaCents)}</b>
            {data.total > rows.length && <span className="text-amber-600"> · mostrando as primeiras {rows.length}</span>}
          </span>
        )}
        <button
          onClick={imprimir}
          disabled={!rows.length}
          className="ml-auto px-4 py-2 rounded-lg bg-[#B8912B] hover:bg-[#8C7325] text-white font-bold text-sm flex items-center gap-2 disabled:opacity-50"
        ><Printer className="w-4 h-4" /> Imprimir lista</button>
      </div>

      {loading && !data ? (
        <div className="p-10 text-center text-slate-400"><Loader2 className="w-6 h-6 animate-spin mx-auto" /></div>
      ) : !rows.length ? (
        <div className="bg-white border border-[#E7E2D8] rounded-xl p-10 text-center text-slate-400">
          🎉 Nada a fazer{filtro !== 'tudo' ? ' nesse filtro' : ''} — nenhuma conta vencida ou vencendo hoje.
        </div>
      ) : (
        <>
          {atrasadas.length > 0 && <Grupo titulo="ATRASADAS" cor="rose" lista={atrasadas} />}
          {doDia.length > 0 && <Grupo titulo="VENCEM HOJE" cor="amber" lista={doDia} />}
        </>
      )}
    </div>
  );
}

/* ═══════════════════ FUNCIONÁRIAS ═══════════════════ */
function Funcionarias() {
  const [mes, setMes] = useState(new Date().toISOString().slice(0, 7));
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setLoading(true);
    api<any>(`/admin/contas-pagar/funcionarias/resumo?mes=${mes}`)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [mes]);
  return (
    <div className="space-y-4">
      <div className="bg-white border border-[#E7E2D8] rounded-xl p-4 flex items-center gap-3 text-sm">
        <label className="text-slate-500 font-semibold">Mês</label>
        <input type="month" value={mes} onChange={(e) => setMes(e.target.value)} className="border border-[#E7E2D8] rounded-lg px-2 py-1" />
        {data && <span className="text-slate-500">{data.qtd} lançamento(s) · total <b className="text-[#2E7D46]">{brl(data.totalCents)}</b></span>}
        <span className="ml-auto text-[11px] text-slate-400">🔒 Visível só pra perfis autorizados (admin/master)</span>
      </div>
      {loading ? (
        <div className="p-10 text-center text-slate-400"><Loader2 className="w-6 h-6 animate-spin mx-auto" /></div>
      ) : !data?.pessoas?.length ? (
        <div className="bg-white border border-[#E7E2D8] rounded-xl p-10 text-center text-slate-400">
          Nenhum pagamento de funcionária no mês. Lance por “Nova conta → 👤 Funcionária”.
        </div>
      ) : (
        <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-3">
          {data.pessoas.map((p: any) => (
            <div key={p.sellerId || p.nome} className="bg-white border border-[#E7E2D8] rounded-xl p-4">
              <div className="font-extrabold">{p.nome}</div>
              <div className="text-lg font-extrabold text-[#2E7D46] my-1">{brl(p.totalCents)}</div>
              <div className="space-y-1">
                {p.itens.map((i: any) => (
                  <div key={i.id} className="text-xs text-slate-500 flex justify-between">
                    <span>{i.especie} · loja {i.lojaCode} · {fmtData(i.vencimento)}</span>
                    <span className="font-bold">{brl(i.valorCents)} {i.status === 'paga' ? '✓' : '⏳'}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ═══════════ ASSOCIAÇÃO — referência = FUNCIONÁRIAS do RH (alfabética) ═══════════
   Pedido do dono (11/07): o inverso da fila por fornecedor — eu procuro a
   funcionária pelo nome certinho (tabela do RH) e associo os fornecedores dela. */
function Associacao({ avisar }: { avisar: (t: 'ok' | 'erro', m: string) => void }) {
  const [painel, setPainel] = useState<any>(null);
  const [data, setData] = useState<any>(null); // fila restante (criar histórica / não é pessoa)
  const [decididos, setDecididos] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [rodando, setRodando] = useState<string | null>(null);
  const [escolhendo, setEscolhendo] = useState<any | null>(null); // fornecedor no modal "escolher funcionária"
  const [buscandoPara, setBuscandoPara] = useState<any | null>(null); // funcionária no modal "buscar fornecedor"
  const [filtroFun, setFiltroFun] = useState('');
  const [soComSugestao, setSoComSugestao] = useState(true);

  const carregar = useCallback(async () => {
    setLoading(true);
    try {
      const [p, c, d] = await Promise.all([
        api<any>('/admin/contas-pagar/associacao/painel'),
        api<any>('/admin/contas-pagar/associacao/candidatos'),
        api<any[]>('/admin/contas-pagar/associacao/decididos'),
      ]);
      setPainel(p);
      setData(c);
      setDecididos(d || []);
    } catch (e: any) {
      avisar('erro', e?.message || 'Falha ao carregar');
    } finally { setLoading(false); }
  }, [avisar]);
  useEffect(() => { carregar(); }, [carregar]);

  const acao = async (fn: () => Promise<any>, ok: string, label: string) => {
    setRodando(label);
    try { const r = await fn(); avisar('ok', typeof ok === 'string' ? ok : ok); carregar(); return r; }
    catch (e: any) { avisar('erro', e?.message || 'Falhou'); }
    finally { setRodando(null); }
  };

  return (
    <div className="space-y-4">
      <div className="bg-white border-l-4 border-[#B8912B] rounded-lg p-3 text-sm text-slate-500">
        👤 <b>Fornecedores que são PESSOAS</b> (folha RH/VALE de 20 anos no GIGA) viram beneficiária
        FUNCIONÁRIA em todas as contas e somem do autocomplete de fornecedores. Tudo reversível e auditado.
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => acao(() => api('/admin/contas-pagar/associacao/importar-giga', { method: 'POST' }), 'Funcionárias do GIGA importadas', 'import')}
          disabled={!!rodando}
          className="px-4 py-2 rounded-lg bg-[#B8912B] text-white font-bold text-sm flex items-center gap-2 disabled:opacity-60"
        >
          {rodando === 'import' ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          1 · Importar funcionárias do GIGA (CPF/loja)
        </button>
        <button
          onClick={() => acao(() => api('/admin/contas-pagar/associacao/confirmar-exatos', { method: 'POST' }), 'Nomes exatos associados em lote', 'exatos')}
          disabled={!!rodando || !data?.exatos}
          className="px-4 py-2 rounded-lg bg-[#2E7D46] text-white font-bold text-sm flex items-center gap-2 disabled:opacity-60"
        >
          {rodando === 'exatos' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
          2 · Confirmar todos os EXATOS ({data?.exatos ?? 0})
        </button>
        <button onClick={carregar} className="px-4 py-2 rounded-lg border border-[#E7E2D8] text-slate-500 font-bold text-sm">Atualizar</button>
      </div>

      {loading && !painel ? (
        <div className="p-10 text-center text-slate-400"><Loader2 className="w-6 h-6 animate-spin mx-auto" /></div>
      ) : (
        <>
          {/* ── REFERÊNCIA: funcionárias do RH, ordem alfabética ── */}
          <div className="bg-white border border-[#E7E2D8] rounded-xl p-3 flex flex-wrap items-center gap-2 text-sm">
            <Search className="w-4 h-4 text-slate-400" />
            <input
              value={filtroFun}
              onChange={(e) => setFiltroFun(e.target.value)}
              placeholder="Filtrar funcionária pelo nome…"
              className="flex-1 min-w-[220px] border border-[#E7E2D8] rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-[#B8912B]"
            />
            <button
              onClick={() => setSoComSugestao(!soComSugestao)}
              className={`px-3 py-1 rounded-full border font-semibold ${soComSugestao ? 'bg-[#FBF6E6] border-[#B8912B] text-[#8C7325]' : 'border-[#E7E2D8] text-slate-500'}`}
            >Só com sugestão/associação</button>
            {painel && (
              <span className="text-[12px] text-slate-400">
                {painel.pendentesTotal} fornecedor(es)-pessoa pendente(s)
              </span>
            )}
          </div>

          <div className="bg-white border border-[#E7E2D8] rounded-xl overflow-x-auto">
            <table className="w-full text-sm min-w-[880px]">
              <thead>
                <tr className="bg-[#FAFAF7] text-[11px] uppercase tracking-wide text-slate-500 border-b border-[#E7E2D8]">
                  <th className="text-left px-3 py-2">Funcionária (RH · A→Z)</th>
                  <th className="text-left px-3 py-2">Fornecedores associados</th>
                  <th className="text-left px-3 py-2">Sugestões (clique pra associar)</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {(painel?.funcionarias || [])
                  .filter((f: any) => {
                    if (soComSugestao && !f.sugestoes.length && !f.associados.length) return false;
                    if (!filtroFun.trim()) return true;
                    return f.nome.toUpperCase().includes(filtroFun.trim().toUpperCase());
                  })
                  .map((f: any) => (
                    <tr key={f.sellerId} className="border-b border-[#F1EDE3] hover:bg-[#FBF6E6] align-top">
                      <td className="px-3 py-2 whitespace-nowrap">
                        <div className="font-bold">{f.nome}</div>
                        <div className="text-[11px] text-slate-400">
                          {f.loja && <span className="font-bold text-[#8C7325]">{f.loja}</span>}
                          {f.cpf && <span> · CPF {f.cpf}</span>}
                          {!f.ativa && <span> · inativa</span>}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        {f.associados.length ? f.associados.map((a: any) => (
                          <span key={a.codigo} className="inline-flex items-center gap-1 text-[11px] font-bold bg-emerald-50 text-[#2E7D46] rounded-full px-2 py-0.5 mr-1 mb-1">
                            ✓ {a.nome} <span className="text-emerald-500 font-normal">({a.contas})</span>
                          </span>
                        )) : <span className="text-[12px] text-slate-300">—</span>}
                      </td>
                      <td className="px-3 py-2">
                        {f.sugestoes.length ? f.sugestoes.map((s: any) => (
                          <button
                            key={s.codigo}
                            disabled={!!rodando}
                            onClick={() => acao(() => api('/admin/contas-pagar/associacao/associar', { method: 'POST', body: JSON.stringify({ fornecedorGigaCodigo: s.codigo, sellerId: f.sellerId }) }), `${s.nome} → ${f.nome}`, `s${s.codigo}`)}
                            title={`${s.totalContas} lançamento(s) · ${brl(s.somaCents)} · confiança: ${s.nivel}`}
                            className={`inline-flex items-center gap-1 text-[11px] font-bold rounded-full px-2 py-0.5 mr-1 mb-1 border ${s.nivel === 'exato' ? 'border-[#2E7D46] text-[#2E7D46] hover:bg-emerald-50' : 'border-amber-400 text-amber-700 hover:bg-amber-50'}`}
                          >
                            ＋ {s.nome} <span className="font-normal">({s.totalContas})</span>
                          </button>
                        )) : <span className="text-[12px] text-slate-300">—</span>}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-right">
                        <button
                          onClick={() => setBuscandoPara(f)}
                          disabled={!!rodando}
                          className="text-[12px] font-bold px-2.5 py-1 rounded-lg border border-[#E7E2D8] text-slate-500 hover:bg-[#FBF6E6]"
                        >🔍 Buscar fornecedor…</button>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>

          {/* ── Fornecedores-pessoa que sobraram (ex sem cadastro / não é pessoa) ── */}
          {(data?.candidatos?.length ?? 0) > 0 && (
            <div className="bg-white border border-[#E7E2D8] rounded-xl p-4">
              <h3 className="text-sm font-extrabold text-slate-600 mb-1">
                Fornecedores-pessoa ainda sem dona ({data.candidatos.length})
              </h3>
              <p className="text-[12px] text-slate-400 mb-2">
                Ex-funcionárias sem cadastro → <b>Criar histórica</b>. Empresas que caíram aqui por engano → <b>Não é pessoa</b>.
              </p>
              <div className="max-h-72 overflow-y-auto divide-y divide-[#F1EDE3]">
                {data.candidatos.map((c: any) => (
                  <div key={c.codigo} className="py-1.5 text-sm flex items-center justify-between gap-2">
                    <span className="min-w-0">
                      <b>{c.nome}</b>
                      <span className="text-[11px] text-slate-400"> · {c.totalContas} lançamento(s) · {brl(c.somaCents)}</span>
                    </span>
                    <span className="shrink-0">
                      <button onClick={() => setEscolhendo(c)} disabled={!!rodando} className="text-[11px] font-bold px-2 py-0.5 rounded border border-[#E7E2D8] text-slate-500 hover:bg-[#FBF6E6] mr-1">Escolher…</button>
                      <button
                        onClick={() => acao(() => api('/admin/contas-pagar/associacao/associar', { method: 'POST', body: JSON.stringify({ fornecedorGigaCodigo: c.codigo, criarHistorica: true }) }), 'Funcionária histórica criada e associada', `h${c.codigo}`)}
                        disabled={!!rodando}
                        className="text-[11px] font-bold px-2 py-0.5 rounded border border-[#B8912B] text-[#8C7325] hover:bg-[#FBF6E6] mr-1"
                      >👤 Criar histórica</button>
                      <button
                        onClick={() => acao(() => api('/admin/contas-pagar/associacao/nao-eh-pessoa', { method: 'POST', body: JSON.stringify({ fornecedorGigaCodigo: c.codigo }) }), 'Marcado como "não é pessoa"', `n${c.codigo}`)}
                        disabled={!!rodando}
                        className="text-[11px] font-bold px-2 py-0.5 rounded border border-[#E7E2D8] text-slate-400 hover:bg-rose-50"
                      >Não é pessoa</button>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {decididos.length > 0 && (
            <div className="bg-white border border-[#E7E2D8] rounded-xl p-4">
              <h3 className="text-sm font-extrabold text-slate-600 mb-2">Decididos ({decididos.length})</h3>
              <div className="max-h-64 overflow-y-auto divide-y divide-[#F1EDE3]">
                {decididos.map((d: any) => (
                  <div key={d.id} className="py-1.5 text-sm flex items-center justify-between gap-2">
                    <span>
                      <b>{d.fornecedorNome || `GIGA #${d.fornecedorGigaCodigo}`}</b>
                      {d.naoEhPessoa
                        ? <span className="text-slate-400"> — não é pessoa</span>
                        : <span> → 👤 <b>{d.sellerNome}</b> <span className="text-[11px] text-slate-400">({d.contasConvertidas} conta(s))</span></span>}
                    </span>
                    <button
                      onClick={() => acao(() => api('/admin/contas-pagar/associacao/desfazer', { method: 'POST', body: JSON.stringify({ fornecedorGigaCodigo: d.fornecedorGigaCodigo }) }), 'Desfeito', `d${d.id}`)}
                      className="text-[11px] font-bold px-2 py-0.5 rounded border border-[#E7E2D8] text-slate-400 hover:bg-rose-50"
                    >Desfazer</button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {escolhendo && (
        <EscolherFuncionariaModal
          candidato={escolhendo}
          onClose={() => setEscolhendo(null)}
          onOk={() => { setEscolhendo(null); carregar(); }}
          avisar={avisar}
        />
      )}
      {buscandoPara && (
        <BuscarFornecedorModal
          funcionaria={buscandoPara}
          onClose={() => setBuscandoPara(null)}
          onOk={() => { setBuscandoPara(null); carregar(); }}
          avisar={avisar}
        />
      )}
    </div>
  );
}

/** Busca fornecedor PENDENTE (qualquer parte do nome) e associa à funcionária. */
function BuscarFornecedorModal({ funcionaria, onClose, onOk, avisar }: any) {
  const [q, setQ] = useState('');
  const [opts, setOpts] = useState<any[]>([]);
  const [saving, setSaving] = useState(false);
  const tRef = useRef<any>(null);
  useEffect(() => {
    clearTimeout(tRef.current);
    tRef.current = setTimeout(async () => {
      try { setOpts(await api<any[]>(`/admin/contas-pagar/associacao/pendentes?q=${encodeURIComponent(q)}`)); }
      catch { setOpts([]); }
    }, 250);
  }, [q]);
  const escolher = async (codigo: number, nome: string) => {
    setSaving(true);
    try {
      await api('/admin/contas-pagar/associacao/associar', {
        method: 'POST',
        body: JSON.stringify({ fornecedorGigaCodigo: codigo, sellerId: funcionaria.sellerId }),
      });
      avisar('ok', `${nome} → ${funcionaria.nome}`);
      onOk();
    } catch (e: any) { avisar('erro', e?.message || 'Falhou'); }
    finally { setSaving(false); }
  };
  return (
    <Modal titulo={`Associar fornecedor a "${funcionaria.nome}"`} onClose={onClose}>
      <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Busque o fornecedor por qualquer parte do nome…" className="inp" />
      <div className="max-h-64 overflow-y-auto divide-y divide-[#F1EDE3] mt-2">
        {opts.map((o) => (
          <button key={o.codigo} disabled={saving} onClick={() => escolher(o.codigo, o.nome)} className="block w-full text-left px-2 py-2 text-sm hover:bg-[#FBF6E6]">
            <b>{o.nome}</b>
            <span className="text-[11px] text-slate-400 ml-2">GIGA #{o.codigo} · {o.totalContas} lançamento(s) · {brl(o.somaCents)}</span>
          </button>
        ))}
        {!opts.length && <p className="text-sm text-slate-400 py-3 px-2">Nenhum fornecedor pendente com esse texto.</p>}
      </div>
    </Modal>
  );
}

function EscolherFuncionariaModal({ candidato, onClose, onOk, avisar }: any) {
  const [q, setQ] = useState('');
  const [opts, setOpts] = useState<any[]>([]);
  const [saving, setSaving] = useState(false);
  const tRef = useRef<any>(null);
  useEffect(() => {
    clearTimeout(tRef.current);
    tRef.current = setTimeout(async () => {
      try { setOpts(await api<any[]>(`/admin/contas-pagar/associacao/funcionarias?q=${encodeURIComponent(q)}`)); }
      catch { setOpts([]); }
    }, 250);
  }, [q]);
  const escolher = async (sellerId: string, nome: string) => {
    setSaving(true);
    try {
      await api('/admin/contas-pagar/associacao/associar', {
        method: 'POST',
        body: JSON.stringify({ fornecedorGigaCodigo: candidato.codigo, sellerId }),
      });
      avisar('ok', `Associado: ${nome}`);
      onOk();
    } catch (e: any) { avisar('erro', e?.message || 'Falhou'); }
    finally { setSaving(false); }
  };
  return (
    <Modal titulo={`Associar "${candidato.nome}" a…`} onClose={onClose}>
      <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Busque a funcionária (inclui inativas/históricas)…" className="inp" />
      <div className="max-h-64 overflow-y-auto divide-y divide-[#F1EDE3] mt-2">
        {opts.map((o) => (
          <button key={o.id} disabled={saving} onClick={() => escolher(o.id, o.name)} className="block w-full text-left px-2 py-2 text-sm hover:bg-[#FBF6E6]">
            <b>{o.name}</b>
            {o.loja && <span className="text-[11px] font-bold text-[#8C7325] ml-2">· {o.loja}</span>}
            {!o.active && <span className="text-[10px] text-slate-400 ml-1">(inativa)</span>}
            {o.cpf && <span className="text-[11px] text-slate-400 ml-2">CPF {o.cpf}</span>}
          </button>
        ))}
        {!opts.length && <p className="text-sm text-slate-400 py-3 px-2">Digite pra buscar…</p>}
      </div>
    </Modal>
  );
}

/* ═══════════════════ DIVERGÊNCIAS (migração GIGA × FLOW) ═══════════════════ */
function Divergencias({ avisar }: { avisar: (t: 'ok' | 'erro', m: string) => void }) {
  const [val, setVal] = useState<any>(null);
  const [prog, setProg] = useState<any>(null);
  const pollRef = useRef<any>(null);
  const carregar = useCallback(() => {
    api<any>('/admin/contas-pagar/validacao').then(setVal).catch(() => setVal(null));
  }, []);

  // Acompanha o job em background (espelho/migração) a cada 2s.
  const acompanhar = useCallback(() => {
    clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const p = await api<any>('/admin/contas-pagar/progresso');
        setProg(p);
        if (!p?.running) {
          clearInterval(pollRef.current);
          if (p?.finishedAt) {
            if (p.error) avisar('erro', `${p.step === 'espelho' ? 'Espelho' : 'Migração'}: ${p.error}`);
            else avisar('ok', `${p.step === 'espelho' ? 'Espelho' : 'Migração'} concluído`);
          }
          carregar();
        }
      } catch { /* mantém polling */ }
    }, 2000);
  }, [avisar, carregar]);

  useEffect(() => {
    carregar();
    // Se já tem job rodando (ex.: voltou pra tela), retoma o acompanhamento.
    api<any>('/admin/contas-pagar/progresso').then((p) => { setProg(p); if (p?.running) acompanhar(); }).catch(() => {});
    return () => clearInterval(pollRef.current);
  }, [carregar, acompanhar]);

  const rodando = !!prog?.running;
  const rodar = async (rota: string, label: string) => {
    try {
      const r = await api<any>(`/admin/contas-pagar/${rota}`, { method: 'POST' });
      if (r?.alreadyRunning) { avisar('erro', 'Já tem um processo rodando — aguarde terminar'); return; }
      avisar('ok', `${label} iniciado — acompanhe a barra`);
      acompanhar();
    } catch (e: any) {
      avisar('erro', `${label}: ${e?.message || 'falhou'}`);
    }
  };

  return (
    <div className="space-y-4">
      <div className="bg-white border-l-4 border-[#B8912B] rounded-lg p-3 text-sm text-slate-500">
        ⚖️ <b>Regra da migração:</b> divergência NUNCA se corrige sozinha — aparece aqui e você decide.
        Lançamento novo é só no Flow; o GIGA fica congelado pra consulta.
      </div>
      <div className="flex gap-2">
        <button onClick={() => rodar('espelho/sync', 'Espelho do GIGA')} disabled={rodando} className="px-4 py-2 rounded-lg bg-[#B8912B] text-white font-bold text-sm flex items-center gap-2 disabled:opacity-60">
          {rodando && prog?.step === 'espelho' ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} 1 · Sincronizar espelho
        </button>
        <button onClick={() => rodar('migrar', 'Migração')} disabled={rodando} className="px-4 py-2 rounded-lg bg-[#B8912B] text-white font-bold text-sm flex items-center gap-2 disabled:opacity-60">
          {rodando && prog?.step === 'migracao' ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} 2 · Migrar (idempotente)
        </button>
        <button onClick={carregar} className="px-4 py-2 rounded-lg border border-[#E7E2D8] text-slate-500 font-bold text-sm">Atualizar validação</button>
      </div>
      {rodando && (
        <div className="bg-white border border-[#E7E2D8] rounded-xl p-4">
          <div className="flex justify-between text-sm font-bold text-slate-600 mb-2">
            <span>⏳ {prog?.step === 'espelho' ? 'Copiando o GIGA pro espelho…' : 'Migrando pro modelo novo…'}</span>
            <span>{(prog?.processed || 0).toLocaleString('pt-BR')} / {(prog?.total || 0).toLocaleString('pt-BR')}</span>
          </div>
          <div className="h-2.5 bg-[#F1EDE3] rounded-full overflow-hidden">
            <div
              className="h-full bg-[#B8912B] rounded-full transition-all"
              style={{ width: `${prog?.total ? Math.min(100, Math.round((prog.processed / prog.total) * 100)) : 5}%` }}
            />
          </div>
          <p className="text-[11px] text-slate-400 mt-2">Roda no servidor — pode sair da tela. Rodar de novo NÃO duplica (continua de onde parou).</p>
        </div>
      )}
      {!rodando && prog?.finishedAt && prog?.resumo && (
        <p className="text-xs text-slate-500">
          Último processo ({prog.step === 'espelho' ? 'espelho' : 'migração'}): {prog.error ? `❌ ${prog.error}` : '✓ concluído'}
          {prog.resumo?.linhas != null && ` · ${Number(prog.resumo.linhas).toLocaleString('pt-BR')} linhas`}
          {prog.resumo?.criadas != null && ` · ${Number(prog.resumo.criadas).toLocaleString('pt-BR')} novas, ${Number(prog.resumo.puladas || 0).toLocaleString('pt-BR')} já migradas`}
          {prog.resumo?.durationMs != null && ` · ${Math.round(prog.resumo.durationMs / 1000)}s`}
        </p>
      )}
      {val && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <CardStat titulo="GIGA (espelho)" cents={Math.round(Number(val.espelho?.soma || 0) * 100)} qtd={val.espelho?.total || 0} cor="text-slate-800" />
            <CardStat titulo="FLOW (migradas)" cents={Math.round(Number(val.flow?.soma || 0) * 100)} qtd={val.flow?.total || 0} cor="text-slate-800" />
            <div className={`border rounded-xl px-4 py-3 ${val.ok ? 'bg-emerald-50 border-[#2E7D46]' : 'bg-rose-50 border-rose-300'}`}>
              <div className="text-[10px] uppercase tracking-wider font-bold text-slate-400">Equivalência</div>
              <div className={`text-lg font-extrabold ${val.ok ? 'text-[#2E7D46]' : 'text-rose-600'}`}>{val.ok ? '✓ 100% batendo' : 'DIVERGENTE'}</div>
              <div className="text-[11px] text-slate-400">abertas: GIGA {val.espelho?.abertas} × FLOW {val.flow?.abertas}</div>
            </div>
            <div className="bg-white border border-[#E7E2D8] rounded-xl px-4 py-3">
              <div className="text-[10px] uppercase tracking-wider font-bold text-slate-400">Conferido em</div>
              <div className="text-sm font-bold">{val.geradoEm ? new Date(val.geradoEm).toLocaleString('pt-BR') : '—'}</div>
            </div>
          </div>
          {val.lojasDivergentes?.length > 0 && (
            <div className="bg-white border border-[#E7E2D8] rounded-xl overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="bg-[#FAFAF7] text-[11px] uppercase text-slate-500 border-b border-[#E7E2D8]">
                  <th className="text-left px-3 py-2">Loja</th><th className="text-right px-3 py-2">GIGA</th><th className="text-right px-3 py-2">FLOW</th><th className="text-right px-3 py-2">Diferença</th>
                </tr></thead>
                <tbody>
                  {val.lojasDivergentes.map((l: any) => (
                    <tr key={l.loja} className="border-b border-[#F1EDE3]">
                      <td className="px-3 py-2 font-bold">{l.loja}</td>
                      <td className="px-3 py-2 text-right">{l.giga_total}</td>
                      <td className="px-3 py-2 text-right">{l.flow_total}</td>
                      <td className="px-3 py-2 text-right font-bold text-rose-600">{Number(l.giga_total) - Number(l.flow_total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {!val && <p className="text-sm text-slate-400">Validação indisponível — rode o espelho e a migração primeiro.</p>}
    </div>
  );
}

/* ═══════════════════ componentes base ═══════════════════ */
function Modal({ titulo, children, onClose, largo }: any) {
  return (
    <div className="fixed inset-0 bg-black/40 z-40 flex items-start justify-center p-4 overflow-y-auto" onClick={onClose}>
      <div className={`bg-white rounded-2xl shadow-xl w-full ${largo ? 'max-w-3xl' : 'max-w-lg'} mt-10 p-5`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-extrabold">{titulo}</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[#FBF6E6]"><X className="w-5 h-5 text-slate-400" /></button>
        </div>
        {children}
        <style jsx global>{`
          .inp { width: 100%; border: 1.5px solid #E7E2D8; border-radius: 9px; padding: 8px 10px; font-size: 14px; background: #FAFAF7; }
          .inp:focus { outline: 2px solid #B8912B; border-color: #B8912B; }
        `}</style>
      </div>
    </div>
  );
}
function Campo({ label, children }: any) {
  return (
    <div>
      <label className="block text-[11px] uppercase tracking-wide font-bold text-slate-400 mb-1">{label}</label>
      {children}
    </div>
  );
}
