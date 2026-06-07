'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, KeyRound, Loader2, MessageCircle, AlertCircle } from 'lucide-react';
import { maskCpf, isValidCpf, cpfDigits } from '@/lib/cpf';
import { api } from '@/lib/api';

export default function EsqueciSenhaPage() {
  const router = useRouter();
  const [cpf, setCpf] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (!isValidCpf(cpf)) {
      setErr('CPF inválido');
      return;
    }
    setLoading(true);
    try {
      const r = await api<{ sent: true; phoneMasked?: string }>(
        '/customers/app/forgot-password',
        { method: 'POST', body: JSON.stringify({ cpf: cpfDigits(cpf) }) },
      );
      setSentTo(r.phoneMasked || 'seu WhatsApp cadastrado');
      // Redireciona pra tela de inserir código depois de 2s
      setTimeout(() => {
        router.push(`/resetar-senha?cpf=${cpfDigits(cpf)}`);
      }, 1800);
    } catch (e: any) {
      setErr(e?.message || 'Falha ao enviar');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-dvh flex flex-col px-6 pt-6 pb-8">
      <header className="flex items-center gap-3 mb-6">
        <Link href="/login" className="p-2 rounded-full bg-ink-800 hover:bg-ink-700 transition">
          <ArrowLeft className="w-5 h-5 text-gold" />
        </Link>
      </header>
      <div className="text-center mb-8">
        <KeyRound className="w-12 h-12 mx-auto text-gold" />
        <h1 className="font-serif text-2xl font-bold mt-3">Esqueci minha senha</h1>
        <p className="text-sm text-cream/70 mt-2">
          Digita seu CPF que vamos enviar um código no seu WhatsApp.
        </p>
      </div>

      {sentTo ? (
        <div className="card-gold-border bg-gold/10 text-center">
          <MessageCircle className="w-10 h-10 text-gold mx-auto" />
          <h2 className="font-bold text-white mt-2">Código enviado!</h2>
          <p className="text-sm text-cream/80 mt-1">
            Pra {sentTo}. Vale por 15 minutos.
          </p>
          <Loader2 className="w-5 h-5 animate-spin text-gold mx-auto mt-3" />
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="text-xs font-bold uppercase tracking-wider text-cream/60 mb-1.5 block">
              CPF *
            </label>
            <input
              type="tel"
              inputMode="numeric"
              placeholder="000.000.000-00"
              value={cpf}
              onChange={(e) => setCpf(maskCpf(e.target.value))}
              className="input-dark text-lg tracking-wider"
              maxLength={14}
              required
            />
          </div>
          {err && (
            <div className="flex items-start gap-2 p-3 bg-red-900/30 border border-red-700/50 rounded-xl text-sm text-red-200">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{err}</span>
            </div>
          )}
          <button
            type="submit"
            disabled={loading || !cpf}
            className="btn-gold-lg w-full"
          >
            {loading ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin" />
                Enviando código...
              </>
            ) : (
              'Enviar código no WhatsApp'
            )}
          </button>
          <Link href="/login" className="btn-ghost w-full">
            Voltar pro login
          </Link>
        </form>
      )}
    </div>
  );
}
