'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, ShieldCheck, Loader2, AlertCircle, CheckCircle2, Eye, EyeOff } from 'lucide-react';
import { api } from '@/lib/api';

export default function ResetarSenhaPage() {
  return (
    <Suspense fallback={
      <div className="min-h-dvh flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-gold" />
      </div>
    }>
      <ResetContent />
    </Suspense>
  );
}

function ResetContent() {
  const router = useRouter();
  const params = useSearchParams();
  const cpf = params.get('cpf') || '';

  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (code.length !== 6) {
      setErr('Código de 6 dígitos.');
      return;
    }
    if (password.length < 6) {
      setErr('Senha precisa ter pelo menos 6 caracteres.');
      return;
    }
    setLoading(true);
    try {
      await api('/customers/app/reset-password', {
        method: 'POST',
        body: JSON.stringify({ cpf, code, password }),
      });
      setSuccess(true);
      setTimeout(() => router.push('/login'), 1800);
    } catch (e: any) {
      setErr(e?.message || 'Erro');
    } finally {
      setLoading(false);
    }
  };

  if (success) {
    return (
      <div className="min-h-dvh flex flex-col items-center justify-center px-6 text-center">
        <CheckCircle2 className="w-16 h-16 text-emerald-400" />
        <h1 className="font-serif text-2xl font-bold mt-4">Senha alterada!</h1>
        <p className="text-sm text-cream/70 mt-2">Redirecionando pro login…</p>
        <Loader2 className="w-5 h-5 animate-spin text-gold mt-3" />
      </div>
    );
  }

  return (
    <div className="min-h-dvh flex flex-col px-6 pt-6 pb-8">
      <header className="flex items-center gap-3 mb-6">
        <Link href="/esqueci-senha" className="p-2 rounded-full bg-ink-800 hover:bg-ink-700 transition">
          <ArrowLeft className="w-5 h-5 text-gold" />
        </Link>
      </header>
      <div className="text-center mb-8">
        <ShieldCheck className="w-12 h-12 mx-auto text-gold" />
        <h1 className="font-serif text-2xl font-bold mt-3">Nova senha</h1>
        <p className="text-sm text-cream/70 mt-2">
          Digite o código que enviamos no WhatsApp + sua nova senha.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="text-xs font-bold uppercase tracking-wider text-cream/60 mb-1.5 block">
            Código (6 dígitos) *
          </label>
          <input
            type="tel"
            inputMode="numeric"
            placeholder="000000"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            className="input-dark text-center text-2xl tracking-[0.6em] font-mono"
            maxLength={6}
            required
            autoFocus
          />
        </div>

        <div>
          <label className="text-xs font-bold uppercase tracking-wider text-cream/60 mb-1.5 block">
            Nova senha *
          </label>
          <div className="relative">
            <input
              type={showPwd ? 'text' : 'password'}
              placeholder="Mínimo 6 caracteres"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="input-dark pr-12"
              minLength={6}
              required
            />
            <button
              type="button"
              onClick={() => setShowPwd(!showPwd)}
              className="absolute right-3 top-1/2 -translate-y-1/2 p-2 text-cream/50 hover:text-gold"
            >
              {showPwd ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
            </button>
          </div>
        </div>

        {err && (
          <div className="flex items-start gap-2 p-3 bg-red-900/30 border border-red-700/50 rounded-xl text-sm text-red-200">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{err}</span>
          </div>
        )}

        <button type="submit" disabled={loading} className="btn-gold-lg w-full">
          {loading ? (
            <>
              <Loader2 className="w-5 h-5 animate-spin" />
              Validando...
            </>
          ) : (
            'Alterar senha'
          )}
        </button>

        <Link href="/esqueci-senha" className="btn-ghost w-full text-center">
          Reenviar código
        </Link>
      </form>
    </div>
  );
}
