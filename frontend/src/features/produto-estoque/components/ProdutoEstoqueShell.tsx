'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ArrowLeft, Boxes, ChevronRight, Loader2, PackageCheck } from 'lucide-react';
import { api } from '@/lib/api';
import {
  MODULE_BASE_PATH,
  isModuleNavActive,
  isProductNavActive,
  produtoEstoqueNav,
  produtosNav,
} from '../module-nav';

interface ProdutoEstoqueShellProps {
  children: ReactNode;
}

export default function ProdutoEstoqueShell({ children }: ProdutoEstoqueShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [access, setAccess] = useState<'checking' | 'allowed'>('checking');
  const isProdutos = pathname === `${MODULE_BASE_PATH}/produtos`
    || pathname.startsWith(`${MODULE_BASE_PATH}/produtos/`);

  useEffect(() => {
    const token = localStorage.getItem('flowops_token');
    if (!token) {
      router.replace('/login');
      return;
    }

    api<{ role: string }>('/auth/me')
      .then((me) => {
        if (me.role === 'admin') {
          setAccess('allowed');
          return;
        }

        if (me.role === 'store') router.replace('/minha-loja/pdv');
        else if (me.role === 'contador') router.replace('/retaguarda/relatorio-fiscal');
        else if (me.role === 'franquias' || me.role === 'master_franquia') router.replace('/franquias');
        else router.replace('/');
      })
      .catch(() => router.replace('/login'));
  }, [router]);

  if (access === 'checking') {
    return (
      <div className="min-h-[70vh] flex items-center justify-center bg-slate-50">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-500">
          <Loader2 className="w-5 h-5 animate-spin text-teal-600" />
          Abrindo Produto & Estoque…
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white shadow-sm">
        <div className="mx-auto max-w-[1680px] px-3 py-4 sm:px-5 lg:px-7">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
            <div>
              <div className="mb-1 flex flex-wrap items-center gap-1.5 text-xs font-semibold text-slate-500">
                <Link href="/retaguarda" className="hover:text-teal-700">Gestão</Link>
                <ChevronRight className="h-3.5 w-3.5" />
                <span className="text-slate-700">Produto & Estoque</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-teal-600 to-cyan-800 text-white shadow-sm">
                  <PackageCheck className="h-6 w-6" />
                </span>
                <div>
                  <h1 className="text-2xl font-black tracking-tight text-slate-900 sm:text-3xl">
                    Produto & Estoque
                  </h1>
                  <p className="text-sm text-slate-500">
                    Cadastro, grade, entradas e inteligência em um só módulo
                  </p>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <Link
                href="/retaguarda/produto-master"
                className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-600 hover:border-teal-300 hover:text-teal-700"
                title="Abrir a rota antiga sem o menu do novo módulo"
              >
                <Boxes className="h-4 w-4" />
                Tela antiga
              </Link>
              <Link
                href="/retaguarda"
                className="inline-flex items-center gap-1.5 rounded-xl bg-slate-900 px-3 py-2 text-xs font-bold text-white hover:bg-slate-700"
              >
                <ArrowLeft className="h-4 w-4" />
                Gestão
              </Link>
            </div>
          </div>

          <nav className="mt-5 flex gap-2 overflow-x-auto pb-1" aria-label="Áreas de Produto e Estoque">
            {produtoEstoqueNav.map((item) => {
              const active = isModuleNavActive(pathname, item.href);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={`inline-flex shrink-0 items-center gap-2 rounded-xl px-3.5 py-2.5 text-sm font-bold transition ${
                    active
                      ? 'bg-teal-700 text-white shadow-sm'
                      : 'border border-slate-200 bg-white text-slate-600 hover:border-teal-300 hover:text-teal-700'
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  <span className="hidden sm:inline">{item.label}</span>
                  <span className="sm:hidden">{item.shortLabel}</span>
                </Link>
              );
            })}
          </nav>

          {isProdutos && (
            <nav
              className="mt-3 flex gap-2 overflow-x-auto rounded-2xl border border-slate-200 bg-slate-50 p-2"
              aria-label="Modos da área Produtos"
            >
              {produtosNav.map((item) => {
                const active = isProductNavActive(pathname, item.href);
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    title={item.description}
                    className={`inline-flex shrink-0 items-center gap-2 rounded-xl px-3 py-2 text-xs font-extrabold transition ${
                      active
                        ? 'bg-white text-teal-800 shadow-sm ring-1 ring-slate-200'
                        : 'text-slate-500 hover:bg-white hover:text-slate-800'
                    }`}
                  >
                    <Icon className="h-4 w-4" />
                    {item.label}
                  </Link>
                );
              })}
            </nav>
          )}
        </div>
      </header>

      <main>{children}</main>
    </div>
  );
}
