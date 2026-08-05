'use client';
import { overlayClose } from '@/lib/overlayClose';

/**
 * /minha-loja/realinhamento — Tela onde a FILIAL separa as ordens de
 * realinhamento que a matriz despachou.
 *
 * Fluxo:
 *   1. GET /realignment/mine → lista tudo que tá pending pra essa loja ORIGEM.
 *   2. Agrupa por LOJA DESTINO → cada card = "pra qual loja vai".
 *   3. Dentro do card, agrupa por REF mostrando grade Cor × Tamanho (estilo
 *      /consultar) pra vendedora achar as peças rápido na arara.
 *   4. Botão "Enviei esta peça" por linha → PATCH /realignment/:id/sent.
 *      Remove da lista, emite socket pra matriz acompanhar.
 *   5. Socket 'realignment:new' → adiciona ordens novas em tempo real.
 *   6. Socket 'realignment:sent' → sincroniza se marcar enviado em outra aba.
 *
 * Motivo do design: a vendedora na loja não tem paciência pra ficar rolando
 * uma lista longa. Agrupando por DESTINO ela faz uma pilha por loja, e
 * agrupando por REF dentro dela consegue pegar todas as cores+tamanhos da
 * mesma referência em uma ida só na arara.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api } from '@/lib/api';
import { appPrompt } from '@/lib/app-prompt';
import { getSocket } from '@/lib/socket';
import ProductThumb from '@/components/ProductThumb';
import {
  ArrowLeft, Shuffle, CheckCircle2, Loader2, RefreshCw, Package,
  AlertCircle, Send, Sparkles, Shirt, ChevronDown, Printer, Undo2,
  Truck, X, FileText, RotateCcw,
} from 'lucide-react';

interface RealignmentItem {
  id: string;
  refCode: string;
  descricao: string | null;
  cor: string | null;
  tamanho: string | null;
  qtyOrigem: number;
  lojaDestinoCode: string;
  lojaDestinoName: string;
  solicitanteNome: string;
  mensagem: string;
  createdAt: string;
  imageUrl?: string | null;
  // Preenchido apenas na view "enviados hoje" — horário em que a vendedora
  // marcou a peça como separada. Usado pra exibir na célula em verde.
  sentAt?: string | null;
  // 'pending' | 'not_found' — a peça reportada como não achada CONTINUA na
  // lista (04/08). Some da tela era o que fazia a pilha inteira do destino
  // desaparecer quando era a última peça.
  realignmentStatus?: string | null;
  realignmentNotFoundNote?: string | null;
  /** TODAS as ordens desta cor+tamanho (a matriz pode ter mais de uma —
   *  cadastro com dois códigos pra mesma peça, ou pedido em duas linhas).
   *  Só é preenchido no item que representa a célula da grade. */
  celula?: RealignmentItem[];
}

type ViewMode = 'pending' | 'sent';

/** Formata ISO → HH:MM no fuso local. */
function formatTime(iso: string | null | undefined): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

/** Title-case pra descrição — o Giga devolve tudo maiúsculo, fica elegante
 *  em "Vestido Midi Estampa Preto" ao invés de gritando. */
function toTitleCase(s: string): string {
  const SMALL = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'com', 'em', 'para', 'pra']);
  return s
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((w, i) => {
      if (i > 0 && SMALL.has(w)) return w;
      // preserva dígitos e abreviações
      if (/\d/.test(w)) return w.toUpperCase();
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(' ');
}

interface MeProfile {
  userId: string;
  email: string;
  role: 'admin' | 'operator' | 'store';
  storeId: string | null;
  storeCode: string | null;
  storeName: string | null;
}

// Ordenação de tamanhos igual da tela /consultar: numéricos asc depois letras
const SIZE_ORDER = ['PP', 'P', 'M', 'G', 'GG', 'XG', 'XGG', 'EG', 'EGG'];
function sortSizes(a: string | null, b: string | null): number {
  const A = (a || '').toUpperCase().trim();
  const B = (b || '').toUpperCase().trim();
  const na = Number(A);
  const nb = Number(B);
  const aIsNum = !Number.isNaN(na);
  const bIsNum = !Number.isNaN(nb);
  if (aIsNum && bIsNum) return na - nb;
  if (aIsNum) return -1;
  if (bIsNum) return 1;
  const ia = SIZE_ORDER.indexOf(A);
  const ib = SIZE_ORDER.indexOf(B);
  if (ia >= 0 && ib >= 0) return ia - ib;
  if (ia >= 0) return -1;
  if (ib >= 0) return 1;
  return A.localeCompare(B);
}

export default function MinhaLojaRealinhamentoPage() {
  const router = useRouter();
  const [me, setMe] = useState<MeProfile | null>(null);
  const [items, setItems] = useState<RealignmentItem[]>([]);
  // Ordens já enviadas HOJE — conferência pra vendedora ver o que já separou.
  // Preenchido via GET /realignment/mine-sent.
  const [sentItems, setSentItems] = useState<RealignmentItem[]>([]);
  // Toggle entre "Pendentes" e "Enviados hoje". Default = pendentes (o trabalho).
  const [view, setView] = useState<ViewMode>('pending');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sendingIds, setSendingIds] = useState<Set<string>>(new Set());
  // IDs em processo de REVERSÃO (sent → pending). UI mostra spinner na célula.
  const [revertingIds, setRevertingIds] = useState<Set<string>>(new Set());
  const [toasts, setToasts] = useState<Array<{ id: string; msg: string }>>([]);
  // Accordion: só 1 pilha aberta por vez. Começa TUDO fechado — vendedora
  // vê só os botões das lojas destino empilhados e abre o que for separar.
  const [expandedDest, setExpandedDest] = useState<string | null>(null);
  // No modo impressão, força TODAS as pilhas abertas pra sair completo no papel.
  // Toggle temporário (~500ms) só durante o window.print().
  const [printMode, setPrintMode] = useState(false);

  // ── REMESSAS ABERTAS ──
  // Cada vez que vendedora clica "Enviei" numa peça, ela vai pra remessa
  // OPEN do par origem→destino. Aqui listamos essas remessas pra ela poder
  // FECHAR e ENVIAR (baixa Giga em batch + manda alerta pra loja destino).
  const [openShipments, setOpenShipments] = useState<any[]>([]);
  // Fechadas e ainda sem etiqueta — some da lista sozinha quando a etiqueta sai.
  const [pendingLabel, setPendingLabel] = useState<any[]>([]);
  // Qual caixa em montagem está com o conteúdo aberto na tela.
  const [caixaAberta, setCaixaAberta] = useState<string | null>(null);
  const [closingShipmentId, setClosingShipmentId] = useState<string | null>(null);
  /** Remessa fechada agora — pra gerar etiqueta/nota sem sair desta tela.
   *  `rotaPropria` vem do fechamento: sem ela o cartão oferecia "Gerar envio
   *  Correios" numa caixa de Santos e o clique dava o erro de transporte
   *  PRÓPRIO (04/08). */
  const [recemEnviada, setRecemEnviada] = useState<{
    id: string; code: string; qty: number; rotaPropria?: boolean; destino?: string;
  } | null>(null);

  const toggleDest = useCallback((code: string) => {
    setExpandedDest((curr) => (curr === code ? null : code));
  }, []);

  const handlePrint = useCallback(async () => {
    setPrintMode(true);
    // Espera React renderizar TODAS as pilhas + ciclo extra do layout antes
    // de chamar window.print(). 150ms era pouco em telas com muitos destinos:
    // o React enfileirava o re-render e o print disparava antes do DOM expandir.
    await new Promise((r) => setTimeout(r, 600));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    window.print();
    setTimeout(() => setPrintMode(false), 1000);
  }, []);

  // Detecta Ctrl+P do navegador (não passa pelo handlePrint do botão).
  // Quando usuário aperta Ctrl+P, `beforeprint` dispara antes do snapshot
  // do print — setPrintMode forçar abertura de todas as pilhas.
  useEffect(() => {
    const onBefore = () => setPrintMode(true);
    const onAfter = () => setPrintMode(false);
    window.addEventListener('beforeprint', onBefore);
    window.addEventListener('afterprint', onAfter);
    return () => {
      window.removeEventListener('beforeprint', onBefore);
      window.removeEventListener('afterprint', onAfter);
    };
  }, []);

  const pushToast = useCallback((msg: string) => {
    const id = String(Date.now() + Math.random());
    setToasts((prev) => [...prev, { id, msg }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  const loadOpenShipments = useCallback(async () => {
    try {
      const data = await api<any[]>('/realignment/shipments/open');
      setOpenShipments(Array.isArray(data) ? data : []);
    } catch {
      // silencioso — endpoint pode não existir ainda em deploys antigos
      setOpenShipments([]);
    }
  }, []);

  /**
   * Caixas já fechadas e ainda sem etiqueta.
   *
   * Fechar a remessa a tirava das amarelas, e o botão de gerar etiqueta só
   * existia no painel que aparece logo depois de fechar. Fechou e saiu da tela
   * — ou fechou no outro PC da loja — e a caixa ficava pronta, sem caminho
   * nenhum pra postar. Era o caso de Suzano: 20 peças enviadas no dia, nenhuma
   * caixa amarela, nada pra clicar.
   */
  const loadPendingLabel = useCallback(async () => {
    try {
      const data = await api<any[]>('/realignment/shipments/pendentes-etiqueta');
      setPendingLabel(Array.isArray(data) ? data : []);
    } catch {
      setPendingLabel([]);
    }
  }, []);

  const loadItems = useCallback(async () => {
    try {
      const data = await api<RealignmentItem[]>('/realignment/mine');
      setItems(data);
      setError(null);
    } catch (err: any) {
      setError(err?.message ?? 'Erro ao carregar ordens');
    }
  }, []);

  // Carrega o que já foi separado hoje pra vendedora conferir. Isolada em
  // try/catch própria pra NÃO derrubar a tela se endpoint ainda não deployado.
  const loadSentItems = useCallback(async () => {
    try {
      const data = await api<RealignmentItem[]>('/realignment/mine-sent');
      setSentItems(Array.isArray(data) ? data : []);
    } catch {
      // silencioso — vendedora ainda tem a tela de pendentes funcionando
      setSentItems([]);
    }
  }, []);

  /**
   * Baixa o PDF (romaneio) da remessa e abre numa nova aba.
   * Usa fetch direto com bearer pra preservar autenticação da rota /pdf.
   *
   * IMPORTANTE: backend tem globalPrefix='api', então a URL real é
   * ${API_URL}/api/realignment/.../pdf. Sem o /api retorna "Cannot GET".
   */
  const handleDownloadPdf = useCallback(async (shipmentId: string, code: string) => {
    try {
      const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_token') : null;
      if (!token) {
        alert('Sessão expirada. Faça login novamente.');
        return;
      }
      const { API_URL } = await import('@/lib/api');
      const r = await fetch(`${API_URL}/api/realignment/shipments/${shipmentId}/pdf`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        throw new Error(txt || `HTTP ${r.status}`);
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.download = `remessa-${code}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Não revoga imediatamente pra deixar a aba abrir
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e: any) {
      alert(`Erro ao gerar PDF: ${e?.message || e}`);
    }
  }, []);

  /**
   * Imprime DIRETO na impressora padrão do Windows, sem preview.
   *
   * Estratégia em 2 camadas (mesma lógica do PDV):
   *  1. Electron desktop → silentPrintUrl() abre hidden window e imprime direto
   *     na impressora padrão (a Elgin já configurada no Windows). Vendedora não vê nada.
   *  2. Browser puro → abre o PDF em popup/iframe e dispara window.print() do dialog
   *     (única forma sem extensão).
   */
  const handlePrintRemessa = useCallback(async (shipmentId: string, code: string) => {
    try {
      const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_token') : null;
      if (!token) {
        alert('Sessão expirada. Faça login novamente.');
        return;
      }
      const { API_URL } = await import('@/lib/api');
      const r = await fetch(`${API_URL}/api/realignment/shipments/${shipmentId}/pdf`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        throw new Error(txt || `HTTP ${r.status}`);
      }
      const blob = await r.blob();
      const blobUrl = URL.createObjectURL(blob);

      // Romaneio é A4 (capa + lista) → imprime na impressora A4 CONFIGURADA.
      // Antes ia direto no silentPrint (impressora ativa = quase sempre a
      // térmica) e saía esticado no rolo. printPdfA4 escolhe a A4 antes.
      const { printPdfA4 } = await import('@/lib/printer-router');
      const res = await printPdfA4(blobUrl);
      if (res.mode === 'popup-blocked') {
        alert(
          'Popup bloqueado. Habilite popups pra imprimir automático,\n' +
          'ou clica em "PDF" pra baixar e imprimir manualmente.',
        );
      } else if (res.mode === 'electron-silent') {
        pushToast(`🖨️ Romaneio ${code} enviado pra impressora.`);
      }
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
    } catch (e: any) {
      alert(`Erro ao imprimir: ${e?.message || e}`);
    }
  }, [pushToast]);

  /**
   * Antes de fechar, faz PRE-CHECK pra detectar items sem estoque suficiente
   * no Giga (vendido entre criação e fechamento, divergência ERP×físico, etc).
   * Se tem problema, abre modal com lista — vendedora pode remover/diagnosticar
   * antes de tentar de novo. Se OK, fecha direto.
   */
  /**
   * EXCLUI uma caixa ABERTA (04/08 — botão "Excluir remessa").
   * As peças voltam pra fila "a enviar" (células amarelas); a caixa some.
   * Sem movimento de estoque — a baixa só acontece no fechamento.
   */
  const handleExcluirRemessa = useCallback(async (shipmentId: string, code: string, qtd: number) => {
    if (!confirm(
      `Excluir a remessa ${code}?\n\n` +
      `A caixa some e ${qtd > 0 ? `as ${qtd} peça(s) que estão nela voltam` : 'as peças voltam'} ` +
      `pra fila "a enviar" (células amarelas) — os pedidos continuam valendo.\n` +
      `Nenhum estoque é movimentado.`,
    )) return;
    try {
      const r = await api<{ ok: boolean; code: string; pecasDevolvidas: number }>(
        `/realignment/shipments/${shipmentId}`,
        { method: 'DELETE' },
      );
      pushToast(`🗑 Remessa ${r.code} excluída — ${r.pecasDevolvidas} peça(s) voltaram pra fila.`);
      await Promise.all([loadOpenShipments(), loadPendingLabel(), loadItems(), loadSentItems()]);
    } catch (e: any) {
      alert(`Erro ao excluir remessa: ${e?.message || e}`);
    }
  }, [pushToast, loadOpenShipments, loadPendingLabel, loadItems, loadSentItems]);

  /**
   * EXCLUI A PILHA de um destino: cancela os pedidos pendentes (e não
   * achadas) daquela loja. Peça já bipada em caixa aberta fica — a caixa
   * tem o próprio "Excluir remessa".
   */
  const handleExcluirPilha = useCallback(async (destCode: string, destName: string, unidades: number) => {
    if (!confirm(
      `Excluir a pilha de ${destName}?\n\n` +
      `Os pedidos pendentes deste destino (${unidades} unidade(s) na tela) serão CANCELADOS — ` +
      `saem da fila e não voltam.\n` +
      `Peças já bipadas em caixa aberta NÃO são afetadas.`,
    )) return;
    const motivo = await appPrompt(`Por que está excluindo a pilha de ${destName}? (ex: pedido errado da matriz)`);
    if (motivo === null) return;
    try {
      const r = await api<{ ok: boolean; canceladas: number }>(
        `/realignment/pilha/${encodeURIComponent(destCode)}?motivo=${encodeURIComponent(motivo.trim())}`,
        { method: 'DELETE' },
      );
      pushToast(`🗑 Pilha de ${destName} excluída — ${r.canceladas} pedido(s) cancelado(s).`);
      await Promise.all([loadItems(), loadSentItems(), loadOpenShipments()]);
    } catch (e: any) {
      alert(`Erro ao excluir pilha: ${e?.message || e}`);
    }
  }, [pushToast, loadItems, loadSentItems, loadOpenShipments]);

  const handleCloseShipment = useCallback(async (shipmentId: string, code: string) => {
    // SIMPLIFICADO: sem modal de precheck. Vendedora separou, pecas em maos,
    // clica Fechar e enviar -> confirma -> fecha. Backend ja aceita unresolved
    // e roda decreaseStock com allowNegative=true (peca fisica prevalece).
    if (!confirm(`Fechar remessa ${code} e enviar pra destino?\n\nIsso vai BAIXAR o estoque Giga das pecas e marcar a remessa como em transito. Nao pode desfazer.`)) {
      return;
    }
    setClosingShipmentId(shipmentId);
    try {
      const res = await api<{
        ok: boolean; code: string; totalItems: number; totalQty: number;
        novaRemessa?: { id: string; code: string; totalItens: number } | null;
        rotaPropria?: boolean; toStoreName?: string;
      }>(
        `/realignment/shipments/${shipmentId}/close-and-send`,
        { method: 'POST', body: '{}' },
      );
      pushToast(`✅ Remessa ${res.code} enviada (${res.totalQty} pecas). Loja destino recebeu alerta.`);
      // Fechou sem estar 100% verde? O que faltou já está numa caixa NOVA.
      if (res.novaRemessa) {
        pushToast(
          `📦 ${res.novaRemessa.totalItens} peça(s) não separada(s) foram pra caixa nova ${res.novaRemessa.code}.`,
        );
      }
      // A remessa some da lista de montagem assim que fecha. Guardar aqui é o
      // que permite gerar etiqueta e nota SEM ir até a Retaguarda: quem acabou
      // de fechar a caixa é quem vai postar, e é agora que ela precisa do papel.
      setRecemEnviada({
        id: shipmentId,
        code: res.code,
        qty: res.totalQty,
        rotaPropria: !!res.rotaPropria,
        destino: res.toStoreName,
      });
      await Promise.all([loadOpenShipments(), loadPendingLabel(), loadItems(), loadSentItems()]);
    } catch (e: any) {
      alert(`Erro ao fechar remessa: ${e?.message || e}`);
    } finally {
      setClosingShipmentId(null);
    }
  }, [pushToast, loadOpenShipments, loadPendingLabel, loadItems, loadSentItems]);

  // Estado do modal de problemas detectados pelo precheck
  const [problemasShipment, setProblemasShipment] = useState<{
    shipmentId: string;
    code: string;
    totalItems: number;
    problemas: Array<{
      transferOrderId: string;
      refCode: string;
      cor: string | null;
      tamanho: string | null;
      qtyRequerida: number;
      sku: string;
      storeCode: string;
      estoqueGiga: number;
    }>;
    unresolved: Array<{ transferOrderId?: string; refCode: string; cor: string | null; tamanho: string | null }>;
  } | null>(null);

  /** Remove item da remessa (transferOrder) — usado no modal de problemas */
  const handleRemoveItem = useCallback(async (transferOrderId: string, descricao: string) => {
    if (!confirm(`Remover "${descricao}" da remessa?`)) return;
    try {
      await api(`/realignment/shipments/items/${transferOrderId}`, { method: 'DELETE' });
      pushToast(`🗑️ Item removido. Reabra "Fechar e enviar" pra rever.`);
      // Atualiza modal removendo o item da lista local
      setProblemasShipment((prev) => {
        if (!prev) return null;
        const novosProblemas = prev.problemas.filter((p) => p.transferOrderId !== transferOrderId);
        if (novosProblemas.length === 0 && prev.unresolved.length === 0) {
          return null; // fecha modal se não tem mais nada
        }
        return { ...prev, problemas: novosProblemas };
      });
      await Promise.all([loadOpenShipments(), loadPendingLabel(), loadItems()]);
    } catch (e: any) {
      alert(`Erro ao remover item: ${e?.message || e}`);
    }
  }, [pushToast, loadOpenShipments, loadItems]);

  // Estado: remoção em lote em progresso (mostra barra de progresso)
  const [batchRemoving, setBatchRemoving] = useState<{ done: number; total: number } | null>(null);

  /**
   * Remove TODOS os itens problemáticos da remessa de uma vez.
   * Não mexe no estoque Giga — apenas volta os transferOrders pra "pending".
   * Os outros itens da remessa continuam intactos.
   */
  const handleRemoveAllProblematic = useCallback(async () => {
    if (!problemasShipment) return;
    // Pega BOTH: estoque insuficiente + SKU não identificado (ambos travam o fechamento)
    const allIds: Array<{ id: string; desc: string }> = [
      ...problemasShipment.problemas.map((p) => ({
        id: p.transferOrderId,
        desc: `${p.refCode} ${p.cor || ''} ${p.tamanho || ''}`.trim(),
      })),
      ...problemasShipment.unresolved
        .filter((u: any) => u.transferOrderId)
        .map((u: any) => ({
          id: u.transferOrderId,
          desc: `${u.refCode} ${u.cor || ''} ${u.tamanho || ''}`.trim(),
        })),
    ];
    const total = allIds.length;
    if (!total) return;
    if (!confirm(
      `Remover TODOS os ${total} item(s) problemáticos da remessa?\n\n` +
      `✓ Os outros itens da remessa ficam intactos\n` +
      `✓ NÃO mexe no estoque Giga\n` +
      `✓ Os itens removidos voltam pra fila "pendente" e somem dessa remessa\n\n` +
      `Confirma?`,
    )) return;

    setBatchRemoving({ done: 0, total });
    let removidos = 0;
    let falhas: string[] = [];

    for (const it of allIds) {
      try {
        await api(`/realignment/shipments/items/${it.id}`, { method: 'DELETE' });
        removidos++;
      } catch (e: any) {
        falhas.push(it.desc);
      }
      setBatchRemoving({ done: removidos + falhas.length, total });
    }

    setBatchRemoving(null);
    setProblemasShipment(null);
    await Promise.all([loadOpenShipments(), loadPendingLabel(), loadItems()]);

    if (falhas.length === 0) {
      pushToast(`✅ ${removidos} item(s) removido(s) da remessa. Os outros ficaram intactos.`);
    } else {
      pushToast(`⚠️ ${removidos} removido(s), ${falhas.length} falharam: ${falhas.slice(0,3).join(', ')}${falhas.length > 3 ? '…' : ''}`);
    }
  }, [problemasShipment, pushToast, loadOpenShipments, loadItems]);

  // Auth + initial load
  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_token') : null;
    if (!token) {
      router.push('/login');
      return;
    }
    (async () => {
      try {
        const profile = await api<MeProfile>('/auth/me');
        if (profile.role !== 'store') {
          router.push('/');
          return;
        }
        setMe(profile);
        // Carrega as 3 listas em paralelo — pendentes + enviados hoje + remessas abertas.
        await Promise.all([loadItems(), loadSentItems(), loadOpenShipments(), loadPendingLabel()]);
      } catch (err: any) {
        setError(err?.message ?? 'Erro ao carregar');
        if (String(err?.message ?? '').startsWith('401')) router.push('/login');
      } finally {
        setLoading(false);
      }
    })();
  }, [router, loadItems, loadSentItems]);

  // Socket
  useEffect(() => {
    if (!me) return;
    const socket = getSocket();

    const onNew = (payload: any) => {
      if (!payload?.items || !Array.isArray(payload.items)) return;
      // Merge: adiciona só as que não temos ainda (dedup por id)
      setItems((prev) => {
        const existingIds = new Set(prev.map((p) => p.id));
        const fresh = payload.items.filter((it: any) => !existingIds.has(it.id));
        if (fresh.length === 0) return prev;
        pushToast(`+${fresh.length} peça(s) de realinhamento chegaram`);
        return [...fresh, ...prev];
      });
    };

    const onSent = (payload: any) => {
      if (!payload?.transferId) return;
      // Sincroniza: remove da lista se outra aba marcou
      setItems((prev) => prev.filter((i) => i.id !== payload.transferId));
    };

    // Sincronização de REVERSÃO entre abas/dispositivos. Se outra
    // aba clicou "voltar pra pendentes", tiramos dos enviados e recarregamos
    // os pendentes pra trazer o item de volta (com dados frescos).
    const onUnsent = (payload: any) => {
      if (!payload?.transferId) return;
      setSentItems((prev) => prev.filter((i) => i.id !== payload.transferId));
      // Recarrega pendentes — mais seguro que reconstruir do payload sem todos os campos
      loadItems();
    };

    socket.on('realignment:new', onNew);
    socket.on('realignment:sent', onSent);
    socket.on('realignment:unsent', onUnsent);
    return () => {
      socket.off('realignment:new', onNew);
      socket.off('realignment:sent', onSent);
      socket.off('realignment:unsent', onUnsent);
    };
  }, [me, pushToast, loadItems]);

  /**
   * REVERTE um item já enviado (sent → pending). Caso de uso: vendedora
   * clicou "Enviei" errado e precisa voltar pra fila de separação sem
   * criar ordem nova. Move otimisticamente de sentItems → items.
   */
  async function markUnsent(itemId: string) {
    /**
     * Procura no que está NA TELA, não só em `sentItems`.
     *
     * A peça verde pode vir da caixa aberta (inclusive de outro dia), e essa
     * não está na lista de "enviados hoje". Procurando só ali, o toque na
     * célula verde caía num `return` mudo — o desfazer simplesmente não fazia
     * nada, sem erro nenhum.
     */
    const item =
      sentItems.find((i) => i.id === itemId) ||
      (currentItems.find((i) => i.id === itemId) as RealignmentItem | undefined);
    if (!item) return;
    // Confirmação simples pra evitar clique acidental
    if (!confirm(`Voltar ${item.refCode} ${item.cor || ''} ${item.tamanho || ''} pra lista de pendentes?`)) {
      return;
    }
    setRevertingIds((prev) => new Set(prev).add(itemId));
    try {
      await api(`/realignment/${itemId}/unsent`, { method: 'PATCH' });
      // Move otimisticamente: tira dos enviados e devolve pra pendentes
      let moved: RealignmentItem | null = null;
      setSentItems((prev) => {
        const found = prev.find((i) => i.id === itemId);
        if (found) moved = found;
        return prev.filter((i) => i.id !== itemId);
      });
      if (moved) {
        const restored: RealignmentItem = {
          ...(moved as RealignmentItem),
          sentAt: null,
        };
        setItems((prev) => [restored, ...prev]);
      }
      // Recarrega: a peça pode ter saído de uma CAIXA, e aí a caixa mudou de
      // tamanho (ou esvaziou). O movimento otimista acima só cobre o caso de
      // "enviado hoje" solto.
      void Promise.all([loadItems(), loadSentItems(), loadOpenShipments()]);
      pushToast('Voltou pra lista de pendentes ↺');
    } catch (err: any) {
      pushToast(`Erro: ${err?.message ?? 'falha ao reverter'}`);
    } finally {
      setRevertingIds((prev) => {
        const next = new Set(prev);
        next.delete(itemId);
        return next;
      });
    }
  }

  /** Filial reporta que não encontrou a peça fisicamente (estoque divergente,
   *  etiqueta errada, peça sumida). Pede motivo e marca pra matriz revisar. */
  async function reportNotFound(item: RealignmentItem) {
    const motivo = await appPrompt(
      `❌ Não achou a peça?\n\n` +
        `${item.refCode} ${item.cor || ''} ${item.tamanho || ''}\n\n` +
        `Por que? (ex: peça não está na arara, etiqueta errada, estoque divergente)`,
    );
    if (motivo === null) return; // cancelou
    try {
      await api(`/realignment/${item.id}/not-found`, {
        method: 'PATCH',
        body: JSON.stringify({ motivo: motivo.trim() }),
      });
      // NÃO remove da lista (fix 04/08 — caso Santos): a peça continua na
      // grade marcada como "não achada". Tirar daqui apagava a pilha inteira
      // do destino quando era a última peça, e a caixa ia junto.
      setItems((prev) =>
        prev.map((i) =>
          i.id === item.id
            ? { ...i, realignmentStatus: 'not_found', realignmentNotFoundNote: motivo.trim() || null }
            : i,
        ),
      );
      pushToast('Marcada como não achada · toque nela pra desfazer');
    } catch (err: any) {
      pushToast(`Erro: ${err?.message ?? 'falha ao reportar'}`);
    }
  }

  /**
   * EXCLUI uma peça do pedido — pra quando a matriz pediu a mais.
   *
   * Diferente do "não achei": ali a peça existe e não foi encontrada; aqui o
   * PEDIDO é que estava errado (foi o caso da REM-679, com VOGUE AZUL 58 e 60
   * em duplicidade). Some da fila e não volta.
   */
  async function excluirOrdem(item: RealignmentItem, totalNaCelula: number) {
    const oQue = `${item.refCode} ${item.cor || ''} ${item.tamanho || ''}`.trim();
    const aviso = totalNaCelula > 1
      ? `Excluir 1 peça de "${oQue}"?\n\nA matriz pediu ${totalNaCelula} — vai ficar ${totalNaCelula - 1}.`
      : `Excluir "${oQue}" do pedido?\n\nA peça sai da lista de separação e não volta.`;
    if (!confirm(aviso)) return;
    const motivo = await appPrompt('Por que está excluindo? (ex: pedido em duplicidade)');
    if (motivo === null) return;
    try {
      await api(`/realignment/${item.id}?motivo=${encodeURIComponent(motivo.trim())}`, {
        method: 'DELETE',
      });
      setItems((prev) => prev.filter((i) => i.id !== item.id));
      void loadOpenShipments();
      pushToast('Peça excluída do pedido 🗑');
    } catch (err: any) {
      pushToast(`Erro: ${err?.message ?? 'falha ao excluir'}`);
    }
  }

  /** Desfaz o "não achei" — a peça volta pra fila de separação da loja. */
  async function undoNotFound(item: RealignmentItem) {
    if (!confirm(
      `Achou a peça?\n\n${item.refCode} ${item.cor || ''} ${item.tamanho || ''}\n\n` +
      `Ela volta pra lista de separação.`,
    )) return;
    try {
      await api(`/realignment/${item.id}/undo-not-found`, { method: 'PATCH' });
      setItems((prev) =>
        prev.map((i) =>
          i.id === item.id
            ? { ...i, realignmentStatus: 'pending', realignmentNotFoundNote: null }
            : i,
        ),
      );
      pushToast('Voltou pra separação ↺');
    } catch (err: any) {
      pushToast(`Erro: ${err?.message ?? 'falha ao desfazer'}`);
    }
  }

  async function markSent(itemId: string) {
    // CAPTURA o item ANTES do await — fix race condition: o socket
    // 'realignment:sent' pode chegar ANTES da response do PATCH e remover
    // o item de items. Se a gente buscasse DEPOIS do await, encontraria
    // undefined e a peça não iria pra sentItems (sumia da lista sem
    // aparecer em enviados). Capturar agora garante que temos a referência
    // mesmo que o socket limpe antes.
    const captured = items.find((i) => i.id === itemId) || null;
    setSendingIds((prev) => new Set(prev).add(itemId));
    try {
      await api(`/realignment/${itemId}/sent`, { method: 'PATCH' });
      setItems((prev) => prev.filter((i) => i.id !== itemId));
      if (captured) {
        const stamped: RealignmentItem = {
          ...captured,
          sentAt: new Date().toISOString(),
        };
        setSentItems((prev) => {
          if (prev.some((i) => i.id === captured.id)) return prev;
          return [stamped, ...prev];
        });
      } else {
        // Fallback paranoico: item já removido antes do clique? Força recarga.
        loadSentItems();
      }
      pushToast('Marcado como enviado ✓');
    } catch (err: any) {
      pushToast(`Erro: ${err?.message ?? 'falha ao marcar'}`);
    } finally {
      setSendingIds((prev) => {
        const next = new Set(prev);
        next.delete(itemId);
        return next;
      });
    }
  }

  // Fonte da verdade p/ a grade: troca conforme a aba selecionada.
  // Dessa forma o mesmo agrupamento e o mesmo componente de grid servem pros
  // 2 modos (só muda a cor/label das células).
  //
  // Na aba de enviados, peça que JÁ ESTÁ EM CAIXA FECHADA sai da pilha verde:
  // ela virou caixa lacrada, e quem manda nela agora é o cartão de etiqueta lá
  // em cima. Aparecer nos dois lugares fazia parecer trabalho em dobro — e o
  // "desfazer" da célula verde nem valeria mais, porque o estoque já baixou.
  /**
   * REGRA DAS ABAS (dono, 03/08):
   *   caixa ABERTA  → aba amarela (Pendentes), mesmo já com peça bipada dentro
   *   caixa FECHADA → aba verde (Enviados hoje)
   *   reabriu       → volta pra amarela
   *
   * Então a pilha verde não lista mais peça que está DENTRO de caixa nenhuma:
   * a peça mora na caixa, e a caixa é que escolhe a aba. Sobra pra pilha só a
   * peça sem caixa — o acervo antigo, de antes das remessas. Sem isso a mesma
   * caixa aparecia nas duas abas: amarela como "em montagem" e verde como
   * pilha de peças.
   */
  const currentItems = useMemo(() => {
    if (view === 'sent') {
      // Verde: só peça que não está em caixa nenhuma (acervo antigo). O resto
      // mora na caixa, e a caixa é que escolhe a aba.
      return sentItems.filter((i) => !(i as any).shipmentId);
    }
    /**
     * Amarela: a grade INTEIRA do destino — o que falta pegar (célula aberta)
     * MAIS o que já está na caixa (célula verde, com o horário e o desfazer).
     *
     * ⚠️ O verde vem da CAIXA (`openShipments[].items`), não de "enviados
     * hoje". Essa era a raiz de oito idas e voltas: eu montava a grade a partir
     * da lista do dia, então bastava virar a meia-noite — ou reabrir uma caixa
     * de ontem — pra peça sumir da grade e a caixa cair numa tabela plana onde
     * não dá pra bipar. A caixa carrega o próprio conteúdo; a data não tem nada
     * a ver com isso.
     */
    const daCaixa = openShipments.flatMap((s: any) =>
      (s.items || []).map((i: any) => ({
        ...i,
        lojaDestinoCode: i.lojaDestinoCode ?? s.toStoreCode,
        lojaDestinoName: i.lojaDestinoName ?? s.toStoreName,
        // `sentAt` é o que pinta a célula de verde e liga o desfazer.
        sentAt: i.realignmentSentAt ?? i.sentAt ?? null,
        shipmentId: s.id,
      })),
    );
    // DEDUPE por id: desde 04/08 a caixa nova nasce carregando o que faltou
    // separar, então a MESMA peça vem das duas listas (pendente + conteúdo da
    // caixa). Sem isto ela contaria em dobro no total do destino.
    const porId = new Map<string, RealignmentItem>();
    for (const it of [...items, ...daCaixa]) {
      const anterior = porId.get(it.id);
      porId.set(it.id, anterior ? { ...anterior, ...it, sentAt: it.sentAt ?? anterior.sentAt } : it);
    }
    return Array.from(porId.values());
  }, [view, items, sentItems, openShipments]);


  // Agrupa por destino → dentro dele, por REF, com grade Cor × Tamanho
  const byDestination = useMemo(() => {
    const dests = new Map<string, { code: string; name: string; items: RealignmentItem[] }>();
    for (const it of currentItems) {
      if (!dests.has(it.lojaDestinoCode)) {
        dests.set(it.lojaDestinoCode, {
          code: it.lojaDestinoCode,
          name: it.lojaDestinoName,
          items: [],
        });
      }
      dests.get(it.lojaDestinoCode)!.items.push(it);
    }
    // Converte cada destino pra grupos por REF, e dentro agrupa por Cor+Tam
    return Array.from(dests.values())
      .sort((a, b) => a.code.localeCompare(b.code))
      .map((d) => {
        const byRef = new Map<string, RealignmentItem[]>();
        for (const it of d.items) {
          if (!byRef.has(it.refCode)) byRef.set(it.refCode, []);
          byRef.get(it.refCode)!.push(it);
        }
        const refGroups = Array.from(byRef.entries())
          .map(([ref, list]) => {
            // Organiza em matriz: linhas = cor, colunas = tamanho
            const cores = Array.from(new Set(list.map((x) => x.cor || '—'))).sort();
            const tams = Array.from(new Set(list.map((x) => x.tamanho || '—'))).sort(sortSizes);
            // Para cada (cor, tam) → item (ou null)
            const matrix: Record<string, Record<string, RealignmentItem | null>> = {};
            for (const c of cores) {
              matrix[c] = {};
              for (const t of tams) matrix[c][t] = null;
            }
            /**
             * ⚠️ PODE HAVER MAIS DE UMA ORDEM NA MESMA CÉLULA (04/08).
             *
             * A matriz guardava `matrix[cor][tam] = it` — a segunda ordem da
             * MESMA cor+tamanho sobrescrevia a primeira e ficava invisível.
             * O estrago aparecia só no romaneio: a vendedora bipava a célula,
             * a lista recarregava mostrando a ordem irmã (ainda pendente) como
             * se nada tivesse sido pego, ela bipava de novo — e a caixa saía
             * com DUAS peças iguais. Foi o caso da REM-2026-000679, VOGUE AZUL
             * 58 e 60 duplicados.
             *
             * Agora a célula carrega TODAS as ordens (`celula`) e a quantidade
             * exibida é a soma — o que está na tela é o que vai na caixa.
             */
            for (const it of list) {
              const c = it.cor || '—';
              const t = it.tamanho || '—';
              const atual = matrix[c][t];
              const celula = atual ? [...(atual.celula || [atual]), it] : [it];
              // Principal = a primeira ordem que ainda dá pra bipar; se todas
              // já foram, a primeira mesmo (só pra rótulo/id de referência).
              const principal =
                celula.find((x) => !x.sentAt && x.realignmentStatus !== 'not_found') || celula[0];
              matrix[c][t] = {
                ...principal,
                celula,
                qtyOrigem: celula.reduce((a, x) => a + (x.qtyOrigem || 0), 0),
              };
            }
            const totalQty = list.reduce((a, it) => a + it.qtyOrigem, 0);
            // Descrição: pega a primeira não-vazia (todas as variações da mesma
            // REF compartilham a descrição base do produto). Remove o sufixo
            // "REF COR TAMANHO" do final pra não duplicar (já aparece na grade
            // Cor × Tamanho abaixo).
            const rawDesc = list.find((it) => it.descricao && it.descricao.trim())?.descricao || '';
            let cleanDesc = rawDesc;
            if (cleanDesc) {
              // Remove "REF COR TAM" do final (em qualquer ordem). Coleta todas
              // as cores e tamanhos das variações pra varrer e tirar.
              const cores = new Set(
                list.map((i) => (i.cor || '').toUpperCase().trim()).filter(Boolean),
              );
              const tams = new Set(
                list.map((i) => (i.tamanho || '').toUpperCase().trim()).filter(Boolean),
              );
              // Tokeniza descrição e remove tokens que são REF, COR ou TAM
              const tokens = cleanDesc.split(/\s+/);
              const filtered = tokens.filter((tok) => {
                const t = tok.toUpperCase().trim();
                if (!t) return false;
                if (t === ref.toUpperCase()) return false; // REF
                if (cores.has(t)) return false;
                if (tams.has(t)) return false;
                return true;
              });
              cleanDesc = filtered.join(' ').trim();
            }
            const descricao = cleanDesc ? toTitleCase(cleanDesc) : '';
            // Imagem: primeira URL válida (todas variações da mesma REF usam a mesma)
            const imageUrl = list.find((it) => it.imageUrl && it.imageUrl.trim())?.imageUrl || null;
            return { ref, descricao, imageUrl, cores, tams, matrix, totalQty, items: list };
          })
          .sort((a, b) => a.ref.localeCompare(b.ref));

        const totalItems = d.items.length;
        const totalUnits = d.items.reduce((a, it) => a + it.qtyOrigem, 0);
        return { code: d.code, name: d.name, refGroups, totalItems, totalUnits };
      });
  }, [currentItems]);

  /** Caixa aberta de cada destino, indexada pelo código da loja.
   *  Com IRMÃS abertas pro mesmo destino (caixa fantasma da REM-809, 05/08),
   *  vale a MAIS RECENTE — a mesma que o bipe do backend escolhe agora. As
   *  outras entram em `irmasAbertas` pra tela AVISAR em vez de esconder. */
  const caixaDoDestino = useMemo(() => {
    const m: Record<string, any> = {};
    for (const s of openShipments) {
      const atual = m[s.toStoreCode];
      if (!atual || String(s.openedAt || '') > String(atual.openedAt || '')) m[s.toStoreCode] = s;
    }
    return m;
  }, [openShipments]);

  /** Caixas abertas ALÉM da exibida, por destino — antes ficavam invisíveis
   *  (o bipe caía nelas e o cartão dizia "0 item(s)"). */
  const irmasAbertas = useMemo(() => {
    const m: Record<string, any[]> = {};
    for (const s of openShipments) {
      if (caixaDoDestino[s.toStoreCode]?.id !== s.id) {
        (m[s.toStoreCode] = m[s.toStoreCode] || []).push(s);
      }
    }
    return m;
  }, [openShipments, caixaDoDestino]);

  /**
   * Caixa em montagem que NÃO tem grade na tela — cartão próprio só pra essa.
   *
   * A caixa com grade mostra as ações no cabeçalho DELA: é um card por
   * destino, com a grade cor×tamanho embaixo, porque a caixa aberta continua
   * recebendo peça e a pessoa precisa ver o que falta pegar (decisão do dono:
   * "toda caixa que estiver em pendentes fica no formato da grade, pois
   * podemos ainda inserir peças"). Tabela plana não serve pra isso — não dá
   * pra bipar nela.
   *
   * Sobra o cartão simples pra caixa que ficou aberta de OUTRO DIA: as peças
   * dela não estão nos enviados de hoje, então não têm grade. Sem o cartão,
   * ela ficaria aberta pra sempre sem ninguém achar o "Fechar e enviar".
   */
  const caixasEmMontagem = useMemo(() => {
    // SÓ na aba Pendentes (o dono confirmou em 04/08 depois de um vaivém:
    // caixa em montagem é trabalho em andamento, mora nos Pendentes — em
    // Enviados ela aparecia DUPLICADA, porque a pilha do destino já mostra a
    // caixa com os botões no próprio cabeçalho).
    if (view !== 'pending') return [];
    const comGrade = new Set(byDestination.map((d) => d.code));
    // Entram: caixa de destino SEM grade (de outro dia) E as IRMÃS da caixa
    // exibida na pilha — cada caixa aberta precisa de um cartão com botões,
    // senão vira a caixa fantasma (bipe caía nela e ninguém conseguia fechar).
    return openShipments.filter(
      (s) => !comGrade.has(s.toStoreCode) || caixaDoDestino[s.toStoreCode]?.id !== s.id,
    );
  }, [view, openShipments, byDestination, caixaDoDestino]);

  // Peça "não achada" continua na lista (pra não sumir a pilha), mas NÃO é
  // trabalho pendente — senão o contador do topo mentiria.
  const pendentesDeVerdade = useMemo(
    () => items.filter((i) => i.realignmentStatus !== 'not_found'),
    [items],
  );
  const totalNaoAchadas = items.length - pendentesDeVerdade.length;
  const totalPending = pendentesDeVerdade.length;
  const totalUnits = useMemo(
    () => pendentesDeVerdade.reduce((a, it) => a + it.qtyOrigem, 0),
    [pendentesDeVerdade],
  );
  const totalSentToday = sentItems.length;
  const totalSentUnitsToday = useMemo(
    () => sentItems.reduce((a, it) => a + it.qtyOrigem, 0),
    [sentItems],
  );

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-slate-500">
        <RefreshCw className="w-5 h-5 animate-spin mr-2" /> Carregando ordens...
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#f4f1ec] pb-16 relative">

      {/* Header — glass sutil com gradiente. Sticky pra manter contexto. */}
      <header className="bg-gradient-to-r from-indigo-700 via-violet-700 to-fuchsia-700 text-white sticky top-0 z-30 shadow-2xl relative overflow-hidden">
        {/* Textura de brilho no canto */}
        <div className="absolute -top-10 -right-10 w-64 h-64 rounded-full bg-white/10 blur-2xl pointer-events-none" />
        <div className="absolute top-20 left-1/3 w-40 h-40 rounded-full bg-fuchsia-400/20 blur-3xl pointer-events-none" />

        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center gap-3 relative">
          <Link
            href="/minha-loja"
            className="p-2 hover:bg-white/15 rounded-lg transition backdrop-blur"
            title="Voltar"
          >
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="w-11 h-11 rounded-2xl bg-white/20 backdrop-blur-md flex items-center justify-center shrink-0 ring-1 ring-white/20 shadow-lg">
            <Shuffle className="w-5 h-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <div className="font-black text-xl leading-tight truncate tracking-tight">
                Realinhamento
              </div>
              <Sparkles className="w-4 h-4 opacity-70" />
            </div>
            <div className="text-xs opacity-85 truncate font-medium">
              {me?.storeName ?? ''} · separe e envie pras lojas irmãs
            </div>
          </div>
          <button
            onClick={handlePrint}
            className="no-print p-2 hover:bg-white/15 rounded-lg transition backdrop-blur"
            title="Imprimir ordens de separação"
            disabled={items.length === 0}
          >
            <Printer className="w-4 h-4" />
          </button>
          <button
            onClick={() => { loadItems(); loadSentItems(); loadOpenShipments(); loadPendingLabel(); }}
            className="no-print p-2 hover:bg-white/15 rounded-lg transition backdrop-blur"
            title="Atualizar"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>

        {/* Abas pendentes / enviados hoje — logo abaixo do título.
            Pílulas grandes, mobile-friendly. Mostra contador em cada uma pra
            vendedora ter noção do trabalho pendente vs. feito sem clicar. */}
        <div className="max-w-6xl mx-auto px-4 pb-3 flex gap-2 relative no-print">
          <button
            type="button"
            onClick={() => { setView('pending'); setExpandedDest(null); }}
            className={`flex-1 rounded-xl px-4 py-2.5 text-sm font-black uppercase tracking-wider transition ring-1 ${
              view === 'pending'
                ? 'bg-white text-indigo-800 ring-white shadow-lg'
                : 'bg-white/10 text-white/90 ring-white/20 hover:bg-white/15'
            }`}
          >
            Pendentes · {totalPending}
          </button>
          <button
            type="button"
            onClick={() => { setView('sent'); setExpandedDest(null); }}
            className={`flex-1 rounded-xl px-4 py-2.5 text-sm font-black uppercase tracking-wider transition ring-1 ${
              view === 'sent'
                ? 'bg-white text-emerald-800 ring-white shadow-lg'
                : 'bg-white/10 text-white/90 ring-white/20 hover:bg-white/15'
            }`}
          >
            Enviados hoje · {totalSentToday}
          </button>
        </div>

        {/* KPIs grandes — trocam conforme a aba:
             - Pendentes: amarelo (peças a separar) + verde (unidades totais)
             - Enviados hoje: verde (peças feitas) + azul (unidades enviadas) */}
        <div className="max-w-6xl mx-auto px-4 pb-5 grid grid-cols-2 gap-3 relative">
          {view === 'pending' ? (
            <>
              <div className="group bg-gradient-to-br from-amber-300 to-amber-400 text-amber-950 rounded-2xl px-5 py-4 shadow-xl flex items-center gap-4 ring-1 ring-white/40 hover:scale-[1.02] transition">
                <div className="w-12 h-12 rounded-xl bg-white/40 backdrop-blur flex items-center justify-center shrink-0 shadow-inner">
                  <Package className="w-6 h-6" />
                </div>
                <div>
                  <div className="text-4xl font-black tabular-nums leading-none tracking-tight">{totalPending}</div>
                  <div className="text-xs font-black opacity-80 mt-1.5 uppercase tracking-wider">Peças pendentes</div>
                </div>
              </div>
              <div className="group bg-gradient-to-br from-emerald-300 to-emerald-400 text-emerald-950 rounded-2xl px-5 py-4 shadow-xl flex items-center gap-4 ring-1 ring-white/40 hover:scale-[1.02] transition">
                <div className="w-12 h-12 rounded-xl bg-white/40 backdrop-blur flex items-center justify-center shrink-0 shadow-inner">
                  <Send className="w-6 h-6" />
                </div>
                <div>
                  <div className="text-4xl font-black tabular-nums leading-none tracking-tight">{totalUnits}</div>
                  <div className="text-xs font-black opacity-80 mt-1.5 uppercase tracking-wider">Unidades no total</div>
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="group bg-gradient-to-br from-emerald-300 to-emerald-400 text-emerald-950 rounded-2xl px-5 py-4 shadow-xl flex items-center gap-4 ring-1 ring-white/40 hover:scale-[1.02] transition">
                <div className="w-12 h-12 rounded-xl bg-white/40 backdrop-blur flex items-center justify-center shrink-0 shadow-inner">
                  <CheckCircle2 className="w-6 h-6" />
                </div>
                <div>
                  <div className="text-4xl font-black tabular-nums leading-none tracking-tight">{totalSentToday}</div>
                  <div className="text-xs font-black opacity-80 mt-1.5 uppercase tracking-wider">Peças enviadas hoje</div>
                </div>
              </div>
              <div className="group bg-gradient-to-br from-sky-300 to-sky-400 text-sky-950 rounded-2xl px-5 py-4 shadow-xl flex items-center gap-4 ring-1 ring-white/40 hover:scale-[1.02] transition">
                <div className="w-12 h-12 rounded-xl bg-white/40 backdrop-blur flex items-center justify-center shrink-0 shadow-inner">
                  <Send className="w-6 h-6" />
                </div>
                <div>
                  <div className="text-4xl font-black tabular-nums leading-none tracking-tight">{totalSentUnitsToday}</div>
                  <div className="text-xs font-black opacity-80 mt-1.5 uppercase tracking-wider">Unidades enviadas</div>
                </div>
              </div>
            </>
          )}
        </div>
      </header>

      <main className="max-w-6xl mx-auto p-4 space-y-5">
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-800 rounded-lg px-4 py-3 flex items-start gap-2">
            <AlertCircle className="w-5 h-5 mt-0.5 shrink-0" />
            <div className="text-sm">{error}</div>
          </div>
        )}

        {/* ── REMESSAS ABERTAS ──
            Cada remessa = 1 caixa física que vendedora está montando pra
            mandar pra outra loja. Quando termina de empacotar, fecha aqui →
            sistema baixa Giga + emite alerta pra loja destino receber. */}
        {recemEnviada && (
          <EnvioDaRemessa
            shipmentId={recemEnviada.id}
            code={recemEnviada.code}
            qty={recemEnviada.qty}
            destino={recemEnviada.destino}
            rotaPropria={!!recemEnviada.rotaPropria}
            onPdf={() => void handleDownloadPdf(recemEnviada.id, recemEnviada.code)}
            onImprimir={() => void handlePrintRemessa(recemEnviada.id, recemEnviada.code)}
            onFechar={() => setRecemEnviada(null)}
          />
        )}

        {/* ── CAIXAS FECHADAS: ETIQUETA E NOTA ──
            SÓ na aba "Enviados hoje" (decisão do dono, 03/08). Em "Pendentes"
            fica o que ainda precisa sair da arara; caixa já lacrada esperando
            papel é outro assunto e estava roubando o topo do trabalho.

            Existe porque fechar a remessa era um caminho sem volta: ela sumia
            das amarelas e o botão de gerar etiqueta só vivia no painel que
            aparece logo depois de fechar. Quem fechasse e saísse da tela (ou
            fechasse no outro PC da loja) ficava com a caixa pronta e nada pra
            clicar — foi o que aconteceu em Suzano. */}
        {view === 'sent' && pendingLabel.filter((s) => s.id !== recemEnviada?.id).length > 0 && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm font-bold text-rose-900">
              <AlertCircle className="w-4 h-4" />
              Caixas fechadas — conferir, etiqueta e nota
            </div>
            {pendingLabel
              .filter((s) => s.id !== recemEnviada?.id)
              .map((s) => (
                <EnvioDaRemessa
                  key={s.id}
                  shipmentId={s.id}
                  code={s.code}
                  qty={s.totalPecas ?? 0}
                  destino={s.toStoreName || s.toStoreCode}
                  rastreioExistente={s.trackingCode ?? null}
                  jaTemEtiqueta={!!s.jaTemEtiqueta}
                  notaAutorizada={s.notaAutorizada ?? null}
                  rotaPropria={!!s.rotaPropria}
                  onPdf={() => void handleDownloadPdf(s.id, s.code)}
                  onImprimir={() => void handlePrintRemessa(s.id, s.code)}
                  onMudou={() => {
                    void loadPendingLabel();
                    void loadOpenShipments();
                    void loadSentItems();
                  }}
                />
              ))}
          </div>
        )}

        {/* Caixa em montagem que NÃO tem pilha nesta tela — tipicamente a que
            ficou aberta de outro dia. Quem tem pilha já mostra as ações no
            próprio cabeçalho dela; repetir aqui era o mesmo item duas vezes.
            Mas sumir com a caixa sem pilha seria pior: ela ficaria aberta pra
            sempre, sem ninguém achar o "Fechar e enviar". */}
        {caixasEmMontagem.length > 0 && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm font-bold text-amber-900">
              <Truck className="w-4 h-4" />
              Remessas em montagem
            </div>
            {caixasEmMontagem.map((s) => {
              const isClosing = closingShipmentId === s.id;
              const totalQty = (s.items || []).reduce(
                (sum: number, i: any) => sum + (i.qtyOrigem || 1), 0,
              );
              return (
                <div
                  key={s.id}
                  className="bg-amber-50 border-2 border-amber-300 rounded-2xl p-4 shadow-sm"
                >
                  <div className="flex items-start gap-3">
                    <div className="w-12 h-12 rounded-xl bg-amber-500 text-white flex items-center justify-center shrink-0">
                      <Package className="w-6 h-6" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono font-black text-amber-900 text-base">
                          {s.code}
                        </span>
                        <span className="text-xs bg-amber-200 text-amber-900 px-2 py-0.5 rounded font-bold uppercase">
                          aberta
                        </span>
                      </div>
                      <div className="text-sm text-amber-900/90 font-semibold mt-1">
                        Pra <b>{s.toStoreName}</b> ({s.toStoreCode})
                      </div>
                      <div className="text-xs text-amber-800/80 mt-1">
                        {(s.items || []).length} item(s) · {totalQty} peça(s) na caixa
                      </div>
                      {/* VER O QUE TEM DENTRO — sem isto a caixa em montagem
                          era uma caixa fechada aos olhos de quem monta: dizia
                          "2 peça(s)" e não deixava conferir QUAIS. Vale ainda
                          mais depois de reabrir, que é quando a pessoa precisa
                          checar o que voltou pra dentro. Os itens já vêm no
                          payload da lista — não custa uma ida ao servidor. */}
                      {/* Alvo de toque de verdade: isto é usado em pé, no
                          balcão, muitas vezes no celular — link fininho ali
                          não se acerta com a caixa na mão. */}
                      <button
                        type="button"
                        onClick={() => setCaixaAberta((atual) => (atual === s.id ? null : s.id))}
                        className="mt-2.5 inline-flex items-center gap-2 bg-white hover:bg-amber-100 text-amber-900 border-2 border-amber-400 px-4 py-2 rounded-xl text-sm font-bold shadow-sm"
                      >
                        <Package className="w-4 h-4" />
                        {caixaAberta === s.id ? 'Ocultar conteúdo' : 'Verificar conteúdo'}
                      </button>
                    </div>
                    <div className="flex flex-col gap-2 shrink-0">
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => handleDownloadPdf(s.id, s.code)}
                          disabled={(s.items || []).length === 0}
                          className="flex-1 bg-white hover:bg-amber-100 text-amber-900 border-2 border-amber-400 px-3 py-2 rounded-xl text-xs font-bold shadow-sm flex items-center justify-center gap-1.5 disabled:opacity-50"
                          title="Baixar romaneio em PDF"
                        >
                          <FileText className="w-4 h-4" />
                          PDF
                        </button>
                        <button
                          type="button"
                          onClick={() => handlePrintRemessa(s.id, s.code)}
                          disabled={(s.items || []).length === 0}
                          className="flex-1 bg-amber-100 hover:bg-amber-200 text-amber-900 border-2 border-amber-400 px-3 py-2 rounded-xl text-xs font-bold shadow-sm flex items-center justify-center gap-1.5 disabled:opacity-50"
                          title="Imprimir direto na impressora padrão (silencioso no PC com Electron)"
                        >
                          <Printer className="w-4 h-4" />
                          Imprimir
                        </button>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleCloseShipment(s.id, s.code)}
                        disabled={isClosing || (s.items || []).length === 0}
                        className="bg-amber-600 hover:bg-amber-700 text-white px-4 py-2.5 rounded-xl text-sm font-black shadow-md flex items-center justify-center gap-2 disabled:opacity-50"
                      >
                        {isClosing ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Send className="w-4 h-4" />
                        )}
                        Fechar e enviar
                      </button>
                      <button
                        type="button"
                        onClick={() => handleExcluirRemessa(s.id, s.code, (s.items || []).length)}
                        disabled={isClosing}
                        className="bg-white hover:bg-rose-50 text-rose-700 border-2 border-rose-300 px-3 py-2 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 disabled:opacity-50"
                        title="Exclui a caixa — as peças voltam pra fila 'a enviar'"
                      >
                        <X className="w-4 h-4" /> Excluir remessa
                      </button>
                    </div>
                  </div>
                  {caixaAberta === s.id && (
                    <div className="mt-3 rounded-xl border border-amber-200 bg-white overflow-hidden">
                      {(s.items || []).length === 0 ? (
                        <p className="text-sm text-slate-500 p-4">Caixa ainda vazia.</p>
                      ) : (
                        <table className="w-full text-sm">
                          <thead className="bg-slate-50 text-slate-500 uppercase tracking-wide text-xs">
                            <tr>
                              <th className="text-left px-4 py-2.5 font-bold">Ref</th>
                              <th className="text-left px-4 py-2.5 font-bold">Cor</th>
                              <th className="text-left px-4 py-2.5 font-bold">Tam</th>
                              <th className="text-right px-4 py-2.5 font-bold">Qtd</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {(s.items || []).map((i: any) => (
                              <tr key={i.id}>
                                <td className="px-4 py-3 font-mono font-black text-slate-900">{i.refCode}</td>
                                <td className="px-4 py-3 text-slate-700 font-semibold">{i.cor || '—'}</td>
                                <td className="px-4 py-3 text-slate-700 font-semibold">{i.tamanho || '—'}</td>
                                <td className="px-4 py-3 text-right font-black text-slate-900">{i.qtyOrigem ?? 1}</td>
                              </tr>
                            ))}
                          </tbody>
                          <tfoot className="bg-slate-50">
                            <tr>
                              <td colSpan={3} className="px-4 py-3 font-bold text-slate-600">Total</td>
                              <td className="px-4 py-3 text-right font-black text-slate-900">{totalQty}</td>
                            </tr>
                          </tfoot>
                        </table>
                      )}
                    </div>
                  )}
                  <div className="mt-2 text-[11px] text-amber-900/70 leading-snug">
                    ⚠️ Ao fechar, o estoque das peças sai desta loja e a remessa vai pra
                    loja destino conferir. Dá pra <b>reabrir</b> depois pela aba Enviados —
                    cancelando a etiqueta e a nota, se já tiverem saído.
                    <br />
                    💡 Dica: você pode <b>fechar uma loja por vez</b> — as outras remessas continuam abertas pra acumular peças.
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {byDestination.length === 0 ? (
          <div className="bg-white rounded-2xl border-2 border-dashed border-slate-300 p-12 text-center shadow-sm">
            <div className="w-20 h-20 mx-auto rounded-full bg-emerald-50 flex items-center justify-center mb-4">
              <CheckCircle2 className="w-12 h-12 text-emerald-500" />
            </div>
            <div className="text-xl font-black text-slate-800">
              {view === 'pending'
                ? 'Nenhuma peça pendente'
                : 'Nenhuma peça enviada hoje ainda'}
            </div>
            <div className="text-sm text-slate-500 mt-2 max-w-md mx-auto">
              {view === 'pending'
                ? 'Quando a matriz despachar um realinhamento, ele aparece aqui na hora. Enquanto isso, fica tranquila.'
                : 'Assim que você marcar uma peça como ENVIEI, ela aparece nesta aba com o horário — pra você conferir o que já separou.'}
            </div>
          </div>
        ) : (
          byDestination.map((d) => {
            const isOpen = printMode || expandedDest === d.code;
            return (
              <section
                key={d.code}
                className="bg-white/90 backdrop-blur rounded-3xl border border-slate-200/80 shadow-xl overflow-hidden relative"
              >
                {/* Header destino = BOTÃO clicável. Toca abre/fecha a pilha.
                    Só 1 aberta por vez (accordion) — foco total em separar
                    uma loja antes de ir pra próxima. */}
                <button
                  type="button"
                  onClick={() => toggleDest(d.code)}
                  aria-expanded={isOpen}
                  aria-controls={`pilha-${d.code}`}
                  className="w-full bg-gradient-to-r from-emerald-500 via-teal-600 to-cyan-600 text-white px-5 py-5 flex items-center gap-4 relative overflow-hidden text-left active:scale-[0.995] hover:brightness-105 transition"
                >
                  <div className="absolute -top-8 -right-8 w-40 h-40 rounded-full bg-white/15 blur-2xl pointer-events-none" />
                  <div className="absolute bottom-0 left-1/3 w-32 h-32 rounded-full bg-cyan-300/20 blur-3xl pointer-events-none" />
                  <div className="w-14 h-14 rounded-2xl bg-white/20 backdrop-blur-md flex items-center justify-center shrink-0 ring-1 ring-white/30 shadow-lg relative">
                    <Send className="w-7 h-7" />
                  </div>
                  <div className="min-w-0 flex-1 relative">
                    <div className="text-[11px] font-black uppercase tracking-[0.15em] opacity-80">
                      Pilha pra
                    </div>
                    <div className="font-black text-2xl sm:text-3xl leading-tight truncate tracking-tight mt-0.5">
                      <span className="font-mono bg-white/25 backdrop-blur rounded-lg px-2.5 py-0.5 text-xl mr-2 ring-1 ring-white/30">
                        {d.code}
                      </span>
                      {d.name}
                    </div>
                  </div>
                  <div className="text-right shrink-0 relative">
                    <div className="text-4xl font-black tabular-nums leading-none tracking-tight">
                      {d.totalUnits}
                    </div>
                    <div className="text-[11px] font-black uppercase tracking-wider opacity-85 mt-1.5">
                      unidades
                    </div>
                  </div>
                  <ChevronDown
                    className={`no-print w-6 h-6 shrink-0 relative transition-transform duration-300 ${
                      isOpen ? 'rotate-180' : ''
                    }`}
                  />
                </button>

                {/* EXCLUIR PILHA (04/08 — dono: o excluir tem que estar ali
                    mesmo sem peça bipada). IRMÃO do botão do cabeçalho,
                    posicionado por cima — botão dentro de botão é HTML
                    inválido. Cancela os pedidos pendentes deste destino;
                    caixa aberta não é tocada (tem o próprio excluir). */}
                {view === 'pending' && (
                  <button
                    type="button"
                    onClick={() => handleExcluirPilha(d.code, d.name, d.totalUnits)}
                    title={`Excluir a pilha de ${d.name} — cancela os pedidos pendentes deste destino`}
                    className="no-print absolute top-2 right-14 z-10 bg-white/20 hover:bg-rose-600 backdrop-blur text-white rounded-lg px-2 py-1 text-[10px] font-black uppercase tracking-wide ring-1 ring-white/30 transition"
                  >
                    ✕ Excluir
                  </button>
                )}

                {/* A CAIXA daquele destino, colada na grade.
                    Um card por destino: cabeçalho com a caixa e as ações, grade
                    cor×tamanho embaixo. A caixa aberta continua recebendo peça,
                    então o que a pessoa precisa ver é o que FALTA pegar — e
                    isso é a grade, não uma tabela plana onde não dá pra bipar.
                    Fora do <button> do cabeçalho de propósito: botão dentro de
                    botão não é HTML válido e o clique vira loteria. */}
                {view === 'pending' && caixaDoDestino[d.code] && (
                  <div className="no-print bg-amber-50 border-b-2 border-amber-200 px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-sm font-black text-amber-900">
                        {caixaDoDestino[d.code].code}
                      </span>
                      <span className="text-[10px] bg-amber-200 text-amber-900 px-2 py-0.5 rounded font-bold uppercase">
                        aberta
                      </span>
                      <span className="text-xs text-amber-800/80">
                        {(caixaDoDestino[d.code].items || []).length} item(s) na caixa
                      </span>
                      <div className="flex flex-wrap gap-2 ml-auto">
                        <button
                          type="button"
                          onClick={() => handleDownloadPdf(caixaDoDestino[d.code].id, caixaDoDestino[d.code].code)}
                          className="bg-white hover:bg-amber-100 text-amber-900 border-2 border-amber-400 px-3 py-2 rounded-xl text-xs font-bold flex items-center gap-1.5"
                        >
                          <FileText className="w-4 h-4" /> PDF
                        </button>
                        <button
                          type="button"
                          onClick={() => handlePrintRemessa(caixaDoDestino[d.code].id, caixaDoDestino[d.code].code)}
                          className="bg-amber-100 hover:bg-amber-200 text-amber-900 border-2 border-amber-400 px-3 py-2 rounded-xl text-xs font-bold flex items-center gap-1.5"
                        >
                          <Printer className="w-4 h-4" /> Imprimir
                        </button>
                        <button
                          type="button"
                          onClick={() => handleCloseShipment(caixaDoDestino[d.code].id, caixaDoDestino[d.code].code)}
                          disabled={closingShipmentId === caixaDoDestino[d.code].id}
                          className="bg-amber-600 hover:bg-amber-700 text-white px-4 py-2 rounded-xl text-sm font-black flex items-center gap-2 disabled:opacity-50"
                        >
                          {closingShipmentId === caixaDoDestino[d.code].id
                            ? <Loader2 className="w-4 h-4 animate-spin" />
                            : <Send className="w-4 h-4" />}
                          Fechar e enviar
                        </button>
                        <button
                          type="button"
                          onClick={() => handleExcluirRemessa(
                            caixaDoDestino[d.code].id,
                            caixaDoDestino[d.code].code,
                            (caixaDoDestino[d.code].items || []).length,
                          )}
                          className="bg-white hover:bg-rose-50 text-rose-700 border-2 border-rose-300 px-3 py-2 rounded-xl text-xs font-bold flex items-center gap-1.5"
                          title="Exclui a caixa — as peças voltam pra fila 'a enviar'"
                        >
                          <X className="w-4 h-4" /> Excluir remessa
                        </button>
                      </div>
                    </div>
                    <p className="text-[11px] text-amber-900/70 mt-1.5 leading-snug">
                      As <b className="text-emerald-700">verdes</b> já estão na caixa · as claras
                      ainda faltam pegar. Dá pra <b>reabrir</b> depois pela aba Enviados.
                    </p>
                    {/* CAIXA IRMÃ (05/08 — fantasma da REM-809): existe OUTRA
                        caixa aberta pro mesmo destino. Antes ela ficava
                        invisível — o bipe caía nela e este cartão dizia
                        "0 item(s)". Agora avisa e aponta onde ela está. */}
                    {(irmasAbertas[d.code] || []).length > 0 && (
                      <div className="mt-2 bg-rose-50 border-2 border-rose-300 rounded-lg px-3 py-2 text-[11px] text-rose-900 leading-snug">
                        ⚠ <b>Este destino tem {(irmasAbertas[d.code] || []).length + 1} caixas abertas:</b>{' '}
                        {(irmasAbertas[d.code] || []).map((s: any) => (
                          <b key={s.id} className="font-mono">
                            {s.code} ({(s.items || []).length} item{(s.items || []).length !== 1 ? 's' : ''}) ·{' '}
                          </b>
                        ))}
                        estão logo acima, em <b>Remessas em montagem</b> — feche ou exclua por lá.
                        Peça verde desta grade pode estar em qualquer uma delas.
                      </div>
                    )}
                  </div>
                )}

                {/* Grupos por REF — só renderiza quando aberto */}
                {isOpen && (
                  <div id={`pilha-${d.code}`} className="divide-y divide-slate-100">
                    {d.refGroups.map((g) => (
                      <div key={g.ref} className="p-4 sm:p-6 space-y-4">
                        {/* Header do REF — card elegante com miniatura (quando tem)
                            ou ícone gradient fallback. Tamanho 16x20 mobile-first
                            pra vendedora reconhecer visualmente a peça antes de
                            ir na arara. */}
                        <div className="flex items-start gap-3 flex-wrap">
                          {/* Foto do produto. Prioriza g.imageUrl (cache wpDb backend);
                              fallback ProductThumb que busca WooCommerce REST por REF
                              (cache 1h + lightbox no click). Funciona em tela e print. */}
                          {g.imageUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={g.imageUrl}
                              alt={g.ref}
                              className="w-20 h-20 sm:w-24 sm:h-24 rounded-xl object-cover shrink-0 shadow-lg ring-1 ring-slate-200 bg-slate-100 cursor-zoom-in hover:ring-2 hover:ring-violet-400 transition"
                              loading="lazy"
                              referrerPolicy="no-referrer"
                              onClick={(e) => {
                                const src = (e.currentTarget as HTMLImageElement).src;
                                window.open(src, '_blank', 'noopener,noreferrer');
                              }}
                              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                            />
                          ) : (
                            <ProductThumb
                              sku={g.ref}
                              refCode={g.ref}
                              productName={g.descricao || g.ref}
                              size={80}
                            />
                          )}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <div className="font-mono font-black text-2xl sm:text-3xl text-slate-900 tracking-tight uppercase leading-none">
                                {g.ref.toUpperCase()}
                              </div>
                              <span className="text-xs bg-gradient-to-r from-indigo-50 to-violet-50 text-indigo-800 border border-indigo-200 rounded-full px-3 py-1 font-black uppercase tracking-wider shadow-sm">
                                {g.items.length} × {g.totalQty}un
                              </span>
                            </div>
                            {g.descricao && (
                              <div className="text-sm text-slate-600 font-medium mt-1.5 leading-snug line-clamp-2">
                                {g.descricao}
                              </div>
                            )}
                          </div>
                        </div>

                        {/* Grade Cor × Tamanho — formato idêntico à tela /consultar.
                            Header de tamanhos tipo tabela compacta + bolinha de cor +
                            coluna/linha Total. Células clicáveis pra marcar ENVIEI. */}
                        <RealignGrid
                          g={g}
                          sendingIds={sendingIds}
                          revertingIds={revertingIds}
                          onSend={markSent}
                          onRevert={markUnsent}
                          onReportNotFound={reportNotFound}
                          onUndoNotFound={undoNotFound}
                          onExcluir={excluirOrdem}
                          viewMode={view}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </section>
            );
          })
        )}

        {/* Info card — menor e muted, só referência. */}
        {byDestination.length > 0 && (
          <div className="no-print bg-indigo-50/60 border border-indigo-200 rounded-xl p-4 flex items-start gap-3">
            <div className="w-8 h-8 rounded-lg bg-indigo-100 flex items-center justify-center shrink-0">
              <Package className="w-4 h-4 text-indigo-700" />
            </div>
            <div className="text-xs text-indigo-900 leading-relaxed">
              {view === 'pending' ? (
                <>
                  <b className="text-sm">Como operar:</b><br />
                  Pegue a peça na arara · toque na célula com a quantidade e{' '}
                  <b>&quot;ENVIEI&quot;</b> · ela fica <b className="text-emerald-700">verde</b>{' '}
                  com o horário, já dentro da caixa daquela loja. As células
                  claras são o que ainda falta buscar. Errou? toque na verde pra
                  voltar. Quando a caixa estiver completa, <b>Fechar e enviar</b>.
                </>
              ) : (
                <>
                  <b className="text-sm">Conferência do dia:</b><br />
                  Essas são todas as peças que você marcou como ENVIEI hoje —
                  com horário de cada uma. A lista zera automaticamente à
                  meia-noite.
                </>
              )}
            </div>
          </div>
        )}
      </main>

      {/* Toasts */}
      <div className="no-print fixed bottom-4 left-1/2 -translate-x-1/2 space-y-2 z-50 w-full max-w-md px-4">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="bg-slate-900 text-white px-4 py-3 rounded-lg shadow-2xl text-sm font-semibold text-center"
          >
            {t.msg}
          </div>
        ))}
      </div>

      {/* Regras de impressão — esconde decorativos, achata gradientes pra
          economizar tinta e força todas as pilhas abertas. Sem página separada
          de preview: a própria tela vira o impresso quando clicam em Imprimir. */}
      <style jsx global>{`
        @media print {
          @page {
            size: A4 portrait;
            margin: 10mm;
          }
          html, body {
            background: white !important;
            color: #000 !important;
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
          }
          .no-print { display: none !important; }
          /* Garante fotos saírem no print (Chrome às vezes pula imagens externas) */
          img {
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
            display: block !important;
            visibility: visible !important;
          }
          header.sticky { position: static !important; box-shadow: none !important; }
          /* Gradientes e glass viram fundos sólidos limpos pra não gastar tinta */
          header[class*="from-indigo"],
          button[class*="from-emerald"] {
            background: #fff !important;
            color: #000 !important;
            box-shadow: none !important;
            border-bottom: 2px solid #000 !important;
          }
          /* Mantém legibilidade das grades */
          table { page-break-inside: auto; }
          tr { page-break-inside: avoid; page-break-after: auto; }
          section { page-break-inside: avoid; break-inside: avoid; }
          /* Borda clara em vez de shadow */
          .shadow-xl, .shadow-2xl, .shadow-lg { box-shadow: none !important; }
          /* Força ícones/spinners invisíveis no papel */
          svg.animate-spin { display: none !important; }
        }
      `}</style>

      {/* MODAL — problemas detectados pelo precheck antes de fechar remessa */}
      {problemasShipment && (
        <div
          className="fixed inset-0 bg-black/60 z-50 flex items-start justify-center p-4 overflow-y-auto"
          {...overlayClose(() => setProblemasShipment(null))}
        >
          <div
            className="bg-white rounded-2xl w-full max-w-2xl my-8 overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-3 bg-rose-50 border-b border-rose-200 flex items-center justify-between">
              <h2 className="font-black text-base text-rose-800 flex items-center gap-2">
                <AlertCircle className="w-5 h-5" />
                Não dá pra fechar a remessa {problemasShipment.code}
              </h2>
              <button onClick={() => setProblemasShipment(null)} className="text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-5 space-y-4">
              <div className="bg-amber-50 border border-amber-300 rounded-lg p-3 text-sm text-amber-900">
                <b>O que aconteceu:</b> uma ou mais peças desta remessa <b>não estão no estoque Giga da sua loja</b>.
                Causas possíveis: o plano de realinhamento sugeriu origem errada (peça nunca esteve aqui),
                a peça foi vendida fisicamente entre o pedido e a separação, ou tem divergência ERP × físico.
                <br />
                <br />
                <b>Como resolver:</b>
                <br />
                • Se a peça <b>está fisicamente em mãos</b>, clique <b>FORÇAR FECHAMENTO</b> abaixo (Giga fica negativo, conserta no inventário).
                <br />
                • Se a peça <b>não existe</b>, clique <b>Remover TODOS</b> pra tirar da remessa (não mexe no Giga).
              </div>

              {/* Botão geral: Remover TODOS (problemas + unresolved) */}
              {(problemasShipment.problemas.length + problemasShipment.unresolved.length) > 0 && (
                <div className="flex justify-end -mt-2">
                  <button
                    type="button"
                    onClick={handleRemoveAllProblematic}
                    disabled={!!batchRemoving}
                    className="px-3 py-1.5 bg-rose-700 hover:bg-rose-800 disabled:opacity-60 text-white rounded-lg text-xs font-bold flex items-center gap-1.5"
                    title="Remove TUDO problemático (estoque insuficiente + SKU não identificado). Não mexe no Giga."
                  >
                    {batchRemoving ? (
                      <>⏳ Removendo {batchRemoving.done}/{batchRemoving.total}…</>
                    ) : (
                      <>🗑️ Remover TODOS ({problemasShipment.problemas.length + problemasShipment.unresolved.length})</>
                    )}
                  </button>
                </div>
              )}

              {/* Items sem estoque */}
              {problemasShipment.problemas.length > 0 && (
                <div>
                  <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
                    <div className="text-xs font-bold uppercase text-rose-700 tracking-wider">
                      {problemasShipment.problemas.length} item(s) com estoque insuficiente
                    </div>
                  </div>
                  <div className="space-y-2">
                    {problemasShipment.problemas.map((p) => {
                      const desc = `${p.refCode} ${p.cor || ''} ${p.tamanho || ''}`.trim();
                      return (
                        <div
                          key={p.transferOrderId}
                          className="border-2 border-rose-200 bg-rose-50/40 rounded-lg p-3"
                        >
                          <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
                            <div>
                              <div className="font-bold text-sm text-slate-900">{desc}</div>
                              <div className="text-xs text-slate-600 mt-0.5">
                                SKU <span className="font-mono">{p.sku}</span> ·
                                Loja {p.storeCode} ·
                                <span className="text-rose-700 font-bold ml-1">
                                  Giga tem {p.estoqueGiga}, remessa pediu {p.qtyRequerida}
                                </span>
                              </div>
                            </div>
                          </div>
                          <div className="flex gap-2">
                            <button
                              onClick={() => handleRemoveItem(p.transferOrderId, desc)}
                              className="px-3 py-1.5 bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-xs font-bold flex items-center gap-1.5"
                            >
                              <X className="w-3.5 h-3.5" />
                              Remover da remessa
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Items com SKU não resolvido (REF+cor+tamanho não bate em produtos) */}
              {problemasShipment.unresolved.length > 0 && (
                <div>
                  <div className="text-xs font-bold uppercase text-amber-700 tracking-wider mb-2">
                    {problemasShipment.unresolved.length} item(s) com SKU não identificado
                  </div>
                  <div className="space-y-1.5">
                    {problemasShipment.unresolved.map((u, idx) => {
                      const desc = `${u.refCode} ${u.cor || ''} ${u.tamanho || ''}`.trim();
                      return (
                        <div key={u.transferOrderId || idx} className="text-sm bg-amber-50 border border-amber-200 rounded p-2">
                          <div className="flex items-center justify-between gap-2 flex-wrap">
                            <div>
                              <span className="font-mono font-bold">{u.refCode}</span>
                              <span className="ml-2 text-slate-600">
                                {u.cor || '—'} / {u.tamanho || '—'}
                              </span>
                              <div className="text-[10px] text-amber-700 mt-1">
                                Cadastro Giga divergente. Remove daqui ou conserte no Wincred.
                              </div>
                            </div>
                            {u.transferOrderId && (
                              <button
                                onClick={() => handleRemoveItem(u.transferOrderId!, desc)}
                                className="px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white rounded text-xs font-bold flex items-center gap-1.5 shrink-0"
                              >
                                <X className="w-3.5 h-3.5" />
                                Remover
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            <div className="px-5 py-3 bg-slate-50 border-t flex flex-wrap justify-between items-center gap-2">
              <div className="text-[11px] text-slate-600 max-w-[400px]">
                <b>Pecas em maos?</b> Use o botao laranja. O Giga ficara
                negativo nessas pecas (corrige no proximo inventario).
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setProblemasShipment(null)}
                  className="px-4 py-2 bg-white border border-slate-300 hover:bg-slate-100 rounded font-bold text-sm"
                >
                  Fechar
                </button>
                <button
                  onClick={async () => {
                    if (!problemasShipment) return;
                    const totalProb = problemasShipment.problemas.length;
                    const totalUnres = problemasShipment.unresolved.length;
                    const partes: string[] = [];
                    if (totalProb > 0) partes.push(totalProb + ' com estoque divergente');
                    if (totalUnres > 0) partes.push(totalUnres + ' com SKU nao identificado');
                    const msg = 'FORCAR fechamento da remessa ' + problemasShipment.code + '?\n\n' +
                      partes.join(' + ') + '.\n\n' +
                      'Use SO se as pecas estao fisicamente em maos. ' +
                      'Os itens com estoque divergente ficam Giga negativo (corrige no inventario). ' +
                      'Os com SKU nao identificado vao pra remessa SEM baixar Giga (admin revisa).';
                    if (!confirm(msg)) return;
                    const shipmentId = problemasShipment.shipmentId;
                    setClosingShipmentId(shipmentId);
                    setProblemasShipment(null);
                    try {
                      const res = await api<{ ok: boolean; code: string; totalItems: number; totalQty: number }>(
                        '/realignment/shipments/' + shipmentId + '/close-and-send',
                        { method: 'POST', body: '{}' },
                      );
                      pushToast('Remessa ' + res.code + ' FORCADA e enviada (' + res.totalQty + ' pecas).');
                      await Promise.all([loadOpenShipments(), loadPendingLabel(), loadItems(), loadSentItems()]);
                    } catch (e: any) {
                      alert('Erro ao forcar fechamento: ' + (e?.message || e));
                    } finally {
                      setClosingShipmentId(null);
                    }
                  }}
                  className="px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white border-2 border-amber-700 rounded font-black text-sm flex items-center gap-1.5 shadow-md"
                  title="Fecha a remessa ignorando divergencia de estoque/cadastro (pecas em maos)"
                >
                  FORCAR FECHAMENTO ({problemasShipment.problemas.length + problemasShipment.unresolved.length})
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * RealignGrid — grade Cor × Tamanho no MESMO formato da tela /consultar.
 *
 * Estrutura:
 *   thead: Cor | [tamanhos] | Total
 *   tbody: ● [COR]  | [células clicáveis amber] | [row total]
 *   tfoot: Total    | [col totals]              | [grand total]
 *
 * Diferença do /consultar: as células aqui representam peças A ENVIAR.
 * Clicar na célula = marcar "ENVIEI" (dispara onSend). Durante o envio,
 * mostra spinner. Células sem peça (aquele cor/tam não veio no lote) ficam
 * "—" em slate, não são clicáveis.
 */
function RealignGrid({
  g,
  sendingIds,
  revertingIds,
  onSend,
  onRevert,
  onReportNotFound,
  onUndoNotFound,
  onExcluir,
  viewMode,
}: {
  g: {
    ref: string;
    descricao: string;
    cores: string[];
    tams: string[];
    matrix: Record<string, Record<string, RealignmentItem | null>>;
    totalQty: number;
    items: RealignmentItem[];
  };
  sendingIds: Set<string>;
  revertingIds: Set<string>;
  onSend: (id: string) => void;
  onRevert: (id: string) => void;
  onReportNotFound: (item: RealignmentItem) => void;
  onUndoNotFound: (item: RealignmentItem) => void;
  onExcluir: (item: RealignmentItem, totalNaCelula: number) => void;
  viewMode: ViewMode;
}) {
  // Totais por cor (linha) e por tamanho (coluna) — ignora células vazias.
  const totalsByColor = new Map<string, number>();
  const totalsBySize = new Map<string, number>();
  for (const c of g.cores) {
    let rowTotal = 0;
    for (const t of g.tams) {
      const it = g.matrix[c][t];
      if (it) {
        rowTotal += it.qtyOrigem;
        totalsBySize.set(t, (totalsBySize.get(t) || 0) + it.qtyOrigem);
      }
    }
    totalsByColor.set(c, rowTotal);
  }

  return (
    <>
      <div className="overflow-x-auto border border-slate-200 rounded-lg">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-slate-100 border-b border-slate-200">
              <th className="text-left px-2 py-2 font-bold text-slate-700 sticky left-0 bg-slate-100 z-10 min-w-[80px]">
                Cor
              </th>
              {g.tams.map((s) => (
                <th
                  key={s}
                  className="px-1 py-2 text-center font-bold text-slate-700 min-w-[42px]"
                >
                  {s}
                </th>
              ))}
              <th className="px-1 py-2 text-center font-bold text-slate-700 min-w-[44px] bg-slate-200 sticky right-0 z-10">
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {g.cores.map((cor) => {
              const colorTotal = totalsByColor.get(cor) || 0;
              return (
                <tr
                  key={cor}
                  className="transition border-b border-slate-100 hover:bg-slate-50"
                >
                  <td className="px-2 py-2 font-semibold text-slate-800 sticky left-0 z-10 bg-white border-r border-slate-100">
                    <div className="flex items-center gap-1.5">
                      <span
                        className={`w-2 h-2 rounded-full shrink-0 ${
                          colorTotal > 0 ? 'bg-emerald-500' : 'bg-slate-300'
                        }`}
                      />
                      <span
                        className="truncate max-w-[90px] uppercase tracking-wide text-xs"
                        title={cor}
                      >
                        {cor}
                      </span>
                    </div>
                  </td>
                  {g.tams.map((s) => {
                    const it = g.matrix[cor]?.[s] ?? null;
                    return (
                      <td key={s} className="p-0.5 text-center">
                        <RealignCell
                          item={it}
                          sending={it ? sendingIds.has(it.id) : false}
                          reverting={it ? revertingIds.has(it.id) : false}
                          onSend={onSend}
                          onRevert={onRevert}
                          onReportNotFound={onReportNotFound}
                          onUndoNotFound={onUndoNotFound}
                          onExcluir={onExcluir}
                          viewMode={viewMode}
                        />
                      </td>
                    );
                  })}
                  <td
                    className={`px-1 py-2 text-center font-bold sticky right-0 z-10 ${
                      colorTotal > 0 ? 'text-emerald-700' : 'text-slate-400'
                    } bg-slate-50`}
                  >
                    {colorTotal}
                  </td>
                </tr>
              );
            })}
            {/* Linha totais por tamanho */}
            <tr className="bg-slate-100 border-t-2 border-slate-300">
              <td className="px-2 py-2 font-bold text-slate-700 sticky left-0 bg-slate-100 z-10 border-r border-slate-200">
                Total
              </td>
              {g.tams.map((s) => {
                const t = totalsBySize.get(s) || 0;
                return (
                  <td
                    key={s}
                    className={`px-1 py-2 text-center font-bold ${
                      t > 0 ? 'text-slate-800' : 'text-slate-400'
                    }`}
                  >
                    {t}
                  </td>
                );
              })}
              <td className="px-1 py-2 text-center font-extrabold text-emerald-700 bg-slate-200 sticky right-0 z-10">
                {g.totalQty}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Legenda — contexto muda conforme modo (separando vs. conferindo). */}
      <div className="flex flex-wrap items-center gap-3 mt-2 px-1 text-[11px] text-slate-500">
        {viewMode === 'pending' ? (
          <>
            <span className="inline-flex items-center gap-1">
              <span className="w-3 h-3 rounded bg-amber-100 border border-amber-300 inline-block" />
              a enviar · toque pra marcar ENVIEI
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="w-3 h-3 rounded bg-emerald-200 border border-emerald-400 inline-block" />
              enviando...
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="w-3 h-3 rounded bg-slate-50 border border-slate-200 inline-block" />
              sem peça neste lote
            </span>
          </>
        ) : (
          <>
            <span className="inline-flex items-center gap-1">
              <span className="w-3 h-3 rounded bg-emerald-100 border border-emerald-400 inline-block" />
              enviada · mostra horário
            </span>
            <span className="inline-flex items-center gap-1">
              <Undo2 className="w-3 h-3 text-rose-600" />
              clicou errado? toque numa célula verde pra voltar pra pendentes
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="w-3 h-3 rounded bg-slate-50 border border-slate-200 inline-block" />
              sem peça neste lote
            </span>
          </>
        )}
      </div>
    </>
  );
}

/**
 * Célula individual da grade de realinhamento.
 *   - Com item:  amber, clicável (mostra qty grande + "ENVIEI" pequeno)
 *   - Sem item:  "—" slate, não clicável
 *   - Enviando:  emerald + spinner
 *   - Enviada (modo sent): verde clicável → clica pra REVERTER pra pendente
 *   - Revertendo: spinner em cima do verde
 */
function RealignCell({
  item,
  sending,
  reverting,
  onSend,
  onRevert,
  onReportNotFound,
  onUndoNotFound,
  onExcluir,
  viewMode,
}: {
  item: RealignmentItem | null;
  sending: boolean;
  reverting: boolean;
  onSend: (id: string) => void;
  onRevert: (id: string) => void;
  onReportNotFound: (item: RealignmentItem) => void;
  onUndoNotFound: (item: RealignmentItem) => void;
  onExcluir: (item: RealignmentItem, totalNaCelula: number) => void;
  viewMode: ViewMode;
}) {
  const base =
    'mx-auto w-full h-10 rounded flex flex-col items-center justify-center font-extrabold relative transition select-none';

  if (!item) {
    return (
      <div className={`${base} bg-slate-50 text-slate-300 text-base`}>
        —
      </div>
    );
  }

  /**
   * A célula pode representar MAIS DE UMA ordem da mesma cor+tamanho (ver o
   * comentário em byDestination). Toda ação vale pro conjunto: bipar marca as
   * que faltam, reverter devolve as que estão na caixa. Assim a tela para de
   * mentir sobre quantas peças aquela posição pede — foi o que gerou caixa com
   * peça duplicada.
   */
  const celula = item.celula && item.celula.length ? item.celula : [item];
  const naCaixa = celula.filter((x) => x.sentAt);
  const aPegar = celula.filter((x) => !x.sentAt && x.realignmentStatus !== 'not_found');
  const parcial = naCaixa.length > 0 && aPegar.length > 0;
  const qtdCelula = celula.length;

  /**
   * Célula VERDE — peça já bipada. Clicável pra REVERTER o clique errado.
   *
   * A decisão é do ITEM (`sentAt`), não mais só da aba. Na aba amarela a grade
   * agora mistura os dois estados: o que falta pegar em célula aberta e o que
   * já está na caixa em verde, com o horário. Amarrado só à aba, a peça da
   * caixa aberta apareceria como se ainda estivesse na arara — e a vendedora
   * ia buscar de novo o que já tinha separado.
   *
   * Reverter continua seguro: o backend recusa se a remessa já fechou.
   */
  /**
   * Célula NÃO ACHADA — a peça foi reportada como ausente (o ✕).
   *
   * Antes ela simplesmente sumia da tela, e com ela a pilha inteira da loja
   * destino quando era a última peça — foi assim que a caixa de SANTOS
   * "desapareceu" em Itanhaém (04/08). Agora fica visível, riscada, e toque
   * DESFAZ: a peça volta pra fila de separação.
   */
  if (item.realignmentStatus === 'not_found') {
    return (
      <button
        type="button"
        onClick={() => onUndoNotFound(item)}
        title={
          `NÃO ACHADA${item.realignmentNotFoundNote ? ` — "${item.realignmentNotFoundNote}"` : ''}` +
          ` · toque pra DESFAZER e voltar pra separação`
        }
        className={`${base} bg-rose-100 text-rose-800 border border-rose-300 hover:bg-amber-100 hover:border-amber-400 hover:text-amber-900 active:scale-95 cursor-pointer`}
      >
        <span className="tabular-nums text-base leading-none line-through opacity-70">
          {item.qtyOrigem}
        </span>
        <span className="text-[9px] font-bold leading-none mt-0.5">não achada</span>
        <Undo2 className="w-3 h-3 absolute top-0.5 right-0.5 text-rose-600/80" />
      </button>
    );
  }

  // PARCIAL: parte da célula já está na caixa e ainda falta pegar o resto.
  // Antes esse estado não existia — a peça que faltava aparecia como se nada
  // tivesse sido separado, e bipar de novo mandava uma peça a mais.
  if (viewMode !== 'sent' && parcial) {
    return (
      <button
        type="button"
        onClick={() => aPegar.forEach((x) => onSend(x.id))}
        title={
          `${naCaixa.length} de ${qtdCelula} já na caixa · toque pra marcar ${aPegar.length > 1 ? 'as restantes' : 'a restante'}`
        }
        className={`${base} bg-amber-200 text-amber-900 border-2 border-emerald-500 hover:bg-amber-300 active:scale-95 cursor-pointer`}
      >
        <span className="tabular-nums text-base leading-none">{item.qtyOrigem}</span>
        <span className="text-[9px] font-black leading-none mt-0.5">
          {naCaixa.length}/{qtdCelula} na caixa
        </span>
      </button>
    );
  }

  if (viewMode === 'sent' || item.sentAt) {
    const time = formatTime(item.sentAt || naCaixa[0]?.sentAt);
    if (reverting) {
      return (
        <div className={`${base} bg-emerald-200 text-emerald-900 border border-emerald-400`}>
          <Loader2 className="w-4 h-4 animate-spin" />
        </div>
      );
    }
    return (
      <button
        type="button"
        onClick={() => (naCaixa.length ? naCaixa : [item]).forEach((x) => onRevert(x.id))}
        title={
          `${qtdCelula > 1 ? `${qtdCelula} peças · ` : ''}enviado às ${time || '—'} pra LJ${item.lojaDestinoCode}` +
          ` — toque pra REVERTER pra pendente`
        }
        className={`${base} bg-emerald-100 text-emerald-900 border border-emerald-400 hover:bg-rose-100 hover:border-rose-400 hover:text-rose-900 active:scale-95 cursor-pointer`}
      >
        <span className="tabular-nums text-base leading-none">{item.qtyOrigem}</span>
        <span className="text-[9px] font-bold opacity-70 leading-none mt-0.5">{time}</span>
        <Undo2 className="w-3 h-3 absolute top-0.5 right-0.5 text-emerald-700/80" />
      </button>
    );
  }

  if (sending) {
    return (
      <div className={`${base} bg-emerald-200 text-emerald-900 border border-emerald-400`}>
        <Loader2 className="w-4 h-4 animate-spin" />
      </div>
    );
  }

  return (
    <div className={`${base} bg-amber-100 text-amber-900 border border-amber-300 hover:bg-amber-200 text-base`}>
      <button
        type="button"
        onClick={() => (aPegar.length ? aPegar : [item]).forEach((x) => onSend(x.id))}
        title={
          `Marcar como ENVIEI — ${item.qtyOrigem}un` +
          (qtdCelula > 1 ? ` (${qtdCelula} ordens desta cor/tamanho)` : '')
        }
        className="absolute inset-0 cursor-pointer active:scale-95 transition-transform rounded"
        aria-label="Marcar enviada"
      />
      <span className="tabular-nums pointer-events-none relative">{item.qtyOrigem}</span>
      <CheckCircle2 className="w-3 h-3 absolute top-0.5 right-0.5 text-amber-700/70 pointer-events-none" />
      {/* Botão ❌ no canto superior esquerdo: reporta peça não encontrada */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onReportNotFound(item);
        }}
        title="Não achei a peça — reportar pra matriz"
        aria-label="Não achei essa peça"
        className="absolute top-0 left-0 w-5 h-5 rounded-tl rounded-br bg-rose-500/90 hover:bg-rose-600 text-white flex items-center justify-center text-[10px] font-black shadow z-10 active:scale-90 transition"
      >
        ✕
      </button>
      {/* 🗑 no canto inferior esquerdo: a matriz pediu peça a mais.
          Diferente do ✕ — ali a peça não foi achada, aqui o pedido é que
          estava errado. Tira do pedido e não volta. */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onExcluir(item, qtdCelula);
        }}
        title={
          qtdCelula > 1
            ? `Pedido em duplicidade? Excluir 1 das ${qtdCelula} peças desta posição`
            : 'Excluir esta peça do pedido (a matriz pediu errado)'
        }
        aria-label="Excluir do pedido"
        className="absolute bottom-0 left-0 w-5 h-5 rounded-bl rounded-tr bg-slate-500/80 hover:bg-slate-700 text-white flex items-center justify-center text-[9px] shadow z-10 active:scale-90 transition"
      >
        🗑
      </button>
    </div>
  );
}

/* ────────── Etiqueta + nota da remessa que acabou de fechar ────────── */

/**
 * Os MESMOS endpoints da Retaguarda (`gerar-envio` e `docs-envio`), na tela
 * onde a loja já está.
 *
 * Por que aqui: quem fecha a caixa é quem posta. Obrigar a vendedora a abrir a
 * Retaguarda pra pegar o papel da caixa que está na mão dela é passo perdido —
 * e passo perdido vira caixa parada esperando alguém "gerar depois".
 *
 * O endereço não é digitado em lugar nenhum: remetente e destinatário saem da
 * config fiscal das lojas, a mesma que a NF-e usa.
 */
function EnvioDaRemessa({
  shipmentId, code, qty, onFechar, destino, rastreioExistente = null, jaTemEtiqueta = false,
  notaAutorizada = null, rotaPropria = false, onPdf, onImprimir, onMudou,
}: {
  shipmentId: string;
  code: string;
  qty: number;
  /** Só a caixa que ACABOU de fechar pode ser dispensada. A da lista some
   *  sozinha quando sai da janela de dias — dar um "fechar" ali seria oferecer
   *  esconder trabalho que ainda existe. */
  onFechar?: () => void;
  destino?: string;
  /** Rastreio que já está gravado — a caixa pode ter tido o envio gerado num
   *  dia e a impressão falhado no outro. */
  rastreioExistente?: string | null;
  jaTemEtiqueta?: boolean;
  /** Número da NF-e autorizada desta caixa, se houver. */
  notaAutorizada?: string | number | null;
  /** Caixa que vai no carro da rede (Itanhaém/Praia Grande/Santos): existe,
   *  aparece e pode ser conferida — só não tem etiqueta dos Correios. */
  rotaPropria?: boolean;
  /** Romaneio (número da remessa + relação das peças). Existe em TODA caixa,
   *  mas é o único papel da rota própria — lá não há etiqueta nem NF pra
   *  imprimir, e a caixa precisa seguir com a relação do que vai dentro. */
  onPdf?: () => void;
  onImprimir?: () => void;
  /** Recarrega as listas da tela — a caixa reaberta sai daqui e volta pras
   *  amarelas, então quem manda tem que saber. */
  onMudou?: () => void;
}) {
  const [ocupado, setOcupado] = useState<'gerar' | 'docs' | 'reabrir' | 'conteudo' | null>(null);
  const [rastreio, setRastreio] = useState<string | null>(rastreioExistente);
  const [conteudo, setConteudo] = useState<any[] | null>(null);
  const [msg, setMsg] = useState<{ tipo: 'ok' | 'erro'; texto: string } | null>(null);

  /**
   * `forcar` = caixa da rota do carro sendo postada pelos Correios mesmo
   * assim (dono 04/08: "como emito o correio?" — a caixa de Santos ficou sem
   * saída). O backend vira a remessa pra CORREIOS e gera NF + etiqueta.
   */
  async function gerar(forcar = false) {
    if (forcar && !window.confirm(
      `Postar a caixa ${code} pelos CORREIOS?\n\n` +
      `Ela é da rota do carro da rede — forçando, o transporte vira CORREIOS ` +
      `e o sistema emite a nota fiscal e a etiqueta agora.`,
    )) return;
    setOcupado('gerar');
    setMsg(null);
    try {
      const r = await api<any>(`/realignment/shipments/${shipmentId}/gerar-envio`, {
        method: 'POST',
        body: JSON.stringify(forcar ? { forcar: true } : {}),
      });
      setRastreio(r?.codigoRastreio ?? null);
      setMsg({
        tipo: 'ok',
        texto: r?.jaGerado
          ? `Já tinha envio: ${r.carrier || ''} ${r.codigoRastreio}`
          : `${r?.carrier || 'Envio'} gerado — rastreio ${r?.codigoRastreio}`,
      });
      // Forçou rota própria → Correios: o cartão precisa renascer como
      // Correios (com Etiqueta + NF) — recarrega as listas.
      if (forcar) onMudou?.();
    } catch (e: any) {
      setMsg({ tipo: 'erro', texto: e?.message?.replace(/^\d+:\s*/, '') || 'Falha ao gerar o envio' });
    } finally {
      setOcupado(null);
    }
  }

  async function reabrir() {
    // O aviso lista o que vai ser DESFEITO, item por item. Reabrir mexe em
    // estoque, em cobrança entre lojas e — quando tem nota — em documento
    // fiscal; um "tem certeza?" genérico esconderia justamente isso.
    const desfaz = [
      jaTemEtiqueta ? `⚠️ A ETIQUETA ${rastreio || ''} será CANCELADA — jogue fora, não poste com ela.` : null,
      notaAutorizada ? `⚠️ A NOTA FISCAL ${notaAutorizada} será CANCELADA na SEFAZ (prazo de 24h; fora dele a SEFAZ recusa e nada muda).` : null,
      'As peças voltam pra "a enviar" na aba Pendentes — pra pegar e bipar de novo.',
      'O estoque volta pra loja e a cobrança do acerto é cancelada.',
      'A loja destino deixa de esperar a caixa.',
    ].filter(Boolean);
    if (!window.confirm(`Reabrir a caixa ${code}?\n\n${desfaz.join('\n')}`)) return;
    setOcupado('reabrir');
    setMsg(null);
    try {
      const r = await api<any>(`/realignment/shipments/${shipmentId}/reabrir`, {
        method: 'POST',
        // Confirmado na tela: a etiqueta vai pro lixo. Sem isto o backend
        // recusa — e recusar sem saída foi o que prendeu as caixas antes.
        body: JSON.stringify({
          descartarEtiqueta: jaTemEtiqueta,
          cancelarNota: !!notaAutorizada,
        }),
      });
      setMsg({
        tipo: 'ok',
        texto:
          `Caixa desfeita — ${r?.voltaramPendentes ?? 0} peça(s) voltaram pra "a enviar" na aba Pendentes.` +
          (r?.etiquetaDescartada ? ' Etiqueta cancelada.' : '') +
          (r?.notaCancelada ? ` NF-e ${r.notaCancelada} cancelada na SEFAZ.` : ''),
      });
      onMudou?.();
    } catch (e: any) {
      setMsg({ tipo: 'erro', texto: e?.message?.replace(/^\d+:\s*/, '') || 'Falha ao reabrir' });
    } finally {
      setOcupado(null);
    }
  }

  async function verConteudo() {
    setOcupado('conteudo');
    setMsg(null);
    try {
      const r = await api<any>(`/realignment/shipments/${shipmentId}`);
      setConteudo(Array.isArray(r?.items) ? r.items : []);
    } catch (e: any) {
      setMsg({ tipo: 'erro', texto: e?.message?.replace(/^\d+:\s*/, '') || 'Falha ao abrir o conteúdo' });
    } finally {
      setOcupado(null);
    }
  }

  async function baixarDocs() {
    setOcupado('docs');
    setMsg(null);
    try {
      const r = await api<any>(`/realignment/shipments/${shipmentId}/docs-envio`);
      if (!r?.pdfBase64) throw new Error('PDF não veio');
      const a = document.createElement('a');
      a.href = `data:application/pdf;base64,${r.pdfBase64}`;
      a.download = `${code}-etiqueta-danfe.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setMsg({
        tipo: 'ok',
        texto: r?.temNota ? 'PDF baixado (etiqueta + DANFE).' : 'PDF baixado (só a etiqueta — DANFE não disponível).',
      });
    } catch (e: any) {
      setMsg({ tipo: 'erro', texto: e?.message?.replace(/^\d+:\s*/, '') || 'Falha ao baixar' });
    } finally {
      setOcupado(null);
    }
  }

  return (
    <div className="rounded-2xl border-2 border-emerald-300 bg-emerald-50 p-4 mb-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-black text-emerald-900">
            Remessa {code} enviada · {qty} peça(s)
            {destino && <span className="font-bold"> · pra {destino}</span>}
          </p>
          <p className="text-xs text-emerald-800/80 mt-0.5">
            {rotaPropria
              ? '🚚 Vai no carro da rede — sem etiqueta dos Correios. Confira o conteúdo ou reabra se faltou peça.'
              : jaTemEtiqueta
                ? 'Envio já gerado — clique em Etiqueta + NF pra imprimir de novo.'
                : 'Agora gere a etiqueta dos Correios e imprima junto com a nota — sem sair desta tela.'}
          </p>
          {rastreio && (
            <p className="text-xs font-mono font-bold text-emerald-900 mt-1">Rastreio: {rastreio}</p>
          )}
        </div>
        <div className="flex flex-wrap gap-2 shrink-0">
          {/* Rota própria: o padrão é o carro da rede, então o "Gerar envio"
              normal sai de cena — mas SEMPRE com a saída de postar mesmo
              assim (dono 04/08: a caixa de Santos ficou sem como emitir).
              Forçar vira a remessa pra CORREIOS e emite NF + etiqueta. */}
          {rotaPropria && (
            <button
              type="button"
              onClick={() => void gerar(true)}
              disabled={ocupado !== null}
              className="bg-white hover:bg-emerald-50 text-emerald-800 border-2 border-dashed border-emerald-400 px-4 py-2.5 rounded-xl text-sm font-bold shadow-sm flex items-center gap-2 disabled:opacity-50"
              title="A caixa é da rota do carro, mas dá pra postar pelos Correios mesmo assim — gera NF + etiqueta"
            >
              {ocupado === 'gerar' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Truck className="w-4 h-4" />}
              Postar pelos Correios
            </button>
          )}
          {!rotaPropria && (
            <>
              <button
                type="button"
                onClick={() => void gerar()}
                disabled={ocupado !== null}
                className="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2.5 rounded-xl text-sm font-black shadow-md flex items-center gap-2 disabled:opacity-50"
              >
                {ocupado === 'gerar' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Truck className="w-4 h-4" />}
                {jaTemEtiqueta ? 'Refazer envio' : 'Gerar envio Correios'}
              </button>
              <button
                type="button"
                onClick={() => void baixarDocs()}
                disabled={ocupado !== null}
                className="bg-white hover:bg-emerald-100 text-emerald-900 border-2 border-emerald-400 px-4 py-2.5 rounded-xl text-sm font-bold shadow-sm flex items-center gap-2 disabled:opacity-50"
              >
                {ocupado === 'docs' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Printer className="w-4 h-4" />}
                Etiqueta + NF
              </button>
            </>
          )}

          {/* REPROCESSAR NOTA — conserta NF-e emitida com itens faltando SEM
              reabrir a caixa e SEM re-bipar (caso REM-838: nota de 2 itens
              numa caixa de 57). Cancela a nota na SEFAZ (prazo 24h) e emite
              outra completa; a etiqueta continua a mesma. */}
          {notaAutorizada && (
            <button
              type="button"
              onClick={async () => {
                if (!window.confirm(
                  `Reprocessar a nota da caixa ${code}?\n\n` +
                  `• A NF-e ${notaAutorizada} será CANCELADA na SEFAZ (prazo de 24h).\n` +
                  `• Uma nota NOVA sai com TODAS as peças da caixa — se ainda faltar código em alguma, ` +
                  `a emissão recusa e mostra a lista.\n` +
                  `• A etiqueta/rastreio continuam os mesmos.`,
                )) return;
                setOcupado('gerar');
                setMsg(null);
                try {
                  const r = await api<any>(`/realignment/shipments/${shipmentId}/reprocessar-nota`, {
                    method: 'POST', body: '{}',
                  });
                  setMsg({
                    tipo: 'ok',
                    texto: `Nota reprocessada: nº ${r?.notaNova?.numero ?? '?'} no lugar da ` +
                      `${r?.notaCancelada?.numero ?? '—'} · ${r?.skusAtualizados ?? 0} código(s) corrigido(s). ` +
                      `Imprima a Etiqueta + NF de novo.`,
                  });
                  onMudou?.();
                } catch (e: any) {
                  setMsg({ tipo: 'erro', texto: e?.message?.replace(/^\d+:\s*/, '') || 'Falha ao reprocessar' });
                } finally {
                  setOcupado(null);
                }
              }}
              disabled={ocupado !== null}
              className="bg-white hover:bg-amber-50 text-amber-800 border-2 border-amber-400 px-4 py-2.5 rounded-xl text-sm font-bold shadow-sm flex items-center gap-2 disabled:opacity-50"
              title="Cancela a nota atual na SEFAZ e emite outra com TODAS as peças — sem reabrir, sem re-bipar"
            >
              {ocupado === 'gerar' ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
              Reprocessar nota
            </button>
          )}

          {/* ROMANEIO — número da remessa + relação do que vai dentro.
              Na rota própria é o único papel que acompanha a caixa: quem
              recebe confere peça por peça contra essa lista. */}
          {onImprimir && (
            <button
              type="button"
              onClick={onImprimir}
              disabled={ocupado !== null}
              className="bg-white hover:bg-emerald-100 text-emerald-900 border-2 border-emerald-400 px-4 py-2.5 rounded-xl text-sm font-bold shadow-sm flex items-center gap-2 disabled:opacity-50"
              title="Imprime o romaneio: número da remessa e a relação das peças"
            >
              <Printer className="w-4 h-4" /> Imprimir relação
            </button>
          )}
          {onPdf && (
            <button
              type="button"
              onClick={onPdf}
              disabled={ocupado !== null}
              className="bg-white hover:bg-slate-100 text-slate-800 border-2 border-slate-300 px-4 py-2.5 rounded-xl text-sm font-bold shadow-sm flex items-center gap-2 disabled:opacity-50"
              title="Baixa o romaneio em PDF"
            >
              <FileText className="w-4 h-4" /> PDF
            </button>
          )}
          {/* Conferir o que está dentro ANTES de lacrar de vez — e desfazer se
              a caixa foi fechada sem querer ou faltou peça. */}
          <button
            type="button"
            onClick={() => (conteudo ? setConteudo(null) : void verConteudo())}
            disabled={ocupado !== null}
            className="bg-white hover:bg-slate-100 text-slate-800 border-2 border-slate-300 px-4 py-2.5 rounded-xl text-sm font-bold shadow-sm flex items-center gap-2 disabled:opacity-50"
          >
            {ocupado === 'conteudo' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Package className="w-4 h-4" />}
            {conteudo ? 'Ocultar conteúdo' : 'Verificar conteúdo'}
          </button>
          <button
            type="button"
            onClick={() => void reabrir()}
            disabled={ocupado !== null}
            title="Desfaz a caixa: as peças voltam pra 'a enviar' e o estoque volta pra loja"
            className="bg-white hover:bg-amber-50 text-amber-900 border-2 border-amber-400 px-4 py-2.5 rounded-xl text-sm font-bold shadow-sm flex items-center gap-2 disabled:opacity-50"
          >
            {ocupado === 'reabrir' ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
            Reabrir caixa
          </button>
          {onFechar && (
            <button
              type="button"
              onClick={onFechar}
              className="text-emerald-800/70 hover:text-emerald-900 px-2 py-2.5 text-xs font-bold"
            >
              fechar
            </button>
          )}
        </div>
      </div>
      {msg && (
        <p className={`text-xs mt-2 font-semibold ${msg.tipo === 'ok' ? 'text-emerald-800' : 'text-rose-700'}`}>
          {msg.texto}
        </p>
      )}

      {/* Conteúdo da caixa — REF, cor, tamanho e quantidade, do jeito que a
          pessoa vai conferir peça na mão antes de lacrar. */}
      {conteudo && (
        <div className="mt-3 rounded-xl border border-emerald-200 bg-white overflow-hidden">
          {conteudo.length === 0 ? (
            <p className="text-xs text-slate-500 p-3">Esta caixa está sem itens.</p>
          ) : (
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-500 uppercase tracking-wide">
                <tr>
                  <th className="text-left px-3 py-2 font-bold">Ref</th>
                  <th className="text-left px-3 py-2 font-bold">Cor</th>
                  <th className="text-left px-3 py-2 font-bold">Tam</th>
                  <th className="text-right px-3 py-2 font-bold">Qtd</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {conteudo.map((i: any) => (
                  <tr key={i.id}>
                    <td className="px-3 py-2 font-mono font-bold text-slate-900">{i.refCode}</td>
                    <td className="px-3 py-2 text-slate-700">{i.cor || '—'}</td>
                    <td className="px-3 py-2 text-slate-700">{i.tamanho || '—'}</td>
                    <td className="px-3 py-2 text-right font-bold text-slate-900">{i.qtyOrigem ?? 1}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-slate-50">
                <tr>
                  <td colSpan={3} className="px-3 py-2 font-bold text-slate-600">Total</td>
                  <td className="px-3 py-2 text-right font-black text-slate-900">
                    {conteudo.reduce((n: number, i: any) => n + (i.qtyOrigem ?? 1), 0)}
                  </td>
                </tr>
              </tfoot>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
