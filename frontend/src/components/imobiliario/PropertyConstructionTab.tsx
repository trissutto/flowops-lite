'use client';

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Banknote,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  CircleDollarSign,
  Download,
  FileText,
  HardHat,
  Loader2,
  Paperclip,
  Plus,
  ReceiptText,
  RefreshCw,
  RotateCcw,
  Save,
  TrendingUp,
  Users,
  WalletCards,
  X,
} from 'lucide-react';
import { API_URL, api, getAuthToken } from '@/lib/api';

type Project = {
  id: string;
  name: string;
  status: string;
  plannedStartAt?: string | null;
  plannedEndAt?: string | null;
};

type Category = { id: string; name: string };
type Vendor = {
  id: string;
  legalName: string;
  tradeName?: string | null;
  kind: string;
  specialty?: string | null;
  document?: string | null;
  phone?: string | null;
  email?: string | null;
  pixKey?: string | null;
  active: boolean;
};

type DocumentItem = {
  id: string;
  fileName: string;
  kind: string;
  uploadedAt: string;
};

type Stage = {
  id: string;
  name: string;
  responsible?: string | null;
  plannedStartAt?: string | null;
  plannedEndAt?: string | null;
  budgetCents: number;
  progressPercent: number;
  status: string;
  contractedCents: number;
  paidCents: number;
  overdue: boolean;
  category?: Category | null;
};

type Commitment = {
  id: string;
  description: string;
  amountCents: number;
  paidCents: number;
  balanceCents: number;
  contractedAt: string;
  dueDate?: string | null;
  status: string;
  overdue: boolean;
  vendor?: Vendor | null;
  stage?: { id: string; name: string } | null;
  documents: DocumentItem[];
};

type Payment = {
  id: string;
  description: string;
  amountCents: number;
  netAmountCents: number;
  paidAt: string;
  status: string;
  documents: DocumentItem[];
};

type ProjectData = Project & {
  description?: string | null;
  summary: {
    previstoCents: number;
    contratadoCents: number;
    pagoCents: number;
    entradasCents: number;
    saldoCents: number;
    aPagarCents: number;
    disponivelOrcamentoCents: number;
    progressoPercent: number;
    compromissosAtrasados: number;
    etapasAtrasadas: number;
  };
  stages: Stage[];
  commitments: Commitment[];
  payments: Payment[];
  entries: any[];
};

type LedgerRow = {
  id: string;
  entityId: string;
  type: 'entrada' | 'pagamento' | 'estorno';
  subtype?: string | null;
  occurredAt: string;
  description: string;
  amountCents: number;
  balanceCents: number;
  vendor?: Vendor | null;
  stage?: { id: string; name: string } | null;
  documents: DocumentItem[];
};

type Bootstrap = {
  property: { id: string; name: string };
  projects: Project[];
  categories: Category[];
  vendors: Vendor[];
};

const today = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

const PROJECT_STATUS: Record<string, string> = {
  planejamento: 'Planejamento',
  ativa: 'Ativa',
  pausada: 'Pausada',
  concluida: 'Concluída',
  cancelada: 'Cancelada',
};

const STAGE_STATUS: Record<string, string> = {
  nao_iniciada: 'Não iniciada',
  em_andamento: 'Em andamento',
  pausada: 'Pausada',
  concluida: 'Concluída',
  cancelada: 'Cancelada',
};

const emptyCommitment = () => ({
  description: '',
  amount: '',
  contractedAt: today(),
  dueDate: '',
  vendorId: '',
  stageId: '',
  categoryId: '',
  notes: '',
});

const emptyPayment = () => ({
  commitmentId: '',
  description: '',
  amount: '',
  paidAt: today(),
  paymentMethod: 'pix',
  vendorId: '',
  stageId: '',
  notes: '',
});

const emptyEntry = () => ({
  type: 'aporte',
  description: '',
  amount: '',
  occurredAt: today(),
  vendorId: '',
  notes: '',
});

export function PropertyConstructionTab({ propertyId }: { propertyId: string }) {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [projectId, setProjectId] = useState('');
  const [project, setProject] = useState<ProjectData | null>(null);
  const [ledger, setLedger] = useState<{ openingBalanceCents: number; closingBalanceCents: number; rows: LedgerRow[] }>({
    openingBalanceCents: 0,
    closingBalanceCents: 0,
    rows: [],
  });
  const [tab, setTab] = useState<'resumo' | 'conta' | 'cronograma' | 'fornecedores'>('resumo');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [projectForm, setProjectForm] = useState({ name: '', status: 'planejamento', plannedStartAt: '', plannedEndAt: '' });
  const [actionForm, setActionForm] = useState<'commitment' | 'payment' | 'entry' | null>(null);
  const [commitmentForm, setCommitmentForm] = useState(emptyCommitment);
  const [paymentForm, setPaymentForm] = useState(emptyPayment);
  const [entryForm, setEntryForm] = useState(emptyEntry);
  const [stageForm, setStageForm] = useState({
    name: '', responsible: '', plannedStartAt: '', plannedEndAt: '', budget: '', categoryId: '', status: 'nao_iniciada',
  });
  const [vendorForm, setVendorForm] = useState({
    legalName: '', tradeName: '', kind: 'prestador', specialty: '', document: '', phone: '', email: '', pixKey: '',
  });
  const [from, setFrom] = useState(() => `${today().slice(0, 8)}01`);
  const [to, setTo] = useState(today);
  const [typeFilter, setTypeFilter] = useState('');
  const [vendorFilter, setVendorFilter] = useState('');
  const [stageFilter, setStageFilter] = useState('');
  const [documentFilter, setDocumentFilter] = useState('');
  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const loadBootstrap = useCallback(async () => {
    const data = await api<Bootstrap>(`/properties/${propertyId}/construction`);
    setBootstrap(data);
    setProjectId((current) => {
      if (current && data.projects.some((item) => item.id === current)) return current;
      return data.projects.find((item) => item.status === 'ativa')?.id || data.projects[0]?.id || '';
    });
    return data;
  }, [propertyId]);

  const loadProject = useCallback(async (selectedProjectId: string) => {
    if (!selectedProjectId) {
      setProject(null);
      return;
    }
    const data = await api<ProjectData>(`/properties/${propertyId}/construction/projects/${selectedProjectId}`);
    setProject(data);
  }, [propertyId]);

  const loadLedger = useCallback(async (selectedProjectId: string) => {
    if (!selectedProjectId) {
      setLedger({ openingBalanceCents: 0, closingBalanceCents: 0, rows: [] });
      return;
    }
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (typeFilter) params.set('type', typeFilter);
    if (vendorFilter) params.set('vendorId', vendorFilter);
    if (stageFilter) params.set('stageId', stageFilter);
    if (documentFilter) params.set('documentStatus', documentFilter);
    const data = await api<any>(`/properties/${propertyId}/construction/projects/${selectedProjectId}/ledger?${params}`);
    setLedger(data);
  }, [propertyId, from, to, typeFilter, vendorFilter, stageFilter, documentFilter]);

  useEffect(() => {
    setLoading(true);
    setError(null);
    loadBootstrap()
      .catch((e: any) => setError(readError(e)))
      .finally(() => setLoading(false));
  }, [loadBootstrap]);

  useEffect(() => {
    if (!projectId) {
      setProject(null);
      return;
    }
    setLoading(true);
    Promise.all([loadProject(projectId), loadLedger(projectId)])
      .catch((e: any) => setError(readError(e)))
      .finally(() => setLoading(false));
  }, [projectId, loadProject, loadLedger]);

  const refresh = useCallback(async () => {
    await Promise.all([loadBootstrap(), projectId ? loadProject(projectId) : Promise.resolve(), projectId ? loadLedger(projectId) : Promise.resolve()]);
  }, [loadBootstrap, loadProject, loadLedger, projectId]);

  const run = async (work: () => Promise<any>, success: string, rethrow = false) => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await work();
      setNotice(success);
      await refresh();
    } catch (e: any) {
      setError(readError(e));
      if (rethrow) throw e;
    } finally {
      setSaving(false);
    }
  };

  const createProject = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const created = await api<ProjectData>(`/properties/${propertyId}/construction/projects`, {
        method: 'POST',
        body: JSON.stringify(projectForm),
      });
      await loadBootstrap();
      setProjectId(created.id);
      setNewProjectOpen(false);
      setProjectForm({ name: '', status: 'planejamento', plannedStartAt: '', plannedEndAt: '' });
      setNotice('Obra criada com sucesso.');
    } catch (e: any) {
      setError(readError(e));
    } finally {
      setSaving(false);
    }
  };

  const createCommitment = async (event: FormEvent) => {
    event.preventDefault();
    if (!projectId) return;
    await run(async () => {
      await api(`/properties/${propertyId}/construction/projects/${projectId}/commitments`, {
        method: 'POST',
        body: JSON.stringify({
          ...commitmentForm,
          amountCents: toCents(commitmentForm.amount),
          dueDate: commitmentForm.dueDate || null,
          vendorId: commitmentForm.vendorId || null,
          stageId: commitmentForm.stageId || null,
          categoryId: commitmentForm.categoryId || null,
        }),
      });
      setCommitmentForm(emptyCommitment());
      setActionForm(null);
    }, 'Contratação registrada.');
  };

  const createPayment = async (event: FormEvent, allowOverpayment = false) => {
    event.preventDefault();
    if (!projectId) return;
    const payload = {
      ...paymentForm,
      amountCents: toCents(paymentForm.amount),
      commitmentId: paymentForm.commitmentId || null,
      vendorId: paymentForm.vendorId || null,
      stageId: paymentForm.stageId || null,
      description: paymentForm.description || undefined,
      allowOverpayment,
    };
    try {
      await run(async () => {
        await api(`/properties/${propertyId}/construction/projects/${projectId}/payments`, {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        setPaymentForm(emptyPayment());
        setActionForm(null);
      }, 'Pagamento registrado.', true);
    } catch (e: any) {
      if (!allowOverpayment && readError(e).toLowerCase().includes('ultrapassa o saldo')) {
        if (confirm('O valor ultrapassa o saldo contratado. Deseja registrar mesmo assim?')) {
          await createPayment(event, true);
        }
      }
    }
  };

  const createEntry = async (event: FormEvent) => {
    event.preventDefault();
    if (!projectId) return;
    await run(async () => {
      await api(`/properties/${propertyId}/construction/projects/${projectId}/entries`, {
        method: 'POST',
        body: JSON.stringify({
          ...entryForm,
          amountCents: toCents(entryForm.amount),
          vendorId: entryForm.vendorId || null,
        }),
      });
      setEntryForm(emptyEntry());
      setActionForm(null);
    }, 'Entrada registrada.');
  };

  const createStage = async (event: FormEvent) => {
    event.preventDefault();
    if (!projectId) return;
    await run(async () => {
      await api(`/properties/${propertyId}/construction/projects/${projectId}/stages`, {
        method: 'POST',
        body: JSON.stringify({
          ...stageForm,
          budgetCents: toCents(stageForm.budget || '0'),
          categoryId: stageForm.categoryId || null,
        }),
      });
      setStageForm({ name: '', responsible: '', plannedStartAt: '', plannedEndAt: '', budget: '', categoryId: '', status: 'nao_iniciada' });
    }, 'Etapa adicionada.');
  };

  const createVendor = async (event: FormEvent) => {
    event.preventDefault();
    await run(async () => {
      await api(`/properties/${propertyId}/construction/vendors`, {
        method: 'POST',
        body: JSON.stringify(vendorForm),
      });
      setVendorForm({ legalName: '', tradeName: '', kind: 'prestador', specialty: '', document: '', phone: '', email: '', pixKey: '' });
    }, 'Fornecedor/prestador cadastrado.');
  };

  const setRange = (kind: 'today' | 'yesterday' | 'seven' | 'month') => {
    const end = new Date();
    const start = new Date();
    if (kind === 'yesterday') {
      start.setDate(start.getDate() - 1);
      end.setDate(end.getDate() - 1);
    } else if (kind === 'seven') {
      start.setDate(start.getDate() - 6);
    } else if (kind === 'month') {
      start.setDate(1);
    }
    setFrom(localDate(start));
    setTo(localDate(end));
  };

  const chooseCommitmentForPayment = (commitment: Commitment) => {
    setPaymentForm({
      ...emptyPayment(),
      commitmentId: commitment.id,
      description: commitment.description,
      amount: (commitment.balanceCents / 100).toFixed(2),
      vendorId: commitment.vendor?.id || '',
      stageId: commitment.stage?.id || '',
    });
    setActionForm('payment');
    setTab('conta');
  };

  const reversePayment = async (paymentId: string, amountCents: number) => {
    const amount = prompt('Valor do estorno (R$):', (amountCents / 100).toFixed(2));
    if (!amount) return;
    const reason = prompt('Motivo do estorno:');
    if (!reason) return;
    await run(() => api(`/properties/${propertyId}/construction/projects/${projectId}/payments/${paymentId}/reversals`, {
      method: 'POST',
      body: JSON.stringify({ amountCents: toCents(amount), occurredAt: today(), reason }),
    }), 'Estorno registrado.');
  };

  const cancelCommitment = async (commitmentId: string) => {
    const reason = prompt('Motivo do cancelamento da contratação:');
    if (!reason) return;
    await run(() => api(`/properties/${propertyId}/construction/projects/${projectId}/commitments/${commitmentId}/cancel`, {
      method: 'PATCH',
      body: JSON.stringify({ reason }),
    }), 'Contratação cancelada sem apagar o histórico.');
  };

  const cancelEntry = async (entryId: string) => {
    const reason = prompt('Motivo do cancelamento da entrada:');
    if (!reason) return;
    await run(() => api(`/properties/${propertyId}/construction/projects/${projectId}/entries/${entryId}/cancel`, {
      method: 'PATCH',
      body: JSON.stringify({ reason }),
    }), 'Entrada cancelada sem apagar o histórico.');
  };

  const uploadDocuments = async (paymentId: string, files: FileList | null) => {
    if (!files?.length || !projectId) return;
    setSaving(true);
    setError(null);
    try {
      for (const file of Array.from(files)) {
        const body = new FormData();
        body.append('file', file);
        body.append('paymentId', paymentId);
        body.append('kind', 'recibo');
        await api(`/properties/${propertyId}/construction/projects/${projectId}/documents`, { method: 'POST', body });
      }
      setNotice(files.length > 1 ? 'Recibos anexados.' : 'Recibo anexado.');
      await Promise.all([loadProject(projectId), loadLedger(projectId)]);
    } catch (e: any) {
      setError(readError(e));
    } finally {
      setSaving(false);
      if (fileInputRefs.current[paymentId]) fileInputRefs.current[paymentId]!.value = '';
    }
  };

  const downloadDocument = async (document: DocumentItem) => {
    try {
      const token = getAuthToken();
      const response = await fetch(
        `${API_URL}/api/properties/${propertyId}/construction/projects/${projectId}/documents/${document.id}/download`,
        { headers: token ? { Authorization: `Bearer ${token}` } : undefined },
      );
      if (!response.ok) throw new Error(await response.text());
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = window.document.createElement('a');
      anchor.href = url;
      anchor.download = document.fileName;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      setError(`Falha no download: ${readError(e)}`);
    }
  };

  if (loading && !bootstrap) return <LoadingCard label="Carregando Gestão de Obra..." />;
  if (error && !bootstrap) return <Message tone="error">{error}</Message>;

  return (
    <div className="construction-root space-y-4">
      <section className="rounded-2xl border border-amber-500/30 bg-slate-900/55 p-5 shadow-xl shadow-black/10">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center">
          <div className="flex items-center gap-3 flex-1">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-amber-500/15 text-amber-300">
              <HardHat className="h-6 w-6" />
            </div>
            <div>
              <h2 className="text-xl font-black">Gestão de Obra</h2>
              <p className="text-sm text-slate-400">Financeiro, recibos, fornecedores e cronograma do imóvel.</p>
            </div>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            {bootstrap?.projects.length ? (
              <div className="relative min-w-[230px]">
                <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className="input pr-10 font-bold">
                  {bootstrap.projects.map((item) => (
                    <option key={item.id} value={item.id}>{item.name} — {PROJECT_STATUS[item.status] || item.status}</option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-3 top-3.5 h-4 w-4 text-slate-500" />
              </div>
            ) : null}
            <button onClick={() => setNewProjectOpen((value) => !value)} className="btn-primary">
              <Plus className="h-4 w-4" /> Nova obra
            </button>
          </div>
        </div>

        {newProjectOpen && (
          <form onSubmit={createProject} className="mt-5 grid gap-3 rounded-xl border border-white/10 bg-slate-950/55 p-4 md:grid-cols-2 lg:grid-cols-5">
            <Field label="Nome da obra" className="lg:col-span-2">
              <input required value={projectForm.name} onChange={(e) => setProjectForm({ ...projectForm, name: e.target.value })} className="input" placeholder="Ex.: Construção 2026" />
            </Field>
            <Field label="Situação">
              <select value={projectForm.status} onChange={(e) => setProjectForm({ ...projectForm, status: e.target.value })} className="input">
                {Object.entries(PROJECT_STATUS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </Field>
            <Field label="Início previsto"><input type="date" value={projectForm.plannedStartAt} onChange={(e) => setProjectForm({ ...projectForm, plannedStartAt: e.target.value })} className="input" /></Field>
            <Field label="Término previsto"><input type="date" value={projectForm.plannedEndAt} onChange={(e) => setProjectForm({ ...projectForm, plannedEndAt: e.target.value })} className="input" /></Field>
            <div className="flex gap-2 lg:col-span-5 lg:justify-end">
              <button type="button" onClick={() => setNewProjectOpen(false)} className="btn-muted"><X className="h-4 w-4" /> Cancelar</button>
              <button disabled={saving} className="btn-primary"><Save className="h-4 w-4" /> Criar obra</button>
            </div>
          </form>
        )}
      </section>

      {notice && <Message tone="success" onClose={() => setNotice(null)}>{notice}</Message>}
      {error && <Message tone="error" onClose={() => setError(null)}>{error}</Message>}
      {loading && bootstrap && <div className="flex items-center gap-2 text-xs text-slate-400"><Loader2 className="h-4 w-4 animate-spin" /> Atualizando dados...</div>}

      {!project ? (
        <EmptyState
          icon={HardHat}
          title="Nenhuma obra cadastrada"
          description="Crie a primeira obra deste imóvel para começar o orçamento, a conta corrente e o cronograma."
          action={<button onClick={() => setNewProjectOpen(true)} className="btn-primary"><Plus className="h-4 w-4" /> Criar primeira obra</button>}
        />
      ) : (
        <>
          <section className="flex flex-col gap-3 rounded-xl border border-white/10 bg-slate-900/45 p-3 lg:flex-row lg:items-center">
            <div className="flex flex-1 gap-1 overflow-x-auto">
              {([
                ['resumo', 'Visão geral', TrendingUp],
                ['conta', 'Conta corrente', WalletCards],
                ['cronograma', 'Cronograma', CalendarDays],
                ['fornecedores', 'Fornecedores', Users],
              ] as const).map(([id, label, Icon]) => (
                <button key={id} onClick={() => setTab(id)} className={`subtab ${tab === id ? 'subtab-active' : ''}`}>
                  <Icon className="h-4 w-4" /> {label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <span className={`status ${project.status === 'ativa' ? 'status-green' : project.status === 'concluida' ? 'status-blue' : 'status-amber'}`}>
                {PROJECT_STATUS[project.status] || project.status}
              </span>
              <select
                aria-label="Alterar situação da obra"
                value={project.status}
                onChange={(e) => run(() => api(`/properties/${propertyId}/construction/projects/${projectId}`, {
                  method: 'PATCH', body: JSON.stringify({ status: e.target.value }),
                }), 'Situação da obra atualizada.')}
                className="input h-9 py-1 text-xs"
              >
                {Object.entries(PROJECT_STATUS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
              <button onClick={() => refresh().catch((e) => setError(readError(e)))} className="btn-icon" title="Atualizar"><RefreshCw className="h-4 w-4" /></button>
            </div>
          </section>

          {tab === 'resumo' && <SummaryView project={project} onPay={chooseCommitmentForPayment} />}
          {tab === 'conta' && (
            <LedgerView
              project={project}
              bootstrap={bootstrap!}
              ledger={ledger}
              actionForm={actionForm}
              setActionForm={setActionForm}
              commitmentForm={commitmentForm}
              setCommitmentForm={setCommitmentForm}
              paymentForm={paymentForm}
              setPaymentForm={setPaymentForm}
              entryForm={entryForm}
              setEntryForm={setEntryForm}
              createCommitment={createCommitment}
              createPayment={createPayment}
              createEntry={createEntry}
              saving={saving}
              from={from}
              to={to}
              setFrom={setFrom}
              setTo={setTo}
              setRange={setRange}
              typeFilter={typeFilter}
              setTypeFilter={setTypeFilter}
              vendorFilter={vendorFilter}
              setVendorFilter={setVendorFilter}
              stageFilter={stageFilter}
              setStageFilter={setStageFilter}
              documentFilter={documentFilter}
              setDocumentFilter={setDocumentFilter}
              onPay={chooseCommitmentForPayment}
              onReverse={reversePayment}
              onCancelCommitment={cancelCommitment}
              onCancelEntry={cancelEntry}
              onUpload={uploadDocuments}
              onDownload={downloadDocument}
              fileInputRefs={fileInputRefs}
            />
          )}
          {tab === 'cronograma' && (
            <ScheduleView
              project={project}
              categories={bootstrap?.categories || []}
              stageForm={stageForm}
              setStageForm={setStageForm}
              onCreate={createStage}
              saving={saving}
              onUpdate={(stageId: string, data: any) => run(() => api(`/properties/${propertyId}/construction/projects/${projectId}/stages/${stageId}`, {
                method: 'PATCH', body: JSON.stringify(data),
              }), 'Etapa atualizada.')}
              onNewCategory={async () => {
                const name = prompt('Nome da nova categoria:');
                if (!name) return;
                await run(() => api(`/properties/${propertyId}/construction/categories`, { method: 'POST', body: JSON.stringify({ name }) }), 'Categoria criada.');
              }}
            />
          )}
          {tab === 'fornecedores' && (
            <VendorsView
              vendors={bootstrap?.vendors || []}
              form={vendorForm}
              setForm={setVendorForm}
              onCreate={createVendor}
              saving={saving}
              onToggle={(vendor: Vendor) => run(() => api(`/properties/${propertyId}/construction/vendors/${vendor.id}`, {
                method: 'PATCH', body: JSON.stringify({ active: !vendor.active }),
              }), vendor.active ? 'Fornecedor inativado.' : 'Fornecedor reativado.')}
              onEdit={(vendor: Vendor, data: any) => run(() => api(`/properties/${propertyId}/construction/vendors/${vendor.id}`, {
                method: 'PATCH', body: JSON.stringify(data),
              }), 'Fornecedor/prestador atualizado.')}
            />
          )}
        </>
      )}
      <style jsx global>{`
        .construction-root .panel {
          border: 1px solid rgba(255,255,255,.1);
          border-radius: 1rem;
          background: rgba(15,23,42,.55);
          padding: 1.25rem;
        }
        .construction-root .metric-card {
          border: 1px solid rgba(255,255,255,.1);
          border-radius: .9rem;
          background: rgba(15,23,42,.62);
          padding: 1rem;
        }
        .construction-root .input {
          width: 100%;
          border: 1px solid rgba(148,163,184,.24);
          border-radius: .65rem;
          background: rgba(2,6,23,.58);
          color: #f8fafc;
          padding: .7rem .8rem;
          outline: none;
        }
        .construction-root .input:focus {
          border-color: rgba(251,191,36,.72);
          box-shadow: 0 0 0 3px rgba(245,158,11,.12);
        }
        .construction-root .input option { background: #0f172a; color: #f8fafc; }
        .construction-root .btn-primary,
        .construction-root .btn-money,
        .construction-root .btn-muted {
          display: inline-flex;
          min-height: 2.5rem;
          align-items: center;
          justify-content: center;
          gap: .45rem;
          border-radius: .65rem;
          padding: .55rem .9rem;
          font-size: .78rem;
          font-weight: 800;
          transition: .16s ease;
        }
        .construction-root .btn-primary { background: #d4af37; color: #111827; }
        .construction-root .btn-primary:hover { background: #f1cc52; }
        .construction-root .btn-money { background: #2e7d46; color: white; }
        .construction-root .btn-money:hover { background: #389554; }
        .construction-root .btn-muted { border: 1px solid rgba(255,255,255,.12); background: rgba(255,255,255,.055); color: #e2e8f0; }
        .construction-root .btn-muted:hover { background: rgba(255,255,255,.1); }
        .construction-root button:disabled { cursor: not-allowed; opacity: .55; }
        .construction-root .btn-icon {
          display: inline-flex;
          height: 2.5rem;
          width: 2.5rem;
          align-items: center;
          justify-content: center;
          border: 1px solid rgba(255,255,255,.1);
          border-radius: .65rem;
          background: rgba(255,255,255,.05);
          color: #cbd5e1;
        }
        .construction-root .btn-icon:hover { background: rgba(255,255,255,.1); color: white; }
        .construction-root .subtab {
          display: inline-flex;
          align-items: center;
          gap: .45rem;
          white-space: nowrap;
          border-radius: .6rem;
          padding: .65rem .8rem;
          color: #94a3b8;
          font-size: .78rem;
          font-weight: 800;
        }
        .construction-root .subtab:hover { background: rgba(255,255,255,.05); color: white; }
        .construction-root .subtab-active { background: rgba(245,158,11,.14); color: #fcd34d; }
        .construction-root .status {
          display: inline-flex;
          align-items: center;
          border: 1px solid;
          border-radius: 999px;
          padding: .2rem .5rem;
          white-space: nowrap;
          font-size: .62rem;
          font-weight: 900;
          text-transform: uppercase;
          letter-spacing: .03em;
        }
        .construction-root .status-green { border-color: rgba(52,211,153,.35); background: rgba(16,185,129,.12); color: #6ee7b7; }
        .construction-root .status-blue { border-color: rgba(56,189,248,.35); background: rgba(14,165,233,.12); color: #7dd3fc; }
        .construction-root .status-amber { border-color: rgba(251,191,36,.35); background: rgba(245,158,11,.12); color: #fcd34d; }
        .construction-root .status-red { border-color: rgba(251,113,133,.35); background: rgba(244,63,94,.12); color: #fda4af; }
        .construction-root .status-gray { border-color: rgba(148,163,184,.25); background: rgba(100,116,139,.12); color: #cbd5e1; }
        .construction-root .form-grid {
          display: grid;
          grid-template-columns: repeat(1, minmax(0, 1fr));
          gap: .8rem;
          border: 1px solid rgba(245,158,11,.2);
          border-radius: .9rem;
          background: rgba(2,6,23,.48);
          padding: 1rem;
        }
        .construction-root .shortcut {
          border: 1px solid rgba(255,255,255,.1);
          border-radius: 999px;
          background: rgba(255,255,255,.045);
          padding: .35rem .7rem;
          color: #cbd5e1;
          font-size: .7rem;
          font-weight: 800;
        }
        .construction-root .shortcut:hover { border-color: rgba(251,191,36,.35); color: #fcd34d; }
        @media (min-width: 768px) {
          .construction-root .form-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
        }
      `}</style>
    </div>
  );
}

function SummaryView({ project, onPay }: { project: ProjectData; onPay: (commitment: Commitment) => void }) {
  const summary = project.summary;
  const cards = [
    ['Previsto', summary.previstoCents, 'text-sky-300', CalendarDays],
    ['Contratado', summary.contratadoCents, 'text-amber-300', FileText],
    ['Pago', summary.pagoCents, 'text-rose-300', ReceiptText],
    ['Entradas', summary.entradasCents, 'text-emerald-300', CircleDollarSign],
    ['Saldo da obra', summary.saldoCents, summary.saldoCents >= 0 ? 'text-emerald-300' : 'text-rose-300', WalletCards],
    ['A pagar', summary.aPagarCents, 'text-orange-300', Banknote],
    ['Disponível no orçamento', summary.disponivelOrcamentoCents, summary.disponivelOrcamentoCents >= 0 ? 'text-emerald-300' : 'text-rose-300', TrendingUp],
  ] as const;
  return (
    <div className="space-y-4">
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map(([label, value, color, Icon]) => (
          <div key={label} className="metric-card">
            <div className="flex items-center justify-between text-xs font-bold uppercase tracking-wide text-slate-400"><span>{label}</span><Icon className={`h-4 w-4 ${color}`} /></div>
            <div className={`mt-2 text-2xl font-black ${color}`}>{money(value)}</div>
          </div>
        ))}
        <div className="metric-card">
          <div className="flex items-center justify-between text-xs font-bold uppercase tracking-wide text-slate-400"><span>Progresso físico</span><HardHat className="h-4 w-4 text-violet-300" /></div>
          <div className="mt-2 text-2xl font-black text-violet-300">{summary.progressoPercent}%</div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-700"><div className="h-full rounded-full bg-violet-400" style={{ width: `${summary.progressoPercent}%` }} /></div>
        </div>
      </section>
      {(summary.compromissosAtrasados > 0 || summary.etapasAtrasadas > 0) && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100 flex gap-3">
          <AlertTriangle className="h-5 w-5 shrink-0 text-amber-300" />
          <div><b>Atenção:</b> {summary.compromissosAtrasados} contratação(ões) com saldo vencido e {summary.etapasAtrasadas} etapa(s) atrasada(s).</div>
        </div>
      )}
      <section className="panel">
        <PanelTitle icon={Banknote} title="Próximos pagamentos" subtitle="Contratações com saldo restante" />
        <div className="mt-4 space-y-2">
          {project.commitments.filter((item) => item.status !== 'cancelada' && item.balanceCents > 0).slice(0, 8).map((item) => (
            <div key={item.id} className="flex flex-col gap-3 rounded-xl border border-white/10 bg-slate-950/35 p-3 sm:flex-row sm:items-center">
              <div className="flex-1"><div className="font-bold">{item.description}</div><div className="text-xs text-slate-400">{item.vendor?.legalName || 'Sem fornecedor'} · vencimento {dateLabel(item.dueDate)}</div></div>
              <div className="text-right"><div className="text-xs text-slate-400">Saldo</div><div className={item.overdue ? 'font-black text-rose-300' : 'font-black text-amber-300'}>{money(item.balanceCents)}</div></div>
              <button onClick={() => onPay(item)} className="btn-primary h-9">Pagar</button>
            </div>
          ))}
          {!project.commitments.some((item) => item.status !== 'cancelada' && item.balanceCents > 0) && <EmptyInline text="Nenhum saldo contratado pendente." />}
        </div>
      </section>
    </div>
  );
}

function LedgerView(props: any) {
  const { project, bootstrap, ledger, actionForm, setActionForm, saving } = props;
  return (
    <div className="space-y-4">
      <section className="panel">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-end">
          <div className="flex-1"><PanelTitle icon={WalletCards} title="Conta corrente" subtitle={`Saldo anterior: ${money(ledger.openingBalanceCents)} · saldo final: ${money(ledger.closingBalanceCents)}`} /></div>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => setActionForm(actionForm === 'commitment' ? null : 'commitment')} className="btn-muted"><FileText className="h-4 w-4" /> Contratação</button>
            <button onClick={() => setActionForm(actionForm === 'payment' ? null : 'payment')} className="btn-primary"><ReceiptText className="h-4 w-4" /> Pagamento</button>
            <button onClick={() => setActionForm(actionForm === 'entry' ? null : 'entry')} className="btn-money"><Plus className="h-4 w-4" /> Entrada</button>
          </div>
        </div>

        {actionForm === 'commitment' && (
          <form onSubmit={props.createCommitment} className="form-grid mt-5">
            <FormHeader title="Nova contratação" onClose={() => setActionForm(null)} />
            <Field label="Descrição" className="md:col-span-2"><input required className="input" value={props.commitmentForm.description} onChange={(e) => props.setCommitmentForm({ ...props.commitmentForm, description: e.target.value })} placeholder="Ex.: Instalação elétrica completa" /></Field>
            <MoneyField label="Valor contratado" value={props.commitmentForm.amount} onChange={(value: string) => props.setCommitmentForm({ ...props.commitmentForm, amount: value })} />
            <Field label="Data da contratação"><input required type="date" className="input" value={props.commitmentForm.contractedAt} onChange={(e) => props.setCommitmentForm({ ...props.commitmentForm, contractedAt: e.target.value })} /></Field>
            <Field label="Vencimento"><input type="date" className="input" value={props.commitmentForm.dueDate} onChange={(e) => props.setCommitmentForm({ ...props.commitmentForm, dueDate: e.target.value })} /></Field>
            <SelectField label="Fornecedor/Prestador" value={props.commitmentForm.vendorId} onChange={(value: string) => props.setCommitmentForm({ ...props.commitmentForm, vendorId: value })} options={bootstrap.vendors.filter((v: Vendor) => v.active).map((v: Vendor) => [v.id, v.legalName])} empty="Não informado" />
            <SelectField label="Etapa" value={props.commitmentForm.stageId} onChange={(value: string) => props.setCommitmentForm({ ...props.commitmentForm, stageId: value })} options={project.stages.map((s: Stage) => [s.id, s.name])} empty="Sem etapa" />
            <SelectField label="Categoria" value={props.commitmentForm.categoryId} onChange={(value: string) => props.setCommitmentForm({ ...props.commitmentForm, categoryId: value })} options={bootstrap.categories.map((c: Category) => [c.id, c.name])} empty="Sem categoria" />
            <Field label="Observações" className="md:col-span-2"><input className="input" value={props.commitmentForm.notes} onChange={(e) => props.setCommitmentForm({ ...props.commitmentForm, notes: e.target.value })} /></Field>
            <FormActions saving={saving} label="Salvar contratação" />
          </form>
        )}

        {actionForm === 'payment' && (
          <form onSubmit={props.createPayment} className="form-grid mt-5">
            <FormHeader title="Novo pagamento" onClose={() => setActionForm(null)} />
            <SelectField label="Contratação" className="md:col-span-2" value={props.paymentForm.commitmentId} onChange={(value: string) => {
              const commitment = project.commitments.find((item: Commitment) => item.id === value);
              props.setPaymentForm({
                ...props.paymentForm,
                commitmentId: value,
                description: commitment?.description || props.paymentForm.description,
                amount: commitment ? (commitment.balanceCents / 100).toFixed(2) : props.paymentForm.amount,
                vendorId: commitment?.vendor?.id || props.paymentForm.vendorId,
                stageId: commitment?.stage?.id || props.paymentForm.stageId,
              });
            }} options={project.commitments.filter((c: Commitment) => c.status !== 'cancelada').map((c: Commitment) => [c.id, `${c.description} — saldo ${money(c.balanceCents)}`])} empty="Pagamento direto, sem contratação" />
            <MoneyField label="Valor pago" value={props.paymentForm.amount} onChange={(value: string) => props.setPaymentForm({ ...props.paymentForm, amount: value })} />
            <Field label="Data"><input required type="date" className="input" value={props.paymentForm.paidAt} onChange={(e) => props.setPaymentForm({ ...props.paymentForm, paidAt: e.target.value })} /></Field>
            <Field label="Descrição"><input required={!props.paymentForm.commitmentId} className="input" value={props.paymentForm.description} onChange={(e) => props.setPaymentForm({ ...props.paymentForm, description: e.target.value })} placeholder="Herdada da contratação" /></Field>
            <SelectField label="Forma" value={props.paymentForm.paymentMethod} onChange={(value: string) => props.setPaymentForm({ ...props.paymentForm, paymentMethod: value })} options={[['pix', 'PIX'], ['transferencia', 'Transferência'], ['boleto', 'Boleto'], ['cartao', 'Cartão'], ['dinheiro', 'Dinheiro'], ['outro', 'Outro']]} />
            <SelectField label="Fornecedor/Prestador" value={props.paymentForm.vendorId} onChange={(value: string) => props.setPaymentForm({ ...props.paymentForm, vendorId: value })} options={bootstrap.vendors.filter((v: Vendor) => v.active).map((v: Vendor) => [v.id, v.legalName])} empty="Não informado" />
            <SelectField label="Etapa" value={props.paymentForm.stageId} onChange={(value: string) => props.setPaymentForm({ ...props.paymentForm, stageId: value })} options={project.stages.map((s: Stage) => [s.id, s.name])} empty="Sem etapa" />
            <Field label="Observações"><input className="input" value={props.paymentForm.notes} onChange={(e) => props.setPaymentForm({ ...props.paymentForm, notes: e.target.value })} /></Field>
            <FormActions saving={saving} label="Registrar pagamento" />
          </form>
        )}

        {actionForm === 'entry' && (
          <form onSubmit={props.createEntry} className="form-grid mt-5">
            <FormHeader title="Nova entrada" onClose={() => setActionForm(null)} />
            <SelectField label="Tipo" value={props.entryForm.type} onChange={(value: string) => props.setEntryForm({ ...props.entryForm, type: value })} options={[['aporte', 'Aporte'], ['reembolso', 'Reembolso'], ['outra', 'Outra entrada']]} />
            <Field label="Descrição" className="md:col-span-2"><input required className="input" value={props.entryForm.description} onChange={(e) => props.setEntryForm({ ...props.entryForm, description: e.target.value })} /></Field>
            <MoneyField label="Valor da entrada" value={props.entryForm.amount} onChange={(value: string) => props.setEntryForm({ ...props.entryForm, amount: value })} />
            <Field label="Data"><input required type="date" className="input" value={props.entryForm.occurredAt} onChange={(e) => props.setEntryForm({ ...props.entryForm, occurredAt: e.target.value })} /></Field>
            <SelectField label="Fornecedor relacionado" value={props.entryForm.vendorId} onChange={(value: string) => props.setEntryForm({ ...props.entryForm, vendorId: value })} options={bootstrap.vendors.filter((v: Vendor) => v.active).map((v: Vendor) => [v.id, v.legalName])} empty="Não informado" />
            <Field label="Observações" className="md:col-span-2"><input className="input" value={props.entryForm.notes} onChange={(e) => props.setEntryForm({ ...props.entryForm, notes: e.target.value })} /></Field>
            <FormActions saving={saving} label="Registrar entrada" money />
          </form>
        )}
      </section>

      <section className="panel">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
          <Field label="De"><input type="date" className="input" value={props.from} onChange={(e) => props.setFrom(e.target.value)} /></Field>
          <Field label="Até"><input type="date" className="input" value={props.to} onChange={(e) => props.setTo(e.target.value)} /></Field>
          <SelectField label="Tipo" value={props.typeFilter} onChange={props.setTypeFilter} options={[['entrada', 'Entrada'], ['pagamento', 'Pagamento'], ['estorno', 'Estorno']]} empty="Todos" />
          <SelectField label="Fornecedor" value={props.vendorFilter} onChange={props.setVendorFilter} options={bootstrap.vendors.map((v: Vendor) => [v.id, v.legalName])} empty="Todos" />
          <SelectField label="Etapa" value={props.stageFilter} onChange={props.setStageFilter} options={project.stages.map((s: Stage) => [s.id, s.name])} empty="Todas" />
          <SelectField label="Comprovante" value={props.documentFilter} onChange={props.setDocumentFilter} options={[['com', 'Com anexo'], ['sem', 'Sem anexo']]} empty="Todos" />
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button onClick={() => props.setRange('today')} className="shortcut">Hoje</button>
          <button onClick={() => props.setRange('yesterday')} className="shortcut">Ontem</button>
          <button onClick={() => props.setRange('seven')} className="shortcut">7 dias</button>
          <button onClick={() => props.setRange('month')} className="shortcut">Mês</button>
        </div>
      </section>

      <section className="panel overflow-hidden p-0">
        <div className="hidden overflow-x-auto lg:block">
          <table className="w-full text-sm">
            <thead className="bg-slate-950/55 text-left text-[11px] uppercase tracking-wide text-slate-400">
              <tr><th className="px-4 py-3">Data</th><th className="px-4 py-3">Descrição</th><th className="px-4 py-3">Fornecedor / etapa</th><th className="px-4 py-3 text-right">Entrada</th><th className="px-4 py-3 text-right">Saída</th><th className="px-4 py-3 text-right">Saldo</th><th className="px-4 py-3">Recibos</th></tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {ledger.rows.map((row: LedgerRow) => <LedgerDesktopRow key={row.id} row={row} {...props} />)}
            </tbody>
          </table>
        </div>
        <div className="divide-y divide-white/5 lg:hidden">
          {ledger.rows.map((row: LedgerRow) => <LedgerMobileRow key={row.id} row={row} {...props} />)}
        </div>
        {!ledger.rows.length && <EmptyInline text="Nenhum lançamento encontrado para os filtros selecionados." />}
      </section>

      <section className="panel">
        <PanelTitle icon={FileText} title="Contratações" subtitle="Previsto por fornecedor, pagamentos parciais e saldo" />
        <div className="mt-4 grid gap-3 xl:grid-cols-2">
          {project.commitments.map((item: Commitment) => (
            <div key={item.id} className={`rounded-xl border p-4 ${item.status === 'cancelada' ? 'border-slate-700 bg-slate-950/20 opacity-60' : item.overdue ? 'border-rose-500/30 bg-rose-500/5' : 'border-white/10 bg-slate-950/35'}`}>
              <div className="flex items-start gap-3"><div className="flex-1"><div className="font-bold">{item.description}</div><div className="mt-1 text-xs text-slate-400">{item.vendor?.legalName || 'Sem fornecedor'} · {item.stage?.name || 'Sem etapa'}</div></div>{item.overdue && <span className="status status-red">Vencida</span>}</div>
              <div className="mt-4 grid grid-cols-3 gap-2 text-xs"><Value label="Contratado" value={money(item.amountCents)} /><Value label="Pago" value={money(item.paidCents)} /><Value label="Saldo" value={money(item.balanceCents)} strong /></div>
              {item.status !== 'cancelada' && (
                <div className="mt-4 flex gap-2">
                  {item.balanceCents > 0 && <button onClick={() => props.onPay(item)} className="btn-primary flex-1">Registrar pagamento</button>}
                  <button onClick={() => props.onCancelCommitment(item.id)} className="btn-muted text-rose-300" title="Cancelar contratação"><X className="h-4 w-4" /> Cancelar</button>
                </div>
              )}
            </div>
          ))}
          {!project.commitments.length && <EmptyInline text="Nenhuma contratação cadastrada." />}
        </div>
      </section>
    </div>
  );
}

function LedgerDesktopRow({ row, onReverse, onCancelEntry, onUpload, onDownload, fileInputRefs }: any) {
  return (
    <tr className="hover:bg-white/[0.025]">
      <td className="whitespace-nowrap px-4 py-3 text-slate-300">{dateLabel(row.occurredAt)}</td>
      <td className="px-4 py-3"><div className="font-semibold">{row.description}</div><div className="text-[11px] uppercase text-slate-500">{row.subtype || row.type}</div></td>
      <td className="px-4 py-3 text-xs text-slate-400">{row.vendor?.legalName || '—'}{row.stage?.name ? <><br />{row.stage.name}</> : null}</td>
      <td className="px-4 py-3 text-right font-bold text-emerald-300">{row.type !== 'pagamento' ? money(row.amountCents) : '—'}</td>
      <td className="px-4 py-3 text-right font-bold text-rose-300">{row.type === 'pagamento' ? money(row.amountCents) : '—'}</td>
      <td className={`px-4 py-3 text-right font-black ${row.balanceCents >= 0 ? 'text-slate-200' : 'text-rose-300'}`}>{money(row.balanceCents)}</td>
      <td className="px-4 py-3"><ReceiptActions row={row} onReverse={onReverse} onCancelEntry={onCancelEntry} onUpload={onUpload} onDownload={onDownload} fileInputRefs={fileInputRefs} /></td>
    </tr>
  );
}

function LedgerMobileRow({ row, onReverse, onCancelEntry, onUpload, onDownload, fileInputRefs }: any) {
  return (
    <div className="p-4">
      <div className="flex items-start justify-between gap-3"><div><div className="font-bold">{row.description}</div><div className="text-xs text-slate-400">{dateLabel(row.occurredAt)} · {row.vendor?.legalName || row.type}</div></div><div className={`font-black ${row.type === 'pagamento' ? 'text-rose-300' : 'text-emerald-300'}`}>{row.type === 'pagamento' ? '−' : '+'}{money(row.amountCents)}</div></div>
      <div className="mt-3 flex items-center justify-between"><span className="text-xs text-slate-500">Saldo {money(row.balanceCents)}</span><ReceiptActions row={row} onReverse={onReverse} onCancelEntry={onCancelEntry} onUpload={onUpload} onDownload={onDownload} fileInputRefs={fileInputRefs} /></div>
    </div>
  );
}

function ReceiptActions({ row, onReverse, onCancelEntry, onUpload, onDownload, fileInputRefs }: any) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {row.documents?.map((document: DocumentItem) => (
        <button key={document.id} onClick={() => onDownload(document)} className="btn-icon h-8 w-8" title={document.fileName}><Download className="h-3.5 w-3.5" /></button>
      ))}
      {row.type === 'pagamento' && (
        <>
          <input ref={(element) => { fileInputRefs.current[row.entityId] = element; }} type="file" accept=".pdf,.jpg,.jpeg,.png" multiple className="hidden" onChange={(e) => onUpload(row.entityId, e.target.files)} />
          <button onClick={() => fileInputRefs.current[row.entityId]?.click()} className="btn-icon h-8 w-8" title="Anexar recibo"><Paperclip className="h-3.5 w-3.5" /></button>
          <button onClick={() => onReverse(row.entityId, row.amountCents)} className="btn-icon h-8 w-8 text-amber-300" title="Estornar"><RotateCcw className="h-3.5 w-3.5" /></button>
        </>
      )}
      {row.type === 'entrada' && (
        <button onClick={() => onCancelEntry(row.entityId)} className="btn-icon h-8 w-8 text-rose-300" title="Cancelar entrada"><X className="h-3.5 w-3.5" /></button>
      )}
      {!row.documents?.length && row.type !== 'pagamento' && <span className="text-xs text-slate-600">—</span>}
    </div>
  );
}

function ScheduleView({ project, categories, stageForm, setStageForm, onCreate, saving, onUpdate, onNewCategory }: any) {
  return (
    <div className="space-y-4">
      <section className="panel">
        <PanelTitle icon={CalendarDays} title="Nova etapa do cronograma" subtitle="Cronograma simples, responsável, prazo, orçamento e execução" />
        <form onSubmit={onCreate} className="form-grid mt-5">
          <Field label="Nome da etapa" className="md:col-span-2"><input required className="input" value={stageForm.name} onChange={(e) => setStageForm({ ...stageForm, name: e.target.value })} placeholder="Ex.: Instalação elétrica" /></Field>
          <Field label="Responsável"><input className="input" value={stageForm.responsible} onChange={(e) => setStageForm({ ...stageForm, responsible: e.target.value })} /></Field>
          <SelectField label="Categoria" value={stageForm.categoryId} onChange={(value: string) => setStageForm({ ...stageForm, categoryId: value })} options={categories.map((c: Category) => [c.id, c.name])} empty="Sem categoria" />
          <Field label="Início previsto"><input type="date" className="input" value={stageForm.plannedStartAt} onChange={(e) => setStageForm({ ...stageForm, plannedStartAt: e.target.value })} /></Field>
          <Field label="Término previsto"><input type="date" className="input" value={stageForm.plannedEndAt} onChange={(e) => setStageForm({ ...stageForm, plannedEndAt: e.target.value })} /></Field>
          <MoneyField label="Orçamento previsto" value={stageForm.budget} onChange={(value: string) => setStageForm({ ...stageForm, budget: value })} required={false} />
          <SelectField label="Situação" value={stageForm.status} onChange={(value: string) => setStageForm({ ...stageForm, status: value })} options={Object.entries(STAGE_STATUS)} />
          <div className="flex flex-wrap gap-2 md:col-span-4 md:justify-end"><button type="button" onClick={onNewCategory} className="btn-muted"><Plus className="h-4 w-4" /> Nova categoria</button><button disabled={saving} className="btn-primary"><Plus className="h-4 w-4" /> Adicionar etapa</button></div>
        </form>
      </section>

      <section className="space-y-3">
        {project.stages.map((stage: Stage, index: number) => (
          <article key={stage.id} className={`panel ${stage.overdue ? 'border-rose-500/35' : ''}`}>
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-500/15 font-black text-amber-300">{index + 1}</div>
              <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="font-black">{stage.name}</h3>{stage.category && <span className="status status-blue">{stage.category.name}</span>}{stage.overdue && <span className="status status-red">Atrasada</span>}</div><p className="mt-1 text-xs text-slate-400">{stage.responsible || 'Sem responsável'} · {dateLabel(stage.plannedStartAt)} até {dateLabel(stage.plannedEndAt)}</p></div>
              <div className="grid grid-cols-3 gap-4 text-xs"><Value label="Previsto" value={money(stage.budgetCents)} /><Value label="Contratado" value={money(stage.contractedCents)} /><Value label="Pago" value={money(stage.paidCents)} strong /></div>
              <button onClick={() => editStage(stage, onUpdate)} className="btn-muted">Editar dados</button>
            </div>
            <div className="mt-5 grid gap-3 md:grid-cols-[1fr_180px] md:items-end">
              <Field label={`Progresso: ${stage.progressPercent}%`}><input type="range" min="0" max="100" step="5" defaultValue={stage.progressPercent} onMouseUp={(e) => onUpdate(stage.id, { progressPercent: Number((e.target as HTMLInputElement).value) })} onTouchEnd={(e) => onUpdate(stage.id, { progressPercent: Number((e.target as HTMLInputElement).value) })} className="h-2 w-full cursor-pointer accent-amber-400" /></Field>
              <SelectField label="Situação" value={stage.status} onChange={(value: string) => onUpdate(stage.id, { status: value })} options={Object.entries(STAGE_STATUS)} />
            </div>
          </article>
        ))}
        {!project.stages.length && <EmptyState icon={CalendarDays} title="Cronograma vazio" description="Adicione a primeira etapa para começar a acompanhar prazo, orçamento e progresso." />}
      </section>
    </div>
  );
}

function VendorsView({ vendors, form, setForm, onCreate, saving, onToggle, onEdit }: any) {
  return (
    <div className="space-y-4">
      <section className="panel">
        <PanelTitle icon={Users} title="Novo fornecedor ou prestador" subtitle="Cadastro exclusivo das obras, separado dos fornecedores das lojas" />
        <form onSubmit={onCreate} className="form-grid mt-5">
          <Field label="Nome/Razão social" className="md:col-span-2"><input required className="input" value={form.legalName} onChange={(e) => setForm({ ...form, legalName: e.target.value })} /></Field>
          <Field label="Nome fantasia"><input className="input" value={form.tradeName} onChange={(e) => setForm({ ...form, tradeName: e.target.value })} /></Field>
          <SelectField label="Tipo" value={form.kind} onChange={(value: string) => setForm({ ...form, kind: value })} options={[['prestador', 'Prestador'], ['fornecedor', 'Fornecedor'], ['ambos', 'Ambos']]} />
          <Field label="Especialidade"><input className="input" value={form.specialty} onChange={(e) => setForm({ ...form, specialty: e.target.value })} placeholder="Ex.: Elétrica" /></Field>
          <Field label="CPF/CNPJ"><input className="input" value={form.document} onChange={(e) => setForm({ ...form, document: e.target.value })} /></Field>
          <Field label="Telefone"><input className="input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
          <Field label="E-mail"><input type="email" className="input" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="Chave PIX" className="md:col-span-2"><input className="input" value={form.pixKey} onChange={(e) => setForm({ ...form, pixKey: e.target.value })} /></Field>
          <FormActions saving={saving} label="Cadastrar fornecedor/prestador" />
        </form>
      </section>
      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {vendors.map((vendor: Vendor) => (
          <article key={vendor.id} className={`panel ${!vendor.active ? 'opacity-55' : ''}`}>
            <div className="flex items-start gap-3"><div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-500/15 text-violet-300"><Users className="h-5 w-5" /></div><div className="min-w-0 flex-1"><h3 className="truncate font-black">{vendor.legalName}</h3><p className="text-xs text-slate-400">{vendor.specialty || vendor.kind}</p></div><span className={`status ${vendor.active ? 'status-green' : 'status-gray'}`}>{vendor.active ? 'Ativo' : 'Inativo'}</span></div>
            <div className="mt-4 space-y-1 text-xs text-slate-400">{vendor.document && <div>CPF/CNPJ: {vendor.document}</div>}{vendor.phone && <div>Telefone: {vendor.phone}</div>}{vendor.email && <div>E-mail: {vendor.email}</div>}{vendor.pixKey && <div className="truncate">PIX: {vendor.pixKey}</div>}</div>
            <div className="mt-4 flex gap-2"><button onClick={() => editVendor(vendor, onEdit)} className="btn-muted flex-1">Editar</button><button onClick={() => onToggle(vendor)} className="btn-muted flex-1">{vendor.active ? 'Inativar' : 'Reativar'}</button></div>
          </article>
        ))}
        {!vendors.length && <EmptyState icon={Users} title="Nenhum fornecedor" description="Cadastre prestadores e fornecedores para reutilizar em todas as obras." />}
      </section>
    </div>
  );
}

function PanelTitle({ icon: Icon, title, subtitle }: any) {
  return <div className="flex items-start gap-3"><Icon className="mt-0.5 h-5 w-5 text-amber-300" /><div><h3 className="font-black">{title}</h3>{subtitle && <p className="mt-0.5 text-xs text-slate-400">{subtitle}</p>}</div></div>;
}

function Field({ label, children, className = '' }: any) {
  return <label className={`block ${className}`}><span className="mb-1.5 block text-xs font-bold text-slate-300">{label}</span>{children}</label>;
}

function MoneyField({ label, value, onChange, required = true }: any) {
  return <Field label={label}><div className="relative"><span className="absolute left-3 top-3 text-sm text-slate-500">R$</span><input required={required} type="number" min="0" step="0.01" className="input pl-10" value={value} onChange={(e) => onChange(e.target.value)} /></div></Field>;
}

function SelectField({ label, value, onChange, options, empty, className = '' }: any) {
  return <Field label={label} className={className}><select className="input" value={value} onChange={(e) => onChange(e.target.value)}>{empty !== undefined && <option value="">{empty}</option>}{options.map(([id, text]: [string, string]) => <option key={id} value={id}>{text}</option>)}</select></Field>;
}

function FormHeader({ title, onClose }: any) {
  return <div className="flex items-center justify-between md:col-span-4"><h3 className="font-black text-amber-300">{title}</h3><button type="button" onClick={onClose} className="btn-icon"><X className="h-4 w-4" /></button></div>;
}

function FormActions({ saving, label, money: moneyTone = false }: any) {
  return <div className="flex justify-end md:col-span-4"><button disabled={saving} className={moneyTone ? 'btn-money' : 'btn-primary'}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}{label}</button></div>;
}

function Value({ label, value, strong }: any) {
  return <div><div className="text-slate-500">{label}</div><div className={strong ? 'mt-0.5 font-black text-amber-300' : 'mt-0.5 font-bold text-slate-200'}>{value}</div></div>;
}

function Message({ tone, children, onClose }: any) {
  const success = tone === 'success';
  return <div className={`flex items-start gap-3 rounded-xl border p-4 text-sm ${success ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-100' : 'border-rose-500/30 bg-rose-500/10 text-rose-100'}`}>{success ? <CheckCircle2 className="h-5 w-5 shrink-0" /> : <AlertTriangle className="h-5 w-5 shrink-0" />}<div className="flex-1">{children}</div>{onClose && <button onClick={onClose}><X className="h-4 w-4" /></button>}</div>;
}

function EmptyInline({ text }: { text: string }) {
  return <div className="p-6 text-center text-sm text-slate-500">{text}</div>;
}

function EmptyState({ icon: Icon, title, description, action }: any) {
  return <div className="panel flex min-h-[220px] flex-col items-center justify-center text-center"><div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-white/5 text-slate-400"><Icon className="h-7 w-7" /></div><h3 className="mt-4 font-black">{title}</h3><p className="mt-1 max-w-md text-sm text-slate-400">{description}</p>{action && <div className="mt-4">{action}</div>}</div>;
}

function LoadingCard({ label }: { label: string }) {
  return <div className="panel flex min-h-[220px] items-center justify-center gap-3 text-slate-400"><Loader2 className="h-6 w-6 animate-spin text-amber-300" /> {label}</div>;
}

function money(cents: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(cents || 0) / 100);
}

function toCents(value: string) {
  const number = Number(String(value || '').replace(',', '.'));
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.round(number * 100);
}

function dateLabel(value?: string | null) {
  if (!value) return 'sem data';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'sem data' : date.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

function localDate(value: Date) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

function editStage(stage: Stage, onUpdate: (stageId: string, data: any) => Promise<any>) {
  const name = prompt('Nome da etapa:', stage.name);
  if (!name) return;
  const responsible = prompt('Responsável:', stage.responsible || '');
  if (responsible === null) return;
  const plannedStartAt = prompt('Início previsto (AAAA-MM-DD):', dateInput(stage.plannedStartAt));
  if (plannedStartAt === null) return;
  const plannedEndAt = prompt('Término previsto (AAAA-MM-DD):', dateInput(stage.plannedEndAt));
  if (plannedEndAt === null) return;
  const budget = prompt('Orçamento previsto (R$):', (stage.budgetCents / 100).toFixed(2));
  if (budget === null) return;
  void onUpdate(stage.id, {
    name,
    responsible: responsible || null,
    plannedStartAt: plannedStartAt || null,
    plannedEndAt: plannedEndAt || null,
    budgetCents: toCents(budget),
  });
}

function editVendor(vendor: Vendor, onEdit: (vendor: Vendor, data: any) => Promise<any>) {
  const legalName = prompt('Nome/Razão social:', vendor.legalName);
  if (!legalName) return;
  const specialty = prompt('Especialidade:', vendor.specialty || '');
  if (specialty === null) return;
  const phone = prompt('Telefone:', vendor.phone || '');
  if (phone === null) return;
  const email = prompt('E-mail:', vendor.email || '');
  if (email === null) return;
  const pixKey = prompt('Chave PIX:', vendor.pixKey || '');
  if (pixKey === null) return;
  void onEdit(vendor, { legalName, specialty, phone, email, pixKey });
}

function dateInput(value?: string | null) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : localDate(date);
}

function readError(error: any) {
  const raw = String(error?.message || error || 'Erro inesperado.');
  try {
    const jsonStart = raw.indexOf('{');
    if (jsonStart >= 0) {
      const parsed = JSON.parse(raw.slice(jsonStart));
      return Array.isArray(parsed?.message) ? parsed.message.join(', ') : parsed?.message || raw;
    }
  } catch {}
  return raw.replace(/^\d{3}:\s*/, '');
}
