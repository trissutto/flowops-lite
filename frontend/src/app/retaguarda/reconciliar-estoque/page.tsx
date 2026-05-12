'use client';

/**
 * /retaguarda/reconciliar-estoque
 *
 * Tela admin pra rodar reconciliacao retroativa de estoque PDV → Wincred.
 * Vendas finalizadas antes do fix gravaram caixa mas nao baixaram estoque.
 * Aqui dispara o script de baixa retroativa em lotes pequenos.
 */

import { useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, Loader2, AlertTriangle, CheckCircle2, Play, Eye, Package, Store, Database, Zap,
} from 'lucide-react';
import { api } from '@/lib/api';

type Resultado = {
  mode: 'dry-run' | 'executed';
  sinceIso: string;
  untilIso?: string;
  storeCode: string | null;
  totalSalesEncontradas: number;
  salesProcessadas: number;
  itemsAgregados: number;
  qtdTotal: number;
  falhas: Array<{ saleId: string; storeCode: string; error: string }>;
  aplicados: number;
  finished: boolean;
};

const brl = (n: number) =>
  Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export default function ReconciliarEstoquePage() {
  const [since, setSince] = useState(() => {
    // Default: 90 dias atras
    const d = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    return d.toISOString().slice(0, 10); // YYYY-MM-DD
  });
  // ATE — default vazio = ate agora. Permite cobrir janela especifica (ex:
  // so vendas do dia 13/05) sem mexer em dias ja reconciliados.
  const [until, setUntil] = useState('');
  const [storeCode, setStoreCode] = useState('');
  const [limit, setLimit] = useState(100);
  const [loading, setLoading] = useState(false);
  const [resultado, setResultado] = useState<Resultado | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Historico de lotes executados na sessao
  const [historico, setHistorico] = useState<Resultado[]>([]);

  const sinceIso = since ? new Date(since + 'T00:00:00').toISOString() : undefined;
  // Until: pega o FIM do dia escolhido (23:59:59.999) pra incluir toda a data
  const untilIso = until ? new Date(until + 'T23:59:59.999').toISOString() : undefined;

  async function rodar(dryRun: boolean) {
    setError(null);
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (sinceIso) params.set('since', sinceIso);
      if (untilIso) params.set('until', untilIso);
      if (storeCode) params.set('storeCode', storeCode);
      if (limit) params.set('limit', String(limit));

      let r: Resultado;
      if (dryRun) {
        r = await api<Resultado>(`/pdv/admin/reconcile-stock/preview?${params.toString()}`);
      } else {
        r = await api<Resultado>('/pdv/admin/reconcile-stock/execute', {
          method: 'POST',
          body: JSON.stringify({
            since: sinceIso,
            until: untilIso,
            storeCode: storeCode || undefined,
            limit,
          }),
        });
        setHistorico((prev) => [r, ...prev].slice(0, 20));
      }
      setResultado(r);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  async function executarTudo() {
    if (!confirm(
      'EXECUTAR EM LOOP ATE TERMINAR?\n\n' +
      'Vai rodar lotes consecutivos de ate ' + limit + ' vendas ate baixar estoque ' +
      'de todas as vendas pendentes do periodo. Pode levar alguns minutos.\n\n' +
      'Idempotente — vendas ja processadas sao puladas. Continua de onde parou ' +
      'se voce sair da tela.'
    )) return;

    setError(null);
    setLoading(true);
    setHistorico([]);
    try {
      let totalAplicados = 0;
      let totalFalhas = 0;
      let lotes = 0;
      let ultimoResult: Resultado | null = null;

      while (true) {
        lotes++;
        if (lotes > 200) {
          // Salvaguarda contra loop infinito
          setError(`Parou apos ${lotes} lotes — limite de seguranca atingido. Rode mais vezes se precisar.`);
          break;
        }
        const r = await api<Resultado>('/pdv/admin/reconcile-stock/execute', {
          method: 'POST',
          body: JSON.stringify({
            since: sinceIso,
            until: untilIso,
            storeCode: storeCode || undefined,
            limit,
          }),
        });
        totalAplicados += r.aplicados;
        totalFalhas += r.falhas.length;
        ultimoResult = r;
        setHistorico((prev) => [r, ...prev].slice(0, 50));
        setResultado(r);
        if (r.finished || r.salesProcessadas === 0) break;
      }

      if (ultimoResult) {
        alert(
          `RECONCILIACAO COMPLETA!\n\n` +
          `Lotes: ${lotes}\n` +
          `Vendas baixadas com sucesso: ${totalAplicados}\n` +
          `Falhas: ${totalFalhas}\n\n` +
          (totalFalhas > 0 ? 'Confira a lista de falhas abaixo.' : 'Tudo OK ✓')
        );
      }
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100">
      <div className="max-w-5xl mx-auto p-4 space-y-4">
        <div className="flex items-center gap-3">
          <Link href="/retaguarda" className="p-2 rounded-lg hover:bg-slate-200 text-slate-700">
            <ArrowLeft size={22} />
          </Link>
          <div>
            <h1 className="text-2xl font-black text-slate-900">RECONCILIAR ESTOQUE</h1>
            <p className="text-xs text-slate-500">
              Baixa retroativa de estoque Wincred pra vendas finalizadas que nao baixaram (bug historico)
            </p>
          </div>
        </div>

        {/* Alerta de contexto */}
        <div className="bg-amber-50 border-2 border-amber-300 rounded-xl p-4 flex items-start gap-3">
          <AlertTriangle className="text-amber-700 flex-shrink-0 mt-0.5" size={20} />
          <div className="text-sm text-amber-900 leading-relaxed">
            <div className="font-bold mb-1">Por que essa tela existe?</div>
            Vendas finalizadas no PDV ANTES do ultimo fix gravavam a venda na tabela <code className="bg-amber-100 px-1 rounded text-xs">caixa</code> do Wincred mas NAO chamavam <code className="bg-amber-100 px-1 rounded text-xs">decreaseStock</code> — entao o estoque ficou inflado. Esse script processa as vendas pendentes (flag <code className="bg-amber-100 px-1 rounded text-xs">stockDecreasedAt=null</code>) e baixa o estoque. <b>Idempotente</b>: nao baixa duas vezes a mesma venda.
          </div>
        </div>

        {/* Diagnostico de indices Wincred */}
        <IndexDiagnosticCard />

        {/* Filtros */}
        <div className="bg-white rounded-2xl shadow-sm p-4 space-y-3">
          <h2 className="font-bold text-slate-800 flex items-center gap-2">
            <Package size={18} /> Filtros
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div>
              <label className="text-xs uppercase font-bold text-slate-600 mb-1 block">
                Desde
              </label>
              <input
                type="date"
                value={since}
                onChange={(e) => setSince(e.target.value)}
                className="w-full px-3 py-2 border rounded-lg text-sm"
              />
              <div className="text-[10px] text-slate-500 mt-1">
                Default: 90d atras
              </div>
            </div>
            <div>
              <label className="text-xs uppercase font-bold text-slate-600 mb-1 block">
                Ate
              </label>
              <input
                type="date"
                value={until}
                onChange={(e) => setUntil(e.target.value)}
                className="w-full px-3 py-2 border rounded-lg text-sm"
              />
              <div className="text-[10px] text-slate-500 mt-1">
                Vazio = ate agora
              </div>
            </div>
            <div>
              <label className="text-xs uppercase font-bold text-slate-600 mb-1 block">
                Loja (opcional)
              </label>
              <input
                type="text"
                value={storeCode}
                onChange={(e) => setStoreCode(e.target.value.replace(/\D/g, '').slice(0, 2))}
                placeholder="01, 02… (vazio = todas)"
                className="w-full px-3 py-2 border rounded-lg text-sm font-mono"
              />
            </div>
            <div>
              <label className="text-xs uppercase font-bold text-slate-600 mb-1 block">
                Lote (max vendas)
              </label>
              <input
                type="number"
                value={limit}
                min={1}
                max={500}
                onChange={(e) => setLimit(Math.max(1, Math.min(500, Number(e.target.value) || 100)))}
                className="w-full px-3 py-2 border rounded-lg text-sm font-mono"
              />
              <div className="text-[10px] text-slate-500 mt-1">
                Recomendado: 100 (max 500)
              </div>
            </div>
          </div>

          {/* Atalhos rapidos pra janela de data */}
          <div className="flex flex-wrap gap-2 text-xs pt-1">
            <span className="text-slate-500 font-bold uppercase self-center mr-1">Atalhos:</span>
            <button
              type="button"
              onClick={() => {
                const t = new Date(); t.setHours(0, 0, 0, 0);
                const iso = t.toISOString().slice(0, 10);
                setSince(iso); setUntil(iso);
              }}
              className="px-2 py-1 bg-slate-100 hover:bg-slate-200 rounded text-slate-700 font-bold"
            >
              Hoje
            </button>
            <button
              type="button"
              onClick={() => {
                const t = new Date(Date.now() - 24 * 60 * 60 * 1000);
                const iso = t.toISOString().slice(0, 10);
                setSince(iso); setUntil(iso);
              }}
              className="px-2 py-1 bg-slate-100 hover:bg-slate-200 rounded text-slate-700 font-bold"
            >
              Ontem
            </button>
            <button
              type="button"
              onClick={() => {
                const t = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
                setSince(t.toISOString().slice(0, 10));
                setUntil('');
              }}
              className="px-2 py-1 bg-slate-100 hover:bg-slate-200 rounded text-slate-700 font-bold"
            >
              Ultimos 7d
            </button>
            <button
              type="button"
              onClick={() => {
                const t = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
                setSince(t.toISOString().slice(0, 10));
                setUntil('');
              }}
              className="px-2 py-1 bg-slate-100 hover:bg-slate-200 rounded text-slate-700 font-bold"
            >
              Ultimos 30d
            </button>
            <button
              type="button"
              onClick={() => setUntil('')}
              className="px-2 py-1 bg-slate-50 hover:bg-slate-100 rounded text-slate-500 font-bold"
              title="Limpa o campo 'Ate' — usa ate agora"
            >
              Limpar 'Ate'
            </button>
          </div>

          <div className="flex flex-wrap gap-2 pt-2 border-t">
            <button
              onClick={() => rodar(true)}
              disabled={loading}
              className="px-4 py-2 bg-slate-200 hover:bg-slate-300 text-slate-800 font-bold rounded-lg flex items-center gap-2 disabled:opacity-50"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Eye className="w-4 h-4" />}
              Preview (sem baixar)
            </button>
            <button
              onClick={() => rodar(false)}
              disabled={loading}
              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-lg flex items-center gap-2 disabled:opacity-50"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
              Executar 1 lote
            </button>
            <button
              onClick={executarTudo}
              disabled={loading}
              className="px-4 py-2 bg-rose-600 hover:bg-rose-700 text-white font-bold rounded-lg flex items-center gap-2 disabled:opacity-50 shadow-md"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Store className="w-4 h-4" />}
              Executar TUDO (loop ate terminar)
            </button>
          </div>
        </div>

        {error && (
          <div className="bg-rose-50 border-2 border-rose-300 text-rose-800 rounded-xl p-4 text-sm flex items-start gap-2">
            <AlertTriangle size={18} className="flex-shrink-0 mt-0.5" />
            <div>
              <div className="font-bold">Erro</div>
              {error}
            </div>
          </div>
        )}

        {/* Resultado do ultimo lote */}
        {resultado && (
          <div className={`rounded-2xl shadow-md p-5 border-2 ${
            resultado.mode === 'dry-run'
              ? 'bg-slate-50 border-slate-300'
              : resultado.falhas.length > 0
                ? 'bg-amber-50 border-amber-300'
                : 'bg-emerald-50 border-emerald-300'
          }`}>
            <div className="flex items-center gap-2 mb-3">
              {resultado.mode === 'dry-run' ? (
                <Eye className="text-slate-700" />
              ) : (
                <CheckCircle2 className="text-emerald-700" />
              )}
              <h2 className="font-bold text-slate-900">
                {resultado.mode === 'dry-run' ? 'PREVIEW' : 'EXECUTADO'}
              </h2>
              <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded ${
                resultado.finished ? 'bg-emerald-600 text-white' : 'bg-amber-500 text-white'
              }`}>
                {resultado.finished ? '✓ acabou' : '↻ tem mais — rode de novo'}
              </span>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-center">
              <div className="bg-white rounded-lg p-3 border">
                <div className="text-[10px] uppercase text-slate-500 font-bold">Vendas no filtro</div>
                <div className="text-2xl font-black tabular-nums text-slate-800">
                  {resultado.totalSalesEncontradas}
                </div>
              </div>
              <div className="bg-white rounded-lg p-3 border">
                <div className="text-[10px] uppercase text-slate-500 font-bold">Processadas (lote)</div>
                <div className="text-2xl font-black tabular-nums text-blue-700">
                  {resultado.salesProcessadas}
                </div>
              </div>
              <div className="bg-white rounded-lg p-3 border">
                <div className="text-[10px] uppercase text-slate-500 font-bold">Items (SKUs)</div>
                <div className="text-2xl font-black tabular-nums text-slate-800">
                  {resultado.itemsAgregados}
                </div>
              </div>
              <div className="bg-white rounded-lg p-3 border">
                <div className="text-[10px] uppercase text-slate-500 font-bold">Qtd total</div>
                <div className="text-2xl font-black tabular-nums text-slate-800">
                  {resultado.qtdTotal}
                </div>
              </div>
              <div className="bg-white rounded-lg p-3 border">
                <div className="text-[10px] uppercase text-slate-500 font-bold">
                  {resultado.mode === 'dry-run' ? 'Aplicaria' : 'Baixadas ✓'}
                </div>
                <div className={`text-2xl font-black tabular-nums ${
                  resultado.mode === 'dry-run' ? 'text-slate-500' : 'text-emerald-700'
                }`}>
                  {resultado.aplicados}
                </div>
              </div>
            </div>

            {resultado.falhas.length > 0 && (
              <div className="mt-4 bg-white rounded-lg border border-rose-200 overflow-hidden">
                <div className="px-3 py-2 bg-rose-50 border-b border-rose-200 font-bold text-rose-900 text-sm">
                  {resultado.falhas.length} falha(s)
                </div>
                <div className="max-h-64 overflow-y-auto divide-y divide-slate-100">
                  {resultado.falhas.map((f, i) => (
                    <div key={i} className="px-3 py-2 text-xs">
                      <div className="font-mono text-slate-700">
                        {f.saleId.slice(-8).toUpperCase()} · Loja {f.storeCode}
                      </div>
                      <div className="text-rose-700">{f.error}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Historico de lotes (so se rodou loop) */}
        {historico.length > 1 && (
          <div className="bg-white rounded-2xl shadow-sm p-4">
            <h3 className="font-bold text-slate-800 mb-2 text-sm">Historico desta sessao</h3>
            <div className="space-y-1 max-h-64 overflow-y-auto">
              {historico.map((h, i) => (
                <div key={i} className="flex items-center justify-between text-xs px-2 py-1 hover:bg-slate-50 rounded">
                  <span className="text-slate-500 font-mono">
                    Lote {historico.length - i}
                  </span>
                  <span className="text-slate-700">
                    {h.salesProcessadas} venda{h.salesProcessadas !== 1 ? 's' : ''}
                  </span>
                  <span className="font-bold text-emerald-700">
                    {h.aplicados} OK
                  </span>
                  {h.falhas.length > 0 && (
                    <span className="font-bold text-rose-700">
                      {h.falhas.length} falha{h.falhas.length !== 1 ? 's' : ''}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// Card de DIAGNOSTICO de indices Wincred — verifica se tabela estoque tem
// indice composto (CODIGO, LOJA). Sem isso, batch SELECT varre tabela toda.
// ═══════════════════════════════════════════════════════════════════════
function IndexDiagnosticCard() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setError(null); setLoading(true);
    try {
      const r = await api<any>('/pdv/admin/erp-indexes');
      setData(r);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  async function createIndex(table: string, indexName: string, columns: string[]) {
    if (!confirm(
      `Criar INDICE ${indexName} em ${table} (${columns.join(', ')})?\n\n` +
      `Operacao ONLINE (nao bloqueia Giga PDV).\n` +
      `Pode demorar alguns minutos em tabela grande.\n` +
      `Idempotente — se ja existir, nao faz nada.`
    )) return;
    setCreating(indexName); setError(null);
    try {
      const r = await api<any>('/pdv/admin/erp-create-index', {
        method: 'POST',
        body: JSON.stringify({ table, indexName, columns }),
      });
      alert(
        `${r.alreadyExists ? 'INDICE JA EXISTIA' : 'INDICE CRIADO COM SUCESSO'}\n\n` +
        `Tabela: ${r.table}\nNome: ${r.indexName}\nColunas: ${r.columns.join(', ')}\n` +
        (r.durationMs ? `Tempo: ${(r.durationMs / 1000).toFixed(1)}s` : '')
      );
      load(); // recarrega
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setCreating(null);
    }
  }

  return (
    <div className="bg-white rounded-2xl shadow-sm p-4 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="font-bold text-slate-800 flex items-center gap-2">
          <Database size={18} /> Diagnostico de indices Wincred
        </h2>
        <button
          onClick={load}
          disabled={loading}
          className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-xs font-bold rounded flex items-center gap-1"
        >
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Eye className="w-3.5 h-3.5" />}
          Verificar
        </button>
      </div>

      {error && (
        <div className="text-sm text-rose-700 flex items-center gap-1.5 bg-rose-50 border border-rose-200 rounded p-2">
          <AlertTriangle size={14} /> {error}
        </div>
      )}

      {!data && !loading && (
        <div className="text-xs text-slate-500">
          Clique em <b>Verificar</b> pra inspecionar indices das tabelas estoque, caixa, produtos e movimento.
        </div>
      )}

      {data?.results && (
        <div className="space-y-2">
          {(data.results as any[]).map((t) => (
            <div key={t.table} className={`border rounded-lg overflow-hidden ${t.recommendation ? 'border-amber-300' : 'border-emerald-300'}`}>
              <div className={`px-3 py-2 text-xs font-bold flex items-center justify-between ${t.recommendation ? 'bg-amber-50 text-amber-900' : 'bg-emerald-50 text-emerald-900'}`}>
                <span className="font-mono uppercase">{t.table}</span>
                <span>{t.indexes?.length || 0} indice(s)</span>
              </div>
              {t.indexes && t.indexes.length > 0 && (
                <div className="divide-y divide-slate-100">
                  {t.indexes.map((idx: any, i: number) => (
                    <div key={i} className="px-3 py-1.5 text-[11px] flex items-center justify-between gap-2">
                      <span className="font-mono text-slate-700">
                        {idx.name}
                        {idx.unique && <span className="text-emerald-700 ml-1">UNIQUE</span>}
                      </span>
                      <span className="font-mono text-slate-500">{idx.columns.join(', ')}</span>
                    </div>
                  ))}
                </div>
              )}
              {t.recommendation && (
                <div className="px-3 py-2 bg-amber-100 border-t border-amber-200 text-xs text-amber-900 flex items-start gap-2">
                  <Zap size={14} className="flex-shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <b>Recomendacao:</b> {t.recommendation}
                  </div>
                  {t.table === 'estoque' && !t.hasCodigoLoja && (
                    <button
                      onClick={() => createIndex('estoque', 'idx_lurds_codigo_loja', ['CODIGO', 'LOJA'])}
                      disabled={creating !== null}
                      className="px-2 py-1 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-[10px] font-bold rounded shrink-0"
                    >
                      {creating === 'idx_lurds_codigo_loja' ? 'Criando…' : 'Criar agora'}
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
