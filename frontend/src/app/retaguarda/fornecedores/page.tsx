'use client';

/**
 * /retaguarda/fornecedores — cadastro de fornecedor.
 *
 * Até 01/08/2026 não existia: a lista do Contas a Pagar e dos pedidos de compra
 * vinha do Giga e não havia como criar um novo — só pelo Wincred desktop, que
 * ninguém usa mais.
 *
 * O fornecedor é gravado no Flow e o Giga recebe réplica pela fila. Código na
 * faixa 90.000+ (o Giga usa até 10.526), o que também deixa óbvio na tela quem
 * nasceu aqui.
 *
 * CNPJ é OPCIONAL e NÃO precisa ser único de propósito: o cadastro legado tem
 * 694 fornecedores sem CNPJ e 76 CNPJs repetidos. Exigir qualquer das duas
 * regras travaria a edição de quem já está lá. A tela AVISA sobre repetido, mas
 * deixa salvar.
 */

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import {
  ArrowLeft, Plus, Search, Save, X, Building2, AlertTriangle, Check, Clock, Trash2,
} from 'lucide-react';

type Fornecedor = {
  codigo: number;
  razaoSocial: string | null;
  fantasia: string | null;
  cnpj: string | null;
  ie: string | null;
  endereco: string | null;
  bairro: string | null;
  cidade: string | null;
  uf: string | null;
  ddd: string | null;
  fone: string | null;
  fax: string | null;
  cep: string | null;
  email: string | null;
  contato: string | null;
  flowIsSource?: boolean;
  gigaOk?: boolean;
};

const VAZIO: Partial<Fornecedor> & { obs?: string } = {
  razaoSocial: '', fantasia: '', cnpj: '', ie: '', endereco: '', bairro: '',
  cidade: '', uf: '', ddd: '', fone: '', fax: '', cep: '', email: '', contato: '', obs: '',
};

const UFS = ['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'];

const fmtCnpj = (v: string) => {
  const d = String(v || '').replace(/\D/g, '').slice(0, 14);
  if (d.length <= 11) return d;
  return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{0,2})$/, '$1.$2.$3/$4-$5');
};

export default function FornecedoresPage() {
  const [lista, setLista] = useState<Fornecedor[]>([]);
  const [busca, setBusca] = useState('');
  const [carregando, setCarregando] = useState(false);
  const [form, setForm] = useState<any | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [dupCnpj, setDupCnpj] = useState<any[]>([]);
  // Excluir em 2 cliques (sem window.confirm — não funciona no app das lojas):
  // 1º clique arma ("Confirma?"), 2º executa. Qualquer outro clique desarma.
  const [armadoExcluir, setArmadoExcluir] = useState<number | null>(null);
  const [excluindo, setExcluindo] = useState<number | null>(null);

  const carregar = useCallback(async () => {
    setCarregando(true);
    try {
      setLista(await api<Fornecedor[]>(`/fornecedores?q=${encodeURIComponent(busca)}`));
    } catch (e: any) {
      setErro(e?.message || 'Falha ao carregar');
    } finally {
      setCarregando(false);
    }
  }, [busca]);

  useEffect(() => { void carregar(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const abrirNovo = () => { setForm({ ...VAZIO }); setDupCnpj([]); setErro(null); setOk(null); };
  const abrirEdicao = (f: Fornecedor) => { setForm({ ...f, obs: '' }); setDupCnpj([]); setErro(null); setOk(null); };

  // Aviso de CNPJ repetido — informativo, nunca bloqueia.
  const checarCnpj = async (cnpj: string) => {
    const d = String(cnpj || '').replace(/\D/g, '');
    if (d.length < 11) { setDupCnpj([]); return; }
    try {
      const r = await api<{ existentes: any[] }>(
        `/fornecedores/checar-cnpj?cnpj=${d}${form?.codigo ? `&ignorar=${form.codigo}` : ''}`,
      );
      setDupCnpj(r.existentes || []);
    } catch { setDupCnpj([]); }
  };

  const excluir = async (f: Fornecedor) => {
    if (armadoExcluir !== f.codigo) { setArmadoExcluir(f.codigo); setErro(null); setOk(null); return; }
    setExcluindo(f.codigo);
    setArmadoExcluir(null);
    try {
      await api(`/fornecedores/${f.codigo}`, { method: 'DELETE' });
      setOk(`Fornecedor ${f.codigo} — ${f.razaoSocial || 's/ nome'} excluído (Giga recebe a exclusão automaticamente)`);
      await carregar();
    } catch (e: any) {
      // Trava do backend (ex.: contas a pagar vinculadas) chega aqui com o motivo.
      setErro(e?.message || 'Falha ao excluir');
    } finally {
      setExcluindo(null);
    }
  };

  const salvar = async () => {
    if (!String(form?.razaoSocial || '').trim()) { setErro('Razão social é obrigatória'); return; }
    setSalvando(true); setErro(null);
    try {
      if (form.codigo) await api(`/fornecedores/${form.codigo}`, { method: 'PUT', body: JSON.stringify(form) });
      else await api('/fornecedores', { method: 'POST', body: JSON.stringify(form) });
      setOk(form.codigo ? `Fornecedor ${form.codigo} atualizado` : 'Fornecedor cadastrado');
      setForm(null);
      await carregar();
    } catch (e: any) {
      setErro(e?.message || 'Falha ao salvar');
    } finally {
      setSalvando(false);
    }
  };

  const campo = (k: string, label: string, extra?: { largura?: string; tipo?: string; max?: number }) => (
    <div className={extra?.largura || 'col-span-1'}>
      <label className="block text-[11px] font-semibold uppercase tracking-wide text-neutral-500 mb-1">{label}</label>
      <input
        type={extra?.tipo || 'text'}
        maxLength={extra?.max}
        value={form?.[k] ?? ''}
        onChange={(e) => setForm({ ...form, [k]: e.target.value })}
        onBlur={k === 'cnpj' ? (e) => void checarCnpj(e.target.value) : undefined}
        className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-[#B8912B] focus:ring-1 focus:ring-[#B8912B]"
      />
    </div>
  );

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <div className="mb-6 flex items-center gap-3">
        <Link href="/retaguarda" className="rounded-lg p-2 hover:bg-neutral-100"><ArrowLeft size={18} /></Link>
        <div className="flex-1">
          <h1 className="flex items-center gap-2 text-xl font-bold text-neutral-800">
            <Building2 size={20} className="text-[#B8912B]" /> Fornecedores
          </h1>
          <p className="text-xs text-neutral-500">Cadastro no Flow · o Giga recebe cópia automaticamente</p>
        </div>
        <button onClick={abrirNovo} className="flex items-center gap-2 rounded-lg bg-[#B8912B] px-4 py-2 text-sm font-semibold text-white hover:bg-[#8C7325]">
          <Plus size={16} /> Novo fornecedor
        </button>
      </div>

      {ok && <div className="mb-4 flex items-center gap-2 rounded-lg bg-green-50 px-4 py-3 text-sm text-green-800"><Check size={16} /> {ok}</div>}
      {erro && !form && <div className="mb-4 flex items-center gap-2 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-800"><AlertTriangle size={16} /> {erro}</div>}

      <div className="mb-4 flex gap-2">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
          <input
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void carregar(); }}
            placeholder="Busque por razão social, fantasia, CNPJ ou código"
            className="w-full rounded-lg border border-neutral-300 py-2 pl-9 pr-3 text-sm outline-none focus:border-[#B8912B]"
          />
        </div>
        <button onClick={() => void carregar()} className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-50">Buscar</button>
      </div>

      <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white">
        <div className="border-b border-neutral-100 bg-neutral-50/60 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
          {carregando ? 'Carregando…' : `${lista.length} fornecedor${lista.length === 1 ? '' : 'es'}${busca.trim() ? ' na busca' : ' no total'}`}
        </div>
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-[11px] uppercase tracking-wide text-neutral-500">
            <tr>
              <th className="px-4 py-3 text-left">Código</th>
              <th className="px-4 py-3 text-left">Razão social</th>
              <th className="px-4 py-3 text-left">CNPJ</th>
              <th className="px-4 py-3 text-left">Cidade</th>
              <th className="px-4 py-3 text-left">Contato</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {carregando && <tr><td colSpan={6} className="px-4 py-8 text-center text-neutral-400">Carregando…</td></tr>}
            {!carregando && !lista.length && <tr><td colSpan={6} className="px-4 py-8 text-center text-neutral-400">Nenhum fornecedor</td></tr>}
            {lista.map((f) => (
              <tr key={f.codigo} className="hover:bg-neutral-50">
                <td className="px-4 py-3 font-mono text-xs">
                  {f.codigo}
                  {f.flowIsSource && (
                    <span className="ml-2 rounded bg-[#FBF6E6] px-1.5 py-0.5 text-[10px] font-semibold text-[#8C7325]">FLOW</span>
                  )}
                  {f.flowIsSource && f.gigaOk === false && (
                    <span title="réplica pro Giga ainda na fila" className="ml-1 inline-flex items-center text-amber-600"><Clock size={11} /></span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <div className="font-medium text-neutral-800">{f.razaoSocial || '—'}</div>
                  {f.fantasia && <div className="text-xs text-neutral-500">{f.fantasia}</div>}
                </td>
                <td className="px-4 py-3 font-mono text-xs text-neutral-600">{f.cnpj ? fmtCnpj(f.cnpj) : '—'}</td>
                <td className="px-4 py-3 text-neutral-600">{f.cidade || '—'}{f.uf ? `/${f.uf}` : ''}</td>
                <td className="px-4 py-3 text-neutral-600">{f.contato || f.fone || '—'}</td>
                <td className="px-4 py-3 text-right">
                  <div className="flex items-center justify-end gap-1.5">
                    <button onClick={() => { setArmadoExcluir(null); abrirEdicao(f); }} className="rounded-lg border border-neutral-300 px-3 py-1 text-xs font-medium hover:bg-neutral-50">Editar</button>
                    <button
                      onClick={() => void excluir(f)}
                      disabled={excluindo === f.codigo}
                      title={armadoExcluir === f.codigo ? 'Clique de novo pra confirmar a exclusão' : 'Excluir fornecedor'}
                      className={`rounded-lg border px-2.5 py-1 text-xs font-medium flex items-center gap-1 disabled:opacity-50 ${
                        armadoExcluir === f.codigo
                          ? 'border-red-400 bg-red-600 text-white hover:bg-red-700'
                          : 'border-red-200 text-red-600 hover:bg-red-50'
                      }`}
                    >
                      <Trash2 size={13} />
                      {excluindo === f.codigo ? 'Excluindo…' : armadoExcluir === f.codigo ? 'Confirma?' : ''}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {form && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4">
          <div className="mt-8 w-full max-w-3xl rounded-xl bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-neutral-200 px-6 py-4">
              <h2 className="font-bold text-neutral-800">
                {form.codigo ? `Editar fornecedor ${form.codigo}` : 'Novo fornecedor'}
              </h2>
              <button onClick={() => setForm(null)} className="rounded-lg p-1 hover:bg-neutral-100"><X size={18} /></button>
            </div>

            <div className="grid grid-cols-1 gap-4 px-6 py-5 md:grid-cols-4">
              {campo('razaoSocial', 'Razão social *', { largura: 'md:col-span-2', max: 50 })}
              {campo('fantasia', 'Nome fantasia', { largura: 'md:col-span-2', max: 50 })}

              {campo('cnpj', 'CNPJ', { largura: 'md:col-span-2', max: 18 })}
              {campo('ie', 'Inscrição estadual', { largura: 'md:col-span-2', max: 18 })}

              {dupCnpj.length > 0 && (
                <div className="md:col-span-4 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                  <div>
                    <b>Este CNPJ já está em outro cadastro:</b>{' '}
                    {dupCnpj.map((d) => `${d.codigo} — ${d.razaoSocial || d.fantasia || 's/ nome'}`).join(' · ')}
                    <div className="mt-0.5 text-amber-700">Dá pra salvar mesmo assim (o cadastro antigo já tem repetidos), mas confira se não é duplicata.</div>
                  </div>
                </div>
              )}

              {campo('endereco', 'Endereço', { largura: 'md:col-span-3', max: 50 })}
              {campo('bairro', 'Bairro', { max: 30 })}

              {campo('cidade', 'Cidade', { largura: 'md:col-span-2', max: 30 })}
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-wide text-neutral-500 mb-1">UF</label>
                <select
                  value={form.uf ?? ''}
                  onChange={(e) => setForm({ ...form, uf: e.target.value })}
                  className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-[#B8912B]"
                >
                  <option value="">—</option>
                  {UFS.map((u) => <option key={u} value={u}>{u}</option>)}
                </select>
              </div>
              {campo('cep', 'CEP', { max: 10 })}

              {campo('ddd', 'DDD', { max: 5 })}
              {campo('fone', 'Telefone', { max: 16 })}
              {campo('fax', 'Fax', { max: 16 })}
              {campo('contato', 'Contato', { max: 50 })}

              {campo('email', 'E-mail', { largura: 'md:col-span-4', tipo: 'email', max: 50 })}

              <div className="md:col-span-4">
                <label className="block text-[11px] font-semibold uppercase tracking-wide text-neutral-500 mb-1">Observações</label>
                <textarea
                  rows={2}
                  maxLength={500}
                  value={form.obs ?? ''}
                  onChange={(e) => setForm({ ...form, obs: e.target.value })}
                  className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-[#B8912B]"
                />
              </div>

              {erro && (
                <div className="md:col-span-4 flex items-center gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
                  <AlertTriangle size={14} /> {erro}
                </div>
              )}
            </div>

            <div className="flex items-center justify-between border-t border-neutral-200 px-6 py-4">
              <p className="text-xs text-neutral-500">
                Só a razão social é obrigatória. O código é gerado automaticamente.
              </p>
              <div className="flex gap-2">
                <button onClick={() => setForm(null)} className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-50">Cancelar</button>
                <button
                  onClick={() => void salvar()}
                  disabled={salvando}
                  className="flex items-center gap-2 rounded-lg bg-[#2E7D46] px-5 py-2 text-sm font-semibold text-white hover:bg-[#256238] disabled:opacity-50"
                >
                  <Save size={15} /> {salvando ? 'Salvando…' : 'Salvar'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
