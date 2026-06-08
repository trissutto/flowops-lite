'use client';

/**
 * /retaguarda/lu-config — Configuração da Lú IA
 *
 * Painel pra ajustar comportamento da Lú (IA de atendimento Lurd's):
 *  • Tom de voz (formal / casual / super amável)
 *  • Ativação Lú Posts (responder comentários sem live ativa)
 *  • Lojas físicas (lista editável)
 *  • Palavras-chave que disparam respostas específicas
 *  • CTAs padrão (taplink, site)
 *  • Mensagens prontas por categoria
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  Bot,
  ChevronLeft,
  Save,
  Plus,
  Trash2,
  Sparkles,
  MapPin,
  MessageCircle,
  Link as LinkIcon,
  ToggleLeft,
  ToggleRight,
} from 'lucide-react';

/* ─── Tipos ─── */
interface LuConfig {
  toneStyle: 'formal' | 'casual' | 'super_friendly';
  luPostsEnabled: boolean;
  luLiveEnabled: boolean;
  emojiUsage: 'none' | 'moderate' | 'high';
  ctaPrimary: string;
  ctaSecondary: string;
  stores: StoreEntry[];
  keywords: KeywordRule[];
  presets: PresetMessage[];
}

interface StoreEntry {
  id: string;
  city: string;
  address: string;
  whatsapp: string;
}

interface KeywordRule {
  id: string;
  trigger: string;
  response: string;
}

interface PresetMessage {
  id: string;
  label: string;
  body: string;
  category: 'size' | 'shipping' | 'payment' | 'store' | 'other';
}

/* ─── Default config (até backend retornar) ─── */
const DEFAULT_CONFIG: LuConfig = {
  toneStyle: 'super_friendly',
  luPostsEnabled: true,
  luLiveEnabled: true,
  emojiUsage: 'moderate',
  ctaPrimary: 'https://lurds.com.br/tree',
  ctaSecondary: 'https://taplink.cc/lurdsplussize',
  stores: [
    { id: '1', city: 'Campinas', address: 'Rua 13 de Maio, 1100', whatsapp: '5519999990001' },
    { id: '2', city: 'Sorocaba', address: 'Av. Gen. Carneiro, 450', whatsapp: '5515999990002' },
    { id: '3', city: 'Praia Grande', address: 'Av. Pres. Costa e Silva, 220', whatsapp: '5513999990003' },
    { id: '4', city: 'Limeira', address: 'Rua Boa Morte, 800', whatsapp: '5519999990004' },
    { id: '5', city: 'Indaiatuba', address: 'Av. Pres. Vargas, 1200', whatsapp: '5519999990005' },
    { id: '6', city: 'Itanhaém', address: 'Av. Pres. Vargas, 850', whatsapp: '5513999990006' },
    { id: '7', city: 'Piracicaba', address: 'Rua do Rosário, 300', whatsapp: '5519999990007' },
    { id: '8', city: 'Vinhedo', address: 'Av. Independência, 500', whatsapp: '5519999990008' },
    { id: '9', city: 'São José dos Campos', address: 'Av. Andrômeda, 700', whatsapp: '5512999990009' },
    { id: '10', city: 'Balneário Camboriú', address: 'Av. Brasil, 1500', whatsapp: '5547999990010' },
  ],
  keywords: [
    { id: '1', trigger: 'tamanho|manequim|veste', response: 'Atendemos do 46 ao 60 💕 Qual seria o seu tamanho?' },
    { id: '2', trigger: 'preço|valor|quanto custa', response: 'Te mando os valores agora linda! Tem desconto pra primeira compra ✨' },
    { id: '3', trigger: 'frete|entrega|chegou', response: 'Entregamos pro Brasil todo via Correios e transportadoras parceiras 📦' },
    { id: '4', trigger: 'parcelar|cartão|pix', response: 'Pode parcelar em até 12x sem juros no cartão ou 5% off no Pix 💳' },
  ],
  presets: [
    { id: '1', label: 'Saudação', body: 'Oi linda! Tudo bem? 💕 Como posso te ajudar?', category: 'other' },
    { id: '2', label: 'Tamanho disponível', body: 'Acabei de checar e tem sim! Posso reservar pra você?', category: 'size' },
    { id: '3', label: 'Pedir CEP', body: 'Me passa seu CEP pra eu ver se temos loja física pertinho de você? 📍', category: 'store' },
    { id: '4', label: 'Forma de pagamento', body: 'Aceitamos Pix (5% off), cartão até 12x sem juros e boleto 💳', category: 'payment' },
    { id: '5', label: 'Prazo de entrega', body: 'O prazo é de 3 a 7 dias úteis após confirmação do pagamento 📦', category: 'shipping' },
  ],
};

export default function LuConfigPage() {
  const [config, setConfig] = useState<LuConfig>(DEFAULT_CONFIG);
  const [saved, setSaved] = useState(false);
  const [activeTab, setActiveTab] = useState<'tom' | 'lojas' | 'keywords' | 'presets' | 'cta'>('tom');

  useEffect(() => {
    // TODO: GET /lu/config — usar default enquanto não tem backend
    // api<LuConfig>('/lu/config').then(setConfig).catch(() => {});
  }, []);

  const handleSave = async () => {
    // TODO: POST /lu/config
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  /* ─── Mutators ─── */
  const updateField = <K extends keyof LuConfig>(key: K, val: LuConfig[K]) =>
    setConfig({ ...config, [key]: val });

  const addStore = () =>
    setConfig({
      ...config,
      stores: [...config.stores, { id: Date.now().toString(), city: '', address: '', whatsapp: '' }],
    });
  const removeStore = (id: string) =>
    setConfig({ ...config, stores: config.stores.filter((s) => s.id !== id) });
  const updateStore = (id: string, patch: Partial<StoreEntry>) =>
    setConfig({
      ...config,
      stores: config.stores.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    });

  const addKeyword = () =>
    setConfig({
      ...config,
      keywords: [...config.keywords, { id: Date.now().toString(), trigger: '', response: '' }],
    });
  const removeKeyword = (id: string) =>
    setConfig({ ...config, keywords: config.keywords.filter((k) => k.id !== id) });
  const updateKeyword = (id: string, patch: Partial<KeywordRule>) =>
    setConfig({
      ...config,
      keywords: config.keywords.map((k) => (k.id === id ? { ...k, ...patch } : k)),
    });

  const addPreset = () =>
    setConfig({
      ...config,
      presets: [
        ...config.presets,
        { id: Date.now().toString(), label: '', body: '', category: 'other' },
      ],
    });
  const removePreset = (id: string) =>
    setConfig({ ...config, presets: config.presets.filter((p) => p.id !== id) });
  const updatePreset = (id: string, patch: Partial<PresetMessage>) =>
    setConfig({
      ...config,
      presets: config.presets.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    });

  return (
    <main className="min-h-screen bg-stone-100">
      {/* Header */}
      <header className="bg-white border-b border-stone-200 px-6 py-3 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <Link
            href="/retaguarda/instagram-hub"
            className="p-2 rounded-lg hover:bg-stone-100 text-stone-600"
          >
            <ChevronLeft className="w-5 h-5" />
          </Link>
          <div>
            <div className="text-xs text-stone-500">FlowOps · Instagram</div>
            <h1 className="text-lg font-bold text-stone-900 flex items-center gap-2">
              <Bot className="w-5 h-5 text-rose-600" />
              Configuração Lú IA
            </h1>
          </div>
        </div>
        <button
          onClick={handleSave}
          className="px-4 py-2 rounded-lg bg-rose-600 hover:bg-rose-700 text-white text-sm font-medium flex items-center gap-2"
        >
          <Save className="w-4 h-4" />
          {saved ? '✓ Salvo' : 'Salvar configurações'}
        </button>
      </header>

      <div className="max-w-screen-xl mx-auto p-6 grid grid-cols-12 gap-6">
        {/* Sidebar tabs */}
        <aside className="col-span-3 space-y-1">
          <TabButton
            label="Tom & Comportamento"
            icon={Sparkles}
            active={activeTab === 'tom'}
            onClick={() => setActiveTab('tom')}
          />
          <TabButton
            label="Lojas Físicas"
            icon={MapPin}
            active={activeTab === 'lojas'}
            onClick={() => setActiveTab('lojas')}
            count={config.stores.length}
          />
          <TabButton
            label="Palavras-chave"
            icon={MessageCircle}
            active={activeTab === 'keywords'}
            onClick={() => setActiveTab('keywords')}
            count={config.keywords.length}
          />
          <TabButton
            label="Respostas Prontas"
            icon={MessageCircle}
            active={activeTab === 'presets'}
            onClick={() => setActiveTab('presets')}
            count={config.presets.length}
          />
          <TabButton
            label="CTAs e Links"
            icon={LinkIcon}
            active={activeTab === 'cta'}
            onClick={() => setActiveTab('cta')}
          />
        </aside>

        {/* Content */}
        <section className="col-span-9 bg-white rounded-2xl shadow p-6 min-h-[500px]">
          {/* TOM */}
          {activeTab === 'tom' && (
            <div className="space-y-6">
              <div>
                <h2 className="text-lg font-bold text-stone-900 mb-1">Tom de voz da Lú</h2>
                <p className="text-sm text-stone-500">
                  Como a IA fala com as clientes da Lurd's
                </p>
              </div>

              <ToneOption
                value="super_friendly"
                current={config.toneStyle}
                onClick={(v) => updateField('toneStyle', v)}
                title="Super amável (recomendado)"
                desc="'Oi linda 💕', emojis frequentes, perguntas de acolhimento. Combina com público Lurd's."
              />
              <ToneOption
                value="casual"
                current={config.toneStyle}
                onClick={(v) => updateField('toneStyle', v)}
                title="Casual"
                desc="Linguagem natural, alguns emojis, sem 'linda/amor'. Mais neutro."
              />
              <ToneOption
                value="formal"
                current={config.toneStyle}
                onClick={(v) => updateField('toneStyle', v)}
                title="Formal"
                desc="'Olá, tudo bem?', sem emojis, tratamento por 'você'. Profissional."
              />

              <div className="pt-6 border-t border-stone-200 space-y-4">
                <ToggleRow
                  label="Lú Posts ativa"
                  desc="IA responde comentários quando NÃO tem live em andamento"
                  value={config.luPostsEnabled}
                  onChange={(v) => updateField('luPostsEnabled', v)}
                />
                <ToggleRow
                  label="Lú Live ativa"
                  desc="IA responde comentários DURANTE a live e processa reservas"
                  value={config.luLiveEnabled}
                  onChange={(v) => updateField('luLiveEnabled', v)}
                />
              </div>

              <div className="pt-6 border-t border-stone-200">
                <label className="text-sm font-bold text-stone-700 block mb-2">
                  Uso de emojis
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {(['none', 'moderate', 'high'] as const).map((opt) => (
                    <button
                      key={opt}
                      onClick={() => updateField('emojiUsage', opt)}
                      className={`px-3 py-2 rounded-lg border-2 text-sm font-medium transition ${
                        config.emojiUsage === opt
                          ? 'border-rose-500 bg-rose-50 text-rose-700'
                          : 'border-stone-200 text-stone-600 hover:border-stone-300'
                      }`}
                    >
                      {opt === 'none' ? 'Nenhum' : opt === 'moderate' ? 'Moderado' : 'Alto 💕✨'}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* LOJAS */}
          {activeTab === 'lojas' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-bold text-stone-900">Lojas físicas</h2>
                  <p className="text-sm text-stone-500">
                    Lú menciona essas lojas quando cliente envia CEP ou pergunta sobre cidade
                  </p>
                </div>
                <button
                  onClick={addStore}
                  className="px-3 py-1.5 rounded-lg bg-stone-100 hover:bg-stone-200 text-sm font-medium flex items-center gap-1"
                >
                  <Plus className="w-4 h-4" /> Adicionar
                </button>
              </div>

              <div className="space-y-2">
                {config.stores.map((s) => (
                  <div
                    key={s.id}
                    className="grid grid-cols-12 gap-2 p-3 bg-stone-50 rounded-lg items-center"
                  >
                    <input
                      value={s.city}
                      onChange={(e) => updateStore(s.id, { city: e.target.value })}
                      placeholder="Cidade"
                      className="col-span-3 px-3 py-1.5 rounded border border-stone-200 text-sm"
                    />
                    <input
                      value={s.address}
                      onChange={(e) => updateStore(s.id, { address: e.target.value })}
                      placeholder="Endereço"
                      className="col-span-5 px-3 py-1.5 rounded border border-stone-200 text-sm"
                    />
                    <input
                      value={s.whatsapp}
                      onChange={(e) => updateStore(s.id, { whatsapp: e.target.value })}
                      placeholder="WhatsApp E.164"
                      className="col-span-3 px-3 py-1.5 rounded border border-stone-200 text-sm font-mono"
                    />
                    <button
                      onClick={() => removeStore(s.id)}
                      className="col-span-1 text-stone-400 hover:text-red-600 flex justify-center"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* KEYWORDS */}
          {activeTab === 'keywords' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-bold text-stone-900">Palavras-chave</h2>
                  <p className="text-sm text-stone-500">
                    Quando aparecer essas palavras na DM/comentário, Lú usa a resposta correspondente
                  </p>
                </div>
                <button
                  onClick={addKeyword}
                  className="px-3 py-1.5 rounded-lg bg-stone-100 hover:bg-stone-200 text-sm font-medium flex items-center gap-1"
                >
                  <Plus className="w-4 h-4" /> Adicionar
                </button>
              </div>

              <div className="space-y-2">
                {config.keywords.map((k) => (
                  <div key={k.id} className="p-3 bg-stone-50 rounded-lg space-y-2">
                    <div className="flex items-start gap-2">
                      <div className="flex-1">
                        <label className="text-[11px] uppercase font-bold text-stone-500">
                          Trigger (separado por | )
                        </label>
                        <input
                          value={k.trigger}
                          onChange={(e) => updateKeyword(k.id, { trigger: e.target.value })}
                          placeholder="ex: tamanho|manequim|veste"
                          className="w-full px-3 py-1.5 rounded border border-stone-200 text-sm font-mono mt-1"
                        />
                      </div>
                      <button
                        onClick={() => removeKeyword(k.id)}
                        className="mt-6 text-stone-400 hover:text-red-600"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                    <div>
                      <label className="text-[11px] uppercase font-bold text-stone-500">
                        Resposta da Lú
                      </label>
                      <textarea
                        value={k.response}
                        onChange={(e) => updateKeyword(k.id, { response: e.target.value })}
                        rows={2}
                        className="w-full px-3 py-1.5 rounded border border-stone-200 text-sm mt-1"
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* PRESETS */}
          {activeTab === 'presets' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-bold text-stone-900">Respostas prontas</h2>
                  <p className="text-sm text-stone-500">
                    Atendentes humanos usam essas no Inbox como atalho (1 clique pra enviar)
                  </p>
                </div>
                <button
                  onClick={addPreset}
                  className="px-3 py-1.5 rounded-lg bg-stone-100 hover:bg-stone-200 text-sm font-medium flex items-center gap-1"
                >
                  <Plus className="w-4 h-4" /> Adicionar
                </button>
              </div>

              <div className="space-y-2">
                {config.presets.map((p) => (
                  <div key={p.id} className="p-3 bg-stone-50 rounded-lg space-y-2">
                    <div className="grid grid-cols-12 gap-2">
                      <input
                        value={p.label}
                        onChange={(e) => updatePreset(p.id, { label: e.target.value })}
                        placeholder="Label (ex: Saudação)"
                        className="col-span-4 px-3 py-1.5 rounded border border-stone-200 text-sm"
                      />
                      <select
                        value={p.category}
                        onChange={(e) =>
                          updatePreset(p.id, { category: e.target.value as PresetMessage['category'] })
                        }
                        className="col-span-4 px-3 py-1.5 rounded border border-stone-200 text-sm bg-white"
                      >
                        <option value="size">Tamanho</option>
                        <option value="shipping">Frete</option>
                        <option value="payment">Pagamento</option>
                        <option value="store">Loja física</option>
                        <option value="other">Outro</option>
                      </select>
                      <div className="col-span-3" />
                      <button
                        onClick={() => removePreset(p.id)}
                        className="col-span-1 text-stone-400 hover:text-red-600 flex justify-center items-center"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                    <textarea
                      value={p.body}
                      onChange={(e) => updatePreset(p.id, { body: e.target.value })}
                      placeholder="Mensagem completa…"
                      rows={2}
                      className="w-full px-3 py-1.5 rounded border border-stone-200 text-sm"
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* CTA */}
          {activeTab === 'cta' && (
            <div className="space-y-4">
              <h2 className="text-lg font-bold text-stone-900 mb-1">CTAs padrão</h2>
              <p className="text-sm text-stone-500 mb-4">
                Links que Lú envia quando convidando a cliente pro site/catálogo
              </p>

              <div>
                <label className="text-sm font-bold text-stone-700 block mb-1">
                  CTA Primária (lurds.com.br/tree)
                </label>
                <input
                  value={config.ctaPrimary}
                  onChange={(e) => updateField('ctaPrimary', e.target.value)}
                  className="w-full px-3 py-2 rounded border border-stone-200 text-sm"
                />
                <p className="text-xs text-stone-500 mt-1">
                  Usado quando cliente pergunta link, preço ou onde comprar
                </p>
              </div>

              <div>
                <label className="text-sm font-bold text-stone-700 block mb-1">
                  CTA Secundária (taplink Instagram)
                </label>
                <input
                  value={config.ctaSecondary}
                  onChange={(e) => updateField('ctaSecondary', e.target.value)}
                  className="w-full px-3 py-2 rounded border border-stone-200 text-sm"
                />
                <p className="text-xs text-stone-500 mt-1">
                  Fallback para o link do bio do Instagram
                </p>
              </div>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

/* ─── Sub-components ─── */

function TabButton({
  label,
  icon: Icon,
  active,
  onClick,
  count,
}: {
  label: string;
  icon: any;
  active: boolean;
  onClick: () => void;
  count?: number;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm font-medium transition ${
        active
          ? 'bg-rose-100 text-rose-800'
          : 'text-stone-600 hover:bg-stone-100'
      }`}
    >
      <span className="flex items-center gap-2">
        <Icon className="w-4 h-4" />
        {label}
      </span>
      {count !== undefined && (
        <span className="text-[11px] bg-white px-2 py-0.5 rounded-full text-stone-600">
          {count}
        </span>
      )}
    </button>
  );
}

function ToneOption({
  value,
  current,
  onClick,
  title,
  desc,
}: {
  value: LuConfig['toneStyle'];
  current: LuConfig['toneStyle'];
  onClick: (v: LuConfig['toneStyle']) => void;
  title: string;
  desc: string;
}) {
  const active = current === value;
  return (
    <button
      onClick={() => onClick(value)}
      className={`w-full text-left p-4 rounded-xl border-2 transition ${
        active
          ? 'border-rose-500 bg-rose-50'
          : 'border-stone-200 hover:border-stone-300'
      }`}
    >
      <div className="font-bold text-stone-900">{title}</div>
      <div className="text-sm text-stone-600 mt-1">{desc}</div>
    </button>
  );
}

function ToggleRow({
  label,
  desc,
  value,
  onChange,
}: {
  label: string;
  desc: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      onClick={() => onChange(!value)}
      className="w-full flex items-center justify-between p-3 rounded-lg hover:bg-stone-50 text-left"
    >
      <div>
        <div className="font-medium text-stone-900">{label}</div>
        <div className="text-xs text-stone-500">{desc}</div>
      </div>
      {value ? (
        <ToggleRight className="w-10 h-10 text-rose-600" />
      ) : (
        <ToggleLeft className="w-10 h-10 text-stone-300" />
      )}
    </button>
  );
}
