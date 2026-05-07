'use client';

/**
 * /minha-loja/pdv/fechamento — TELA DE FECHAMENTO DIÁRIO
 *
 * Mostra os totais por forma de pagamento da sessão de caixa atual,
 * estilo "Movimento Diário de Caixa" do Wincred. Diferença: tudo vem
 * do flowops em tempo real, sem depender de "Processa Movimento".
 *
 * Layout cobre:
 * - Cards principais: Dinheiro, PIX, Crediário
 * - Cartões Crédito (por bandeira): Mastercard, Visa, Cielo, Elo, Amex, Hipercard
 * - Cartões Débito (por bandeira): Visa Electron, Rede Shop
 * - Movimentações: Fundo, Sangrias, Suprimentos
 * - Total do Dia
 * - Botão Imprimir
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft, Printer, RefreshCw, Banknote, QrCode, CreditCard, User,
  TrendingUp, TrendingDown, Wallet, AlertCircle, CheckCircle2,
} from 'lucide-react';
import { api } from '@/lib/api';

interface RelatorioDetalhado {
  session: {
    id: string;
    storeCode: string;
    storeName: string;
    openedAt: string;
    openedByName?: string;
    fundoTroco: number;
  };
  totais: {
    DINHEIRO: number;
    PIX: number;
    CREDIARIO: number;
    MASTERCARD: number;
    VISANET: number;
    CIELO: number;
    ELO: number;
    AMEX: number;
    HIPERCARD: number;
    VISA_ELECTRON: number;
    REDE_SHOP: number;
    CREDITO_GENERICO: number;
    DEBITO_GENERICO: number;
    OUTROS: number;
  };
  resumo: {
    totalVendas: number;
    totalDinheiro: number;
    totalPix: number;
    totalCrediario: number;
    totalCartaoCredito: number;
    totalCartaoDebito: number;
    totalSangrias: number;
    totalSuprimentos: number;
    dinheiroEsperado: number;
    qtdVendas: number;
  };
  movimentos: Array<{
    id: string;
    tipo: string;
    valor: number;
    observacao?: string;
    createdAt: string;
  }>;
  generatedAt: string;
}

const brl = (n: number) =>
  Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export default function FechamentoPage() {
  const router = useRouter();
  const [data, setData] = useState<RelatorioDetalhado | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_token') : null;
    if (!token) {
      router.push('/login');
      return;
    }

    setLoading(true);
    setError(null);
    const storeCode = typeof window !== 'undefined'
      ? localStorage.getItem('lurds_pdv_store') || ''
      : '';
    const url = storeCode
      ? `/pdv/caixa/relatorio-detalhado?storeCode=${encodeURIComponent(storeCode)}`
      : '/pdv/caixa/relatorio-detalhado';

    api<RelatorioDetalhado>(url)
      .then((d) => setData(d))
      .catch((e: any) => setError(e?.message || 'Erro ao carregar relatório'))
      .finally(() => setLoading(false));
  }, [router, refreshKey]);

  const handlePrint = () => {
    window.print();
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-slate-400">
        Carregando…
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-slate-50 p-4">
        <div className="max-w-2xl mx-auto bg-white rounded-lg shadow p-6 mt-8 space-y-4">
          <Link href="/minha-loja/pdv" className="text-slate-500 text-sm flex items-center gap-1 mb-2">
            <ArrowLeft className="w-4 h-4" /> Voltar pro PDV
          </Link>
          <div className="flex items-start gap-2 bg-rose-50 border border-rose-200 text-rose-800 p-4 rounded-lg">
            <AlertCircle className="w-5 h-5 mt-0.5 shrink-0" />
            <div>
              <h2 className="font-semibold">Não foi possível carregar o fechamento</h2>
              <p className="text-sm mt-1">{error || 'Sem caixa aberto'}</p>
              <p className="text-xs text-rose-600 mt-2">
                Provavelmente não tem caixa aberto na loja. Abre o caixa pelo PDV antes de fechar.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const { session, totais, resumo, movimentos } = data;

  // Total geral pra footer
  const totalFormas =
    resumo.totalDinheiro + resumo.totalPix + resumo.totalCrediario +
    resumo.totalCartaoCredito + resumo.totalCartaoDebito;

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 print:hidden sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link href="/minha-loja/pdv" className="text-slate-500 hover:text-slate-900">
            <ArrowLeft size={20} />
          </Link>
          <Wallet className="text-violet-600" size={22} />
          <div className="flex-1">
            <h1 className="text-lg font-semibold text-slate-900">Fechamento Diário</h1>
            <p className="text-xs text-slate-500">
              Loja {session.storeCode} — {session.storeName} · Caixa aberto em{' '}
              {new Date(session.openedAt).toLocaleString('pt-BR')}
              {session.openedByName ? ` por ${session.openedByName}` : ''}
            </p>
          </div>
          <button
            onClick={() => setRefreshKey((k) => k + 1)}
            className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 rounded-lg text-sm flex items-center gap-1.5"
          >
            <RefreshCw size={14} /> Atualizar
          </button>
          <button
            onClick={handlePrint}
            className="px-3 py-1.5 bg-violet-600 hover:bg-violet-700 text-white rounded-lg text-sm flex items-center gap-1.5"
          >
            <Printer size={14} /> Imprimir
          </button>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-4 space-y-4 print:max-w-full print:p-2">
        {/* Print header (só aparece na impressão) */}
        <div className="hidden print:block mb-4">
          <h1 className="text-2xl font-bold text-center">FECHAMENTO DIÁRIO DE CAIXA</h1>
          <p className="text-center text-sm">
            Loja {session.storeCode} — {session.storeName}
          </p>
          <p className="text-center text-xs">
            Caixa aberto em {new Date(session.openedAt).toLocaleString('pt-BR')}
            {session.openedByName ? ` por ${session.openedByName}` : ''}
          </p>
        </div>

        {/* Resumo top */}
        <section className="grid grid-cols-2 md:grid-cols-4 gap-3 print:grid-cols-4">
          <ResumoCard
            label="TOTAL DE VENDAS"
            valor={resumo.totalVendas}
            qtd={resumo.qtdVendas}
            tone="violet"
            big
          />
          <ResumoCard label="FUNDO INICIAL" valor={session.fundoTroco} tone="slate" />
          <ResumoCard label="SANGRIAS" valor={resumo.totalSangrias} tone="rose" prefix="−" />
          <ResumoCard label="SUPRIMENTOS" valor={resumo.totalSuprimentos} tone="emerald" prefix="+" />
        </section>

        {/* Bloco: Pagamentos diretos */}
        <Card title="Pagamentos Diretos" icon={<Banknote size={18} className="text-emerald-600" />}>
          <Linha label="Dinheiro" valor={totais.DINHEIRO} icon={<Banknote size={16} />} />
          <Linha label="PIX" valor={totais.PIX} icon={<QrCode size={16} />} />
          <Linha label="Crediário" valor={totais.CREDIARIO} icon={<User size={16} />} />
        </Card>

        {/* Bloco: Cartões CRÉDITO */}
        <Card
          title="Cartões Crédito"
          icon={<CreditCard size={18} className="text-blue-600" />}
          subtotal={resumo.totalCartaoCredito}
        >
          <Linha label="Mastercard" valor={totais.MASTERCARD} />
          <Linha label="Visa (Visanet)" valor={totais.VISANET} />
          <Linha label="Cielo" valor={totais.CIELO} />
          <Linha label="Elo" valor={totais.ELO} />
          <Linha label="American Express" valor={totais.AMEX} />
          <Linha label="Hipercard" valor={totais.HIPERCARD} />
          {totais.CREDITO_GENERICO > 0 && (
            <Linha
              label="Crédito (sem bandeira)"
              valor={totais.CREDITO_GENERICO}
              warning="bandeira não identificada"
            />
          )}
        </Card>

        {/* Bloco: Cartões DÉBITO */}
        <Card
          title="Cartões Débito"
          icon={<CreditCard size={18} className="text-cyan-600" />}
          subtotal={resumo.totalCartaoDebito}
        >
          <Linha label="Visa Electron" valor={totais.VISA_ELECTRON} />
          <Linha label="Rede Shop" valor={totais.REDE_SHOP} />
          {totais.DEBITO_GENERICO > 0 && (
            <Linha
              label="Débito (sem bandeira)"
              valor={totais.DEBITO_GENERICO}
              warning="bandeira não identificada"
            />
          )}
        </Card>

        {/* Outros */}
        {totais.OUTROS > 0 && (
          <Card title="Outras Formas" icon={<AlertCircle size={18} className="text-amber-600" />}>
            <Linha label="Outros" valor={totais.OUTROS} />
          </Card>
        )}

        {/* Movimentações */}
        {movimentos && movimentos.length > 0 && (
          <Card
            title={`Movimentações de Caixa (${movimentos.length})`}
            icon={<TrendingUp size={18} className="text-amber-600" />}
          >
            <div className="text-xs space-y-1">
              {movimentos.map((m) => (
                <div
                  key={m.id}
                  className="flex items-center justify-between py-1 border-b border-slate-100 last:border-0"
                >
                  <div className="flex items-center gap-2">
                    {m.tipo === 'sangria' ? (
                      <TrendingDown size={14} className="text-rose-600" />
                    ) : (
                      <TrendingUp size={14} className="text-emerald-600" />
                    )}
                    <span className="font-medium uppercase">{m.tipo}</span>
                    {m.observacao && (
                      <span className="text-slate-500 text-[11px]">— {m.observacao}</span>
                    )}
                    <span className="text-[11px] text-slate-400 ml-auto">
                      {new Date(m.createdAt).toLocaleTimeString('pt-BR')}
                    </span>
                  </div>
                  <span
                    className={`font-mono font-semibold ${
                      m.tipo === 'sangria' ? 'text-rose-700' : 'text-emerald-700'
                    }`}
                  >
                    {m.tipo === 'sangria' ? '−' : '+'}
                    {brl(m.valor)}
                  </span>
                </div>
              ))}
            </div>
          </Card>
        )}

        {/* Conferência de caixa */}
        <Card
          title="Conferência do Caixa"
          icon={<CheckCircle2 size={18} className="text-emerald-600" />}
        >
          <Linha
            label="Fundo Inicial"
            valor={session.fundoTroco}
            italic
          />
          <Linha label="(+) Vendas em Dinheiro" valor={totais.DINHEIRO} italic />
          <Linha label="(+) Suprimentos" valor={resumo.totalSuprimentos} italic />
          <Linha
            label="(−) Sangrias"
            valor={resumo.totalSangrias}
            italic
            prefix="−"
          />
          <Linha
            label="DINHEIRO ESPERADO EM CAIXA"
            valor={resumo.dinheiroEsperado}
            destaque
          />
        </Card>

        {/* TOTAL DO DIA — destaque grande */}
        <div className="bg-gradient-to-r from-violet-600 to-fuchsia-600 text-white p-6 rounded-xl shadow-lg print:bg-violet-700 print:text-white">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-widest opacity-80">Total do Dia</p>
              <p className="text-3xl font-bold">{brl(totalFormas)}</p>
              <p className="text-xs opacity-80 mt-1">
                {resumo.qtdVendas} venda(s) finalizada(s)
              </p>
            </div>
            <Wallet className="w-12 h-12 opacity-50" />
          </div>
        </div>

        <p className="text-[10px] text-slate-400 text-center pt-2">
          Gerado em {new Date(data.generatedAt).toLocaleString('pt-BR')} · flowops PDV
        </p>
      </main>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// Componentes auxiliares
// ════════════════════════════════════════════════════════════════════════

interface ResumoCardProps {
  label: string;
  valor: number;
  qtd?: number;
  tone: 'violet' | 'slate' | 'rose' | 'emerald';
  big?: boolean;
  prefix?: string;
}
function ResumoCard({ label, valor, qtd, tone, big, prefix }: ResumoCardProps) {
  const tones = {
    violet: 'bg-violet-50 border-violet-200 text-violet-900',
    slate: 'bg-slate-50 border-slate-200 text-slate-900',
    rose: 'bg-rose-50 border-rose-200 text-rose-900',
    emerald: 'bg-emerald-50 border-emerald-200 text-emerald-900',
  };
  return (
    <div className={`border rounded-lg p-3 ${tones[tone]}`}>
      <p className="text-[10px] uppercase font-semibold tracking-wider opacity-70">{label}</p>
      <p className={`font-bold tabular-nums ${big ? 'text-2xl' : 'text-lg'}`}>
        {prefix || ''}
        {brl(valor)}
      </p>
      {qtd !== undefined && (
        <p className="text-[10px] opacity-70 mt-0.5">{qtd} venda(s)</p>
      )}
    </div>
  );
}

interface CardProps {
  title: string;
  icon: React.ReactNode;
  subtotal?: number;
  children: React.ReactNode;
}
function Card({ title, icon, subtotal, children }: CardProps) {
  return (
    <section className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden print:shadow-none print:border-2">
      <header className="px-4 py-2.5 border-b border-slate-100 flex items-center gap-2 bg-slate-50">
        {icon}
        <h2 className="font-semibold text-slate-900 flex-1">{title}</h2>
        {subtotal !== undefined && (
          <span className="text-sm font-bold text-slate-700 tabular-nums">{brl(subtotal)}</span>
        )}
      </header>
      <div className="p-3 space-y-1">{children}</div>
    </section>
  );
}

interface LinhaProps {
  label: string;
  valor: number;
  icon?: React.ReactNode;
  prefix?: string;
  italic?: boolean;
  destaque?: boolean;
  warning?: string;
}
function Linha({ label, valor, icon, prefix, italic, destaque, warning }: LinhaProps) {
  if (valor === 0 && !destaque && !warning) {
    // Linha zerada renderiza apagado
    return (
      <div className="flex items-center justify-between py-1 text-slate-400 text-sm">
        <div className="flex items-center gap-2">
          {icon}
          <span className={italic ? 'italic' : ''}>{label}</span>
        </div>
        <span className="tabular-nums">−</span>
      </div>
    );
  }
  return (
    <div
      className={`flex items-center justify-between py-1.5 ${
        destaque ? 'border-t-2 border-slate-300 pt-2 mt-1 font-bold text-slate-900' : 'text-sm text-slate-700'
      }`}
    >
      <div className="flex items-center gap-2">
        {icon}
        <span className={italic ? 'italic text-slate-500' : ''}>{label}</span>
        {warning && (
          <span className="text-[10px] text-amber-600 italic">({warning})</span>
        )}
      </div>
      <span className="tabular-nums font-mono">
        {prefix || ''}
        {brl(valor)}
      </span>
    </div>
  );
}
