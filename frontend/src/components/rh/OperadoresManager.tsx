'use client';

/**
 * OperadoresManager — cadastro de FUNÇÃO + PIN pessoal de liberação (por CPF).
 *
 * Usado em DOIS lugares (mesmo componente):
 *   - Matriz:  /retaguarda/rh/operadores        (vê todas as lojas)
 *   - Loja:    /minha-loja/funcionarias          (gerente vê só as da loja dela)
 * O escopo é do BACKEND (filtra pelo JWT). Loja não concede MASTER/SUPREMA.
 * A tela nunca mostra o PIN — só se tem ou não. `backHref` = pra onde volta.
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

/** Funcionária da equipe da loja (vendedoras ativas do PDV + RH) pra escolher em vez de digitar. */
interface EquipeItem {
  nome: string;
  cpf: string | null;
  cargo: string | null;
  nivelSugerido: Nivel;
  storeCode: string | null;
  jaTemPin: boolean;
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
/** Aviso imediato de PIN óbvio (mesma regra do backend) — seguro no cliente. */
function pinFracoClient(pin: string): boolean {
  const d = pin.replace(/\D/g, '');
  if (d.length !== 6) return false;
  if (/^(\d)\1{5}$/.test(d)) return true;            // 000000, 111111...
  return '0123456789'.includes(d) || '9876543210'.includes(d); // 123456, 654321
}

export default function OperadoresManager({ backHref, backLabel }: { backHref: string; backLabel: string }) {
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

  // Equipe da loja — escolher em vez de digitar de novo
  const [equipe, setEquipe] = useState<EquipeItem[]>([]);
  const [equipeSel, setEquipeSel] = useState('');

  // Redefinir PIN inline (prompt() não funciona no app desktop das lojas)
  const [resetCpf, setResetCpf] = useState<string | null>(null);
  const [resetPin, setResetPin] = useState('');

  // Papel do usuário: loja (gerente) NÃO concede MASTER/SUPREMA — só a matriz.
  const [role, setRole] = useState<string>('');
  const niveisDisponiveis: Nivel[] =
    role === 'store'
      ? ['CAIXA', 'SUPERVISOR', 'GERENTE']
      : ['CAIXA', 'SUPERVISOR', 'GERENTE', 'MASTER', 'SUPREMA'];

  const load = async () => {
    setLoading(true); setErr(null);
    try {
      setLista(await api<Operador[]>('/rh/operadores'));
    } catch (e: any) { setErr('Falha ao carregar. Recarregue a página.'); }
    finally { setLoading(false); }
  };
  useEffect(() => {
    load();
    api<{ role?: string }>('/auth/me').then((r) => setRole(r?.role || '')).catch(() => {});
    api<EquipeItem[]>('/rh/operadores/equipe').then(setEquipe).catch(() => {});
  }, []);

  function limpar() {
    setNome(''); setCpf(''); setNivel('CAIXA'); setPin(''); setEditando(false); setEquipeSel('');
  }

  /** Escolheu alguém da equipe → preenche nome/CPF/função sugerida. */
  function escolherDaEquipe(idx: string) {
    setEquipeSel(idx);
    if (idx === '') return;
    const f = equipe[Number(idx)];
    if (!f) return;
    setNome(f.nome);
    setCpf(f.cpf ? maskCpf(f.cpf) : '');
    if (niveisDisponiveis.includes(f.nivelSugerido)) setNivel(f.nivelSugerido);
    setEditando(false);
    setOkMsg(null); setErr(null);
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

  // prompt() não abre no app desktop das lojas (Electron) — campo inline na linha.
  async function confirmarNovoPin(o: Operador) {
    try {
      await api(`/rh/operadores/${o.cpf}/pin`, { method: 'POST', body: JSON.stringify({ pin: resetPin.replace(/\D/g, '') }) });
      setOkMsg(`PIN de ${o.nome.split(' ')[0]} redefinido.`);
      setResetCpf(null); setResetPin('');
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
  const podeSalvar = nome.trim().length >= 3 && cpfOk && pinOk && !pinFracoClient(pin) && !saving;

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6">
      <div className="max-w-2xl mx-auto">
        <Link href={backHref} className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800 mb-4">
          <ArrowLeft className="w-4 h-4" /> {backLabel}
        </Link>
        <h1 className="text-xl font-bold text-slate-800 flex items-center gap-2">
          <KeyRound className="w-5 h-5 text-[#B8912B]" /> Função & PIN das funcionárias
        </h1>
        <p className="text-sm text-slate-500 mt-1 mb-1">
          Cada uma com seu PIN de 6 dígitos pra liberar desconto/sangria. Você vê só as da sua loja.
        </p>
        <p className="text-xs text-slate-400 mb-5">
          💡 Só quem <b>libera</b> tem PIN (caixa, supervisor, gerente). Vendedora e auxiliar <b>não precisam</b>.
        </p>

        {/* Form */}
        <form onSubmit={salvar} className="bg-white rounded-2xl border border-slate-200 p-4 sm:p-5 shadow-sm mb-6">
          <div className="text-sm font-bold text-slate-700 mb-3 flex items-center gap-1.5">
            <UserPlus className="w-4 h-4" /> {editando ? 'Editar funcionária' : 'Nova funcionária'}
          </div>
          <div className="space-y-3">
            {equipe.length > 0 && !editando && (
              <div>
                <select value={equipeSel} onChange={(e) => escolherDaEquipe(e.target.value)}
                  className="w-full px-3 py-2.5 rounded-xl border border-[#B8912B]/50 bg-[#FBF6E6] focus:border-[#B8912B] outline-none font-medium text-slate-700">
                  <option value="">👥 Escolher da equipe da loja…</option>
                  {equipe.map((f, i) => (
                    <option key={`${f.nome}-${i}`} value={String(i)}>
                      {f.nome}{f.cargo ? ` — ${f.cargo.replace(/_/g, ' ')}` : ''}{f.jaTemPin ? ' ✓ (já tem PIN)' : ''}
                    </option>
                  ))}
                </select>
                <p className="text-[11px] text-slate-400 mt-1">
                  Lista das funcionárias já cadastradas da sua loja — escolher preenche nome, CPF e função.
                  Se o CPF não vier, é porque falta no RH: complete abaixo.
                </p>
              </div>
            )}
            <input value={nome} onChange={(e) => { setNome(e.target.value); setEquipeSel(''); }} placeholder="Nome completo"
              className="w-full px-3 py-2.5 rounded-xl border border-slate-300 focus:border-[#B8912B] outline-none" />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <input value={cpf} onChange={(e) => setCpf(maskCpf(e.target.value))} placeholder="CPF" inputMode="numeric"
                disabled={editando}
                className="w-full px-3 py-2.5 rounded-xl border border-slate-300 focus:border-[#B8912B] outline-none disabled:bg-slate-100" />
              <select value={nivel} onChange={(e) => setNivel(e.target.value as Nivel)}
                className="w-full px-3 py-2.5 rounded-xl border border-slate-300 focus:border-[#B8912B] outline-none bg-white">
                {niveisDisponiveis.map((n) => (
                  <option key={n} value={n}>{NIVEL_LABEL[n]}</option>
                ))}
              </select>
            </div>
            <input value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder={editando ? 'PIN (deixe vazio pra manter)' : 'PIN de 6 dígitos'} inputMode="numeric"
              className={`w-full px-3 py-2.5 rounded-xl border outline-none tracking-[0.3em] text-center ${
                pinFracoClient(pin) ? 'border-red-400 focus:border-red-500' : 'border-slate-300 focus:border-[#B8912B]'
              }`} />
            {pinFracoClient(pin) && (
              <p className="text-red-500 text-xs -mt-1">PIN muito óbvio — evite sequência (123456) ou repetição (000000).</p>
            )}
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
              <div key={o.cpf} className={`bg-white rounded-xl border border-slate-200 p-3 ${o.ativo ? '' : 'opacity-50'}`}>
                <div className="flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-slate-800 truncate">{o.nome}</div>
                    <div className="text-xs text-slate-500">
                      {maskCpfShow(o.cpf)} · <span className="font-semibold text-[#8C7325]">{NIVEL_LABEL[o.nivel]}</span>
                      {!o.ativo && ' · desativada'}
                    </div>
                  </div>
                  <button onClick={() => editar(o)} className="text-xs font-semibold text-slate-600 hover:text-[#8C7325] px-2 py-1">Editar</button>
                  <button onClick={() => { setResetCpf(resetCpf === o.cpf ? null : o.cpf); setResetPin(''); setErr(null); }}
                    className={`text-xs font-semibold px-2 py-1 ${resetCpf === o.cpf ? 'text-[#8C7325]' : 'text-slate-600 hover:text-[#8C7325]'}`} title="Redefinir PIN">
                    <KeyRound className="w-4 h-4" />
                  </button>
                  <button onClick={() => toggleAtivo(o)} className={`text-xs font-semibold px-2 py-1 ${o.ativo ? 'text-slate-400 hover:text-red-600' : 'text-emerald-600'}`} title={o.ativo ? 'Desativar' : 'Ativar'}>
                    <Power className="w-4 h-4" />
                  </button>
                </div>
                {resetCpf === o.cpf && (
                  <div className="flex items-center gap-2 mt-2 pt-2 border-t border-slate-100">
                    <input value={resetPin} onChange={(e) => setResetPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      placeholder="Novo PIN (6 dígitos)" inputMode="numeric" autoFocus
                      className={`flex-1 px-3 py-2 rounded-lg border outline-none tracking-[0.3em] text-center text-sm ${
                        pinFracoClient(resetPin) ? 'border-red-400' : 'border-slate-300 focus:border-[#B8912B]'
                      }`} />
                    <button onClick={() => confirmarNovoPin(o)}
                      disabled={resetPin.length !== 6 || pinFracoClient(resetPin)}
                      className="px-3 py-2 rounded-lg bg-[#B8912B] text-white text-xs font-bold disabled:opacity-40 hover:bg-[#8C7325]">
                      Salvar PIN
                    </button>
                    <button onClick={() => { setResetCpf(null); setResetPin(''); }}
                      className="px-3 py-2 rounded-lg border border-slate-300 text-slate-500 text-xs font-semibold">
                      Cancelar
                    </button>
                  </div>
                )}
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
