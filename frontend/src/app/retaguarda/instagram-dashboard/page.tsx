'use client';

/**
 * /retaguarda/instagram-dashboard — Dashboard de Métricas do Instagram
 *
 * Painel executivo com KPIs operacionais da @lurdsplussize:
 *  • DMs recebidas / respondidas (hoje/semana/mês)
 *  • Comentários processados pela Lú IA
 *  • Lives realizadas + GMV total
 *  • Conversão de comentários em reservas
 *  • Top clientes (VIP) por volume de compra
 *  • Taxa de resposta da equipe (SLA)
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  ChevronLeft,
  TrendingUp,
  MessageSquare,
  MessageCircle,
  Radio,
  ShoppingBag,
  Users,
  Clock,
  Sparkles,
  ArrowUp,
  ArrowDown,
} from 'lucide-react';

interface DashboardData {
  period: 'today' | 'week' | 'month';
  dmReceived: number;
  dmReplied: number;
  dmAvgResponseMin: number;
  commentsProcessed: number;
  commentsLuReplied: number;
  livesCount: number;
  livesGmv: number;
  reservationsCreated: number;
  reservationsConverted: number;
  topVipCustomers: VipCustomer[];
  recentActivity: ActivityItem[];
}

interface VipCustomer {
  name: string;
  igUsername: string;
  tier: 'diamond' | 'gold' | 'silver' | 'bronze';
  totalSpent: number;
  ordersCount: number;
}

interface ActivityItem {
  type: 'dm' | 'comment' | 'reservation' | 'live';
  text: string;
  time: string;
}

const MOCK_DATA: Record<string, DashboardData> = {
  today: {
    period: 'today',
    dmReceived: 47,
    dmReplied: 42,
    dmAvgResponseMin: 8,
    commentsProcessed: 312,
    commentsLuReplied: 289,
    livesCount: 1,
    livesGmv: 8540,
    reservationsCreated: 23,
    reservationsConverted: 19,
    topVipCustomers: [
      { name: 'Patrícia Souza', igUsername: '@paty_souza', tier: 'diamond', totalSpent: 4200, ordersCount: 8 },
      { name: 'Renata Lima', igUsername: '@re.lima', tier: 'gold', totalSpent: 2890, ordersCount: 5 },
      { name: 'Ana Costa', igUsername: '@anacosta_oficial', tier: 'gold', totalSpent: 2150, ordersCount: 4 },
      { name: 'Carolina Ramos', igUsername: '@caroramos', tier: 'silver', totalSpent: 1680, ordersCount: 3 },
      { name: 'Juliana Pires', igUsername: '@ju.pires', tier: 'silver', totalSpent: 1340, ordersCount: 3 },
    ],
    recentActivity: [
      { type: 'reservation', text: 'Nova reserva: Vestido azul P (#205) por @paty_souza', time: '2 min' },
      { type: 'dm', text: 'DM respondida por Maria Silva → @re.lima', time: '5 min' },
      { type: 'comment', text: 'Lú respondeu comentário de @anacosta_oficial no post #312', time: '8 min' },
      { type: 'live', text: 'Live "Promo Sextou" iniciada — 312 espectadores', time: '15 min' },
      { type: 'reservation', text: 'Reserva confirmada: Blusa verde M (#198) por @caroramos', time: '23 min' },
    ],
  },
  week: {
    period: 'week',
    dmReceived: 384,
    dmReplied: 361,
    dmAvgResponseMin: 12,
    commentsProcessed: 2_148,
    commentsLuReplied: 1_982,
    livesCount: 4,
    livesGmv: 47_280,
    reservationsCreated: 156,
    reservationsConverted: 138,
    topVipCustomers: [
      { name: 'Patrícia Souza', igUsername: '@paty_souza', tier: 'diamond', totalSpent: 12_400, ordersCount: 22 },
      { name: 'Renata Lima', igUsername: '@re.lima', tier: 'gold', totalSpent: 8_320, ordersCount: 14 },
      { name: 'Mariana Vieira', igUsername: '@mari.vieira', tier: 'gold', totalSpent: 7_650, ordersCount: 13 },
      { name: 'Ana Costa', igUsername: '@anacosta_oficial', tier: 'gold', totalSpent: 6_180, ordersCount: 11 },
      { name: 'Carolina Ramos', igUsername: '@caroramos', tier: 'silver', totalSpent: 4_980, ordersCount: 9 },
    ],
    recentActivity: [],
  },
  month: {
    period: 'month',
    dmReceived: 1_624,
    dmReplied: 1_523,
    dmAvgResponseMin: 14,
    commentsProcessed: 9_312,
    commentsLuReplied: 8_476,
    livesCount: 18,
    livesGmv: 218_540,
    reservationsCreated: 712,
    reservationsConverted: 624,
    topVipCustomers: [
      { name: 'Patrícia Souza', igUsername: '@paty_souza', tier: 'diamond', totalSpent: 38_200, ordersCount: 64 },
      { name: 'Renata Lima', igUsername: '@re.lima', tier: 'diamond', totalSpent: 28_140, ordersCount: 48 },
      { name: 'Mariana Vieira', igUsername: '@mari.vieira', tier: 'gold', totalSpent: 22_980, ordersCount: 41 },
      { name: 'Ana Costa', igUsername: '@anacosta_oficial', tier: 'gold', totalSpent: 19_640, ordersCount: 36 },
      { name: 'Tatiana Reis', igUsername: '@taty.reis', tier: 'gold', totalSpent: 17_320, ordersCount: 32 },
    ],
    recentActivity: [],
  },
};

export default function InstagramDashboardPage() {
  const [period, setPeriod] = useState<'today' | 'week' | 'month'>('today');
  const [data, setData] = useState<DashboardData>(MOCK_DATA.today);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    setTimeout(() => {
      setData(MOCK_DATA[period]);
      setLoading(false);
    }, 200);
  }, [period]);

  const fmtCurrency = (v: number) =>
    v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 0 });
  const fmtNum = (v: number) => v.toLocaleString('pt-BR');
  const fmtPct = (v: number, total: number) =>
    total > 0 ? `${Math.round((v / total) * 100)}%` : '0%';

  return (
    <main className="min-h-screen bg-stone-100">
      <header className="bg-white border-b border-stone-200 px-6 py-3 flex items-center justify-between">
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
              <TrendingUp className="w-5 h-5 text-rose-600" />
              Dashboard Instagram
            </h1>
          </div>
        </div>

        {/* Period selector */}
        <div className="flex items-center gap-1 bg-stone-100 rounded-lg p-1">
          {(['today', 'week', 'month'] as const).map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`px-4 py-1.5 rounded-md text-sm font-medium ${
                period === p ? 'bg-white shadow text-stone-900' : 'text-stone-600 hover:text-stone-900'
              }`}
            >
              {p === 'today' ? 'Hoje' : p === 'week' ? 'Semana' : 'Mês'}
            </button>
          ))}
        </div>
      </header>

      <div className="max-w-screen-xl mx-auto p-6 space-y-6">
        {/* ─── KPIs principais ─── */}
        <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Kpi
            icon={MessageSquare}
            label="DMs recebidas"
            value={fmtNum(data.dmReceived)}
            sub={`${data.dmReplied} respondidas (${fmtPct(data.dmReplied, data.dmReceived)})`}
            tone="rose"
            trend="up"
          />
          <Kpi
            icon={MessageCircle}
            label="Comentários"
            value={fmtNum(data.commentsProcessed)}
            sub={`Lú respondeu ${fmtPct(data.commentsLuReplied, data.commentsProcessed)}`}
            tone="pink"
            trend="up"
          />
          <Kpi
            icon={Radio}
            label="Lives"
            value={fmtNum(data.livesCount)}
            sub={`GMV: ${fmtCurrency(data.livesGmv)}`}
            tone="fuchsia"
            trend="up"
          />
          <Kpi
            icon={ShoppingBag}
            label="Reservas"
            value={fmtNum(data.reservationsCreated)}
            sub={`${data.reservationsConverted} convertidas (${fmtPct(
              data.reservationsConverted,
              data.reservationsCreated,
            )})`}
            tone="amber"
            trend="up"
          />
        </section>

        {/* ─── SLA + IA Bar ─── */}
        <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="bg-white rounded-2xl shadow p-5">
            <div className="flex items-center gap-2 text-stone-500 text-xs uppercase font-bold tracking-wider mb-3">
              <Clock className="w-4 h-4" /> SLA Atendimento Humano
            </div>
            <div className="text-4xl font-bold text-stone-900">
              {data.dmAvgResponseMin}
              <span className="text-base text-stone-500 ml-1">min</span>
            </div>
            <div className="text-xs text-stone-500 mt-1">Tempo médio de resposta · meta: &lt; 15 min</div>
            <div className="mt-3 h-2 bg-stone-100 rounded-full overflow-hidden">
              <div
                className={`h-full ${
                  data.dmAvgResponseMin < 15 ? 'bg-emerald-500' : 'bg-amber-500'
                }`}
                style={{ width: `${Math.min((data.dmAvgResponseMin / 30) * 100, 100)}%` }}
              />
            </div>
          </div>

          <div className="bg-white rounded-2xl shadow p-5 col-span-2">
            <div className="flex items-center gap-2 text-stone-500 text-xs uppercase font-bold tracking-wider mb-3">
              <Sparkles className="w-4 h-4 text-rose-600" /> Eficácia da Lú IA
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <div className="text-2xl font-bold text-stone-900">
                  {fmtPct(data.commentsLuReplied, data.commentsProcessed)}
                </div>
                <div className="text-xs text-stone-500">Comentários respondidos</div>
              </div>
              <div>
                <div className="text-2xl font-bold text-stone-900">
                  {fmtNum(data.commentsProcessed - data.commentsLuReplied)}
                </div>
                <div className="text-xs text-stone-500">Escalados pra humano</div>
              </div>
              <div>
                <div className="text-2xl font-bold text-emerald-600">
                  {fmtCurrency(Math.round(data.livesGmv / Math.max(data.livesCount, 1)))}
                </div>
                <div className="text-xs text-stone-500">GMV médio por live</div>
              </div>
            </div>
          </div>
        </section>

        {/* ─── Top VIP + Activity ─── */}
        <section className="grid grid-cols-1 lg:grid-cols-5 gap-4">
          {/* Top VIP */}
          <div className="bg-white rounded-2xl shadow p-5 lg:col-span-3">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-bold text-stone-900 flex items-center gap-2">
                <Users className="w-4 h-4 text-rose-600" />
                Top clientes VIP
              </h2>
              <span className="text-xs text-stone-500">{period === 'today' ? 'hoje' : period === 'week' ? '7 dias' : '30 dias'}</span>
            </div>
            <div className="space-y-2">
              {data.topVipCustomers.map((c, i) => (
                <div
                  key={c.igUsername}
                  className="flex items-center gap-3 p-2 rounded-lg hover:bg-stone-50"
                >
                  <span className="w-6 text-center text-sm font-bold text-stone-400">
                    {i + 1}
                  </span>
                  <VipBadge tier={c.tier} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-stone-900 truncate">
                      {c.name}
                    </div>
                    <div className="text-xs text-stone-500">{c.igUsername}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-bold text-stone-900">
                      {fmtCurrency(c.totalSpent)}
                    </div>
                    <div className="text-xs text-stone-500">{c.ordersCount} pedidos</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Activity feed */}
          <div className="bg-white rounded-2xl shadow p-5 lg:col-span-2">
            <h2 className="font-bold text-stone-900 mb-4">Atividade recente</h2>
            {data.recentActivity.length === 0 ? (
              <div className="text-sm text-stone-500 text-center py-8">
                Sem atividades nesse período. Mude pra "Hoje" pra ver eventos em tempo real.
              </div>
            ) : (
              <div className="space-y-3">
                {data.recentActivity.map((a, i) => (
                  <div key={i} className="flex items-start gap-3 text-sm">
                    <ActivityIcon type={a.type} />
                    <div className="flex-1 min-w-0">
                      <div className="text-stone-800">{a.text}</div>
                      <div className="text-xs text-stone-500">há {a.time}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        {/* ─── Permissões Meta ativas ─── */}
        <section className="bg-gradient-to-r from-rose-500 to-pink-600 text-white rounded-2xl shadow-lg p-6">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 items-center">
            <div className="md:col-span-2">
              <div className="text-xs uppercase opacity-80 mb-1">Powered by</div>
              <div className="text-xl font-bold">Meta Graph API v19.0</div>
              <div className="text-sm opacity-90 mt-1">
                @lurdsplussize · Conectada via API oficial
              </div>
            </div>
            <Pill label="instagram_business_basic" />
            <Pill label="instagram_business_manage_messages" />
          </div>
        </section>
      </div>
    </main>
  );
}

/* ─── Sub-components ─── */

function Kpi({
  icon: Icon,
  label,
  value,
  sub,
  tone,
  trend,
}: {
  icon: any;
  label: string;
  value: string;
  sub: string;
  tone: 'rose' | 'pink' | 'fuchsia' | 'amber';
  trend?: 'up' | 'down';
}) {
  const toneClasses = {
    rose: 'bg-rose-50 text-rose-700',
    pink: 'bg-pink-50 text-pink-700',
    fuchsia: 'bg-fuchsia-50 text-fuchsia-700',
    amber: 'bg-amber-50 text-amber-700',
  };
  return (
    <div className="bg-white rounded-2xl shadow p-5">
      <div className="flex items-center justify-between mb-3">
        <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${toneClasses[tone]}`}>
          <Icon className="w-5 h-5" />
        </div>
        {trend && (
          <div className={`flex items-center gap-1 text-xs font-bold ${trend === 'up' ? 'text-emerald-600' : 'text-red-600'}`}>
            {trend === 'up' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />}
            vs período anterior
          </div>
        )}
      </div>
      <div className="text-3xl font-bold text-stone-900">{value}</div>
      <div className="text-xs uppercase font-bold text-stone-500 tracking-wider mt-1">{label}</div>
      <div className="text-xs text-stone-500 mt-1">{sub}</div>
    </div>
  );
}

function VipBadge({ tier }: { tier: VipCustomer['tier'] }) {
  const styles = {
    diamond: 'bg-gradient-to-br from-blue-400 to-purple-500 text-white',
    gold: 'bg-gradient-to-br from-amber-400 to-yellow-500 text-white',
    silver: 'bg-gradient-to-br from-stone-300 to-stone-400 text-white',
    bronze: 'bg-gradient-to-br from-orange-400 to-orange-600 text-white',
  };
  return (
    <div className={`w-8 h-8 rounded-full flex items-center justify-center text-[10px] font-bold ${styles[tier]}`}>
      {tier === 'diamond' ? '💎' : tier === 'gold' ? '🥇' : tier === 'silver' ? '🥈' : '🥉'}
    </div>
  );
}

function ActivityIcon({ type }: { type: ActivityItem['type'] }) {
  const icons = {
    dm: { Icon: MessageSquare, bg: 'bg-rose-100 text-rose-700' },
    comment: { Icon: MessageCircle, bg: 'bg-pink-100 text-pink-700' },
    reservation: { Icon: ShoppingBag, bg: 'bg-amber-100 text-amber-700' },
    live: { Icon: Radio, bg: 'bg-fuchsia-100 text-fuchsia-700' },
  };
  const { Icon, bg } = icons[type];
  return (
    <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${bg}`}>
      <Icon className="w-3.5 h-3.5" />
    </div>
  );
}

function Pill({ label }: { label: string }) {
  return (
    <div className="bg-white/20 backdrop-blur ring-1 ring-white/30 rounded-lg px-3 py-1.5 text-xs font-mono font-bold text-center">
      ✓ {label}
    </div>
  );
}
