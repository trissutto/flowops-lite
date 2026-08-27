'use client';
import { overlayClose } from '@/lib/overlayClose';

/**
 * Central de Emissão de Separações.
 *
 * FLUXO SIMPLIFICADO (1 clique faz tudo):
 *  1. Seleciona os pedidos (checkbox)
 *  2. Clica em "Enviar separação" → sistema faz:
 *     a) Calcula a loja responsável (routing por estoque/distância/prioridade)
 *     b) Registra pick-order no backend (Separação oficial)
 *     c) Dispara WhatsApp pra loja via Baileys
 *     d) Muda status do pedido pra "Separação" no WC
 *
 * Ações auxiliares:
 *  - "Só calcular prévia" (bulk) → mostra qual loja vai pegar, sem disparar
 *  - "Calcular loja" (individual) → mesma prévia, um pedido só
 *  - "Imprimir" → gera ordem 80mm pra térmica
 *
 * Atualiza sozinho a cada 30s.
 */

import { Fragment, Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import { api } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { classifyShipping } from '@/lib/shipping-method';
import { autoSendOrderToStore } from '@/lib/auto-send-order';
import { abrirWhatsApp } from '@/lib/whatsapp';
import AlertaAvisosTroca from '@/components/AlertaAvisosTroca';
import SellerTag from '@/components/SellerTag';
import EnviadosByStore from '@/components/EnviadosByStore';
import PosVenda from '@/components/PosVenda';
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
  AlertCircle,
  Zap,
  Truck,
  PackageCheck,
  Plane,
  Star,
  ArrowLeft,
  LayoutDashboard,
  Globe2,
  BarChart3,
  Settings,
} from 'lucide-react';
import AdminShell, { type AdminNavItem } from '@/components/AdminShell';
import { Table, Th, Tr, Td } from '@/components/ui';

const SEP_NAV: AdminNavItem[] = [
  { key: 'dashboard', label: 'Dashboard', href: '/',           icon: LayoutDashboard },
  { key: 'site',      label: 'Site',      href: '/site',       icon: Globe2 },
  { key: 'loja',      label: 'Loja',      href: '/loja',       icon: StoreIcon },
  { key: 'gestao',    label: 'Gestão',    href: '/retaguarda', icon: BarChart3 },
  { key: 'config',    label: 'Config',    href: '/config',     icon: Settings },
];

interface PickOrderLite {
  storeCode: string | null;
  storeName: string | null;
  status: string;
  trackingCode: string | null;
  carrier: string | null;
}

interface WcOrderListItem {
  id: number;
  number: string;
  /** Slug da ABA pedida — NÃO é o status do pedido (ver `statusLocal`). */
  status: string;
  /** Status REAL do pedido no Postgres (separating, shipped, cancelled…). */
  statusLocal?: string | null;
  /** Rótulo humano do status real ("Em separação", "Despachado"…). */
  statusLabel?: string | null;
  /** Aba onde este pedido mora — null = status que nenhuma aba mostra. */
  abaSlug?: string | null;
  dateCreatedGmt: string;
  total: string;
  customerName: string;
  shippingMethod?: string | null;
  shippingState?: string | null;
  // Enriquecimento vindo do backend: loja(s) responsável(is) + rastreio
  pickOrders?: PickOrderLite[];
  shipped?: boolean;
  /** Desde quando a caixa está separada esperando postagem (aba "Pronto pra postar"). */
  prontoDesde?: string | null;
  trackingCode?: string | null;
  trackingCarrier?: string | null;
  // Vendedora atribuída (tag pra relatório de vendas online por atendente)
  sellerId?: string | null;
  sellerName?: string | null;
  // Marketing: nome da campanha de origem (Order Attribution do WC). Só vem
  // preenchido se o anúncio carregou UTM na URL. null = direto/sem campanha.
  utmCampaign?: string | null;
  // ── Aba "Em trânsito" ──
  // Último evento conhecido do objeto, lido do cache `rastreio_objetos` (o
  // backend só preenche nessa aba). null = o cron ainda não olhou pra ele —
  // e "sem movimento" é diferente de "sem dado".
  rastreio?: {
    status: string | null;
    local: string | null;
    eventoEm: string | null;
    previsaoEm: string | null;
    entregue: boolean;
    consultadoEm: string | null;
  } | null;
  /** Quantas caixas o pedido tem — dividido só fecha quando TODAS chegam. */
  volumes?: number;
  entregueEm?: string | null;
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

/**
 * Issue reportado pela filial num pick-order (sem estoque físico, defeito, etc).
 * Matriz vê badge vermelho nas linhas afetadas e clica "Recalcular" pra reroteiar.
 */
interface ActiveIssue {
  pickOrderId: string;
  wcOrderId: number | null;
  wcOrderNumber: string | null;
  storeCode: string | null;
  storeName: string | null;
  reason: string;
  reasonLabel: string;
  note: string | null;
  reportedAt: string | null;
}

/**
 * ABAS — divididas em FILA (exige alguém) e ACOMPANHAR (consulta).
 *
 * As onze abas moravam na mesma barra, com o mesmo peso e a mesma pílula rosa:
 * os ~30 pedidos que precisam de ação ficavam visualmente MENORES que os 410 já
 * entregues. Agora a fila é a barra de abas de verdade e o resto é uma linha de
 * links abaixo — e o contador só ganha cor quando o número É uma pendência
 * (regra do Semáforo: cor é propriedade exclusiva do estado).
 *
 * `travados` não é status de pedido: é a lista de problemas que as lojas
 * reportaram, que vive em `/pick-orders/issues-active` e antes era um banner
 * vermelho de 100px repetido em TODAS as abas. Painel próprio, como `enviados`.
 */
const FILTROS = [
  { slug: 'travados',    label: 'Travados',            color: 'bg-red-100 text-red-800',        grupo: 'fila' },
  { slug: 'processing',  label: 'Processando',         color: 'bg-emerald-100 text-emerald-800', grupo: 'fila' },
  { slug: 'pending',     label: 'Pagto pendente',      color: 'bg-amber-100 text-amber-800',    grupo: 'fila' },
  { slug: 'on-hold',     label: 'Aguardando',          color: 'bg-yellow-100 text-yellow-800',  grupo: 'fila' },
  { slug: 'carrinhos',   label: 'Carrinhos',           color: 'bg-rose-100 text-rose-800' },
  { slug: 'separacao',   label: 'Em separação',        color: 'bg-blue-100 text-blue-800',      grupo: 'fila' },
  // PRONTO PRA POSTAR (24/08, ordem do dono): "entre separação e em trânsito
  // ele fica parado, sem movimentar status". A peça já foi bipada e a caixa
  // espera etiqueta/postagem — 31 cards nesse limbo na medição do dia, 36h de
  // média e o pior com 6,3 dias, todos escondidos dentro de "Em separação".
  // Reparte aquela aba (não duplica): ver `whereNativoDaAba` no backend.
  { slug: 'pronto-postar', label: 'Pronto pra postar', color: 'bg-orange-100 text-orange-800', grupo: 'fila' },
  // "Enviados por Loja" não é um status de pedido WC — é um painel diferente
  // (tracking do dia por filial). Reaproveitamos a aba pra evitar que a matriz
  // precise ir pra /retaguarda/enviados-hoje só pra ver quem despachou.
  { slug: 'enviados',    label: 'Enviados por Loja',   color: 'bg-emerald-100 text-emerald-800' },
  // Em trânsito: a loja despachou E colocou o rastreio, e o objeto ainda não
  // chegou. Sai daqui sozinho — quando o rastreio confirma a entrega, o
  // `RastreioSyncCron` fecha o pedido e ele aparece em Concluídos.
  { slug: 'em-transito', label: 'Em trânsito',         color: 'bg-sky-100 text-sky-800' },
  // Concluídos = entregue (rastreio confirmou) + o que não tem o que rastrear
  // (retirada, motoboy) + o WC completed do site antigo.
  { slug: 'completed',   label: 'Concluídos',          color: 'bg-slate-100 text-slate-700' },
  // Pós-venda: o que acontece DEPOIS que chegou — convite pra avaliar (D+5),
  // avaliações esperando aprovação e os pontos que a cliente ganhou.
  { slug: 'pos-venda',   label: 'Pós-venda',           color: 'bg-violet-100 text-violet-800' },
  // Cancelados/reembolsados — pra conferir o que saiu da fila e não ficar sem
  // rastro depois de cancelar.
  { slug: 'cancelled',   label: 'Cancelados',          color: 'bg-rose-100 text-rose-800' },
];

/**
 * Status destino da mudança em bloco.
 *
 * CANCELADO e REEMBOLSADO entraram em 04/08 (pedido do dono: "nenhum status e
 * preciso cancelar"). Estavam fora de propósito, por medo de clique acidental —
 * mas o efeito foi pior: pedido morto ficava preso na fila pra sempre, sem
 * nenhuma saída na tela. Agora eles existem, marcados como `destrutivo`, o que
 * liga uma confirmação que explica o que vai acontecer antes de gravar.
 */
const BULK_TARGETS: Array<{ slug: string; label: string; color: string; destrutivo?: boolean }> = [
  { slug: 'separacao',  label: 'Separação',   color: 'bg-blue-600 hover:bg-blue-700' },
  { slug: 'processing', label: 'Processando', color: 'bg-emerald-600 hover:bg-emerald-700' },
  { slug: 'on-hold',    label: 'Aguardando',  color: 'bg-yellow-500 hover:bg-yellow-600' },
  { slug: 'completed',  label: 'Concluído',   color: 'bg-slate-600 hover:bg-slate-700' },
  { slug: 'cancelled',  label: 'Cancelar',    color: 'bg-rose-600 hover:bg-rose-700', destrutivo: true },
  { slug: 'refunded',   label: 'Reembolsado', color: 'bg-fuchsia-700 hover:bg-fuchsia-800', destrutivo: true },
];

/**
 * Wrapper com Suspense — exigência do Next.js 14 App Router quando o componente
 * usa `useSearchParams()`. Sem isso, o build estático explode (prerender-error).
 */
export default function SeparacaoPage() {
  return (
    <Suspense fallback={<div className="p-6 text-slate-400">Carregando…</div>}>
      <SeparacaoPageInner />
    </Suspense>
  );
}

function SeparacaoPageInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const initialTab = (() => {
    const t = searchParams?.get('tab');
    if (t && FILTROS.some((f) => f.slug === t)) return t;
    if (typeof window !== 'undefined') {
      const saved = window.localStorage.getItem('separacao_tab');
      if (saved && FILTROS.some((f) => f.slug === saved)) return saved;
    }
    return 'processing';
  })();

  const [orders, setOrders] = useState<WcOrderListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<string>(initialTab);

  // Persiste tab em URL + localStorage pra sobreviver back do navegador
  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('separacao_tab', status);
    }
    if (pathname) {
      const sp = new URLSearchParams(searchParams?.toString() || '');
      sp.set('tab', status);
      router.replace(`${pathname}?${sp.toString()}`, { scroll: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  /**
   * BUSCA ENQUANTO DIGITA (25/08). O campo só valia depois de apertar Enter ou
   * caçar o botão "Buscar" — e campo de busca que não reage a digitação é
   * lido como campo quebrado. 400ms é o intervalo em que a matriz termina de
   * digitar o número do pedido sem disparar uma requisição por tecla.
   * O botão continua ali (Enter também) pra quem já tem o dedo viciado.
   */
  useEffect(() => {
    const alvo = searchInput.trim();
    if (alvo === search) return;
    const t = setTimeout(() => setSearch(alvo), 400);
    return () => clearTimeout(t);
  }, [searchInput, search]);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [preview, setPreview] = useState<Record<number, SeparationPreview>>({});
  const [busy, setBusy] = useState<Record<number, boolean>>({});
  const [errorByOrder, setErrorByOrder] = useState<Record<number, string>>({});

  // Seleção em bloco
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number; fails: number } | null>(null);

  // Issues ativos reportados pelas lojas — mapa wcOrderId → array de issues
  // Alimenta o badge vermelho nas linhas e o banner no topo.
  const [issuesByWcId, setIssuesByWcId] = useState<Record<number, ActiveIssue[]>>({});
  const [recalculating, setRecalculating] = useState<Record<number, boolean>>({});

  // Contadores por status pra badge nas abas (atualiza a cada 30s).
  // Mapeia FILTROS.slug → total. "enviados" é painel próprio (sem contador).
  const [tabCounts, setTabCounts] = useState<Record<string, number>>({});

  // Filtro de LOJA RESPONSÁVEL pela separação
  const [storeCode, setStoreCode] = useState<string>('');
  const [stores, setStores] = useState<Array<{ code: string; name: string; openOrders: number }>>([]);

  // Filtro de ORIGEM: '' = todos · 'site' (WooCommerce antigo) · 'live' (Live
  // Commerce) · 'ecommerce' (site NOVO, sprint 011 — nº "LP-xxxxxx").
  // As três origens entram na MESMA fila: quem sabe rotear Order roteia todas.
  const [sourceFilter, setSourceFilter] = useState<'' | 'site' | 'live' | 'ecommerce' | 'pdv_online'>('');

  /**
   * O QUE A MATRIZ REALMENTE VÊ — a lista já passada pelo filtro de origem.
   *
   * O filtro de origem era aplicado só na hora de desenhar as linhas: a barra
   * de cima contava `orders` inteiro e dizia "1 pedido(s) na fila" com a lista
   * vazia embaixo, e "Marcar todos" marcava pedido ESCONDIDO — que a mudança
   * de status em bloco levava junto. Uma lista só, usada por todo mundo.
   */
  const visiveis = useMemo(
    () => orders.filter((o) => !sourceFilter || ((o as any).orderSource || 'site') === sourceFilter),
    [orders, sourceFilter],
  );

  /** Pedidos com problema reportado por alguma loja — alimenta a aba "Travados". */
  const totalTravados = useMemo(() => Object.keys(issuesByWcId).length, [issuesByWcId]);

  // Carrega as lojas com o que CADA UMA tem na mão na aba atual: em "Em
  // separação" é o card ainda na arara; em "Pronto pra postar", a caixa
  // esperando etiqueta. O número não seguia aba nenhuma e contava tudo que não
  // tinha acabado — 56 contra os 11 da tela em 24/08 (ver `wcStoresLoad`).
  async function loadStores(aba: string) {
    try {
      const r = await api<{ stores: Array<{ code: string; name: string; openOrders: number }> }>(
        `/orders/wc/stores-load?aba=${encodeURIComponent(aba)}`,
      );
      setStores(r.stores || []);
    } catch {}
  }
  // Depende da aba: sem isso o número congelava no que foi carregado na
  // abertura da tela e o botão Atualizar não o alcançava.
  useEffect(() => {
    loadStores(status);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  async function loadCounts() {
    try {
      const r = await api<{ byStatus: Record<string, { name: string; total: number }> }>('/orders/wc/counts');
      const next: Record<string, number> = {};
      next['processing']  = r.byStatus['processing']?.total ?? 0;
      next['pending']     = r.byStatus['pending']?.total ?? 0;
      next['on-hold']     = r.byStatus['on-hold']?.total ?? 0;
      next['separacao']   = r.byStatus['separacao']?.total ?? 0;
      // O backend reparte o `separating` entre as duas abas pela MESMA regra
      // da lista — badge que discorda da tela faz a matriz abrir a aba "pra
      // conferir", e aí o badge não serve pra nada.
      next['pronto-postar'] = r.byStatus['pronto-postar']?.total ?? 0;
      // O backend passou a devolver a aba pronta (regra: shipped + rastreio +
      // dentro da janela). Ler 'shipped' do WC dava 0 pra sempre — lá o pedido
      // despachado vira 'completed'.
      next['em-transito'] = r.byStatus['em-transito']?.total ?? 0;
      next['completed']   = r.byStatus['completed']?.total ?? 0;
      next['cancelled']   = r.byStatus['cancelled']?.total ?? 0;
      // merge (não substitui) pra não apagar o contador de carrinhos,
      // que vem de outro endpoint e pode chegar depois
      setTabCounts((prev) => ({ ...prev, ...next }));
    } catch { /* silencioso */ }
    /**
     * Carrinhos abandonados nos últimos 7 dias — as DUAS lojas.
     *
     * ⚠️ O badge lia só o plugin do WooCommerce e mostrava **23** enquanto o
     * painel da própria aba mostrava **118**: os outros 95 são do site novo,
     * que hoje é a loja. Badge que discorda do painel da mesma tela faz a
     * operação abrir a aba "pra conferir" — e aí o badge não serve pra nada.
     * As duas contas somam aqui, do mesmo jeito que o painel soma lá dentro.
     */
    try {
      const since = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
      const [s, ecom] = await Promise.all([
        api<any>(`/abandoned-carts/stats?since=${since}&_t=${Date.now()}`).catch(() => null),
        api<any>(`/abandoned-carts/ecommerce/stats?since=${since}&_t=${Date.now()}`).catch(() => null),
      ]);
      // stats pode vir PLANO (abandoned) ou ANINHADO (by_status.abandoned.qty)
      const raw = (s as any)?.stats || s || {};
      const by = raw.by_status || {};
      const abandoned = Number(raw.abandoned ?? by.abandoned?.qty ?? by.abandoned?.count ?? 0) || 0;
      const abandonedEcom = Number((ecom as any)?.abandoned ?? 0) || 0;
      setTabCounts((prev) => ({ ...prev, carrinhos: abandoned + abandonedEcom }));
    } catch { /* silencioso */ }
    // Pós-venda: o badge conta só o que EXIGE alguém — avaliação esperando
    // aprovação + entrega que já passou do prazo e ninguém convidou. Contar
    // "entregues no mês" faria um número grande e permanente, que é como se
    // ensina a operação a ignorar a aba.
    try {
      // Endpoint SÓ do badge: puxar a fila inteira (300 pedidos com as
      // avaliações aninhadas) a cada 30s, em todo PC de matriz aberto, seria
      // gastar banco pra desenhar um número de dois dígitos.
      const r = await api<{ aEnviar?: number }>('/pos-venda/resumo');
      setTabCounts((prev) => ({
        ...prev,
        'pos-venda': r?.aEnviar ?? 0,
      }));
    } catch { /* silencioso */ }
  }
  useEffect(() => {
    loadCounts();
    const t = setInterval(loadCounts, 30_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, search, storeCode]);

  // Fetch inicial + socket listener pra issues reportados pelas lojas
  useEffect(() => {
    loadIssues();
    const sock = getSocket();
    const onIssue = () => loadIssues();
    const onIssueResolved = () => loadIssues();
    sock.on('pick-order:issue', onIssue);
    sock.on('pick-order:issue-resolved', onIssueResolved);
    sock.on('pick-order:created', onIssue); // após recalcular, novos pick-orders aparecem
    return () => {
      sock.off('pick-order:issue', onIssue);
      sock.off('pick-order:issue-resolved', onIssueResolved);
      sock.off('pick-order:created', onIssue);
    };
  }, []);

  async function loadIssues() {
    try {
      const rows = await api<ActiveIssue[]>('/pick-orders/issues-active');
      const map: Record<number, ActiveIssue[]> = {};
      for (const r of rows) {
        if (r.wcOrderId == null) continue;
        (map[r.wcOrderId] ||= []).push(r);
      }
      setIssuesByWcId(map);
    } catch (e) {
      console.error('Falha ao carregar issues ativos', e);
    }
  }

  /**
   * Recalcula rota do pedido excluindo automaticamente as lojas que reportaram
   * problema. Backend lê issueReason dos pick-orders e auto-exclui.
   * Resolve os issues atuais — aí badge some e WA pode ser disparado pra nova loja.
   */
  async function recalcularRota(wcId: number) {
    setRecalculating((r) => ({ ...r, [wcId]: true }));
    try {
      const res = await api<{
        ok: boolean;
        reason?: string;
        message?: string;
        excludedStoreCodes?: string[];
        pickOrders?: Array<{ storeCode: string; storeName: string }>;
      }>(`/orders/wc/${wcId}/recalculate-separation`, { method: 'POST' });

      if (res.ok) {
        const lojas = (res.pickOrders || [])
          .map((g) => `${g.storeName} (${g.storeCode})`)
          .join(', ');
        const excl = (res.excludedStoreCodes || []).join(', ');
        alert(
          `✓ Rota recalculada!\n\n` +
          `Nova(s) loja(s): ${lojas || '—'}\n` +
          (excl ? `Excluídas: ${excl}\n\n` : '\n') +
          `Pedido pronto pra novo disparo de WhatsApp.`,
        );
        // Limpa preview em cache pra forçar recálculo na UI
        setPreview((p) => {
          const { [wcId]: _, ...rest } = p;
          return rest;
        });
        await loadIssues();
        await load();
      } else {
        alert(
          `⚠ Não foi possível rotear.\n\n` +
          (res.message || `Motivo: ${res.reason || 'desconhecido'}`),
        );
      }
    } catch (e: any) {
      alert('Erro ao recalcular: ' + (e?.message || e));
    } finally {
      setRecalculating((r) => ({ ...r, [wcId]: false }));
    }
  }

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
    // Marca só o que está na tela: seleção em bloco que pega linha invisível
    // vira mudança de status em pedido que ninguém viu.
    setSelected((prev) => {
      if (prev.size === visiveis.length && visiveis.length > 0) {
        return new Set();
      }
      return new Set(visiveis.map((o) => o.id));
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
   * FLUXO UNIFICADO — "Enviar separação" faz tudo em 1 clique:
   *  1. Confere sessão WhatsApp ativa (se não, redireciona pra conectar)
   *  2. Auto-calcula prévia pros pedidos que ainda não têm (chama prepare-separation)
   *  3. Dispara as mensagens em bloco via backend Baileys (/whatsapp/send-bulk, delay 2.8s)
   *  4. PATCH status → 'separacao' no WC pros pedidos 100% OK
   *     (o backend cria pick-order automaticamente no hook do PATCH — idempotente)
   *
   * Por que mudou: antes o operador precisava clicar "Gerar separação" e DEPOIS
   * "Disparar WhatsApp". Confundia e travava o fluxo. Agora é 1 botão só.
   */
  async function bulkDispararWhatsapp() {
    if (selected.size === 0) return;

    const ids = Array.from(selected);

    // PASSO 0 — confere sessão WA antes de calcular nada (poupa trabalho se cair)
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

    setBulkRunning(true);

    // PASSO 1 — auto-calcula prévia pros IDs que ainda não têm preview em memória.
    // Uso um mapa local porque setState é async e preciso do resultado imediato
    // pra montar as tasks logo abaixo.
    const previewMap: Record<number, SeparationPreview> = { ...preview };
    const missingIds = ids.filter((id) => !previewMap[id]);
    const calcFails: number[] = [];

    if (missingIds.length > 0) {
      setBulkProgress({ done: 0, total: missingIds.length, fails: 0 });
      const CONCURRENCY = 4;
      const queue = [...missingIds];
      async function calcWorker() {
        while (queue.length > 0) {
          const id = queue.shift();
          if (id == null) break;
          try {
            const res = await api<SeparationPreview>(`/orders/wc/${id}/prepare-separation`);
            previewMap[id] = res;
            setPreview((p) => ({ ...p, [id]: res }));
            setExpanded((x) => ({ ...x, [id]: true }));
            setErrorByOrder((e) => ({ ...e, [id]: '' }));
          } catch (e: any) {
            calcFails.push(id);
            setErrorByOrder((er) => ({ ...er, [id]: e?.message || 'Falha ao calcular' }));
          } finally {
            setBulkProgress((p) => (p ? { ...p, done: p.done + 1, fails: calcFails.length } : p));
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, missingIds.length) }, calcWorker));
    }

    // PASSO 2 — monta tasks com base no mapa atualizado
    type Task = { wcId: number; group: SeparationGroup };
    const tasks: Task[] = [];
    const comRuptura: number[] = [];
    const semWhatsapp: Array<{ wcId: number; storeName: string }> = [];

    for (const id of ids) {
      const p = previewMap[id];
      if (!p) continue; // falhou no cálculo — já contado em calcFails
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
      setBulkRunning(false);
      setBulkProgress(null);
      alert(
        'Nenhum pedido apto pra disparo.\n\n' +
        (calcFails.length ? `· ${calcFails.length} falhou(aram) no cálculo de separação\n` : '') +
        (comRuptura.length ? `· ${comRuptura.length} em ruptura (sem estoque)\n` : '') +
        (semWhatsapp.length ? `· ${semWhatsapp.length} com loja sem WhatsApp cadastrado` : ''),
      );
      return;
    }

    const resumoExtras =
      (calcFails.length ? `\n· ${calcFails.length} falhou(aram) no cálculo (ignorados)` : '') +
      (comRuptura.length ? `\n· ${comRuptura.length} em ruptura (ignorados)` : '') +
      (semWhatsapp.length ? `\n· ${semWhatsapp.length} loja(s) sem WhatsApp (ignoradas)` : '');

    if (!window.confirm(
      `Disparar ${tasks.length} mensagem(ns) de WhatsApp e marcar os pedidos como "Separação"?` +
      resumoExtras +
      `\n\n⏳ Uma mensagem a cada ~3 segundos pra evitar spam. ${tasks.length} msgs ≈ ${Math.ceil(tasks.length * 3 / 60)} min.`,
    )) {
      setBulkRunning(false);
      setBulkProgress(null);
      return;
    }

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
    const alvo = BULK_TARGETS.find((t) => t.slug === targetSlug);
    const targetLabel = alvo?.label ?? targetSlug;

    // Cancelar/reembolsar mexe em dinheiro e para a separação nas lojas — a
    // confirmação lista o que acontece, em vez de perguntar "tem certeza?".
    if (alvo?.destrutivo) {
      const oQueAcontece = [
        `${ids.length} pedido(s) ${targetSlug === 'refunded' ? 'vão pra REEMBOLSADO' : 'vão ser CANCELADOS'} no site.`,
        'As ordens de separação em aberto desses pedidos são CANCELADAS — a loja para de separar.',
        'Os pedidos saem da fila e passam a aparecer na aba Cancelados.',
        targetSlug === 'refunded'
          ? 'O estorno do dinheiro NÃO é feito aqui — faça no gateway (PagBank/Pagar.me).'
          : 'Se já foi pago, confira o estorno no gateway.',
      ];
      if (!window.confirm(`${targetLabel.toUpperCase()} · ${ids.length} pedido(s)\n\n${oQueAcontece.join('\n\n')}`)) return;
    } else if (!window.confirm(
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
    // Abas com painel PRÓPRIO não usam a lista de pedidos WC — elas renderizam
    // um componente que busca os dados dele. Pula fetch pra não poluir a rede.
    if (status === 'enviados' || status === 'pos-venda' || status === 'travados') {
      setOrders([]);
      setLoading(false);
      return;
    }
    // Filtra localmente caso backend não suporte o query param.
    // Match flexível: normaliza removendo acentos/case e compara code OU name.
    const normalize = (s: any) =>
      String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();
    const target = normalize(storeCode);
    const filterByStoreLocal = (list: WcOrderListItem[]): WcOrderListItem[] => {
      if (!storeCode) return list;
      const filtered = list.filter((o: any) =>
        (o.pickOrders || []).some((p: any) =>
          normalize(p?.storeCode) === target || normalize(p?.storeName) === target,
        ),
      );
      // DEBUG: ajuda a diagnosticar se filtro não funciona
      // eslint-disable-next-line no-console
      console.log('[separacao filter]', {
        storeCode,
        target,
        total: list.length,
        filtered: filtered.length,
        samplePickOrders: list.slice(0, 3).map((o: any) => ({
          id: o.id,
          picks: (o.pickOrders || []).map((p: any) => ({ code: p?.storeCode, name: p?.storeName })),
        })),
      });
      return filtered;
    };

    // EM TRÂNSITO (19/08): quem responde é o Postgres, não o WooCommerce.
    //
    // A aba pedia `status=shipped` no WC e por isso vivia zerada: quando a loja
    // despacha, o pedido vira **completed** lá (é o hook que dispara o WhatsApp
    // do plugin). Agora o slug vai cru pro backend, que monta a regra de
    // verdade — despachado, COM rastreio e ainda dentro da janela de 30 dias —
    // e devolve junto o último evento do objeto.
    if (status === 'em-transito') {
      try {
        const q = new URLSearchParams({ status: 'em-transito', per_page: '50' });
        if (search) q.set('search', search);
        if (storeCode) q.set('storeCode', storeCode);
        const res = await api<{ data: WcOrderListItem[] }>(`/orders/wc?${q}`);
        setOrders(filterByStoreLocal(res.data));
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
      return;
    }
    try {
      // Quando filtrando por loja, busca mais (per_page=100) pra compensar filtro local
      const q = new URLSearchParams({ status, per_page: storeCode ? '100' : '50' });
      if (search) q.set('search', search);
      if (storeCode) q.set('storeCode', storeCode);
      const res = await api<{ data: WcOrderListItem[] }>(`/orders/wc?${q}`);
      setOrders(filterByStoreLocal(res.data));
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

  /**
   * 1-CLIQUE — faz TUDO pra 1 pedido só:
   *   - checa WA conectado
   *   - calcula separação (routing)
   *   - dispara WhatsApp pra loja escolhida
   *   - PATCH status → 'separacao' no WC
   *
   * Usa o helper compartilhado `autoSendOrderToStore` (o mesmo do Piloto Automático).
   * Diferença do bulk "Enviar separação": aqui é 1 linha e abre alert detalhado.
   */
  async function umClique(wcId: number) {
    setBusy((b) => ({ ...b, [wcId]: true }));
    setErrorByOrder((e) => ({ ...e, [wcId]: '' }));
    try {
      const outcome = await autoSendOrderToStore(wcId, { skipWaStatusCheck: false });
      if (outcome.ok) {
        // Se o filtro atual != separacao, tira da lista (já foi)
        if (status !== 'separacao') {
          setOrders((prev) => prev.filter((o) => o.id !== wcId));
        } else {
          await load();
        }
        const lojas = outcome.groups.map((g) => `${g.storeName} (${g.storeCode})`).join(', ');
        alert(`✓ Enviado!\n\nLoja(s): ${lojas}\nStatus atualizado pra Separação.`);
      } else {
        if (outcome.reason === 'wa-disconnected') {
          if (window.confirm(outcome.message + '\n\nAbrir tela de conexão WhatsApp?')) {
            window.location.href = '/retaguarda/whatsapp';
          }
        } else {
          setErrorByOrder((er) => ({ ...er, [wcId]: outcome.message }));
          // Se o helper já calculou a prévia, cacheia pra usuário ver
          if (outcome.groups) {
            setPreview((p) => ({
              ...p,
              [wcId]: {
                success: outcome.reason !== 'no-stock',
                strategy: 'single-store',
                shippingMethod: '',
                groups: outcome.groups as any,
                missing: [],
              } as SeparationPreview,
            }));
            setExpanded((x) => ({ ...x, [wcId]: true }));
          }
          alert(`⚠ Falha: ${outcome.message}`);
        }
      }
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
    <AdminShell
      title="Pedidos · Separação"
      subtitle={
        <span>
          Selecione os pedidos e clique em <b className="text-emerald-700">Enviar separação</b> — em 1 clique o sistema calcula a loja, registra a separação e dispara o WhatsApp.
        </span>
      }
      navItems={SEP_NAV}
      activeKey="site"
      noSidebar
      actions={
        <>
          <Link
            href="/"
            className="px-3 py-2 rounded-lg bg-white border border-slate-200 text-sm font-semibold text-slate-700 hover:bg-slate-50 flex items-center gap-1.5"
          >
            <ArrowLeft className="w-4 h-4" />
            Home
          </Link>
          <button
            onClick={() => { load(); loadCounts(); loadStores(status); }}
            className="px-3 py-2 rounded-lg bg-white border border-slate-200 text-sm font-semibold text-slate-700 hover:bg-slate-50 flex items-center gap-1.5"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Atualizar
          </button>
        </>
      }
    >
      {/* A matriz vive nesta tela — é aqui que o alarme tem que aparecer.
          Some sozinho quando não há código de postagem preso. */}
      <AlertaAvisosTroca />

      {/* ─── ALARME DOS TRAVADOS ───
          Barra baixa, uma linha, igual à fila da /minha-loja: o alarme continua
          na tela de qualquer aba, mas parou de ser a parede vermelha de 100px
          que aparecia inclusive em cima de lista vazia. Clique leva pra aba. */}
      {totalTravados > 0 && status !== 'travados' && (
        <button
          type="button"
          onClick={() => setStatus('travados')}
          className="mb-3 flex w-full items-center gap-2 rounded-card border border-crit/30 bg-crit-soft px-3 py-2 text-left text-[13px] font-semibold text-crit hover:bg-crit/10"
        >
          <AlertCircle className="w-4 h-4 shrink-0" />
          {totalTravados} pedido{totalTravados === 1 ? '' : 's'} travado{totalTravados === 1 ? '' : 's'} —
          a loja reportou problema e ninguém decidiu
          <span className="ml-auto text-[12px] font-normal underline">ver</span>
        </button>
      )}

      {/* ─── FILA: o que exige alguém agora ─── */}
      <div role="tablist" className="mb-3 flex flex-wrap items-center gap-1 border-b border-line">
        {FILTROS.filter((f) => f.grupo === 'fila').map((f) => {
          const count = f.slug === 'travados' ? totalTravados : tabCounts[f.slug];
          const active = status === f.slug;
          const tom = f.slug === 'travados' ? 'crit' : 'warn';
          return (
            <button
              key={f.slug}
              role="tab"
              aria-selected={active}
              onClick={() => setStatus(f.slug)}
              className={`relative -mb-px inline-flex items-center gap-2 border-b-2 px-3.5 py-2.5 text-[13px] font-semibold transition-colors ${
                active
                  ? 'border-action text-ink'
                  : 'border-transparent text-ink-soft hover:text-ink'
              }`}
            >
              {f.slug === 'pronto-postar' && <PackageCheck className="w-3.5 h-3.5" />}
              <span>{f.label}</span>
              {count != null && (
                <span
                  className={`rounded-field px-1.5 py-0.5 text-[11px] font-bold tabular-nums ${
                    count === 0
                      ? 'bg-line-soft text-ink-faint'
                      : tom === 'crit'
                        ? 'bg-crit-soft text-crit'
                        : 'bg-warn-soft text-warn'
                  }`}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* ─── ACOMPANHAR: consulta, não trabalho ───
          Mesmo peso visual que a fila era o que fazia 410 concluídos parecerem
          mais importantes que os 15 pedidos esperando separação. */}
      <div className="mb-4 flex flex-wrap items-center gap-x-1 gap-y-1 text-[12.5px]">
        <span className="mr-1 text-[11px] font-bold uppercase tracking-[.11em] text-ink-faint">
          Acompanhar
        </span>
        {FILTROS.filter((f) => f.grupo !== 'fila').map((f) => {
          const count = tabCounts[f.slug];
          const active = status === f.slug;
          return (
            <button
              key={f.slug}
              onClick={() => setStatus(f.slug)}
              className={`inline-flex items-center gap-1.5 rounded-field px-2.5 py-1 transition-colors ${
                active
                  ? 'bg-action text-action-ink font-semibold'
                  : 'text-ink-soft hover:bg-line-soft hover:text-ink'
              }`}
            >
              {f.slug === 'enviados' && <Truck className="w-3 h-3" />}
              {f.slug === 'em-transito' && <Plane className="w-3 h-3" />}
              {f.slug === 'completed' && <CheckCircle2 className="w-3 h-3" />}
              {f.slug === 'pos-venda' && <Star className="w-3 h-3" />}
              <span>{f.label}</span>
              {count != null && f.slug !== 'enviados' && (
                <span className={`tabular-nums ${active ? 'opacity-70' : 'text-ink-faint'}`}>
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Abas com PAINEL PRÓPRIO — "Enviados por Loja" (tracking do dia por
          filial) e "Pós-venda" (avaliações). Early-return aqui mantém o
          header/filtros no topo mas pula toda a UI de pedidos. */}
      {status === 'enviados' ? (
        <EnviadosByStore />
      ) : status === 'pos-venda' ? (
        <PosVenda />
      ) : status === 'travados' ? (
        /* ─── TRAVADOS ───
           O que era banner vermelho repetido em toda aba. Aqui cada problema é
           uma LINHA com a ação que resolve — "Recalcular" reroteia excluindo a
           loja que reportou, exatamente como o botão da lista fazia. */
        totalTravados === 0 ? (
          <div className="rounded-card border border-line bg-surface p-10 text-center text-[13px] text-ink-soft">
            Nenhuma loja reportou problema. Quando alguma bater “sem estoque / defeito /
            divergência”, o pedido aparece aqui.
          </div>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Pedido</Th>
                <Th>Loja que reportou</Th>
                <Th>Motivo</Th>
                <Th>Peça</Th>
                <Th align="right">Reportado</Th>
                <Th align="right">Ação</Th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(issuesByWcId).map(([wcIdStr, issues]) => {
                const wcId = Number(wcIdStr);
                const first = issues[0];
                return (
                  <Tr key={wcIdStr} estado="crit">
                    <Td>
                      <Link
                        href={`/pedidos/wc/${wcId}`}
                        className="font-mono font-semibold text-ink hover:underline"
                      >
                        {first.wcOrderNumber || wcId}
                      </Link>
                    </Td>
                    <Td className="text-ink-soft">
                      {issues
                        .map((i) => i.storeName || i.storeCode || '?')
                        .join(' · ')}
                    </Td>
                    <Td className="font-semibold text-crit">
                      {first.reasonLabel}
                      {issues.length > 1 && ` (+${issues.length - 1})`}
                    </Td>
                    <Td className="text-ink-soft">{first.note || '—'}</Td>
                    <Td align="right" num className="text-ink-soft">
                      {first.reportedAt ? `${fmtDate(first.reportedAt)} atrás` : '—'}
                    </Td>
                    <Td align="right">
                      <div className="flex justify-end gap-2">
                        <button
                          onClick={() => recalcularRota(wcId)}
                          disabled={recalculating[wcId]}
                          className="inline-flex items-center gap-1.5 rounded-field bg-crit px-3 py-1.5 text-[12px] font-semibold text-white hover:opacity-90 disabled:opacity-50"
                          title={`Recalcular excluindo: ${issues
                            .map((i) => i.storeCode)
                            .filter(Boolean)
                            .join(', ')}`}
                        >
                          {recalculating[wcId] ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <RefreshCw className="w-3.5 h-3.5" />
                          )}
                          Recalcular
                        </button>
                        <Link
                          href={`/pedidos/wc/${wcId}`}
                          className="inline-flex items-center rounded-field border border-line px-3 py-1.5 text-[12px] font-semibold text-ink hover:bg-surface-2"
                        >
                          Abrir
                        </Link>
                      </div>
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        )
      ) : (
      <>
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

        {/* ─── FILTRO ORIGEM (SITE / LIVE / ONLINE / ECOMMERCE) ───
             ONLINE = venda online do PDV da loja (nº ON-xxxxxx). Fica ao lado
             da Live porque é o mesmo tipo de fila: pedido que a LOJA abriu. */}
        <div className="flex items-center gap-1 ml-3">
          {([['', 'Todos'], ['site', 'Site'], ['live', 'Live'], ['pdv_online', 'Online'], ['ecommerce', 'Ecommerce']] as const).map(([val, label]) => (
            <button
              key={val || 'todos'}
              type="button"
              onClick={() => setSourceFilter(val)}
              /* Filtro é escolha, não estado — no Semáforo ele não ganha cor
                 própria: o selecionado é o grafite da ação. Rosa/violeta/teal
                 aqui eram três cores gastas num seletor. */
              className={`rounded-field border px-3 py-1.5 text-xs font-semibold transition ${
                sourceFilter === val
                  ? 'border-action bg-action text-action-ink'
                  : 'border-line bg-surface text-ink-soft hover:bg-surface-2 hover:text-ink'
              }`}
              title={
                val === 'live'
                  ? 'Só pedidos da Live Commerce'
                  : val === 'site'
                    ? 'Só pedidos do site antigo (WooCommerce)'
                    : val === 'ecommerce'
                      ? 'Só pedidos do site novo (nº LP-xxxxxx)'
                      : val === 'pdv_online'
                        ? 'Só vendas online das lojas (nº ON-xxxxxx)'
                        : 'Todas as origens'
              }
            >
              {label}
            </button>
          ))}
        </div>

        {/* ─── FILTRO LOJA RESPONSÁVEL ─── */}
        <div className="flex items-center gap-2 ml-auto">
          <span className="text-xs font-bold uppercase tracking-wider text-slate-600">
            Loja:
          </span>
          <select
            value={storeCode}
            onChange={(e) => setStoreCode(e.target.value)}
            className="px-3 py-2 border rounded text-sm bg-white min-w-[200px]"
            title={
              status === 'pronto-postar'
                ? 'O número é quantas caixas desta loja esperam postagem'
                : 'O número é quantos pedidos esta loja tem PRA SEPARAR agora'
            }
          >
            <option value="">Todas as lojas</option>
            {stores.map((s) => (
              <option key={s.code} value={s.code}>
                {s.name}{s.openOrders > 0 ? ` (${s.openOrders})` : ''}
              </option>
            ))}
          </select>
          {storeCode && (
            <button
              type="button"
              onClick={() => setStoreCode('')}
              className="px-2 py-1 text-xs text-slate-500 hover:text-rose-700"
              title="Limpar filtro de loja"
            >
              ✕
            </button>
          )}
        </div>
      </form>

      {/* Aviso de filtro ativo */}
      {storeCode && (
        <div className="mb-3 px-3 py-2 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-900 flex items-center gap-2">
          <span>📦 Mostrando apenas pedidos da loja</span>
          <strong>{stores.find((s) => s.code === storeCode)?.name || storeCode}</strong>
          <span className="text-blue-700/70 ml-auto text-xs">
            {visiveis.length} pedido{visiveis.length === 1 ? '' : 's'}
          </span>
        </div>
      )}

      {/* A antiga parede vermelha de issues virou a aba "Travados" + a barra
          baixa lá em cima. Alarme que fica sempre na tela deixa de ser alarme. */}

      {/* Barra de seleção em bloco — SEMPRE VISÍVEL quando há pedidos */}
      {visiveis.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <button
              onClick={toggleAll}
              className="flex items-center gap-2 rounded-field border border-line bg-surface px-3 py-1.5 text-[12.5px] font-semibold text-ink transition hover:bg-surface-2"
              title="Selecionar/desmarcar todos os pedidos da lista"
            >
              {selected.size === visiveis.length ? (
                <>
                  <CheckSquare className="w-4 h-4" /> Desmarcar todos
                </>
              ) : (
                <>
                  <Square className="w-4 h-4" /> Marcar todos ({visiveis.length})
                </>
              )}
            </button>

            {selected.size > 0 && selected.size < visiveis.length && (
              <button
                onClick={clearSelection}
                className="text-[12.5px] text-ink-soft underline hover:text-ink"
              >
                Limpar seleção
              </button>
            )}
          </div>

          <div className="text-[12.5px] text-ink-soft">
            {loading ? (
              'Carregando…'
            ) : (
              <>
                <span className="font-semibold text-ink tabular-nums">{visiveis.length}</span> pedido{visiveis.length === 1 ? '' : 's'} nesta fila
                {selected.size > 0 && (
                  <span className="ml-2 font-semibold text-ink">
                    · {selected.size} selecionado{selected.size === 1 ? '' : 's'}
                  </span>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {!visiveis.length && !loading && !search && (
        <div className="mb-3 text-[12.5px] text-ink-faint">0 pedidos nesta fila</div>
      )}

      {/* BUSCA ATIVA — a lista deixou de ser a aba (25/08).
          Com termo digitado o backend varre TODOS os status; sem dizer isso na
          cara, a matriz olha a aba "Processando" selecionada, vê um pedido
          `separating` na lista e acha que a tela mentiu. */}
      {search && !loading && (
        <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-brand/30 bg-brand/5 px-3 py-2 text-sm">
          <Search className="w-4 h-4 text-brand shrink-0" />
          <span>
            Buscando <b className="font-mono">{search}</b> em{' '}
            <b>todos os status</b> —{' '}
            <b>{visiveis.length}</b> pedido(s)
          </span>
          <button
            type="button"
            onClick={() => { setSearchInput(''); setSearch(''); }}
            className="text-brand underline hover:text-brand-dark"
          >
            voltar pra aba {FILTROS.find((f) => f.slug === status)?.label ?? status}
          </button>
        </div>
      )}

      {/* COBRANÇA DE VENDA ONLINE ESPERANDO O DINHEIRO — mora aqui porque
          "Pagto pendente" é exatamente o que ela é, e a lista de baixo só
          conhece `Order` (a venda do PDV só vira pedido quando o pagamento
          cai). Ver `CobrancasPdvBloco`. */}
      {status === 'pending' && !search && <CobrancasPdvBloco />}

      {/* Lista */}
      {status === 'carrinhos' && !search ? (
        <CarrinhosTab />
      ) : !loading && visiveis.length === 0 ? (
        search ? (
          /* Busca vazia NÃO é motivo de festa: nada achado é problema de quem
             procura, não conquista da operação. Diz o que foi procurado e
             onde — e avisa se algum filtro ainda está cortando o resultado. */
          <div className="rounded-card border border-line bg-surface p-10 text-center text-[13px] text-ink-soft">
            <div className="font-semibold text-ink">
              Nenhum pedido encontrado para <span className="font-mono">{search}</span>
            </div>
            <div className="mt-1">
              Procuramos por nº do pedido, nome, e-mail, telefone e rastreio — em todos os status.
            </div>
            {(sourceFilter || storeCode) && (
              <div className="mt-2 font-semibold text-warn">
                ⚠ Ainda há filtro ligado
                {sourceFilter ? ` de origem (${sourceFilter})` : ''}
                {sourceFilter && storeCode ? ' e' : ''}
                {storeCode ? ` de loja (${storeCode})` : ''} — pode estar escondendo o pedido.
              </div>
            )}
          </div>
        ) : (
          <div className="rounded-card border border-line bg-surface p-10 text-center text-[13px] text-ink-soft">
            Nenhum pedido{' '}
            {sourceFilter === 'live'
              ? 'da LIVE '
              : sourceFilter === 'site'
                ? 'do site antigo '
                : sourceFilter === 'ecommerce'
                  ? 'do site novo '
                  : sourceFilter === 'pdv_online'
                    ? 'de venda online das lojas '
                    : ''}
            nesta fila agora.
          </div>
        )
      ) : (
        /* ─── A LISTA ───
           Era um cartão por pedido com até 8 badges inline em ordem variável:
           cada linha tinha uma largura diferente e não dava pra descer a lista
           comparando loja com loja. Agora é tabela de coluna fixa, e o ESTADO
           é a faixa lateral do primitivo (crit/warn/ok) — a mesma régua do
           Semáforo usada em /retaguarda/produtos.

           `min-w`: sem piso a tabela ESPREME as dez colunas em 341px no celular
           e o texto vira sopa. Com piso ela rola dentro da própria caixa — a
           página nunca rola de lado. */
        <Table className="min-w-[1080px]">
          <thead>
            <tr>
              <Th className="w-10"> </Th>
              <Th>Pedido</Th>
              <Th>Cliente</Th>
              <Th>Envio</Th>
              <Th>Loja que separa</Th>
              <Th>Situação</Th>
              <Th>Vendedora</Th>
              <Th align="right">Esperando</Th>
              <Th align="right">Valor</Th>
              <Th align="right">Ação</Th>
            </tr>
          </thead>
          <tbody>
          {visiveis.map((o) => {
            const p = preview[o.id];
            const err = errorByOrder[o.id];
            const isBusy = busy[o.id];
            const isExpanded = expanded[o.id];

            const isChecked = selected.has(o.id);
            const orderIssues = issuesByWcId[o.id] || [];
            const hasIssue = orderIssues.length > 0;
            const isRecalculating = recalculating[o.id];

            // HÁ QUANTO TEMPO ESTE PEDIDO ESTÁ PARADO — não é a idade dele.
            // Em "Pronto pra postar" a conta começa quando a loja terminou de
            // separar (`prontoDesde`); nas outras, da entrada na fila. É esse
            // número que acende a faixa: 24h = a fazer, 72h = parado.
            const esperaDesde = (status === 'pronto-postar' && o.prontoDesde) || o.dateCreatedGmt;
            const esperaHoras = esperaDesde
              ? (Date.now() - new Date(esperaDesde.endsWith('Z') ? esperaDesde : esperaDesde + 'Z').getTime()) / 3600000
              : 0;
            // Aba de consulta não tem "atraso": pedido entregue não está esperando ninguém.
            const abaDeFila = !['completed', 'em-transito', 'cancelled'].includes(status);
            const estadoLinha: 'crit' | 'warn' | 'ok' | undefined =
              hasIssue || (abaDeFila && esperaHoras >= 72)
                ? 'crit'
                : abaDeFila && esperaHoras >= 24
                  ? 'warn'
                  : o.shipped
                    ? 'ok'
                    : undefined;

            const shipBadge = classifyShipping(o.shippingMethod, o.shippingState);
            const lojas = (o.pickOrders || [])
              .map((x) => x.storeName || x.storeCode || '?')
              .join(' + ');

            return (
              <Fragment key={o.id}>
                <Tr
                  estado={estadoLinha}
                  className={isChecked ? 'bg-surface-2' : undefined}
                >
                  <Td>
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => toggleOne(o.id)}
                      className="w-4 h-4 accent-action cursor-pointer align-middle"
                      title={isChecked ? 'Remover da seleção' : 'Adicionar à seleção'}
                    />
                  </Td>

                  {/* PEDIDO — o prefixo do número já diz a origem (LP- site novo,
                      ON- venda da loja), então as pílulas coloridas de origem
                      saíram: eram cor gasta em informação que o número carrega. */}
                  <Td>
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => toggleExpanded(o.id)}
                        className="text-ink-faint hover:text-ink"
                        title={isExpanded ? 'Recolher' : 'Ver itens e lojas avaliadas'}
                      >
                        {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                      </button>
                      <Link
                        href={`/pedidos/wc/${o.id}`}
                        className="font-mono text-[12.5px] font-semibold text-ink hover:underline"
                      >
                        {o.number}
                      </Link>
                      {(o as any).orderSource === 'live' && (
                        <span className="text-[10px] font-bold text-ink-soft" title="Pedido da Live Commerce">
                          LIVE
                        </span>
                      )}
                    </div>
                    {/* Na busca a lista deixa de ser a aba: dizer em qual delas
                        o pedido mora é o que impede a matriz de achar que a
                        tela mentiu. */}
                    {search && (o.statusLabel || o.statusLocal) && (
                      o.abaSlug && o.abaSlug !== status ? (
                        <button
                          type="button"
                          onClick={() => { setSearchInput(''); setSearch(''); setStatus(o.abaSlug!); }}
                          className="mt-0.5 block text-[11px] text-ink-soft underline hover:text-ink"
                          title={`Este pedido está na aba "${FILTROS.find((f) => f.slug === o.abaSlug)?.label ?? o.abaSlug}" — clique pra ir`}
                        >
                          {o.statusLabel || o.statusLocal} ↗
                        </button>
                      ) : (
                        <span className="mt-0.5 block text-[11px] text-ink-faint">
                          {o.statusLabel || o.statusLocal}
                        </span>
                      )
                    )}
                  </Td>

                  <Td>
                    <span className="font-medium">{o.customerName || '—'}</span>
                    {o.utmCampaign && (
                      <span
                        className="mt-0.5 block max-w-[220px] truncate text-[11px] text-ink-faint"
                        title={`Veio da campanha: ${o.utmCampaign}`}
                      >
                        {o.utmCampaign}
                      </span>
                    )}
                  </Td>

                  <Td className="text-ink-soft" title={shipBadge.raw || undefined}>
                    {o.shippingMethod ? shipBadge.short : '—'}
                  </Td>

                  <Td className="text-ink-soft">
                    {lojas || <span className="text-ink-faint">a calcular</span>}
                  </Td>

                  {/* SITUAÇÃO — uma frase por linha, na cor do estado. Antes eram
                      até cinco badges disputando a mesma linha de texto. */}
                  <Td>
                    {hasIssue ? (
                      <span
                        className="font-semibold text-crit"
                        title={orderIssues
                          .map((i) => `${i.storeCode || '?'}: ${i.reasonLabel}${i.note ? ` — ${i.note}` : ''}`)
                          .join('\n')}
                      >
                        {orderIssues.length === 1 ? orderIssues[0].reasonLabel : `${orderIssues.length} problemas`}
                      </span>
                    ) : o.rastreio ? (
                      <span
                        className="block max-w-[260px] truncate text-ink-soft"
                        title={[
                          o.rastreio.status,
                          o.rastreio.local,
                          o.rastreio.eventoEm ? `em ${new Date(o.rastreio.eventoEm).toLocaleString('pt-BR')}` : null,
                          o.volumes && o.volumes > 1 ? `${o.volumes} volumes` : null,
                        ].filter(Boolean).join(' · ')}
                      >
                        {o.rastreio.status || 'sem movimento ainda'}
                        {o.rastreio.local ? ` · ${o.rastreio.local}` : ''}
                      </span>
                    ) : status === 'em-transito' && o.trackingCode ? (
                      <span className="text-ink-faint" title="O objeto entrou na fila do rastreio e ainda não foi consultado (o ciclo roda de 30 em 30 minutos).">
                        aguardando 1ª leitura
                      </span>
                    ) : o.shipped ? (
                      <span className="font-semibold text-ok" title={o.trackingCode ? `${o.trackingCarrier || ''} ${o.trackingCode}` : 'Enviado pela loja'}>
                        Enviado{o.trackingCode ? ` · ${o.trackingCode}` : ''}
                      </span>
                    ) : p && !p.success ? (
                      <span className="font-semibold text-crit">Ruptura — nenhuma loja cobre</span>
                    ) : p && p.groups.length > 1 ? (
                      <span className="text-warn">Dividido em {p.groups.length} lojas</span>
                    ) : (
                      <span className="text-ink-faint">—</span>
                    )}
                  </Td>

                  {/* Vendedora: continua editável na linha, mas parou de gritar
                      "◎ Vendedora? ▾" quinze vezes numa tela de quinze pedidos. */}
                  <Td>
                    <SellerTag
                      wcOrderId={o.id}
                      currentSellerId={o.sellerId ?? null}
                      currentSellerName={o.sellerName ?? null}
                      compact
                      onChange={(sellerId, sellerName) => {
                        setOrders((prev) =>
                          prev.map((x) => (x.id === o.id ? { ...x, sellerId, sellerName } : x)),
                        );
                      }}
                    />
                  </Td>

                  <Td
                    align="right"
                    num
                    className={
                      estadoLinha === 'crit' ? 'font-semibold text-crit'
                      : estadoLinha === 'warn' ? 'font-semibold text-warn'
                      : 'text-ink-soft'
                    }
                    title={
                      status === 'pronto-postar' && o.prontoDesde
                        ? 'Tempo desde que a loja terminou de separar'
                        : 'Tempo desde que o pedido entrou na fila'
                    }
                  >
                    {esperaDesde ? fmtDate(esperaDesde) : '—'}
                  </Td>

                  <Td align="right" num className="font-semibold">{fmtMoney(o.total)}</Td>

                  <Td align="right">
                    <div className="flex items-center justify-end gap-1.5">
                      {/* SECUNDÁRIAS: ícone fantasma. Elas existiam com borda e
                          cor própria, e junto com a primária verde davam três
                          botões gritando por linha — 45 na tela. */}
                      {!hasIssue && !p && (
                        <>
                          <button
                            onClick={() => imprimirPedido(o.id)}
                            className="rounded-field p-1.5 text-ink-faint hover:bg-line-soft hover:text-ink"
                            title="Imprimir ordem de separação"
                          >
                            <Printer className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => calcular(o.id)}
                            disabled={isBusy}
                            className="rounded-field p-1.5 text-ink-faint hover:bg-line-soft hover:text-ink disabled:opacity-40"
                            title="Só calcula e mostra qual loja separaria (prévia, sem enviar)"
                          >
                            {isBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <StoreIcon className="w-4 h-4" />}
                          </button>
                        </>
                      )}

                      {hasIssue ? (
                        <button
                          onClick={() => recalcularRota(o.id)}
                          disabled={isRecalculating}
                          className="inline-flex items-center gap-1.5 rounded-field bg-crit px-3 py-1.5 text-[12px] font-semibold text-white hover:opacity-90 disabled:opacity-50"
                          title={`Recalcular excluindo: ${orderIssues.map((i) => i.storeCode).filter(Boolean).join(', ')}`}
                        >
                          {isRecalculating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                          Recalcular
                        </button>
                      ) : p && p.success && p.groups.length === 1 ? (
                        <button
                          onClick={() => dispararWhatsapp(o.id, p.groups[0])}
                          disabled={isBusy || !p.groups[0].whatsapp}
                          className="inline-flex items-center gap-1.5 rounded-field bg-action px-3 py-1.5 text-[12px] font-semibold text-action-ink hover:opacity-90 disabled:opacity-40"
                          title={p.groups[0].whatsapp ? `Enviar pra ${p.groups[0].storeName}` : 'Loja sem WhatsApp cadastrado'}
                        >
                          {isBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                          Enviar pra {p.groups[0].storeName}
                        </button>
                      ) : p && p.success && p.groups.length > 1 ? (
                        <button
                          onClick={() => toggleExpanded(o.id)}
                          className="inline-flex items-center gap-1.5 rounded-field border border-line px-3 py-1.5 text-[12px] font-semibold text-ink hover:bg-surface-2"
                        >
                          Ver as {p.groups.length} lojas
                        </button>
                      ) : !['pronto-postar', 'completed', 'em-transito'].includes(status) ? (
                        /* O botão se chamava "1-CLIQUE" — nome do mecanismo, não
                           da ação. Ele calcula a loja, registra a separação e
                           dispara o WhatsApp: é "Enviar separação". */
                        <button
                          onClick={() => umClique(o.id)}
                          disabled={isBusy}
                          className="inline-flex items-center gap-1.5 rounded-field bg-action px-3 py-1.5 text-[12px] font-semibold text-action-ink hover:opacity-90 disabled:opacity-50"
                          title="Calcula a loja, registra a separação e avisa a loja no WhatsApp"
                        >
                          {isBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
                          Enviar separação
                        </button>
                      ) : (
                        <button
                          onClick={() => imprimirPedido(o.id)}
                          className="inline-flex items-center gap-1.5 rounded-field border border-line px-3 py-1.5 text-[12px] font-semibold text-ink hover:bg-surface-2"
                          title="Imprimir ordem de separação"
                        >
                          <Printer className="w-3.5 h-3.5" />
                          Imprimir
                        </button>
                      )}
                    </div>
                  </Td>
                </Tr>

                {err && (
                  <tr>
                    <td colSpan={10} className="border-b border-line-soft bg-crit-soft px-4 py-2 text-[12px] font-medium text-crit">
                      {err}
                    </td>
                  </tr>
                )}

                {/* Área expandida — itens, lojas avaliadas e mensagem do WhatsApp */}
                {isExpanded && p && (
                  <tr>
                    <td colSpan={10} className="border-b border-line-soft p-0">
                  <div className="bg-surface-2 px-4 py-3">
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
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
          </tbody>
        </Table>
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

              {/* AÇÃO PRIMÁRIA — faz tudo (calcula loja + registra separação + envia WA + muda status) */}
              <button
                onClick={bulkDispararWhatsapp}
                disabled={bulkRunning}
                className="px-4 py-2 rounded text-sm font-bold text-white bg-green-600 hover:bg-green-700 disabled:opacity-50 flex items-center gap-2 ring-2 ring-green-400 shadow-lg"
                title="1 clique faz tudo: calcula a loja → registra separação → envia WhatsApp → muda status do pedido pra Separação"
              >
                {bulkRunning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                Enviar separação ({selected.size})
              </button>

              {/* AÇÃO SECUNDÁRIA — só pré-visualiza qual loja pegaria, sem disparar nada */}
              <button
                onClick={bulkPrepareSeparation}
                disabled={bulkRunning}
                className="px-3 py-1.5 rounded text-sm font-medium text-slate-200 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 flex items-center gap-1.5"
                title="Só calcula qual loja separa cada pedido (prévia, sem enviar WhatsApp nem mudar status)"
              >
                {bulkRunning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <StoreIcon className="w-3.5 h-3.5" />}
                Só calcular prévia
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
         </>
      )}
    </AdminShell>
  );
}



// =================================================================================
// CarrinhosTab — aba "Carrinhos" da tela de separacao.
// Le do plugin Cart Abandonment Recovery for WooCommerce (CartFlows) via
// REST autenticada (HTTPS, sem precisar de MySQL externo).
// Endpoint: /abandoned-carts (que chama /wp-json/flowops/v1/abandoned-carts/list)
// Requer plugin PHP flowops-abandoned-carts em wp-content/mu-plugins/ do WP +
// vars FLOWOPS_WP_BASE e FLOWOPS_WP_KEY no Railway.
// =================================================================================
type CarrinhoAB = {
  id: number;
  email: string;
  first_name?: string;
  last_name?: string;
  phone?: string;
  total?: number;
  cart_total?: number;
  cart_total_brl?: number;
  status?: string;
  order_status?: string;
  time?: string | null;
  unsubscribed?: number | boolean;
  /**
   * Marcou o aviso de WhatsApp no checkout?
   *
   * Vem so das capturas do site novo (source ecommerce-contact). Antes de
   * 17/08 quem NAO marcava era simplesmente escondido da lista — a loja via
   * uma fracao do abandono sem saber. Agora aparece com selo e sem botao de
   * disparo: consentimento e permissao pra CONTATAR, nao pra CONTAR.
   *
   * undefined nas outras origens (pedido, plugin, WooCommerce) — por isso as
   * comparacoes usam `=== false`, e nao falsy.
   */
  optin?: boolean;
  items_count?: number;
  // Origem do registro: undefined = plugin CartFlows; 'woocommerce' = pedido
  // iniciado-sem-pagar trazido pelo fallback WC pra preencher gaps de captura;
  // 'ecommerce' = checkout iniciado-sem-pagar no site NOVO (orders do Postgres).
  source?: string;
  // Só no source='ecommerce': número LP-xxxxxx e itens já embutidos na lista
  // (vêm do nosso banco — não precisa de /full).
  order_number?: string | null;
  // Status CRU do pedido no site novo. `payment_failed` = cartão RECUSADO (a
  // cliente não vai "terminar de pagar"); `awaiting_payment` = PIX/link em
  // aberto. A tela dizia "aguardando pagamento" pros dois.
  pedido_status?: string | null;
  cart_items?: any[];
  // Pedido WC vinculado (quando o CartFlows registrou que o carrinho virou
  // pedido). Usado pra deduplicar contra os itens do fallback WooCommerce.
  order_id?: number | null;
  recovery_id?: string;
  // Campanha de origem (via order_id → Order local com atribuição do WC).
  // null/undefined = carrinho sem pedido ainda ou sem UTM (não atribuível).
  utmCampaign?: string | null;
  /**
   * Chave ESTÁVEL da linha, montada pelo backend (`pedido:`/`contato:`). É por
   * ela que se dá baixa — o `id` da linha de contato é sintético e muda a cada
   * carregamento, então dar baixa por ele daria baixa em outra pessoa amanhã.
   * As origens mortas (plugin WP / WooCommerce) não mandam: ver `chaveCarrinho`.
   */
  chave?: string;
  /** Nascimento da linha (início da inserção dos dados no checkout). */
  criado_em?: string | null;
  /** Preenchido quando a linha já teve baixa — ver o type `Desfecho`. */
  desfecho?: Desfecho | null;
};

/**
 * A BAIXA: "ela não vai fechar, e este é o motivo" (dono, 25/08).
 *
 * A fila só tinha uma saída boa (a cliente paga) e nenhuma saída ruim. Quem
 * ligava, ouvia "achei caro" e desligava não tinha onde registrar — a linha
 * continuava lá e a próxima colega ligava pra ouvir a mesma coisa.
 */
type Desfecho = {
  chave: string;
  telefone?: string | null;
  motivo: string;
  motivoLabel: string;
  observacao?: string | null;
  por: string;
  em?: string | null;
  valor?: number | null;
};
type MotivoBaixa = { slug: string; label: string };
type DesfechoResp = { ok?: boolean; motivos?: MotivoBaixa[]; itens?: Desfecho[] };

/**
 * Chave da linha pras origens que o backend não carimba (plugin do CartFlows e
 * fallback WooCommerce, os dois do site velho). Mesmo formato do backend.
 */
const chaveCarrinho = (c: CarrinhoAB) =>
  c.chave || (c.source === 'woocommerce' ? `wc:${c.id}` : `plugin:${c.id}`);

/**
 * Rede de segurança pros botões do modal: se o GET das baixas falhar, a tela
 * ainda deixa registrar. Quem MANDA na validação é o backend
 * (`common/carrinho-abandonado`) — esta lista é só o rótulo.
 */
const MOTIVOS_FALLBACK: MotivoBaixa[] = [
  { slug: 'preco', label: 'Achou caro' },
  { slug: 'frete', label: 'Frete caro ou demorado' },
  { slug: 'sem_tamanho', label: 'Não tinha o tamanho/cor' },
  { slug: 'so_pesquisando', label: 'Só estava pesquisando' },
  { slug: 'comprou_loja', label: 'Vai comprar na loja física' },
  { slug: 'comprou_fora', label: 'Comprou em outro lugar' },
  { slug: 'pagamento', label: 'Problema no pagamento' },
  { slug: 'sem_resposta', label: 'Não respondeu' },
  { slug: 'desistiu', label: 'Desistiu / adiou a compra' },
  { slug: 'contato_errado', label: 'Telefone errado / não é ela' },
  { slug: 'outro', label: 'Outro (explique)' },
];

/**
 * QUEM JÁ CHAMOU A CLIENTE (dono, 24/08).
 *
 * A fila é aberta por várias pessoas da matriz ao mesmo tempo e nada dizia que
 * alguém já tinha puxado conversa — duas operadoras mandavam o mesmo "posso te
 * ajudar a finalizar?" pra mesma cliente. Chave por TELEFONE, não por linha: a
 * mesma cliente aparece em mais de uma linha (captura + pedido não pago, duas
 * tentativas), e quem foi chamada foi a pessoa.
 */
type Atendimento = { telefone: string; por: string; desde: string | null };
type AtendResp = { ok?: boolean; valeMin?: number; ativos?: Atendimento[] };

/** Mesma normalização do backend (`soDigitosFone`): só dígitos, sem o 55. */
const soDigitosFone = (v: unknown) =>
  String(v ?? '').replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '');

type StatsAB = {
  abandoned?: number;
  recovered?: number;
  completed?: number;
  lost?: number;
  recovery_rate?: number;
  total_abandoned_value?: number;
  total_recovered_value?: number;
};

type ListResp = {
  ok?: boolean;
  items?: CarrinhoAB[];
  rows?: CarrinhoAB[];
  total?: number;
  stats?: StatsAB;
  error?: string;
  warning?: string;
};

function CarrinhosTab() {
  const [items, setItems] = useState<CarrinhoAB[]>([]);
  const [stats, setStats] = useState<StatsAB | null>(null);
  /** telefone (só dígitos) → quem assumiu. Ver o type `Atendimento`. */
  const [atendimentos, setAtendimentos] = useState<Record<string, Atendimento>>({});
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [dias, setDias] = useState(7);
  const [statusF, setStatusF] = useState<'abandoned' | 'completed' | 'naoconvertido' | 'all'>('abandoned');
  /** chave da linha → baixa. Ver o type `Desfecho`. */
  const [desfechos, setDesfechos] = useState<Record<string, Desfecho>>({});
  const [motivos, setMotivos] = useState<MotivoBaixa[]>(MOTIVOS_FALLBACK);
  // Carrinho aberto no modal de baixa (null = modal fechado).
  const [baixando, setBaixando] = useState<CarrinhoAB | null>(null);
  const [motivoSel, setMotivoSel] = useState('');
  const [obsBaixa, setObsBaixa] = useState('');
  const [salvandoBaixa, setSalvandoBaixa] = useState(false);
  const [baixaErro, setBaixaErro] = useState<string | null>(null);
  /** Quantos ainda estão dentro da espera de 1h — a tela DIZ, não esconde calada. */
  const [noForno, setNoForno] = useState(0);
  const [search, setSearch] = useState('');
  const [showDiag, setShowDiag] = useState(false);
  const [diag, setDiag] = useState<any>(null);
  const [selected, setSelected] = useState<CarrinhoAB | null>(null);
  const [detail, setDetail] = useState<any>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  // "Fechar esta venda no PDV" — importa o carrinho como venda online montada.
  const [importando, setImportando] = useState(false);
  const [importErro, setImportErro] = useState<string | null>(null);
  const [lastFetch, setLastFetch] = useState<Date | null>(null);
  // Aviso quando os dados vêm do fallback WooCommerce (plugin WP fora do ar).
  const [warning, setWarning] = useState<string | null>(null);
  // Quantos itens foram trazidos do WooCommerce pra preencher gaps de captura
  // do plugin (pedidos iniciados-sem-pagar que o CartFlows não registrou).
  const [wcFill, setWcFill] = useState(0);
  // Quantos vieram do e-commerce NOVO (orders source='ecommerce' sem pagamento).
  const [ecomFill, setEcomFill] = useState(0);
  // Auto-refresh a cada 60s pra capturar carrinhos novos do site
  useEffect(() => {
    const t = setInterval(() => { load(); }, 60000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dias, statusF, search]);

  async function openCart(c: CarrinhoAB) {
    setSelected(c);
    setDetail(null);
    // Itens do WooCommerce (preenchimento de gap) não existem no plugin
    // CartFlows, então não têm /full — buscar daria 404. Mostra só o resumo.
    if (c.source === 'woocommerce') {
      setDetailLoading(false);
      return;
    }
    // Carrinho do e-commerce novo já traz os itens embutidos (nosso banco).
    if (c.source === 'ecommerce' || c.source === 'ecommerce-contact') {
      setDetail({ cart_items: c.cart_items || [] });
      setDetailLoading(false);
      return;
    }
    setDetailLoading(true);
    try {
      const d = await api<any>(`/abandoned-carts/${c.id}/full`);
      setDetail(d);
    } catch (e) {
      console.error(e);
    } finally {
      setDetailLoading(false);
    }
  }
  function closeCart() { setSelected(null); setDetail(null); setImportErro(null); }

  /**
   * Abre no PDV uma venda online já montada com as peças e a cliente deste
   * carrinho. O backend reusa o `addItem` (preço/promo iguais ao bipe) e
   * devolve `faltaram` com o que não resolveu — a venda abre com o que deu, em
   * vez de falhar inteiro por causa de uma REF fora do catálogo e jogar a
   * vendedora de volta pro caminho manual.
   */
  async function importarPraPdv(c: CarrinhoAB) {
    setImportando(true);
    setImportErro(null);
    try {
      const r = await api<{
        saleId: string;
        storeCode: string;
        jaExistia?: boolean;
        importados: number;
        total?: number;
        faltaram?: string[];
        precoMudou?: string[];
      }>('/pdv/sales/importar-carrinho', {
        method: 'POST',
        // CONTATO CAPTURADO no checkout manda o `recovery_id` (uuid) — ele não
        // tem pedido nenhum por trás. O `c.id` dessas linhas é SINTÉTICO
        // (970.000.000 + posição na lista) e não existe em tabela nenhuma:
        // mandá-lo como wcOrderId era o "Carrinho 970000006 não encontrado"
        // que fazia este botão morrer justo no carrinho mais comum.
        body: JSON.stringify(
          c.recovery_id
            ? { recoveryId: c.recovery_id }
            : { wcOrderId: c.order_id ?? c.id },
        ),
      });
      // Avisa ANTES de sair da tela — no PDV ela não teria como saber, e
      // fecharia a venda incompleta (ou por outro valor) sem perceber.
      if (r.faltaram?.length) {
        alert(
          `Venda aberta com ${r.importados} de ${r.total ?? r.importados} peça(s).\n\n` +
            `NÃO entraram (bipe na mão no PDV):\n• ${r.faltaram.join('\n• ')}`,
        );
      }
      // Preço da VITRINE ≠ preço do CAIXA: duas réguas de preço diferentes de
      // propósito, que podem não bater na mesma peça. Ela combinou um valor no
      // WhatsApp; quem decide o que cobrar é ela, mas não em silêncio.
      if (r.precoMudou?.length) {
        alert(
          `ATENÇÃO — o caixa cobra outro valor que o site nesta(s) peça(s):\n\n` +
            `• ${r.precoMudou.join('\n• ')}\n\n` +
            `Confira com a cliente o valor combinado antes de finalizar.`,
        );
      }
      // O PDV retoma venda aberta pela chave do localStorage (não aceita id na
      // URL). Escrever aqui e navegar reusa o mecanismo que já existe.
      //
      // ⚠️ A LOJA VAI JUNTO. Pra admin da matriz o PDV abre na loja que ficou
      // no `lurds_pdv_store` da última vez — se ela for outra, a venda que
      // acabou de nascer na loja-canal SITE não é retomada e a operadora cai
      // num PDV vazio, sem entender por quê. Vendedora (role=store) ignora
      // isto: a loja dela vem travada do token.
      try {
        localStorage.setItem('lurds_pdv_store', r.storeCode);
        localStorage.setItem(`lurds_pdv_sale_${r.storeCode}`, r.saleId);
      } catch {}
      window.location.href = '/minha-loja/pdv';
    } catch (e: any) {
      setImportErro(e?.message || 'Não deu pra abrir a venda no PDV.');
    } finally {
      setImportando(false);
    }
  }

  async function load() {
    setLoading(true);
    setErro(null);
    try {
      /**
       * PISO 19/08/2026 — A VIRADA DO SITE (ordem do dono, 25/08).
       *
       * "Excluir todos os carrinhos de 18/08 pra trás, independente de qualquer
       * canal de aquisição." Antes desse dia a fila é lixo da migração: pedido
       * do WooCommerce que morreu com o site velho, PIX vencido há semanas,
       * contato capturado que nunca voltou. Fila com alarme falso velho é fila
       * em que ninguém confia — a mesma regra da fila de tarefas da loja.
       *
       * O piso mora aqui, no `since` que vai pras QUATRO fontes de uma vez
       * (plugin do WP, WooCommerce REST, site novo e contatos capturados) — é
       * o que faz valer "independente do canal". Aumentar o filtro de dias na
       * tela não traz os velhos de volta: o piso ganha do filtro.
       */
      const CORTE_CARRINHOS = '2026-08-19';
      const janela = new Date(Date.now() - dias * 86400000).toISOString().slice(0, 10);
      const since = janela < CORTE_CARRINHOS ? CORTE_CARRINHOS : janela;
      // O plugin do WP não conhece "não convertido" — pra ele essas linhas
      // continuam sendo abandono; quem separa é o mapa de baixas, no cliente.
      const sParam =
        statusF === 'all' ? '' : statusF === 'naoconvertido' ? 'abandoned' : statusF;
      const qsList = new URLSearchParams({ since, per_page: '200' });
      if (sParam) qsList.set('status', sParam);
      if (search) qsList.set('search', search);
      // Cache-bust pra forcar request fresh (Vercel/CDN/browser cache)
      qsList.set('_t', String(Date.now()));

      // Busca TODAS as páginas. O plugin do WP limita a 200 carrinhos por
      // página; num período de 90 dias há centenas (ex.: 463 abandonados).
      // Antes só a página 1 era carregada → os 263+ carrinhos restantes (os
      // mais ANTIGOS, no fim da ordenação por data) nunca apareciam na lista,
      // mesmo o card de KPI mostrando o total cheio.
      const fetchAllCarts = async (): Promise<ListResp> => {
        const first = await api<ListResp>(`/abandoned-carts?${qsList}`);
        const acc: CarrinhoAB[] = [
          ...(((first as any).items || (first as any).rows || []) as CarrinhoAB[]),
        ];
        const totalPages = Number((first as any).total_pages || 1);
        // Só pagina o plugin real; o fallback WooCommerce já é um proxy parcial
        // (1 request por status) e não segue a mesma paginação por offset.
        const isFallback =
          (first as any).source === 'woocommerce-fallback' ||
          !!(first as any).pluginError;
        if (!isFallback && totalPages > 1) {
          const MAX_PAGES = 20; // teto de segurança (~4.000 carrinhos)
          for (let p = 2; p <= Math.min(totalPages, MAX_PAGES); p++) {
            const qs = new URLSearchParams(qsList);
            qs.set('page', String(p));
            qs.set('_t', String(Date.now()));
            try {
              const r = await api<ListResp>(`/abandoned-carts?${qs}`);
              const arr = ((r as any).items || (r as any).rows || []) as CarrinhoAB[];
              if (Array.isArray(arr)) acc.push(...arr);
            } catch { /* uma página falhou — segue com o que já veio */ }
          }
        }
        return { ...first, items: acc };
      };

      // E-commerce NOVO (lurdsplussize.com.br): pedidos do nosso Postgres com
      // checkout iniciado e sem pagamento. Busca 'all' pra somar nos KPIs; a
      // lista filtra pelo status escolhido logo abaixo.
      const qsEcom = new URLSearchParams({ since, status: 'all', _t: String(Date.now()) });
      if (search) qsEcom.set('search', search);

      const [listResp, statsResp, ecomResp, atendResp, baixaResp] = await Promise.all([
        fetchAllCarts().catch((e) => ({ ok: false, error: e?.message } as ListResp)),
        api<any>(`/abandoned-carts/stats?since=${since}&_t=${Date.now()}`).catch(() => null),
        api<ListResp>(`/abandoned-carts/ecommerce/list?${qsEcom}`).catch(() => null),
        // Quem já chamou a cliente (últimas 2h). Vem separado das listas de
        // propósito: a marca é por TELEFONE e vale nas quatro fontes que a tela
        // junta — a mesma cliente costuma aparecer em mais de uma linha.
        api<AtendResp>(`/abandoned-carts/atendimento?_t=${Date.now()}`).catch(() => null),
        // As baixas do período. Lista separada pelo mesmo motivo da de
        // atendimento: a marca vale nas QUATRO fontes que a tela junta.
        api<DesfechoResp>(`/abandoned-carts/desfecho?since=${since}&_t=${Date.now()}`).catch(() => null),
      ]);
      setLastFetch(new Date());

      const mapaAtend: Record<string, Atendimento> = {};
      for (const a of atendResp?.ativos ?? []) {
        if (a?.telefone) mapaAtend[soDigitosFone(a.telefone)] = a;
      }
      setAtendimentos(mapaAtend);

      const mapaBaixa: Record<string, Desfecho> = {};
      for (const d of baixaResp?.itens ?? []) {
        if (d?.chave) mapaBaixa[d.chave] = d;
      }
      setDesfechos(mapaBaixa);
      if (baixaResp?.motivos?.length) setMotivos(baixaResp.motivos);
      setNoForno(Number((ecomResp as any)?.stats?.no_forno ?? 0));

      const ecomAll: CarrinhoAB[] = Array.isArray((ecomResp as any)?.items)
        ? ((ecomResp as any).items as CarrinhoAB[])
        : [];
      const ecomVisiveis = ecomAll.filter((c) => {
        const st = String(c.order_status || '');
        if (statusF === 'abandoned') return st === 'abandoned';
        if (statusF === 'completed') return st === 'recovered';
        if (statusF === 'naoconvertido') return st === 'nao_convertido';
        return true;
      });

      if ((listResp as any)?.ok === false || (listResp as any)?.error) {
        setErro((listResp as any)?.error || 'Falha ao buscar carrinhos.');
        // Site antigo fora do ar não pode esconder os carrinhos do e-commerce
        // novo — eles vêm do nosso banco e continuam aparecendo.
        setItems(ecomVisiveis);
        setWarning(null);
        setWcFill(0);
        setEcomFill(ecomVisiveis.length);
      } else {
        let arr: CarrinhoAB[] = (listResp as any).items || (listResp as any).rows || [];
        if (!Array.isArray(arr)) arr = [];
        // Plugin WP fora → backend caiu pro WooCommerce (dados parciais).
        const usouFallback =
          (listResp as any)?.source === 'woocommerce-fallback' ||
          !!(listResp as any)?.pluginError;

        // MESCLA com o WooCommerce pra preencher janelas onde o CartFlows não
        // capturou (ex.: o plugin de recuperação ficou inativo por dias e não
        // gravou nenhum carrinho). Só faz sentido quando o plugin RESPONDEU
        // (senão já é tudo fallback) e nos filtros de abandonados/todos — em
        // "recuperados" o WC traria milhares de pedidos concluídos.
        let fill = 0;
        if (!usouFallback && statusF !== 'completed') {
          try {
            const qsWc = new URLSearchParams({ since, per_page: '100' });
            if (sParam) qsWc.set('status', sParam);
            if (search) qsWc.set('search', search);
            qsWc.set('_t', String(Date.now()));
            const wc = await api<ListResp>(`/abandoned-carts/wc-pending/list?${qsWc}`);
            const wcItems = (((wc as any)?.items || (wc as any)?.rows || []) as CarrinhoAB[]);
            if (Array.isArray(wcItems) && wcItems.length) {
              // Dedup: não repetir um pedido WC que já está ligado a um carrinho
              // do plugin (order_id do CartFlows == id do pedido WC).
              const jaLigados = new Set(
                arr.map((c) => c.order_id).filter((v) => v != null).map((v) => String(v)),
              );
              const novos = wcItems
                .filter((w) => !jaLigados.has(String(w.id)))
                .map((w) => ({ ...w, source: 'woocommerce' }));
              fill = novos.length;
              arr = [...arr, ...novos];
              // Reordena por data desc (agora misturamos plugin + WC).
              arr.sort((a, b) => {
                const ta = a.time ? Date.parse(a.time) : 0;
                const tb = b.time ? Date.parse(b.time) : 0;
                return tb - ta;
              });
            }
          } catch { /* WC indisponível — segue só com o plugin */ }
        }
        setWcFill(fill);
        // Junta os carrinhos do e-commerce novo (id na faixa 950M — nunca
        // colide com CartFlows nem com pedido WC) e reordena por data.
        if (ecomVisiveis.length) {
          arr = [...arr, ...ecomVisiveis];
          arr.sort((a, b) => {
            const ta = a.time ? Date.parse(a.time) : 0;
            const tb = b.time ? Date.parse(b.time) : 0;
            return tb - ta;
          });
        }
        setEcomFill(ecomVisiveis.length);
        setItems(arr);
        setWarning(usouFallback ? ((listResp as any)?.warning || 'Mostrando dados parciais via WooCommerce — o plugin de carrinhos do site está fora do ar.') : null);
      }
      // Normaliza: o plugin/WC pode mandar PLANO (abandoned) ou ANINHADO
      // (by_status.abandoned.qty/total). A tela lê plano — então achatamos aqui.
      const raw: any = (statsResp as any)?.stats || (statsResp as any) || {};
      const by = raw.by_status || {};
      const pick = (...vs: any[]) => {
        for (const v of vs) if (v !== undefined && v !== null) return Number(v) || 0;
        return 0;
      };
      // Soma o e-commerce novo nos KPIs (o endpoint de stats só cobre o site
      // antigo). Com ecommerce presente, recalcula a taxa em cima do total.
      const somaVal = (list: CarrinhoAB[]) =>
        list.reduce((s, c) => s + Number(c.total ?? c.cart_total ?? c.cart_total_brl ?? 0), 0);
      // `nao_convertido` NÃO entra no card de abandonados: ele é a fila que
      // ainda dá pra trabalhar. Contar baixa ali faria o número chamar a
      // operadora pra um caso que já foi resolvido.
      const ecomAb = ecomAll.filter((c) => c.order_status === 'abandoned');
      const ecomRec = ecomAll.filter((c) => c.order_status === 'recovered');
      const abTot = pick(raw.abandoned, by.abandoned?.qty, by.abandoned?.count) + ecomAb.length;
      const recTot = pick(raw.recovered, raw.completed, by.completed?.qty, by.recovered?.qty) + ecomRec.length;
      setStats({
        abandoned: abTot,
        recovered: recTot,
        lost: pick(raw.lost, by.lost?.qty, by.lost?.count),
        total_abandoned_value: pick(raw.total_abandoned_value, by.abandoned?.total, by.abandoned?.value) + somaVal(ecomAb),
        total_recovered_value: pick(raw.total_recovered_value, by.completed?.total, by.recovered?.total) + somaVal(ecomRec),
        recovery_rate: ecomAll.length
          ? (abTot + recTot > 0 ? (recTot / (abTot + recTot)) * 100 : 0)
          : pick(raw.recovery_rate),
      });
    } catch (e: any) {
      setErro(e?.message || 'Erro de rede');
      setItems([]);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [dias, statusF]);

  async function runDiag() {
    try {
      const d = await api<any>(`/abandoned-carts/schema`);
      setDiag(d);
    } catch (e: any) {
      setDiag({ ok: false, error: e?.message || 'falha' });
    }
    setShowDiag(true);
  }

  function whatsapp(c: CarrinhoAB) {
    const tel = (c.phone || '').replace(/\D/g, '');
    if (!tel || tel.length < 10) { alert('Cliente sem telefone valido.'); return; }
    const phone = `55${tel}`;
    const nome = (c.first_name || '').split(' ')[0] || 'cliente';
    const valor = Number(c.total ?? c.cart_total ?? c.cart_total_brl ?? 0);
    const brl = valor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    const msg = `Ola, ${nome}! Aqui e da Lurd\'s Plus Size. Vi que voce separou pecas no valor de ${brl} no nosso site. Posso te ajudar a finalizar?`;
    /**
     * A CONVERSA ABRE PRIMEIRO, E ISSO É REGRA — não estilo.
     *
     * Tudo o que depende de clique (protocolo do app, popup) tem que sair no
     * gesto síncrono, senão o navegador bloqueia. A marcação vai DEPOIS, sem
     * await: assumir o atendimento é aviso entre colegas, e nunca pode ficar
     * entre a operadora e a conversa com a cliente.
     */
    abrirWhatsApp(phone, msg);
    assumirAtendimento(tel);
  }


  /**
   * Marca "EM ATENDIMENTO" com quem está logado (decisão do dono, 24/08: quem
   * clicou é quem atende — passo manual é passo esquecido).
   *
   * Pinta na hora e só então confirma no servidor: a lista recarrega a cada 60s
   * e a colega ao lado precisa ver a tag AGORA, não no próximo ciclo. Se o POST
   * falhar, a tag some sozinha no recarregamento — o erro se corrige, e não vale
   * um alerta no meio do atendimento.
   */
  async function assumirAtendimento(telefone: string) {
    const chave = soDigitosFone(telefone);
    if (chave.length < 10) return;
    setAtendimentos((prev) => ({
      ...prev,
      [chave]: { telefone: chave, por: 'você', desde: new Date().toISOString() },
    }));
    try {
      const r = await api<{ ok?: boolean; por?: string; desde?: string }>('/abandoned-carts/atendimento', {
        method: 'POST',
        body: JSON.stringify({ telefone: chave }),
      });
      if (r?.ok && r.por) {
        setAtendimentos((prev) => ({
          ...prev,
          [chave]: { telefone: chave, por: r.por!, desde: r.desde ?? new Date().toISOString() },
        }));
      }
    } catch {
      /* ver o comentário acima: a tag se corrige no próximo carregamento */
    }
  }

  /**
   * DÁ BAIXA — "ela não vai fechar, e este é o motivo" (dono, 25/08).
   *
   * Abre o modal com a lista fechada de motivos. Lista fechada porque é o que
   * vira relatório: "achou caro", "tava caro" e "preço" digitados à mão viram
   * três coisas diferentes no fim do mês e não somam.
   */
  function abrirBaixa(c: CarrinhoAB) {
    setBaixando(c);
    setMotivoSel('');
    setObsBaixa('');
    setBaixaErro(null);
  }

  async function confirmarBaixa() {
    if (!baixando || !motivoSel) return;
    const chave = chaveCarrinho(baixando);
    setSalvandoBaixa(true);
    setBaixaErro(null);
    try {
      const r = await api<{ ok?: boolean; error?: string; desfecho?: Desfecho }>(
        '/abandoned-carts/desfecho',
        {
          method: 'POST',
          body: JSON.stringify({
            chave,
            telefone: baixando.phone || '',
            nome: `${baixando.first_name || ''} ${baixando.last_name || ''}`.trim(),
            // Congela o valor: o carrinho de origem some (sessão morre, pedido
            // expira) e sem isto não dá pra somar quanto o motivo PREÇO custou.
            valor: Number(baixando.total ?? baixando.cart_total ?? baixando.cart_total_brl ?? 0),
            motivo: motivoSel,
            observacao: obsBaixa,
          }),
        },
      );
      if (!r?.ok) { setBaixaErro(r?.error || 'Não consegui registrar a baixa.'); return; }
      const salvo: Desfecho = r.desfecho || {
        chave, motivo: motivoSel, motivoLabel: motivoSel, por: 'você', observacao: obsBaixa || null,
        em: new Date().toISOString(),
      };
      setDesfechos((prev) => ({ ...prev, [chave]: salvo }));
      // ⚠️ O item do site novo carrega o próprio `desfecho` (o backend carimba
      // na lista). Sem mexer nele, `baixaDe` continuaria lendo o valor velho no
      // próximo render e a linha ficaria desencontrada com o mapa.
      setItems((prev) => prev.map((i) => (chaveCarrinho(i) === chave
        ? { ...i, desfecho: salvo, order_status: i.order_status === 'abandoned' ? 'nao_convertido' : i.order_status }
        : i)));
      // O backend apaga o atendimento junto: caso encerrado, telefone liberado.
      // A tela reflete na hora — a colega ao lado não pode ver tag de um caso
      // que já foi fechado.
      const tel = soDigitosFone(baixando.phone);
      if (tel) setAtendimentos((prev) => { const n = { ...prev }; delete n[tel]; return n; });
      setBaixando(null);
    } catch (e: any) {
      setBaixaErro(e?.message || 'Não consegui registrar a baixa.');
    } finally {
      setSalvandoBaixa(false);
    }
  }

  /** Desfaz a baixa: baixa errada tem que ter volta, senão ninguém dá a certa. */
  async function voltarPraFila(c: CarrinhoAB) {
    const chave = chaveCarrinho(c);
    setDesfechos((prev) => { const n = { ...prev }; delete n[chave]; return n; });
    // Mesma razão do `confirmarBaixa`: sem limpar o `desfecho` do item, a linha
    // continuava "não convertida" na tela até o refresh de 60s — o clique
    // parecia não ter feito nada, e a operadora clicava de novo.
    setItems((prev) => prev.map((i) => (chaveCarrinho(i) === chave
      ? { ...i, desfecho: null, order_status: i.order_status === 'nao_convertido' ? 'abandoned' : i.order_status }
      : i)));
    try {
      await api('/abandoned-carts/desfecho/reabrir', {
        method: 'POST',
        body: JSON.stringify({ chave }),
      });
    } catch {
      // Falhou: o próximo carregamento (60s) traz a baixa de volta sozinho.
    }
  }

  const fmt = (s: string | null | undefined) => s ? new Date(s + (typeof s === 'string' && s.endsWith('Z') ? '' : ' UTC')).toLocaleString('pt-BR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }) : '-';
  const BRL = (v: number) => (v || 0).toLocaleString('pt-BR', { style:'currency', currency:'BRL' });

  /** A baixa desta linha — do próprio item (site novo) ou do mapa (outras origens). */
  const baixaDe = (c: CarrinhoAB): Desfecho | null =>
    c.desfecho || desfechos[chaveCarrinho(c)] || null;

  const filtered = items.filter((it) => {
    // A baixa vale pras QUATRO fontes, e o backend só sabe carimbar as do site
    // novo — por isso o corte é aqui, onde a lista já está junta.
    const baixa = baixaDe(it);
    if (statusF === 'abandoned' && baixa) return false;
    if (statusF === 'naoconvertido' && !baixa) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    const nome = `${it.first_name || ''} ${it.last_name || ''}`.toLowerCase();
    return (it.email?.toLowerCase().includes(q) || nome.includes(q) || it.phone?.includes(q));
  });

  // Safety-net: se o endpoint de stats vier sem os abandonados (formato divergente),
  // deriva dos próprios itens carregados — assim o card NUNCA fica 0 com lista cheia.
  const itensAbandonados = items.filter((c) => {
    if (baixaDe(c)) return false; // baixa não é fila em aberto
    const st = String(c.order_status || c.status || 'abandoned').toLowerCase();
    return st === 'abandoned' || st === '';
  });
  const valorItensAb = itensAbandonados.reduce(
    (s, c) => s + Number(c.total ?? c.cart_total ?? c.cart_total_brl ?? 0),
    0,
  );
  const abCount = stats?.abandoned ? stats.abandoned : itensAbandonados.length;
  const abValue = stats?.total_abandoned_value ? stats.total_abandoned_value : valorItensAb;

  return (
    <div className="space-y-3">
      {erro && (
        <div className="bg-rose-50 border-2 border-rose-300 rounded-lg p-3 text-sm text-rose-800 flex items-center justify-between gap-2">
          <div className="flex-1"><strong>Erro:</strong> {erro}</div>
          <button onClick={runDiag} className="px-3 py-1.5 bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold rounded whitespace-nowrap">Diagnosticar</button>
        </div>
      )}

      {showDiag && diag && (
        <div className="bg-slate-900 text-emerald-300 border-2 border-slate-700 rounded-lg p-3 text-[11px] font-mono">
          <div className="flex justify-between mb-1">
            <strong>Diagnostico</strong>
            <button onClick={() => setShowDiag(false)} className="text-slate-400 hover:text-white">x</button>
          </div>
          <pre className="overflow-x-auto whitespace-pre-wrap break-all">{JSON.stringify(diag, null, 2)}</pre>
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        <div className="border-2 border-rose-300 bg-rose-50 rounded-lg p-3">
          <div className="text-[10px] font-bold uppercase text-rose-700">Abandonados</div>
          <div className="text-2xl font-black tabular-nums text-rose-800">{abCount}</div>
          <div className="text-[11px] text-rose-700">{BRL(abValue)}</div>
        </div>
        <div className="border-2 border-emerald-300 bg-emerald-50 rounded-lg p-3">
          <div className="text-[10px] font-bold uppercase text-emerald-700">Recuperados</div>
          <div className="text-2xl font-black tabular-nums text-emerald-800">{(stats?.recovered ?? stats?.completed) ?? 0}</div>
          <div className="text-[11px] text-emerald-700">{BRL(stats?.total_recovered_value ?? 0)}</div>
        </div>
        <div className="border-2 border-violet-300 bg-violet-50 rounded-lg p-3">
          <div className="text-[10px] font-bold uppercase text-violet-700">Taxa Recuperacao</div>
          <div className="text-2xl font-black tabular-nums text-violet-800">{Number(stats?.recovery_rate ?? 0).toFixed(1)}%</div>
          <div className="text-[11px] text-violet-700">Ultimos {dias} dias</div>
        </div>
        <div className="border-2 border-amber-300 bg-amber-50 rounded-lg p-3">
          <div className="text-[10px] font-bold uppercase text-amber-700">Receita Pendente</div>
          <div className="text-2xl font-black tabular-nums text-amber-800">{BRL(abValue)}</div>
          <div className="text-[11px] text-amber-700">se nada recuperar</div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 bg-white p-3 rounded-lg border">
        <select value={dias} onChange={(e) => setDias(Number(e.target.value))} className="px-3 py-2 border-2 rounded text-sm font-bold bg-white">
          <option value={1}>Hoje</option>
          <option value={3}>3 dias</option>
          <option value={7}>7 dias</option>
          <option value={15}>15 dias</option>
          <option value={30}>30 dias</option>
          <option value={90}>90 dias</option>
        </select>
        <select value={statusF} onChange={(e) => setStatusF(e.target.value as any)} className="px-3 py-2 border-2 rounded text-sm font-bold bg-white">
          <option value="abandoned">Abandonados</option>
          <option value="completed">Recuperados</option>
          <option value="naoconvertido">Não convertidos</option>
          <option value="all">Todos</option>
        </select>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar nome, email ou telefone..." className="flex-1 min-w-[200px] px-3 py-2 border-2 rounded text-sm" />
        <button onClick={load} className="px-3 py-2 border-2 rounded text-sm font-bold bg-white hover:bg-slate-50">Atualizar</button>
        <button onClick={runDiag} className="px-3 py-2 border-2 rounded text-sm font-bold bg-slate-100 hover:bg-slate-200" title="Schema da tabela CartFlows">Diag</button>
        <span className="text-xs text-slate-500 ml-auto">{filtered.length} {filtered.length === 1 ? 'carrinho' : 'carrinhos'}{wcFill > 0 ? ` · ${wcFill} do site` : ''}{ecomFill > 0 ? ` · ${ecomFill} do ecommerce` : ''}{noForno > 0 ? ` · ${noForno} ainda no checkout (aparecem depois de 1h)` : ''}{lastFetch ? ` · atualizado ${lastFetch.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : ''}</span>
      </div>

      {warning && !erro && (
        <div className="mb-2 bg-amber-50 border-2 border-amber-300 rounded-lg p-3 text-sm text-amber-900 flex items-start gap-2">
          <span className="font-bold">⚠️ Modo parcial:</span>
          <span>{warning} Pra cobertura total, reative o plugin <b>flowops-abandoned-carts</b> no WordPress (ou confira <b>FLOWOPS_WP_BASE</b>/<b>FLOWOPS_WP_KEY</b>) — clique em <b>Diag</b> pra ver o erro.</span>
        </div>
      )}

      {loading ? (
        <div className="bg-white rounded-lg shadow p-8 text-center text-slate-400">Carregando do site...</div>
      ) : filtered.length === 0 ? (
        <div className="bg-white rounded-lg shadow p-8 text-center text-slate-400">
          Nenhum carrinho com esses filtros.
          {!erro && <div className="text-[11px] mt-2 text-slate-500">Se voce sabe que tem carrinhos no plugin do WP, clique em <strong>Diag</strong> pra ver schema da tabela.</div>}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((c) => {
            const status = (c.order_status || c.status || '').toString();
            const isCompleted = status === 'completed' || status === 'recovered';
            const isWc = c.source === 'woocommerce';
            const isEcom = c.source === 'ecommerce';
            const isEcomContact = c.source === 'ecommerce-contact';
            // CARTÃO RECUSADO ≠ AGUARDANDO PAGAMENTO. O primeiro está morto (ela
            // não vai "terminar de pagar" — o banco negou); o segundo é PIX/link
            // em aberto. O mesmo rótulo pros dois mandava a operadora cobrar a
            // conclusão de um pagamento que nunca vai acontecer, e a mensagem
            // certa aqui é outra: "seu cartão foi recusado, quer tentar de novo
            // ou pagar no PIX?".
            const recusado = isEcom && c.pedido_status === 'payment_failed';
            // Alguém da matriz já puxou conversa com ESTA cliente. Sem prazo
            // desde 25/08 — quem tira a tag é a baixa, não o relógio.
            const atendida = atendimentos[soDigitosFone(c.phone)] || null;
            // Já resolvida: "ela não vai fechar, e este é o motivo".
            const baixa = baixaDe(c);
            const nome = `${c.first_name || ''} ${c.last_name || ''}`.trim() || c.email?.split('@')[0] || 'Cliente';
            const valor = Number(c.total ?? c.cart_total ?? c.cart_total_brl ?? 0);
            return (
              <div key={`${c.source || 'wp'}-${c.id}`} onClick={() => openCart(c)} className={`border-2 rounded-lg p-3 flex items-center gap-3 cursor-pointer hover:shadow-md hover:border-blue-400 transition ${isCompleted ? 'border-emerald-200 bg-emerald-50' : baixa ? 'border-slate-200 bg-slate-50 opacity-70' : 'bg-white border-slate-200'}`}>
                <div className="flex-1 min-w-0">
                  <div className="font-bold text-sm text-slate-800 truncate">
                    {nome}
                    {isCompleted && <span className="ml-2 text-[10px] bg-emerald-200 text-emerald-800 px-1.5 py-0.5 rounded font-bold uppercase">Recuperado</span>}
                    {isWc && <span className="ml-2 text-[10px] bg-sky-100 text-sky-700 px-1.5 py-0.5 rounded font-bold uppercase" title="Pedido iniciado no site sem pagamento (via WooCommerce) — o plugin de carrinhos não registrou este">Site</span>}
                    {isEcom && !isCompleted && recusado && <span className="ml-2 text-[10px] bg-rose-100 text-rose-800 px-1.5 py-0.5 rounded font-bold uppercase" title={`Cartão RECUSADO pelo banco — este pagamento não vai se concluir sozinho${c.order_number ? ` (${c.order_number})` : ''}. Se ela tivesse tentado de novo e passado, este pedido nem apareceria aqui.`}>Cartão recusado</span>}
                    {isEcom && !isCompleted && !recusado && <span className="ml-2 text-[10px] bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded font-bold uppercase" title={`Pedido criado no site novo, aguardando confirmação do pagamento${c.order_number ? ` — ${c.order_number}` : ''}`}>Aguardando pagamento</span>}
                    {isEcom && isCompleted && <span className="ml-2 text-[10px] bg-emerald-100 text-emerald-800 px-1.5 py-0.5 rounded font-bold uppercase">Pagamento confirmado</span>}
                    {isEcomContact && <span className="ml-2 text-[10px] bg-violet-100 text-violet-800 px-1.5 py-0.5 rounded font-bold uppercase" title="Nome e WhatsApp capturados antes de existir pedido">Contato capturado</span>}
                    {c.optin === false && <span className="ml-2 text-[10px] bg-slate-200 text-slate-600 px-1.5 py-0.5 rounded font-bold uppercase" title="Nao marcou o aviso de WhatsApp no checkout — aparece aqui para voce ver o volume real de abandono, mas nao pode receber disparo">Sem opt-in</span>}
                    {Boolean(c.unsubscribed) && <span className="ml-2 text-[10px] bg-slate-200 text-slate-700 px-1.5 py-0.5 rounded font-bold uppercase">Optout</span>}
                    {/* SÓLIDA de propósito: as outras tags dizem em que pé está o
                        pagamento; esta diz "não ligue pra esta, já tem gente" — e
                        precisa parar o olho de quem varre a lista. */}
                    {atendida && !baixa && (
                      <span
                        className="ml-2 text-[10px] bg-indigo-600 text-white px-1.5 py-0.5 rounded font-bold uppercase"
                        title={`${atendida.por} abriu a conversa com esta cliente${atendida.desde ? ` em ${fmt(atendida.desde)}` : ''}. A marca fica até alguém dar baixa no carrinho (ou a venda fechar) — não vence mais sozinha.`}
                      >
                        Em atendimento · {atendida.por}
                      </span>
                    )}
                    {/* BAIXA: a linha continua visível (em "Não convertidos" e em
                        "Todos") mas sai da fila de quem trabalha o abandono. */}
                    {baixa && (
                      <span
                        className="ml-2 text-[10px] bg-slate-700 text-white px-1.5 py-0.5 rounded font-bold uppercase"
                        title={`${baixa.por} deu baixa${baixa.em ? ` em ${fmt(baixa.em)}` : ''}${baixa.observacao ? ` — ${baixa.observacao}` : ''}`}
                      >
                        Não convertido · {baixa.motivoLabel}
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-slate-500 flex flex-wrap items-center gap-2 mt-0.5">
                    <span>{c.email || '-'}</span>
                    {c.phone && <span>{c.phone}</span>}
                    <span>{fmt(c.time)}</span>
                    {Number(c.items_count) > 0 && <span>{c.items_count} {Number(c.items_count) === 1 ? 'item' : 'itens'}</span>}
                    {c.utmCampaign && (
                      <span
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-violet-100 text-violet-800 font-bold rounded max-w-[200px] truncate"
                        title={`Veio da campanha: ${c.utmCampaign}`}
                      >
                        📣 {c.utmCampaign}
                      </span>
                    )}
                  </div>
                  {/* O QUE ELA ESCOLHEU (dono, 26/08). A linha dizia só "2 itens"
                      e o detalhe com as peças só abria clicando — quem varre 70
                      carrinhos por dia não clica em 70. Sem isto a menina liga
                      sem saber o que separar nem o que oferecer se o tamanho
                      acabou, que é a primeira pergunta da cliente.
                      Corta em 4: é fila, não é ficha. */}
                  {Array.isArray(c.cart_items) && c.cart_items.length > 0 && (
                    <div className="mt-1 rounded-md border border-slate-200 bg-slate-50 px-2 py-1">
                      {c.cart_items.slice(0, 4).map((p: any, i: number) => (
                        <div key={i} className="text-[11px] leading-snug text-slate-700">
                          <span className="font-bold tabular-nums">{Number(p.quantity || 1)}×</span>{' '}
                          {p.name || p.sku || 'peça'}
                        </div>
                      ))}
                      {c.cart_items.length > 4 && (
                        <div className="text-[11px] italic text-slate-500">
                          + {c.cart_items.length - 4} peça(s)
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <div className={`font-black tabular-nums text-lg whitespace-nowrap ${baixa ? 'text-slate-400 line-through' : 'text-rose-700'}`}>{BRL(valor)}</div>
                {/* NÃO FECHOU — a saída ruim, que antes não existia. Discreto de
                    propósito: o botão grande continua sendo o que dá dinheiro. */}
                {!isCompleted && !baixa && (
                  <button
                    onClick={(e) => { e.stopPropagation(); abrirBaixa(c); }}
                    title="Ela não vai fechar? Registre o motivo e tire da fila"
                    className="px-3 py-2 rounded-lg border-2 border-slate-300 text-slate-600 hover:bg-slate-100 hover:border-slate-400 font-bold text-xs whitespace-nowrap"
                  >
                    Não fechou
                  </button>
                )}
                {baixa && (
                  <button
                    onClick={(e) => { e.stopPropagation(); voltarPraFila(c); }}
                    title={`Baixa por "${baixa.motivoLabel}"${baixa.por ? ` (${baixa.por})` : ''} — clique pra devolver esta cliente pra fila`}
                    className="px-3 py-2 rounded-lg border-2 border-amber-400 text-amber-700 hover:bg-amber-50 font-bold text-xs whitespace-nowrap"
                  >
                    Voltar pra fila
                  </button>
                )}
                {!isCompleted && !baixa && !c.unsubscribed && c.optin !== false && c.phone && (
                  // Já atendida: o botão sai do verde "pode ir" e vira contorno.
                  // Continua clicável de propósito — quem assumiu volta pra
                  // conversa por aqui, e a tag ao lado é que avisa a colega.
                  <button
                    onClick={(e) => { e.stopPropagation(); whatsapp(c); }}
                    title={atendida ? `${atendida.por} já está falando com esta cliente — confira antes de mandar outra mensagem.` : undefined}
                    className={`px-3 py-2 rounded-lg font-bold text-xs whitespace-nowrap ${
                      atendida
                        ? 'border-2 border-emerald-600 text-emerald-700 hover:bg-emerald-50'
                        : 'bg-emerald-600 hover:bg-emerald-700 text-white'
                    }`}
                  >
                    WhatsApp
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── POR QUE ELA NÃO FECHOU ─────────────────────────────────────────
          A saída ruim da fila, que até 25/08 não existia: só dava pra sair
          vendendo. Quem ligava e ouvia "achei caro" não tinha onde registrar, a
          linha continuava vermelha e a próxima colega ligava pra ouvir a mesma
          coisa — alarme falso repetido, que mata a confiança na fila inteira.

          Motivo é LISTA FECHADA porque é o que vira relatório: digitado à mão,
          "achou caro"/"tava caro"/"preço" viram três coisas e não somam. */}
      {baixando && (
        <div className="fixed inset-0 bg-black/60 z-[60] flex items-start justify-center p-4 overflow-y-auto" {...overlayClose(() => setBaixando(null))}>
          <div className="bg-white rounded-2xl w-full max-w-lg my-10 overflow-hidden shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-3 bg-slate-800 text-white flex items-center justify-between gap-3">
              <div className="min-w-0">
                <h2 className="font-black text-lg">Por que ela não fechou?</h2>
                <p className="text-[11px] opacity-90 truncate">
                  {`${baixando.first_name || ''} ${baixando.last_name || ''}`.trim() || 'Cliente'}
                  {' · '}
                  {BRL(Number(baixando.total ?? baixando.cart_total ?? baixando.cart_total_brl ?? 0))}
                </p>
              </div>
              <button onClick={() => setBaixando(null)} className="text-white hover:bg-white/20 rounded-lg w-8 h-8 flex items-center justify-center text-xl font-bold shrink-0">x</button>
            </div>
            <div className="p-5 space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {motivos.map((m) => (
                  <button
                    key={m.slug}
                    type="button"
                    onClick={() => setMotivoSel(m.slug)}
                    className={`text-left px-3 py-2 rounded-lg border-2 text-sm font-bold transition ${
                      motivoSel === m.slug
                        ? 'border-slate-800 bg-slate-800 text-white'
                        : 'border-slate-200 text-slate-700 hover:border-slate-400'
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
              <div>
                <label className="text-[11px] font-bold uppercase text-slate-500">
                  O que ela disse{' '}
                  {motivoSel === 'outro'
                    ? <span className="text-rose-600">(obrigatório neste motivo)</span>
                    : <span className="text-slate-400">(opcional)</span>}
                </label>
                <textarea
                  value={obsBaixa}
                  onChange={(e) => setObsBaixa(e.target.value)}
                  rows={2}
                  maxLength={400}
                  placeholder="O caso em uma linha — é o que a próxima pessoa vai ler."
                  className="w-full mt-1 px-3 py-2 border-2 rounded text-sm"
                />
              </div>
              {baixaErro && <div className="text-xs font-bold text-rose-700">{baixaErro}</div>}
              <div className="text-[11px] text-slate-500 bg-slate-50 border border-slate-200 rounded-lg p-2">
                A cliente sai da fila de abandonados e o <b>atendimento é liberado</b>.
                Errou? O botão <b>Voltar pra fila</b> na linha desfaz.
              </div>
            </div>
            <div className="px-5 py-3 bg-slate-50 border-t border-slate-200 flex items-center gap-2">
              <button onClick={() => setBaixando(null)} className="px-4 py-2 bg-white border-2 border-slate-300 hover:bg-slate-50 text-slate-700 rounded-lg font-bold text-sm">Cancelar</button>
              <button
                onClick={confirmarBaixa}
                disabled={!motivoSel || salvandoBaixa || (motivoSel === 'outro' && obsBaixa.trim().length < 3)}
                className="ml-auto px-4 py-2 bg-slate-800 hover:bg-slate-900 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg font-bold text-sm"
              >
                {salvandoBaixa ? 'Registrando…' : 'Dar baixa — não convertido'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal detalhes do carrinho */}
      {selected && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-start justify-center p-4 overflow-y-auto" {...overlayClose(closeCart)}>
          <div className="bg-white rounded-2xl w-full max-w-3xl my-8 overflow-hidden shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-3 bg-gradient-to-r from-rose-600 to-pink-600 text-white flex items-center justify-between">
              <div>
                <h2 className="font-black text-lg">Carrinho abandonado #{selected.order_number || selected.id}</h2>
                <p className="text-[11px] opacity-90">Dados pra contato direto via WhatsApp ou ligacao.</p>
              </div>
              <button onClick={closeCart} className="text-white hover:bg-white/20 rounded-lg w-8 h-8 flex items-center justify-center text-xl font-bold">x</button>
            </div>
            <div className="p-5 space-y-4">
              {detailLoading && <div className="text-center text-slate-400 py-2">Carregando detalhes...</div>}

              {selected.source === 'ecommerce' && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-[12px] text-amber-900">
                  <b>Pedido do e-commerce novo.</b> {selected.order_status === 'recovered' ? 'Pagamento confirmado' : 'Aguardando confirmação do pagamento'}{selected.order_number ? <> — pedido <b>{selected.order_number}</b></> : null}. Os itens abaixo vêm direto do nosso banco.
                </div>
              )}

              {selected.source === 'ecommerce-contact' && (
                <div className="bg-violet-50 border border-violet-200 rounded-lg p-3 text-[12px] text-violet-900">
                  <b>Contato capturado no checkout.</b> A cliente informou nome e WhatsApp, mas ainda não criou um pedido. Os itens abaixo são o retrato da sacola nesse momento.
                </div>
              )}

              {selected.source === 'woocommerce' && (
                <div className="bg-sky-50 border border-sky-200 rounded-lg p-3 text-[12px] text-sky-900">
                  <b>Origem: WooCommerce.</b> Este é um pedido iniciado no site sem pagamento, trazido pra preencher um período em que o plugin de carrinhos não registrou nada. Os itens do carrinho não ficam disponíveis por aqui — consulte o pedido #{selected.id} no WooCommerce/painel do site.
                </div>
              )}

              <section>
                <h3 className="text-xs font-bold uppercase text-slate-500 mb-2">Dados da cliente</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-sm">
                  <div><span className="text-slate-500">Nome:</span> <b>{`${selected.first_name || ''} ${selected.last_name || ''}`.trim() || '-'}</b></div>
                  <div><span className="text-slate-500">Email:</span> <b>{selected.email || '-'}</b></div>
                  <div><span className="text-slate-500">Telefone:</span> <b className="text-emerald-700">{selected.phone || '-'}</b></div>
                  <div><span className="text-slate-500">Total:</span> <b className="text-rose-700">{BRL(Number(selected.total ?? selected.cart_total ?? selected.cart_total_brl ?? 0))}</b></div>
                  <div><span className="text-slate-500">Abandonado em:</span> {fmt(selected.time)}</div>
                  <div><span className="text-slate-500">Status:</span> {selected.order_status || selected.status || '-'}</div>
                  {(selected.utmCampaign || detail?.utmCampaign) && (
                    <div className="sm:col-span-2">
                      <span className="text-slate-500">Campanha:</span>{' '}
                      <b className="text-violet-700">📣 {selected.utmCampaign || detail?.utmCampaign}</b>
                    </div>
                  )}
                </div>
              </section>

              {detail?.other_fields && (
                <section>
                  <h3 className="text-xs font-bold uppercase text-slate-500 mb-2">Endereco completo</h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-sm bg-slate-50 rounded-lg p-3 border border-slate-200">
                    {detail.other_fields.wcf_billing_address_1 && (
                      <div className="sm:col-span-2"><span className="text-slate-500">Endereco:</span> <b>{detail.other_fields.wcf_billing_address_1}</b></div>
                    )}
                    {detail.other_fields.wcf_billing_address_2 && (
                      <div className="sm:col-span-2"><span className="text-slate-500">Complemento:</span> <b>{detail.other_fields.wcf_billing_address_2}</b></div>
                    )}
                    {detail.other_fields.wcf_billing_city && (
                      <div><span className="text-slate-500">Cidade:</span> <b>{detail.other_fields.wcf_billing_city}</b></div>
                    )}
                    {detail.other_fields.wcf_billing_state && (
                      <div><span className="text-slate-500">UF:</span> <b>{detail.other_fields.wcf_billing_state}</b></div>
                    )}
                    {detail.other_fields.wcf_billing_postcode && (
                      <div><span className="text-slate-500">CEP:</span> <b>{detail.other_fields.wcf_billing_postcode}</b></div>
                    )}
                    {detail.other_fields.wcf_billing_country && (
                      <div><span className="text-slate-500">Pais:</span> <b>{detail.other_fields.wcf_billing_country}</b></div>
                    )}
                  </div>
                </section>
              )}

              <section>
                <h3 className="text-xs font-bold uppercase text-slate-500 mb-2">Produtos no carrinho</h3>
                {!detail?.cart_items || detail.cart_items.length === 0 ? (
                  <div className="text-sm text-slate-400 italic">Sem detalhe de produtos disponivel.</div>
                ) : (
                  <div className="space-y-2">
                    {detail.cart_items.map((p: any, i: number) => (
                      <div key={i} className="flex items-center gap-3 bg-white border-2 border-slate-200 rounded-lg p-2">
                        {p.image ? (
                          <img src={p.image} alt={p.name || 'Produto'} className="w-16 h-16 object-cover rounded border border-slate-200 flex-shrink-0" />
                        ) : (
                          <div className="w-16 h-16 bg-slate-100 border border-slate-200 rounded flex items-center justify-center text-[10px] text-slate-400 flex-shrink-0">sem foto</div>
                        )}
                        <div className="flex-1 min-w-0">
                          {p.permalink ? (
                            <a href={p.permalink} target="_blank" rel="noreferrer" className="font-bold text-sm text-blue-700 hover:underline truncate block">{p.name || `Produto #${p.product_id}`}</a>
                          ) : (
                            <div className="font-bold text-sm text-slate-800 truncate">{p.name || `Produto #${p.product_id}`}</div>
                          )}
                          <div className="text-[11px] text-slate-500 flex flex-wrap gap-2 mt-0.5">
                            {p.sku && <span>SKU: <b>{p.sku}</b></span>}
                            {p.categories && <span>{p.categories}</span>}
                            {p.stock_status && <span className={p.stock_status === 'instock' ? 'text-emerald-700' : 'text-rose-700'}>{p.stock_status === 'instock' ? 'em estoque' : 'sem estoque'}</span>}
                          </div>
                        </div>
                        <div className="text-right whitespace-nowrap">
                          <div className="text-[11px] text-slate-500">{p.quantity || 1}x {BRL(Number(p.price || p.line_subtotal || 0))}</div>
                          <div className="font-black text-slate-900 tabular-nums">{BRL(Number(p.line_subtotal || p.line_total || (Number(p.price || 0) * Number(p.quantity || 1))))}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* ── FECHAR A VENDA NO PDV ──────────────────────────────────
                  Medido em 17/08: 7 carrinhos recuperados no dia, só 2 viraram
                  venda no sistema. Os outros 5 foram pagos por fora (PIX,
                  PayPal, link) e ninguém registrou — cada um custa estoque que
                  não baixa, NF que não sai, dinheiro fora do caixa, comissão
                  que a vendedora não recebe, e o carrinho seguindo como
                  "abandonado" pra sempre.

                  A causa era fricção: remontar 11 peças à mão depois de fechar
                  no WhatsApp. Aqui a venda abre PRONTA — a vendedora só escolhe
                  como recebeu. Só pro carrinho do site novo: é o único que tem
                  os itens no nosso banco (os do plugin WP não têm SKU nosso). */}
              {(selected.source === 'ecommerce' || selected.source === 'ecommerce-contact') &&
                selected.order_status !== 'recovered' && (
                  <section className="mt-3 rounded-lg border-2 border-teal-300 bg-teal-50 p-3">
                    <div className="text-sm font-bold text-teal-900">Cliente já fechou com você?</div>
                    <div className="text-xs text-teal-800 mt-1">
                      Abre uma <b>venda online no PDV já montada</b> com as peças e os dados dela.
                      Você só escolhe como recebeu (PIX, PayPal, link, cartão) e finaliza — aí o
                      estoque baixa, sai NF, entra no caixa e a comissão é sua.
                    </div>
                    <button
                      type="button"
                      disabled={importando}
                      onClick={() => importarPraPdv(selected)}
                      className="mt-2 px-4 py-2 bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white rounded-lg font-bold text-sm"
                    >
                      {importando ? 'Abrindo venda…' : '🛒 Fechar esta venda no PDV'}
                    </button>
                    {importErro && (
                      <div className="mt-2 text-xs font-semibold text-rose-700">{importErro}</div>
                    )}
                  </section>
                )}

              <section className="flex flex-wrap gap-2 pt-2 border-t border-slate-200">
                {selected.phone && !selected.unsubscribed && !baixaDe(selected) && (
                  <button onClick={() => whatsapp(selected)} className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg font-bold text-sm">WhatsApp pra finalizar</button>
                )}
                {/* Quem abriu a ficha pra ver os itens é quem acabou de falar com
                    ela — a saída ruim tem que estar aqui também, senão ela fecha
                    o modal e a linha volta a parecer pendente. */}
                {selected.order_status !== 'recovered' && !baixaDe(selected) && (
                  <button
                    onClick={() => { const c = selected; closeCart(); abrirBaixa(c); }}
                    className="px-4 py-2 bg-white border-2 border-slate-300 hover:bg-slate-100 text-slate-700 rounded-lg font-bold text-sm"
                  >
                    Não fechou — dar baixa
                  </button>
                )}
                {selected.email && (
                  <a href={`mailto:${selected.email}`} className="px-4 py-2 bg-slate-700 hover:bg-slate-800 text-white rounded-lg font-bold text-sm">Email</a>
                )}
                <button onClick={closeCart} className="px-4 py-2 bg-white border-2 border-slate-300 hover:bg-slate-50 text-slate-700 rounded-lg font-bold text-sm ml-auto">Fechar</button>
              </section>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════
   COBRANÇAS DO PDV AGUARDANDO PAGAMENTO — aba "Pagto pendente" (25/08)

   A aba lista `Order` com status `pending`. Só que a venda online da LOJA
   (PIX/link mandado no WhatsApp) **não é pedido enquanto o dinheiro não cai**
   — ela vive como `pdv_sales.status='open'`, e o pedido só nasce no
   fechamento. Resultado: a cobrança na rua não aparecia em tela nenhuma da
   matriz, e o dono não tinha como saber se a cliente pagou.

   Mesma fonte do widget do PDV (`GET /pdv/cobrancas-online`), mesma régua de
   situação — divergir aí é o defeito de badge×tela se repetindo. Sem
   storeCode = rede inteira (a matriz é admin).
   ══════════════════════════════════════════════════════════════════════ */
type CobrancaOnline = {
  saleId: string;
  saleCode: string;
  storeCode: string;
  storeName: string | null;
  customerName: string | null;
  customerPhone: string | null;
  customerCpf: string | null;
  sellerName: string | null;
  entregaTipo: string | null;
  total: number;
  restante: number;
  meio: 'pix' | 'link';
  situacao: 'pago' | 'aguardando' | 'venceu';
  statusGateway: string;
  valor: number;
  link: string | null;
  orderId: string | null;
  createdAt: string;
  tentativas: number;
  horas: number;
};

function CobrancasPdvBloco() {
  const [itens, setItens] = useState<CobrancaOnline[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [aberto, setAberto] = useState(true);
  const [ocupado, setOcupado] = useState<string | null>(null);

  const load = async () => {
    try {
      const r = await api<CobrancaOnline[]>('/pdv/cobrancas-online');
      setItens(Array.isArray(r) ? r : []);
    } catch {
      setItens([]);
    } finally {
      setCarregando(false);
    }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, []);

  if (carregando || itens.length === 0) return null;

  const BRL = (v: number) => (v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const naoPagou = itens.filter((c) => c.situacao === 'venceu').length;
  const pagos = itens.filter((c) => c.situacao === 'pago').length;

  const idade = (h: number) => (h < 1 ? 'agora há pouco' : h < 24 ? `há ${h}h` : `há ${Math.floor(h / 24)}d`);

  const conferir = async (c: CobrancaOnline) => {
    if (!c.orderId) return;
    setOcupado(c.saleId);
    try {
      const rota = c.meio === 'pix' ? 'pagbank' : 'pagarme';
      const r = await api<{ status: string; isPaid?: boolean }>(`/${rota}/pix/check/${c.orderId}`, { method: 'POST' });
      alert(
        r.isPaid || r.status === 'paid'
          ? `PAGOU! A venda #${c.saleCode} fecha sozinha em segundos.`
          : `Ainda não pagou (situação no gateway: ${r.status}).`,
      );
      load();
    } catch (e: any) {
      alert(`Não consegui conferir: ${e?.message || e}`);
    } finally {
      setOcupado(null);
    }
  };

  /** Gera um PIX NOVO do que falta e abre o WhatsApp com o link. */
  const cobrarDeNovo = async (c: CobrancaOnline) => {
    const valor = c.restante > 0 ? c.restante : c.total;
    if (!confirm(`Gerar um PIX NOVO de ${BRL(valor)} pra ${c.customerName || 'esta cliente'}?\n\nO código anterior para de valer.`)) return;
    setOcupado(c.saleId);
    try {
      const pb = await api<{ shortUrl?: string; qrCodeText: string; valor: number }>('/pagbank/pix/create', {
        method: 'POST',
        body: JSON.stringify({
          saleId: c.saleId,
          valor,
          storeCode: c.storeCode,
          customerName: c.customerName || undefined,
          customerCpf: c.customerCpf || undefined,
          expiresInMinutes: 60,
          origem: 'venda_online',
        }),
      });
      const url = pb.shortUrl || '';
      if (url) navigator.clipboard.writeText(url).catch(() => {});
      abrirWhatsApp(
        c.customerPhone || '',
        url
          ? `Oi${c.customerName ? ` ${c.customerName.split(' ')[0]}` : ''}! Segue o PIX de ${BRL(pb.valor)} pra fechar seu pedido 💛\n\nÉ só tocar no link e apertar COPIAR CÓDIGO PIX:\n\n${url}\n\nAssim que o pagamento cair a gente já separa tudo!`
          : `Oi${c.customerName ? ` ${c.customerName.split(' ')[0]}` : ''}! Segue o PIX de ${BRL(pb.valor)} pra fechar seu pedido 💛\n\n${pb.qrCodeText}`,
      );
      load();
    } catch (e: any) {
      alert(`Não consegui gerar o PIX: ${e?.message || e}`);
    } finally {
      setOcupado(null);
    }
  };

  return (
    <div className="mb-3 rounded-lg border-2 border-amber-300 bg-amber-50/60 overflow-hidden">
      <button
        type="button"
        onClick={() => setAberto((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-amber-100/60"
      >
        <span className="text-base leading-none">💳</span>
        <span className="font-bold text-sm text-amber-900">
          {itens.length} cobrança{itens.length > 1 ? 's' : ''} de venda online esperando pagamento
        </span>
        <span className="text-[11px] text-amber-800">
          {pagos > 0 && `· ${pagos} já pagou`}
          {naoPagou > 0 && ` · ${naoPagou} não pagou`}
        </span>
        <span className="ml-auto text-[11px] text-amber-700">{aberto ? 'esconder' : 'ver'}</span>
      </button>
      {aberto && (
        <div className="px-2 pb-2 space-y-1.5">
          <p className="px-1 text-[11px] text-amber-800">
            PIX/link que a loja mandou pra cliente. Enquanto o dinheiro não cai a venda não vira
            pedido — por isso não aparece na lista abaixo.
          </p>
          {itens.map((c) => (
            <div
              key={c.saleId}
              className={`rounded border bg-white px-2.5 py-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm ${
                c.situacao === 'pago'
                  ? 'border-emerald-300'
                  : c.situacao === 'venceu'
                    ? 'border-amber-300'
                    : 'border-slate-200'
              }`}
            >
              <span className="font-mono text-[10px] font-bold bg-slate-100 px-1.5 py-0.5 rounded">
                #{c.saleCode}
              </span>
              <span
                className={`text-[10px] font-black px-1.5 py-0.5 rounded ${
                  c.meio === 'pix' ? 'bg-emerald-100 text-emerald-800' : 'bg-violet-100 text-violet-800'
                }`}
              >
                {c.meio === 'pix' ? 'PIX' : 'LINK'}
              </span>
              {c.situacao === 'pago' ? (
                <span className="text-[10px] font-black px-2 py-0.5 rounded bg-emerald-600 text-white">✓ PAGOU</span>
              ) : c.situacao === 'venceu' ? (
                <span
                  className="text-[10px] font-black px-2 py-0.5 rounded bg-amber-600 text-white"
                  title={`Situação no gateway: ${c.statusGateway}`}
                >
                  ⚠ NÃO PAGOU
                </span>
              ) : (
                <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-amber-100 text-amber-800">
                  ⏳ Aguardando
                </span>
              )}
              <span className="font-semibold text-slate-800 truncate max-w-[220px]">
                {c.customerName || 'Sem nome'}
              </span>
              <span className="text-[11px] text-slate-500">
                {c.storeName || c.storeCode}
                {c.sellerName ? ` · ${c.sellerName}` : ''} · {idade(c.horas)}
                {c.tentativas > 1 ? ` · ${c.tentativas}ª cobrança` : ''}
              </span>
              <span className="ml-auto font-black tabular-nums text-slate-800">{BRL(c.total)}</span>
              <div className="flex gap-1 flex-wrap">
                <button
                  type="button"
                  disabled={ocupado === c.saleId || !c.orderId}
                  onClick={() => conferir(c)}
                  className="px-2 py-1 rounded bg-sky-600 hover:bg-sky-700 disabled:opacity-40 text-white text-[11px] font-bold"
                  title="Perguntar ao gateway se caiu"
                >
                  🔄
                </button>
                {c.link && (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard.writeText(c.link!);
                        alert('Link copiado.');
                      }}
                      className="px-2 py-1 rounded bg-violet-600 hover:bg-violet-700 text-white text-[11px] font-bold"
                      title="Copiar o link que a cliente recebeu"
                    >
                      📋
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        abrirWhatsApp(
                          c.customerPhone || '',
                          c.meio === 'pix'
                            ? `Oi${c.customerName ? ` ${c.customerName.split(' ')[0]}` : ''}! Segue o PIX de ${BRL(c.valor)} pra fechar seu pedido 💛\n\nÉ só tocar no link e apertar COPIAR CÓDIGO PIX:\n\n${c.link}`
                            : `Olá! Link pra pagamento (${BRL(c.total)}):\n\n${c.link}\n\nPIX ou cartão até 12x sem juros.`,
                        )
                      }
                      className="px-2 py-1 rounded bg-green-600 hover:bg-green-700 text-white text-[11px] font-bold"
                      title="Abre no WhatsApp deste PC"
                    >
                      📱
                    </button>
                  </>
                )}
                {c.situacao !== 'pago' && (
                  <button
                    type="button"
                    disabled={ocupado === c.saleId}
                    onClick={() => cobrarDeNovo(c)}
                    className="px-2 py-1 rounded bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 text-white text-[11px] font-bold"
                    title="Gera um PIX novo com o valor que falta e manda pra cliente"
                  >
                    💸 Cobrar de novo
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
