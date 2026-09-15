'use client';

/**
 * /imobiliario/novo — Cadastro de novo imóvel.
 * ViaCEP auto-preenche endereço quando CEP completo (8 dígitos).
 *
 * ORDER ONE · Executive Operations UI (15/09/2026): casca navy, faixa de
 * comando e formulário em seções de duas colunas. Mesma lógica de antes.
 */

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertCircle, ArrowLeft, Building2, Loader2, MapPin, NotebookPen, Save } from 'lucide-react';
import { api } from '@/lib/api';
import EnterpriseShell from '@/components/enterprise/EnterpriseShell';
import PageHeader from '@/components/enterprise/PageHeader';
import { BarraAcoes, BTN_PRIMARIO, BTN_SECUNDARIO, CAMPO, Campo, Secao } from '@/components/enterprise/Form';

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
    <EnterpriseShell trilha={[{ label: 'Início', href: '/' }, { label: 'Imobiliário', href: '/imobiliario' }, { label: 'Novo imóvel' }]}>
      <div className="bg-oo-nav pb-16 sm:pb-20">
        <div className="mx-auto w-full max-w-[1200px] px-4 pt-6 sm:px-6 sm:pt-8">
          <Link
            href="/imobiliario"
            className="mb-4 inline-flex items-center gap-1.5 rounded-md text-[13px] font-medium text-slate-400 transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
          >
            <ArrowLeft className="h-4 w-4" />
            Imóveis
          </Link>
          <PageHeader
            escuro
            icone={<Building2 className="h-5 w-5" />}
            titulo="Novo imóvel"
            subtitulo="Cadastro rápido — depois você adiciona docs e taxas"
          />
        </div>
      </div>

      <main className="mx-auto -mt-10 w-full max-w-[1200px] px-4 pb-12 sm:-mt-12 sm:px-6">
        <div className="overflow-hidden rounded-xl border border-oo-line bg-oo-surface shadow-[0_1px_2px_rgba(16,24,40,.06),0_8px_24px_-12px_rgba(16,24,40,.12)]">
          {error && (
            <div className="flex items-center gap-2 border-b border-oo-danger/20 bg-oo-danger-soft px-5 py-3 text-[14px] font-medium text-oo-danger sm:px-8" role="alert">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}

          <Secao titulo="Dados principais" icone={<Building2 className="h-4 w-4" />} descricao="Como o imóvel aparece na lista e quem é o dono.">
            <div className="grid gap-4 sm:grid-cols-2">
              <Campo label="Nome do imóvel *" className="sm:col-span-2">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Ex: Apto Moema 302, Sala Vila Olímpia"
                  className={`${CAMPO} h-10`}
                  autoFocus
                />
              </Campo>
              <Campo label="Proprietário">
                <input
                  value={proprietario}
                  onChange={(e) => setProprietario(e.target.value)}
                  placeholder="Nome ou razão social"
                  className={`${CAMPO} h-10`}
                />
              </Campo>
              <Campo label="Status">
                <select value={status} onChange={(e) => setStatus(e.target.value)} className={`${CAMPO} h-10`}>
                  {STATUS_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </Campo>
            </div>
          </Secao>

          <Secao titulo="Endereço" icone={<MapPin className="h-4 w-4" />} descricao="8 dígitos completam endereço automaticamente">
            <div className="grid gap-4 sm:grid-cols-6">
              <Campo label="CEP" className="sm:col-span-2">
                <div className="relative">
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
                    className={`${CAMPO} h-10 pr-9 tabular-nums`}
                  />
                  {cepLoading && <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-oo-primary" />}
                </div>
              </Campo>
              <Campo label="Logradouro" className="sm:col-span-4">
                <input value={endereco} onChange={(e) => setEndereco(e.target.value)} placeholder="Rua / Avenida" className={`${CAMPO} h-10`} />
              </Campo>
              <Campo label="Número" className="sm:col-span-2">
                <input value={numero} onChange={(e) => setNumero(e.target.value)} placeholder="Nº" className={`${CAMPO} h-10`} />
              </Campo>
              <Campo label="Complemento" className="sm:col-span-4">
                <input value={complemento} onChange={(e) => setComplemento(e.target.value)} placeholder="Apto, sala, bloco" className={`${CAMPO} h-10`} />
              </Campo>
              <Campo label="Bairro" className="sm:col-span-2">
                <input value={bairro} onChange={(e) => setBairro(e.target.value)} placeholder="Bairro" className={`${CAMPO} h-10`} />
              </Campo>
              <Campo label="Cidade" className="sm:col-span-3">
                <input value={cidade} onChange={(e) => setCidade(e.target.value)} placeholder="Cidade" className={`${CAMPO} h-10`} />
              </Campo>
              <Campo label="UF">
                <input
                  value={estado}
                  onChange={(e) => setEstado(e.target.value.toUpperCase().slice(0, 2))}
                  placeholder="SP"
                  maxLength={2}
                  className={`${CAMPO} h-10 uppercase`}
                />
              </Campo>
            </div>
          </Secao>

          <Secao titulo="Observações" icone={<NotebookPen className="h-4 w-4" />} descricao="Notas internas, contatos, particularidades.">
            <textarea
              value={observacoes}
              onChange={(e) => setObservacoes(e.target.value)}
              placeholder="Notas internas, contatos, particularidades..."
              rows={4}
              className={`${CAMPO} resize-y py-2.5`}
            />
          </Secao>

          <BarraAcoes>
            <Link href="/imobiliario" className={BTN_SECUNDARIO}>
              Cancelar
            </Link>
            <button onClick={salvar} disabled={saving || !name.trim()} className={BTN_PRIMARIO}>
              {saving ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Salvando...
                </>
              ) : (
                <>
                  <Save className="h-4 w-4" />
                  Salvar imóvel
                </>
              )}
            </button>
          </BarraAcoes>
        </div>
      </main>
    </EnterpriseShell>
  );
}
