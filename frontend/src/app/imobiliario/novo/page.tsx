'use client';

/**
 * /imobiliario/novo — Cadastro de novo imóvel.
 * ViaCEP auto-preenche endereço quando CEP completo (8 dígitos).
 */

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Building2, Loader2, Save, Search } from 'lucide-react';
import { api } from '@/lib/api';

const STATUS_OPTIONS = [
  { value: 'ativo', label: 'Ativo' },
  { value: 'em_construcao', label: 'Em Construção' },
  { value: 'pronta_locacao', label: 'Pronta para Locação' },
  { value: 'inativo', label: 'Inativo' },
  { value: 'vendido', label: 'Vendido' },
];

export default function NovoImovelPage() {
  const router = useRouter();

  const [name, setName] = useState('');
  const [cep, setCep] = useState('');
  const [endereco, setEndereco] = useState('');
  const [numero, setNumero] = useState('');
  const [complemento, setComplemento] = useState('');
  const [bairro, setBairro] = useState('');
  const [cidade, setCidade] = useState('');
  const [estado, setEstado] = useState('');
  const [status, setStatus] = useState('ativo');
  const [proprietario, setProprietario] = useState('');
  const [observacoes, setObservacoes] = useState('');

  const [cepLoading, setCepLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lookupCep = async (raw: string) => {
    const clean = raw.replace(/\D/g, '');
    if (clean.length !== 8) return;
    setCepLoading(true);
    try {
      const r = await fetch(`https://viacep.com.br/ws/${clean}/json/`);
      const data = await r.json();
      if (data?.erro) return;
      if (!endereco) setEndereco(data.logradouro || '');
      if (!bairro) setBairro(data.bairro || '');
      if (!cidade) setCidade(data.localidade || '');
      if (!estado) setEstado((data.uf || '').toUpperCase());
    } catch {
      // silent
    } finally {
      setCepLoading(false);
    }
  };

  const salvar = async () => {
    if (!name.trim()) {
      setError('Nome do imóvel é obrigatório');
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const r = await api<{ id: string }>('/properties', {
        method: 'POST',
        body: JSON.stringify({
          name, cep, endereco, numero, complemento, bairro, cidade, estado,
          status, proprietario, observacoes,
        }),
      });
      router.push(`/imobiliario/${r.id}`);
    } catch (e: any) {
      setError(e?.message || 'Erro ao salvar');
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white">
      <header className="bg-slate-900/80 backdrop-blur-xl border-b border-white/10 sticky top-0 z-30">
        <div className="max-w-3xl mx-auto px-6 py-4 flex items-center gap-3">
          <Link href="/imobiliario" className="p-2 rounded-lg hover:bg-white/10 transition">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-500 to-amber-700 flex items-center justify-center">
            <Building2 className="w-5 h-5 text-white" />
          </div>
          <div className="flex-1">
            <h1 className="text-lg font-black">Novo imóvel</h1>
            <p className="text-xs text-slate-400">Cadastro rápido — depois você adiciona docs e taxas</p>
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto p-6 space-y-4">
        {error && (
          <div className="bg-rose-500/10 border border-rose-500/30 text-rose-200 rounded-lg p-3 text-sm">
            ⚠ {error}
          </div>
        )}

        {/* Dados principais */}
        <section className="bg-white/5 backdrop-blur-md border border-white/10 rounded-2xl p-5 space-y-4">
          <h2 className="text-xs font-bold uppercase tracking-wider text-amber-400">Dados principais</h2>

          <Field label="Nome do imóvel *" required>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ex: Apto Moema 302, Sala Vila Olímpia"
              className="w-full px-3 py-2.5 bg-white/5 border border-white/10 rounded-lg text-white placeholder:text-slate-500 focus:outline-none focus:border-amber-400"
              autoFocus
            />
          </Field>

          <Field label="Proprietário">
            <input
              value={proprietario}
              onChange={(e) => setProprietario(e.target.value)}
              placeholder="Nome ou razão social"
              className="w-full px-3 py-2.5 bg-white/5 border border-white/10 rounded-lg text-white placeholder:text-slate-500 focus:outline-none focus:border-amber-400"
            />
          </Field>

          <Field label="Status">
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="w-full px-3 py-2.5 bg-white/5 border border-white/10 rounded-lg text-white focus:outline-none focus:border-amber-400"
            >
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value} className="bg-slate-800">{o.label}</option>
              ))}
            </select>
          </Field>
        </section>

        {/* Endereço */}
        <section className="bg-white/5 backdrop-blur-md border border-white/10 rounded-2xl p-5 space-y-4">
          <h2 className="text-xs font-bold uppercase tracking-wider text-amber-400">Endereço</h2>

          <Field label="CEP">
            <div className="flex gap-2">
              <input
                value={cep}
                onChange={(e) => {
                  const v = e.target.value.replace(/\D/g, '').slice(0, 8);
                  setCep(v);
                  if (v.length === 8) lookupCep(v);
                }}
                placeholder="só números"
                maxLength={8}
                inputMode="numeric"
                className="flex-1 px-3 py-2.5 bg-white/5 border border-white/10 rounded-lg text-white font-mono placeholder:text-slate-500 focus:outline-none focus:border-amber-400"
              />
              {cepLoading && (
                <div className="flex items-center px-3 text-amber-400">
                  <Loader2 className="w-4 h-4 animate-spin" />
                </div>
              )}
            </div>
            <p className="text-[10px] text-slate-500 mt-1">8 dígitos completam endereço automaticamente</p>
          </Field>

          <Field label="Logradouro">
            <input
              value={endereco}
              onChange={(e) => setEndereco(e.target.value)}
              placeholder="Rua / Avenida"
              className="w-full px-3 py-2.5 bg-white/5 border border-white/10 rounded-lg text-white placeholder:text-slate-500 focus:outline-none focus:border-amber-400"
            />
          </Field>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <Field label="Número">
              <input
                value={numero}
                onChange={(e) => setNumero(e.target.value)}
                placeholder="Nº"
                className="w-full px-3 py-2.5 bg-white/5 border border-white/10 rounded-lg text-white placeholder:text-slate-500 focus:outline-none focus:border-amber-400"
              />
            </Field>
            <div className="col-span-2">
              <Field label="Complemento">
                <input
                  value={complemento}
                  onChange={(e) => setComplemento(e.target.value)}
                  placeholder="Apto, sala, bloco"
                  className="w-full px-3 py-2.5 bg-white/5 border border-white/10 rounded-lg text-white placeholder:text-slate-500 focus:outline-none focus:border-amber-400"
                />
              </Field>
            </div>
          </div>

          <Field label="Bairro">
            <input
              value={bairro}
              onChange={(e) => setBairro(e.target.value)}
              placeholder="Bairro"
              className="w-full px-3 py-2.5 bg-white/5 border border-white/10 rounded-lg text-white placeholder:text-slate-500 focus:outline-none focus:border-amber-400"
            />
          </Field>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <div className="col-span-2">
              <Field label="Cidade">
                <input
                  value={cidade}
                  onChange={(e) => setCidade(e.target.value)}
                  placeholder="Cidade"
                  className="w-full px-3 py-2.5 bg-white/5 border border-white/10 rounded-lg text-white placeholder:text-slate-500 focus:outline-none focus:border-amber-400"
                />
              </Field>
            </div>
            <Field label="UF">
              <input
                value={estado}
                onChange={(e) => setEstado(e.target.value.toUpperCase().slice(0, 2))}
                placeholder="SP"
                maxLength={2}
                className="w-full px-3 py-2.5 bg-white/5 border border-white/10 rounded-lg text-white font-mono uppercase placeholder:text-slate-500 focus:outline-none focus:border-amber-400"
              />
            </Field>
          </div>
        </section>

        {/* Observações */}
        <section className="bg-white/5 backdrop-blur-md border border-white/10 rounded-2xl p-5 space-y-4">
          <h2 className="text-xs font-bold uppercase tracking-wider text-amber-400">Observações</h2>
          <textarea
            value={observacoes}
            onChange={(e) => setObservacoes(e.target.value)}
            placeholder="Notas internas, contatos, particularidades..."
            rows={4}
            className="w-full px-3 py-2.5 bg-white/5 border border-white/10 rounded-lg text-white placeholder:text-slate-500 focus:outline-none focus:border-amber-400 resize-y"
          />
        </section>

        {/* Ações */}
        <div className="flex items-center gap-3 sticky bottom-4">
          <Link
            href="/imobiliario"
            className="px-5 py-3 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-sm font-bold transition"
          >
            Cancelar
          </Link>
          <button
            onClick={salvar}
            disabled={saving || !name.trim()}
            className="flex-1 px-5 py-3 bg-gradient-to-br from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-white font-bold rounded-lg shadow-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 transition-all"
          >
            {saving ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Salvando...
              </>
            ) : (
              <>
                <Save className="w-4 h-4" />
                Salvar imóvel
              </>
            )}
          </button>
        </div>
      </main>
    </div>
  );
}

function Field({ label, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs font-bold text-slate-300 mb-1.5 block">{label}</span>
      {children}
    </label>
  );
}
