'use client';

/**
 * /retaguarda/clientes — CONSULTA DE CLIENTES nativa (substitui a do Giga).
 *
 * Integração (regra do dono): site + lojas + live = UMA pessoa. A busca agrupa
 * por CPF (personKey) e a ficha mostra TODAS as fichas da pessoa (uma por
 * loja), o vínculo com o CRM e o crediário em aberto (espelho).
 *
 * "Puxe tudo": além dos campos estruturados, cada ficha carrega o rawJson com
 * TODOS os campos originais do Giga — a seção "Todos os campos" renderiza
 * dinamicamente qualquer coluna (cônjuge, pai/mãe, autorizados, referências…),
 * então nada do Giga fica invisível aqui, mesmo sem mapeamento.
 */

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, Search, Users, Loader2, Phone, MapPin, CreditCard,
  ShieldAlert, ChevronDown, ChevronUp, BadgeCheck, Store,
} from 'lucide-react';
import { api } from '@/lib/api';

const brl = (v: number | null | undefined) =>
  v == null ? '—' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtData = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString('pt-BR') : '—';
const fmtCpf = (cpf: string | null | undefined) => {
  const d = String(cpf || '').replace(/\D/g, '');
  return d.length === 11 ? `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}` : cpf || '—';
};

type PessoaHit = {
  personKey: string | null;
  nome: string | null;
  cpf: string | null;
  foneCel: string | null;
  cidade: string | null;
  noCrm: boolean;
  fichas: Array<{ loja: string; codigo: string; bloqueado: string | null; avaliacao: string | null }>;
};

export default function ConsultaClientesPage() {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [pessoas, setPessoas] = useState<PessoaHit[]>([]);
  const [buscou, setBuscou] = useState(false);
  const [ficha, setFicha] = useState<any | null>(null);
  const [fichaBusy, setFichaBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const term = q.trim();
    if (term.length < 2) { setPessoas([]); setBuscou(false); return; }
    timer.current = setTimeout(async () => {
      setBusy(true);
      try {
        const r = await api<{ pessoas: PessoaHit[] }>(`/admin/clientes-giga/search?q=${encodeURIComponent(term)}`);
        setPessoas(r.pessoas || []);
        setBuscou(true);
      } catch { setPessoas([]); }
      finally { setBusy(false); }
    }, 350);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [q]);

  const abrirFicha = async (loja: string, codigo: string) => {
    setFichaBusy(true);
    try {
      const r = await api<any>(`/admin/clientes-giga/pessoa?loja=${encodeURIComponent(loja)}&codigo=${encodeURIComponent(codigo)}`);
      if (r?.found) setFicha(r);
    } catch { /* mantém a lista */ }
    finally { setFichaBusy(false); }
  };

  return (
    <div className="min-h-screen bg-[#FAFAF7] pb-16 text-slate-800">
      <header className="bg-white border-b border-[#E7E2D8] sticky top-0 z-20">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link href="/retaguarda" className="text-slate-500 hover:text-slate-800"><ArrowLeft className="w-5 h-5" /></Link>
          <Users className="w-5 h-5 text-[#B8912B]" />
          <div className="flex-1">
            <h1 className="font-bold text-lg">Consulta de Clientes</h1>
            <p className="text-xs text-slate-500">Uma pessoa só — fichas de todas as lojas + CRM (site/live) + crediário</p>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-5 space-y-4">
        {/* Busca */}
        <div className="relative">
          <Search className="w-5 h-5 absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => { setQ(e.target.value); setFicha(null); }}
            placeholder="Busque por nome, CPF, telefone ou código…"
            className="w-full rounded-xl border-2 border-[#E7E2D8] bg-white py-3.5 pl-12 pr-4 text-base shadow-sm focus:border-[#D4AF37] focus:outline-none focus:ring-2 focus:ring-[#FBF6E6]"
          />
          {busy && <Loader2 className="w-5 h-5 absolute right-4 top-1/2 -translate-y-1/2 animate-spin text-[#B8912B]" />}
        </div>

        {/* FICHA DA PESSOA */}
        {ficha ? (
          <FichaPessoa ficha={ficha} onVoltar={() => setFicha(null)} />
        ) : (
          <>
            {/* Resultados */}
            {fichaBusy && (
              <div className="text-center py-8 text-slate-400"><Loader2 className="w-6 h-6 animate-spin mx-auto" /></div>
            )}
            <div className="grid md:grid-cols-2 gap-3">
              {pessoas.map((p, i) => {
                const bloqueada = p.fichas.some((f) => String(f.bloqueado || '').toUpperCase() === 'SIM');
                const f0 = p.fichas[0];
                return (
                  <button
                    key={p.personKey || `${f0?.loja}-${f0?.codigo}-${i}`}
                    onClick={() => f0 && abrirFicha(f0.loja, f0.codigo)}
                    className="text-left bg-white rounded-xl border border-[#E7E2D8] p-4 hover:border-[#D4AF37] hover:shadow-md transition"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-bold text-slate-800 truncate">{p.nome || '(sem nome)'}</div>
                        <div className="text-xs text-slate-500 font-mono">{fmtCpf(p.cpf)}</div>
                      </div>
                      <div className="flex gap-1 shrink-0">
                        {p.noCrm && (
                          <span title="Vinculada ao CRM (site/live)" className="rounded-md bg-emerald-50 border border-emerald-300 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700 flex items-center gap-0.5">
                            <BadgeCheck className="w-3 h-3" /> CRM
                          </span>
                        )}
                        {bloqueada && (
                          <span className="rounded-md bg-red-50 border border-red-300 px-1.5 py-0.5 text-[10px] font-bold text-red-700 flex items-center gap-0.5">
                            <ShieldAlert className="w-3 h-3" /> BLOQ
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="mt-2 flex items-center gap-3 text-xs text-slate-500">
                      {p.foneCel && <span className="flex items-center gap-1"><Phone className="w-3 h-3" />{p.foneCel}</span>}
                      {p.cidade && <span className="flex items-center gap-1"><MapPin className="w-3 h-3" />{p.cidade}</span>}
                    </div>
                    <div className="mt-2 flex gap-1 flex-wrap">
                      {p.fichas.map((f) => (
                        <span key={`${f.loja}-${f.codigo}`} className="rounded bg-[#FBF6E6] border border-[#E6DFC8] px-1.5 py-0.5 text-[10px] font-bold text-[#8C7325]">
                          LJ{f.loja} · {f.codigo}{f.avaliacao ? ` · ${f.avaliacao}` : ''}
                        </span>
                      ))}
                    </div>
                  </button>
                );
              })}
            </div>
            {buscou && !busy && pessoas.length === 0 && (
              <div className="text-center py-10 text-slate-400">Nenhum cliente com “{q.trim()}”.</div>
            )}
            {!buscou && (
              <div className="text-center py-14 text-slate-400 text-sm">
                Digite ao menos 2 caracteres — a busca cobre <b>todas as lojas</b> e agrupa a pessoa pelo CPF.
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}

/* ─── Ficha unificada ─────────────────────────────────────────────────────── */
function FichaPessoa({ ficha, onVoltar }: { ficha: any; onVoltar: () => void }) {
  const { pessoa, fichas, customer, parcelasAbertas, totalAbertoReais } = ficha;
  const f0 = fichas[0] || {};
  const bloqueada = fichas.some((f: any) => String(f.bloqueado || '').toUpperCase() === 'SIM');

  const Campo = ({ label, valor }: { label: string; valor: any }) => (
    <div>
      <div className="text-[10px] uppercase tracking-wide font-bold text-slate-400">{label}</div>
      <div className="text-sm text-slate-800">{valor == null || valor === '' ? '—' : String(valor)}</div>
    </div>
  );

  return (
    <div className="space-y-4">
      <button onClick={onVoltar} className="text-sm text-slate-500 hover:text-slate-800 flex items-center gap-1">
        <ArrowLeft className="w-4 h-4" /> Voltar pra busca
      </button>

      {/* Cabeçalho da pessoa */}
      <div className="bg-white rounded-2xl border border-[#E7E2D8] shadow-sm p-5">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-2xl font-black text-slate-900">{pessoa.nome || '(sem nome)'}</h2>
            <div className="text-sm text-slate-500 font-mono mt-0.5">CPF {fmtCpf(pessoa.cpf)}</div>
          </div>
          <div className="flex gap-2">
            {customer && (
              <span className="rounded-lg bg-emerald-50 border border-emerald-300 px-2.5 py-1.5 text-xs font-bold text-emerald-700 flex items-center gap-1">
                <BadgeCheck className="w-4 h-4" /> No CRM{customer.igUsername ? ` · @${customer.igUsername}` : ''}
              </span>
            )}
            {bloqueada && (
              <span className="rounded-lg bg-red-50 border border-red-300 px-2.5 py-1.5 text-xs font-bold text-red-700 flex items-center gap-1">
                <ShieldAlert className="w-4 h-4" /> BLOQUEADO
              </span>
            )}
          </div>
        </div>
        <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-3">
          <Campo label="Nascimento" valor={f0.nascimento ? fmtData(f0.nascimento) : null} />
          <Campo label="RG" valor={f0.rg} />
          <Campo label="Celular" valor={f0.foneCel} />
          <Campo label="Email" valor={f0.email || customer?.email} />
        </div>
        <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
          <Campo
            label="Endereço"
            valor={[f0.endereco, f0.numero, f0.complemento, f0.bairro, f0.cidade, f0.uf, f0.cep].filter(Boolean).join(', ') || null}
          />
          <Campo label="Trabalho" valor={[f0.localTrabalho, f0.salario != null ? brl(Number(f0.salario)) : null].filter(Boolean).join(' · ') || null} />
        </div>
      </div>

      {/* Crediário em aberto (todas as lojas) */}
      <div className="bg-white rounded-2xl border border-[#E7E2D8] shadow-sm overflow-hidden">
        <div className="px-5 py-3 border-b border-[#F1EDE3] flex items-center justify-between">
          <h3 className="font-bold text-slate-800 flex items-center gap-2"><CreditCard className="w-4 h-4 text-[#B8912B]" /> Crediário em aberto</h3>
          <span className="font-black text-[#2E7D46]">{brl(totalAbertoReais)}</span>
        </div>
        {parcelasAbertas?.length ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] uppercase text-slate-400 border-b border-[#F1EDE3]">
                <th className="text-left px-4 py-2">Vencimento</th>
                <th className="text-left px-4 py-2">Parcela</th>
                <th className="text-left px-4 py-2">Loja</th>
                <th className="text-right px-4 py-2">Valor</th>
              </tr>
            </thead>
            <tbody>
              {parcelasAbertas.map((p: any) => {
                const vencida = p.vencimento && new Date(p.vencimento).getTime() < Date.now() - 86400000;
                return (
                  <tr key={p.registro} className="border-b border-[#F8F5EC]">
                    <td className={`px-4 py-2 ${vencida ? 'text-red-600 font-bold' : ''}`}>{fmtData(p.vencimento)}</td>
                    <td className="px-4 py-2 text-slate-500">{p.parcela}/{p.totalParcelas}</td>
                    <td className="px-4 py-2 text-slate-500">LJ{p.loja}</td>
                    <td className="px-4 py-2 text-right tabular-nums font-semibold">{brl(Number(p.valorParcela))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div className="px-5 py-6 text-sm text-slate-400">Nenhuma parcela em aberto. ✓</div>
        )}
      </div>

      {/* Fichas por loja (limite/avaliação/pontos são POR LOJA no Giga) */}
      {fichas.map((f: any) => <FichaLoja key={`${f.loja}-${f.codigo}`} f={f} />)}
    </div>
  );
}

/* Ficha de UMA loja + todos os campos originais do Giga (rawJson dinâmico) */
function FichaLoja({ f }: { f: any }) {
  const [aberto, setAberto] = useState(false);
  const raw = f.rawJson || {};
  return (
    <div className="bg-white rounded-2xl border border-[#E7E2D8] shadow-sm overflow-hidden">
      <div className="px-5 py-3 border-b border-[#F1EDE3] flex items-center gap-3 flex-wrap">
        <h3 className="font-bold text-slate-800 flex items-center gap-2">
          <Store className="w-4 h-4 text-[#B8912B]" /> Loja {f.loja} · ficha {f.codigo}
        </h3>
        <div className="flex gap-2 text-[11px] font-bold ml-auto">
          {f.avaliacao && <span className="rounded bg-[#FBF6E6] border border-[#E6DFC8] px-2 py-0.5 text-[#8C7325]">Avaliação {f.avaliacao}</span>}
          {f.limiteCompras != null && <span className="rounded bg-emerald-50 border border-emerald-200 px-2 py-0.5 text-emerald-700">Limite {brl(Number(f.limiteCompras))}</span>}
          {f.pontos != null && Number(f.pontos) > 0 && <span className="rounded bg-violet-50 border border-violet-200 px-2 py-0.5 text-violet-700">{Number(f.pontos)} pts</span>}
          {String(f.bloqueado || '').toUpperCase() === 'SIM' && <span className="rounded bg-red-50 border border-red-300 px-2 py-0.5 text-red-700">BLOQUEADO</span>}
        </div>
      </div>
      <button
        onClick={() => setAberto(!aberto)}
        className="w-full px-5 py-2.5 text-left text-xs font-bold text-slate-500 hover:bg-slate-50 flex items-center gap-1"
      >
        {aberto ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        Todos os campos do Giga ({Object.keys(raw).length})
      </button>
      {aberto && (
        <div className="px-5 pb-4 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-x-4 gap-y-2">
          {Object.entries(raw).map(([k, v]) => (
            <div key={k} className="min-w-0">
              <div className="text-[10px] uppercase tracking-wide font-bold text-slate-400 truncate">{k}</div>
              <div className="text-xs text-slate-700 break-words">{v == null || v === '' ? '—' : String(v)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
