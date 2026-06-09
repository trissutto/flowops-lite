'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft, User, Phone, Mail, Hash, Store as StoreIcon,
  TrendingUp, ShoppingBag, Calendar, Loader2, AlertCircle,
  Pencil, X, CheckCircle2, Cake,
} from 'lucide-react';
import { getMe, updateMe, isLoggedIn, type CustomerMe } from '@/lib/api';

/**
 * /conta/dados — perfil consolidado do CustomerAccount.
 * Cliente pode editar nome, whatsapp, email, data nascimento (CPF não).
 */

type EditField = 'name' | 'phone' | 'email' | 'birthDate' | null;

export default function DadosPessoaisPage() {
  const router = useRouter();
  const [data, setData] = useState<CustomerMe | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditField>(null);
  const [savedFlash, setSavedFlash] = useState<EditField>(null);

  useEffect(() => {
    if (!isLoggedIn()) {
      router.push('/entrar?next=/conta/dados');
      return;
    }
    getMe()
      .then(setData)
      .catch((e) => setError(e?.message || 'Erro ao carregar perfil'))
      .finally(() => setLoading(false));
  }, [router]);

  const fmtBrl = (v: number) =>
    v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

  const fmtDate = (iso: string | null) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString('pt-BR');
  };

  const fmtPhone = (raw: string | null) => {
    if (!raw) return '—';
    const d = raw.replace(/\D/g, '');
    if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
    if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
    return raw;
  };

  const handleSave = async (field: EditField, value: string) => {
    if (!field) return;
    setError(null);
    try {
      const updated = await updateMe({ [field]: value });
      setData(updated);
      setEditing(null);
      setSavedFlash(field);
      setTimeout(() => setSavedFlash(null), 2000);
    } catch (e: any) {
      setError(e?.message || 'Erro ao salvar');
    }
  };

  return (
    <div className="min-h-dvh pb-24">
      <header className="flex items-center gap-3 px-5 pt-5">
        <Link href="/conta" className="p-2 rounded-full bg-ink-800 hover:bg-ink-700 transition">
          <ArrowLeft className="w-5 h-5 text-gold" />
        </Link>
        <h1 className="font-serif text-xl font-bold">Dados pessoais</h1>
      </header>

      {loading && (
        <div className="text-center py-16 text-cream/60">
          <Loader2 className="w-8 h-8 animate-spin mx-auto" />
          <div className="text-sm mt-2">Carregando...</div>
        </div>
      )}

      {error && (
        <div className="mx-5 mt-3 flex items-start gap-2 p-3 bg-red-900/30 border border-red-700/50 rounded-xl text-sm text-red-200">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)}>
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {data && (
        <>
          {/* Avatar + nome (clicável pra editar) */}
          <section className="mt-6 px-5 text-center">
            <div className="mx-auto w-20 h-20 rounded-full bg-gradient-to-br from-gold to-gold-dark flex items-center justify-center font-serif text-3xl font-bold text-ink">
              {(data.name || 'C').charAt(0).toUpperCase()}
            </div>
            <button
              onClick={() => setEditing('name')}
              className="mt-3 inline-flex items-center gap-2 font-serif text-xl font-bold hover:text-gold transition"
            >
              {data.name || 'Adicionar nome'}
              <Pencil className="w-3.5 h-3.5 text-cream/40" />
            </button>
            <p className="text-xs text-cream/60 font-mono mt-1">{data.cpf}</p>
          </section>

          {/* Dados de contato */}
          <section className="mt-7 px-5">
            <h3 className="text-[11px] font-bold uppercase tracking-widest text-cream/40 mb-2 px-1">
              Contato
            </h3>
            <div className="card-dark divide-y divide-ink-600 !p-0 overflow-hidden">
              {/* CPF (não editável) */}
              <div className="flex items-center gap-3 px-4 py-3.5">
                <Hash className="w-4 h-4 text-gold/70" />
                <div className="flex-1">
                  <div className="text-[10px] uppercase tracking-wider text-cream/40 font-bold">
                    CPF
                  </div>
                  <div className="text-sm font-medium text-white">{data.cpf}</div>
                </div>
                <span className="text-[10px] text-cream/40 italic">Não editável</span>
              </div>

              {/* WhatsApp */}
              <EditableRow
                icon={<Phone className="w-4 h-4 text-gold/70" />}
                label="WhatsApp"
                value={fmtPhone(data.phone)}
                placeholder="(13) 99999-9999"
                isEmpty={!data.phone}
                emptyLabel="Adicionar WhatsApp"
                onEdit={() => setEditing('phone')}
                savedFlash={savedFlash === 'phone'}
              />

              {/* E-mail */}
              <EditableRow
                icon={<Mail className="w-4 h-4 text-gold/70" />}
                label="E-mail"
                value={data.email || ''}
                placeholder="seu@email.com"
                isEmpty={!data.email}
                emptyLabel="Adicionar e-mail"
                onEdit={() => setEditing('email')}
                savedFlash={savedFlash === 'email'}
              />

              {/* Data Nascimento (pra mimo aniversário) */}
              <EditableRow
                icon={<Cake className="w-4 h-4 text-gold/70" />}
                label="Aniversário"
                value={data.birthDate ? fmtDate(data.birthDate) : ''}
                placeholder="01/01/1990"
                isEmpty={!data.birthDate}
                emptyLabel="Adicionar pra ganhar mimo de aniversário"
                onEdit={() => setEditing('birthDate')}
                savedFlash={savedFlash === 'birthDate'}
              />
            </div>
          </section>

          {/* Stats agregados */}
          <section className="mt-7 px-5">
            <h3 className="text-[11px] font-bold uppercase tracking-widest text-cream/40 mb-2 px-1">
              Sua jornada na Lurd's
            </h3>
            <div className="card-gold-border bg-gold/5">
              <div className="grid grid-cols-2 gap-3">
                <StatCard
                  icon={<StoreIcon className="w-5 h-5" />}
                  value={data.stats.linkedStoresCount}
                  label={data.stats.linkedStoresCount === 1 ? 'Loja' : 'Lojas'}
                />
                <StatCard
                  icon={<ShoppingBag className="w-5 h-5" />}
                  value={data.stats.orderCount}
                  label={data.stats.orderCount === 1 ? 'Compra' : 'Compras'}
                />
                <StatCard
                  icon={<TrendingUp className="w-5 h-5" />}
                  value={fmtBrl(data.stats.ltvBrl)}
                  label="Total gasto"
                  small
                />
                <StatCard
                  icon={<Calendar className="w-5 h-5" />}
                  value={fmtDate(data.stats.lastOrderAt)}
                  label="Última compra"
                  small
                />
              </div>
              {data.stats.linkedStoresCount > 1 && (
                <p className="mt-3 text-[11px] text-gold/80 text-center italic">
                  ✨ Seu cadastro está unificado em {data.stats.linkedStoresCount} lojas
                </p>
              )}
            </div>
          </section>

          {/* Cashback resumo */}
          <section className="mt-7 px-5">
            <h3 className="text-[11px] font-bold uppercase tracking-widest text-cream/40 mb-2 px-1">
              Cashback
            </h3>
            <Link href="/cashback" className="card-dark block hover:border-gold/50 transition">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-xs text-cream/60">Saldo disponível</div>
                  <div className="font-serif text-2xl font-black text-gold mt-0.5">
                    {fmtBrl(data.cashback.balance)}
                  </div>
                </div>
                <div className="text-right text-[11px] text-cream/60">
                  <div>Acumulado: {fmtBrl(data.cashback.earned)}</div>
                  <div>Usado: {fmtBrl(data.cashback.spent)}</div>
                </div>
              </div>
            </Link>
          </section>
        </>
      )}

      {/* Modal de edição */}
      {editing && data && (
        <EditModal
          field={editing}
          currentValue={
            editing === 'name' ? (data.name || '')
            : editing === 'phone' ? (data.phone || '')
            : editing === 'email' ? (data.email || '')
            : editing === 'birthDate' ? (data.birthDate || '')
            : ''
          }
          onSave={(v) => handleSave(editing, v)}
          onCancel={() => setEditing(null)}
        />
      )}
    </div>
  );
}

/* ════════════ COMPONENTES ════════════ */

function EditableRow({
  icon, label, value, placeholder, isEmpty, emptyLabel, onEdit, savedFlash,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  placeholder: string;
  isEmpty: boolean;
  emptyLabel: string;
  onEdit: () => void;
  savedFlash?: boolean;
}) {
  return (
    <button
      onClick={onEdit}
      className="w-full flex items-center gap-3 px-4 py-3.5 text-left hover:bg-ink-700/30 transition"
    >
      {icon}
      <div className="flex-1 min-w-0">
        <div className="text-[10px] uppercase tracking-wider text-cream/40 font-bold flex items-center gap-1.5">
          {label}
          {savedFlash && (
            <span className="inline-flex items-center gap-1 text-emerald-400 normal-case tracking-normal">
              <CheckCircle2 className="w-3 h-3" /> salvo
            </span>
          )}
        </div>
        <div className={`text-sm truncate ${isEmpty ? 'text-cream/40 italic' : 'font-medium text-white'}`}>
          {isEmpty ? emptyLabel : value}
        </div>
      </div>
      <Pencil className="w-3.5 h-3.5 text-cream/40 shrink-0" />
    </button>
  );
}

function StatCard({ icon, value, label, small }: {
  icon: React.ReactNode; value: string | number; label: string; small?: boolean;
}) {
  return (
    <div className="bg-ink-800 rounded-xl p-3 text-center">
      <div className="text-gold flex justify-center mb-1">{icon}</div>
      <div className={small ? 'text-base font-bold' : 'text-2xl font-black'}>
        {value}
      </div>
      <div className="text-[10px] uppercase tracking-wider text-cream/50 font-bold mt-0.5">
        {label}
      </div>
    </div>
  );
}

function EditModal({
  field, currentValue, onSave, onCancel,
}: {
  field: 'name' | 'phone' | 'email' | 'birthDate';
  currentValue: string;
  onSave: (v: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(currentValue);
  const [saving, setSaving] = useState(false);

  const config = {
    name:      { title: 'Editar nome',       placeholder: 'Maria da Silva',     inputMode: 'text',     type: 'text' },
    phone:     { title: 'Editar WhatsApp',   placeholder: '(13) 99999-9999',    inputMode: 'tel',      type: 'tel' },
    email:     { title: 'Editar e-mail',     placeholder: 'maria@exemplo.com',  inputMode: 'email',    type: 'email' },
    birthDate: { title: 'Data de nascimento',placeholder: '01/01/1990',         inputMode: 'numeric',  type: 'date' },
  }[field];

  const formatPhoneInput = (v: string) => {
    const d = v.replace(/\D/g, '').slice(0, 11);
    if (d.length <= 2) return d.length ? `(${d}` : d;
    if (d.length <= 7) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
    return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  };

  const handleChange = (raw: string) => {
    if (field === 'phone') {
      setValue(formatPhoneInput(raw));
    } else {
      setValue(raw);
    }
  };

  const handleSubmit = async () => {
    setSaving(true);
    try {
      const toSend = field === 'phone' ? value.replace(/\D/g, '') : value;
      await onSave(toSend);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[300] bg-ink/90 backdrop-blur-sm flex items-end sm:items-center justify-center"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md mx-0 sm:mx-4 bg-ink-800 sm:border sm:border-gold/30 rounded-t-3xl sm:rounded-3xl p-6 animate-slide-up"
        onClick={(e) => e.stopPropagation()}
        style={{ paddingBottom: 'calc(1.5rem + env(safe-area-inset-bottom))' }}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-serif text-lg font-bold">{config.title}</h3>
          <button onClick={onCancel} className="p-2 rounded-full bg-ink-700">
            <X className="w-4 h-4" />
          </button>
        </div>

        <input
          type={config.type}
          inputMode={config.inputMode as any}
          value={value}
          onChange={(e) => handleChange(e.target.value)}
          placeholder={config.placeholder}
          autoFocus
          className="input-dark text-base"
        />

        {field === 'birthDate' && (
          <p className="mt-2 text-[11px] text-cream/60">
            🎂 Adicionando seu aniversário, você ganha um mimo todo ano.
          </p>
        )}

        <button
          onClick={handleSubmit}
          disabled={saving || !value.trim()}
          className="w-full mt-5 btn-gold-lg"
        >
          {saving ? (
            <Loader2 className="w-5 h-5 animate-spin" />
          ) : (
            <>
              <CheckCircle2 className="w-5 h-5" />
              Salvar
            </>
          )}
        </button>
      </div>
    </div>
  );
}
