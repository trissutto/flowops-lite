'use client';

/**
 * / — Home/Launchpad da matriz.
 *
 * ANTES: a raiz renderizava direto a tela de Separação + faixa KPI sticky.
 * AGORA: é um DASHBOARD de entrada — cards grandes coloridos (estilo
 * /minha-loja) organizados por seção (Operação / Retaguarda / Gestão /
 * Sistema), com KPIs no topo e Piloto Automático em destaque.
 *
 * Estrutura:
 *   1. Header de boas-vindas
 *   2. Faixa de KPIs (Processando / Em separação / Pgto pendente / Aguardando /
 *      Enviados hoje) + Toggle Piloto Automático
 *   3. Grid OPERAÇÃO — card jumbo pra Pedidos & Separação (o módulo mais usado)
 *   4. Grid RETAGUARDA — 8 cards médios
 *   5. Grid GESTÃO — 4 cards
 *   6. Grid SISTEMA — 1 card
 *
 * Mobile: tudo vira grid 2 colunas. Desktop: 3-4 colunas por seção.
 * Pedidos & Separação propriamente dita virou rota dedicada /separacao.
 *
 * Redireciona:
 *   - sem token → /login
 *   - role=store → /minha-loja (operador de filial tem UI dedicada)
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  LayoutDashboard, Truck, FileSearch, CheckCircle2, Package2, Boxes,
  Globe, Smartphone, Database, DollarSign, ShoppingBag, Users,
  Megaphone, Settings, Zap, Bot, ArrowRight, TrendingUp,
} from 'lucide-react';
import { api } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { isPilotOn, setPilotOn } from '@/lib/auto-send-order';

// ----------- Tipos dos fetches -----------
interface CountsResp {
  byStatus: Record<string, { name: string; total: number }>;
  grand: number;
}

interface EnviadosHojeItem {
  storeId?: string;
  storeName?: string;
  total?: number;
}

// ----------- Config dos cards -----------
type ModuleCard = {
  href: string;
  label: string;
  subtitle: string;
  icon: typeof LayoutDashboard;
};

type Section = {
  key: string;
  label: string;
  // Gradient color pair for section identity
  bg: string;
  accent: string;   // tailwind class pro rótulo da seção
  items: ModuleCard[];
};

const OPERACAO_CARDS: ModuleCard[] = [
  { href: '/separacao', label: 'Pedidos & Separação', subtitle: '1-clique envia pra loja', icon: LayoutDashboard },
];

const RETAGUARDA_CARDS: ModuleCard[] = [
  { href: '/retaguarda/enviados-hoje',   label: 'Enviados por Loja', subtitle: 'Tracking do dia',         icon: Truck },
  { href: '/retaguarda/baixas-log',      label: 'Log de Baixas',     subtitle: 'Auditoria ERP',          icon: FileSearch },
  { href: '/retaguarda/venda-certa',     label: 'Venda Certa',       subtitle: 'Anti-malandragem',       icon: CheckCircle2 },
  { href: '/retaguarda/materiais',       label: 'Materiais',         subtitle: 'Pedidos das filiais',    icon: Package2 },
  { href: '/retaguarda/almoxarifado',    label: 'Almoxarifado',      subtitle: 'Estoque interno',        icon: Boxes },
  { href: '/retaguarda/publicar-site',   label: 'Publicar no Site',  subtitle: 'Cadastros via IA',       icon: Globe },
  { href: '/retaguarda/whatsapp',        label: 'WhatsApp',          subtitle: 'Conexão + bulk',         icon: Smartphone },
  { href: '/retaguarda/diagnostico-erp', label: 'Diagnóstico ERP',   subtitle: 'Auditoria SKU',          icon: Database },
];

const GESTAO_CARDS: ModuleCard[] = [
  { href: '/financeiro', label: 'Financeiro', subtitle: 'Faturamento + recebíveis', icon: DollarSign },
  { href: '/produtos',   label: 'Produtos',   subtitle: 'Sync + variações',         icon: ShoppingBag },
  { href: '/clientes',   label: 'Clientes',   subtitle: 'CRM + compras',            icon: Users },
  { href: '/marketing',  label: 'Marketing',  subtitle: 'Recuperação + campanhas',  icon: Megaphone },
];

const SISTEMA_CARDS: ModuleCard[] = [
  { href: '/configuracoes', label: 'Configurações', subtitle: 'Lojas, roles, prioridades', icon: Settings },
];

// KPI cards visíveis no topo
const KPI_CARDS: Array<{ slug: string; label: string; color: string }> = [
  { slug: 'processing', label: 'Processando',    color: 'border-emerald-500' },
  { slug: 'separacao',  label: 'Em separação',   color: 'border-blue-500' },
  { slug: 'pending',    label: 'Pgto pendente',  color: 'border-amber-500' },
  { slug: 'on-hold',    label: 'Aguardando',     color: 'border-yellow-500' },
];

export default function DashboardHome() {
  const router = useRouter();
  const [counts, setCounts] = useState<Record<string, { name: string; total: number }>>({});
  const [enviadosHoje, setEnviadosHoje] = useState<number>(0);
  const [userName, setUserName] = useState<string>('');
  const [pilot, setPilot] = useState(false);

  // Guard de sessão + role (mesma lógica da home antiga)
  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_token') : null;
    if (!token) {
      router.push('/login');
      return;
    }
    api<{ role: string; name?: string }>('/auth/me')
      .then((me) => {
        if (me.role === 'store') router.push('/minha-loja');
        if (me.name) setUserName(me.name);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Piloto Automático
  useEffect(() => {
    setPilot(isPilotOn());
    const onChange = (e: Event) => {
      const det = (e as CustomEvent).detail;
      setPilot(!!det?.on);
    };
    window.addEventListener('lurds:pilot-changed', onChange);
    return () => window.removeEventListener('lurds:pilot-changed', onChange);
  }, []);

  // KPIs — contadores por status + enviados hoje (total). Atualiza a cada 30s.
  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const cnt = await api<CountsResp>('/orders/wc/counts');
        if (!cancelled) setCounts(cnt.byStatus);
      } catch {}
      try {
        // Endpoint existente — retorna pedidos enviados hoje agrupados por loja.
        // Uso o total agregado pra KPI.
        const env = await api<any>('/retaguarda/enviados-hoje');
        if (!cancelled) {
          if (Array.isArray(env)) {
            const total = env.reduce((a, x: any) => a + (x.total ?? x.count ?? 0), 0);
            setEnviadosHoje(total);
          } else if (env?.total != null) {
            setEnviadosHoje(env.total);
          } else if (env?.stores && Array.isArray(env.stores)) {
            const total = env.stores.reduce((a: number, x: any) => a + (x.total ?? 0), 0);
            setEnviadosHoje(total);
          }
        }
      } catch {}
    }

    load();
    const timer = setInterval(load, 30_000);

    const sock = getSocket();
    const onAny = () => load();
    sock.on('order:new', onAny);
    sock.on('order:status-changed', onAny);

    return () => {
      cancelled = true;
      clearInterval(timer);
      sock.off('order:new', onAny);
      sock.off('order:status-changed', onAny);
    };
  }, []);

  function togglePilot() {
    const next = !pilot;
    setPilotOn(next);
    setPilot(next);
  }

  const today = new Date().toLocaleDateString('pt-BR', {
    weekday: 'long', day: '2-digit', month: 'long',
  });

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header de boas-vindas */}
      <div className="bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 pt-6 pb-8">
          <div className="flex items-center justify-between flex-wrap gap-4">
            <div>
              <div className="text-xs uppercase tracking-widest text-slate-400 mb-1">Lurds Order One</div>
              <h1 className="text-2xl sm:text-3xl font-bold">
                {userName ? `Oi, ${userName.split(' ')[0]}` : 'Bem-vindo'} 👋
              </h1>
              <div className="text-sm text-slate-300 mt-1 capitalize">{today}</div>
            </div>
            <button
              onClick={togglePilot}
              className={`relative rounded-xl px-4 py-2.5 text-sm font-bold flex items-center gap-2 transition shadow-lg ring-2 ${
                pilot
                  ? 'bg-gradient-to-br from-fuchsia-500 to-purple-600 text-white ring-fuchsia-300/60 hover:from-fuchsia-600 hover:to-purple-700'
                  : 'bg-white/10 text-white ring-white/20 hover:bg-white/15'
              }`}
              title={pilot ? 'Pedidos novos caem na loja sozinhos. Clique pra desligar.' : 'Envio manual. Clique pra ligar.'}
            >
              {pilot ? <Zap className="w-4 h-4" /> : <Bot className="w-4 h-4" />}
              <span className="leading-tight text-left">
                <span className="block text-[10px] uppercase opacity-80 tracking-wider">Piloto automático</span>
                <span className="block text-sm">{pilot ? 'LIGADO' : 'DESLIGADO'}</span>
              </span>
              {pilot && <span className="ml-1 w-2 h-2 rounded-full bg-green-300 animate-pulse" />}
            </button>
          </div>
        </div>
      </div>

      {/* KPIs — flutuam acima do fundo escuro, criando efeito de card */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 -mt-5 relative">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2 sm:gap-3">
          {KPI_CARDS.map((c) => (
            <div
              key={c.slug}
              className={`bg-white rounded-xl shadow-sm border-l-4 ${c.color} px-3 py-2.5`}
            >
              <div className="text-[11px] sm:text-xs text-slate-500 leading-none mb-1">{c.label}</div>
              <div className="text-xl sm:text-2xl font-bold text-slate-900 leading-tight">
                {(counts[c.slug]?.total ?? 0).toLocaleString('pt-BR')}
              </div>
            </div>
          ))}
          <div className="bg-white rounded-xl shadow-sm border-l-4 border-pink-500 px-3 py-2.5">
            <div className="text-[11px] sm:text-xs text-slate-500 leading-none mb-1 flex items-center gap-1">
              <TrendingUp className="w-3 h-3" /> Enviados hoje
            </div>
            <div className="text-xl sm:text-2xl font-bold text-slate-900 leading-tight">
              {enviadosHoje.toLocaleString('pt-BR')}
            </div>
          </div>
        </div>
      </div>

      {/* Grid de módulos */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-8">
        {/* OPERAÇÃO — card jumbo (mais usado) */}
        <section>
          <SectionLabel label="Operação" color="text-sky-700" />
          <div className="grid grid-cols-1 gap-3">
            {OPERACAO_CARDS.map((item) => (
              <JumboCard
                key={item.href}
                item={item}
                gradient="from-sky-500 via-blue-600 to-blue-700"
                kpi={counts['processing']?.total}
                kpiLabel="processando agora"
              />
            ))}
          </div>
        </section>

        {/* RETAGUARDA */}
        <section>
          <SectionLabel label="Retaguarda" color="text-amber-700" />
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {RETAGUARDA_CARDS.map((item) => (
              <ModuleCardView
                key={item.href}
                item={item}
                gradient="from-amber-500 to-orange-600"
              />
            ))}
          </div>
        </section>

        {/* GESTÃO */}
        <section>
          <SectionLabel label="Gestão" color="text-emerald-700" />
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {GESTAO_CARDS.map((item) => (
              <ModuleCardView
                key={item.href}
                item={item}
                gradient="from-emerald-500 to-teal-600"
              />
            ))}
          </div>
        </section>

        {/* SISTEMA */}
        <section>
          <SectionLabel label="Sistema" color="text-slate-700" />
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {SISTEMA_CARDS.map((item) => (
              <ModuleCardView
                key={item.href}
                item={item}
                gradient="from-slate-600 to-slate-800"
              />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function SectionLabel({ label, color }: { label: string; color: string }) {
  return (
    <div className={`text-xs font-bold uppercase tracking-[0.2em] ${color} mb-3`}>
      {label}
    </div>
  );
}

function JumboCard({
  item, gradient, kpi, kpiLabel,
}: {
  item: ModuleCard;
  gradient: string;
  kpi?: number;
  kpiLabel?: string;
}) {
  const Icon = item.icon;
  // Card inteiro continua clicável (Link envolve tudo), mas agora existe um
  // BOTÃO visível "ABRIR →" pra dar affordance clara de clique.
  return (
    <Link
      href={item.href}
      className={`group block rounded-2xl bg-gradient-to-br ${gradient} text-white shadow-lg hover:shadow-xl hover:scale-[1.01] transition p-5 sm:p-6`}
    >
      <div className="flex items-center gap-4 sm:gap-5">
        <div className="w-14 h-14 sm:w-16 sm:h-16 bg-white/15 backdrop-blur rounded-2xl flex items-center justify-center shrink-0">
          <Icon className="w-7 h-7 sm:w-8 sm:h-8" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-lg sm:text-xl font-bold leading-tight">{item.label}</div>
          <div className="text-xs sm:text-sm opacity-90 mt-0.5">{item.subtitle}</div>
          {kpi != null && kpi > 0 && (
            <div className="mt-2 inline-flex items-center gap-1.5 bg-white/20 backdrop-blur rounded-full px-2.5 py-0.5 text-xs font-semibold">
              {kpi.toLocaleString('pt-BR')} {kpiLabel}
            </div>
          )}
        </div>
        <div className="hidden sm:flex items-center gap-1.5 bg-white text-slate-900 font-bold text-sm px-4 py-2.5 rounded-xl shadow-md group-hover:shadow-lg group-hover:-translate-y-0.5 transition shrink-0">
          ABRIR
          <ArrowRight className="w-4 h-4" />
        </div>
      </div>
    </Link>
  );
}

function ModuleCardView({ item, gradient }: { item: ModuleCard; gradient: string }) {
  const Icon = item.icon;
  // Card com botão "ABRIR" destacado no rodapé — mais affordance de clique do
  // que só uma setinha solta. Link envolve o card todo, então clicar em qualquer
  // área funciona, mas o botão é o foco visual.
  return (
    <Link
      href={item.href}
      className={`group flex flex-col rounded-xl bg-gradient-to-br ${gradient} text-white shadow-md hover:shadow-lg hover:-translate-y-0.5 transition p-4 min-h-[150px]`}
    >
      <div className="w-10 h-10 bg-white/15 rounded-lg flex items-center justify-center mb-3">
        <Icon className="w-5 h-5" />
      </div>
      <div className="font-semibold text-sm leading-tight">{item.label}</div>
      <div className="text-[11px] opacity-85 mt-0.5 line-clamp-1">{item.subtitle}</div>
      <div className="mt-auto pt-3">
        <div className="inline-flex items-center gap-1 bg-white/20 backdrop-blur text-white text-xs font-bold px-3 py-1.5 rounded-lg group-hover:bg-white group-hover:text-slate-900 transition">
          ABRIR
          <ArrowRight className="w-3.5 h-3.5" />
        </div>
      </div>
    </Link>
  );
}
