'use client';

/**
 * /minha-loja — Tela do operador de loja (role=store).
 *
 * Fluxo:
 *  1. Carrega perfil do user logado (GET /auth/me). Se não for role=store, redireciona.
 *  2. Lista pick-orders da loja dele (GET /pick-orders/mine) — só ativos por default.
 *  3. Conecta socket na sala `store:{storeId}` e escuta:
 *      - pick-order:new     → adiciona card + dispara notificação + auto-maximize em 5min
 *      - pick-order:status  → atualiza status do card (eco das próprias ações)
 *  4. Botões por status:
 *      - new         → "Iniciar Separação"        → separating
 *      - separating  → "Marcar como Pronto"       → ready
 *      - ready       → "Enviar (rastreio)"        → abre modal → shipped
 *  5. Sem som de alerta. Só notificação visual + title flash + (electron) maximize.
 *
 * Mobile-first: cards grandes, botões grossos, sem menu lateral.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api } from '@/lib/api';
import EnderecoEntregaModal, { enderecoDoPedido } from '@/components/EnderecoEntregaModal';
import { getSocket, disconnectSocket } from '@/lib/socket';
import { parseShippingAddress, formatPhone } from '@/lib/format-address';
import { classifyShipping } from '@/lib/shipping-method';
import { refCorTam, nomeSemVariacao } from '@/lib/peca-linha';
import Logo from '@/components/Logo';
import TrackingTimeline from '@/components/TrackingTimeline';
import ProductThumb from '@/components/ProductThumb';
import PushActivateButton from '@/components/PushActivateButton';
import BipModal from './BipModal';
import SwapModal, { SwapPayload, SwapResponse } from './SwapModal';
import {
  Clock, PlayCircle, CheckCircle2, Truck, Printer, RefreshCw,
  Wifi, WifiOff, X, LogOut, AlertCircle, Barcode, Search, History,
  Package2, ClipboardList, Shuffle, Inbox, Package, ShoppingCart,
  Fingerprint, Zap, Radio, ArrowLeftRight, KeyRound, ScanFace, Smartphone, AlertTriangle,
  Globe, Copy, ChevronDown,
} from 'lucide-react';

type PickStatus = 'new' | 'separating' | 'separated' | 'ready' | 'shipped';

interface PickOrderItem {
  id?: string;
  sku: string;
  quantity: number;
  productName?: string | null;
  variant?: string | null;
  /** REF · COR · TAM — o que a vendedora lê pra achar a peça (13/08). */
  ref?: string | null;
  cor?: string | null;
  tamanho?: string | null;
  assignedStoreId?: string | null;
}

/**
 * Título da peça no card do SITE — MESMO formato do card da LIVE mais abaixo
 * nesta tela (`{refCode} · {cor} {tamanho}`), com a descrição em cinza
 * embaixo. Pedido do site nascido antes de 13/08 não tem REF gravada; aí cai
 * no nome, que é o que essa tela sempre mostrou.
 */
function tituloPeca(it: PickOrderItem): string {
  return refCorTam(it) || it.productName || it.sku;
}

interface PickOrderRow {
  id: string;
  status: PickStatus;
  trackingCode: string | null;
  carrier: string | null;
  correiosPrepostagemId?: string | null;
  correiosGeneratedAt?: string | null;
  createdAt: string;
  updatedAt?: string;
  isTransfer?: boolean;
  transferToStoreCode?: string | null;
  transferToStoreName?: string | null;
  transferToStoreCity?: string | null;
  /**
   * JUNTADA (21/08): pedido dividido com loja ÂNCORA — este card é FEEDER
   * (as peças completam o pedido na âncora, que envia o pacote único pra
   * cliente). Diferente da transferência de retirada: a cliente NÃO busca.
   */
  juntadaFeeder?: boolean;
  /**
   * A MODALIDADE DE VERDADE (21/08) — o que a loja tem que POSTAR, resolvido
   * no backend pela mesma régua da etiqueta. Antes a faixa classificava pelo
   * título e "Frete Grátis" virava "TRANSPORTADORA": a vendedora não sabia se
   * era SEDEX ou PAC.
   */
  servicoEnvio?: 'SEDEX' | 'PAC' | 'RETIRADA' | 'MOTOBOY' | null;
  /**
   * NINGUÉM ESCOLHEU esse serviço — quem decidiu foi a regra de UF (24/08).
   * A faixa avisa em vez de afirmar: no ON-000105 ela escreveu "PAC" num
   * pedido sem forma de entrega e a vendedora, que tinha marcado SEDEX,
   * levou a culpa por uma escolha que o sistema fez sozinho.
   */
  servicoEnvioIncerto?: boolean;
  /** Frete que a cliente pagou foi zero — vira o "(grátis)" ao lado. */
  freteGratis?: boolean;
  /** Caixa deste feeder (nasce quando a bipagem finaliza). */
  caixaJuntada?: {
    code: string;
    status: string; // in_transit | received
    trackingCode: string | null;
    carrier: string | null;
    transportMode: string | null; // 'correios' | 'proprio' | null
  } | null;
  /**
   * Preenchido no card da ÂNCORA: as peças das outras lojas que vêm pra cá.
   * Nasce com a JUNTADA (não com a caixa) — a âncora precisa saber desde o
   * primeiro minuto que o pedido é COMPOSTO e não sai só com o pedaço dela.
   */
  juntadaChegando?: {
    total: number;
    /** Caixas que JÁ chegaram — é o que libera o envio. */
    recebidas: number;
    /** Peças vindo de fora (soma dos feeders). */
    pecasChegando?: number;
    caixas: Array<{
      code: string | null;
      status: string;
      /** separando (sem caixa ainda) · problema (loja reportou) · a_caminho · chegou */
      etapa?: 'separando' | 'problema' | 'a_caminho' | 'chegou';
      fromStoreName: string | null;
      trackingCode: string | null;
      pecas?: number;
    }>;
  } | null;
  customerSnapshot?: {
    name?: string | null;
    cpf?: string | null;
    email?: string | null;
    phone?: string | null;
    pickupStoreCode?: string | null;
    pickupStoreName?: string | null;
    shippingMethod?: string | null;
    wcOrderNumber?: string | null;
    wcOrderId?: number | null;
  } | null;
  order: {
    id: string;
    wcOrderId: number | null;
    wcOrderNumber: string | null;
    /** 'site' | 'live' | 'ecommerce' | 'pdv_online' — pdv_online = card verde ONLINE */
    source?: string | null;
    customerName: string | null;
    customerPhone: string | null;
    customerCpf?: string | null;
    customerEmail?: string | null;
    shippingCep: string | null;
    shippingAddress: string | null;
    totalAmount: number | null;
    wcDateCreated?: string | null;
    isPickup?: boolean;
    pickupStoreCode?: string | null;
    shippingMethod?: string | null;
    items?: PickOrderItem[];
  };
}

/**
 * PEDIDO QUE ESTA LOJA VENDEU ONLINE (GET /pick-orders/vendi-online).
 *
 * Não é fila de trabalho: quem separa é outra loja. É acompanhamento — a
 * vendedora fechou no WhatsApp e precisa responder "cadê o meu pedido?" sem
 * ligar pra matriz.
 */
interface VendidoOnlineRow {
  id: string;
  wcOrderNumber: string | null;
  wcOrderId: number | null;
  source?: string | null;
  status: string;
  customerName: string | null;
  customerPhone: string | null;
  totalAmount: number | null;
  pecas: number;
  criadoEm: string | null;
  entrega: { label: string | null; isPickup: boolean; pickupStoreCode: string | null };
  trackingCode: string | null;
  /**
   * Onde o objeto está, do cache que o cron mantém (`rastreio_objetos`). Vem
   * cru — a data é formatada AQUI, no fuso de quem está olhando: o backend roda
   * em UTC e formatar lá sairia 3h atrasado.
   */
  rastreio: {
    status: string | null;
    local: string | null;
    eventoEm: string | null;
    previsaoEm: string | null;
    entregue: boolean;
    entregueEm: string | null;
    consultadoEm: string | null;
  } | null;
  atendendo: Array<{ status: string | null; storeCode: string | null; storeName: string | null }>;
  situacao: {
    chave: 'cancelado' | 'matriz' | 'aguardando' | 'separando' | 'pronto' | 'enviado' | 'entregue';
    rotulo: string;
    detalhe: string;
    tom: 'rose' | 'amber' | 'sky' | 'mint' | 'slate';
  };
  emAndamento: boolean;
}

// ── Pedido da LIVE na fila desta loja (GET /live-pdv/store-queue) ──
interface LiveQueueItem {
  id: string;
  refCode: string;
  descricao: string | null;
  cor: string | null;
  tamanho: string | null;
  qty: number;
  status: string; // separating | shipped
  separatedAt: string | null;
  trackingCode: string | null;
}
interface LiveQueueGroup {
  cartId: string;
  cartNumber?: number | null;
  customerName: string;
  customerPhone: string;
  customerInstagram: string | null;
  customerCpf: string | null;
  customerEmail?: string | null;
  customerCep?: string | null;
  customerEndereco?: string | null;
  customerNumero?: string | null;
  customerComplemento?: string | null;
  customerBairro?: string | null;
  customerCidade?: string | null;
  customerUf?: string | null;
  paymentMethod?: string | null; // 'pix' | 'link'
  subtotalCents?: number | null;
  freteCents?: number | null;
  freteServico?: 'SEDEX' | 'PAC' | null; // forma de envio derivada do CEP
  totalCents?: number | null;
  isPickup?: boolean;
  pickupStoreCode?: string | null;
  pickupStoreName?: string | null;
  paidAt?: string | null;
  liveStoreName: string | null;
  items: LiveQueueItem[];
}

interface MeProfile {
  userId: string;
  email: string;
  role: 'admin' | 'operator' | 'store';
  storeId: string | null;
  storeCode: string | null;
  storeName: string | null;
}

const STATUS_LABEL: Record<PickStatus, string> = {
  new: 'Novo',
  separating: 'Separando',
  separated: 'Pronto p/ postar',
  ready: 'Pronto',
  shipped: 'Enviado',
};
const STATUS_COLOR: Record<PickStatus, string> = {
  new: 'bg-amber-100 text-amber-900 border-amber-300',
  separating: 'bg-blue-100 text-blue-900 border-blue-300',
  separated: 'bg-emerald-100 text-emerald-900 border-emerald-300',
  ready: 'bg-emerald-100 text-emerald-900 border-emerald-300',
  shipped: 'bg-slate-200 text-slate-700 border-slate-300',
};

const CARRIERS = ['Correios', 'Loggi', 'Jadlog', 'Azul Cargo', 'Total Express', 'Retirada', 'Outra'];

export default function MinhaLojaPage() {
  const router = useRouter();
  const [me, setMe] = useState<MeProfile | null>(null);
  const [rows, setRows] = useState<PickOrderRow[]>([]);
  // Pedidos da LIVE pra esta loja separar — entram na MESMA lista dos pedidos
  // do site (formato igual, com a tag "LIVE <loja anfitriã>").
  const [liveRows, setLiveRows] = useState<LiveQueueGroup[]>([]);
  const [liveBusy, setLiveBusy] = useState<string | null>(null);
  const [liveBipCart, setLiveBipCart] = useState<LiveQueueGroup | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [showShippedModal, setShowShippedModal] = useState<PickOrderRow | null>(null);
  const [showBipModal, setShowBipModal] = useState<PickOrderRow | null>(null);
  const [showIssueModal, setShowIssueModal] = useState<PickOrderRow | null>(null);
  // Troca manual de peça na separação (pedido do site OU da live).
  const [swapCtx, setSwapCtx] = useState<
    | { kind: 'pick'; pickOrderId: string; itemId: string; label: string }
    | { kind: 'live'; itemId: string; label: string }
    | null
  >(null);
  // Filtro de aba: null = todos | 'new' | 'separating' | 'ready' (separados+ready)
  const [filterTab, setFilterTab] = useState<'new' | 'separating' | 'ready' | 'shipped' | 'vendi' | null>(null);
  // Recorte da aba ENVIADOS. De/Ate + atalhos e a convencao da casa pra tela
  // com recorte de tempo — nunca dropdown de periodo fixo.
  const hojeISO = new Date().toISOString().slice(0, 10);
  const seteDiasISO = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
  const [envDe, setEnvDe] = useState(seteDiasISO);
  const [envAte, setEnvAte] = useState(hojeISO);
  const [enviados, setEnviados] = useState<PickOrderRow[]>([]);
  // VENDI ONLINE (18/08): o que ESTA loja vendeu, separado por outra. Sem
  // De/Até o backend traz 30 dias + tudo que ainda está em aberto.
  const [vendDe, setVendDe] = useState('');
  const [vendAte, setVendAte] = useState('');
  const [vendidos, setVendidos] = useState<VendidoOnlineRow[]>([]);
  // Pedido com o endereco aberto pra correcao (modal compartilhado com a retaguarda).
  const [editandoEndereco, setEditandoEndereco] = useState<PickOrderRow | null>(null);
  const [toasts, setToasts] = useState<Array<{ id: string; msg: string }>>([]);
  // Badge de realinhamento: qtd de ordens pendentes (filial origem). Atualiza
  // via load inicial + socket 'realignment:new' e 'realignment:sent'.
  const [realignmentPending, setRealignmentPending] = useState(0);
  // Badge de remessas chegando (filial destino). Mostra no card "Receber".
  const [shipmentsIncoming, setShipmentsIncoming] = useState(0);
  // ── FILA DE TAREFAS (piloto 11/08) ──
  // Caixa de remessa ABERTA com peça dentro é a maior fonte de "estoque não
  // baixou": a etiqueta imprime com a caixa aberta, a loja despacha e esquece
  // o "Fechar e enviar" — o destino nunca vê a remessa (caso Piracicaba/Santos
  // 11/08). Tudo que está pendente vira tarefa clicável no topo da home.
  const [openBoxes, setOpenBoxes] = useState<any[]>([]);
  const [incomingShipments, setIncomingShipments] = useState<any[]>([]);
  const [pendingPieces, setPendingPieces] = useState<any[]>([]);
  // NÃO existe tarefa de "gerar etiqueta" aqui — e é de propósito (11/08).
  // A medição no banco derrubou a premissa: só 5 das 203 remessas em trânsito
  // têm etiqueta do sistema, e mesmo assim 639 caixas chegaram e foram
  // recebidas em 30 dias (média 4,1 dias até a entrada). Ou seja, gerar
  // etiqueta é EXCEÇÃO na operação — cobrar isso transformava o caminho normal
  // da casa em parede de alarme vermelho. Quem precisa de etiqueta gera pelo
  // botão da tela Realinhar. O que fecha o ciclo de verdade é o destino DAR
  // ENTRADA, e isso já é tarefa aqui ("Receber remessa").
  //
  // Loja grande (matriz) acumula dezenas de pendências — 50 linhas de uma vez
  // é tão inútil quanto lista nenhuma. Mostra as 10 mais urgentes e abre o
  // resto sob demanda.
  const [showAllTasks, setShowAllTasks] = useState(false);
  // 25/08: a fila nasce FECHADA atrás da barra vermelha — a home abre com o
  // painel de botões à vista e o alarme resumido em uma linha só.
  const [tasksOpen, setTasksOpen] = useState(false);
  const autoMaximizeTimers = useRef<Map<string, number>>(new Map());
  const originalTitleRef = useRef<string>('LURDS ORDER ONE');

  // Set de IDs de pick-orders já "vistos" nessa sessão — usado pra evitar
  // que o popup de PEDIDO NOVO apareça de novo pro mesmo pedido em caso de
  // reconexão do socket, eco duplicado, 2ª aba aberta, ou emit repetido do
  // backend. Persistido em localStorage por loja+dia pra sobreviver a
  // reload/restart do Electron (reseta toda manhã — então se o pedido ficar
  // aberto virando o dia, no máximo notifica 1x por dia).
  const seenPickIdsRef = useRef<Set<string>>(new Set());
  const seenStorageKeyRef = useRef<string>('');

  const loadSeenFromStorage = useCallback((storeId: string) => {
    try {
      const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      const key = `flowops_seen_${storeId}_${today}`;
      seenStorageKeyRef.current = key;
      const raw = localStorage.getItem(key);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) seenPickIdsRef.current = new Set(arr);
      }
      // Limpa chaves de dias anteriores pra não vazar localStorage
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(`flowops_seen_${storeId}_`) && k !== key) {
          localStorage.removeItem(k);
        }
      }
    } catch {}
  }, []);

  const persistSeen = useCallback(() => {
    try {
      if (!seenStorageKeyRef.current) return;
      localStorage.setItem(
        seenStorageKeyRef.current,
        JSON.stringify(Array.from(seenPickIdsRef.current)),
      );
    } catch {}
  }, []);

  // ---------- Auth + initial load ----------
  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_token') : null;
    if (!token) {
      router.push('/login');
      return;
    }
    (async () => {
      try {
        const profile = await api<MeProfile>('/auth/me');
        if (profile.role !== 'store' || !profile.storeId) {
          // Não é operador de loja → manda pra raiz (admin/operator views)
          router.push('/');
          return;
        }
        setMe(profile);
        // Atualiza document.title com "LURDS ORDER ONE [NOME DA LOJA]"
        // Aparece na aba do browser E na barra da janela Electron.
        if (typeof document !== 'undefined') {
          const fullTitle = profile.storeName
            ? `LURDS ORDER ONE ${profile.storeName}`
            : 'LURDS ORDER ONE';
          document.title = fullTitle;
          originalTitleRef.current = fullTitle;
        }
        // Carrega IDs já notificados hoje — protege contra reload do Electron
        if (profile.storeId) loadSeenFromStorage(profile.storeId);
        await Promise.all([loadRows(), loadLiveRows(), loadTasksData()]);
      } catch (err: any) {
        setError(err?.message ?? 'Erro ao carregar perfil');
        if (String(err?.message ?? '').startsWith('401')) {
          router.push('/login');
        }
      } finally {
        setLoading(false);
      }
    })();
    if (typeof document !== 'undefined') {
      originalTitleRef.current = document.title;
    }
  }, [router]);

  // Atalho global: F2 ou Ctrl+K → vai pra tela de consulta de produto.
  // Ajuda MUITO no balcão — vendedora não precisa tirar a mão do leitor.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isSearchShortcut =
        e.key === 'F2' ||
        ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K'));
      if (isSearchShortcut) {
        e.preventDefault();
        router.push('/minha-loja/consultar');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [router]);

  const loadRows = useCallback(async () => {
    try {
      const data = await api<PickOrderRow[]>('/pick-orders/mine');
      setRows(data);
      // Tudo que vem no carregamento inicial é considerado "já visto" pra
      // fins de popup — não dispara notificação sonora/title-flash pra pedido
      // que o operador ABRE o app e já encontra na lista. Popup só pra evento
      // socket REALMENTE novo (pick-order criado AGORA).
      for (const r of data) seenPickIdsRef.current.add(r.id);
      persistSeen();
    } catch (err: any) {
      setError(err?.message ?? 'Erro ao carregar pedidos');
    }
  }, [persistSeen]);

  /**
   * ENVIADOS do periodo — consulta PROPRIA, nao o /mine de sempre.
   *
   * O /mine sem parametro devolve so os ATIVOS (new/separating/ready): o
   * despachado nunca chegava, e por isso a aba nasceu vazia. Com from/to o
   * backend traz os shipped daquele recorte.
   */
  const loadEnviados = useCallback(async () => {
    try {
      const q = new URLSearchParams({ from: envDe, to: envAte }).toString();
      setEnviados(await api<PickOrderRow[]>('/pick-orders/mine?' + q));
    } catch {
      setEnviados([]);
    }
  }, [envDe, envAte]);

  useEffect(() => { if (filterTab === 'shipped') void loadEnviados(); }, [filterTab, loadEnviados]);

  const loadVendidos = useCallback(async () => {
    try {
      const q = vendDe && vendAte ? '?' + new URLSearchParams({ from: vendDe, to: vendAte }).toString() : '';
      setVendidos(await api<VendidoOnlineRow[]>('/pick-orders/vendi-online' + q));
    } catch {
      // Loja que não vende online (ou rota velha no ar) segue sem a aba.
      setVendidos([]);
    }
  }, [vendDe, vendAte]);
  useEffect(() => { void loadVendidos(); }, [loadVendidos]);

  // Pedidos da LIVE pra esta loja (silencioso: loja sem live não vê nada).
  // Pedido FINALIZADO (todas as peças enviadas) sai da home — igual ao site;
  // segue visível na tela /minha-loja/live-expedicao pra marcar "Entregue".
  const loadLiveRows = useCallback(async () => {
    try {
      const data = await api<LiveQueueGroup[]>('/live-pdv/store-queue');
      const pendentes = (Array.isArray(data) ? data : []).filter((g) =>
        (g.items || []).some((it) => it.status === 'separating'),
      );
      setLiveRows(pendentes);
    } catch { /* segue sem live */ }
  }, []);

  // Ações da LIVE (mesma pegada dos pedidos do site: separar → enviar c/ rastreio)
  const liveMarkSeparated = useCallback(async (itemId: string) => {
    setLiveBusy(itemId);
    try {
      await api(`/live-pdv/items/${itemId}/separated`, { method: 'POST', body: JSON.stringify({}) });
      await loadLiveRows();
    } catch (e: any) {
      alert(e?.message || 'Erro ao marcar separado');
    } finally { setLiveBusy(null); }
  }, [loadLiveRows]);
  // Despacho da LIVE: abre MODAL de rastreio (prompt() não funciona no app
  // desktop/Electron — o clique morria sem fazer nada).
  const [liveShipItemId, setLiveShipItemId] = useState<string | null>(null);
  const liveMarkShipped = useCallback((itemId: string) => {
    setLiveShipItemId(itemId);
  }, []);
  const liveSubmitShipped = useCallback(async (itemId: string, trackingCode?: string) => {
    setLiveBusy(itemId);
    try {
      await api(`/live-pdv/items/${itemId}/shipped`, {
        method: 'POST',
        body: JSON.stringify({ trackingCode: trackingCode || undefined }),
      });
      setLiveShipItemId(null);
      await loadLiveRows();
    } catch (e: any) {
      alert(e?.message || 'Erro ao despachar');
    } finally { setLiveBusy(null); }
  }, [loadLiveRows]);

  // Carrega count de realinhamento pendente (pra badge no card do launchpad).
  // Silencioso: se falhar, mostra 0 e segue a vida — não bloqueia a tela.
  // Carrega TUDO que vira tarefa na fila "O que fazer agora" (e alimenta os
  // badges dos cards) numa ida só: caixas abertas da loja, remessas chegando
  // e peças de realinhamento aguardando separação. Silencioso em erro — a
  // fila simplesmente não mostra aquela fonte.
  const loadTasksData = useCallback(async () => {
    const [open, inc, mine] = await Promise.all([
      api<any[]>('/realignment/shipments/open').catch(() => []),
      api<any[]>('/realignment/shipments/incoming').catch(() => []),
      api<any[]>('/realignment/mine').catch(() => []),
    ]);
    // Caixa vazia não é tarefa — só entra caixa com peça dentro.
    setOpenBoxes(Array.isArray(open) ? open.filter((s) => (s?.items || []).length > 0) : []);
    setIncomingShipments(Array.isArray(inc) ? inc : []);
    setPendingPieces(Array.isArray(mine) ? mine : []);
    setShipmentsIncoming(Array.isArray(inc) ? inc.length : 0);
    setRealignmentPending(Array.isArray(mine) ? mine.length : 0);
  }, []);

  // ---------- Socket ----------
  useEffect(() => {
    if (!me) return;
    const socket = getSocket();

    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    const onNew = (pickOrder: any) => {
      if (!pickOrder?.id) return;

      // Guard anti-popup-fantasma: se esse pick-order JÁ foi visto
      // nessa sessão (ou carregado pela lista inicial, ou notificado antes),
      // não dispara popup de novo. Isso cobre:
      //  - reconexão do socket reemitindo evento
      //  - 2ª instância do Electron/aba aberta com mesmo JWT
      //  - retry interno do socket.io
      //  - qualquer reenvio do backend
      if (seenPickIdsRef.current.has(pickOrder.id)) {
        // Ainda sim garante que a lista está atualizada (caso status tenha mudado)
        setRows((prev) =>
          prev.map((r) =>
            r.id === pickOrder.id
              ? {
                  ...r,
                  status: (pickOrder.status as PickStatus) ?? r.status,
                  trackingCode: pickOrder.trackingCode ?? r.trackingCode,
                  carrier: pickOrder.carrier ?? r.carrier,
                }
              : r,
          ),
        );
        return;
      }

      // Guard anti-pedido-antigo: se o pick-order foi criado há mais de 10 min,
      // não faz sentido tocar alarme de "pedido novo" — provavelmente é eco.
      // Ainda coloca na lista mas sem flash/notificação.
      const createdAt = pickOrder.createdAt
        ? new Date(pickOrder.createdAt).getTime()
        : Date.now();
      const isRecent = Date.now() - createdAt < 10 * 60 * 1000;

      seenPickIdsRef.current.add(pickOrder.id);
      persistSeen();

      setRows((prev) => {
        if (prev.some((r) => r.id === pickOrder.id)) return prev;
        const row: PickOrderRow = {
          id: pickOrder.id,
          status: (pickOrder.status as PickStatus) ?? 'new',
          trackingCode: pickOrder.trackingCode ?? null,
          carrier: pickOrder.carrier ?? null,
          createdAt: pickOrder.createdAt ?? new Date().toISOString(),
          order: pickOrder.order ?? {
            id: pickOrder.orderId,
            wcOrderId: null,
            wcOrderNumber: null,
            customerName: null,
            customerPhone: null,
            shippingCep: null,
            shippingAddress: null,
            totalAmount: null,
            items: [],
          },
        };
        return [row, ...prev];
      });

      if (isRecent) {
        triggerNewOrderAlert(pickOrder);
      } else {
        // Pedido antigo chegando via socket (eco): só toast discreto, sem barulho
        pushToast(`Pedido adicionado (eco): #${pickOrder?.order?.wcOrderNumber ?? '—'}`);
      }
    };
    const onStatus = (pickOrder: any) => {
      if (!pickOrder?.id) return;
      setRows((prev) =>
        prev.map((r) =>
          r.id === pickOrder.id
            ? {
                ...r,
                status: pickOrder.status ?? r.status,
                trackingCode: pickOrder.trackingCode ?? r.trackingCode,
                carrier: pickOrder.carrier ?? r.carrier,
              }
            : r,
        ),
      );
    };

    // Matriz cancelou esse pedido pra reatribuir loja → some o card.
    const onRemoved = (payload: { orderId: string; pickOrderId?: string }) => {
      if (!payload?.orderId) return;
      setRows((prev) => prev.filter((r) => r.order?.id !== payload.orderId));
      pushToast('Matriz reatribuiu este pedido a outra loja.');
    };

    // Impressão remota disparada pela matriz: abre hidden window (Electron)
    // ou janela pop-up (browser) apontando pro cupom com ?autoprint=1.
    // A página de impressão se auto-imprime e se fecha.
    const onPrintRequest = (payload: { pickOrderId: string; url: string }) => {
      if (!payload?.url) return;
      const absolute = payload.url.startsWith('http')
        ? payload.url
        : window.location.origin + payload.url;
      // Se estiver no Electron, usa o IPC que abre hidden window silenciosa
      const electron = (window as any).electronAPI;
      if (electron?.silentPrintUrl) {
        electron.silentPrintUrl(absolute).catch((e: any) => {
          console.warn('silentPrintUrl falhou:', e);
          window.open(absolute, 'flowops-print', 'width=400,height=600');
        });
      } else {
        // Browser normal: abre janela popup (vai mostrar preview do browser)
        window.open(absolute, 'flowops-print', 'width=400,height=600');
      }
      pushToast(`🖨️ Imprimindo pedido #${payload.pickOrderId.slice(0, 6)}...`);
    };

    // Realinhamento: matriz despachou ordens pra essa loja origem separar.
    // Payload agregado: { items: [{id,refCode,cor,tamanho,qtyOrigem,...}] }
    // Soma o count no badge + toast pro operador ver que chegou.
    const onRealignmentNew = (payload: any) => {
      const count = Number(payload?.count || payload?.items?.length || 0);
      if (count > 0) {
        setRealignmentPending((prev) => prev + count);
        pushToast(`🔁 Realinhamento: ${count} peça(s) pra separar e enviar`);
      }
      loadTasksData(); // fila "O que fazer agora" reflete na hora
    };
    // Quando a própria loja marca enviado em outra aba — sincroniza badge.
    const onRealignmentSent = (_payload: any) => {
      setRealignmentPending((prev) => Math.max(0, prev - 1));
      loadTasksData();
    };

    // Pedido da LIVE liberado pra esta loja — mesma dinâmica do pedido do site
    // (toast + notificação do SO) e recarrega a fila da live.
    const onLiveSeparationNew = (payload: any) => {
      loadLiveRows();
      const quem = payload?.customerName || 'Cliente';
      const live = payload?.liveStoreName ? ` (LIVE ${String(payload.liveStoreName).toUpperCase()})` : '';
      pushToast(`🔴 Pedido da LIVE${live}: ${quem} — ${payload?.count || 1} peça(s) pra separar!`);
      if (typeof Notification !== 'undefined') {
        const show = () =>
          new Notification('LURDS ORDER ONE — Pedido da LIVE', {
            body: `${quem} · ${payload?.count || 1} peça(s) pra separar${live}`,
            silent: true,
          });
        if (Notification.permission === 'granted') show();
      }
    };

    // Pedido da LIVE RECOLHIDO pela matriz (roteamento repensado) — some da fila
    const onLiveSeparationRemoved = (payload: any) => {
      loadLiveRows();
      const quem = payload?.customerName || 'Cliente';
      pushToast(`↩ Pedido da LIVE de ${quem} foi recolhido pela matriz — pode ignorar.`);
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('pick-order:new', onNew);
    socket.on('pick-order:status', onStatus);
    socket.on('pick-order:removed', onRemoved);
    socket.on('pick-order:print', onPrintRequest);
    socket.on('realignment:new', onRealignmentNew);
    socket.on('realignment:sent', onRealignmentSent);
    socket.on('live-pdv:separation-new', onLiveSeparationNew);
    socket.on('live-pdv:separation-removed', onLiveSeparationRemoved);
    if (socket.connected) setConnected(true);

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('pick-order:new', onNew);
      socket.off('pick-order:status', onStatus);
      socket.off('pick-order:removed', onRemoved);
      socket.off('pick-order:print', onPrintRequest);
      socket.off('realignment:new', onRealignmentNew);
      socket.off('realignment:sent', onRealignmentSent);
      socket.off('live-pdv:separation-new', onLiveSeparationNew);
      socket.off('live-pdv:separation-removed', onLiveSeparationRemoved);
    };
  }, [me, loadLiveRows, loadTasksData]);

  // A fila de tarefas se atualiza sozinha a cada 60s — caixa aberta envelhece
  // e fica vermelha sem depender de reload manual (o PC da loja fica dias aberto).
  useEffect(() => {
    if (!me) return;
    const t = window.setInterval(() => {
      loadTasksData();
      // A vendedora deixa a home aberta o dia todo: sem isso o "Vendi online"
      // congelava no que estava quando ela abriu o PC de manhã.
      void loadVendidos();
    }, 60_000);
    return () => window.clearInterval(t);
  }, [me, loadTasksData, loadVendidos]);

  // ── Monta a fila "O que fazer agora" (vermelho = parado, amarelo = a fazer) ──
  const storeTasks = useMemo(() => {
    const now = Date.now();
    const horas = (iso?: string | null) =>
      iso ? Math.max(0, (now - new Date(iso).getTime()) / 3_600_000) : 0;
    const idadeTxt = (h: number) =>
      h >= 48 ? `${Math.floor(h / 24)} dias` : h >= 1 ? `${Math.floor(h)}h` : `${Math.max(1, Math.round(h * 60))}min`;
    const tasks: Array<{
      key: string; urgency: 'red' | 'yellow'; icon: any; title: string; subtitle: string; go: () => void;
    }> = [];

    for (const s of openBoxes) {
      const h = horas(s.openedAt);
      tasks.push({
        key: `caixa-${s.id}`,
        urgency: h >= 4 ? 'red' : 'yellow',
        icon: Package,
        title: `Fechar caixa ${s.code} → ${s.toStoreName || s.toStoreCode}`,
        subtitle: `${(s.items || []).length} peça(s) · aberta há ${idadeTxt(h)} · o estoque SÓ baixa quando fechar`,
        go: () => router.push('/minha-loja/realinhamento'),
      });
    }
    // RECEBER é a tarefa que fecha o ciclo: enquanto a caixa não entra, a peça
    // não está no estoque de loja nenhuma (nem some da origem, nem aparece
    // aqui) — 1.057 peças estavam nesse limbo em 11/08. O ciclo normal medido
    // é de 4,1 dias, então 3 dias já é sinal vermelho.
    for (const s of incomingShipments) {
      const h = horas(s.sentAt || s.openedAt);
      tasks.push({
        key: `receber-${s.id}`,
        urgency: h >= 72 ? 'red' : 'yellow',
        icon: Inbox,
        title: `Receber remessa de ${s.fromStoreName || s.fromStoreCode}`,
        subtitle: `${s.totalQty || '?'} peça(s) · ${s.code} · em trânsito há ${idadeTxt(h)}${h >= 72 ? ' · a peça está fora do estoque até dar entrada' : ''}`,
        go: () => router.push('/minha-loja/recebimento'),
      });
    }
    if (pendingPieces.length > 0) {
      const oldest = Math.max(...pendingPieces.map((p: any) => horas(p.createdAt)));
      // AVISO DE ESQUECIMENTO (24/08): peça pedida e nunca enviada é cancelada
      // sozinha com 7 dias (cron da retaguarda) — enquanto ela existe, segura o
      // estoque e deixa a Grade por Loja negativa. Some sem avisar é pior do
      // que parada, então do 5º dia em diante a fila conta os dias que restam.
      const EXPIRA_DIAS = 7;
      const restam = EXPIRA_DIAS - Math.floor(oldest / 24);
      const quase = oldest >= 5 * 24;
      const prazo = restam <= 0 ? 'hoje' : `em ${restam} dia${restam > 1 ? 's' : ''}`;
      tasks.push({
        key: 'realinhamento-pendente',
        urgency: oldest >= 24 ? 'red' : 'yellow',
        icon: Shuffle,
        title: `Separar ${pendingPieces.length} peça(s) pra outras lojas`,
        subtitle:
          `realinhamento aguardando bipe${oldest >= 24 ? ` · parado há ${idadeTxt(oldest)}` : ''}` +
          `${quase ? ` · a mais antiga sai da fila ${prazo} se não for enviada` : ''}`,
        go: () => router.push('/minha-loja/realinhamento'),
      });
    }
    const scrollPedidos = () => {
      document.getElementById('fila-pedidos')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    for (const r of rows) {
      if (r.status !== 'new' && r.status !== 'separating') continue;
      const h = horas(r.createdAt);
      const n = r.order?.wcOrderNumber ?? r.order?.wcOrderId ?? r.id.slice(0, 6);
      tasks.push({
        key: `pedido-${r.id}`,
        urgency: h >= 3 ? 'red' : 'yellow',
        icon: ShoppingCart,
        title: `Separar pedido #${n}`,
        subtitle: `${r.order?.items?.length || '?'} peça(s) · chegou há ${idadeTxt(h)}${r.status === 'separating' ? ' · separação começada' : ''}`,
        go: scrollPedidos,
      });
    }
    for (const g of liveRows) {
      tasks.push({
        key: `live-${g.cartId}`,
        urgency: 'yellow',
        icon: Radio,
        title: `Separar LIVE de ${g.customerName}`,
        subtitle: `${g.items?.length || '?'} peça(s)${g.liveStoreName ? ` · live ${g.liveStoreName}` : ''}`,
        go: scrollPedidos,
      });
    }
    // Vermelhas primeiro; dentro da mesma cor mantém a ordem natural das fontes
    // (caixas → receber → separar → pedidos), que já é a ordem de prioridade.
    tasks.sort((a, b) => (a.urgency === b.urgency ? 0 : a.urgency === 'red' ? -1 : 1));
    return tasks;
  }, [openBoxes, incomingShipments, pendingPieces, rows, liveRows, router]);

  // Quantas estão PARADAS (vermelhas) — é o único detalhe que a barra fechada
  // precisa dizer além do total.
  const tasksParadas = useMemo(() => storeTasks.filter((t) => t.urgency === 'red').length, [storeTasks]);

  // ---------- Notificação + auto-maximize em 5min ----------
  const triggerNewOrderAlert = useCallback((pickOrder: any) => {
    const orderNumber = pickOrder?.order?.wcOrderNumber ?? pickOrder?.order?.wcOrderId ?? '—';
    pushToast(`Pedido novo #${orderNumber} chegou!`);

    // Title flash
    if (typeof document !== 'undefined') {
      let on = true;
      const original = originalTitleRef.current;
      const flashId = window.setInterval(() => {
        document.title = on ? `🔔 PEDIDO NOVO #${orderNumber}` : original;
        on = !on;
      }, 700);
      // Para o flash assim que o usuário interage (focus)
      const stop = () => {
        window.clearInterval(flashId);
        document.title = original;
        window.removeEventListener('focus', stop);
        window.removeEventListener('click', stop);
      };
      window.addEventListener('focus', stop);
      window.addEventListener('click', stop);
      window.setTimeout(stop, 60000);
    }

    // Notificação do SO
    if (typeof Notification !== 'undefined') {
      const show = () =>
        new Notification('LURDS ORDER ONE — Pedido Novo', {
          body: `Pedido #${orderNumber} chegou pra separar`,
          silent: true,
        });
      if (Notification.permission === 'granted') show();
      else if (Notification.permission !== 'denied') {
        Notification.requestPermission().then((p) => { if (p === 'granted') show(); });
      }
    }

    // Auto-maximize: se em 5min ninguém clicar, chama window.focus() +
    // (em Electron) IPC pra forçar restore + focus. Se não for Electron, o focus()
    // basta pra piscar o ícone na taskbar.
    const tid = window.setTimeout(() => {
      try {
        window.focus();
        // Electron expõe window.electronAPI?.focusWindow() (ver preload)
        (window as any).electronAPI?.focusWindow?.();
      } catch {}
    }, 5 * 60 * 1000);
    autoMaximizeTimers.current.set(pickOrder.id, tid);
  }, []);

  // Cancela auto-maximize quando o card é visto/atualizado
  const cancelAutoMaximize = useCallback((pickOrderId: string) => {
    const tid = autoMaximizeTimers.current.get(pickOrderId);
    if (tid) {
      clearTimeout(tid);
      autoMaximizeTimers.current.delete(pickOrderId);
    }
  }, []);

  // ---------- Toasts ----------
  const pushToast = useCallback((msg: string) => {
    const id = String(Date.now() + Math.random());
    setToasts((prev) => [...prev, { id, msg }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 6000);
  }, []);

  // ---------- Ações ----------
  async function transitionStatus(row: PickOrderRow, to: PickStatus) {
    cancelAutoMaximize(row.id);
    try {
      const updated = await api(`/pick-orders/${row.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: to }),
      });
      setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, ...updated } : r)));
      pushToast(`Pedido #${row.order.wcOrderNumber ?? '—'}${STATUS_LABEL[to].toLowerCase()}`);
      if (updated?.wcSyncApplied) {
        pushToast(`🌐 Site: ${updated.wcSyncApplied}`);
      }
      if (updated?.wcSyncWarning) {
        pushToast(`⚠️ ${updated.wcSyncWarning}`);
      }
    } catch (err: any) {
      pushToast(`Erro: ${err?.message ?? 'falha ao atualizar'}`);
    }
  }

  async function submitReportIssue(row: PickOrderRow, reason: string, note: string) {
    cancelAutoMaximize(row.id);
    try {
      const res = await api(`/pick-orders/${row.id}/report-issue`, {
        method: 'POST',
        body: JSON.stringify({ reason, note }),
      });
      // Remove o card da fila da loja imediatamente (backend vai confirmar via socket)
      setRows((prev) => prev.filter((r) => r.id !== row.id));
      setShowIssueModal(null);
      pushToast(
        `Problema reportado: ${res?.reasonLabel ?? reason}. A matriz foi avisada e vai reatribuir pra outra loja.`,
      );
    } catch (err: any) {
      pushToast(`Erro ao reportar: ${err?.message ?? 'falha'}`);
    }
  }

  async function submitShipped(row: PickOrderRow, trackingCode: string, carrier: string) {
    cancelAutoMaximize(row.id);
    try {
      const updated = await api(`/pick-orders/${row.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'shipped', trackingCode, carrier }),
      });
      setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, ...updated } : r)));
      setShowShippedModal(null);
      pushToast(`Pedido #${row.order.wcOrderNumber ?? '—'} enviado (${carrier})`);
      if (updated?.wcSyncApplied) {
        pushToast(`🌐 Site: ${updated.wcSyncApplied}`);
      }
      if (updated?.wcSyncWarning) {
        pushToast(`⚠️ ${updated.wcSyncWarning}`);
      }
      // Auto-baixa no ERP Gigasistemas (dispara no shipped quando ERP_WRITE_ENABLED=true).
      // Mostra só se houve ação real — sucesso, shadow ou falha.
      const ad = updated?.autoDebit;
      if (ad?.applied) {
        pushToast(`📦 Estoque baixado no ERP Gigasistemas`);
      } else if (ad?.shadow) {
        pushToast(`⏳ Baixa em shadow — matriz vai liberar`);
      } else if (ad?.attempted && ad?.reason) {
        pushToast(`⚠️ Baixa ERP falhou: ${ad.reason}. Matriz reabre em /baixas-log.`);
      }
    } catch (err: any) {
      pushToast(`Erro: ${err?.message ?? 'falha ao enviar'}`);
    }
  }

  function downloadPdf(b64: string, name: string) {
    const a = document.createElement('a');
    a.href = `data:application/pdf;base64,${b64}`;
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
  }
  // DOCUMENTOS DO ENVIO num PDF ÚNICO: etiqueta + DANFE (nessa ordem), pra
  // loja imprimir um arquivo só. Fallback: etiqueta separada se o merge falhar.
  async function baixarEtiquetaCorreios(idPre: string, rastreio: string, pickId?: string) {
    if (pickId) {
      try {
        const m = await api<any>(`/pick-orders/${pickId}/docs-envio`);
        if (m?.ok && m.pdfBase64) {
          downloadPdf(m.pdfBase64, `envio-${rastreio}.pdf`);
          if (m.temNota && m.temEtiqueta === false) pushToast(`🧾 NF-e baixada — etiqueta pendente: ${m.etiquetaErro ?? 'tente de novo em instantes'}`);
          else if (m.temNota) pushToast('📦 Etiqueta + NF-e num arquivo só');
          else pushToast('🏷️ Etiqueta baixada (envio sem NF-e autorizada)');
          return;
        }
      } catch { /* cai no fluxo da etiqueta separada */ }
    }
    try {
      const et = await api<any>('/correios/etiqueta', { method: 'POST', body: JSON.stringify({ idPrepostagem: idPre }) });
      if (et?.ok && et.pdfBase64) { downloadPdf(et.pdfBase64, `etiqueta-${rastreio}.pdf`); pushToast('🏷️ Etiqueta baixada'); }
      else pushToast(`Etiqueta não ficou pronta: ${et?.erro ?? 'tente reimprimir'}`);
    } catch { pushToast('Etiqueta falhou (tente reimprimir).'); }
  }

  // DOCUMENTOS DA CAIXA DA JUNTADA num PDF único: etiqueta pra loja âncora +
  // DANFE da transferência + romaneio carimbado "PEÇAS DO PEDIDO #X".
  // Transporte próprio (carro da rede) sai só o romaneio.
  async function docsCaixaJuntada(row: PickOrderRow) {
    cancelAutoMaximize(row.id);
    try {
      const m = await api<any>(`/pick-orders/${row.id}/juntada-docs`);
      if (m?.ok && m.pdfBase64) {
        downloadPdf(m.pdfBase64, `caixa-${m.shipmentCode ?? row.order.wcOrderNumber ?? 'juntada'}.pdf`);
        if (m.transporte === 'proprio') pushToast('🚚 Romaneio baixado — a caixa vai no carro da rede');
        else if (m.temEtiqueta && m.temNota) pushToast('📦 Etiqueta pra loja + NF + romaneio num arquivo só');
        else if (m.aviso) pushToast(`⚠️ ${m.aviso}`);
        else pushToast('📄 Documentos da caixa baixados');
        // Reflete a caixa no card na hora (o retorno é a fonte mais fresca)
        setRows((prev) => prev.map((r) => r.id === row.id
          ? {
              ...r,
              caixaJuntada: {
                code: m.shipmentCode ?? r.caixaJuntada?.code ?? '',
                status: r.caixaJuntada?.status ?? 'in_transit',
                trackingCode: m.trackingCode ?? r.caixaJuntada?.trackingCode ?? null,
                carrier: m.carrier ?? r.caixaJuntada?.carrier ?? null,
                transportMode: m.transporte ?? r.caixaJuntada?.transportMode ?? null,
              },
            }
          : r));
      } else {
        pushToast(m?.aviso ? `⚠️ ${m.aviso}` : 'Documentos ainda não disponíveis — tente de novo em instantes.');
      }
    } catch (err: any) {
      pushToast(`Erro nos documentos da caixa: ${err?.body?.message ?? err?.message ?? 'falha'}`);
    }
  }

  // MODEL B: gera a pré-postagem (modalidade correta), mostra o rastreio e baixa
  // etiqueta + declaração. NÃO marca enviado — o pedido FICA na lista
  // "aguardando postagem"; o cron marca enviado quando os Correios postarem.
  async function gerarEnvioCorreios(row: PickOrderRow) {
    cancelAutoMaximize(row.id);
    try {
      const r = await api<any>(`/pick-orders/${row.id}/correios-envio`, { method: 'POST', body: JSON.stringify({}) });
      if (!r?.codigoRastreio) { pushToast('Correios não devolveu rastreio.'); return; }
      setRows((prev) => prev.map((x) => (x.id === row.id
        ? { ...x, trackingCode: r.codigoRastreio, carrier: r.carrier || (r.servico ? `Correios ${r.servico}` : 'Correios'), correiosPrepostagemId: r.idPrepostagem ?? null }
        : x)));
      pushToast(`📮 Envio gerado (${r.servico ?? '—'}): ${r.codigoRastreio} — aguardando postagem`);
      // DC-e saiu do fluxo (dono 29/07): a NF-e do envio cumpre o papel.
      // NF-e do envio: falha vira aviso (a DANFE autorizada vem no PDF único)
      if (r.nfe?.status === 'error' || r.nfe?.status === 'rejected') {
        pushToast(`NF-e do envio falhou (${r.nfe?.cStat ?? ''}): ${r.nfe?.xMotivo ?? r.nfe?.erro ?? 'ver retaguarda'}`);
      }
      // Rotina do dono (28/07): Gerar SÓ gera — a impressão é o botão
      // "Etiqueta + NF" na sequência (nada de preview/download automático aqui).
    } catch (err: any) {
      pushToast(`Erro no envio Correios: ${err?.message ?? 'falha'}`);
    }
  }
  async function reabrirEnvio(row: PickOrderRow) {
    try {
      await api(`/pick-orders/${row.id}/correios-reabrir`, { method: 'POST', body: JSON.stringify({}) });
      setRows((prev) => prev.map((x) => (x.id === row.id ? { ...x, trackingCode: null, carrier: null, correiosPrepostagemId: null, correiosGeneratedAt: null } : x)));
      pushToast('Envio reaberto — gere de novo. (Cancele a pré-postagem antiga no portal dos Correios.)');
    } catch (err: any) { pushToast(`Erro ao reabrir: ${err?.message ?? 'falha'}`); }
  }
  // Override manual: força "enviado" agora com o rastreio já gerado (Giga +
  // WhatsApp) — pra quando o cron ainda não pegou a postagem ou está desligado.
  async function marcarEnviadoManual(row: PickOrderRow) {
    if (!row.trackingCode) { pushToast('Gere o envio primeiro.'); return; }
    await submitShipped(row, row.trackingCode, row.carrier || 'Correios');
  }

  function logout() {
    try { localStorage.removeItem('flowops_token'); } catch {}
    try { disconnectSocket(); } catch {}
    router.push('/login');
  }

  // ---------- Helpers UI ----------
  const activeRows = useMemo(
    () => rows.filter((r) => r.status !== 'shipped'),
    [rows],
  );
  const countByStatus = useMemo(() => {
    const c: Record<PickStatus, number> = { new: 0, separating: 0, separated: 0, ready: 0, shipped: 0 };
    for (const r of rows) c[r.status] = (c[r.status] ?? 0) + 1;
    return c;
  }, [rows]);

  // Em andamento = tudo que ainda pode dar errado (fora entregue/cancelado).
  const vendidosAndamento = useMemo(
    () => vendidos.filter((v) => v.emAndamento).length,
    [vendidos],
  );

  // Lista filtrada pela aba ativa (clique nos cards do topo).
  // null = mostra todos os ativos (default).
  const visibleRows = useMemo(() => {
    // "Vendi online" é outra lista (pedido, não pick-order) — renderiza à parte.
    if (filterTab === 'vendi') return [];
    if (!filterTab) return activeRows;
    if (filterTab === 'new') return activeRows.filter((r) => r.status === 'new');
    if (filterTab === 'separating') return activeRows.filter((r) => r.status === 'separating');
    if (filterTab === 'ready') return activeRows.filter((r) => r.status === 'separated' || r.status === 'ready');
    // ENVIADOS sai de `rows`, não de `activeRows` — `activeRows` existe
    // justamente pra ESCONDER os despachados do dia a dia.
    if (filterTab === 'shipped') return enviados;
    return activeRows;
  }, [activeRows, filterTab, enviados]);

  // Imprime todos os pedidos visíveis (batch). Abre UMA única janela com TODOS
  // os cupons concatenados — assim o popup blocker bloqueia 0 ou 1 (não N).
  // Resolve o bug "só imprime o primeiro" (Chrome bloqueia janelas em loop).
  const printAllVisible = async () => {
    const targets = visibleRows.filter((r) => r.status === 'new' || r.status === 'separating');
    if (targets.length === 0) return;
    if (targets.length > 1 && !confirm(`Imprimir ${targets.length} pedidos de uma vez?`)) return;
    const ids = targets.map((t) => t.id).join(',');
    const url = `/minha-loja/imprimir-todos?ids=${encodeURIComponent(ids)}`;
    const w = window.open(url, 'imprimir-todos', 'width=420,height=720,noopener=no');
    if (!w) {
      // Se popup bloqueado, abre na MESMA aba (compromisso: usuário volta com back)
      window.location.href = url;
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader />
      </div>
    );
  }
  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="bg-red-50 border border-red-300 rounded p-6 max-w-sm text-center">
          <AlertCircle className="w-10 h-10 text-red-600 mx-auto mb-2" />
          <p className="text-red-800 font-medium">{error}</p>
          <button onClick={() => location.reload()} className="mt-4 px-4 py-2 bg-red-600 text-white rounded">
            Recarregar
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#f4f1ec]">
      {/* Header unificado com a retaguarda — fundo branco, borda sutil */}
      <header className="sticky top-0 z-30 bg-white border-b border-slate-200 shadow-sm">
        <div className="px-4 py-3 flex items-center justify-between max-w-3xl mx-auto">
          <div className="flex items-center gap-3">
            <div
              className="circle-ring flex items-center justify-center w-11 h-11"
              style={{ border: '3px solid #c08081', background: '#f5e6e3' }}
            >
              <Logo height={22} />
            </div>
            <div>
              <div
                className="text-[10px] uppercase tracking-[0.2em] font-semibold leading-none"
                style={{ color: '#8b4f55' }}
              >
                Order One
              </div>
              <div
                className="font-display text-lg leading-tight"
                style={{ color: '#3a2a2c' }}
              >
                {me?.storeName ? me.storeName : 'Minha Loja'}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* Botão de Push: mostra status ('Notificações ativas' verde / 'Ativar
                notificações' violeta). Some quando browser não suporta. */}
            <PushActivateButton variant="sm" />
            <span
              className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-full font-medium"
              style={
                connected
                  ? { background: '#e3ebd9', color: '#475636' }
                  : { background: '#f5e6e3', color: '#8b4f55' }
              }
              title={connected ? 'Conectado em tempo real' : 'Desconectado — sem tempo real'}
            >
              {connected ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
              <span className="hidden sm:inline">{connected ? 'Online' : 'Offline'}</span>
            </span>
            <button
              onClick={loadRows}
              className="p-2 rounded-full transition"
              style={{ color: '#6e3a40' }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = '#f5e6e3';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
              }}
              title="Atualizar"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
            <button
              onClick={logout}
              className="p-2 rounded-full transition"
              style={{ color: '#6e3a40' }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = '#f5e6e3';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
              }}
              title="Sair"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
        {/* Contadores pastel — mini-pílulas clicáveis que filtram a lista.
            ENVIADOS entrou como 4ª (dono, 04/08): o pedido despachado sumia da
            tela, e é justamente nele que aparece o erro de endereço na hora de
            postar. Sem essa aba, corrigir um complemento exigia a matriz. */}
        <div className="px-4 pb-3 max-w-3xl mx-auto grid grid-cols-4 gap-2">
          <Counter label="Novos"            count={countByStatus.new}                              tone="rose"
            active={filterTab === 'new'}
            onClick={() => setFilterTab(filterTab === 'new' ? null : 'new')} />
          <Counter label="Separando"        count={countByStatus.separating}                       tone="sky"
            active={filterTab === 'separating'}
            onClick={() => setFilterTab(filterTab === 'separating' ? null : 'separating')} />
          <Counter label="Pronto p/ postar" count={countByStatus.separated + countByStatus.ready}  tone="mint"
            active={filterTab === 'ready'}
            onClick={() => setFilterTab(filterTab === 'ready' ? null : 'ready')} />
          {/* Conta o que a CONSULTA do período trouxe. `countByStatus` sai de
              `rows`, que é a fila ativa e nunca tem despachado — ficaria zero
              pra sempre. */}
          <Counter label="Enviados"         count={enviados.length}                                tone="slate"
            active={filterTab === 'shipped'}
            onClick={() => setFilterTab(filterTab === 'shipped' ? null : 'shipped')} />
        </div>
        {/* VENDI ONLINE (18/08) — linha PRÓPRIA, fora das 4 abas de trabalho.
            As de cima são o que ESTA loja tem pra fazer; esta é o que ela
            VENDEU e outra loja está atendendo: acompanhamento, não tarefa (por
            isso também não entra na fila "O que fazer agora" — alarme falso
            sobre pedido que não é dela mataria a confiança na fila). */}
        {(vendidos.length > 0 || filterTab === 'vendi') && (
          <div className="px-4 pb-3 max-w-3xl mx-auto">
            <button
              type="button"
              onClick={() => setFilterTab(filterTab === 'vendi' ? null : 'vendi')}
              className={`w-full rounded-2xl border-2 px-4 py-2.5 flex items-center justify-between gap-2 transition ${
                filterTab === 'vendi'
                  ? 'border-green-600 bg-green-100 text-green-900'
                  : 'border-green-300 bg-green-50 text-green-800 hover:border-green-400'
              }`}
            >
              <span className="font-bold text-sm flex items-center gap-2">
                <Globe className="w-4 h-4" /> Vendi online
              </span>
              <span className="text-xs font-semibold">
                {vendidosAndamento > 0
                  ? `${vendidosAndamento} em andamento`
                  : 'nada em andamento — ver histórico'}
              </span>
            </button>
          </div>
        )}
        {filterTab && (
          <div className="px-4 pb-2 max-w-3xl mx-auto flex items-center justify-between gap-2">
            <span className="text-[11px] text-slate-500">
              Filtrando: <strong>{
                filterTab === 'new' ? 'Novos'
                  : filterTab === 'separating' ? 'Separando'
                  : filterTab === 'ready' ? 'Pronto p/ postar'
                  : filterTab === 'shipped' ? 'Enviados'
                  : 'Vendi online'
              }</strong>
              {' · '}{(filterTab === 'vendi' ? vendidos.length : visibleRows.length)}{' '}
              {(filterTab === 'vendi' ? vendidos.length : visibleRows.length) === 1 ? 'pedido' : 'pedidos'}
            </span>
            <button
              type="button"
              onClick={() => setFilterTab(null)}
              className="text-[11px] text-slate-600 underline hover:text-slate-900"
            >
              ver todos
            </button>
          </div>
        )}
      </header>

      {/* ══ O QUE FAZER AGORA — fila de tarefas (piloto 11/08) ══
          A operadora não precisa saber QUAL tela abrir: tudo que está pendente
          na loja vira uma linha aqui, com idade e cor de urgência. Vermelho =
          parado (caixa aberta 4h+, pedido 3h+, remessa em trânsito 3 dias+).

          25/08 (ordem do dono): a fila vive FECHADA numa única barra vermelha
          baixa, logo acima do painel de botões. A barra continua dizendo QUANTAS
          tarefas existem e quantas estão paradas — o que sai da tela é a parede
          de linhas, não o alarme. Um clique abre a lista inteira ali mesmo. */}
      <div className="max-w-3xl mx-auto px-3 pt-3">
        {storeTasks.length === 0 ? (
          <div className="rounded-2xl border-2 border-emerald-200 bg-emerald-50 px-4 py-3 flex items-center gap-2.5">
            <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
            <div className="text-sm font-bold text-emerald-800">
              Tudo em dia — nenhum pedido, caixa ou remessa esperando você.
            </div>
          </div>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setTasksOpen((v) => !v)}
              aria-expanded={tasksOpen}
              aria-controls="fila-tarefas"
              className="w-full rounded-xl bg-rose-600 hover:bg-rose-700 text-white px-4 py-2.5 shadow-md flex items-center gap-3 transition active:scale-[0.99]"
            >
              <span className="shrink-0 w-2.5 h-2.5 rounded-full bg-white animate-pulse" />
              <span className="text-sm font-black uppercase tracking-wide">
                {storeTasks.length} tarefa{storeTasks.length === 1 ? '' : 's'} esperando você
              </span>
              <span className="hidden sm:inline text-[11px] font-bold text-white/85 truncate">
                {tasksParadas > 0 ? `${tasksParadas} parada${tasksParadas === 1 ? '' : 's'} · ` : ''}
                {tasksOpen ? 'toque pra fechar' : 'toque pra ver a lista'}
              </span>
              <ChevronDown className={`ml-auto shrink-0 w-5 h-5 transition-transform ${tasksOpen ? 'rotate-180' : ''}`} />
            </button>
            {tasksOpen && (
              <div id="fila-tarefas" className="mt-2 rounded-2xl border-2 border-slate-200 bg-white shadow-sm overflow-hidden divide-y divide-slate-100">
                {(showAllTasks ? storeTasks : storeTasks.slice(0, 10)).map((t) => {
                  const Icon = t.icon;
                  const red = t.urgency === 'red';
                  return (
                    <button
                      key={t.key}
                      type="button"
                      onClick={t.go}
                      className={`w-full text-left px-4 py-3 flex items-center gap-3 transition ${
                        red ? 'bg-rose-50 hover:bg-rose-100' : 'hover:bg-amber-50'
                      }`}
                    >
                      <span className={`shrink-0 w-2.5 h-2.5 rounded-full ${red ? 'bg-rose-500 animate-pulse' : 'bg-amber-400'}`} />
                      <Icon className={`w-5 h-5 shrink-0 ${red ? 'text-rose-600' : 'text-amber-600'}`} />
                      <span className="min-w-0 flex-1">
                        <span className={`block text-sm font-bold truncate ${red ? 'text-rose-900' : 'text-slate-800'}`}>{t.title}</span>
                        <span className={`block text-[11px] truncate ${red ? 'text-rose-700' : 'text-slate-500'}`}>{t.subtitle}</span>
                      </span>
                      <span className={`shrink-0 text-[11px] font-black uppercase ${red ? 'text-rose-600' : 'text-amber-600'}`}>
                        {red ? 'parado' : 'fazer'} →
                      </span>
                    </button>
                  );
                })}
                {storeTasks.length > 10 && (
                  <button
                    type="button"
                    onClick={() => setShowAllTasks((v) => !v)}
                    className="w-full px-4 py-2.5 text-xs font-bold text-slate-600 hover:bg-slate-50"
                  >
                    {showAllTasks
                      ? '↑ mostrar só as 10 mais urgentes'
                      : `↓ ver as outras ${storeTasks.length - 10} tarefas`}
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Quick-action grid — acesso rápido às funções da filial */}
      <div className="max-w-3xl mx-auto px-3 pt-3">
        <QuickActionGrid realignmentPending={realignmentPending} shipmentsIncoming={shipmentsIncoming} />
      </div>

      {/* Lista */}
      <main id="fila-pedidos" className="max-w-3xl mx-auto p-3 space-y-3 pb-10">
        {/* Botões "Imprimir TODOS" + "RESUMO ESTOQUE" — quando filtra Novos/Separando */}
        {(filterTab === 'new' || filterTab === 'separating') && visibleRows.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <button
              type="button"
              onClick={printAllVisible}
              className="w-full px-4 py-3 bg-violet-600 hover:bg-violet-700 text-white font-bold rounded-xl shadow-md flex items-center justify-center gap-2 transition active:scale-95"
            >
              <Printer className="w-5 h-5" />
              Imprimir TODOS ({visibleRows.length})
            </button>
            <button
              type="button"
              onClick={() => {
                // Resumo é A4 (laser) — abre em nova ABA larga, não popup pequeno
                const url = '/minha-loja/imprimir-resumo';
                const w = window.open(url, '_blank');
                if (!w) window.location.href = url;
              }}
              className="w-full px-4 py-3 bg-amber-500 hover:bg-amber-600 text-white font-bold rounded-xl shadow-md flex items-center justify-center gap-2 transition active:scale-95"
              title="Resumo A4 consolidado pra picking no estoque"
            >
              📋
              RESUMO ESTOQUE ({visibleRows.length})
            </button>
          </div>
        )}
        {/* Pedidos da LIVE — mesma lista, mesmo formato, com a tag vermelha.
            Fora da aba "Vendi online", que é acompanhamento e não fila. */}
        {filterTab !== 'vendi' && liveRows.map((g) => (
          <LiveOrderCard
            key={g.cartId}
            group={g}
            busy={liveBusy}
            onBip={() => setLiveBipCart(g)}
            onSeparated={liveMarkSeparated}
            onShipped={liveMarkShipped}
            onSwapItem={(it) =>
              setSwapCtx({
                kind: 'live',
                itemId: it.id,
                label: `${it.refCode}${it.cor ? ` · ${it.cor}` : ''}${it.tamanho ? ` ${it.tamanho}` : ''}`,
              })
            }
          />
        ))}
        {liveBipCart && (
          <LiveBipModal
            group={liveBipCart}
            onClose={() => { setLiveBipCart(null); loadLiveRows(); }}
          />
        )}
        {swapCtx && (
          <SwapModal
            currentLabel={swapCtx.label}
            onClose={() => setSwapCtx(null)}
            onDone={() => { loadRows(); loadLiveRows(); }}
            onSwap={(p: SwapPayload): Promise<SwapResponse> =>
              swapCtx.kind === 'pick'
                ? api<SwapResponse>(`/pick-orders/${swapCtx.pickOrderId}/swap-item`, {
                    method: 'POST',
                    body: JSON.stringify({ orderItemId: swapCtx.itemId, ...p }),
                  })
                : api<SwapResponse>(`/live-pdv/items/${swapCtx.itemId}/swap`, {
                    method: 'POST',
                    body: JSON.stringify(p),
                  })
            }
          />
        )}
        {editandoEndereco?.order?.wcOrderId && (
          <EnderecoEntregaModal
            wcOrderId={Number(editandoEndereco.order.wcOrderId)}
            inicial={enderecoDoPedido(editandoEndereco.order.shippingAddress)}
            onFechar={() => setEditandoEndereco(null)}
            onSalvo={() => { pushToast("Endereço corrigido ✓"); void loadRows(); }}
          />
        )}
        {/* RECORTE DA ABA ENVIADOS — De/Até + atalhos, a convenção da casa pra
            tela com recorte de tempo (nunca dropdown de período fixo). Só
            aparece na aba: nas outras não há o que recortar, é tudo do agora. */}
        {filterTab === 'shipped' && (
          <div className="no-print mb-3 rounded-2xl border border-slate-200 bg-white p-3 space-y-2">
            <div className="flex flex-wrap items-end gap-2">
              <label className="text-xs font-bold text-slate-500">
                De
                <input type="date" value={envDe} onChange={(e) => setEnvDe(e.target.value)}
                  className="ml-1 rounded-lg border border-slate-300 px-2 py-1.5 text-sm font-normal" />
              </label>
              <label className="text-xs font-bold text-slate-500">
                Até
                <input type="date" value={envAte} onChange={(e) => setEnvAte(e.target.value)}
                  className="ml-1 rounded-lg border border-slate-300 px-2 py-1.5 text-sm font-normal" />
              </label>
              <button type="button" onClick={() => void loadEnviados()}
                className="rounded-lg bg-slate-800 px-3 py-2 text-xs font-bold text-white hover:bg-slate-900">
                Buscar
              </button>
              <span className="ml-auto text-xs text-slate-500">{enviados.length} pedido(s)</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {([['Hoje', 0, 0], ['Ontem', 1, 1], ['7 dias', 6, 0], ['30 dias', 29, 0]] as Array<[string, number, number]>)
                .map(([rotulo, deDias, ateDias]) => (
                  <button
                    key={rotulo}
                    type="button"
                    onClick={() => {
                      const d = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
                      setEnvDe(d(deDias));
                      setEnvAte(d(ateDias));
                    }}
                    className="rounded-full border border-slate-300 px-3 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-100"
                  >
                    {rotulo}
                  </button>
                ))}
            </div>
          </div>
        )}

        {/* ══ VENDI ONLINE — o que ESTA loja vendeu e outra está atendendo ══ */}
        {filterTab === 'vendi' && (
          <>
            <div className="no-print mb-3 rounded-2xl border border-green-200 bg-white p-3 space-y-2">
              <p className="text-[11px] text-slate-500 leading-snug">
                Pedidos que <b>esta loja vendeu online</b>. Quem separa e posta é a loja do card —
                aqui é só pra você saber em que pé está e responder a cliente.
              </p>
              <div className="flex flex-wrap items-end gap-2">
                <label className="text-xs font-bold text-slate-500">
                  De
                  <input type="date" value={vendDe} onChange={(e) => setVendDe(e.target.value)}
                    className="ml-1 rounded-lg border border-slate-300 px-2 py-1.5 text-sm font-normal" />
                </label>
                <label className="text-xs font-bold text-slate-500">
                  Até
                  <input type="date" value={vendAte} onChange={(e) => setVendAte(e.target.value)}
                    className="ml-1 rounded-lg border border-slate-300 px-2 py-1.5 text-sm font-normal" />
                </label>
                <button type="button" onClick={() => void loadVendidos()}
                  className="rounded-lg bg-slate-800 px-3 py-2 text-xs font-bold text-white hover:bg-slate-900">
                  Buscar
                </button>
                <span className="ml-auto text-xs text-slate-500">{vendidos.length} pedido(s)</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {([['Hoje', 0, 0], ['Ontem', 1, 1], ['7 dias', 6, 0], ['30 dias', 29, 0]] as Array<[string, number, number]>)
                  .map(([rotulo, deDias, ateDias]) => (
                    <button
                      key={rotulo}
                      type="button"
                      onClick={() => {
                        const d = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
                        setVendDe(d(deDias));
                        setVendAte(d(ateDias));
                      }}
                      className="rounded-full border border-slate-300 px-3 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-100"
                    >
                      {rotulo}
                    </button>
                  ))}
                {/* Sem período = 30 dias + TUDO que ainda está em aberto (pedido
                    travado há 45 dias é o que ela mais precisa ver). */}
                <button
                  type="button"
                  onClick={() => { setVendDe(''); setVendAte(''); }}
                  className="rounded-full border border-green-300 bg-green-50 px-3 py-1 text-xs font-bold text-green-800 hover:bg-green-100"
                >
                  Em aberto + 30 dias
                </button>
              </div>
            </div>
            {vendidos.length === 0 ? (
              <div className="rounded-2xl border-2 border-dashed border-slate-200 bg-white px-4 py-8 text-center text-sm text-slate-500">
                Nenhuma venda online desta loja no período.
              </div>
            ) : (
              vendidos.map((v) => <VendidoOnlineCard key={v.id} v={v} />)
            )}
          </>
        )}

        {filterTab === 'vendi' ? null : visibleRows.length === 0 && liveRows.length === 0 ? (
          <EmptyState />
        ) : (
          visibleRows.map((row) => (
            <PickOrderCard
              key={row.id}
              row={row}
              onStart={() => transitionStatus(row, 'separating')}
              onBip={() => setShowBipModal(row)}
              onShip={() => setShowShippedModal(row)}
              onEntregaSemRastreio={(modo) => {
                const q = modo === 'Motoboy' ? 'Confirmar: a peça SAIU com o motoboy?' : 'Confirmar: a cliente RETIROU a peça na loja?';
                if (confirm(q)) void submitShipped(row, '', modo);
              }}
              onCorreios={() => gerarEnvioCorreios(row)}
              onReabrir={() => reabrirEnvio(row)}
              onEditarEndereco={() => setEditandoEndereco(row)}
              onReimprimir={() => row.correiosPrepostagemId ? baixarEtiquetaCorreios(String(row.correiosPrepostagemId), row.trackingCode || 'etiqueta', row.id) : pushToast('Sem pré-postagem pra reimprimir.')}
              onMarcarEnviado={() => marcarEnviadoManual(row)}
              onDocsJuntada={() => docsCaixaJuntada(row)}
              onPrint={() => openPrintWindow(row.id)}
              onReportIssue={() => setShowIssueModal(row)}
              onSeen={() => cancelAutoMaximize(row.id)}
              onSwapItem={(it) =>
                setSwapCtx({
                  kind: 'pick',
                  pickOrderId: row.id,
                  itemId: it.id ?? '',
                  label: it.productName ?? it.sku,
                })
              }
            />
          ))
        )}
      </main>

      {/* Modal enviar */}
      {showShippedModal && (
        <ShippedModal
          row={showShippedModal}
          onClose={() => setShowShippedModal(null)}
          onSubmit={submitShipped}
        />
      )}

      {/* Modal enviar item da LIVE (rastreio opcional) */}
      {liveShipItemId && (
        <LiveShipModal
          busy={liveBusy === liveShipItemId}
          onClose={() => setLiveShipItemId(null)}
          onSubmit={(tracking) => liveSubmitShipped(liveShipItemId, tracking)}
        />
      )}

      {/* Modal reportar problema */}
      {showIssueModal && (
        <ReportIssueModal
          row={showIssueModal}
          onClose={() => setShowIssueModal(null)}
          onSubmit={submitReportIssue}
        />
      )}

      {/* Modal bipagem (EAN13) */}
      {showBipModal && (
        <BipModal
          pickOrderId={showBipModal.id}
          wcOrderNumber={showBipModal.order.wcOrderNumber ?? String(showBipModal.order.wcOrderId ?? '')}
          customerName={showBipModal.order.customerName}
          onClose={() => setShowBipModal(null)}
          onFinished={() => {
            // Atualiza status local pra 'separated' imediatamente (UX ágil)
            setRows((prev) =>
              prev.map((r) =>
                r.id === showBipModal.id ? { ...r, status: 'separated' as PickStatus } : r,
              ),
            );
            setShowBipModal(null);
            pushToast(`Pedido enviado pra matriz pra aprovação da baixa`);
          }}
        />
      )}

      {/* Toasts */}
      <div className="fixed bottom-4 left-1/2 -translate-x-1/2 space-y-2 z-50">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="bg-slate-900 text-white px-4 py-2 rounded shadow-lg text-sm"
          >
            {t.msg}
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================
// Componentes internos
// ============================================================

function Loader() {
  return (
    <div className="flex items-center gap-2 text-slate-600">
      <RefreshCw className="w-5 h-5 animate-spin" />
      <span>Carregando...</span>
    </div>
  );
}

/**
 * Abre /minha-loja/imprimir/{id} em popup estreito.
 * A página destino dispara window.print() automático e fecha sozinha.
 * Compatível com impressora térmica 80mm (papel de cupom).
 */
function openPrintWindow(pickOrderId: string) {
  const url = `/minha-loja/imprimir/${pickOrderId}`;
  const w = window.open(url, `print-${pickOrderId}`, 'width=400,height=700,noopener=no');
  if (!w) {
    // Popup bloqueado — abre na mesma aba como fallback
    window.location.href = url;
  }
}

// ──────────────────────────────────────────────────────────────
// QuickActionGrid — grid de botões grandes pra ações rápidas
// ──────────────────────────────────────────────────────────────
// Cada botão é um gradiente colorido com ícone e label. Pensado pra click
// rápido no mobile (alvo grande) e pra destacar visualmente as funções
// importantes da filial. Quando há realinhamento pendente, destaca um
// card cheia-largura com badge pra ficar impossível de ignorar.
function QuickActionGrid({ realignmentPending = 0, shipmentsIncoming = 0 }: { realignmentPending?: number; shipmentsIncoming?: number }) {
  // 7 cards grandes coloridos — mesmo estilo da retaguarda (/site, /loja, etc.)
  type Tone = 'teal' | 'rose' | 'orange' | 'purple' | 'amber' | 'sky' | 'green' | 'indigo' | 'fuchsia';
  const items: Array<{
    href: string;
    icon: any;
    label: string;
    subtitle: string;
    description: string;
    tone: Tone;
    badge?: number;
  }> = [
    { href: '/minha-loja/pdv',           icon: ShoppingCart, label: 'PDV',            subtitle: 'Venda',       description: 'Frente de caixa',          tone: 'teal'   },
    { href: '/minha-loja/live-pdv',      icon: Radio,        label: 'Live',           subtitle: 'Ao vivo',     description: 'Vender na live',           tone: 'fuchsia' },
    { href: '/minha-loja/live-expedicao',icon: Zap,          label: 'Expedir Live',   subtitle: 'Live',        description: 'Separar e despachar',      tone: 'purple' },
    { href: '/minha-loja/consultar',     icon: Search,       label: 'Consultar',      subtitle: 'Estoque',     description: 'Buscar na rede',           tone: 'rose'   },
    { href: '/minha-loja/historico',     icon: History,      label: 'Transferências', subtitle: 'Histórico',   description: 'Eu pedi · me pediram',     tone: 'orange' },
    { href: '/minha-loja/triagem',       icon: Package,      label: 'Triagem',        subtitle: 'Bipar',       description: 'Distribuir mercadoria',    tone: 'purple' },
    { href: '/minha-loja/materiais',     icon: Package2,     label: 'Materiais',      subtitle: 'Suprimentos', description: 'Sacolas, etiquetas…',      tone: 'amber'  },
    { href: '/minha-loja/realinhamento', icon: Shuffle,      label: 'Realinhar',      subtitle: 'Inter-lojas', description: 'Separar pra outras lojas', tone: 'sky',     badge: realignmentPending },
    { href: '/minha-loja/transferencia', icon: ArrowLeftRight, label: 'Transferir',    subtitle: 'Ponto a ponto', description: 'Mandar pra outra loja',    tone: 'sky'    },
    { href: '/minha-loja/recebimento',   icon: Inbox,        label: 'Receber',        subtitle: 'Mercadoria',  description: 'Dar entrada de remessa',   tone: 'green',   badge: shipmentsIncoming },
    { href: '/minha-loja/defeitos',      icon: AlertTriangle, label: 'Defeitos',      subtitle: 'Avaria',      description: 'Tirar do estoque e mandar pra matriz', tone: 'amber' },
    { href: '/minha-loja/ponto',         icon: Fingerprint,  label: 'Ponto',          subtitle: 'Bater',       description: 'Entrada · almoço · saída', tone: 'indigo' },
    { href: '/minha-loja/ponto-celular', icon: Smartphone,   label: 'Ponto Celular',  subtitle: 'Totem',       description: 'Bater no celular da loja', tone: 'indigo' },
    { href: '/minha-loja/funcionarias',  icon: KeyRound,     label: 'Funcionárias',   subtitle: 'Função & PIN', description: 'Liberar desconto no PDV',   tone: 'amber'  },
    { href: '/minha-loja/rosto',         icon: ScanFace,     label: 'Rosto',          subtitle: 'Ponto facial', description: 'Cadastrar rosto pro ponto', tone: 'indigo' },
  ];

  const TONES: Record<Tone, { from: string; to: string }> = {
    teal:   { from: '#0e7e87', to: '#0a5a62' },
    rose:   { from: '#c95a78', to: '#9a3f59' },
    orange: { from: '#d68a3c', to: '#b66a1f' },
    purple: { from: '#8a5cb6', to: '#5f3e8a' },
    amber:  { from: '#c9a96e', to: '#8a7340' },
    sky:    { from: '#3b82a8', to: '#1f5f80' },
    green:  { from: '#5b9b3e', to: '#3f7029' },
    indigo: { from: '#4f46e5', to: '#312e81' },
    fuchsia:{ from: '#c026d3', to: '#86198f' },
  };

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 fade-up">
      {items.map((a) => {
        const t = TONES[a.tone];
        const Icon = a.icon;
        const hasBadge = a.badge != null && a.badge > 0;
        return (
          <Link
            key={a.href}
            href={a.href}
            className={`relative overflow-hidden rounded-2xl px-4 py-4 text-white shadow-sm hover:shadow-md hover:-translate-y-0.5 active:translate-y-0 transition flex flex-col gap-1.5 ${
              hasBadge ? 'ring-2 ring-rose-300 ring-offset-2 ring-offset-[#f4f1ec]' : ''
            }`}
            style={{ background: `linear-gradient(135deg, ${t.from} 0%, ${t.to} 100%)` }}
          >
            {/* Glow decorativo */}
            <div
              className="absolute -top-8 -right-8 w-32 h-32 rounded-full opacity-15"
              style={{ background: 'radial-gradient(circle, white 0%, transparent 70%)' }}
            />
            <div className="relative flex items-center justify-between">
              <Icon className="w-6 h-6 opacity-90" strokeWidth={1.7} />
              {hasBadge && (
                <span className="text-[11px] font-black px-2 py-0.5 rounded-full bg-white text-rose-700 shadow animate-pulse">
                  {a.badge}
                </span>
              )}
            </div>
            <div className="relative">
              <div className="text-[10px] font-bold tracking-wider uppercase opacity-90">{a.subtitle}</div>
              <div className="text-xl font-bold leading-tight mt-0.5">{a.label}</div>
              <div className="text-[11px] opacity-80 mt-1 leading-snug">{a.description}</div>
            </div>
          </Link>
        );
      })}
    </div>
  );
}

/**
 * "há 2 h", "ontem", "há 5 d" — quando o evento aconteceu, sem obrigar ninguém
 * a comparar datas. Tempo relativo também é imune a fuso, que é o que mais
 * erra nesta casa.
 */
function quandoFoi(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const min = Math.round((Date.now() - t) / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `há ${h} h`;
  const d = Math.round(h / 24);
  if (d === 1) return 'ontem';
  if (d < 30) return `há ${d} dias`;
  return new Date(iso).toLocaleDateString('pt-BR');
}

/**
 * ONDE A PEÇA ESTÁ — a linha que faltava no card (18/08).
 *
 * A loja via "Enviado + código" e não sabia dizer nada além disso; pra
 * responder "chegou?" tinha que abrir o site dos Correios. Aqui vem o último
 * movimento, a cidade e há quanto tempo — o que a vendedora repassa pra
 * cliente sem sair da tela.
 */
function LinhaRastreio({ r }: { r: VendidoOnlineRow['rastreio'] }) {
  if (!r) return null;
  if (!r.status) {
    return (
      <div className="text-[11px] text-slate-400">
        Etiqueta emitida — a transportadora ainda não registrou movimento.
      </div>
    );
  }
  const entregue = !!r.entregue;
  const quando = quandoFoi(r.entregueEm ?? r.eventoEm);
  return (
    <div
      className={`flex items-start gap-1.5 rounded-lg px-2 py-1 text-[11px] leading-snug ${
        entregue ? 'bg-emerald-50 text-emerald-900' : 'bg-slate-50 text-slate-700'
      }`}
    >
      <span aria-hidden>{entregue ? '✅' : '🚚'}</span>
      <span className="min-w-0 flex-1">
        <span className="font-semibold">{r.status}</span>
        {r.local ? <span className="text-slate-500"> · {r.local}</span> : null}
        {quando ? <span className="text-slate-400"> · {quando}</span> : null}
        {/* Previsão só enquanto está em trânsito: depois de entregue vira ruído. */}
        {!entregue && r.previsaoEm ? (
          <span className="text-slate-500">
            {' '}· previsão {new Date(r.previsaoEm).toLocaleDateString('pt-BR')}
          </span>
        ) : null}
      </span>
    </div>
  );
}

/**
 * CARD DO PEDIDO QUE ESTA LOJA VENDEU (18/08).
 *
 * Read-only de propósito: a ação (separar, postar) é da loja que atende. O que
 * a vendedora precisa daqui é responder a cliente — situação em uma frase,
 * onde o objeto está, quem está com o pedido, o rastreio pra copiar e o
 * WhatsApp dela.
 */
function VendidoOnlineCard({ v }: { v: VendidoOnlineRow }) {
  const [copiado, setCopiado] = useState(false);
  const TOM: Record<string, string> = {
    rose:  'bg-rose-100 text-rose-900 border-rose-300',
    amber: 'bg-amber-100 text-amber-900 border-amber-300',
    sky:   'bg-blue-100 text-blue-900 border-blue-300',
    mint:  'bg-emerald-100 text-emerald-900 border-emerald-300',
    slate: 'bg-slate-200 text-slate-700 border-slate-300',
  };
  const zap = String(v.customerPhone || '').replace(/\D/g, '');
  return (
    <article className="bg-white rounded-xl border-2 border-green-200 shadow-sm p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-lg font-black text-slate-900">
              #{v.wcOrderNumber ?? v.wcOrderId ?? '—'}
            </span>
            <span className={`text-[11px] font-bold uppercase tracking-wide px-2 py-0.5 rounded border ${TOM[v.situacao.tom] ?? TOM.slate}`}>
              {v.situacao.rotulo}
            </span>
          </div>
          <div className="text-sm font-medium text-slate-700 truncate">{v.customerName ?? '—'}</div>
        </div>
        <div className="text-right shrink-0">
          {v.totalAmount != null && (
            <div className="text-base font-bold text-slate-900">R$ {Number(v.totalAmount).toFixed(2)}</div>
          )}
          <div className="text-[11px] text-slate-500">{v.pecas} peça(s)</div>
        </div>
      </div>

      <p className="text-xs text-slate-600 leading-snug">{v.situacao.detalhe}</p>

      {v.trackingCode && <LinhaRastreio r={v.rastreio} />}

      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        {v.entrega.label && (
          <span className="rounded-full bg-slate-100 px-2 py-0.5 font-semibold text-slate-600">
            {v.entrega.label}
          </span>
        )}
        {v.atendendo.map((a, i) => (
          <span key={`${a.storeCode ?? i}-${i}`} className="rounded-full border border-green-200 bg-green-50 px-2 py-0.5 font-semibold text-green-800">
            {a.storeName ?? a.storeCode ?? 'loja'} · {STATUS_LABEL[(a.status ?? '') as PickStatus] ?? a.status ?? '—'}
          </span>
        ))}
        {v.criadoEm && (
          <span className="text-slate-400">
            {new Date(v.criadoEm).toLocaleDateString('pt-BR')}
          </span>
        )}
      </div>

      {(v.trackingCode || zap) && (
        <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-slate-100">
          {v.trackingCode && (
            <button
              type="button"
              onClick={() => {
                navigator.clipboard?.writeText(v.trackingCode || '');
                setCopiado(true);
                window.setTimeout(() => setCopiado(false), 2000);
              }}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2 py-1 text-[11px] font-mono font-bold text-slate-700 hover:bg-slate-50"
              title="Copiar rastreio pra mandar pra cliente"
            >
              <Copy className="w-3 h-3" />
              {copiado ? 'copiado!' : v.trackingCode}
            </button>
          )}
          {zap && (
            <a
              href={`https://wa.me/55${zap}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1 text-[11px] font-bold text-white hover:bg-emerald-700"
            >
              Falar com a cliente
            </a>
          )}
        </div>
      )}
    </article>
  );
}

function Counter({
  label,
  count,
  tone,
  active,
  onClick,
}: {
  label: string;
  count: number;
  tone: 'rose' | 'sky' | 'mint' | 'peach' | 'slate';
  active?: boolean;
  onClick?: () => void;
}) {
  // Boutique sofisticado — alinhado com TONE_MAP do PastelShell
  const TONES: Record<string, { ring: string; bg: string; text: string; bgActive: string }> = {
    rose:  { ring: '#c08081', bg: '#f5e6e3', text: '#6e3a40', bgActive: '#e8c5c0' },
    sky:   { ring: '#6b8a92', bg: '#dde7ea', text: '#2e4750', bgActive: '#b8ccd2' },
    mint:  { ring: '#9caf88', bg: '#e3ebd9', text: '#475636', bgActive: '#c4d4a8' },
    peach: { ring: '#c87f5e', bg: '#f3e2d6', text: '#6f3b25', bgActive: '#e3c0a3' },
    // ENVIADOS: cinza de proposito — e arquivo do dia, nao trabalho a fazer.
    slate: { ring: '#8a8f98', bg: '#e6e8ea', text: '#3b4148', bgActive: '#c9ced4' },
  };
  const t = TONES[tone];
  const hasCount = count > 0;
  const clickable = !!onClick;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!clickable}
      className={`flex-1 rounded-2xl px-3 py-2 transition-all text-left ${hasCount ? '' : 'opacity-60'} ${clickable ? 'cursor-pointer hover:shadow-md active:scale-95' : 'cursor-default'} ${active ? 'ring-2 ring-offset-1 shadow-md' : ''}`}
      style={{
        background: active ? t.bgActive : t.bg,
        border: `${active ? '2.5' : '1.5'}px solid ${t.ring}`,
        outlineColor: t.ring,
      }}
    >
      <div className="font-display text-2xl tabular-nums leading-none" style={{ color: t.text }}>
        {count}
      </div>
      <div className="text-[10px] uppercase tracking-wider mt-1 font-semibold" style={{ color: t.text }}>
        {label}
      </div>
    </button>
  );
}

function EmptyState() {
  return (
    <div className="bg-white rounded-xl border-2 border-dashed border-slate-300 p-10 text-center">
      <div className="w-20 h-20 mx-auto rounded-full bg-emerald-50 flex items-center justify-center mb-3">
        <CheckCircle2 className="w-10 h-10 text-emerald-500" />
      </div>
      <p className="font-bold text-lg text-slate-800">Tudo em dia por aqui!</p>
      <p className="text-sm mt-1 text-slate-500">
        Assim que um novo pedido chegar da matriz, ele aparece automaticamente.
      </p>
    </div>
  );
}

/** Barrinha lateral colorida do card conforme status — tipo "semáforo". */
function statusAccent(s: PickStatus): string {
  switch (s) {
    case 'new': return 'bg-amber-500';
    case 'separating': return 'bg-blue-500';
    case 'separated':
    case 'ready': return 'bg-emerald-500';
    case 'shipped': return 'bg-slate-400';
  }
}

/** Passos visuais do pipeline — mostra o progresso mesmo sem texto. */
function PipelineSteps({ status }: { status: PickStatus }) {
  const steps = [
    { key: 'new', label: 'Recebido' },
    { key: 'separating', label: 'Separando' },
    { key: 'separated', label: 'Pronto' },
    { key: 'shipped', label: 'Enviado' },
  ] as const;
  const order = ['new', 'separating', 'separated', 'ready', 'shipped'];
  const currentIdx = order.indexOf(status);
  const stepIdx = (k: string) => {
    if (k === 'separated') {
      return status === 'separated' || status === 'ready' || status === 'shipped' ? 2 : -1;
    }
    return order.indexOf(k);
  };
  return (
    <div className="flex items-center gap-1 px-3 pt-2 pb-1">
      {steps.map((s, i) => {
        const reachedIdx = s.key === 'separated'
          ? (status === 'separated' || status === 'ready' || status === 'shipped' ? 99 : -1)
          : order.indexOf(s.key);
        const done = reachedIdx !== -1 && reachedIdx <= currentIdx
          || (s.key === 'separated' && (status === 'separated' || status === 'ready' || status === 'shipped'))
          || (s.key === 'shipped' && status === 'shipped');
        const isCurrent =
          (s.key === status) ||
          (s.key === 'separated' && status === 'ready');
        return (
          <div key={s.key} className="flex-1 flex flex-col items-center gap-0.5">
            <div
              className={`w-full h-1.5 rounded-full transition-colors ${
                done ? 'bg-emerald-500' : 'bg-slate-200'
              }`}
            />
            <span
              className={`text-[10px] uppercase tracking-wide ${
                isCurrent ? 'text-emerald-700 font-bold' : done ? 'text-emerald-600' : 'text-slate-400'
              }`}
            >
              {s.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

const liveBrl = (cents?: number | null) =>
  ((cents ?? 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/* ─── Card de pedido da LIVE — mesmo formato do pedido do site, com banner
       vermelho "PEDIDO DA LIVE <loja anfitriã>". Ações: Separei → Enviar. ─── */
function LiveOrderCard({
  group,
  busy,
  onBip,
  onSeparated,
  onShipped,
  onSwapItem,
}: {
  group: LiveQueueGroup;
  busy: string | null;
  onBip: () => void;
  onSeparated: (itemId: string) => void;
  onShipped: (itemId: string) => void;
  onSwapItem: (it: LiveQueueItem) => void;
}) {
  const pendentes = group.items.filter((it) => it.status === 'separating');
  const enviados = group.items.filter((it) => it.status === 'shipped');
  const aBipar = pendentes.filter((it) => !it.separatedAt);
  return (
    <article className="bg-white rounded-xl border border-rose-400 ring-2 ring-rose-200 shadow-md overflow-hidden flex">
      {/* Faixa lateral vermelha — semáforo visual da LIVE */}
      <div className="w-1.5 flex-shrink-0 bg-rose-500" />
      <div className="flex-1 min-w-0">
        {/* Banner LIVE — mesmo padrão do banner de transferência */}
        <div className="bg-rose-600 text-white px-4 py-2.5 flex items-center justify-between gap-2">
          <div>
            <div className="font-bold text-sm flex items-center gap-2">
              🔴 PEDIDO DA LIVE{group.liveStoreName ? ` ${group.liveStoreName.toUpperCase()}` : ''}
            </div>
            <div className="text-xs opacity-95 mt-0.5">
              Venda da live — separar e postar pra cliente no endereço abaixo.
            </div>
          </div>
          <button
            onClick={async () => {
              // Imprime o ROMANEIO na térmica configurada (app desktop = silencioso;
              // Chrome puro = diálogo). Mesma rota de impressão dos cupons.
              const { routePrint } = await import('@/lib/printer-router');
              await routePrint({ kind: 'cupom', url: `/minha-loja/live-romaneio/${group.cartId}?autoprint=1`, warnIfMissing: true });
            }}
            className="shrink-0 rounded-lg bg-white/15 hover:bg-white/25 px-3 py-1.5 text-xs font-bold"
            title="Imprimir romaneio do pedido (térmica)"
          >
            🖨 Imprimir pedido
          </button>
        </div>

        {/* Cliente */}
        <div className="px-4 py-3 border-b border-slate-100">
          <div className="font-bold text-slate-800">{group.customerName}</div>
          <div className="text-xs text-slate-500">
            {group.customerPhone}
            {group.customerInstagram && ` · @${group.customerInstagram}`}
            {group.customerCpf && ` · CPF ${group.customerCpf}`}
          </div>
        </div>

        {/* Envio + Pagamento — MESMO padrão do pedido do site (imprime e posta) */}
        <div className="grid gap-2 border-b border-slate-100 px-4 py-3 text-xs leading-relaxed text-slate-600 sm:grid-cols-2">
          <div>
            <div className="mb-0.5 font-semibold text-slate-700">
              {group.isPickup ? '🏬 Retirada em loja' : '📦 Envio'}
            </div>
            {group.isPickup ? (
              <div className="font-semibold text-orange-700">
                Cliente vai RETIRAR na loja {group.pickupStoreName || group.pickupStoreCode} — enviar a
                peça pra lá (transferência) em até 7 dias úteis. NÃO postar pro endereço.
              </div>
            ) : group.customerEndereco ? (
              <>
                <div className="text-slate-800">{group.customerName}</div>
                <div>
                  {group.customerEndereco}
                  {group.customerNumero ? `, ${group.customerNumero}` : ''}
                  {group.customerComplemento ? ` — ${group.customerComplemento}` : ''}
                </div>
                {group.customerBairro && <div>Bairro: {group.customerBairro}</div>}
                <div>
                  {group.customerCidade}
                  {group.customerUf ? ` - ${group.customerUf}` : ''}
                </div>
                {group.customerCep && <div>CEP: {group.customerCep}</div>}
              </>
            ) : (
              <div className="font-semibold text-amber-600">
                ⚠ SEM ENDEREÇO — NÃO postar. Avise a matriz pra completar o cadastro da cliente.
              </div>
            )}
            {!group.isPickup && group.freteServico && (
              <div className="mt-1.5 inline-block rounded-md bg-indigo-50 px-2 py-1 text-[11px] font-extrabold text-indigo-700">
                📮 Enviar por {group.freteServico}
              </div>
            )}
            {group.customerPhone && <div className="mt-1">Tel: {group.customerPhone}</div>}
            {group.customerEmail && <div className="break-all">✉️ {group.customerEmail}</div>}
          </div>
          <div>
            <div className="mb-0.5 font-semibold text-slate-700">💳 Pagamento</div>
            <div>
              Forma:{' '}
              <span className="font-semibold text-slate-800">
                {group.paymentMethod === 'link' ? 'Link (cartão)' : group.paymentMethod === 'pix' ? 'PIX' : '—'}
              </span>
              {group.paidAt && (
                <span className="text-slate-400">
                  {' '}· pago às {new Date(group.paidAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                </span>
              )}
            </div>
            {group.subtotalCents != null && <div>Peças: {liveBrl(group.subtotalCents)}</div>}
            {(group.freteCents ?? 0) > 0 && (
              <div>
                Frete: {liveBrl(group.freteCents)}
                {group.freteServico && <span className="font-bold text-indigo-700"> · {group.freteServico}</span>}
              </div>
            )}
            {group.totalCents != null && (
              <div className="font-bold text-emerald-700">Total: {liveBrl(group.totalCents)}</div>
            )}
          </div>
        </div>

        {/* Itens */}
        <div className="divide-y divide-slate-50">
          {group.items.map((it) => {
            const podeTrocar = it.status === 'separating' && !it.separatedAt;
            return (
            <div key={it.id} className="flex items-center gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                {podeTrocar ? (
                  <button
                    onClick={() => onSwapItem(it)}
                    title="Trocar esta peça por outra"
                    className="group/troca text-left w-full"
                  >
                    <div className="font-medium text-slate-800 group-hover/troca:text-[#8C7325] group-hover/troca:underline decoration-dotted underline-offset-2">
                      {it.refCode} · {it.cor} {it.tamanho} <span className="text-slate-400">×{it.qty}</span>
                      <span className="ml-1 text-[10px] font-bold uppercase tracking-wide text-[#B8912B] opacity-0 group-hover/troca:opacity-100">✎ trocar</span>
                    </div>
                    <div className="truncate text-xs text-slate-500">{it.descricao}</div>
                  </button>
                ) : (
                  <>
                    <div className="font-medium text-slate-800">
                      {it.refCode} · {it.cor} {it.tamanho} <span className="text-slate-400">×{it.qty}</span>
                    </div>
                    <div className="truncate text-xs text-slate-500">{it.descricao}</div>
                  </>
                )}
                {it.trackingCode && (
                  <div className="text-xs text-emerald-600">Rastreio: {it.trackingCode}</div>
                )}
              </div>
              {it.status === 'separating' ? (
                <>
                  {it.separatedAt ? (
                    <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-bold text-emerald-700">
                      ✓ Conferida
                    </span>
                  ) : (
                    <button
                      onClick={() => onSeparated(it.id)}
                      disabled={busy === it.id}
                      title="Fallback sem bipar (etiqueta danificada) — a baixa de estoque roda igual"
                      className="inline-flex items-center gap-1 rounded-lg bg-slate-100 px-2.5 py-1.5 text-xs font-medium text-slate-500 hover:bg-slate-200 disabled:opacity-50"
                    >
                      marcar s/ bipar
                    </button>
                  )}
                  <button
                    onClick={() => onShipped(it.id)}
                    disabled={busy === it.id || !it.separatedAt || (!group.isPickup && !group.customerEndereco)}
                    title={
                      !group.isPickup && !group.customerEndereco
                        ? 'SEM ENDEREÇO — matriz precisa completar o cadastro antes do envio'
                        : it.separatedAt
                        ? group.isPickup
                          ? `Enviar pra loja de retirada (${group.pickupStoreName || group.pickupStoreCode})`
                          : 'Postar e informar o rastreio'
                        : 'Bipe a peça primeiro (conferência)'
                    }
                    className="inline-flex items-center gap-1 rounded-lg bg-rose-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-rose-700 disabled:opacity-40"
                  >
                    📦 Enviar
                  </button>
                </>
              ) : (
                <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-semibold text-slate-600">
                  Enviado
                </span>
              )}
            </div>
            );
          })}
        </div>

        {/* Bip de conferência — mesmo rito do pedido do site */}
        {aBipar.length > 0 && (
          <div className="px-4 py-2.5 border-t border-slate-100">
            <button
              onClick={onBip}
              className="w-full rounded-lg bg-violet-600 py-2.5 text-sm font-bold text-white hover:bg-violet-700"
            >
              🔍 Bipar conferência ({aBipar.length} peça{aBipar.length > 1 ? 's' : ''})
            </button>
          </div>
        )}

        {/* Rodapé: progresso */}
        <div className="bg-slate-50 px-4 py-2 text-xs text-slate-500">
          {pendentes.length > 0
            ? aBipar.length > 0
              ? `${aBipar.length} pra bipar · ${pendentes.length - aBipar.length} conferida(s) aguardando envio`
              : `Tudo conferido ✓ — informe o rastreio no Enviar`
            : `Tudo enviado ✓ (${enviados.length} peça(s))`}
        </div>
      </div>
    </article>
  );
}

/* ─── Modal de bipagem do pedido da LIVE — mesmo rito do site: bipa o código
       de barras, o sistema confere se a peça é do pedido e baixa o estoque. ─── */
function LiveBipModal({
  group,
  onClose,
}: {
  group: LiveQueueGroup;
  onClose: () => void;
}) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [doneIds, setDoneIds] = useState<Set<string>>(
    () => new Set(group.items.filter((i) => i.separatedAt || i.status === 'shipped').map((i) => i.id)),
  );
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const pendentes = group.items.filter((i) => i.status === 'separating' && !doneIds.has(i.id));
  const completo = pendentes.length === 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const c = code.trim();
    if (!c || busy) return;
    setBusy(true);
    setFeedback(null);
    try {
      const r = await api<{ ok: boolean; itemId: string; descricao: string; cor: string | null; tamanho: string | null; restantes: number }>(
        `/live-pdv/carts/${group.cartId}/bip`,
        { method: 'POST', body: JSON.stringify({ code: c }) },
      );
      setDoneIds((s) => new Set(s).add(r.itemId));
      setFeedback({ ok: true, text: `✓ ${r.descricao}${r.cor ? ` · ${r.cor}` : ''}${r.tamanho ? ` ${r.tamanho}` : ''}` });
    } catch (err: any) {
      const raw = String(err?.message || '');
      let msg = 'Peça não confere.';
      try {
        const j = JSON.parse(raw.slice(raw.indexOf(': ') + 2));
        if (j?.message) msg = Array.isArray(j.message) ? j.message[0] : j.message;
      } catch { /* texto cru */ }
      setFeedback({ ok: false, text: `✗ ${msg}` });
    } finally {
      setCode('');
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <form onSubmit={submit} className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl">
        <div className="mb-1 flex items-center justify-between">
          <h3 className="text-lg font-bold text-slate-800">🔍 Bipar conferência</h3>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600">✕</button>
        </div>
        <p className="mb-3 text-xs text-slate-500">
          <b>{group.customerName}</b> · pedido da LIVE{group.liveStoreName ? ` ${group.liveStoreName.toUpperCase()}` : ''}.
          Bipe o código de barras de cada peça — a baixa de estoque sai no bip.
        </p>

        <input
          ref={inputRef}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="Bipe ou digite o código…"
          disabled={busy || completo}
          className="mb-2 w-full rounded-lg border-2 border-violet-300 px-3 py-3 text-lg font-mono focus:border-violet-500 focus:outline-none disabled:bg-slate-100"
        />
        {feedback && (
          <div
            className={`mb-2 rounded-lg px-3 py-2 text-sm font-semibold ${
              feedback.ok ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'
            }`}
          >
            {feedback.text}
          </div>
        )}

        <div className="mb-3 max-h-56 space-y-1 overflow-y-auto">
          {group.items.filter((i) => i.status === 'separating').map((it) => {
            const ok = doneIds.has(it.id);
            return (
              <div
                key={it.id}
                className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
                  ok ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-slate-200 text-slate-700'
                }`}
              >
                <span className="w-5 text-center">{ok ? '✓' : '•'}</span>
                <span className="min-w-0 flex-1 truncate">
                  {it.refCode} · {it.cor} {it.tamanho} <span className="opacity-60">×{it.qty}</span>
                </span>
              </div>
            );
          })}
        </div>

        {completo ? (
          <button
            type="button"
            onClick={onClose}
            className="w-full rounded-lg bg-emerald-600 py-2.5 font-bold text-white hover:bg-emerald-700"
          >
            ✓ Tudo conferido — voltar e enviar
          </button>
        ) : (
          <div className="text-center text-xs text-slate-400">
            {pendentes.length} peça(s) restante(s)
          </div>
        )}
      </form>
    </div>
  );
}

function PickOrderCard({
  row, onStart, onBip, onShip, onEntregaSemRastreio, onCorreios, onReabrir, onReimprimir, onMarcarEnviado, onDocsJuntada, onPrint, onReportIssue, onSeen, onSwapItem, onEditarEndereco,
}: {
  row: PickOrderRow;
  onStart: () => void;
  onBip: () => void;
  onShip: () => void;
  onEntregaSemRastreio: (modo: 'Motoboy' | 'Retirada') => void;
  onCorreios: () => Promise<void> | void;
  onReabrir: () => void;
  onEditarEndereco: () => void;
  onReimprimir: () => void;
  onMarcarEnviado: () => void;
  onDocsJuntada: () => Promise<void> | void;
  onPrint: () => void;
  onReportIssue: () => void;
  onSeen: () => void;
  onSwapItem: (it: PickOrderItem) => void;
}) {
  const { order, status } = row;
  const items = order.items ?? [];
  // Pode gerar envio Correios: qualquer pedido que NÃO é retirada em loja
  // (live E site). Retirada não posta.
  /**
   * MOTOBOY É O TERCEIRO MUNDO (17/08). O card só conhecia "posta nos
   * Correios" ou "retirada", e motoboy caía no primeiro: o único botão azul
   * gerava etiqueta SEDEX de verdade, e o outro exigia rastreio que não
   * existe. A loja fechava inventando um código. Agora motoboy e retirada
   * têm o botão que diz o que aconteceu, e nenhum dos dois posta.
   */
  const tipoEntrega = classifyShipping(order.shippingMethod ?? null, null).kind;
  const ehMotoboy = tipoEntrega === 'motoboy';
  // FEEDER DE JUNTADA: as peças vão pra loja ÂNCORA, nunca pra cliente —
  // etiqueta de cliente aqui seria envio errado (o backend bloqueia, mas o
  // botão nem deve aparecer). O caminho é "Documentos da caixa".
  const ehFeederJuntada = !!row.juntadaFeeder;
  // ÂNCORA aguardando caixas das outras lojas: o envio final só libera com o
  // pedido completo (o backend trava) — botão ativo aqui viraria toast de
  // erro em loop enquanto a faixa acima diz "aguarde as caixas".
  const aguardandoCaixas =
    !!row.juntadaChegando && row.juntadaChegando.recebidas < row.juntadaChegando.total;
  const podeGerarEnvio = !order.isPickup && !ehMotoboy && !ehFeederJuntada && !aguardandoCaixas;
  /**
   * ETIQUETA JÁ GERADA continua administrável mesmo esperando as caixas.
   *
   * A matriz pode juntar um pedido que a loja JÁ despachou pro trilho dos
   * Correios (`separated` com rastreio). Amarrar o painel da etiqueta ao
   * `podeGerarEnvio` deixava o card sem NENHUM botão nessa janela: a etiqueta
   * viva nos Correios, sem "Reabrir" pra cancelar e sem "Etiqueta + NF" pra
   * reimprimir. O que a juntada tem que impedir é POSTAR incompleto — só o
   * "Já postei" some enquanto falta caixa.
   */
  const podeMexerNaEtiqueta = !order.isPickup && !ehMotoboy && !ehFeederJuntada;
  const [corrBusy, setCorrBusy] = useState(false);
  const [docsBusy, setDocsBusy] = useState(false);

  const isTransfer = !!row.isTransfer;
  // CARD VERDE ONLINE (14/08): pedido criado pela Venda Online do PDV de outra
  // loja (ou desta). Processo idêntico ao pedido do site — a cor/tag só dizem
  // de onde veio.
  const isOnline = order.source === 'pdv_online';
  const snap = row.customerSnapshot ?? null;
  // Na transferência os dados-chave vêm do snapshot (cliente final), não do order.customerName
  const customerName = isTransfer ? snap?.name ?? order.customerName : order.customerName;
  const customerCpf = isTransfer ? snap?.cpf : order.customerCpf ?? null;
  const customerEmail = isTransfer ? snap?.email : order.customerEmail ?? null;
  const customerPhone = isTransfer ? snap?.phone : order.customerPhone;

  return (
    <article
      className={`bg-white rounded-xl border shadow-md overflow-hidden flex ${
        isTransfer
          ? 'border-orange-400 ring-2 ring-orange-200'
          : isOnline
          ? 'border-green-500 ring-2 ring-green-200'
          : 'border-slate-200'
      }`}
      onClick={onSeen}
    >
      {/* Faixa lateral colorida conforme status — semáforo visual de 6px */}
      <div className={`w-1.5 flex-shrink-0 ${statusAccent(status)}`} />

      <div className="flex-1 min-w-0">
      {/* Banner TRANSFERÊNCIA — alerta visual forte quando não é venda direta.
          JUNTADA tem banner próprio: aqui a cliente NÃO retira — as peças
          completam o pedido na loja âncora, que envia o pacote único. */}
      {isTransfer && (
        ehFeederJuntada ? (
          <div className="bg-violet-600 text-white px-4 py-2.5">
            <div className="font-bold text-sm flex items-center gap-2">
              🧲 JUNTANDO PEDIDO #{order.wcOrderNumber ?? order.wcOrderId ?? '—'} — envie as
              peças pra LOJA {row.transferToStoreName ?? row.transferToStoreCode}
            </div>
            <div className="text-xs opacity-95 mt-0.5">
              As peças NÃO vão pra cliente: elas completam o pedido na loja{' '}
              {row.transferToStoreName ?? row.transferToStoreCode}, que envia tudo junto.
            </div>
          </div>
        ) : (
          <div className="bg-orange-500 text-white px-4 py-2.5">
            <div className="font-bold text-sm flex items-center gap-2">
              🚚 TRANSFERÊNCIA PRA LOJA {row.transferToStoreName ?? row.transferToStoreCode}
            </div>
            <div className="text-xs opacity-95 mt-0.5">
              Separar e enviar pra essa loja — cliente vai retirar lá. Não é venda direta.
            </div>
          </div>
        )
      )}

      {/* Pipeline steps — mostra o progresso visualmente */}
      <PipelineSteps status={status} />

      {/* Header do card — número do pedido BEM grande */}
      <header className="flex items-start justify-between px-4 pt-2 pb-3 border-b border-slate-100">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-2xl font-black text-slate-900 tracking-tight">
              #{order.wcOrderNumber ?? order.wcOrderId ?? '—'}
            </span>
            <span
              className={`text-xs font-bold uppercase tracking-wide px-2 py-1 rounded border ${STATUS_COLOR[status]}`}
            >
              {STATUS_LABEL[status]}
            </span>
            {isTransfer && (
              <span className={`text-xs px-2 py-1 rounded font-bold uppercase border ${
                ehFeederJuntada
                  ? 'bg-violet-100 text-violet-800 border-violet-300'
                  : 'bg-orange-100 text-orange-800 border-orange-300'
              }`}>
                {ehFeederJuntada ? '🧲 Juntada' : 'Transferência'}
              </span>
            )}
            {isOnline && (
              <span className="text-xs px-2 py-1 rounded bg-green-600 text-white border border-green-700 font-bold uppercase">
                Online
              </span>
            )}
          </div>
          <div className="text-sm text-slate-700 font-medium mt-1 truncate">
            {customerName ?? '—'}
          </div>
        </div>
        <div className="text-right text-xs text-slate-500 ml-2 flex-shrink-0">
          {order.totalAmount != null && (
            <div className="text-base font-bold text-slate-900">
              R$ {Number(order.totalAmount).toFixed(2)}
            </div>
          )}
          <div className="flex items-center gap-1 mt-1 justify-end">
            <Clock className="w-3 h-3" />
            <span>{formatRelativeTime(row.createdAt)}</span>
          </div>
        </div>
      </header>

      {/* ─── FAIXA DE MODALIDADE DE ENVIO ─── */}
      {/* Destaque MÁXIMO pra filial bater o olho e saber se é SEDEX/PAC/RETIRADA. */}
      {(() => {
        const raw = order.shippingMethod ?? null;
        /**
         * O QUE POSTAR vem do BACKEND (dono, 21/08), não do título.
         *
         * "Frete Grátis" não diz serviço nenhum: a faixa classificava pelo
         * texto e escrevia TRANSPORTADORA — a vendedora abria o card sem
         * saber se ia de SEDEX ou de PAC. Agora `servicoEnvio` chega pronto,
         * resolvido pela MESMA régua que gera a pré-postagem, e o "(grátis)"
         * fica pequeno ao lado: é informação da cliente, não instrução de
         * despacho.
         *
         * Card antigo (payload sem o campo) cai no classificador de sempre.
         */
        const servico = row.servicoEnvio ?? null;
        if (!servico && !raw) return null;

        const addrPar = parseShippingAddress(order.shippingAddress);
        const m = classifyShipping(raw, addrPar?.state ?? null);
        const kind: string = servico
          ? servico === 'RETIRADA'
            ? 'pickup'
            : servico.toLowerCase()
          : m.kind;
        const label = servico === 'RETIRADA' ? 'RETIRADA EM LOJA' : servico ?? m.label;

        const Icon =
          kind === 'sedex' ? Truck : kind === 'pac' ? Package : kind === 'motoboy' ? Truck : kind === 'pickup' ? Package2 : kind === 'transportadora' ? Truck : Package2;
        // Cores fortes inline pra garantir contraste alto
        const bg =
          kind === 'sedex'
            ? 'bg-red-600'
            : kind === 'pac'
            ? 'bg-blue-600'
            : kind === 'pickup'
            ? 'bg-amber-500'
            : kind === 'motoboy'
            ? 'bg-orange-600'
            : kind === 'transportadora'
            ? 'bg-purple-600'
            : 'bg-slate-700';
        // Grátis só faz sentido em ENVIO — retirada não tem frete pra pagar.
        const mostrarGratis = !!row.freteGratis && kind !== 'pickup';
        return (
          <div
            className={`${bg} text-white px-4 py-3 flex items-center gap-3 shadow-inner`}
            title={m.raw || label}
          >
            <Icon className="w-8 h-8 shrink-0" strokeWidth={2.5} />
            <div className="flex-1 min-w-0">
              <div className="text-[10px] uppercase tracking-widest opacity-80 leading-none">
                Modalidade de Envio
              </div>
              <div className="flex items-baseline gap-2 min-w-0">
                <span className="text-2xl md:text-3xl font-black uppercase tracking-wide leading-tight truncate">
                  {label}
                </span>
                {mostrarGratis && (
                  <span className="text-xs md:text-sm font-semibold uppercase tracking-wide opacity-90 shrink-0">
                    (grátis)
                  </span>
                )}
                {/* NINGUÉM ESCOLHEU (24/08) — a faixa não pode afirmar um
                    serviço que o sistema chutou pela UF. Ver ON-000105. */}
                {row.servicoEnvioIncerto && (
                  <span className="text-[10px] md:text-xs font-black uppercase tracking-wide bg-amber-300 text-amber-950 px-2 py-0.5 rounded shrink-0">
                    não informada
                  </span>
                )}
              </div>
              {row.servicoEnvioIncerto && (
                <div className="text-[11px] font-semibold leading-snug mt-0.5 opacity-95">
                  Ninguém escolheu como enviar — o sistema supôs pelo estado da cliente.
                  Confirme com quem vendeu <b>antes</b> de gerar a etiqueta.
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* Card da ÂNCORA da juntada — caixas das outras lojas vindo pra cá.
          O bipe das peças próprias segue igual; o envio final só libera
          quando o pedido estiver completo (todas as caixas recebidas). */}
      {row.juntadaChegando && (() => {
        const j = row.juntadaChegando!;
        const faltam = j.total - j.recebidas;
        const minhasPecas = items.reduce((s, i) => s + (i.quantity ?? 0), 0);
        const totalPedido = minhasPecas + (j.pecasChegando ?? 0);
        return (
        <section className="mx-4 mt-3 rounded-lg border-2 border-violet-300 bg-violet-50 p-3">
          {/* O TÍTULO diz o que a loja precisa entender ANTES de embalar: este
              pedido não é só o que está na tela dela. */}
          <div className="text-sm font-bold text-violet-900">
            🧲 PEDIDO COMPOSTO — esta loja junta e envia
          </div>
          {j.pecasChegando ? (
            <div className="mt-1 text-xs text-violet-900">
              São <span className="font-bold">{totalPedido} peça(s)</span> no total:{' '}
              <span className="font-bold">{minhasPecas}</span> daqui e{' '}
              <span className="font-bold">{j.pecasChegando}</span> de outra(s) loja(s).
            </div>
          ) : null}
          <ul className="mt-1.5 space-y-1 text-xs text-violet-900">
            {j.caixas.map((c, i) => (
              <li key={c.code ?? `${c.fromStoreName}-${i}`} className="flex items-center gap-1.5 flex-wrap">
                <span className="font-semibold">{c.fromStoreName ?? 'Loja da rede'}</span>
                {c.pecas ? <span className="text-violet-700">({c.pecas} peça{c.pecas > 1 ? 's' : ''})</span> : null}
                <span className="text-violet-400">→</span>
                {/* Sem caixa ainda: a outra loja nem terminou de separar. Dizer
                    isso é o que faltava — antes o card ficava mudo até a caixa
                    nascer e a âncora achava que era um pedido comum. */}
                {c.etapa === 'problema' ? (
                  // A loja reportou problema: o card sumiu da fila DELA e a
                  // matriz vai remanejar. Dizer "ainda separando" aqui seria a
                  // fila mentindo — ninguém está separando essa peça.
                  <span className="font-semibold text-red-700">
                    ⚠️ loja reportou problema — a matriz vai remanejar
                  </span>
                ) : c.etapa === 'separando' || !c.code ? (
                  <span className="font-semibold text-amber-700">✋ ainda separando na loja</span>
                ) : (
                  <>
                    <span>
                      caixa <span className="font-mono font-semibold">{c.code}</span>
                    </span>
                    {c.etapa === 'chegou' || c.status === 'received' ? (
                      <span className="font-semibold text-emerald-700">✅ chegou</span>
                    ) : (
                      <span>📦 em trânsito</span>
                    )}
                    {c.trackingCode && <span className="font-mono text-violet-700">{c.trackingCode}</span>}
                  </>
                )}
              </li>
            ))}
          </ul>
          <div className="mt-1.5 text-xs text-violet-800 font-medium">
            {faltam > 0 ? (
              <>
                <span className="font-bold">NÃO ENVIE AINDA.</span> Separe e deixe as peças
                daqui prontas; falta(m) {faltam} caixa(s). Dê entrada na tela de
                Transferências quando chegar — o envio libera com o pedido completo.
              </>
            ) : (
              <>Todas as caixas chegaram — pode conferir o pedido inteiro e enviar.</>
            )}
          </div>
        </section>
        );
      })()}

      {/* Itens — qty em badge circular de destaque */}
      <section className="px-4 py-3 space-y-2 text-sm">
        <div className="text-[11px] uppercase tracking-wide font-bold text-slate-500 mb-1">
          Peças ({items.reduce((s, i) => s + (i.quantity ?? 0), 0)})
        </div>
        {items.length === 0 ? (
          <div className="text-slate-400 italic">Sem itens atribuídos</div>
        ) : (
          items.map((it, idx) => (
            <div key={it.id ?? `${it.sku}-${idx}`} className="flex gap-3 items-start">
              {/* Foto do produto — ajuda vendedora a encontrar a peça rápido na loja.
                  Click amplia em lightbox com nome+SKU pra conferir detalhes. */}
              <ProductThumb
                sku={it.sku}
                refCode={it.productName ?? it.sku}
                productName={it.productName ?? null}
                size={64}
              />
              <span className="inline-flex items-center justify-center min-w-[2.25rem] h-9 px-2 rounded-full bg-slate-900 text-white font-extrabold text-sm shrink-0">
                {it.quantity}x
              </span>
              <div className="flex-1 min-w-0">
                {(status === 'new' || status === 'separating') ? (
                  <button
                    onClick={() => onSwapItem(it)}
                    title="Trocar esta peça por outra"
                    className="group/troca text-left w-full"
                  >
                    <div className="text-slate-900 font-semibold leading-tight group-hover/troca:text-[#8C7325] group-hover/troca:underline decoration-dotted underline-offset-2">
                      {tituloPeca(it)}
                      <span className="ml-1 text-[10px] font-bold uppercase tracking-wide text-[#B8912B] opacity-0 group-hover/troca:opacity-100">✎ trocar</span>
                    </div>
                  </button>
                ) : (
                  <div className="text-slate-900 font-semibold leading-tight">
                    {tituloPeca(it)}
                  </div>
                )}
                {/* Descrição embaixo, cinza — o MESMO formato do card da LIVE
                    logo abaixo nesta tela: a linha grande é REF · COR TAM. */}
                {it.ref && it.productName && (
                  <div className="truncate text-xs text-slate-500">
                    {nomeSemVariacao(it.productName, it.cor, it.tamanho)}
                  </div>
                )}
                {it.variant && (
                  <div className="text-xs text-slate-500 mt-0.5">{it.variant}</div>
                )}
                <div className="text-xs text-slate-400 font-mono mt-0.5">SKU: {it.sku}</div>
              </div>
            </div>
          ))
        )}
      </section>

      {/* Dados do cliente (quando transferência — bloco em destaque com tudo que a loja precisa) */}
      {isTransfer && (
        <section className={`px-3 pb-2 text-xs text-slate-700 leading-relaxed border-t pt-2 ${
          ehFeederJuntada ? 'border-violet-100 bg-violet-50/40' : 'border-orange-100 bg-orange-50/40'
        }`}>
          <div className={`font-semibold mb-1 ${ehFeederJuntada ? 'text-violet-900' : 'text-orange-900'}`}>
            {ehFeederJuntada
              ? <>🧾 Cliente final (recebe o pacote único da LOJA {row.transferToStoreName ?? row.transferToStoreCode})</>
              : <>🧾 Dados do cliente final (quem vai retirar na LOJA {row.transferToStoreName ?? row.transferToStoreCode})</>}
          </div>
          {customerName && <div className="text-slate-900 font-medium">{customerName}</div>}
          {customerCpf && (
            <div className="font-mono">🪪 CPF {customerCpf}</div>
          )}
          {customerEmail && <div>✉️ {customerEmail}</div>}
          {customerPhone && <div>📱 {formatPhone(customerPhone)}</div>}
          {ehFeederJuntada ? (
            <div className="mt-1 text-violet-900 font-medium">
              As peças deste card NÃO vão pra cliente: elas completam o pedido na loja{' '}
              {row.transferToStoreName ?? row.transferToStoreCode}, que envia tudo junto.
              Bipe normal e finalize — a caixa e os documentos saem sozinhos.
            </div>
          ) : (
            <div className="mt-1 text-orange-900 font-medium">
              ⚠ Cliente vai retirar na loja {row.transferToStoreName ?? row.transferToStoreCode}
              {row.transferToStoreCity ? ` (${row.transferToStoreCity})` : ''}.
            </div>
          )}
        </section>
      )}

      {/* Endereço / envio ao cliente — só em pedido de ENTREGA normal */}
      {!isTransfer && (() => {
        const addr = parseShippingAddress(order.shippingAddress);
        if (!addr && !order.shippingCep && !customerPhone) return null;
        return (
          <section className="px-3 pb-2 text-xs text-slate-600 leading-relaxed">
            <div className="font-medium text-slate-700 mb-0.5">Envio</div>
            {addr?.recipientName && <div className="text-slate-800">{addr.recipientName}</div>}
            {addr?.streetLine && <div>{addr.streetLine}</div>}
            {addr?.complement && <div>{addr.complement}</div>}
            {addr?.neighborhood && <div>Bairro: {addr.neighborhood}</div>}
            {addr?.cityState && <div>{addr.cityState}</div>}
            {(addr?.cep || order.shippingCep) && (
              <div>CEP: {addr?.cep ?? order.shippingCep}</div>
            )}
            {/* Fallback: texto cru se não deu pra parsear */}
            {!addr?.streetLine && !addr?.recipientName && addr?.oneLiner && (
              <div className="text-slate-500 break-words">{addr.oneLiner}</div>
            )}
            {customerCpf && (
              <div className="mt-1 font-mono text-slate-700">CPF {customerCpf}</div>
            )}
            {customerPhone && (
              <div className="mt-1">Tel: {formatPhone(customerPhone)}</div>
            )}
            {customerEmail && (
              <div className="mt-1 break-all">✉️ {customerEmail}</div>
            )}
          </section>
        );
      })()}

      {/* Rastreio (se já enviado) — mostra código + timeline ao vivo (LinkeTrack) */}
      {status === 'shipped' && row.trackingCode && (
        <section className="mx-4 mb-3 space-y-2">
          <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-3">
            <div className="text-[11px] uppercase tracking-wide font-bold text-emerald-800 flex items-center gap-1">
              <Truck className="w-3 h-3" /> Rastreio
            </div>
            <div className="font-mono text-lg font-bold text-emerald-900 mt-0.5">
              {row.trackingCode}
            </div>
            <div className="text-xs text-emerald-700">{row.carrier}</div>
          </div>
          {/* CORRIGIR ENDEREÇO em pedido JÁ ENVIADO.
              O botão do outro bloco vive em `status !== 'shipped'` — ou seja,
              sumia exatamente na aba Enviados, que foi criada pra isso.
              Aqui a etiqueta não se refaz (o objeto já está viajando), mas
              corrigir vale: acerta o cadastro da cliente pro próximo pedido e
              deixa o registro certo pra quem for atrás depois. */}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onEditarEndereco(); }}
            className="w-full rounded-lg border-2 border-violet-300 bg-white py-2 text-sm font-semibold text-violet-700 hover:bg-violet-50"
            title="Corrigir o endereço do pedido e do cadastro da cliente"
          >
            ✎ Corrigir endereço
          </button>
          {/* Timeline ao vivo: só carrega quando expandir (compact) pra não estourar chamadas */}
          <TrackingTimeline
            code={row.trackingCode}
            carrier={row.carrier}
            autoFetch={false}
            compact
          />
        </section>
      )}

      {/* Ações — botões gigantes, fáceis de acertar com dedo */}
      <footer className="p-3 border-t border-slate-100 bg-slate-50/60 flex flex-col sm:flex-row gap-2">
        {status === 'new' && (
          <button
            onClick={(e) => { e.stopPropagation(); onStart(); }}
            className="flex-1 bg-amber-500 hover:bg-amber-600 active:scale-[0.98] text-white font-bold py-4 rounded-lg flex items-center justify-center gap-2 text-base shadow-md transition"
          >
            <PlayCircle className="w-6 h-6" /> Iniciar Separação
          </button>
        )}
        {status === 'separating' && (
          <button
            onClick={(e) => { e.stopPropagation(); onBip(); }}
            className="flex-1 bg-blue-600 hover:bg-blue-700 active:scale-[0.98] text-white font-bold py-4 rounded-lg flex items-center justify-center gap-2 text-base shadow-md transition"
          >
            <Barcode className="w-6 h-6" /> Bipar peças
          </button>
        )}
        {/* FEEDER DE JUNTADA finalizado → o caminho é a CAIXA pra loja âncora:
            PDF único com etiqueta pra loja + DANFE da transferência + romaneio
            (rota do carro sai só o romaneio). Nada de etiqueta de cliente. */}
        {ehFeederJuntada && (status === 'separated' || status === 'ready') && (
          <div className="flex-1 flex flex-col gap-1.5">
            <button
              onClick={async (e) => {
                e.stopPropagation();
                if (docsBusy) return;
                setDocsBusy(true);
                try { await onDocsJuntada(); } finally { setDocsBusy(false); }
              }}
              disabled={docsBusy}
              title="Baixa etiqueta pra loja + NF de transferência + romaneio num PDF único"
              className="w-full bg-violet-600 hover:bg-violet-700 active:scale-[0.98] disabled:opacity-50 text-white font-bold py-4 rounded-lg flex items-center justify-center gap-2 text-base shadow-md transition"
            >
              <Printer className="w-6 h-6" /> {docsBusy ? 'Gerando…' : '📄 Documentos da caixa'}
            </button>
            {row.caixaJuntada && (
              <div className="rounded-lg border-2 border-violet-200 bg-violet-50 px-3 py-1.5 text-center text-sm font-bold text-violet-900">
                Caixa <span className="font-mono">{row.caixaJuntada.code}</span>
                {row.caixaJuntada.status === 'received' && ' · ✅ chegou na âncora'}
                {row.caixaJuntada.trackingCode && (
                  <div className="text-[11px] font-normal text-violet-700">
                    <span className="font-mono font-semibold">{row.caixaJuntada.trackingCode}</span>
                    {row.caixaJuntada.carrier && <> · {row.caixaJuntada.carrier}</>}
                  </div>
                )}
              </div>
            )}
            {row.caixaJuntada?.transportMode === 'proprio' && (
              <div className="rounded-lg border-2 border-amber-300 bg-amber-50 px-3 py-1.5 text-center text-xs font-bold text-amber-900">
                🚚 Vai no carro da rede — imprima o romaneio e despache a caixa
              </div>
            )}
          </div>
        )}
        {/* Pronto, SEM pré-postagem (live OU site) → gera (não marca enviado; fica na lista) */}
        {(status === 'separated' || status === 'ready') && podeGerarEnvio && !row.trackingCode && (
          <button
            onClick={async (e) => { e.stopPropagation(); if (corrBusy) return; setCorrBusy(true); try { await onCorreios(); } finally { setCorrBusy(false); } }}
            disabled={corrBusy}
            title="Gera a pré-postagem (modalidade correta). Depois clique em Etiqueta + NF pra imprimir. O pedido fica na lista até postar."
            className="flex-1 bg-sky-600 hover:bg-sky-700 active:scale-[0.98] disabled:opacity-50 text-white font-bold py-4 rounded-lg flex items-center justify-center gap-2 text-base shadow-md transition"
          >
            <Truck className="w-6 h-6" /> {corrBusy ? 'Gerando...' : '📮 Gerar envio Correios'}
          </button>
        )}
        {/* Pré-postagem gerada, aguardando postagem física */}
        {podeMexerNaEtiqueta && row.trackingCode && status !== 'shipped' && (
          <div className="flex-1 flex flex-col gap-1">
            <div className="rounded-lg border-2 border-sky-300 bg-sky-50 px-3 py-1.5 text-center text-sm font-bold text-sky-800">
              📮 {row.trackingCode} · {row.carrier || 'Correios'}
              <div className="text-[11px] font-normal text-sky-600">aguardando postagem — a cliente é avisada quando os Correios postarem</div>
            </div>
            <div className="flex gap-1">
              <button onClick={(e) => { e.stopPropagation(); onReimprimir(); }} title="Baixa etiqueta + DANFE num PDF único" className="flex-1 bg-white border-2 border-slate-300 text-slate-800 font-semibold py-2 rounded-lg text-sm hover:bg-slate-100">🏷️ Etiqueta + NF</button>
              <button onClick={(e) => { e.stopPropagation(); onEditarEndereco(); }} title="Corrigir o endereco antes de postar (complemento, numero, bairro)" className="flex-1 bg-white border-2 border-violet-300 text-violet-700 font-semibold py-2 rounded-lg text-sm hover:bg-violet-50">✎ Endereco</button>
              {/* "Já postei" fecha o pedido e avisa a cliente — não pode existir
                  enquanto faltam caixas (postaria o pedido pela metade). Os
                  outros botões continuam: a etiqueta está viva e precisa poder
                  ser reimpressa/cancelada. */}
              {!aguardandoCaixas && (
                <button onClick={(e) => { e.stopPropagation(); onMarcarEnviado(); }} title="Já postei — marcar enviado agora (baixa Giga + avisa cliente)" className="flex-1 bg-emerald-600 text-white font-semibold py-2 rounded-lg text-sm hover:bg-emerald-700">✓ Já postei</button>
              )}
              <button onClick={(e) => { e.stopPropagation(); if (confirm('Refazer o envio? A etiqueta atual é CANCELADA nos Correios e uma nova é gerada com o endereço que estiver no pedido agora.')) onReabrir(); }} className="flex-1 bg-white border-2 border-amber-300 text-amber-700 font-semibold py-2 rounded-lg text-sm hover:bg-amber-50">↩︎ Reabrir</button>
            </div>
          </div>
        )}
        {/* Motoboy → saiu com o motoboy. Retirada → a cliente levou. Nenhum dos
            dois tem rastreio, e o backend aceita shipped sem código nesses casos. */}
        {(status === 'separated' || status === 'ready') && (ehMotoboy || order.isPickup) && !ehFeederJuntada && (
          <button
            onClick={(e) => { e.stopPropagation(); onEntregaSemRastreio(ehMotoboy ? 'Motoboy' : 'Retirada'); }}
            title={ehMotoboy ? 'A peça saiu com o motoboy — fecha o pedido sem rastreio' : 'A cliente levou a peça — fecha o pedido sem rastreio'}
            className="flex-1 bg-emerald-600 hover:bg-emerald-700 active:scale-[0.98] text-white font-bold py-4 rounded-lg flex items-center justify-center gap-2 text-base shadow-md transition"
          >
            {ehMotoboy ? '🛵 Entregue por motoboy' : '🏬 Cliente retirou'}
          </button>
        )}
        {/* Âncora com o próprio bipe pronto, aguardando as caixas das feeders */}
        {(status === 'separated' || status === 'ready') && aguardandoCaixas && (
          <div className="flex-1 rounded-lg border-2 border-violet-300 bg-violet-50 px-3 py-3 text-center text-sm font-bold text-violet-800">
            🧲 Suas peças estão prontas — o envio libera quando as caixas das outras lojas chegarem
          </div>
        )}
        {/* Fallback manual → envio com rastreio digitado (só quem posta) */}
        {(status === 'separated' || status === 'ready') && !ehMotoboy && !order.isPickup && !ehFeederJuntada && !aguardandoCaixas && !row.trackingCode && (
          <button
            onClick={(e) => { e.stopPropagation(); onShip(); }}
            title="Digitar o rastreio manualmente (fallback se o Gerar envio falhar)"
            className="flex-1 bg-emerald-600 hover:bg-emerald-700 active:scale-[0.98] text-white font-bold py-4 rounded-lg flex items-center justify-center gap-2 text-base shadow-md transition"
          >
            <Truck className="w-6 h-6" /> Enviar c/ rastreio
          </button>
        )}
        {(status === 'new' || status === 'separating') && (
          <button
            onClick={(e) => { e.stopPropagation(); onReportIssue(); }}
            className="sm:w-auto bg-white hover:bg-red-50 active:scale-[0.98] text-red-700 font-semibold py-4 px-5 rounded-lg flex items-center justify-center gap-2 border-2 border-red-300 transition"
            title="Reportar problema (sem estoque, defeito, divergência)"
          >
            <AlertCircle className="w-5 h-5" /> Reportar
          </button>
        )}
      </footer>
      </div>
    </article>
  );
}

/* Modal de despacho da LIVE — rastreio OPCIONAL (Electron não tem prompt()) */
function LiveShipModal({
  busy, onClose, onSubmit,
}: {
  busy: boolean;
  onClose: () => void;
  onSubmit: (trackingCode?: string) => void;
}) {
  const [tracking, setTracking] = useState('');
  return (
    <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-white rounded-t-2xl sm:rounded-xl w-full sm:max-w-md shadow-xl">
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="font-bold text-lg">📦 Despachar peça da live</h2>
          <button onClick={onClose} className="p-1 hover:bg-slate-100 rounded">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-4">
          <label className="block text-sm font-medium mb-1">Código de rastreio (opcional)</label>
          <input
            type="text"
            autoFocus
            value={tracking}
            onChange={(e) => setTracking(e.target.value.toUpperCase())}
            onKeyDown={(e) => { if (e.key === 'Enter' && !busy) onSubmit(tracking.trim() || undefined); }}
            placeholder="Ex: BR123456789BR — deixe vazio se não tiver"
            className="w-full px-3 py-3 border rounded text-base font-mono uppercase"
          />
        </div>
        <div className="p-4 border-t flex gap-2">
          <button
            onClick={onClose}
            disabled={busy}
            className="flex-1 py-3 rounded-lg border border-slate-300 font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            onClick={() => onSubmit(tracking.trim() || undefined)}
            disabled={busy}
            className="flex-1 py-3 rounded-lg bg-rose-600 font-bold text-white hover:bg-rose-700 disabled:opacity-50"
          >
            {busy ? 'Despachando…' : tracking.trim() ? 'Despachar c/ rastreio' : 'Despachar sem rastreio'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ShippedModal({
  row, onClose, onSubmit,
}: {
  row: PickOrderRow;
  onClose: () => void;
  onSubmit: (row: PickOrderRow, trackingCode: string, carrier: string) => void;
}) {
  const [tracking, setTracking] = useState('');
  const [carrier, setCarrier] = useState(CARRIERS[0]);
  const [customCarrier, setCustomCarrier] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const effectiveCarrier = carrier === 'Outra' ? customCarrier.trim() : carrier;
  const canSubmit = tracking.trim().length >= 5 && effectiveCarrier.length >= 2;

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await onSubmit(row, tracking.trim(), effectiveCarrier);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-white rounded-t-2xl sm:rounded-xl w-full sm:max-w-md max-h-[90vh] overflow-y-auto shadow-xl">
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="font-bold text-lg">
            Enviar pedido #{row.order.wcOrderNumber ?? '—'}
          </h2>
          <button onClick={onClose} className="p-1 hover:bg-slate-100 rounded">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-4 space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Código de rastreio</label>
            <input
              type="text"
              autoFocus
              value={tracking}
              onChange={(e) => setTracking(e.target.value)}
              placeholder="Ex: BR123456789BR"
              className="w-full px-3 py-3 border rounded text-base font-mono uppercase"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Transportadora</label>
            <select
              value={carrier}
              onChange={(e) => setCarrier(e.target.value)}
              className="w-full px-3 py-3 border rounded text-base"
            >
              {CARRIERS.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
            {carrier === 'Outra' && (
              <input
                type="text"
                value={customCarrier}
                onChange={(e) => setCustomCarrier(e.target.value)}
                placeholder="Nome da transportadora"
                className="mt-2 w-full px-3 py-3 border rounded text-base"
              />
            )}
          </div>
        </div>
        <div className="p-4 border-t flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-3 bg-slate-200 hover:bg-slate-300 rounded font-medium"
          >
            Cancelar
          </button>
          <button
            onClick={submit}
            disabled={!canSubmit || submitting}
            className="flex-1 px-4 py-3 bg-slate-900 text-white rounded font-semibold disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {submitting ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Truck className="w-4 h-4" />}
            Confirmar envio
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// ReportIssueModal — loja sinaliza problema no pick-order
// ============================================================

const ISSUE_REASONS: Array<{ value: string; label: string; hint: string }> = [
  { value: 'out_of_stock', label: 'Sem estoque físico', hint: 'O sistema mostrava, mas a peça não está na loja' },
  { value: 'defective', label: 'Peça com defeito', hint: 'Furo, mancha, costura ruim, etc.' },
  { value: 'divergence', label: 'Divergência', hint: 'Cor ou tamanho diferente do pedido' },
  { value: 'other', label: 'Outro', hint: 'Descreva na observação abaixo' },
];

function ReportIssueModal({
  row, onClose, onSubmit,
}: {
  row: PickOrderRow;
  onClose: () => void;
  onSubmit: (row: PickOrderRow, reason: string, note: string) => Promise<void> | void;
}) {
  const [reason, setReason] = useState<string>('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const canSubmit = reason && (reason !== 'other' || note.trim().length >= 5);

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await onSubmit(row, reason, note.trim());
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-2 sm:p-4">
      <div className="bg-white rounded-t-2xl sm:rounded-xl max-w-md w-full max-h-[90vh] overflow-y-auto shadow-2xl">
        <header className="bg-red-600 text-white px-4 py-3 flex items-center gap-2">
          <AlertCircle className="w-5 h-5" />
          <div className="flex-1">
            <div className="font-bold">Reportar problema</div>
            <div className="text-xs opacity-90">
              Pedido #{row.order.wcOrderNumber ?? row.order.wcOrderId ?? '—'}
            </div>
          </div>
          <button onClick={onClose} className="text-white/90 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </header>

        <div className="p-4 space-y-3">
          <p className="text-sm text-slate-600">
            Ao confirmar, o pedido <b>some da sua fila</b> e a matriz é avisada pra reatribuir pra outra loja.
          </p>

          <div className="space-y-2">
            {ISSUE_REASONS.map((r) => (
              <label
                key={r.value}
                className={`block border-2 rounded-lg p-3 cursor-pointer transition ${
                  reason === r.value
                    ? 'border-red-500 bg-red-50'
                    : 'border-slate-200 hover:border-slate-300'
                }`}
              >
                <input
                  type="radio"
                  name="reason"
                  value={r.value}
                  checked={reason === r.value}
                  onChange={() => setReason(r.value)}
                  className="sr-only"
                />
                <div className="flex items-center gap-2">
                  <div
                    className={`w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${
                      reason === r.value ? 'border-red-500' : 'border-slate-400'
                    }`}
                  >
                    {reason === r.value && (
                      <div className="w-2 h-2 rounded-full bg-red-500" />
                    )}
                  </div>
                  <div>
                    <div className="font-semibold text-slate-900">{r.label}</div>
                    <div className="text-xs text-slate-600">{r.hint}</div>
                  </div>
                </div>
              </label>
            ))}
          </div>

          <div>
            <label className="text-xs font-semibold text-slate-700 block mb-1">
              Observação {reason === 'other' ? '(obrigatório)' : '(opcional)'}
            </label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              maxLength={500}
              placeholder="Ex: cheguei na arara e a peça não estava lá."
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-red-500"
            />
          </div>
        </div>

        <footer className="p-3 border-t border-slate-100 bg-slate-50 flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 bg-white hover:bg-slate-100 text-slate-700 font-semibold py-3 rounded-lg border-2 border-slate-300"
            disabled={submitting}
          >
            Cancelar
          </button>
          <button
            onClick={submit}
            disabled={!canSubmit || submitting}
            className="flex-1 bg-red-600 hover:bg-red-700 text-white font-bold py-3 rounded-lg disabled:bg-slate-300 disabled:cursor-not-allowed shadow-md"
          >
            {submitting ? 'Enviando...' : 'Confirmar problema'}
          </button>
        </footer>
      </div>
    </div>
  );
}

// ============================================================
// Helpers
// ============================================================

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return `${min}min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}
