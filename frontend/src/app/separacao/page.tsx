'use client';

/**
 * Central de Emissão de Separações.
 *
 * Quem cuida de enviar as separações pras lojas usa esta tela:
 *  1. Vê todos os pedidos pendentes (status configurável)
 *  2. Clica em "Preparar" num pedido → sistema calcula qual loja separa
 *  3. Clica em "WhatsApp" → abre wa.me com a mensagem pronta e muda status pra "Separação"
 *
 * Atualiza sozinho a cada 30s.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import {
  RefreshCw,
  Send,
  Loader2,
  ExternalLink,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Package,
  Store as StoreIcon,
  Search,
  CheckSquare,
  Square,
  X,
  Printer,
} from 'lucide-react';

interface WcOrderListItem {
  id: number;
  number: string;
  status: string;
  dateCreatedGmt: string;
  total: string;
  customerName: string;
}

interface SeparationGroup {
  storeId: string;
  storeCode: string;
  storeName: string;
  storeCity: string | null;
  storeState: string | null;
  whatsapp: string | null;
  contactName: string | null;
  items: Array<{ sku: string; quantity: number; productName: string; variant?: string }>;
  whatsappMessage: string;
  whatsappUrl: string | null;
}
interface ScoreRow {
  storeCode: string;
  storeName: string;
  priorityScore: number;
  stockBuffer: number;
  stockBufferScore: number;
  distanceScore: number;
  finalScore: number;
  fullCoverage: boolean;
}
interface SeparationPreview {
  success: boolean;
  strategy: 'single-store' | 'multi-store' | 'insufficient-stock';
  shippingMethod: string;
  groups: SeparationGroup[];
  missing: Array<{ sku: string; quantity: number; productName: string }>;
  scoreBreakdown?: ScoreRow[];
}

const FILTROS = [
  { slug: 'processing',  label: 'Processando',         color: 'bg-emerald-100 text-emerald-800' },
  { slug: 'pending',     label: 'Pagto pendente',      color: 'bg-amber-100 text-amber-800' },
  { slug: 'on-hold',     label: 'Aguardando',          color: 'bg-yellow-100 text-yellow-800' },
  { slug: 'separacao',   label: 'Em separação',        color: 'bg-blue-100 text-blue-800' },
];

// Mapa de status destino permitidos pra mudança em bloco, com label.
// Só mostramos os úteis pro fluxo operacional (não quero acidentes tipo "cancelled").
const BULK_TARGETS: Array<{ slug: string; label: string; color: string }> = [
  { slug: 'separacao',  label: 'Separação',   color: 'bg-blue-600 hover:bg-blue-700' },
  { slug: 'processing', label: 'Processando', color: 'bg-emerald-600 hover:bg-emerald-700' },
  { slug: 'on-hold',    label: 'Aguardando',  color: 'bg-yellow-500 hover:bg-yellow-600' },
  { slug: 'completed',  label: 'Concluído',   color: 'bg-slate-600 hover:bg-slate-700' },
];

export default function SeparacaoPage() {
  const [orders, setOrders] = useState<WcOrderListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<string>('processing');
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [preview, setPreview] = useState<Record<number, SeparationPreview>>({});
  const [busy, setBusy] = useState<Record<number, boolean>>({});
  const [errorByOrder, setErrorByOrder] = useState<Record<number, string>>({});

  // Seleção em bloco
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number; fails: number } | null>(null);

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, search]);

  // Limpa seleção ao trocar filtro/busca — IDs mudam
  useEffect(() => {
    setSelected(new Set());
  }, [status, search]);

  function toggleOne(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) => {
      if (prev.size === orders.length && orders.length > 0) {
        return new Set();
      }
      return new Set(orders.map((o) => o.id));
    });
  }

  function clearSelection() {
    setSelected(new Set());
  }

  /**
   * Abre uma janela com a ordem de separação pronta pra imprimir na térmica.
   * A página /separacao/imprimir/[wcId] já chama window.print() sozinha.
   */
  function imprimirPedido(wcId: number) {
    const url = `/separacao/imprimir/${wcId}`;
    window.open(url, '_blank', 'width=420,height=800,noopener,noreferrer');
  }

  /**
   * Imprime todos os pedidos selecionados numa única aba (page-break entre eles).
   * Muito mais prático do que abrir N abas.
   */
  function imprimirSelecionados() {
    if (selected.size === 0) return;
    const ids = Array.from(selected).join(',');
    // Qualquer ID funciona na rota; o ?wcIds sobrescreve com a lista
    const firstId = Array.from(selected)[0];
    const url = `/separacao/imprimir/${firstId}?wcIds=${ids}`;
    window.open(url, '_blank', 'width=420,height=800,noopener,noreferrer');
  }

  /**
   * Roda "Preparar separação" em bloco pra todos os selecionados.
   * 4 em paralelo pra não estourar o backend/WC.
   *
   * Cada sucesso:
   *   - popula preview[wcId] (loja escolhida pelo routing)
   *   - expande o card automaticamente (user já enxerga a loja)
   * Cada falha:
   *   - registra em errorByOrder[wcId]
   *
   * Após terminar, o user pode clicar WhatsApp em cada um (dispara + muda status)
   * ou usar o bulk "Mudar status → Separação" se já resolveu manualmente.
   */
  async function bulkPrepareSeparation() {
    if (selected.size === 0) return;

    // Filtra só quem AINDA não tem preview — evita recalcular o que já calculou
    const ids = Array.from(selected).filter((id) => !preview[id]);
    if (ids.length === 0) {
      alert('Todos os pedidos selecionados já têm separação calculada.');
      return;
    }

    setBulkRunning(true);
    setBulkProgress({ done: 0, total: ids.length, fails: 0 });

    const CONCURRENCY = 4;
    const queue = [...ids];
    let fails = 0;

    async function worker() {
      while (queue.length > 0) {
        const id = queue.shift();
        if (id == null) break;
        try {
          const res = await api<SeparationPreview>(`/orders/wc/${id}/prepare-separation`);
          setPreview((p) => ({ ...p, [id]: res }));
          setExpanded((x) => ({ ...x, [id]: true }));
          setErrorByOrder((e) => ({ ...e, [id]: '' }));
        } catch (e: any) {
          fails++;
          setErrorByOrder((er) => ({ ...er, [id]: e?.message || 'Falha ao calcular' }));
        } finally {
          setBulkProgress((p) => (p ? { ...p, done: p.done + 1, fails } : p));
        }
      }
    }

    const workers = Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker);
    await Promise.all(workers);

    setBulkRunning(false);

    if (fails === 0) {
      setBulkProgress({ done: ids.length, total: ids.length, fails: 0 });
      setTimeout(() => setBulkProgress(null), 2500);
    } else {
      alert(`${ids.length - fails} OK · ${fails} falhou(aram). Veja o erro em vermelho em cada pedido.`);
      setBulkProgress(null);
    }
  }

  /**
   * Dispara WhatsApp em bloco pros selecionados que já têm preview calculado.
   *
   * Regras importantes:
   *  - Só dispara pra pedidos com preview.success = true
   *  - Pedido dividido em N lojas → abre N abas (uma por loja)
   *  - Cada aba tem NOME ÚNICO (flowops-wa-{wcId}-{storeCode}) pra NÃO sobrescrever
   *    (no individual a gente usa 'flowops-whatsapp' fixo, mas em bulk isso
   *    destruiria a aba anterior antes do user apertar enviar)
   *  - Loja sem WhatsApp cadastrado: pula e conta como falha
   *  - Depois de abrir todas as abas, PATCH status → 'separacao' no WC em paralelo
   *
   * Popup blocker: Chrome geralmente bloqueia o 2º window.open em diante mesmo
   * dentro de um clique. Por isso abrimos com pequeno delay entre cada uma
   * E avisamos o user pra liberar popups do site.
   */
  /**
   * Dispara WhatsApp em bloco via backend Baileys — uma chamada única pra
   * /whatsapp/send-bulk. Backend envia cada mensagem com delay de 2.5s.
   * Se a sessão não estiver ativa, redireciona pra /retaguarda/whatsapp.
   */
  async function bulkDispararWhatsapp() {
    if (selected.size === 0) return;

    const ids = Array.from(selected);

    type Task = { wcId: number; group: SeparationGroup };
    const tasks: Task[] = [];
    const semPreview: number[] = [];
    const comRuptura: number[] = [];
    const semWhatsapp: Array<{ wcId: number; storeName: string }> = [];

    for (const id of ids) {
      const p = preview[id];
      if (!p) { semPreview.push(id); continue; }
      if (!p.success) { comRuptura.push(id); continue; }
      for (const g of p.groups) {
        if (g.whatsapp && g.whatsappMessage) {
          tasks.push({ wcId: id, group: g });
        } else {
          semWhatsapp.push({ wcId: id, storeName: g.storeName });
        }
      }
    }

    if (tasks.length === 0) {
      alert(
        'Nenhum pedido apto pra disparo.\n\n' +
        (semPreview.length ? `· ${semPreview.length} sem separação calculada (clica em "Gerar separação" antes)\n` : '') +
        (comRuptura.length ? `· ${comRuptura.length} em ruptura (sem estoque)\n` : '') +
        (semWhatsapp.length ? `· ${semWhatsapp.length} com loja sem WhatsApp cadastrado` : ''),
      );
      return;
    }

    // Confere se a sessão WhatsApp está ativa antes de disparar
    try {
      const st = await api<{ connected: boolean }>('/whatsapp/status');
      if (!st.connected) {
        if (window.confirm(
          'A integração WhatsApp não está conectada.\n\n' +
          'Quer abrir a tela de conexão agora? (você escaneia 1 QR code e volta aqui)',
        )) {
          window.location.href = '/retaguarda/whatsapp';
        }
        return;
      }
    } catch (e: any) {
      alert('Falha ao consultar status do WhatsApp: ' + (e?.message || e));
      return;
    }

    const resumoExtras =
      (semPreview.length ? `\n· ${semPreview.length} sem separação calculada (serão ignorados)` : '') +
      (comRuptura.length ? `\n· ${comRuptura.length} em ruptura (serão ignorados)` : '') +
      (semWhatsapp.length ? `\n· ${semWhatsapp.length} loja(s) sem WhatsApp (serão ignoradas)` : '');

    if (!window.confirm(
      `Disparar ${tasks.length} mensagem(ns) de WhatsApp e marcar os pedidos como "Separação"?` +
      resumoExtras +
      `\n\n⏳ Uma mensagem a cada ~3 segundos pra evitar spam. ${tasks.length} msgs ≈ ${Math.ceil(tasks.length * 3 / 60)} min.`,
    )) return;

    setBulkRunning(true);
    setBulkProgress({ done: 0, total: tasks.length, fails: 0 });

    // Monta payload pro backend: 1 item por (pedido × loja)
    const items = tasks.map((t) => ({
      number: t.group.whatsapp!,
      text: t.group.whatsappMessage!,
      tag: `${t.wcId}/${t.group.storeCode}`,
    }));

    let sendResult: { total: number; sent: number; failed: Array<{ tag?: string; error: string }> };
    try {
      sendResult = await api('/whatsapp/send-bulk', {
        method: 'POST',
        body: JSON.stringify({ items, delayMs: 2800 }),
      });
    } catch (e: any) {
      setBulkRunning(false);
      setBulkProgress(null);
      alert('Erro no envio em bloco: ' + (e?.message || e));
      return;
    }

    setBulkProgress({ done: sendResult.total, total: sendResult.total, fails: sendResult.failed.length });

    // Pros pedidos cuja TODAS as lojas receberam OK, PATCH status → 'separacao' no WC
    const failedTags = new Set((sendResult.failed || []).map((f) => f.tag || ''));
    const wcIdsOk: number[] = [];
    const wcIdsPartialFail: number[] = [];

    // Agrupa por wcId e verifica se alguma task desse pedido falhou
    const byWcId: Record<number, Task[]> = {};
    for (const t of tasks) {
      (byWcId[t.wcId] ||= []).push(t);
    }
    for (const wcIdStr of Object.keys(byWcId)) {
      const wcId = Number(wcIdStr);
      const anyFailed = byWcId[wcId].some((t) => failedTags.has(`${t.wcId}/${t.group.storeCode}`));
      if (anyFailed) wcIdsPartialFail.push(wcId);
      else wcIdsOk.push(wcId);
    }

    // Muda status no WC pros que foram 100% OK (4 em paralelo)
    const queue = [...wcIdsOk];
    let patchFails = 0;
    async function patchWorker() {
      while (queue.length > 0) {
        const wcId = queue.shift();
        if (wcId == null) break;
        try {
          const lojas = byWcId[wcId]
            .map((t) => `${t.group.storeName} (${t.group.storeCode})`)
            .join(', ');
          await api(`/orders/wc/${wcId}`, {
            method: 'PATCH',
            body: JSON.stringify({
              status: 'separacao',
              addNote: {
                text: `Separação enviada em bloco via WhatsApp pra: ${lojas}.`,
                notifyCustomer: false,
              },
            }),
          });
        } catch (e) {
          patchFails++;
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, wcIdsOk.length) }, patchWorker));

    setBulkRunning(false);

    // Remove da lista local se filtro atual ≠ separacao
    if (status !== 'separacao' && wcIdsOk.length > 0) {
      setOrders((prev) => prev.filter((o) => !wcIdsOk.includes(o.id)));
    } else {
      await load();
    }
    setSelected(new Set());

    if (sendResult.failed.length === 0 && patchFails === 0) {
      setBulkProgress({ done: sendResult.total, total: sendResult.total, fails: 0 });
      setTimeout(() => setBulkProgress(null), 3500);
    } else {
      setBulkProgress(null);
      const detalhes: string[] = [];
      if (sendResult.sent > 0) detalhes.push(`✓ ${sendResult.sent} mensagem(ns) enviada(s)`);
      if (sendResult.failed.length > 0) {
        detalhes.push(`✗ ${sendResult.failed.length} falha(s) de envio:`);
        for (const f of sendResult.failed.slice(0, 5)) {
          detalhes.push(`  · ${f.tag || '?'}: ${f.error}`);
        }
        if (sendResult.failed.length > 5) detalhes.push(`  · … e +${sendResult.failed.length - 5}`);
      }
      if (wcIdsPartialFail.length > 0) detalhes.push(`⚠ ${wcIdsPartialFail.length} pedido(s) com envio parcial — status NÃO foi alterado`);
      if (patchFails > 0) detalhes.push(`⚠ ${patchFails} status falhou(aram) ao atualizar no WC`);
      alert(detalhes.join('\n'));
    }
  }

  /**
   * Muda o status de todos os selecionados em paralelo (4 requests por vez pra não estourar).
   * Pra cada sucesso, remove o pedido da lista local (se o filtro atual não for o status destino).
   */
  async function bulkChangeStatus(targetSlug: string) {
    if (selected.size === 0) return;

    const ids = Array.from(selected);
    const targetLabel = BULK_TARGETS.find((t) => t.slug === targetSlug)?.label ?? targetSlug;

    if (!window.confirm(
      `Mudar ${ids.length} pedido(s) pra "${targetLabel}"?\n\nIsso grava DIRETO no WooCommerce.`,
    )) return;

    setBulkRunning(true);
    setBulkProgress({ done: 0, total: ids.length, fails: 0 });

    const CONCURRENCY = 4;
    const queue = [...ids];
    const success: number[] = [];
    const fails: Array<{ id: number; error: string }> = [];

    async function worker() {
      while (queue.length > 0) {
        const id = queue.shift();
        if (id == null) break;
        try {
          const res = await api<{ ok: boolean; warning?: string; statusApplied?: boolean }>(
            `/orders/wc/${id}`,
            {
              method: 'PATCH',
              body: JSON.stringify({
                status: targetSlug,
                addNote: {
                  text: `Status alterado em bloco pra "${targetLabel}" via LURDS ORDER ONE.`,
                  notifyCustomer: false,
                },
              }),
            },
          );
          if (res.ok || res.statusApplied) {
            success.push(id);
          } else {
            fails.push({ id, error: res.warning || 'WC rejeitou a alteração' });
          }
        } catch (e: any) {
          fails.push({ id, error: e?.message || 'Falha de rede' });
        } finally {
          setBulkProgress((p) => (p ? { ...p, done: p.done + 1, fails: fails.length } : p));
        }
      }
    }

    const workers = Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker);
    await Promise.all(workers);

    setBulkRunning(false);

    // Remove da lista local os que mudaram com sucesso (se o filtro atual diferente do destino)
    if (status !== targetSlug) {
      setOrders((prev) => prev.filter((o) => !success.includes(o.id)));
    } else {
      await load();
    }
    setSelected(new Set());

    // Feedback
    if (fails.length === 0) {
      setBulkProgress({ done: ids.length, total: ids.length, fails: 0 });
      setTimeout(() => setBulkProgress(null), 2500);
    } else {
      const firstErr = fails[0].error;
      alert(
        `${success.length} OK · ${fails.length} falhou(aram).\n\nPrimeiro erro: ${firstErr}`,
      );
      setBulkProgress(null);
    }
  }

  async function load() {
    try {
      const q = new URLSearchParams({ status, per_page: '50' });
      if (search) q.set('search', search);
      const res = await api<{ data: WcOrderListItem[] }>(`/orders/wc?${q}`);
      setOrders(res.data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }

  async function calcular(wcId: number) {
    setBusy((b) => ({ ...b, [wcId]: true }));
    setErrorByOrder((e) => ({ ...e, [wcId]: '' }));
    try {
      const res = await api<SeparationPreview>(`/orders/wc/${wcId}/prepare-separation`);
      setPreview((p) => ({ ...p, [wcId]: res }));
      setExpanded((x) => ({ ...x, [wcId]: true }));
    } catch (e: any) {
      setErrorByOrder((er) => ({ ...er, [wcId]: e.message }));
    } finally {
      setBusy((b) => ({ ...b, [wcId]: false }));
    }
  }

  async function dispararWhatsapp(wcId: number, grupo: SeparationGroup) {
    if (!grupo.whatsapp || !grupo.whatsappMessage) {
      alert(
        `A loja "${grupo.storeName}" não tem WhatsApp. Cadastra em /lojas antes de disparar.`,
      );
      return;
    }

    // Usa a integração backend (Baileys). Se não estiver conectada, oferece
    // abrir a tela de conexão pra escanear QR code.
    setBusy((b) => ({ ...b, [wcId]: true }));
    try {
      // Verifica sessão ativa antes de mandar
      const st = await api<{ connected: boolean }>('/whatsapp/status');
      if (!st.connected) {
        if (window.confirm(
          'A integração WhatsApp não está conectada.\n\n' +
          'Quer abrir a tela de conexão agora?',
        )) {
          window.location.href = '/retaguarda/whatsapp';
        }
        return;
      }

      // Envia
      const r = await api<{ ok: boolean; error?: string }>('/whatsapp/send', {
        method: 'POST',
        body: JSON.stringify({ number: grupo.whatsapp, text: grupo.whatsappMessage }),
      });
      if (!r.ok) {
        alert(`Falha no envio: ${r.error || 'erro desconhecido'}`);
        return;
      }

      // Marca como "Separação" no WC + nota interna
      await api(`/orders/wc/${wcId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          status: 'separacao',
          addNote: {
            text: `Separação enviada via WhatsApp pra loja ${grupo.storeName} (${grupo.storeCode}).`,
            notifyCustomer: false,
          },
        }),
      });

      if (status !== 'separacao') {
        setOrders((prev) => prev.filter((o) => o.id !== wcId));
      } else {
        await load();
      }
    } catch (e: any) {
      alert('Erro ao disparar WhatsApp: ' + (e?.message || e));
    } finally {
      setBusy((b) => ({ ...b, [wcId]: false }));
    }
  }

  function toggleExpanded(wcId: number) {
    setExpanded((x) => ({ ...x, [wcId]: !x[wcId] }));
  }

  function fmtDate(iso: string) {
    if (!iso) return '—';
    const d = new Date(iso.endsWith('Z') ? iso : iso + 'Z');
    const min = Math.floor((Date.now() - d.getTime()) / 60000);
    if (min < 1) return 'agora';
    if (min < 60) return `${min}min`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h}h`;
    return `${Math.floor(h / 24)}d`;
  }

  function fmtMoney(v: string) {
    return `R$ ${Number(v || 0).toFixed(2).replace('.', ',')}`;
  }

  return (
    <div className="max-w-7xl mx-auto p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Package className="w-6 h-6" /> Emissão de Separações
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Central de roteamento — cada pedido é direcionado pra loja que tem estoque e disparado via WhatsApp.
          </p>
        </div>
        <button
          onClick={load}
          className="px-3 py-2 bg-white border rounded hover:bg-slate-50 flex items-center gap-2 text-sm"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Atualizar
        </button>
      </div>

      {/* Filtros de status */}
      <div className="flex flex-wrap gap-2 mb-4">
        {FILTROS.map((f) => (
          <button
            key={f.slug}
            onClick={() => setStatus(f.slug)}
            className={`px-3 py-1.5 rounded text-sm border transition ${
              status === f.slug
                ? 'bg-brand text-white border-brand'
                : 'bg-white hover:bg-slate-50'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Busca */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setSearch(searchInput.trim());
        }}
        className="mb-4 flex gap-2"
      >
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Buscar por nº do pedido, nome ou email..."
            className="w-full pl-9 pr-3 py-2 border rounded text-sm"
          />
        </div>
        <button type="submit" className="px-4 py-2 border rounded hover:bg-slate-50 text-sm">
          Buscar
        </button>
        {search && (
          <button
            type="button"
            onClick={() => { setSearchInput(''); setSearch(''); }}
            className="px-3 py-2 text-sm text-slate-500 hover:text-slate-800"
          >
            Limpar
          </button>
        )}
      </form>

      {/* Barra de seleção em bloco — SEMPRE VISÍVEL quando há pedidos */}
      {orders.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3 bg-white border rounded-lg p-3 shadow-sm">
          <div className="flex items-center gap-3">
            <button
              onClick={toggleAll}
              className={`flex items-center gap-2 px-4 py-2 rounded font-semibold text-sm transition ${
                selected.size === orders.length
                  ? 'bg-brand text-white hover:bg-brand-dark'
                  : 'bg-brand text-white hover:bg-brand-dark'
              }`}
              title="Selecionar/desmarcar todos os pedidos da lista"
            >
              {selected.size === orders.length ? (
                <>
                  <CheckSquare className="w-5 h-5" /> Desmarcar todos
                </>
              ) : (
                <>
                  <Square className="w-5 h-5" /> Marcar todos ({orders.length})
                </>
              )}
            </button>

            {selected.size > 0 && selected.size < orders.length && (
              <button
                onClick={clearSelection}
                className="text-sm text-slate-500 hover:text-slate-800 underline"
              >
                Limpar seleção
              </button>
            )}
          </div>

          <div className="text-sm text-slate-600">
            {loading ? (
              'Carregando...'
            ) : (
              <>
                <span className="font-semibold">{orders.length}</span> pedido(s) na fila
                {selected.size > 0 && (
                  <span className="ml-2 text-brand font-bold">
                    · {selected.size} selecionado(s)
                  </span>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {!orders.length && !loading && (
        <div className="text-sm text-slate-500 mb-3">0 pedido(s) na fila</div>
      )}

      {/* Lista */}
      {!loading && orders.length === 0 ? (
        <div className="bg-white rounded-lg shadow p-8 text-center text-slate-400">
          Nenhum pedido com esse status no momento. 🎉
        </div>
      ) : (
        <div className="space-y-2">
          {orders.map((o) => {
            const p = preview[o.id];
            const err = errorByOrder[o.id];
            const isBusy = busy[o.id];
            const isExpanded = expanded[o.id];

            const isChecked = selected.has(o.id);

            return (
              <div
                key={o.id}
                className={`bg-white rounded shadow overflow-hidden transition ${
                  isChecked ? 'ring-2 ring-brand' : ''
                }`}
              >
                {/* Linha principal */}
                <div className="flex items-center p-4 gap-3">
                  {/* Checkbox de seleção em bloco */}
                  <label
                    className="p-1 cursor-pointer shrink-0"
                    title={isChecked ? 'Remover da seleção' : 'Adicionar à seleção'}
                  >
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => toggleOne(o.id)}
                      className="w-4 h-4 accent-brand cursor-pointer"
                    />
                  </label>

                  <button
                    onClick={() => toggleExpanded(o.id)}
                    className="text-slate-400 hover:text-slate-700 p-1"
                    title={isExpanded ? 'Recolher' : 'Expandir'}
                  >
                    {isExpanded ? <ChevronDown className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
                  </button>

                  <div className="flex-1 grid grid-cols-12 gap-3 items-center text-sm">
                    <div className="col-span-2">
                      <Link
                        href={`/pedidos/wc/${o.id}`}
                        className="font-mono font-semibold text-brand hover:underline"
                      >
                        #{o.number}
                      </Link>
                      <div className="text-xs text-slate-500">{fmtDate(o.dateCreatedGmt)} atrás</div>
                    </div>
                    <div className="col-span-4 truncate">{o.customerName || '—'}</div>
                    <div className="col-span-2 font-mono text-right">{fmtMoney(o.total)}</div>
                    <div className="col-span-4 flex justify-end gap-2">
                      {!p && (
                        <>
                          <button
                            onClick={() => imprimirPedido(o.id)}
                            className="px-2.5 py-1.5 bg-white border border-slate-300 text-slate-700 rounded hover:bg-slate-50 text-sm flex items-center gap-1.5"
                            title="Imprimir ordem de separação"
                          >
                            <Printer className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => calcular(o.id)}
                            disabled={isBusy}
                            className="px-3 py-1.5 bg-emerald-600 text-white rounded hover:bg-emerald-700 text-sm disabled:opacity-50 flex items-center gap-1.5"
                          >
                            {isBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <StoreIcon className="w-3.5 h-3.5" />}
                            Preparar separação
                          </button>
                        </>
                      )}
                      {p && p.success && p.groups.length === 1 && (
                        <button
                          onClick={() => dispararWhatsapp(o.id, p.groups[0])}
                          disabled={isBusy || !p.groups[0].whatsapp}
                          className="px-3 py-1.5 bg-green-600 text-white rounded hover:bg-green-700 text-sm disabled:opacity-50 flex items-center gap-1.5"
                          title={p.groups[0].whatsapp ? `Enviar pra ${p.groups[0].storeName}` : 'Loja sem WhatsApp cadastrado'}
                        >
                          {isBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                          WhatsApp → {p.groups[0].storeName}
                        </button>
                      )}
                      {p && p.success && p.groups.length > 1 && (
                        <span className="px-3 py-1.5 bg-amber-100 text-amber-800 rounded text-xs font-medium">
                          Dividido em {p.groups.length} lojas (expande pra ver)
                        </span>
                      )}
                      {p && !p.success && (
                        <span className="px-3 py-1.5 bg-red-100 text-red-800 rounded text-xs font-medium flex items-center gap-1">
                          <AlertTriangle className="w-3.5 h-3.5" /> Ruptura
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {err && (
                  <div className="px-4 pb-3 text-xs text-red-700 bg-red-50">{err}</div>
                )}

                {/* Área expandida */}
                {isExpanded && p && (
                  <div className="bg-slate-50 border-t px-4 py-3">
                    <div className="text-xs text-slate-500 mb-2">
                      <b>Envio:</b> {p.shippingMethod}
                    </div>

                    {p.missing.length > 0 && (
                      <div className="bg-red-50 border border-red-200 rounded p-3 mb-3 text-sm">
                        <div className="font-medium text-red-800 mb-1 flex items-center gap-1">
                          <AlertTriangle className="w-4 h-4" /> Itens sem estoque em nenhuma loja:
                        </div>
                        <ul className="text-red-700 space-y-0.5">
                          {p.missing.map((m) => (
                            <li key={m.sku}>• {m.quantity}× {m.productName} <span className="font-mono text-xs">({m.sku})</span></li>
                          ))}
                        </ul>
                      </div>
                    )}

                    <div className="grid gap-2">
                      {p.groups.map((g, idx) => (
                        <div key={g.storeId + idx} className="bg-white border rounded p-3">
                          <div className="flex items-center justify-between mb-2">
                            <div>
                              <div className="font-semibold text-sm flex items-center gap-2">
                                <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                                {g.storeName}
                                <span className="font-mono text-xs text-slate-500">({g.storeCode})</span>
                              </div>
                              <div className="text-xs text-slate-500 mt-0.5">
                                {[g.storeCity, g.storeState].filter(Boolean).join(' / ') || '—'}
                                {g.whatsapp ? ` · 📱 ${g.whatsapp}` : ' · ⚠ sem WhatsApp'}
                                · {g.items.length} item(ns)
                              </div>
                            </div>
                            <div className="flex gap-1.5">
                              <button
                                onClick={() => imprimirPedido(o.id)}
                                className="px-3 py-1.5 bg-slate-700 text-white rounded hover:bg-slate-800 text-sm flex items-center gap-1.5"
                                title="Imprimir ordem de separação (térmica 80mm)"
                              >
                                <Printer className="w-3.5 h-3.5" /> Imprimir
                              </button>
                              <button
                                onClick={() => dispararWhatsapp(o.id, g)}
                                disabled={!g.whatsapp || isBusy}
                                className="px-3 py-1.5 bg-green-600 text-white rounded hover:bg-green-700 text-sm disabled:opacity-40 flex items-center gap-1.5"
                              >
                                <Send className="w-3.5 h-3.5" /> WhatsApp
                              </button>
                            </div>
                          </div>
                          <ul className="text-xs text-slate-600 space-y-0.5 pl-5">
                            {g.items.map((it) => (
                              <li key={it.sku}>
                                {it.quantity}× {it.productName}{' '}
                                <span className="font-mono text-slate-400">({it.sku})</span>
                                {it.variant && <span className="text-slate-500"> · {it.variant}</span>}
                              </li>
                            ))}
                          </ul>
                          <details className="mt-2 text-xs text-slate-500">
                            <summary className="cursor-pointer hover:text-slate-700">
                              Ver mensagem do WhatsApp
                            </summary>
                            <pre className="bg-slate-50 p-2 rounded mt-1 whitespace-pre-wrap font-sans text-slate-700">
                              {g.whatsappMessage}
                            </pre>
                          </details>
                        </div>
                      ))}
                    </div>

                    {/* Ranking de lojas — transparência da decisão */}
                    {p.scoreBreakdown && p.scoreBreakdown.length > 0 && (
                      <details className="mt-3 bg-white border rounded p-2">
                        <summary className="cursor-pointer text-xs font-medium text-slate-700 hover:text-slate-900 select-none">
                          Por que essa(s) loja(s)? Ver ranking ({p.scoreBreakdown.length} lojas avaliadas)
                        </summary>
                        <div className="mt-2 overflow-x-auto">
                          <table className="w-full text-xs">
                            <thead className="text-slate-500 border-b">
                              <tr>
                                <th className="text-left font-medium py-1.5 px-2">Loja</th>
                                <th className="text-center font-medium py-1.5 px-2" title="Menor ratio disponível/necessário entre os itens. 0 = falta item, 3+ = sobra de estoque.">Folga</th>
                                <th className="text-center font-medium py-1.5 px-2" title="Folga normalizada (0..1)">Estoque</th>
                                <th className="text-center font-medium py-1.5 px-2" title="Proximidade com CEP do cliente (0..1)">Dist.</th>
                                <th className="text-center font-medium py-1.5 px-2" title="Prioridade manual cadastrada (0..1)">Prio.</th>
                                <th className="text-center font-medium py-1.5 px-2" title="Score composto final">Final</th>
                                <th className="text-center font-medium py-1.5 px-2">Cobre tudo?</th>
                              </tr>
                            </thead>
                            <tbody>
                              {p.scoreBreakdown
                                .slice()
                                .sort((a, b) => b.finalScore - a.finalScore)
                                .map((s, i) => {
                                  const chosen = p.groups.some((g) => g.storeCode === s.storeCode);
                                  return (
                                    <tr
                                      key={s.storeCode}
                                      className={`border-b last:border-0 ${chosen ? 'bg-emerald-50' : ''}`}
                                    >
                                      <td className="py-1.5 px-2">
                                        {chosen && <span className="text-emerald-600 mr-1">✓</span>}
                                        <span className={chosen ? 'font-semibold' : ''}>
                                          {s.storeName}
                                        </span>
                                        <span className="font-mono text-slate-400 ml-1">({s.storeCode})</span>
                                      </td>
                                      <td className="text-center py-1.5 px-2 font-mono">
                                        {s.stockBuffer === 0 ? (
                                          <span className="text-red-500">0</span>
                                        ) : s.stockBuffer >= 3 ? (
                                          <span className="text-emerald-600 font-semibold">{s.stockBuffer.toFixed(1)}+</span>
                                        ) : (
                                          s.stockBuffer.toFixed(2)
                                        )}
                                      </td>
                                      <td className="text-center py-1.5 px-2 font-mono text-slate-600">
                                        {s.stockBufferScore.toFixed(2)}
                                      </td>
                                      <td className="text-center py-1.5 px-2 font-mono text-slate-600">
                                        {s.distanceScore.toFixed(2)}
                                      </td>
                                      <td className="text-center py-1.5 px-2 font-mono text-slate-600">
                                        {s.priorityScore.toFixed(2)}
                                      </td>
                                      <td className="text-center py-1.5 px-2 font-mono font-semibold">
                                        {s.finalScore.toFixed(3)}
                                      </td>
                                      <td className="text-center py-1.5 px-2">
                                        {s.fullCoverage ? (
                                          <span className="text-emerald-600">✓</span>
                                        ) : (
                                          <span className="text-slate-300">—</span>
                                        )}
                                      </td>
                                    </tr>
                                  );
                                })}
                            </tbody>
                          </table>
                          <div className="mt-2 text-[10px] text-slate-400 leading-relaxed">
                            <b>Folga</b> = menor razão disponível/necessário (elo mais fraco do pedido). 1 = tem exato, 2 = tem o dobro, 3+ = caldeirão.
                            Pesos: estoque 45% · distância 30% · prioridade 25%.
                          </div>
                        </div>
                      </details>
                    )}

                    <div className="mt-3 flex gap-2 text-xs">
                      <button
                        onClick={() => calcular(o.id)}
                        disabled={isBusy}
                        className="text-slate-500 hover:text-slate-800 underline"
                      >
                        Recalcular
                      </button>
                      <span className="text-slate-300">·</span>
                      <Link
                        href={`/pedidos/wc/${o.id}`}
                        className="text-slate-500 hover:text-slate-800 underline flex items-center gap-1"
                      >
                        Abrir pedido completo <ExternalLink className="w-3 h-3" />
                      </Link>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* BARRA DE AÇÃO EM BLOCO — aparece quando tem pedidos selecionados */}
      {selected.size > 0 && (
        <div className="fixed bottom-0 left-0 right-0 z-40 pointer-events-none">
          <div className="max-w-7xl mx-auto px-6 pb-4">
            <div className="pointer-events-auto bg-slate-900 text-white rounded-xl shadow-2xl p-4 flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <CheckSquare className="w-5 h-5 text-emerald-400" />
                {selected.size} pedido(s) selecionado(s)
              </div>

              <div className="h-6 w-px bg-slate-700 hidden sm:block" />

              <button
                onClick={bulkPrepareSeparation}
                disabled={bulkRunning}
                className="px-3 py-1.5 rounded text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 flex items-center gap-1.5"
                title="Calcula a loja que vai separar cada pedido selecionado"
              >
                {bulkRunning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <StoreIcon className="w-3.5 h-3.5" />}
                Gerar separação ({selected.size})
              </button>

              <button
                onClick={bulkDispararWhatsapp}
                disabled={bulkRunning}
                className="px-3 py-1.5 rounded text-sm font-semibold text-white bg-green-600 hover:bg-green-700 disabled:opacity-50 flex items-center gap-1.5"
                title="Dispara as mensagens direto pelo backend (precisa ter Gerado separação antes e WhatsApp conectado em /retaguarda/whatsapp)"
              >
                {bulkRunning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                Disparar WhatsApp ({selected.size})
              </button>

              <button
                onClick={imprimirSelecionados}
                disabled={bulkRunning}
                className="px-3 py-1.5 rounded text-sm font-medium text-white bg-slate-700 hover:bg-slate-600 disabled:opacity-50 flex items-center gap-1.5"
                title="Imprimir ordens de separação (térmica 80mm)"
              >
                <Printer className="w-3.5 h-3.5" /> Imprimir ({selected.size})
              </button>

              <div className="h-6 w-px bg-slate-700 hidden sm:block" />

              <div className="text-xs text-slate-400 mr-1 hidden md:block">
                Mudar status pra:
              </div>

              {BULK_TARGETS.filter((t) => t.slug !== status).map((t) => (
                <button
                  key={t.slug}
                  onClick={() => bulkChangeStatus(t.slug)}
                  disabled={bulkRunning}
                  className={`px-3 py-1.5 rounded text-sm font-medium text-white disabled:opacity-50 flex items-center gap-1.5 ${t.color}`}
                >
                  {bulkRunning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                  {t.label}
                </button>
              ))}

              <div className="flex-1" />

              {bulkProgress && (
                <div className="text-xs text-slate-300">
                  {bulkProgress.done}/{bulkProgress.total}
                  {bulkProgress.fails > 0 && (
                    <span className="text-red-400 ml-1">· {bulkProgress.fails} falha(s)</span>
                  )}
                </div>
              )}

              <button
                onClick={clearSelection}
                disabled={bulkRunning}
                className="p-1.5 rounded hover:bg-slate-800 disabled:opacity-50"
                title="Limpar seleção"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
