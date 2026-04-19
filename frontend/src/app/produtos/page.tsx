'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { RefreshCw, Search, ChevronDown, ChevronRight, Package, ExternalLink, AlertTriangle, CloudCog, X, CheckCircle2, XCircle, FileDown, ShieldCheck, History, Archive } from 'lucide-react';

/**
 * Tela /produtos — listagem ao vivo do catálogo WooCommerce.
 *
 * Mostra: foto, nome, SKU, preço, estoque.
 * Produtos VARIÁVEIS podem ser expandidos pra ver todas as variações (SKU + qtd + preço).
 * Dados vêm do proxy /products do FlowOps (que consulta /wc/v3/products).
 */

interface Product {
  id: number;
  name: string;
  slug: string;
  sku: string | null;
  type: 'simple' | 'variable' | 'grouped' | 'external';
  status: string;
  permalink: string;
  price: number | null;
  regularPrice: number | null;
  salePrice: number | null;
  stockQuantity: number | null;
  stockStatus: 'instock' | 'outofstock' | 'onbackorder';
  manageStock: boolean;
  totalSales: number;
  image: string | null;
  categories: string[];
  dateModified: string;
  variationsCount: number;
}

interface Variation {
  id: number;
  sku: string | null;
  price: number | null;
  regularPrice: number | null;
  salePrice: number | null;
  stockQuantity: number | null;
  stockStatus: 'instock' | 'outofstock' | 'onbackorder';
  manageStock: boolean;
  attributes: Array<{ name: string; option: string }>;
  image: string | null;
  erpStock: number | null; // estoque consolidado do gigasistemas21
  erpSku: string | null;   // SKU encontrado no ERP (null = não encontrado)
}

interface ProductDetail extends Product {
  description: string;
  shortDescription: string;
  tags: string[];
  images: Array<{ src: string; alt: string }>;
  attributes: Array<{ name: string; options: string[] }>;
  variations: Variation[];
  variationsStockSum: number | null;
  variationsErpStockSum: number | null;
  erpStock: number | null;
  erpSku: string | null; // SKU encontrado no ERP (null = não encontrado)
}

interface BulkSyncState {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  // Pre-scan (fase 1)
  prescanRunning: boolean;
  prescanFinished: boolean;
  prescanTotalProducts: number;
  prescanProcessed: number;
  productsAlreadySynced: number;
  // Fase 3 — auto-rascunho por estoque baixo
  lowStockDraftRunning: boolean;
  lowStockDraftFinished: boolean;
  lowStockThreshold: number;
  lowStockCandidates: number;
  productsMarkedDraft: number;
  lowStockDraftFailed: number;
  // Loop principal (fase 2)
  totalProducts: number;
  processed: number;
  currentProductId: number | null;
  currentProductName: string | null;
  variationsUpdated: number;
  variationsUnchanged: number;
  variationsFailed: number;
  variationsSkipped: number;
  productsFailed: number;
  parentsFixedStandalone: number;
  lastError: string | null;
  backupFilename: string | null;
  backupVariationsCount: number;
  recentLog: Array<{
    productId: number;
    name: string;
    updated: number;
    failed: number;
    skipped: number;
    success: boolean;
    error?: string;
  }>;
}

interface SyncReport {
  productId: number;
  productName: string;
  productSku: string | null;
  totalVariations: number;
  variationsUpdated: number;
  variationsUnchanged: number;
  variationsFailed: number;
  variationsSkipped: number;
  parentBefore: number;
  totalBefore: number;
  totalAfter: number;
  parentUpdated: boolean;
  parentNeedsUpdate: boolean;
  parentOnlyFix: boolean;
  parentError: string | null;
  details: Array<{
    variationId: number;
    sku: string | null;
    attributes: Array<{ name: string; option: string }>;
    before: number | null;
    after: number | null;
    success: boolean;
    skipped?: boolean;
    unchanged?: boolean;
    reason?: string;
    error?: string;
  }>;
  finishedAt: string;
}

const WC_ADMIN_URL = 'https://www.lurds.com.br/wp-admin/post.php?action=edit&post=';

const STOCK_FILTERS: Array<{ slug: '' | 'instock' | 'outofstock' | 'onbackorder'; label: string; color: string }> = [
  { slug: '',             label: 'Todos',           color: '' },
  { slug: 'instock',      label: 'Em estoque',      color: 'text-emerald-700' },
  { slug: 'outofstock',   label: 'Sem estoque',     color: 'text-red-700' },
  { slug: 'onbackorder',  label: 'Sob encomenda',   color: 'text-amber-700' },
];

export default function ProdutosPage() {
  const [data, setData] = useState<Product[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [stockStatus, setStockStatus] = useState<'' | 'instock' | 'outofstock' | 'onbackorder'>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Cache de detalhes expandidos: { [productId]: ProductDetail | 'loading' }
  const [expanded, setExpanded] = useState<Record<number, ProductDetail | 'loading' | 'error'>>({});

  // Estado da sincronização de estoque ERP → WC
  const [syncConfirm, setSyncConfirm] = useState<{ step: 1 | 2; product: ProductDetail } | null>(null);
  const [syncRunning, setSyncRunning] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncReport | null>(null);

  // Sync em MASSA (todos produtos). Backup é gerado DURANTE o sync (inline).
  const [bulkState, setBulkState] = useState<BulkSyncState | null>(null);
  const [bulkConfirm, setBulkConfirm] = useState<1 | 2 | null>(null);
  // Flag pra disparar download automático do backup quando termina
  const [bulkBackupDownloaded, setBulkBackupDownloaded] = useState<string | null>(null);
  const [backupState, setBackupState] = useState<{
    running: boolean;
    startedAt: string | null;
    finishedAt: string | null;
    totalProducts: number;
    processed: number;
    currentProductName: string | null;
    variationsCount: number;
    filename: string | null;
    savedPath: string | null;
    error: string | null;
  } | null>(null);
  const [backupDone, setBackupDone] = useState<{ filename: string; products: number; variations: number } | null>(null);

  // Restore (pra caso de emergência)
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [restoreRunning, setRestoreRunning] = useState(false);
  const [restoreResult, setRestoreResult] = useState<{ variationsRestored: number; variationsFailed: number; productsUpdated: number; details: any[] } | null>(null);

  // Preview de produtos a draftear (estoque baixo)
  interface LowStockItem {
    productId: number;
    name: string;
    stockQuantity: number | null;
    type: string;
    applied: boolean;
    error?: string;
  }
  interface LowStockResult {
    threshold: number;
    scannedProducts: number;
    candidates: number;
    success: number;
    failed: number;
    items: LowStockItem[];
  }
  const [lowStockOpen, setLowStockOpen] = useState(false);
  const [lowStockLoading, setLowStockLoading] = useState(false);
  const [lowStockApplying, setLowStockApplying] = useState(false);
  const [lowStockThreshold, setLowStockThreshold] = useState(5);
  const [lowStockData, setLowStockData] = useState<LowStockResult | null>(null);
  const [lowStockApplyResult, setLowStockApplyResult] = useState<LowStockResult | null>(null);
  const [lowStockSearch, setLowStockSearch] = useState('');

  useEffect(() => { load(); /* eslint-disable-line */ }, [page, search, stockStatus]);

  // Polling do bulk sync a cada 2s
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const s = await api<BulkSyncState>('/products/sync-all-stock-from-erp/status');
        if (cancelled) return;
        setBulkState(s);
        // Se acabou de rodar, recarrega a lista pra refletir novos estoques
        if (bulkState?.running && !s.running && s.finishedAt) {
          load();
          // Auto-download do backup (gerado inline durante o sync)
          if (s.backupFilename && bulkBackupDownloaded !== s.backupFilename) {
            setBulkBackupDownloaded(s.backupFilename);
            downloadBackupFile(s.backupFilename).catch(() => {});
          }
        }
      } catch {
        // silencia — pode ser 401 durante refresh de token
      }
    }
    poll(); // primeira leitura imediata
    const id = setInterval(poll, 2000);
    return () => { cancelled = true; clearInterval(id); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bulkState?.running]);

  // Polling do backup a cada 1s (só quando está rodando)
  useEffect(() => {
    if (!backupState?.running) return;
    let cancelled = false;
    async function poll() {
      try {
        const s = await api<NonNullable<typeof backupState>>('/products/stock-backup/status');
        if (cancelled) return;
        setBackupState(s);
        // Quando finaliza, auto-download e marca backupDone
        if (!s.running && s.filename && !s.error) {
          await downloadBackupFile(s.filename);
          setBackupDone({
            filename: s.filename,
            products: s.totalProducts,
            variations: s.variationsCount,
          });
        }
        if (s.error) {
          alert(`Falha no backup: ${s.error}`);
        }
      } catch {
        // silencia
      }
    }
    poll();
    const id = setInterval(poll, 1000);
    return () => { cancelled = true; clearInterval(id); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backupState?.running]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const q = new URLSearchParams();
      q.set('page', String(page));
      q.set('per_page', '50');
      if (search) q.set('search', search);
      if (stockStatus) q.set('stock_status', stockStatus);
      const res = await api<{ data: Product[]; total: number; totalPages: number }>(`/products?${q}`);
      setData(res.data);
      setTotal(res.total);
      setTotalPages(res.totalPages);
      // Reset dos expandidos ao mudar a lista
      setExpanded({});
    } catch (e: any) {
      setError(`Falha ao consultar WooCommerce: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }

  async function toggleExpand(p: Product) {
    // Produto simples não tem variações — só expande produto variável
    if (p.type !== 'variable') return;

    const current = expanded[p.id];
    if (current && current !== 'loading' && current !== 'error') {
      // Fechar
      const copy = { ...expanded };
      delete copy[p.id];
      setExpanded(copy);
      return;
    }

    // Abrir + buscar detalhe
    setExpanded({ ...expanded, [p.id]: 'loading' });
    try {
      const detail = await api<ProductDetail>(`/products/${p.id}`);
      setExpanded((prev) => ({ ...prev, [p.id]: detail }));
    } catch {
      setExpanded((prev) => ({ ...prev, [p.id]: 'error' }));
    }
  }

  function onSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPage(1);
    setSearch(searchInput.trim());
  }

  async function startBackup() {
    try {
      setBackupDone(null);
      const s = await api<typeof backupState>('/products/stock-backup/start', { method: 'POST' });
      setBackupState(s);
    } catch (e: any) {
      alert(`Falha ao iniciar backup: ${e?.message ?? 'erro desconhecido'}`);
    }
  }

  async function downloadBackupFile(filename: string) {
    try {
      const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_token') : null;
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
      const res = await fetch(`${apiUrl}/api/products/stock-backup/download/${filename}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e: any) {
      alert(`Falha ao baixar backup: ${e?.message ?? 'erro desconhecido'}`);
    }
  }

  async function startBulkSync() {
    try {
      const s = await api<BulkSyncState>('/products/sync-all-stock-from-erp', { method: 'POST' });
      setBulkState(s);
      setBulkConfirm(null);
      setBulkBackupDownloaded(null); // libera pra baixar o próximo backup
    } catch (e: any) {
      alert(`Falha ao iniciar sync em massa: ${e?.message ?? 'erro desconhecido'}`);
    }
  }

  async function restoreFromBackupFile(file: File) {
    setRestoreRunning(true);
    setRestoreResult(null);
    try {
      const arrayBuffer = await file.arrayBuffer();
      // Converte pra base64 em chunks pra evitar stack overflow em arquivos grandes
      const bytes = new Uint8Array(arrayBuffer);
      let binary = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)) as any);
      }
      const fileBase64 = btoa(binary);

      const result = await api<{ variationsRestored: number; variationsFailed: number; productsUpdated: number; details: any[] }>(
        '/products/restore-stock',
        {
          method: 'POST',
          body: JSON.stringify({ fileBase64 }),
        },
      );
      setRestoreResult(result);
      load();
    } catch (e: any) {
      alert(`Falha ao restaurar: ${e?.message ?? 'erro desconhecido'}`);
    } finally {
      setRestoreRunning(false);
    }
  }

  async function loadLowStockPreview(threshold: number) {
    setLowStockLoading(true);
    setLowStockData(null);
    setLowStockApplyResult(null);
    try {
      const result = await api<LowStockResult>(
        `/products/draft-low-stock/preview?threshold=${threshold}`,
      );
      setLowStockData(result);
    } catch (e: any) {
      alert(`Falha ao carregar preview: ${e?.message ?? 'erro desconhecido'}`);
    } finally {
      setLowStockLoading(false);
    }
  }

  async function applyLowStockDraft(threshold: number) {
    // Dupla confirmação — irreversível em massa.
    const first = window.confirm(
      `Vou marcar como RASCUNHO todos os produtos publicados com estoque total < ${threshold}.\n\nTem certeza?`,
    );
    if (!first) return;
    const second = window.confirm(
      `CONFIRMAÇÃO FINAL.\n\n${lowStockData?.candidates ?? '?'} produto(s) serão arquivados (sairão do ar).\n\nConfirmar?`,
    );
    if (!second) return;

    setLowStockApplying(true);
    setLowStockApplyResult(null);
    try {
      const result = await api<LowStockResult>(
        `/products/draft-low-stock/apply?threshold=${threshold}`,
        { method: 'POST' },
      );
      setLowStockApplyResult(result);
      // Recarrega a listagem pra refletir os novos status.
      load();
    } catch (e: any) {
      alert(`Falha ao aplicar: ${e?.message ?? 'erro desconhecido'}`);
    } finally {
      setLowStockApplying(false);
    }
  }

  async function runSyncFromErp(productId: number) {
    setSyncRunning(true);
    setSyncResult(null);
    try {
      const report = await api<SyncReport>(`/products/${productId}/sync-stock-from-erp`, {
        method: 'POST',
      });
      setSyncResult(report);
      // Reabre o detalhe pra refletir os valores novos
      setExpanded((prev) => ({ ...prev, [productId]: 'loading' }));
      try {
        const fresh = await api<ProductDetail>(`/products/${productId}`);
        setExpanded((prev) => ({ ...prev, [productId]: fresh }));
      } catch {
        setExpanded((prev) => ({ ...prev, [productId]: 'error' }));
      }
    } catch (e: any) {
      setSyncResult({
        productId,
        productName: '',
        productSku: null,
        totalVariations: 0,
        variationsUpdated: 0,
        variationsUnchanged: 0,
        variationsFailed: 0,
        variationsSkipped: 0,
        parentBefore: 0,
        totalBefore: 0,
        totalAfter: 0,
        parentUpdated: false,
        parentNeedsUpdate: false,
        parentOnlyFix: false,
        parentError: e?.message ?? 'Falha desconhecida',
        details: [],
        finishedAt: new Date().toISOString(),
      });
    } finally {
      setSyncRunning(false);
      setSyncConfirm(null);
    }
  }

  function fmtMoney(v: number | null | undefined) {
    if (v == null || isNaN(v)) return '—';
    return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  function stockBadge(p: { stockStatus: string; stockQuantity: number | null }) {
    if (p.stockStatus === 'outofstock') {
      return <span className="px-2 py-0.5 rounded text-xs bg-red-100 text-red-700 font-medium">Esgotado</span>;
    }
    if (p.stockStatus === 'onbackorder') {
      return <span className="px-2 py-0.5 rounded text-xs bg-amber-100 text-amber-700 font-medium">Sob encomenda</span>;
    }
    // instock
    if (p.stockQuantity != null) {
      const color = p.stockQuantity <= 5 ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-800';
      return <span className={`px-2 py-0.5 rounded text-xs font-medium ${color}`}>{p.stockQuantity} un</span>;
    }
    return <span className="px-2 py-0.5 rounded text-xs bg-emerald-100 text-emerald-800 font-medium">Disponível</span>;
  }

  return (
    <div className="max-w-7xl mx-auto p-6">
      <div className="flex justify-between items-center mb-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Package className="w-6 h-6" />
            Produtos
          </h1>
          <p className="text-sm text-slate-500 mt-1">Catálogo ao vivo do WooCommerce — {total.toLocaleString('pt-BR')} produtos</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setBulkConfirm(1)}
            disabled={bulkState?.running}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded text-sm font-semibold bg-violet-600 hover:bg-violet-700 text-white disabled:opacity-50 transition shadow-sm"
            title="Aplicar estoque do ERP em TODOS os produtos variáveis (backup automático incluído)"
          >
            <CloudCog className="w-4 h-4" />
            {bulkState?.running ? 'Sincronizando...' : 'Sincronizar TODOS do ERP'}
          </button>
          <button
            onClick={() => {
              setLowStockOpen(true);
              setLowStockData(null);
              setLowStockApplyResult(null);
              setLowStockSearch('');
              loadLowStockPreview(lowStockThreshold);
            }}
            disabled={bulkState?.running}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded text-sm font-semibold bg-amber-600 hover:bg-amber-700 text-white disabled:opacity-50 transition shadow-sm"
            title="Pré-visualizar produtos publicados com estoque total menor que o limite (para marcar como rascunho)"
          >
            <Archive className="w-4 h-4" />
            Pré-visualizar estoque baixo
          </button>
          <button
            onClick={() => { setRestoreResult(null); setRestoreOpen(true); }}
            disabled={bulkState?.running}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded text-sm font-semibold bg-white hover:bg-slate-50 text-slate-700 border border-slate-300 disabled:opacity-50 transition"
            title="Restaurar estoque a partir de um backup"
          >
            <History className="w-4 h-4" />
            Restaurar backup
          </button>
          <button
            onClick={load}
            className="p-2 rounded hover:bg-slate-100"
            title="Atualizar"
          >
            <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Card de progresso do bulk sync */}
      {bulkState && (bulkState.running || (bulkState.finishedAt && Date.now() - new Date(bulkState.finishedAt).getTime() < 5 * 60 * 1000)) && (
        <div className={`mb-4 p-3 rounded border ${
          bulkState.running
            ? 'bg-violet-50 border-violet-200'
            : bulkState.productsFailed > 0 || bulkState.variationsFailed > 0
            ? 'bg-amber-50 border-amber-200'
            : 'bg-emerald-50 border-emerald-200'
        }`}>
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2 text-sm font-semibold">
              {bulkState.running ? (
                bulkState.prescanRunning ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin text-sky-700" />
                    <span className="text-sky-900">
                      Pré-analisando catálogo (comparando WC × ERP)…
                    </span>
                  </>
                ) : bulkState.lowStockDraftRunning ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin text-amber-700" />
                    <span className="text-amber-900">
                      Arquivando produtos com estoque &lt; {bulkState.lowStockThreshold}…
                    </span>
                  </>
                ) : (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin text-violet-700" />
                    <span className="text-violet-900">Sincronização em massa em andamento…</span>
                  </>
                )
              ) : (
                <>
                  <CheckCircle2 className={`w-4 h-4 ${bulkState.productsFailed > 0 ? 'text-amber-700' : 'text-emerald-700'}`} />
                  <span className={bulkState.productsFailed > 0 ? 'text-amber-900' : 'text-emerald-900'}>
                    Sincronização concluída
                  </span>
                </>
              )}
            </div>
            <div className="text-xs text-slate-600">
              {bulkState.prescanRunning
                ? `${bulkState.prescanProcessed} / ${bulkState.prescanTotalProducts} analisados`
                : `${bulkState.processed} / ${bulkState.totalProducts} produtos`}
            </div>
          </div>

          {/* Pre-scan: barra separada */}
          {bulkState.prescanRunning && bulkState.prescanTotalProducts > 0 && (
            <div className="w-full h-2 bg-white rounded overflow-hidden mb-2 border">
              <div
                className="h-full bg-sky-500 transition-all"
                style={{
                  width: `${Math.round(
                    (bulkState.prescanProcessed / bulkState.prescanTotalProducts) * 100,
                  )}%`,
                }}
              />
            </div>
          )}

          {/* Resumo do pre-scan quando termina */}
          {bulkState.prescanFinished && (
            <div className="text-xs text-slate-700 mb-2 flex flex-wrap gap-3">
              <span className="text-emerald-700">
                <b>{bulkState.productsAlreadySynced}</b> já alinhados (pulados)
              </span>
              <span className="text-violet-800">
                <b>{bulkState.totalProducts}</b> pra processar
              </span>
              {bulkState.prescanTotalProducts > 0 && (
                <span className="text-slate-500">
                  (economia de{' '}
                  {Math.round(
                    (bulkState.productsAlreadySynced / bulkState.prescanTotalProducts) * 100,
                  )}
                  % do catálogo)
                </span>
              )}
            </div>
          )}

          {/* Barra de progresso (fase 2) */}
          {!bulkState.prescanRunning && bulkState.totalProducts > 0 && (
            <div className="w-full h-2 bg-white rounded overflow-hidden mb-2 border">
              <div
                className={`h-full transition-all ${
                  bulkState.running ? 'bg-violet-500' : bulkState.productsFailed > 0 ? 'bg-amber-500' : 'bg-emerald-500'
                }`}
                style={{ width: `${Math.round((bulkState.processed / bulkState.totalProducts) * 100)}%` }}
              />
            </div>
          )}

          {/* Produto sendo processado */}
          {bulkState.running && bulkState.currentProductName && (
            <div className="text-xs text-slate-700 mb-2 truncate">
              <span className="text-slate-500">Atual:</span> <span className="font-medium">{bulkState.currentProductName}</span>
            </div>
          )}

          {/* Contadores */}
          <div className="flex flex-wrap gap-3 text-xs">
            <span className="text-emerald-800">
              <b>{bulkState.variationsUpdated}</b> variações atualizadas
            </span>
            {bulkState.variationsUnchanged > 0 && (
              <span className="text-slate-500" title="Já estavam iguais ao ERP — não precisou tocar">
                <b>{bulkState.variationsUnchanged}</b> inalteradas
              </span>
            )}
            {bulkState.variationsSkipped > 0 && (
              <span className="text-slate-600">
                <b>{bulkState.variationsSkipped}</b> puladas
              </span>
            )}
            {bulkState.parentsFixedStandalone > 0 && (
              <span className="text-blue-700" title="Produtos pais que estavam dessincronizados da soma das variações e foram corrigidos">
                <b>{bulkState.parentsFixedStandalone}</b> pais ressincronizados
              </span>
            )}
            {bulkState.variationsFailed > 0 && (
              <span className="text-red-700">
                <b>{bulkState.variationsFailed}</b> falhas em variações
              </span>
            )}
            {bulkState.productsFailed > 0 && (
              <span className="text-red-700">
                <b>{bulkState.productsFailed}</b> produtos com erro
              </span>
            )}
            {bulkState.lowStockDraftFinished && bulkState.productsMarkedDraft > 0 && (
              <span
                className="text-amber-700"
                title={`Produtos publicados com estoque total < ${bulkState.lowStockThreshold} foram marcados como rascunho`}
              >
                <b>{bulkState.productsMarkedDraft}</b> marcados como rascunho
              </span>
            )}
            {bulkState.lowStockDraftFailed > 0 && (
              <span className="text-red-700">
                <b>{bulkState.lowStockDraftFailed}</b> falhas ao draftear
              </span>
            )}
            {bulkState.startedAt && (
              <span className="text-slate-500 ml-auto">
                Iniciado {new Date(bulkState.startedAt).toLocaleTimeString('pt-BR')}
                {bulkState.finishedAt && ` · Fim ${new Date(bulkState.finishedAt).toLocaleTimeString('pt-BR')}`}
              </span>
            )}
          </div>

          {bulkState.lastError && (
            <div className="mt-2 text-xs text-red-700">Erro: {bulkState.lastError}</div>
          )}

          {/* Botão de download do backup (aparece assim que o filename é publicado) */}
          {bulkState.backupFilename && (
            <div className="mt-2 flex items-center gap-2 pt-2 border-t">
              <button
                onClick={() => downloadBackupFile(bulkState.backupFilename!)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 text-white"
                title="Baixa o XLSX com o estoque ANTES do sync (pra restore em emergência)"
              >
                <FileDown className="w-3.5 h-3.5" />
                Baixar backup ({bulkState.backupVariationsCount} SKUs)
              </button>
              <span className="text-xs text-slate-500 font-mono truncate">
                {bulkState.backupFilename}
              </span>
            </div>
          )}
        </div>
      )}

      {error && <div className="bg-red-50 text-red-700 p-3 rounded mb-4 text-sm">{error}</div>}

      {/* Filtros de estoque */}
      <div className="mb-4 flex flex-wrap gap-2">
        {STOCK_FILTERS.map((f) => {
          const active = stockStatus === f.slug;
          return (
            <button
              key={f.slug || 'all'}
              onClick={() => { setStockStatus(f.slug); setPage(1); }}
              className={`px-3 py-1.5 rounded text-sm border transition ${
                active ? 'bg-brand text-white border-brand' : 'bg-white hover:bg-slate-50'
              }`}
            >
              {f.label}
            </button>
          );
        })}
      </div>

      {/* Busca */}
      <form onSubmit={onSearchSubmit} className="mb-4 flex gap-2">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Buscar por nome ou SKU..."
            className="w-full pl-9 pr-3 py-2 border rounded text-sm"
          />
        </div>
        <button type="submit" className="px-4 py-2 border rounded hover:bg-slate-50 text-sm">
          Buscar
        </button>
        {search && (
          <button
            type="button"
            onClick={() => { setSearchInput(''); setSearch(''); setPage(1); }}
            className="px-3 py-2 text-sm text-slate-500 hover:text-slate-800"
          >
            Limpar
          </button>
        )}
      </form>

      {/* Lista */}
      <div className="bg-white rounded shadow overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-100">
            <tr>
              <th className="p-3 text-left w-[60px]"></th>
              <th className="p-3 text-left">Produto</th>
              <th className="p-3 text-left">SKU</th>
              <th className="p-3 text-right">Preço</th>
              <th className="p-3 text-center">Estoque</th>
              <th className="p-3 text-center">Variações</th>
              <th className="p-3 text-left w-[60px]">WP</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={7} className="p-6 text-center text-slate-400">Carregando...</td></tr>
            )}
            {!loading && data.length === 0 && (
              <tr>
                <td colSpan={7} className="p-8 text-center text-slate-400">
                  Nenhum produto encontrado.
                </td>
              </tr>
            )}
            {!loading && data.map((p) => {
              const isExpanded = expanded[p.id] !== undefined;
              const detail = expanded[p.id];
              return (
                <>
                  <tr key={p.id} className="border-t hover:bg-slate-50">
                    <td className="p-2">
                      {p.image ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={p.image} alt={p.name} className="w-12 h-12 object-cover rounded border" />
                      ) : (
                        <div className="w-12 h-12 bg-slate-100 rounded border flex items-center justify-center text-slate-400">
                          <Package className="w-5 h-5" />
                        </div>
                      )}
                    </td>
                    <td className="p-3">
                      <button
                        onClick={() => toggleExpand(p)}
                        className="flex items-start gap-2 text-left hover:text-brand disabled:cursor-default"
                        disabled={p.type !== 'variable'}
                        title={p.type === 'variable' ? 'Ver variações' : ''}
                      >
                        {p.type === 'variable' ? (
                          isExpanded ? <ChevronDown className="w-4 h-4 mt-0.5 flex-shrink-0" /> : <ChevronRight className="w-4 h-4 mt-0.5 flex-shrink-0" />
                        ) : (
                          <span className="w-4 h-4" />
                        )}
                        <span>
                          <span className="font-semibold">{p.name}</span>
                          {p.categories.length > 0 && (
                            <span className="block text-xs text-slate-500 mt-0.5">
                              {p.categories.slice(0, 3).join(' · ')}
                            </span>
                          )}
                        </span>
                      </button>
                    </td>
                    <td className="p-3 font-mono text-xs">{p.sku ?? <span className="text-slate-400">—</span>}</td>
                    <td className="p-3 text-right font-mono">
                      {p.type === 'variable' ? (
                        <span className="text-slate-600 text-xs">variável</span>
                      ) : (
                        <>
                          {p.salePrice && p.salePrice < (p.regularPrice ?? 0) ? (
                            <>
                              <span className="line-through text-slate-400 text-xs mr-2">{fmtMoney(p.regularPrice)}</span>
                              <span className="text-emerald-700 font-semibold">{fmtMoney(p.salePrice)}</span>
                            </>
                          ) : (
                            fmtMoney(p.price)
                          )}
                        </>
                      )}
                    </td>
                    <td className="p-3 text-center">
                      {stockBadge(p)}
                    </td>
                    <td className="p-3 text-center">
                      {p.type === 'variable' ? (
                        <span className="px-2 py-0.5 bg-slate-100 text-slate-700 rounded text-xs font-semibold">
                          {p.variationsCount}
                        </span>
                      ) : (
                        <span className="text-slate-400 text-xs">—</span>
                      )}
                    </td>
                    <td className="p-2">
                      <a
                        href={`${WC_ADMIN_URL}${p.id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-slate-400 hover:text-brand inline-flex"
                        title="Abrir no WordPress"
                      >
                        <ExternalLink className="w-4 h-4" />
                      </a>
                    </td>
                  </tr>

                  {/* Linha expandida: variações + descrição */}
                  {isExpanded && (
                    <tr key={`${p.id}-expanded`} className="bg-slate-50 border-t">
                      <td colSpan={7} className="p-0">
                        <div className="p-4">
                          {detail === 'loading' && (
                            <div className="text-center text-slate-500 py-4 text-sm">Carregando variações…</div>
                          )}
                          {detail === 'error' && (
                            <div className="flex items-center gap-2 text-red-700 text-sm">
                              <AlertTriangle className="w-4 h-4" />
                              Falha ao carregar variações.
                            </div>
                          )}
                          {detail && detail !== 'loading' && detail !== 'error' && (
                            <>
                              {/* Descrição curta */}
                              {(detail.shortDescription || detail.description) && (
                                <div className="mb-4">
                                  <div className="text-xs font-semibold text-slate-500 uppercase mb-1">Descrição</div>
                                  <div className="text-sm text-slate-700 leading-relaxed max-h-32 overflow-auto">
                                    {detail.shortDescription || detail.description}
                                  </div>
                                </div>
                              )}

                              {/* Resumo estoque variações — WC × ERP */}
                              {detail.variationsStockSum != null && (
                                <div className="mb-3 flex flex-wrap items-center justify-between gap-4 text-xs">
                                  <div className="flex flex-wrap items-center gap-4">
                                    <div className="text-slate-600">
                                      {detail.variations.length} variação(ões)
                                    </div>
                                    <div className="flex items-center gap-1.5">
                                      <span className="inline-block w-2.5 h-2.5 rounded-sm bg-blue-500"></span>
                                      <span className="text-slate-600">Total WooCommerce:</span>
                                      <span className="font-bold text-blue-700">{detail.variationsStockSum} un</span>
                                    </div>
                                    {detail.variationsErpStockSum != null && (
                                      <div className="flex items-center gap-1.5">
                                        <span className="inline-block w-2.5 h-2.5 rounded-sm bg-violet-500"></span>
                                        <span className="text-slate-600">Total ERP (gigasistemas21):</span>
                                        <span className="font-bold text-violet-700">{detail.variationsErpStockSum} un</span>
                                        {detail.variationsStockSum !== detail.variationsErpStockSum && (
                                          <span className="ml-1 px-1.5 py-0.5 bg-amber-100 text-amber-800 rounded font-semibold">
                                            divergência: {Math.abs(detail.variationsStockSum - detail.variationsErpStockSum)} un
                                          </span>
                                        )}
                                      </div>
                                    )}
                                  </div>

                                  {/* Botão sincronizar — só aparece se houver ERP e alguma divergência */}
                                  {detail.variationsErpStockSum != null && (
                                    <button
                                      onClick={() => setSyncConfirm({ step: 1, product: detail })}
                                      disabled={syncRunning}
                                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-semibold bg-violet-600 hover:bg-violet-700 text-white disabled:opacity-50 transition shadow-sm"
                                      title="Sobrescreve o estoque das variações no WooCommerce com os valores do ERP"
                                    >
                                      <CloudCog className="w-3.5 h-3.5" />
                                      Aplicar estoque ERP no WooCommerce
                                    </button>
                                  )}
                                </div>
                              )}

                              {/* Tabela de variações */}
                              <div className="bg-white border rounded overflow-hidden">
                                <table className="w-full text-xs">
                                  <thead className="bg-slate-100">
                                    <tr>
                                      <th className="p-2 text-left">Variação</th>
                                      <th className="p-2 text-left">SKU Site</th>
                                      <th className="p-2 text-left bg-violet-50 text-violet-900">SKU Gigasistemas</th>
                                      <th className="p-2 text-right">Preço</th>
                                      <th className="p-2 text-center bg-blue-50 text-blue-900">Estoque WC</th>
                                      <th className="p-2 text-center bg-violet-50 text-violet-900">Estoque ERP</th>
                                      <th className="p-2 text-center">Diferença</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {detail.variations.map((v) => {
                                      const wcQty = v.stockQuantity ?? 0;
                                      const erpQty = v.erpStock ?? null;
                                      const hasErp = erpQty !== null;
                                      const diff = hasErp ? wcQty - (erpQty as number) : null;
                                      return (
                                        <tr key={v.id} className="border-t hover:bg-slate-50">
                                          <td className="p-2">
                                            {v.attributes.map((a) => `${a.option}`).join(' · ') || <span className="text-slate-400">—</span>}
                                          </td>
                                          <td className="p-2 font-mono">{v.sku ?? <span className="text-slate-400">—</span>}</td>
                                          <td className="p-2 font-mono bg-violet-50/40">
                                            {v.erpSku ? (
                                              v.sku && v.erpSku === v.sku ? (
                                                <span className="text-violet-800" title="SKU confere com o Gigasistemas">{v.erpSku}</span>
                                              ) : (
                                                <span className="text-amber-700" title="SKU divergente do Site">{v.erpSku}</span>
                                              )
                                            ) : !v.sku ? (
                                              <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-slate-200 text-slate-600" title="Variação sem SKU no site">sem SKU site</span>
                                            ) : (
                                              <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-red-100 text-red-700" title="SKU do site não encontrado no Gigasistemas">não encontrado</span>
                                            )}
                                          </td>
                                          <td className="p-2 text-right font-mono">
                                            {v.salePrice && v.salePrice < (v.regularPrice ?? 0) ? (
                                              <>
                                                <span className="line-through text-slate-400 mr-1">{fmtMoney(v.regularPrice)}</span>
                                                <span className="text-emerald-700 font-semibold">{fmtMoney(v.salePrice)}</span>
                                              </>
                                            ) : (
                                              fmtMoney(v.price)
                                            )}
                                          </td>
                                          <td className="p-2 text-center bg-blue-50/40">
                                            {stockBadge(v)}
                                          </td>
                                          <td className="p-2 text-center bg-violet-50/40">
                                            {hasErp ? (
                                              <span className={`px-2 py-0.5 rounded text-xs font-semibold ${
                                                (erpQty as number) === 0
                                                  ? 'bg-red-100 text-red-700'
                                                  : (erpQty as number) <= 5
                                                  ? 'bg-amber-100 text-amber-800'
                                                  : 'bg-violet-100 text-violet-800'
                                              }`}>
                                                {erpQty} un
                                              </span>
                                            ) : (
                                              <span className="text-slate-400 text-xs italic" title="SKU não encontrado no ERP">sem ref.</span>
                                            )}
                                          </td>
                                          <td className="p-2 text-center">
                                            {diff === null ? (
                                              <span className="text-slate-300">—</span>
                                            ) : diff === 0 ? (
                                              <span className="text-emerald-600 font-semibold">=</span>
                                            ) : diff > 0 ? (
                                              <span className="text-amber-700 font-mono font-semibold" title="WC tem mais que ERP">
                                                +{diff}
                                              </span>
                                            ) : (
                                              <span className="text-red-700 font-mono font-semibold" title="ERP tem mais que WC">
                                                {diff}
                                              </span>
                                            )}
                                          </td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              </div>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ========== MODAL BULK SYNC — Preview → Confirmação final ========== */}
      {bulkConfirm && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between p-4 border-b bg-violet-50">
              <h3 className="font-bold text-violet-900 flex items-center gap-2">
                <CloudCog className="w-5 h-5" />
                Sincronizar TODOS os produtos com ERP
                <span className="ml-2 text-xs font-normal text-slate-500">
                  Passo {bulkConfirm} de 2
                </span>
              </h3>
              <button
                onClick={() => setBulkConfirm(null)}
                className="p-1 hover:bg-violet-100 rounded"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 overflow-auto flex-1 text-sm space-y-3">
              {/* Passo 1: preview/explicação (backup é inline agora) */}
              {bulkConfirm === 1 && (
                <>
                  <div className="p-3 bg-emerald-50 border border-emerald-200 rounded flex gap-2 text-emerald-900">
                    <ShieldCheck className="w-5 h-5 flex-shrink-0 mt-0.5" />
                    <div>
                      <div className="font-semibold mb-1">Backup automático incluído.</div>
                      <div className="text-xs">
                        O estoque ANTES de cada variação é capturado DURANTE o sync e salvo num
                        arquivo <b>.xlsx</b>. Quando terminar, o arquivo é baixado automaticamente e
                        um botão <b>Baixar backup</b> fica disponível no card de progresso.
                      </div>
                      <div className="text-xs mt-1">
                        Em caso de problema, use <b>Restaurar backup</b> pra voltar tudo.
                      </div>
                    </div>
                  </div>

                  <div className="p-3 bg-blue-50 border border-blue-200 rounded">
                    <div className="font-semibold text-blue-900 mb-1">O que vai acontecer:</div>
                    <ul className="text-xs text-blue-900 space-y-1 list-disc pl-5">
                      <li>Vamos processar <b>todos os produtos variáveis</b> do WooCommerce (todos os status).</li>
                      <li><b>Sync incremental</b>: só atualiza a variação se o estoque WC ≠ ERP. Se já bate, pula.</li>
                      <li>Variações sem SKU no ERP: <b>mantêm o estoque atual</b> (não zeram).</li>
                      <li><b>Estoque do produto pai</b>: sempre conferido contra a soma das variações. Se estiver dessincronizado, é corrigido mesmo que nenhuma variação tenha mudado.</li>
                      <li>Tempo estimado nessa primeira rodada: <b>8 a 15 minutos</b> (nas próximas, bem mais rápido — só toca no que diverge).</li>
                      <li>Você pode fechar esta janela — o processo continua no servidor.</li>
                    </ul>
                  </div>
                </>
              )}

              {/* Passo 2: confirmação final */}
              {bulkConfirm === 2 && (
                <div className="p-4 bg-red-50 border-2 border-red-300 rounded">
                  <div className="font-bold text-red-900 mb-2 text-base flex items-center gap-2">
                    <AlertTriangle className="w-5 h-5" />
                    ÚLTIMA CONFIRMAÇÃO
                  </div>
                  <div className="text-sm text-red-800 space-y-1">
                    <div>Vou começar a sincronização em massa agora.</div>
                    <div>Centenas de produtos e milhares de variações serão sobrescritos no WooCommerce.</div>
                    <div className="text-xs mt-2 text-red-700">
                      O arquivo de backup (.xlsx) será baixado automaticamente quando terminar.
                      Guarde numa pasta segura (Dropbox / Drive).
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="p-4 border-t bg-slate-50 flex justify-between gap-2">
              <button
                onClick={() => {
                  if (bulkConfirm === 1) setBulkConfirm(null);
                  else setBulkConfirm((bulkConfirm - 1) as 1 | 2);
                }}
                className="px-4 py-2 border rounded text-sm hover:bg-white"
              >
                {bulkConfirm === 1 ? 'Cancelar' : '← Voltar'}
              </button>

              {bulkConfirm === 1 && (
                <button
                  onClick={() => setBulkConfirm(2)}
                  className="px-4 py-2 rounded text-sm font-semibold bg-violet-600 hover:bg-violet-700 text-white"
                >
                  Continuar →
                </button>
              )}
              {bulkConfirm === 2 && (
                <button
                  onClick={startBulkSync}
                  className="px-4 py-2 rounded text-sm font-semibold bg-red-600 hover:bg-red-700 text-white inline-flex items-center gap-2"
                >
                  <CloudCog className="w-4 h-4" />
                  SIM, INICIAR AGORA
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ========== MODAL PRÉ-VISUALIZAR ESTOQUE BAIXO (auto-rascunho) ========== */}
      {lowStockOpen && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between p-4 border-b bg-amber-50">
              <h3 className="font-bold text-amber-900 flex items-center gap-2">
                <Archive className="w-5 h-5" />
                Produtos a marcar como rascunho — estoque baixo
              </h3>
              <button
                onClick={() => { setLowStockOpen(false); setLowStockData(null); setLowStockApplyResult(null); }}
                disabled={lowStockApplying}
                className="p-1 hover:bg-amber-100 rounded disabled:opacity-50"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 overflow-auto flex-1 text-sm space-y-3">
              {/* Controles: threshold + busca */}
              <div className="flex flex-wrap items-end gap-3">
                <label className="block">
                  <div className="text-xs font-semibold text-slate-700 mb-1">Estoque total &lt;</div>
                  <input
                    type="number"
                    min={0}
                    max={999}
                    value={lowStockThreshold}
                    onChange={(e) => setLowStockThreshold(Math.max(0, parseInt(e.target.value || '0', 10)))}
                    disabled={lowStockLoading || lowStockApplying}
                    className="w-24 px-2 py-1.5 border rounded text-sm font-mono"
                  />
                </label>
                <button
                  onClick={() => loadLowStockPreview(lowStockThreshold)}
                  disabled={lowStockLoading || lowStockApplying}
                  className="px-3 py-1.5 rounded text-sm font-semibold bg-slate-700 hover:bg-slate-800 text-white disabled:opacity-50 inline-flex items-center gap-1.5"
                >
                  <RefreshCw className={`w-4 h-4 ${lowStockLoading ? 'animate-spin' : ''}`} />
                  Recalcular
                </button>
                <div className="relative ml-auto w-64">
                  <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input
                    type="text"
                    value={lowStockSearch}
                    onChange={(e) => setLowStockSearch(e.target.value)}
                    placeholder="Filtrar por nome..."
                    disabled={!lowStockData}
                    className="w-full pl-9 pr-3 py-1.5 border rounded text-sm"
                  />
                </div>
              </div>

              {/* Loading */}
              {lowStockLoading && (
                <div className="flex items-center gap-2 text-slate-600 text-sm py-6 justify-center">
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  Escaneando catálogo... pode demorar 1-2 minutos.
                </div>
              )}

              {/* Resumo do scan */}
              {!lowStockLoading && lowStockData && (
                <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                  <div className="p-2 rounded border bg-slate-50 text-center">
                    <div className="text-xs text-slate-600">Produtos publicados escaneados</div>
                    <div className="text-xl font-bold text-slate-900">{lowStockData.scannedProducts}</div>
                  </div>
                  <div className="p-2 rounded border bg-amber-50 text-center">
                    <div className="text-xs text-amber-700">Candidatos a rascunho</div>
                    <div className="text-xl font-bold text-amber-900">{lowStockData.candidates}</div>
                  </div>
                  <div className="p-2 rounded border bg-violet-50 text-center">
                    <div className="text-xs text-violet-700">Threshold (estoque &lt;)</div>
                    <div className="text-xl font-bold text-violet-900">{lowStockData.threshold}</div>
                  </div>
                </div>
              )}

              {/* Resultado da aplicação */}
              {lowStockApplyResult && (
                <div className="grid grid-cols-3 gap-2">
                  <div className="p-2 rounded border bg-emerald-50 text-center">
                    <div className="text-xs text-emerald-700">Marcados como rascunho</div>
                    <div className="text-xl font-bold text-emerald-900">{lowStockApplyResult.success}</div>
                  </div>
                  <div className="p-2 rounded border bg-red-50 text-center">
                    <div className="text-xs text-red-700">Falharam</div>
                    <div className="text-xl font-bold text-red-900">{lowStockApplyResult.failed}</div>
                  </div>
                  <div className="p-2 rounded border bg-slate-50 text-center">
                    <div className="text-xs text-slate-600">Total processado</div>
                    <div className="text-xl font-bold text-slate-900">{lowStockApplyResult.candidates}</div>
                  </div>
                </div>
              )}

              {/* Tabela de candidatos */}
              {!lowStockLoading && lowStockData && lowStockData.items.length > 0 && (
                <div className="border rounded overflow-hidden">
                  <div className="max-h-[420px] overflow-y-auto">
                    <table className="w-full text-xs">
                      <thead className="bg-slate-100 sticky top-0">
                        <tr>
                          <th className="p-2 text-left">Produto</th>
                          <th className="p-2 text-center">Tipo</th>
                          <th className="p-2 text-center">Estoque total</th>
                          <th className="p-2 text-center">Status</th>
                          <th className="p-2 text-left w-[40px]">WP</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(() => {
                          // Mescla items do preview com applyResult (se houver, sobrescreve estado).
                          const applyMap = new Map<number, LowStockItem>();
                          if (lowStockApplyResult) {
                            for (const it of lowStockApplyResult.items) applyMap.set(it.productId, it);
                          }
                          const filtered = lowStockData.items
                            .map((it) => applyMap.get(it.productId) ?? it)
                            .filter((it) =>
                              !lowStockSearch ||
                              it.name.toLowerCase().includes(lowStockSearch.toLowerCase()),
                            );
                          if (filtered.length === 0) {
                            return (
                              <tr>
                                <td colSpan={5} className="p-6 text-center text-slate-400">
                                  Nenhum produto bate o filtro.
                                </td>
                              </tr>
                            );
                          }
                          return filtered.map((it) => (
                            <tr key={it.productId} className="border-t hover:bg-slate-50">
                              <td className="p-2 font-medium text-slate-800">{it.name}</td>
                              <td className="p-2 text-center text-slate-500">{it.type}</td>
                              <td className="p-2 text-center font-mono font-semibold text-amber-800">
                                {it.stockQuantity ?? '—'}
                              </td>
                              <td className="p-2 text-center">
                                {it.error ? (
                                  <span
                                    className="px-1.5 py-0.5 rounded bg-red-100 text-red-700 text-[10px] font-semibold"
                                    title={it.error}
                                  >
                                    falha
                                  </span>
                                ) : it.applied ? (
                                  <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 text-[10px] font-semibold">
                                    arquivado
                                  </span>
                                ) : (
                                  <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 text-[10px] font-semibold">
                                    candidato
                                  </span>
                                )}
                              </td>
                              <td className="p-2">
                                <a
                                  href={`${WC_ADMIN_URL}${it.productId}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-slate-400 hover:text-brand inline-flex"
                                  title="Abrir no WordPress"
                                >
                                  <ExternalLink className="w-3.5 h-3.5" />
                                </a>
                              </td>
                            </tr>
                          ));
                        })()}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {!lowStockLoading && lowStockData && lowStockData.items.length === 0 && (
                <div className="p-6 text-center text-slate-500 border rounded bg-slate-50">
                  Nenhum produto publicado com estoque &lt; {lowStockData.threshold}. Tudo certo!
                </div>
              )}
            </div>

            <div className="p-4 border-t bg-slate-50 flex items-center justify-between gap-2">
              <div className="text-xs text-slate-500">
                {lowStockApplyResult
                  ? 'Operação aplicada. Você pode fechar.'
                  : lowStockData
                  ? `${lowStockData.candidates} produto(s) ficarão com status "rascunho" (saem do ar).`
                  : ''}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => { setLowStockOpen(false); setLowStockData(null); setLowStockApplyResult(null); }}
                  disabled={lowStockApplying}
                  className="px-4 py-2 border rounded text-sm hover:bg-white disabled:opacity-50"
                >
                  Fechar
                </button>
                {lowStockData && lowStockData.candidates > 0 && !lowStockApplyResult && (
                  <button
                    onClick={() => applyLowStockDraft(lowStockThreshold)}
                    disabled={lowStockApplying}
                    className="px-4 py-2 rounded text-sm font-semibold bg-red-600 hover:bg-red-700 text-white disabled:opacity-50 inline-flex items-center gap-2"
                  >
                    {lowStockApplying ? (
                      <>
                        <RefreshCw className="w-4 h-4 animate-spin" />
                        Aplicando...
                      </>
                    ) : (
                      <>
                        <Archive className="w-4 h-4" />
                        Aplicar agora ({lowStockData.candidates})
                      </>
                    )}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ========== MODAL RESTAURAR BACKUP ========== */}
      {restoreOpen && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between p-4 border-b bg-slate-100">
              <h3 className="font-bold text-slate-900 flex items-center gap-2">
                <History className="w-5 h-5" />
                Restaurar estoque a partir de backup
              </h3>
              <button
                onClick={() => { setRestoreOpen(false); setRestoreResult(null); }}
                disabled={restoreRunning}
                className="p-1 hover:bg-white rounded disabled:opacity-50"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 overflow-auto flex-1 text-sm">
              {!restoreResult && (
                <>
                  <div className="p-3 bg-amber-50 border border-amber-200 rounded text-amber-900 text-xs mb-3">
                    <div className="font-semibold mb-1 flex items-center gap-1.5">
                      <AlertTriangle className="w-4 h-4" /> Atenção
                    </div>
                    Envie o arquivo <b>stock-backup-YYYYMMDDHHMMSS.xlsx</b> gerado antes do sync.
                    O arquivo deve ter 2 colunas: <code>sku</code> | <code>stock_quantity</code>.
                    Cada SKU será resolvido no WC e seu estoque sobrescrito com o valor do arquivo.
                  </div>

                  <label className="block">
                    <div className="text-xs font-semibold text-slate-700 mb-1">Selecionar arquivo XLSX</div>
                    <input
                      type="file"
                      accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) restoreFromBackupFile(file);
                      }}
                      disabled={restoreRunning}
                      className="block w-full text-sm border rounded p-2 disabled:opacity-50"
                    />
                  </label>

                  {restoreRunning && (
                    <div className="mt-3 flex items-center gap-2 text-slate-600 text-sm">
                      <RefreshCw className="w-4 h-4 animate-spin" />
                      Restaurando estoque... pode demorar alguns minutos.
                    </div>
                  )}
                </>
              )}

              {restoreResult && (
                <>
                  <div className="grid grid-cols-3 gap-2 mb-3">
                    <div className="p-2 rounded border bg-emerald-50 text-center">
                      <div className="text-xs text-emerald-700">SKUs restaurados</div>
                      <div className="text-xl font-bold text-emerald-900">{restoreResult.variationsRestored}</div>
                    </div>
                    <div className="p-2 rounded border bg-red-50 text-center">
                      <div className="text-xs text-red-700">Falharam</div>
                      <div className="text-xl font-bold text-red-900">{restoreResult.variationsFailed}</div>
                    </div>
                    <div className="p-2 rounded border bg-violet-50 text-center">
                      <div className="text-xs text-violet-700">Produtos pais</div>
                      <div className="text-xl font-bold text-violet-900">{restoreResult.productsUpdated}</div>
                    </div>
                  </div>
                  <div className="text-xs text-slate-500 mb-2">
                    {restoreResult.details.length} linhas processadas.
                  </div>
                  {restoreResult.variationsFailed > 0 && (
                    <div className="border rounded overflow-hidden max-h-64 overflow-y-auto">
                      <table className="w-full text-xs">
                        <thead className="bg-slate-100 sticky top-0">
                          <tr>
                            <th className="p-2 text-left">SKU</th>
                            <th className="p-2 text-left">Erro</th>
                          </tr>
                        </thead>
                        <tbody>
                          {restoreResult.details
                            .filter((d: any) => !d.success)
                            .map((d: any, i: number) => (
                              <tr key={i} className="border-t">
                                <td className="p-2 font-mono">{d.sku}</td>
                                <td className="p-2 text-red-700">{d.error}</td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="p-3 border-t bg-slate-50 flex justify-end">
              <button
                onClick={() => { setRestoreOpen(false); setRestoreResult(null); }}
                disabled={restoreRunning}
                className="px-4 py-2 rounded text-sm font-semibold bg-slate-800 hover:bg-slate-900 text-white disabled:opacity-50"
              >
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========== MODAL DUPLA CONFIRMAÇÃO — Sincronizar estoque ERP → WC ========== */}
      {syncConfirm && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between p-4 border-b bg-violet-50">
              <h3 className="font-bold text-violet-900 flex items-center gap-2">
                <CloudCog className="w-5 h-5" />
                {syncConfirm.step === 1 ? 'Confirmar sincronização' : 'TEM CERTEZA?'}
              </h3>
              <button
                onClick={() => setSyncConfirm(null)}
                disabled={syncRunning}
                className="p-1 hover:bg-violet-100 rounded disabled:opacity-50"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 overflow-auto flex-1 text-sm">
              {syncConfirm.step === 1 && (
                <>
                  <div className="mb-3 p-3 bg-amber-50 border border-amber-200 rounded flex gap-2 text-amber-900">
                    <AlertTriangle className="w-5 h-5 flex-shrink-0 mt-0.5" />
                    <div>
                      <div className="font-semibold mb-1">Operação irreversível no WooCommerce.</div>
                      <div className="text-xs">
                        O estoque das variações no site será <b>sobrescrito</b> pelos valores do ERP.
                        O estoque anterior do site será <b>perdido</b>.
                      </div>
                    </div>
                  </div>

                  <div className="mb-3">
                    <div className="font-semibold text-slate-900">{syncConfirm.product.name}</div>
                    {syncConfirm.product.sku && (
                      <div className="text-xs text-slate-500 font-mono">{syncConfirm.product.sku}</div>
                    )}
                  </div>

                  <div className="border rounded overflow-hidden mb-3">
                    <table className="w-full text-xs">
                      <thead className="bg-slate-100">
                        <tr>
                          <th className="p-2 text-left">Variação</th>
                          <th className="p-2 text-left">SKU</th>
                          <th className="p-2 text-center bg-blue-50 text-blue-900">Antes (WC)</th>
                          <th className="p-2 text-center bg-violet-50 text-violet-900">Depois (ERP)</th>
                          <th className="p-2 text-center">Δ</th>
                        </tr>
                      </thead>
                      <tbody>
                        {syncConfirm.product.variations.map((v) => {
                          const before = v.stockQuantity ?? 0;
                          const hasErp = v.erpStock !== null && v.erpStock !== undefined;
                          const after = hasErp ? (v.erpStock as number) : before;
                          const diff = hasErp ? after - before : null;
                          return (
                            <tr key={v.id} className={`border-t ${!hasErp ? 'opacity-50' : ''}`}>
                              <td className="p-2">
                                {v.attributes.map((a) => a.option).join(' · ') || '—'}
                              </td>
                              <td className="p-2 font-mono">{v.sku ?? '—'}</td>
                              <td className="p-2 text-center bg-blue-50/40 font-mono">{before}</td>
                              <td className="p-2 text-center bg-violet-50/40 font-mono font-semibold">
                                {hasErp ? after : <span className="text-slate-400 italic">sem ref.</span>}
                              </td>
                              <td className="p-2 text-center font-mono">
                                {diff === null ? (
                                  <span className="text-slate-300">—</span>
                                ) : diff === 0 ? (
                                  <span className="text-slate-400">0</span>
                                ) : diff > 0 ? (
                                  <span className="text-emerald-700 font-semibold">+{diff}</span>
                                ) : (
                                  <span className="text-red-700 font-semibold">{diff}</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                      <tfoot className="bg-slate-50 border-t-2">
                        <tr>
                          <td colSpan={2} className="p-2 font-semibold text-right">Totais:</td>
                          <td className="p-2 text-center bg-blue-50 font-bold text-blue-900">
                            {syncConfirm.product.variationsStockSum ?? '—'}
                          </td>
                          <td className="p-2 text-center bg-violet-50 font-bold text-violet-900">
                            {syncConfirm.product.variationsErpStockSum ?? '—'}
                          </td>
                          <td className="p-2 text-center font-bold">
                            {syncConfirm.product.variationsStockSum != null &&
                              syncConfirm.product.variationsErpStockSum != null && (
                                <>
                                  {syncConfirm.product.variationsErpStockSum - syncConfirm.product.variationsStockSum > 0 ? '+' : ''}
                                  {syncConfirm.product.variationsErpStockSum - syncConfirm.product.variationsStockSum}
                                </>
                              )}
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>

                  <div className="text-xs text-slate-600 bg-slate-50 p-2 rounded border">
                    O estoque do <b>produto pai</b> será atualizado para a soma acima:{' '}
                    <span className="font-bold text-violet-800">
                      {syncConfirm.product.variationsErpStockSum ?? 0} un
                    </span>
                  </div>
                </>
              )}

              {syncConfirm.step === 2 && (
                <div className="space-y-3">
                  <div className="p-4 bg-red-50 border-2 border-red-300 rounded">
                    <div className="font-bold text-red-900 mb-1 text-base flex items-center gap-2">
                      <AlertTriangle className="w-5 h-5" />
                      Última confirmação
                    </div>
                    <div className="text-sm text-red-800">
                      Vou aplicar <b>{syncConfirm.product.variations.filter(v => v.sku && v.erpStock != null).length}</b> alteração(ões)
                      no WooCommerce do produto <b>{syncConfirm.product.name}</b>.
                    </div>
                    <div className="text-xs text-red-700 mt-2">
                      Essa operação não pode ser desfeita pelo sistema.
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="p-4 border-t bg-slate-50 flex justify-between gap-2">
              <button
                onClick={() => setSyncConfirm(null)}
                disabled={syncRunning}
                className="px-4 py-2 border rounded text-sm hover:bg-white disabled:opacity-50"
              >
                Cancelar
              </button>
              {syncConfirm.step === 1 ? (
                <button
                  onClick={() => setSyncConfirm({ ...syncConfirm, step: 2 })}
                  className="px-4 py-2 rounded text-sm font-semibold bg-violet-600 hover:bg-violet-700 text-white"
                >
                  Continuar →
                </button>
              ) : (
                <button
                  onClick={() => runSyncFromErp(syncConfirm.product.id)}
                  disabled={syncRunning}
                  className="px-4 py-2 rounded text-sm font-semibold bg-red-600 hover:bg-red-700 text-white disabled:opacity-50 inline-flex items-center gap-2"
                >
                  {syncRunning ? (
                    <>
                      <RefreshCw className="w-4 h-4 animate-spin" />
                      Sincronizando...
                    </>
                  ) : (
                    <>
                      <CloudCog className="w-4 h-4" />
                      SIM, APLICAR AGORA
                    </>
                  )}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ========== MODAL RESULTADO ========== */}
      {syncResult && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-3xl w-full max-h-[90vh] overflow-hidden flex flex-col">
            <div className={`flex items-center justify-between p-4 border-b ${
              syncResult.parentUpdated && syncResult.variationsFailed === 0
                ? 'bg-emerald-50'
                : syncResult.parentUpdated
                ? 'bg-amber-50'
                : 'bg-red-50'
            }`}>
              <h3 className="font-bold flex items-center gap-2">
                {syncResult.parentUpdated && syncResult.variationsFailed === 0 ? (
                  <>
                    <CheckCircle2 className="w-5 h-5 text-emerald-700" />
                    <span className="text-emerald-900">Sincronização concluída</span>
                  </>
                ) : syncResult.parentUpdated ? (
                  <>
                    <AlertTriangle className="w-5 h-5 text-amber-700" />
                    <span className="text-amber-900">Concluída com avisos</span>
                  </>
                ) : (
                  <>
                    <XCircle className="w-5 h-5 text-red-700" />
                    <span className="text-red-900">Falha na sincronização</span>
                  </>
                )}
              </h3>
              <button
                onClick={() => setSyncResult(null)}
                className="p-1 hover:bg-white rounded"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 overflow-auto flex-1 text-sm">
              {syncResult.productName && (
                <div className="mb-3 font-semibold">{syncResult.productName}</div>
              )}

              {/* KPIs do resultado */}
              <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-4">
                <div className="p-2 rounded border bg-emerald-50">
                  <div className="text-xs text-emerald-700">Atualizadas</div>
                  <div className="text-xl font-bold text-emerald-900">{syncResult.variationsUpdated}</div>
                </div>
                <div className="p-2 rounded border bg-slate-50">
                  <div className="text-xs text-slate-500" title="Já estavam iguais">Inalteradas</div>
                  <div className="text-xl font-bold text-slate-700">{syncResult.variationsUnchanged ?? 0}</div>
                </div>
                <div className="p-2 rounded border bg-red-50">
                  <div className="text-xs text-red-700">Falharam</div>
                  <div className="text-xl font-bold text-red-900">{syncResult.variationsFailed}</div>
                </div>
                <div className="p-2 rounded border bg-amber-50">
                  <div className="text-xs text-amber-700">Puladas</div>
                  <div className="text-xl font-bold text-amber-800">{syncResult.variationsSkipped}</div>
                </div>
                <div className="p-2 rounded border bg-violet-50">
                  <div className="text-xs text-violet-700">Total (pai)</div>
                  <div className="text-xl font-bold text-violet-900">
                    {syncResult.totalBefore}
                    <span className="mx-1 text-slate-400 text-base">→</span>
                    {syncResult.totalAfter}
                  </div>
                </div>
              </div>

              {syncResult.parentError && (
                <div className="mb-3 p-2 rounded bg-red-50 border border-red-200 text-xs text-red-800">
                  Erro ao atualizar produto pai: {syncResult.parentError}
                </div>
              )}

              {/* Detalhes por variação */}
              {syncResult.details.length > 0 && (
                <div className="border rounded overflow-hidden">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-100">
                      <tr>
                        <th className="p-2 text-left">Status</th>
                        <th className="p-2 text-left">Variação</th>
                        <th className="p-2 text-left">SKU</th>
                        <th className="p-2 text-center">Antes</th>
                        <th className="p-2 text-center">Depois</th>
                        <th className="p-2 text-left">Observação</th>
                      </tr>
                    </thead>
                    <tbody>
                      {syncResult.details.map((d) => (
                        <tr key={d.variationId} className="border-t">
                          <td className="p-2">
                            {d.skipped ? (
                              <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 text-[10px] font-semibold">pulada</span>
                            ) : d.unchanged ? (
                              <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 text-[10px] font-semibold" title="Já estava igual — não foi atualizada">sem mudança</span>
                            ) : d.success ? (
                              <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 text-[10px] font-semibold">atualizada</span>
                            ) : (
                              <span className="px-1.5 py-0.5 rounded bg-red-100 text-red-800 text-[10px] font-semibold">falha</span>
                            )}
                          </td>
                          <td className="p-2">
                            {d.attributes?.map((a) => a.option).join(' · ') || '—'}
                          </td>
                          <td className="p-2 font-mono">{d.sku ?? '—'}</td>
                          <td className="p-2 text-center font-mono">{d.before ?? '—'}</td>
                          <td className="p-2 text-center font-mono font-semibold">{d.after ?? '—'}</td>
                          <td className="p-2 text-slate-600">
                            {d.error ?? d.reason ?? ''}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="p-3 border-t bg-slate-50 flex justify-end">
              <button
                onClick={() => setSyncResult(null)}
                className="px-4 py-2 rounded text-sm font-semibold bg-slate-800 hover:bg-slate-900 text-white"
              >
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Paginação */}
      {totalPages > 1 && (
        <div className="flex justify-between items-center mt-4 text-sm text-slate-600">
          <div>
            {total.toLocaleString('pt-BR')} produtos — página {page} de {totalPages}
          </div>
          <div className="flex gap-1">
            <button
              disabled={page === 1}
              onClick={() => setPage(1)}
              className="px-3 py-1 border rounded disabled:opacity-30 hover:bg-slate-50"
            >«</button>
            <button
              disabled={page === 1}
              onClick={() => setPage(page - 1)}
              className="px-3 py-1 border rounded disabled:opacity-30 hover:bg-slate-50"
            >‹</button>
            <span className="px-3 py-1">{page}</span>
            <button
              disabled={page >= totalPages}
              onClick={() => setPage(page + 1)}
              className="px-3 py-1 border rounded disabled:opacity-30 hover:bg-slate-50"
            >›</button>
            <button
              disabled={page >= totalPages}
              onClick={() => setPage(totalPages)}
              className="px-3 py-1 border rounded disabled:opacity-30 hover:bg-slate-50"
            >»</button>
          </div>
        </div>
      )}
    </div>
  );
}
