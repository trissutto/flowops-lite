'use client';

/**
 * /franquias — Hub da FRANQUIA.
 *
 * Dois papéis usam esta tela (escopo forçado no backend, aqui é só navegação):
 *   - 'franquias'       → READ-ONLY dos dados das lojas FRANQUEADAS (tipo='FILIAL').
 *   - 'master_franquia' → funções de MASTER, porém SOMENTE nas lojas FILIAL:
 *                         botão "Entrar PDV" abre o PDV das franquias em aba nova
 *                         (o backend recusa loja REDE no impersonate).
 *
 * Áreas (conforme liberação):
 *   - Notas (NFC-e)      → /minha-loja/pdv/notas  (ATIVO — já escopado)
 *   - Faturamento/Vendas → em breve
 *   - Estoque/Produtos   → em breve
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { FileText, BarChart3, Package2, ArrowUpRight, LogOut, Lock, Building2, ShoppingBag } from 'lucide-react';
import { api } from '@/lib/api';
import StoreSwitcher from '@/components/StoreSwitcher';

export default function FranquiasHub() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [checking, setChecking] = useState(true);
  const [isMaster, setIsMaster] = useState(false);

  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_token') : null;
    if (!token) {
      router.push('/login');
      return;
    }
    api<{ role: string; name?: string }>('/auth/me')
      .then((me) => {
        // Só franquias/master_franquia (e admin, pra conferir a tela) entram aqui.
        if (me.role !== 'franquias' && me.role !== 'master_franquia' && me.role !== 'admin') {
          router.push('/');
          return;
        }
        setIsMaster(me.role === 'master_franquia');
        if (me.name) setName(me.name);
        setChecking(false);
      })
      .catch(() => router.push('/login'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function logout() {
    try { localStorage.removeItem('flowops_token'); } catch {}
    try { sessionStorage.removeItem('flowops_token'); } catch {}
    router.push('/login');
  }

  if (checking) {
    return (
      <div className="min-h-screen flex items-center justify-center text-slate-400 text-sm">
        Carregando…
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <header className="bg-white border-b border-slate-200">
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-500 to-amber-700 text-white flex items-center justify-center shrink-0">
              <Building2 className="w-5 h-5" />
            </div>
            <div>
              <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-amber-700/80">
                {isMaster ? 'Master Franquia' : 'Administrador de Franquias'}
              </div>
              <div className="font-bold text-slate-800 leading-tight">
                {name || 'Lurds Order One'}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {isMaster && <StoreSwitcher />}
            <button
              onClick={logout}
              className="px-3 py-2 rounded-lg bg-white border border-slate-200 text-sm font-semibold text-slate-600 hover:bg-slate-50 flex items-center gap-1.5"
            >
              <LogOut className="w-4 h-4" /> Sair
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-6">
        {/* Aviso de escopo */}
        <div className="mb-5 flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-800">
          <Lock className="w-4 h-4 shrink-0" />
          {isMaster ? (
            <span>
              Acesso <b>master</b> restrito às <b>lojas franqueadas</b> — use{' '}
              <b>Entrar PDV</b> pra abrir uma loja da franquia em aba nova.
            </span>
          ) : (
            <span>
              Acesso <b>somente leitura</b> aos dados das <b>lojas franqueadas</b>.
            </span>
          )}
        </div>

        {/* Áreas */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {/* Faturamento = o MESMO Super Painel da retaguarda (15/07, decisão
              do dono: "100% idêntico, inclusive as cascatas"). O backend escopa
              os papéis de franquia só às lojas FILIAL automaticamente. */}
          <AreaCard
            href="/retaguarda/super-painel-caixas"
            label="Faturamento · Super Painel"
            description="Caixas, vendas e formas — com as cascatas, ao vivo e por período"
            icon={BarChart3}
            tone="sky"
          />
          <AreaCard
            href="/minha-loja/pdv/notas"
            label="Notas (NFC-e)"
            description="Notas emitidas pelas franquias"
            icon={FileText}
            tone="emerald"
          />
          <AreaCard
            href="/franquias/estoque"
            label="Estoque"
            description="Peças, valor por loja, grupos e consulta de produto"
            icon={Package2}
            tone="violet"
          />
          <AreaCard
            href="/franquias/faturamento"
            label="Resumo & Ranking"
            description="Bruto oficial por dia, ranking das franquias e mais vendidos"
            icon={BarChart3}
            tone="emerald"
          />
          <AreaCard
            href="/retaguarda/produtos-vendidos"
            label="Produtos Vendidos · Editar"
            description="Vendas das franquias: editar vendedora/pagamento e excluir venda"
            icon={ShoppingBag}
            tone="sky"
          />
        </div>
      </main>
    </div>
  );
}

const TONES = {
  emerald: { from: '#5b9b3e', to: '#3f7029' },
  sky: { from: '#0e7e87', to: '#0a5a62' },
  violet: { from: '#8a5cb6', to: '#5f3e8a' },
} as const;

function AreaCard({
  href, label, description, icon: Icon, tone, soon,
}: {
  href?: string;
  label: string;
  description: string;
  icon: typeof FileText;
  tone: keyof typeof TONES;
  soon?: boolean;
}) {
  const t = TONES[tone];
  const inner = (
    <div
      className={`relative overflow-hidden rounded-2xl px-5 py-5 text-white shadow-sm flex flex-col gap-2 h-full ${
        soon ? 'opacity-50' : 'hover:shadow-md hover:-translate-y-0.5 active:translate-y-0 transition'
      }`}
      style={{ background: `linear-gradient(135deg, ${t.from} 0%, ${t.to} 100%)` }}
    >
      <div className="absolute -top-8 -right-8 w-32 h-32 rounded-full opacity-15"
           style={{ background: 'radial-gradient(circle, white 0%, transparent 70%)' }} />
      <div className="relative flex items-center justify-between">
        <Icon className="w-6 h-6 opacity-90" strokeWidth={1.7} />
        {!soon && <ArrowUpRight className="w-4 h-4 opacity-70" />}
      </div>
      <div className="relative">
        <div className="text-xl font-bold leading-tight">{label}</div>
        <div className="text-[11px] opacity-85 mt-1 leading-snug">{description}</div>
        {soon && (
          <span className="inline-block mt-2 text-[10px] font-bold uppercase tracking-wider bg-white/20 rounded px-1.5 py-0.5">
            Em breve
          </span>
        )}
      </div>
    </div>
  );
  if (soon || !href) return <div>{inner}</div>;
  return <Link href={href}>{inner}</Link>;
}
