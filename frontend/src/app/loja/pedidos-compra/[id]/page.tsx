'use client';

/**
 * /loja/pedidos-compra/[id] — Detalhe de pedido.
 *
 * Modos:
 *  - pendente/rascunho: vê itens, pode editar header, ou marcar como recebido
 *  - recebido: vê SKUs gerados + botão imprimir etiquetas
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  ArrowLeft, Loader2, AlertCircle, Package, CheckCircle2,
  Truck, Printer, FileText, Edit3, Trash2, Plus,
} from 'lucide-react';
import { api } from '@/lib/api';

type Order = {
  id: string;
  numero: number;
  fornecedorNome: string;
  fornecedorCnpj: string | null;
  marca: string | null;
  dataPedido: string;
  dataPrevista: string | null;
  nfNumero: string | null;
  observacoes: string | null;
  status: string;
  totalPecas: number;
  totalCusto: number;
  totalVenda: number;
  recebidoAt: string | null;
  cadastroLog: string | null;
  items: Array<{
    id: string;
    ref: string;
    descricaoBase: string;
    cor: string;
    grupoNome: string | null;
    subgrupoNome: string | null;
    ncm: string | null;
    plusSize: boolean;
    custoUnit: number;
    precoUnit: number;
    tributoPct: number;
    tamanhosQty: Record<string, number>;
    tamanhosQtyRecebida: Record<string, number> | null;
    skusGerados: Array<{ codigo: string; cor: string; tamanho: string; descricao: string; qty: number }> | null;
    itemStatus: string;
  }>;
};

const STATUS_INFO: Record<string, { label: string; color: string }> = {
  rascunho: { label: 'Rascunho', color: 'bg-slate-100 text-slate-700' },
  enviado: { label: 'Enviado', color: 'bg-sky-100 text-sky-800' },
  aguardando: { label: 'Aguardando', color: 'bg-amber-100 text-amber-800' },
  recebido: { label: 'Recebido', color: 'bg-emerald-100 text-emerald-800' },
  recebido_com_erro: { label: 'Recebido c/ erro', color: 'bg-rose-100 text-rose-800' },
  cancelado: { label: 'Cancelado', color: 'bg-slate-100 text-slate-500' },
};

const brl = (n: number) =>
  Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export default function PedidoDetalhePage() {
  const router = useRouter();
  const params = useParams();
  const id = params?.id as string;

  const [data, setData] = useState<Order | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [receiving, setReceiving] = useState(false);
  const [receiveResult, setReceiveResult] = useState<any>(null);

  // Modo edição de qty (recebimento detalhado): { itemId → { tam → qty } }
  const [adjustedQty, setAdjustedQty] = useState<Record<string, Record<string, number>>>({});
  const [editMode, setEditMode] = useState(false);
  const [addModalOpen, setAddModalOpen] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api<Order>(`/purchase-orders/${id}`);
      setData(r);
    } catch (e: any) {
      setError(e?.message || 'Erro ao carregar pedido');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (id) fetchData();
  }, [id, fetchData]);

  const confirmarRecebimento = async () => {
    if (!data) return;
    if (!confirm(
      `Confirmar recebimento de TODAS as ${data.totalPecas} peças do pedido #${data.numero}?\n\n` +
      `O sistema vai cadastrar automaticamente cada SKU no Wincred (com EAN-13) e atualizar estoque.`,
    )) return;

    setReceiving(true);
    try {
      const itemsRecebidos = editMode
        ? data.items.map((it) => ({
            itemId: it.id,
            tamanhosQty: adjustedQty[it.id] || it.tamanhosQty,
          }))
        : [];
      const r = await api<any>(`/purchase-orders/${id}/receive`, {
        method: 'POST',
        body: JSON.stringify({ itemsRecebidos }),
      });
      setReceiveResult(r);
      await fetchData();
    } catch (e: any) {
      alert('Erro: ' + e?.message);
    } finally {
      setReceiving(false);
    }
  };

  const irPraEtiquetas = () => {
    router.push(`/loja/pedidos-compra/${id}/etiquetas`);
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-violet-600" />
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="bg-rose-50 border border-rose-300 text-rose-700 rounded-lg p-6 max-w-md text-center">
          <AlertCircle className="w-10 h-10 mx-auto mb-2" />
          <div className="font-bold">{error || 'Pedido não encontrado'}</div>
          <Link href="/loja/pedidos-compra" className="mt-3 inline-block text-sm underline">
            ← Voltar pra lista
          </Link>
        </div>
      </div>
    );
  }

  const st = STATUS_INFO[data.status] || STATUS_INFO.rascunho;
  const isRecebido = data.status === 'recebido' || data.status === 'recebido_com_erro';

  // Agrupa items por REF pra mostrar grade combinada
  const itemsPorRef = new Map<string, typeof data.items>();
  for (const it of data.items) {
    if (!itemsPorRef.has(it.ref)) itemsPorRef.set(it.ref, []);
    itemsPorRef.get(it.ref)!.push(it);
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-30">
        <div className="max-w-[1400px] mx-auto px-4 py-3 flex items-center gap-3">
          <Link href="/loja/pedidos-compra" className="p-2 rounded-lg hover:bg-slate-100">
            <ArrowLeft className="w-5 h-5 text-slate-600" />
          </Link>
          <div className="w-12 h-12 rounded-xl bg-violet-100 flex items-center justify-center">
            <span className="text-violet-700 font-black">#{data.numero}</span>
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-lg font-black truncate">{data.fornecedorNome}</h1>
              <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded ${st.color}`}>
                {st.label}
              </span>
              {data.dataPrevista && !isRecebido && data.status !== 'cancelado' && (() => {
                const dias = Math.ceil(
                  (new Date(data.dataPrevista).getTime() - Date.now()) / 86400000,
                );
                const atrasado = dias < 0;
                const proximo = dias >= 0 && dias <= 3;
                const cls = atrasado
                  ? 'bg-rose-100 text-rose-800 border-rose-400'
                  : proximo
                    ? 'bg-amber-100 text-amber-800 border-amber-400'
                    : 'bg-sky-100 text-sky-800 border-sky-400';
                return (
                  <span className={`text-xs font-bold px-2.5 py-1 rounded-lg border-2 ${cls}`}>
                    Entrega {new Date(data.dataPrevista).toLocaleDateString('pt-BR')}
                    {atrasado && <span className="ml-1.5">- ATRASADO {Math.abs(dias)} dia(s)</span>}
                    {proximo && !atrasado && (
                      <span className="ml-1.5">
                        - {dias === 0 ? 'HOJE' : dias === 1 ? 'AMANHA' : `em ${dias} dias`}
                      </span>
                    )}
                    {!atrasado && !proximo && <span className="ml-1.5">- em {dias} dias</span>}
                  </span>
                );
              })()}
            </div>
            <p className="text-xs text-slate-500">
              {data.marca && <span>Marca: <b>{data.marca}</b> · </span>}
              {data.nfNumero && <span>NF {data.nfNumero} · </span>}
              <b>{data.totalPecas}</b> peças · {brl(data.totalCusto)} custo
            </p>
          </div>
          {!isRecebido && (
            <button
              onClick={confirmarRecebimento}
              disabled={receiving || data.items.length === 0}
              className="flex items-center gap-2 px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-sm rounded-lg shadow-md disabled:opacity-40"
            >
              {receiving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
              {editMode ? 'Confirmar ajustado' : '✓ Recebi tudo'}
            </button>
          )}
          {isRecebido && (
            <button
              onClick={irPraEtiquetas}
              className="flex items-center gap-2 px-5 py-2.5 bg-violet-600 hover:bg-violet-700 text-white font-bold text-sm rounded-lg shadow-md"
            >
              <Printer className="w-4 h-4" />
              Imprimir etiquetas
            </button>
          )}
          <Link
            href={`/loja/pedidos-compra/${id}/imprimir`}
            className="flex items-center gap-2 px-4 py-2.5 bg-white hover:bg-slate-50 border border-slate-300 text-slate-700 font-bold text-sm rounded-lg"
            title="Gerar PDF do pedido (conferência)"
          >
            <FileText className="w-4 h-4" />
            PDF
          </Link>
          <button
            onClick={async () => {
              if (!confirm(`Excluir pedido #${data.numero} (${data.fornecedorNome})?\n\nEsta acao nao pode ser desfeita.${isRecebido ? '\n\nATENCAO: este pedido ja foi RECEBIDO. Os SKUs cadastrados no Wincred NAO serao removidos.' : ''}`)) return;
              try {
                await api(`/purchase-orders/${id}?force=true`, { method: 'DELETE' });
                router.push('/loja/pedidos-compra');
              } catch (err: any) {
                alert('Erro ao excluir: ' + (err?.message || 'desconhecido'));
              }
            }}
            title="Excluir pedido"
            className="flex items-center gap-2 px-4 py-2.5 bg-white hover:bg-rose-50 border border-rose-200 hover:border-rose-300 text-rose-600 font-bold text-sm rounded-lg"
          >
            <Trash2 className="w-4 h-4" />
            Excluir
          </button>
        </div>
      </header>

      <main className="max-w-[1400px] mx-auto p-4 space-y-3">
        {/* Resultado do recebimento */}
        {receiveResult && (
          <div className={`rounded-lg p-4 border-2 ${
            receiveResult.errors?.length > 0
              ? 'bg-amber-50 border-amber-300'
              : 'bg-emerald-50 border-emerald-300'
          }`}>
            <div className="font-black text-base mb-2">
              {receiveResult.errors?.length > 0 ? '⚠ Recebido com erros' : '✅ Recebimento OK'}
            </div>
            <div className="text-sm space-y-1">
              <div><b>{receiveResult.totalPecas}</b> peças recebidas</div>
              <div><b>{receiveResult.totalSkusInseridos}</b> SKUs novos cadastrados no Wincred</div>
              <div><b>{receiveResult.totalSkusJaExistiam}</b> SKUs já existiam</div>
              {receiveResult.errors?.length > 0 && (
                <details className="mt-2">
                  <summary className="cursor-pointer font-bold text-rose-700">
                    {receiveResult.errors.length} erros
                  </summary>
                  <ul className="mt-1 text-xs space-y-0.5 text-rose-700">
                    {receiveResult.errors.map((e: string, i: number) => <li key={i}>• {e}</li>)}
                  </ul>
                </details>
              )}
            </div>
          </div>
        )}

        {/* FINANCEIRO DO PEDIDO */}
        {(() => {
          let totalPecas = 0;
          let precoBruto = 0;
          let descontoTotal = 0;
          let impostoTotal = 0;
          for (const it of data.items as any[]) {
            const qtyMap = (isRecebido && it.tamanhosQtyRecebida) ? it.tamanhosQtyRecebida : it.tamanhosQty;
            let qty = 0;
            for (const k of Object.keys(qtyMap || {})) qty += Number(qtyMap[k] || 0);
            totalPecas += qty;
            const custoUnit = Number(it.custoUnit || 0);
            const bruto = custoUnit * qty;
            precoBruto += bruto;
            const descPct = Number(it.descontoPct || 0);
            const tribPct = Number(it.tributoPct || 0);
            descontoTotal += bruto * (descPct / 100);
            impostoTotal += bruto * (1 - descPct / 100) * (tribPct / 100);
          }
          const precoLiquido = precoBruto - descontoTotal;
          const totalPedido = precoLiquido + impostoTotal;
          return (
            <section className="bg-white border border-slate-200 rounded-2xl p-4">
              <h2 className="text-sm font-black text-violet-700 uppercase tracking-wider mb-3">Financeiro do pedido</h2>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                <div className="bg-slate-50 rounded-lg p-3">
                  <div className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">Total peças</div>
                  <div className="text-2xl font-black text-slate-800 tabular-nums mt-1">{totalPecas}</div>
                </div>
                <div className="bg-slate-50 rounded-lg p-3">
                  <div className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">Preço bruto</div>
                  <div className="text-lg font-black text-slate-800 tabular-nums mt-1">{brl(precoBruto)}</div>
                </div>
                <div className="bg-rose-50 rounded-lg p-3">
                  <div className="text-[10px] uppercase font-bold text-rose-700 tracking-wider">- Desconto</div>
                  <div className="text-lg font-black text-rose-700 tabular-nums mt-1">{brl(descontoTotal)}</div>
                </div>
                <div className="bg-amber-50 rounded-lg p-3">
                  <div className="text-[10px] uppercase font-bold text-amber-700 tracking-wider">+ Impostos</div>
                  <div className="text-lg font-black text-amber-700 tabular-nums mt-1">{brl(impostoTotal)}</div>
                </div>
                <div className="bg-emerald-50 rounded-lg p-3 border-2 border-emerald-200">
                  <div className="text-[10px] uppercase font-bold text-emerald-800 tracking-wider">Total pedido</div>
                  <div className="text-xl font-black text-emerald-700 tabular-nums mt-1">{brl(totalPedido)}</div>
                </div>
              </div>
              <div className="mt-2 text-[11px] text-slate-500 flex flex-wrap gap-3">
                <span>Preço líquido: <b className="text-slate-700">{brl(precoLiquido)}</b></span>
                <span>Custo médio/peça: <b className="text-slate-700">{totalPecas > 0 ? brl(totalPedido / totalPecas) : 'R$ 0,00'}</b></span>
              </div>
            </section>
          );
        })()}

        {/* Botão modo edição (só se NÃO recebido) */}
        {!isRecebido && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 flex items-center gap-2">
            <input
              type="checkbox"
              id="editmode"
              checked={editMode}
              onChange={(e) => setEditMode(e.target.checked)}
              className="accent-amber-600"
            />
            <label htmlFor="editmode" className="text-sm cursor-pointer">
              <b>Conferência detalhada</b> — ajustar qty por tamanho (caso chegou menos do que pediu)
            </label>
          </div>
        )}

        {/* Botao Adicionar item — disponivel sempre (rascunho ou recebido) */}
        <div className="flex justify-end">
          <button
            onClick={() => setAddModalOpen(true)}
            className="flex items-center gap-2 px-4 py-2 bg-violet-600 hover:bg-violet-700 text-white font-bold text-sm rounded-lg shadow-sm transition active:scale-95"
            title="Adicionar nova REF ao pedido"
          >
            <Plus className="w-4 h-4" />
            Adicionar item
          </button>
        </div>

        {/* Modal de adicionar item */}
        {addModalOpen && (
          <AddItemModal
            orderId={id}
            onClose={() => setAddModalOpen(false)}
            onSaved={() => { setAddModalOpen(false); fetchData(); }}
          />
        )}

        {/* Items agrupados por REF */}
        {Array.from(itemsPorRef.entries()).map(([ref, refItems]) => {
          const primeiro = refItems[0];
          // Coleta todos os tamanhos únicos dessa REF (pode variar por linha)
          const todosTamanhos = new Set<string>();
          for (const it of refItems) {
            for (const t of Object.keys(it.tamanhosQty || {})) todosTamanhos.add(t);
          }
          const tamanhosOrdenados = Array.from(todosTamanhos).sort((a, b) => Number(a) - Number(b));

          return (
            <div key={ref} className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="bg-violet-50 px-4 py-2 border-b border-violet-100 flex items-center gap-3">
                <div className="font-black text-violet-700 font-mono">{ref}</div>
                <div className="font-bold text-slate-700">{primeiro.descricaoBase}</div>
                <div className="text-[11px] text-slate-500">
                  {primeiro.grupoNome} / {primeiro.subgrupoNome}
                  {primeiro.plusSize && ' · PLUS SIZE'}
                </div>
                <div className="flex-1" />
                <div className="text-xs text-slate-600">
                  Custo {brl(primeiro.custoUnit)} · Venda <b className="text-emerald-700">{brl(primeiro.precoUnit)}</b>
                </div>
              </div>

              <div className="overflow-x-auto p-2">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[10px] uppercase text-slate-500">
                      <th className="text-left p-1">Cor</th>
                      {tamanhosOrdenados.map((t) => (
                        <th key={t} className="text-center p-1 font-mono text-violet-700">{t}</th>
                      ))}
                      <th className="text-center p-1 font-mono text-violet-700">TOT</th>
                    </tr>
                  </thead>
                  <tbody>
                    {refItems.map((it) => {
                      const qtyPraExibir = isRecebido
                        ? it.tamanhosQtyRecebida || it.tamanhosQty
                        : it.tamanhosQty;
                      let total = 0;
                      for (const t of tamanhosOrdenados) total += Number(qtyPraExibir[t] || 0);
                      return (
                        <tr key={it.id} className="border-t border-slate-100">
                          <td className="p-1 font-bold text-amber-700">{it.cor}</td>
                          {tamanhosOrdenados.map((t) => {
                            const qty = Number(qtyPraExibir[t] || 0);
                            return (
                              <td key={t} className="p-0.5 text-center">
                                {editMode && !isRecebido ? (
                                  <input
                                    type="text"
                                    inputMode="numeric"
                                    defaultValue={qty || ''}
                                    onChange={(e) => {
                                      const v = Number(e.target.value.replace(/\D/g, '')) || 0;
                                      setAdjustedQty((prev) => ({
                                        ...prev,
                                        [it.id]: { ...(prev[it.id] || it.tamanhosQty), [t]: v },
                                      }));
                                    }}
                                    className="w-12 px-1 py-0.5 border rounded text-center font-mono text-sm"
                                  />
                                ) : (
                                  <span className={`font-mono text-sm ${qty === 0 ? 'text-slate-300' : 'text-slate-800'}`}>
                                    {qty || '—'}
                                  </span>
                                )}
                              </td>
                            );
                          })}
                          <td className="p-1 text-center font-black text-violet-700 tabular-nums">{total}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>


            </div>
          );
        })}
      </main>
    </div>
  );
}


// ===================================================================
// AddItemModal — adiciona uma nova REF ao pedido
// ===================================================================

type Grupo = { codigo: number; nome: string };

function AddItemModal({
  orderId, onClose, onSaved,
}: {
  orderId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [grupos, setGrupos] = useState<Grupo[]>([]);
  const [subgrupos, setSubgrupos] = useState<Grupo[]>([]);
  const [ref, setRef] = useState('');
  const [descricaoBase, setDescricaoBase] = useState('');
  const [cor, setCor] = useState('');
  const [grupoCode, setGrupoCode] = useState<number | null>(null);
  const [subgrupoCode, setSubgrupoCode] = useState<number | null>(null);
  const [ncm, setNcm] = useState('');
  const [cfop, setCfop] = useState('5102');
  const [plusSize, setPlusSize] = useState(true);
  const [custoUnit, setCustoUnit] = useState('');
  const [descontoPct, setDescontoPct] = useState('');
  const [tributoPct, setTributoPct] = useState('');
  const [precoUnit, setPrecoUnit] = useState('');
  const [tamanhosTxt, setTamanhosTxt] = useState('');
  const [criandoG, setCriandoG] = useState(false);
  const [criandoSg, setCriandoSg] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api<Grupo[]>('/purchase-orders/lookups/grupos').then(setGrupos).catch(() => {});
  }, []);

  useEffect(() => {
    if (!grupoCode) { setSubgrupos([]); return; }
    api<Grupo[]>(`/purchase-orders/lookups/subgrupos?grupo=${grupoCode}`).then(setSubgrupos).catch(() => setSubgrupos([]));
  }, [grupoCode]);

  const refetchGrupos = async () => {
    try { const r = await api<Grupo[]>('/purchase-orders/lookups/grupos'); setGrupos(r); } catch {}
  };

  const criarGrupo = async () => {
    const nome = prompt('Nome do novo grupo:')?.trim();
    if (!nome) return;
    setCriandoG(true);
    try {
      const novo = await api<Grupo>('/purchase-orders/lookups/grupo', {
        method: 'POST', body: JSON.stringify({ nome }),
      });
      await refetchGrupos();
      setGrupoCode(novo.codigo);
      setSubgrupoCode(null);
    } catch (e: any) { alert('Erro: ' + (e?.message || '')); }
    finally { setCriandoG(false); }
  };

  const criarSubgrupo = async () => {
    if (!grupoCode) { alert('Escolha um grupo antes'); return; }
    const nome = prompt('Nome do novo subgrupo:')?.trim();
    if (!nome) return;
    setCriandoSg(true);
    try {
      const novo = await api<Grupo>('/purchase-orders/lookups/subgrupo', {
        method: 'POST', body: JSON.stringify({ grupo: grupoCode, nome }),
      });
      const lista = await api<Grupo[]>(`/purchase-orders/lookups/subgrupos?grupo=${grupoCode}`);
      setSubgrupos(lista);
      setSubgrupoCode(novo.codigo);
    } catch (e: any) { alert('Erro: ' + (e?.message || '')); }
    finally { setCriandoSg(false); }
  };

  // Parse "PP:2,P:3,M:5" → { PP: 2, P: 3, M: 5 }
  const parseTamanhos = (txt: string): Record<string, number> => {
    const result: Record<string, number> = {};
    for (const part of txt.split(',')) {
      const [t, q] = part.split(':').map((s) => s.trim());
      if (t && q && !isNaN(Number(q))) result[t.toUpperCase()] = Number(q);
    }
    return result;
  };

  const totalPecas = (() => {
    const map = parseTamanhos(tamanhosTxt);
    return Object.values(map).reduce((s, v) => s + v, 0);
  })();

  const salvar = async () => {
    setErr(null);
    if (!ref.trim()) { setErr('REF obrigatória'); return; }
    if (!cor.trim()) { setErr('COR obrigatória'); return; }
    if (!grupoCode) { setErr('Grupo obrigatório'); return; }
    if (!subgrupoCode) { setErr('Subgrupo obrigatório'); return; }
    const custo = Number((custoUnit || '').replace(',', '.')) || 0;
    const preco = Number((precoUnit || '').replace(',', '.')) || 0;
    if (!custo) { setErr('Custo obrigatório'); return; }
    if (!preco) { setErr('Preço venda obrigatório'); return; }
    const tamanhosQty = parseTamanhos(tamanhosTxt);
    if (Object.keys(tamanhosQty).length === 0) {
      setErr('Tamanhos obrigatórios (ex: P:2,M:3,G:1)');
      return;
    }
    const g = grupos.find((x) => x.codigo === grupoCode);
    const sg = subgrupos.find((x) => x.codigo === subgrupoCode);
    setSaving(true);
    try {
      await api(`/purchase-orders/${orderId}/items`, {
        method: 'POST',
        body: JSON.stringify({
          ref: ref.trim().toUpperCase(),
          descricaoBase: descricaoBase.trim().toUpperCase() || ref.trim().toUpperCase(),
          cor: cor.trim().toUpperCase(),
          grupoCode,
          grupoNome: g?.nome || '',
          subgrupoCode,
          subgrupoNome: sg?.nome || '',
          ncm: ncm.trim(),
          cfop: cfop.trim() || '5102',
          plusSize,
          custoUnit: custo,
          precoUnit: preco,
          descontoPct: Number((descontoPct || '0').replace(',', '.')) || 0,
          tributoPct: Number((tributoPct || '0').replace(',', '.')) || 0,
          tamanhosQty,
        }),
      });
      onSaved();
    } catch (e: any) {
      setErr(e?.message || 'Erro ao salvar');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4 overflow-y-auto" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-2xl max-w-2xl w-full p-5 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-black mb-3">Adicionar item ao pedido</h2>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <div>
            <label className="text-[10px] font-bold text-slate-600 uppercase">REF *</label>
            <input value={ref} onChange={(e) => setRef(e.target.value.toUpperCase())} placeholder="7031"
              className="w-full px-2 py-2 border rounded text-sm font-mono" />
          </div>
          <div className="sm:col-span-3">
            <label className="text-[10px] font-bold text-slate-600 uppercase">Descrição base</label>
            <input value={descricaoBase} onChange={(e) => setDescricaoBase(e.target.value.toUpperCase())}
              placeholder="BLUSA FEMININA MANGA CURTA"
              className="w-full px-2 py-2 border rounded text-sm" />
          </div>
          <div className="sm:col-span-2">
            <label className="text-[10px] font-bold text-slate-600 uppercase">COR *</label>
            <input value={cor} onChange={(e) => setCor(e.target.value.toUpperCase())} placeholder="PRETO"
              className="w-full px-2 py-2 border rounded text-sm" />
          </div>
          <div>
            <label className="text-[10px] font-bold text-slate-600 uppercase">NCM</label>
            <input value={ncm} onChange={(e) => setNcm(e.target.value.replace(/\D/g, '').slice(0, 8))}
              placeholder="00000000" className="w-full px-2 py-2 border rounded text-sm font-mono" />
          </div>
          <div>
            <label className="text-[10px] font-bold text-slate-600 uppercase">CFOP</label>
            <input value={cfop} onChange={(e) => setCfop(e.target.value.replace(/\D/g, '').slice(0, 4))}
              className="w-full px-2 py-2 border rounded text-sm font-mono" />
          </div>
        </div>

        {/* Grupo + Subgrupo com botao + */}
        <div className="grid grid-cols-2 gap-2 mt-3 bg-slate-50 p-2 rounded-lg">
          <div>
            <div className="flex items-center justify-between">
              <label className="text-[10px] font-bold text-slate-600 uppercase">Grupo *</label>
              <button type="button" onClick={criarGrupo} disabled={criandoG}
                className="text-[10px] font-bold text-violet-600 hover:text-violet-800 disabled:opacity-40">
                {criandoG ? '...' : '+ novo'}
              </button>
            </div>
            <select value={grupoCode || ''} onChange={(e) => { setGrupoCode(Number(e.target.value) || null); setSubgrupoCode(null); }}
              className="w-full px-2 py-2 border rounded text-sm bg-white">
              <option value="">— selecione —</option>
              {grupos.map((g) => <option key={g.codigo} value={g.codigo}>{g.nome}</option>)}
            </select>
          </div>
          <div>
            <div className="flex items-center justify-between">
              <label className="text-[10px] font-bold text-slate-600 uppercase">Subgrupo *</label>
              <button type="button" onClick={criarSubgrupo} disabled={criandoSg || !grupoCode}
                className="text-[10px] font-bold text-violet-600 hover:text-violet-800 disabled:opacity-40">
                {criandoSg ? '...' : '+ novo'}
              </button>
            </div>
            <select value={subgrupoCode || ''} onChange={(e) => setSubgrupoCode(Number(e.target.value) || null)}
              disabled={!grupoCode}
              className="w-full px-2 py-2 border rounded text-sm bg-white disabled:opacity-50">
              <option value="">— selecione —</option>
              {subgrupos.map((s) => <option key={s.codigo} value={s.codigo}>{s.nome}</option>)}
            </select>
          </div>
        </div>

        {/* PlusSize */}
        <label className="flex items-center gap-2 mt-2 cursor-pointer">
          <input type="checkbox" checked={plusSize} onChange={(e) => setPlusSize(e.target.checked)}
            className="accent-violet-600 w-4 h-4" />
          <span className="text-sm font-bold text-violet-700">PLUS SIZE</span>
        </label>

        {/* Precificação */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3 bg-amber-50 p-2 rounded-lg">
          <div>
            <label className="text-[10px] font-bold text-slate-600 uppercase">Custo R$ *</label>
            <input value={custoUnit} onChange={(e) => setCustoUnit(e.target.value)} placeholder="0,00"
              className="w-full px-2 py-2 border rounded text-sm font-mono" />
          </div>
          <div>
            <label className="text-[10px] font-bold text-slate-600 uppercase">Desconto %</label>
            <input value={descontoPct} onChange={(e) => setDescontoPct(e.target.value)} placeholder="0"
              className="w-full px-2 py-2 border rounded text-sm font-mono" />
          </div>
          <div>
            <label className="text-[10px] font-bold text-slate-600 uppercase">Imposto %</label>
            <input value={tributoPct} onChange={(e) => setTributoPct(e.target.value)} placeholder="0"
              className="w-full px-2 py-2 border rounded text-sm font-mono" />
          </div>
          <div>
            <label className="text-[10px] font-bold text-slate-600 uppercase">Preço venda R$ *</label>
            <input value={precoUnit} onChange={(e) => setPrecoUnit(e.target.value)} placeholder="0,00"
              className="w-full px-2 py-2 border rounded text-sm font-mono bg-emerald-50" />
          </div>
        </div>

        {/* Tamanhos */}
        <div className="mt-3">
          <label className="text-[10px] font-bold text-slate-600 uppercase">Tamanhos + Quantidades *</label>
          <input value={tamanhosTxt} onChange={(e) => setTamanhosTxt(e.target.value)}
            placeholder="P:2, M:3, G:5, GG:2"
            className="w-full px-2 py-2 border rounded text-sm font-mono" />
          <div className="text-[11px] text-slate-500 mt-1">
            Formato: <code>tamanho:qty</code> separados por vírgula. Total: <b className="text-violet-700">{totalPecas} peças</b>
          </div>
        </div>

        {err && (
          <div className="bg-rose-50 border border-rose-200 text-rose-700 text-xs rounded p-2 mt-3">{err}</div>
        )}

        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onClose} disabled={saving}
            className="px-4 py-2 text-sm font-bold text-slate-700 hover:bg-slate-100 rounded-lg disabled:opacity-40">
            Cancelar
          </button>
          <button onClick={salvar} disabled={saving}
            className="px-4 py-2 text-sm font-bold text-white bg-violet-600 hover:bg-violet-700 rounded-lg disabled:opacity-40">
            {saving ? 'Salvando...' : 'Adicionar item'}
          </button>
        </div>
      </div>
    </div>
  );
}
