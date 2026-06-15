'use client';

/**
 * /retaguarda/comissoes
 *
 * Hub admin pra gestao de comissao. 3 abas:
 *   - Regras       — CRUD de regras (global/store/seller)
 *   - Fechamentos  — periodos mensais (open/closed/paid)
 *   - Relatorio    — visao agregada por loja do periodo selecionado
 *
 * F4 da migracao 30/06: substitui o calculo que vinha do Wincred/Giga.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, DollarSign, Plus, Save, X, Trash2, Loader2, Calculator,
  Lock, CheckCircle2, Download, RefreshCw, AlertTriangle,
} from 'lucide-react';
import { api } from '@/lib/api';

type Rule = {
  id: string;
  scope: 'global' | 'store' | 'seller';
  storeId: string | null;
  sellerId: string | null;
  percentBase: number | string;
  meta: number | string | null;
  bonusPercent: number | string | null;
  validFrom: string;
  validTo: string | null;
  active: boolean;
  note: string | null;
  store?: { code: string; name: string } | null;
  seller?: { name: string } | null;
};

type Period = {
  id: string;
  yearMonth: string;
  status: 'open' | 'closed' | 'paid';
  startDate: string;
  endDate: string;
  totalSellers: number;
  totalCommission: number | string;
  totalVendido: number | string;
  closedAt: string | null;
  paidAt: string | null;
};

type Store = { id: string; code: string; name: string; active: boolean };
type Seller = { id: string; name: string; active: boolean };

const brl = (n: number | string | null | undefined) =>
  Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export default function ComissoesPage() {
  const [tab, setTab] = useState<'rules' | 'periods' | 'report'>('rules');
  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 space-y-5">
      <div className="flex items-center gap-3">
        <Link
          href="/retaguarda"
          className="p-2 rounded-lg hover:bg-slate-100 text-slate-500"
          title="Voltar"
        >
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-emerald-500 to-green-600 text-white flex items-center justify-center shadow">
          <DollarSign className="w-5 h-5" />
        </div>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-slate-900">Comissões</h1>
          <p className="text-sm text-slate-500">
            Engine de cálculo Flowops (substitui Wincred a partir de 30/06).
          </p>
        </div>
      </div>

      <div className="flex gap-1 border-b border-slate-200">
        {[
          { k: 'rules', label: 'Regras' },
          { k: 'periods', label: 'Fechamentos' },
          { k: 'report', label: 'Relatório' },
        ].map((t) => (
          <button
            key={t.k}
            onClick={() => setTab(t.k as any)}
            className={`px-4 py-2 font-bold text-sm border-b-2 transition ${
              tab === t.k
                ? 'border-emerald-600 text-emerald-700'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'rules' && <RulesTab />}
      {tab === 'periods' && <PeriodsTab />}
      {tab === 'report' && <ReportTab />}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
//  RULES TAB
// ═══════════════════════════════════════════════════════════════════

function RulesTab() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
  const [sellers, setSellers] = useState<Seller[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Partial<Rule> | null>(null);

  async function load() {
    setLoading(true);
    try {
      const [r, s, se] = await Promise.all([
        api<Rule[]>('/commissions/rules?activeOnly=1'),
        api<Store[]>('/stores'),
        api<Seller[]>('/sellers'),
      ]);
      setRules(r);
      setStores(s.filter((x) => x.active).sort((a, b) => a.code.localeCompare(b.code)));
      setSellers(se.filter((x) => x.active).sort((a, b) => a.name.localeCompare(b.name)));
    } catch (e: any) {
      alert('Erro: ' + (e?.message || e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleDeactivate(id: string) {
    if (!confirm('Desativar essa regra? Histórico de cálculos antigos é preservado.')) return;
    await api(`/commissions/rules/${id}/deactivate`, { method: 'POST' });
    load();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-600">
          Regras hierárquicas: <b>seller &gt; store &gt; global</b>. A mais específica vale.
        </p>
        <button
          onClick={() =>
            setEditing({
              scope: 'global',
              percentBase: 3,
              validFrom: new Date().toISOString().slice(0, 10),
              active: true,
            })
          }
          className="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-lg font-bold flex items-center gap-2"
        >
          <Plus className="w-4 h-4" />
          Nova regra
        </button>
      </div>

      {loading ? (
        <Loader2 className="w-6 h-6 animate-spin mx-auto" />
      ) : rules.length === 0 ? (
        <div className="text-center py-10 bg-amber-50 border border-amber-200 rounded-lg">
          <AlertTriangle className="w-8 h-8 mx-auto text-amber-600 mb-2" />
          <p className="font-bold text-amber-800">Nenhuma regra cadastrada</p>
          <p className="text-sm text-amber-700 mt-1">
            Cadastra ao menos uma regra <b>global</b> pra cálculo nunca dar zero.
          </p>
        </div>
      ) : (
        <table className="w-full bg-white rounded-xl border border-slate-200 overflow-hidden">
          <thead className="bg-slate-50 text-xs uppercase text-slate-600">
            <tr>
              <th className="text-left px-3 py-2">Escopo</th>
              <th className="text-left px-3 py-2">Loja / Vendedora</th>
              <th className="text-right px-3 py-2">% Base</th>
              <th className="text-right px-3 py-2">Meta</th>
              <th className="text-right px-3 py-2">Bônus</th>
              <th className="text-left px-3 py-2">Vigência</th>
              <th className="text-center px-3 py-2">Ações</th>
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id} className="border-t border-slate-100 hover:bg-slate-50">
                <td className="px-3 py-2">
                  <span
                    className={`text-xs font-bold px-2 py-0.5 rounded uppercase ${
                      r.scope === 'global'
                        ? 'bg-slate-100 text-slate-700'
                        : r.scope === 'store'
                        ? 'bg-blue-100 text-blue-700'
                        : 'bg-violet-100 text-violet-700'
                    }`}
                  >
                    {r.scope}
                  </span>
                </td>
                <td className="px-3 py-2 text-sm">
                  {r.scope === 'store' && r.store
                    ? `${r.store.code} — ${r.store.name}`
                    : r.scope === 'seller' && r.seller
                    ? r.seller.name
                    : '—'}
                </td>
                <td className="px-3 py-2 text-right font-bold tabular-nums">
                  {Number(r.percentBase).toFixed(2)}%
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-xs">
                  {r.meta ? brl(r.meta) : '—'}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-xs">
                  {r.bonusPercent ? `+${Number(r.bonusPercent).toFixed(2)}%` : '—'}
                </td>
                <td className="px-3 py-2 text-xs text-slate-600">
                  {new Date(r.validFrom).toLocaleDateString('pt-BR')}
                  {r.validTo ? ` → ${new Date(r.validTo).toLocaleDateString('pt-BR')}` : ''}
                </td>
                <td className="px-3 py-2 text-center">
                  <button
                    onClick={() => handleDeactivate(r.id)}
                    className="p-1.5 hover:bg-red-50 rounded text-red-600"
                    title="Desativar"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editing && (
        <RuleEditModal
          rule={editing}
          stores={stores}
          sellers={sellers}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function RuleEditModal({
  rule,
  stores,
  sellers,
  onClose,
  onSaved,
}: {
  rule: Partial<Rule>;
  stores: Store[];
  sellers: Seller[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [scope, setScope] = useState<'global' | 'store' | 'seller'>(rule.scope || 'global');
  const [storeId, setStoreId] = useState(rule.storeId || '');
  const [sellerId, setSellerId] = useState(rule.sellerId || '');
  const [percentBase, setPercentBase] = useState(String(rule.percentBase ?? '3'));
  const [meta, setMeta] = useState(String(rule.meta ?? ''));
  const [bonusPercent, setBonusPercent] = useState(String(rule.bonusPercent ?? ''));
  const [validFrom, setValidFrom] = useState(
    rule.validFrom ? String(rule.validFrom).slice(0, 10) : new Date().toISOString().slice(0, 10),
  );
  const [validTo, setValidTo] = useState(rule.validTo ? String(rule.validTo).slice(0, 10) : '');
  const [note, setNote] = useState(rule.note || '');
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      const body: any = {
        scope,
        percentBase: Number(percentBase),
        validFrom,
        active: true,
        note,
      };
      if (scope === 'store') body.storeId = storeId;
      if (scope === 'seller') body.sellerId = sellerId;
      if (meta.trim()) body.meta = Number(meta);
      if (bonusPercent.trim()) body.bonusPercent = Number(bonusPercent);
      if (validTo.trim()) body.validTo = validTo;
      await api('/commissions/rules', { method: 'POST', body: JSON.stringify(body) });
      onSaved();
    } catch (e: any) {
      alert('Erro: ' + (e?.message || e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto">
        <div className="px-5 py-3 border-b flex items-center justify-between sticky top-0 bg-white">
          <h2 className="font-bold">Nova regra de comissão</h2>
          <button onClick={onClose} className="p-1 hover:bg-slate-100 rounded">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="block text-xs font-bold uppercase text-slate-500 mb-1">
              Escopo
            </label>
            <div className="flex gap-2">
              {(['global', 'store', 'seller'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setScope(s)}
                  className={`flex-1 py-2 rounded-lg font-bold text-sm ${
                    scope === s
                      ? s === 'global'
                        ? 'bg-slate-700 text-white'
                        : s === 'store'
                        ? 'bg-blue-600 text-white'
                        : 'bg-violet-600 text-white'
                      : 'bg-slate-100 text-slate-500'
                  }`}
                >
                  {s.toUpperCase()}
                </button>
              ))}
            </div>
            <p className="text-xs text-slate-400 mt-1">
              Global vale pra todas. Store sobrescreve global. Seller sobrescreve store.
            </p>
          </div>

          {scope === 'store' && (
            <div>
              <label className="block text-xs font-bold uppercase text-slate-500 mb-1">Loja</label>
              <select
                value={storeId}
                onChange={(e) => setStoreId(e.target.value)}
                className="w-full px-3 py-2 border rounded"
              >
                <option value="">Escolha uma loja</option>
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.code} — {s.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {scope === 'seller' && (
            <div>
              <label className="block text-xs font-bold uppercase text-slate-500 mb-1">
                Vendedora
              </label>
              <select
                value={sellerId}
                onChange={(e) => setSellerId(e.target.value)}
                className="w-full px-3 py-2 border rounded"
              >
                <option value="">Escolha uma vendedora</option>
                {sellers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-bold uppercase text-slate-500 mb-1">
                % Base
              </label>
              <input
                type="number"
                step="0.01"
                value={percentBase}
                onChange={(e) => setPercentBase(e.target.value)}
                className="w-full px-3 py-2 border rounded text-right tabular-nums"
              />
              <p className="text-xs text-slate-400 mt-1">Ex: 3.00 = 3%</p>
            </div>
            <div>
              <label className="block text-xs font-bold uppercase text-slate-500 mb-1">
                Meta R$ (opcional)
              </label>
              <input
                type="number"
                step="0.01"
                value={meta}
                onChange={(e) => setMeta(e.target.value)}
                placeholder="Ex: 80000"
                className="w-full px-3 py-2 border rounded text-right tabular-nums"
              />
            </div>
            <div>
              <label className="block text-xs font-bold uppercase text-slate-500 mb-1">
                Bônus % (acima da meta)
              </label>
              <input
                type="number"
                step="0.01"
                value={bonusPercent}
                onChange={(e) => setBonusPercent(e.target.value)}
                placeholder="Ex: 1.00 = +1%"
                className="w-full px-3 py-2 border rounded text-right tabular-nums"
                disabled={!meta.trim()}
              />
            </div>
            <div />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-bold uppercase text-slate-500 mb-1">
                Válida a partir de
              </label>
              <input
                type="date"
                value={validFrom}
                onChange={(e) => setValidFrom(e.target.value)}
                className="w-full px-3 py-2 border rounded"
              />
            </div>
            <div>
              <label className="block text-xs font-bold uppercase text-slate-500 mb-1">
                Até (opcional)
              </label>
              <input
                type="date"
                value={validTo}
                onChange={(e) => setValidTo(e.target.value)}
                className="w-full px-3 py-2 border rounded"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold uppercase text-slate-500 mb-1">
              Observação (opcional)
            </label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Motivo da regra, contexto..."
              className="w-full px-3 py-2 border rounded text-sm"
              rows={2}
            />
          </div>
        </div>
        <div className="px-5 py-3 border-t flex items-center justify-end sticky bottom-0 bg-white">
          <button
            onClick={handleSave}
            disabled={saving || (scope === 'store' && !storeId) || (scope === 'seller' && !sellerId)}
            className="bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-bold px-5 py-2 rounded flex items-center gap-2"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            Salvar
          </button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
//  PERIODS TAB
// ═══════════════════════════════════════════════════════════════════

function PeriodsTab() {
  const [periods, setPeriods] = useState<Period[]>([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const r = await api<Period[]>('/commissions/periods');
      setPeriods(r);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function currentYearMonth(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  async function action(yearMonth: string, action: 'calculate' | 'close' | 'pay') {
    if (action === 'pay' && !confirm(`Confirmar pagamento de ${yearMonth}? Não pode desfazer.`))
      return;
    if (action === 'close' && !confirm(`Fechar ${yearMonth}? Não recalcula mais (override admin).`))
      return;
    setWorking(yearMonth + ':' + action);
    try {
      const r = await api<any>(`/commissions/periods/${yearMonth}/${action}`, { method: 'POST' });
      if (action === 'calculate') {
        alert(`Recálculo OK: ${r.entries?.length || 0} entries, total ${brl(r.total)}`);
      }
      load();
    } catch (e: any) {
      alert('Erro: ' + (e?.message || e));
    } finally {
      setWorking(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-600">
          Fechamentos mensais. Sempre rode <b>Calcular</b> antes de fechar.
        </p>
        <button
          onClick={() => action(currentYearMonth(), 'calculate')}
          disabled={!!working}
          className="bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white px-4 py-2 rounded-lg font-bold flex items-center gap-2"
        >
          <Calculator className="w-4 h-4" />
          Calcular mês atual
        </button>
      </div>

      {loading ? (
        <Loader2 className="w-6 h-6 animate-spin mx-auto" />
      ) : (
        <table className="w-full bg-white rounded-xl border border-slate-200 overflow-hidden">
          <thead className="bg-slate-50 text-xs uppercase text-slate-600">
            <tr>
              <th className="text-left px-3 py-2">Mês</th>
              <th className="text-left px-3 py-2">Status</th>
              <th className="text-right px-3 py-2">Vendedoras</th>
              <th className="text-right px-3 py-2">Vendido Liq.</th>
              <th className="text-right px-3 py-2">Comissão</th>
              <th className="text-center px-3 py-2">Ações</th>
            </tr>
          </thead>
          <tbody>
            {periods.map((p) => (
              <tr key={p.id} className="border-t border-slate-100">
                <td className="px-3 py-2 font-bold">{p.yearMonth}</td>
                <td className="px-3 py-2">
                  <span
                    className={`text-xs font-bold px-2 py-0.5 rounded uppercase ${
                      p.status === 'open'
                        ? 'bg-amber-100 text-amber-700'
                        : p.status === 'closed'
                        ? 'bg-blue-100 text-blue-700'
                        : 'bg-emerald-100 text-emerald-700'
                    }`}
                  >
                    {p.status}
                  </span>
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{p.totalSellers}</td>
                <td className="px-3 py-2 text-right tabular-nums text-sm">
                  {brl(p.totalVendido)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums font-bold text-emerald-700">
                  {brl(p.totalCommission)}
                </td>
                <td className="px-3 py-2 text-center">
                  <div className="inline-flex gap-1">
                    {p.status === 'open' && (
                      <>
                        <button
                          onClick={() => action(p.yearMonth, 'calculate')}
                          disabled={!!working}
                          className="text-xs bg-slate-200 hover:bg-slate-300 px-2 py-1 rounded font-bold"
                          title="Recalcular"
                        >
                          <RefreshCw className="w-3 h-3 inline" />
                        </button>
                        <button
                          onClick={() => action(p.yearMonth, 'close')}
                          disabled={!!working}
                          className="text-xs bg-blue-600 hover:bg-blue-700 text-white px-2 py-1 rounded font-bold"
                        >
                          <Lock className="w-3 h-3 inline" /> Fechar
                        </button>
                      </>
                    )}
                    {p.status === 'closed' && (
                      <button
                        onClick={() => action(p.yearMonth, 'pay')}
                        disabled={!!working}
                        className="text-xs bg-emerald-600 hover:bg-emerald-700 text-white px-2 py-1 rounded font-bold"
                      >
                        <CheckCircle2 className="w-3 h-3 inline" /> Marcar pago
                      </button>
                    )}
                    {p.status === 'paid' && (
                      <span className="text-xs text-emerald-700 font-bold">
                        ✓ Pago {p.paidAt && new Date(p.paidAt).toLocaleDateString('pt-BR')}
                      </span>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
//  REPORT TAB
// ═══════════════════════════════════════════════════════════════════

function ReportTab() {
  const now = new Date();
  const defaultYM = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const [yearMonth, setYearMonth] = useState(defaultYM);
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const r = await api<any>(`/commissions/periods/${yearMonth}/report`);
      setData(r);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [yearMonth]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <input
          type="month"
          value={yearMonth}
          onChange={(e) => setYearMonth(e.target.value)}
          className="px-3 py-2 border rounded"
        />
        <button
          onClick={load}
          className="bg-slate-700 hover:bg-slate-800 text-white px-3 py-2 rounded flex items-center gap-1"
        >
          <RefreshCw className="w-4 h-4" /> Atualizar
        </button>
      </div>

      {loading ? (
        <Loader2 className="w-6 h-6 animate-spin mx-auto" />
      ) : !data ? (
        <p className="text-center text-slate-400 py-10">Nenhum dado pra esse período</p>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-3">
            <Card label="Vendido líquido" value={brl(data.period.totalVendido)} />
            <Card label="Comissão total" value={brl(data.period.totalCommission)} highlight />
            <Card label="Vendedoras" value={String(data.period.totalSellers)} />
          </div>

          {data.byStore.map((g: any) => (
            <div key={g.storeId} className="bg-white border rounded-xl overflow-hidden">
              <div className="px-3 py-2 bg-slate-50 border-b flex items-center justify-between">
                <span className="font-bold text-sm">Loja</span>
                <span className="text-sm">
                  <b>{brl(g.totalVendido)}</b> vendido / <b className="text-emerald-700">{brl(g.totalComissao)}</b>{' '}
                  comissão
                </span>
              </div>
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs uppercase text-slate-600">
                  <tr>
                    <th className="text-left px-3 py-1.5">Vendedora</th>
                    <th className="text-right px-3 py-1.5">Vendido Liq.</th>
                    <th className="text-right px-3 py-1.5">Comissão Base</th>
                    <th className="text-right px-3 py-1.5">Bônus</th>
                    <th className="text-right px-3 py-1.5">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {g.sellers.map((s: any) => (
                    <tr key={s.sellerId} className="border-t border-slate-100">
                      <td className="px-3 py-1.5 font-bold">{s.sellerName}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        {brl(s.vendidoLiquido)}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{brl(s.comissaoBase)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-emerald-700">
                        {s.metaAtingida ? brl(s.bonusValue) : '—'}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums font-bold">
                        {brl(s.total)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Card({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div
      className={`rounded-xl border p-3 ${
        highlight ? 'bg-emerald-50 border-emerald-200' : 'bg-white border-slate-200'
      }`}
    >
      <div className="text-xs font-bold uppercase text-slate-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${highlight ? 'text-emerald-700' : 'text-slate-800'}`}>
        {value}
      </div>
    </div>
  );
}
