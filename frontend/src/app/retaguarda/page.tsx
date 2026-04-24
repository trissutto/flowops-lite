'use client';

/**
 * /retaguarda — Hub de retaguarda.
 *
 * Tela intermediária entre a home (4 botões MÃE) e os módulos individuais.
 * Mostra os 10 cards coloridos do grupo RETAGUARDA (Enviados por loja, Log
 * de baixas, Venda Certa, Materiais, Almoxarifado, Publicar no site,
 * WhatsApp, Diagnóstico ERP, Vendedoras, Realinhamento).
 *
 * Motivo do arquivo: a home foi simplificada pra 4 botões MÃE. Esses cards
 * que ficavam diretamente na home vieram pra cá.
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  FileSearch, CheckCircle2, Package2, Boxes, Globe, Smartphone,
  Database, Users, Shuffle, ArrowLeft, ArrowRight, Layers,
} from 'lucide-react';
import { api } from '@/lib/api';

type ModuleCard = {
  href: string;
  label: string;
  subtitle: string;
  icon: typeof FileSearch;
};

const RETAGUARDA_CARDS: ModuleCard[] = [
  // "Enviados por Loja" virou aba em /separacao (Emissão de Separações).
  // Removido daqui pra não duplicar — acesso direto na tela de operação diária.
  { href: '/retaguarda/baixas-log',      label: 'Log de Baixas',     subtitle: 'Auditoria ERP',          icon: FileSearch },
  { href: '/retaguarda/venda-certa',     label: 'Venda Certa',       subtitle: 'Anti-malandragem',       icon: CheckCircle2 },
  { href: '/retaguarda/materiais',       label: 'Materiais',         subtitle: 'Pedidos das filiais',    icon: Package2 },
  { href: '/retaguarda/almoxarifado',    label: 'Almoxarifado',      subtitle: 'Estoque interno',        icon: Boxes },
  { href: '/retaguarda/publicar-site',   label: 'Publicar no Site',  subtitle: 'Cadastros via IA',       icon: Globe },
  { href: '/retaguarda/whatsapp',        label: 'WhatsApp',          subtitle: 'Conexão + bulk',         icon: Smartphone },
  { href: '/retaguarda/diagnostico-erp', label: 'Diagnóstico ERP',   subtitle: 'Auditoria SKU',          icon: Database },
  { href: '/retaguarda/vendedoras',      label: 'Vendedoras',        subtitle: 'Karine, Manu, …',        icon: Users },
  { href: '/retaguarda/realinhamento',   label: 'Realinhamento',     subtitle: 'Rebalancear estoque entre lojas', icon: Shuffle },
];

export default function RetaguardaHub() {
  const router = useRouter();

  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_token') : null;
    if (!token) {
      router.push('/login');
      return;
    }
    api<{ role: string }>('/auth/me')
      .then((me) => { if (me.role === 'store') router.push('/minha-loja'); })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="min-h-screen bg-gradient-to-br from-amber-50 via-orange-50 to-red-50">
      {/* Header da seção */}
      <div className="bg-gradient-to-br from-amber-500 via-orange-600 to-red-600 text-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 pt-5 pb-10 relative">
          <div className="absolute -top-10 -right-10 w-64 h-64 rounded-full bg-yellow-300/20 blur-3xl pointer-events-none" />
          <div className="absolute top-10 left-1/3 w-48 h-48 rounded-full bg-red-400/20 blur-3xl pointer-events-none" />
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-sm font-semibold opacity-90 hover:opacity-100 mb-4 transition"
          >
            <ArrowLeft className="w-4 h-4" /> Voltar
          </Link>
          <div className="flex items-center gap-4 relative">
            <div className="w-16 h-16 rounded-2xl bg-white/20 backdrop-blur-md ring-1 ring-white/25 flex items-center justify-center shadow-xl">
              <Layers className="w-8 h-8" />
            </div>
            <div>
              <div className="text-xs uppercase tracking-widest opacity-80">Lurds Order One</div>
              <h1 className="text-3xl sm:text-5xl font-black tracking-tight">RETAGUARDA</h1>
              <div className="text-sm opacity-90 mt-1">Materiais · baixas · ERP · site · WhatsApp</div>
            </div>
          </div>
        </div>
      </div>

      {/* Grid de módulos */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 sm:py-10">
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4">
          {RETAGUARDA_CARDS.map((item) => (
            <ModuleCardView key={item.href} item={item} />
          ))}
        </div>
      </div>
    </div>
  );
}

function ModuleCardView({ item }: { item: ModuleCard }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      className="group flex flex-col rounded-2xl bg-gradient-to-br from-amber-500 to-orange-600 text-white shadow-lg hover:shadow-2xl hover:-translate-y-1 transition-all duration-300 p-5 min-h-[170px] relative overflow-hidden"
    >
      <div className="absolute -top-10 -right-10 w-32 h-32 rounded-full bg-yellow-300/20 blur-2xl pointer-events-none group-hover:bg-yellow-300/30 transition" />
      <div className="w-12 h-12 bg-white/20 backdrop-blur-sm ring-1 ring-white/20 rounded-xl flex items-center justify-center mb-3 shadow-md relative">
        <Icon className="w-6 h-6" />
      </div>
      <div className="font-black text-base leading-tight relative">{item.label}</div>
      <div className="text-xs opacity-85 mt-1 line-clamp-2 relative">{item.subtitle}</div>
      <div className="mt-auto pt-3 relative">
        <div className="inline-flex items-center gap-1 bg-white/25 backdrop-blur text-white text-xs font-black px-3 py-1.5 rounded-lg group-hover:bg-white group-hover:text-orange-700 transition uppercase tracking-wider">
          Abrir
          <ArrowRight className="w-3.5 h-3.5" />
        </div>
      </div>
    </Link>
  );
}
