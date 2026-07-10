'use client';

/**
 * /retaguarda/rh/operadores — FASE A do portal de RH.
 *
 * A gerente cadastra FUNÇÃO + PIN pessoal de liberação de cada funcionária.
 * O PIN (6 dígitos, por CPF) passa a valer em TODOS os pontos de liberação do
 * PDV (desconto, sangria, devolução) e — na próxima fase — grava QUEM autorizou.
 *
 * Escopo: loja vê só as suas (o backend filtra pelo JWT). Loja não concede
 * MASTER/SUPREMA (só a matriz). A tela nunca mostra o PIN — só se tem ou não.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { ArrowLeft, UserPlus, KeyRound, Check, AlertCircle, Power } from 'lucide-react';

type Nivel = 'CAIXA' | 'SUPERVISOR' | 'GERENTE' | 'MASTER' | 'SUPREMA';

interface Operador {
  cpf: string;
  nome: string;
  nivel: Nivel;
  ativo: boolean;
  storeCode: string | null;
  temPin: boolean;
}

const NIVEL_LABEL: Record<Nivel, string> = {
  CAIXA: 'Caixa',
  SUPERVISOR: 'Supervisor',
  GERENTE: 'Gerente',
  MASTER: 'Master (matriz)',
  SUPREMA: 'Suprema (dono)',
};

function maskCpf(v: string) {
  const d = v.replace(/\D/g, '').slice(0, 11);
  return d.replace(/^(\d{3})(\d)/, '$1.$2').replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3').replace(/\.(\d{3})(\d{1,2})$/, '.$1-$2');
}
function maskCpfShow(cpf: string) {
  const d = cpf.replace(/\D/g, '');
  return d.length === 11 ? `•••.${d.slice(3, 6)}.•••-${d.slice(9)}` : cpf;
}

export default function OperadoresPage() {
  const [lista, setLista] = useState<Operador[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Form
  const [nome, setNome] = useState('');
  const [cpf, setCpf] = useState('');
  const [nivel, setNivel] = useState<Nivel>('CAIXA');
  const [pin, setPin] = useState('');
  const [editando, setEditando] = useState(false);

  const load = async () => {
    setLoading(true); setErr(null);
    try {
      setLista(await api<Operador[]>('/rh/operadores'));
    } catch (e: any) { setErr('Falha ao carregar. Recarregue a página.'); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  function limpar() {
    setNome(''); setCpf(''); setNivel('CAIXA'); setPin(''); setEditando(false);
  }
  function editar(o: Operador) {
    setNome(o.nome); setCpf(maskCpf(o.cpf)); setNivel(o.nivel); setPin(''); setEditando(true);
    setOkMsg(null); setErr(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function salvar(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true); setErr(null); setOkMsg(null);
    try {
      await api('/rh/operadores', {
        method: 'POST',
        body: JSON.stringify({ nome, cpf: cpf.replace(/\D/g, ''), nivel, pin: pin.replace(/\D/g, '') || undefined }),
      });
      setOkMsg(`${nome.split(' ')[0]} salva! 💜`);
      limpar();
      await load();
    } catch (e: any) {
      setErr(parseErr(e));
    } finally { setSaving(false); }
  }

  async function redefinirPin(o: Operador) {
    const novo = prompt(`Novo PIN de 6 dígitos para ${o.nome}:`);
    if (!novo) return;
    try {
      await api(`/rh/operadores/${o.cpf}/pin`, { method: 'POST', body: JSON.stringify({ pin: novo.replace(/\D/g, '') }) });
      setOkMsg(`PIN de ${o.nome.split(' ')[0]} redefinido.`);
    } catch (e: any) { setErr(parseErr(e)); }
  }

  async function toggleAtivo(o: Operador) {
    try {
      await api(`/rh/operadores/${o.cpf}/ativo`, { method: 'POST', body: JSON.stringify({ ativo: !o.ativo }) });
      await load();
    } catch (e: any) { setErr(parseErr(e)); }
  }

  const cpfOk = cpf.replace(/\D/g, '').length === 11;
  const pinOk = pin === '' ? editando : pin.replace(/\D/g, '').length === 6;
  const podeSalvar = nome.trim().length >= 3 && cpfOk && pinOk && !saving;

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6">
      <div className="max-w-2xl mx-auto">
        <Link href="/retaguarda/rh" className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800 mb-4">
          <ArrowLeft className="w-4 h-4" /> RH
        </Link>
        <h1 className="text-xl font-bold text-slate-800 flex items-center gap-2">
          <KeyRound className="w-5 h-5 text-[#B8912B]" /> Função & PIN das funcionárias
        </h1>
        <p className="text-sm text-slate-500 mt-1 mb-5">
          Cada uma com seu PIN de 6 dígitos pra liberar desconto/sangria. Você vê só as da sua loja.
        </p>

        {/* Form */}
        <form onSubmit={salvar} className="bg-white rounded-2xl border border-slate-200 p-4 sm:p-5 shadow-sm mb-6">
          <div className="text-sm font-bold text-slate-700 mb-3 flex items-center gap-1.5">
            <UserPlus className="w-4 h-4" /> {editando ? 'Editar funcionária' : 'Nova funcionária'}
          </div>
          <div className="space-y-3">
            <input value={nome} onChange={(e) => setNome(e.target.value)} placeholder="Nome completo"
              className="w-full px-3 py-2.5 rounded-xl border border-slate-300 focus:border-[#B8912B] outline-none" />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <input value={cpf} onChange={(e) => setCpf(maskCpf(e.target.value))} placeholder="CPF" inputMode="numeric"
                disabled={editando}
                className="w-full px-3 py-2.5 rounded-xl border border-slate-300 focus:border-[#B8912B] outline-none disabled:bg-slate-100" />
              <select value={nivel} onChange={(e) => setNivel(e.target.value as Nivel)}
                className="w-full px-3 py-2.5 rounded-xl border border-slate-300 focus:border-[#B8912B] outline-none bg-white">
                {(['CAIXA', 'SUPERVISOR', 'GERENTE', 'MASTER', 'SUPREMA'] as Nivel[]).map((n) => (
                  <option key={n} value={n}>{NIVEL_LABEL[n]}</option>
                ))}
              </select>
            </div>
            <input value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder={editando ? 'PIN (deixe vazio pra manter)' : 'PIN de 6 dígitos'} inputMode="numeric"
              className="w-full px-3 py-2.5 rounded-xl border border-slate-300 focus:border-[#B8912B] outline-none tracking-[0.3em] text-center" />
          </div>
          {err && <p className="text-red-600 text-sm mt-3 flex items-center gap-1.5"><AlertCircle className="w-4 h-4" />{err}</p>}
          {okMsg && <p className="text-emerald-600 text-sm mt-3 flex items-center gap-1.5"><Check className="w-4 h-4" />{okMsg}</p>}
          <div className="flex gap-2 mt-4">
            <button type="submit" disabled={!podeSalvar}
              className="flex-1 py-2.5 rounded-xl bg-[#B8912B] text-white font-bold disabled:opacity-40 hover:bg-[#8C7325]">
              {saving ? 'Salvando…' : editando ? 'Salvar alterações' : 'Cadastrar'}
            </button>
            {editando && (
              <button type="button" onClick={limpar} className="px-4 py-2.5 rounded-xl border border-slate-300 text-slate-600 font-semibold">
                Cancelar
              </button>
            )}
          </div>
        </form>

        {/* Lista */}
        {loading ? (
          <p className="text-slate-400 text-sm">Carregando…</p>
        ) : lista.length === 0 ? (
          <p className="text-slate-400 text-sm">Nenhuma funcionária com PIN ainda. Cadastre a primeira acima. 💜</p>
        ) : (
          <div className="space-y-2">
            {lista.map((o) => (
              <div key={o.cpf} className={`bg-white rounded-xl border border-slate-200 p-3 flex items-center gap-3 ${o.ativo ? '' : 'opacity-50'}`}>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-slate-800 truncate">{o.nome}</div>
                  <div className="text-xs text-slate-500">
                    {maskCpfShow(o.cpf)} · <span className="font-semibold text-[#8C7325]">{NIVEL_LABEL[o.nivel]}</span>
                    {!o.ativo && ' · desativada'}
                  </div>
                </div>
                <button onClick={() => editar(o)} className="text-xs font-semibold text-slate-600 hover:text-[#8C7325] px-2 py-1">Editar</button>
                <button onClick={() => redefinirPin(o)} className="text-xs font-semibold text-slate-600 hover:text-[#8C7325] px-2 py-1" title="Redefinir PIN">
                  <KeyRound className="w-4 h-4" />
                </button>
                <button onClick={() => toggleAtivo(o)} className={`text-xs font-semibold px-2 py-1 ${o.ativo ? 'text-slate-400 hover:text-red-600' : 'text-emerald-600'}`} title={o.ativo ? 'Desativar' : 'Ativar'}>
                  <Power className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function parseErr(e: any): string {
  const raw = String(e?.message || '');
  try {
    const j = JSON.parse(raw.slice(raw.indexOf(': ') + 2));
    if (j?.message) return Array.isArray(j.message) ? j.message[0] : j.message;
  } catch { /* texto puro */ }
  return 'Algo deu errado. Tenta de novo.';
}
