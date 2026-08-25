'use client';

import Link from 'next/link';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { falarComCliente } from '@/lib/whatsapp';
import {
  ArrowLeft, Check, ChevronRight, Clock3, ExternalLink, Loader2, MapPin,
  MessageCircle, Pencil, RefreshCw, ShieldCheck, ShoppingBag, Store, UserRound,
  Users, WalletCards, X,
} from 'lucide-react';

const ABAS = [
  ['resumo', 'Resumo'], ['cadastro', 'Cadastro'], ['perfil', 'Perfil de moda'],
  ['credito', 'Crédito'], ['compras', 'Compras'], ['cashback', 'Cashback'],
  ['enderecos', 'Endereços'], ['lgpd', 'LGPD'], ['auditoria', 'Auditoria'],
] as const;
type Aba = typeof ABAS[number][0];

type AnyRecord = Record<string, any>;

const origemLabel: Record<string, string> = {
  pdv: 'PDV', physical: 'PDV', woo: 'Site antigo', site: 'Site', ecommerce: 'Site',
  live: 'Live', instagram: 'Live', giga: 'Giga', manual: 'FlowOps',
};

function money(cents: any) {
  const n = Number(cents || 0);
  return (n / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
function date(value: any, withTime = false) {
  if (!value) return 'Não informado';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString('pt-BR', withTime
    ? { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }
    : { timeZone: 'America/Sao_Paulo', dateStyle: 'short' });
}
function phone(value: any) {
  const d = String(value || '').replace(/\D/g, '');
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return value || 'Não informado';
}
function first(...values: any[]) {
  return values.find((v) => v !== null && v !== undefined && String(v).trim() !== '') ?? null;
}

function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <section className={`rounded-xl border border-[#DEDCD7] bg-white p-5 shadow-sm ${className}`}>{children}</section>;
}
function Field({ label, value, moneyValue = false }: { label: string; value: any; moneyValue?: boolean }) {
  const shown = value === null || value === undefined || value === '' ? 'Não informado' : String(value);
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-[#817B70]">{label}</div>
      <div className={`mt-1 break-words text-sm ${shown === 'Não informado' ? 'italic text-[#AAA49A]' : moneyValue ? 'font-semibold text-[#2E7D46]' : 'text-[#27241F]'}`}>{shown}</div>
    </div>
  );
}
function SectionTitle({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return <div className="mb-4 flex items-center justify-between gap-3 border-b border-[#ECE9E2] pb-3"><h2 className="font-semibold text-[#27241F]">{children}</h2>{action}</div>;
}

function EditSection({ title, data, fields, onSaved }: {
  title: string;
  data: AnyRecord;
  fields: Array<{ key: string; label: string; type?: string }>;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<AnyRecord>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const start = () => { setForm(Object.fromEntries(fields.map(f => [f.key, data[f.key] ? String(data[f.key]).slice(0, f.type === 'date' ? 10 : undefined) : '']))); setEditing(true); setError(''); };
  const save = async () => {
    setSaving(true); setError('');
    try {
      const body = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, String(v).trim() || null]));
      await api(`/customers-crm/${data.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      setEditing(false); onSaved();
    } catch (e: any) { setError(e?.message || 'Não foi possível salvar'); }
    finally { setSaving(false); }
  };
  return (
    <Card>
      <SectionTitle action={editing ? <div className="flex gap-2"><button onClick={() => setEditing(false)} className="rounded-lg border px-3 py-1.5 text-xs"><X className="mr-1 inline h-3 w-3" />Cancelar</button><button onClick={save} disabled={saving} className="rounded-lg bg-[#2E7D46] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"><Check className="mr-1 inline h-3 w-3" />{saving ? 'Salvando…' : 'Salvar'}</button></div> : <button onClick={start} className="rounded-lg border border-[#D4AF37] px-3 py-1.5 text-xs font-semibold text-[#8C7325] hover:bg-[#FBF6E6]"><Pencil className="mr-1 inline h-3 w-3" />Editar</button>}>{title}</SectionTitle>
      {error && <div className="mb-3 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {fields.map(f => editing ? <label key={f.key} className="text-xs font-semibold text-[#6B665D]">{f.label}<input type={f.type || 'text'} value={form[f.key] ?? ''} onChange={e => setForm(v => ({ ...v, [f.key]: e.target.value }))} className="mt-1 w-full rounded-lg border border-[#D8D3C8] px-3 py-2 text-sm font-normal outline-none focus:border-[#B8912B]" /></label> : <Field key={f.key} label={f.label} value={f.key === 'birthDate' ? date(data[f.key]) : data[f.key]} />)}
      </div>
    </Card>
  );
}

function CreditEditor({ data, onSaved }: { data: AnyRecord; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState<AnyRecord>({});
  const start = () => {
    setForm({
      limiteCrediario: data.limiteCrediarioCents ? Number(data.limiteCrediarioCents) / 100 : '',
      bloqueado: !!data.bloqueadoGiga, negativado: !!data.negativadoGiga,
      spcSituacao: data.spcSituacao || '', spcData: data.spcData ? String(data.spcData).slice(0, 10) : '',
      trabalhoRazaoSocial: data.trabalhoRazaoSocial || '', trabalhoCargo: data.trabalhoCargo || '',
      trabalhoSalario: data.trabalhoSalarioCents ? Number(data.trabalhoSalarioCents) / 100 : '',
      trabalhoAdmissao: data.trabalhoAdmissao ? String(data.trabalhoAdmissao).slice(0, 10) : '',
      trabalhoFone: data.trabalhoFone || '', casaPropria: data.casaPropria ?? '',
      aluguel: data.aluguelCents ? Number(data.aluguelCents) / 100 : '',
    });
    setError(''); setOpen(true);
  };
  const save = async () => {
    setSaving(true); setError('');
    try {
      const body = { ...form };
      for (const key of ['limiteCrediario', 'trabalhoSalario', 'aluguel']) body[key] = body[key] === '' ? null : Number(body[key]);
      for (const key of ['spcSituacao', 'spcData', 'trabalhoRazaoSocial', 'trabalhoCargo', 'trabalhoAdmissao', 'trabalhoFone']) body[key] = String(body[key] || '').trim() || null;
      if (body.casaPropria === '') body.casaPropria = null;
      await api(`/customers-crm/${data.id}/beta/credit`, { method: 'PATCH', body: JSON.stringify(body) });
      setOpen(false); onSaved();
    } catch (e: any) { setError(e?.message || 'Não foi possível salvar os dados de crédito'); }
    finally { setSaving(false); }
  };
  if (!open) return <button onClick={start} className="ml-2 rounded-lg border border-amber-400 bg-white px-3 py-1.5 text-xs font-bold text-amber-900"><Pencil className="mr-1 inline h-3 w-3" />Editar crédito</button>;
  const input = (key: string, label: string, type = 'text') => <label className="text-xs font-semibold text-[#6B665D]">{label}<input type={type} value={form[key] ?? ''} onChange={e => setForm(v => ({ ...v, [key]: e.target.value }))} className="mt-1 w-full rounded-lg border px-3 py-2 text-sm font-normal outline-none focus:border-[#B8912B]" /></label>;
  return <Card className="mt-4 border-amber-300 bg-amber-50"><SectionTitle action={<div className="flex gap-2"><button onClick={() => setOpen(false)} className="rounded-lg border bg-white px-3 py-1.5 text-xs">Cancelar</button><button onClick={save} disabled={saving} className="rounded-lg bg-[#2E7D46] px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50">{saving ? 'Salvando…' : 'Salvar alterações'}</button></div>}>Editar dados de crédito</SectionTitle>{error && <div className="mb-3 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}<div className="grid gap-4 sm:grid-cols-2">{input('limiteCrediario','Limite de compras (R$)','number')}{input('spcSituacao','Situação SPC')}{input('spcData','Data SPC','date')}{input('trabalhoRazaoSocial','Empresa')}{input('trabalhoCargo','Cargo')}{input('trabalhoSalario','Salário (R$)','number')}{input('trabalhoAdmissao','Admissão','date')}{input('trabalhoFone','Telefone comercial')}{input('aluguel','Aluguel (R$)','number')}<label className="text-xs font-semibold">Bloqueada<select value={String(form.bloqueado)} onChange={e => setForm(v => ({...v,bloqueado:e.target.value==='true'}))} className="mt-1 w-full rounded-lg border bg-white px-3 py-2 text-sm"><option value="false">Não</option><option value="true">Sim</option></select></label><label className="text-xs font-semibold">Negativada<select value={String(form.negativado)} onChange={e => setForm(v => ({...v,negativado:e.target.value==='true'}))} className="mt-1 w-full rounded-lg border bg-white px-3 py-2 text-sm"><option value="false">Não</option><option value="true">Sim</option></select></label></div></Card>;
}

function MarkedAuthorization({ fichas, onSaved }: { fichas: AnyRecord[]; onSaved: () => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [evaluation, setEvaluation] = useState('');
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const start = (ficha: AnyRecord) => {
    setEditing(`${ficha.storeCode}:${ficha.customerCode}`);
    setEvaluation(ficha.evaluation || '');
    setPassword('');
    setError('');
  };
  const save = async (ficha: AnyRecord) => {
    if (!password.trim()) { setError('Informe a senha do gerente.'); return; }
    setSaving(true); setError('');
    try {
      const result = await api<AnyRecord>('/admin/clientes-giga/ficha/restrito', {
        method: 'POST',
        body: JSON.stringify({
          loja: ficha.storeCode,
          codigo: ficha.customerCode,
          password,
          campos: { AVALIACAO: evaluation.trim().toUpperCase() },
        }),
      });
      if (result?.ok === false) throw new Error(result.erro || 'Não foi possível alterar a liberação');
      setEditing(null); setPassword(''); onSaved();
    } catch (e: any) { setError(e?.message || 'Não foi possível alterar a liberação'); }
    finally { setSaving(false); }
  };

  return <Card className="lg:col-span-2">
    <SectionTitle>Liberação para marcado</SectionTitle>
    <p className="mb-4 text-sm text-[#6B665D]">A liberação é por loja. Para permitir marcar, a ficha precisa estar com Avaliação A, limite maior que zero e sem bloqueio.</p>
    {!fichas?.length ? <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">Esta cliente ainda não possui ficha física vinculada para liberar o marcado.</div> : <div className="space-y-3">
      {fichas.map((ficha) => {
        const key = `${ficha.storeCode}:${ficha.customerCode}`;
        const isEditing = editing === key;
        return <div key={key} className="rounded-xl border border-[#DEDCD7] p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1">
              <div className="font-semibold">Loja {ficha.storeCode} <span className="font-normal text-[#817B70]">· ficha {ficha.customerCode}</span></div>
              <div className="mt-1 flex flex-wrap gap-2 text-xs">
                <span className={`rounded-full px-2 py-1 font-semibold ${ficha.allowed ? 'bg-emerald-100 text-emerald-800' : 'bg-red-50 text-red-800'}`}>{ficha.allowed ? 'Liberada para marcado' : 'Não liberada'}</span>
                <span className="rounded-full bg-[#F2F0EB] px-2 py-1">Avaliação: {ficha.evaluation || '—'}</span>
                <span className="rounded-full bg-[#F2F0EB] px-2 py-1">Limite: {ficha.limit == null ? 'não informado' : ficha.limit.toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}</span>
                {ficha.blocked && <span className="rounded-full bg-red-50 px-2 py-1 text-red-800">Bloqueada</span>}
              </div>
            </div>
            {!isEditing && <button onClick={() => start(ficha)} className="rounded-lg border border-[#D4AF37] px-3 py-2 text-xs font-semibold text-[#8C7325] hover:bg-[#FBF6E6]"><ShieldCheck className="mr-1 inline h-4 w-4" />Alterar liberação</button>}
          </div>
          {isEditing && <div className="mt-4 grid gap-3 border-t border-[#ECE9E2] pt-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <label className="text-xs font-semibold text-[#6B665D]">Avaliação<select value={evaluation} onChange={e => setEvaluation(e.target.value)} className="mt-1 w-full rounded-lg border bg-white px-3 py-2 text-sm font-normal"><option value="">Sem classificação</option><option value="A">A — libera marcado</option><option value="B">B — não libera</option><option value="C">C — não libera</option></select></label>
            <label className="text-xs font-semibold text-[#6B665D]">Senha do gerente<input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" className="mt-1 w-full rounded-lg border px-3 py-2 text-sm font-normal" /></label>
            <div className="flex gap-2"><button onClick={() => setEditing(null)} className="rounded-lg border px-3 py-2 text-xs">Cancelar</button><button onClick={() => void save(ficha)} disabled={saving} className="rounded-lg bg-[#27241F] px-3 py-2 text-xs font-bold text-white disabled:opacity-50">{saving ? 'Salvando…' : 'Confirmar'}</button></div>
          </div>}
          {isEditing && error && <div className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}
        </div>;
      })}
    </div>}
  </Card>;
}

export default function FichaClienteBetaPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const id = params.id;
  const requestedTab = searchParams.get('tab') as Aba | null;
  const [tab, setTab] = useState<Aba>(ABAS.some(([k]) => k === requestedTab) ? requestedTab! : 'resumo');
  const [detail, setDetail] = useState<AnyRecord | null>(null);
  const [person, setPerson] = useState<AnyRecord | null>(null);
  const [me, setMe] = useState<AnyRecord | null>(null);
  const [history, setHistory] = useState<AnyRecord | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [d, actor] = await Promise.all([
        api<AnyRecord>(`/customers-crm/${id}/beta`),
        api<AnyRecord>('/auth/me').catch(() => null),
      ]);
      setDetail(d);
      setPerson(d.personSummary ? {
        personId: d.personSummary.personId,
        agregado: {
          totalCadastros: d.personSummary.totalCadastros,
          totalLtvCents: d.personSummary.totalLtvCents,
          totalOrderCount: d.personSummary.totalOrderCount,
          canais: d.personSummary.canais,
          lojas: d.personSummary.lojas,
        },
        outros: (d.personSummary.records || []).filter((r: AnyRecord) => r.id !== id),
      } : null);
      setMe(actor);
    } catch (e: any) { setError(e?.message || 'Não foi possível carregar a ficha'); }
    finally { setLoading(false); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (tab !== 'compras' || history || loadingHistory) return;
    setLoadingHistory(true);
    api<AnyRecord>(`/customers-crm/${id}/historico`).then(setHistory).catch((e: any) => setHistory({ error: e?.message || 'Falha ao carregar compras' })).finally(() => setLoadingHistory(false));
  }, [tab, id, history, loadingHistory]);

  const chooseTab = (next: Aba) => {
    setTab(next);
    const qs = new URLSearchParams(searchParams.toString()); qs.set('tab', next);
    const detailPath = pathname.startsWith('/beta/clientes/')
      ? `/beta/clientes/${id}`
      : `/clientes-crm/beta/${id}`;
    router.replace(`${detailPath}?${qs.toString()}`, { scroll: false });
  };
  const back = searchParams.get('returnTo');
  const validReturn = back && !back.startsWith('//') && (back.startsWith('/clientes-crm') || back.startsWith('/beta/clientes'));
  const returnTo = validReturn ? back! : (typeof window !== 'undefined' && window.location.pathname.startsWith('/beta/') ? '/beta/clientes' : '/clientes-crm');
  const totalLtv = person?.agregado?.totalLtvCents ?? Number(detail?.ltvCents || 0);
  const totalOrders = person?.agregado?.totalOrderCount ?? detail?.orderCount ?? 0;
  const channels = useMemo(() => {
    const raw = person?.agregado?.canais?.length ? person.agregado.canais : [detail?.originSource];
    return Array.from(new Set<string>((raw as string[]).filter(Boolean).map((v) => origemLabel[v] || v)));
  }, [person, detail]);

  if (loading) return <div className="min-h-screen bg-[#F7F7F5] p-10 text-center text-[#817B70]"><Loader2 className="mx-auto mb-3 h-7 w-7 animate-spin" />Carregando ficha única…</div>;
  if (error || !detail) return <div className="min-h-screen bg-[#F7F7F5] p-6"><Card className="mx-auto max-w-xl text-center"><h1 className="text-lg font-semibold">Não foi possível abrir a ficha</h1><p className="my-4 text-sm text-[#817B70]">{error}</p><div className="flex justify-center gap-2"><button onClick={() => void load()} className="rounded-lg bg-[#27241F] px-4 py-2 text-sm text-white"><RefreshCw className="mr-2 inline h-4 w-4" />Tentar novamente</button><Link href={returnTo} className="rounded-lg border px-4 py-2 text-sm">Voltar</Link></div></Card></div>;

  const name = first(detail.nameSocial, detail.name, 'Cliente sem nome');
  const whatsappDigits = String(detail.whatsapp || '').replace(/\D/g, '');
  const isAdmin = me?.role === 'admin';

  return (
    <main className="min-h-screen bg-[#F7F7F5] text-[#27241F]">
      <div className="border-b border-[#DEDCD7] bg-white">
        <div className="mx-auto max-w-7xl px-4 py-4 sm:px-6">
          <Link href={returnTo} className="mb-4 inline-flex items-center gap-2 text-sm text-[#6B665D] hover:text-[#27241F]"><ArrowLeft className="h-4 w-4" />Voltar para clientes</Link>
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center">
            <div className="flex min-w-0 items-center gap-4">
              <div className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-[#E8E5DE] text-xl font-semibold">{String(name).charAt(0).toUpperCase()}</div>
              <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h1 className="truncate text-2xl font-semibold">{name}</h1><span className="rounded-full bg-[#FBF6E6] px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-[#8C7325]">Beta</span></div><p className="mt-1 text-sm text-[#817B70]">CPF {detail.cpf || 'não informado'} · cliente desde {date(detail.createdAt)}</p></div>
            </div>
            <div className="flex flex-wrap gap-2 lg:ml-auto">
              {whatsappDigits && <button type="button" onClick={() => falarComCliente(whatsappDigits)} className="rounded-lg border border-[#D8D3C8] bg-white px-4 py-2 text-sm font-semibold" title="Abre no WhatsApp que já está logado neste PC"><MessageCircle className="mr-2 inline h-4 w-4" />WhatsApp</button>}
              <Link href={`/clientes-crm?openId=${id}`} className="rounded-lg border border-[#D8D3C8] bg-white px-4 py-2 text-sm font-semibold">Ficha antiga <ExternalLink className="ml-2 inline h-4 w-4" /></Link>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-2 text-xs">
            <span className="rounded-full border bg-white px-3 py-1">{detail.vipTier || 'bronze'}</span>
            {detail.rfvSegment && <span className="rounded-full border bg-white px-3 py-1">{detail.rfvSegment}</span>}
            {detail.sizeDefault && <span className="rounded-full border bg-white px-3 py-1">Manequim {detail.sizeDefault}</span>}
            {channels.map((c: string) => <span key={c} className="rounded-full border bg-white px-3 py-1">Origem: {c}</span>)}
            <span className={`rounded-full border px-3 py-1 ${detail.active ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-800'}`}>{detail.active ? 'Ativa' : 'Inativa'}</span>
          </div>
        </div>
      </div>

      <div className="sticky top-0 z-20 border-b border-[#DEDCD7] bg-white/95 backdrop-blur">
        <nav className="mx-auto flex max-w-7xl gap-1 overflow-x-auto px-4 sm:px-6">
          {ABAS.map(([key, label]) => <button key={key} onClick={() => chooseTab(key)} className={`shrink-0 border-b-2 px-3 py-3 text-sm font-medium ${tab === key ? 'border-[#27241F] text-[#27241F]' : 'border-transparent text-[#817B70] hover:text-[#27241F]'}`}>{label}</button>)}
        </nav>
      </div>

      <div className="mx-auto max-w-7xl space-y-4 px-4 py-6 sm:px-6">
        {tab === 'resumo' && <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4"><Card><Field label="Total em compras" value={money(totalLtv)} moneyValue /></Card><Card><Field label="Compras" value={totalOrders} /></Card><Card><Field label="Ticket médio" value={money(totalOrders ? totalLtv / totalOrders : 0)} moneyValue /></Card><Card><Field label="Cashback disponível" value={money(detail.cashbackBalance?.balanceCents)} moneyValue /></Card></div>
          {(person?.agregado?.totalCadastros || 0) > 1 && <Card className="border-[#D9CCE8] bg-[#F7F2FC]"><div className="flex gap-3"><Users className="h-5 w-5 text-purple-700" /><div><h2 className="font-semibold text-purple-950">Uma pessoa, {person?.agregado?.totalCadastros} cadastros vinculados</h2><p className="mt-1 text-sm text-purple-800">Canais: {channels.join(', ')}{person?.agregado?.lojas?.length ? ` · Lojas: ${person?.agregado?.lojas.join(', ')}` : ''}</p><p className="mt-1 text-xs text-purple-700">A ficha soma a trajetória da cliente sem apagar os registros de origem.</p></div></div></Card>}
          {!person?.personId && <Card className="border-amber-200 bg-amber-50"><p className="text-sm text-amber-900"><ShieldCheck className="mr-2 inline h-4 w-4" />Identidade provisória: este cadastro ainda não foi vinculado à base única de pessoas.</p></Card>}
          <div className="grid gap-4 lg:grid-cols-2"><Card><SectionTitle>Contato e relacionamento</SectionTitle><div className="grid grid-cols-2 gap-4"><Field label="WhatsApp" value={phone(detail.whatsapp)} /><Field label="E-mail" value={detail.email} /><Field label="Vendedora que captou" value={detail.originSeller} /><Field label="Última compra" value={date(detail.lastOrderAt)} /></div></Card><Card><SectionTitle>Origem da cliente</SectionTitle><div className="space-y-3 text-sm"><div className="flex gap-3"><Store className="h-4 w-4 text-[#8C7325]" /><span>{detail.originStore ? `${detail.originStore.code} · ${detail.originStore.name}` : 'Loja não informada'}</span></div><div className="flex gap-3"><UserRound className="h-4 w-4 text-[#8C7325]" /><span>{channels.join(', ') || 'Origem não informada'}</span></div><div className="flex gap-3"><Clock3 className="h-4 w-4 text-[#8C7325]" /><span>Atualizada em {date(detail.updatedAt, true)}</span></div></div></Card></div>
        </>}

        {tab === 'cadastro' && <div className="grid gap-4 lg:grid-cols-2"><EditSection title="Identificação" data={detail} onSaved={load} fields={[{key:'name',label:'Nome completo'},{key:'nameSocial',label:'Nome social'},{key:'cpf',label:'CPF'},{key:'birthDate',label:'Nascimento',type:'date'},{key:'gender',label:'Gênero'},{key:'maritalStatus',label:'Estado civil'}]} /><EditSection title="Contato" data={detail} onSaved={load} fields={[{key:'whatsapp',label:'WhatsApp'},{key:'phone',label:'Telefone fixo'},{key:'email',label:'E-mail',type:'email'}]} /><Card><SectionTitle>Origem e atribuição</SectionTitle><div className="grid grid-cols-2 gap-4"><Field label="Loja de origem" value={detail.originStore?.name} /><Field label="Canal de origem" value={origemLabel[detail.originSource] || detail.originSource} /><Field label="Vendedora" value={detail.originSeller} /><Field label="Registro Giga" value={detail.registroGiga} /></div></Card><Card><SectionTitle>Dados complementares</SectionTitle><div className="grid grid-cols-2 gap-4"><Field label="RG" value={detail.rg} /><Field label="Naturalidade" value={detail.naturalidade} /><Field label="Pai" value={detail.pai} /><Field label="Mãe" value={detail.mae} /></div></Card></div>}

        {tab === 'perfil' && <div className="grid gap-4 lg:grid-cols-2"><EditSection title="Perfil Plus Size" data={detail} onSaved={load} fields={[{key:'sizeDefault',label:'Manequim principal'},{key:'sizeSecondary',label:'Manequim secundário'},{key:'bodyType',label:'Tipo de corpo'},{key:'preferredStyle',label:'Estilo preferido'},{key:'favoriteColors',label:'Cores favoritas'},{key:'avoidedPieces',label:'Peças que evita'}]} /><Card><SectionTitle>Segmentação</SectionTitle><div className="grid grid-cols-2 gap-4"><Field label="Tier atual" value={detail.vipTier} /><Field label="Entrada no tier" value={date(detail.tierEnteredAt)} /><Field label="Classificação RFV" value={detail.rfvSegment} /><Field label="Engajamento" value={detail.rfvEngagement !== null ? `${detail.rfvEngagement || 0} / 100` : null} /></div></Card></div>}

        {tab === 'credito' && <><div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><ShieldCheck className="mr-2 inline h-4 w-4" />Dados sensíveis. {isAdmin ? <>Somente administradores podem alterar esta aba.<CreditEditor data={detail} onSaved={load} /></> : 'Somente administradores podem alterar esta aba.'}</div><div className="grid gap-4 lg:grid-cols-2">{isAdmin && <MarkedAuthorization fichas={detail.markedAuthorizations || []} onSaved={load} />}<Card><SectionTitle>Limite e situação</SectionTitle><div className="grid grid-cols-2 gap-4"><Field label="Limite de compras" value={detail.limiteCrediarioCents ? money(detail.limiteCrediarioCents) : null} moneyValue /><Field label="Bloqueada" value={detail.bloqueadoGiga === true ? 'Sim' : detail.bloqueadoGiga === false ? 'Não' : null} /><Field label="SPC / negativada" value={detail.negativadoGiga === true ? 'Sim' : detail.negativadoGiga === false ? 'Não' : null} /><Field label="Situação SPC" value={detail.spcSituacao} /><Field label="Data da consulta" value={date(detail.spcData)} /><Field label="Casa própria" value={detail.casaPropria === true ? 'Sim' : detail.casaPropria === false ? 'Não' : null} /></div></Card><Card><SectionTitle>Trabalho e renda</SectionTitle><div className="grid grid-cols-2 gap-4"><Field label="Empresa" value={detail.trabalhoRazaoSocial} /><Field label="Cargo" value={detail.trabalhoCargo} /><Field label="Admissão" value={date(detail.trabalhoAdmissao)} /><Field label="Salário" value={detail.trabalhoSalarioCents ? money(detail.trabalhoSalarioCents) : null} moneyValue /><Field label="Telefone comercial" value={phone(detail.trabalhoFone)} /><Field label="Aluguel" value={detail.aluguelCents ? money(detail.aluguelCents) : null} moneyValue /></div></Card></div></>}

        {tab === 'compras' && <Card><SectionTitle>Histórico consolidado · loja + site + live</SectionTitle>{loadingHistory ? <div className="py-10 text-center text-[#817B70]"><Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin" />Carregando compras…</div> : history?.error ? <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{history.error}</div> : history?.compras?.length ? <div className="divide-y">{history.compras.map((c: AnyRecord) => <div key={`${c.canal}-${c.id}`} className="flex items-start gap-3 py-4"><div className="rounded-lg bg-[#F2F0EB] p-2"><ShoppingBag className="h-4 w-4" /></div><div className="min-w-0 flex-1"><div className="font-medium">{c.canal === 'loja' ? c.storeName : c.canal === 'live' ? 'Live Commerce' : 'Site'} · {c.saleNumber}</div><div className="mt-1 text-xs text-[#817B70]">{date(c.data, true)} · {c.qtdItens} peça(s){c.sellerName ? ` · ${c.sellerName}` : ''}</div></div><div className="font-semibold text-[#2E7D46]">{Number(c.total || 0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}</div></div>)}</div> : <p className="py-8 text-center text-sm italic text-[#AAA49A]">Nenhuma compra localizada</p>}</Card>}

        {tab === 'cashback' && <><div className="grid grid-cols-2 gap-3 lg:grid-cols-4"><Card><Field label="Saldo atual" value={money(detail.cashbackBalance?.balanceCents)} moneyValue /></Card><Card><Field label="Acumulado" value={money(detail.cashbackBalance?.accumulatedTotalCents)} moneyValue /></Card><Card><Field label="Resgatado" value={money(detail.cashbackBalance?.redeemedTotalCents)} /></Card><Card><Field label="Próxima expiração" value={detail.cashbackBalance?.nextExpirationAt ? `${money(detail.cashbackBalance.nextExpirationCents)} · ${date(detail.cashbackBalance.nextExpirationAt)}` : null} /></Card></div><Card><SectionTitle>Extrato</SectionTitle>{detail.cashbackTransactions?.length ? <div className="divide-y">{detail.cashbackTransactions.map((tx: AnyRecord) => <div key={tx.id} className="flex justify-between gap-3 py-3 text-sm"><div><div>{tx.description || tx.type}</div><div className="text-xs text-[#817B70]">{date(tx.createdAt, true)}{tx.store ? ` · ${tx.store.name}` : ''}</div></div><span className={tx.type === 'credit' ? 'font-semibold text-[#2E7D46]' : 'font-semibold'}>{tx.type === 'credit' ? '+' : '−'} {money(tx.valueCents)}</span></div>)}</div> : <p className="text-sm italic text-[#AAA49A]">Sem movimentações</p>}</Card></>}

        {tab === 'enderecos' && <div className="grid gap-4 lg:grid-cols-2">{detail.addresses?.length ? detail.addresses.map((a: AnyRecord) => <Card key={a.id}><SectionTitle>{a.type || 'Endereço'}{a.isPrimary && <span className="rounded-full bg-[#FBF6E6] px-2 py-1 text-[10px] text-[#8C7325]">Principal</span>}</SectionTitle><div className="grid grid-cols-2 gap-4"><Field label="CEP" value={a.cep} /><Field label="Logradouro" value={[a.street,a.number].filter(Boolean).join(', ')} /><Field label="Complemento" value={a.complement} /><Field label="Bairro" value={a.district} /><Field label="Cidade / UF" value={[a.city,a.state].filter(Boolean).join(' / ')} /><Field label="Referência" value={a.reference} /></div></Card>) : <Card><p className="text-sm italic text-[#AAA49A]">Nenhum endereço cadastrado</p></Card>}</div>}

        {tab === 'lgpd' && <Card><SectionTitle>Consentimentos atuais</SectionTitle><div className="mb-4 rounded-lg bg-[#F2F0EB] p-3 text-xs text-[#6B665D]">Cada alteração gera um novo evento. O histórico de consentimento não é apagado.</div><div className="grid grid-cols-2 gap-4 sm:grid-cols-3">{['whatsapp','email','sms','mail','general'].map(k => <Field key={k} label={k === 'general' ? 'Termo geral' : k.toUpperCase()} value={detail.currentConsents?.[k] === true ? 'Aceito' : detail.currentConsents?.[k] === false ? 'Revogado' : null} />)}</div></Card>}

        {tab === 'auditoria' && <div className="grid gap-4 lg:grid-cols-2"><Card><SectionTitle>Controle do registro</SectionTitle><div className="grid grid-cols-2 gap-4"><Field label="Criado em" value={date(detail.createdAt, true)} /><Field label="Atualizado em" value={date(detail.updatedAt, true)} /><Field label="Status da identidade" value={person?.personId ? 'Consolidada' : 'Provisória'} /><Field label="Cadastros vinculados" value={person?.agregado?.totalCadastros || 1} /></div></Card><Card><SectionTitle>Registros de origem</SectionTitle><div className="space-y-3">{[detail, ...(person?.outros || [])].map((c: AnyRecord) => <div key={c.id} className="flex items-center gap-3 rounded-lg border border-[#ECE9E2] p-3"><div className="rounded-lg bg-[#F2F0EB] p-2"><Store className="h-4 w-4" /></div><div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">{c.name || name}</div><div className="text-xs text-[#817B70]">{origemLabel[c.originSource] || c.originSource || 'Origem não informada'}{c.originStore?.name ? ` · ${c.originStore.name}` : ''}</div></div><ChevronRight className="h-4 w-4 text-[#AAA49A]" /></div>)}</div></Card></div>}
      </div>
    </main>
  );
}
