'use client';

/**
 * /retaguarda/inbox — Caixa de Entrada do Atendimento Humano
 *
 * Tela usada pela equipe de atendimento da Lurd's Plus Size pra responder
 * mensagens de clientes vindas do Instagram Direct.
 *
 * Usa a permissão Human Agent da Meta — estende janela de resposta de
 * 24h pra 7 dias quando atendente humano responde manualmente.
 */

import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';

interface Conversation {
  customer_id: string;
  name: string;
  ig_username: string;
  vip_tier: string;
  last_message: string;
  last_direction: 'in' | 'out';
  last_at: string;
  channel: string;
  hours_ago: number;
  unread_count: number;
}

interface Message {
  id: string;
  body: string;
  direction: 'in' | 'out';
  channel: string;
  aiGenerated: boolean;
  createdAt: string;
  status: string;
}

interface ConversationDetail {
  customer: {
    id: string;
    name: string;
    igUsername: string;
    vipTier: string;
    sizeDefault: string | null;
  };
  messages: Message[];
}

export default function InboxPage() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [filter, setFilter] = useState<'all' | 'pending' | 'beyond24h'>('all');
  const [selected, setSelected] = useState<ConversationDetail | null>(null);
  const [composerText, setComposerText] = useState('');
  const [sending, setSending] = useState(false);
  const [agentName] = useState('Maria Silva'); // mockado
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // ─── Carrega conversas ────────────────────────────────────
  const loadConversations = async (f = filter) => {
    try {
      const data = await api<Conversation[]>(`/inbox/conversations?filter=${f}`);
      setConversations(data);
    } catch (err) {
      console.error('Erro carregando conversas:', err);
    }
  };

  useEffect(() => {
    loadConversations();
    const interval = setInterval(() => loadConversations(), 10_000);
    return () => clearInterval(interval);
  }, [filter]);

  // ─── Abre conversa ──────────────────────────────────────
  const openConversation = async (customerId: string) => {
    try {
      const data = await api<ConversationDetail>(`/inbox/conversations/${customerId}`);
      setSelected(data);
      setComposerText('');
      // marca como lida → recarrega lista
      loadConversations();
      // scroll pro fim
      setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
    } catch (err) {
      console.error('Erro abrindo conversa:', err);
    }
  };

  // ─── Envia resposta ─────────────────────────────────────
  const sendReply = async () => {
    if (!selected || !composerText.trim() || sending) return;
    setSending(true);
    try {
      await api(`/inbox/conversations/${selected.customer.id}/reply`, {
        method: 'POST',
        body: JSON.stringify({ body: composerText, agentName }),
      });
      setComposerText('');
      // recarrega conversa pra ver msg enviada
      await openConversation(selected.customer.id);
    } catch (err: any) {
      alert('Erro ao enviar: ' + err.message);
    } finally {
      setSending(false);
    }
  };

  // ─── Helpers ────────────────────────────────────────────
  const hoursAgo = (n: number) => {
    if (n < 1) return 'agora há pouco';
    if (n < 24) return `há ${Math.floor(n)}h`;
    return `há ${Math.floor(n / 24)} dias`;
  };

  const vipBadge = (tier: string) => {
    const colors: any = {
      diamond: 'bg-purple-100 text-purple-700',
      gold: 'bg-amber-100 text-amber-700',
      silver: 'bg-stone-200 text-stone-700',
      bronze: 'bg-orange-100 text-orange-700',
    };
    return colors[tier] || 'bg-stone-100 text-stone-600';
  };

  return (
    <main className="min-h-screen bg-stone-100">
      {/* Header */}
      <header className="bg-white border-b border-stone-200 px-6 py-3 flex items-center justify-between">
        <div>
          <div className="text-xs text-stone-500">FlowOps · Lurd's Plus Size</div>
          <h1 className="text-lg font-bold text-stone-900">
            📥 Caixa de Entrada — Atendimento Humano
          </h1>
        </div>
        <div className="text-right text-sm">
          <div className="font-semibold text-stone-800">{agentName}</div>
          <div className="text-xs text-stone-500">Atendente · Online</div>
        </div>
      </header>

      {/* Layout 2 colunas */}
      <div className="grid grid-cols-1 lg:grid-cols-[400px_1fr] h-[calc(100vh-64px)]">
        {/* ─── Coluna esquerda: lista de conversas ─── */}
        <aside className="bg-white border-r border-stone-200 flex flex-col">
          {/* Filtros */}
          <div className="border-b border-stone-200 p-3 flex gap-2 flex-wrap">
            <FilterButton active={filter === 'all'} onClick={() => setFilter('all')}>
              Todas
            </FilterButton>
            <FilterButton active={filter === 'pending'} onClick={() => setFilter('pending')}>
              Pendentes
            </FilterButton>
            <FilterButton active={filter === 'beyond24h'} onClick={() => setFilter('beyond24h')}>
              ⏰ Janela 7 dias
            </FilterButton>
          </div>

          {/* Lista */}
          <div className="flex-1 overflow-y-auto">
            {conversations.length === 0 && (
              <div className="text-center text-stone-400 text-sm py-12">
                Nenhuma conversa
              </div>
            )}
            {conversations.map((c) => {
              const isOver24h = c.last_direction === 'in' && c.hours_ago > 24;
              const isPending = c.last_direction === 'in';
              return (
                <button
                  key={c.customer_id}
                  onClick={() => openConversation(c.customer_id)}
                  className={`w-full text-left px-4 py-3 border-b border-stone-100 hover:bg-stone-50 transition ${
                    selected?.customer.id === c.customer_id ? 'bg-rose-50 border-l-4 border-l-rose-500' : ''
                  }`}
                >
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="w-9 h-9 bg-gradient-to-br from-rose-300 to-pink-400 rounded-full flex items-center justify-center text-white font-bold text-sm flex-shrink-0">
                        {c.name?.[0] || c.ig_username?.[0] || '?'}
                      </div>
                      <div className="min-w-0">
                        <div className="font-semibold text-sm text-stone-800 truncate">
                          {c.name || `@${c.ig_username}`}
                        </div>
                        <div className="text-[10px] text-stone-500 truncate">
                          @{c.ig_username} · {c.channel}
                        </div>
                      </div>
                    </div>
                    <span className={`text-[10px] px-2 py-0.5 rounded-full uppercase font-bold flex-shrink-0 ${vipBadge(c.vip_tier)}`}>
                      {c.vip_tier}
                    </span>
                  </div>
                  <div className="text-xs text-stone-600 truncate ml-11">
                    {c.last_direction === 'out' && (
                      <span className="text-stone-400">você: </span>
                    )}
                    {c.last_message}
                  </div>
                  <div className="flex items-center justify-between ml-11 mt-1">
                    <span className="text-[10px] text-stone-400">{hoursAgo(c.hours_ago)}</span>
                    <div className="flex gap-1">
                      {isOver24h && (
                        <span className="text-[9px] bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full font-bold">
                          🕒 +24h
                        </span>
                      )}
                      {c.unread_count > 0 && (
                        <span className="text-[9px] bg-rose-600 text-white px-2 py-0.5 rounded-full font-bold">
                          {c.unread_count}
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </aside>

        {/* ─── Coluna direita: conversa aberta ─── */}
        <section className="flex flex-col bg-stone-50">
          {!selected ? (
            <div className="flex-1 flex items-center justify-center text-stone-400 text-sm">
              ← Selecione uma conversa
            </div>
          ) : (
            <>
              {/* Header da conversa */}
              <div className="bg-white border-b border-stone-200 px-6 py-3 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-gradient-to-br from-rose-300 to-pink-400 rounded-full flex items-center justify-center text-white font-bold">
                    {selected.customer.name?.[0] || selected.customer.igUsername?.[0]}
                  </div>
                  <div>
                    <div className="font-bold text-stone-900">{selected.customer.name}</div>
                    <div className="text-xs text-stone-500">
                      @{selected.customer.igUsername}
                      {selected.customer.sizeDefault && ` · Tamanho ${selected.customer.sizeDefault}`}
                      <span className={`ml-2 text-[10px] px-2 py-0.5 rounded-full uppercase font-bold ${vipBadge(selected.customer.vipTier)}`}>
                        {selected.customer.vipTier}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="text-xs text-stone-500">
                  📍 Instagram Direct via API oficial Meta
                </div>
              </div>

              {/* Mensagens */}
              <div className="flex-1 overflow-y-auto p-6 space-y-3">
                {selected.messages.map((m) => {
                  const inbound = m.direction === 'in';
                  const date = new Date(m.createdAt);
                  return (
                    <div key={m.id} className={`flex ${inbound ? 'justify-start' : 'justify-end'}`}>
                      <div className={`max-w-md ${inbound ? '' : 'text-right'}`}>
                        <div
                          className={`inline-block px-4 py-2.5 rounded-2xl ${
                            inbound
                              ? 'bg-white border border-stone-200 text-stone-800 rounded-bl-sm'
                              : m.aiGenerated
                              ? 'bg-violet-100 border border-violet-200 text-violet-900 rounded-br-sm'
                              : 'bg-rose-600 text-white rounded-br-sm'
                          }`}
                        >
                          <div className="text-sm whitespace-pre-wrap">{m.body}</div>
                        </div>
                        <div className="text-[10px] text-stone-400 mt-1 px-1">
                          {!inbound && (m.aiGenerated ? '🤖 IA · ' : '👤 Atendente · ')}
                          {date.toLocaleString('pt-BR')}
                        </div>
                      </div>
                    </div>
                  );
                })}
                <div ref={messagesEndRef} />
              </div>

              {/* Composer */}
              <div className="bg-white border-t border-stone-200 p-4">
                <div className="mb-2 flex items-center gap-2 text-[10px] text-stone-500">
                  <span className="bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full font-bold">
                    🕒 HUMAN AGENT
                  </span>
                  <span>Resposta manual dentro da janela estendida de 7 dias (Meta)</span>
                </div>
                <div className="flex gap-2">
                  <textarea
                    value={composerText}
                    onChange={(e) => setComposerText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) sendReply();
                    }}
                    placeholder="Digite a resposta da atendente humana (Ctrl+Enter envia)..."
                    rows={3}
                    disabled={sending}
                    className="flex-1 border border-stone-300 rounded-xl px-3 py-2 text-sm focus:border-rose-500 outline-none resize-none"
                  />
                  <button
                    onClick={sendReply}
                    disabled={sending || !composerText.trim()}
                    className="bg-rose-600 hover:bg-rose-700 disabled:bg-stone-300 text-white px-6 rounded-xl font-bold text-sm"
                  >
                    {sending ? 'Enviando…' : 'Enviar'}
                  </button>
                </div>
                <div className="mt-2 text-[10px] text-stone-400">
                  Mensagem será enviada via Instagram Graph API com tag HUMAN_AGENT.
                </div>
              </div>
            </>
          )}
        </section>
      </div>
    </main>
  );
}

function FilterButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`text-xs px-3 py-1.5 rounded-lg font-medium transition ${
        active
          ? 'bg-rose-600 text-white'
          : 'bg-stone-100 text-stone-700 hover:bg-stone-200'
      }`}
    >
      {children}
    </button>
  );
}
