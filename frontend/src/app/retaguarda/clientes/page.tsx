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
  ShieldAlert, ChevronDown, ChevronUp, BadgeCheck, Store, Pencil, UserPlus, X,
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
  const [novaAberta, setNovaAberta] = useState(false);
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
      if (r?.found) {
        setFicha({ ...r, _hist: null, _resumo: null, _base: { loja, codigo } });
        // Histórico + resumo carregam em paralelo (não travam a ficha abrir)
        api<any>(`/admin/clientes-giga/historico?loja=${encodeURIComponent(loja)}&codigo=${encodeURIComponent(codigo)}`)
          .then((h) => setFicha((cur: any) => (cur ? { ...cur, _hist: h } : cur)))
          .catch(() => setFicha((cur: any) => (cur ? { ...cur, _hist: { eventos: [] } } : cur)));
        api<any>(`/admin/clientes-giga/resumo?loja=${encodeURIComponent(loja)}&codigo=${encodeURIComponent(codigo)}`)
          .then((s) => setFicha((cur: any) => (cur ? { ...cur, _resumo: s } : cur)))
          .catch(() => setFicha((cur: any) => (cur ? { ...cur, _resumo: { found: false } } : cur)));
      }
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

        {/* Nova cliente — nasce NO FLOW (código 500001+), replica pro Giga */}
        {!ficha && (
          <div className="flex justify-end">
            <button
              onClick={() => setNovaAberta(true)}
              className="rounded-lg bg-[#B8912B] hover:bg-[#8C7325] text-white text-sm font-bold px-4 py-2 flex items-center gap-1.5"
            >
              <UserPlus className="w-4 h-4" /> Nova cliente
            </button>
          </div>
        )}
        {novaAberta && (
          <ClienteForm
            modo="nova"
            onClose={() => setNovaAberta(false)}
            onSaved={(loja, codigo) => { setNovaAberta(false); abrirFicha(loja, codigo); }}
          />
        )}

        {/* FICHA DA PESSOA */}
        {ficha ? (
          <FichaPessoa ficha={ficha} onVoltar={() => setFicha(null)} onReload={abrirFicha} />
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

/** Data do Giga: ISO 'YYYY-MM-DD'; 1899-11-30 é o "nulo" do Wincred. */
const gigaData = (v: any): string | null => {
  const s = String(v || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || s.startsWith('1899')) return null;
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y}`;
};

function FichaPessoa({ ficha, onVoltar, onReload }: { ficha: any; onVoltar: () => void; onReload: (loja: string, codigo: string) => void }) {
  const { pessoa, fichas, customer, parcelasAbertas, parcelasPagas, totalAbertoReais, totalPagoReais } = ficha;
  const bloqueada = fichas.some((f: any) => String(f.bloqueado || '').toUpperCase() === 'SIM');
  const [editando, setEditando] = useState<any | null>(null);
  const [verPagas, setVerPagas] = useState(false);

  // CONSOLIDA entre as fichas: primeiro valor não-vazio do campo (nomes REAIS
  // do Giga, ex. ENDERECORES). Ficha duplicada/incompleta não deixa "—" na tela.
  const cons = (key: string): string | null => {
    for (const f of fichas) {
      const v = f?.rawJson?.[key];
      if (v != null && String(v).trim() !== '' && String(v) !== '0') return String(v).trim();
    }
    return null;
  };
  const consData = (key: string) => gigaData(cons(key));
  const consMoney = (key: string) => {
    const v = cons(key);
    return v != null && isFinite(Number(v)) ? brl(Number(v)) : null;
  };

  const Campo = ({ label, valor }: { label: string; valor: any }) => (
    <div>
      <div className="text-[10px] uppercase tracking-wide font-bold text-slate-400">{label}</div>
      <div className="text-sm text-slate-800">{valor == null || valor === '' ? '—' : String(valor)}</div>
    </div>
  );

  /** Card de seção que só mostra campos COM valor (e some se tudo vazio). */
  const Secao = ({ titulo, icone, campos }: { titulo: string; icone: React.ReactNode; campos: Array<[string, any]> }) => {
    const cheios = campos.filter(([, v]) => v != null && v !== '');
    if (!cheios.length) return null;
    return (
      <div className="bg-white rounded-2xl border border-[#E7E2D8] shadow-sm p-5">
        <h3 className="font-bold text-slate-800 flex items-center gap-2 mb-3">{icone} {titulo}</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-3">
          {cheios.map(([label, v]) => <Campo key={label} label={label} valor={v} />)}
        </div>
      </div>
    );
  };

  const enderecoRes = [cons('ENDERECORES'), cons('NUMERORES'), cons('COMPRES'), cons('BAIRRORES'), cons('CIDADERES'), cons('UFRES'), cons('CEPRES')]
    .filter(Boolean).join(', ') || null;

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
          <Campo label="Nascimento" valor={consData('NASCIMENTO')} />
          <Campo label="RG" valor={[cons('RG'), cons('RGEXP')].filter(Boolean).join(' · ')} />
          <Campo label="Celular" valor={cons('FONECEL')} />
          <Campo label="Fone res / recado" valor={[cons('FONERES'), cons('FONEREC')].filter(Boolean).join(' · ')} />
          <Campo label="Falar com" valor={cons('NOMEREC')} />
          <Campo label="Email" valor={cons('EMAIL') || customer?.email} />
          <Campo label="Estado civil" valor={cons('ESTADOCIVIL')} />
          <Campo label="Naturalidade" valor={cons('NATURALIDADE')} />
        </div>
        <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
          <Campo label="Endereço" valor={enderecoRes} />
          <Campo label="Observação" valor={cons('OBS')} />
        </div>
      </div>

      {/* RESUMO DA CLIENTE — crediário, marcados AO VIVO, limite, cashback */}
      <ResumoCard resumo={ficha._resumo} base={ficha._base} onReload={() => onReload(ficha._base.loja, ficha._base.codigo)} />

      {/* Seções com os campos REAIS do Giga (só aparecem se têm conteúdo) */}
      <Secao
        titulo="Família"
        icone={<Users className="w-4 h-4 text-[#B8912B]" />}
        campos={[
          ['Cônjuge', [cons('CONJUGE'), cons('CONJUGERG') && `RG ${cons('CONJUGERG')}`, cons('CONJUGECPF') && `CPF ${fmtCpf(cons('CONJUGECPF'))}`].filter(Boolean).join(' · ') || null],
          ['Pai', cons('PAI')],
          ['Mãe', cons('MAE')],
        ]}
      />
      <Secao
        titulo="Trabalho"
        icone={<Store className="w-4 h-4 text-[#B8912B]" />}
        campos={[
          ['Local de trabalho', cons('TRABALHORAZAOSOC')],
          ['Endereço', [cons('TRABALHOENDERECO'), cons('TRABALHOCOMP'), cons('TRABALHOBAIRRO'), cons('TRABALHOCIDADE'), cons('TRABALHOUF'), cons('TRABALHOCEP')].filter(Boolean).join(', ') || null],
          ['Fone', cons('TRABALHOFONE')],
          ['Função', cons('TRABALHOCARGO')],
          ['Admissão', consData('TRABALHOADM')],
          ['Salário', consMoney('TRABALHOSALARIO')],
        ]}
      />
      <Secao
        titulo="Crédito & SPC"
        icone={<ShieldAlert className="w-4 h-4 text-[#B8912B]" />}
        campos={[
          ['Abertura do crédito', consData('DATACREDITO')],
          ['Consulta nº', cons('SPCCONSULTA')],
          ['Data consulta', consData('SPCDATA')],
          ['Situação', cons('SPCSITUACAO')],
          ['Obs SPC', cons('SPCOBS')],
          ['Negativado', cons('NEGATIVADO')],
          ['Justiça', cons('JUSTICA')],
          ['1ª compra', consData('PRICOMPRA')],
          ['Última compra', consData('ULTCOMPRA')],
        ]}
      />
      <Secao
        titulo="Cartão Lurd's"
        icone={<CreditCard className="w-4 h-4 text-[#B8912B]" />}
        campos={[
          ['Nº cartão', cons('COD_CARD')],
          ['Emitido', cons('EMITIDO')],
          ['Fidelidade', cons('FIDELIDADE')],
          ['Autorizado 1', [cons('AUTORIZADO1'), cons('AUTORIZADO1RG') && `RG ${cons('AUTORIZADO1RG')}`, cons('AUTORIZADO1CPF') && `CPF ${fmtCpf(cons('AUTORIZADO1CPF'))}`].filter(Boolean).join(' · ') || null],
          ['Autorizado 2', [cons('AUTORIZADO2'), cons('AUTORIZADO2RG') && `RG ${cons('AUTORIZADO2RG')}`, cons('AUTORIZADO2CPF') && `CPF ${fmtCpf(cons('AUTORIZADO2CPF'))}`].filter(Boolean).join(' · ') || null],
        ]}
      />
      <Secao
        titulo="Referências"
        icone={<Phone className="w-4 h-4 text-[#B8912B]" />}
        campos={[
          ['Comercial 1', [cons('REFCOM1'), cons('FONEREFCOM1')].filter(Boolean).join(' · ') || null],
          ['Comercial 2', [cons('REFCOM2'), cons('FONEREFCOM2')].filter(Boolean).join(' · ') || null],
          ['Pessoal 1', [cons('REFPESSOAL1'), cons('FONEREFPESSOAL1')].filter(Boolean).join(' · ') || null],
          ['Pessoal 2', [cons('REFPESSOAL2'), cons('FONEREFPESSOAL2')].filter(Boolean).join(' · ') || null],
        ]}
      />

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

        {/* HISTÓRICO do crediário (parcelas PAGAS — do ledger nativo) */}
        {parcelasPagas?.length > 0 && (
          <>
            <button
              onClick={() => setVerPagas(!verPagas)}
              className="w-full px-5 py-2.5 text-left text-xs font-bold text-slate-500 hover:bg-slate-50 flex items-center gap-1 border-t border-[#F1EDE3]"
            >
              {verPagas ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              Parcelas pagas ({parcelasPagas.length}{totalPagoReais ? ` · ${brl(totalPagoReais)}` : ''})
            </button>
            {verPagas && (
              <table className="w-full text-sm">
                <tbody>
                  {parcelasPagas.map((p: any) => (
                    <tr key={p.registro} className="border-b border-[#F8F5EC]">
                      <td className="px-5 py-1.5 text-xs text-slate-500 whitespace-nowrap">pago {fmtData(p.dataPagamento)}</td>
                      <td className="px-2 py-1.5 text-xs text-slate-400">{p.parcela}/{p.totalParcelas}</td>
                      <td className="px-2 py-1.5 text-xs text-slate-400">LJ{p.loja}</td>
                      <td className="px-2 py-1.5 text-xs text-slate-400">venc. {fmtData(p.vencimento)}</td>
                      <td className="px-5 py-1.5 text-right tabular-nums text-emerald-700 font-semibold">
                        {brl(Number(p.valorPago ?? p.valorParcela) || 0)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </div>

      {/* HISTÓRICO COMPLETO — lojas + PDV + site + live + devoluções */}
      <HistoricoCard hist={ficha._hist} />

      {/* Fichas por loja (limite/avaliação/pontos são POR LOJA no Giga) */}
      {fichas.map((f: any) => (
        <FichaLoja key={`${f.loja}-${f.codigo}`} f={f} onEditar={() => setEditando(f)} />
      ))}

      {editando && (
        <ClienteForm
          modo="editar"
          fichaAtual={editando}
          onClose={() => setEditando(null)}
          onSaved={() => { setEditando(null); onReload(editando.loja, editando.codigo); }}
        />
      )}
    </div>
  );
}

/* ─── Formulário compartilhado (editar ficha / nova cliente) ─────────────────
   Grava NO FLOW (fonte da verdade; flowIsSource) e replica pro Giga via
   outbox. Campos com os NOMES REAIS do Giga. */
type FormMask = 'cpf' | 'fone' | 'cep' | 'rg';
const FORM_CAMPOS: Array<{ key: string; label: string; tipo?: 'date' | 'select-sn'; largo?: boolean; mask?: FormMask; lower?: boolean }> = [
  { key: 'NOME', label: 'Nome completo', largo: true },
  { key: 'CPF', label: 'CPF', mask: 'cpf' },
  { key: 'NASCIMENTO', label: 'Nascimento', tipo: 'date' },
  { key: 'RG', label: 'RG', mask: 'rg' },
  { key: 'ESTADOCIVIL', label: 'Estado civil' },
  { key: 'FONECEL', label: 'Celular', mask: 'fone' },
  { key: 'FONERES', label: 'Fone residencial', mask: 'fone' },
  { key: 'FONEREC', label: 'Fone recado', mask: 'fone' },
  { key: 'NOMEREC', label: 'Falar com' },
  { key: 'EMAIL', label: 'Email', largo: true, lower: true },
  { key: 'ENDERECORES', label: 'Endereço', largo: true },
  { key: 'NUMERORES', label: 'Número' },
  { key: 'COMPRES', label: 'Complemento' },
  { key: 'BAIRRORES', label: 'Bairro' },
  { key: 'CIDADERES', label: 'Cidade' },
  { key: 'UFRES', label: 'UF' },
  { key: 'CEPRES', label: 'CEP', mask: 'cep' },
  { key: 'PAI', label: 'Pai', largo: true },
  { key: 'MAE', label: 'Mãe', largo: true },
  { key: 'CONJUGE', label: 'Cônjuge', largo: true },
  { key: 'TRABALHORAZAOSOC', label: 'Local de trabalho', largo: true },
  { key: 'TRABALHOCARGO', label: 'Função' },
  { key: 'TRABALHOSALARIO', label: 'Salário (R$)' },
  { key: 'AVALIACAO', label: 'Avaliação (A/B/C…)' },
  { key: 'LIMITECOMPRAS', label: 'Limite compras (R$)' },
  { key: 'BLOQUEADO', label: 'Bloqueado', tipo: 'select-sn' },
  { key: 'OBS', label: 'Observação', largo: true },
];

/* Máscaras progressivas (exibição). Ao SALVAR, CPF/fone/CEP vão só DÍGITOS —
   mantém a busca por "contém dígitos" funcionando e o personKey batendo. */
const soDigitos = (s: string) => String(s || '').replace(/\D/g, '');
const maskCpf = (s: string) => {
  const d = soDigitos(s).slice(0, 11);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `${d.slice(0, 3)}.${d.slice(3)}`;
  if (d.length <= 9) return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6)}`;
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
};
const maskFone = (s: string) => {
  const d = soDigitos(s).slice(0, 11);
  if (d.length <= 2) return d.length ? `(${d}` : '';
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
};
const maskCep = (s: string) => {
  const d = soDigitos(s).slice(0, 8);
  return d.length <= 5 ? d : `${d.slice(0, 5)}-${d.slice(5)}`;
};
const maskRg = (s: string) => {
  const d = soDigitos(s).slice(0, 9);
  if (d.length <= 2) return d;
  if (d.length <= 5) return `${d.slice(0, 2)}.${d.slice(2)}`;
  if (d.length <= 8) return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5)}`;
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}-${d.slice(8)}`;
};
const aplicarMask = (mask: FormMask | undefined, v: string) =>
  mask === 'cpf' ? maskCpf(v) : mask === 'fone' ? maskFone(v) : mask === 'cep' ? maskCep(v) : mask === 'rg' ? maskRg(v) : v;

function ClienteForm({
  modo, fichaAtual, onClose, onSaved,
}: {
  modo: 'editar' | 'nova';
  fichaAtual?: any;
  onClose: () => void;
  onSaved: (loja: string, codigo: string) => void;
}) {
  const raw = fichaAtual?.rawJson || {};
  // Regra de digitação (dono 21/07): MAIÚSCULA em tudo, minúscula no email,
  // máscara em CPF/RG/fones/CEP (exibição — salva só dígitos).
  const tratar = (c: (typeof FORM_CAMPOS)[number], v: string): string => {
    if (c.tipo === 'date') return v;
    if (c.lower) return v.toLowerCase();
    if (c.mask) return aplicarMask(c.mask, v);
    return v.toUpperCase();
  };
  const [campos, setCampos] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const c of FORM_CAMPOS) {
      const v = raw[c.key];
      init[c.key] = v == null ? '' : tratar(c, c.tipo === 'date' ? String(v).slice(0, 10) : String(v));
    }
    return init;
  });
  const [loja, setLoja] = useState<string>(fichaAtual?.loja || '');
  const [lojas, setLojas] = useState<Array<{ code: string; name: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (modo === 'nova') api<Array<{ code: string; name: string }>>('/stores').then(setLojas).catch(() => {});
  }, [modo]);

  const salvar = async () => {
    setErr(null);
    if (!campos.NOME?.trim()) { setErr('Nome é obrigatório'); return; }
    if (modo === 'nova' && !loja) { setErr('Escolha a loja da ficha'); return; }
    setBusy(true);
    try {
      // Salva CPF/RG/fones/CEP só com DÍGITOS (máscara é exibição) — mantém a
      // busca por dígitos e o personKey batendo.
      const paraEnviar: Record<string, string> = {};
      for (const c of FORM_CAMPOS) {
        const v = campos[c.key] ?? '';
        paraEnviar[c.key] = c.mask ? soDigitos(v) : v;
      }
      if (modo === 'editar') {
        const r = await api<any>('/admin/clientes-giga/ficha/editar', {
          method: 'POST',
          body: JSON.stringify({ loja: fichaAtual.loja, codigo: fichaAtual.codigo, campos: paraEnviar }),
        });
        if (!r?.ok) throw new Error(r?.erro || 'Falha ao salvar');
        onSaved(fichaAtual.loja, fichaAtual.codigo);
      } else {
        const r = await api<any>('/admin/clientes-giga/cadastro', {
          method: 'POST',
          body: JSON.stringify({ loja, campos: paraEnviar }),
        });
        if (!r?.ok) throw new Error(r?.erro || 'Falha ao cadastrar');
        onSaved(r.loja, r.codigo);
      }
    } catch (e: any) {
      setErr(e?.message || 'Erro ao salvar');
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-10 overflow-y-auto">
      <div className="w-full max-w-3xl rounded-2xl bg-[#FAFAF7] shadow-2xl border border-[#E6DFC8] overflow-hidden mb-10">
        <div className="flex items-center justify-between px-5 py-3 bg-white border-b border-[#E6DFC8]">
          <h3 className="font-bold text-slate-800 flex items-center gap-2">
            {modo === 'editar'
              ? <><Pencil className="w-4 h-4 text-[#B8912B]" /> Editar ficha — Loja {fichaAtual?.loja} · {fichaAtual?.codigo}</>
              : <><UserPlus className="w-4 h-4 text-[#B8912B]" /> Nova cliente</>}
          </h3>
          <button onClick={onClose} className="p-2 rounded-lg text-slate-500 hover:bg-slate-100"><X className="w-5 h-5" /></button>
        </div>

        <div className="p-5 space-y-3">
          {modo === 'nova' && (
            <div>
              <label className="text-[11px] uppercase tracking-wide font-bold text-slate-400">Loja da ficha</label>
              <select value={loja} onChange={(e) => setLoja(e.target.value)}
                className="mt-0.5 w-full rounded-lg border border-[#E7E2D8] bg-white px-3 py-2 text-sm focus:border-[#D4AF37] focus:outline-none">
                <option value="">Selecione…</option>
                {lojas.map((l) => <option key={l.code} value={l.code}>{l.code} · {l.name}</option>)}
              </select>
            </div>
          )}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {FORM_CAMPOS.map((c) => (
              <div key={c.key} className={c.largo ? 'col-span-2 md:col-span-3' : ''}>
                <label className="text-[11px] uppercase tracking-wide font-bold text-slate-400">{c.label}</label>
                {c.tipo === 'select-sn' ? (
                  <select
                    value={campos[c.key] || ''}
                    onChange={(e) => setCampos((p) => ({ ...p, [c.key]: e.target.value }))}
                    className="mt-0.5 w-full rounded-lg border border-[#E7E2D8] bg-white px-3 py-2 text-sm focus:border-[#D4AF37] focus:outline-none"
                  >
                    <option value="">—</option>
                    <option value="NAO">NÃO</option>
                    <option value="SIM">SIM</option>
                  </select>
                ) : (
                  <input
                    type={c.tipo === 'date' ? 'date' : 'text'}
                    inputMode={c.mask ? 'numeric' : undefined}
                    value={campos[c.key] || ''}
                    onChange={(e) => { const v = tratar(c, e.target.value); setCampos((p) => ({ ...p, [c.key]: v })); }}
                    className="mt-0.5 w-full rounded-lg border border-[#E7E2D8] bg-white px-3 py-2 text-sm focus:border-[#D4AF37] focus:outline-none"
                  />
                )}
              </div>
            ))}
          </div>
          {err && <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">{err}</div>}
          <div className="flex justify-end gap-2 pt-1">
            <button onClick={onClose} disabled={busy}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-bold text-slate-600 hover:bg-slate-50 disabled:opacity-50">
              Cancelar
            </button>
            <button onClick={salvar} disabled={busy}
              className="rounded-lg bg-[#2E7D46] hover:bg-[#256a3a] text-white px-5 py-2 text-sm font-bold flex items-center gap-2 disabled:opacity-50">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              {modo === 'editar' ? 'Salvar alterações' : 'Cadastrar cliente'}
            </button>
          </div>
          <p className="text-[10px] text-slate-400">
            Grava no Flow (fonte da verdade) e replica pro Giga automaticamente em segundos.
          </p>
        </div>
      </div>
    </div>
  );
}

/* ─── RESUMO DA CLIENTE (painel do topo — pedido do dono 21/07) ────────────
   Crediário em aberto · MARCADOS pra fechar (AO VIVO no Giga: fechou → sai
   da lista) · limite disponível (edição com SENHA gerente) · cashback ·
   pode marcar pra experimentar. */
function ResumoCard({ resumo, base, onReload }: { resumo: any; base: { loja: string; codigo: string }; onReload: () => void }) {
  const [verMarcados, setVerMarcados] = useState(false);
  const [editRestrito, setEditRestrito] = useState(false);

  if (!resumo) {
    return (
      <div className="bg-white rounded-2xl border border-[#E7E2D8] shadow-sm px-5 py-4 text-sm text-slate-400 flex items-center gap-2">
        <Loader2 className="w-4 h-4 animate-spin" /> Carregando resumo…
      </div>
    );
  }
  if (!resumo.found) return null;

  const Tile = ({ label, valor, sub, tom, onClick }: { label: string; valor: React.ReactNode; sub?: React.ReactNode; tom: string; onClick?: () => void }) => (
    <button
      onClick={onClick}
      disabled={!onClick}
      className={`text-left rounded-xl border-2 p-3 ${tom} ${onClick ? 'hover:shadow-md transition cursor-pointer' : 'cursor-default'}`}
    >
      <div className="text-[10px] uppercase tracking-wide font-bold opacity-70">{label}</div>
      <div className="text-lg font-black leading-tight">{valor}</div>
      {sub && <div className="text-[11px] mt-0.5 opacity-80">{sub}</div>}
    </button>
  );

  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Tile
          label="Crediário em aberto"
          valor={brl(resumo.crediarioAbertoReais)}
          sub={resumo.crediarioVencidas > 0 ? `${resumo.crediarioVencidas} vencida(s)` : 'em dia'}
          tom={resumo.crediarioAbertoReais > 0 ? (resumo.crediarioVencidas > 0 ? 'bg-red-50 border-red-300 text-red-800' : 'bg-amber-50 border-amber-300 text-amber-800') : 'bg-emerald-50 border-emerald-300 text-emerald-800'}
        />
        <Tile
          label="Marcados pra fechar"
          valor={resumo.marcados ? brl(resumo.marcados.totalReais) : '—'}
          sub={resumo.marcados ? `${resumo.marcados.itens.length} peça(s) · clique pra ver` : '⚠ Giga fora — sem conferência'}
          tom={resumo.marcados && resumo.marcados.totalReais > 0 ? 'bg-violet-50 border-violet-300 text-violet-800' : 'bg-white border-[#E7E2D8] text-slate-600'}
          onClick={resumo.marcados?.itens?.length ? () => setVerMarcados(!verMarcados) : undefined}
        />
        <Tile
          label="Limite disponível"
          valor={brl(resumo.limiteDisponivel)}
          sub={<>de {brl(resumo.limiteTotal)} · <span className="underline decoration-dotted">✎ editar (senha)</span></>}
          tom="bg-[#FBF6E6] border-[#D4AF37] text-[#8C7325]"
          onClick={() => setEditRestrito(true)}
        />
        <Tile
          label="Cashback"
          valor={resumo.cashbackCents != null ? brl(resumo.cashbackCents / 100) : '—'}
          sub="da pessoa, vale em qualquer loja"
          tom="bg-emerald-50 border-emerald-300 text-emerald-800"
        />
        <Tile
          label="Pode marcar?"
          valor={resumo.podeMarcar ? 'SIM ✓' : 'NÃO'}
          sub={resumo.motivoMarcar || `Avaliação ${resumo.avaliacao || '—'}`}
          tom={resumo.podeMarcar ? 'bg-emerald-50 border-emerald-300 text-emerald-800' : 'bg-red-50 border-red-300 text-red-800'}
          onClick={() => setEditRestrito(true)}
        />
      </div>

      {/* Itens marcados (o que está na casa da cliente pra fechar) */}
      {verMarcados && resumo.marcados?.itens?.length > 0 && (
        <div className="bg-white rounded-2xl border border-violet-200 shadow-sm overflow-hidden">
          <div className="px-5 py-2.5 border-b border-violet-100 bg-violet-50/50 text-sm font-bold text-violet-800">
            🏷️ Peças marcadas em aberto (ao vivo no Giga — se fechou, não aparece aqui)
          </div>
          <table className="w-full text-sm">
            <tbody>
              {resumo.marcados.itens.map((m: any) => (
                <tr key={m.REGISTRO} className="border-b border-[#F8F5EC]">
                  <td className="px-5 py-2 text-xs text-slate-500 whitespace-nowrap">{gigaData(m.DATA) || '—'}</td>
                  <td className="px-2 py-2 text-xs text-slate-500">LJ{m.LOJA}</td>
                  <td className="px-2 py-2">{String(m.DESCRICAO || '').slice(0, 60)}</td>
                  <td className="px-2 py-2 text-xs text-slate-500 text-center">{Number(m.QUANTIDADE) || 1}x</td>
                  <td className="px-5 py-2 text-right tabular-nums font-semibold">{brl(Number(m.VALORTOTAL) || 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editRestrito && (
        <RestritoModal
          base={base}
          atual={{ limite: resumo.limiteTotal, avaliacao: resumo.avaliacao, bloqueado: resumo.bloqueado }}
          onClose={() => setEditRestrito(false)}
          onSaved={() => { setEditRestrito(false); onReload(); }}
        />
      )}
    </>
  );
}

/* Edição SENSÍVEL (limite / avaliação / bloqueado) — exige senha GERENTE+ */
function RestritoModal({
  base, atual, onClose, onSaved,
}: {
  base: { loja: string; codigo: string };
  atual: { limite: number; avaliacao: string | null; bloqueado: boolean };
  onClose: () => void;
  onSaved: () => void;
}) {
  const [limite, setLimite] = useState(String(atual.limite || ''));
  const [avaliacao, setAvaliacao] = useState(atual.avaliacao || '');
  const [bloqueado, setBloqueado] = useState(atual.bloqueado ? 'SIM' : 'NAO');
  const [senha, setSenha] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const salvar = async () => {
    setErr(null);
    if (!senha.trim()) { setErr('Informe a senha (GERENTE ou acima)'); return; }
    setBusy(true);
    try {
      const r = await api<any>('/admin/clientes-giga/ficha/restrito', {
        method: 'POST',
        body: JSON.stringify({
          loja: base.loja, codigo: base.codigo, password: senha.trim(),
          campos: {
            LIMITECOMPRAS: limite.replace(',', '.'),
            AVALIACAO: avaliacao.toUpperCase(),
            BLOQUEADO: bloqueado,
          },
        }),
      });
      if (!r?.ok) throw new Error(r?.erro || 'Falha ao salvar');
      onSaved();
    } catch (e: any) {
      const raw = String(e?.message || '');
      setErr(/403/.test(raw) ? 'Senha inválida ou nível insuficiente (precisa GERENTE+)' : raw || 'Erro');
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-sm rounded-2xl bg-white shadow-2xl border border-[#E6DFC8] p-5 space-y-3">
        <h3 className="font-bold text-slate-800">🔒 Limite / marcação — Loja {base.loja} · {base.codigo}</h3>
        <div>
          <label className="text-[11px] uppercase font-bold text-slate-400">Limite de compras (R$)</label>
          <input value={limite} onChange={(e) => setLimite(e.target.value)} inputMode="decimal"
            className="mt-0.5 w-full rounded-lg border border-[#E7E2D8] px-3 py-2 text-sm focus:border-[#D4AF37] focus:outline-none" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[11px] uppercase font-bold text-slate-400">Avaliação (A = pode marcar)</label>
            <input value={avaliacao} onChange={(e) => setAvaliacao(e.target.value)} maxLength={2}
              className="mt-0.5 w-full rounded-lg border border-[#E7E2D8] px-3 py-2 text-sm uppercase focus:border-[#D4AF37] focus:outline-none" />
          </div>
          <div>
            <label className="text-[11px] uppercase font-bold text-slate-400">Bloqueado</label>
            <select value={bloqueado} onChange={(e) => setBloqueado(e.target.value)}
              className="mt-0.5 w-full rounded-lg border border-[#E7E2D8] px-3 py-2 text-sm focus:border-[#D4AF37] focus:outline-none">
              <option value="NAO">NÃO</option>
              <option value="SIM">SIM</option>
            </select>
          </div>
        </div>
        <div>
          <label className="text-[11px] uppercase font-bold text-slate-400">Senha / PIN (GERENTE ou acima)</label>
          <input type="password" value={senha} onChange={(e) => setSenha(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !busy) salvar(); }}
            className="mt-0.5 w-full rounded-lg border-2 border-amber-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none" />
        </div>
        {err && <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700">{err}</div>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-bold text-slate-600 hover:bg-slate-50 disabled:opacity-50">Cancelar</button>
          <button onClick={salvar} disabled={busy} className="rounded-lg bg-[#B8912B] hover:bg-[#8C7325] text-white px-4 py-2 text-sm font-bold flex items-center gap-1.5 disabled:opacity-50">
            {busy && <Loader2 className="w-4 h-4 animate-spin" />} Autorizar e salvar
          </button>
        </div>
        <p className="text-[10px] text-slate-400">Fica registrado quem autorizou. Replica pro Giga automaticamente.</p>
      </div>
    </div>
  );
}

/* ─── Histórico completo (integração: lojas + PDV + site + live) ──────────── */
const ORIGEM_STYLE: Record<string, { label: string; cls: string }> = {
  LOJA: { label: 'Loja', cls: 'bg-[#FBF6E6] border-[#E6DFC8] text-[#8C7325]' },
  MARCADO: { label: 'Marcado', cls: 'bg-amber-50 border-amber-300 text-amber-700' },
  PDV: { label: 'PDV', cls: 'bg-blue-50 border-blue-200 text-blue-700' },
  SITE: { label: 'Site', cls: 'bg-indigo-50 border-indigo-200 text-indigo-700' },
  LIVE: { label: 'Live', cls: 'bg-rose-50 border-rose-200 text-rose-700' },
  DEVOLUCAO: { label: 'Devolução', cls: 'bg-red-50 border-red-300 text-red-700' },
};

function HistoricoCard({ hist }: { hist: any }) {
  const [filtro, setFiltro] = useState<string>('');
  const eventos: any[] = hist?.eventos || [];
  const porOrigem: Record<string, { qtd: number; total: number }> = hist?.porOrigem || {};
  const visiveis = filtro ? eventos.filter((e) => e.origem === filtro) : eventos;
  const totalGeral = eventos.filter((e) => e.origem !== 'DEVOLUCAO').reduce((s, e) => s + (Number(e.valor) || 0), 0);

  return (
    <div className="bg-white rounded-2xl border border-[#E7E2D8] shadow-sm overflow-hidden">
      <div className="px-5 py-3 border-b border-[#F1EDE3] flex items-center justify-between gap-2 flex-wrap">
        <h3 className="font-bold text-slate-800 flex items-center gap-2">
          <Search className="w-4 h-4 text-[#B8912B]" /> Histórico completo
          {hist && <span className="text-xs font-normal text-slate-400">({eventos.length} registro{eventos.length !== 1 ? 's' : ''})</span>}
        </h3>
        {hist && eventos.length > 0 && (
          <span className="text-sm font-black text-[#2E7D46]">{brl(Math.round(totalGeral * 100) / 100)} em compras</span>
        )}
      </div>

      {!hist ? (
        <div className="px-5 py-6 text-sm text-slate-400 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Carregando histórico…</div>
      ) : eventos.length === 0 ? (
        <div className="px-5 py-6 text-sm text-slate-400">Nenhuma compra encontrada (lojas desde 2025 · PDV/site/live completos).</div>
      ) : (
        <>
          {/* Filtros por origem */}
          <div className="px-5 py-2.5 flex gap-1.5 flex-wrap border-b border-[#F8F5EC]">
            <button
              onClick={() => setFiltro('')}
              className={`rounded-full border px-2.5 py-1 text-[11px] font-bold ${!filtro ? 'bg-slate-800 text-white border-slate-800' : 'bg-white border-slate-200 text-slate-500'}`}
            >
              Todas ({eventos.length})
            </button>
            {Object.entries(porOrigem).map(([o, s]) => (
              <button
                key={o}
                onClick={() => setFiltro(filtro === o ? '' : o)}
                className={`rounded-full border px-2.5 py-1 text-[11px] font-bold ${filtro === o ? 'bg-slate-800 text-white border-slate-800' : ORIGEM_STYLE[o]?.cls || 'bg-white border-slate-200 text-slate-500'}`}
              >
                {ORIGEM_STYLE[o]?.label || o} ({s.qtd})
              </button>
            ))}
          </div>
          <div className="max-h-96 overflow-y-auto">
            <table className="w-full text-sm">
              <tbody>
                {visiveis.map((e, i) => (
                  <tr key={i} className="border-b border-[#F8F5EC]">
                    <td className="px-5 py-2 whitespace-nowrap text-xs text-slate-500">{fmtData(e.data)}</td>
                    <td className="px-2 py-2">
                      <span className={`rounded border px-1.5 py-0.5 text-[10px] font-bold ${ORIGEM_STYLE[e.origem]?.cls || ''}`}>
                        {ORIGEM_STYLE[e.origem]?.label || e.origem}
                      </span>
                    </td>
                    <td className="px-2 py-2 text-xs text-slate-500 whitespace-nowrap">{e.loja ? `LJ${e.loja}` : '—'}</td>
                    <td className="px-2 py-2 min-w-0">
                      <div className="text-slate-800 truncate max-w-[280px]">{e.titulo}</div>
                      {e.detalhe && <div className="text-[11px] text-slate-400 truncate max-w-[280px]">{e.detalhe}</div>}
                    </td>
                    <td className={`px-5 py-2 text-right tabular-nums font-semibold whitespace-nowrap ${e.valor < 0 ? 'text-red-600' : 'text-slate-800'}`}>
                      {brl(e.valor)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

/* Ficha de UMA loja + todos os campos originais do Giga (rawJson dinâmico) */
function FichaLoja({ f, onEditar }: { f: any; onEditar: () => void }) {
  const [aberto, setAberto] = useState(false);
  const raw = f.rawJson || {};
  return (
    <div className="bg-white rounded-2xl border border-[#E7E2D8] shadow-sm overflow-hidden">
      <div className="px-5 py-3 border-b border-[#F1EDE3] flex items-center gap-3 flex-wrap">
        <h3 className="font-bold text-slate-800 flex items-center gap-2">
          <Store className="w-4 h-4 text-[#B8912B]" /> Loja {f.loja} · ficha {f.codigo}
          {f.flowIsSource && (
            <span title={`Editada no Flow${f.editedBy ? ` por ${f.editedBy}` : ''} — fonte da verdade`} className="rounded bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 text-[9px] font-bold text-emerald-700">FLOW</span>
          )}
        </h3>
        <button
          onClick={onEditar}
          className="rounded-lg border border-[#B8912B] px-2.5 py-1 text-[11px] font-bold text-[#8C7325] hover:bg-[#FBF6E6] flex items-center gap-1"
        >
          <Pencil className="w-3 h-3" /> Editar
        </button>
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
