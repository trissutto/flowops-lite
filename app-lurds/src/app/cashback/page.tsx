'use client';

import Link from 'next/link';
import { ArrowLeft, Wallet, TrendingUp, Gift, Sparkles } from 'lucide-react';
import BottomNav from '@/components/BottomNav';

/**
 * /cashback — Tela do saldo + extrato (placeholder Semana 1).
 * Semana 2 vai conectar com o backend pra puxar saldo real.
 */
export default function CashbackPage() {
  return (
    <div className="pb-24">
      <header className="flex items-center gap-3 px-5 pt-5">
        <Link href="/" className="p-2 rounded-full bg-ink-800 hover:bg-ink-700 transition">
          <ArrowLeft className="w-5 h-5 text-gold" />
        </Link>
        <h1 className="font-serif text-xl font-bold">Meu Cashback</h1>
      </header>

      {/* Saldo principal */}
      <section className="mt-6 px-5">
        <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-gold via-gold-light to-gold p-6 text-ink shadow-gold-lg">
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest opacity-70">
            <Wallet className="w-4 h-4" />
            Saldo disponível
          </div>
          <div className="mt-2 font-serif text-5xl font-black tabular-nums">
            R$ 0<span className="text-3xl">,00</span>
          </div>
          <div className="mt-2 text-sm opacity-80">
            Use na sua próxima compra (loja física ou site)
          </div>
        </div>
      </section>

      {/* Cards de status */}
      <section className="mt-5 px-5 grid grid-cols-2 gap-3">
        <div className="card-dark">
          <TrendingUp className="w-5 h-5 text-gold mb-2" />
          <div className="text-[10px] uppercase tracking-wider text-cream/60 font-bold">
            Acumulado
          </div>
          <div className="text-xl font-bold mt-0.5">R$ 0,00</div>
        </div>
        <div className="card-dark">
          <Gift className="w-5 h-5 text-gold mb-2" />
          <div className="text-[10px] uppercase tracking-wider text-cream/60 font-bold">
            Pendente
          </div>
          <div className="text-xl font-bold mt-0.5">R$ 0,00</div>
        </div>
      </section>

      {/* Bônus de cadastro pendente */}
      <section className="mt-6 px-5">
        <div className="card-gold-border bg-gold/5 flex items-start gap-3">
          <Sparkles className="w-5 h-5 text-gold shrink-0 mt-0.5" />
          <div className="text-sm">
            <strong className="text-gold">R$ 20 esperando você</strong>
            <p className="text-cream/70 mt-1">
              Faça sua primeira compra (na loja ou no site) e os R$ 20 vão direto pro seu
              saldo, automaticamente.
            </p>
          </div>
        </div>
      </section>

      {/* Como funciona */}
      <section className="mt-8 px-5">
        <h2 className="font-serif text-lg font-bold mb-3">Como funciona</h2>
        <div className="space-y-3 text-sm text-cream/70">
          <div className="card-dark">
            <strong className="text-white">1. Compre</strong> em qualquer loja Lurd's ou no site
            usando seu CPF.
          </div>
          <div className="card-dark">
            <strong className="text-white">2. Ganhe cashback</strong> em até 7 dias após a
            compra confirmada (% configurável pela Lurd's).
          </div>
          <div className="card-dark">
            <strong className="text-white">3. Use</strong> quando quiser na sua próxima compra
            — desconto na hora.
          </div>
        </div>
      </section>

      {/* Extrato (vazio) */}
      <section className="mt-8 px-5">
        <h2 className="font-serif text-lg font-bold mb-3">Extrato</h2>
        <div className="card-dark text-center py-8 text-cream/50 text-sm">
          Você ainda não tem movimentações.<br />
          Faça sua primeira compra pra começar 💛
        </div>
      </section>

      <div className="h-20" />
      <BottomNav />
    </div>
  );
}
