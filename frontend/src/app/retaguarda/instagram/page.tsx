'use client';

/**
 * /retaguarda/instagram — Status da Conta Instagram Conectada
 *
 * Mostra dados básicos da conta @lurdsplussize acessados via Graph API.
 * Demonstra o uso da permissão `instagram_business_basic` da Meta.
 */

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface AccountInfo {
  id?: string;
  username?: string;
  name?: string;
  biography?: string;
  profile_picture_url?: string;
  followers_count?: number;
  follows_count?: number;
  media_count?: number;
  website?: string;
  error?: string;
}

interface MediaItem {
  id: string;
  media_type: string;
  caption?: string;
  permalink: string;
  media_url?: string;
  thumbnail_url?: string;
  timestamp: string;
  like_count?: number;
  comments_count?: number;
}

export default function InstagramAccountPage() {
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadAll = async () => {
    setLoading(true);
    setError(null);
    try {
      const [accRes, mediaRes] = await Promise.all([
        api<AccountInfo>('/inbox/instagram/account'),
        api<{ data?: MediaItem[]; error?: string }>('/inbox/instagram/media?limit=9'),
      ]);

      if (accRes.error) {
        setError(accRes.error);
      } else {
        setAccount(accRes);
      }
      if (mediaRes?.data) setMedia(mediaRes.data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAll();
  }, []);

  const formatNumber = (n?: number) => {
    if (n === undefined || n === null) return '—';
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return n.toString();
  };

  return (
    <main className="min-h-screen bg-stone-100">
      {/* Header */}
      <header className="bg-white border-b border-stone-200 px-6 py-3 flex items-center justify-between">
        <div>
          <div className="text-xs text-stone-500">FlowOps · Instagram / Live</div>
          <h1 className="text-lg font-bold text-stone-900">
            📷 Conta Instagram Conectada
          </h1>
        </div>
        <button
          onClick={loadAll}
          disabled={loading}
          className="px-3 py-1.5 rounded-lg text-sm font-medium bg-stone-100 text-stone-700 hover:bg-stone-200"
        >
          {loading ? '⟳ Carregando…' : '⟳ Atualizar'}
        </button>
      </header>

      <div className="max-w-screen-xl mx-auto p-6 space-y-6">
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-800 rounded-2xl p-4">
            <div className="font-bold mb-1">Erro ao carregar dados da Meta</div>
            <div className="text-sm">{error}</div>
          </div>
        )}

        {/* ─── CARD PRINCIPAL DA CONTA ─── */}
        {account && !account.error && (
          <section className="bg-white rounded-2xl shadow p-6">
            <div className="flex items-start gap-5 flex-wrap">
              {account.profile_picture_url ? (
                <img
                  src={account.profile_picture_url}
                  alt={account.username}
                  className="w-24 h-24 rounded-full ring-4 ring-rose-100 object-cover"
                />
              ) : (
                <div className="w-24 h-24 rounded-full bg-gradient-to-br from-rose-400 to-pink-500 flex items-center justify-center text-white text-3xl font-bold">
                  {account.username?.[0]?.toUpperCase() || '?'}
                </div>
              )}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-3 flex-wrap">
                  <h2 className="text-2xl font-bold text-stone-900">@{account.username}</h2>
                  <span className="text-[10px] uppercase font-bold bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full">
                    ✓ Conectada via API oficial Meta
                  </span>
                </div>
                <div className="text-stone-700 mt-1">{account.name}</div>
                {account.biography && (
                  <div className="text-sm text-stone-600 mt-2 whitespace-pre-wrap max-w-2xl">
                    {account.biography}
                  </div>
                )}
                {account.website && (
                  <a
                    href={account.website}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm text-rose-600 hover:underline mt-2 inline-block"
                  >
                    🌐 {account.website}
                  </a>
                )}
              </div>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-3 gap-4 mt-6 pt-6 border-t border-stone-200">
              <Stat label="Seguidores" value={formatNumber(account.followers_count)} accent="text-rose-600" />
              <Stat label="Seguindo" value={formatNumber(account.follows_count)} accent="text-stone-800" />
              <Stat label="Publicações" value={formatNumber(account.media_count)} accent="text-stone-800" />
            </div>
          </section>
        )}

        {/* ─── PERMISSÕES ATIVAS ─── */}
        <section className="bg-white rounded-2xl shadow p-6">
          <h2 className="font-bold text-sm text-stone-500 uppercase tracking-wider mb-4">
            Permissões ativas (Meta App Review)
          </h2>
          <div className="space-y-2">
            <PermBadge label="instagram_business_basic" desc="Ler dados básicos da conta, perfil e mídias" />
            <PermBadge label="instagram_business_manage_comments" desc="Responder comentários públicos (Lú IA)" />
            <PermBadge label="instagram_business_manage_messages" desc="Enviar e receber DMs (atendimento humano)" />
          </div>
        </section>

        {/* ─── ÚLTIMAS PUBLICAÇÕES ─── */}
        {media.length > 0 && (
          <section className="bg-white rounded-2xl shadow p-6">
            <h2 className="font-bold text-sm text-stone-500 uppercase tracking-wider mb-4">
              Últimas publicações ({media.length})
            </h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {media.map((m) => (
                <a
                  key={m.id}
                  href={m.permalink}
                  target="_blank"
                  rel="noreferrer"
                  className="group block aspect-square rounded-xl overflow-hidden bg-stone-100 relative"
                >
                  {(m.thumbnail_url || m.media_url) ? (
                    <img
                      src={m.thumbnail_url || m.media_url}
                      alt={m.caption?.slice(0, 40) || m.id}
                      className="w-full h-full object-cover group-hover:scale-105 transition"
                    />
                  ) : (
                    <div className="flex items-center justify-center h-full text-4xl">📷</div>
                  )}
                  <div className="absolute bottom-0 left-0 right-0 p-2 bg-gradient-to-t from-black/70 to-transparent text-white text-xs">
                    <div className="flex items-center gap-2">
                      <span>❤️ {m.like_count ?? 0}</span>
                      <span>💬 {m.comments_count ?? 0}</span>
                    </div>
                  </div>
                  <span className="absolute top-2 right-2 text-[10px] bg-black/60 text-white px-1.5 py-0.5 rounded uppercase font-bold">
                    {m.media_type}
                  </span>
                </a>
              ))}
            </div>
          </section>
        )}

        {/* ─── INFO TÉCNICA ─── */}
        <section className="bg-stone-900 text-stone-300 rounded-2xl p-6 text-xs font-mono">
          <div className="text-stone-400 mb-2">// Conexão API Meta</div>
          <div className="space-y-1">
            <div><span className="text-rose-400">App ID:</span> {process.env.NEXT_PUBLIC_META_APP_ID || '1541267820922482'}</div>
            <div><span className="text-rose-400">IG User ID:</span> {account?.id || '—'}</div>
            <div><span className="text-rose-400">Graph API version:</span> v19.0</div>
            <div><span className="text-rose-400">Endpoint:</span> graph.facebook.com/{`{ig-user-id}`}</div>
          </div>
        </section>
      </div>
    </main>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div className="text-center">
      <div className={`text-3xl font-bold ${accent}`}>{value}</div>
      <div className="text-xs text-stone-500 uppercase tracking-wider mt-1">{label}</div>
    </div>
  );
}

function PermBadge({ label, desc }: { label: string; desc: string }) {
  return (
    <div className="flex items-start gap-3 p-3 rounded-lg bg-emerald-50 border border-emerald-200">
      <span className="text-emerald-600 text-lg">✓</span>
      <div>
        <code className="text-xs font-mono font-bold text-emerald-900">{label}</code>
        <div className="text-xs text-emerald-800 mt-0.5">{desc}</div>
      </div>
    </div>
  );
}
