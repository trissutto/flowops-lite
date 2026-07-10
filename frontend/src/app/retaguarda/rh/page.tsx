'use client';

/**
 * /retaguarda/rh — Hub central do módulo Recursos Humanos.
 *
 * Estrutura:
 *  - Header com voltar + título
 *  - Dashboard: 4 cards de resumo (ponto hoje, comissão pendente, aniversários, férias vencendo)
 *  - 5 grupos de botões: Cadastro, Ponto, Comissão, Treinamento, Relatórios
 *
 * Todos os botões linkam pras telas que JÁ EXISTEM. Esse hub só centraliza.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, Users, Clock, DollarSign, GraduationCap, BarChart3,
  UserPlus, UserCheck, Fingerprint, ClipboardList, TrendingUp, Calendar,
  Cake, BadgeAlert, FileText, Award, KeyRound,
} from 'lucide-react';
import { api } from '@/lib/api';

type Resumo = {
  pontoBatidoHojePct: number | null;
  comissaoPendenteMes: number | null;
  aniversariantesSemana: number | null;
  feriasVencendo30d: number | null;
  totalAtivas: number | null;
};

export default function RhHubPage() {
  const [resumo, setResumo] = useState<Resumo>({
    pontoBatidoHojePct: null,
    comissaoPendenteMes: null,
    aniversariantesSemana: null,
    feriasVencendo30d: null,
    totalAtivas: null,
  });

  useEffect(() => {
    // Carrega resumo via endpoint dedicado (silenciosamente — não bloqueia UI)
    api<Resumo>('/rh/resumo')
      .then(setResumo)
      .catch(() => {
        // Sem endpoint ainda? Carrega só total de ativas via /sellers
        api<{ count: number }>('/sellers/count?active=true')
          .then((r) => setResumo((p) => ({ ...p, totalAtivas: r.count })))
          .catch(() => {});
      });
  }, []);

  return (
    <main className="min-h-screen bg-slate-50">
      {/* HEADER */}
      <div className="bg-gradient-to-r from-slate-700 to-slate-900 text-white py-6 px-4 sm:px-6 shadow-md">
        <div className="max-w-6xl mx-auto flex items-center gap-3">
          <Link href="/" className="p-2 rounded-lg hover:bg-white/10 transition">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="bg-white/15 p-2.5 rounded-xl">
            <Users className="w-7 h-7" strokeWidth={1.8} />
          </div>
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold leading-tight">Recursos Humanos</h1>
            <p className="text-[12px] text-white/80">
              Gestão de pessoas · Ponto · Comissão · Treinamento · Documentos
            </p>
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 space-y-6">
        {/* DASHBOARD — 4 cards de resumo */}
        <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <ResumoCard
            label="Funcionárias ativas"
            value={resumo.totalAtivas}
            icon={UserCheck}
            tone="emerald"
            href="/retaguarda/vendedoras"
          />
          <ResumoCard
            label="Ponto batido hoje"
            value={resumo.pontoBatidoHojePct !== null ? `${resumo.pontoBatidoHojePct}%` : null}
            icon={Fingerprint}
            tone="sky"
            href="/retaguarda/rh/espelho-ponto"
          />
          <ResumoCard
            label="Comissão pendente"
            value={resumo.comissaoPendenteMes !== null ? formatBRL(resumo.comissaoPendenteMes) : null}
            icon={DollarSign}
            tone="amber"
            href="/retaguarda/comissoes"
          />
          <ResumoCard
            label="Aniversariantes esta semana"
            value={resumo.aniversariantesSemana}
            icon={Cake}
            tone="rose"
            href="/retaguarda/vendedoras"
          />
        </section>

        {resumo.feriasVencendo30d !== null && resumo.feriasVencendo30d > 0 && (
          <div className="bg-amber-50 border-2 border-amber-300 rounded-xl px-4 py-3 flex items-center gap-3">
            <BadgeAlert className="w-5 h-5 text-amber-700 flex-shrink-0" />
            <div className="text-sm text-amber-900 font-bold">
              {resumo.feriasVencendo30d} {resumo.feriasVencendo30d === 1 ? 'funcionária com férias vencendo' : 'funcionárias com férias vencendo'} nos próximos 30 dias.{' '}
              <Link href="/retaguarda/vendedoras" className="underline">Ver</Link>
            </div>
          </div>
        )}

        {/* GRUPOS DE BOTÕES */}
        <Grupo titulo="CADASTRO" icon={Users}>
          <Botao href="/retaguarda/vendedoras"             icon={UserCheck}   label="Funcionárias"        sub="Lista + prontuário" />
          <Botao href="/retaguarda/vendedoras/nova"        icon={UserPlus}    label="Nova contratação"    sub="Cadastrar" />
          <Botao href="/retaguarda/vendedoras-ativas"      icon={Award}       label="Ativas no PDV"       sub="Whitelist atendimento" />
          <Botao href="/retaguarda/rh/operadores"          icon={KeyRound}    label="Função & PIN"        sub="Liberar desconto no PDV" />
        </Grupo>

        <Grupo titulo="PONTO ELETRÔNICO" icon={Clock}>
          <Botao href="/retaguarda/rh/espelho-ponto"       icon={ClipboardList} label="Espelho de ponto"   sub="Batidas do mês" />
          <Botao href="/retaguarda/rh/banco-horas"         icon={TrendingUp}    label="Banco de horas"     sub="Saldo + hora extra" />
          <Botao href="/retaguarda/rh/face-enroll"         icon={Fingerprint}   label="Face Enroll"        sub="Reconhecimento facial" />
        </Grupo>

        <Grupo titulo="COMISSÃO" icon={DollarSign}>
          <Botao href="/retaguarda/comissoes"              icon={DollarSign} label="Regras + Fechamento" sub="Mensal por vendedora" />
          <Botao href="/retaguarda/comissoes/cargos"       icon={Award}      label="Por cargo"           sub="Vendedora · Líder · Gerente" />
        </Grupo>

        <Grupo titulo="TREINAMENTO" icon={GraduationCap}>
          <Botao href="/retaguarda/treinamento"            icon={GraduationCap} label="Módulo PDV"        sub="Praticar sem gravar" />
        </Grupo>

        <Grupo titulo="RELATÓRIOS" icon={BarChart3}>
          <Botao href="/retaguarda/comissoes?aba=relatorio" icon={BarChart3} label="Comissão por loja"   sub="Agregado mensal" />
          <Botao href="/retaguarda/vendedoras"             icon={FileText}  label="Documentos"          sub="CPF · RG · contrato" />
          <Botao href="/retaguarda/vendedoras"             icon={Calendar}  label="Férias"              sub="Programadas + vencendo" />
        </Grupo>
      </div>
    </main>
  );
}

// ── Helpers visuais ──────────────────────────────────────────────────

function ResumoCard({
  label, value, icon: Icon, tone, href,
}: {
  label: string;
  value: number | string | null;
  icon: typeof Users;
  tone: 'emerald' | 'sky' | 'amber' | 'rose';
  href: string;
}) {
  const tones = {
    emerald: 'border-emerald-300 bg-emerald-50 text-emerald-800',
    sky:     'border-sky-300 bg-sky-50 text-sky-800',
    amber:   'border-amber-300 bg-amber-50 text-amber-800',
    rose:    'border-rose-300 bg-rose-50 text-rose-800',
  };
  return (
    <Link
      href={href}
      className={`block border-2 rounded-xl p-4 hover:shadow-md transition ${tones[tone]}`}
    >
      <div className="flex items-center justify-between mb-2">
        <Icon className="w-5 h-5 opacity-80" strokeWidth={1.8} />
        <span className="text-[10px] font-bold uppercase opacity-70">Hoje</span>
      </div>
      <div className="text-2xl font-black tabular-nums">
        {value === null ? <span className="text-slate-400">—</span> : value}
      </div>
      <div className="text-[11px] font-bold uppercase opacity-80 mt-1">{label}</div>
    </Link>
  );
}

function Grupo({
  titulo, icon: Icon, children,
}: {
  titulo: string;
  icon: typeof Users;
  children: React.ReactNode;
}) {
  return (
    <section className="bg-white border border-slate-200 rounded-2xl p-4 shadow-sm">
      <div className="flex items-center gap-2 mb-3 pb-2 border-b border-slate-100">
        <Icon className="w-4 h-4 text-slate-600" strokeWidth={2} />
        <h2 className="text-xs font-black tracking-wider uppercase text-slate-700">{titulo}</h2>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {children}
      </div>
    </section>
  );
}

function Botao({
  href, icon: Icon, label, sub,
}: {
  href: string;
  icon: typeof Users;
  label: string;
  sub: string;
}) {
  return (
    <Link
      href={href}
      className="flex items-center gap-3 px-4 py-3 border-2 border-slate-200 hover:border-slate-500 hover:bg-slate-50 rounded-xl transition group"
    >
      <div className="bg-slate-100 group-hover:bg-slate-200 p-2 rounded-lg transition">
        <Icon className="w-5 h-5 text-slate-700" strokeWidth={1.8} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="font-bold text-sm text-slate-800 leading-tight">{label}</div>
        <div className="text-[11px] text-slate-500">{sub}</div>
      </div>
    </Link>
  );
}

function formatBRL(value: number): string {
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 0, maximumFractionDigits: 0 });
}
