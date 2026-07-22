'use client';

/**
 * /retaguarda/vendedoras/nova
 *
 * Cadastro completo de nova funcionaria. Preenche tudo de uma vez:
 * dados pessoais, contrato, ferias, cargo de comissao. Apos salvar,
 * redireciona pro prontuario dela (/retaguarda/vendedoras/[id]) onde
 * pode anexar documentos depois.
 *
 * UX: pequenos blocos colapsaveis, validacao inline, lookup ViaCEP
 * automatico ao digitar o CEP.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft, Save, Loader2, User, Briefcase, Plane, DollarSign,
  FileText, Calendar, MapPin, AlertCircle, Clock,
} from 'lucide-react';
import { api } from '@/lib/api';
import HorarioGrid from '@/components/rh/HorarioGrid';

type Cargo = 'VENDEDORA' | 'LIDER_B' | 'LIDER_A' | 'GERENTE_B' | 'GERENTE_A';

const CARGOS: { value: Cargo; label: string; pct: string }[] = [
  { value: 'VENDEDORA', label: 'Vendedora', pct: '2% sobre vendas próprias' },
  { value: 'LIDER_B',   label: 'Líder B',   pct: '0,5% sobre loja toda' },
  { value: 'LIDER_A',   label: 'Líder A',   pct: '1,0% sobre loja toda' },
  { value: 'GERENTE_B', label: 'Gerente B', pct: '1,5% sobre loja toda' },
  { value: 'GERENTE_A', label: 'Gerente A', pct: '2,0% sobre loja toda' },
];

const CONTRATO_TIPOS = ['CLT', 'PJ', 'ESTAGIO', 'FREELA', 'OUTROS'];

type Store = { id: string; code: string; name: string; active: boolean };

export default function NovaFuncionariaPage() {
  const router = useRouter();

  // Dados pessoais
  const [name, setName] = useState('');
  const [apelido, setApelido] = useState('');
  const [cpf, setCpf] = useState('');
  const [rg, setRg] = useState('');
  const [dataNascimento, setDataNascimento] = useState('');
  const [whatsapp, setWhatsapp] = useState('');
  const [email, setEmail] = useState('');
  // Endereço
  const [cep, setCep] = useState('');
  const [endereco, setEndereco] = useState('');
  const [cidade, setCidade] = useState('');
  const [uf, setUf] = useState('');
  // Contrato
  const [cargo, setCargo] = useState<Cargo>('VENDEDORA');
  const [responsibleStoreId, setResponsibleStoreId] = useState('');
  const [cargoFuncao, setCargoFuncao] = useState('');
  const [contratoTipo, setContratoTipo] = useState('CLT');
  const [dataAdmissao, setDataAdmissao] = useState(new Date().toISOString().slice(0, 10));
  const [salarioBase, setSalarioBase] = useState('');
  const [storeCodeOrigin, setStoreCodeOrigin] = useState('');
  // Férias
  const [dataInicioFerias, setDataInicioFerias] = useState('');
  const [dataFimFerias, setDataFimFerias] = useState('');
  // Horário de trabalho (com almoço)
  const [horarioTrabalho, setHorarioTrabalho] = useState<any>(null);
  // Obs
  const [observacoes, setObservacoes] = useState('');

  const [stores, setStores] = useState<Store[]>([]);
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [cepLoading, setCepLoading] = useState(false);

  useEffect(() => {
    api<Store[]>('/stores')
      .then((arr) =>
        setStores(arr.filter((s) => s.active).sort((a, b) => a.code.localeCompare(b.code))),
      )
      .catch(() => {});
  }, []);

  // Auto-lookup ViaCEP quando CEP tiver 8 dígitos
  useEffect(() => {
    const digits = cep.replace(/\D/g, '');
    if (digits.length !== 8) return;
    setCepLoading(true);
    fetch(`https://viacep.com.br/ws/${digits}/json/`)
      .then((r) => r.json())
      .then((d) => {
        if (d?.logradouro) setEndereco(d.logradouro);
        if (d?.localidade) setCidade(d.localidade);
        if (d?.uf) setUf(d.uf);
      })
      .catch(() => {})
      .finally(() => setCepLoading(false));
  }, [cep]);

  async function salvar() {
    setErrorMsg(null);
    const nome = name.trim();
    if (!nome) {
      setErrorMsg('Nome é obrigatório.');
      return;
    }
    if ((cargo === 'LIDER_A' || cargo === 'LIDER_B' || cargo === 'GERENTE_A' || cargo === 'GERENTE_B') && !responsibleStoreId) {
      setErrorMsg(`${cargo} precisa ter uma loja responsável vinculada.`);
      return;
    }

    setSaving(true);
    try {
      const body: any = {
        name: nome,
        apelido: apelido.trim() || undefined,
        cargo,
        responsibleStoreId: responsibleStoreId || null,
        cpf: cpf.replace(/\D/g, '') || undefined,
        rg: rg || undefined,
        whatsapp: whatsapp || undefined,
        email: email || undefined,
        dataNascimento: dataNascimento || undefined,
        endereco: endereco || undefined,
        cidade: cidade || undefined,
        uf: uf || undefined,
        cep: cep.replace(/\D/g, '') || undefined,
        dataAdmissao: dataAdmissao || undefined,
        contratoTipo: contratoTipo || undefined,
        cargoFuncao: cargoFuncao || undefined,
        salarioBase: salarioBase ? Number(salarioBase) : undefined,
        dataInicioFerias: dataInicioFerias || undefined,
        dataFimFerias: dataFimFerias || undefined,
        horarioTrabalho: horarioTrabalho ?? undefined,
        observacoes: observacoes || undefined,
        storeCodeOrigin: storeCodeOrigin || undefined,
      };
      const r = await api<{ id: string }>('/sellers', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      alert(`✓ Funcionária ${nome} cadastrada!`);
      router.push(`/retaguarda/vendedoras/${r.id}`);
    } catch (e: any) {
      setErrorMsg(e?.message || String(e));
    } finally {
      setSaving(false);
    }
  }

  const cargoInfo = CARGOS.find((c) => c.value === cargo)!;
  const precisaLoja = cargo !== 'VENDEDORA';

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
            <h1 className="text-xl font-bold">Nova funcionária</h1>
            <p className="text-xs text-white/80">
              Cadastro completo: pessoais, contrato, comissão
            </p>
          </div>
        </div>
      </header>

      <div className="max-w-4xl mx-auto p-4 space-y-4">
        {errorMsg && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-red-600 mt-0.5" />
            <p className="text-sm text-red-800">{errorMsg}</p>
          </div>
        )}

        {/* PESSOAIS */}
        <Section icon={<User />} title="Dados pessoais" required>
          <Grid>
            <Field label="Nome completo *" required>
              <Input value={name} onChange={setName} placeholder="Ex: Maria Silva" autoFocus />
            </Field>
            <Field label="Apelido (aparece no PDV)">
              <Input value={apelido} onChange={(v) => setApelido(v.toUpperCase())} placeholder="Ex.: LETICIA 2, JÔ, MARI" />
            </Field>
            <Field label="CPF">
              <Input value={cpf} onChange={setCpf} placeholder="000.000.000-00" />
            </Field>
            <Field label="RG">
              <Input value={rg} onChange={setRg} placeholder="00.000.000-0" />
            </Field>
            <Field label="Data de nascimento">
              <Input type="date" value={dataNascimento} onChange={setDataNascimento} />
            </Field>
            <Field label="WhatsApp">
              <Input value={whatsapp} onChange={setWhatsapp} placeholder="(11) 99999-9999" />
            </Field>
            <Field label="E-mail">
              <Input type="email" value={email} onChange={setEmail} placeholder="nome@email.com" />
            </Field>
          </Grid>
        </Section>

        {/* ENDEREÇO */}
        <Section icon={<MapPin />} title="Endereço">
          <Grid>
            <Field label={`CEP ${cepLoading ? '(buscando...)' : ''}`}>
              <Input value={cep} onChange={setCep} placeholder="00000-000" />
            </Field>
            <Field label="UF">
              <Input
                value={uf}
                onChange={(v) => setUf(v.toUpperCase().slice(0, 2))}
                placeholder="SP"
              />
            </Field>
            <div className="md:col-span-2">
              <Field label="Endereço">
                <Input value={endereco} onChange={setEndereco} placeholder="Rua, número, complemento" />
              </Field>
            </div>
            <div className="md:col-span-2">
              <Field label="Cidade">
                <Input value={cidade} onChange={setCidade} />
              </Field>
            </div>
          </Grid>
        </Section>

        {/* CONTRATO */}
        <Section icon={<Briefcase />} title="Contrato e cargo" required>
          <div className="mb-3">
            <label className="block text-xs font-bold uppercase text-slate-500 mb-1">
              Cargo de comissão *
            </label>
            <select
              value={cargo}
              onChange={(e) => setCargo(e.target.value as Cargo)}
              className="w-full px-3 py-2 border rounded text-sm"
            >
              {CARGOS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label} — {c.pct}
                </option>
              ))}
            </select>
            <p className="text-xs text-slate-500 mt-1">{cargoInfo.pct}</p>
          </div>

          {precisaLoja && (
            <Field label={`Loja responsável * (${cargoInfo.label} ganha % sobre ela)`} required>
              <select
                value={responsibleStoreId}
                onChange={(e) => setResponsibleStoreId(e.target.value)}
                className="w-full px-3 py-2 border rounded text-sm"
              >
                <option value="">— escolha a loja —</option>
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.code} {s.name}
                  </option>
                ))}
              </select>
            </Field>
          )}

          <div className="mt-3">
            <Field label="Loja onde trabalha">
              <select
                value={storeCodeOrigin}
                onChange={(e) => setStoreCodeOrigin(e.target.value)}
                className="w-full px-3 py-2 border rounded text-sm"
              >
                <option value="">— sem loja —</option>
                {stores.map((s) => (
                  <option key={s.id} value={s.code}>
                    {s.code} {s.name}
                  </option>
                ))}
              </select>
            </Field>
            <p className="text-xs text-slate-400 mt-1">
              Ela entra sozinha na escolha de vendedora no PDV desta loja.
            </p>
          </div>

          <Grid>
            <Field label="Função (título)">
              <Input value={cargoFuncao} onChange={setCargoFuncao} placeholder="Ex: Vendedora Sênior" />
            </Field>
            <Field label="Tipo de contrato">
              <select
                value={contratoTipo}
                onChange={(e) => setContratoTipo(e.target.value)}
                className="w-full px-3 py-2 border rounded text-sm"
              >
                {CONTRATO_TIPOS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Data de admissão">
              <Input type="date" value={dataAdmissao} onChange={setDataAdmissao} />
            </Field>
            <Field label="Salário base (R$)">
              <Input
                type="number"
                step="0.01"
                value={salarioBase}
                onChange={setSalarioBase}
                placeholder="0.00"
              />
            </Field>
          </Grid>
        </Section>

        {/* HORÁRIO DE TRABALHO */}
        <Section icon={<Clock />} title="Horário de trabalho (com almoço)">
          <HorarioGrid value={horarioTrabalho} onChange={setHorarioTrabalho} />
        </Section>

        {/* FÉRIAS */}
        <Section icon={<Plane />} title="Férias (opcional)">
          <Grid>
            <Field label="Início das férias">
              <Input type="date" value={dataInicioFerias} onChange={setDataInicioFerias} />
            </Field>
            <Field label="Fim das férias">
              <Input type="date" value={dataFimFerias} onChange={setDataFimFerias} />
            </Field>
          </Grid>
          <p className="text-xs text-slate-500 mt-2">
            Pode deixar em branco. Próximo vencimento é calculado automaticamente após admissão.
          </p>
        </Section>

        {/* OBSERVAÇÕES */}
        <Section icon={<FileText />} title="Observações">
          <textarea
            value={observacoes}
            onChange={(e) => setObservacoes(e.target.value)}
            rows={3}
            placeholder="Notas livres (contatos emergência, restrições, etc)"
            className="w-full px-3 py-2 border rounded text-sm"
          />
        </Section>

        {/* SAVE */}
        <div className="sticky bottom-4 bg-white border-2 border-emerald-500 rounded-xl p-3 shadow-lg flex items-center justify-between gap-3">
          <div className="text-xs text-slate-500">
            Documentos (RG, contrato, atestados) → abre o prontuário após salvar.
          </div>
          <button
            onClick={salvar}
            disabled={saving}
            className="bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-bold px-6 py-2.5 rounded-lg flex items-center gap-2"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            Cadastrar funcionária
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
  required,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
  required?: boolean;
}) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4">
      <div className="flex items-center gap-2 mb-3 pb-2 border-b border-slate-100">
        <div className="w-7 h-7 rounded-lg bg-emerald-100 text-emerald-700 flex items-center justify-center">
          {icon}
        </div>
        <h2 className="font-bold text-slate-800">{title}</h2>
        {required && (
          <span className="text-[10px] font-bold bg-red-100 text-red-700 px-1.5 py-0.5 rounded">
            OBRIGATÓRIO
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 md:grid-cols-2 gap-3">{children}</div>;
}

function Field({
  label,
  children,
  required,
}: {
  label: string;
  children: React.ReactNode;
  required?: boolean;
}) {
  return (
    <div>
      <label
        className={`block text-xs font-bold uppercase mb-1 ${
          required ? 'text-red-700' : 'text-slate-500'
        }`}
      >
        {label}
      </label>
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
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  step?: string;
  autoFocus?: boolean;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      step={step}
      autoFocus={autoFocus}
      className="w-full px-3 py-2 border rounded text-sm"
    />
  );
}
