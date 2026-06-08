'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import { Eye, EyeOff, Loader2, AlertCircle } from 'lucide-react';
import { maskCpf, isValidCpf, cpfDigits } from '@/lib/cpf';
import { loginCustomer, setToken } from '@/lib/api';

/**
 * /login — Login do cliente com CPF + senha.
 *
 * Visual: tela cheia preta com logo grande no topo, formulário com
 * campos altos (touch-friendly), botão dourado destacado.
 *
 * Validações:
 *  - CPF: máscara aplicada na digitação, valida algoritmo no submit
 *  - Senha: mínimo 6 chars
 */
export default function LoginPage() {
  const router = useRouter();
  const [cpf, setCpf] = useState('');
  const [password, setPassword] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!isValidCpf(cpf)) {
      setError('CPF inválido. Confere os números.');
      return;
    }
    if (password.length < 6) {
      setError('Senha precisa ter pelo menos 6 caracteres.');
      return;
    }

    setLoading(true);
    try {
      const r = await loginCustomer(cpfDigits(cpf), password);
      setToken(r.token);
      // Pega next param se vier de redirect (ex: /conta/notificacoes), senão home
      const next = new URLSearchParams(window.location.search).get('next');
      router.push(next ? `${next}?welcome=1` : '/?welcome=1');
    } catch (err: any) {
      setError(err?.message || 'Erro ao entrar. Tenta de novo.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-dvh flex flex-col px-6 pt-12 pb-8">
      {/* Logo grande no topo */}
      <div className="flex justify-center mb-12">
        <Image
          src="/images/logo-branco.png"
          alt="Lurd's Plus Size"
          width={180}
          height={98}
          priority
          className="h-20 w-auto"
        />
      </div>

      {/* Boas-vindas */}
      <div className="text-center mb-8">
        <h1 className="font-serif text-3xl font-bold">
          Bem-<span className="italic text-gold">vinda</span>
        </h1>
        <p className="text-sm text-cream/70 mt-1">
          Entra com seu CPF pra acessar suas promoções
        </p>
      </div>

      {/* Form */}
      <form onSubmit={handleSubmit} className="flex-1 flex flex-col gap-4">
        {/* CPF */}
        <div>
          <label htmlFor="cpf" className="text-xs font-bold uppercase tracking-wider text-cream/60 mb-1.5 block">
            CPF
          </label>
          <input
            id="cpf"
            type="tel"
            inputMode="numeric"
            autoComplete="username"
            placeholder="000.000.000-00"
            value={cpf}
            onChange={(e) => setCpf(maskCpf(e.target.value))}
            className="input-dark text-lg tracking-wider"
            maxLength={14}
            required
          />
        </div>

        {/* Senha */}
        <div>
          <label htmlFor="password" className="text-xs font-bold uppercase tracking-wider text-cream/60 mb-1.5 block">
            Senha
          </label>
          <div className="relative">
            <input
              id="password"
              type={showPwd ? 'text' : 'password'}
              autoComplete="current-password"
              placeholder="Mínimo 6 caracteres"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="input-dark pr-12"
              required
              minLength={6}
            />
            <button
              type="button"
              onClick={() => setShowPwd(!showPwd)}
              className="absolute right-3 top-1/2 -translate-y-1/2 p-2 text-cream/50 hover:text-gold transition"
              aria-label={showPwd ? 'Ocultar senha' : 'Mostrar senha'}
            >
              {showPwd ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
            </button>
          </div>
          <Link
            href="/esqueci-senha"
            className="text-xs text-gold/80 hover:text-gold mt-2 inline-block tracking-wider"
          >
            Esqueci minha senha
          </Link>
        </div>

        {/* Error */}
        {error && (
          <div className="flex items-start gap-2 p-3 bg-red-900/30 border border-red-700/50 rounded-xl text-sm text-red-200">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {/* Submit */}
        <button
          type="submit"
          disabled={loading || !cpf || !password}
          className="btn-gold-lg w-full mt-4"
        >
          {loading ? (
            <>
              <Loader2 className="w-5 h-5 animate-spin" />
              Entrando...
            </>
          ) : (
            'Entrar'
          )}
        </button>

        {/* Divisor */}
        <div className="my-6 flex items-center gap-3">
          <div className="flex-1 divider-gold" />
          <span className="text-xs text-cream/40 uppercase tracking-wider">ou</span>
          <div className="flex-1 divider-gold" />
        </div>

        {/* Cadastro */}
        <Link href="/cadastro" className="btn-outline-gold w-full">
          Criar conta · Ganhe R$ 20
        </Link>
      </form>

      {/* Rodapé legal */}
      <footer className="mt-8 pt-6 border-t border-ink-600 text-center text-[11px] text-cream/40 space-y-1">
        <p>
          Ao continuar você concorda com nossos{' '}
          <Link href="/termos" className="text-gold/80 underline">
            Termos de Uso
          </Link>{' '}
          e{' '}
          <Link href="/privacidade" className="text-gold/80 underline">
            Política de Privacidade
          </Link>
          .
        </p>
        <p className="text-cream/30">Lurd's Plus Size · CNPJ XX.XXX.XXX/0001-XX</p>
      </footer>
    </div>
  );
}
