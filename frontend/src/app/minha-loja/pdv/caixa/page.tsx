'use client';

/**
 * /minha-loja/pdv/caixa
 *
 * Abertura, sangria, suprimento e fechamento de caixa.
 *
 * Estados visíveis:
 *  - Sem caixa aberto → tela de abertura (input fundo de troco)
 *  - Com caixa aberto → painel com KPIs + ações (sangria/suprimento/relatório X/fechar)
 */

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { ArrowLeft, DollarSign, TrendingDown, TrendingUp, FileText, X, Lock, Clock, Store as StoreIcon } from 'lucide-react';
import { api } from '@/lib/api';

type StoreOpt = { code: string; name: string; active?: boolean };

type Movement = {
  id: string;
  tipo: 'sangria' | 'suprimento';
  valor: number;
  motivo: string;
  userName?: string;
  createdAt: string;
};

type Totals = {
  totalVendas: number;
  totalDinheiro: number;
  totalPix: number;
  totalCartaoCredito: number;
  totalCartaoDebito: number;
  totalCrediario: number;
  totalSangrias: number;
  totalSuprimentos: number;
  dinheiroEsperado: number;
  qtdVendas: number;
};

type Session = {
  id: string;
  storeCode: string;
  storeName: string;
  status: 'open' | 'closed';
  fundoTroco: number;
  openedAt: string;
  openedByName?: string;
  closedAt?: string;
};

// Slot de cada forma — tem total + qtd + lista de vendas detalhadas
type Slot = {
  valor: number;
  qtd: number;
  vendas: Array<{
    saleId: string;
    saleTotal: number;
    paymentId: string;
    method: string;
    bandeira?: string | null;
    valor: number;
    customerName: string | null;
    customerCpf: string | null;
    sellerName: string | null;
    finalizedAt: string | null;
    parcelas?: number;
    items?: Array<{
      parcelaNum: number | null;
      totalParcelas: number | null;
      vencimento: string;
      valorPago: number;
      jurosCalculado: number;
    }>;
  }>;
};

type RelatorioDetalhado = {
  totais: {
    DINHEIRO: Slot; PIX: Slot; CREDIARIO: Slot;
    MASTERCARD: Slot; VISANET: Slot; CIELO: Slot; ELO: Slot; AMEX: Slot; HIPERCARD: Slot;
    VISA_ELECTRON: Slot; REDE_SHOP: Slot;
    CREDITO_GENERICO: Slot; DEBITO_GENERICO: Slot; OUTROS: Slot;
  };
  recebimentosCrediario: {
    dinheiro: Slot;
    pix: Slot;
    total: number;
    qtdTotal: number;
  };
  resumo: Totals & {
    totalRecebimentosDinheiro: number;
    totalRecebimentosPix: number;
    qtdRecebimentosDinheiro: number;
    qtdRecebimentosPix: number;
    dinheiroEsperadoSoVendas: number;
    qtdDinheiro: number;
    qtdPix: number;
    qtdCrediario: number;
    qtdCartaoCredito: number;
    qtdCartaoDebito: number;
  };
};

const fmt = (n: number) =>
  n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

type EditPaymentTarget = {
  paymentId: string;
  saleId: string;
  method: string;
  bandeira?: string | null;
  valor: number;
  customerName: string | null;
} | null;

export default function CaixaPage() {
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [movements, setMovements] = useState<Movement[]>([]);
  const [detalhado, setDetalhado] = useState<RelatorioDetalhado | null>(null);

  // Loja contexto — admin pode trocar; vendedora vem travada do JWT
  const [stores, setStores] = useState<StoreOpt[]>([]);
  const [storeCode, setStoreCode] = useState<string>('');
  const [isAdmin, setIsAdmin] = useState(false);

  // Modais
  const [showAbrir, setShowAbrir] = useState(false);
  const [showSangria, setShowSangria] = useState(false);
  const [showSuprimento, setShowSuprimento] = useState(false);
  const [showFechar, setShowFechar] = useState(false);

  /**
   * Bootstrap: descobre se é admin (precisa escolher loja) ou vendedora
   * (já tem storeCode no JWT). Reaproveita 'lurds_pdv_store' do PDV pra
   * lembrar última loja escolhida quando admin.
   */
  useEffect(() => {
    (async () => {
      try {
        const me = await api<{ role: string; storeCode?: string }>('/auth/me');
        if (me.role === 'admin') {
          setIsAdmin(true);
          const all = await api<StoreOpt[]>('/stores');
          const ativas = all.filter((s) => s.active !== false);
          setStores(ativas);
          const saved = typeof window !== 'undefined' ? localStorage.getItem('lurds_pdv_store') : null;
          if (saved && ativas.some((s) => s.code === saved)) {
            setStoreCode(saved);
          } else if (ativas[0]) {
            setStoreCode(ativas[0].code);
          }
        } else {
          // Vendedora: storeCode vem do JWT, backend resolve automático
          setStoreCode(me.storeCode || '');
        }
      } catch (e) {
        console.error('auth/me falhou', e);
      }
    })();
  }, []);

  // Salva escolha do admin
  useEffect(() => {
    if (isAdmin && storeCode && typeof window !== 'undefined') {
      localStorage.setItem('lurds_pdv_store', storeCode);
    }
  }, [isAdmin, storeCode]);

  // Adiciona ?storeCode=XX nas chamadas quando admin (vendedora não precisa)
  const qs = isAdmin && storeCode ? `?storeCode=${encodeURIComponent(storeCode)}` : '';

  const reload = useCallback(async () => {
    if (isAdmin && !storeCode) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const data = await api<{
        open: boolean;
        session: Session | null;
        totals?: Totals;
      }>(`/pdv/caixa/atual${qs}`);
      setOpen(data.open);
      setSession(data.session);
      setTotals(data.totals || null);
      if (data.open) {
        const movs = await api<Movement[]>(`/pdv/caixa/movimentos${qs}`);
        setMovements(movs);
        try {
          const det = await api<RelatorioDetalhado>(`/pdv/caixa/relatorio-detalhado${qs}`);
          setDetalhado(det);
        } catch (err) {
          console.error('Falha ao buscar relatorio-detalhado', err);
          setDetalhado(null);
        }
      } else {
        setMovements([]);
        setDetalhado(null);
      }
    } catch (e) {
      console.error('Falha ao ler caixa', e);
    } finally {
      setLoading(false);
    }
  }, [qs, isAdmin, storeCode]);

  useEffect(() => {
    reload();
  }, [reload]);

  if (loading) {
    return (
      <div className="min-h-screen bg-[#f4f1ec] p-6 flex items-center justify-center">
        <div className="text-rose-700">Carregando caixa…</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#f4f1ec] p-4 md:p-6">
      <div className="max-w-4xl mx-auto">
        <Link
          href="/minha-loja/pdv"
          className="inline-flex items-center gap-2 text-rose-700 hover:text-rose-900 mb-4"
        >
          <ArrowLeft size={18} /> Voltar pro PDV
        </Link>

        <h1 className="text-2xl md:text-3xl font-bold text-rose-900 mb-3">
          Caixa do dia
        </h1>

        {/* SELETOR DE LOJA — só pra admin */}
        {isAdmin && stores.length > 0 && (
          <div className="bg-white rounded-2xl shadow-sm p-4 mb-4 flex items-center gap-3">
            <StoreIcon className="w-5 h-5 text-rose-600 shrink-0" />
            <div className="flex-1">
              <label className="block text-[11px] font-bold text-rose-700 uppercase tracking-wide mb-1">
                Operando como (admin)
              </label>
              <select
                value={storeCode}
                onChange={(e) => setStoreCode(e.target.value)}
                className="w-full p-2 border-2 border-rose-200 rounded-lg font-semibold text-rose-900 focus:border-rose-400 focus:outline-none"
              >
                {stores.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.code} — {s.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

        {!storeCode ? (
          <div className="bg-white rounded-2xl shadow-sm p-12 text-center">
            <p className="text-rose-700">Selecione uma loja acima.</p>
          </div>
        ) : !open ? (
          <NoCashOpenCard onOpen={() => setShowAbrir(true)} storeName={isAdmin ? stores.find((s) => s.code === storeCode)?.name || storeCode : undefined} />
        ) : (
          <OpenCashPanel
            session={session!}
            totals={totals}
            detalhado={detalhado}
            movements={movements}
            onSangria={() => setShowSangria(true)}
            onSuprimento={() => setShowSuprimento(true)}
            onFechar={() => setShowFechar(true)}
          />
        )}
      </div>

      {showAbrir && (
        <AbrirModal
          storeCode={isAdmin ? storeCode : undefined}
          onClose={() => setShowAbrir(false)}
          onSuccess={() => {
            setShowAbrir(false);
            reload();
          }}
        />
      )}
      {showSangria && (
        <MovModal
          tipo="sangria"
          storeCode={isAdmin ? storeCode : undefined}
          onClose={() => setShowSangria(false)}
          onSuccess={() => {
            setShowSangria(false);
            reload();
          }}
        />
      )}
      {showSuprimento && (
        <MovModal
          tipo="suprimento"
          storeCode={isAdmin ? storeCode : undefined}
          onClose={() => setShowSuprimento(false)}
          onSuccess={() => {
            setShowSuprimento(false);
            reload();
          }}
        />
      )}
      {showFechar && totals && (
        <FecharModal
          totals={totals}
          fundoTroco={session!.fundoTroco}
          storeCode={isAdmin ? storeCode : undefined}
          onClose={() => setShowFechar(false)}
          onSuccess={() => {
            setShowFechar(false);
            reload();
          }}
        />
      )}
    </div>
  );
}

function NoCashOpenCard({ onOpen, storeName }: { onOpen: () => void; storeName?: string }) {
  return (
    <div className="bg-white rounded-2xl shadow-md p-8 text-center">
      <div className="w-20 h-20 mx-auto bg-rose-100 rounded-full flex items-center justify-center mb-4">
        <Lock size={36} className="text-rose-600" />
      </div>
      <h2 className="text-xl font-bold text-rose-900 mb-2">
        Caixa fechado{storeName ? ` — ${storeName}` : ''}
      </h2>
      <p className="text-gray-600 mb-6">
        Abra o caixa antes de começar a vender.
        <br />
        Você precisa informar o fundo de troco inicial.
      </p>
      <button
        onClick={onOpen}
        className="bg-rose-600 hover:bg-rose-700 text-white px-8 py-3 rounded-xl font-semibold"
      >
        Abrir Caixa
      </button>
    </div>
  );
}

function OpenCashPanel({
  session,
  totals,
  detalhado,
  movements,
  onSangria,
  onSuprimento,
  onFechar,
}: {
  session: Session;
  totals: Totals | null;
  detalhado: RelatorioDetalhado | null;
  movements: Movement[];
  onSangria: () => void;
  onSuprimento: () => void;
  onFechar: () => void;
}) {
  const [editTarget, setEditTarget] = useState<EditPaymentTarget>(null);
  return (
    <div className="space-y-6">
      <div className="bg-gradient-to-br from-rose-100 to-pink-50 rounded-2xl p-6 shadow-md">
        <div className="flex items-center justify-between mb-2">
          <div className="text-sm text-rose-700">
            <Clock size={14} className="inline mr-1" />
            Aberto em {new Date(session.openedAt).toLocaleString('pt-BR')}
          </div>
          {session.openedByName && (
            <div className="text-sm text-rose-700">por {session.openedByName}</div>
          )}
        </div>
        <div className="text-sm text-rose-600">Fundo de troco</div>
        <div className="text-3xl font-bold text-rose-900">R$ {fmt(session.fundoTroco)}</div>
      </div>

      {totals && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <KpiCard label="Vendas" value={totals.totalVendas} sub={`${totals.qtdVendas} cupons`} />
            <KpiCard label="Sangrias" value={totals.totalSangrias} negative />
            <KpiCard label="Suprimentos" value={totals.totalSuprimentos} />
            <KpiCard
              label="Recebimentos crediário"
              value={(detalhado?.recebimentosCrediario.total) || 0}
              sub={`${detalhado?.recebimentosCrediario.qtdTotal || 0} baixa(s)`}
            />
          </div>
          {detalhado ? (
            <DetalhesCaixa
              detalhado={detalhado}
              onEditPayment={(v) => setEditTarget({
                paymentId: v.paymentId,
                saleId: v.saleId,
                method: v.method,
                bandeira: v.bandeira,
                valor: v.valor,
                customerName: v.customerName,
              })}
            />
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <KpiCard label="Dinheiro" value={totals.totalDinheiro} highlight />
              <KpiCard label="Pix" value={totals.totalPix} />
              <KpiCard label="Cartão Crédito" value={totals.totalCartaoCredito} />
              <KpiCard label="Cartão Débito" value={totals.totalCartaoDebito} />
              <KpiCard label="Crediário" value={totals.totalCrediario} />
            </div>
          )}
        </>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <button
          onClick={onSangria}
          className="bg-amber-100 hover:bg-amber-200 text-amber-900 p-4 rounded-xl font-semibold flex items-center justify-center gap-2"
        >
          <TrendingDown size={20} /> Sangria
        </button>
        <button
          onClick={onSuprimento}
          className="bg-emerald-100 hover:bg-emerald-200 text-emerald-900 p-4 rounded-xl font-semibold flex items-center justify-center gap-2"
        >
          <TrendingUp size={20} /> Suprimento
        </button>
        <button
          onClick={onFechar}
          className="bg-rose-600 hover:bg-rose-700 text-white p-4 rounded-xl font-semibold flex items-center justify-center gap-2"
        >
          <Lock size={20} /> Fechar Caixa
        </button>
      </div>

      {totals && (
        <div className="bg-white rounded-2xl shadow-md p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-bold text-rose-900">Dinheiro esperado em caixa</h3>
            <FileText size={16} className="text-rose-600" />
          </div>
          <div className="space-y-1 text-sm font-mono">
            <div className="flex justify-between">
              <span>Fundo de troco</span>
              <span>R$ {fmt(session.fundoTroco)}</span>
            </div>
            <div className="flex justify-between">
              <span>+ Vendas em dinheiro</span>
              <span>R$ {fmt(totals.totalDinheiro)}</span>
            </div>
            <div className="flex justify-between">
              <span>+ Suprimentos</span>
              <span>R$ {fmt(totals.totalSuprimentos)}</span>
            </div>
            <div className="flex justify-between text-amber-700">
              <span>− Sangrias</span>
              <span>R$ {fmt(totals.totalSangrias)}</span>
            </div>
            <div className="border-t border-rose-200 mt-2 pt-2 flex justify-between font-bold text-rose-900 text-base">
              <span>Esperado</span>
              <span>R$ {fmt(totals.dinheiroEsperado)}</span>
            </div>
          </div>
        </div>
      )}

      {movements.length > 0 && (
        <div className="bg-white rounded-2xl shadow-md p-5">
          <h3 className="font-bold text-rose-900 mb-3">Movimentações</h3>
          <div className="space-y-2">
            {movements.map((m) => (
              <div
                key={m.id}
                className="flex items-center justify-between bg-rose-50 rounded-lg p-3"
              >
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span
                      className={`text-xs font-semibold px-2 py-0.5 rounded ${
                        m.tipo === 'sangria'
                          ? 'bg-amber-100 text-amber-800'
                          : 'bg-emerald-100 text-emerald-800'
                      }`}
                    >
                      {m.tipo === 'sangria' ? 'SANGRIA' : 'SUPRIMENTO'}
                    </span>
                    <span className="text-sm text-gray-700">{m.motivo}</span>
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    {new Date(m.createdAt).toLocaleString('pt-BR')}
                    {m.userName ? ` · ${m.userName}` : ''}
                  </div>
                </div>
                <div
                  className={`font-bold ${
                    m.tipo === 'sangria' ? 'text-amber-700' : 'text-emerald-700'
                  }`}
                >
                  {m.tipo === 'sangria' ? '−' : '+'} R$ {fmt(m.valor)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    {editTarget && (
      <AjustePagamentoModal
        target={editTarget}
        onClose={() => setEditTarget(null)}
        onSaved={() => { setEditTarget(null); window.location.reload(); }}
      />
    )}
        </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// DetalhesCaixa — exibição com cascata por modalidade + recebimentos
// ════════════════════════════════════════════════════════════════════════

function DetalhesCaixa({ detalhado, onEditPayment }: { detalhado: RelatorioDetalhado; onEditPayment?: (v: Slot['vendas'][0]) => void }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toggle = (key: string) =>
    setExpanded((e) => ({ ...e, [key]: !e[key] }));

  const t = detalhado.totais;
  const rec = detalhado.recebimentosCrediario;
  const r = detalhado.resumo;

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-bold text-rose-900 mt-4">Detalhamento por modalidade</h3>

      {/* DINHEIRO */}
      <ModalidadeCard
        titulo="Dinheiro"
        valor={t.DINHEIRO.valor}
        qtd={t.DINHEIRO.qtd}
        cor="emerald"
        expanded={!!expanded.dinheiro}
        onToggle={() => toggle('dinheiro')}
        vendas={t.DINHEIRO.vendas}
      
        onEditPayment={onEditPayment}
      />

      {/* PIX */}
      <ModalidadeCard
        titulo="Pix"
        valor={t.PIX.valor}
        qtd={t.PIX.qtd}
        cor="cyan"
        expanded={!!expanded.pix}
        onToggle={() => toggle('pix')}
        vendas={t.PIX.vendas}
      
        onEditPayment={onEditPayment}
      />

      {/* CREDIÁRIO (vendas novas) */}
      <ModalidadeCard
        titulo="Crediário"
        valor={t.CREDIARIO.valor}
        qtd={t.CREDIARIO.qtd}
        cor="rose"
        expanded={!!expanded.crediario}
        onToggle={() => toggle('crediario')}
        vendas={t.CREDIARIO.vendas}
      
        onEditPayment={onEditPayment}
      />

      {/* CARTÃO CRÉDITO — com cascata por bandeira */}
      <ModalidadeCard
        titulo="Cartão Crédito"
        valor={r.totalCartaoCredito}
        qtd={r.qtdCartaoCredito}
        cor="blue"
        expanded={!!expanded.credito}
        onToggle={() => toggle('credito')}
        bandeiras={[
          { nome: 'Mastercard', slot: t.MASTERCARD },
          { nome: 'Visa (Visanet)', slot: t.VISANET },
          { nome: 'Cielo', slot: t.CIELO },
          { nome: 'Elo', slot: t.ELO },
          { nome: 'American Express', slot: t.AMEX },
          { nome: 'Hipercard', slot: t.HIPERCARD },
          { nome: 'Sem bandeira', slot: t.CREDITO_GENERICO },
        ].filter((b) => b.slot.qtd > 0)}
      
        onEditPayment={onEditPayment}
      />

      {/* CARTÃO DÉBITO */}
      <ModalidadeCard
        titulo="Cartão Débito"
        valor={r.totalCartaoDebito}
        qtd={r.qtdCartaoDebito}
        cor="indigo"
        expanded={!!expanded.debito}
        onToggle={() => toggle('debito')}
        bandeiras={[
          { nome: 'Visa Electron', slot: t.VISA_ELECTRON },
          { nome: 'Rede Shop', slot: t.REDE_SHOP },
          { nome: 'Sem bandeira', slot: t.DEBITO_GENERICO },
        ].filter((b) => b.slot.qtd > 0)}
      
        onEditPayment={onEditPayment}
      />

      {/* RECEBIMENTOS DE CREDIÁRIO — separado das vendas! */}
      {rec.qtdTotal > 0 && (
        <div className="bg-amber-50 border-2 border-amber-300 rounded-xl p-3 mt-2">
          <div className="text-[11px] uppercase font-bold tracking-widest text-amber-800 mb-1">
            ⚠ Recebimentos de Crediário (não são venda do dia)
          </div>
          <div className="text-xs text-amber-700 mb-2">
            Pagamentos de parcelas antigas. Entram no caixa físico mas NÃO contam como venda.
          </div>
          <div className="grid grid-cols-2 gap-2">
            <ModalidadeCard
              titulo="Em Dinheiro"
              valor={rec.dinheiro.valor}
              qtd={rec.dinheiro.qtd}
              cor="emerald"
              expanded={!!expanded.recDinheiro}
              onToggle={() => toggle('recDinheiro')}
              vendas={rec.dinheiro.vendas}
              compact
            
        onEditPayment={onEditPayment}
      />
            <ModalidadeCard
              titulo="Em PIX"
              valor={rec.pix.valor}
              qtd={rec.pix.qtd}
              cor="cyan"
              expanded={!!expanded.recPix}
              onToggle={() => toggle('recPix')}
              vendas={rec.pix.vendas}
              compact
            
        onEditPayment={onEditPayment}
      />
          </div>
        </div>
      )}
    </div>
  );
}

function ModalidadeCard({
  titulo,
  valor,
  qtd,
  cor,
  expanded,
  onToggle,
  vendas,
  bandeiras,
  compact,
  onEditPayment,
}: {
  titulo: string;
  valor: number;
  qtd: number;
  cor: 'emerald' | 'cyan' | 'rose' | 'blue' | 'indigo';
  expanded: boolean;
  onToggle: () => void;
  vendas?: Slot['vendas'];
  bandeiras?: Array<{ nome: string; slot: Slot }>;
  compact?: boolean;
  onEditPayment?: (v: Slot['vendas'][0]) => void;
}) {
  const tonesActive = {
    emerald: 'bg-gradient-to-br from-emerald-50 to-emerald-100 border-emerald-300 hover:border-emerald-400 hover:shadow-md',
    cyan: 'bg-gradient-to-br from-cyan-50 to-cyan-100 border-cyan-300 hover:border-cyan-400 hover:shadow-md',
    rose: 'bg-gradient-to-br from-rose-50 to-rose-100 border-rose-300 hover:border-rose-400 hover:shadow-md',
    blue: 'bg-gradient-to-br from-blue-50 to-blue-100 border-blue-300 hover:border-blue-400 hover:shadow-md',
    indigo: 'bg-gradient-to-br from-indigo-50 to-indigo-100 border-indigo-300 hover:border-indigo-400 hover:shadow-md',
  };
  const labelColor = {
    emerald: 'text-emerald-700', cyan: 'text-cyan-700', rose: 'text-rose-700',
    blue: 'text-blue-700', indigo: 'text-indigo-700',
  };
  const valueColor = {
    emerald: 'text-emerald-900', cyan: 'text-cyan-900', rose: 'text-rose-900',
    blue: 'text-blue-900', indigo: 'text-indigo-900',
  };
  const hasContent = qtd > 0;
  const tone = hasContent ? tonesActive[cor] : 'bg-slate-50 border-slate-200 border-dashed';
  return (
    <div className={`rounded-xl border-2 transition-all duration-200 ${tone} ${hasContent ? 'cursor-pointer' : ''}`}>
      <button
        onClick={onToggle}
        disabled={!hasContent}
        className="w-full flex items-center justify-between p-3 disabled:cursor-default text-left group"
      >
        <div className="flex-1 min-w-0">
          <div className={`font-medium uppercase tracking-wider ${
            hasContent ? labelColor[cor] : 'text-slate-400'
          } ${compact ? 'text-[9px]' : 'text-[10px]'}`}>
            {titulo}
          </div>
          <div className={`font-extrabold tabular-nums leading-tight mt-0.5 ${
            hasContent ? valueColor[cor] : 'text-slate-300'
          } ${compact ? 'text-lg' : 'text-2xl'}`}>
            R$ {fmt(valor)}
          </div>
          {hasContent ? (
            <div className="text-[10px] text-slate-500 mt-1 font-medium">
              {qtd} {qtd === 1 ? 'ticket' : 'tickets'}
            </div>
          ) : (
            <div className="text-[10px] text-slate-300 mt-1 italic">sem movimento</div>
          )}
        </div>
        {hasContent && (
          <div className={`shrink-0 ml-2 w-6 h-6 rounded-full flex items-center justify-center transition-transform duration-300 ${
            expanded ? 'rotate-180' : ''
          } bg-white/60 group-hover:bg-white text-slate-600`}>
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </div>
        )}
      </button>
      {hasContent && (
        <div
          className={`grid transition-all duration-300 ease-in-out ${
            expanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
          }`}
        >
          <div className="overflow-hidden">
            <div className="border-t border-current border-opacity-20 px-3 py-2 bg-white/50">
              {bandeiras && bandeiras.length > 0 && (
                <div className="space-y-1.5 mb-2">
                  {bandeiras.map((b) => (
                    <BandeiraRow key={b.nome} nome={b.nome} slot={b.slot} />
                  ))}
                </div>
              )}
              {vendas && vendas.length > 0 && (
                <div className="space-y-1 mt-1">
                  {vendas.map((v, i) => (
                    <VendaRow key={i} v={v} />
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function BandeiraRow({ nome, slot, onEditPayment }: { nome: string; slot: Slot; onEditPayment?: (v: Slot['vendas'][0]) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="bg-white rounded-md border border-slate-200 hover:border-slate-300 transition-colors overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between p-2 text-sm hover:bg-slate-50 group"
      >
        <span className="font-semibold text-slate-700">{nome}</span>
        <div className="flex items-center gap-3">
          <span className="text-xs text-slate-500 font-medium">{slot.qtd} {slot.qtd === 1 ? 'tk' : 'tks'}</span>
          <span className="font-mono font-bold tabular-nums text-slate-800">R$ {fmt(slot.valor)}</span>
          <div className={`w-5 h-5 rounded-full flex items-center justify-center transition-transform duration-300 ${
            open ? 'rotate-180' : ''
          } bg-slate-100 group-hover:bg-slate-200`}>
            <svg className="w-2.5 h-2.5 text-slate-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </div>
        </div>
      </button>
      <div
        className={`grid transition-all duration-300 ease-in-out ${
          open && slot.vendas.length > 0 ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
        }`}
      >
        <div className="overflow-hidden">
          <div className="border-t px-2 py-1.5 space-y-1 bg-slate-50">
            {slot.vendas.map((v, i) => (
              <VendaRow key={i} v={v} onEdit={onEditPayment} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function VendaRow({ v, onEdit }: { v: Slot['vendas'][0]; onEdit?: (v: Slot['vendas'][0]) => void }) {
  const [expanded, setExpanded] = useState(false);
  const hora = v.finalizedAt ? new Date(v.finalizedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '';
  const cliente = v.customerName || (v.customerCpf ? `CPF ${v.customerCpf}` : 'Sem identificação');
  // Tem múltiplas parcelas detalhadas? (caso de recebimento crediário com 3 parcelas juntas)
  const hasItems = v.items && v.items.length > 1;
  return (
    <div className={hasItems ? 'border border-slate-200 rounded bg-slate-50' : ''}>
      <div
        className={`flex items-center justify-between text-[11px] py-0.5 px-1 hover:bg-white rounded group ${hasItems ? 'cursor-pointer' : ''}`}
        onClick={() => hasItems && setExpanded(!expanded)}
      >
        <div className="flex items-center gap-2 min-w-0">
          {hasItems && (
            <span className={`text-slate-400 text-[10px] transition-transform shrink-0 ${expanded ? 'rotate-90' : ''}`}>▶</span>
          )}
          {hora && <span className="text-slate-400 font-mono shrink-0">{hora}</span>}
          <span className={`truncate ${v.customerName ? 'text-slate-800 font-medium' : 'text-slate-400 italic'}`}>
            {cliente}
          </span>
          {v.sellerName && (
            <span className="text-slate-500 text-[10px] shrink-0">· {v.sellerName.split(' ')[0]}</span>
          )}
          {v.parcelas && v.parcelas > 1 && (
            <span className="text-violet-600 text-[10px] shrink-0">· {v.parcelas}x</span>
          )}
          {hasItems && (
            <span className="text-amber-700 text-[10px] font-bold shrink-0 bg-amber-100 px-1 rounded">
              {v.items!.length} parc
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0 ml-2">
          <span className="font-mono font-bold tabular-nums">R$ {fmt(v.valor)}</span>
          {onEdit && (
            <button onClick={(e) => { e.stopPropagation(); onEdit(v); }} className="opacity-0 group-hover:opacity-100 transition text-slate-400 hover:text-blue-600 px-1" title="Ajustar pagamento (admin/supervisor)">✏️</button>
          )}
        </div>
      </div>
      {/* Cascade das parcelas individuais */}
      {hasItems && expanded && (
        <div className="border-t border-slate-200 bg-white px-2 py-1 space-y-0.5">
          {v.items!.map((it, i) => {
            const venc = it.vencimento ? (() => {
              try { const s = String(it.vencimento); const d = s.includes('T') ? new Date(s) : new Date(s + 'T00:00:00'); return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('pt-BR'); } catch { return '—'; }
            })() : '—';
            const numLabel = it.parcelaNum && it.totalParcelas
              ? `${it.parcelaNum}/${it.totalParcelas}`
              : `parc ${i + 1}`;
            return (
              <div key={i} className="flex items-center justify-between text-[10px] gap-2">
                <span className="font-bold text-rose-700 shrink-0 min-w-[40px]">{numLabel}</span>
                <span className="text-slate-500 font-mono shrink-0">venc {venc}</span>
                <span className="text-slate-400 italic flex-1 text-right shrink-0">
                  {it.jurosCalculado > 0 ? `juros R$ ${fmt(it.jurosCalculado)}` : ''}
                </span>
                <span className="font-mono font-bold tabular-nums text-emerald-700 shrink-0">R$ {fmt(it.valorPago)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Modal de ajuste de pagamento
const FORMAS_AJUSTE = [
  { method: 'dinheiro', label: 'Dinheiro', bandeiras: [] as string[] },
  { method: 'pix', label: 'PIX', bandeiras: [] as string[] },
  { method: 'credito', label: 'Cartão Crédito', bandeiras: ['MASTERCARD', 'VISA', 'CIELO', 'ELO', 'AMEX', 'HIPERCARD'] },
  { method: 'debito', label: 'Cartão Débito', bandeiras: ['VISA ELECTRON', 'REDESHOP', 'MASTERCARD', 'ELO'] },
  { method: 'crediario', label: 'Crediário', bandeiras: [] as string[] },
];

function AjustePagamentoModal({ target, onClose, onSaved }: { target: NonNullable<EditPaymentTarget>; onClose: () => void; onSaved: () => void }) {
  const [method, setMethod] = useState<string>(target.method.toLowerCase());
  const [bandeira, setBandeira] = useState<string>(target.bandeira || '');
  const [valor, setValor] = useState<string>(String(target.valor.toFixed(2)).replace('.', ','));
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formaInfo = FORMAS_AJUSTE.find((f) => f.method === method) || FORMAS_AJUSTE[0];
  const needsBandeira = formaInfo.bandeiras.length > 0;
  const submit = async () => {
    setError(null);
    if (!reason.trim() || reason.trim().length < 3) { setError('Razão obrigatória (mínimo 3 caracteres)'); return; }
    if (needsBandeira && !bandeira) { setError('Selecione a bandeira'); return; }
    const valorNum = Number(valor.replace(/\./g, '').replace(',', '.'));
    if (isNaN(valorNum) || valorNum <= 0) { setError('Valor inválido'); return; }
    setSaving(true);
    try {
      const body: any = { method, valor: valorNum, reason: reason.trim() };
      if (needsBandeira) body.details = { bandeira };
      await api(`/pdv/sales/${target.saleId}/payments/${target.paymentId}`, { method: 'PATCH', body: JSON.stringify(body) });
      onSaved();
    } catch (e: any) { setError(e?.message || String(e)); } finally { setSaving(false); }
  };
  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl max-w-md w-full p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-black text-blue-700 flex items-center gap-2">✏️ Ajustar pagamento</h2>
        <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-sm space-y-1">
          <div><strong>Cliente:</strong> {target.customerName || '—'}</div>
          <div><strong>Original:</strong> R$ {fmt(target.valor)} · <strong>{target.method.toUpperCase()}</strong>{target.bandeira && ` · ${target.bandeira}`}</div>
        </div>
        <div>
          <label className="text-xs uppercase font-bold text-slate-700 block mb-1">Forma</label>
          <div className="grid grid-cols-2 gap-1">
            {FORMAS_AJUSTE.map((f) => (
              <button key={f.method} type="button" onClick={() => { setMethod(f.method); setBandeira(''); }}
                className={`px-3 py-2 rounded border-2 text-xs font-bold ${method === f.method ? 'bg-blue-600 border-blue-700 text-white' : 'bg-white border-slate-200 text-slate-700 hover:border-blue-300'}`}>
                {f.label}
              </button>
            ))}
          </div>
        </div>
        {needsBandeira && (
          <div>
            <label className="text-xs uppercase font-bold text-slate-700 block mb-1">Bandeira</label>
            <div className="grid grid-cols-3 gap-1">
              {formaInfo.bandeiras.map((b) => (
                <button key={b} type="button" onClick={() => setBandeira(b)}
                  className={`px-2 py-1.5 rounded border-2 text-[11px] font-bold ${bandeira === b ? 'bg-blue-600 border-blue-700 text-white' : 'bg-white border-slate-200 text-slate-700 hover:border-blue-300'}`}>
                  {b}
                </button>
              ))}
            </div>
          </div>
        )}
        <div>
          <label className="text-xs uppercase font-bold text-slate-700 block mb-1">Valor R$</label>
          <input type="text" inputMode="decimal" value={valor} onChange={(e) => setValor(e.target.value)}
            className="w-full px-3 py-2 text-lg font-bold tabular-nums border-2 border-slate-200 rounded-lg focus:outline-none focus:border-blue-400" />
        </div>
        <div>
          <label className="text-xs uppercase font-bold text-slate-700 block mb-1">Razão (obrigatória)</label>
          <textarea value={reason} onChange={(e) => setReason(e.target.value.slice(0, 200))} placeholder="Ex: vendedora marcou crédito mas era débito" rows={2}
            className="w-full px-3 py-2 text-sm border-2 border-slate-200 rounded-lg focus:outline-none focus:border-blue-400" autoFocus />
          <div className="text-[10px] text-slate-400 text-right">{reason.length}/200</div>
        </div>
        {error && <div className="bg-rose-50 border border-rose-300 text-rose-800 rounded p-2 text-xs">{error}</div>}
        <div className="flex gap-2 pt-1">
          <button onClick={onClose} disabled={saving} className="flex-1 px-3 py-2 bg-gray-200 hover:bg-gray-300 text-gray-700 font-bold rounded-lg disabled:opacity-50">Cancelar</button>
          <button onClick={submit} disabled={saving || !reason.trim()} className="flex-[2] px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-lg disabled:opacity-40">{saving ? 'Salvando…' : 'Salvar ajuste'}</button>
        </div>
      </div>
    </div>
  );
}

function KpiCard({
  label,
  value,
  sub,
  highlight,
  negative,
}: {
  label: string;
  value: number;
  sub?: string;
  highlight?: boolean;
  negative?: boolean;
}) {
  return (
    <div
      className={`rounded-xl p-3 shadow ${
        highlight
          ? 'bg-rose-600 text-white'
          : negative
          ? 'bg-amber-50'
          : 'bg-white'
      }`}
    >
      <div className={`text-xs ${highlight ? 'text-rose-100' : 'text-gray-500'}`}>{label}</div>
      <div className={`text-lg font-bold ${highlight ? 'text-white' : 'text-rose-900'}`}>
        R$ {fmt(value || 0)}
      </div>
      {sub && (
        <div className={`text-xs ${highlight ? 'text-rose-100' : 'text-gray-500'}`}>{sub}</div>
      )}
    </div>
  );
}

// ── Modais ──────────────────────────────────────────────────────────

function ModalShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full">
        <div className="flex items-center justify-between p-5 border-b">
          <h2 className="text-lg font-bold text-rose-900">{title}</h2>
          <button onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

function AbrirModal({ onClose, onSuccess, storeCode }: { onClose: () => void; onSuccess: () => void; storeCode?: string }) {
  const [fundo, setFundo] = useState('');
  const [obs, setObs] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function submit() {
    setErr('');
    const v = parseFloat(fundo.replace(',', '.'));
    if (isNaN(v) || v < 0) {
      setErr('Informe o fundo de troco (R$)');
      return;
    }
    setBusy(true);
    try {
      const body: any = { fundoTroco: v, observacao: obs || undefined };
      if (storeCode) body.storeCode = storeCode;
      await api('/pdv/caixa/abrir', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      onSuccess();
    } catch (e: any) {
      setErr(e?.message || 'Falha ao abrir caixa');
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalShell title="Abrir Caixa" onClose={onClose}>
      <label className="block text-sm font-semibold text-gray-700 mb-1">
        Fundo de troco (R$)
      </label>
      <input
        type="text"
        inputMode="decimal"
        value={fundo}
        onChange={(e) => setFundo(e.target.value)}
        placeholder="100,00"
        className="w-full p-3 border rounded-lg text-lg focus:ring-2 focus:ring-rose-400"
        autoFocus
      />
      <label className="block text-sm font-semibold text-gray-700 mb-1 mt-4">
        Observação (opcional)
      </label>
      <textarea
        value={obs}
        onChange={(e) => setObs(e.target.value)}
        rows={2}
        className="w-full p-3 border rounded-lg focus:ring-2 focus:ring-rose-400"
      />
      {err && <div className="mt-3 text-sm text-red-600">{err}</div>}
      <div className="mt-5 flex gap-2">
        <button
          onClick={onClose}
          className="flex-1 py-3 rounded-xl bg-gray-200 hover:bg-gray-300 font-semibold"
        >
          Cancelar
        </button>
        <button
          disabled={busy}
          onClick={submit}
          className="flex-1 py-3 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-semibold disabled:opacity-50"
        >
          {busy ? '...' : 'Abrir Caixa'}
        </button>
      </div>
    </ModalShell>
  );
}

function MovModal({
  tipo,
  onClose,
  onSuccess,
  storeCode,
}: {
  tipo: 'sangria' | 'suprimento';
  onClose: () => void;
  onSuccess: () => void;
  storeCode?: string;
}) {
  const [valor, setValor] = useState('');
  const [motivo, setMotivo] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function submit() {
    setErr('');
    const v = parseFloat(valor.replace(',', '.'));
    if (isNaN(v) || v <= 0) {
      setErr('Informe o valor');
      return;
    }
    if (motivo.trim().length < 3) {
      setErr('Informe o motivo (mínimo 3 caracteres)');
      return;
    }
    setBusy(true);
    try {
      const body: any = { valor: v, motivo: motivo.trim() };
      if (storeCode) body.storeCode = storeCode;
      const mov = await api<{ id: string }>(`/pdv/caixa/${tipo}`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      // Imprime cupom SILENCIOSO (sem preview) com espaço pra assinatura.
      // Passa TODOS os dados via query string pra evitar race condition
      // (iframe oculto não precisa esperar fetch ao backend).
      if (mov?.id) {
        try {
          const qsImp = new URLSearchParams({
            autoprint: '1',
            tipo,
            valor: String(v),
            motivo: motivo.trim(),
            userName: (typeof window !== 'undefined' && localStorage.getItem('flowops_user_name')) || '',
            createdAt: new Date().toISOString(),
            storeCode: storeCode || '',
          });
          const url = `/minha-loja/pdv/caixa/sangria/${mov.id}?${qsImp.toString()}`;
          const electron = (window as any).electronAPI;
          if (electron?.silentPrintUrl) {
            electron.silentPrintUrl(window.location.origin + url).catch(() => imprimirHidden(url));
          } else {
            imprimirHidden(url);
          }
        } catch { /* segue mesmo se falhar a impressão */ }
      }
      onSuccess();
    } catch (e: any) {
      setErr(e?.message || 'Falha');
    } finally {
      setBusy(false);
    }
  }

  function imprimirHidden(url: string) {
    try {
      const iframe = document.createElement('iframe');
      iframe.style.cssText = 'position:fixed;left:-9999px;top:0;width:300px;height:600px;border:0;';
      iframe.src = url;
      document.body.appendChild(iframe);
      setTimeout(() => { try { iframe.remove(); } catch {} }, 30000);
    } catch {
      window.open(url, 'lurds_sangria', 'width=320,height=520,resizable=yes');
    }
  }

  return (
    <ModalShell
      title={tipo === 'sangria' ? 'Sangria (Saída)' : 'Suprimento (Entrada)'}
      onClose={onClose}
    >
      <label className="block text-sm font-semibold text-gray-700 mb-1">Valor (R$)</label>
      <input
        type="text"
        inputMode="decimal"
        value={valor}
        onChange={(e) => setValor(e.target.value)}
        placeholder="50,00"
        className="w-full p-3 border rounded-lg text-lg focus:ring-2 focus:ring-rose-400"
        autoFocus
      />
      <label className="block text-sm font-semibold text-gray-700 mb-1 mt-4">Motivo</label>
      <textarea
        value={motivo}
        onChange={(e) => setMotivo(e.target.value)}
        rows={2}
        placeholder={
          tipo === 'sangria' ? 'Ex: pagamento boleto luz' : 'Ex: reforço de troco'
        }
        className="w-full p-3 border rounded-lg focus:ring-2 focus:ring-rose-400"
      />
      {err && <div className="mt-3 text-sm text-red-600">{err}</div>}
      <div className="mt-5 flex gap-2">
        <button
          onClick={onClose}
          className="flex-1 py-3 rounded-xl bg-gray-200 hover:bg-gray-300 font-semibold"
        >
          Cancelar
        </button>
        <button
          disabled={busy}
          onClick={submit}
          className={`flex-1 py-3 rounded-xl text-white font-semibold disabled:opacity-50 ${
            tipo === 'sangria' ? 'bg-amber-600 hover:bg-amber-700' : 'bg-emerald-600 hover:bg-emerald-700'
          }`}
        >
          {busy ? '...' : 'Confirmar'}
        </button>
      </div>
    </ModalShell>
  );
}

function FecharModal({
  totals,
  fundoTroco,
  onClose,
  onSuccess,
  storeCode,
}: {
  totals: Totals;
  fundoTroco: number;
  onClose: () => void;
  onSuccess: () => void;
  storeCode?: string;
}) {
  const [fisico, setFisico] = useState('');
  const [obs, setObs] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const esperado = totals.dinheiroEsperado;
  const fisicoNum = parseFloat(fisico.replace(',', '.')) || 0;
  const diff = fisicoNum - esperado;

  // Detecta erro específico de venda em aberto pra mostrar botão "forçar"
  const [showForceClose, setShowForceClose] = useState(false);
  const [pendenciasCount, setPendenciasCount] = useState(0);

  async function submit(force = false) {
    setErr('');
    if (!fisico.trim()) {
      setErr('Conte o dinheiro físico em caixa');
      return;
    }
    setBusy(true);
    try {
      const body: any = { dinheiroFisico: fisicoNum, observacao: obs || undefined };
      if (storeCode) body.storeCode = storeCode;
      if (force) body.reason = 'Limpeza de pendências antes do fechamento';
      const endpoint = force ? '/pdv/caixa/forcar-fechar' : '/pdv/caixa/fechar';
      await api(endpoint, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      onSuccess();
    } catch (e: any) {
      const msg = String(e?.message || 'Falha ao fechar caixa');
      // Detecta erro de venda em aberto e oferece botão pra cancelar pendências
      const match = msg.match(/Existem (\d+) venda\(s\) em aberto/);
      if (match) {
        setPendenciasCount(parseInt(match[1], 10) || 0);
        setShowForceClose(true);
        setErr(msg);
      } else {
        setErr(msg);
        setShowForceClose(false);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalShell title="Fechar Caixa (Z)" onClose={onClose}>
      <div className="bg-rose-50 rounded-lg p-3 mb-4 text-sm font-mono">
        <div className="flex justify-between">
          <span>Vendas</span>
          <span>R$ {fmt(totals.totalVendas)}</span>
        </div>
        <div className="flex justify-between">
          <span>Dinheiro vendido</span>
          <span>R$ {fmt(totals.totalDinheiro)}</span>
        </div>
        <div className="flex justify-between text-rose-900 font-bold pt-1 border-t border-rose-200 mt-1">
          <span>Esperado em caixa</span>
          <span>R$ {fmt(esperado)}</span>
        </div>
      </div>

      <label className="block text-sm font-semibold text-gray-700 mb-1">
        Dinheiro físico em caixa (R$)
      </label>
      <input
        type="text"
        inputMode="decimal"
        value={fisico}
        onChange={(e) => setFisico(e.target.value)}
        className="w-full p-3 border rounded-lg text-lg focus:ring-2 focus:ring-rose-400"
        autoFocus
      />

      {fisico && (
        <div
          className={`mt-3 rounded-lg p-3 text-center font-bold ${
            Math.abs(diff) < 0.01
              ? 'bg-emerald-100 text-emerald-800'
              : diff > 0
              ? 'bg-blue-100 text-blue-800'
              : 'bg-red-100 text-red-800'
          }`}
        >
          {Math.abs(diff) < 0.01
            ? 'Caixa fechado certinho ✓'
            : diff > 0
            ? `SOBRA: R$ ${fmt(diff)}`
            : `FALTA: R$ ${fmt(Math.abs(diff))}`}
        </div>
      )}

      <label className="block text-sm font-semibold text-gray-700 mb-1 mt-4">
        Observação (opcional)
      </label>
      <textarea
        value={obs}
        onChange={(e) => setObs(e.target.value)}
        rows={2}
        className="w-full p-3 border rounded-lg focus:ring-2 focus:ring-rose-400"
      />

      {err && <div className="mt-3 text-sm text-red-600">{err}</div>}

      {showForceClose && (
        <div className="mt-3 bg-amber-50 border-2 border-amber-300 rounded-lg p-3">
          <div className="text-sm text-amber-900 font-semibold mb-2">
            ⚠ {pendenciasCount} venda(s) em aberto bloqueando o fechamento
          </div>
          <div className="text-xs text-amber-800 mb-3">
            Provavelmente são vendas zumbis (não aparecem no botão Pausadas mas
            estão no banco). Clique abaixo pra cancelar todas e fechar o caixa.
          </div>
          <button
            disabled={busy}
            onClick={() => {
              if (window.confirm(
                `Cancelar ${pendenciasCount} venda(s) em aberto e fechar o caixa?\n\n` +
                'Essa operação NÃO pode ser desfeita.'
              )) {
                submit(true);
              }
            }}
            className="w-full py-2.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white font-semibold disabled:opacity-50"
          >
            {busy ? '...' : '🧹 Cancelar pendências e fechar caixa'}
          </button>
        </div>
      )}

      <div className="mt-5 flex gap-2">
        <button
          onClick={onClose}
          className="flex-1 py-3 rounded-xl bg-gray-200 hover:bg-gray-300 font-semibold"
        >
          Cancelar
        </button>
        <button
          disabled={busy}
          onClick={() => submit(false)}
          className="flex-1 py-3 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-semibold disabled:opacity-50"
        >
          {busy ? '...' : 'Fechar Caixa'}
        </button>
      </div>
    </ModalShell>
  );
}
