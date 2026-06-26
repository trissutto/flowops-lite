'use client';

/**
 * /imobiliario/[id] — Painel individual do imóvel.
 *
 * Tabs:
 *   - Geral (dados + endereço + observações)
 *   - Água
 *   - Energia
 *   - IPTU
 *   - Taxas (múltiplas)
 *   - Matrícula
 *   - Escritura
 *   - Anexos
 *   - Histórico (logs)
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  ArrowLeft, Building2, Loader2, Save, Edit3, Archive, ArchiveRestore,
  Copy, MapPin, Droplet, Zap, Receipt, FileText, Scroll, Folder, History,
  Plus, Trash2, AlertCircle, Calendar, Tag,
} from 'lucide-react';
import { api } from '@/lib/api';

type Property = any;

const STATUS_OPTIONS = [
  { value: 'ativo', label: 'Ativo', color: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40' },
  { value: 'em_construcao', label: 'Em Construção', color: 'bg-amber-500/20 text-amber-300 border-amber-500/40' },
  { value: 'pronta_locacao', label: 'Pronta p/ Locação', color: 'bg-sky-500/20 text-sky-300 border-sky-500/40' },
  { value: 'vendido', label: 'Vendido', color: 'bg-violet-500/20 text-violet-300 border-violet-500/40' },
  { value: 'inativo', label: 'Inativo', color: 'bg-slate-600/40 text-slate-300 border-slate-500/40' },
];

const TABS = [
  { id: 'geral', label: 'Geral', icon: Building2 },
  { id: 'agua', label: 'Água', icon: Droplet },
  { id: 'energia', label: 'Energia', icon: Zap },
  { id: 'iptu', label: 'IPTU', icon: Receipt },
  { id: 'taxas', label: 'Taxas', icon: Tag },
  { id: 'matricula', label: 'Matrícula', icon: FileText },
  { id: 'escritura', label: 'Escritura', icon: Scroll },
  { id: 'historico', label: 'Histórico', icon: History },
];

export default function ImovelDetailPage() {
  const router = useRouter();
  const params = useParams();
  const id = params?.id as string;

  const [data, setData] = useState<Property | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState('geral');
  const [saving, setSaving] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api<Property>(`/properties/${id}`);
      setData(r);
    } catch (e: any) {
      setError(e?.message || 'Erro ao carregar imóvel');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (id) fetchData();
  }, [id, fetchData]);

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-amber-400" />
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white flex items-center justify-center p-8">
        <div className="bg-rose-500/10 border border-rose-500/30 text-rose-200 rounded-lg p-6 max-w-md">
          <AlertCircle className="w-10 h-10 mb-3" />
          <div className="font-bold">{error || 'Imóvel não encontrado'}</div>
          <Link href="/imobiliario" className="mt-4 inline-block text-sm underline text-rose-300">
            ← Voltar pra lista
          </Link>
        </div>
      </div>
    );
  }

  const st = STATUS_OPTIONS.find((o) => o.value === data.status) || STATUS_OPTIONS[0];

  const arquivar = async () => {
    if (!confirm('Arquivar esse imóvel? Ele sai da lista principal mas pode ser restaurado.')) return;
    try {
      await api(`/properties/${id}/archive`, { method: 'POST' });
      router.push('/imobiliario');
    } catch (e: any) {
      alert('Erro: ' + e?.message);
    }
  };
  const desarquivar = async () => {
    try {
      await api(`/properties/${id}/unarchive`, { method: 'POST' });
      fetchData();
    } catch (e: any) {
      alert('Erro: ' + e?.message);
    }
  };
  const duplicar = async () => {
    if (!confirm('Duplicar esse imóvel? Cria uma cópia idêntica que você pode editar.')) return;
    try {
      const r = await api<{ id: string }>(`/properties/${id}/duplicate`, { method: 'POST' });
      router.push(`/imobiliario/${r.id}`);
    } catch (e: any) {
      alert('Erro: ' + e?.message);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white">
      <header className="bg-slate-900/80 backdrop-blur-xl border-b border-white/10 sticky top-0 z-30">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center gap-3">
          <Link href="/imobiliario" className="p-2 rounded-lg hover:bg-white/10">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-500 to-amber-700 flex items-center justify-center">
            <Building2 className="w-5 h-5 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-black truncate">{data.name}</h1>
              <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded border ${st.color}`}>
                {st.label}
              </span>
              {data.archivedAt && (
                <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded border bg-slate-700 text-slate-300 border-slate-500">
                  Arquivado
                </span>
              )}
            </div>
            <p className="text-xs text-slate-400 truncate flex items-center gap-1 mt-0.5">
              <MapPin className="w-3 h-3" />
              {[data.endereco, data.numero, data.bairro, data.cidade, data.estado].filter(Boolean).join(', ') || 'Sem endereço'}
            </p>
          </div>
          <button
            onClick={duplicar}
            className="px-3 py-2 bg-white/5 hover:bg-white/10 border border-white/10 text-xs font-bold rounded-lg flex items-center gap-1.5"
            title="Duplicar"
          >
            <Copy className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Duplicar</span>
          </button>
          {data.archivedAt ? (
            <button
              onClick={desarquivar}
              className="px-3 py-2 bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/40 text-emerald-200 text-xs font-bold rounded-lg flex items-center gap-1.5"
            >
              <ArchiveRestore className="w-3.5 h-3.5" />
              Desarquivar
            </button>
          ) : (
            <button
              onClick={arquivar}
              className="px-3 py-2 bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/40 text-rose-200 text-xs font-bold rounded-lg flex items-center gap-1.5"
            >
              <Archive className="w-3.5 h-3.5" />
              Arquivar
            </button>
          )}
        </div>

        {/* Tabs */}
        <div className="max-w-6xl mx-auto px-6 flex gap-1 overflow-x-auto pb-1">
          {TABS.map((t) => {
            const Icon = t.icon;
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`px-4 py-2.5 text-xs font-bold rounded-t-lg flex items-center gap-1.5 transition whitespace-nowrap ${
                  active
                    ? 'bg-white/10 text-amber-300 border-t-2 border-amber-400'
                    : 'text-slate-400 hover:text-white hover:bg-white/5'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {t.label}
              </button>
            );
          })}
        </div>
      </header>

      <main className="max-w-6xl mx-auto p-6 space-y-4">
        {tab === 'geral' && <TabGeral data={data} id={id} onSave={fetchData} />}
        {tab === 'agua' && (
          <UtilityForm
            title="Conta de Água"
            icon={Droplet}
            data={data.water}
            endpoint={`/properties/${id}/water`}
            propertyId={id}
            scope="water"
            fields={[
              { key: 'companhia', label: 'Companhia (ex: SABESP)' },
              { key: 'titular', label: 'Titular da conta' },
              { key: 'codigoFornecimento', label: 'Código de fornecimento' },
              { key: 'vencimentoDia', label: 'Dia do vencimento (1-31)', type: 'number' },
              { key: 'observacoes', label: 'Observações', type: 'textarea' },
            ]}
            onSaved={fetchData}
          />
        )}
        {tab === 'energia' && (
          <UtilityForm
            title="Conta de Energia"
            icon={Zap}
            data={data.energy}
            endpoint={`/properties/${id}/energy`}
            propertyId={id}
            scope="energy"
            fields={[
              { key: 'companhia', label: 'Companhia (ex: ENEL, CPFL)' },
              { key: 'titular', label: 'Titular' },
              { key: 'codigoCliente', label: 'Código do cliente' },
              { key: 'vencimentoDia', label: 'Dia do vencimento (1-31)', type: 'number' },
              { key: 'observacoes', label: 'Observações', type: 'textarea' },
            ]}
            onSaved={fetchData}
          />
        )}
        {tab === 'iptu' && (
          <UtilityForm
            title="IPTU"
            icon={Receipt}
            data={data.iptu}
            endpoint={`/properties/${id}/iptu`}
            propertyId={id}
            scope="iptu"
            fields={[
              { key: 'proprietario', label: 'Nome do proprietário' },
              { key: 'codigoCadastro', label: 'Código do cadastro' },
              { key: 'valorAnual', label: 'Valor anual (R$)', type: 'number' },
              { key: 'situacao', label: 'Situação', type: 'select', options: [
                { value: 'em_dia', label: 'Em dia' },
                { value: 'em_atraso', label: 'Em atraso' },
                { value: 'parcelado', label: 'Parcelado' },
              ]},
              { key: 'dataVencimento', label: 'Data de vencimento', type: 'date' },
              { key: 'observacoes', label: 'Observações', type: 'textarea' },
            ]}
            onSaved={fetchData}
          />
        )}
        {tab === 'taxas' && <TabTaxas data={data} id={id} onChange={fetchData} />}
        {tab === 'matricula' && (
          <UtilityForm
            title="Matrícula"
            icon={FileText}
            data={data.deed}
            endpoint={`/properties/${id}/deed`}
            propertyId={id}
            scope="deed"
            fields={[
              { key: 'numero', label: 'Número da matrícula' },
              { key: 'cartorio', label: 'Cartório' },
              { key: 'cidadeCartorio', label: 'Cidade do cartório' },
              { key: 'dataEmissao', label: 'Data de emissão', type: 'date' },
              { key: 'observacoes', label: 'Observações', type: 'textarea' },
            ]}
            onSaved={fetchData}
          />
        )}
        {tab === 'escritura' && (
          <UtilityForm
            title="Escritura"
            icon={Scroll}
            data={data.scripture}
            endpoint={`/properties/${id}/scripture`}
            propertyId={id}
            scope="scripture"
            fields={[
              { key: 'numero', label: 'Número da escritura' },
              { key: 'data', label: 'Data', type: 'date' },
              { key: 'livro', label: 'Livro' },
              { key: 'folha', label: 'Folha' },
              { key: 'cartorio', label: 'Cartório' },
              { key: 'observacoes', label: 'Observações', type: 'textarea' },
            ]}
            onSaved={fetchData}
          />
        )}
        {tab === 'historico' && <TabHistorico id={id} />}
      </main>
    </div>
  );
}

// ─── TAB GERAL ──────────────────────────────────────────────────────────
function TabGeral({ data, id, onSave }: any) {
  const [name, setName] = useState(data.name || '');
  const [proprietario, setProprietario] = useState(data.proprietario || '');
  const [status, setStatus] = useState(data.status || 'ativo');
  const [cep, setCep] = useState(data.cep || '');
  const [endereco, setEndereco] = useState(data.endereco || '');
  const [numero, setNumero] = useState(data.numero || '');
  const [complemento, setComplemento] = useState(data.complemento || '');
  const [bairro, setBairro] = useState(data.bairro || '');
  const [cidade, setCidade] = useState(data.cidade || '');
  const [estado, setEstado] = useState(data.estado || '');
  const [observacoes, setObservacoes] = useState(data.observacoes || '');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const salvar = async () => {
    setSaving(true);
    setMsg(null);
    try {
      await api(`/properties/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name, proprietario, status, cep, endereco, numero,
          complemento, bairro, cidade, estado, observacoes,
        }),
      });
      setMsg('✓ Salvo');
      setTimeout(() => setMsg(null), 2000);
      onSave();
    } catch (e: any) {
      setMsg('Erro: ' + e?.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-white/5 border border-white/10 rounded-2xl p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold flex items-center gap-2">
          <Building2 className="w-5 h-5 text-amber-400" />
          Dados gerais
        </h2>
        {msg && <span className="text-xs text-emerald-400">{msg}</span>}
      </div>

      <FieldDark label="Nome do imóvel" value={name} onChange={setName} />
      <FieldDark label="Proprietário" value={proprietario} onChange={setProprietario} />
      <div className="grid grid-cols-2 gap-3">
        <FieldDark label="CEP" value={cep} onChange={(v: string) => setCep(v.replace(/\D/g, '').slice(0, 8))} />
        <SelectDark label="Status" value={status} onChange={setStatus} options={STATUS_OPTIONS} />
      </div>
      <FieldDark label="Logradouro" value={endereco} onChange={setEndereco} />
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <FieldDark label="Número" value={numero} onChange={setNumero} />
        <div className="col-span-2">
          <FieldDark label="Complemento" value={complemento} onChange={setComplemento} />
        </div>
      </div>
      <FieldDark label="Bairro" value={bairro} onChange={setBairro} />
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <div className="col-span-2">
          <FieldDark label="Cidade" value={cidade} onChange={setCidade} />
        </div>
        <FieldDark label="UF" value={estado} onChange={(v: string) => setEstado(v.toUpperCase().slice(0, 2))} />
      </div>
      <FieldDark label="Observações" value={observacoes} onChange={setObservacoes} type="textarea" />

      <button
        onClick={salvar}
        disabled={saving}
        className="w-full mt-3 px-5 py-3 bg-gradient-to-br from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-white font-bold rounded-lg shadow-lg disabled:opacity-50 flex items-center justify-center gap-2"
      >
        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
        Salvar alterações
      </button>
    </div>
  );
}

// ─── UTILITY FORM GENÉRICO (água, energia, IPTU, matrícula, escritura) ──
function UtilityForm({ title, icon: Icon, data, endpoint, fields, onSaved, propertyId, scope }: any) {
  const [form, setForm] = useState<any>(() => {
    const init: any = {};
    for (const f of fields) {
      let v = data?.[f.key] ?? '';
      if (f.type === 'date' && v) {
        v = new Date(v).toISOString().slice(0, 10);
      }
      init[f.key] = v;
    }
    return init;
  });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const salvar = async () => {
    setSaving(true);
    setMsg(null);
    try {
      await api(endpoint, { method: 'PATCH', body: JSON.stringify(form) });
      setMsg('✓ Salvo');
      setTimeout(() => setMsg(null), 2000);
      onSaved();
    } catch (e: any) {
      setMsg('Erro: ' + e?.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-white/5 border border-white/10 rounded-2xl p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold flex items-center gap-2">
          <Icon className="w-5 h-5 text-amber-400" />
          {title}
        </h2>
        {msg && <span className="text-xs text-emerald-400">{msg}</span>}
      </div>

      {fields.map((f: any) => (
        <div key={f.key}>
          {f.type === 'select' ? (
            <SelectDark
              label={f.label}
              value={form[f.key] || ''}
              onChange={(v: string) => setForm({ ...form, [f.key]: v })}
              options={f.options}
            />
          ) : (
            <FieldDark
              label={f.label}
              value={form[f.key] ?? ''}
              onChange={(v: string) => setForm({ ...form, [f.key]: v })}
              type={f.type}
            />
          )}
        </div>
      ))}

      {/* Upload do PDF/JPG da seção (carnê IPTU, conta, escritura, etc) */}
      {propertyId && scope && (
        <UploadSlot
          propertyId={propertyId}
          scope={scope}
          currentUrl={data?.attachmentUrl}
          onUploaded={onSaved}
          label="📎 Anexo principal (PDF/JPG)"
        />
      )}

      <button
        onClick={salvar}
        disabled={saving}
        className="w-full mt-3 px-5 py-3 bg-gradient-to-br from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-white font-bold rounded-lg shadow-lg disabled:opacity-50 flex items-center justify-center gap-2"
      >
        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
        Salvar
      </button>
    </div>
  );
}

// ─── TAB TAXAS ──────────────────────────────────────────────────────────
function TabTaxas({ data, id, onChange }: any) {
  const taxas = data.taxes || [];
  const [adding, setAdding] = useState(false);
  const [tipo, setTipo] = useState('condominio');
  const [valor, setValor] = useState('');
  const [vencimentoDia, setVencimentoDia] = useState('');
  const [codigo, setCodigo] = useState('');
  const [nome, setNome] = useState('');

  const tiposPadrao = [
    { value: 'condominio', label: 'Condomínio' },
    { value: 'lixo', label: 'Taxa de Lixo' },
    { value: 'foro', label: 'Foro' },
    { value: 'associacao', label: 'Associação' },
    { value: 'outros', label: 'Outros (especifique)' },
  ];

  const adicionar = async () => {
    if (!valor && !codigo) {
      alert('Informe ao menos valor ou código');
      return;
    }
    try {
      await api(`/properties/${id}/taxes`, {
        method: 'POST',
        body: JSON.stringify({
          tipo, valor: valor ? Number(valor.replace(',', '.')) : null,
          vencimentoDia: vencimentoDia ? Number(vencimentoDia) : null,
          codigo, nome,
        }),
      });
      setTipo('condominio');
      setValor('');
      setVencimentoDia('');
      setCodigo('');
      setNome('');
      setAdding(false);
      onChange();
    } catch (e: any) {
      alert('Erro: ' + e?.message);
    }
  };

  const remover = async (taxId: string) => {
    if (!confirm('Remover essa taxa?')) return;
    try {
      await api(`/properties/taxes/${taxId}`, { method: 'DELETE' });
      onChange();
    } catch (e: any) {
      alert('Erro: ' + e?.message);
    }
  };

  return (
    <div className="space-y-3">
      <div className="bg-white/5 border border-white/10 rounded-2xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold flex items-center gap-2">
            <Tag className="w-5 h-5 text-amber-400" />
            Taxas ({taxas.length})
          </h2>
          {!adding && (
            <button
              onClick={() => setAdding(true)}
              className="flex items-center gap-1.5 px-3 py-2 bg-amber-500 hover:bg-amber-400 text-white text-xs font-bold rounded-lg"
            >
              <Plus className="w-3.5 h-3.5" />
              Nova taxa
            </button>
          )}
        </div>

        {adding && (
          <div className="bg-black/20 border border-amber-500/30 rounded-xl p-4 space-y-3 mb-4">
            <SelectDark
              label="Tipo"
              value={tipo}
              onChange={setTipo}
              options={tiposPadrao}
            />
            {tipo === 'outros' && (
              <FieldDark label="Nome da taxa" value={nome} onChange={setNome} />
            )}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <FieldDark label="Valor (R$)" value={valor} onChange={setValor} />
              <FieldDark label="Dia vencimento" value={vencimentoDia} onChange={setVencimentoDia} type="number" />
              <FieldDark label="Código (opcional)" value={codigo} onChange={setCodigo} />
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setAdding(false)}
                className="px-4 py-2 text-xs font-bold text-slate-300 hover:bg-white/5 rounded"
              >
                Cancelar
              </button>
              <button
                onClick={adicionar}
                className="flex-1 px-4 py-2 bg-amber-500 hover:bg-amber-400 text-white text-xs font-bold rounded"
              >
                Adicionar taxa
              </button>
            </div>
          </div>
        )}

        {taxas.length === 0 ? (
          <div className="text-center py-8 text-slate-500 text-sm">
            Nenhuma taxa cadastrada
          </div>
        ) : (
          <div className="space-y-2">
            {taxas.map((t: any) => (
              <div key={t.id} className="flex items-center gap-3 p-3 bg-white/5 border border-white/5 rounded-lg">
                <div className="flex-1">
                  <div className="font-bold text-sm capitalize">
                    {t.tipo === 'outros' ? t.nome || 'Outros' : t.tipo}
                  </div>
                  <div className="text-xs text-slate-400 flex gap-3 mt-0.5">
                    {t.valor && <span>R$ {Number(t.valor).toFixed(2)}</span>}
                    {t.vencimentoDia && <span>vence dia {t.vencimentoDia}</span>}
                    {t.codigo && <span>cód {t.codigo}</span>}
                  </div>
                </div>
                <button
                  onClick={() => remover(t.id)}
                  className="p-2 text-rose-400 hover:bg-rose-500/10 rounded"
                  title="Remover"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── UPLOAD SLOT (botão + dropzone reutilizável) ───────────────────────
// Usado nas seções Água/Energia/IPTU/Matrícula/Escritura (1 arquivo único
// que sobrescreve, salvo em attachmentUrl da própria seção) E na aba Anexos
// (múltiplos, salvo em PropertyAttachment).
function UploadSlot({
  propertyId,
  scope,
  currentUrl,
  onUploaded,
  label,
  accept,
}: {
  propertyId: string;
  scope?: 'water' | 'energy' | 'iptu' | 'deed' | 'scripture';
  currentUrl?: string | null;
  onUploaded: () => void;
  label?: string;
  accept?: string;
}) {
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const doUpload = async (file: File) => {
    setError(null);
    if (file.size > 10 * 1024 * 1024) {
      setError('Arquivo maior que 10MB');
      return;
    }
    setUploading(true);
    try {
      const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_token') : null;
      const fd = new FormData();
      fd.append('file', file);
      if (scope) fd.append('scope', scope);
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || `${window.location.protocol}//${window.location.hostname}:3001`;
      const r = await fetch(`${apiUrl}/api/properties/${propertyId}/upload`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        body: fd,
      });
      if (!r.ok) {
        const t = await r.text();
        throw new Error(`${r.status}: ${t}`);
      }
      onUploaded();
    } catch (e: any) {
      setError(e?.message || 'Erro no upload');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-2">
      {label && <div className="text-xs font-bold text-slate-300">{label}</div>}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const f = e.dataTransfer.files?.[0];
          if (f) doUpload(f);
        }}
        className={`border-2 border-dashed rounded-xl p-4 transition ${
          dragOver
            ? 'border-amber-400 bg-amber-500/10'
            : 'border-white/20 bg-white/5 hover:bg-white/10'
        }`}
      >
        {uploading ? (
          <div className="flex items-center justify-center gap-2 py-2">
            <Loader2 className="w-4 h-4 animate-spin text-amber-400" />
            <span className="text-sm text-slate-300">Enviando...</span>
          </div>
        ) : currentUrl ? (
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-emerald-500/20 rounded-lg flex items-center justify-center">
              <FileText className="w-5 h-5 text-emerald-400" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xs text-emerald-300 font-bold">✓ Arquivo anexado</div>
              <a
                href={currentUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] text-slate-400 hover:text-white truncate block underline"
              >
                {currentUrl.split('/').pop()?.split('?')[0]}
              </a>
            </div>
            <a
              href={currentUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="px-3 py-1.5 bg-white/10 hover:bg-white/20 rounded text-xs font-bold"
            >
              Ver
            </a>
            <label className="px-3 py-1.5 bg-amber-500 hover:bg-amber-400 text-white rounded text-xs font-bold cursor-pointer">
              Trocar
              <input
                type="file"
                accept={accept || '.pdf,.jpg,.jpeg,.png'}
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) doUpload(f);
                }}
              />
            </label>
          </div>
        ) : (
          <label className="cursor-pointer flex flex-col items-center justify-center gap-2 py-3 text-center">
            <div className="w-12 h-12 rounded-full bg-amber-500/20 flex items-center justify-center">
              <Plus className="w-6 h-6 text-amber-400" />
            </div>
            <div className="text-sm font-bold text-slate-200">Arraste o arquivo aqui</div>
            <div className="text-[10px] text-slate-500">ou clique pra escolher · PDF / JPG / PNG · máx 10MB</div>
            <input
              type="file"
              accept={accept || '.pdf,.jpg,.jpeg,.png'}
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) doUpload(f);
              }}
            />
          </label>
        )}
        {error && (
          <div className="mt-2 text-xs text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded p-2">
            ⚠ {error}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── TAB HISTÓRICO ──────────────────────────────────────────────────────
function TabHistorico({ id }: { id: string }) {
  const [logs, setLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<any[]>(`/properties/${id}/logs`)
      .then(setLogs)
      .catch(() => setLogs([]))
      .finally(() => setLoading(false));
  }, [id]);

  return (
    <div className="bg-white/5 border border-white/10 rounded-2xl p-6">
      <h2 className="text-lg font-bold flex items-center gap-2 mb-4">
        <History className="w-5 h-5 text-amber-400" />
        Histórico de alterações
      </h2>
      {loading ? (
        <Loader2 className="w-6 h-6 animate-spin text-amber-400 mx-auto" />
      ) : logs.length === 0 ? (
        <div className="text-center py-8 text-slate-500 text-sm">Nenhuma alteração registrada</div>
      ) : (
        <div className="space-y-2">
          {logs.map((log) => (
            <div key={log.id} className="flex items-start gap-3 p-3 bg-white/5 rounded-lg">
              <div className="w-8 h-8 rounded-full bg-amber-500/20 flex items-center justify-center shrink-0">
                <Calendar className="w-4 h-4 text-amber-400" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm">
                  <b>{log.userName || 'Sistema'}</b>
                  <span className="text-slate-400"> · {log.action} · {log.scope}</span>
                </div>
                <div className="text-[11px] text-slate-500 mt-0.5">
                  {new Date(log.createdAt).toLocaleString('pt-BR')}
                </div>
                {log.details && (
                  <pre className="text-[10px] text-slate-400 mt-1 bg-black/20 rounded p-2 overflow-auto max-h-32">
                    {(() => {
                      try { return JSON.stringify(JSON.parse(log.details), null, 2); }
                      catch { return log.details; }
                    })()}
                  </pre>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── INPUTS REUSÁVEIS ──────────────────────────────────────────────────
function FieldDark({ label, value, onChange, type }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <label className="block">
      <span className="text-xs font-bold text-slate-300 mb-1.5 block">{label}</span>
      {type === 'textarea' ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={3}
          className="w-full px-3 py-2.5 bg-white/5 border border-white/10 rounded-lg text-white placeholder:text-slate-500 focus:outline-none focus:border-amber-400 resize-y"
        />
      ) : (
        <input
          type={type === 'date' ? 'date' : type === 'number' ? 'text' : 'text'}
          inputMode={type === 'number' ? 'decimal' : undefined}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full px-3 py-2.5 bg-white/5 border border-white/10 rounded-lg text-white placeholder:text-slate-500 focus:outline-none focus:border-amber-400"
        />
      )}
    </label>
  );
}
function SelectDark({ label, value, onChange, options }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <label className="block">
      <span className="text-xs font-bold text-slate-300 mb-1.5 block">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-3 py-2.5 bg-white/5 border border-white/10 rounded-lg text-white focus:outline-none focus:border-amber-400"
      >
        <option value="" className="bg-slate-800">— Selecione —</option>
        {options.map((o: any) => (
          <option key={o.value} value={o.value} className="bg-slate-800">{o.label}</option>
        ))}
      </select>
    </label>
  );
}
