'use client';

/**
 * /retaguarda/correios — DIAGNÓSTICO da integração com os Correios (API CWS).
 *
 * Serve pra VALIDAR a Parte 1 (frete + pré-postagem) contra a API real depois
 * de configurar as envs CORREIOS_* no Railway — do mesmo jeito que a gente
 * validou a SEFAZ. Três blocos:
 *   1. Status da config (configurado? ambiente? cartão? CEP origem?).
 *   2. Testar FRETE (preço + prazo PAC/SEDEX por CEP destino).
 *   3. Testar PRÉ-POSTAGEM — mostra a RESPOSTA CRUA da API (é dela que saem os
 *      campos certos pra construir a etiqueta na próxima parte).
 *
 * O remetente fica salvo em localStorage pra não redigitar a cada teste.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, Truck, RefreshCw, Loader2, CheckCircle2, AlertTriangle,
  Calculator, PackagePlus, Copy,
} from 'lucide-react';
import { api } from '@/lib/api';

// ── tipos ────────────────────────────────────────────────────────────────────
type Status = {
  configurado: boolean;
  ambiente: string;
  usuario?: string | null;
  cartaoPostagem: string | null;
  contrato: string | null;
  dr?: string | null;
  cepOrigem: string | null;
  servicos: Array<{ nome: string; codigo: string }>;
};

type FreteOpcao = { servico: string; codigo: string; precoReais: number | null; precoBase?: number | null; prazoDias: number | null; erro?: string; raw?: any };
type FreteResp = { cepOrigem: string; cepDestino: string; pesoGramas: number; opcoes: FreteOpcao[] };

type Endereco = {
  nome: string; cnpjCpf: string; endereco: string; numero: string; complemento?: string;
  bairro: string; cidade: string; uf: string; cep: string; telefone?: string;
};

const REMETENTE_KEY = 'flowops:correios:remetente';
const brl = (n: number | null | undefined) =>
  n == null ? '—' : Number(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const REMETENTE_VAZIO: Endereco = {
  nome: '', cnpjCpf: '', endereco: '', numero: '', bairro: '', cidade: '', uf: '', cep: '', telefone: '',
};
// Pré-preenche o remetente com a matriz (CEP de origem do contrato). Editável e
// salvo em localStorage — na Parte 2, o remetente vira a loja de origem do pedido.
const REMETENTE_PADRAO: Endereco = {
  nome: 'T O RISSUTTO EIRELI', cnpjCpf: '20104813000139',
  endereco: 'Av Harry Forssell', numero: '159', bairro: 'Belas Artes',
  cidade: 'Itanhaém', uf: 'SP', cep: '11746692', telefone: '',
};
const DESTINATARIO_VAZIO: Endereco = {
  nome: '', cnpjCpf: '', endereco: '', numero: '', complemento: '', bairro: '', cidade: '', uf: '', cep: '', telefone: '',
};

// ── componente de campo ───────────────────────────────────────────────────────
function Campo({
  label, value, onChange, placeholder, className = '',
}: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; className?: string }) {
  return (
    <label className={`flex flex-col gap-1 text-sm ${className}`}>
      <span className="text-slate-500 text-xs">{label}</span>
      <input
        className="border border-slate-300 rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-sky-300"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

export default function CorreiosDiagnostico() {
  // ── status ──
  const [status, setStatus] = useState<Status | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [erroStatus, setErroStatus] = useState<string | null>(null);

  // debug PRC-124: a que contrato/DR o token pertence
  const [tokenDbg, setTokenDbg] = useState<any>(null);
  const [loadingTok, setLoadingTok] = useState(false);
  const verToken = useCallback(async () => {
    setLoadingTok(true);
    setTokenDbg(null);
    try { setTokenDbg(await api('/correios/token-debug')); }
    catch (e: any) { setTokenDbg({ erro: e?.message || 'falha' }); }
    finally { setLoadingTok(false); }
  }, []);

  const carregarStatus = useCallback(async () => {
    setLoadingStatus(true);
    setErroStatus(null);
    try {
      setStatus(await api<Status>('/correios/status'));
    } catch (e: any) {
      setErroStatus(e?.message || 'Falha ao carregar status');
    } finally {
      setLoadingStatus(false);
    }
  }, []);
  useEffect(() => { carregarStatus(); }, [carregarStatus]);

  // ── frete ──
  const [cepFrete, setCepFrete] = useState('');
  const [pesoFrete, setPesoFrete] = useState('500');
  const [frete, setFrete] = useState<FreteResp | null>(null);
  const [loadingFrete, setLoadingFrete] = useState(false);
  const [erroFrete, setErroFrete] = useState<string | null>(null);
  const [showFreteRaw, setShowFreteRaw] = useState(false);

  const testarFrete = useCallback(async () => {
    setLoadingFrete(true);
    setErroFrete(null);
    setFrete(null);
    try {
      const cep = cepFrete.replace(/\D/g, '');
      const qs = `?cep=${cep}${pesoFrete ? `&peso=${pesoFrete.replace(/\D/g, '')}` : ''}`;
      setFrete(await api<FreteResp>(`/correios/frete${qs}`));
    } catch (e: any) {
      setErroFrete(e?.message || 'Falha ao calcular frete');
    } finally {
      setLoadingFrete(false);
    }
  }, [cepFrete, pesoFrete]);

  // ── pré-postagem ──
  const [remetente, setRemetente] = useState<Endereco>(REMETENTE_PADRAO);
  const [destinatario, setDestinatario] = useState<Endereco>(DESTINATARIO_VAZIO);
  const [servico, setServico] = useState<'PAC' | 'SEDEX'>('PAC');
  const [pesoPP, setPesoPP] = useState('500');
  const [nfeChave, setNfeChave] = useState('');
  const [prepost, setPrepost] = useState<any>(null);
  const [loadingPP, setLoadingPP] = useState(false);
  const [erroPP, setErroPP] = useState<string | null>(null);

  // carrega remetente salvo (1x)
  useEffect(() => {
    try {
      const raw = localStorage.getItem(REMETENTE_KEY);
      if (raw) setRemetente({ ...REMETENTE_PADRAO, ...JSON.parse(raw) });
    } catch { /* ignore */ }
  }, []);

  const setRem = (patch: Partial<Endereco>) => setRemetente((r) => {
    const next = { ...r, ...patch };
    try { localStorage.setItem(REMETENTE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
    return next;
  });
  const setDest = (patch: Partial<Endereco>) => setDestinatario((d) => ({ ...d, ...patch }));

  const testarPrepostagem = useCallback(async () => {
    setLoadingPP(true);
    setErroPP(null);
    setPrepost(null);
    try {
      const payload = {
        servico,
        pesoGramas: Number(pesoPP.replace(/\D/g, '')) || 500,
        nfeChave: nfeChave.replace(/\D/g, '') || undefined,
        remetente: { ...remetente, cnpjCpf: remetente.cnpjCpf },
        destinatario: { ...destinatario, cpfCnpj: destinatario.cnpjCpf || undefined },
      };
      setPrepost(await api('/correios/prepostagem', { method: 'POST', body: JSON.stringify(payload) }));
    } catch (e: any) {
      setErroPP(e?.message || 'Falha na pré-postagem');
    } finally {
      setLoadingPP(false);
    }
  }, [servico, pesoPP, nfeChave, remetente, destinatario]);

  const copiarRaw = () => {
    try { navigator.clipboard.writeText(JSON.stringify(prepost, null, 2)); } catch { /* ignore */ }
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800">
      <div className="max-w-5xl mx-auto px-4 py-6">
        <div className="flex items-center gap-3 mb-6">
          <Link href="/retaguarda" className="p-2 rounded-lg hover:bg-slate-200 transition-colors">
            <ArrowLeft size={20} />
          </Link>
          <Truck size={22} className="text-sky-600" />
          <div>
            <h1 className="text-xl font-semibold">Correios — Diagnóstico</h1>
            <p className="text-xs text-slate-500">Validar frete e pré-postagem contra a API real (CWS)</p>
          </div>
        </div>

        {/* ── STATUS ── */}
        <section className="bg-white rounded-xl border border-slate-200 p-4 mb-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-medium flex items-center gap-2"><RefreshCw size={16} /> Configuração</h2>
            <button onClick={carregarStatus} className="text-xs text-sky-600 hover:underline flex items-center gap-1">
              {loadingStatus ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} atualizar
            </button>
          </div>
          {erroStatus && (
            <div className="text-sm text-rose-600 flex items-center gap-2"><AlertTriangle size={15} /> {erroStatus}</div>
          )}
          {status && (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
              <Info label="Configurado" value={status.configurado ? 'sim' : 'NÃO'} ok={status.configurado} />
              <Info label="Ambiente" value={status.ambiente} />
              <Info label="Usuário API" value={status.usuario || '—'} ok={!!status.usuario} />
              <Info label="Cartão postagem" value={status.cartaoPostagem || '—'} ok={!!status.cartaoPostagem} />
              <Info label="Contrato" value={status.contrato || '—'} ok={!!status.contrato} />
              <Info label="DR" value={status.dr || '—'} ok={!!status.dr && status.dr !== '0'} />
              <Info label="CEP origem" value={status.cepOrigem || '—'} ok={!!status.cepOrigem} />
              <Info label="Serviços" value={status.servicos.map((s) => `${s.nome}:${s.codigo}`).join('  ')} />
            </div>
          )}
          {status && !status.configurado && (
            <div className="mt-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2">
              Faltam as envs no <b>serviço do backend</b> (não no Postgres): CORREIOS_API_USER, CORREIOS_API_TOKEN,
              CORREIOS_CARTAO_POSTAGEM, CORREIOS_CONTRATO, CORREIOS_CEP_ORIGEM. Configure e faça deploy.
            </div>
          )}
          {status?.configurado && (
            <div className="mt-3 pt-3 border-t border-slate-100">
              <button onClick={verToken} disabled={loadingTok} className="text-xs text-sky-600 hover:underline flex items-center gap-1 disabled:opacity-40">
                {loadingTok ? <Loader2 size={13} className="animate-spin" /> : <AlertTriangle size={13} />}
                Debug PRC-124: ver a que contrato/DR o token pertence
              </button>
              {tokenDbg && (
                <pre className="mt-2 bg-slate-900 text-slate-100 text-xs rounded-lg p-3 overflow-auto max-h-80">
                  {JSON.stringify(tokenDbg, null, 2)}
                </pre>
              )}
            </div>
          )}
        </section>

        {/* ── FRETE ── */}
        <section className="bg-white rounded-xl border border-slate-200 p-4 mb-5">
          <h2 className="font-medium flex items-center gap-2 mb-3"><Calculator size={16} /> Testar frete</h2>
          <div className="flex flex-wrap items-end gap-3">
            <Campo label="CEP destino" value={cepFrete} onChange={setCepFrete} placeholder="00000-000" className="w-40" />
            <Campo label="Peso (g)" value={pesoFrete} onChange={setPesoFrete} placeholder="500" className="w-28" />
            <button
              onClick={testarFrete}
              disabled={loadingFrete || cepFrete.replace(/\D/g, '').length !== 8}
              className="bg-sky-600 text-white text-sm rounded-md px-4 py-2 hover:bg-sky-700 disabled:opacity-40 flex items-center gap-2"
            >
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
                    {o.erro ? (
                      <div className="text-xs text-rose-600 mt-1">{o.erro}</div>
                    ) : (
                      <div className="text-sm mt-1">
                        <b>{brl(o.precoReais)}</b>
                        <span className="text-slate-500"> · {o.prazoDias != null ? `${o.prazoDias} dia(s)` : 'prazo —'}</span>
                        {o.precoBase != null && o.precoReais != null && o.precoBase !== o.precoReais && (
                          <span className="ml-2 text-xs text-slate-400">tabela cheia <s>{brl(o.precoBase)}</s></span>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <button onClick={() => setShowFreteRaw((v) => !v)} className="mt-2 text-xs text-sky-600 hover:underline">
                {showFreteRaw ? 'ocultar' : 'ver'} resposta crua do preço (conferir desconto de contrato/tabela promocional)
              </button>
              {showFreteRaw && (
                <pre className="mt-2 bg-slate-900 text-slate-100 text-xs rounded-lg p-3 overflow-auto max-h-96">
                  {JSON.stringify(frete.opcoes.map((o) => ({ servico: o.servico, codigo: o.codigo, precoFinal: o.precoReais, precoBase: o.precoBase, raw: o.raw })), null, 2)}
                </pre>
              )}
            </>
          )}
        </section>

        {/* ── PRÉ-POSTAGEM ── */}
        <section className="bg-white rounded-xl border border-slate-200 p-4 mb-5">
          <h2 className="font-medium flex items-center gap-2 mb-1"><PackagePlus size={16} /> Testar pré-postagem</h2>
          <p className="text-xs text-slate-500 mb-4">
            Gera um envio real e mostra a resposta crua da API — é dela que saem os campos pra montar a etiqueta.
            Só rode se for postar de verdade (ou cancelar depois no painel dos Correios).
          </p>

          <div className="grid md:grid-cols-2 gap-5">
            <div>
              <h3 className="text-xs font-semibold text-slate-500 uppercase mb-2">Remetente (salvo neste PC)</h3>
              <div className="grid grid-cols-2 gap-2">
                <Campo label="Nome" value={remetente.nome} onChange={(v) => setRem({ nome: v })} className="col-span-2" />
                <Campo label="CNPJ/CPF" value={remetente.cnpjCpf} onChange={(v) => setRem({ cnpjCpf: v })} />
                <Campo label="Telefone" value={remetente.telefone || ''} onChange={(v) => setRem({ telefone: v })} />
                <Campo label="Endereço" value={remetente.endereco} onChange={(v) => setRem({ endereco: v })} className="col-span-2" />
                <Campo label="Número" value={remetente.numero} onChange={(v) => setRem({ numero: v })} />
                <Campo label="Bairro" value={remetente.bairro} onChange={(v) => setRem({ bairro: v })} />
                <Campo label="Cidade" value={remetente.cidade} onChange={(v) => setRem({ cidade: v })} />
                <Campo label="UF" value={remetente.uf} onChange={(v) => setRem({ uf: v })} />
                <Campo label="CEP" value={remetente.cep} onChange={(v) => setRem({ cep: v })} className="col-span-2" />
              </div>
            </div>
            <div>
              <h3 className="text-xs font-semibold text-slate-500 uppercase mb-2">Destinatário</h3>
              <div className="grid grid-cols-2 gap-2">
                <Campo label="Nome" value={destinatario.nome} onChange={(v) => setDest({ nome: v })} className="col-span-2" />
                <Campo label="CPF/CNPJ" value={destinatario.cnpjCpf} onChange={(v) => setDest({ cnpjCpf: v })} />
                <Campo label="Telefone" value={destinatario.telefone || ''} onChange={(v) => setDest({ telefone: v })} />
                <Campo label="Endereço" value={destinatario.endereco} onChange={(v) => setDest({ endereco: v })} className="col-span-2" />
                <Campo label="Número" value={destinatario.numero} onChange={(v) => setDest({ numero: v })} />
                <Campo label="Complemento" value={destinatario.complemento || ''} onChange={(v) => setDest({ complemento: v })} />
                <Campo label="Bairro" value={destinatario.bairro} onChange={(v) => setDest({ bairro: v })} />
                <Campo label="Cidade" value={destinatario.cidade} onChange={(v) => setDest({ cidade: v })} />
                <Campo label="UF" value={destinatario.uf} onChange={(v) => setDest({ uf: v })} />
                <Campo label="CEP" value={destinatario.cep} onChange={(v) => setDest({ cep: v })} />
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-3 mt-4 pt-4 border-t border-slate-100">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-slate-500 text-xs">Serviço</span>
              <select
                className="border border-slate-300 rounded-md px-2 py-1.5 text-sm"
                value={servico}
                onChange={(e) => setServico(e.target.value as 'PAC' | 'SEDEX')}
              >
                <option value="PAC">PAC</option>
                <option value="SEDEX">SEDEX</option>
              </select>
            </label>
            <Campo label="Peso (g)" value={pesoPP} onChange={setPesoPP} className="w-28" />
            <Campo label="Chave NF-e (opcional)" value={nfeChave} onChange={setNfeChave} className="w-72" />
            <button
              onClick={testarPrepostagem}
              disabled={loadingPP || !remetente.cep || !destinatario.cep || !destinatario.nome}
              className="bg-emerald-600 text-white text-sm rounded-md px-4 py-2 hover:bg-emerald-700 disabled:opacity-40 flex items-center gap-2"
            >
              {loadingPP ? <Loader2 size={15} className="animate-spin" /> : <PackagePlus size={15} />} Criar pré-postagem
            </button>
          </div>
          {erroPP && <div className="mt-3 text-sm text-rose-600 flex items-center gap-2"><AlertTriangle size={15} /> {erroPP}</div>}
          {prepost && (
            <div className="mt-4">
              {prepost.codigoRastreio && (
                <div className="text-sm mb-2">
                  Código de rastreio: <b className="text-emerald-700">{prepost.codigoRastreio}</b>
                  {prepost.idPrepostagem ? <span className="text-slate-400"> · id {String(prepost.idPrepostagem)}</span> : null}
                </div>
              )}
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-slate-500">Resposta crua da API</span>
                <button onClick={copiarRaw} className="text-xs text-sky-600 hover:underline flex items-center gap-1"><Copy size={12} /> copiar</button>
              </div>
              <pre className="bg-slate-900 text-slate-100 text-xs rounded-lg p-3 overflow-auto max-h-96">
                {JSON.stringify(prepost, null, 2)}
              </pre>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function Info({ label, value, ok }: { label: string; value: string; ok?: boolean }) {
  return (
    <div className="rounded-lg bg-slate-50 border border-slate-200 px-3 py-2">
      <div className="text-[11px] text-slate-400 uppercase tracking-wide">{label}</div>
      <div className={`text-sm font-medium ${ok === false ? 'text-rose-600' : ok === true ? 'text-emerald-700' : 'text-slate-700'}`}>
        {value}
      </div>
    </div>
  );
}
