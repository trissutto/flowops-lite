'use client';

/**
 * /retaguarda/instagram-hub — Hub Instagram / Live
 *
 * Página central que agrupa os módulos Instagram da Lurd's:
 *  • Inbox (DMs — Human Agent 7 dias)
 *  • Live Commerce (reservas em tempo real)
 *  • Conta Instagram (status da conexão Meta)
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Instagram, MessageSquare, Radio, ArrowRight, ChevronLeft } from 'lucide-react';
import { api } from '@/lib/api';

interface AccountInfo {
  username?: string;
  followers_count?: number;
  media_count?: number;
  profile_picture_url?: string;
  error?: string;
}

export default function InstagramHubPage() {
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<AccountInfo>('/inbox/instagram/account')
      .then((res) => setAccount(res))
      .catch(() => setAccount({ error: 'offline' }))
      .finally(() => setLoading(false));
  }, []);

  const formatNumber = (n?: number) => {
    if (n === undefined || n === null) return '—';
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return n.toString();
  };

  return (
    <main className="min-h-screen bg-gradient-to-br from-rose-50 via-stone-50 to-pink-50">
      {/* Header */}
      <header className="bg-white border-b border-stone-200 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link
            href="/"
            className="p-2 rounded-lg hover:bg-stone-100 text-stone-600"
            title="Voltar para a home"
          >
            <ChevronLeft className="w-5 h-5" />
          </Link>
          <div>
            <div className="text-xs text-stone-500">FlowOps · Hub</div>
            <h1 className="text-lg font-bold text-stone-900 flex items-center gap-2">
              <Instagram className="w-5 h-5 text-rose-600" />
              Instagram / Live
            </h1>
          </div>
        </div>

        {account && !account.error && (
          <div className="flex items-center gap-3">
            {account.profile_picture_url && (
              <img
                src={account.profile_picture_url}
                alt={account.username}
                className="w-9 h-9 rounded-full ring-2 ring-rose-200 object-cover"
              />
            )}
            <div className="text-right hidden sm:block">
              <div className="text-sm font-bold text-stone-900">@{account.username}</div>
              <div className="text-[11px] text-stone-500">
                {formatNumber(account.followers_count)} seguidores ·{' '}
                {formatNumber(account.media_count)} posts
              </div>
            </div>
          </div>
        )}
      </header>

      <div className="max-w-screen-xl mx-auto p-6 space-y-6">
        {/* Hero */}
        <section className="bg-gradient-to-r from-rose-500 to-pink-600 text-white rounded-2xl shadow-lg p-8">
          <div className="flex items-start justify-between gap-6 flex-wrap">
            <div className="max-w-2xl">
              <div className="text-xs uppercase tracking-wider opacity-80 mb-2">
                Central Instagram · Lurd's Plus Size
              </div>
              <h2 className="text-3xl font-bold mb-2">
                Tudo sobre @lurdsplussize em um só lugar
              </h2>
              <p className="text-rose-50 text-sm">
                Atenda DMs, comande lives de venda em tempo real e gerencie a conexão
                oficial com a Meta — Inbox, Live Commerce e dados da conta integrados
                ao ERP.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span
                className={`px-3 py-1.5 rounded-full text-xs font-bold ${
                  account && !account.error
                    ? 'bg-emerald-400/20 text-emerald-50 ring-1 ring-emerald-200/40'
                    : 'bg-yellow-400/20 text-yellow-50 ring-1 ring-yellow-200/40'
                }`}
              >
                {loading
                  ? '⟳ Verificando…'
                  : account && !account.error
                  ? '✓ Conectada via API oficial Meta'
                  : '⚠ Meta não configurada'}
              </span>
            </div>
          </div>
        </section>

        {/* Cards principais */}
        <section className="grid grid-cols-1 md:grid-cols-3 gap-5">
          <HubButton
            href="/retaguarda/inbox"
            icon={MessageSquare}
            title="Inbox Instagram"
            subtitle="Atendimento humano · Janela 7 dias"
            description="Responda DMs de clientes via Instagram Direct. Filtros VIP, tag HUMAN_AGENT e histórico completo de conversas."
            badge="Atendimento"
            tone="rose"
          />
          <HubButton
            href="/retaguarda/live"
            icon={Radio}
            title="Live Commerce"
            subtitle="Reservas em tempo real"
            description="Painel mestre da live: produtos, comentários, métricas. Lú IA reserva produtos automaticamente quando cliente comenta o código."
            badge="Live"
            tone="pink"
          />
          <HubButton
            href="/retaguarda/instagram"
            icon={Instagram}
            title="Conta Instagram"
            subtitle="Status da conexão Meta"
            description="Dados oficiais via Graph API v19.0: seguidores, mídias, permissões ativas e ID da conta business conectada."
            badge="Conexão"
            tone="fuchsia"
          />
        </section>

        {/* Permissões ativas — resumo */}
        <section className="bg-white rounded-2xl shadow p-6">
          <h2 className="font-bold text-sm text-stone-500 uppercase tracking-wider mb-4">
            Permissões Meta App Review
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <PermMini
              code="instagram_business_basic"
              desc="Dados da conta + mídias"
              status="ativa"
            />
            <PermMini
              code="instagram_business_manage_comments"
              desc="Responder comentários (Lú IA)"
              status="ativa"
            />
            <PermMini
              code="instagram_business_manage_messages"
              desc="Enviar/receber DMs (Human Agent)"
              status="ativa"
            />
          </div>
        </section>

        {/* Atalhos rápidos */}
        <section className="bg-white rounded-2xl shadow p-6">
          <h2 className="font-bold text-sm text-stone-500 uppercase tracking-wider mb-4">
            Atalhos rápidos
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <QuickLink href="/retaguarda/inbox" label="📨 Abrir Inbox" />
            <QuickLink href="/retaguarda/live" label="📻 Iniciar Live" />
            <QuickLink href="/retaguarda/instagram" label="📊 Ver Conta" />
            <QuickLink
              href="https://www.instagram.com/lurdsplussize"
              label="🔗 @lurdsplussize"
              external
            />
          </div>
        </section>
      </div>
    </main>
  );
}

/* ────────────────────────────────────────────── */

const TONE_CLASSES: Record<
  string,
  { ring: string; bg: string; iconBg: string; iconColor: string; badge: string }
> = {
  rose: {
    ring: 'hover:ring-rose-300',
    bg: 'from-rose-500 to-pink-600',
    iconBg: 'bg-rose-100',
    iconColor: 'text-rose-600',
    badge: 'bg-rose-100 text-rose-700',
  },
  pink: {
    ring: 'hover:ring-pink-300',
    bg: 'from-pink-500 to-fuchsia-600',
    iconBg: 'bg-pink-100',
    iconColor: 'text-pink-600',
    badge: 'bg-pink-100 text-pink-700',
  },
  fuchsia: {
    ring: 'hover:ring-fuchsia-300',
    bg: 'from-fuchsia-500 to-purple-600',
    iconBg: 'bg-fuchsia-100',
    iconColor: 'text-fuchsia-600',
    badge: 'bg-fuchsia-100 text-fuchsia-700',
  },
};

function HubButton({
  href,
  icon: Icon,
  title,
  subtitle,
  description,
  badge,
  tone,
}: {
  href: string;
  icon: any;
  title: string;
  subtitle: string;
  description: string;
  badge: string;
  tone: 'rose' | 'pink' | 'fuchsia';
}) {
  const t = TONE_CLASSES[tone];
  return (
    <Link
      href={href}
      className={`group bg-white rounded-2xl shadow hover:shadow-xl transition-all ring-1 ring-stone-200 ${t.ring} p-6 flex flex-col`}
    >
      <div className="flex items-start justify-between mb-4">
        <div className={`w-12 h-12 rounded-xl ${t.iconBg} flex items-center justify-center`}>
          <Icon className={`w-6 h-6 ${t.iconColor}`} />
        </div>
        <span className={`text-[10px] uppercase font-bold ${t.badge} px-2 py-0.5 rounded-full`}>
          {badge}
        </span>
      </div>
      <h3 className="text-lg font-bold text-stone-900">{title}</h3>
      <div className="text-xs text-stone-500 mb-3">{subtitle}</div>
      <p className="text-sm text-stone-600 flex-1">{description}</p>
      <div className="mt-4 pt-4 border-t border-stone-100 flex items-center justify-between text-sm font-medium text-stone-700 group-hover:text-rose-600 transition-colors">
        <span>Abrir módulo</span>
        <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
      </div>
    </Link>
  );
}

function PermMini({
  code,
  desc,
  status,
}: {
  code: string;
  desc: string;
  status: 'ativa' | 'pendente';
}) {
  const isActive = status === 'ativa';
  return (
    <div
      className={`flex items-start gap-3 p-3 rounded-lg border ${
        isActive ? 'bg-emerald-50 border-emerald-200' : 'bg-yellow-50 border-yellow-200'
      }`}
    >
      <span className={`text-lg ${isActive ? 'text-emerald-600' : 'text-yellow-600'}`}>
        {isActive ? '✓' : '⏳'}
      </span>
      <div className="min-w-0">
        <code className={`text-[11px] font-mono font-bold block truncate ${
          isActive ? 'text-emerald-900' : 'text-yellow-900'
        }`}>
          {code}
        </code>
        <div className={`text-xs mt-0.5 ${isActive ? 'text-emerald-800' : 'text-yellow-800'}`}>
          {desc}
        </div>
      </div>
    </div>
  );
}

function QuickLink({
  href,
  label,
  external,
}: {
  href: string;
  label: string;
  external?: boolean;
}) {
  const props = external
    ? { target: '_blank', rel: 'noreferrer' as const }
    : {};
  const Comp: any = external ? 'a' : Link;
  return (
    <Comp
      href={href}
      {...props}
      className="text-sm font-medium text-stone-700 bg-stone-50 hover:bg-rose-50 hover:text-rose-700 border border-stone-200 hover:border-rose-200 rounded-lg px-4 py-3 text-center transition-colors"
    >
      {label}
    </Comp>
  );
}
