'use client';
import { overlayClose } from '@/lib/overlayClose';
import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, API_URL, getAuthToken } from '@/lib/api';
import { abrirWhatsApp } from '@/lib/whatsapp';
import EnderecoEntregaModal, { enderecoDoPedido } from '@/components/EnderecoEntregaModal';
import DadosClienteModal from '@/components/DadosClienteModal';
import { fmtTelefoneBr, telefoneProblema } from '@/lib/telefone-br';
import { getSocket } from '@/lib/socket';
import { classifyShipping } from '@/lib/shipping-method';
import { Table, Th, Tr, Td } from '@/components/ui';
import { ruaComNumero } from '@/lib/format-address';
import { refCorTam, nomeSemVariacao } from '@/lib/peca-linha';
import TrackingTimeline from '@/components/TrackingTimeline';
import SellerTag from '@/components/SellerTag';
import TrocaPecaModal from './TrocaPecaModal';
import CampanhaCascata, { Atribuicao } from './CampanhaCascata';
import PainelRisco from './PainelRisco';
import { ArrowLeft, Save, ExternalLink, Truck, Package, Loader2, Check, Send, Store as StoreIcon, AlertTriangle, AlertCircle, Zap, Search, X, FileText } from 'lucide-react';

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
  // `availableQty` é LÍQUIDO: já vem sem as peças prometidas a cards abertos
  // em outros pedidos (`reservedQty`). Trocar a loja na mão não pode oferecer
  // peça que já tem dono.
  alternativesBySku: Record<string, Array<{ storeId: string; storeCode: string; storeName: string; availableQty: number; reservedQty?: number; whatsapp: string | null }>>;
  /**
   * Outras lojas que TAMBÉM cobrem o pedido inteiro (top 5, exceto a escolhida).
   * Aparece como radio buttons abaixo do "1 loja atende o pedido inteiro"
   * pra permitir o admin trocar antes de confirmar.
   */
  alternativeFullStores?: Array<{
    storeCode: string;
    storeName: string;
    stockBuffer: number;
    finalScore: number;
  }>;
  isPickup?: boolean;
  pickupStoreCode?: string | null;
  pickupStoreName?: string | null;
  /**
   * JUNTADA automática (trio litoral): o plano já nasce juntando as peças numa
   * loja âncora — os groups com isTransfer apontam pra ela. Diferente da
   * retirada: aqui a âncora ENVIA o pacote único pra cliente.
   */
  consolidateStoreCode?: string | null;
  consolidateStoreName?: string | null;
  customer?: {
    name: string;
    cpf: string | null;
    email: string | null;
    phone: string | null;
  };
}

/**
 * Raio-X da JUNTADA (GET /orders/wc/:id/juntada) — pedido dividido com loja
 * ÂNCORA: as outras lojas mandam caixa pra ela e só ela envia pra cliente.
 * `caixa: null` = a feeder ainda está separando (a caixa nasce quando ela
 * finaliza a bipagem).
 */
interface JuntadaInfo {
  juntando: boolean;
  ancoraStoreCode?: string | null;
  ancoraStoreName?: string | null;
  ancoraPickId?: string | null;
  ancoraPickStatus?: string | null;
  totalCaixas?: number;
  recebidas?: number;
  completa?: boolean;
  caixas?: Array<{
    pickOrderId: string;
    storeCode: string | null;
    storeName: string | null;
    pickStatus: string;
    caixa: {
      code: string;
      status: string; // in_transit | received
      trackingCode: string | null;
      carrier: string | null;
      transporte: 'correios' | 'proprio' | null;
      sentAt: string | null;
      receivedAt: string | null;
    } | null;
  }>;
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
  lineItems: Array<{
    id: number; name: string; sku: string; quantity: number; total: string; price: number; image: string | null;
    /** REF · COR · TAM — vêm preenchidos no pedido do site novo (13/08). */
    ref?: string | null; cor?: string | null; tamanho?: string | null;
  }>;
  shippingLines: Array<{ method: string; total: string }>;
  tracking: { number: string; carrier: string; url: string };
  attribution: { origem: string; source: string };
  /** Cascata "de qual campanha veio" — montada no backend. */
  atribuicao?: Atribuicao | null;
  /** Loja que PEDIU (venda online do PDV). NULL no pedido do site. */
  origemLoja?: { code: string; name: string; vendedora: string | null } | null;
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
  /**
   * O DINHEIRO ENTROU? Vem da régua `pedidoPago` do backend (carimbo do
   * gateway). Só o pedido NATIVO manda — no do WooCommerce vem undefined e a
   * tela segue decidindo pelo status, como sempre decidiu.
   */
  pago?: boolean;
  paidAt?: string | null;
  /** true = pedido nativo (item no Postgres) → a tabela de itens mostra "Trocar". */
  canEditItems?: boolean;
}

/**
 * "5358 · PRETO DOURADO 60" — o MESMO formato que a loja já lê no card da
 * LIVE e na fila da /minha-loja. Pedido sem REF gravada (antes de 13/08, live,
 * WooCommerce) continua mostrando o nome, como sempre mostrou.
 */
function tituloPeca(li: { name: string; sku: string; ref?: string | null; cor?: string | null; tamanho?: string | null }): string {
  return refCorTam(li) || li.name || li.sku;
}

function quantidadeDoCard(card: { items?: Array<{ qty: number }> }): number {
  return (card.items ?? []).reduce((s, item) => s + (Number(item.qty) || 0), 0);
}

function destinoLogisticoObrigatorio(order: WcOrderDetail | null): { code: string; tipo: 'retirada' | 'motoboy' } | null {
  const code = String(order?.pickup?.storeCode || '').trim();
  if (!code) return null;
  if (order?.pickup?.isPickup) return { code, tipo: 'retirada' };
  const method = String(order?.pickup?.shippingMethodTitle || order?.shippingLines?.[0]?.method || '');
  if (/motoboy|moto\s*boy/i.test(method)) return { code, tipo: 'motoboy' };
  return null;
}

export default function PedidoDetailPage() {
  const params = useParams();
  const router = useRouter();
  const wcId = params.id as string;

  const [order, setOrder] = useState<WcOrderDetail | null>(null);
  const [editandoEndereco, setEditandoEndereco] = useState(false);
  const [editandoCliente, setEditandoCliente] = useState(false);
  // TROCAR FORMA DE ENTREGA (17/08) — o pedido nasceu "não informada" ou com
  // a forma errada, e a matriz não tinha como consertar por tela (ON-000006:
  // cliente ia RETIRAR em SJC e o pedido não sabia).
  const [trocandoEntrega, setTrocandoEntrega] = useState(false);
  const [entregaNova, setEntregaNova] = useState<'sedex' | 'pac' | 'motoboy' | 'retirada'>('retirada');
  const [entregaLoja, setEntregaLoja] = useState('');
  const [entregaLojas, setEntregaLojas] = useState<Array<{ code: string; name: string }>>([]);
  const [entregaBusy, setEntregaBusy] = useState(false);
  const [entregaErro, setEntregaErro] = useState<string | null>(null);
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
  /**
   * POR QUE ESTÁ CANCELANDO (26/08). Campo próprio, separado da nota: o
   * backend recusa cancelamento sem motivo (common/motivo-cancelamento.ts) e
   * grava o texto + o nome de quem clicou no histórico do pedido. Até aqui
   * todo cancelamento era anônimo e mudo — o ON-000017 morreu assim.
   */
  const [cancelReason, setCancelReason] = useState('');

  // Separação
  const [separation, setSeparation] = useState<SeparationPreview | null>(null);
  const [sepLoading, setSepLoading] = useState(false);
  const [sepError, setSepError] = useState<string | null>(null);
  // Conserto "a loja vendedora já entregou" (venda online roteada pra outra loja)
  const [fecharLoading, setFecharLoading] = useState(false);
  const [fecharErro, setFecharErro] = useState<string | null>(null);
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

  // TROCA MANUAL DE ITEM (21/08) — botão "Trocar" na tabela de ITENS. Depois
  // de confirmar, o backend acerta o dinheiro (link de cobrança OU vale) e
  // re-roteia o pedido inteiro; a tela só recarrega o que mudou.
  const [trocaItem, setTrocaItem] = useState<{ id: string; label: string } | null>(null);

  // ── ACERTOS DA TROCA (21/08) ──────────────────────────────────────────
  // Peça mais cara vira link de pagamento e TRAVA a separação até a cliente
  // pagar; mais barata vira vale nominal no CPF. Sem esse painel a trava
  // seria invisível — o pedido ficaria parado sem ninguém saber por quê.
  const [trocas, setTrocas] = useState<Array<{
    id: string;
    tipo: 'cobranca' | 'vale' | 'neutro';
    status: 'pending' | 'settled' | 'cancelled';
    oldSku: string | null;
    oldName: string | null;
    newSku: string | null;
    newName: string | null;
    diferenca: number;
    linkUrl: string | null;
    linkExpiresAt: string | null;
    cupomCode: string | null;
    motivo: string | null;
    createdAt: string;
    settledAt: string | null;
  }>>([]);
  const [trocasTravando, setTrocasTravando] = useState(false);
  /** Mini-form inline de cortesia: id da troca sendo liberada + motivo. */
  const [liberandoTroca, setLiberandoTroca] = useState<string | null>(null);
  const [liberarMotivo, setLiberarMotivo] = useState('');
  const [liberarBusy, setLiberarBusy] = useState(false);
  const [liberarErro, setLiberarErro] = useState<string | null>(null);
  const [linkCopiado, setLinkCopiado] = useState<string | null>(null);
  const loadTrocas = () => {
    if (!wcId) return;
    api<{ trocas: typeof trocas; travando: boolean }>(`/orders/wc/${wcId}/trocas`)
      .then((d) => {
        setTrocas(Array.isArray(d?.trocas) ? d.trocas : []);
        setTrocasTravando(!!d?.travando);
      })
      .catch(() => {});
  };

  /** Cortesia: a casa absorve a diferença e a separação destrava. */
  async function liberarTrocaSemCobrar(swapId: string) {
    const motivo = liberarMotivo.trim();
    if (motivo.length < 3) {
      setLiberarErro('Escreva o motivo — é ele que explica o dinheiro que a casa abriu mão.');
      return;
    }
    setLiberarBusy(true);
    setLiberarErro(null);
    try {
      await api(`/orders/trocas/${swapId}/liberar-sem-cobrar`, {
        method: 'POST',
        body: JSON.stringify({ motivo }),
      });
      setLiberandoTroca(null);
      setLiberarMotivo('');
      loadTrocas();
      setFlash('✓ Diferença liberada sem cobrar. Já dá pra gerar a separação.');
      setTimeout(() => setFlash(null), 5000);
    } catch (e: any) {
      setLiberarErro(e?.message || 'Não deu pra liberar. Tente de novo.');
    } finally {
      setLiberarBusy(false);
    }
  }

  // Gate de quebra — pedido dividido em N lojas exige o operador marcar
  // "ciente da divisão" antes do botão Confirmar habilitar. Zera sempre que
  // gera/recalcula preview pra forçar nova revisão.
  const [splitApproved, setSplitApproved] = useState(false);
  // Loja preferida — override manual via radio button quando single-store.
  // null = usa sugestão automática do routing; "XX" = força essa loja.
  const [preferredStoreCode, setPreferredStoreCode] = useState<string | null>(null);
  const [switchingStore, setSwitchingStore] = useState(false);

  // Modal de "Escolher loja manualmente" — retaguarda escolhe especificamente pra
  // qual loja o pedido vai (bypassa a decisão automática do routing). Usado
  // principalmente quando uma loja reportou problema e retaguarda quer forçar
  // uma outra loja específica em vez de deixar o engine decidir.
  const [pickStoreOpen, setPickStoreOpen] = useState(false);
  // Modo SWAP — quando o modal foi aberto pelo botão "Trocar loja" de UM
  // pick-order específico (em vez do "Escolher loja manualmente" geral).
  // Quando setado, applyPickStore faz swap cirúrgico (não recalcula tudo).
  const [swapTarget, setSwapTarget] = useState<{
    pickOrderId: string;
    fromStoreCode: string;
    fromStoreName: string | null;
    fromStatus: string;
  } | null>(null);
  // Modo TROCA NO PREVIEW — botão "↔ Trocar loja" de um GRUPO da sugestão,
  // ANTES de existir pick-order (nada foi enviado pra loja ainda). A troca
  // refaz o preview excluindo a loja rejeitada e FIXANDO a escolhida
  // (pinStoreCodes), e o Confirmar manda as mesmas listas pro backend —
  // sem isso o confirm re-roda o routing do zero e desfaz a troca.
  const [previewSwapTarget, setPreviewSwapTarget] = useState<{
    storeCode: string;
    storeName: string | null;
    skus: string[];
  } | null>(null);
  const [previewExcludes, setPreviewExcludes] = useState<string[]>([]);
  const [previewPins, setPreviewPins] = useState<string[]>([]);
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
    /** Peças que a loja tem mas já estão PROMETIDAS a cards de outros pedidos. */
    reservedQty: number;
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
    status: 'new' | 'separating' | 'separated' | 'ready' | 'shipped';
    trackingCode: string | null;
    carrier: string | null;
    storeId: string;
    storeCode: string | null;
    storeName: string | null;
    storeCity: string | null;
    // JUNTADA: feeder (isTransfer num pedido não-retirada) + a caixa dele,
    // se já nasceu — a tela mostra "em trânsito"/"chegou" no card da loja.
    isTransfer?: boolean;
    transferToStoreCode?: string | null;
    caixaJuntada?: {
      code: string;
      status: string;
      trackingCode: string | null;
      carrier: string | null;
      transportMode: string | null;
      sentAt?: string | null;
      receivedAt?: string | null;
    } | null;
    // ── NOTA FISCAL deste envio (27/08) ──
    // Nasce por CARD (`envio:<pickId>`), não por pedido: pedido dividido tem
    // uma nota por loja, cada uma com o CNPJ da loja que despachou. `null` =
    // despachou sem emitir — pendência fiscal, e a tela diz isso.
    nota?: {
      id: string;
      numero: number;
      serie: string;
      chave: string | null;
      status: string;
      cStat: string | null;
      xMotivo: string | null;
      protocolo: string | null;
      /** tpAmb '2' — nota de TESTE, sem valor fiscal. */
      homologacao: boolean;
      valorCents: number;
      emitidaEm: string;
      danfeDisponivel: boolean;
    } | null;
    // SKUs desta loja — usados pra medir a cobertura do "Trocar loja" só
    // contra os itens que realmente vão mudar de loja.
    skus?: string[];
    // Peças que esta loja separa (descrição + qtd) — mostradas no card.
    // `id` é o OrderItem: é o que permite mover UMA peça de loja sem arrastar
    // o card inteiro junto (LP-000244). Opcional porque backend antigo não manda.
    items?: Array<{
      id?: string;
      sku: string; descricao: string | null; qty: number;
      ref?: string | null; cor?: string | null; tamanho?: string | null;
    }>;
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
    // O que a CASA pagou nesta etiqueta (centavos), gravado na emissão.
    // Vazio nas etiquetas anteriores a 25/08 — antes o custo não era guardado.
    freteCustoCentavos?: number | null;
    freteCustoFonte?: string | null;
  }>>([]);
  const [liveStatusFlash, setLiveStatusFlash] = useState<Record<string, number>>({});

  // ── Peças reportadas na bipagem ("não achei a peça") ──
  // O card da loja SEGUIU com o resto; a peça reportada ficou SEM loja,
  // esperando a matriz mandar de outra loja (Recalcular) ou reembolsar.
  // O reporte se auto-resolve quando o item ganha loja de novo.
  const [itemReports, setItemReports] = useState<Array<{
    id: string;
    storeCode: string;
    sku: string;
    productName: string | null;
    ref?: string | null;
    cor?: string | null;
    tamanho?: string | null;
    qtyMissing: number;
    reason: string;
    reasonLabel: string;
    note?: string | null;
    reportedAt: string;
    stockDecreased: boolean;
    // Quanto a cliente pagou por ESSA peça — é o default do crédito.
    valorSugerido?: number;
    cliente?: { nome: string | null; cpf: string | null; telefone: string | null; pedidoNumero: string };
  }>>([]);
  const [resolvendoReport, setResolvendoReport] = useState<string | null>(null);
  const loadItemReports = () => {
    if (!wcId) return;
    api<any[]>(`/pick-orders/item-reports/by-wc/${wcId}`)
      .then((d) => setItemReports(Array.isArray(d) ? d : []))
      .catch(() => {});
  };

  // ── CRÉDITO NO LUGAR DO REEMBOLSO (dono, 25/08) ──
  // "A cliente prefere crédito": em vez de devolver o dinheiro da peça que
  // faltou, emite um vale NOMINAL no CPF dela, SEM PRAZO, que vale no site e
  // em qualquer caixa da rede. Quem emite é a matriz, aqui na ficha do pedido.
  type ReportLinha = (typeof itemReports)[number];
  const [creditoAlvo, setCreditoAlvo] = useState<ReportLinha | null>(null);
  const [creditoValor, setCreditoValor] = useState('');
  const [creditoBusy, setCreditoBusy] = useState(false);
  const [creditoErro, setCreditoErro] = useState<string | null>(null);
  const [creditosEmitidos, setCreditosEmitidos] = useState<Array<{
    id: string; code: string; valor: number; peca: string; qtyMissing: number;
    storeCode: string; emitidoEm: string | null; existe: boolean; usado: boolean;
    usadoAt: string | null; ativo: boolean; semPrazo: boolean;
  }>>([]);
  const loadCreditos = () => {
    if (!wcId) return;
    api<any[]>(`/pick-orders/item-reports/creditos/by-wc/${wcId}`)
      .then((d) => setCreditosEmitidos(Array.isArray(d) ? d : []))
      .catch(() => {});
  };
  /**
   * DANFE da nota deste envio (27/08).
   *
   * Mesma rota que o relatório fiscal já usa (`GET /nfe/:id/danfe`), que
   * devolve PDF binário — por isso `fetch` cru com o token, e não o helper
   * `api()`, que faz `res.json()` e engasgaria no PDF.
   *
   * Abre em aba nova; se o navegador bloquear o popup, cai pro download —
   * bloqueio de popup não pode virar "o botão não faz nada".
   */
  const [danfeBaixando, setDanfeBaixando] = useState<string | null>(null);
  const abrirDanfe = async (nota: { id: string; numero: number }) => {
    setDanfeBaixando(nota.id);
    try {
      const token = getAuthToken();
      const r = await fetch(`${API_URL}/api/nfe/${nota.id}/danfe`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!r.ok) {
        throw new Error((await r.json().catch(() => null))?.message || `HTTP ${r.status}`);
      }
      const blobUrl = URL.createObjectURL(await r.blob());
      const w = window.open(blobUrl, '_blank');
      if (!w) {
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = `danfe-${nota.numero}.pdf`;
        a.click();
      }
      // Solta o blob depois que o navegador já leu (revogar na hora mata a aba).
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
    } catch (e: any) {
      alert(`Não consegui gerar o DANFE: ${e?.message || e}`);
    } finally {
      setDanfeBaixando(null);
    }
  };

  const abrirCredito = (r: ReportLinha) => {
    setCreditoAlvo(r);
    setCreditoErro(null);
    setCreditoValor(
      r.valorSugerido ? Number(r.valorSugerido).toFixed(2).replace('.', ',') : '',
    );
  };
  const confirmarCredito = async () => {
    if (!creditoAlvo) return;
    // pt-BR: vírgula é o decimal. Sem vírgula, ponto vale como decimal
    // ("89.90" = 89,90) — senão 89.90 virava 8990.
    const t = creditoValor.trim();
    const valor = t
      ? Number(t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t)
      : Number(creditoAlvo.valorSugerido || 0);
    if (!Number.isFinite(valor) || valor <= 0) {
      setCreditoErro('Digite o valor do crédito.');
      return;
    }
    setCreditoBusy(true);
    setCreditoErro(null);
    try {
      const resp = await api<any>(`/pick-orders/item-reports/${creditoAlvo.id}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ modo: 'credito', valor }),
      });
      setItemReports((prev) => prev.filter((x) => x.id !== creditoAlvo.id));
      setCreditoAlvo(null);
      loadCreditos();
      const code = resp?.credito?.code;
      const tel = creditoAlvo.cliente?.telefone;
      // O código só serve se chegar na cliente — o WhatsApp já sai escrito.
      if (code && tel && confirm(`Crédito ${code} de ${fmtMoney(valor)} emitido.\n\nMandar no WhatsApp da cliente agora?`)) {
        abrirWhatsApp(
          tel,
          `Oi${creditoAlvo.cliente?.nome ? ` ${String(creditoAlvo.cliente.nome).split(' ')[0]}` : ''}! ` +
            `Sobre o seu pedido ${creditoAlvo.cliente?.pedidoNumero ?? ''}: uma peça não veio, e a gente já deixou ` +
            `um crédito de ${fmtMoney(valor)} no seu nome 💜\n\n` +
            `Código: ${code}\n\n` +
            `Ele NÃO TEM PRAZO pra usar e vale no site (lurds.com.br) ou em qualquer uma das nossas lojas. ` +
            `É só apresentar esse código na hora de pagar.`,
        );
      }
    } catch (e: any) {
      setCreditoErro(e?.message || 'Não consegui emitir o crédito.');
      loadItemReports();
    } finally {
      setCreditoBusy(false);
    }
  };
  // ── JUNTADA (21/08): pedido dividido com loja ÂNCORA ──
  // As lojas feeder mandam caixa pra âncora e SÓ ela envia o pacote único.
  const [juntada, setJuntada] = useState<JuntadaInfo | null>(null);
  const [juntarOpen, setJuntarOpen] = useState(false);
  const [juntarBusy, setJuntarBusy] = useState<string | null>(null);
  const [juntarErro, setJuntarErro] = useState<string | null>(null);
  const [desfazendoJuntada, setDesfazendoJuntada] = useState(false);
  const loadJuntada = () => {
    if (!wcId) return;
    api<JuntadaInfo>(`/orders/wc/${wcId}/juntada`)
      .then((d) => setJuntada(d ?? { juntando: false }))
      .catch(() => {});
  };

  // ── RAIO-X + LINHA DO TEMPO (26/08 — contrato do dono) ──────────────────
  // ON-000106/LP-000244: o estado do pedido mora em 5 tabelas e ninguém via o
  // todo — Campinas foi cobrada por não enviar o que já tinha postado. Aqui a
  // tela mostra ONDE cada peça está AGORA e TUDO que aconteceu, com QUEM.
  interface PecaRaioX {
    orderItemId: string;
    sku: string;
    ref: string | null;
    cor: string | null;
    tamanho: string | null;
    quantity: number;
    unitPrice: number | null;
    estado: string;
    onde: string;
    cor_semaforo: 'vermelho' | 'amarelo' | 'verde';
    storeCode: string | null;
    storeName: string | null;
    trackingCode: string | null;
  }
  interface EventoLT {
    em: string;
    quem: string | null;
    tipoAtor: string;
    origem: string;
    titulo: string;
    detalhe: string | null;
  }
  const [raiox, setRaiox] = useState<{
    pecas: PecaRaioX[];
    eventos: EventoLT[];
    alertas: string[];
  } | null>(null);
  const loadRaiox = () => {
    if (!wcId) return;
    api<any>(`/orders/wc/${wcId}/linha-do-tempo`)
      .then((r) => setRaiox(r?.found ? { pecas: r.pecas ?? [], eventos: r.eventos ?? [], alertas: r.alertas ?? [] } : null))
      .catch(() => setRaiox(null));
  };

  // ── VERIFICAÇÃO MANUAL DO PEDIDO CARO (27/08) ───────────────────────────
  // Registra no histórico QUEM falou com a cliente. Nota (não status): o
  // pedido não muda de fase por causa da conferência, e a linha do tempo já
  // lê `orderHistory` — então o carimbo sobrevive ao F5 sem tabela nova.
  const [conferindo, setConferindo] = useState(false);
  async function marcarConferido() {
    if (!wcId) return;
    setConferindo(true);
    try {
      await api(`/orders/wc/${wcId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          addNote: {
            text: 'VERIFICACAO MANUAL: falei com a cliente e confirmei os dados do pedido.',
            notifyCustomer: false,
          },
        }),
      });
      setFlash('Verificação registrada no histórico do pedido.');
      setTimeout(() => setFlash(null), 6000);
      loadRaiox();
    } catch (e: any) {
      setError(e?.message || 'Não deu pra registrar a verificação.');
    } finally {
      setConferindo(false);
    }
  }

  // ── CANCELAR UMA PEÇA E DEVOLVER O VALOR (26/08 — "e a peça que faltou?").
  // As duas saídas da peça vermelha: outra loja envia (2º frete, modal do
  // Mover) OU cancela SÓ esta peça e devolve o dinheiro dela. Motivo
  // obrigatório — mesma régua do cancelamento de pedido.
  const [cancelarPeca, setCancelarPeca] = useState<PecaRaioX | null>(null);
  const [cancelarMotivo, setCancelarMotivo] = useState('');
  const [cancelarBusy, setCancelarBusy] = useState(false);
  const [cancelarErro, setCancelarErro] = useState<string | null>(null);
  async function confirmarCancelarPeca() {
    if (!cancelarPeca) return;
    setCancelarBusy(true);
    setCancelarErro(null);
    try {
      const r = await api<{ ok: boolean; valorEstornar: number; peca?: string }>(
        `/orders/wc/${wcId}/cancelar-peca`,
        { method: 'POST', body: JSON.stringify({ orderItemId: cancelarPeca.orderItemId, motivo: cancelarMotivo.trim() }) },
      );
      setCancelarPeca(null);
      setCancelarMotivo('');
      setFlash(
        `✂ Peça cancelada. 🔴 ESTORNE R$ ${Number(r.valorEstornar ?? 0).toFixed(2)} pra cliente no gateway — o pedido segue com as outras peças.`,
      );
      setTimeout(() => setFlash(null), 12000);
      loadRaiox();
      api<typeof liveStatus>(`/pick-orders/by-wc/${wcId}`)
        .then((data) => setLiveStatus(Array.isArray(data) ? data : []))
        .catch(() => {});
    } catch (e: any) {
      setCancelarErro(e?.body?.message || e?.message || 'Não deu pra cancelar a peça.');
    } finally {
      setCancelarBusy(false);
    }
  }

  // ── MOVER UMA PEÇA DE LOJA (26/08) ──────────────────────────────────────
  // "↔ Trocar loja" move o CARD INTEIRO. No LP-000244 a loja tinha 2 das 3
  // peças e faltava só uma: trocar o card mandou as três juntas pra loja
  // seguinte, que recusou pela MESMA peça e devolveu as outras duas de novo —
  // três rodadas em 21 horas. Aqui a unidade é a peça.
  const [moverPeca, setMoverPeca] = useState<{
    item: { id: string; sku: string; ref?: string | null; cor?: string | null; tamanho?: string | null; descricao?: string | null };
    fromStoreCode: string | null;
    fromStoreName: string | null;
    totalNoCard: number;
  } | null>(null);
  const [moverOpcoes, setMoverOpcoes] = useState<Array<{
    storeCode: string; storeName: string; qty: number; jaNoPedido: boolean; reportou: boolean;
  }>>([]);
  const [moverLoading, setMoverLoading] = useState(false);
  const [moverBusy, setMoverBusy] = useState<string | null>(null);
  const [moverErro, setMoverErro] = useState<string | null>(null);

  /**
   * Abre a escolha de loja PRA UMA PEÇA. A lista mostra TODAS as lojas ativas
   * com o saldo DAQUELA peça — inclusive as zeradas, marcadas de vermelho.
   * Esconder as zeradas seria pior: no LP-000244 a peça foi forçada na mão pra
   * três lojas seguidas com saldo 0, e a tela não dizia isso em lugar nenhum.
   */
  async function abrirMoverPeca(
    item: { id: string; sku: string; ref?: string | null; cor?: string | null; tamanho?: string | null; descricao?: string | null },
    card: { storeCode: string | null; storeName: string | null; total: number },
  ) {
    setMoverPeca({ item, fromStoreCode: card.storeCode, fromStoreName: card.storeName, totalNoCard: card.total });
    setMoverOpcoes([]);
    setMoverErro(null);
    setMoverLoading(true);
    try {
      const [stores, preview] = await Promise.all([
        api<Array<{ code: string; name: string; active: boolean }>>('/stores'),
        api<SeparationPreview>(`/orders/wc/${wcId}/prepare-separation`),
      ]);
      const saldo = new Map(
        (preview.alternativesBySku?.[item.sku] ?? []).map((a) => [a.storeCode, a.availableQty ?? 0]),
      );
      const reportou = new Set(
        liveStatus.filter((p) => p.issueReason && p.storeCode).map((p) => p.storeCode as string),
      );
      const noPedido = new Set(
        liveStatus
          .filter((p) => ['new', 'separating', 'separated', 'ready'].includes(p.status))
          .map((p) => p.storeCode)
          .filter(Boolean) as string[],
      );
      setMoverOpcoes(
        stores
          .filter((s) => s.active && s.code !== card.storeCode)
          .map((s) => ({
            storeCode: s.code,
            storeName: s.name,
            qty: saldo.get(s.code) ?? 0,
            jaNoPedido: noPedido.has(s.code),
            reportou: reportou.has(s.code),
          }))
          // Loja que JÁ está no pedido primeiro (não cria caixa nova), depois saldo.
          .sort((a, b) =>
            Number(b.jaNoPedido) - Number(a.jaNoPedido) || b.qty - a.qty || a.storeCode.localeCompare(b.storeCode),
          ),
      );
    } catch (e: any) {
      setMoverErro(e?.body?.message || e?.message || 'Não deu pra carregar o saldo das lojas.');
    } finally {
      setMoverLoading(false);
    }
  }

  async function moverPecaPara(storeCode: string) {
    if (!moverPeca) return;
    setMoverBusy(storeCode);
    setMoverErro(null);
    try {
      const res = await api<{ ok: boolean; avisoJuntada?: string | null; cardsRemovidos?: string[] }>(
        `/orders/wc/${wcId}/mover-itens`,
        { method: 'POST', body: JSON.stringify({ orderItemIds: [moverPeca.item.id], toStoreCode: storeCode }) },
      );
      const peca = [moverPeca.item.ref || moverPeca.item.sku, [moverPeca.item.cor, moverPeca.item.tamanho].filter(Boolean).join(' ')]
        .filter(Boolean)
        .join(' ');
      setMoverPeca(null);
      setFlash(
        `✓ ${peca} → ${storeCode}` +
          (res.cardsRemovidos?.length ? ` · card ${res.cardsRemovidos.join('/')} ficou vazio e saiu` : ''),
      );
      setTimeout(() => setFlash(null), 8000);
      const fresh = await api<typeof liveStatus>(`/pick-orders/by-wc/${wcId}`).catch(() => []);
      setLiveStatus(Array.isArray(fresh) ? fresh : []);
      loadJuntada(); loadRaiox();
      if (res.avisoJuntada) setSepError(`🧲 ${res.avisoJuntada}`);
    } catch (e: any) {
      setMoverErro(e?.body?.message || e?.message || 'Não deu pra mover a peça.');
    } finally {
      setMoverBusy(null);
    }
  }

  const resolverItemReport = async (id: string) => {
    setResolvendoReport(id);
    try {
      await api(`/pick-orders/item-reports/${id}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ modo: 'reembolso' }),
      });
      setItemReports((prev) => prev.filter((r) => r.id !== id));
    } catch {
      loadItemReports();
    } finally {
      setResolvendoReport(null);
    }
  };

  useEffect(() => { load(); /* eslint-disable-line */ }, [wcId]);

  // Carrega pick-orders atuais desse pedido WC quando a página abre
  useEffect(() => {
    if (!wcId) return;
    api<typeof liveStatus>(`/pick-orders/by-wc/${wcId}`)
      .then((data) => setLiveStatus(Array.isArray(data) ? data : []))
      .catch((e) => console.warn('Falha ao carregar pick-orders:', e?.message));
    loadItemReports();
    loadCreditos();
    loadJuntada(); loadRaiox();
    loadTrocas();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      // A feeder que finaliza a bipagem faz a CAIXA da juntada nascer — o
      // evento de status é a deixa pra faixa "JUNTANDO PEÇAS" atualizar.
      loadJuntada(); loadRaiox();
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
      loadItemReports(); // re-rotear pode ter dado destino à peça reportada
      loadJuntada(); loadRaiox();
    };
    const onNew = () => {
      // Idem — pick-order novo apareceu (recalcular ou primeira confirmação)
      api<typeof liveStatus>(`/pick-orders/by-wc/${wcId}`)
        .then((data) => setLiveStatus(Array.isArray(data) ? data : []))
        .catch(() => {});
      loadItemReports();
      loadJuntada(); loadRaiox();
    };
    // Reporte novo (do card inteiro OU por peça) — atualiza o banner na hora.
    const onIssue = () => loadItemReports();
    socket.on('pick-order:status', onStatus);
    socket.on('pick-order:removed', onRemoved);
    socket.on('pick-order:new', onNew);
    socket.on('pick-order:issue', onIssue);
    return () => {
      socket.off('pick-order:status', onStatus);
      socket.off('pick-order:removed', onRemoved);
      socket.off('pick-order:new', onNew);
      socket.off('pick-order:issue', onIssue);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  /**
   * Depois da troca aplicada: só RECARREGA a tela.
   *
   * O re-roteio NÃO é mais chamado daqui (era, até 21/08 de manhã): quem
   * troca a peça agora é o `swap-item`, e ele já cancela os cards antigos e
   * roteia de novo por dentro. Chamar `recalculate-separation` outra vez
   * cancelaria o card recém-criado e estornaria bipe à toa.
   *
   * Quando a troca gera diferença A COBRAR, o backend deixa o pedido SEM
   * card de propósito — a separação fica travada até o dinheiro entrar, e é
   * o painel "Acertos da troca" que explica isso pra quem está olhando.
   */
  function aposTrocaDePeca() {
    void load();
    loadTrocas();
    loadItemReports();
    loadJuntada(); loadRaiox();
    api<typeof liveStatus>(`/pick-orders/by-wc/${wcId}`)
      .then((data) => setLiveStatus(Array.isArray(data) ? data : []))
      .catch(() => {});
    setFlash('✓ Peça trocada. Confira o acerto no painel abaixo dos itens.');
    setTimeout(() => setFlash(null), 6000);
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

      // Motivo do cancelamento vai em campo PRÓPRIO: o backend o exige e o
      // grava no histórico junto com quem clicou.
      if (cancelReason.trim()) body.cancelReason = cancelReason.trim();

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

      if (resp.warning) {
        // O backend já explica o que houve (motivo obrigatório, pedido já
        // despachado...). Culpar o WooCommerce em toda recusa mandava a
        // operação caçar plugin quando a trava era daqui mesmo.
        setError(`⚠ ${resp.warning}`);
      } else if (resp.statusApplied === false) {
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
      setCancelReason('');
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
  /**
   * "A loja vendedora já entregou" — conserta venda online roteada errado.
   *
   * Caso ON-000004 (Suzano, 15/08): a loja vendeu, mandou de motoboy pra cliente
   * a 20 km e o pedido foi roteado pra SOROCABA (150 km) separar uma SEGUNDA
   * peça, com o estoque de Suzano fantasma. O backend cancela o card indevido,
   * baixa o estoque na loja que vendeu e fecha o pedido.
   */
  async function fecharNaLojaVendedora() {
    const nome = order?.origemLoja?.name ?? 'a loja vendedora';
    if (
      !confirm(
        `Confirmar que ${nome} JÁ ENTREGOU esta venda pra cliente?\n\n` +
          `• o estoque da peça baixa em ${nome} (é de lá que ela saiu)\n` +
          `• os cards de separação em aberto são cancelados\n` +
          `• o pedido fecha como ENVIADO\n\n` +
          `Só confirme se a peça realmente saiu dessa loja.`,
      )
    )
      return;
    setFecharLoading(true);
    setFecharErro(null);
    try {
      const res = await api<{
        ok: boolean;
        alreadyDone?: boolean;
        message?: string;
        storeName?: string;
        pecasBaixadas?: number;
        cardsCancelados?: number;
      }>(`/orders/wc/${wcId}/fechar-na-loja-vendedora`, { method: 'POST' });
      if (!res.ok) {
        setFecharErro(res.message ?? 'Não foi possível fechar o pedido.');
        return;
      }
      await load();
      const fresh = await api<typeof liveStatus>(`/pick-orders/by-wc/${wcId}`).catch(() => []);
      setLiveStatus(Array.isArray(fresh) ? fresh : []);
    } catch (e: any) {
      setFecharErro(e?.message || 'Falha ao fechar o pedido na loja vendedora.');
    } finally {
      setFecharLoading(false);
    }
  }

  /** Abre o painel de troca de entrega já com a lista de lojas ativas. */
  async function abrirTrocaEntrega() {
    setEntregaErro(null);
    setTrocandoEntrega(true);
    if (entregaLojas.length === 0) {
      try {
        const lojas = await api<Array<{ code: string; name: string; active: boolean }>>('/stores');
        setEntregaLojas(
          (Array.isArray(lojas) ? lojas : [])
            .filter((s) => s.active)
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((s) => ({ code: s.code, name: s.name })),
        );
      } catch (e: any) {
        setEntregaErro(e?.message || 'Não consegui carregar as lojas.');
      }
    }
  }

  /**
   * Troca a forma de entrega do pedido. Retirada exige a loja onde a cliente
   * busca; motoboy aceita a loja que manda (opcional). O backend re-roteia:
   * apaga cards ativos e recalcula, ou roteia na hora quando trava numa loja.
   */
  async function salvarTrocaEntrega() {
    if (entregaNova === 'retirada' && !entregaLoja) {
      setEntregaErro('Escolha a loja onde a cliente vai retirar.');
      return;
    }
    setEntregaBusy(true);
    setEntregaErro(null);
    try {
      const res = await api<{
        ok: boolean;
        shippingMethod: string;
        roteamento?: { acao: string; ok?: boolean; detalhe?: string | null };
        /** Etiqueta já gerada com a entrega ANTIGA — precisa Reabrir. */
        aviso?: string | null;
      }>(`/orders/wc/${wcId}/entrega`, {
        method: 'PATCH',
        body: JSON.stringify({ tipo: entregaNova, storeCode: entregaLoja || null }),
      });
      setTrocandoEntrega(false);
      await load();
      const fresh = await api<typeof liveStatus>(`/pick-orders/by-wc/${wcId}`).catch(() => []);
      setLiveStatus(Array.isArray(fresh) ? fresh : []);
      const r = res.roteamento;
      if (r && r.acao !== 'nenhuma' && r.ok === false) {
        setSepError(`Entrega trocada pra ${res.shippingMethod}, mas o roteamento não foi: ${r.detalhe || 'sem detalhe'}. Use "Recalcular separação".`);
      } else if (res.aviso) {
        // Trocar o pedido não troca o papel que já saiu da impressora.
        setSepError(`Entrega trocada pra ${res.shippingMethod}. ${res.aviso}`);
      }
    } catch (e: any) {
      setEntregaErro(e?.message || 'Falha ao trocar a entrega.');
    } finally {
      setEntregaBusy(false);
    }
  }

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
      setPreferredStoreCode(null);
      setOverrides({});
      setSplitApproved(false); // reset gate a cada novo preview
      // Gerar/recalcular volta pra sugestão automática — troca manual zera
      setPreviewExcludes([]);
      setPreviewPins([]);
      setPreviewSwapTarget(null);
    } catch (e: any) {
      setSepError(e.message);
    } finally {
      setSepLoading(false);
    }
  }

  /**
   * "Recalcular automático" do banner de PROBLEMA: re-roteia SÓ os pick-orders
   * das lojas que reportaram issue (swap cirúrgico via pickOrderId, um a um).
   * As outras lojas do pedido — inclusive as que JÁ ENVIARAM — não são tocadas.
   * Bug real 13/07: o botão recalculava o pedido INTEIRO e "trocava tudo".
   */
  async function recalcularLojasComProblema() {
    const issues = liveStatus.filter((r) => r.issueReason && r.id);
    if (!issues.length) return;
    const nomes = issues.map((r) => `${r.storeName || r.storeCode}`).join(', ');
    if (!confirm(
      `Re-rotear SÓ as peças de: ${nomes}?\n\n` +
      `O sistema escolhe outra loja automaticamente (excluindo a que reportou o problema). ` +
      `As demais lojas deste pedido NÃO são tocadas.`,
    )) return;
    setSepLoading(true);
    setSepError(null);
    try {
      const resumo: string[] = [];
      for (const r of issues) {
        const res = await api<{
          ok: boolean;
          message?: string;
          pickOrders?: Array<{ storeCode: string }>;
          newStoreCode?: string;
        }>(`/orders/wc/${wcId}/recalculate-separation`, {
          method: 'POST',
          body: JSON.stringify({ pickOrderId: r.id }),
        });
        if (res.ok) {
          const destino = res.newStoreCode || res.pickOrders?.map((p) => p.storeCode).join('+') || 'nova loja';
          resumo.push(`${r.storeCode} → ${destino}`);
        } else {
          resumo.push(`${r.storeCode}: ${res.message || 'nenhuma loja com estoque'}`);
        }
      }
      setFlash(`✓ ${resumo.join(' · ')}`);
      setTimeout(() => setFlash(null), 6000);
      api<typeof liveStatus>(`/pick-orders/by-wc/${wcId}`)
        .then((data) => setLiveStatus(Array.isArray(data) ? data : []))
        .catch(() => {});
    } catch (e: any) {
      setSepError(e?.message || 'Falha ao re-rotear a loja com problema.');
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
  /**
   * Remove um pick-order específico (loja resolvida manualmente).
   * Tira o card da loja problemática + os items dela ficam órfãos
   * (a retaguarda já resolveu fora do sistema). Não mexe nas outras lojas.
   */
  async function removerPickOrder(pickOrderId: string, storeCode: string, storeName: string | null) {
    const displayName = storeName || storeCode;
    if (!confirm(
      `Remover ${displayName} (${storeCode}) deste pedido?\n\n` +
      `Use isso quando você JÁ resolveu o problema manualmente em outra loja ` +
      `(ex: cliente pegou na outra) e só quer limpar o card aqui.\n\n` +
      `As outras lojas do pedido NÃO são afetadas.`,
    )) return;

    setSepLoading(true);
    setSepError(null);
    try {
      const res = await api<{
        ok: boolean;
        pickOrderId: string;
        storeCode: string;
        storeName: string;
        itemsLiberados: number;
      }>(`/pick-orders/${pickOrderId}`, { method: 'DELETE' });

      if (!res.ok) {
        setSepError('Não foi possível remover o pick-order.');
        return;
      }
      setFlash(`✓ ${storeCode} removida do pedido. ${res.itemsLiberados} item(ns) liberado(s).`);
      setTimeout(() => setFlash(null), 5000);
      // Recarrega painel ao vivo
      api<typeof liveStatus>(`/pick-orders/by-wc/${wcId}`)
        .then((data) => setLiveStatus(Array.isArray(data) ? data : []))
        .catch(() => {});
    } catch (e: any) {
      setSepError(e?.message || 'Falha ao remover pick-order');
    } finally {
      setSepLoading(false);
    }
  }

  /**
   * Click no botão "↔ Trocar loja" de um card específico.
   * Em vez do confirm() simples (que tentava re-rotear automático), agora
   * abre o modal "Escolher loja manualmente" — vendedora vê TODAS as lojas
   * (mesmo sem estoque) e escolhe livremente. Faz swap cirúrgico via
   * pickOrderId, deixa as outras lojas intocadas.
   */
  /**
   * Troca a loja escolhida no preview (single-store) antes de confirmar.
   * Refaz GET prepare-separation com ?preferStoreCode=XX — o backend força essa
   * loja se ela cobrir tudo. Não cria pick-order ainda — só atualiza o preview
   * pra o admin revisar antes de clicar "Confirmar e enviar pras lojas".
   */
  async function switchPreferredStore(newStoreCode: string | null) {
    if (switchingStore) return;
    setSwitchingStore(true);
    setSepError(null);
    try {
      const params = new URLSearchParams();
      if (newStoreCode) params.set('preferStoreCode', newStoreCode);
      // Preserva trocas manuais já aplicadas no preview
      if (previewExcludes.length) params.set('excludeStoreCodes', previewExcludes.join(','));
      if (previewPins.length) params.set('pinStoreCodes', previewPins.join(','));
      const qs = params.toString();
      const url = `/orders/wc/${wcId}/prepare-separation${qs ? `?${qs}` : ''}`;
      const res = await api<SeparationPreview>(url);
      setSeparation(res);
      setPreferredStoreCode(newStoreCode);
      setSplitApproved(false);
    } catch (e: any) {
      setSepError(e?.message || 'Falha ao trocar loja');
    } finally {
      setSwitchingStore(false);
    }
  }

  function swapStore(storeCode: string, storeName: string | null) {
    const targetPickOrder = liveStatus.find((p) => p.storeCode === storeCode);
    if (!targetPickOrder) {
      // Ainda é PREVIEW (nenhum card criado): troca manual refaz a sugestão
      // excluindo esta loja e fixando a escolhida — nada é enviado pra loja.
      const group = separation?.groups.find((g) => g.storeCode === storeCode);
      const pTarget = {
        storeCode,
        storeName,
        skus: (group?.items ?? []).map((it) => it.sku),
      };
      setSwapTarget(null);
      setPreviewSwapTarget(pTarget);
      // Passa o alvo por parâmetro: o setState acima ainda não refletiu no
      // closure desta render — ler o estado aqui pegaria o valor velho.
      openPickStoreModal({ previewSwap: pTarget });
      return;
    }
    const sTarget = {
      pickOrderId: targetPickOrder.id,
      fromStoreCode: storeCode,
      fromStoreName: storeName,
      fromStatus: targetPickOrder.status,
    };
    setPreviewSwapTarget(null);
    setSwapTarget(sTarget);
    openPickStoreModal({ swap: sTarget });
  }

  /**
   * Aplica a troca manual NO PREVIEW: refaz o prepare-separation excluindo a
   * loja rejeitada e fixando (pin) a escolhida. Nada é criado/enviado — o
   * operador revisa o novo preview e clica em "Confirmar e enviar pras lojas",
   * que manda as mesmas listas pro backend.
   */
  async function applyPreviewSwap(pickedCode: string, pickedName: string) {
    const from = previewSwapTarget;
    if (!from) return;
    if (pickedCode === from.storeCode) {
      setPickStoreOpen(false);
      setPreviewSwapTarget(null);
      return;
    }
    if (!confirm(
      `Trocar ${from.storeName || from.storeCode} por ${pickedName} (${pickedCode}) na sugestão?\n\n` +
      `O sistema refaz a divisão SEM ${from.storeCode}, priorizando ${pickedCode} nas peças ` +
      `que ela tem em estoque.\n\n` +
      `Nada é enviado pras lojas ainda — revise o resultado e clique em ` +
      `"Confirmar e enviar pras lojas".`,
    )) return;

    setPickStoreApplying(pickedCode);
    setPickStoreError(null);
    try {
      const excludes = Array.from(new Set([...previewExcludes, from.storeCode]))
        .filter((c) => c !== pickedCode);
      const pins = Array.from(
        new Set([...previewPins.filter((c) => c !== from.storeCode), pickedCode]),
      ).filter((c) => !excludes.includes(c));

      const params = new URLSearchParams();
      if (excludes.length) params.set('excludeStoreCodes', excludes.join(','));
      if (pins.length) params.set('pinStoreCodes', pins.join(','));
      const res = await api<SeparationPreview>(
        `/orders/wc/${wcId}/prepare-separation?${params.toString()}`,
      );
      setSeparation(res);
      setPreviewExcludes(excludes);
      setPreviewPins(pins);
      setPreferredStoreCode(null);
      setSplitApproved(false);
      setPickStoreOpen(false);
      setPreviewSwapTarget(null);
      setFlash(`✓ Sugestão refeita: ${from.storeCode} → ${pickedCode}. Revise e confirme.`);
      setTimeout(() => setFlash(null), 5000);
    } catch (e: any) {
      setPickStoreError(e?.message || 'Falha ao refazer o preview com a troca.');
    } finally {
      setPickStoreApplying(null);
    }
  }

  /** Desfaz TODAS as trocas manuais do preview e volta pra sugestão automática. */
  async function desfazerTrocaManual() {
    setSepLoading(true);
    setSepError(null);
    try {
      const res = await api<SeparationPreview>(`/orders/wc/${wcId}/prepare-separation`);
      setSeparation(res);
      setPreviewExcludes([]);
      setPreviewPins([]);
      setPreviewSwapTarget(null);
      // Zera o radio também — senão o confirm mandava um preferStoreCode que
      // o preview desfeito já não mostra.
      setPreferredStoreCode(null);
      setSplitApproved(false);
    } catch (e: any) {
      setSepError(e?.message || 'Falha ao voltar pra sugestão automática.');
    } finally {
      setSepLoading(false);
    }
  }

  /**
   * JUNTADA MANUAL: marca a loja âncora — as outras lojas do pedido viram
   * feeder (isTransfer) e mandam caixa pra ela; só a âncora envia pra cliente.
   * O backend só aceita loja que já tem card ativo neste pedido.
   */
  async function aplicarJuntada(anchorStoreCode: string, anchorStoreName: string | null) {
    const nome = anchorStoreName || anchorStoreCode;
    if (!confirm(
      `Juntar o pedido na LOJA ${nome}?\n\n` +
      `As outras lojas mandam as peças pra ela (caixa com NF de transferência + ` +
      `etiqueta pra loja, ou carro da rede no litoral) e SÓ ${nome} envia o ` +
      `pacote pra cliente.`,
    )) return;
    setJuntarBusy(anchorStoreCode);
    setJuntarErro(null);
    try {
      const res = await api<{
        caixasDesalinhadas?: Array<{ code: string; toStoreName: string | null; toStoreCode: string; trackingCode: string | null }>;
      }>(`/orders/wc/${wcId}/juntar`, {
        method: 'POST',
        body: JSON.stringify({ anchorStoreCode }),
      });
      setJuntarOpen(false);
      setFlash(`🧲 Juntada criada — as peças se encontram em ${nome} e saem num pacote só.`);
      setTimeout(() => setFlash(null), 5000);
      // Caixa que JÁ saiu pra âncora antiga não muda de rota sozinha — a
      // etiqueta impressa continua com o endereço velho.
      if (res?.caixasDesalinhadas?.length) {
        setSepError(
          `🚚 ${res.caixasDesalinhadas
            .map((c) => `${c.code} já está a caminho da ${c.toStoreName || c.toStoreCode}${c.trackingCode ? ` (${c.trackingCode})` : ''}`)
            .join(' · ')} — essa caixa NÃO muda de destino. Combine com a loja pra reencaminhar pra ${nome}.`,
        );
      }
      loadJuntada(); loadRaiox();
      api<typeof liveStatus>(`/pick-orders/by-wc/${wcId}`)
        .then((data) => setLiveStatus(Array.isArray(data) ? data : []))
        .catch(() => {});
    } catch (e: any) {
      // BadRequest do backend já vem com a mensagem pronta pra mostrar
      setJuntarErro(e?.body?.message || e?.message || 'Falha ao juntar o pedido.');
    } finally {
      setJuntarBusy(null);
    }
  }

  /** Desfaz a juntada — o backend recusa se alguma caixa já nasceu. */
  async function desfazerJuntada() {
    if (!confirm('Desfazer a juntada? Cada loja volta a enviar direto pra cliente.')) return;
    setDesfazendoJuntada(true);
    try {
      await api(`/orders/wc/${wcId}/juntar/desfazer`, { method: 'POST' });
      setFlash('✓ Juntada desfeita — cada loja envia direto pra cliente.');
      setTimeout(() => setFlash(null), 5000);
      loadJuntada(); loadRaiox();
      api<typeof liveStatus>(`/pick-orders/by-wc/${wcId}`)
        .then((data) => setLiveStatus(Array.isArray(data) ? data : []))
        .catch(() => {});
    } catch (e: any) {
      setSepError(e?.body?.message || e?.message || 'Não deu pra desfazer a juntada.');
    } finally {
      setDesfazendoJuntada(false);
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
  async function openPickStoreModal(alvo?: {
    swap?: { pickOrderId: string; fromStoreCode: string; fromStoreName: string | null; fromStatus: string };
    previewSwap?: { storeCode: string; storeName: string | null; skus: string[] };
  }) {
    // Alvo recém-setado chega por parâmetro (setState não reflete no closure
    // da mesma render); sem parâmetro, usa o estado (reaberturas, modo geral).
    const swapAlvo = alvo?.swap ?? swapTarget;
    const previewAlvo = alvo?.swap ? null : (alvo?.previewSwap ?? previewSwapTarget);
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
      // O swap APAGA o card reportado — e o issueReason morre junto: quem já
      // negou voltava a aparecer "limpa" e recebia o card DE NOVO (Suzano no
      // ON-000110/162, minutos depois de gritar "não temos"). O histórico da
      // linha do tempo é quem lembra ("Loja 17 reportou problema/a peça...").
      (raiox?.eventos ?? []).forEach((ev) => {
        const m = /\bLoja\s+(\w+)\s+reportou\b/i.exec(`${ev.titulo} ${ev.detalhe ?? ''}`);
        if (m) issueCodes.add(m[1]);
      });

      // Set de SKUs do pedido (inferido do groups + missing + alternativesBySku)
      const allSkus = new Set<string>();
      preview.groups.forEach((g) => g.items.forEach((it) => allSkus.add(it.sku)));
      preview.missing.forEach((m) => allSkus.add(m.sku));
      Object.keys(preview.alternativesBySku ?? {}).forEach((sku) => allSkus.add(sku));

      // MODO SWAP (14/07): "Trocar loja" de UM pick-order considera SÓ os SKUs
      // DAQUELA loja — não o pedido inteiro. Sem isso a cobertura "cobre X/9"
      // contava contra TODOS os itens do pedido (inclusive os de outra loja que
      // nem vão mudar), e uma loja que cobre 100% do que será trocado aparecia
      // como "⚠ cobre 6/9". Fallback: sem os SKUs da loja, usa o pedido inteiro.
      let relevantSkus = allSkus;
      if (swapAlvo?.pickOrderId) {
        const po = liveStatus.find((p) => p.id === swapAlvo.pickOrderId);
        const swapSkus = (po?.skus ?? []).filter((s) => allSkus.has(s));
        if (swapSkus.length) relevantSkus = new Set(swapSkus);
      } else if (previewAlvo) {
        // Troca no PREVIEW: cobertura medida só contra os SKUs do grupo trocado.
        const swapSkus = previewAlvo.skus.filter((s) => allSkus.has(s));
        if (swapSkus.length) relevantSkus = new Set(swapSkus);
      }

      // Quantidades pedidas (pra comparar com availableQty)
      const qtyBySku = new Map<string, number>();
      preview.groups.forEach((g) => g.items.forEach((it) => {
        qtyBySku.set(it.sku, (qtyBySku.get(it.sku) ?? 0) + it.quantity);
      }));
      preview.missing.forEach((m) => {
        qtyBySku.set(m.sku, (qtyBySku.get(m.sku) ?? 0) + m.quantity);
      });

      // Cobertura por loja, escopada aos relevantSkus. Uma passagem só: monta o
      // conjunto de SKUs cobertos por loja (group assignee + alternativa com
      // estoque suficiente) e deriva skusCovered/missing/totalQty dele.
      const skusArr = Array.from(relevantSkus);
      const byStore = new Map<string, { skusCovered: number; totalQty: number; reservedQty: number; missing: string[] }>();
      for (const s of activeStores) {
        const code = s.code;
        const covered = new Set<string>();
        let totalQty = 0;
        // Peças que a loja TEM mas já estão prometidas a card de outro pedido —
        // o backend já tirou elas do availableQty; aqui é só pra tela poder
        // dizer POR QUE a loja aparece com menos do que a Consulta mostra.
        let reservedQty = 0;
        preview.groups.filter((g) => g.storeCode === code).forEach((g) =>
          g.items.forEach((it) => {
            if (relevantSkus.has(it.sku) && !covered.has(it.sku)) {
              covered.add(it.sku);
              totalQty += it.quantity;
            }
          }),
        );
        Object.entries(preview.alternativesBySku ?? {}).forEach(([sku, alts]) => {
          if (!relevantSkus.has(sku)) return;
          const alt = alts.find((a) => a.storeCode === code);
          if (!alt) return;
          reservedQty += alt.reservedQty ?? 0;
          if (covered.has(sku)) return;
          const need = qtyBySku.get(sku) ?? 1;
          if (alt.availableQty >= need) {
            covered.add(sku);
            totalQty += alt.availableQty;
          }
        });
        byStore.set(code, {
          skusCovered: covered.size,
          totalQty,
          reservedQty,
          missing: skusArr.filter((sku) => !covered.has(sku)),
        });
      }

      const candidates = activeStores
        .map((s) => {
          const rec = byStore.get(s.code) ?? { skusCovered: 0, totalQty: 0, reservedQty: 0, missing: [] };
          return {
            id: s.id,
            code: s.code,
            name: s.name,
            city: s.city,
            state: s.state,
            active: s.active,
            skusCovered: rec.skusCovered,
            skusTotal: relevantSkus.size,
            totalQty: rec.totalQty,
            reservedQty: rec.reservedQty,
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
    // MODO PREVIEW: ainda não existe pick-order — a troca só refaz a sugestão.
    if (previewSwapTarget && !swapTarget) {
      await applyPreviewSwap(pickedCode, pickedName);
      return;
    }
    // Texto do confirm reflete o MODO: swap cirúrgico (só a loja de origem
    // muda) × recalculate total (pedido inteiro forçado pra loja escolhida).
    const msg = swapTarget
      ? `Trocar ${swapTarget.fromStoreCode} por ${pickedName} (${pickedCode})?\n\n` +
        `SÓ as peças que estavam com ${swapTarget.fromStoreCode} mudam de loja — ` +
        `as outras lojas deste pedido NÃO são tocadas. Se ${pickedCode} não ` +
        `tiver estoque, nada muda.`
      // O caminho `forceStoreCode` do backend cria o card com TODAS as peças
      // mesmo sem estoque (bypassa o routing). O texto antigo dizia que o
      // pedido "fica pending" se faltasse estoque — e era justo nessa hora
      // (ruptura) que a retaguarda precisava clicar. Assustava e travava.
      : `Mandar o pedido INTEIRO pra ${pickedName} (${pickedCode})?\n\n` +
        `O card nasce lá com TODAS as peças — inclusive as que ${pickedCode} ` +
        `não tem em estoque. Ela bipa o que estiver na arara; o que faltar ` +
        `precisa chegar por transferência antes de fechar.\n\n` +
        `As outras lojas saem do roteamento deste pedido.`;
    if (!confirm(msg)) return;

    setPickStoreApplying(pickedCode);
    setPickStoreError(null);
    try {
      const excludeCodes = allStoreCodes.filter((c) => c !== pickedCode);
      // Modo SWAP cirúrgico: passa pickOrderId — backend só mexe nesse pick-order
      // específico, deixa os outros (incluindo MOEMA enviado) intactos.
      // Modo RECALCULATE total: sem pickOrderId — recalcula tudo do pedido.
      const body: any = {
        excludeStoreCodes: excludeCodes,
        forceStoreCode: pickedCode,
      };
      if (swapTarget?.pickOrderId) {
        body.pickOrderId = swapTarget.pickOrderId;
      }
      const res = await api<{
        ok: boolean;
        reason?: string;
        message?: string;
        pickOrders?: Array<{ id: string; storeCode: string; storeName: string }>;
      }>(`/orders/wc/${wcId}/recalculate-separation`, {
        method: 'POST',
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        setPickStoreError(
          res.message || `Não deu pra forçar ${pickedCode}. Provavelmente não tem estoque suficiente.`,
        );
        return;
      }

      setPickStoreOpen(false);
      setSwapTarget(null);
      const acao = swapTarget
        ? `${swapTarget.fromStoreCode} trocada por ${pickedCode}`
        : `Pedido reatribuído pra ${pickedName} (${pickedCode})`;
      setFlash(`✓ ${acao}.`);
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
      }>(`/orders/wc/${wcId}/confirm-separation`, {
        method: 'POST',
        // Manda a loja escolhida no radio button (se houver) + as trocas
        // manuais do preview (excluídas/fixadas) — o backend re-roda o routing
        // no confirm, então sem essas listas a troca era desfeita na criação.
        body: JSON.stringify({
          preferStoreCode: preferredStoreCode || null,
          excludeStoreCodes: previewExcludes,
          pinStoreCodes: previewPins,
        }),
      });
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

  /** Abre a conversa no WhatsApp do PC e marca o pedido como "Separação". */
  async function sendWhatsapp(group: SeparationGroup) {
    if (!group.whatsapp) {
      alert(
        `A loja "${group.storeName}" não tem WhatsApp cadastrado. Vai em /lojas, edita a loja e salva o número.`,
      );
      return;
    }
    // App do PC (já logado) em vez de mais uma aba do Web — mesma rotina de
    // todo botão de WhatsApp do sistema. A conversa sai ANTES do PATCH: o que
    // depende do clique tem que sair no gesto síncrono.
    abrirWhatsApp(group.whatsapp, group.whatsappMessage);

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
        <Link href="/pedidos?status=processing" className="text-brand text-sm hover:underline flex items-center gap-1">
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
  // Está matando o pedido? Aí o motivo é obrigatório — mesma regra do backend.
  const cancelando = statusChanged && (status === 'cancelled' || status === 'refunded');
  const faltaMotivoCancelamento = cancelando && cancelReason.trim().length < 3;

  /**
   * PEÇAS × FRETE (14/08). O frete que a loja cobrou da cliente é uma linha
   * da VENDA (assim entra no caixa), não uma peça pra separar. O primeiro
   * pedido online mostrava "FRETE - ENVIO" no meio dos produtos e a
   * separação acusava "1 SKU sem estoque em nenhuma loja".
   */
  const ehLinhaFrete = (li: { sku?: string | null; ref?: string | null }) =>
    [li.sku, li.ref].some((v) => String(v ?? '').trim().toUpperCase() === 'FRETE');
  const pecasDoPedido = order.lineItems.filter((li) => !ehLinhaFrete(li));
  /**
   * "Trocar" em pedido nativo (item no Postgres) enquanto o pedido não morreu.
   * `completed` SAIU da lista (ordem do dono, 26/08: troca liberada a qualquer
   * tempo pra peça não enviada): o slug junta `shipped` e `delivered`, e num
   * pedido dividido a peça que ficou pra trás continua trocável mesmo com a
   * caixa da irmã na rua. Quem decide POR PEÇA é o backend (`troca-bloqueio`)
   * — o modal mostra o motivo exato quando a peça específica já saiu.
   */
  const podeTrocarItem =
    !!order.canEditItems && !['cancelled', 'refunded'].includes(status);

  /**
   * ONDE ESTÁ CADA PEÇA — agora no quadro PRINCIPAL (27/08, ordem do dono:
   * "temos dois quadros com as informações da peça").
   *
   * A tabela de peças que morava dentro do trilho repetia, linha por linha, o
   * que a tabela de ITENS já listava. Some de lá; o dado vem pra cá:
   * bolinha de estado + etiqueta da loja que separa, clicável pra trocar.
   */
  const pecaPorItem = (li: { id: number | string }) =>
    raiox?.pecas.find((p) => String(p.orderItemId) === String(li.id)) ?? null;

  /**
   * QUAL CARD ESTÁ COM ESTA PEÇA — lido dos próprios cards (27/08, ON-000176).
   *
   * O raio-x resolve a loja pelo carimbo `assignedStoreId` do item, que só
   * existe quando o roteamento DIVIDE o pedido. Em pedido de loja única a peça
   * fica sem carimbo, e a tela mostrava "escolher loja / Aguardando" ao lado de
   * um card que listava a mesma peça. O backend passou a cobrir esse caso, mas
   * a tela não pode depender só disso: o card é a fonte que ela já desenha.
   */
  const cardComAPeca = (li: { id: number | string; sku?: string }) =>
    liveStatus.find((r) =>
      (r.items ?? []).some(
        (it) =>
          (it.id && String(it.id) === String(li.id)) ||
          (!!li.sku && String(it.sku || '').trim() === String(li.sku || '').trim()),
      ),
    ) ?? null;

  /** Estado da peça em três cores — a mesma régua do Semáforo. */
  const estadoDaPeca = (
    p: PecaRaioX | null,
    /** Card que LISTA esta peça — manda mais que o carimbo do item. */
    cardDoItem?: (typeof liveStatus)[number] | null,
  ) => {
    if (!p) return null;
    const card =
      liveStatus.find((r) => r.storeCode && r.storeCode === p.storeCode) ?? cardDoItem ?? null;
    if (card?.issueReason) {
      return { tom: 'crit' as const, texto: card.issueReasonLabel ?? 'Loja reportou problema' };
    }
    // "Sem loja" só vale quando NENHUM card tem a peça — senão a tela
    // contradizia o card que ela mesma desenha logo abaixo (ON-000176).
    if (!card) {
      if (p.estado === 'nao_roteado') {
        return { tom: 'warn' as const, texto: 'Aguardando separação' };
      }
      if (p.cor_semaforo === 'vermelho') {
        return {
          tom: 'crit' as const,
          texto:
            p.estado === 'sem_estoque_rede'
              ? 'Nenhuma loja tem'
              : p.estado === 'sem_dono'
                ? 'Sem loja'
                : 'Loja reportou problema',
        };
      }
    }
    if (card?.status === 'shipped') return { tom: 'ok' as const, texto: 'Enviada' };
    if (card && ['separated', 'ready'].includes(card.status)) return { tom: 'ok' as const, texto: 'Separada' };
    if (card?.status === 'separating') return { tom: 'warn' as const, texto: 'Separando' };
    if (card?.status === 'new') return { tom: 'warn' as const, texto: 'Aguardando a loja iniciar' };
    if (p.cor_semaforo === 'verde') return { tom: 'ok' as const, texto: 'Separada' };
    return { tom: 'warn' as const, texto: 'Aguardando' };
  };

  /**
   * VERIFICAÇÃO MANUAL (27/08, ordem do dono): pedido acima de R$ 499,99 só
   * anda depois que alguém FALA com a cliente e confere os dados. A régua é
   * o total do pedido; o registro fica no histórico (a nota entra na linha do
   * tempo, então sobrevive ao F5 e diz QUEM confirmou).
   */
  const TETO_SEM_CONFERIR = 499.99;
  const MARCA_CONFERIDO = 'VERIFICACAO MANUAL';
  const precisaConferir = Number(order.total || 0) > TETO_SEM_CONFERIR;
  const conferidoEvento = raiox?.eventos.find((ev) => (ev.detalhe || '').includes(MARCA_CONFERIDO)) ?? null;
  const freteDoPedido = {
    // Valor: o que o pedido guarda no método de envio; se o frete ainda estiver
    // como item (pedido de antes desta correção), soma a linha.
    valor:
      Number(order.shippingLines?.[0]?.total ?? 0) ||
      order.lineItems.filter(ehLinhaFrete).reduce((s, li) => s + Number(li.total || 0), 0),
    metodo: order.shippingLines?.[0]?.method || order.pickup?.shippingMethodTitle || '',
  };

  /**
   * A LOJA QUE POSTOU — quem casa o rastreio do pedido com o card de
   * separação. É dela que sai o CEP de ORIGEM da cotação de frete: cada loja
   * posta do CEP dela e o preço muda com a distância. Casa pelo código do
   * objeto (normalizado, porque a loja digita na mão) e, se não achar, aceita
   * a única loja que despachou. Duas lojas despachando = pedido dividido, e
   * aí nenhuma origem sozinha explica o frete — melhor não chutar.
   */
  const cardQuePostou = (() => {
    const limpar = (s: string | null | undefined) =>
      String(s || '').toUpperCase().replace(/[\s.\-]/g, '');
    const alvo = limpar(order.tracking?.number);
    const porCodigo = alvo
      ? liveStatus.find((p) => limpar(p.trackingCode) === alvo)
      : undefined;
    if (porCodigo) return porCodigo;
    const despacharam = liveStatus.filter((p) => p.status === 'shipped' && p.storeCode);
    return despacharam.length === 1 ? despacharam[0] : null;
  })();
  const lojaQuePostou = cardQuePostou?.storeCode ?? null;
  // O que a casa pagou nesta etiqueta — centavos no banco, reais na tela.
  const custoEtiqueta =
    cardQuePostou?.freteCustoCentavos != null ? cardQuePostou.freteCustoCentavos / 100 : null;

  return (
    <div className="max-w-5xl mx-auto p-6">
      <div className="flex items-center justify-between mb-4">
        <Link href="/pedidos?status=processing" className="text-brand text-sm hover:underline flex items-center gap-1">
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

      {/* CABEÇALHO — uma linha de identificação e uma de contexto.
          O banner de forma de envio que vinha logo abaixo era um retângulo
          VERMELHO de 90px dizendo "SEDEX": cor de alarme gasta num dado que
          não é problema nenhum. No Semáforo o vermelho fica guardado pro que
          está parado — o envio virou mais um item desta linha. */}
      <div className="mb-5 border-b border-line pb-4">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="font-mono text-[19px] font-semibold tracking-tight">#{order.number}</h1>
          {(order.shipping?.first_name || order.billing?.first_name) && (
            <span className="text-[19px] font-bold tracking-tight">
              {[
                order.shipping?.first_name || order.billing?.first_name,
                order.shipping?.last_name || order.billing?.last_name,
              ].filter(Boolean).join(' ')}
            </span>
          )}
          <span className="ml-auto text-[22px] font-bold tabular-nums">{fmtMoney(order.total)}</span>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-y-1 text-[12.5px] text-ink-soft [&>*]:border-l [&>*]:border-line [&>*]:px-3 [&>*:first-child]:border-l-0 [&>*:first-child]:pl-0">
          {(() => {
            const raw = order.pickup?.shippingMethodTitle ?? separation?.shippingMethod ?? null;
            if (!raw) return null;
            const m = classifyShipping(raw, order.shipping?.state ?? order.billing?.state ?? null);
            return <span className="font-semibold text-ink" title={m.raw}>{m.label}</span>;
          })()}
          {order.shipping?.city && (
            <span>{order.shipping.city} / {order.shipping.state}</span>
          )}
          <span title={`Criado em ${fmtDate(order.dateCreatedGmt)}`}>
            Criado em {fmtDate(order.dateCreatedGmt)}
          </span>
          {order.paymentMethodTitle && <span>{order.paymentMethodTitle}</span>}
          {/* Tag de vendedora — atribuir Karine/Manu/etc pra relatório mensal */}
          <span className="inline-flex items-center">
            <SellerTag
              wcOrderId={order.id}
              currentSellerId={order.sellerId ?? null}
              currentSellerName={order.sellerName ?? null}
              compact
              onChange={(sellerId, sellerName) => {
                setOrder((prev) => (prev ? { ...prev, sellerId, sellerName } : prev));
              }}
            />
          </span>
        </div>
      </div>

      {/* VERIFICAÇÃO MANUAL — pedido acima de R$ 499,99 (27/08, ordem do dono).
          A atendente TEM que falar com a cliente e confirmar os dados antes de
          o pedido seguir. Fica no topo, com o WhatsApp a um clique e o botão
          que carimba quem confirmou no histórico. */}
      {precisaConferir && (
        <div
          className={`mb-4 rounded-card border px-4 py-3 ${
            conferidoEvento ? 'border-ok/30 bg-ok-soft' : 'border-warn/40 bg-warn-soft'
          }`}
        >
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className={`text-[13px] font-bold ${conferidoEvento ? 'text-ok' : 'text-warn'}`}>
              {conferidoEvento ? 'Dados confirmados com a cliente' : 'Pedido acima de R$ 499,99 — confirme os dados com a cliente'}
            </span>
            <span className="text-[12px] text-ink-soft">
              {conferidoEvento ? (
                <>
                  por <b>{conferidoEvento.quem || 'sem autor'}</b> em{' '}
                  {new Date(conferidoEvento.em).toLocaleString('pt-BR', {
                    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
                  })}
                </>
              ) : (
                <>
                  {fmtMoney(order.total)} · ligue ou mande WhatsApp antes de mandar separar
                </>
              )}
            </span>
            {!conferidoEvento && (
              <div className="ml-auto flex flex-wrap items-center gap-2">
                {order.billing?.phone && (
                  <a
                    href={`https://wa.me/${String(order.billing.phone).replace(/\D/g, '').replace(/^(?!55)/, '55')}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-field border border-line bg-surface px-3 py-1.5 text-[12px] font-semibold text-ink hover:bg-surface-2"
                  >
                    Falar no WhatsApp
                  </a>
                )}
                <button
                  type="button"
                  onClick={marcarConferido}
                  disabled={conferindo}
                  className="rounded-field bg-action px-3 py-1.5 text-[12px] font-semibold text-action-ink hover:opacity-90 disabled:opacity-60"
                  title="Registra no histórico do pedido que você falou com a cliente e conferiu os dados"
                >
                  {conferindo ? 'Registrando…' : 'Falei com a cliente e confirmei'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {flash && (
        <div className="bg-green-50 text-green-800 border border-green-200 p-3 rounded mb-4 text-sm flex items-center gap-2">
          <Check className="w-4 h-4" /> {flash}
        </div>
      )}
      {error && <div className="bg-red-50 text-red-700 p-3 rounded mb-4 text-sm whitespace-pre-line">{error}</div>}

      {/* O banner gigante de forma de envio saiu daqui (o dado subiu pro
          cabeçalho): 90px de vermelho pra dizer "SEDEX" competia com o alarme
          de pedido travado, que é o único que deveria ser vermelho na tela.
          Retirada continua com o banner próprio azul/âmbar mais abaixo, que
          diz o que a loja tem que FAZER — esse não é decoração. */}

      {/* 🛡️ ANÁLISE DE RISCO — relação com pedidos anteriores que deram
          problema. Fica ANTES da campanha de propósito: quem abre o pedido
          precisa saber que existe alerta antes de qualquer outra coisa. O
          painel se recolhe sozinho quando o risco é baixo, e NÃO bloqueia
          pedido nenhum — só alerta e registra a decisão (dono, 27/08). */}
      <PainelRisco pedidoRef={wcId} />

      {/* DE QUAL CAMPANHA VEIO — o nome do anúncio que trouxe a cliente, com a
          cascata inteira a um clique. Antes isso era uma linha cinza de 12px no
          rodapé da tela, com utm_source/medium/campaign colados por barra. */}
      <CampanhaCascata atribuicao={order.atribuicao} />

      {/* DE ONDE VEIO O PEDIDO — a loja que vendeu. A loja que SEPARA pode ser
          outra (roteamento), e é ela quem cobra desta no acerto; sem este
          carimbo a matriz abria o pedido sem saber qual filial pediu. */}
      {order.origemLoja && (
        <div className="mb-4 rounded-lg border-2 border-teal-300 bg-teal-50 p-4">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <div className="font-bold text-base flex items-center gap-2 text-slate-800">
                🏬 PEDIDO DA LOJA
                <span className="text-teal-700">— {order.origemLoja.name}</span>
              </div>
              <div className="text-xs text-slate-600 mt-1">
                Venda online feita no PDV da loja
                {order.origemLoja.vendedora ? ` · vendedora: ${order.origemLoja.vendedora}` : ''}
                {' · '}a loja que separar cobra desta no acerto.
              </div>
            </div>
            <span className="px-2 py-1 bg-teal-200 text-teal-900 rounded text-xs font-mono">
              {order.origemLoja.code}
            </span>
          </div>

          {/* CARD NA LOJA ERRADA — o card de separação está numa loja que NÃO
              vendeu. Se ela separar, sai uma SEGUNDA peça pra mesma cliente e o
              estoque de quem vendeu fica fantasma (caso ON-000004, Suzano →
              Sorocaba). Só aparece quando o risco existe de verdade: alarme
              falso aqui mata a confiança no aviso. */}
          {(() => {
            const vendedoraCode = order.origemLoja!.code;
            const ativosFora = liveStatus.filter(
              (p) => ['new', 'separating'].includes(p.status) && p.storeCode !== vendedoraCode,
            );
            // `order.status` aqui é o SLUG do detalhe (detalheEcommerce mapeia
            // shipped/delivered → 'completed'), não o status cru do banco.
            const fechavel = !['completed', 'cancelled'].includes(String(order.status || ''));
            if (!fechavel) return null;

            /**
             * ALARME FALSO — CORRIGIDO 17/08 (caso ON-000008).
             *
             * A primeira versão mostrava o aviso vermelho sempre que havia card
             * em loja ≠ vendedora. Só que isso é o caso NORMAL da venda online:
             * SJC vendeu por SEDEX sem ter a peça, o roteamento mandou pra
             * Suzano, Suzano posta pra cliente. Certíssimo — e a tela gritava
             * "uma segunda peça vai pra cliente".
             *
             * Pior que ruído: clicar no botão ali baixaria estoque em SJC (que
             * não tem a peça) e cancelaria o card legítimo da Suzano. Arma
             * apontada pro pé, no lugar onde a matriz mais confia na tela.
             *
             * Vale a regra do CLAUDE.md: alarme falso mata a confiança na fila
             * inteira. Então o bloco só aparece quando é PLAUSÍVEL que a
             * vendedora tenha entregado por conta:
             *   - MOTOBOY → sai da mão dela, sem passar pelo sistema (foi o
             *     ON-000004: Suzano mandou de moto e o card virou fantasma);
             *   - entrega NÃO INFORMADA → ambíguo, ninguém sabe como saiu;
             *   - SEM CARD NENHUM → nada legítimo em andamento.
             * SEDEX/PAC com card em outra loja: silêncio. Pra postar ela
             * PRECISA do card, então não teve como despachar por fora.
             */
            const entregaKind = classifyShipping(
              order.shippingLines?.[0]?.method ?? order.pickup?.shippingMethodTitle ?? null,
              order.shipping?.state ?? order.billing?.state ?? null,
            ).kind;
            const entregaIndefinida = entregaKind === 'other';
            const podeTerEntregadoPorConta =
              entregaKind === 'motoboy' || entregaIndefinida || liveStatus.length === 0;
            if (!podeTerEntregadoPorConta) return null;

            return (
              <div className="mt-3 border-t border-teal-200 pt-3">
                {/* Vermelho SÓ no caso do ON-000004: entrega que sai da mão da
                    vendedora (motoboy) e card aberto em OUTRA loja. Aí sim a
                    peça pode ter saído duas vezes. Nos outros casos o bloco é
                    calmo — é uma ação disponível, não um problema detectado. */}
                {ativosFora.length > 0 && entregaKind === 'motoboy' && (
                  <div className="mb-2 rounded-lg border-2 border-rose-300 bg-rose-50 p-3">
                    <div className="text-sm font-bold text-rose-800">
                      ⚠️ Motoboy, e a separação está em{' '}
                      {ativosFora.map((p) => p.storeName || p.storeCode).join(', ')}
                    </div>
                    <div className="text-xs text-rose-700 mt-1">
                      Motoboy sai da mão de quem vendeu. Se {order.origemLoja!.name} já mandou a
                      peça, essa loja vai separar uma <b>segunda</b> — confirme antes.
                    </div>
                  </div>
                )}
                <div className="flex items-center gap-3 flex-wrap">
                  <button
                    type="button"
                    onClick={fecharNaLojaVendedora}
                    disabled={fecharLoading}
                    className={`rounded-lg px-4 py-2 text-sm font-bold text-white disabled:opacity-50 ${
                      ativosFora.length > 0 && entregaKind === 'motoboy'
                        ? 'bg-rose-600 hover:bg-rose-700'
                        : 'bg-teal-600 hover:bg-teal-700'
                    }`}
                  >
                    {fecharLoading
                      ? 'Fechando…'
                      : `✓ ${order.origemLoja!.name} já entregou — fechar pedido`}
                  </button>
                  <span className="text-[11px] text-slate-600">
                    {ativosFora.length > 0
                      ? `Só clique se confirmou com ${order.origemLoja!.name}: cancela a separação de ${ativosFora
                          .map((p) => p.storeName || p.storeCode)
                          .join(', ')} e baixa o estoque nela.`
                      : 'Baixa o estoque na loja que vendeu e encerra a separação.'}
                  </span>
                </div>
                {fecharErro && (
                  <div className="mt-2 text-xs text-rose-700 font-semibold">{fecharErro}</div>
                )}
              </div>
            );
          })()}
        </div>
      )}

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

      {/* CLIENTE E ENTREGA — um quadro só (27/08, ordem do dono). Eram dois
          cartões lado a lado com o MESMO nome no topo de cada um; quem lê
          precisa dos dois juntos pra decidir qualquer coisa. Cada metade
          mantém o seu "Corrigir" — o de contato e o de endereço são modais
          diferentes e escrevem em campos diferentes. */}
      <div className="bg-white rounded shadow mb-4 p-4">
        <div className="grid gap-6 md:grid-cols-2 md:divide-x md:divide-slate-200">
        {/* Dados do cliente */}
        <div className="md:pr-6">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h3 className="font-semibold text-sm text-slate-600 uppercase tracking-wide">Cliente</h3>
            {/* Corrigir CPF/e-mail/WhatsApp: irmão do "Corrigir" da Entrega.
                Esses campos são snapshot do checkout e eram imutáveis — o
                telefone "55119595822" (+55 colado engolindo o fim do número)
                ficava errado pra sempre e o aviso ia pro nada. */}
            <button
              type="button"
              onClick={() => setEditandoCliente(true)}
              className="rounded-lg border-2 border-violet-300 px-3 py-1.5 text-xs font-bold text-violet-700 hover:bg-violet-50"
            >
              ✎ Corrigir
            </button>
          </div>
          {editandoCliente && (
            <DadosClienteModal
              wcOrderId={Number(wcId)}
              inicial={{
                cpf: order.customerCpf || '',
                email: order.billing.email || '',
                telefone: order.billing.phone || '',
              }}
              onFechar={() => setEditandoCliente(false)}
              onSalvo={() => { void load(); }}
            />
          )}
          <div className="text-sm space-y-1">
            <div className="font-medium">
              {order.billing.first_name} {order.billing.last_name}
            </div>
            {order.customerCpf ? (
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
            ) : (
              // Sem CPF a NF-e não sai e o crédito de peça faltante recusa —
              // melhor gritar aqui do que na hora de faturar.
              <div className="text-xs text-amber-700">🪪 sem CPF — a NF-e e o crédito precisam dele</div>
            )}
            {order.billing.email ? (
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
            ) : (
              <div className="text-xs text-slate-400">✉️ sem e-mail</div>
            )}
            {order.billing.phone ? (
              <div className="text-slate-600">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-500">📱</span>
                  <span>{fmtTelefoneBr(order.billing.phone)}</span>
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
                {/* Número torto aparece CRU + o porquê — formatar bonito
                    esconderia o defeito, e é aqui que a operadora percebe
                    que o aviso de WhatsApp não vai chegar. */}
                {telefoneProblema(order.billing.phone) && (
                  <div className="mt-0.5 text-[11px] font-semibold text-rose-700">
                    ⚠ {telefoneProblema(order.billing.phone)} — confirme com a cliente e use Corrigir
                  </div>
                )}
              </div>
            ) : (
              <div className="text-xs text-slate-400">📱 sem WhatsApp — os avisos do pedido não têm pra onde ir</div>
            )}
          </div>
        </div>

        {/* Entrega */}
        <div className="md:pl-6">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h3 className="font-semibold text-sm text-slate-600 uppercase tracking-wide">Entrega</h3>
            {/* Corrigir endereco: mesma modal da tela da loja. O endereco do
                pedido e snapshot e a etiqueta le dele — sem isto, complemento
                errado so se resolvia por fora do sistema. */}
            <div className="flex items-center gap-2">
              {/* Trocar a FORMA de entrega (SEDEX/PAC/motoboy/retirada + loja
                  que atende). Só enquanto nenhuma separação passou de
                  "separando" — depois a peça já saiu. */}
              {!['completed', 'cancelled'].includes(String(order.status || '')) && (
                <button
                  type="button"
                  onClick={() => (trocandoEntrega ? setTrocandoEntrega(false) : void abrirTrocaEntrega())}
                  className="rounded-lg border-2 border-teal-300 px-3 py-1.5 text-xs font-bold text-teal-700 hover:bg-teal-50"
                >
                  🔁 Trocar entrega
                </button>
              )}
              <button
                type="button"
                onClick={() => setEditandoEndereco(true)}
                className="rounded-lg border-2 border-violet-300 px-3 py-1.5 text-xs font-bold text-violet-700 hover:bg-violet-50"
              >
                ✎ Corrigir
              </button>
            </div>
          </div>

          {trocandoEntrega && (
            <div className="mb-3 rounded-lg border-2 border-teal-200 bg-teal-50 p-3">
              <div className="text-[11px] font-bold uppercase tracking-wide text-teal-800 mb-2">
                Nova forma de entrega
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                {([
                  { id: 'sedex', label: '⚡ SEDEX' },
                  { id: 'pac', label: '📦 PAC' },
                  { id: 'motoboy', label: '🛵 MOTOBOY' },
                  { id: 'retirada', label: '🏬 RETIRADA' },
                ] as const).map((op) => (
                  <button
                    key={op.id}
                    type="button"
                    onClick={() => { setEntregaNova(op.id); if (op.id === 'sedex' || op.id === 'pac') setEntregaLoja(''); }}
                    className={`rounded-lg border-2 py-2 text-xs font-bold transition ${
                      entregaNova === op.id
                        ? 'border-teal-500 bg-teal-600 text-white'
                        : 'border-slate-200 bg-white text-slate-700 hover:border-teal-300'
                    }`}
                  >
                    {op.label}
                  </button>
                ))}
              </div>
              {(entregaNova === 'retirada' || entregaNova === 'motoboy') && (
                <div className="mt-2">
                  <label className="text-[10px] text-slate-600 uppercase font-semibold tracking-wider">
                    {entregaNova === 'retirada' ? 'Cliente retira em qual loja? *' : 'Qual loja manda o motoboy? (opcional)'}
                  </label>
                  <select
                    value={entregaLoja}
                    onChange={(e) => setEntregaLoja(e.target.value)}
                    className="mt-1 w-full rounded-lg border-2 border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-800 focus:border-teal-400 focus:outline-none"
                  >
                    <option value="">{entregaNova === 'retirada' ? '— escolha a loja —' : 'A engine escolhe (por estoque)'}</option>
                    {entregaLojas.map((s) => (
                      <option key={s.code} value={s.code}>{s.name} ({s.code})</option>
                    ))}
                  </select>
                  <p className="text-[10px] text-teal-700 mt-1 font-semibold">
                    {entregaNova === 'retirada'
                      ? 'A separação trava nessa loja. O que ela não tiver chega por transferência antes da cliente buscar.'
                      : entregaLoja
                        ? 'A separação trava nessa loja: ela recebe o que faltar por transferência e manda o motoboy.'
                        : 'Sem loja, a engine escolhe por estoque — pode cair longe da cliente.'}
                  </p>
                </div>
              )}
              <div className="mt-3 flex items-center gap-2 flex-wrap">
                <button
                  type="button"
                  disabled={entregaBusy}
                  onClick={salvarTrocaEntrega}
                  className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-bold text-white hover:bg-teal-700 disabled:opacity-50"
                >
                  {entregaBusy ? 'Salvando…' : 'Salvar e re-rotear'}
                </button>
                <button
                  type="button"
                  onClick={() => setTrocandoEntrega(false)}
                  className="rounded-lg border-2 border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                >
                  Cancelar
                </button>
                <span className="text-[11px] text-slate-600">
                  Cards ainda em "novo/separando" são refeitos com a entrega nova.
                </span>
              </div>
              {entregaErro && <div className="mt-2 text-xs font-semibold text-rose-700">{entregaErro}</div>}
            </div>
          )}

          <div className="text-sm space-y-0.5 text-slate-700">
          {editandoEndereco && (
            <EnderecoEntregaModal
              wcOrderId={Number(wcId)}
              // A tela da matriz ja tem o shipping como OBJETO; a modal le o
              // mesmo shape que o pedido guarda, entao serializa de volta.
              inicial={enderecoDoPedido(JSON.stringify(order.shipping || {}))}
              onFechar={() => setEditandoEndereco(false)}
              onSalvo={() => { void load(); }}
            />
          )}
            <div>{order.shipping.first_name} {order.shipping.last_name}</div>
            {/* `address_1` já vem com o número; concatenar `number` de novo
                escrevia "Rua Salomão Filho, 577 , 577". */}
            <div>{ruaComNumero(order.shipping)}</div>
            {order.shipping.address_2 && <div>{order.shipping.address_2}</div>}
            <div>{order.shipping.city} / {order.shipping.state} · CEP {order.shipping.postcode}</div>
            {order.shippingLines[0] && (
              <div className="text-xs text-slate-500 mt-2">
                Método: {order.shippingLines[0].method} ({fmtMoney(order.shippingLines[0].total)})
              </div>
            )}

            {/* ENDEREÇO PRINCIPAL (o do cadastro/cobrança) — só aparece quando
                é DIFERENTE do de entrega. A etiqueta e a NF-e leem o de
                ENTREGA, então ele é o exposto; o outro fica a um clique, pra
                conferir com a cliente sem sair da tela nem abrir o CRM. */}
            {(() => {
              const chave = (e: any) =>
                [e?.address_1, e?.address_2, e?.city, e?.state, e?.postcode]
                  .map((x) => String(x || '').trim().toUpperCase())
                  .join('|');
              const temCobranca = !!(order.billing?.address_1 || order.billing?.postcode);
              if (!temCobranca || chave(order.billing) === chave(order.shipping)) return null;
              return (
                <details className="mt-2 text-xs">
                  <summary className="cursor-pointer select-none font-semibold text-brand hover:underline">
                    A cliente tem outro endereço no cadastro — ver
                  </summary>
                  <div className="mt-1 rounded border border-slate-200 bg-slate-50 p-2 text-slate-600">
                    <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                      Endereço principal (cadastro/cobrança)
                    </div>
                    <div>{ruaComNumero(order.billing)}</div>
                    {order.billing.address_2 && <div>{order.billing.address_2}</div>}
                    <div>
                      {order.billing.city} / {order.billing.state}
                      {order.billing.postcode ? ` · CEP ${order.billing.postcode}` : ''}
                    </div>
                    <div className="mt-1 text-[11px] text-slate-500">
                      A entrega sai pro endereço de cima. Se a cliente pedir este, use <b>Corrigir</b>.
                    </div>
                  </div>
                </details>
              );
            })()}
          </div>
        </div>
        </div>
      </div>

      {/* Itens — PEÇAS. O FRETE cobrado pela loja é uma linha da venda no PDV
          (é assim que o dinheiro entra no caixa), mas NÃO é peça: aparece
          embaixo, no rodapé, e nunca na lista que a loja vai separar. */}
      <div className="bg-white rounded shadow mb-4 overflow-hidden">
        <h3 className="font-semibold p-4 text-sm text-slate-600 uppercase tracking-wide border-b flex items-center gap-2">
          <Package className="w-4 h-4" /> Itens ({pecasDoPedido.length})
        </h3>
        <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="text-left p-3">Produto</th>
              <th className="text-left p-3">Onde está</th>
              <th className="text-left p-3">SKU</th>
              <th className="text-right p-3">Qtd</th>
              <th className="text-right p-3">Preço</th>
              <th className="text-right p-3">Total</th>
              {podeTrocarItem && <th className="p-3" />}
            </tr>
          </thead>
          <tbody>
            {pecasDoPedido.map((li) => {
              const peca = pecaPorItem(li);
              const cardItem = cardComAPeca(li);
              const est = estadoDaPeca(peca, cardItem);
              // A loja da linha: o carimbo do raio-x quando existe, senão a
              // loja do card que lista a peça (pedido de loja única).
              const lojaCode = peca?.storeCode ?? cardItem?.storeCode ?? null;
              const lojaNome = peca?.storeName ?? cardItem?.storeName ?? null;
              // Trocar a loja DESTA peça = a mesma modal do "→ outra loja" do
              // trilho: escolhe entre as lojas que têm a peça. Só enquanto
              // ninguém bipou — depois o estoque já saiu de lá.
              const podeTrocarLoja =
                !!peca &&
                !['shipped', 'delivered'].includes(
                  (liveStatus.find((r) => r.storeCode === lojaCode) ?? cardItem)?.status ?? 'new',
                );
              return (
                <tr key={li.id} className="border-t">
                  <td className="p-3">
                    <div className="font-medium text-slate-800">{tituloPeca(li)}</div>
                    {li.ref && (
                      <div className="text-xs text-slate-500">
                        {nomeSemVariacao(li.name, li.cor, li.tamanho)}
                      </div>
                    )}
                  </td>

                  {/* ONDE ESTÁ — bolinha do estado + etiqueta da loja. Clicar
                      na etiqueta abre a lista de lojas pra trocar a escolha. */}
                  <td className="p-3">
                    {peca ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${
                            est?.tom === 'crit' ? 'bg-crit' : est?.tom === 'ok' ? 'bg-ok' : 'bg-warn'
                          }`}
                          title={peca.onde}
                          aria-label={est?.texto}
                        />
                        <button
                          type="button"
                          onClick={() =>
                            abrirMoverPeca(
                              { id: String(li.id), sku: li.sku, ref: li.ref, cor: li.cor, tamanho: li.tamanho, descricao: li.name },
                              { storeCode: lojaCode, storeName: lojaNome, total: 1 },
                            )
                          }
                          disabled={!podeTrocarLoja || sepLoading}
                          className={`rounded-field border px-2 py-1 text-xs font-semibold transition ${
                            lojaCode || peca.estado === 'nao_roteado'
                              ? 'border-line bg-surface text-ink hover:bg-surface-2'
                              : 'border-crit/40 bg-crit-soft text-crit hover:bg-crit/10'
                          } disabled:cursor-not-allowed disabled:opacity-60`}
                          title={
                            podeTrocarLoja
                              ? `${peca.onde} — clique pra escolher outra loja`
                              : peca.onde
                          }
                        >
                          {lojaNome || lojaCode || 'escolher loja'}
                          {podeTrocarLoja && <span className="ml-1 text-ink-faint">▾</span>}
                        </button>
                        <span
                          className={`text-xs font-semibold ${
                            est?.tom === 'crit' ? 'text-crit' : est?.tom === 'ok' ? 'text-ok' : 'text-warn'
                          }`}
                        >
                          {est?.texto}
                        </span>
                        {/* Peça vermelha sem dono: as duas saídas (26/08) — o
                            2º frete de outra loja, ou cancelar e devolver. */}
                        {!cardItem &&
                          peca.cor_semaforo === 'vermelho' &&
                          ['sem_dono', 'reportada', 'sem_estoque_rede'].includes(peca.estado) && (
                          <button
                            type="button"
                            onClick={() => { setCancelarPeca(peca); setCancelarMotivo(''); setCancelarErro(null); }}
                            className="text-xs font-semibold text-crit underline hover:opacity-80"
                            title="Cancela SÓ esta peça e devolve o valor dela — o pedido segue com as outras"
                          >
                            cancelar e devolver
                          </button>
                        )}
                      </div>
                    ) : (
                      <span className="text-xs text-slate-400">sem separação ainda</span>
                    )}
                  </td>

                  <td className="p-3 font-mono text-xs text-slate-600">{li.sku || '—'}</td>
                  <td className="p-3 text-right">{li.quantity}</td>
                  <td className="p-3 text-right">{fmtMoney(li.price)}</td>
                  <td className="p-3 text-right font-medium">{fmtMoney(li.total)}</td>
                  {podeTrocarItem && (
                    <td className="p-3 text-right">
                      <button
                        onClick={() => setTrocaItem({ id: String(li.id), label: tituloPeca(li) })}
                        className="rounded-lg border border-[#E6DFC8] bg-white px-2.5 py-1.5 text-xs font-semibold text-[#8C7325] hover:bg-[#FBF6E6]"
                        title="Trocar esta peça por outra — a diferença vira cobrança ou vale, e o pedido é re-roteado."
                      >
                        Trocar
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
          <tfoot className="border-t-2 bg-slate-50 text-slate-700">
            <tr>
              <td className="p-3 text-xs uppercase tracking-wide" colSpan={podeTrocarItem ? 6 : 5}>
                Frete cobrado da cliente{freteDoPedido.metodo ? ` · ${freteDoPedido.metodo}` : ''}
              </td>
              <td className="p-3 text-right font-bold tabular-nums">
                {freteDoPedido.valor > 0 ? fmtMoney(freteDoPedido.valor) : '—'}
              </td>
            </tr>
          </tfoot>
        </table>
        </div>
      </div>

      {/* ── ACERTOS DA TROCA ────────────────────────────────────────────
          O dinheiro que sobrou (ou faltou) de cada troca de peça. Fica
          COLADO na tabela de itens porque é a explicação do preço que
          mudou ali em cima — e, quando é cobrança, é a explicação da
          separação que não anda. */}
      {trocas.length > 0 && (
        <div className="bg-white rounded shadow mb-4 overflow-hidden">
          <h3 className="font-semibold p-4 text-sm text-slate-600 uppercase tracking-wide border-b flex items-center gap-2">
            <AlertCircle className="w-4 h-4" /> Acertos da troca ({trocas.length})
          </h3>
          <div className="divide-y">
            {trocas.map((t) => {
              const cobrando = t.tipo === 'cobranca';
              const pendente = t.status === 'pending';
              return (
                <div key={t.id} className="p-4 space-y-2">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="min-w-0 text-sm">
                      <div className="text-slate-800">
                        <span className="line-through text-slate-400">{t.oldName || t.oldSku || '—'}</span>
                        <span className="mx-2 text-slate-300">→</span>
                        <span className="font-semibold">{t.newName || t.newSku || '—'}</span>
                      </div>
                      <div className="text-xs text-slate-400 mt-0.5">
                        {fmtDate(t.createdAt)}
                        {t.motivo ? ` · ${t.motivo}` : ''}
                      </div>
                    </div>
                    <div
                      className={`shrink-0 text-base font-bold tabular-nums ${
                        t.diferenca > 0 ? 'text-red-600' : t.diferenca < 0 ? 'text-emerald-600' : 'text-slate-500'
                      }`}
                    >
                      {t.diferenca > 0 ? '+' : t.diferenca < 0 ? '−' : ''}
                      {fmtMoney(Math.abs(t.diferenca))}
                    </div>
                  </div>

                  {/* Cobrança em aberto = separação parada. É a linha mais
                      importante da tela quando existe. */}
                  {cobrando && pendente && (
                    <div className="rounded border-2 border-amber-300 bg-amber-50 p-3 space-y-2">
                      <div className="text-sm font-semibold text-amber-900">
                        ⏳ Aguardando a cliente pagar {fmtMoney(Math.abs(t.diferenca))} — a separação está travada
                      </div>
                      {t.linkUrl && (
                        <div className="flex items-center gap-2 flex-wrap">
                          <input
                            readOnly
                            value={t.linkUrl}
                            onFocus={(e) => e.currentTarget.select()}
                            className="flex-1 min-w-[200px] rounded border border-amber-300 bg-white px-2 py-1.5 text-xs font-mono text-slate-700"
                          />
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                await navigator.clipboard.writeText(t.linkUrl || '');
                                setLinkCopiado(t.id);
                                setTimeout(() => setLinkCopiado(null), 2000);
                              } catch { /* sem permissão: copia na mão pelo campo */ }
                            }}
                            className="px-2.5 py-1.5 rounded border-2 border-amber-300 bg-white text-xs font-semibold text-amber-800 hover:bg-amber-100"
                          >
                            {linkCopiado === t.id ? 'Copiado ✓' : 'Copiar link'}
                          </button>
                        </div>
                      )}
                      {t.linkExpiresAt && (
                        <div className="text-xs text-amber-700">Link válido até {fmtDate(t.linkExpiresAt)}.</div>
                      )}

                      {/* Cortesia — trava sem porta de saída vira pedido
                          esquecido. Mini-form inline (nada de prompt()). */}
                      {liberandoTroca === t.id ? (
                        <div className="space-y-2">
                          <input
                            value={liberarMotivo}
                            autoFocus
                            onChange={(e) => setLiberarMotivo(e.target.value)}
                            placeholder="Motivo da cortesia (ex: erro nosso na peça)"
                            className="w-full rounded border border-amber-300 bg-white px-2 py-1.5 text-sm"
                          />
                          {liberarErro && <div className="text-xs text-red-700">{liberarErro}</div>}
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={() => { setLiberandoTroca(null); setLiberarErro(null); setLiberarMotivo(''); }}
                              disabled={liberarBusy}
                              className="px-3 py-1.5 rounded border-2 border-slate-300 bg-white text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-60"
                            >
                              Cancelar
                            </button>
                            <button
                              type="button"
                              onClick={() => void liberarTrocaSemCobrar(t.id)}
                              disabled={liberarBusy || liberarMotivo.trim().length < 3}
                              className="px-3 py-1.5 rounded bg-amber-600 text-white text-xs font-bold hover:bg-amber-700 disabled:opacity-50"
                            >
                              {liberarBusy ? 'Liberando…' : 'Confirmar cortesia'}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => { setLiberandoTroca(t.id); setLiberarMotivo(''); setLiberarErro(null); }}
                          className="text-xs font-semibold text-amber-800 underline hover:text-amber-900"
                          title="A casa absorve a diferença e a separação destrava"
                        >
                          Liberar sem cobrar
                        </button>
                      )}
                    </div>
                  )}

                  {/* VALE QUE NÃO SAIU não pode se passar por acerto fechado:
                      a emissão falha quando o pedido está sem CPF, e dizer
                      "✅ Pago" aqui deixaria a cliente sem o troco com a tela
                      afirmando que está tudo certo. */}
                  {t.status === 'settled' && t.tipo === 'vale' && !t.cupomCode && (
                    <div className="rounded-lg border-2 border-red-300 bg-red-50 px-3 py-2 text-sm font-semibold text-red-800">
                      ⚠️ Vale de {fmtMoney(Math.abs(t.diferenca))} NÃO foi emitido — a cliente ainda tem
                      esse valor a receber. Confira o CPF no pedido e emita o vale.
                    </div>
                  )}

                  {t.status === 'settled' && !(t.tipo === 'vale' && !t.cupomCode) && (
                    <div className="text-sm text-emerald-700 font-semibold">
                      {t.cupomCode
                        ? `✅ Vale ${t.cupomCode} emitido`
                        : t.tipo === 'neutro'
                          ? '✅ Sem diferença'
                          : '✅ Pago'}
                      {t.settledAt ? <span className="font-normal text-slate-400"> · {fmtDate(t.settledAt)}</span> : null}
                    </div>
                  )}

                  {t.status === 'cancelled' && (
                    <div className="text-sm text-slate-500">Acerto cancelado.</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── SEPARAÇÃO: quando fica bloqueada ──────────────────────────────
          A régua é o DINHEIRO, não a palavra do status (24/08).

          Até aqui bastava o status estar em on-hold/pending/failed/cancelled
          pra tela trocar o bloco de Separação INTEIRO por "pagamento não
          confirmado" — inclusive o "escolher loja manualmente", que é a
          saída de emergência. Só que `pending` também é o estado que o
          re-roteamento deixava num pedido PAGO sem loja com estoque: a
          matriz trocava uma peça do LP-000161 (PIX de R$ 95,90 confirmado
          dois dias antes) e caía num beco sem saída, com a tela dizendo que
          a cliente não pagou.

          Agora: pedido com pagamento comprovado (`pago`, carimbo do gateway)
          NUNCA cai no aviso de pagamento — o bloco de Separação continua ali
          e a matriz roteia de novo (ou escolhe a loja na mão, se der
          ruptura). Pedido cancelado/estornado segue bloqueado, com o texto
          certo em vez de "a cliente não pagou". */}
      {(() => {
        const morto = ['cancelled', 'refunded'].includes(status);
        const semPagamento = ['on-hold', 'pending', 'failed'].includes(status) && !order.pago;
        return morto || semPagamento;
      })() ? (
        <div className="bg-amber-50 border-2 border-amber-300 rounded shadow p-5 mb-4">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-amber-700 flex-shrink-0 mt-0.5" />
            {['cancelled', 'refunded'].includes(status) ? (
              <div>
                <div className="font-bold text-amber-900 text-sm uppercase tracking-wide">
                  Separação bloqueada — pedido {status === 'refunded' ? 'reembolsado' : 'cancelado'}
                </div>
                <div className="text-amber-800 text-sm mt-1">
                  Não dá pra separar um pedido {status === 'refunded' ? 'reembolsado' : 'cancelado'}. Se foi engano,
                  mude o status em <b>Atualizar pedido</b> antes de gerar a separação.
                </div>
              </div>
            ) : (
              <div>
                <div className="font-bold text-amber-900 text-sm uppercase tracking-wide">Separacao bloqueada — pagamento nao confirmado</div>
                <div className="text-amber-800 text-sm mt-1">
                  O pedido esta com status <b>{STATUS_OPTIONS.find((s) => s.slug === status)?.label || status}</b>. Aguarde o cliente confirmar o pagamento antes de gerar a separacao.
                </div>
                <div className="text-amber-700 text-xs mt-2">
                  Depois que o status mudar para <b>Processando</b> ou <b>Em separacao</b>, o botao de gerar separacao aparece automaticamente.
                </div>
              </div>
            )}
          </div>
        </div>
      ) : (
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

        {/* Trava da troca — o backend recusa mesmo; o aviso existe pra pessoa
            entender ANTES de clicar e ir cobrar a cliente (ou liberar sem
            cobrar no painel "Acertos da troca"). */}
        {trocasTravando && (
          <div className="mb-3 rounded border-2 border-amber-400 bg-amber-50 px-3 py-2.5 text-sm font-semibold text-amber-900">
            🔒 Separação travada: diferença da troca ainda não paga.
          </div>
        )}

        {/* A faixa roxa "JUNTANDO PEÇAS" e o banner verde "Separação já
           criada" viraram o cabeçalho do TRILHO, mais abaixo: as duas diziam
           o que o trilho mostra numa linha ("2 lojas · 0 de 1 caixa chegou").
           A checagem de peça sem dono que o banner âmbar fazia virou o
           contador vermelho do trilho — o mesmo flagra do ON-000106. */}

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
                  {/* CIRÚRGICO: os dois botões agem SÓ na(s) loja(s) que reportou(aram)
                      problema — as outras lojas do pedido (inclusive as que já
                      enviaram) ficam intocadas. Bug real 13/07: recalculava tudo. */}
                  <button
                    onClick={recalcularLojasComProblema}
                    disabled={sepLoading}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-semibold bg-white border border-red-400 text-red-800 hover:bg-red-50 disabled:opacity-60"
                    title="Re-roteia SÓ as peças da loja com problema (exclui ela); as outras lojas não mudam"
                  >
                    🔁 Recalcular automático (só a loja com problema)
                  </button>
                  <button
                    onClick={() => {
                      const issue = liveStatus.find((r) => r.issueReason && r.id);
                      if (issue) {
                        // Alvo por PARÂMETRO: setState não reflete no closure desta
                        // render — sem isso o modal media cobertura contra o pedido
                        // INTEIRO e loja com QUALQUER outra peça aparecia "1 un.
                        // disponíveis" (carrossel do ON-000110: 4 lojas forçadas
                        // atrás de peça que não existia em nenhuma).
                        const sTarget = {
                          pickOrderId: issue.id,
                          fromStoreCode: issue.storeCode!,
                          fromStoreName: issue.storeName,
                          fromStatus: issue.status,
                        };
                        setSwapTarget(sTarget);
                        openPickStoreModal({ swap: sTarget });
                        return;
                      }
                      openPickStoreModal();
                    }}
                    disabled={sepLoading}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-semibold bg-red-600 text-white hover:bg-red-700 disabled:opacity-60"
                    title="Escolhe a loja que assume SÓ as peças da loja com problema; as outras lojas não mudam"
                  >
                    🎯 Escolher outra loja manualmente
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Peça reportada na bipagem — o card seguiu, mas UMA peça ficou sem
            destino. Não confundir com o banner acima (card INTEIRO parado). */}
        {itemReports.length > 0 && (
          <div className="bg-red-50 border-2 border-red-400 rounded-lg p-3 mb-3">
            <div className="flex items-start gap-2">
              <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
              <div className="flex-1 text-sm">
                <div className="font-bold text-red-900">
                  Peça reportada na bipagem — sem loja pra enviar
                </div>
                {itemReports.map((r) => (
                  <div key={r.id} className="mt-1 text-red-800 flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span>
                      <b>Loja {r.storeCode}</b>:{' '}
                      {[r.ref, r.cor, r.tamanho].filter(Boolean).join(' · ') || r.sku} ({r.qtyMissing} un)
                      {' — '}{r.reasonLabel}
                      {r.note && <span className="text-red-700 italic"> — "{r.note}"</span>}
                      {r.stockDecreased && (
                        <span className="text-red-600 text-xs"> · já saiu do estoque da loja</span>
                      )}
                      {r.valorSugerido ? (
                        <span className="text-red-900 font-semibold"> · {fmtMoney(r.valorSugerido)}</span>
                      ) : null}
                    </span>
                    {/* O DESFECHO É UMA ESCOLHA DE DINHEIRO (dono, 25/08): devolver
                        ou virar crédito. O crédito vem primeiro e colorido porque é
                        o que a cliente costuma preferir — e é o que segura a venda
                        dentro de casa. */}
                    <button
                      onClick={() => abrirCredito(r)}
                      disabled={resolvendoReport === r.id}
                      className="px-2 py-0.5 rounded text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-60"
                      title="Emite um vale no CPF da cliente, sem prazo, que vale no site e em qualquer loja"
                    >
                      💳 Gerar crédito pra ela
                    </button>
                    <button
                      onClick={() => resolverItemReport(r.id)}
                      disabled={resolvendoReport === r.id}
                      className="px-2 py-0.5 rounded text-xs font-semibold bg-white border border-red-400 text-red-800 hover:bg-red-100 disabled:opacity-60"
                      title="Marque quando o dinheiro já voltou pra cliente (estorno/PIX)"
                    >
                      {resolvendoReport === r.id ? 'salvando…' : '✓ Reembolsei (ou resolvi por fora)'}
                    </button>
                  </div>
                ))}
                <div className="mt-2 text-xs text-red-700">
                  A cliente pagou por essa peça. Use <b>Recalcular separação</b> pra mandar de
                  outra loja que tenha a peça — o aviso some sozinho quando ela ganhar destino.
                  Se não tem de onde mandar, escolha o desfecho: <b>crédito</b> (fica com ela,
                  sem prazo) ou <b>reembolso</b>.
                </div>
              </div>
            </div>
          </div>
        )}

        {/* CRÉDITO JÁ EMITIDO — o código tem que sobreviver ao F5. Assim que o
            reporte é resolvido ele some do banner de cima; sem este painel, o
            único lugar onde o código aparecia era a resposta do clique. */}
        {creditosEmitidos.length > 0 && (
          <div className="bg-emerald-50 border-2 border-emerald-300 rounded-lg p-3 mb-3">
            <div className="flex items-start gap-2">
              <Check className="w-5 h-5 text-emerald-600 flex-shrink-0 mt-0.5" />
              <div className="flex-1 text-sm">
                <div className="font-bold text-emerald-900">
                  Crédito emitido pra cliente (no lugar do reembolso)
                </div>
                {creditosEmitidos.map((c) => (
                  <div key={c.id} className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-emerald-900">
                    <span className="font-mono font-bold text-base bg-white border border-emerald-400 rounded px-2 py-0.5">
                      {c.code}
                    </span>
                    <span className="font-semibold">{fmtMoney(c.valor)}</span>
                    <span className="text-emerald-700 text-xs">
                      {c.peca} · loja {c.storeCode}
                      {c.emitidoEm && ` · ${fmtDate(c.emitidoEm)}`}
                    </span>
                    {c.usado ? (
                      <span className="px-1.5 py-0.5 rounded text-xs font-semibold bg-slate-200 text-slate-700">
                        JÁ USADO{c.usadoAt ? ` em ${fmtDate(c.usadoAt)}` : ''}
                      </span>
                    ) : !c.existe || !c.ativo ? (
                      <span className="px-1.5 py-0.5 rounded text-xs font-semibold bg-red-100 text-red-800">
                        {c.existe ? 'DESATIVADO' : 'NÃO ENCONTRADO'}
                      </span>
                    ) : (
                      <span className="px-1.5 py-0.5 rounded text-xs font-semibold bg-emerald-600 text-white">
                        DISPONÍVEL {c.semPrazo ? '· SEM PRAZO' : ''}
                      </span>
                    )}
                    <button
                      onClick={() => navigator.clipboard?.writeText(c.code)}
                      className="px-2 py-0.5 rounded text-xs font-semibold bg-white border border-emerald-400 text-emerald-800 hover:bg-emerald-100"
                    >
                      copiar
                    </button>
                    {!c.usado && c.existe && (
                      <button
                        onClick={() =>
                          abrirWhatsApp(
                            order?.billing?.phone,
                            `Oi! Sobre o seu pedido: uma peça não veio, e a gente deixou um crédito de ` +
                              `${fmtMoney(c.valor)} no seu nome 💜\n\nCódigo: ${c.code}\n\n` +
                              `Ele NÃO TEM PRAZO e vale no site (lurds.com.br) ou em qualquer uma das nossas lojas.`,
                          )
                        }
                        className="px-2 py-0.5 rounded text-xs font-semibold bg-white border border-emerald-400 text-emerald-800 hover:bg-emerald-100"
                      >
                        WhatsApp
                      </button>
                    )}
                  </div>
                ))}
                <div className="mt-2 text-xs text-emerald-800">
                  Vale no site e em qualquer caixa da rede, <b>sem prazo de validade</b>. É
                  nominal: só a cliente do CPF deste pedido consegue usar.
                </div>
              </div>
            </div>
          </div>
        )}

        {/* MODAL DO CRÉDITO */}
        {creditoAlvo && (
          <div
            className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
            {...overlayClose(() => {
              if (!creditoBusy) setCreditoAlvo(null);
            })}
          >
            <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-lg font-bold text-slate-900">Gerar crédito pra cliente</h3>
                <button
                  onClick={() => !creditoBusy && setCreditoAlvo(null)}
                  className="text-slate-400 hover:text-slate-700"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="text-sm text-slate-700 bg-slate-50 border border-slate-200 rounded p-2 mb-3">
                <div>
                  <b>Peça que faltou:</b>{' '}
                  {[creditoAlvo.ref, creditoAlvo.cor, creditoAlvo.tamanho].filter(Boolean).join(' · ') ||
                    creditoAlvo.sku}{' '}
                  ({creditoAlvo.qtyMissing} un) — loja {creditoAlvo.storeCode}
                </div>
                <div className="mt-1">
                  <b>Cliente:</b> {creditoAlvo.cliente?.nome || '—'}
                  {creditoAlvo.cliente?.cpf
                    ? ` · CPF final ${creditoAlvo.cliente.cpf.slice(-4)}`
                    : ''}
                </div>
              </div>

              {/* SEM CPF NÃO EMITE. O vale é nominal de propósito: código sem
                  dono circula em print de WhatsApp e vira compra de outra
                  pessoa. Falar isso ANTES de ela digitar o valor. */}
              {!creditoAlvo.cliente?.cpf ? (
                <div className="text-sm bg-amber-50 border border-amber-300 text-amber-900 rounded p-3">
                  Este pedido está <b>sem CPF</b>, e o crédito é nominal — não dá pra emitir.
                  Preencha o CPF da cliente no pedido e volte aqui.
                </div>
              ) : (
                <>
                  <label className="block text-sm font-semibold text-slate-700 mb-1">
                    Valor do crédito
                  </label>
                  <input
                    value={creditoValor}
                    onChange={(e) => setCreditoValor(e.target.value)}
                    inputMode="decimal"
                    autoFocus
                    className="w-full border border-slate-300 rounded px-3 py-2 text-lg font-semibold"
                    placeholder="0,00"
                  />
                  <div className="text-xs text-slate-500 mt-1">
                    Sugerido: o que ela pagou pela peça
                    {creditoAlvo.valorSugerido ? ` (${fmtMoney(creditoAlvo.valorSugerido)})` : ''}. Dá
                    pra ajustar — por exemplo, incluir o frete.
                  </div>

                  <div className="mt-3 text-xs text-slate-600 bg-emerald-50 border border-emerald-200 rounded p-2">
                    O crédito nasce <b>sem prazo de validade</b>, no CPF da cliente, e vale no
                    site <b>e</b> em qualquer caixa da rede. Uso único.
                  </div>

                  {creditoErro && (
                    <div className="mt-3 text-sm bg-red-50 border border-red-300 text-red-800 rounded p-2">
                      {creditoErro}
                    </div>
                  )}

                  <div className="mt-4 flex gap-2 justify-end">
                    <button
                      onClick={() => setCreditoAlvo(null)}
                      disabled={creditoBusy}
                      className="px-3 py-2 rounded text-sm font-semibold border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-60"
                    >
                      Cancelar
                    </button>
                    <button
                      onClick={confirmarCredito}
                      disabled={creditoBusy}
                      className="px-4 py-2 rounded text-sm font-bold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-60 inline-flex items-center gap-2"
                    >
                      {creditoBusy && <Loader2 className="w-4 h-4 animate-spin" />}
                      {creditoBusy ? 'emitindo…' : 'Gerar crédito sem prazo'}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {/* ═══ TRILHO DA SEPARAÇÃO ═══════════════════════════════════════
            Isto aqui era QUATRO caixas dizendo a mesma coisa em quatro cores:
            a faixa roxa "JUNTANDO PEÇAS", a verde "Separação já criada", o
            "Onde está cada peça" e o painel "Status ao vivo das lojas". No
            LP-000289 as quatro juntas diziam uma frase só — "Vinhedo separa,
            manda pra Piracicaba, Piracicaba posta; nenhuma começou".

            Agora é um trilho: quem tem a peça → quem junta e posta → a
            cliente, na ordem em que acontece. Nada de ação se perdeu —
            imprimir, remover, trocar loja, mover peça, desfazer juntada e a
            linha do tempo continuam aqui dentro. */}
        {liveStatus.length > 0 && (() => {
          const destinoObrigatorio = destinoLogisticoObrigatorio(order);
          const ehRetirada = !!order.pickup?.isPickup;
          // Feeder = loja que manda caixa pra outra em vez de postar pra cliente.
          const feeders = liveStatus.filter(
            (r) => r.isTransfer && r.transferToStoreCode && !ehRetirada,
          );
          const finais = liveStatus.filter((r) => !feeders.includes(r));
          const paradas = raiox?.pecas.filter((p) => p.cor_semaforo === 'vermelho').length ?? 0;
          const algumEnviou = liveStatus.some((r) => r.status === 'shipped');
          const metodo = order.pickup?.shippingMethodTitle ?? separation?.shippingMethod ?? null;
          const envioLabel = metodo
            ? classifyShipping(metodo, order.shipping?.state ?? order.billing?.state ?? null).label
            : null;

          /** Uma loja dentro de uma coluna do trilho. */
          const cardLoja = (r: (typeof liveStatus)[number]) => {
            const hasIssue = !!r.issueReason;
            const tom = hasIssue
              ? 'crit'
              : r.status === 'shipped' || r.status === 'ready' || r.status === 'separated'
                ? 'ok'
                : 'warn';
            const label = hasIssue
              ? r.issueReasonLabel ?? 'Problema reportado'
              : r.status === 'shipped' ? 'Enviado'
              : r.status === 'ready' ? 'Pronto pra envio'
              : r.status === 'separated' ? 'Separado (bipe completo)'
              : r.status === 'separating' ? 'Separando agora'
              : 'Aguardando iniciar';
            const qtdNoCard = quantidadeDoCard(r);
            const ehReceptor =
              qtdNoCard === 0 && !!destinoObrigatorio && r.storeCode === destinoObrigatorio.code;
            const ehAncora =
              juntada?.juntando && !r.isTransfer && r.storeCode === juntada.ancoraStoreCode;
            const flash = !!liveStatusFlash[r.id];
            const st = printState[r.id] ?? 'idle';
            const err = printError[r.id];
            const canSwap = ['new', 'separating'].includes(r.status);

            return (
              <div
                key={r.id}
                className={`rounded-card border bg-surface p-3 transition-colors ${
                  flash ? 'border-ok' : 'border-line'
                }`}
                style={{
                  boxShadow: `inset 3px 0 0 var(--tom-${tom}, ${
                    tom === 'crit' ? '#C4291A' : tom === 'ok' ? '#2E9E5B' : '#B4720F'
                  })`,
                }}
              >
                <div className="flex items-baseline gap-2">
                  <span className="text-[13.5px] font-bold tracking-tight">{r.storeName}</span>
                  <span className="font-mono text-[11px] text-ink-faint">({r.storeCode})</span>
                  {flash && <span className="text-[11px] font-semibold text-ok">atualizado agora</span>}
                </div>

                {/* PAPEL da loja no trilho — o que ela faz, em português. */}
                <div className="mt-0.5 text-[11.5px] text-ink-soft">
                  {ehAncora
                    ? 'junta as caixas e envia o pedido completo'
                    : r.isTransfer && r.transferToStoreCode && !ehRetirada
                      ? `manda pra ${
                          juntada?.ancoraStoreName ||
                          liveStatus.find((x) => x.storeCode === r.transferToStoreCode)?.storeName ||
                          r.transferToStoreCode
                        }`
                      : ehReceptor
                        ? `destino do ${destinoObrigatorio!.tipo === 'motoboy' ? 'motoboy' : 'pedido'} — aguardando peças`
                        : ehRetirada
                          ? 'entrega pra cliente na loja'
                          : 'posta pra cliente'}
                </div>

                <div
                  className={`mt-1.5 text-[12px] font-bold ${
                    tom === 'crit' ? 'text-crit' : tom === 'ok' ? 'text-ok' : 'text-warn'
                  }`}
                  title={r.issueNote || undefined}
                >
                  {label}
                  {hasIssue && r.issueNote ? ` — “${r.issueNote}”` : ''}
                </div>

                {/* PEÇAS desta loja — com o "→ outra loja" por item, que move
                    UMA peça sem arrastar o card inteiro (LP-000244). */}
                {(r.items?.length ?? 0) > 0 && (
                  <ul className="mt-2 space-y-0.5 border-t border-line-soft pt-2">
                    {r.items!.map((it, i) => (
                      <li key={`${it.sku}-${i}`} className="group flex items-center gap-1.5 text-[12px]">
                        <span className="shrink-0 font-mono font-semibold text-ink-soft">{it.qty}×</span>
                        <span className="truncate">
                          {it.ref
                            ? [it.ref, [it.cor, it.tamanho].filter(Boolean).join(' ')].filter(Boolean).join(' · ')
                            : it.descricao || it.sku}
                        </span>
                        {it.id && ['new', 'separating'].includes(r.status) && (
                          <button
                            type="button"
                            onClick={() =>
                              abrirMoverPeca(
                                { id: it.id!, sku: it.sku, ref: it.ref, cor: it.cor, tamanho: it.tamanho, descricao: it.descricao },
                                { storeCode: r.storeCode, storeName: r.storeName, total: r.items?.length ?? 1 },
                              )
                            }
                            disabled={sepLoading}
                            className="ml-auto shrink-0 rounded-field px-1.5 py-0.5 text-[11px] text-ink-faint opacity-60 transition hover:bg-line-soft hover:text-ink group-hover:opacity-100 disabled:opacity-40"
                            title={`Mandar SÓ esta peça pra outra loja (o resto do card fica na ${r.storeCode})`}
                          >
                            → outra loja
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}

                {/* Caixa da juntada / rastreio / baixa no ERP — o que a linha
                    roxa e o rodapé dos cards diziam, agora no mesmo lugar. */}
                {r.caixaJuntada && (
                  <div className="mt-2 text-[11.5px] text-ink-soft">
                    Caixa <span className="font-mono font-semibold text-ink">{r.caixaJuntada.code}</span>
                    {r.caixaJuntada.status === 'received' ? (
                      <span className="font-semibold text-ok"> · chegou na âncora</span>
                    ) : (
                      <span className="font-semibold text-warn"> · em trânsito</span>
                    )}
                    {r.caixaJuntada.transportMode === 'proprio' && <> · carro da rede</>}
                    {r.caixaJuntada.trackingCode && (
                      <span className="ml-1 font-mono">{r.caixaJuntada.trackingCode}</span>
                    )}
                  </div>
                )}
                {r.status === 'shipped' && r.trackingCode && (
                  <div className="mt-2 text-[11.5px] text-ink-soft">
                    <Truck className="mr-1 inline h-3 w-3" />
                    <span className="font-mono font-semibold text-ink">{r.trackingCode}</span>
                    {r.carrier && <span className="ml-1.5">via {r.carrier}</span>}
                  </div>
                )}
                {r.debitStatus === 'missing' && (
                  <div className="mt-1 text-[11.5px] font-semibold text-crit">
                    Baixa no Giga falhou —{' '}
                    <Link href="/retaguarda/baixas-log" className="underline">
                      resolver no log
                    </Link>
                  </div>
                )}
                {/* ── NOTA FISCAL deste envio (27/08, pedido do dono) ──
                    Colada no rastreio de propósito: são as duas metades da mesma
                    pergunta — o que saiu e com que documento. A nota nasce por
                    CARD (`envio:<pickId>`), então pedido dividido tem uma nota
                    por loja, cada uma com o CNPJ de quem despachou. */}
                {r.nota && r.nota.status === 'authorized' && (
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11.5px] text-ink-soft">
                    <FileText className="h-3 w-3 shrink-0" />
                    <span>
                      NF-e <span className="font-mono font-semibold text-ink">{r.nota.numero}</span>
                      <span className="text-ink-soft">/{r.nota.serie}</span>
                    </span>
                    <span>
                      {(r.nota.valorCents / 100).toLocaleString('pt-BR', {
                        style: 'currency',
                        currency: 'BRL',
                      })}
                    </span>
                    {r.nota.homologacao && (
                      <span className="rounded-field bg-warn-soft px-1.5 py-0.5 text-[10px] font-bold uppercase text-warn">
                        homologação · sem valor fiscal
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => abrirDanfe(r.nota!)}
                      disabled={danfeBaixando === r.nota.id}
                      className="ml-auto rounded-field border border-line bg-surface px-2 py-1 text-[11.5px] font-semibold text-ink hover:bg-surface-2 disabled:opacity-50"
                      title={r.nota.chave ? `Chave ${r.nota.chave}` : 'Baixar DANFE'}
                    >
                      {danfeBaixando === r.nota.id ? '…' : 'DANFE'}
                    </button>
                  </div>
                )}
                {r.nota?.status === 'authorized' && r.nota.chave && (
                  // Chave de acesso: o que o contador pede e o que a cliente usa
                  // pra consultar no portal da SEFAZ.
                  <div className="mt-0.5 break-all font-mono text-[10px] text-ink-soft opacity-70">
                    {r.nota.chave}
                  </div>
                )}
                {r.nota && r.nota.status !== 'authorized' && (
                  <div className="mt-1 text-[11.5px] font-semibold text-crit">
                    NF-e {r.nota.status === 'rejected' ? 'REJEITADA' : r.nota.status}
                    {r.nota.xMotivo && <span className="font-normal"> — {r.nota.xMotivo}</span>}
                  </div>
                )}
                {/* Despachou sem nota: 99 de 647 cards em 30 dias. Pendência
                    fiscal — a tela mostra o buraco em vez de omitir. */}
                {r.status === 'shipped' && !r.nota && (
                  <div className="mt-1 text-[11.5px] font-semibold text-warn">
                    Despachado sem nota fiscal
                  </div>
                )}

                {/* AÇÕES da loja — cinza, sem competir com o estado. */}
                <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-line-soft pt-2">
                  <button
                    type="button"
                    onClick={() => sendPrintRemote(r.id, r.storeName || '')}
                    disabled={st === 'sending'}
                    className={`rounded-field border px-2 py-1 text-[11.5px] font-semibold ${
                      st === 'sent'
                        ? 'border-ok bg-ok-soft text-ok'
                        : st === 'error'
                          ? 'border-crit bg-crit-soft text-crit'
                          : 'border-line bg-surface text-ink hover:bg-surface-2'
                    }`}
                    title="Imprimir na térmica da loja"
                  >
                    {st === 'sending' ? '…' : st === 'sent' ? 'Impresso' : st === 'error' ? 'Reimprimir' : 'Imprimir'}
                  </button>
                  {r.storeCode && (
                    <button
                      type="button"
                      onClick={() => swapStore(r.storeCode!, r.storeName)}
                      disabled={sepLoading || !canSwap}
                      className="rounded-field border border-line bg-surface px-2 py-1 text-[11.5px] font-semibold text-ink hover:bg-surface-2 disabled:cursor-not-allowed disabled:text-ink-faint"
                      title={
                        canSwap
                          ? `Escolher outra loja no lugar de ${r.storeCode}. Só funciona se a loja ainda não bipou.`
                          : `Já passou de "separando" (status: ${r.status}). Não dá pra trocar sem perder trabalho da loja.`
                      }
                    >
                      ↔ Trocar loja
                    </button>
                  )}
                  {r.storeCode && !['shipped', 'delivered'].includes(r.status) && (
                    <button
                      type="button"
                      onClick={() => removerPickOrder(r.id, r.storeCode!, r.storeName)}
                      disabled={sepLoading}
                      className="rounded-field px-2 py-1 text-[11.5px] font-semibold text-ink-soft underline hover:text-crit disabled:opacity-60"
                      title={`Remover ${r.storeCode} do pedido (resolvido manualmente)`}
                    >
                      Remover
                    </button>
                  )}
                  {!!r.updatedAt && (
                    <span className="ml-auto text-[11px] text-ink-faint">
                      {new Date(r.updatedAt).toLocaleString('pt-BR', {
                        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
                      })}
                    </span>
                  )}
                </div>
                {st === 'error' && err && <div className="mt-1 text-[11.5px] text-crit">{err}</div>}
              </div>
            );
          };

          const colunas: Array<{ titulo: string; cards: typeof liveStatus }> = [];
          if (feeders.length) colunas.push({ titulo: 'Quem tem a peça', cards: feeders });
          if (finais.length) {
            colunas.push({
              titulo: juntada?.juntando
                ? 'Junta e envia'
                : ehRetirada
                  ? 'Entrega na loja'
                  : finais.length > 1
                    ? 'Enviam pra cliente'
                    : 'Envia pra cliente',
              cards: finais,
            });
          }

          return (
            <div className="mb-4">
              <div className="mb-2 flex flex-wrap items-baseline gap-2">
                <h4 className="text-[11px] font-bold uppercase tracking-[.13em] text-ink-faint">
                  {ehRetirada ? 'Até a mão da cliente' : 'A caminho da cliente'}
                </h4>
                <span className="text-[12px] text-ink-soft">
                  {liveStatus.length} loja{liveStatus.length === 1 ? '' : 's'}
                  {juntada?.juntando && (
                    <>
                      {' · '}
                      <b className={juntada.completa ? 'text-ok' : 'text-warn'}>
                        {juntada.recebidas ?? 0} de {juntada.totalCaixas ?? 0} caixa
                        {(juntada.totalCaixas ?? 0) === 1 ? '' : 's'} chegaram
                      </b>
                    </>
                  )}
                  {paradas > 0 && (
                    <>
                      {' · '}
                      <b className="text-crit">
                        {paradas} peça{paradas === 1 ? '' : 's'} sem dono
                      </b>
                    </>
                  )}
                </span>
                {juntada?.juntando && (
                  <button
                    type="button"
                    onClick={desfazerJuntada}
                    disabled={desfazendoJuntada}
                    className="ml-auto text-[12px] text-ink-soft underline hover:text-crit disabled:opacity-60"
                    title="Cada loja volta a enviar direto pra cliente (só dá antes de alguma caixa nascer)"
                  >
                    {desfazendoJuntada ? 'Desfazendo…' : 'Desfazer juntada'}
                  </button>
                )}
              </div>

              {/* As colunas do trilho. A seta só existe onde há fluxo de
                  verdade: loja → loja → cliente. Lojas que postam sozinhas
                  ficam EMPILHADAS na mesma coluna, sem seta entre elas. */}
              <div className="flex flex-col gap-5 lg:flex-row lg:items-stretch lg:gap-0">
                {colunas.map((col, i) => (
                  <div
                    key={col.titulo}
                    className={`flex min-w-0 flex-1 flex-col gap-2 ${i > 0 ? 'lg:ml-6 lg:border-l lg:border-line lg:pl-6' : ''}`}
                  >
                    <div className="text-[10.5px] font-bold uppercase tracking-[.11em] text-ink-faint">
                      {i > 0 && <span className="mr-1 lg:hidden">↓</span>}
                      {col.titulo}
                    </div>
                    {col.cards.map((r) => cardLoja(r))}
                  </div>
                ))}

                {/* Última etapa: a cliente. Fecha a frase — sem ela o trilho
                    termina numa loja e ninguém vê se o pacote saiu. */}
                <div className="flex min-w-0 flex-1 flex-col gap-2 lg:ml-6 lg:border-l lg:border-line lg:pl-6">
                  <div className="text-[10.5px] font-bold uppercase tracking-[.11em] text-ink-faint">
                    <span className="mr-1 lg:hidden">↓</span>
                    {ehRetirada ? 'Cliente retira' : 'Cliente recebe'}
                  </div>
                  <div className="rounded-card border border-line bg-surface p-3">
                    <div className="text-[13.5px] font-bold tracking-tight">
                      {[order.shipping?.first_name || order.billing?.first_name,
                        order.shipping?.last_name || order.billing?.last_name]
                        .filter(Boolean).join(' ') || 'Cliente'}
                    </div>
                    <div className="mt-0.5 text-[11.5px] text-ink-soft">
                      {order.shipping?.city
                        ? `${order.shipping.city} / ${order.shipping.state}`
                        : 'endereço no bloco de entrega'}
                      {envioLabel ? ` · ${envioLabel}` : ''}
                    </div>
                    <div className={`mt-1.5 text-[12px] font-bold ${algumEnviou ? 'text-ok' : 'text-ink-faint'}`}>
                      {order.tracking?.number
                        ? 'Objeto postado'
                        : algumEnviou
                          ? 'Enviado pela loja'
                          : ehRetirada
                            ? 'Aguardando a cliente buscar'
                            : 'Não postado ainda'}
                    </div>
                    {order.tracking?.number && (
                      <div className="mt-2 text-[11.5px]">
                        <span className="font-mono font-semibold">{order.tracking.number}</span>
                        {order.tracking.carrier && (
                          <span className="ml-1.5 text-ink-soft">via {order.tracking.carrier}</span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* ONDE ESTÁ CADA PEÇA — o raio-x, agora como tabela embaixo do
                  trilho em vez de terceira caixa colorida. Vermelho = parada,
                  e é ela que ganha os dois botões da saída. */}
              {raiox && raiox.pecas.length > 0 && (
                <div className="mt-4">
                  {raiox.alertas.map((a, i) => (
                    <div key={i} className="mb-2 rounded-card border border-crit/30 bg-crit-soft px-3 py-2 text-[12.5px] font-semibold text-crit">
                      {a}
                    </div>
                  ))}
                  {/* A tabela peça-a-peça saiu daqui (27/08, ordem do dono:
                      "temos dois quadros com as informações da peça"). Onde
                      cada peça está agora é COLUNA do quadro ITENS lá em cima,
                      com a bolinha do estado e a etiqueta da loja clicável. */}

                  {/* LINHA DO TEMPO — tudo que aconteceu, com QUEM. */}
                  <details className="mt-2">
                    <summary className="cursor-pointer select-none text-[12px] font-semibold text-ink-soft hover:text-ink">
                      Linha do tempo completa ({raiox.eventos.length} registro
                      {raiox.eventos.length === 1 ? '' : 's'})
                    </summary>
                    <div className="mt-2 max-h-96 space-y-1 overflow-y-auto pr-1">
                      {raiox.eventos.map((ev, i) => {
                        const quando = new Date(ev.em).toLocaleString('pt-BR', {
                          timeZone: 'America/Sao_Paulo',
                          day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
                        });
                        return (
                          <div key={i} className="flex items-start gap-2 border-b border-line-soft pb-1 text-[11.5px] leading-snug">
                            <span className="shrink-0 font-mono text-ink-faint">{quando}</span>
                            <span className="w-14 shrink-0 text-[10.5px] font-bold uppercase tracking-wider text-ink-faint">
                              {ev.origem}
                            </span>
                            <span className="flex-1 text-ink">
                              <b>{ev.titulo}</b>
                              {ev.detalhe ? <> — {ev.detalhe}</> : null}
                              <span className={ev.quem ? 'text-ink-soft' : 'italic text-ink-faint'}>
                                {' '}· {ev.quem ?? (ev.tipoAtor === 'sistema' ? 'sistema' : 'sem autor (registro antigo)')}
                              </span>
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </details>
                </div>
              )}

              {/* Trocar a loja escolhendo da lista, e juntar/desfazer juntada —
                  as portas que viviam em caixas amarelas soltas acima dos cards. */}
              <div className="mt-3 flex flex-wrap items-center gap-3 text-[12px]">
                {liveStatus.some((p) => ['new', 'separating'].includes(p.status)) && (
                  <button
                    onClick={() => openPickStoreModal()}
                    disabled={sepLoading}
                    className="rounded-field border border-line bg-surface px-3 py-1.5 font-semibold text-ink hover:bg-surface-2 disabled:opacity-60"
                  >
                    Escolher loja manualmente
                  </button>
                )}
                {(() => {
                  // JUNTAR NUMA LOJA — só com 2+ cards COM PEÇA, pedido de
                  // ENTREGA (retirada tem trilho próprio) e sem juntada ativa.
                  const cardsAtivos = liveStatus.filter((p) =>
                    ['new', 'separating', 'separated', 'ready'].includes(p.status),
                  );
                  const cardsComPecas = cardsAtivos.filter((p) => quantidadeDoCard(p) > 0);
                  const jaTemFeeder = cardsComPecas.some((p) => p.isTransfer && !destinoObrigatorio);
                  if (destinoObrigatorio || juntada?.juntando === true || jaTemFeeder) return null;
                  if (cardsComPecas.length < 2) return null;
                  return (
                    <>
                      <button
                        onClick={() => { setJuntarErro(null); setJuntarOpen(true); }}
                        disabled={sepLoading}
                        className="rounded-field border border-line bg-surface px-3 py-1.5 font-semibold text-ink hover:bg-surface-2 disabled:opacity-60"
                      >
                        Juntar numa loja só
                      </button>
                      <span className="text-ink-soft">
                        Pedido dividido em {cardsComPecas.length} lojas = {cardsComPecas.length} fretes.
                      </span>
                    </>
                  );
                })()}
                {/* ÂNCORA ÓRFÃ — a juntada aponta pra loja que saiu do pedido e
                    a caixa está viajando pra quem não separa nada (LP-000244).
                    Antes a tela ficava MUDA: dava pra ver e não dava pra
                    consertar. */}
                {(() => {
                  if (destinoObrigatorio) return null;
                  const cardsAtivos = liveStatus.filter((p) =>
                    ['new', 'separating', 'separated', 'ready'].includes(p.status),
                  );
                  const fd = cardsAtivos.filter((p) => p.isTransfer && p.transferToStoreCode);
                  if (!fd.length) return null;
                  const anc = String(fd[0].transferToStoreCode);
                  if (cardsAtivos.some((p) => !p.isTransfer && p.storeCode === anc)) return null;
                  return (
                    <div className="flex w-full flex-wrap items-center gap-2 rounded-card border border-crit/30 bg-crit-soft px-3 py-2 font-semibold text-crit">
                      A juntada aponta pra loja <b>{anc}</b>, que não tem card neste pedido — a caixa
                      está indo pra quem não separa nada.
                      <button
                        onClick={() => { setJuntarErro(null); setJuntarOpen(true); }}
                        disabled={sepLoading || cardsAtivos.length < 2}
                        className="ml-auto rounded-field border border-crit/40 bg-surface px-3 py-1.5 font-semibold text-crit hover:bg-crit/10 disabled:opacity-60"
                      >
                        Escolher a loja final de novo
                      </button>
                    </div>
                  );
                })()}
              </div>

              {/* ── MODAL: cancelar a peça e devolver o valor ── */}
              {cancelarPeca && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
                  <div className="w-full max-w-md rounded-card bg-surface p-4 shadow-xl">
                    <div className="mb-1 font-bold text-ink">Cancelar peça e devolver o valor</div>
                    <div className="mb-2 text-[13px] text-ink-soft">
                      <b className="text-ink">
                        {[cancelarPeca.ref, cancelarPeca.cor, cancelarPeca.tamanho].filter(Boolean).join(' ') || cancelarPeca.sku}
                      </b>
                      {cancelarPeca.quantity > 1 ? ` ×${cancelarPeca.quantity}` : ''} — devolver{' '}
                      <b className="text-crit">
                        R$ {(((cancelarPeca.unitPrice ?? 0) * cancelarPeca.quantity) || 0).toFixed(2)}
                      </b>{' '}
                      à cliente. O pedido segue com as outras peças.
                    </div>
                    <label className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-ink-soft">
                      Motivo (obrigatório)
                    </label>
                    <textarea
                      value={cancelarMotivo}
                      onChange={(e) => setCancelarMotivo(e.target.value)}
                      rows={2}
                      placeholder="Ex: ruptura — nenhuma loja da rede tem a peça; cliente será avisada e o PIX da peça devolvido"
                      className="mb-2 w-full rounded-field border border-line px-2 py-1.5 text-[13px]"
                    />
                    {cancelarErro && (
                      <div className="mb-2 rounded-field border border-crit/30 bg-crit-soft p-2 text-[12px] text-crit">
                        {cancelarErro}
                      </div>
                    )}
                    <div className="flex justify-end gap-2">
                      <button
                        onClick={() => setCancelarPeca(null)}
                        disabled={cancelarBusy}
                        className="rounded-field border border-line px-3 py-1.5 text-[13px] font-bold text-ink hover:bg-surface-2"
                      >
                        Voltar
                      </button>
                      <button
                        onClick={confirmarCancelarPeca}
                        disabled={cancelarBusy || cancelarMotivo.trim().length < 5}
                        className="rounded-field bg-crit px-3 py-1.5 text-[13px] font-bold text-white hover:opacity-90 disabled:opacity-50"
                      >
                        {cancelarBusy ? 'Cancelando…' : 'Cancelar peça e devolver'}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })()}

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
              {/* JUNTADA no preview: a regra automática (trio litoral) devolve a
                  âncora no nível raiz; fallback deriva do primeiro grupo
                  isTransfer — só em pedido de ENTREGA (retirada tem copy própria). */}
              {separation.success && !separation.isPickup && (() => {
                const nomeAncora = separation.consolidateStoreName
                  ?? separation.groups.find((g) => g.isTransfer)?.transferToStoreName
                  ?? null;
                if (!nomeAncora) return null;
                return (
                  <div className="mt-1 font-semibold">
                    🧲 JUNTANDO: as peças se encontram na LOJA {nomeAncora} e saem num
                    pacote só pra cliente (carro da rede no litoral).
                  </div>
                );
              })()}
              <div className="text-xs mt-1 opacity-80">Envio: {separation.shippingMethod}</div>
            </div>

            {/* Troca manual ativa no preview — mostra o que foi trocado e permite
                voltar pra sugestão automática antes de confirmar. */}
            {(previewExcludes.length > 0 || previewPins.length > 0) && !confirmResult?.ok && (
              <div className="bg-amber-50 border border-amber-300 rounded p-3 mb-4 text-sm text-amber-900 flex items-center justify-between gap-3 flex-wrap">
                <div>
                  ↔ <b>Troca manual aplicada</b>
                  {previewExcludes.length > 0 && (
                    <> — sem <b>{previewExcludes.join(', ')}</b></>
                  )}
                  {previewPins.length > 0 && (
                    <>, priorizando <b>{previewPins.join(', ')}</b></>
                  )}
                  . Essa escolha vale no "Confirmar e enviar pras lojas".
                </div>
                <button
                  onClick={desfazerTrocaManual}
                  disabled={sepLoading}
                  className="px-3 py-1.5 bg-white border border-amber-400 text-amber-800 rounded text-xs font-semibold hover:bg-amber-100 disabled:opacity-60"
                >
                  Desfazer (sugestão automática)
                </button>
              </div>
            )}

            {/* ── RUPTURA: MANDAR O CARD COM TODAS AS PEÇAS ─────────────────
                O `pickup-blocked`/ruptura devolve `assignments: []` de
                propósito ("operação precisa decidir") — resultado: NADA é
                criado, nem pras peças que existem, e o pedido para em
                awaiting_stock com o dinheiro na conta.

                Só que a decisão quase sempre é a mesma: manda o card inteiro
                pra loja que vai entregar, ela bipa o que tem e o que falta
                chega depois. O backend já sabe fazer isso (`forceStoreCode`
                cria o card MESMO SEM ESTOQUE, bypassando o routing) — o que
                faltava era a porta: o botão "Escolher loja manualmente" só
                aparecia com card ativo, ou seja, nunca depois de uma ruptura.

                Caso ON-000006 (17/08): retirada em São José dos Campos, 11
                peças, 1 SKU sem estoque em loja nenhuma → separação bloqueada
                e SJC sem card. */}
            {!separation.success && (
              <div className="mb-4 rounded-lg border-2 border-amber-300 bg-amber-50 p-3">
                <div className="text-sm font-bold text-amber-900">
                  Precisa mandar o card mesmo assim?
                </div>
                <div className="text-xs text-amber-800 mt-1">
                  Escolha a loja que vai <b>entregar</b>: o card nasce lá com <b>todas as peças</b>,
                  inclusive as que ela não tem. Ela bipa o que estiver na arara e o resto chega
                  por transferência.
                  {separation.pickupStoreName && (
                    <> Esta é uma <b>retirada em {separation.pickupStoreName}</b> — normalmente é essa a loja.</>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => openPickStoreModal()}
                  disabled={sepLoading}
                  className="mt-2 rounded-lg bg-amber-600 px-4 py-2 text-sm font-bold text-white hover:bg-amber-700 disabled:opacity-50"
                >
                  🎯 Escolher a loja e mandar o card com todas
                </button>
              </div>
            )}

            {/* ── ESCOLHER OUTRA LOJA — single-store com alternativas ────────
                 Mostra radio buttons com a sugestão automática + até 5 outras
                 lojas que TAMBÉM cobrem o pedido inteiro. Admin pode trocar
                 antes de confirmar (ex: prefere consolidar todas vendas na
                 mesma loja, ou loja sugerida está com problema operacional). */}
            {separation.success &&
              separation.strategy === 'single-store' &&
              separation.alternativeFullStores &&
              separation.alternativeFullStores.length > 0 && (
                <div className="bg-white border border-slate-200 rounded-lg p-3 mb-4">
                  <div className="text-xs font-bold text-slate-700 mb-2 flex items-center gap-2">
                    🎯 Escolher loja pra separar
                    {switchingStore && <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-400" />}
                  </div>
                  <div className="space-y-1.5">
                    {/* Opção 1: sugestão automática (loja atual) */}
                    <label className={`flex items-center gap-2.5 p-2 rounded cursor-pointer border transition ${
                      preferredStoreCode === null
                        ? 'bg-emerald-50 border-emerald-300'
                        : 'border-transparent hover:bg-slate-50'
                    }`}>
                      <input
                        type="radio"
                        name="preferred-store"
                        checked={preferredStoreCode === null}
                        onChange={() => switchPreferredStore(null)}
                        disabled={switchingStore}
                        className="w-4 h-4 accent-emerald-600"
                      />
                      <div className="flex-1">
                        <div className="font-semibold text-sm text-slate-900">
                          {separation.groups[0]?.storeName} ({separation.groups[0]?.storeCode})
                        </div>
                        <div className="text-[10px] text-emerald-700 font-bold">
                          ✓ Sugestão automática (melhor score)
                        </div>
                      </div>
                    </label>
                    {/* Opções alternativas: outras lojas que cobrem tudo */}
                    {separation.alternativeFullStores.map((alt) => (
                      <label
                        key={alt.storeCode}
                        className={`flex items-center gap-2.5 p-2 rounded cursor-pointer border transition ${
                          preferredStoreCode === alt.storeCode
                            ? 'bg-indigo-50 border-indigo-300'
                            : 'border-transparent hover:bg-slate-50'
                        }`}
                      >
                        <input
                          type="radio"
                          name="preferred-store"
                          checked={preferredStoreCode === alt.storeCode}
                          onChange={() => switchPreferredStore(alt.storeCode)}
                          disabled={switchingStore}
                          className="w-4 h-4 accent-indigo-600"
                        />
                        <div className="flex-1">
                          <div className="font-semibold text-sm text-slate-900">
                            {alt.storeName} ({alt.storeCode})
                          </div>
                          <div className="text-[10px] text-slate-500">
                            Cobre o pedido inteiro · folga estoque: {alt.stockBuffer.toFixed(1)}
                          </div>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              )}

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
                        {/* Copy por tipo: RETIRADA = cliente busca na loja destino;
                            JUNTADA (entrega) = a âncora envia o pacote único. */}
                        {g.isTransfer && g.transferToStoreName && (
                          <span className={`px-2 py-0.5 rounded text-xs font-semibold ${
                            separation.isPickup
                              ? 'bg-orange-200 text-orange-900'
                              : 'bg-violet-200 text-violet-900'
                          }`}>
                            {separation.isPickup
                              ? <>🚚 TRANSFERIR PRA {g.transferToStoreName}</>
                              : <>🧲 MANDA PRA {g.transferToStoreName}</>}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-slate-500">
                        {[g.storeCity, g.storeState].filter(Boolean).join(' / ') || '—'}
                        {g.whatsapp ? ` · 📱 ${g.whatsapp}` : ' · sem WhatsApp cadastrado'}
                      </div>
                      {g.isTransfer && (
                        <div className={`text-xs mt-1 font-medium ${
                          separation.isPickup ? 'text-orange-800' : 'text-violet-800'
                        }`}>
                          {separation.isPickup
                            ? <>⚠ Separar e enviar pra loja {g.transferToStoreName} — cliente vai retirar lá.</>
                            : <>🧲 Manda as peças pra LOJA {g.transferToStoreName}, que envia tudo junto pra cliente.</>}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-2 flex-wrap justify-end">
                      {/* Botão trocar loja: vale pra loja FONTE de transferência e pra
                          qualquer grupo de single/multi-store (troca manual no preview).
                          Na pickup-lock e na loja DESTINO da retirada, trocar não
                          adianta (destino é fixo). Antes do confirmar, a troca só
                          refaz o preview (nada é enviado); depois, faz swap cirúrgico
                          do pick-order via modal. */}
                      {g.storeCode &&
                        (g.isTransfer ||
                          separation.strategy === 'multi-store' ||
                          separation.strategy === 'single-store') && (
                        <button
                          onClick={() => swapStore(g.storeCode!, g.storeName)}
                          disabled={sepLoading}
                          className="inline-flex items-center gap-1 px-3 py-2 rounded text-sm border bg-amber-50 text-amber-800 border-amber-300 hover:bg-amber-100 disabled:opacity-60"
                          title={`Escolher outra loja no lugar de ${g.storeCode}.`}
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
      )}

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

            {/* MOTIVO DO CANCELAMENTO (26/08) — obrigatório, e vai pro
                histórico com o nome de quem clicou. A loja já é obrigada a
                dizer o porquê quando reporta ruptura numa peça; a retaguarda
                cancelando o pedido inteiro não tinha exigência nenhuma. */}
            {cancelando && (
              <div className="mt-3 border border-red-200 bg-red-50 rounded p-3">
                <label className="block text-sm font-medium text-red-800 mb-1">
                  Motivo do {status === 'refunded' ? 'reembolso' : 'cancelamento'} *
                </label>
                <textarea
                  value={cancelReason}
                  onChange={(e) => setCancelReason(e.target.value)}
                  rows={2}
                  placeholder="Ex: ruptura — nenhuma loja tem a SMILE 54; cliente avisada e PIX devolvido"
                  className="w-full border border-red-300 rounded px-3 py-2 text-sm bg-white"
                />
                <p className="text-xs text-red-700 mt-1">
                  {faltaMotivoCancelamento
                    ? 'Escreva o motivo pra liberar o cancelamento — ele fica gravado no histórico com o seu nome.'
                    : 'Fica gravado no histórico do pedido junto com o seu nome.'}
                </p>
              </div>
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

            {/* Rastreio ao vivo — eventos + FICHA do objeto (serviço, postagem,
                previsão de entrega, peso) e a linha do dinheiro: o frete que a
                cliente pagou contra o que o transporte DAQUELA etiqueta cobra
                hoje pelo mesmo trajeto. O CEP e a contagem de peças montam a
                MESMA caixa que o checkout cota (250 g/peça) — cotar com outra
                caixa dá outro preço e a conferência não serve pra nada.
                `lojaCode` é a loja que POSTOU: sem ela a cotação sai do CEP
                padrão e o card não dá veredito de prejuízo (cotar de outra
                cidade inventa diferença que não existe). */}
            {order.tracking?.number && (
              <div className="mt-4">
                <TrackingTimeline
                  code={order.tracking.number}
                  carrier={order.tracking.carrier}
                  autoFetch
                  cepDestino={order.shipping?.postcode || order.billing?.postcode || null}
                  pecas={pecasDoPedido.reduce((s, li) => s + (Number(li.quantity) || 1), 0)}
                  lojaCode={lojaQuePostou}
                  fretePago={freteDoPedido.valor || null}
                  custoEtiqueta={custoEtiqueta}
                  custoEtiquetaFonte={cardQuePostou?.freteCustoFonte ?? null}
                  metodoPago={freteDoPedido.metodo || null}
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
              setCancelReason('');
            }}
            disabled={!hasChanges || saving}
            className="px-4 py-2 border rounded hover:bg-slate-50 text-sm disabled:opacity-40"
          >
            Descartar alterações
          </button>
          <button
            onClick={save}
            disabled={!hasChanges || saving || faltaMotivoCancelamento}
            title={faltaMotivoCancelamento ? 'Escreva o motivo do cancelamento' : undefined}
            className="px-5 py-2 bg-brand text-white rounded hover:bg-brand-dark text-sm disabled:opacity-50 flex items-center gap-2"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            {saving ? 'Enviando para o site...' : 'Salvar no site'}
          </button>
        </div>
      </div>

      {/* Attribution — a origem crua do WooCommerce continua aqui embaixo como
          rodapé técnico; o que a operação lê é o bloco de campanha lá em cima. */}
      <div className="text-xs text-slate-500 text-right">
        {order.attribution.origem} · {order.attribution.source}
      </div>

      {/* MODAL — Mandar SÓ ESTA PEÇA pra outra loja */}
      {moverPeca && (
        <div
          className="fixed inset-0 z-[85] bg-black/60 flex items-center justify-center p-4"
          {...overlayClose(() => !moverBusy && setMoverPeca(null))}
        >
          <div
            className="bg-white rounded-lg shadow-2xl max-w-xl w-full max-h-[85vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-4 border-b">
              <h3 className="font-bold text-lg text-slate-800">
                Mandar SÓ esta peça pra outra loja
              </h3>
              <p className="text-sm text-slate-700 mt-1">
                <b>
                  {[moverPeca.item.ref || moverPeca.item.sku, [moverPeca.item.cor, moverPeca.item.tamanho].filter(Boolean).join(' ')]
                    .filter(Boolean)
                    .join(' · ')}
                </b>
                {moverPeca.fromStoreCode && (
                  <> — hoje na <b>{moverPeca.fromStoreName || moverPeca.fromStoreCode}</b></>
                )}
              </p>
              <p className="text-xs text-slate-500 mt-1">
                {moverPeca.totalNoCard > 1
                  ? `As outras ${moverPeca.totalNoCard - 1} peça(s) do card CONTINUAM na ${moverPeca.fromStoreCode}.`
                  : 'É a única peça do card — a loja sai do pedido.'}
              </p>
            </div>
            <div className="p-4 overflow-y-auto flex-1">
              {moverErro && (
                <div className="mb-3 text-sm bg-red-50 border border-red-200 text-red-800 rounded p-2">
                  {moverErro}
                </div>
              )}
              {moverLoading ? (
                <div className="text-sm text-slate-500">Carregando saldo das lojas…</div>
              ) : (
                <ul className="space-y-1">
                  {moverOpcoes.map((o) => (
                    <li key={o.storeCode}>
                      <button
                        type="button"
                        onClick={() => moverPecaPara(o.storeCode)}
                        disabled={!!moverBusy}
                        className={`w-full text-left px-3 py-2 rounded border flex items-center gap-2 transition disabled:opacity-50 ${
                          o.qty > 0
                            ? 'border-emerald-200 bg-emerald-50/50 hover:bg-emerald-50'
                            : 'border-red-200 bg-red-50/40 hover:bg-red-50'
                        }`}
                      >
                        <span className="font-semibold text-slate-800">{o.storeName}</span>
                        <span className="text-xs text-slate-500">({o.storeCode})</span>
                        {o.jaNoPedido && (
                          <span className="text-[11px] px-1.5 py-0.5 rounded bg-violet-100 text-violet-800 border border-violet-200">
                            já está no pedido
                          </span>
                        )}
                        {o.reportou && (
                          <span className="text-[11px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-200">
                            reportou problema aqui
                          </span>
                        )}
                        <span
                          className={`ml-auto text-xs font-bold ${o.qty > 0 ? 'text-emerald-700' : 'text-red-700'}`}
                        >
                          {o.qty > 0 ? `${o.qty} em estoque` : 'SEM SALDO'}
                        </span>
                        {moverBusy === o.storeCode && <span className="text-xs text-slate-500">…</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-[11px] text-slate-500 mt-3">
                Loja com <b className="text-red-700">SEM SALDO</b> aparece de propósito: dá pra
                forçar, mas foi assim que esta peça passou por três lojas zeradas antes de chegar
                em alguém que a tivesse.
              </p>
            </div>
            <div className="p-3 border-t flex justify-end">
              <button
                onClick={() => setMoverPeca(null)}
                disabled={!!moverBusy}
                className="px-3 py-1.5 text-sm rounded border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL — Escolher loja manualmente */}
      {pickStoreOpen && (
        <div
          className="fixed inset-0 z-[80] bg-black/60 flex items-center justify-center p-4"
          {...overlayClose(() => !pickStoreApplying && (setPickStoreOpen(false), setSwapTarget(null), setPreviewSwapTarget(null)))}
        >
          <div
            className="bg-white rounded-lg shadow-2xl max-w-2xl w-full max-h-[85vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-4 border-b flex items-center justify-between">
              <div>
                {!swapTarget && previewSwapTarget ? (
                  <>
                    <h3 className="font-bold text-lg text-slate-800">
                      Trocar loja: {previewSwapTarget.storeName || previewSwapTarget.storeCode}
                    </h3>
                    <p className="text-xs text-amber-700 mt-0.5">
                      Troca na <b>sugestão</b> (nada foi enviado pra loja ainda): o sistema refaz
                      a divisão sem {previewSwapTarget.storeCode}, priorizando a loja escolhida.
                      Depois é só revisar e clicar em <b>Confirmar e enviar pras lojas</b>.
                    </p>
                  </>
                ) : swapTarget ? (
                  <>
                    <h3 className="font-bold text-lg text-slate-800">
                      Trocar loja: {swapTarget.fromStoreName || swapTarget.fromStoreCode}
                    </h3>
                    <p className="text-xs text-amber-700 mt-0.5">
                      Os items dessa loja serão movidos pra a loja que você escolher abaixo.
                      Outras lojas do pedido NÃO são afetadas. Status atual: <b>{swapTarget.fromStatus}</b>.
                      {['shipped', 'delivered'].includes(swapTarget.fromStatus) &&
                        ' ⚠️ Loja já enviou — estoque Giga será estornado automaticamente.'}
                    </p>
                  </>
                ) : (
                  <>
                    <h3 className="font-bold text-lg text-slate-800">Escolher loja manualmente</h3>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Força o pedido pra uma loja específica. Usado quando o routing automático
                      não atende (ex: loja reportou problema, você quer concentrar numa loja só).
                    </p>
                  </>
                )}
              </div>
              <button
                onClick={() => !pickStoreApplying && (setPickStoreOpen(false), setSwapTarget(null), setPreviewSwapTarget(null))}
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
                    Ordenado por <b>maior cobertura</b> (mais SKUs disponíveis)
                    {swapTarget
                      ? <> — <b>só dos itens de {swapTarget.fromStoreName || swapTarget.fromStoreCode}</b> (as outras lojas do pedido não entram na conta).</>
                      : previewSwapTarget
                      ? <> — <b>só dos itens de {previewSwapTarget.storeName || previewSwapTarget.storeCode}</b> (as outras lojas do pedido não entram na conta).</>
                      : ' do pedido.'}
                    {' '}A loja <b>✓ verde</b> cobre tudo. <b>⚠ amarelo</b> cobre parcialmente
                    (vai faltar peça — ia precisar transferir ou quebrar de novo).
                  </div>
                  {pickStoreCandidates.map((c) => {
                    const full = c.skusCovered >= c.skusTotal && c.skusTotal > 0;
                    const partial = c.skusCovered > 0 && !full;
                    const none = c.skusCovered === 0;
                    const isCurrentAssigned =
                      liveStatus.some((p) => p.storeCode === c.code && ['new', 'separating'].includes(p.status)) ||
                      (!swapTarget && previewSwapTarget?.storeCode === c.code);
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
                                🚫 já negou este pedido
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
                            {/* A peça está na arara, mas já tem dono: outro card
                                aberto nesta loja vai levar ela. Sem esta linha a
                                loja "some" e ninguém entende por quê. */}
                            {c.reservedQty > 0 && (
                              <span className="text-amber-700 font-medium">
                                {' '}· {c.reservedQty} já prometida{c.reservedQty > 1 ? 's' : ''} a outro pedido
                              </span>
                            )}
                          </div>
                          {c.missingSkus.length > 0 && c.missingSkus.length <= 5 && (
                            <div className="text-xs text-slate-600 mt-1">
                              <span className="opacity-70">Faltam:</span>{' '}
                              <span className="font-mono">{c.missingSkus.join(', ')}</span>
                            </div>
                          )}
                        </div>
                        <button
                          onClick={() => {
                            // Loja SEM estoque: confirmação extra pra evitar erro acidental.
                            // Loja COM estoque: aplica direto.
                            if (none) {
                              const ok = window.confirm(
                                `${c.name} (${c.code}) NÃO TEM estoque de nenhuma peça desse pedido.\n\n` +
                                `Forçando essa loja, ela vai precisar buscar transferência das outras lojas pra atender.\n\n` +
                                `Confirma forçar mesmo assim?`,
                              );
                              if (!ok) return;
                            } else if (c.hasReportedIssue) {
                              // Já negou = quase sempre volta negado (carrossel do
                              // ON-000110). Fricção de propósito, não bloqueio.
                              const ok = window.confirm(
                                `${c.name} (${c.code}) JÁ NEGOU peça deste pedido ("não temos").\n\n` +
                                `Mandar de novo quase sempre volta negado. Confirma mesmo assim?`,
                              );
                              if (!ok) return;
                            }
                            applyPickStore(c.code, c.name);
                          }}
                          disabled={!!pickStoreApplying || isCurrentAssigned}
                          className={`px-3 py-2 rounded text-xs font-semibold flex-shrink-0 flex items-center gap-1 ${
                            isCurrentAssigned
                              ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
                              : none
                              ? 'bg-slate-500 text-white hover:bg-slate-600 disabled:opacity-60'
                              : 'bg-brand text-white hover:bg-brand-dark disabled:opacity-60'
                          }`}
                          title={
                            isCurrentAssigned
                              ? 'Essa loja já é a responsável atual'
                              : none
                              ? 'Forçar mesmo SEM estoque (confirmação extra)'
                              : `Forçar pedido pra ${c.name}`
                          }
                        >
                          {pickStoreApplying === c.code ? (
                            <>
                              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Aplicando...
                            </>
                          ) : (
                            <>{none ? 'Forçar mesmo assim' : 'Escolher'}</>
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
                onClick={() => !pickStoreApplying && (setPickStoreOpen(false), setSwapTarget(null), setPreviewSwapTarget(null))}
                disabled={!!pickStoreApplying}
                className="px-3 py-1.5 border rounded hover:bg-white text-slate-700 disabled:opacity-60"
              >
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL — Juntar numa loja (escolher a ÂNCORA da juntada). Mesmo padrão
          visual do "Escolher loja manualmente" acima, mas a lista é SÓ das
          lojas com card ativo neste pedido — o backend recusa qualquer outra. */}
      {juntarOpen && (
        <div
          className="fixed inset-0 z-[80] bg-black/60 flex items-center justify-center p-4"
          {...overlayClose(() => !juntarBusy && setJuntarOpen(false))}
        >
          <div
            className="bg-white rounded-lg shadow-2xl max-w-lg w-full max-h-[85vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-4 border-b flex items-center justify-between">
              <div>
                <h3 className="font-bold text-lg text-slate-800">🧲 Juntar numa loja</h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  As outras lojas vão mandar as peças pra loja escolhida, que envia TUDO
                  num pacote só pra cliente. Sai NF de transferência e etiqueta pra loja
                  (Itanhaém/Praia Grande/Santos vai de carro).
                </p>
              </div>
              <button
                onClick={() => !juntarBusy && setJuntarOpen(false)}
                className="text-slate-400 hover:text-slate-700 text-2xl leading-none p-1"
                disabled={!!juntarBusy}
              >
                ×
              </button>
            </div>

            <div className="p-4 overflow-y-auto flex-1 space-y-2">
              {juntarErro && (
                <div className="bg-red-50 text-red-700 p-3 rounded text-sm flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <div>{juntarErro}</div>
                </div>
              )}
              {liveStatus
                .filter(
                  (p) =>
                    ['new', 'separating', 'separated', 'ready'].includes(p.status) &&
                    quantidadeDoCard(p) > 0,
                )
                .map((p) => {
                  const pecas = quantidadeDoCard(p);
                  return (
                    <div
                      key={p.id}
                      className="border border-slate-200 rounded-lg p-3 flex items-center gap-3"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold text-slate-800">
                          {p.storeName}{' '}
                          <span className="text-xs font-mono text-slate-500">({p.storeCode})</span>
                        </div>
                        <div className="text-xs text-slate-500">{pecas} peça(s) neste card</div>
                      </div>
                      <button
                        onClick={() => p.storeCode && aplicarJuntada(p.storeCode, p.storeName)}
                        disabled={!!juntarBusy || !p.storeCode}
                        className="px-3 py-2 rounded text-xs font-semibold bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-60 flex items-center gap-1 flex-shrink-0"
                        title={`As outras lojas mandam as peças pra ${p.storeName || p.storeCode}`}
                      >
                        {juntarBusy === p.storeCode ? (
                          <>
                            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Juntando…
                          </>
                        ) : (
                          'Juntar aqui'
                        )}
                      </button>
                    </div>
                  );
                })}
            </div>

            <div className="p-3 border-t bg-slate-50 text-xs text-slate-500 flex items-center justify-between">
              <span>O envio final da âncora só libera quando todas as caixas chegarem.</span>
              <button
                onClick={() => !juntarBusy && setJuntarOpen(false)}
                disabled={!!juntarBusy}
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

      {/* Troca manual de item — mostra o acerto do dinheiro antes de confirmar;
          o backend aplica, cobra/da vale e re-roteia o pedido inteiro. */}
      {trocaItem && (
        <TrocaPecaModal
          wcId={wcId}
          orderItemId={trocaItem.id}
          currentLabel={trocaItem.label}
          onDone={aposTrocaDePeca}
          onClose={() => setTrocaItem(null)}
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
    rows: Array<{ storeCode: string; storeName: string; tipo: string; active: boolean; real: number; committed: number; liquid: number }>;
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
      {...overlayClose(onClose)}
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
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
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
                  <>
                  <div className="border rounded-lg overflow-hidden">
                    <div className="grid grid-cols-[1fr_60px_70px_80px_90px_80px] gap-2 px-3 py-2 bg-slate-100 text-[10px] uppercase tracking-wider font-bold text-slate-600">
                      <div>Loja</div>
                      <div className="text-center">Tipo</div>
                      <div className="text-center">Status</div>
                      <div className="text-right">Real</div>
                      <div className="text-right">Compromet.</div>
                      <div className="text-right">Líquido</div>
                    </div>
                    {data.rows.map((r) => (
                      <div
                        key={r.storeCode}
                        className={`grid grid-cols-[1fr_60px_70px_80px_90px_80px] gap-2 px-3 py-2 text-sm border-t border-slate-100 items-center ${
                          !r.active && r.real > 0 ? 'bg-rose-50/50' : ''
                        }`}
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
                        <div className="text-center text-[10px] font-bold">
                          {r.active ? (
                            <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800">ATIVA</span>
                          ) : (
                            <span className="px-1.5 py-0.5 rounded bg-rose-200 text-rose-900" title="Loja desativada — routing ignora estoque desta loja!">
                              INATIVA
                            </span>
                          )}
                        </div>
                        <div className="text-right tabular-nums text-blue-700 font-bold">{r.real}</div>
                        <div className="text-right tabular-nums text-amber-700 font-bold">
                          {r.committed > 0 ? r.committed : '—'}
                        </div>
                        <div className={`text-right tabular-nums font-black ${
                          r.liquid > 0 && r.active ? 'text-emerald-700' : 'text-rose-700'
                        }`}>
                          {r.active ? r.liquid : '—'}
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Aviso quando há estoque em loja inativa */}
                  {data.rows.some((r) => !r.active && r.real > 0) && (
                    <div className="mt-2 bg-rose-50 border-2 border-rose-300 rounded-lg p-3 text-sm text-rose-900">
                      <b>⚠️ ESTOQUE EM LOJA INATIVA:</b> uma ou mais linhas acima estão marcadas como <b>INATIVA</b> e
                      <b> têm estoque real &gt; 0</b>. O routing ignora lojas inativas. Pra usar essa peça, ative a loja em{' '}
                      <Link href="/retaguarda/lojas" className="underline font-bold" target="_blank">/retaguarda/lojas</Link>{' '}
                      e clique em <b>Recalcular separação</b> de novo.
                    </div>
                  )}
                  </>
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
