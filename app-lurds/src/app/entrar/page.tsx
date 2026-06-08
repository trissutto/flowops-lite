'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import Image from 'next/image';
import {
  Loader2, AlertCircle, ChevronRight, ChevronLeft, Sparkles,
  Eye, EyeOff, Gift, CheckCircle2, Lock,
} from 'lucide-react';
import { maskCpf, isValidCpf, cpfDigits } from '@/lib/cpf';
import {
  lookupCpf, loginCustomer, registerCustomer, setToken,
  captureInviteFromUrl, getStoredInvite, clearStoredInvite,
  type CpfLookup,
} from '@/lib/api';

/**
 * /entrar — Onboarding obrigatório (cadastro/login em fluxo único).
 *
 * Filosofia: a cliente NÃO consegue ver o app sem se identificar.
 * Custo dela: baixo (CPF + senha 4 dígitos). Recompensa: R$20 caindo na hora.
 *
 * Fluxo:
 *   Etapa 1 — CPF (única coisa obrigatória sempre)
 *     → lookup no CRM:
 *         a) tem CustomerAccount → Etapa 2A (LOGIN: pede senha)
 *         b) tem Customer mas não Account → Etapa 2B (CADASTRO: nome pré-preenchido)
 *         c) totalmente novo → Etapa 2C (CADASTRO: pede nome)
 *   Etapa 3 — Bem-vinda + R$20 caindo (animação)
 *
 * Sem chrome, sem navegação. Foco total na ação.
 */
export default function EntrarPage() {
  return (
    <Suspense fallback={<div className="min-h-dvh flex items-center justify-center"><Loader2 className="w-8 h-8 animate-spin text-gold" /></div>}>
      <EntrarFlow />
    </Suspense>
  );
}

type Step = 'cpf' | 'login' | 'cadastro' | 'success';

function EntrarFlow() {
  const router = useRouter();
  const search = useSearchParams();
  const nextUrl = search.get('next') || '/';

  const [step, setStep] = useState<Step>('cpf');
  const [cpf, setCpf] = useState('');
  const [lookup, setLookup] = useState<CpfLookup | null>(null);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [pwd, setPwd] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Captura invite token de QR PDV
  useEffect(() => {
    captureInviteFromUrl();
  }, []);

  /* ─────── Etapa 1: CPF ─────── */
  const handleCpfNext = async () => {
    setError(null);
    const digits = cpfDigits(cpf);
    if (!isValidCpf(cpf)) {
      setError('CPF inválido. Confere os números.');
      return;
    }
    setLoading(true);
    try {
      const r = await lookupCpf(digits);
      setLookup(r);
      // Pré-preenche nome/telefone se vier do CRM
      if (r.nameSuggested) setName(r.nameSuggested);
      if (r.phoneSuggested) setPhone(r.phoneSuggested);
      else if (r.phone) setPhone(r.phone);
      setStep(r.hasAppAccount ? 'login' : 'cadastro');
    } catch (e: any) {
      setError(e?.message || 'Erro ao consultar CPF');
    } finally {
      setLoading(false);
    }
  };

  /* ─────── Etapa 2A: LOGIN (CPF tem conta) ─────── */
  const handleLogin = async () => {
    setError(null);
    if (pwd.length < 4) {
      setError('Digite sua senha.');
      return;
    }
    setLoading(true);
    try {
      const r = await loginCustomer(cpfDigits(cpf), pwd);
      setToken(r.token);
      router.push(nextUrl);
    } catch (e: any) {
      setError(e?.message || 'Senha incorreta. Tenta de novo.');
    } finally {
      setLoading(false);
    }
  };

  /* ─────── Etapa 2B/C: CADASTRO ─────── */
  const handleRegister = async () => {
    setError(null);
    if (name.trim().length < 3) {
      setError('Nome completo, por favor.');
      return;
    }
    if (phone.replace(/\D/g, '').length < 10) {
      setError('Telefone com DDD, por favor.');
      return;
    }
    if (pwd.length < 4) {
      setError('Senha tem que ter pelo menos 4 dígitos.');
      return;
    }
    setLoading(true);
    try {
      const r = await registerCustomer({
        cpf: cpfDigits(cpf),
        name: name.trim(),
        phone: phone.replace(/\D/g, ''),
        password: pwd,
        invite: getStoredInvite() || undefined,
      });
      setToken(r.token);
      if (r.invite?.redeemed) clearStoredInvite();
      setStep('success');
      // Auto-redireciona após animação de 3.5s
      setTimeout(() => router.push(nextUrl + (nextUrl.includes('?') ? '&' : '?') + 'welcome=1'), 3500);
    } catch (e: any) {
      setError(e?.message || 'Erro no cadastro. Tenta de novo.');
    } finally {
      setLoading(false);
    }
  };

  /* ────────────────── UI ────────────────── */
  return (
    <div className="min-h-dvh flex flex-col" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
      {/* Logo no topo */}
      <div className="flex items-center justify-center pt-8 pb-4">
        <Image
          src="/images/logo-branco.png"
          alt="Lurd's Plus Size"
          width={140} height={77}
          priority
          className="h-14 w-auto"
        />
      </div>

      <div className="flex-1 px-6 pb-8 flex flex-col">
        {step === 'cpf' && (
          <StepCpf
            cpf={cpf} setCpf={setCpf}
            loading={loading} error={error}
            onNext={handleCpfNext}
          />
        )}
        {step === 'login' && (
          <StepLogin
            cpf={cpf}
            lookup={lookup}
            pwd={pwd} setPwd={setPwd}
            showPwd={showPwd} setShowPwd={setShowPwd}
            loading={loading} error={error}
            onSubmit={handleLogin}
            onBack={() => { setStep('cpf'); setError(null); setPwd(''); }}
          />
        )}
        {step === 'cadastro' && (
          <StepCadastro
            cpf={cpf}
            lookup={lookup}
            name={name} setName={setName}
            phone={phone} setPhone={setPhone}
            pwd={pwd} setPwd={setPwd}
            showPwd={showPwd} setShowPwd={setShowPwd}
            loading={loading} error={error}
            onSubmit={handleRegister}
            onBack={() => { setStep('cpf'); setError(null); }}
          />
        )}
        {step === 'success' && (
          <StepSuccess firstName={name.split(' ')[0] || 'amiga'} />
        )}
      </div>
    </div>
  );
}

/* ═══════════════════ ETAPA 1: CPF ═══════════════════ */
function StepCpf({ cpf, setCpf, loading, error, onNext }: any) {
  return (
    <>
      <div className="text-center mb-6">
        <h1 className="font-serif text-3xl font-black text-white">Bem-vinda 💛</h1>
        <p className="text-base text-cream/70 mt-2">
          Pra começar, digite seu CPF
        </p>
      </div>

      <div className="bg-gold/5 border border-gold/30 rounded-2xl p-4 mb-5 flex items-center gap-3">
        <Gift className="w-8 h-8 text-gold shrink-0" />
        <div className="text-xs leading-relaxed">
          <strong className="text-gold">R$ 20,00</strong> de cashback caem na sua conta assim que você terminar 🎁
        </div>
      </div>

      <div>
        <label className="block text-xs uppercase tracking-wider text-cream/50 mb-2 font-bold">
          Seu CPF
        </label>
        <input
          type="tel"
          inputMode="numeric"
          autoComplete="off"
          value={maskCpf(cpf)}
          onChange={(e) => setCpf(cpfDigits(e.target.value))}
          maxLength={14}
          placeholder="000.000.000-00"
          className="input-dark w-full text-xl tracking-wider tabular-nums text-center"
          autoFocus
        />
      </div>

      {error && (
        <div className="mt-3 text-sm text-rose-200 bg-rose-900/30 border border-rose-700/50 rounded-lg p-3 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {error}
        </div>
      )}

      <div className="flex-1" />

      <button
        onClick={onNext}
        disabled={loading || cpf.length < 11}
        className="btn-gold-lg w-full"
        style={{ marginBottom: 'env(safe-area-inset-bottom)' }}
      >
        {loading ? (
          <><Loader2 className="w-5 h-5 animate-spin" /> Verificando...</>
        ) : (
          <>Continuar <ChevronRight className="w-5 h-5" /></>
        )}
      </button>

      <p className="text-[10px] text-cream/40 text-center mt-3">
        Ao continuar você aceita os <a href="/termos" className="underline">Termos</a> e a <a href="/privacidade" className="underline">Política de Privacidade</a>
      </p>
    </>
  );
}

/* ═══════════════════ ETAPA 2A: LOGIN ═══════════════════ */
function StepLogin({ cpf, lookup, pwd, setPwd, showPwd, setShowPwd, loading, error, onSubmit, onBack }: any) {
  const firstName = lookup?.name?.split(' ')[0] || lookup?.nameSuggested?.split(' ')[0];
  return (
    <>
      <button
        onClick={onBack}
        className="self-start text-xs text-cream/60 mb-3 flex items-center gap-1"
      >
        <ChevronLeft className="w-4 h-4" /> Voltar
      </button>

      <div className="text-center mb-6">
        <div className="text-5xl mb-2">👋</div>
        <h1 className="font-serif text-2xl font-black text-white">
          Oi de novo{firstName ? `, ${firstName}` : ''}!
        </h1>
        <p className="text-sm text-cream/70 mt-2">
          Esse CPF já tem conta na Lurd's. Digite sua senha.
        </p>
      </div>

      <div>
        <label className="block text-xs uppercase tracking-wider text-cream/50 mb-2 font-bold">
          Sua senha
        </label>
        <div className="relative">
          <input
            type={showPwd ? 'text' : 'password'}
            value={pwd}
            onChange={(e) => setPwd(e.target.value)}
            placeholder="Mínimo 4 dígitos"
            className="input-dark w-full pr-12"
            autoFocus
          />
          <button
            type="button"
            onClick={() => setShowPwd(!showPwd)}
            className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-cream/50"
            aria-label="Mostrar senha"
          >
            {showPwd ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
          </button>
        </div>
        <a href="/esqueci-senha" className="text-xs text-gold/80 underline mt-2 inline-block">
          Esqueci minha senha
        </a>
      </div>

      {error && (
        <div className="mt-3 text-sm text-rose-200 bg-rose-900/30 border border-rose-700/50 rounded-lg p-3 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {error}
        </div>
      )}

      <div className="flex-1" />

      <button
        onClick={onSubmit}
        disabled={loading || pwd.length < 4}
        className="btn-gold-lg w-full"
        style={{ marginBottom: 'env(safe-area-inset-bottom)' }}
      >
        {loading ? (
          <><Loader2 className="w-5 h-5 animate-spin" /> Entrando...</>
        ) : (
          <>Entrar <ChevronRight className="w-5 h-5" /></>
        )}
      </button>
    </>
  );
}

/* ═══════════════════ ETAPA 2B/C: CADASTRO ═══════════════════ */
function StepCadastro({
  cpf, lookup, name, setName, phone, setPhone, pwd, setPwd,
  showPwd, setShowPwd, loading, error, onSubmit, onBack,
}: any) {
  const isReturning = lookup?.exists && !lookup?.hasAppAccount;
  return (
    <>
      <button
        onClick={onBack}
        className="self-start text-xs text-cream/60 mb-3 flex items-center gap-1"
      >
        <ChevronLeft className="w-4 h-4" /> Voltar
      </button>

      <div className="text-center mb-5">
        {isReturning ? (
          <>
            <div className="text-4xl mb-2">✨</div>
            <h1 className="font-serif text-2xl font-black text-white">
              Reconheci você!
            </h1>
            <p className="text-sm text-cream/70 mt-2">
              Já comprou {lookup.stats?.linkedStoresCount ? `em ${lookup.stats.linkedStoresCount} loja${lookup.stats.linkedStoresCount > 1 ? 's' : ''}` : 'na Lurd\'s'}.
              Confirma seus dados e cria uma senha 💛
            </p>
          </>
        ) : (
          <>
            <div className="text-4xl mb-2">💛</div>
            <h1 className="font-serif text-2xl font-black text-white">
              Falta só isso
            </h1>
            <p className="text-sm text-cream/70 mt-2">
              Vamos te conhecer rapidinho. R$ 20 caem assim que terminar.
            </p>
          </>
        )}
      </div>

      <div className="space-y-3">
        <div>
          <label className="block text-xs uppercase tracking-wider text-cream/50 mb-1.5 font-bold">
            Nome completo
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Como te chamamos?"
            className="input-dark w-full"
            autoFocus={!name}
            autoComplete="name"
          />
        </div>

        <div>
          <label className="block text-xs uppercase tracking-wider text-cream/50 mb-1.5 font-bold">
            WhatsApp <span className="text-cream/40 normal-case">(com DDD)</span>
          </label>
          <input
            type="tel"
            inputMode="numeric"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="(11) 99999-9999"
            className="input-dark w-full"
            autoComplete="tel"
          />
        </div>

        <div>
          <label className="block text-xs uppercase tracking-wider text-cream/50 mb-1.5 font-bold flex items-center gap-1">
            <Lock className="w-3 h-3" /> Crie uma senha
          </label>
          <div className="relative">
            <input
              type={showPwd ? 'text' : 'password'}
              value={pwd}
              onChange={(e) => setPwd(e.target.value)}
              placeholder="Mínimo 4 dígitos"
              className="input-dark w-full pr-12"
              autoComplete="new-password"
            />
            <button
              type="button"
              onClick={() => setShowPwd(!showPwd)}
              className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-cream/50"
              aria-label="Mostrar senha"
            >
              {showPwd ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
            </button>
          </div>
          <p className="text-[10px] text-cream/40 mt-1">
            Sugestão: 4 dígitos numéricos, fácil de lembrar (aniversário, etc)
          </p>
        </div>
      </div>

      {error && (
        <div className="mt-3 text-sm text-rose-200 bg-rose-900/30 border border-rose-700/50 rounded-lg p-3 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {error}
        </div>
      )}

      <div className="flex-1" />

      <button
        onClick={onSubmit}
        disabled={loading || name.length < 3 || phone.replace(/\D/g, '').length < 10 || pwd.length < 4}
        className="btn-gold-lg w-full"
        style={{ marginBottom: 'env(safe-area-inset-bottom)' }}
      >
        {loading ? (
          <><Loader2 className="w-5 h-5 animate-spin" /> Criando sua conta...</>
        ) : (
          <>Ativar meus R$ 20 <Sparkles className="w-5 h-5" /></>
        )}
      </button>
    </>
  );
}

/* ═══════════════════ ETAPA 3: SUCESSO ═══════════════════ */
function StepSuccess({ firstName }: { firstName: string }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShown(true), 300);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center">
      <div className={`transition-all duration-700 ${shown ? 'scale-100 opacity-100' : 'scale-0 opacity-0'}`}>
        <div className="text-7xl mb-4">🎉</div>
      </div>
      <h1 className="font-serif text-3xl font-black text-white mb-2">
        Bem-vinda, {firstName}!
      </h1>
      <p className="text-base text-cream/80 mb-8">
        Sua conta tá pronta. Olha o que caiu na sua carteira:
      </p>

      <div className={`w-full max-w-sm transition-all duration-1000 ${shown ? 'translate-y-0 opacity-100' : 'translate-y-8 opacity-0'}`}>
        <div className="bg-gradient-to-br from-gold via-gold-light to-gold rounded-3xl p-6 text-ink shadow-2xl">
          <div className="text-[10px] font-bold uppercase tracking-widest opacity-70">
            Saldo de cashback
          </div>
          <div className="font-serif text-5xl font-black mt-2 flex items-baseline justify-center gap-1">
            R$ <span>20</span><span className="text-3xl">,00</span>
          </div>
          <div className="text-xs mt-2 opacity-80">
            Use na sua próxima compra · válido 30 dias
          </div>
        </div>
      </div>

      <div className="mt-8 flex items-center gap-2 text-sm text-cream/70">
        <Loader2 className="w-4 h-4 animate-spin text-gold" />
        Levando você pras promoções...
      </div>
    </div>
  );
}
