'use client';
import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { api } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { classifyShipping } from '@/lib/shipping-method';
import { ArrowLeft, Save, ExternalLink, Truck, Package, Loader2, Check, Send, Store as StoreIcon, AlertTriangle, AlertCircle, Zap } from 'lucide-react';

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
    const hasAdvanced = liveStatus.some(
      (p) => !['new', 'separating'].includes(p.status),
    );
    if (hasAdvanced) {
      alert(
        'Não dá pra trocar loja: alguma já passou de "separando" (bipou/enviou). ' +
        'Rejeite manualmente pela tela de baixa antes.',
      );
      return;
    }
    if (!confirm(
      `Trocar a loja ${displayName} (${storeCode}) por outra?\n\n` +
      `O sistema vai rerodar o roteamento excluindo ${storeCode} e escolher outra loja ` +
      `com estoque. O card atual vai sumir do /minha-loja da ${storeCode}.\n\n` +
      `Se nenhuma outra loja tiver estoque suficiente, o pedido fica pending.`,
    )) return;

    setSepLoading(true);
    setSepError(null);
    try {
      const res = await api<{
        ok: boolean;
        reason?: string;
        message?: string;
        cancelledCount?: number;
        excludedStoreCodes?: string[];
        pickOrders?: Array<{ id: string; storeCode: string; storeName: string }>;
      }>(`/orders/wc/${wcId}/recalculate-separation`, {
        method: 'POST',
        body: JSON.stringify({ excludeStoreCodes: [storeCode] }),
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
                <div className="mt-2 text-red-800 text-xs">
                  Clique em <b>Recalcular separação</b> acima pra reatribuir pra outra loja
                  (a loja que reportou será <b>excluída automaticamente</b>).
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
              <div className="mb-2 text-xs bg-amber-50 border border-amber-200 text-amber-900 rounded px-2 py-1.5 flex items-start gap-1.5">
                <span className="text-amber-700">💡</span>
                <span>
                  Quer trocar a loja que vai enviar/transferir? Clica em{' '}
                  <b>↔ Trocar loja</b> no card da loja e o sistema escolhe outra com
                  estoque automaticamente.
                </span>
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
                      {['new', 'separating'].includes(r.status) && r.storeCode && (
                        <button
                          type="button"
                          onClick={() => swapStore(r.storeCode!, r.storeName)}
                          disabled={sepLoading}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs border bg-amber-50 text-amber-800 border-amber-300 hover:bg-amber-100 disabled:opacity-60"
                          title={`Escolher outra loja no lugar de ${r.storeCode}. Só funciona se a loja ainda não bipou.`}
                        >
                          ↔ Trocar loja
                        </button>
                      )}
                    </div>
                    {r.status === 'shipped' && r.trackingCode && (
                      <div className="mt-1 pl-6 text-xs text-slate-700">
                        <Truck className="w-3 h-3 inline mr-1" />
                        <span className="font-mono font-semibold">{r.trackingCode}</span>
                        {r.carrier && <span className="text-slate-500 ml-2">via {r.carrier}</span>}
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
                  🚚 <b>RETIRADA EM LOJA com TRANSFERÊNCIA</b> — {separation.pickupStoreName} não tem tudo.
                  {separation.groups.filter((g) => g.isTransfer).length} loja(s) vão <b>transferir</b> pra {separation.pickupStoreName}.
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

            {/* BOTÃO PRINCIPAL — Confirma e dispara socket pras lojas */}
            {separation.success && (
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
                </div>
                <button
                  onClick={confirmSeparation}
                  disabled={confirmLoading || (confirmResult?.ok === true)}
                  className="px-5 py-3 bg-white text-brand rounded font-semibold hover:bg-slate-100 disabled:opacity-60 flex items-center gap-2 shadow"
                >
                  {confirmLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                  {confirmResult?.ok ? 'Já confirmado ✓' : confirmLoading ? 'Confirmando...' : 'Confirmar e enviar pras lojas'}
                </button>
              </div>
            )}

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

            {/* Missing (ruptura) */}
            {separation.missing.length > 0 && (
              <div className="bg-red-50 border border-red-200 rounded p-3 mb-4">
                <div className="text-sm font-medium text-red-800 mb-2">Sem estoque em nenhuma loja:</div>
                <ul className="text-sm text-red-700 space-y-1">
                  {separation.missing.map((m) => (
                    <li key={m.sku}>
                      • {m.quantity}× {m.productName} <span className="font-mono text-xs">(SKU {m.sku})</span>
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
                    <button
                      onClick={() => sendWhatsapp(g)}
                      disabled={!g.whatsapp}
                      className="px-3 py-2 bg-green-600 text-white rounded hover:bg-green-700 text-sm disabled:opacity-40 flex items-center gap-2"
                      title={g.whatsapp ? 'Abrir WhatsApp com mensagem pronta' : 'Cadastra o WhatsApp em /lojas'}
                    >
                      <Send className="w-4 h-4" /> Enviar WhatsApp
                    </button>
                  </div>

                  <div className="p-4">
                    <div className="text-xs text-slate-500 mb-2 font-medium">
                      {g.items.length} item{g.items.length === 1 ? '' : 'ns'} pra essa loja
                    </div>
                    <ul className="text-sm space-y-1 mb-3">
                      {g.items.map((it) => (
                        <li key={it.sku}>
                          <span className="font-medium">{it.quantity}×</span> {it.productName}
                          <span className="text-xs text-slate-500 ml-2 font-mono">SKU {it.sku}</span>
                          {it.variant && <span className="text-xs text-slate-500 ml-2">· {it.variant}</span>}
                        </li>
                      ))}
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
    </div>
  );
}
