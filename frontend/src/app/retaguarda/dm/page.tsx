'use client';

/**
 * /retaguarda/dm — Direct Messages Pro (Inbox v2)
 *
 * Versão avançada do Inbox com:
 *  • Tags/labels coloridas (VIP, Reclamação, Pedido, Dúvida, etc)
 *  • Templates rápidos (1 clique pra inserir resposta pronta)
 *  • Painel lateral direito: histórico do cliente (compras passadas, status VIP, tamanho preferido)
 *  • Filtros avançados: por tag, por janela (24h/7d), unread, atribuição
 *  • Busca por nome / @ / texto
 *  • Marcadores: estrela, arquivar, marcar como lido
 *  • Indicador de digitação
 *  • Atalhos de teclado (Cmd+Enter pra enviar)
 */

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import {
  ChevronLeft,
  MessageSquare,
  Search,
  Star,
  Send,
  Tag,
  Sparkles,
  User,
  ShoppingBag,
  Award,
  Clock,
  Archive,
  Zap,
  X,
  ChevronRight,
} from 'lucide-react';
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
  tags?: string[];
  starred?: boolean;
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

interface CustomerHistory {
  totalOrders: number;
  totalSpent: number;
  lastOrderDate: string | null;
  preferredSize: string | null;
  preferredCategory: string;
  notes: string;
  recentProducts: Array<{ ref: string; name: string; date: string }>;
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

/* ─── Templates de resposta (vem da Lú Config no futuro) ─── */
const PRESET_TEMPLATES = [
  { id: '1', label: '👋 Saudação', body: 'Oi linda! Tudo bem? 💕 Como posso te ajudar?', category: 'other' },
  { id: '2', label: '👗 Tamanho OK', body: 'Acabei de checar e tem sim! Posso reservar pra você?', category: 'size' },
  { id: '3', label: '📍 Pede CEP', body: 'Me passa seu CEP pra eu ver se temos loja física pertinho de você? 📍', category: 'store' },
  { id: '4', label: '💳 Pagamento', body: 'Aceitamos Pix (5% off), cartão até 6x sem juros e boleto 💳', category: 'payment' },
  { id: '5', label: '📦 Prazo', body: 'O prazo é de 3 a 7 dias úteis após confirmação do pagamento 📦', category: 'shipping' },
  { id: '6', label: '🙏 Despedida', body: 'Qualquer dúvida tô aqui linda! 💕 Boas compras! ✨', category: 'other' },
];

const AVAILABLE_TAGS = [
  { id: 'vip', label: 'VIP', color: 'bg-purple-100 text-purple-800' },
  { id: 'reclamacao', label: 'Reclamação', color: 'bg-red-100 text-red-800' },
  { id: 'pedido', label: 'Pedido em andamento', color: 'bg-blue-100 text-blue-800' },
  { id: 'duvida-produto', label: 'Dúvida produto', color: 'bg-amber-100 text-amber-800' },
  { id: 'duvida-tamanho', label: 'Dúvida tamanho', color: 'bg-pink-100 text-pink-800' },
  { id: 'frete', label: 'Frete', color: 'bg-emerald-100 text-emerald-800' },
];

/* Mock customer history (até backend gerar) */
const MOCK_HISTORY: Record<string, CustomerHistory> = {
  default: {
    totalOrders: 6,
    totalSpent: 1284.5,
    lastOrderDate: '12 dias atrás',
    preferredSize: 'M',
    preferredCategory: 'Vestidos',
    notes: 'Cliente VIP. Sempre compra peças de festa. Prefere cores rosa/lilás.',
    recentProducts: [
      { ref: '205', name: 'Vestido Azul Floral', date: '12 dias' },
      { ref: '198', name: 'Blusa Verde', date: '23 dias' },
      { ref: '147', name: 'Saia Plissada Rosa', date: '1 mês' },
    ],
  },
};

export default function DmInboxV2Page() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [filter, setFilter] = useState<'all' | 'pending' | 'beyond24h' | 'starred'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [selected, setSelected] = useState<ConversationDetail | null>(null);
  const [composerText, setComposerText] = useState('');
  const [sending, setSending] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [showTagPicker, setShowTagPicker] = useState(false);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [customerHistory, setCustomerHistory] = useState<CustomerHistory | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const loadConversations = async (f = filter) => {
    try {
      const apiFilter = f === 'starred' ? 'all' : f;
      const data = await api<Conversation[]>(`/inbox/conversations?filter=${apiFilter}`);
      // Adiciona tags aleatórias mockadas pras conversas (até backend persistir tags)
      const enriched = data.map((c, i) => ({
        ...c,
        tags: i % 3 === 0 ? ['vip'] : i % 4 === 0 ? ['duvida-produto'] : [],
        starred: i % 5 === 0,
      }));
      setConversations(enriched);
    } catch (err) {
      console.error('Erro carregando conversas:', err);
    }
  };

  useEffect(() => {
    loadConversations();
    const interval = setInterval(() => loadConversations(), 10_000);
    return () => clearInterval(interval);
  }, [filter]);

  const openConversation = async (customerId: string) => {
    try {
      const data = await api<ConversationDetail>(`/inbox/conversations/${customerId}`);
      setSelected(data);
      setComposerText('');
      setSelectedTags(
        conversations.find((c) => c.customer_id === customerId)?.tags || [],
      );
      // TODO: GET /customers/:id/history
      setCustomerHistory(MOCK_HISTORY.default);
    } catch (err) {
      console.error('Erro abrindo conversa:', err);
    }
  };

  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [selected?.messages.length]);

  const send = async () => {
    if (!selected || !composerText.trim()) return;
    setSending(true);
    try {
      await api(`/inbox/conversations/${selected.customer.id}/reply`, {
        method: 'POST',
        body: JSON.stringify({ body: composerText.trim(), agentName: 'Maria Silva' }),
      });
      setComposerText('');
      const refreshed = await api<ConversationDetail>(
        `/inbox/conversations/${selected.customer.id}`,
      );
      setSelected(refreshed);
      loadConversations();
    } catch (err: any) {
      console.error('Erro enviando:', err);
      alert('Falha ao enviar: ' + (err.message || 'erro'));
    } finally {
      setSending(false);
    }
  };

  const handleTemplateClick = (template: typeof PRESET_TEMPLATES[number]) => {
    setComposerText((prev) => (prev ? `${prev}\n${template.body}` : template.body));
    setShowTemplates(false);
    composerRef.current?.focus();
  };

  const toggleTag = (tagId: string) => {
    setSelectedTags((prev) =>
      prev.includes(tagId) ? prev.filter((t) => t !== tagId) : [...prev, tagId],
    );
  };

  const filteredConversations = conversations.filter((c) => {
    if (filter === 'starred' && !c.starred) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return (
        c.name.toLowerCase().includes(q) ||
        c.ig_username.toLowerCase().includes(q) ||
        c.last_message.toLowerCase().includes(q)
      );
    }
    return true;
  });

  return (
    <main className="h-screen flex flex-col bg-stone-100">
      {/* Header */}
      <header className="bg-white border-b border-stone-200 px-6 py-3 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <Link
            href="/retaguarda/instagram-hub"
            className="p-2 rounded-lg hover:bg-stone-100 text-stone-600"
          >
            <ChevronLeft className="w-5 h-5" />
          </Link>
          <div>
            <div className="text-xs text-stone-500">FlowOps · Direct Messages Pro</div>
            <h1 className="text-lg font-bold text-stone-900 flex items-center gap-2">
              <MessageSquare className="w-5 h-5 text-rose-600" />
              Inbox DM @lurdsplussize
            </h1>
          </div>
        </div>
        <div className="text-sm text-stone-600">
          {filteredConversations.length} conversa{filteredConversations.length !== 1 ? 's' : ''}
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        {/* ─── COLUNA 1: Lista de conversas ─── */}
        <aside className="w-[340px] bg-white border-r border-stone-200 flex flex-col">
          {/* Busca */}
          <div className="p-3 border-b border-stone-200">
            <div className="relative">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-stone-400" />
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Buscar nome, @ ou texto…"
                className="w-full pl-9 pr-3 py-2 rounded-lg bg-stone-100 text-sm focus:outline-none focus:ring-2 focus:ring-rose-500"
              />
            </div>
          </div>

          {/* Filtros */}
          <div className="px-3 py-2 border-b border-stone-200 flex items-center gap-1 overflow-x-auto">
            {(
              [
                { id: 'all', label: 'Todas' },
                { id: 'pending', label: '⏳ Pendentes' },
                { id: 'beyond24h', label: '🕒 7 dias' },
                { id: 'starred', label: '⭐ Favoritas' },
              ] as const
            ).map((f) => (
              <button
                key={f.id}
                onClick={() => setFilter(f.id)}
                className={`px-3 py-1 rounded-full text-xs font-medium shrink-0 ${
                  filter === f.id
                    ? 'bg-rose-600 text-white'
                    : 'bg-stone-100 text-stone-600 hover:bg-stone-200'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>

          {/* Lista */}
          <div className="flex-1 overflow-y-auto">
            {filteredConversations.length === 0 && (
              <div className="p-8 text-center text-stone-500 text-sm">
                Nenhuma conversa encontrada
              </div>
            )}
            {filteredConversations.map((c) => (
              <button
                key={c.customer_id}
                onClick={() => openConversation(c.customer_id)}
                className={`w-full text-left p-3 border-b border-stone-100 hover:bg-stone-50 ${
                  selected?.customer.id === c.customer_id ? 'bg-rose-50' : ''
                }`}
              >
                <div className="flex items-start gap-3">
                  <VipAvatar tier={c.vip_tier} name={c.name} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-bold text-sm text-stone-900 truncate flex items-center gap-1">
                        {c.starred && <Star className="w-3 h-3 fill-amber-400 text-amber-400" />}
                        {c.name}
                      </span>
                      <span className="text-[10px] text-stone-500 shrink-0">
                        {c.hours_ago > 24
                          ? `${Math.floor(c.hours_ago / 24)}d`
                          : `${c.hours_ago}h`}
                      </span>
                    </div>
                    <div className="text-xs text-stone-500 truncate">
                      {c.ig_username}
                    </div>
                    <div className="text-xs text-stone-600 truncate mt-1">
                      {c.last_direction === 'out' && (
                        <span className="text-stone-400 mr-1">↗</span>
                      )}
                      {c.last_message}
                    </div>
                    <div className="flex items-center gap-1 mt-1.5 flex-wrap">
                      {c.hours_ago > 24 && (
                        <span className="text-[9px] uppercase font-bold bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded">
                          🕒 7 dias
                        </span>
                      )}
                      {c.unread_count > 0 && (
                        <span className="text-[9px] uppercase font-bold bg-rose-600 text-white px-1.5 py-0.5 rounded">
                          {c.unread_count} nova{c.unread_count > 1 ? 's' : ''}
                        </span>
                      )}
                      {c.tags?.map((tagId) => {
                        const tag = AVAILABLE_TAGS.find((t) => t.id === tagId);
                        if (!tag) return null;
                        return (
                          <span
                            key={tagId}
                            className={`text-[9px] uppercase font-bold px-1.5 py-0.5 rounded ${tag.color}`}
                          >
                            {tag.label}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </aside>

        {/* ─── COLUNA 2: Conversa ─── */}
        <section className="flex-1 flex flex-col bg-stone-50">
          {!selected ? (
            <div className="flex-1 flex items-center justify-center text-stone-400">
              <div className="text-center">
                <MessageSquare className="w-16 h-16 mx-auto mb-3 opacity-40" />
                <p className="text-sm">Selecione uma conversa pra começar</p>
              </div>
            </div>
          ) : (
            <>
              {/* Header da conversa */}
              <div className="bg-white border-b border-stone-200 px-5 py-3 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <VipAvatar tier={selected.customer.vipTier} name={selected.customer.name} />
                  <div>
                    <div className="font-bold text-stone-900">{selected.customer.name}</div>
                    <div className="text-xs text-stone-500">
                      {selected.customer.igUsername}
                      {selected.customer.sizeDefault && ` · Tamanho ${selected.customer.sizeDefault}`}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button className="p-2 hover:bg-stone-100 rounded-lg text-stone-600">
                    <Star className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => setShowTagPicker(true)}
                    className="p-2 hover:bg-stone-100 rounded-lg text-stone-600"
                  >
                    <Tag className="w-4 h-4" />
                  </button>
                  <button className="p-2 hover:bg-stone-100 rounded-lg text-stone-600">
                    <Archive className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Tags ativas */}
              {selectedTags.length > 0 && (
                <div className="bg-white border-b border-stone-200 px-5 py-2 flex items-center gap-2 flex-wrap">
                  {selectedTags.map((tagId) => {
                    const tag = AVAILABLE_TAGS.find((t) => t.id === tagId);
                    if (!tag) return null;
                    return (
                      <span
                        key={tagId}
                        className={`text-[10px] uppercase font-bold px-2 py-1 rounded flex items-center gap-1 ${tag.color}`}
                      >
                        {tag.label}
                        <button onClick={() => toggleTag(tagId)} className="hover:opacity-70">
                          <X className="w-2.5 h-2.5" />
                        </button>
                      </span>
                    );
                  })}
                </div>
              )}

              {/* Mensagens */}
              <div className="flex-1 overflow-y-auto p-5 space-y-3">
                {selected.messages.map((m) => (
                  <div
                    key={m.id}
                    className={`flex ${m.direction === 'out' ? 'justify-end' : 'justify-start'}`}
                  >
                    <div
                      className={`max-w-[70%] rounded-2xl px-4 py-2.5 ${
                        m.direction === 'out'
                          ? 'bg-rose-600 text-white rounded-br-sm'
                          : 'bg-white border border-stone-200 rounded-bl-sm'
                      }`}
                    >
                      <div className="text-sm whitespace-pre-wrap break-words">{m.body}</div>
                      <div
                        className={`text-[10px] mt-1 flex items-center gap-1 ${
                          m.direction === 'out' ? 'text-rose-100 justify-end' : 'text-stone-500'
                        }`}
                      >
                        {m.aiGenerated && (
                          <span className="flex items-center gap-1">
                            <Sparkles className="w-2.5 h-2.5" /> Lú
                          </span>
                        )}
                        <span>{new Date(m.createdAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>
                      </div>
                    </div>
                  </div>
                ))}
                <div ref={messagesEndRef} />
              </div>

              {/* Composer */}
              <div className="bg-white border-t border-stone-200 p-3">
                <div className="bg-amber-50 border border-amber-200 text-amber-800 text-[11px] px-3 py-1.5 rounded-lg mb-2 flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  <strong>HUMAN AGENT</strong> — janela 7 dias · resposta humana via Graph API
                </div>

                {/* Templates rápidos */}
                {showTemplates && (
                  <div className="bg-stone-50 rounded-lg p-2 mb-2 flex flex-wrap gap-1">
                    {PRESET_TEMPLATES.map((t) => (
                      <button
                        key={t.id}
                        onClick={() => handleTemplateClick(t)}
                        className="text-xs px-2 py-1 rounded bg-white border border-stone-200 hover:border-rose-300 hover:bg-rose-50"
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>
                )}

                <div className="flex items-end gap-2">
                  <button
                    onClick={() => setShowTemplates(!showTemplates)}
                    className={`p-2 rounded-lg ${
                      showTemplates ? 'bg-rose-100 text-rose-700' : 'hover:bg-stone-100 text-stone-600'
                    }`}
                    title="Templates rápidos"
                  >
                    <Zap className="w-5 h-5" />
                  </button>
                  <textarea
                    ref={composerRef}
                    value={composerText}
                    onChange={(e) => setComposerText(e.target.value)}
                    onKeyDown={(e) => {
                      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                        e.preventDefault();
                        send();
                      }
                    }}
                    placeholder="Escreva sua resposta... (Ctrl+Enter pra enviar)"
                    rows={2}
                    className="flex-1 px-3 py-2 rounded-lg border border-stone-200 text-sm focus:outline-none focus:ring-2 focus:ring-rose-500 resize-none"
                  />
                  <button
                    onClick={send}
                    disabled={!composerText.trim() || sending}
                    className="px-4 py-2.5 rounded-lg bg-rose-600 hover:bg-rose-700 disabled:bg-stone-300 text-white font-medium text-sm flex items-center gap-2"
                  >
                    <Send className="w-4 h-4" />
                    {sending ? 'Enviando...' : 'Enviar'}
                  </button>
                </div>
              </div>
            </>
          )}
        </section>

        {/* ─── COLUNA 3: Histórico do cliente ─── */}
        {selected && customerHistory && (
          <aside className="w-[300px] bg-white border-l border-stone-200 overflow-y-auto">
            <div className="p-5">
              <h3 className="font-bold text-stone-900 mb-3 flex items-center gap-2">
                <User className="w-4 h-4 text-rose-600" />
                Histórico do cliente
              </h3>

              {/* Stats */}
              <div className="grid grid-cols-2 gap-2 mb-4">
                <div className="bg-stone-50 rounded-lg p-3">
                  <div className="text-[10px] uppercase font-bold text-stone-500">Pedidos</div>
                  <div className="text-2xl font-bold text-stone-900">{customerHistory.totalOrders}</div>
                </div>
                <div className="bg-emerald-50 rounded-lg p-3">
                  <div className="text-[10px] uppercase font-bold text-emerald-700">Total gasto</div>
                  <div className="text-lg font-bold text-emerald-700">
                    {customerHistory.totalSpent.toLocaleString('pt-BR', {
                      style: 'currency',
                      currency: 'BRL',
                    })}
                  </div>
                </div>
              </div>

              {/* Info */}
              <div className="space-y-2 mb-4 text-xs">
                <InfoRow icon={Clock} label="Última compra" value={customerHistory.lastOrderDate || '—'} />
                <InfoRow icon={ShoppingBag} label="Tamanho preferido" value={customerHistory.preferredSize || '—'} />
                <InfoRow icon={Award} label="Categoria favorita" value={customerHistory.preferredCategory} />
              </div>

              {/* Notes */}
              {customerHistory.notes && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-4">
                  <div className="text-[10px] uppercase font-bold text-amber-700 mb-1">
                    📝 Observações internas
                  </div>
                  <div className="text-xs text-amber-900">{customerHistory.notes}</div>
                </div>
              )}

              {/* Produtos recentes */}
              <div>
                <div className="text-[10px] uppercase font-bold text-stone-500 mb-2">
                  Produtos comprados recentemente
                </div>
                <div className="space-y-1">
                  {customerHistory.recentProducts.map((p) => (
                    <div
                      key={p.ref}
                      className="flex items-center gap-2 p-2 rounded-lg bg-stone-50 text-xs"
                    >
                      <span className="font-mono font-bold text-rose-600">#{p.ref}</span>
                      <span className="flex-1 truncate">{p.name}</span>
                      <span className="text-stone-500">{p.date}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </aside>
        )}
      </div>

      {/* ─── Modal Tag Picker ─── */}
      {showTagPicker && (
        <TagPickerModal
          available={AVAILABLE_TAGS}
          selected={selectedTags}
          onToggle={toggleTag}
          onClose={() => setShowTagPicker(false)}
        />
      )}
    </main>
  );
}

/* ─── Sub-components ─── */

function VipAvatar({ tier, name }: { tier: string; name: string }) {
  const tierStyles: Record<string, string> = {
    diamond: 'bg-gradient-to-br from-blue-400 to-purple-500',
    gold: 'bg-gradient-to-br from-amber-400 to-yellow-500',
    silver: 'bg-gradient-to-br from-stone-300 to-stone-400',
    bronze: 'bg-gradient-to-br from-orange-400 to-orange-600',
  };
  const bg = tierStyles[tier] || 'bg-gradient-to-br from-stone-300 to-stone-400';
  const initial = name?.[0]?.toUpperCase() || '?';
  return (
    <div
      className={`w-10 h-10 rounded-full ${bg} text-white flex items-center justify-center font-bold text-sm shrink-0`}
    >
      {initial}
    </div>
  );
}

function InfoRow({ icon: Icon, label, value }: { icon: any; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="w-3.5 h-3.5 text-stone-400" />
      <span className="text-stone-500">{label}:</span>
      <span className="font-medium text-stone-900">{value}</span>
    </div>
  );
}

function TagPickerModal({
  available,
  selected,
  onToggle,
  onClose,
}: {
  available: typeof AVAILABLE_TAGS;
  selected: string[];
  onToggle: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl p-6 max-w-md w-full"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="font-bold text-stone-900 mb-4">Marcar conversa com tags</h3>
        <div className="space-y-2">
          {available.map((tag) => (
            <button
              key={tag.id}
              onClick={() => onToggle(tag.id)}
              className={`w-full flex items-center justify-between p-3 rounded-lg border-2 ${
                selected.includes(tag.id)
                  ? 'border-rose-500 bg-rose-50'
                  : 'border-stone-200 hover:border-stone-300'
              }`}
            >
              <span className={`px-2 py-1 rounded text-xs font-bold ${tag.color}`}>
                {tag.label}
              </span>
              {selected.includes(tag.id) && (
                <ChevronRight className="w-4 h-4 text-rose-600" />
              )}
            </button>
          ))}
        </div>
        <button
          onClick={onClose}
          className="w-full mt-4 py-2 rounded-lg bg-stone-900 hover:bg-stone-800 text-white font-medium"
        >
          Concluído
        </button>
      </div>
    </div>
  );
}
