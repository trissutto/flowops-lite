'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import {
  ArrowLeft, Loader2, AlertCircle, Eye, EyeOff, Gift,
  Sparkles, Store as StoreIcon, ShoppingBag, CheckCircle2,
} from 'lucide-react';
import { maskCpf, isValidCpf, cpfDigits } from '@/lib/cpf';
import { registerCustomer, setToken, lookupCpf, type CpfLookup } from '@/lib/api';

/**
 * /cadastro — fluxo INTELIGENTE:
 *   1) Cliente digita CPF.
 *   2) Quando CPF fica válido (11 dígitos), faz lookup no backend.
 *   3) Se já existe CONTA do app: redireciona pra /login com mensagem.
 *   4) Se existe no CRM (Giga): pré-preenche nome+telefone + mostra
 *      "✨ Reconhecemos você! Já comprou em N lojas" + total gasto.
 *   5) Se não existe: cliente preenche tudo do zero.
 */
export default function CadastroPage() {
  const router = useRouter();
  const [form, setForm] = useState({
    cpf: '',
    name: '',
    phone: '',
    email: '',
    password: '',
  });
  const [lookup, setLookup] = useState<CpfLookup | null>(null);
  const [lookingUp, setLookingUp] = useState(false);
  const [showPwd, setShowPwd] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof typeof form>(key: K, value: string) =>
    setForm((f) => ({ ...f, [key]: value }));

  // Debounce do lookup quando CPF fica válido
  useEffect(() => {
    if (!isValidCpf(form.cpf)) {
      setLookup(null);
      return;
    }
    setLookingUp(true);
    const handler = setTimeout(() => {
      lookupCpf(cpfDigits(form.cpf))
        .then((r) => {
          setLookup(r);
          // Auto-preenche se temos dados sugeridos
          if (r.exists && !r.hasAppAccount) {
            setForm((f) => ({
              ...f,
              name: f.name || r.nameSuggested || '',
              phone: f.phone || r.phoneSuggested || '',
            }));
          }
        })
        .catch(() => setLookup(null))
        .finally(() => setLookingUp(false));
    }, 350);
    return () => clearTimeout(handler);
  }, [form.cpf]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!isValidCpf(form.cpf)) {
      setError('CPF inválido. Confere os números.');
      return;
    }
    if (form.name.trim().length < 3) {
      setError('Nome completo, por favor.');
      return;
    }
    if (form.phone.replace(/\D/g, '').length < 10) {
      setError('Telefone com DDD, por favor.');
      return;
    }
    if (form.password.length < 6) {
      setError('Senha precisa ter pelo menos 6 caracteres.');
      return;
    }

    setLoading(true);
    try {
      const r = await registerCustomer({
        ...form,
        cpf: cpfDigits(form.cpf),
        phone: form.phone.replace(/\D/g, ''),
      });
      setToken(r.token);
      router.push('/?welcome=1');
    } catch (err: any) {
      setError(err?.message || 'Erro no cadastro. Tenta de novo.');
    } finally {
      setLoading(false);
    }
  };

  const alreadyRegistered = lookup?.hasAppAccount;

  return (
    <div className="min-h-dvh flex flex-col px-6 pt-6 pb-8">
      <header className="flex items-center gap-3 mb-6">
        <Link href="/login" className="p-2 rounded-full bg-ink-800 hover:bg-ink-700 transition">
          <ArrowLeft className="w-5 h-5 text-gold" />
        </Link>
        <Image src="/images/logo-branco.png" alt="Lurd's"
               width={80} height={43} className="h-9 w-auto ml-auto" />
      </header>

      {/* Banner do bônus */}
      <div className="rounded-3xl bg-gradient-to-br from-gold via-gold-light to-gold p-5 text-ink mb-6">
        <div className="flex items-center gap-3">
          <Gift className="w-8 h-8" />
          <div>
            <div className="font-serif text-xl font-black">R$ 20 grátis</div>
            <div className="text-xs opacity-80">cai no seu cashback após a 1ª compra</div>
          </div>
        </div>
      </div>

      <h1 className="font-serif text-2xl font-bold mb-1">Criar conta</h1>
      <p className="text-sm text-cream/70 mb-6">
        Rápido — você usa pra acessar promoções e cashback.
      </p>

      {/* Form */}
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        {/* CPF */}
        <Field label="CPF" required>
          <div className="relative">
            <input
              type="tel"
              inputMode="numeric"
              placeholder="000.000.000-00"
              value={form.cpf}
              onChange={(e) => set('cpf', maskCpf(e.target.value))}
              className="input-dark text-lg tracking-wider pr-10"
              maxLength={14}
              required
            />
            {lookingUp && (
              <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gold animate-spin" />
            )}
            {!lookingUp && lookup?.exists && (
              <CheckCircle2 className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 text-emerald-400" />
            )}
          </div>
        </Field>

        {/* Já existe APP account → redireciona pra login */}
        {alreadyRegistered && (
          <div className="card-gold-border bg-gold/10 flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-gold shrink-0 mt-0.5" />
            <div className="text-sm">
              <strong className="text-gold">Já tem conta!</strong>
              <p className="text-cream/70 mt-1">
                CPF {form.cpf} já está cadastrado no app
                {lookup?.name && ` como ${lookup.name}`}.
              </p>
              <Link href="/login" className="btn-gold mt-3 text-xs">
                Fazer login
              </Link>
            </div>
          </div>
        )}

        {/* Reconheceu no CRM → mostra histórico */}
        {lookup?.exists && !lookup.hasAppAccount && lookup.stats && (
          <div className="card-gold-border bg-gradient-to-br from-gold/10 to-transparent">
            <div className="flex items-center gap-2 text-gold mb-2">
              <Sparkles className="w-4 h-4" />
              <span className="text-xs font-bold uppercase tracking-wider">
                Você é cliente Lurd's!
              </span>
            </div>
            <p className="text-sm text-cream/90">
              Reconhecemos seu CPF{lookup.name && (<>, <strong>{lookup.name}</strong></>)}.
              Vc já comprou conosco em{' '}
              <strong className="text-gold">{lookup.stats.linkedStoresCount}</strong>{' '}
              {lookup.stats.linkedStoresCount === 1 ? 'loja' : 'lojas'}.
            </p>
            <div className="grid grid-cols-2 gap-2 mt-3">
              <MiniStat
                icon={<ShoppingBag className="w-4 h-4" />}
                value={lookup.stats.orderCount}
                label={lookup.stats.orderCount === 1 ? 'compra' : 'compras'}
              />
              <MiniStat
                icon={<StoreIcon className="w-4 h-4" />}
                value={`R$ ${lookup.stats.ltvBrl.toLocaleString('pt-BR', {minimumFractionDigits: 0, maximumFractionDigits: 0})}`}
                label="total comprado"
              />
            </div>
            <p className="text-[11px] text-gold/80 mt-2 italic">
              ✨ Seu cashback + histórico ficam disponíveis ao terminar o cadastro.
            </p>
          </div>
        )}

        {/* Nome (pré-preenchido se vier do lookup) */}
        {!alreadyRegistered && (
          <>
            <Field label="Nome completo" required>
              <input
                type="text"
                autoComplete="name"
                placeholder="Seu nome"
                value={form.name}
                onChange={(e) => set('name', e.target.value)}
                className="input-dark"
                required
              />
            </Field>

            <Field label="WhatsApp" required>
              <input
                type="tel"
                inputMode="numeric"
                autoComplete="tel"
                placeholder="(11) 99999-9999"
                value={form.phone}
                onChange={(e) => set('phone', e.target.value)}
                className="input-dark"
                required
              />
            </Field>

            <Field label="E-mail (opcional)">
              <input
                type="email"
                autoComplete="email"
                placeholder="voce@exemplo.com"
                value={form.email}
                onChange={(e) => set('email', e.target.value)}
                className="input-dark"
              />
            </Field>

            <Field label="Senha" required>
              <div className="relative">
                <input
                  type={showPwd ? 'text' : 'password'}
                  autoComplete="new-password"
                  placeholder="Mínimo 6 caracteres"
                  value={form.password}
                  onChange={(e) => set('password', e.target.value)}
                  className="input-dark pr-12"
                  required
                  minLength={6}
                />
                <button
                  type="button"
                  onClick={() => setShowPwd(!showPwd)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 p-2 text-cream/50 hover:text-gold"
                  aria-label="Mostrar/ocultar senha"
                >
                  {showPwd ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                </button>
              </div>
            </Field>

            {error && (
              <div className="flex items-start gap-2 p-3 bg-red-900/30 border border-red-700/50 rounded-xl text-sm text-red-200">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            <button type="submit" disabled={loading} className="btn-gold-lg w-full mt-2">
              {loading ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  Criando conta...
                </>
              ) : (
                'Criar conta e ganhar R$ 20'
              )}
            </button>

            <p className="text-[11px] text-center text-cream/40 mt-2">
              Ao criar conta você concorda com nossos{' '}
              <Link href="/termos" className="text-gold/80 underline">Termos</Link> e{' '}
              <Link href="/privacidade" className="text-gold/80 underline">Privacidade</Link>.
            </p>
          </>
        )}
      </form>
    </div>
  );
}

function Field({ label, required, children }: {
  label: string; required?: boolean; children: React.ReactNode;
}) {
  return (
    <div>
      <label className="text-xs font-bold uppercase tracking-wider text-cream/60 mb-1.5 block">
        {label} {required && <span className="text-gold">*</span>}
      </label>
      {children}
    </div>
  );
}

function MiniStat({ icon, value, label }: {
  icon: React.ReactNode; value: string | number; label: string;
}) {
  return (
    <div className="bg-ink-800 rounded-xl p-2 text-center">
      <div className="text-gold flex justify-center mb-0.5">{icon}</div>
      <div className="text-base font-black">{value}</div>
      <div className="text-[9px] uppercase tracking-wider text-cream/50 font-bold">
        {label}
      </div>
    </div>
  );
}
