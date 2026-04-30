'use client';
import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { api } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { classifyShipping } from '@/lib/shipping-method';
import TrackingTimeline from '@/components/TrackingTimeline';
import SellerTag from '@/components/SellerTag';
import { ArrowLeft, Save, ExternalLink, Truck, Package, Loader2, Check, Send, Store as StoreIcon, AlertTriangle, AlertCircle, Zap, Search, X } from 'lucide-react';

const WC_ADMIN_URL = 'https://www.lurds.com.br/wp-admin/admin.php?page=wc-orders&action=edit&id=';

const STATUS_OPTIONS: Array<{ slug: string; label: string }> = [
  { slug: 'pending',     label: 'Pagamento pendente' },
  { slug: 'on-hold',     label: 'Aguardando' },
  { slug: 'processing',  label: 'Processando' },
  { slug: 'separacao',   label: 'Separação' },
  { slug: 'completed',   label: 'Concluído' },
  { slug: 'cancelled',   label: 'Cancelado' },
  { slug: 'refunded',    label: 'Reembolsado' },
  { slug: 'failed',      label: 'Malsucedido' },
];

// Transportadoras mais usadas no BR (livre pra digitar qualquer outra)
/**
 * Mapeia status do pick-order pra label e cores da pílula.
 * Usado pra mostrar status visual ao lado de cada item do pedido.
 */
function pickStatusStyles(status: string): { label: string; bg: string; text: string } {
  const s = (status || '').toLowerCase();
  if (s === 'new') return { label: 'AGUARDANDO', bg: 'bg-slate-100', text: 'text-slate-700' };
  if (s === 'separating') return { label: 'SEPARANDO', bg: 'bg-blue-100', text: 'text-blue-800' };
  if (s === 'separated') return { label: 'SEPARADO', bg: 'bg-emerald-100', text: 'text-emerald-800' };
  if (s === 'ready') return { label: 'PRONTO', bg: 'bg-cyan-100', text: 'text-cyan-800' };
  if (s === 'shipped') return { label: 'ENVIADO', bg: 'bg-violet-100', text: 'text-violet-800' };
  if (s === 'delivered') return { label: 'ENTREGUE', bg: 'bg-green-200', text: 'text-green-900' };
  if (s === 'cancelled' || s === 'canceled') return { label: 'CANCELADO', bg: 'bg-red-100', text: 'text-red-800' };
  return { label: status.toUpperCase(), bg: 'bg-gray-100', text: 'text-gray-700' };
}

const CARRIERS = [
  { value: 'Correios',         trackUrl: 'https://rastreamento.correios.com.br/app/index.php?objetos=' },
  { value: 'Jadlog',           trackUrl: 'https://www.jadlog.com.br/tracking?cte=' },
  { value: 'Loggi',            trackUrl: 'https://www.loggi.com/rastreador/?tracking_key=' },
  { value: 'Mercado Envios',   trackUrl: '' },
  { value: 'Total Express',    trackUrl: 'https://tracking.totalexpress.com.br/poupup_track.php?reid=' },
  { value: 'JT Express',       trackUrl: 'https://www.jtexpress.com.br/track.html?billcode=' },
  { value: 'Azul Cargo',       trackUrl: 'https://www.azulcargoexpresso.com.br/Rastreio/RetornaNumeroDocumentoCliente?numero=' },
];

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
  isTransfer?: boolean;
  transferToStoreCode?: string | null;
  transferToStoreName?: string | null;
}
interface SeparationPreview {
  success: boolean;
  strategy:
    | 'single-store'
    | 'multi-store'
    | 'insufficient-stock'
    | 'pickup-lock'
    | 'pickup-transfer'
    | 'pickup-blocked';
  shippingMethod: string;
  groups: SeparationGroup[];
  missing: Array<{ sku: string; quantity: number; productName: string }>;
  alternativesBySku: Record<string, Array<{ storeId: string; storeCode: string; storeName: string; availableQty: number; whatsapp: string | null }>>;
  isPickup?: boolean;
  pickupStoreCode?: string | null;
  pickupStoreName?: string | null;
  customer?: {
    name: string;
    cpf: string | null;
    email: string | null;
    phone: string | null;
  };
}

interface WcOrderDetail {
  id: number;
  number: string;
  status: string;
  dateCreatedGmt: string;
  dateModifiedGmt: string;
  total: string;
  currency: string;
  paymentMethodTitle: string;
  customerNote: string;
  billing: any;
  shipping: any;
  lineItems: Array<{ id: number; name: string; sku: string; quantity: number; total: string; price: number; image: string | null }>;
  shippingLines: Array<{ method: string; total: string }>;
  tracking: { number: string; carrier: string; url: string };
  attribution: { origem: string; source: string };
  customerCpf?: string | null;
  pickup?: {
    isPickup: boolean;
    storeCode: string | null;
    storeName: string | null;
    shippingMethodTitle: string | null;
    unresolvedCityName: string | null;
  };
  sellerId?: string | null;
  sellerName?: string | null;
}

export default function PedidoDetailPage() {
  const params = useParams();
  const router = useRouter();
  const wcId = params.id as string;

  const [order, setOrder] = useState<WcOrderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  // Edição
  const [status, setStatus] = useState('');
  const [trackingNumber, setTrackingNumber] = useState('');
  const [trackingCarrier, setTrackingCarrier] = useState('');
  const [trackingUrl, setTrackingUrl] = useState('');
  const [note, setNote] = useState('');
  const [notifyCustomer, setNotifyCustomer] = useState(true);

  // Separação
  const [separation, setSeparation] = useState<SeparationPreview | null>(null);
  const [sepLoading, setSepLoading] = useState(false);
  const [sepError, setSepError] = useState<string | null>(null);
  /** Override manual: storeId → novo storeId selecionado */
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  // Confirmação (cria pick-order e dispara socket pra loja)
  const [confirmLoading, setConfirmLoading] = useState(false);
  const [confirmResult, setConfirmResult] = useState<{
    ok: boolean;
    pickOrders?: Array<{ id: string; status: string; storeCode: string; storeName: string }>;
    reason?: string;
    message?: string;
  } | null>(null);
  // Impressão remota: state por pickOrderId
  const [printState, setPrintState] = useState<Record<string, 'idle' | 'sending' | 'sent' | 'error'>>({});
  const [printError, setPrintError] = useState<Record<string, string>>({});

  // Diagnóstico de SKU (modal)
  const [diagnoseSku, setDiagnoseSku] = useState<string | null>(null);

  // Gate de quebra — pedido dividido em N lojas exige o operador marcar
  // "ciente da divisão" antes do botão Confirmar habilitar. Zera sempre que
  // gera/recalcula preview pra forçar nova revisão.
  const [splitApproved, setSplitApproved] = useState(false);

  // Modal de "Escolher loja manualmente" — retaguarda escolhe especificamente pra
  // qual loja o pedido vai (bypassa a decisão automática do routing). Usado
  // principalmente quando uma loja reportou problema e retaguarda quer forçar
  // uma outra loja específica em vez de deixar o engine decidir.
  const [pickStoreOpen, setPickStoreOpen] = useState(false);
  const [pickStoreLoading, setPickStoreLoading] = useState(false);
  const [pickStoreError, setPickStoreError] = useState<string | null>(null);
  const [pickStoreApplying, setPickStoreApplying] = useState<string | null>(null);
  const [pickStoreCandidates, setPickStoreCandidates] = useState<Array<{
    id: string;
    code: string;
    name: string;
    city: string | null;
    state: string | null;
    /** Cobertura: quantos SKUs a loja consegue cobrir entre os do pedido. */
    skusCovered: number;
    skusTotal: number;
    /** Quantidade total que a loja tem somando todos os SKUs. */
    totalQty: number;
    /** Lista dos SKUs que faltam nessa loja. */
    missingSkus: string[];
    /** Já reportou problema nesse pedido? */
    hasReportedIssue: boolean;
    active: boolean;
  }>>([]);
  const [allStoreCodes, setAllStoreCodes] = useState<string[]>([]);

  // ── Status ao vivo dos pick-orders (matriz vê o que a filial está fazendo) ──
  // Carregado de /pick-orders/by-wc/:wcId + atualizado em tempo real pelo
  // evento socket 'pick-order:status' (emitido pela sala 'admin' quando
  // qualquer loja muda status ou põe rastreio).
  const [liveStatus, setLiveStatus] = useState<Array<{
    id: string;
    status: 'new' | 'separating' | 'ready' | 'shipped';
    trackingCode: string | null;
    carrier: string | null;
    storeId: string;
    storeCode: string | null;
    storeName: string | null;
    storeCity: string | null;
    updatedAt: string;
    issueReason?: string | null;
    issueReasonLabel?: string | null;
    issueNote?: string | null;
    issueReportedAt?: string | null;
    // Baixa no Gigasistemas — backend retorna debitApprovedAt + debitStatus derivado.
    // 'applied' = baixa já dada no Giga (autoDebitOnShipped rodou OK)
    // 'missing' = status=shipped mas sem baixa (falhou, cair em /retaguarda/baixas-log)
    // 'pending' = ainda não deveria ter baixa (status=new/separating/ready)
    debitApprovedAt?: string | null;
    debitStatus?: 'applied' | 'pending' | 'missing';
  }>>([]);
  const [liveStatusFlash, setLiveStatusFlash] = useState<Record<string, number>>({});

  useEffect(() => { load(); /* eslint-disable-line */ }, [wcId]);

  // Carrega pick-orders atuais desse pedido WC quando a página abre
  useEffect(() => {
    if (!wcId) return;
    api<typeof liveStatus>(`/pick-orders/by-wc/${wcId}`)
      .then((data) => setLiveStatus(Array.isArray(data) ? data : []))
      .catch((e) => console.warn('Falha ao carregar pick-orders:', e?.message));
  }, [wcId]);

  // Escuta socket 'pick-order:status' pra atualizar em tempo real
  useEffect(() => {
    if (!wcId) return;
    const socket = getSocket();
    const onStatus = (payload: any) => {
      if (!payload?.id) return;
      // Filtra: só atualiza se o pick-order pertence ao pedido dessa tela
      setLiveStatus((prev) => {
        const match = prev.find((r) => r.id === payload.id);
        if (!match) return prev; // não é desse pedido
        return prev.map((r) =>
          r.id === payload.id
            ? {
                ...r,
                status: payload.status ?? r.status,
                trackingCode: payload.trackingCode ?? r.trackingCode,
                carrier: payload.carrier ?? r.carrier,
                updatedAt: new Date().toISOString(),
              }
            : r,
        );
      });
      // Flash visual (linha pisca verde por 3s)
      setLiveStatusFlash((prev) => ({ ...prev, [payload.id]: Date.now() }));
      setTimeout(() => {
        setLiveStatusFlash((prev) => {
          const { [payload.id]: _, ...rest } = prev;
          return rest;
        });
      }, 3000);
    };
    // Recalcular separação cancela pick-order(s) e cria novo(s) — atualiza painel.
    const onRemoved = () => {
      // Refetch — o backend pode ter cancelado N e criado M; mais simples re-puxar tudo.
      api<typeof liveStatus>(`/pick-orders/by-wc/${wcId}`)
        .then((data) => setLiveStatus(Array.isArray(data) ? data : []))
        .catch(() => {});
    };
    const onNew = () => {
      // Idem — pick-order novo apareceu (recalcular ou primeira confirmação)
      api<typeof liveStatus>(`/pick-orders/by-wc/${wcId}`)
        .then((data) => setLiveStatus(Array.isArray(data) ? data : []))
        .catch(() => {});
    };
    socket.on('pick-order:status', onStatus);
    socket.on('pick-order:removed', onRemoved);
    socket.on('pick-order:new', onNew);
    return () => {
      socket.off('pick-order:status', onStatus);
      socket.off('pick-order:removed', onRemoved);
      socket.off('pick-order:new', onNew);
    };
  }, [wcId]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const o = await api<WcOrderDetail>(`/orders/wc/${wcId}`);
      setOrder(o);
      setStatus(o.status);
      setTrackingNumber(o.tracking.number || '');
      setTrackingCarrier(o.tracking.carrier || '');
      setTrackingUrl(o.tracking.url || '');
    } catch (e: any) {
      setError(`Falha ao carregar pedido: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }

  // Se o usuário escolhe uma transportadora conhecida + tem código, gera URL automática
  useEffect(() => {
    if (!trackingCarrier || !trackingNumber) return;
    const c = CARRIERS.find((x) => x.value === trackingCarrier);
    if (c?.trackUrl) {
      const novaUrl = `${c.trackUrl}${trackingNumber.trim()}`;
      // Só sobrescreve se a URL atual for da mesma transportadora conhecida (ou vazia)
      if (!trackingUrl || CARRIERS.some((x) => trackingUrl.startsWith(x.trackUrl) && x.trackUrl)) {
        setTrackingUrl(novaUrl);
      }
    }
  }, [trackingCarrier, trackingNumber]); // eslint-disable-line

  async function save() {
    if (!order) return;
    setSaving(true);
    setError(null);
    setFlash(null);
    try {
      const body: any = {};

      if (status !== order.status) body.status = status;

      // Manda tracking só se mudou
      if (trackingNumber !== (order.tracking.number || '')) body.trackingNumber = trackingNumber;
      if (trackingCarrier !== (order.tracking.carrier || '')) body.trackingCarrier = trackingCarrier;
      if (trackingUrl !== (order.tracking.url || '')) body.trackingUrl = trackingUrl;

      if (note.trim()) {
        body.addNote = { text: note.trim(), notifyCustomer };
      }

      if (Object.keys(body).length === 0) {
        setFlash('Nada pra salvar — não tem alteração.');
        setTimeout(() => setFlash(null), 3000);
        setSaving(false);
        return;
      }

      const resp = await api<{
        ok: boolean;
        status: string;
        requestedStatus?: string;
        statusApplied?: boolean;
        warning?: string;
      }>(`/orders/wc/${wcId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });

      if (resp.warning || resp.statusApplied === false) {
        setError(
          `⚠ WooCommerce não aplicou o status pedido.\n` +
          `Pedido: "${resp.requestedStatus}" — Retornado pelo WC: "${resp.status}"\n\n` +
          `Causas mais comuns:\n` +
          `• O slug "${resp.requestedStatus}" não existe no WP (precisa registrar via plugin — WooCommerce Custom Order Status, ou código no functions.php)\n` +
          `• A chave REST não tem permissão de escrita (Read/Write)\n` +
          `• Algum plugin está bloqueando a transição (ex: fluxo de pagamento)`,
        );
      } else {
        setFlash('✓ Alterações enviadas para o site.');
      }
      setNote('');
      await load();
      setTimeout(() => setFlash(null), 3500);
    } catch (e: any) {
      setError(`Erro ao salvar: ${e.message}`);
    } finally {
      setSaving(false);
    }
  }

  /**
   * Comportamento dinâmico do botão:
   *  - SEM pick-order ainda → faz preview (GET prepare-separation)
   *  - COM pick-order ativo → RECALCULA de verdade (POST recalculate-separation)
   *    cancela o atual, reroda o routing (já considerando estoque virtual de outros
   *    pedidos ativos) e cria novo pick-order na loja correta.
   *  - Se algum pick-order já passou de "separating" → bloqueia com mensagem clara.
   */
  async function loadSeparation() {
    setSepLoading(true);
    setSepError(null);
    setConfirmResult(null);
    try {
      const hasActivePickOrder = liveStatus.some((p) =>
        ['new', 'separating'].includes(p.status),
      );
      if (hasActivePickOrder) {
        // RECALCULAR DE VERDADE
        if (!confirm(
          'Vai cancelar o pick-order atual e rerodar o roteamento. ' +
          'A loja antiga vai perder o card no app /minha-loja. Confirma?'
        )) {
          setSepLoading(false);
          return;
        }
        const res = await api<{
          ok: boolean;
          reason?: string;
          message?: string;
          cancelledCount?: number;
          strategy?: string;
          pickOrders?: Array<{ id: string; storeCode: string; storeName: string }>;
        }>(`/orders/wc/${wcId}/recalculate-separation`, { method: 'POST' });

        if (!res.ok) {
          setSepError(res.message ?? 'Não foi possível recalcular.');
          setSepLoading(false);
          return;
        }
        setFlash(
          `✓ Recalculado: ${res.cancelledCount ?? 0} pick-order(s) antigo(s) cancelado(s), ` +
          `${res.pickOrders?.length ?? 0} novo(s) criado(s) em ${res.pickOrders?.map((p) => p.storeCode).join(', ')}.`,
        );
        setTimeout(() => setFlash(null), 5000);
        // Recarrega painel ao vivo
        api<typeof liveStatus>(`/pick-orders/by-wc/${wcId}`)
          .then((data) => setLiveStatus(Array.isArray(data) ? data : []))
          .catch(() => {});
        return;
      }

      // PRIMEIRA VEZ: só preview pra mostrar grupos antes de confirmar
      const res = await api<SeparationPreview>(`/orders/wc/${wcId}/prepare-separation`);
      setSeparation(res);
      setOverrides({});
      setSplitApproved(false); // reset gate a cada novo preview
    } catch (e: any) {
      setSepError(e.message);
    } finally {
      setSepLoading(false);
    }
  }

  /**
   * Troca manual da loja de origem — usuário escolhe pular uma loja específica
   * (ex: "não quero MOEMA enviar, quero outra loja"). Chama o mesmo
   * recalculate-separation mas forçando `excludeStoreCodes: [storeCode]`.
   *
   * O routing engine re-escolhe entre as OUTRAS lojas que têm estoque. Se
   * nenhuma outra tiver, devolve sem-estoque-excluindo-loja e a matriz decide.
   *
   * Só habilita se o pick-order ainda está em new/separating (não pode trocar
   * depois que a loja já bipou — isso seria perda de trabalho).
   */
  async function swapStore(storeCode: string, storeName: string | null) {
    const displayName = storeName || storeCode;

    // Pega o pick-order ESPECÍFICO da loja sendo trocada
    const targetPickOrder = liveStatus.find((p) => p.storeCode === storeCode);
    if (!targetPickOrder) {
      alert(`Não encontrei pick-order pra loja ${storeCode}.`);
      return;
    }

    // Avisa se outras lojas do mesmo pedido já enviaram (pra contexto)
    const outrasJaEnviaram = liveStatus.filter(
      (p) => p.storeCode !== storeCode && !['new', 'separating'].includes(p.status),
    );
    const avisoOutras = outrasJaEnviaram.length
      ? `\n⚠️ Outras lojas (${outrasJaEnviaram.map((p) => p.storeCode).join(', ')}) já avançaram — elas NÃO vão ser tocadas, só esta troca aqui.\n`
      : '';

    // Aviso reforçado quando a LOJA ALVO já avançou (separado/enviado)
    const ADVANCED_REVERSIBLE = ['shipped', 'delivered'];
    const REQUIRES_REVERSE = ADVANCED_REVERSIBLE.includes(targetPickOrder.status);
    const ADVANCED_PAST_NEW = !['new', 'separating'].includes(targetPickOrder.status);

    let confirmMsg = '';
    if (REQUIRES_REVERSE) {
      confirmMsg =
        `🚨 ATENÇÃO: a loja ${displayName} (${storeCode}) JÁ ESTÁ COMO "${targetPickOrder.status}".\n\n` +
        `Se trocar, o sistema vai:\n` +
        `1. ESTORNAR o estoque Giga da ${storeCode} (devolver as peças pro estoque dela)\n` +
        `2. Cancelar o pick-order atual\n` +
        `3. Roteamento pra outra loja\n` +
        `4. ⚠️ Tracking/etiqueta correios já gerada NÃO é cancelada automaticamente — cancele manualmente nos Correios se necessário\n\n` +
        avisoOutras +
        `Confirma a troca?`;
    } else if (ADVANCED_PAST_NEW) {
      confirmMsg =
        `⚠️ A loja ${displayName} (${storeCode}) já está em "${targetPickOrder.status}" (separada mas não enviada).\n\n` +
        `Trocar vai cancelar o pick-order desta loja e re-rotear pra outra. ` +
        `O estoque Giga ainda NÃO foi baixado, então sem efeito ERP.\n` +
        avisoOutras +
        `Confirma?`;
    } else {
      confirmMsg =
        `Trocar SOMENTE a loja ${displayName} (${storeCode})?\n\n` +
        avisoOutras +
        `O sistema vai cancelar o pick-order desta loja e re-rotear OS ITEMS DELA pra outra loja com estoque.\n\n` +
        `Se nenhuma outra loja tiver estoque, os items ficam órfãos (você decide manualmente).`;
    }

    if (!confirm(confirmMsg)) return;

    setSepLoading(true);
    setSepError(null);
    try {
      const res = await api<{
        ok: boolean;
        reason?: string;
        message?: string;
        cancelledCount?: number;
        itemsReassigned?: number;
        oldStoreCode?: string;
        excludedStoreCodes?: string[];
        pickOrders?: Array<{ id: string; storeCode: string; storeName: string }>;
      }>(`/orders/wc/${wcId}/recalculate-separation`, {
        method: 'POST',
        body: JSON.stringify({
          excludeStoreCodes: [storeCode],
          pickOrderId: targetPickOrder.id,  // ← swap cirúrgico
        }),
      });

      if (!res.ok) {
        setSepError(res.message ?? 'Não foi possível trocar a loja.');
        setSepLoading(false);
        return;
      }
      const novaLoja = res.pickOrders?.map((p) => `${p.storeName} (${p.storeCode})`).join(', ');
      setFlash(
        `✓ Loja trocada. ${storeCode} saiu, nova(s) loja(s): ${novaLoja}.`,
      );
      setTimeout(() => setFlash(null), 6000);
      // Recarrega painel ao vivo
      api<typeof liveStatus>(`/pick-orders/by-wc/${wcId}`)
        .then((data) => setLiveStatus(Array.isArray(data) ? data : []))
        .catch(() => {});
    } catch (e: any) {
      setSepError(e.message);
    } finally {
      setSepLoading(false);
    }
  }

  /**
   * Abre o modal "Escolher loja manualmente" — retaguarda decide especificamente
   * pra qual loja mandar o pedido (bypassa a ordenação automática do routing).
   *
   * Fluxo:
   *  1. Puxa /stores pra ter a lista completa de lojas ativas
   *  2. Puxa /orders/wc/:id/prepare-separation pra ter alternativesBySku
   *     (qualquer estado do pedido — se tem issue, o recalculate com exclude
   *      já é outro caminho; esse modal é pra forçar uma loja específica mesmo
   *      com tudo rodando normal).
   *  3. Constrói tabela de cobertura por loja e ordena por skusCovered DESC
   *  4. Exibe lojas que reportaram problema com marcador vermelho (pra evitar
   *     escolher de volta a mesma que falhou)
   */
  async function openPickStoreModal() {
    setPickStoreOpen(true);
    setPickStoreLoading(true);
    setPickStoreError(null);
    setPickStoreCandidates([]);
    try {
      const [stores, preview] = await Promise.all([
        api<Array<{ id: string; code: string; name: string; city: string | null; state: string | null; active: boolean }>>('/stores'),
        api<SeparationPreview>(`/orders/wc/${wcId}/prepare-separation`),
      ]);

      const activeStores = stores.filter((s) => s.active);
      setAllStoreCodes(activeStores.map((s) => s.code));

      // Lojas que reportaram problema nesse pedido (pra marcar no modal)
      const issueCodes = new Set(
        liveStatus.filter((p) => p.issueReason && p.storeCode).map((p) => p.storeCode as string),
      );

      // Set de SKUs do pedido (inferido do groups + missing + alternativesBySku)
      const allSkus = new Set<string>();
      preview.groups.forEach((g) => g.items.forEach((it) => allSkus.add(it.sku)));
      preview.missing.forEach((m) => allSkus.add(m.sku));
      Object.keys(preview.alternativesBySku ?? {}).forEach((sku) => allSkus.add(sku));

      // Quantidades pedidas (pra comparar com availableQty)
      const qtyBySku = new Map<string, number>();
      preview.groups.forEach((g) => g.items.forEach((it) => {
        qtyBySku.set(it.sku, (qtyBySku.get(it.sku) ?? 0) + it.quantity);
      }));
      preview.missing.forEach((m) => {
        qtyBySku.set(m.sku, (qtyBySku.get(m.sku) ?? 0) + m.quantity);
      });

      // Monta mapa storeCode → { skusCovered, totalQty, missingSkus }
      const byStore = new Map<string, { skusCovered: number; totalQty: number; missing: string[] }>();
      for (const code of activeStores.map((s) => s.code)) {
        byStore.set(code, { skusCovered: 0, totalQty: 0, missing: [] });
      }
      // Também considera loja que está num group (tem tudo daquele grupo)
      preview.groups.forEach((g) => {
        const rec = byStore.get(g.storeCode);
        if (!rec) return;
        g.items.forEach((it) => {
          rec.skusCovered += 1;
          rec.totalQty += it.quantity;
        });
      });
      // Adiciona o que aparece em alternativesBySku (qty disponível por loja/SKU)
      Object.entries(preview.alternativesBySku ?? {}).forEach(([sku, alts]) => {
        const need = qtyBySku.get(sku) ?? 1;
        alts.forEach((alt) => {
          const rec = byStore.get(alt.storeCode);
          if (!rec) return;
          if (alt.availableQty >= need) {
            // Evita dupla contagem se a loja já está como group assignee
            const alreadyInGroup = preview.groups.some(
              (g) => g.storeCode === alt.storeCode && g.items.some((it) => it.sku === sku),
            );
            if (!alreadyInGroup) {
              rec.skusCovered += 1;
              rec.totalQty += alt.availableQty;
            }
          }
        });
      });

      // Calcula missingSkus por loja
      const skusArr = Array.from(allSkus);
      for (const [code, rec] of byStore.entries()) {
        const covered = new Set<string>();
        preview.groups.filter((g) => g.storeCode === code).forEach((g) => g.items.forEach((it) => covered.add(it.sku)));
        Object.entries(preview.alternativesBySku ?? {}).forEach(([sku, alts]) => {
          const need = qtyBySku.get(sku) ?? 1;
          const alt = alts.find((a) => a.storeCode === code);
          if (alt && alt.availableQty >= need) covered.add(sku);
        });
        rec.missing = skusArr.filter((sku) => !covered.has(sku));
      }

      const candidates = activeStores
        .map((s) => {
          const rec = byStore.get(s.code) ?? { skusCovered: 0, totalQty: 0, missing: [] };
          return {
            id: s.id,
            code: s.code,
            name: s.name,
            city: s.city,
            state: s.state,
            active: s.active,
            skusCovered: rec.skusCovered,
            skusTotal: allSkus.size,
            totalQty: rec.totalQty,
            missingSkus: rec.missing,
            hasReportedIssue: issueCodes.has(s.code),
          };
        })
        .sort((a, b) => {
          if (b.skusCovered !== a.skusCovered) return b.skusCovered - a.skusCovered;
          return b.totalQty - a.totalQty;
        });

      setPickStoreCandidates(candidates);
    } catch (e: any) {
      setPickStoreError(e?.message || 'Falha ao carregar lojas candidatas.');
    } finally {
      setPickStoreLoading(false);
    }
  }

  /**
   * Aplica a escolha manual: recalcula excluindo TODAS as outras lojas ativas
   * exceto a escolhida. O routing engine é obrigado a rotear pra essa loja
   * (se ela tiver estoque suficiente). Se não tiver, retorna sem-estoque-
   * excluindo-loja e matriz decide.
   */
  async function applyPickStore(pickedCode: string, pickedName: string) {
    if (!confirm(
      `Forçar o pedido pra ${pickedName} (${pickedCode})?\n\n` +
      `O sistema vai excluir TODAS as outras lojas do roteamento. Se ` +
      `${pickedCode} não tiver estoque suficiente do que falta, o pedido ` +
      `fica pending.`,
    )) return;

    setPickStoreApplying(pickedCode);
    setPickStoreError(null);
    try {
      const excludeCodes = allStoreCodes.filter((c) => c !== pickedCode);
      const res = await api<{
        ok: boolean;
        reason?: string;
        message?: string;
        pickOrders?: Array<{ id: string; storeCode: string; storeName: string }>;
      }>(`/orders/wc/${wcId}/recalculate-separation`, {
        method: 'POST',
        body: JSON.stringify({ excludeStoreCodes: excludeCodes }),
      });

      if (!res.ok) {
        setPickStoreError(
          res.message || `Não deu pra forçar ${pickedCode}. Provavelmente não tem estoque suficiente.`,
        );
        return;
      }

      setPickStoreOpen(false);
      setFlash(`✓ Pedido reatribuído pra ${pickedName} (${pickedCode}).`);
      setTimeout(() => setFlash(null), 5000);

      api<typeof liveStatus>(`/pick-orders/by-wc/${wcId}`)
        .then((data) => setLiveStatus(Array.isArray(data) ? data : []))
        .catch(() => {});
    } catch (e: any) {
      setPickStoreError(e?.message || 'Falha na chamada de recalcular.');
    } finally {
      setPickStoreApplying(null);
    }
  }

  /**
   * CONFIRMA a separação no sistema: cria pick-order e dispara o socket
   * pra loja receber em tempo real no app /minha-loja.
   * Diferente do "Enviar WhatsApp" — esse aqui é o que faz o card aparecer
   * no PC da loja com toast/notification.
   */
  async function confirmSeparation() {
    if (!confirm(
      'Vai criar a ordem de separação e mandar pro app das lojas envolvidas. Confirma?'
    )) return;
    setConfirmLoading(true);
    setConfirmResult(null);
    setSepError(null);
    try {
      const res = await api<{
        ok: boolean;
        pickOrders?: Array<{ id: string; status: string; storeCode: string; storeName: string }>;
        reason?: string;
        message?: string;
      }>(`/orders/wc/${wcId}/confirm-separation`, { method: 'POST' });
      setConfirmResult(res);
      if (res.ok) {
        setFlash(
          `✓ Pedido enviado pra ${res.pickOrders?.length ?? 0} loja(s). ` +
          `Já apareceu no app /minha-loja delas.`,
        );
        // Recarrega painel de status ao vivo pra ter os novos pick-orders
        api<typeof liveStatus>(`/pick-orders/by-wc/${wcId}`)
          .then((data) => setLiveStatus(Array.isArray(data) ? data : []))
          .catch(() => {});
        // Atualiza status no WC pra "separacao" também (best-effort)
        if (order && order.status !== 'separacao') {
          try {
            await api(`/orders/wc/${wcId}`, {
              method: 'PATCH',
              body: JSON.stringify({
                status: 'separacao',
                addNote: {
                  text: `Separação confirmada via LURDS ORDER ONE. Distribuído pra: ${res.pickOrders?.map((p) => p.storeName).join(', ')}.`,
                  notifyCustomer: false,
                },
              }),
            });
            await load();
          } catch (e: any) {
            console.warn('Falha ao mudar status pra separacao no WC:', e.message);
          }
        }
      }
      setTimeout(() => setFlash(null), 5000);
    } catch (e: any) {
      setSepError(`Erro ao confirmar: ${e.message}`);
    } finally {
      setConfirmLoading(false);
    }
  }

  /** Abre wa.me em nova aba e marca o pedido como "Separação" no WC. */
  async function sendWhatsapp(group: SeparationGroup) {
    const url = group.whatsappUrl;
    if (!url) {
      alert(
        `A loja "${group.storeName}" não tem WhatsApp cadastrado. Vai em /lojas, edita a loja e salva o número.`,
      );
      return;
    }
    // Nome fixo 'flowops-whatsapp' → cliques seguintes reusam a MESMA aba,
    // não pedem login de novo no WhatsApp Web. Evita abrir 10 abas diferentes.
    window.open(url, 'flowops-whatsapp', 'noopener,noreferrer');

    // Troca status pra "separacao" automaticamente (se ainda não estiver)
    if (order && order.status !== 'separacao') {
      try {
        await api(`/orders/wc/${wcId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            status: 'separacao',
            addNote: {
              text: `Separação enviada por WhatsApp pra loja ${group.storeName} (${group.storeCode}).`,
              notifyCustomer: false,
            },
          }),
        });
        await load();
      } catch (e: any) {
        console.warn('Falha ao atualizar status pra separacao:', e.message);
      }
    }
  }

  /**
   * Dispara impressão remota na térmica da loja.
   * Backend valida presença → emite socket → Electron da loja imprime silencioso.
   * Se loja offline, retorna erro claro.
   */
  async function sendPrintRemote(pickOrderId: string, storeName: string) {
    setPrintState((s) => ({ ...s, [pickOrderId]: 'sending' }));
    setPrintError((s) => ({ ...s, [pickOrderId]: '' }));
    try {
      const res = await api<{
        ok: boolean;
        sent: boolean;
        storeId: string;
        storeName: string | null;
        reason?: string;
      }>(`/pick-orders/${pickOrderId}/print`, { method: 'POST' });
      if (res.sent) {
        setPrintState((s) => ({ ...s, [pickOrderId]: 'sent' }));
        setFlash(`🖨️ Impressão disparada pra ${res.storeName || storeName}`);
        setTimeout(() => setFlash(null), 4000);
      } else {
        setPrintState((s) => ({ ...s, [pickOrderId]: 'error' }));
        setPrintError((s) => ({ ...s, [pickOrderId]: res.reason || 'Falha desconhecida' }));
      }
    } catch (e: any) {
      setPrintState((s) => ({ ...s, [pickOrderId]: 'error' }));
      setPrintError((s) => ({ ...s, [pickOrderId]: e.message || 'Erro de rede' }));
    }
  }

  function fmtMoney(v: string | number | undefined) {
    const n = Number(v ?? 0);
    return `R$ ${n.toFixed(2).replace('.', ',')}`;
  }
  function fmtDate(iso: string) {
    if (!iso) return '—';
    const d = new Date(iso.endsWith('Z') ? iso : iso + 'Z');
    return d.toLocaleString('pt-BR');
  }

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto p-6">
        <div className="flex items-center gap-2 text-slate-500">
          <Loader2 className="w-5 h-5 animate-spin" /> Carregando pedido...
        </div>
      </div>
    );
  }

  if (error && !order) {
    return (
      <div className="max-w-5xl mx-auto p-6">
        <Link href="/pedidos" className="text-brand text-sm hover:underline flex items-center gap-1">
          <ArrowLeft className="w-4 h-4" /> Voltar
        </Link>
        <div className="bg-red-50 text-red-700 p-4 rounded mt-4">{error}</div>
      </div>
    );
  }

  if (!order) return null;

  const statusChanged = status !== order.status;
  const trackingChanged =
    trackingNumber !== (order.tracking.number || '') ||
    trackingCarrier !== (order.tracking.carrier || '') ||
    trackingUrl !== (order.tracking.url || '');
  const hasChanges = statusChanged || trackingChanged || note.trim().length > 0;

  return (
    <div className="max-w-5xl mx-auto p-6">
      <div className="flex items-center justify-between mb-4">
        <Link href="/pedidos" className="text-brand text-sm hover:underline flex items-center gap-1">
          <ArrowLeft className="w-4 h-4" /> Voltar pra lista
        </Link>
        <a
          href={`${WC_ADMIN_URL}${order.id}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-slate-500 hover:text-brand flex items-center gap-1"
        >
          Abrir no WordPress <ExternalLink className="w-3 h-3" />
        </a>
      </div>

      <div className="flex items-center justify-between mb-6">
        <div>
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-bold">Pedido #{order.number}</h1>
            {(() => {
              // Badge de forma de envio em destaque — ao lado do número do pedido.
              // Fonte: shipping_lines do WC (via order.pickup.shippingMethodTitle) ou
              // fallback pra separation.shippingMethod quando o pickup não foi detectado.
              const raw =
                order.pickup?.shippingMethodTitle ?? separation?.shippingMethod ?? null;
              if (!raw) return null;
              const m = classifyShipping(raw);
              return (
                <span
                  className={`px-3 py-1 text-sm font-bold rounded shadow-sm ${m.colorBold}`}
                  title={m.raw}
                >
                  {m.label}
                </span>
              );
            })()}
            {/* Tag de vendedora — atribuir Karine/Manu/etc pra relatório mensal */}
            <SellerTag
              wcOrderId={order.id}
              currentSellerId={order.sellerId ?? null}
              currentSellerName={order.sellerName ?? null}
              onChange={(sellerId, sellerName) => {
                setOrder((prev) => (prev ? { ...prev, sellerId, sellerName } : prev));
              }}
            />
          </div>
          <p className="text-sm text-slate-500 mt-1">
            Criado em {fmtDate(order.dateCreatedGmt)}
            {order.dateModifiedGmt && order.dateModifiedGmt !== order.dateCreatedGmt &&
              <> · modificado em {fmtDate(order.dateModifiedGmt)}</>
            }
          </p>
        </div>
        <div className="text-right">
          <div className="text-3xl font-bold text-brand">{fmtMoney(order.total)}</div>
          <div className="text-xs text-slate-500">{order.paymentMethodTitle}</div>
        </div>
      </div>

      {flash && (
        <div className="bg-green-50 text-green-800 border border-green-200 p-3 rounded mb-4 text-sm flex items-center gap-2">
          <Check className="w-4 h-4" /> {flash}
        </div>
      )}
      {error && <div className="bg-red-50 text-red-700 p-3 rounded mb-4 text-sm whitespace-pre-line">{error}</div>}

      {/* BANNER DE FORMA DE ENVIO — grande, cor sólida, sempre no topo.
           A retaguarda precisa bater o olho e já saber SEDEX/PAC/RETIRADA
           antes de decidir como separar. Fallback: se for pickup, o banner
           azul/âmbar específico abaixo já cobre o caso (mais informativo),
           então aqui renderiza só pra não-pickup. */}
      {(() => {
        const raw =
          order.pickup?.shippingMethodTitle ?? separation?.shippingMethod ?? null;
        if (!raw) return null;
        const m = classifyShipping(raw);
        if (m.kind === 'pickup') return null; // já tem banner próprio abaixo
        const icon =
          m.kind === 'sedex' ? '⚡' :
          m.kind === 'pac' ? '📦' :
          m.kind === 'transportadora' ? '🚚' : '📨';
        return (
          <div className={`mb-4 rounded-lg p-4 shadow-sm ${m.colorBold} flex items-center gap-3`}>
            <div className="text-3xl">{icon}</div>
            <div className="flex-1 min-w-0">
              <div className="text-xs uppercase tracking-widest opacity-80">Forma de envio</div>
              <div className="text-2xl font-black leading-tight">{m.label}</div>
              {m.raw && m.raw.toUpperCase() !== m.label && (
                <div className="text-xs opacity-90 mt-0.5 truncate">{m.raw}</div>
              )}
            </div>
          </div>
        );
      })()}

      {/* Banner de RETIRADA EM LOJA — aparece só quando o método de envio é pickup */}
      {order.pickup?.isPickup && (
        <div
          className={`mb-4 rounded-lg border-2 p-4 ${
            order.pickup.storeCode
              ? 'border-blue-300 bg-blue-50'
              : 'border-amber-300 bg-amber-50'
          }`}
        >
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <div className="font-bold text-base flex items-center gap-2 text-slate-800">
                🚶 RETIRADA EM LOJA
                {order.pickup.storeName && (
                  <span className="text-blue-700">— {order.pickup.storeName}</span>
                )}
              </div>
              <div className="text-xs text-slate-600 mt-1">
                Método: {order.pickup.shippingMethodTitle}
              </div>
              {!order.pickup.storeCode && (
                <div className="text-xs text-amber-800 mt-2 font-medium">
                  ⚠ Pickup detectado mas loja não mapeada
                  {order.pickup.unresolvedCityName && (
                    <> (cidade detectada: <b>{order.pickup.unresolvedCityName}</b>)</>
                  )}
                  . Cadastre a loja em <Link href="/lojas" className="underline">/lojas</Link>.
                </div>
              )}
            </div>
            {order.pickup.storeCode && (
              <span className="px-2 py-1 bg-blue-200 text-blue-900 rounded text-xs font-mono">
                {order.pickup.storeCode}
              </span>
            )}
          </div>
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-4 mb-4">
        {/* Dados do cliente */}
        <div className="bg-white rounded shadow p-4">
          <h3 className="font-semibold mb-3 text-sm text-slate-600 uppercase tracking-wide">Cliente</h3>
          <div className="text-sm space-y-1">
            <div className="font-medium">
              {order.billing.first_name} {order.billing.last_name}
            </div>
            {order.customerCpf && (
              <div className="text-slate-700 flex items-center gap-2">
                <span className="text-xs text-slate-500">🪪 CPF</span>
                <span className="font-mono">{order.customerCpf}</span>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(order.customerCpf ?? '');
                    setFlash('CPF copiado.');
                    setTimeout(() => setFlash(null), 1500);
                  }}
                  className="text-xs text-brand hover:underline"
                  title="Copiar CPF"
                >
                  copiar
                </button>
              </div>
            )}
            {order.billing.email && (
              <div className="text-slate-600 flex items-center gap-2">
                <span className="text-xs text-slate-500">✉️</span>
                <span>{order.billing.email}</span>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(order.billing.email);
                    setFlash('Email copiado.');
                    setTimeout(() => setFlash(null), 1500);
                  }}
                  className="text-xs text-brand hover:underline"
                  title="Copiar email"
                >
                  copiar
                </button>
              </div>
            )}
            {order.billing.phone && (
              <div className="text-slate-600 flex items-center gap-2">
                <span className="text-xs text-slate-500">📱</span>
                <span>{order.billing.phone}</span>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(order.billing.phone);
                    setFlash('Telefone copiado.');
                    setTimeout(() => setFlash(null), 1500);
                  }}
                  className="text-xs text-brand hover:underline"
                  title="Copiar telefone"
                >
                  copiar
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Entrega */}
        <div className="bg-white rounded shadow p-4">
          <h3 className="font-semibold mb-3 text-sm text-slate-600 uppercase tracking-wide">Entrega</h3>
          <div className="text-sm space-y-0.5 text-slate-700">
            <div>{order.shipping.first_name} {order.shipping.last_name}</div>
            <div>{order.shipping.address_1} {order.shipping.number ? `, ${order.shipping.number}` : ''}</div>
            {order.shipping.address_2 && <div>{order.shipping.address_2}</div>}
            <div>{order.shipping.city} / {order.shipping.state} · CEP {order.shipping.postcode}</div>
            {order.shippingLines[0] && (
              <div className="text-xs text-slate-500 mt-2">
                Método: {order.shippingLines[0].method} ({fmtMoney(order.shippingLines[0].total)})
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Itens */}
      <div className="bg-white rounded shadow mb-4 overflow-hidden">
        <h3 className="font-semibold p-4 text-sm text-slate-600 uppercase tracking-wide border-b flex items-center gap-2">
          <Package className="w-4 h-4" /> Itens ({order.lineItems.length})
        </h3>
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="text-left p-3">Produto</th>
              <th className="text-left p-3">SKU</th>
              <th className="text-right p-3">Qtd</th>
              <th className="text-right p-3">Preço</th>
              <th className="text-right p-3">Total</th>
            </tr>
          </thead>
          <tbody>
            {order.lineItems.map((li) => (
              <tr key={li.id} className="border-t">
                <td className="p-3">{li.name}</td>
                <td className="p-3 font-mono text-xs text-slate-600">{li.sku || '—'}</td>
                <td className="p-3 text-right">{li.quantity}</td>
                <td className="p-3 text-right">{fmtMoney(li.price)}</td>
                <td className="p-3 text-right font-medium">{fmtMoney(li.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* SEPARAÇÃO — rotear pra loja + WhatsApp */}
      <div className="bg-white rounded shadow p-5 mb-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-sm text-slate-600 uppercase tracking-wide flex items-center gap-2">
            <StoreIcon className="w-4 h-4" /> Separação
          </h3>
          <button
            onClick={loadSeparation}
            disabled={sepLoading}
            className="px-4 py-2 bg-emerald-600 text-white rounded hover:bg-emerald-700 text-sm disabled:opacity-50 flex items-center gap-2"
          >
            {sepLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            {separation ? 'Recalcular separação' : liveStatus.length > 0 ? 'Recalcular separação' : 'Gerar separação'}
          </button>
        </div>

        {/* Header de resumo — aparece SEMPRE que já houver pick-order criado, mesmo
             que o user não tenha clicado em "Gerar separação" nessa aba (ex: chegou
             via bulk WhatsApp). Mostra em qual loja o pedido ficou alocado. */}
        {liveStatus.length > 0 && !separation && (
          <div className="bg-emerald-50 border border-emerald-200 rounded p-3 mb-3 text-sm">
            <div className="flex items-start gap-2">
              <Check className="w-4 h-4 text-emerald-700 flex-shrink-0 mt-0.5" />
              <div>
                <div className="font-semibold text-emerald-900">
                  Separação já criada — {liveStatus.length} loja{liveStatus.length === 1 ? '' : 's'} responsável{liveStatus.length === 1 ? '' : 'is'}
                </div>
                <div className="text-emerald-800 text-xs mt-0.5">
                  {liveStatus.map((r) => `${r.storeName} (${r.storeCode})`).join(' · ')}
                </div>
                <div className="text-emerald-700 text-xs mt-1">
                  Veja status em tempo real abaixo. Clica em <b>Recalcular separação</b> só se quiser reatribuir (ex: loja original sem estoque).
                </div>
              </div>
            </div>
          </div>
        )}

        {sepError && (
          <div className="bg-red-50 text-red-700 p-3 rounded text-sm mb-3">{sepError}</div>
        )}

        {/* Painel Status AO VIVO — SEMPRE visível quando existem pick-orders, indepen-
             dente de o user ter gerado preview na aba atual. Atualiza em tempo real
             via socket 'pick-order:status'. Fonte de verdade única: matriz sempre sabe
             em qual loja o pedido caiu. */}
        {/* Alerta de issue no topo — vermelho forte quando alguma loja reportou problema */}
        {liveStatus.some((r) => r.issueReason) && (
          <div className="bg-red-50 border-2 border-red-400 rounded-lg p-3 mb-3">
            <div className="flex items-start gap-2">
              <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
              <div className="flex-1 text-sm">
                <div className="font-bold text-red-900">
                  Loja reportou problema neste pedido
                </div>
                {liveStatus
                  .filter((r) => r.issueReason)
                  .map((r) => (
                    <div key={r.id} className="mt-1 text-red-800">
                      <b>{r.storeName} ({r.storeCode})</b>: {r.issueReasonLabel ?? r.issueReason}
                      {r.issueNote && (
                        <span className="text-red-700 italic"> — "{r.issueNote}"</span>
                      )}
                    </div>
                  ))}
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    onClick={loadSeparation}
                    disabled={sepLoading}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-semibold bg-white border border-red-400 text-red-800 hover:bg-red-50 disabled:opacity-60"
                    title="Deixa o sistema escolher automaticamente (exclui a loja que reportou)"
                  >
                    🔁 Recalcular automático
                  </button>
                  <button
                    onClick={openPickStoreModal}
                    disabled={sepLoading}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-semibold bg-red-600 text-white hover:bg-red-700 disabled:opacity-60"
                    title="Abre lista de lojas candidatas pra você escolher manualmente"
                  >
                    🎯 Escolher outra loja manualmente
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {liveStatus.length > 0 && (
          <div className="bg-slate-50 border border-slate-200 rounded p-3 mb-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-800 mb-2">
              <Zap className="w-4 h-4 text-emerald-500" />
              Status ao vivo das lojas
              <span className="text-xs text-slate-500 font-normal ml-auto">
                atualiza automático
              </span>
            </div>
            {/* Dica: troca manual de loja (só faz sentido enquanto alguma ainda
                está em new/separating — depois que bipou não dá mais) */}
            {liveStatus.some((p) => ['new', 'separating'].includes(p.status)) && (
              <div className="mb-2 text-xs bg-amber-50 border border-amber-200 text-amber-900 rounded px-2 py-1.5 flex items-start gap-1.5 flex-wrap">
                <span className="text-amber-700">💡</span>
                <span className="flex-1 min-w-[180px]">
                  Quer trocar a loja que vai enviar/transferir? Use <b>↔ Trocar loja</b> no
                  card (automático) ou <b>escolha manualmente</b> da lista de lojas.
                </span>
                <button
                  onClick={openPickStoreModal}
                  disabled={sepLoading}
                  className="text-xs px-2 py-1 bg-white border border-amber-400 text-amber-900 rounded hover:bg-amber-100 font-semibold disabled:opacity-60"
                >
                  🎯 Escolher loja manualmente
                </button>
              </div>
            )}
            <div className="space-y-2">
              {liveStatus.map((r) => {
                const flash = !!liveStatusFlash[r.id];
                const hasIssue = !!r.issueReason;
                const badgeColor = hasIssue
                  ? 'bg-red-600 text-white'
                  : r.status === 'shipped' ? 'bg-emerald-600 text-white'
                  : r.status === 'ready' ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                  : r.status === 'separating' ? 'bg-blue-100 text-blue-800 border border-blue-300'
                  : 'bg-amber-100 text-amber-900 border border-amber-300';
                const label = hasIssue
                  ? `⚠ ${r.issueReasonLabel ?? 'Problema reportado'}`
                  : r.status === 'shipped' ? 'Enviado'
                  : r.status === 'ready' ? 'Pronto pra envio'
                  : r.status === 'separating' ? 'Separando'
                  : 'Aguardando iniciar';
                const st = printState[r.id] ?? 'idle';
                const err = printError[r.id];
                return (
                  <div
                    key={r.id}
                    className={`bg-white rounded border p-2 text-sm transition-colors ${
                      flash ? 'border-emerald-400 bg-emerald-50' : 'border-slate-200'
                    }`}
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <StoreIcon className="w-4 h-4 text-slate-500" />
                      <span className="font-semibold">{r.storeName}</span>
                      <span className="text-xs text-slate-500">({r.storeCode})</span>
                      <span className={`text-xs px-2 py-0.5 rounded font-medium ${badgeColor}`}>
                        {label}
                      </span>
                      {flash && (
                        <span className="text-xs text-emerald-600 font-semibold animate-pulse">
                          ✓ atualizado agora
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => sendPrintRemote(r.id, r.storeName || '')}
                        disabled={st === 'sending'}
                        className={`ml-auto inline-flex items-center gap-1 px-2 py-1 rounded text-xs border ${
                          st === 'sent'
                            ? 'bg-emerald-600 text-white border-emerald-700'
                            : st === 'error'
                            ? 'bg-red-50 text-red-700 border-red-300 hover:bg-red-100'
                            : st === 'sending'
                            ? 'bg-gray-100 text-gray-500 border-gray-300 cursor-wait'
                            : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                        }`}
                        title="Imprimir na térmica da loja"
                      >
                        {st === 'sending' && '…'}
                        {st === 'sent' && '✓ Impresso'}
                        {st === 'error' && '⚠ Reimprimir'}
                        {st === 'idle' && '🖨️ Imprimir'}
                      </button>
                      {/* Trocar loja — SEMPRE visível pra retaguarda ter essa opção
                          na cara, mas desabilita (com tooltip) se já avançou de
                          "separating" pra "ready/shipped". Nesses estágios trocar
                          desperdiça trabalho da loja. */}
                      {r.storeCode && (() => {
                        const canSwap = ['new', 'separating'].includes(r.status);
                        const tooltip = canSwap
                          ? `Escolher outra loja no lugar de ${r.storeCode}. Só funciona se a loja ainda não bipou.`
                          : `Já passou de "separando" (status: ${r.status}). Não dá pra trocar sem perder trabalho da loja.`;
                        return (
                          <button
                            type="button"
                            onClick={() => swapStore(r.storeCode!, r.storeName)}
                            disabled={sepLoading || !canSwap}
                            className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs border transition ${
                              canSwap
                                ? 'bg-amber-50 text-amber-800 border-amber-300 hover:bg-amber-100 disabled:opacity-60'
                                : 'bg-slate-100 text-slate-400 border-slate-200 cursor-not-allowed'
                            }`}
                            title={tooltip}
                          >
                            ↔ Trocar loja
                          </button>
                        );
                      })()}
                    </div>
                    {r.status === 'shipped' && r.trackingCode && (
                      <div className="mt-1 pl-6 text-xs text-slate-700">
                        <Truck className="w-3 h-3 inline mr-1" />
                        <span className="font-mono font-semibold">{r.trackingCode}</span>
                        {r.carrier && <span className="text-slate-500 ml-2">via {r.carrier}</span>}
                      </div>
                    )}
                    {/* Baixa no Gigasistemas — garante ao usuário que o estoque físico
                        já foi debitado no ERP. O autoDebitOnShipped() roda quando
                        a loja marca 'shipped' com rastreio. Se falhou (missing),
                        redireciona pro log de baixas pra resolver manualmente. */}
                    {r.debitStatus === 'applied' && (
                      <div className="mt-1 pl-6 text-xs text-emerald-700 flex items-center gap-1">
                        <Check className="w-3 h-3" />
                        <span className="font-medium">Baixa aplicada no Gigasistemas</span>
                        {r.debitApprovedAt && (
                          <span className="text-emerald-600 ml-1">
                            ({new Date(r.debitApprovedAt).toLocaleString('pt-BR')})
                          </span>
                        )}
                      </div>
                    )}
                    {r.debitStatus === 'missing' && (
                      <div className="mt-1 pl-6 text-xs text-red-700 flex items-center gap-1.5">
                        <AlertCircle className="w-3 h-3" />
                        <span className="font-semibold">Baixa no Giga falhou</span>
                        <Link
                          href="/retaguarda/baixas-log"
                          className="underline hover:text-red-900 font-medium"
                        >
                          resolver em Log de Baixas →
                        </Link>
                      </div>
                    )}
                    {r.debitStatus === 'pending' && r.status !== 'new' && (
                      <div className="mt-1 pl-6 text-xs text-slate-500">
                        Baixa no Giga: aguardando envio
                      </div>
                    )}
                    {!!r.updatedAt && (
                      <div className="pl-6 text-xs text-slate-400 mt-0.5">
                        Última atualização: {new Date(r.updatedAt).toLocaleString('pt-BR')}
                      </div>
                    )}
                    {st === 'error' && err && (
                      <div className="mt-1 pl-6 text-xs text-red-700">{err}</div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {!separation && !sepLoading && !sepError && liveStatus.length === 0 && (
          <p className="text-sm text-slate-500">
            Clica em <b>Gerar separação</b> pra o sistema consultar o estoque de cada loja
            e sugerir quem vai separar o pedido.
          </p>
        )}

        {separation && (
          <>
            {/* Faixa-resumo */}
            <div
              className={`p-3 rounded text-sm mb-4 ${
                separation.success
                  ? separation.strategy === 'single-store' || separation.strategy === 'pickup-lock'
                    ? 'bg-emerald-50 text-emerald-800'
                    : 'bg-amber-50 text-amber-800'
                  : 'bg-red-50 text-red-800'
              }`}
            >
              {separation.success && separation.strategy === 'single-store' && (
                <>✓ <b>1 loja atende o pedido inteiro</b> — {separation.groups[0]?.storeName}</>
              )}
              {separation.success && separation.strategy === 'multi-store' && (
                <>⚠ Nenhuma loja tem tudo. Pedido vai ser <b>dividido em {separation.groups.length} lojas</b>.</>
              )}
              {separation.success && separation.strategy === 'pickup-lock' && (
                <>
                  🚶 <b>RETIRADA EM LOJA</b> — {separation.pickupStoreName} tem todas as peças.
                  Cliente vai buscar direto lá.
                </>
              )}
              {separation.success && separation.strategy === 'pickup-transfer' && (
                <>
                  🚚 <b>RETIRADA EM LOJA com TRANSFERÊNCIA</b> — {separation.pickupStoreName} não tem TUDO em estoque (sistema já priorizou a própria loja de retirada).
                  {' '}
                  {separation.groups.filter((g) => g.isTransfer).length} loja(s) vão <b>transferir</b> pra {separation.pickupStoreName}.
                  <div className="text-xs mt-1 opacity-80">
                    Pra trocar qual loja transfere: clica em <b>↔ Trocar loja</b> no card laranja abaixo.
                  </div>
                </>
              )}
              {!separation.success && separation.strategy === 'pickup-blocked' && (
                <>
                  <AlertTriangle className="inline w-4 h-4 mr-1" />
                  <b>Retirada bloqueada:</b> faltam {separation.missing.length} SKU(s) sem estoque em nenhuma loja (nem na de retirada, nem nas que poderiam transferir).
                </>
              )}
              {!separation.success && separation.strategy !== 'pickup-blocked' && (
                <>
                  <AlertTriangle className="inline w-4 h-4 mr-1" />
                  <b>Ruptura:</b> {separation.missing.length} SKU(s) sem estoque em nenhuma loja ativa.
                </>
              )}
              <div className="text-xs mt-1 opacity-80">Envio: {separation.shippingMethod}</div>
            </div>

            {/* GATE DE QUEBRA — avisa retaguarda antes de emitir separação em N lojas.
                 Multi-store = pedido dividido entre lojas diferentes (quebra). Quem
                 opera precisa bater o olho nos grupos antes de disparar ordem pra
                 cada uma porque qualquer ruptura depois vira retrabalho multi-loja. */}
            {separation.success && separation.strategy === 'multi-store' && !splitApproved && (
              <div className="bg-orange-50 border-2 border-orange-400 rounded-lg p-4 mb-4">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="w-6 h-6 text-orange-600 flex-shrink-0" />
                  <div className="flex-1 text-sm">
                    <div className="font-bold text-orange-900 text-base">
                      ⚠ Atenção: pedido vai ser dividido em {separation.groups.length} lojas
                    </div>
                    <div className="text-orange-800 mt-1">
                      Nenhuma loja sozinha tem todas as peças. O sistema sugere separar em:
                      <ul className="mt-1 ml-5 list-disc">
                        {separation.groups.map((g) => (
                          <li key={g.storeCode}>
                            <b>{g.storeName}</b> ({g.storeCode}): {g.items.reduce((s, it) => s + it.quantity, 0)} peça(s)
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div className="text-orange-700 text-xs mt-2">
                      Antes de confirmar: <b>revise os grupos abaixo</b>, e use <b>↔ Trocar loja</b> ou
                      <b> Escolher loja manualmente</b> se quiser consolidar numa única loja.
                    </div>
                    <label className="mt-3 flex items-center gap-2 cursor-pointer select-none text-sm font-semibold text-orange-900 bg-white border border-orange-300 rounded px-3 py-2 hover:bg-orange-50 transition w-fit">
                      <input
                        type="checkbox"
                        checked={splitApproved}
                        onChange={(e) => setSplitApproved(e.target.checked)}
                        className="w-4 h-4"
                      />
                      Estou ciente da divisão — liberar confirmação
                    </label>
                  </div>
                </div>
              </div>
            )}

            {/* BOTÃO PRINCIPAL — Confirma e dispara socket pras lojas */}
            {separation.success && (() => {
              const isSplit = separation.strategy === 'multi-store';
              const gatedBySplit = isSplit && !splitApproved;
              return (
                <div className="bg-gradient-to-r from-brand to-brand-dark rounded-lg p-4 mb-4 flex items-center justify-between flex-wrap gap-3">
                  <div className="text-white">
                    <div className="font-bold text-base flex items-center gap-2">
                      <Zap className="w-5 h-5" />
                      Confirmar separação
                    </div>
                    <div className="text-xs opacity-90 mt-0.5">
                      Cria a ordem no sistema e <b>dispara alerta no PC</b> da{separation.groups.length > 1 ? 's lojas' : ' loja'}{' '}
                      {separation.groups.map((g) => g.storeName).join(', ')}.
                    </div>
                    {gatedBySplit && (
                      <div className="text-xs mt-1 bg-orange-400/30 border border-orange-200 px-2 py-1 rounded inline-block">
                        ⚠ Marque "ciente da divisão" acima pra liberar
                      </div>
                    )}
                  </div>
                  <button
                    onClick={confirmSeparation}
                    disabled={confirmLoading || (confirmResult?.ok === true) || gatedBySplit}
                    className="px-5 py-3 bg-white text-brand rounded font-semibold hover:bg-slate-100 disabled:opacity-60 disabled:cursor-not-allowed flex items-center gap-2 shadow"
                    title={gatedBySplit ? 'Marque "ciente da divisão" no aviso laranja acima' : undefined}
                  >
                    {confirmLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                    {confirmResult?.ok ? 'Já confirmado ✓' : confirmLoading ? 'Confirmando...' : 'Confirmar e enviar pras lojas'}
                  </button>
                </div>
              );
            })()}

            {/* Resultado da confirmação */}
            {confirmResult?.ok && confirmResult.pickOrders && (
              <div className="bg-emerald-50 border border-emerald-200 rounded p-3 mb-4 text-sm">
                <div className="font-semibold text-emerald-800 flex items-center gap-2">
                  <Check className="w-4 h-4" /> Distribuído pra {confirmResult.pickOrders.length} loja(s):
                </div>
                <ul className="mt-2 ml-6 list-disc text-emerald-700">
                  {confirmResult.pickOrders.map((p) => {
                    const st = printState[p.id] ?? 'idle';
                    const err = printError[p.id];
                    return (
                      <li key={p.id} className="mb-2">
                        <div>
                          <b>{p.storeName}</b> ({p.storeCode}) — pick-order <span className="font-mono text-xs">{p.id.slice(0, 8)}</span>
                        </div>
                        <div className="mt-1 ml-0">
                          <button
                            type="button"
                            onClick={() => sendPrintRemote(p.id, p.storeName)}
                            disabled={st === 'sending'}
                            className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs border ${
                              st === 'sent'
                                ? 'bg-emerald-600 text-white border-emerald-700'
                                : st === 'error'
                                ? 'bg-red-50 text-red-700 border-red-300 hover:bg-red-100'
                                : st === 'sending'
                                ? 'bg-gray-100 text-gray-500 border-gray-300 cursor-wait'
                                : 'bg-white text-emerald-800 border-emerald-400 hover:bg-emerald-100'
                            }`}
                          >
                            {st === 'sending' && 'Enviando...'}
                            {st === 'sent' && '✓ Enviado pra impressora'}
                            {st === 'error' && '⚠️ Erro — tentar novamente'}
                            {st === 'idle' && '🖨️ Imprimir na loja (80mm)'}
                          </button>
                          {st === 'error' && err && (
                            <div className="mt-1 text-xs text-red-700">{err}</div>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
                <div className="mt-3 pt-2 border-t border-emerald-200">
                  <a
                    href={`/admin/routing-debug/${wcId}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-emerald-800 underline hover:text-emerald-900"
                  >
                    🔍 Diagnosticar routing (ERP vs decisão salva)
                  </a>
                </div>
              </div>
            )}
            {confirmResult && !confirmResult.ok && (
              <div className="bg-red-50 border border-red-200 rounded p-3 mb-4 text-sm text-red-700">
                <b>Não foi possível confirmar:</b> {confirmResult.message}
              </div>
            )}

            {/* Missing (ruptura) — com botão Diagnosticar pra investigar
                quando o SKU "tem estoque" mas o sistema fala ruptura (committed). */}
            {separation.missing.length > 0 && (
              <div className="bg-red-50 border border-red-200 rounded p-3 mb-4">
                <div className="text-sm font-medium text-red-800 mb-2">Sem estoque em nenhuma loja:</div>
                <ul className="text-sm text-red-700 space-y-1.5">
                  {separation.missing.map((m) => (
                    <li key={m.sku} className="flex items-center gap-2 flex-wrap">
                      <span>
                        • {m.quantity}× {m.productName} <span className="font-mono text-xs">(SKU {m.sku})</span>
                      </span>
                      <button
                        type="button"
                        onClick={() => setDiagnoseSku(m.sku)}
                        className="ml-auto px-2 py-1 bg-white border border-red-300 hover:bg-red-100 text-red-700 rounded text-[11px] font-bold flex items-center gap-1 transition"
                        title="Ver onde está o estoque e quem reservou"
                      >
                        <Search className="w-3 h-3" />
                        Diagnosticar
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Grupos: uma loja por bloco */}
            <div className="space-y-3">
              {separation.groups.map((g, idx) => (
                <div
                  key={g.storeId + idx}
                  className={`border rounded overflow-hidden ${
                    g.isTransfer ? 'border-orange-300 ring-1 ring-orange-200' : ''
                  }`}
                >
                  <div className={`px-4 py-3 flex items-center justify-between ${
                    g.isTransfer ? 'bg-orange-50' : 'bg-slate-50'
                  }`}>
                    <div>
                      <div className="font-semibold text-slate-800 flex items-center gap-2 flex-wrap">
                        {g.storeName} <span className="text-xs font-mono text-slate-500">({g.storeCode})</span>
                        {g.isTransfer && g.transferToStoreName && (
                          <span className="px-2 py-0.5 bg-orange-200 text-orange-900 rounded text-xs font-semibold">
                            🚚 TRANSFERIR PRA {g.transferToStoreName}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-slate-500">
                        {[g.storeCity, g.storeState].filter(Boolean).join(' / ') || '—'}
                        {g.whatsapp ? ` · 📱 ${g.whatsapp}` : ' · sem WhatsApp cadastrado'}
                      </div>
                      {g.isTransfer && (
                        <div className="text-xs text-orange-800 mt-1 font-medium">
                          ⚠ Separar e enviar pra loja {g.transferToStoreName} — cliente vai retirar lá.
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-2 flex-wrap justify-end">
                      {/* Botão trocar loja: só faz sentido pra loja FONTE de transferência.
                          Na pickup-lock, trocar não adianta (loja destino é fixa).
                          Na multi-store/single-store, também oferecemos porque pode ser
                          ruptura local, divergência, etc. */}
                      {g.isTransfer && g.storeCode && (
                        <button
                          onClick={() => swapStore(g.storeCode!, g.storeName)}
                          disabled={sepLoading}
                          className="inline-flex items-center gap-1 px-3 py-2 rounded text-sm border bg-amber-50 text-amber-800 border-amber-300 hover:bg-amber-100 disabled:opacity-60"
                          title={`Escolher outra loja no lugar de ${g.storeCode}. O sistema re-roteia excluindo esta.`}
                        >
                          ↔ Trocar loja
                        </button>
                      )}
                      <button
                        onClick={() => sendWhatsapp(g)}
                        disabled={!g.whatsapp}
                        className="px-3 py-2 bg-green-600 text-white rounded hover:bg-green-700 text-sm disabled:opacity-40 flex items-center gap-2"
                        title={g.whatsapp ? 'Abrir WhatsApp com mensagem pronta' : 'Cadastra o WhatsApp em /lojas'}
                      >
                        <Send className="w-4 h-4" /> Enviar WhatsApp
                      </button>
                    </div>
                  </div>

                  <div className="p-4">
                    <div className="text-xs text-slate-500 mb-2 font-medium flex items-center gap-2 flex-wrap">
                      <span>{g.items.length} item{g.items.length === 1 ? '' : 'ns'} pra essa loja</span>
                      {/* Status da loja inteira (do pick-order) */}
                      {(() => {
                        const live = liveStatus.find((p) => p.storeCode === g.storeCode);
                        if (!live) return null;
                        const s = live.status;
                        const styles = pickStatusStyles(s);
                        return (
                          <span className={`text-[10px] uppercase font-bold px-2 py-0.5 rounded-full ${styles.bg} ${styles.text}`}>
                            {styles.label}
                          </span>
                        );
                      })()}
                    </div>
                    <ul className="text-sm space-y-1 mb-3">
                      {g.items.map((it) => {
                        const live = liveStatus.find((p) => p.storeCode === g.storeCode);
                        const styles = live ? pickStatusStyles(live.status) : null;
                        return (
                          <li key={it.sku} className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium">{it.quantity}×</span>
                            <span>{it.productName}</span>
                            <span className="text-xs text-slate-500 font-mono">SKU {it.sku}</span>
                            {it.variant && <span className="text-xs text-slate-500">· {it.variant}</span>}
                            {styles && (
                              <span className={`text-[10px] uppercase font-bold px-1.5 py-0.5 rounded ${styles.bg} ${styles.text} ml-auto`}>
                                {styles.label}
                              </span>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                    <details className="text-xs text-slate-500">
                      <summary className="cursor-pointer hover:text-slate-700">Ver mensagem que vai pro WhatsApp</summary>
                      <pre className="bg-slate-50 p-3 rounded mt-2 whitespace-pre-wrap text-slate-700 font-sans">
                        {g.whatsappMessage}
                      </pre>
                    </details>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* EDIÇÃO — status, rastreio, nota */}
      <div className="bg-white rounded shadow p-5 mb-4">
        <h3 className="font-semibold mb-4 text-sm text-slate-600 uppercase tracking-wide">
          Atualizar pedido
        </h3>

        <div className="space-y-4">
          {/* Status */}
          <div>
            <label className="block text-sm font-medium mb-1">Status do pedido</label>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="w-full md:w-80 border rounded px-3 py-2 text-sm"
            >
              {STATUS_OPTIONS.map((s) => (
                <option key={s.slug} value={s.slug}>{s.label}</option>
              ))}
              {!STATUS_OPTIONS.find((s) => s.slug === status) && status && (
                <option value={status}>{status} (custom)</option>
              )}
            </select>
            {statusChanged && (
              <p className="text-xs text-amber-700 mt-1">
                Vai trocar de <b>{STATUS_OPTIONS.find((s) => s.slug === order.status)?.label ?? order.status}</b> para <b>{STATUS_OPTIONS.find((s) => s.slug === status)?.label ?? status}</b>
              </p>
            )}
          </div>

          {/* Rastreio */}
          <div className="border-t pt-4">
            <div className="flex items-center gap-2 mb-3">
              <Truck className="w-4 h-4 text-slate-500" />
              <h4 className="font-medium text-sm">Código de rastreio</h4>
            </div>
            <div className="grid md:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs text-slate-500 mb-1">Transportadora</label>
                <input
                  list="carriers-list"
                  value={trackingCarrier}
                  onChange={(e) => setTrackingCarrier(e.target.value)}
                  placeholder="Correios"
                  className="w-full border rounded px-3 py-2 text-sm"
                />
                <datalist id="carriers-list">
                  {CARRIERS.map((c) => <option key={c.value} value={c.value} />)}
                </datalist>
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">Código *</label>
                <input
                  value={trackingNumber}
                  onChange={(e) => setTrackingNumber(e.target.value)}
                  placeholder="AA123456789BR"
                  className="w-full border rounded px-3 py-2 text-sm font-mono"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">URL de rastreio (auto)</label>
                <input
                  value={trackingUrl}
                  onChange={(e) => setTrackingUrl(e.target.value)}
                  placeholder="https://..."
                  className="w-full border rounded px-3 py-2 text-xs"
                />
              </div>
            </div>
            <p className="text-xs text-slate-500 mt-2">
              Salvo como <code className="bg-slate-100 px-1 rounded">_tracking_number</code> / <code className="bg-slate-100 px-1 rounded">_tracking_carrier</code> nos meta_data do pedido (compatível com o plugin WooCommerce Shipment Tracking).
            </p>

            {/* Timeline de rastreio — puxa status do Correios/LinkeTrack em tempo real */}
            {order.tracking?.number && (
              <div className="mt-4">
                <TrackingTimeline
                  code={order.tracking.number}
                  carrier={order.tracking.carrier}
                  autoFetch
                />
              </div>
            )}
          </div>

          {/* Nota */}
          <div className="border-t pt-4">
            <label className="block text-sm font-medium mb-1">Adicionar nota ao pedido</label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder="Ex: Pedido postado pelos Correios — AA123456789BR"
              className="w-full border rounded px-3 py-2 text-sm"
            />
            <label className="flex items-center gap-2 mt-2 text-sm">
              <input
                type="checkbox"
                checked={notifyCustomer}
                onChange={(e) => setNotifyCustomer(e.target.checked)}
              />
              Enviar nota por email ao cliente
            </label>
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-6 pt-4 border-t">
          <button
            onClick={() => {
              setStatus(order.status);
              setTrackingNumber(order.tracking.number || '');
              setTrackingCarrier(order.tracking.carrier || '');
              setTrackingUrl(order.tracking.url || '');
              setNote('');
            }}
            disabled={!hasChanges || saving}
            className="px-4 py-2 border rounded hover:bg-slate-50 text-sm disabled:opacity-40"
          >
            Descartar alterações
          </button>
          <button
            onClick={save}
            disabled={!hasChanges || saving}
            className="px-5 py-2 bg-brand text-white rounded hover:bg-brand-dark text-sm disabled:opacity-50 flex items-center gap-2"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            {saving ? 'Enviando para o site...' : 'Salvar no site'}
          </button>
        </div>
      </div>

      {/* Attribution */}
      <div className="text-xs text-slate-500 text-right">
        {order.attribution.origem} · {order.attribution.source}
      </div>

      {/* MODAL — Escolher loja manualmente */}
      {pickStoreOpen && (
        <div
          className="fixed inset-0 z-[80] bg-black/60 flex items-center justify-center p-4"
          onClick={() => !pickStoreApplying && setPickStoreOpen(false)}
        >
          <div
            className="bg-white rounded-lg shadow-2xl max-w-2xl w-full max-h-[85vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-4 border-b flex items-center justify-between">
              <div>
                <h3 className="font-bold text-lg text-slate-800">Escolher loja manualmente</h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Força o pedido pra uma loja específica. Usado quando o routing automático
                  não atende (ex: loja reportou problema, você quer concentrar numa loja só).
                </p>
              </div>
              <button
                onClick={() => !pickStoreApplying && setPickStoreOpen(false)}
                className="text-slate-400 hover:text-slate-700 text-2xl leading-none p-1"
                disabled={!!pickStoreApplying}
              >
                ×
              </button>
            </div>

            <div className="p-4 overflow-y-auto flex-1">
              {pickStoreLoading && (
                <div className="flex items-center gap-2 text-slate-500 text-sm py-10 justify-center">
                  <Loader2 className="w-5 h-5 animate-spin" /> Carregando lojas candidatas...
                </div>
              )}

              {pickStoreError && !pickStoreLoading && (
                <div className="bg-red-50 text-red-700 p-3 rounded text-sm mb-3 flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <div>{pickStoreError}</div>
                </div>
              )}

              {!pickStoreLoading && pickStoreCandidates.length === 0 && !pickStoreError && (
                <div className="text-sm text-slate-500 text-center py-6">
                  Nenhuma loja ativa encontrada.
                </div>
              )}

              {!pickStoreLoading && pickStoreCandidates.length > 0 && (
                <div className="space-y-2">
                  <div className="text-xs text-slate-500 mb-2">
                    Ordenado por <b>maior cobertura</b> (mais SKUs do pedido disponíveis).
                    A loja <b>✓ verde</b> cobre o pedido todo. <b>⚠ amarelo</b> cobre parcialmente
                    (vai faltar peça — ia precisar transferir ou quebrar de novo).
                  </div>
                  {pickStoreCandidates.map((c) => {
                    const full = c.skusCovered >= c.skusTotal && c.skusTotal > 0;
                    const partial = c.skusCovered > 0 && !full;
                    const none = c.skusCovered === 0;
                    const isCurrentAssigned = liveStatus.some((p) => p.storeCode === c.code && ['new', 'separating'].includes(p.status));
                    return (
                      <div
                        key={c.code}
                        className={`border rounded-lg p-3 flex items-center gap-3 ${
                          c.hasReportedIssue
                            ? 'bg-red-50 border-red-300'
                            : full
                            ? 'bg-emerald-50 border-emerald-300'
                            : partial
                            ? 'bg-amber-50 border-amber-300'
                            : 'bg-slate-50 border-slate-200 opacity-70'
                        }`}
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-semibold text-slate-800">{c.name}</span>
                            <span className="text-xs font-mono text-slate-500">({c.code})</span>
                            {isCurrentAssigned && (
                              <span className="text-xs px-2 py-0.5 bg-blue-100 text-blue-800 rounded font-medium">
                                atual
                              </span>
                            )}
                            {c.hasReportedIssue && (
                              <span className="text-xs px-2 py-0.5 bg-red-200 text-red-900 rounded font-medium">
                                ⚠ reportou problema
                              </span>
                            )}
                            {full && !c.hasReportedIssue && (
                              <span className="text-xs px-2 py-0.5 bg-emerald-600 text-white rounded font-bold">
                                ✓ cobre tudo
                              </span>
                            )}
                            {partial && (
                              <span className="text-xs px-2 py-0.5 bg-amber-500 text-white rounded font-bold">
                                ⚠ cobre {c.skusCovered}/{c.skusTotal}
                              </span>
                            )}
                            {none && (
                              <span className="text-xs px-2 py-0.5 bg-slate-400 text-white rounded font-medium">
                                sem estoque
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-slate-500 mt-0.5">
                            {[c.city, c.state].filter(Boolean).join(' / ') || '—'}
                            {c.totalQty > 0 && <> · {c.totalQty} un. disponíveis</>}
                          </div>
                          {c.missingSkus.length > 0 && c.missingSkus.length <= 5 && (
                            <div className="text-xs text-slate-600 mt-1">
                              <span className="opacity-70">Faltam:</span>{' '}
                              <span className="font-mono">{c.missingSkus.join(', ')}</span>
                            </div>
                          )}
                        </div>
                        <button
                          onClick={() => applyPickStore(c.code, c.name)}
                          disabled={!!pickStoreApplying || none || isCurrentAssigned}
                          className={`px-3 py-2 rounded text-xs font-semibold flex-shrink-0 flex items-center gap-1 ${
                            none || isCurrentAssigned
                              ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
                              : 'bg-brand text-white hover:bg-brand-dark disabled:opacity-60'
                          }`}
                          title={
                            isCurrentAssigned
                              ? 'Essa loja já é a responsável atual'
                              : none
                              ? 'Essa loja não tem estoque de nenhuma peça'
                              : `Forçar pedido pra ${c.name}`
                          }
                        >
                          {pickStoreApplying === c.code ? (
                            <>
                              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Aplicando...
                            </>
                          ) : (
                            <>Escolher</>
                          )}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="p-3 border-t bg-slate-50 text-xs text-slate-500 flex items-center justify-between">
              <span>Dica: se nenhuma loja cobre tudo, volte e use <b>Recalcular</b> pra dividir automático.</span>
              <button
                onClick={() => !pickStoreApplying && setPickStoreOpen(false)}
                disabled={!!pickStoreApplying}
                className="px-3 py-1.5 border rounded hover:bg-white text-slate-700 disabled:opacity-60"
              >
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal de diagnóstico de SKU — explica por que o sistema fala ruptura */}
      {diagnoseSku && (
        <SkuDiagnoseModal
          sku={diagnoseSku}
          onClose={() => setDiagnoseSku(null)}
        />
      )}
    </div>
  );
}

// ── SKU DIAGNOSE MODAL ────────────────────────────────────────────────
// Mostra pra um SKU específico:
//   - Total real no Giga
//   - Total comprometido em pick-orders ativos
//   - Total líquido (real − committed)
//   - Detalhamento por loja
//   - Lista de pick-orders ativos com pedido WC + cliente — pra retaguarda
//     identificar quem reservou e decidir (cancelar/aguardar/conferir físico)
function SkuDiagnoseModal({
  sku,
  onClose,
}: {
  sku: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<{
    sku: string;
    totals: { real: number; committed: number; liquid: number };
    rows: Array<{ storeCode: string; storeName: string; tipo: string; real: number; committed: number; liquid: number }>;
    commitments: Array<{
      storeCode: string;
      storeName: string;
      qty: number;
      pickOrderId: string;
      pickOrderStatus: string;
      wcOrderId: number | null;
      wcOrderNumber: string | null;
      customerName: string | null;
      orderStatus: string | null;
      orderCreatedAt: string | null;
    }>;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const r = await api<any>(`/intelligence/sku-diagnose/${encodeURIComponent(sku)}`);
        if (!cancelled) setData(r);
      } catch (e: any) {
        if (!cancelled) setErr(e?.message || 'Erro ao carregar diagnóstico');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [sku]);

  return (
    <div
      className="fixed inset-0 bg-black/60 z-50 flex items-start justify-center p-4 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl w-full max-w-3xl my-8 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 bg-slate-100 border-b flex items-center justify-between">
          <h2 className="font-black text-base text-slate-800 flex items-center gap-2">
            <Search className="w-4 h-4 text-violet-600" />
            Diagnóstico de estoque · SKU <span className="font-mono">{sku}</span>
          </h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700"><X className="w-5 h-5" /></button>
        </div>

        <div className="p-5 space-y-4">
          {loading && (
            <div className="text-center py-10">
              <Loader2 className="w-6 h-6 animate-spin inline-block text-violet-600" />
              <div className="text-xs text-slate-500 mt-2">Consultando Giga + pick-orders ativos…</div>
            </div>
          )}

          {err && (
            <div className="bg-red-50 border border-red-200 rounded p-3 text-sm text-red-700">
              {err}
            </div>
          )}

          {data && !loading && (
            <>
              {/* KPIs no topo: real vs committed vs liquid */}
              <div className="grid grid-cols-3 gap-3">
                <div className="bg-blue-50 border-2 border-blue-200 rounded-xl p-3 text-center">
                  <div className="text-[10px] text-blue-700 uppercase tracking-widest font-bold">Real (Giga)</div>
                  <div className="text-3xl font-black text-blue-700 tabular-nums mt-1">{data.totals.real}</div>
                  <div className="text-[10px] text-blue-600 mt-0.5">peças físicas</div>
                </div>
                <div className="bg-amber-50 border-2 border-amber-200 rounded-xl p-3 text-center">
                  <div className="text-[10px] text-amber-700 uppercase tracking-widest font-bold">Comprometido</div>
                  <div className="text-3xl font-black text-amber-700 tabular-nums mt-1">{data.totals.committed}</div>
                  <div className="text-[10px] text-amber-600 mt-0.5">em pick-orders ativos</div>
                </div>
                <div className={`border-2 rounded-xl p-3 text-center ${
                  data.totals.liquid > 0
                    ? 'bg-emerald-50 border-emerald-200'
                    : 'bg-rose-50 border-rose-200'
                }`}>
                  <div className={`text-[10px] uppercase tracking-widest font-bold ${
                    data.totals.liquid > 0 ? 'text-emerald-700' : 'text-rose-700'
                  }`}>Líquido</div>
                  <div className={`text-3xl font-black tabular-nums mt-1 ${
                    data.totals.liquid > 0 ? 'text-emerald-700' : 'text-rose-700'
                  }`}>{data.totals.liquid}</div>
                  <div className={`text-[10px] mt-0.5 ${
                    data.totals.liquid > 0 ? 'text-emerald-600' : 'text-rose-600'
                  }`}>
                    {data.totals.liquid > 0 ? 'disponível pra alocar' : 'tudo comprometido'}
                  </div>
                </div>
              </div>

              {/* Explicação pra retaguarda */}
              {data.totals.real > 0 && data.totals.liquid === 0 && (
                <div className="bg-amber-50 border border-amber-300 rounded-lg p-3 text-sm text-amber-900">
                  <b>📌 Por que o sistema fala ruptura mesmo tendo {data.totals.real} un fisicamente:</b>
                  <br />
                  As {data.totals.committed} un que existem no Giga já estão {' '}
                  <b>reservadas em outros pick-orders ativos</b> (lista abaixo). A engine não pode prometer
                  a mesma peça pra 2 pedidos diferentes.
                </div>
              )}

              {/* Detalhamento por loja */}
              <div>
                <div className="text-xs font-bold uppercase text-slate-500 tracking-wider mb-2">Por loja</div>
                {data.rows.length === 0 ? (
                  <div className="text-sm text-slate-500 italic px-3 py-4 bg-slate-50 rounded">
                    Esse SKU não aparece em nenhuma loja (real e comprometido = 0).
                  </div>
                ) : (
                  <div className="border rounded-lg overflow-hidden">
                    <div className="grid grid-cols-[1fr_60px_80px_90px_80px] gap-2 px-3 py-2 bg-slate-100 text-[10px] uppercase tracking-wider font-bold text-slate-600">
                      <div>Loja</div>
                      <div className="text-center">Tipo</div>
                      <div className="text-right">Real</div>
                      <div className="text-right">Compromet.</div>
                      <div className="text-right">Líquido</div>
                    </div>
                    {data.rows.map((r) => (
                      <div
                        key={r.storeCode}
                        className="grid grid-cols-[1fr_60px_80px_90px_80px] gap-2 px-3 py-2 text-sm border-t border-slate-100 items-center"
                      >
                        <div className="font-medium text-slate-800">
                          {r.storeName}
                          <span className="ml-2 text-xs font-mono text-slate-400">{r.storeCode}</span>
                        </div>
                        <div className="text-center text-[10px] font-bold">
                          <span className={`px-1.5 py-0.5 rounded ${
                            r.tipo === 'FILIAL' ? 'bg-amber-100 text-amber-800' : 'bg-blue-100 text-blue-800'
                          }`}>
                            {r.tipo === 'FILIAL' ? 'FRANQ' : 'REDE'}
                          </span>
                        </div>
                        <div className="text-right tabular-nums text-blue-700 font-bold">{r.real}</div>
                        <div className="text-right tabular-nums text-amber-700 font-bold">
                          {r.committed > 0 ? r.committed : '—'}
                        </div>
                        <div className={`text-right tabular-nums font-black ${
                          r.liquid > 0 ? 'text-emerald-700' : 'text-rose-700'
                        }`}>
                          {r.liquid}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Lista de compromissos: quem reservou */}
              {data.commitments.length > 0 && (
                <div>
                  <div className="text-xs font-bold uppercase text-slate-500 tracking-wider mb-2">
                    Quem reservou ({data.commitments.length} pick-order{data.commitments.length > 1 ? 's' : ''} ativo{data.commitments.length > 1 ? 's' : ''})
                  </div>
                  <div className="space-y-2">
                    {data.commitments.map((c, idx) => (
                      <div
                        key={c.pickOrderId + idx}
                        className="border border-amber-200 bg-amber-50/40 rounded-lg p-3 text-sm"
                      >
                        <div className="flex items-center justify-between gap-2 flex-wrap mb-1">
                          <div className="font-bold text-slate-900 flex items-center gap-2">
                            <span className="text-amber-700">{c.qty}× reservadas em</span>
                            <span className="text-violet-700">{c.storeName}</span>
                            <span className="text-xs font-mono text-slate-500">{c.storeCode}</span>
                          </div>
                          <span className={`text-[10px] font-bold px-2 py-0.5 rounded uppercase ${
                            c.pickOrderStatus === 'separated' ? 'bg-emerald-200 text-emerald-900' :
                            c.pickOrderStatus === 'separating' ? 'bg-amber-200 text-amber-900' :
                            'bg-slate-200 text-slate-800'
                          }`}>
                            {c.pickOrderStatus}
                          </span>
                        </div>
                        <div className="text-xs text-slate-600 flex items-center gap-3 flex-wrap">
                          {c.wcOrderId && (
                            <Link
                              href={`/pedidos/wc/${c.wcOrderId}`}
                              className="text-violet-700 hover:underline font-mono font-bold"
                              target="_blank"
                            >
                              #{c.wcOrderNumber || c.wcOrderId}
                              <ExternalLink className="w-3 h-3 inline-block ml-0.5" />
                            </Link>
                          )}
                          {c.customerName && (
                            <span className="text-slate-700">
                              <b>Cliente:</b> {c.customerName}
                            </span>
                          )}
                          {c.orderCreatedAt && (
                            <span className="text-slate-500">
                              criado em {new Date(c.orderCreatedAt).toLocaleString('pt-BR')}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Sugestões de ação */}
              {data.totals.real > 0 && data.totals.liquid === 0 && (
                <div className="bg-blue-50 border border-blue-200 rounded p-3 text-xs text-blue-900 leading-relaxed">
                  <b>Como resolver:</b>
                  <ul className="list-disc ml-5 mt-1 space-y-0.5">
                    <li>Se um dos pick-orders acima é de pedido <b>cancelado</b> → cancelar o pick-order libera o estoque.</li>
                    <li>Se o pedido conflitante <b>já foi enviado fisicamente</b> mas o status no sistema ainda é separated → atualizar o status (shipped) libera.</li>
                    <li>Se o estoque ERP está <b>divergente do físico real</b> → ajustar no Giga (zerar a peça que sumiu).</li>
                    <li>Senão, este pedido vai aguardar. Aceitar a ruptura ou comprar peça nova.</li>
                  </ul>
                </div>
              )}
            </>
          )}
        </div>

        <div className="px-5 py-3 bg-slate-50 border-t flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-white border border-slate-300 hover:bg-slate-100 text-slate-700 rounded font-bold text-sm"
          >
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
}
