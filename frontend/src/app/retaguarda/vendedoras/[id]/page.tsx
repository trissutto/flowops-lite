'use client';

/**
 * /retaguarda/vendedoras/[id] — PRONTUARIO RH
 *
 * Tela completa da funcionaria com 4 secoes:
 *   1. Pessoais (CPF, RG, endereco, contato)
 *   2. Contrato (cargo, salario, admissao, ferias, horario)
 *   3. Comissao (vinculo com loja responsavel — link pra /comissoes/cargos)
 *   4. Documentos (upload de contratos, atestados, recibos — Fase 2)
 *
 * Edicao inline com botao Salvar no final de cada secao.
 */

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft, Save, Loader2, User, FileText, DollarSign, Calendar,
  Phone, Mail, MapPin, Briefcase, Plane, Power, AlertCircle, Paperclip,
  Clock, Camera,
} from 'lucide-react';
import { api } from '@/lib/api';
import DocumentsSection from '@/components/rh/DocumentsSection';
import HorarioGrid from '@/components/rh/HorarioGrid';

type Seller = {
  id: string;
  name: string;
  whatsapp: string | null;
  active: boolean;
  createdAt: string;
  cargo?: string;
  responsibleStoreId?: string | null;
  responsibleStore?: { id: string; code: string; name: string } | null;
  wincredCodigo?: string | null;
  storeCodeOrigin?: string | null;
  // RH
  cpf?: string | null;
  rg?: string | null;
  email?: string | null;
  dataNascimento?: string | null;
  endereco?: string | null;
  cidade?: string | null;
  uf?: string | null;
  cep?: string | null;
  dataAdmissao?: string | null;
  contratoTipo?: string | null;
  cargoFuncao?: string | null;
  salarioBase?: number | string | null;
  horarioTrabalho?: any;
  dataInicioFerias?: string | null;
  dataFimFerias?: string | null;
  observacoes?: string | null;
  documents?: Array<{
    id: string;
    categoria: string;
    titulo: string;
    fileUrl: string;
    uploadedAt: string;
  }>;
  faceEnrolledAt?: string | null;
  faceSnapshotUrl?: string | null;
};

const brl = (n: any) =>
  Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const fmtDate = (s?: string | null) => {
  if (!s) return '—';
  try {
    return new Date(s).toLocaleDateString('pt-BR');
  } catch {
    return '—';
  }
};

const inputDate = (s?: string | null) => {
  if (!s) return '';
  try {
    return new Date(s).toISOString().slice(0, 10);
  } catch {
    return '';
  }
};

const CONTRATO_TIPOS = ['CLT', 'PJ', 'ESTAGIO', 'FREELA', 'OUTROS'];

export default function ProntuarioPage() {
  const params = useParams();
  const router = useRouter();
  const id = params?.id as string;

  const [data, setData] = useState<Seller | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Alterações não salvas — protege contra perder edição ao abrir a câmera
  // do cadastro facial (clique no botão errado descartava tudo).
  const [dirty, setDirty] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const r = await api<Seller>(`/sellers/${id}/detail`);
      setData(r);
    } catch (e: any) {
      setError(e?.message || 'Erro');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (id) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  function update<K extends keyof Seller>(key: K, value: any) {
    if (!data) return;
    setData({ ...data, [key]: value });
    setDirty(true);
  }

  async function salvar(opts?: { silent?: boolean }): Promise<boolean> {
    if (!data) return false;
    setSaving(true);
    try {
      await api(`/sellers/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: data.name,
          whatsapp: data.whatsapp,
          cargo: data.cargo,
          cpf: data.cpf,
          rg: data.rg,
          email: data.email,
          dataNascimento: data.dataNascimento || null,
          endereco: data.endereco,
          cidade: data.cidade,
          uf: data.uf,
          cep: data.cep,
          dataAdmissao: data.dataAdmissao || null,
          contratoTipo: data.contratoTipo,
          cargoFuncao: data.cargoFuncao,
          salarioBase: data.salarioBase ? Number(data.salarioBase) : null,
          dataInicioFerias: data.dataInicioFerias || null,
          dataFimFerias: data.dataFimFerias || null,
          horarioTrabalho: data.horarioTrabalho ?? null,
          observacoes: data.observacoes,
        }),
      });
      setDirty(false);
      if (!opts?.silent) {
        alert('✓ Salvo');
        load();
      }
      return true;
    } catch (e: any) {
      alert('Erro: ' + (e?.message || e));
      return false;
    } finally {
      setSaving(false);
    }
  }

  /** Abre a câmera do cadastro facial SEM perder edição: salva antes se preciso. */
  async function abrirCameraFace() {
    if (dirty) {
      const ok = await salvar({ silent: true });
      if (!ok) return; // erro já apareceu no alert — não navega
    }
    router.push(`/retaguarda/rh/face-enroll/${id}`);
  }

  async function toggleAtivo() {
    if (!data) return;
    if (
      !confirm(
        data.active
          ? `DESLIGAR ${data.name}? Some do PDV. Histórico fica preservado.`
          : `Reativar ${data.name}?`,
      )
    )
      return;
    try {
      await api(`/sellers/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ active: !data.active }),
      });
      load();
    } catch (e: any) {
      alert('Erro: ' + (e?.message || e));
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-emerald-600" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="bg-white border border-red-200 rounded-xl p-5 max-w-sm">
          <p className="font-bold text-red-700">Erro</p>
          <p className="text-sm text-slate-600 mt-1">{error || 'Não encontrada'}</p>
          <Link
            href="/retaguarda/vendedoras"
            className="mt-3 block w-full bg-slate-800 text-white text-center py-2 rounded font-bold"
          >
            Voltar
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-brand text-white shadow sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link href="/retaguarda/vendedoras" className="p-2 hover:bg-white/10 rounded">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="w-10 h-10 rounded-full bg-white/20 flex items-center justify-center">
            <User className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <h1 className="text-xl font-bold">{data.name}</h1>
            <p className="text-xs text-white/80">
              {data.wincredCodigo && <>#{data.wincredCodigo} · </>}
              {data.cargo || 'VENDEDORA'}
              {data.responsibleStore && <> · {data.responsibleStore.name}</>}
            </p>
          </div>
          <button
            onClick={toggleAtivo}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg font-bold text-sm ${
              data.active
                ? 'bg-emerald-500/30 hover:bg-emerald-500/50'
                : 'bg-red-500/30 hover:bg-red-500/50'
            }`}
          >
            <Power className="w-4 h-4" />
            {data.active ? 'ATIVA' : 'DESLIGADA'}
          </button>
        </div>
      </header>

      <div className="max-w-4xl mx-auto p-4 space-y-4">
        {/* PESSOAIS */}
        <Section icon={<User className="w-4 h-4" />} title="Dados pessoais">
          <Grid>
            <Field label="Nome completo">
              <Input value={data.name} onChange={(v) => update('name', v)} />
            </Field>
            <Field label="CPF">
              <Input
                value={data.cpf || ''}
                onChange={(v) => update('cpf', v)}
                placeholder="000.000.000-00"
              />
            </Field>
            <Field label="RG">
              <Input
                value={data.rg || ''}
                onChange={(v) => update('rg', v)}
                placeholder="00.000.000-0"
              />
            </Field>
            <Field label="Data de nascimento">
              <Input
                type="date"
                value={inputDate(data.dataNascimento)}
                onChange={(v) => update('dataNascimento', v)}
              />
            </Field>
            <Field label="WhatsApp">
              <Input
                value={data.whatsapp || ''}
                onChange={(v) => update('whatsapp', v)}
                placeholder="(11) 99999-9999"
              />
            </Field>
            <Field label="E-mail">
              <Input
                type="email"
                value={data.email || ''}
                onChange={(v) => update('email', v)}
                placeholder="nome@email.com"
              />
            </Field>
          </Grid>
          <div className="mt-3">
            <Field label="Endereço">
              <Input
                value={data.endereco || ''}
                onChange={(v) => update('endereco', v)}
                placeholder="Rua, número, complemento"
              />
            </Field>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-3">
              <Field label="CEP">
                <Input
                  value={data.cep || ''}
                  onChange={(v) => update('cep', v)}
                  placeholder="00000-000"
                />
              </Field>
              <Field label="Cidade">
                <Input value={data.cidade || ''} onChange={(v) => update('cidade', v)} />
              </Field>
              <Field label="UF">
                <Input
                  value={data.uf || ''}
                  onChange={(v) => update('uf', v.toUpperCase().slice(0, 2))}
                  placeholder="SP"
                />
              </Field>
            </div>
          </div>
        </Section>

        {/* CONTRATO */}
        <Section icon={<Briefcase className="w-4 h-4" />} title="Contrato e cargo">
          <Grid>
            <Field label="Função (título)">
              <Input
                value={data.cargoFuncao || ''}
                onChange={(v) => update('cargoFuncao', v)}
                placeholder="Ex: Vendedora Sr"
              />
            </Field>
            <Field label="Tipo de contrato">
              <select
                value={data.contratoTipo || ''}
                onChange={(e) => update('contratoTipo', e.target.value)}
                className="w-full px-3 py-2 border rounded"
              >
                <option value="">—</option>
                {CONTRATO_TIPOS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Data de admissão">
              <Input
                type="date"
                value={inputDate(data.dataAdmissao)}
                onChange={(v) => update('dataAdmissao', v)}
              />
            </Field>
            <Field label="Salário base">
              <Input
                type="number"
                step="0.01"
                value={String(data.salarioBase || '')}
                onChange={(v) => update('salarioBase', v)}
                placeholder="0.00"
              />
            </Field>
          </Grid>
        </Section>

        {/* FERIAS */}
        <Section icon={<Plane className="w-4 h-4" />} title="Férias">
          <Grid>
            <Field label="Início das férias">
              <Input
                type="date"
                value={inputDate(data.dataInicioFerias)}
                onChange={(v) => update('dataInicioFerias', v)}
              />
            </Field>
            <Field label="Fim das férias">
              <Input
                type="date"
                value={inputDate(data.dataFimFerias)}
                onChange={(v) => update('dataFimFerias', v)}
              />
            </Field>
          </Grid>
          {data.dataAdmissao && (
            <FeriasInfo
              admissao={data.dataAdmissao}
              dataFimFerias={data.dataFimFerias || null}
            />
          )}
        </Section>

        {/* HORARIO DE TRABALHO */}
        <Section icon={<Clock className="w-4 h-4" />} title="Horário de trabalho">
          <HorarioGrid
            value={data.horarioTrabalho}
            onChange={(v) => update('horarioTrabalho', v)}
          />
        </Section>

        {/* COMISSAO */}
        <Section icon={<DollarSign className="w-4 h-4" />} title="Comissão">
          <p className="text-sm text-slate-600">
            Cargo de comissão: <b>{data.cargo || 'VENDEDORA'}</b>
            {data.responsibleStore && (
              <> · responde pela loja <b>{data.responsibleStore.name}</b></>
            )}
          </p>
          <Link
            href="/retaguarda/comissoes/cargos"
            className="mt-2 inline-block text-sm text-emerald-700 font-bold hover:underline"
          >
            Editar cargo + loja responsável →
          </Link>
        </Section>

        {/* PONTO ELETRÔNICO — Cadastro facial */}
        <Section icon={<Camera className="w-4 h-4" />} title="Ponto eletrônico (face)">
          {data.faceEnrolledAt ? (
            <div className="flex items-center gap-3">
              {data.faceSnapshotUrl && (
                <img
                  src={data.faceSnapshotUrl}
                  alt="Foto referência"
                  className="w-16 h-16 rounded-lg object-cover border-2 border-emerald-300"
                />
              )}
              <div className="flex-1">
                <p className="text-sm font-bold text-emerald-700">
                  ✓ Rosto cadastrado
                </p>
                <p className="text-xs text-slate-500">
                  Cadastrado em {fmtDate(data.faceEnrolledAt)}
                </p>
              </div>
              <button
                onClick={abrirCameraFace}
                className="text-sm text-emerald-700 font-bold hover:underline"
              >
                📷 Refazer rosto
              </button>
            </div>
          ) : (
            <div className="flex items-center justify-between bg-amber-50 border border-amber-200 rounded-lg p-3">
              <div>
                <p className="text-sm font-bold text-amber-800">
                  Sem cadastro facial
                </p>
                <p className="text-xs text-amber-700">
                  Sem ele, {data.name.split(' ')[0]} não consegue bater ponto no PDV.
                </p>
              </div>
              <button
                onClick={abrirCameraFace}
                className="bg-amber-500 hover:bg-amber-600 text-white font-bold text-sm px-3 py-2 rounded-lg whitespace-nowrap"
              >
                📷 Cadastrar rosto (câmera)
              </button>
            </div>
          )}
        </Section>

        {/* DOCUMENTOS — FASE 2 ATIVO */}
        <Section icon={<Paperclip className="w-4 h-4" />} title="Documentos">
          <DocumentsSection sellerId={id} />
        </Section>

        {/* OBSERVACOES */}
        <Section icon={<FileText className="w-4 h-4" />} title="Observações">
          <textarea
            value={data.observacoes || ''}
            onChange={(e) => update('observacoes', e.target.value)}
            rows={4}
            placeholder="Notas livres (alergias, contatos emergência, restrições, etc)"
            className="w-full px-3 py-2 border rounded text-sm"
          />
        </Section>

        {/* SAVE */}
        <div className="sticky bottom-4 bg-white border-2 border-emerald-500 rounded-xl p-3 shadow-lg flex items-center justify-end gap-3">
          {dirty && (
            <span className="text-xs font-bold text-amber-600">
              ● alterações não salvas
            </span>
          )}
          <button
            onClick={() => salvar()}
            disabled={saving}
            className="bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-bold px-6 py-2.5 rounded-lg flex items-center gap-2"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            Salvar prontuário
          </button>
        </div>
      </div>
    </div>
  );
}

function Section({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4">
      <div className="flex items-center gap-2 mb-3 pb-2 border-b border-slate-100">
        <div className="w-7 h-7 rounded-lg bg-emerald-100 text-emerald-700 flex items-center justify-center">
          {icon}
        </div>
        <h2 className="font-bold text-slate-800">{title}</h2>
      </div>
      {children}
    </div>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 md:grid-cols-2 gap-3">{children}</div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-bold uppercase text-slate-500 mb-1">{label}</label>
      {children}
    </div>
  );
}

function Input({
  value,
  onChange,
  type = 'text',
  placeholder,
  step,
}: {
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  step?: string;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      step={step}
      className="w-full px-3 py-2 border rounded text-sm"
    />
  );
}

function FeriasInfo({
  admissao,
  dataFimFerias,
}: {
  admissao: string;
  dataFimFerias: string | null;
}) {
  // Calcula próximo vencimento (12 meses após admissão)
  const adm = new Date(admissao);
  const proxVenc = new Date(adm);
  // Ciclo aquisitivo de 12 meses + 12 meses de prazo concessivo
  while (proxVenc < new Date()) {
    proxVenc.setFullYear(proxVenc.getFullYear() + 1);
  }
  const baseRef = dataFimFerias ? new Date(dataFimFerias) : adm;
  const venc = new Date(baseRef);
  venc.setFullYear(venc.getFullYear() + 1);
  const diasFalta = Math.ceil((venc.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
  const alerta = diasFalta < 60;
  return (
    <div
      className={`mt-3 p-3 rounded-lg flex items-start gap-2 text-sm ${
        alerta ? 'bg-amber-50 border border-amber-200' : 'bg-emerald-50 border border-emerald-200'
      }`}
    >
      <AlertCircle
        className={`w-4 h-4 mt-0.5 ${alerta ? 'text-amber-600' : 'text-emerald-600'}`}
      />
      <div>
        <div className="font-bold">
          {alerta ? '⚠️ Férias vencendo' : '✓ Férias no prazo'}
        </div>
        <div className="text-xs text-slate-600 mt-0.5">
          Próximo vencimento (estimado): <b>{venc.toLocaleDateString('pt-BR')}</b>
          {' '}({diasFalta > 0 ? `em ${diasFalta} dias` : `há ${-diasFalta} dias`})
        </div>
      </div>
    </div>
  );
}
