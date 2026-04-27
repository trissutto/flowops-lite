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
import { ArrowLeft, DollarSign, TrendingDown, TrendingUp, FileText, X, Lock, Clock } from 'lucide-react';
import { api } from '@/lib/api';

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

const fmt = (n: number) =>
  n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function CaixaPage() {
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [movements, setMovements] = useState<Movement[]>([]);

  // Modais
  const [showAbrir, setShowAbrir] = useState(false);
  const [showSangria, setShowSangria] = useState(false);
  const [showSuprimento, setShowSuprimento] = useState(false);
  const [showFechar, setShowFechar] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<{
        open: boolean;
        session: Session | null;
        totals?: Totals;
      }>('/pdv/caixa/atual');
      setOpen(data.open);
      setSession(data.session);
      setTotals(data.totals || null);
      if (data.open) {
        const movs = await api<Movement[]>('/pdv/caixa/movimentos');
        setMovements(movs);
      } else {
        setMovements([]);
      }
    } catch (e) {
      console.error('Falha ao ler caixa', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  if (loading) {
    return (
      <div className="min-h-screen bg-pink-50 p-6 flex items-center justify-center">
        <div className="text-rose-700">Carregando caixa…</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-pink-50 p-4 md:p-6">
      <div className="max-w-4xl mx-auto">
        <Link
          href="/minha-loja/pdv"
          className="inline-flex items-center gap-2 text-rose-700 hover:text-rose-900 mb-4"
        >
          <ArrowLeft size={18} /> Voltar pro PDV
        </Link>

        <h1 className="text-2xl md:text-3xl font-bold text-rose-900 mb-6">
          Caixa do dia
        </h1>

        {!open ? (
          <NoCashOpenCard onOpen={() => setShowAbrir(true)} />
        ) : (
          <OpenCashPanel
            session={session!}
            totals={totals}
            movements={movements}
            onSangria={() => setShowSangria(true)}
            onSuprimento={() => setShowSuprimento(true)}
            onFechar={() => setShowFechar(true)}
          />
        )}
      </div>

      {showAbrir && (
        <AbrirModal
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

function NoCashOpenCard({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="bg-white rounded-2xl shadow-md p-8 text-center">
      <div className="w-20 h-20 mx-auto bg-rose-100 rounded-full flex items-center justify-center mb-4">
        <Lock size={36} className="text-rose-600" />
      </div>
      <h2 className="text-xl font-bold text-rose-900 mb-2">
        Caixa fechado
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
  movements,
  onSangria,
  onSuprimento,
  onFechar,
}: {
  session: Session;
  totals: Totals | null;
  movements: Movement[];
  onSangria: () => void;
  onSuprimento: () => void;
  onFechar: () => void;
}) {
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
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KpiCard label="Vendas" value={totals.totalVendas} sub={`${totals.qtdVendas} cupons`} />
          <KpiCard label="Dinheiro" value={totals.totalDinheiro} highlight />
          <KpiCard label="Pix" value={totals.totalPix} />
          <KpiCard label="Cartão Crédito" value={totals.totalCartaoCredito} />
          <KpiCard label="Cartão Débito" value={totals.totalCartaoDebito} />
          <KpiCard label="Crediário" value={totals.totalCrediario} />
          <KpiCard label="Sangrias" value={totals.totalSangrias} negative />
          <KpiCard label="Suprimentos" value={totals.totalSuprimentos} />
        </div>
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

function AbrirModal({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
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
      await api('/pdv/caixa/abrir', {
        method: 'POST',
        body: JSON.stringify({ fundoTroco: v, observacao: obs || undefined }),
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
}: {
  tipo: 'sangria' | 'suprimento';
  onClose: () => void;
  onSuccess: () => void;
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
      await api(`/pdv/caixa/${tipo}`, {
        method: 'POST',
        body: JSON.stringify({ valor: v, motivo: motivo.trim() }),
      });
      onSuccess();
    } catch (e: any) {
      setErr(e?.message || 'Falha');
    } finally {
      setBusy(false);
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
}: {
  totals: Totals;
  fundoTroco: number;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [fisico, setFisico] = useState('');
  const [obs, setObs] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const esperado = totals.dinheiroEsperado;
  const fisicoNum = parseFloat(fisico.replace(',', '.')) || 0;
  const diff = fisicoNum - esperado;

  async function submit() {
    setErr('');
    if (!fisico.trim()) {
      setErr('Conte o dinheiro físico em caixa');
      return;
    }
    setBusy(true);
    try {
      await api('/pdv/caixa/fechar', {
        method: 'POST',
        body: JSON.stringify({ dinheiroFisico: fisicoNum, observacao: obs || undefined }),
      });
      onSuccess();
    } catch (e: any) {
      setErr(e?.message || 'Falha ao fechar caixa');
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
          {busy ? '...' : 'Fechar Caixa'}
        </button>
      </div>
    </ModalShell>
  );
}
