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
 *   - Gestão de Obra
 *   - Ficha p/ Corretores
 *   - Histórico (logs)
 *
 * ORDER ONE · Executive Operations UI (15/09/2026): casca navy, faixa de
 * comando com o DOSSIÊ do imóvel (os 5 documentos clicáveis, levando à aba)
 * e a folha branca com as abas. Mesma lógica, mesmas chamadas de antes.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  ArrowLeft, Building2, Loader2, Save, Archive, ArchiveRestore,
  Copy, MapPin, Droplet, Zap, Receipt, FileText, Scroll, History,
  Plus, Trash2, AlertCircle, Tag, Megaphone, HardHat, Check, AlertTriangle,
  X, UploadCloud, NotebookPen, ChevronDown,
} from 'lucide-react';
import { api } from '@/lib/api';
import { PropertyCommercialTab } from '@/components/imobiliario/PropertyCommercialTab';
import { PropertyConstructionTab } from '@/components/imobiliario/PropertyConstructionTab';
import EnterpriseShell from '@/components/enterprise/EnterpriseShell';
import PageHeader from '@/components/enterprise/PageHeader';
import { EmptyState } from '@/components/enterprise/Indicators';
import {
  BarraAcoes, BTN_ESCURO, BTN_PRIMARIO, BTN_SECUNDARIO, CAMPO, ROTULO, Secao,
} from '@/components/enterprise/Form';

type Property = any;

const STATUS_OPTIONS = [
  { value: 'ativo', label: 'Ativo', ponto: 'bg-[#47CD89]' },
  { value: 'em_construcao', label: 'Em Construção', ponto: 'bg-[#53B1FD]' },
  { value: 'pronta_locacao', label: 'Pronta p/ Locação', ponto: 'bg-white' },
  { value: 'vendido', label: 'Vendido', ponto: 'border-[1.5px] border-slate-400' },
  { value: 'inativo', label: 'Inativo', ponto: 'border-[1.5px] border-slate-400' },
];

const TABS = [
  { id: 'geral', label: 'Geral', icon: Building2 },
  { id: 'agua', label: 'Água', icon: Droplet },
  { id: 'energia', label: 'Energia', icon: Zap },
  { id: 'iptu', label: 'IPTU', icon: Receipt },
  { id: 'taxas', label: 'Taxas', icon: Tag },
  { id: 'matricula', label: 'Matrícula', icon: FileText },
  { id: 'escritura', label: 'Escritura', icon: Scroll },
  { id: 'obras', label: 'Gestão de Obra', icon: HardHat },
  { id: 'corretores', label: 'Ficha p/ Corretores', icon: Megaphone },
  { id: 'historico', label: 'Histórico', icon: History },
];

const SITUACAO_IPTU: Record<string, string> = { em_dia: 'Em dia', em_atraso: 'Em atraso', parcelado: 'Parcelado' };
const MESES = ['JAN', 'FEV', 'MAR', 'ABR', 'MAI', 'JUN', 'JUL', 'AGO', 'SET', 'OUT', 'NOV', 'DEZ'];

/** data só-dia gravada à meia-noite UTC → lê pela parte UTC */
function dataCurta(v: string | null | undefined): string | null {
  if (!v) return null;
  const [a, m, d] = new Date(v).toISOString().slice(0, 10).split('-');
  return `${d} ${MESES[Number(m) - 1]} ${a}`;
}

export default function ImovelDetailPage() {
  const router = useRouter();
  const params = useParams();
  const id = params?.id as string;

  const [data, setData] = useState<Property | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState('geral');

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

  const trilhaBase = [{ label: 'Início', href: '/' }, { label: 'Imobiliário', href: '/imobiliario' }];

  if (loading && !data) {
    return (
      <EnterpriseShell trilha={[...trilhaBase, { label: 'Carregando…' }]}>
        <div className="bg-oo-nav pb-20">
          <div className="mx-auto w-full max-w-[1600px] px-4 pt-8 sm:px-6 2xl:px-12">
            <div className="h-4 w-20 animate-pulse rounded bg-white/10" />
            <div className="mt-5 h-9 w-72 max-w-full animate-pulse rounded bg-white/10" />
            <div className="mt-3 h-4 w-96 max-w-full animate-pulse rounded bg-white/10" />
            <div className="mt-8 h-24 animate-pulse rounded-lg bg-white/[0.06]" />
          </div>
        </div>
        <main className="mx-auto -mt-12 w-full max-w-[1600px] px-4 pb-12 sm:px-6 2xl:px-12">
          <div className="flex h-72 items-center justify-center rounded-xl border border-oo-line bg-oo-surface">
            <Loader2 className="h-6 w-6 animate-spin text-oo-primary" />
          </div>
        </main>
      </EnterpriseShell>
    );
  }
  if (error || !data) {
    return (
      <EnterpriseShell trilha={[...trilhaBase, { label: 'Imóvel' }]}>
        <main className="mx-auto w-full max-w-[720px] px-4 py-12 sm:px-6">
          <div className="rounded-xl border border-oo-line bg-oo-surface">
            <EmptyState
              icone={<AlertCircle className="h-5 w-5 text-oo-danger" />}
              titulo={error || 'Imóvel não encontrado'}
              acoes={
                <Link href="/imobiliario" className={BTN_SECUNDARIO}>
                  <ArrowLeft className="h-4 w-4" />
                  Voltar pra lista
                </Link>
              }
            />
          </div>
        </main>
      </EnterpriseShell>
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

  const endereco = [data.endereco, data.numero, data.bairro, data.cidade, data.estado].filter(Boolean).join(', ') || 'Sem endereço';
  const docsFaltando = new Set(
    [
      !data.water && 'agua',
      !data.energy && 'energia',
      !data.iptu && 'iptu',
      !data.deed && 'matricula',
      !data.scripture && 'escritura',
    ].filter(Boolean) as string[],
  );

  return (
    <EnterpriseShell trilha={[...trilhaBase, { label: data.name }]}>
      {/* Faixa de comando */}
      <div className="bg-oo-nav pb-16 sm:pb-20">
        <div className="mx-auto w-full max-w-[1600px] px-4 pt-6 sm:px-6 sm:pt-8 2xl:px-12">
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
            titulo={<span className="break-words">{data.name}</span>}
            subtitulo={
              <span className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                <span className="inline-flex items-center gap-2 font-semibold text-white">
                  <span className={`h-2 w-2 rounded-full ${st.ponto}`} aria-hidden="true" />
                  {st.label}
                </span>
                {data.archivedAt && (
                  <span className="inline-flex items-center gap-1 rounded border border-white/20 px-1.5 py-px text-[11px] font-semibold uppercase tracking-[0.04em] text-slate-300">
                    <Archive className="h-3 w-3" />
                    Arquivado
                  </span>
                )}
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <MapPin className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{endereco}</span>
                </span>
              </span>
            }
            acoes={
              <>
                <button onClick={duplicar} className={BTN_ESCURO} title="Duplicar">
                  <Copy className="h-4 w-4" />
                  <span className="hidden sm:inline">Duplicar</span>
                </button>
                {data.archivedAt ? (
                  <button onClick={desarquivar} className={BTN_ESCURO}>
                    <ArchiveRestore className="h-4 w-4" />
                    Desarquivar
                  </button>
                ) : (
                  <button onClick={arquivar} className={`${BTN_ESCURO} hover:border-[#FF8A7A]/50 hover:text-[#FF8A7A]`}>
                    <Archive className="h-4 w-4" />
                    Arquivar
                  </button>
                )}
              </>
            }
          />

          {/* Dossiê: os documentos do imóvel, cada um leva à sua aba */}
          <div className="mt-6 flex gap-px overflow-x-auto rounded-lg border border-white/10 bg-white/10 [scrollbar-width:none] sm:mt-8">
            <CelulaDossie
              rotulo="Água"
              ativo={tab === 'agua'}
              onClick={() => setTab('agua')}
              estado={data.water ? 'ok' : 'pendente'}
              valor={data.water ? 'Cadastrada' : 'Pendente'}
              detalhe={data.water ? (data.water.vencimentoDia ? `vence dia ${data.water.vencimentoDia}` : data.water.companhia || null) : 'sem cadastro'}
              anexo={!!data.water?.attachmentUrl}
            />
            <CelulaDossie
              rotulo="Energia"
              ativo={tab === 'energia'}
              onClick={() => setTab('energia')}
              estado={data.energy ? 'ok' : 'pendente'}
              valor={data.energy ? 'Cadastrada' : 'Pendente'}
              detalhe={data.energy ? (data.energy.vencimentoDia ? `vence dia ${data.energy.vencimentoDia}` : data.energy.companhia || null) : 'sem cadastro'}
              anexo={!!data.energy?.attachmentUrl}
            />
            <CelulaDossie
              rotulo="IPTU"
              ativo={tab === 'iptu'}
              onClick={() => setTab('iptu')}
              estado={!data.iptu ? 'pendente' : data.iptu.situacao === 'em_atraso' ? 'critico' : 'ok'}
              valor={!data.iptu ? 'Pendente' : SITUACAO_IPTU[data.iptu.situacao] || 'Cadastrado'}
              detalhe={!data.iptu ? 'sem cadastro' : dataCurta(data.iptu.dataVencimento) ? `venc. ${dataCurta(data.iptu.dataVencimento)}` : 'sem vencimento'}
              anexo={!!data.iptu?.attachmentUrl}
            />
            <CelulaDossie
              rotulo="Matrícula"
              ativo={tab === 'matricula'}
              onClick={() => setTab('matricula')}
              estado={data.deed ? 'ok' : 'pendente'}
              valor={data.deed ? 'Cadastrada' : 'Pendente'}
              detalhe={data.deed ? (data.deed.numero ? `nº ${data.deed.numero}` : data.deed.cartorio || null) : 'sem cadastro'}
              anexo={!!data.deed?.attachmentUrl}
            />
            <CelulaDossie
              rotulo="Escritura"
              ativo={tab === 'escritura'}
              onClick={() => setTab('escritura')}
              estado={data.scripture ? 'ok' : 'pendente'}
              valor={data.scripture ? 'Cadastrada' : 'Pendente'}
              detalhe={data.scripture ? (data.scripture.numero ? `nº ${data.scripture.numero}` : data.scripture.cartorio || null) : 'sem cadastro'}
              anexo={!!data.scripture?.attachmentUrl}
            />
            <CelulaDossie
              rotulo="Taxas"
              ativo={tab === 'taxas'}
              onClick={() => setTab('taxas')}
              estado="neutro"
              valor={`${(data.taxes || []).length} ${(data.taxes || []).length === 1 ? 'taxa' : 'taxas'}`}
              detalhe="condomínio, lixo, foro…"
            />
          </div>
        </div>
      </div>

      <main className="mx-auto -mt-10 w-full max-w-[1600px] px-4 pb-12 sm:-mt-12 sm:px-6 2xl:px-12">
        <div className="rounded-xl border border-oo-line bg-oo-surface shadow-[0_1px_2px_rgba(16,24,40,.06),0_8px_24px_-12px_rgba(16,24,40,.12)]">
          {/* Abas */}
          <div className="flex overflow-x-auto border-b border-oo-line px-2 [scrollbar-width:none] sm:px-4" role="tablist" aria-label="Seções do imóvel">
            {TABS.map((t) => {
              const Icon = t.icon;
              const active = tab === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setTab(t.id)}
                  className={`relative flex h-12 shrink-0 items-center gap-2 px-3 text-[13px] font-semibold transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-oo-primary ${
                    active ? 'text-oo-ink' : 'text-oo-muted hover:text-oo-ink'
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  {t.label}
                  {docsFaltando.has(t.id) && <span className="h-1.5 w-1.5 rounded-full bg-oo-warning" title="Pendente" />}
                  {active && <span className="absolute inset-x-3 bottom-0 h-[2px] bg-oo-ink" />}
                </button>
              );
            })}
          </div>

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
          {tab === 'obras' && (
            <div className="p-5 sm:p-8">
              <PropertyConstructionTab propertyId={id} />
            </div>
          )}
          {tab === 'corretores' && (
            <div className="p-5 sm:p-8">
              <PropertyCommercialTab propertyId={id} />
            </div>
          )}
          {tab === 'historico' && <TabHistorico id={id} />}
        </div>
      </main>
    </EnterpriseShell>
  );
}

// ─── CÉLULA DO DOSSIÊ (faixa navy) ──────────────────────────────────────
function CelulaDossie({
  rotulo,
  valor,
  detalhe,
  estado,
  anexo,
  ativo,
  onClick,
}: {
  rotulo: string;
  valor: string;
  detalhe?: string | null;
  estado: 'ok' | 'pendente' | 'critico' | 'neutro';
  anexo?: boolean;
  ativo: boolean;
  onClick: () => void;
}) {
  const icone =
    estado === 'ok' ? <Check className="h-4 w-4 text-[#47CD89]" strokeWidth={2.5} /> :
    estado === 'pendente' ? <AlertTriangle className="h-4 w-4 text-[#FDB022]" /> :
    estado === 'critico' ? <X className="h-4 w-4 text-[#FF8A7A]" strokeWidth={2.5} /> :
    <Tag className="h-4 w-4 text-slate-400" />;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={ativo}
      className={`group relative min-w-[150px] flex-1 px-4 py-4 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/60 sm:px-5 ${
        ativo ? 'bg-oo-nav-2' : 'bg-oo-nav hover:bg-oo-nav-2'
      }`}
    >
      <span className="block text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-400">{rotulo}</span>
      <span
        className={`mt-2 flex items-center gap-2 text-[15px] font-semibold ${
          estado === 'pendente' ? 'text-[#FDB022]' : estado === 'critico' ? 'text-[#FF8A7A]' : 'text-white'
        }`}
      >
        {icone}
        {valor}
      </span>
      <span className="mt-1 flex items-center gap-2 truncate text-[12px] text-slate-400">
        {detalhe && <span className="truncate">{detalhe}</span>}
        {anexo && (
          <span className="inline-flex shrink-0 items-center gap-1 text-slate-300" title="Arquivo anexado">
            <FileText className="h-3 w-3" />
            anexo
          </span>
        )}
      </span>
      {ativo && <span className="absolute inset-x-0 bottom-0 h-[2px] bg-oo-primary" />}
    </button>
  );
}

// ─── FEEDBACK DE SALVAR ─────────────────────────────────────────────────
function Feedback({ msg }: { msg: string | null }) {
  if (!msg) return null;
  const erro = msg.startsWith('Erro');
  return (
    <span className={`inline-flex items-center gap-1.5 ${erro ? 'text-oo-danger' : 'text-oo-success'}`} role="status">
      {erro ? <AlertCircle className="h-4 w-4" /> : <Check className="h-4 w-4" strokeWidth={2.5} />}
      {msg.replace(/^✓\s*/, '')}
    </span>
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
    <div>
      <Secao titulo="Dados gerais" icone={<Building2 className="h-4 w-4" />} descricao="Nome, proprietário e situação do imóvel.">
        <div className="grid gap-4 sm:grid-cols-2">
          <FieldLight label="Nome do imóvel" value={name} onChange={setName} className="sm:col-span-2" />
          <FieldLight label="Proprietário" value={proprietario} onChange={setProprietario} />
          <SelectLight label="Status" value={status} onChange={setStatus} options={STATUS_OPTIONS} />
        </div>
      </Secao>
      <Secao titulo="Endereço" icone={<MapPin className="h-4 w-4" />}>
        <div className="grid gap-4 sm:grid-cols-6">
          <FieldLight label="CEP" value={cep} onChange={(v: string) => setCep(v.replace(/\D/g, '').slice(0, 8))} className="sm:col-span-2" />
          <FieldLight label="Logradouro" value={endereco} onChange={setEndereco} className="sm:col-span-4" />
          <FieldLight label="Número" value={numero} onChange={setNumero} className="sm:col-span-2" />
          <FieldLight label="Complemento" value={complemento} onChange={setComplemento} className="sm:col-span-4" />
          <FieldLight label="Bairro" value={bairro} onChange={setBairro} className="sm:col-span-2" />
          <FieldLight label="Cidade" value={cidade} onChange={setCidade} className="sm:col-span-3" />
          <FieldLight label="UF" value={estado} onChange={(v: string) => setEstado(v.toUpperCase().slice(0, 2))} />
        </div>
      </Secao>
      <Secao titulo="Observações" icone={<NotebookPen className="h-4 w-4" />}>
        <FieldLight label="Observações" value={observacoes} onChange={setObservacoes} type="textarea" />
      </Secao>
      <BarraAcoes feedback={<Feedback msg={msg} />}>
        <button onClick={salvar} disabled={saving} className={BTN_PRIMARIO}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Salvar alterações
        </button>
      </BarraAcoes>
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
    <div>
      <Secao
        titulo={title}
        icone={<Icon className="h-4 w-4" />}
        descricao={data ? 'Registro cadastrado. Edite e salve para atualizar.' : 'Ainda não cadastrado — preencha e salve.'}
        acao={
          data ? (
            <span className="inline-flex items-center gap-1.5 rounded bg-oo-success-soft px-2 py-0.5 text-[12px] font-semibold text-oo-success">
              <Check className="h-3.5 w-3.5" strokeWidth={2.5} /> Cadastrado
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded bg-oo-warning-soft px-2 py-0.5 text-[12px] font-semibold text-oo-warning">
              <AlertTriangle className="h-3.5 w-3.5" /> Pendente
            </span>
          )
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          {fields.map((f: any) =>
            f.type === 'select' ? (
              <SelectLight
                key={f.key}
                label={f.label}
                value={form[f.key] || ''}
                onChange={(v: string) => setForm({ ...form, [f.key]: v })}
                options={f.options}
              />
            ) : (
              <FieldLight
                key={f.key}
                label={f.label}
                value={form[f.key] ?? ''}
                onChange={(v: string) => setForm({ ...form, [f.key]: v })}
                type={f.type}
                className={f.type === 'textarea' ? 'sm:col-span-2' : undefined}
              />
            ),
          )}
        </div>
      </Secao>

      {/* Upload do PDF/JPG da seção (carnê IPTU, conta, escritura, etc) */}
      {propertyId && scope && (
        <Secao titulo="Anexo principal" icone={<UploadCloud className="h-4 w-4" />} descricao="Anexo principal (PDF/JPG)">
          <UploadSlot propertyId={propertyId} scope={scope} currentUrl={data?.attachmentUrl} onUploaded={onSaved} />
        </Secao>
      )}

      <BarraAcoes feedback={<Feedback msg={msg} />}>
        <button onClick={salvar} disabled={saving} className={BTN_PRIMARIO}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Salvar
        </button>
      </BarraAcoes>
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
    <div className="px-5 py-6 sm:px-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 font-oo-display text-[16px] font-semibold text-oo-ink">
          <Tag className="h-4 w-4 text-oo-muted" />
          Taxas <span className="rounded bg-oo-hover px-1.5 py-0.5 text-[12px] font-semibold tabular-nums text-oo-ink-2">{taxas.length}</span>
        </h2>
        {!adding && (
          <button onClick={() => setAdding(true)} className={BTN_PRIMARIO}>
            <Plus className="h-4 w-4" strokeWidth={2.5} />
            Nova taxa
          </button>
        )}
      </div>

      {adding && (
        <div className="mt-4 rounded-lg border border-oo-line bg-oo-subtle p-4 sm:p-5">
          <div className="grid gap-4 sm:grid-cols-3">
            <SelectLight label="Tipo" value={tipo} onChange={setTipo} options={tiposPadrao} className="sm:col-span-3" />
            {tipo === 'outros' && <FieldLight label="Nome da taxa" value={nome} onChange={setNome} className="sm:col-span-3" />}
            <FieldLight label="Valor (R$)" value={valor} onChange={setValor} />
            <FieldLight label="Dia vencimento" value={vencimentoDia} onChange={setVencimentoDia} type="number" />
            <FieldLight label="Código (opcional)" value={codigo} onChange={setCodigo} />
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <button onClick={() => setAdding(false)} className={BTN_SECUNDARIO}>
              Cancelar
            </button>
            <button onClick={adicionar} className={BTN_PRIMARIO}>
              Adicionar taxa
            </button>
          </div>
        </div>
      )}

      {taxas.length === 0 ? (
        <div className="mt-4 rounded-lg border border-dashed border-oo-line-strong py-10 text-center text-[14px] text-oo-ink-2">
          Nenhuma taxa cadastrada
        </div>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-lg border border-oo-line">
          <table className="w-full text-[14px]">
            <thead>
              <tr className="border-b border-oo-line bg-oo-subtle text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-oo-ink-2">
                <th className="px-4 py-2.5">Tipo</th>
                <th className="px-4 py-2.5 text-right">Valor</th>
                <th className="px-4 py-2.5">Vencimento</th>
                <th className="px-4 py-2.5">Código</th>
                <th className="w-12 px-2 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-oo-line">
              {taxas.map((t: any) => (
                <tr key={t.id} className="transition-colors hover:bg-oo-subtle">
                  <td className="px-4 py-3 font-semibold capitalize text-oo-ink">{t.tipo === 'outros' ? t.nome || 'Outros' : t.tipo}</td>
                  <td className="px-4 py-3 text-right font-semibold tabular-nums text-oo-ink">{t.valor ? `R$ ${Number(t.valor).toFixed(2)}` : '—'}</td>
                  <td className="px-4 py-3 text-oo-ink-2">{t.vencimentoDia ? `vence dia ${t.vencimentoDia}` : '—'}</td>
                  <td className="px-4 py-3 tabular-nums text-oo-ink-2">{t.codigo ? `cód ${t.codigo}` : '—'}</td>
                  <td className="px-2 py-3 text-right">
                    <button
                      onClick={() => remover(t.id)}
                      className="grid h-8 w-8 place-items-center rounded-md text-oo-muted transition-colors hover:bg-oo-danger-soft hover:text-oo-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oo-danger"
                      title="Remover"
                      aria-label="Remover"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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
      {label && <div className={ROTULO}>{label}</div>}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const f = e.dataTransfer.files?.[0];
          if (f) doUpload(f);
        }}
        className={`rounded-lg border-2 border-dashed p-4 transition-colors duration-150 ${
          dragOver ? 'border-oo-primary bg-oo-primary/5' : 'border-oo-line-strong bg-oo-subtle hover:bg-oo-hover'
        }`}
      >
        {uploading ? (
          <div className="flex items-center justify-center gap-2 py-2">
            <Loader2 className="h-4 w-4 animate-spin text-oo-primary" />
            <span className="text-[14px] font-medium text-oo-ink-2">Enviando...</span>
          </div>
        ) : currentUrl ? (
          <div className="flex flex-wrap items-center gap-3">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-md border border-oo-success/20 bg-oo-success-soft">
              <FileText className="h-5 w-5 text-oo-success" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold text-oo-success">✓ Arquivo anexado</div>
              <a
                href={currentUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="block truncate text-[12px] text-oo-ink-2 underline underline-offset-2 hover:text-oo-ink"
              >
                {currentUrl.split('/').pop()?.split('?')[0]}
              </a>
            </div>
            <a href={currentUrl} target="_blank" rel="noopener noreferrer" className={`${BTN_SECUNDARIO} h-9`}>
              Ver
            </a>
            <label className={`${BTN_PRIMARIO} h-9 cursor-pointer`}>
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
          <label className="flex cursor-pointer flex-col items-center justify-center gap-2 py-3 text-center">
            <div className="grid h-11 w-11 place-items-center rounded-full border border-oo-line bg-oo-surface">
              <UploadCloud className="h-5 w-5 text-oo-ink-2" />
            </div>
            <div className="text-[14px] font-semibold text-oo-ink">Arraste o arquivo aqui</div>
            <div className="text-[12px] text-oo-muted">ou clique pra escolher · PDF / JPG / PNG · máx 10MB</div>
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
          <div className="mt-3 flex items-center gap-2 rounded-md border border-oo-danger/20 bg-oo-danger-soft px-3 py-2 text-[13px] font-medium text-oo-danger">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {error}
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
    <div className="px-5 py-6 sm:px-8">
      <h2 className="flex items-center gap-2 font-oo-display text-[16px] font-semibold text-oo-ink">
        <History className="h-4 w-4 text-oo-muted" />
        Histórico de alterações
      </h2>
      {loading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="h-6 w-6 animate-spin text-oo-primary" />
        </div>
      ) : logs.length === 0 ? (
        <div className="mt-4 rounded-lg border border-dashed border-oo-line-strong py-10 text-center text-[14px] text-oo-ink-2">
          Nenhuma alteração registrada
        </div>
      ) : (
        <ol className="relative mt-5 space-y-5 border-l border-oo-line pl-6">
          {logs.map((log) => (
            <li key={log.id} className="relative">
              <span className="absolute -left-[31px] top-1 h-3 w-3 rounded-full border-2 border-oo-surface bg-oo-ink-2 ring-1 ring-oo-line" aria-hidden="true" />
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[14px]">
                <b className="font-semibold text-oo-ink">{log.userName || 'Sistema'}</b>
                <span className="rounded bg-oo-hover px-1.5 py-px text-[12px] font-medium text-oo-ink-2">{log.action}</span>
                <span className="rounded bg-oo-hover px-1.5 py-px text-[12px] font-medium text-oo-ink-2">{log.scope}</span>
                <span className="text-[12px] tabular-nums text-oo-muted">{new Date(log.createdAt).toLocaleString('pt-BR')}</span>
              </div>
              {log.details && (
                <details className="group mt-2">
                  <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-[12px] font-semibold text-oo-primary hover:underline">
                    <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
                    Detalhes
                  </summary>
                  <pre className="mt-2 max-h-48 overflow-auto rounded-md border border-oo-line bg-oo-subtle p-3 text-[12px] leading-relaxed text-oo-ink-2">
                    {(() => {
                      try { return JSON.stringify(JSON.parse(log.details), null, 2); }
                      catch { return log.details; }
                    })()}
                  </pre>
                </details>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

// ─── INPUTS REUSÁVEIS ──────────────────────────────────────────────────
function FieldLight({ label, value, onChange, type, className }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  className?: string;
}) {
  return (
    <label className={`block min-w-0 ${className || ''}`}>
      <span className={`mb-1.5 block ${ROTULO}`}>{label}</span>
      {type === 'textarea' ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={3}
          className={`${CAMPO} resize-y py-2.5`}
        />
      ) : (
        <input
          type={type === 'date' ? 'date' : type === 'number' ? 'text' : 'text'}
          inputMode={type === 'number' ? 'decimal' : undefined}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={`${CAMPO} h-10 ${type === 'number' ? 'tabular-nums' : ''}`}
        />
      )}
    </label>
  );
}
function SelectLight({ label, value, onChange, options, className }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  className?: string;
}) {
  return (
    <label className={`block min-w-0 ${className || ''}`}>
      <span className={`mb-1.5 block ${ROTULO}`}>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className={`${CAMPO} h-10`}>
        <option value="">— Selecione —</option>
        {options.map((o: any) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}
