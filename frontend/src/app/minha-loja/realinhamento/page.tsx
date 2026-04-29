'use client';

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
import { getSocket } from '@/lib/socket';
import {
  ArrowLeft, Shuffle, CheckCircle2, Loader2, RefreshCw, Package,
  AlertCircle, Send, Sparkles, Shirt, ChevronDown, Printer, Undo2,
  Truck, X, FileText,
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
  const [closingShipmentId, setClosingShipmentId] = useState<string | null>(null);

  const toggleDest = useCallback((code: string) => {
    setExpandedDest((curr) => (curr === code ? null : code));
  }, []);

  const handlePrint = useCallback(async () => {
    setPrintMode(true);
    // Espera React renderizar todas as pilhas antes de chamar print
    await new Promise((r) => setTimeout(r, 150));
    window.print();
    // Restaura estado original depois que fechou o diálogo de impressão
    setTimeout(() => setPrintMode(false), 500);
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
   */
  const handleDownloadPdf = useCallback(async (shipmentId: string, code: string) => {
    try {
      const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_token') : null;
      if (!token) {
        alert('Sessão expirada. Faça login novamente.');
        return;
      }
      const { API_URL } = await import('@/lib/api');
      const r = await fetch(`${API_URL}/realignment/shipments/${shipmentId}/pdf`, {
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

  const handleCloseShipment = useCallback(async (shipmentId: string, code: string) => {
    if (!confirm(`Fechar remessa ${code} e enviar?\n\nIsso vai BAIXAR o estoque Giga das peças desta remessa. Não pode desfazer.`)) return;
    setClosingShipmentId(shipmentId);
    try {
      const res = await api<{ ok: boolean; code: string; totalItems: number; totalQty: number }>(
        `/realignment/shipments/${shipmentId}/close-and-send`,
        { method: 'POST', body: '{}' },
      );
      pushToast(`✅ Remessa ${res.code} enviada (${res.totalQty} peças). Loja destino recebeu alerta.`);
      await Promise.all([loadOpenShipments(), loadItems(), loadSentItems()]);
    } catch (e: any) {
      alert(`Erro ao fechar remessa: ${e?.message || e}`);
    } finally {
      setClosingShipmentId(null);
    }
  }, [pushToast, loadOpenShipments, loadItems, loadSentItems]);

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
        await Promise.all([loadItems(), loadSentItems(), loadOpenShipments()]);
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
    const item = sentItems.find((i) => i.id === itemId);
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

  async function markSent(itemId: string) {
    setSendingIds((prev) => new Set(prev).add(itemId));
    try {
      await api(`/realignment/${itemId}/sent`, { method: 'PATCH' });
      // Move otimisticamente: tira dos pendentes e coloca no topo de "enviados
      // hoje" com timestamp local, pra aparecer na aba de conferência na hora.
      let moved: RealignmentItem | null = null;
      setItems((prev) => {
        const found = prev.find((i) => i.id === itemId);
        if (found) moved = found;
        return prev.filter((i) => i.id !== itemId);
      });
      if (moved) {
        const stamped: RealignmentItem = {
          ...(moved as RealignmentItem),
          sentAt: new Date().toISOString(),
        };
        setSentItems((prev) => [stamped, ...prev]);
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
  const currentItems = view === 'pending' ? items : sentItems;

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
            for (const it of list) {
              matrix[it.cor || '—'][it.tamanho || '—'] = it;
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

  const totalPending = items.length;
  const totalUnits = useMemo(() => items.reduce((a, it) => a + it.qtyOrigem, 0), [items]);
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
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-violet-50/40 to-fuchsia-50/30 pb-16 relative">
      {/* Decor blob sutil — visual moderno sem poluir. */}
      <div className="no-print fixed top-40 -left-32 w-96 h-96 rounded-full bg-gradient-to-br from-violet-300/30 to-fuchsia-300/20 blur-3xl pointer-events-none" />
      <div className="no-print fixed bottom-20 -right-32 w-[28rem] h-[28rem] rounded-full bg-gradient-to-tl from-indigo-300/20 to-pink-300/20 blur-3xl pointer-events-none" />

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
            onClick={() => { loadItems(); loadSentItems(); loadOpenShipments(); }}
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
        {openShipments.length > 0 && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm font-bold text-amber-900">
              <Truck className="w-4 h-4" />
              Remessas em montagem
            </div>
            {openShipments.map((s) => {
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
                    </div>
                    <div className="flex flex-col gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => handleDownloadPdf(s.id, s.code)}
                        disabled={(s.items || []).length === 0}
                        className="bg-white hover:bg-amber-100 text-amber-900 border-2 border-amber-400 px-4 py-2 rounded-xl text-xs font-bold shadow-sm flex items-center gap-1.5 disabled:opacity-50"
                        title="Baixar romaneio em PDF"
                      >
                        <FileText className="w-4 h-4" />
                        PDF
                      </button>
                      <button
                        type="button"
                        onClick={() => handleCloseShipment(s.id, s.code)}
                        disabled={isClosing || (s.items || []).length === 0}
                        className="bg-amber-600 hover:bg-amber-700 text-white px-4 py-2.5 rounded-xl text-sm font-black shadow-md flex items-center gap-2 disabled:opacity-50"
                      >
                        {isClosing ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Send className="w-4 h-4" />
                        )}
                        Fechar e enviar
                      </button>
                    </div>
                  </div>
                  <div className="mt-2 text-[11px] text-amber-900/70 leading-snug">
                    ⚠️ Ao fechar, o estoque das peças sai do Giga desta loja e a remessa vai pra
                    loja destino conferir. Não pode reverter depois.
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
                          {g.imageUrl ? (
                            <div className="w-16 h-20 sm:w-20 sm:h-24 rounded-xl overflow-hidden shrink-0 shadow-lg ring-1 ring-slate-200 bg-slate-100 relative">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img
                                src={g.imageUrl}
                                alt={g.ref}
                                className="w-full h-full object-cover"
                                loading="lazy"
                                onError={(e) => {
                                  // Fallback silencioso: esconde img quebrada
                                  (e.currentTarget as HTMLImageElement).style.display = 'none';
                                }}
                              />
                            </div>
                          ) : (
                            <div className="w-16 h-20 sm:w-20 sm:h-24 rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-600 flex items-center justify-center shrink-0 shadow-lg shadow-fuchsia-500/20">
                              <Shirt className="w-8 h-8 text-white" />
                            </div>
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
                  <b>&quot;ENVIEI&quot;</b> · ela some desta aba e aparece na
                  aba <b>Enviados hoje</b> com o horário, pra conferência.
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
          }
          .no-print { display: none !important; }
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
  viewMode,
}: {
  item: RealignmentItem | null;
  sending: boolean;
  reverting: boolean;
  onSend: (id: string) => void;
  onRevert: (id: string) => void;
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

  // Modo CONFERÊNCIA — peça já foi enviada. Célula verde clicável pra permitir
  // REVERTER caso a vendedora tenha clicado errado em "Enviei". Volta o item
  // pra fila de pendentes. Título e ícone Undo2 deixam a affordance explícita.
  if (viewMode === 'sent') {
    const time = formatTime(item.sentAt);
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
        onClick={() => onRevert(item.id)}
        title={`Enviado às ${time || '—'} pra LJ${item.lojaDestinoCode} — toque pra REVERTER pra pendente`}
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
    <button
      type="button"
      onClick={() => onSend(item.id)}
      title={`Marcar como ENVIEI — ${item.qtyOrigem}un`}
      className={`${base} bg-amber-100 text-amber-900 border border-amber-300 hover:bg-amber-200 active:scale-95 cursor-pointer text-base`}
    >
      <span className="tabular-nums">{item.qtyOrigem}</span>
      <CheckCircle2 className="w-3 h-3 absolute top-0.5 right-0.5 text-amber-700/70" />
    </button>
  );
}
