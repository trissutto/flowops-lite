'use client';
import { useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Bell } from 'lucide-react';
import BottomNav from '@/components/BottomNav';

export default function PrefNotificacoesPage() {
  const [prefs, setPrefs] = useState({
    promo: true,
    live: true,
    pedido: true,
    cashback: true,
  });
  const toggle = (k: keyof typeof prefs) => setPrefs((p) => ({ ...p, [k]: !p[k] }));

  return (
    <div className="pb-24">
      <header className="flex items-center gap-3 px-5 pt-5">
        <Link href="/conta" className="p-2 rounded-full bg-ink-800 hover:bg-ink-700 transition">
          <ArrowLeft className="w-5 h-5 text-gold" />
        </Link>
        <h1 className="font-serif text-xl font-bold">Notificações</h1>
      </header>

      <div className="mt-6 px-5">
        <div className="card-gold-border bg-gold/5 flex items-start gap-3">
          <Bell className="w-5 h-5 text-gold shrink-0 mt-0.5" />
          <p className="text-sm text-cream/80">
            Escolha o que quer receber. Promoções segmentadas pelo seu perfil
            costumam ter as melhores ofertas 💛
          </p>
        </div>
      </div>

      <div className="mt-6 px-5 space-y-2">
        <Toggle label="🎯 Promoções e ofertas" value={prefs.promo} onChange={() => toggle('promo')} />
        <Toggle label="📺 Live começou" value={prefs.live} onChange={() => toggle('live')} />
        <Toggle label="📦 Atualizações de pedido" value={prefs.pedido} onChange={() => toggle('pedido')} />
        <Toggle label="💸 Saldo de cashback" value={prefs.cashback} onChange={() => toggle('cashback')} />
      </div>

      <div className="h-20" />
      <BottomNav />
    </div>
  );
}

function Toggle({ label, value, onChange }: {
  label: string; value: boolean; onChange: () => void;
}) {
  return (
    <button
      onClick={onChange}
      className="w-full card-dark flex items-center justify-between hover:border-gold/50 transition"
    >
      <span className="text-sm font-medium">{label}</span>
      <span
        className={`w-11 h-6 rounded-full relative transition ${
          value ? 'bg-gold' : 'bg-ink-600'
        }`}
      >
        <span
          className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
            value ? 'translate-x-5' : 'translate-x-0.5'
          }`}
        />
      </span>
    </button>
  );
}
