'use client';

/**
 * /retaguarda/mais-envios — DIAGNÓSTICO da integração Mais Envios (Parte 1).
 *
 * Valida auth + cotação contra a conta real e DESCOBRE os parâmetros da conta
 * (services/senders → customer, cardpost, pricetable, códigos de serviço) que
 * a pré-postagem vai precisar na Parte 2.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, PackageCheck, RefreshCw, Loader2, CheckCircle2, AlertTriangle, Calculator, Search, MapPin } from 'lucide-react';
import { api } from '@/lib/api';

type Status = {
  configurado: boolean;
  base: string;
  usuario?: string | null;
  customer?: string | null;
  cardpost?: string | null;
  pricetable?: string | null;
  cepOrigem?: string | null;
  servicos: Array<{ nome: string; codigo: string }>;
};
type FreteOpcao = { servico: string; codigo: string; precoReais: number | null; prazoDias: number | null; erro?: string; raw?: any };
type FreteResp = { source: string; destiny: string; pesoGramas: number; opcoes: FreteOpcao[] };

const brl = (n: number | null | undefined) =>
  n == null ? '—' : Number(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function Info({ label, value, ok }: { label: string; value: string; ok?: boolean }) {
  return (
    <div className="rounded-lg bg-slate-50 border border-slate-200 px-3 py-2">
      <div className="text-[11px] text-slate-400 uppercase tracking-wide">{label}</div>
      <div className={`text-sm font-medium ${ok === false ? 'text-rose-600' : ok === true ? 'text-emerald-700' : 'text-slate-700'}`}>{value}</div>
    </div>
  );
}

export default function MaisEnviosDiagnostico() {
  const [status, setStatus] = useState<Status | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [erroStatus, setErroStatus] = useState<string | null>(null);

  const carregarStatus = useCallback(async () => {
    setLoadingStatus(true); setErroStatus(null);
    try { setStatus(await api<Status>('/mais-envios/status')); }
    catch (e: any) { setErroStatus(e?.message || 'Falha ao carregar status'); }
    finally { setLoadingStatus(false); }
  }, []);
  useEffect(() => { carregarStatus(); }, [carregarStatus]);

  // frete
  const [origem, setOrigem] = useState('');
  const [cep, setCep] = useState('');
  const [peso, setPeso] = useState('500');
  const [frete, setFrete] = useState<FreteResp | null>(null);
  const [loadingFrete, setLoadingFrete] = useState(false);
  const [erroFrete, setErroFrete] = useState<string | null>(null);
  const [showFreteRaw, setShowFreteRaw] = useState(false);
  const testarFrete = useCallback(async () => {
    setLoadingFrete(true); setErroFrete(null); setFrete(null);
    try {
      const qs = `?cep=${cep.replace(/\D/g, '')}&origem=${origem.replace(/\D/g, '')}${peso ? `&peso=${peso.replace(/\D/g, '')}` : ''}`;
      setFrete(await api<FreteResp>(`/mais-envios/frete${qs}`));
    } catch (e: any) { setErroFrete(e?.message || 'Falha ao calcular frete'); }
    finally { setLoadingFrete(false); }
  }, [cep, origem, peso]);

  // descoberta
  const [descoberta, setDescoberta] = useState<{ tipo: string; data: any } | null>(null);
  const [loadingDesc, setLoadingDesc] = useState<string | null>(null);
  const descobrir = useCallback(async (tipo: 'services' | 'senders' | 'conta') => {
    setLoadingDesc(tipo); setDescoberta(null);
    try { setDescoberta({ tipo, data: await api<any>(`/mais-envios/${tipo}`) }); }
    catch (e: any) { setDescoberta({ tipo, data: { erro: e?.message || 'falha' } }); }
    finally { setLoadingDesc(null); }
  }, []);

  // rastreio
  const [rastCodigo, setRastCodigo] = useState('');
  const [rast, setRast] = useState<any>(null);
  const [loadingRast, setLoadingRast] = useState(false);
  const rastrear = useCallback(async () => {
    if (!rastCodigo.trim()) return;
    setLoadingRast(true); setRast(null);
    try { setRast(await api<any>(`/mais-envios/rastreio?codigo=${encodeURIComponent(rastCodigo.trim())}`)); }
    catch (e: any) { setRast({ erro: e?.message || 'falha' }); }
    finally { setLoadingRast(false); }
  }, [rastCodigo]);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800">
      <div className="max-w-5xl mx-auto px-4 py-6">
        <div className="flex items-center gap-3 mb-6">
          <Link href="/retaguarda" className="p-2 rounded-lg hover:bg-slate-200 transition-colors"><ArrowLeft size={20} /></Link>
          <PackageCheck size={22} className="text-violet-600" />
          <div>
            <h1 className="text-xl font-semibold">Mais Envios — Diagnóstico</h1>
            <p className="text-xs text-slate-500">Validar auth + cotação e descobrir os parâmetros da conta</p>
          </div>
        </div>

        {/* STATUS */}
        <section className="bg-white rounded-xl border border-slate-200 p-4 mb-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-medium flex items-center gap-2"><RefreshCw size={16} /> Configuração</h2>
            <button onClick={carregarStatus} className="text-xs text-violet-600 hover:underline flex items-center gap-1">
              {loadingStatus ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} atualizar
            </button>
          </div>
          {erroStatus && <div className="text-sm text-rose-600 flex items-center gap-2"><AlertTriangle size={15} /> {erroStatus}</div>}
          {status && (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
              <Info label="Configurado" value={status.configurado ? 'sim' : 'NÃO'} ok={status.configurado} />
              <Info label="Usuário" value={status.usuario || '—'} ok={!!status.usuario} />
              <Info label="Customer" value={status.customer || '—'} ok={!!status.customer} />
              <Info label="Cartão" value={status.cardpost || '—'} ok={!!status.cardpost} />
              <Info label="Price table" value={status.pricetable || '—'} ok={!!status.pricetable} />
              <Info label="CEP origem" value={status.cepOrigem || '—'} ok={!!status.cepOrigem} />
              <Info label="Serviços" value={status.servicos.map((s) => `${s.nome}:${s.codigo}`).join('  ')} />
            </div>
          )}
          {status && !status.configurado && (
            <div className="mt-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2">
              Faltam as envs no serviço do backend: <b>MAISENVIOS_USER</b>, <b>MAISENVIOS_PASS</b>. O CEP de origem NÃO é env (é por loja — digite na cotação). customer/cardpost/pricetable saem da descoberta abaixo.
            </div>
          )}
        </section>

        {/* DESCOBERTA */}
        <section className="bg-white rounded-xl border border-slate-200 p-4 mb-5">
          <h2 className="font-medium flex items-center gap-2 mb-1"><Search size={16} /> Descobrir conta</h2>
          <p className="text-xs text-slate-500 mb-3">Lista serviços e remetentes da sua conta — é daqui que saem os códigos de serviço, o customer e o cartão pra configurar.</p>
          <div className="flex gap-3">
            <button onClick={() => descobrir('services')} disabled={loadingDesc === 'services'} className="bg-violet-600 text-white text-sm rounded-md px-4 py-2 hover:bg-violet-700 disabled:opacity-40 flex items-center gap-2">
              {loadingDesc === 'services' ? <Loader2 size={15} className="animate-spin" /> : <Search size={15} />} Listar serviços
            </button>
            <button onClick={() => descobrir('senders')} disabled={loadingDesc === 'senders'} className="bg-violet-600 text-white text-sm rounded-md px-4 py-2 hover:bg-violet-700 disabled:opacity-40 flex items-center gap-2">
              {loadingDesc === 'senders' ? <Loader2 size={15} className="animate-spin" /> : <Search size={15} />} Listar remetentes
            </button>
            <button onClick={() => descobrir('conta')} disabled={loadingDesc === 'conta'} className="bg-violet-600 text-white text-sm rounded-md px-4 py-2 hover:bg-violet-700 disabled:opacity-40 flex items-center gap-2">
              {loadingDesc === 'conta' ? <Loader2 size={15} className="animate-spin" /> : <Search size={15} />} Customer / tabela
            </button>
          </div>
          {descoberta && (
            <pre className="mt-3 bg-slate-900 text-slate-100 text-xs rounded-lg p-3 overflow-auto max-h-96">
              {JSON.stringify(descoberta.data, null, 2)}
            </pre>
          )}
        </section>

        {/* FRETE */}
        <section className="bg-white rounded-xl border border-slate-200 p-4 mb-5">
          <h2 className="font-medium flex items-center gap-2 mb-3"><Calculator size={16} /> Testar frete</h2>
          <p className="text-xs text-slate-500 mb-3">Cada loja tem seu CEP de origem — digite o da loja que você quer testar (na Parte 2 vem automático da loja do pedido).</p>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-sm w-40"><span className="text-slate-500 text-xs">CEP origem (loja)</span>
              <input className="border border-slate-300 rounded-md px-2 py-1.5 text-sm" value={origem} onChange={(e) => setOrigem(e.target.value)} placeholder="00000-000" /></label>
            <label className="flex flex-col gap-1 text-sm w-40"><span className="text-slate-500 text-xs">CEP destino</span>
              <input className="border border-slate-300 rounded-md px-2 py-1.5 text-sm" value={cep} onChange={(e) => setCep(e.target.value)} placeholder="00000-000" /></label>
            <label className="flex flex-col gap-1 text-sm w-28"><span className="text-slate-500 text-xs">Peso (g)</span>
              <input className="border border-slate-300 rounded-md px-2 py-1.5 text-sm" value={peso} onChange={(e) => setPeso(e.target.value)} /></label>
            <button onClick={testarFrete} disabled={loadingFrete || cep.replace(/\D/g, '').length !== 8 || origem.replace(/\D/g, '').length !== 8} className="bg-violet-600 text-white text-sm rounded-md px-4 py-2 hover:bg-violet-700 disabled:opacity-40 flex items-center gap-2">
              {loadingFrete ? <Loader2 size={15} className="animate-spin" /> : <Calculator size={15} />} Calcular
            </button>
          </div>
          {erroFrete && <div className="mt-3 text-sm text-rose-600 flex items-center gap-2"><AlertTriangle size={15} /> {erroFrete}</div>}
          {frete && (
            <>
              <div className="mt-4 grid sm:grid-cols-2 gap-3">
                {frete.opcoes.map((o) => (
                  <div key={o.codigo} className={`rounded-lg border p-3 ${o.erro ? 'border-rose-200 bg-rose-50' : 'border-emerald-200 bg-emerald-50'}`}>
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{o.servico} <span className="text-xs text-slate-400">({o.codigo})</span></span>
                      {o.erro ? <AlertTriangle size={15} className="text-rose-500" /> : <CheckCircle2 size={15} className="text-emerald-600" />}
                    </div>
                    {o.erro ? <div className="text-xs text-rose-600 mt-1">{o.erro}</div> : (
                      <div className="text-sm mt-1"><b>{brl(o.precoReais)}</b><span className="text-slate-500"> · {o.prazoDias != null ? `${o.prazoDias} dia(s)` : 'prazo —'}</span></div>
                    )}
                  </div>
                ))}
              </div>
              <button onClick={() => setShowFreteRaw((v) => !v)} className="mt-2 text-xs text-violet-600 hover:underline">{showFreteRaw ? 'ocultar' : 'ver'} resposta crua</button>
              {showFreteRaw && <pre className="mt-2 bg-slate-900 text-slate-100 text-xs rounded-lg p-3 overflow-auto max-h-96">{JSON.stringify(frete.opcoes, null, 2)}</pre>}
            </>
          )}
        </section>

        {/* RASTREIO */}
        <section className="bg-white rounded-xl border border-slate-200 p-4 mb-5">
          <h2 className="font-medium flex items-center gap-2 mb-3"><MapPin size={16} /> Rastrear</h2>
          <div className="flex flex-wrap items-end gap-3">
            <input className="border border-slate-300 rounded-md px-2 py-1.5 text-sm w-56" value={rastCodigo} onChange={(e) => setRastCodigo(e.target.value)} placeholder="tag / código" />
            <button onClick={rastrear} disabled={loadingRast || !rastCodigo.trim()} className="bg-violet-600 text-white text-sm rounded-md px-4 py-2 hover:bg-violet-700 disabled:opacity-40 flex items-center gap-2">
              {loadingRast ? <Loader2 size={15} className="animate-spin" /> : <MapPin size={15} />} Rastrear
            </button>
          </div>
          {rast && <pre className="mt-3 bg-slate-900 text-slate-100 text-xs rounded-lg p-3 overflow-auto max-h-80">{JSON.stringify(rast, null, 2)}</pre>}
        </section>
      </div>
    </div>
  );
}
