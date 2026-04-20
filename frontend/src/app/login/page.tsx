'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { Package, LogIn } from 'lucide-react';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('admin@flowops.local');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await api<{
        accessToken: string;
        user: { id: string; email: string; name: string | null; role: string; storeId: string | null };
      }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      localStorage.setItem('flowops_token', res.accessToken);
      // Redireciona por papel: loja vai direto pra /minha-loja
      if (res.user?.role === 'store') {
        router.push('/minha-loja');
      } else {
        router.push('/');
      }
    } catch (err: any) {
      setError('Credenciais inválidas.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-brand-dark via-brand to-brand-light">
      <form onSubmit={handleSubmit} className="bg-white rounded-xl shadow-2xl p-8 w-full max-w-sm">
        <div className="flex flex-col items-center mb-6">
          <Package className="w-10 h-10 text-brand" />
          <h1 className="text-2xl font-bold mt-2 tracking-wide">LURDS ORDER ONE</h1>
          <p className="text-sm text-slate-500">Gestão operacional de pedidos</p>
        </div>

        <label className="block text-sm font-medium mb-1">E-mail</label>
        <input
          type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
          className="w-full px-3 py-2 border rounded mb-4 focus:outline-none focus:border-brand"
        />

        <label className="block text-sm font-medium mb-1">Senha</label>
        <input
          type="password" required value={password} onChange={(e) => setPassword(e.target.value)}
          className="w-full px-3 py-2 border rounded mb-4 focus:outline-none focus:border-brand"
        />

        {error && <p className="text-red-600 text-sm mb-3">{error}</p>}

        <button type="submit" disabled={loading}
          className="w-full bg-brand text-white py-2 rounded hover:bg-brand-dark flex items-center justify-center gap-2 disabled:opacity-50">
          <LogIn className="w-4 h-4" />
          {loading ? 'Entrando...' : 'Entrar'}
        </button>
      </form>
    </div>
  );
}
