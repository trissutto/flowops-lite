'use client';

/**
 * /retaguarda/realinhamento — Rebalanceia estoque entre lojas.
 *
 * Fluxo (3 etapas · pós-pivot #168..#172):
 *   1) CONFIG: usuário cola REFERÊNCIAS (1 por linha, ex: VMS-223), marca lojas origem
 *      (TODAS CEDEM) e destino (TODAS RECEBEM). Backend consulta Giga e expande cada REF
 *      em todas as suas variações (cor × tamanho).
 *   2) PREVIEW: POST /realignment/preview → plano completo em tabela com REF · COR · TAM
 *      + antes/depois por loja. Usuário pode editar qty ou remover linhas.
 *   3) CONFIRM: POST /realignment/confirm → cria N TransferOrder (tipo=REALINHAMENTO,
 *      realignmentStatus=pending) e o backend emite socket 'realignment:new' pra cada
 *      loja ORIGEM. O /minha-loja da filial mostra o card de alerta e a tela de
 *      separação onde eles confirmam 1 a 1.
 *
 * PDF e WhatsApp foram removidos — o alerta chega direto no app da loja.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { Loader2, Shuffle, Send, ArrowRight, AlertTriangle, CheckCircle2, Trash2, ArrowUpFromLine, ArrowDownToLine, Search, Plus, X, Sparkles, Shirt, ChevronDown, Settings } from 'lucide-react';

interface Store {
  id: string;
  code: string;
  name: string;
  city?: string | null;
  state?: string | null;
  active: boolean;
}

interface PlanLine {
  sku: string;
  ref: string | null;
  cor: string | null;
  tamanho: string | null;
  desc: string;
  fromCode: string;
  fromName: string;
  toCode: string;
  toName: string;
  qty: number;
  stockFromBefore: number;
  stockToBefore: number;
  stockFromAfter: number;
  stockToAfter: number;
}

interface PerSkuReport {
  sku: string;
  totalMoved: number;
  stillMissing: number;
  note?: string;
}

interface PerRefReport {
  ref: string;
  desc: string;
  variants: number;
  totalMoved: number;
  stillMissing: number;
}

interface PreviewResponse {
  input: {
    refs: string[];
    skus: string[];
    origins: string[];
    dests: string[];
    minPerDest: number;
    keepMinOrigin: number;
  };
  stores: Array<{ code: string; name: string; active: boolean; city?: string | null; state?: string | null }>;
  plan: PlanLine[];
  perSku: PerSkuReport[];
  perRef: PerRefReport[];
  notFoundRefs: string[];
  ambiguousRefs?: Array<{
    ref: string;
    familias: Array<{ desc: string; count: number }>;
  }>;
  totals: {
    totalMoves: number;
    totalUnits: number;
    skusWithFullCoverage: number;
    skusPartial: number;
    skusUnchanged: number;
    refsScanned: number;
    skusScanned: number;
  };
}

export default function RealinhamentoPage() {
  const [stores, setStores] = useState<Store[]>([]);
  const [refsText, setRefsText] = useState('');
  const [originCodes, setOriginCodes] = useState<Set<string>>(new Set());
  const [destCodes, setDestCodes] = useState<Set<string>>(new Set());
  // Padrão 1/1 — config mais frouxa que maximiza oportunidades de
  // realinhamento. Com 2/2 muita peça ficava parada por "já está no alvo".
  const [minPerDest, setMinPerDest] = useState(1);
  const [keepMinOrigin, setKeepMinOrigin] = useState(1);
  const [note, setNote] = useState('');

  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [editedPlan, setEditedPlan] = useState<PlanLine[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Busca por descrição (pra quando o usuário não sabe a REF exata ou a
  // mesma REF existe em produtos diferentes — ex: BL-5512 blusa + BL-5512 calça)
  const [searchTerm, setSearchTerm] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<
    Array<{ REF: string; DESCRICAOCOMPLETA: string; VARIANT_COUNT: number }>
  >([]);
  const [searchSelected, setSearchSelected] = useState<Set<string>>(new Set());
  // Mapa REF → descrição-filtro. Quando usuário seleciona REF via busca por
  // descrição, guardamos a descrição pra mandar como filtro no preview.
  // Isso evita REF com 2 famílias (ex: 9002 = Calça Mom + Pijama Masculino)
  // serem confundidas no plano final. Sem filtro, o backend detecta a
  // ambiguidade e devolve em ambiguousRefs pra escolha manual.
  const [refFilters, setRefFilters] = useState<Record<string, string>>({});
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [confirmResult, setConfirmResult] = useState<{
    createdCount: number;
    alerts: {
      emitted: number;
      total: number;
      byStore: Array<{ storeCode: string; count: number; ok: boolean; error?: string }>;
    };
  } | null>(null);
  const [confirming, setConfirming] = useState(false);

  // ── BUSCA POR DATA DE CADASTRO (pra REFs que chegaram no período) ──
  // Ex: "PLUS SIZE cadastrados em janeiro/2026 → vou realinhar essas REFs"
  const todayStr = new Date().toISOString().slice(0, 10);
  const monthAgoStr = (() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().slice(0, 10);
  })();
  const [dateFrom, setDateFrom] = useState(monthAgoStr);
  const [dateTo, setDateTo] = useState(todayStr);
  const [dateOnlyPlusSize, setDateOnlyPlusSize] = useState(true);
  const [dateLoading, setDateLoading] = useState(false);
  const [dateError, setDateError] = useState<string | null>(null);
  const [dateResults, setDateResults] = useState<
    Array<{ ref: string; descricao: string; variantCount: number; dataCadastro: string | null }>
  >([]);

  const [dateDebug, setDateDebug] = useState<any>(null);
  const [dateDebugLoading, setDateDebugLoading] = useState(false);

  // Filtro client-side ao vivo: digita "REGATA" → mostra só REFs com REGATA
  // Aceita múltiplas palavras AND: "REGATA MANIFESTO" → tem AS DUAS
  const [dateDescFilter, setDateDescFilter] = useState('');

  // ── BUSCA POR SOBRA DE ESTOQUE (REFs com SKUs >= minQty) ──────────────
  const [sobraMinQty, setSobraMinQty] = useState(2);
  const [sobraOnlyPlusSize, setSobraOnlyPlusSize] = useState(true);
  const [sobraDesc, setSobraDesc] = useState('');
  const [sobraStoreCode, setSobraStoreCode] = useState(''); // '' = todas; senao filtra 1 loja
  const [sobraLoading, setSobraLoading] = useState(false);
  const [sobraError, setSobraError] = useState<string | null>(null);
  const [sobraResults, setSobraResults] = useState<
    Array<{ ref: string; descricao: string; variantesComSobra: number; estoqueTotalSobra: number; skuExemplo: string | null }>
  >([]);
  const [sobraDescFilter, setSobraDescFilter] = useState('');
  const filteredSobraResults = useMemo(() => {
    const f = sobraDescFilter.trim().toUpperCase();
    if (!f) return sobraResults;
    const words = f.split(/\s+/).filter(Boolean);
    return sobraResults.filter((r) => {
      const desc = (r.descricao || '').toUpperCase();
      return words.every((w) => desc.includes(w));
    });
  }, [sobraResults, sobraDescFilter]);

  const handleSearchSobra = async () => {
    setSobraLoading(true);
    setSobraError(null);
    try {
      const params = new URLSearchParams({
        minQty: String(sobraMinQty),
        ...(sobraOnlyPlusSize ? { plusSize: '1' } : {}),
        ...(sobraDesc.trim() ? { desc: sobraDesc.trim() } : {}),
        ...(sobraStoreCode ? { storeCode: sobraStoreCode } : {}),
      });
      const data = await api<typeof sobraResults>(`/realignment/search-refs-com-sobra?${params}`);
      setSobraResults(Array.isArray(data) ? data : []);
    } catch (e: any) {
      setSobraError(e?.message || 'Erro buscando REFs com sobra');
    } finally {
      setSobraLoading(false);
    }
  };

  const addAllSobraRefs = () => {
    const lista = filteredSobraResults;
    if (!lista.length) return;
    const novos = lista.map((r) => r.ref);
    const atuais = new Set(refsText.split('\n').map((s) => s.trim()).filter(Boolean));
    novos.forEach((r) => atuais.add(r));
    setRefsText(Array.from(atuais).sort().join('\n'));
  };
  const filteredDateResults = useMemo(() => {
    const f = dateDescFilter.trim().toUpperCase();
    if (!f) return dateResults;
    const words = f.split(/\s+/).filter(Boolean);
    return dateResults.filter((r) => {
      const desc = (r.descricao || '').toUpperCase();
      return words.every((w) => desc.includes(w));
    });
  }, [dateResults, dateDescFilter]);

  const handleSearchByDate = async () => {
    if (!dateFrom || !dateTo) {
      setDateError('Selecione as duas datas');
      return;
    }
    setDateLoading(true);
    setDateError(null);
    setDateDebug(null);
    try {
      const params = new URLSearchParams({
        from: dateFrom,
        to: dateTo,
        ...(dateOnlyPlusSize ? { desc: 'PLUS SIZE' } : {}),
      });
      const data = await api<typeof dateResults>(`/realignment/search-refs-by-date?${params}`);
      setDateResults(Array.isArray(data) ? data : []);
    } catch (e: any) {
      setDateError(e?.message || 'Erro buscando por data');
    } finally {
      setDateLoading(false);
    }
  };

  const handleDateDebug = async () => {
    if (!dateFrom || !dateTo) return;
    setDateDebugLoading(true);
    try {
      const params = new URLSearchParams({
        from: dateFrom,
        to: dateTo,
        ...(dateOnlyPlusSize ? { desc: 'PLUS SIZE' } : {}),
      });
      const data = await api<any>(`/realignment/search-refs-by-date-debug?${params}`);
      setDateDebug(data);
    } catch (e: any) {
      alert(`Diagnóstico falhou: ${e?.message}`);
    } finally {
      setDateDebugLoading(false);
    }
  };

  const addAllDateRefs = () => {
    // Adiciona as REFs FILTRADAS ao buscador (não todas, respeita o filtro client-side)
    const lista = filteredDateResults;
    if (!lista.length) return;
    const novos = lista.map((r) => r.ref);
    const atuais = new Set(refsText.split('\n').map((s) => s.trim()).filter(Boolean));
    novos.forEach((r) => atuais.add(r));
    setRefsText(Array.from(atuais).sort().join('\n'));
  };

  // ── AUTO-REALINHAMENTO (cron diário com sugestões) ──
  type AutoConfig = { enabled: boolean; diasAtras: number; descricaoFilter: string };
  type AutoPending = {
    generatedAt: string | null;
    diasAtras: number | null;
    dataAlvo: string | null;
    refs: Array<{ ref: string; descricao: string; variantCount: number; dataCadastro: string | null }>;
  };
  const [autoOpen, setAutoOpen] = useState(false);
  const [autoConfig, setAutoConfig] = useState<AutoConfig | null>(null);
  const [autoPending, setAutoPending] = useState<AutoPending | null>(null);
  const [autoSaving, setAutoSaving] = useState(false);
  const [autoRunning, setAutoRunning] = useState(false);

  const loadAuto = async () => {
    try {
      const [cfg, pend] = await Promise.all([
        api<AutoConfig>('/realignment/auto/config'),
        api<AutoPending>('/realignment/auto/pending'),
      ]);
      setAutoConfig(cfg);
      setAutoPending(pend);
    } catch (e: any) {
      // silencioso — só admin tem acesso
    }
  };

  useEffect(() => {
    loadAuto();
  }, []);

  const saveAutoConfig = async (next: Partial<AutoConfig>) => {
    setAutoSaving(true);
    try {
      const cfg = await api<AutoConfig>('/realignment/auto/config', {
        method: 'POST',
        body: JSON.stringify(next),
      });
      setAutoConfig(cfg);
    } catch (e: any) {
      alert(`Erro: ${e?.message}`);
    } finally {
      setAutoSaving(false);
    }
  };

  const runAutoNow = async () => {
    if (!confirm('Rodar auto-realinhamento agora? (não dispara realinhamento, só gera sugestão)')) return;
    setAutoRunning(true);
    try {
      const res = await api<{ refsFound: number; dataAlvo: string }>('/realignment/auto/run-now', {
        method: 'POST',
        body: '{}',
      });
      alert(`✅ ${res.refsFound} REF(s) encontradas pra data ${res.dataAlvo}`);
      await loadAuto();
    } catch (e: any) {
      alert(`Erro: ${e?.message}`);
    } finally {
      setAutoRunning(false);
    }
  };

  const dismissAutoPending = async () => {
    if (!confirm('Descartar essa sugestão?')) return;
    try {
      await api('/realignment/auto/dismiss', { method: 'POST', body: '{}' });
      await loadAuto();
    } catch (e: any) {
      alert(`Erro: ${e?.message}`);
    }
  };

  const importAutoToBuscador = () => {
    if (!autoPending?.refs?.length) return;
    const novos = autoPending.refs.map((r) => r.ref);
    const atuais = new Set(refsText.split('\n').map((s) => s.trim()).filter(Boolean));
    novos.forEach((r) => atuais.add(r));
    setRefsText(Array.from(atuais).sort().join('\n'));
  };

  // ── CONFIG TAMANHOS PLUS SIZE ──
  const [plusSizes, setPlusSizes] = useState('');
  const [plusSizesIsDefault, setPlusSizesIsDefault] = useState(true);
  const [plusSizesOpen, setPlusSizesOpen] = useState(false);
  const [plusSizesSaving, setPlusSizesSaving] = useState(false);

  useEffect(() => {
    api<{ sizes: string; isDefault: boolean }>('/realignment/plus-size-sizes')
      .then((r) => {
        setPlusSizes(r.sizes);
        setPlusSizesIsDefault(r.isDefault);
      })
      .catch(() => {});
  }, []);

  const savePlusSizes = async () => {
    setPlusSizesSaving(true);
    try {
      const r = await api<{ sizes: string }>('/realignment/plus-size-sizes', {
        method: 'POST',
        body: JSON.stringify({ sizes: plusSizes }),
      });
      setPlusSizes(r.sizes);
      setPlusSizesIsDefault(false);
      alert('✅ Filtro de tamanhos atualizado');
    } catch (e: any) {
      alert(`Erro: ${e?.message}`);
    } finally {
      setPlusSizesSaving(false);
    }
  };

  // ── WIPE ALL (admin) ─────────────────────────────────────────────
  // Botão pra zerar TODOS realinhamentos (após período de testes).
  // Carrega preview ao abrir o modal pra usuário ver o impacto antes.
  const [wipeOpen, setWipeOpen] = useState(false);
  const [wipePreview, setWipePreview] = useState<{
    total: number;
    byStatus: Record<string, number>;
    byStore: Array<{ code: string; name: string; count: number }>;
  } | null>(null);
  const [wipeLoading, setWipeLoading] = useState(false);
  const [wipeExecuting, setWipeExecuting] = useState(false);
  const [wipeDone, setWipeDone] = useState<{ deleted: number } | null>(null);
  const [wipeConfirmText, setWipeConfirmText] = useState('');
  const [wipeError, setWipeError] = useState<string | null>(null);

  async function openWipeModal() {
    setWipeOpen(true);
    setWipeDone(null);
    setWipeConfirmText('');
    setWipeError(null);
    setWipePreview(null);
    setWipeLoading(true);
    try {
      const data = await api<typeof wipePreview>('/realignment/wipe-preview');
      setWipePreview(data);
    } catch (e: any) {
      setWipeError(e?.message || 'Erro ao carregar preview');
    } finally {
      setWipeLoading(false);
    }
  }

  async function executeWipe() {
    if (wipeConfirmText !== 'ZERAR') {
      setWipeError('Digite ZERAR (em maiúsculas) pra confirmar');
      return;
    }
    setWipeExecuting(true);
    setWipeError(null);
    try {
      const res = await api<{ ok: boolean; deleted: number }>(
        '/realignment/wipe-all?confirm=YES',
        { method: 'DELETE' },
      );
      setWipeDone({ deleted: res.deleted });
    } catch (e: any) {
      setWipeError(e?.message || 'Erro ao executar');
    } finally {
      setWipeExecuting(false);
    }
  }

  useEffect(() => {
    api<Store[]>('/stores')
      .then((arr) => {
        const sorted = [...arr].sort((a, b) => a.code.localeCompare(b.code));
        setStores(sorted);
      })
      .catch((e) => setError(`Erro carregando lojas: ${e?.message || e}`));
  }, []);

  useEffect(() => {
    setKeepMinOrigin(minPerDest);
  }, [minPerDest]);

  const activeStores = useMemo(() => stores.filter((s) => s.active), [stores]);

  function toggle(set: Set<string>, code: string, setter: (s: Set<string>) => void) {
    const next = new Set(set);
    if (next.has(code)) next.delete(code);
    else next.add(code);
    setter(next);
  }

  function selectAllOrigins() {
    setOriginCodes(new Set(activeStores.map((s) => s.code)));
  }
  function selectAllDests() {
    setDestCodes(new Set(activeStores.map((s) => s.code)));
  }
  function clearOrigins() { setOriginCodes(new Set()); }
  function clearDests() { setDestCodes(new Set()); }

  /**
   * Busca REFs no Gigasistemas por termos da descrição.
   * Backend faz AND LIKE em DESCRICAOCOMPLETA pra cada palavra, agrupa por REF.
   */
  async function handleSearchRefs() {
    const term = searchTerm.trim();
    if (term.length < 2) {
      setSearchError('Digite pelo menos 2 caracteres');
      return;
    }
    setSearchError(null);
    setSearching(true);
    setSearchSelected(new Set());
    try {
      const rows = await api<
        Array<{ REF: string; DESCRICAOCOMPLETA: string; VARIANT_COUNT: number }>
      >(`/realignment/search-refs?term=${encodeURIComponent(term)}`);
      setSearchResults(rows || []);
      setSearchOpen(true);
      if (!rows?.length) setSearchError('Nada encontrado pra esse termo.');
    } catch (e: any) {
      setSearchError(`Erro: ${e?.message || e}`);
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  }

  function toggleSearchRef(ref: string) {
    const next = new Set(searchSelected);
    if (next.has(ref)) next.delete(ref);
    else next.add(ref);
    setSearchSelected(next);
  }

  function selectAllSearchResults() {
    setSearchSelected(new Set(searchResults.map((r) => r.REF)));
  }
  function clearSearchSelection() {
    setSearchSelected(new Set());
  }

  /** Adiciona REFs selecionadas no textarea principal (sem duplicar). */
  function addSelectedRefsToInput() {
    if (!searchSelected.size) return;
    const existing = new Set(
      refsText
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean),
    );
    const toAdd = [...searchSelected].filter((r) => !existing.has(r));
    if (!toAdd.length) {
      setSearchError('Essas REFs já estavam na lista.');
      return;
    }
    // DEFAULT: NÃO amarra filtro de descrição. Adiciona a REF "pelada" — o
    // plano expande TODAS as variações da REF. Se houver ambiguidade (REF
    // repetida em produtos diferentes, ex: 9002 = PIJAMA e CALÇA), o backend
    // retorna em `ambiguousRefs` e a UI mostra botões pra escolher a família.
    // Antes amarrava DESCRICAOCOMPLETA como filtro automaticamente — bug pq
    // a descrição contém detalhes específicos de UMA variação (cor/tamanho),
    // filtrando o plano pra só essa peça.
    const next = [
      ...existing,
      ...toAdd,
    ].join('\n');
    setRefsText(next);
    setSearchError(null);
    // Limpa busca pra feedback visual
    setSearchSelected(new Set());
    setSearchOpen(false);
    setSearchResults([]);
    setSearchTerm('');
  }

  async function handlePreview() {
    setError(null);
    setPreview(null);
    setConfirmResult(null);

    const refs = refsText
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);

    if (refs.length === 0) {
      setError('Cole ao menos uma REFERÊNCIA (1 por linha).');
      return;
    }
    if (originCodes.size === 0) {
      setError('Selecione ao menos uma loja ORIGEM.');
      return;
    }
    if (destCodes.size === 0) {
      setError('Selecione ao menos uma loja DESTINO.');
      return;
    }

    setLoading(true);
    try {
      // Filtra refFilters só pras REFs que estão na lista atual
      // (evita mandar lixo de REFs antigas removidas do textarea)
      const cleanFilters: Record<string, string> = {};
      for (const ref of refs) {
        if (refFilters[ref]) cleanFilters[ref] = refFilters[ref];
      }
      const data = await api<PreviewResponse>('/realignment/preview', {
        method: 'POST',
        body: JSON.stringify({
          refs,
          originStoreCodes: Array.from(originCodes),
          destStoreCodes: Array.from(destCodes),
          minPerDest,
          keepMinOrigin,
          refFilters: Object.keys(cleanFilters).length ? cleanFilters : undefined,
        }),
      });
      setPreview(data);
      setEditedPlan(data.plan.map((p) => ({ ...p })));
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  function updateLineQty(idx: number, newQty: number) {
    setEditedPlan((prev) => {
      const next = [...prev];
      const line = next[idx];
      const maxByOrigin = line.stockFromBefore - Math.max(0, preview?.input.keepMinOrigin || 0);
      const clamped = Math.max(0, Math.min(newQty, Math.max(0, maxByOrigin)));
      next[idx] = {
        ...line,
        qty: clamped,
        stockFromAfter: line.stockFromBefore - clamped,
        stockToAfter: line.stockToBefore + clamped,
      };
      return next;
    });
  }

  function removeLine(idx: number) {
    setEditedPlan((prev) => prev.filter((_, i) => i !== idx));
  }

  async function handleConfirm() {
    setError(null);
    if (editedPlan.filter((l) => l.qty > 0).length === 0) {
      setError('Plano vazio (todas as linhas com qty=0).');
      return;
    }
    setConfirming(true);
    try {
      const res = await api<{
        createdCount: number;
        alerts: {
          emitted: number;
          total: number;
          byStore: Array<{ storeCode: string; count: number; ok: boolean; error?: string }>;
        };
      }>(
        '/realignment/confirm',
        {
          method: 'POST',
          body: JSON.stringify({
            plan: editedPlan.filter((l) => l.qty > 0).map((l) => ({
              sku: l.sku,
              ref: l.ref,
              cor: l.cor,
              tamanho: l.tamanho,
              desc: l.desc,
              fromCode: l.fromCode,
              toCode: l.toCode,
              qty: l.qty,
              stockFromBefore: l.stockFromBefore,
            })),
            note: note.trim() || undefined,
          }),
        },
      );
      setConfirmResult(res);
      setPreview(null);
      setEditedPlan([]);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setConfirming(false);
    }
  }

  const editedTotals = useMemo(() => {
    const totalUnits = editedPlan.reduce((a, l) => a + l.qty, 0);
    const totalMoves = editedPlan.filter((l) => l.qty > 0).length;
    return { totalUnits, totalMoves };
  }, [editedPlan]);

  // Agrupa plano por REF pra exibir visualmente em blocos
  const planByRef = useMemo(() => {
    const map = new Map<string, PlanLine[]>();
    for (const line of editedPlan) {
      const key = line.ref || line.sku;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(line);
    }
    return Array.from(map.entries());
  }, [editedPlan]);

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white flex items-center justify-center shadow">
          <Shuffle className="w-5 h-5" />
        </div>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-slate-900">Realinhamento de Estoque</h1>
          <p className="text-sm text-slate-500">
            Informe as referências, o sistema busca todas as variações no Gigasistemas e gera as ordens de transferência.
          </p>
        </div>
        {/* Atalhos admin */}
        <Link
          href="/retaguarda/realinhamento/nao-encontrados"
          className="flex items-center gap-1.5 text-xs text-amber-800 hover:bg-amber-50 border border-amber-300 hover:border-amber-400 rounded-lg px-3 py-2 transition font-semibold"
          title="Revisar peças não encontradas pelas lojas origem"
        >
          <AlertTriangle className="w-3.5 h-3.5" />
          Não encontradas
        </Link>
        {/* Admin: zerar realinhamentos de teste */}
        <button
          type="button"
          onClick={openWipeModal}
          className="hidden md:flex items-center gap-1.5 text-xs text-rose-700 hover:bg-rose-50 border border-rose-200 hover:border-rose-300 rounded-lg px-3 py-2 transition"
          title="Zerar todos realinhamentos (admin)"
        >
          <Trash2 className="w-3.5 h-3.5" />
          Zerar realinhamentos
        </button>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-800 rounded-lg px-4 py-3 flex items-start gap-2">
          <AlertTriangle className="w-5 h-5 mt-0.5 shrink-0" />
          <div className="text-sm">{error}</div>
        </div>
      )}

      {confirmResult && (
        <div className="bg-emerald-50 border border-emerald-200 text-emerald-900 rounded-lg px-4 py-3 flex items-start gap-2">
          <CheckCircle2 className="w-5 h-5 mt-0.5 shrink-0" />
          <div className="text-sm">
            <div className="font-semibold">
              {confirmResult.createdCount} ordens criadas · alerta enviado pra{' '}
              {confirmResult.alerts.emitted}/{confirmResult.alerts.total} loja(s) origem.
            </div>
            <div className="mt-0.5 text-xs text-emerald-800/80">
              As lojas vão receber o alerta no app <b>/minha-loja</b> em tempo real.
              Elas confirmam o envio uma a uma e você acompanha no histórico.
            </div>
            {confirmResult.alerts.byStore.some((s) => !s.ok) && (
              <ul className="list-disc ml-5 mt-1 text-xs text-red-700">
                {confirmResult.alerts.byStore
                  .filter((s) => !s.ok)
                  .map((f, i) => (
                    <li key={i}>
                      {f.storeCode}: {f.error || 'erro ao emitir alerta'}
                    </li>
                  ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {/* ETAPA 1 — Config */}
      <section className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 space-y-5">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-slate-800">1. Configuração</h2>
          <div className="text-xs text-slate-500">
            {stores.length} lojas cadastradas · {activeStores.length} ativas
          </div>
        </div>

        {/* ── BUSCA POR DATA DE CADASTRO ── */}
        <div className="border border-emerald-200 bg-emerald-50/60 rounded-lg p-3">
          <div className="flex items-center gap-2 mb-2">
            <Search className="w-4 h-4 text-emerald-700" />
            <div className="text-sm font-semibold text-emerald-900">
              Buscar REFs por data de cadastro no Giga
            </div>
          </div>
          <div className="text-xs text-emerald-900/80 mb-2">
            Puxa todas as REFs cadastradas no período (ex: PLUS SIZE chegadas em janeiro/2026 →
            realinhar todas pras filiais).
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-2 items-end">
            <div>
              <label className="block text-[11px] font-semibold text-emerald-900 mb-0.5">De</label>
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="w-full border border-emerald-300 rounded-lg px-2 py-1.5 text-sm bg-white"
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-emerald-900 mb-0.5">Até</label>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="w-full border border-emerald-300 rounded-lg px-2 py-1.5 text-sm bg-white"
              />
            </div>
            <label className="flex items-center gap-2 text-xs text-emerald-900 sm:pb-2">
              <input
                type="checkbox"
                checked={dateOnlyPlusSize}
                onChange={(e) => setDateOnlyPlusSize(e.target.checked)}
              />
              Só PLUS SIZE
            </label>
            <button
              type="button"
              onClick={handleSearchByDate}
              disabled={dateLoading}
              className="bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 text-white font-bold rounded-lg px-4 py-2 text-sm flex items-center justify-center gap-2"
            >
              {dateLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
              Buscar
            </button>
          </div>
          {dateError && (
            <div className="mt-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">
              {dateError}
            </div>
          )}
          {!dateLoading && !dateError && dateResults.length === 0 && (
            <div className="mt-3 bg-amber-50 border border-amber-300 rounded-lg p-3">
              <div className="text-xs text-amber-900 font-bold mb-1">⚠️ Nenhuma REF encontrada nesse período.</div>
              <div className="text-xs text-amber-900/80">
                Tente ampliar o intervalo de datas ou desmarcar o filtro &quot;Só PLUS SIZE&quot;.
              </div>
            </div>
          )}
          {dateResults.length > 0 && (
            <div className="mt-3 bg-white border border-emerald-200 rounded-lg overflow-hidden">
              <div className="flex items-center gap-2 px-3 py-2 bg-emerald-100/50 border-b border-emerald-200">
                <div className="text-xs font-bold text-emerald-900 shrink-0">
                  {filteredDateResults.length === dateResults.length
                    ? `${dateResults.length} REF(s)`
                    : `${filteredDateResults.length} de ${dateResults.length}`}
                </div>
                <input
                  type="text"
                  value={dateDescFilter}
                  onChange={(e) => setDateDescFilter(e.target.value)}
                  placeholder="Filtrar (ex: REGATA, MANIFESTO, BLUSA MANGA…)"
                  className="flex-1 border border-emerald-300 rounded px-2 py-1 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-emerald-400 min-w-0"
                />
                {dateDescFilter && (
                  <button
                    type="button"
                    onClick={() => setDateDescFilter('')}
                    className="text-xs px-2 py-1 text-slate-500 hover:bg-slate-100 rounded"
                    title="Limpar filtro"
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={addAllDateRefs}
                  disabled={filteredDateResults.length === 0}
                  className="text-xs bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-bold rounded px-3 py-1 flex items-center gap-1 shrink-0"
                >
                  <Plus className="w-3 h-3" />
                  Adicionar {filteredDateResults.length > 0 ? `(${filteredDateResults.length})` : ''}
                </button>
              </div>
              <div className="max-h-48 overflow-y-auto divide-y divide-emerald-100 text-xs">
                {filteredDateResults.length === 0 ? (
                  <div className="px-3 py-3 text-slate-500 italic text-center">
                    Nada bate com "{dateDescFilter}"
                  </div>
                ) : (
                  <>
                    {filteredDateResults.slice(0, 100).map((r) => (
                      <div key={r.ref} className="px-3 py-1.5 flex items-center gap-2">
                        <span className="font-mono font-bold text-emerald-900">{r.ref}</span>
                        <span className="text-slate-600 truncate flex-1">{r.descricao}</span>
                        <span className="text-slate-400">{r.variantCount}var</span>
                      </div>
                    ))}
                    {filteredDateResults.length > 100 && (
                      <div className="px-3 py-1.5 text-slate-500 italic">
                        + {filteredDateResults.length - 100} REFs adicionais (use "Adicionar")
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </div>

        {/* ── BUSCA POR SOBRA DE ESTOQUE (REFs com SKUs >= N) ── */}
        <div className="border border-sky-200 bg-sky-50/60 rounded-lg p-3">
          <div className="flex items-center gap-2 mb-2">
            <Search className="w-4 h-4 text-sky-700" />
            <div className="text-sm font-semibold text-sky-900">
              Buscar REFs com sobra de estoque (SKUs &gt;= N)
            </div>
          </div>
          <div className="text-xs text-sky-900/80 mb-2">
            Lista REFs onde alguma variação cor×tamanho tem N+ unidades. Útil pra encontrar
            sobras e redistribuir entre lojas (ex: blusas plus size com 2+ por SKU).
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-6 gap-2 items-end">
            <div>
              <label className="block text-[11px] font-semibold text-sky-900 mb-0.5">Mín. por SKU</label>
              <input
                type="number"
                min={1}
                max={50}
                value={sobraMinQty}
                onChange={(e) => setSobraMinQty(Math.max(1, parseInt(e.target.value, 10) || 2))}
                className="w-full border border-sky-300 rounded-lg px-2 py-1.5 text-sm bg-white"
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-sky-900 mb-0.5">Loja</label>
              <select
                value={sobraStoreCode}
                onChange={(e) => setSobraStoreCode(e.target.value)}
                className="w-full border border-sky-300 rounded-lg px-2 py-1.5 text-sm bg-white"
              >
                <option value="">Todas as lojas</option>
                {activeStores.map((store) => (
                  <option key={store.code} value={store.code}>
                    {store.code} — {store.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className="block text-[11px] font-semibold text-sky-900 mb-0.5">Descrição contém</label>
              <input
                type="text"
                value={sobraDesc}
                onChange={(e) => setSobraDesc(e.target.value)}
                placeholder="Ex: BLUSA MANGA CURTA"
                className="w-full border border-sky-300 rounded-lg px-2 py-1.5 text-sm bg-white"
              />
            </div>
            <label className="flex items-center gap-2 text-xs text-sky-900 sm:pb-2">
              <input
                type="checkbox"
                checked={sobraOnlyPlusSize}
                onChange={(e) => setSobraOnlyPlusSize(e.target.checked)}
              />
              Só PLUS SIZE
            </label>
            <button
              type="button"
              onClick={handleSearchSobra}
              disabled={sobraLoading}
              className="bg-sky-600 hover:bg-sky-700 disabled:bg-slate-300 text-white font-bold rounded-lg px-4 py-2 text-sm flex items-center justify-center gap-2"
            >
              {sobraLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
              Buscar
            </button>
          </div>
          {sobraError && (
            <div className="mt-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">
              {sobraError}
            </div>
          )}
          {!sobraLoading && !sobraError && sobraResults.length === 0 && (
            <div className="mt-3 bg-amber-50 border border-amber-300 rounded-lg p-3">
              <div className="text-xs text-amber-900 font-bold mb-1">
                ⚠️ Nenhuma REF encontrada com esses critérios.
              </div>
              <div className="text-xs text-amber-900/80">
                Tente diminuir a quantidade mínima, desmarcar Só PLUS SIZE ou ajustar o filtro de descrição.
              </div>
            </div>
          )}
          {sobraResults.length > 0 && (
            <div className="mt-3 bg-white border border-sky-200 rounded-lg overflow-hidden">
              <div className="flex items-center gap-2 px-3 py-2 bg-sky-100/50 border-b border-sky-200">
                <div className="text-xs font-bold text-sky-900 shrink-0">
                  {filteredSobraResults.length === sobraResults.length
                    ? `${sobraResults.length} REF(s)`
                    : `${filteredSobraResults.length} de ${sobraResults.length}`}
                </div>
                <input
                  type="text"
                  value={sobraDescFilter}
                  onChange={(e) => setSobraDescFilter(e.target.value)}
                  placeholder="Filtrar resultados…"
                  className="flex-1 border border-sky-300 rounded px-2 py-1 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-sky-400 min-w-0"
                />
                {sobraDescFilter && (
                  <button
                    type="button"
                    onClick={() => setSobraDescFilter('')}
                    className="text-xs px-2 py-1 text-slate-500 hover:bg-slate-100 rounded"
                    title="Limpar filtro"
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={addAllSobraRefs}
                  disabled={filteredSobraResults.length === 0}
                  className="text-xs bg-sky-600 hover:bg-sky-700 disabled:opacity-50 text-white font-bold rounded px-3 py-1 flex items-center gap-1 shrink-0"
                >
                  <Plus className="w-3 h-3" />
                  Adicionar {filteredSobraResults.length > 0 ? `(${filteredSobraResults.length})` : ''}
                </button>
              </div>
              <div className="max-h-64 overflow-y-auto divide-y divide-sky-100 text-xs">
                {filteredSobraResults.length === 0 ? (
                  <div className="px-3 py-3 text-slate-500 italic text-center">
                    Nada bate com esse filtro
                  </div>
                ) : (
                  <>
                    {filteredSobraResults.slice(0, 200).map((r) => (
                      <div key={r.ref} className="px-3 py-1.5 flex items-center gap-2">
                        <span className="font-mono font-bold text-sky-900">{r.ref}</span>
                        <span className="text-slate-600 truncate flex-1">{r.descricao}</span>
                        <span className="text-sky-700 font-bold tabular-nums">{r.variantesComSobra}var</span>
                        <span className="text-emerald-700 font-bold tabular-nums">{r.estoqueTotalSobra}un</span>
                      </div>
                    ))}
                    {filteredSobraResults.length > 200 && (
                      <div className="px-3 py-1.5 text-slate-500 italic">
                        + {filteredSobraResults.length - 200} REFs adicionais (use Adicionar)
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </div>

        {/* ── BARRA COMPACTA: Auto-realin (toggle) + Filtro PLUS SIZE (botão config) ── */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* Toggle Auto-realinhamento — pill compacto */}
          {autoConfig && (
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => saveAutoConfig({ enabled: !autoConfig.enabled })}
                disabled={autoSaving}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border-2 text-xs font-bold transition disabled:opacity-50 ${
                  autoConfig.enabled
                    ? 'bg-violet-600 border-violet-700 text-white hover:bg-violet-700'
                    : 'bg-white border-slate-300 text-slate-600 hover:bg-slate-50'
                }`}
                title="Auto-realinhamento (cron 06h)"
              >
                <Sparkles className="w-3.5 h-3.5" />
                Auto-realin
                <span className={`text-[9px] font-black px-1 rounded ${
                  autoConfig.enabled ? 'bg-white/25' : 'bg-slate-200 text-slate-500'
                }`}>
                  {autoConfig.enabled ? 'ON' : 'OFF'}
                </span>
              </button>
              <button
                type="button"
                onClick={() => setAutoOpen(!autoOpen)}
                className="p-1.5 rounded-lg hover:bg-violet-100 text-violet-700 border-2 border-transparent hover:border-violet-300"
                title="Configurar auto-realinhamento"
              >
                <Settings className="w-3.5 h-3.5" />
              </button>
              {autoPending?.refs && autoPending.refs.length > 0 && (
                <button
                  type="button"
                  onClick={() => setAutoOpen(true)}
                  className="inline-flex items-center gap-1 px-2 py-1.5 rounded-lg bg-rose-50 hover:bg-rose-100 border-2 border-rose-300 text-rose-800 text-xs font-bold"
                  title="REFs sugeridas pendentes"
                >
                  🔔 {autoPending.refs.length}
                </button>
              )}
            </div>
          )}

          {/* Botão quadrado config — Filtro de tamanhos PLUS SIZE */}
          <button
            type="button"
            onClick={() => setPlusSizesOpen(!plusSizesOpen)}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border-2 border-rose-300 bg-rose-50 hover:bg-rose-100 text-rose-800 text-xs font-bold transition"
            title="Filtro de tamanhos PLUS SIZE"
          >
            <Shirt className="w-3.5 h-3.5" />
            Tamanhos
            <span className="text-[9px] font-mono font-normal text-rose-700/70 hidden sm:inline">
              {plusSizes ? `(${plusSizes.split(',').length})` : '(off)'}
            </span>
          </button>
        </div>

        {/* Painel expandido do Auto-realinhamento — só quando autoOpen=true */}
        {autoConfig && autoOpen && (
          <div className="border border-violet-200 bg-violet-50/60 rounded-lg p-3">
            {autoPending?.refs && autoPending.refs.length > 0 && (
              <div className="bg-white border-2 border-violet-300 rounded-lg p-3 mb-2">
                <div className="text-xs text-violet-900 mb-1">
                  🔔 <b>{autoPending.refs.length} REF(s) sugeridas</b> — geradas{' '}
                  {autoPending.generatedAt ? new Date(autoPending.generatedAt).toLocaleString('pt-BR') : ''}{' '}
                  (cadastradas em {autoPending.dataAlvo}, há {autoPending.diasAtras} dias)
                </div>
                <div className="flex gap-2 mt-2">
                  <button
                    type="button"
                    onClick={importAutoToBuscador}
                    className="text-xs bg-violet-600 hover:bg-violet-700 text-white font-bold rounded px-3 py-1.5 flex items-center gap-1"
                  >
                    <Plus className="w-3 h-3" />
                    Importar p/ buscador
                  </button>
                  <button
                    type="button"
                    onClick={dismissAutoPending}
                    className="text-xs border border-slate-300 hover:bg-slate-50 rounded px-3 py-1.5"
                  >
                    Descartar
                  </button>
                </div>
              </div>
            )}
            <div className="text-xs text-violet-900/70 mb-2">
              {autoConfig.enabled
                ? `Ativo. Procura REFs cadastradas há ${autoConfig.diasAtras} dias com "${autoConfig.descricaoFilter}". Próxima execução: amanhã 06h.`
                : 'Desativado. Ative pra receber sugestões diárias automáticas.'}
            </div>
            {autoOpen && (
              <div className="bg-white border border-violet-200 rounded-lg p-3 space-y-2">
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={autoConfig.enabled}
                    disabled={autoSaving}
                    onChange={(e) => saveAutoConfig({ enabled: e.target.checked })}
                  />
                  Ativar cron diário (06h)
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-700 mb-0.5">
                      Dias atrás
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={365}
                      value={autoConfig.diasAtras}
                      disabled={autoSaving}
                      onChange={(e) => setAutoConfig({ ...autoConfig, diasAtras: Number(e.target.value) })}
                      onBlur={() => saveAutoConfig({ diasAtras: autoConfig.diasAtras })}
                      className="w-full border border-slate-300 rounded-lg px-2 py-1.5 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-700 mb-0.5">
                      Filtro descrição
                    </label>
                    <input
                      type="text"
                      value={autoConfig.descricaoFilter}
                      disabled={autoSaving}
                      onChange={(e) => setAutoConfig({ ...autoConfig, descricaoFilter: e.target.value })}
                      onBlur={() => saveAutoConfig({ descricaoFilter: autoConfig.descricaoFilter })}
                      placeholder="PLUS SIZE"
                      className="w-full border border-slate-300 rounded-lg px-2 py-1.5 text-sm"
                    />
                  </div>
                </div>
                <button
                  type="button"
                  onClick={runAutoNow}
                  disabled={autoRunning}
                  className="text-xs bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white font-bold rounded px-3 py-1.5 flex items-center gap-1"
                >
                  {autoRunning ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                  Rodar agora (testar)
                </button>
              </div>
            )}
          </div>
        )}

        {/* Painel expandido — Filtro de tamanhos PLUS SIZE (só quando aberto) */}
        {plusSizesOpen && (
          <div className="border border-rose-200 bg-rose-50/60 rounded-lg p-3 space-y-2">
            <div className="flex items-center gap-2">
              <Shirt className="w-4 h-4 text-rose-700" />
              <span className="text-sm font-semibold text-rose-900 flex-1">
                Filtro de tamanhos PLUS SIZE
                {plusSizesIsDefault && (
                  <span className="ml-2 text-[10px] bg-rose-200 text-rose-900 px-2 py-0.5 rounded font-bold">
                    DEFAULT
                  </span>
                )}
              </span>
              <button
                type="button"
                onClick={() => setPlusSizesOpen(false)}
                className="text-rose-600 hover:bg-rose-100 rounded p-1"
                title="Fechar"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="text-xs text-rose-900/80">
              Variações com tamanho fora dessa lista são <b>ignoradas</b> em todo realinhamento. Vazio = sem filtro.
            </div>
            <textarea
              value={plusSizes}
              onChange={(e) => setPlusSizes(e.target.value)}
              placeholder="46,48,50,52,54,56,58,60,46/48,48/50,50/52,52/54,54/56,56/58,58/60"
              disabled={plusSizesSaving}
              className="w-full border border-rose-300 rounded-lg px-3 py-2 text-sm font-mono bg-white min-h-[60px] focus:outline-none focus:ring-2 focus:ring-rose-400"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setPlusSizes('46,48,50,52,54,56,58,60,46/48,48/50,50/52,52/54,54/56,56/58,58/60');
                }}
                className="text-xs px-3 py-1.5 border border-slate-300 rounded hover:bg-slate-50"
              >
                Restaurar default
              </button>
              <button
                type="button"
                onClick={savePlusSizes}
                disabled={plusSizesSaving}
                className="text-xs px-3 py-1.5 bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white font-bold rounded flex items-center gap-1"
              >
                {plusSizesSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />}
                Salvar
              </button>
            </div>
          </div>
        )}

        {/* Refs */}
        <div>
          <label className="block text-sm font-semibold text-slate-700 mb-1">
            Referências do Gigasistemas (1 por linha)
          </label>
          <textarea
            className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-400 min-h-[140px]"
            placeholder={`Ex:\nVMS-223\nVMS-224\nBL-5512`}
            value={refsText}
            onChange={(e) => setRefsText(e.target.value)}
          />
          <div className="text-xs text-slate-500 mt-1">
            {refsText.split('\n').filter((s) => s.trim()).length} referência(s). O sistema expande automaticamente em todas as cores e tamanhos.
          </div>

          {/* Busca por descrição — útil quando a mesma REF se repete em produtos diferentes */}
          <div className="mt-3 border border-indigo-200 bg-indigo-50/60 rounded-lg p-3">
            <div className="flex items-center gap-2 mb-2">
              <Search className="w-4 h-4 text-indigo-700" />
              <div className="text-sm font-semibold text-indigo-900">
                Não sabe a REF? Busque pela descrição
              </div>
            </div>
            <div className="text-xs text-indigo-900/70 mb-2">
              Digite palavras da descrição (ex: <i>blusa azul 48</i>, <i>vestido boho</i>) — o sistema lista as REFs correspondentes pra você marcar.
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                className="flex-1 border border-indigo-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-white"
                placeholder="Ex: blusa manga longa preta"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleSearchRefs(); } }}
              />
              <button
                type="button"
                onClick={handleSearchRefs}
                disabled={searching || searchTerm.trim().length < 2}
                className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white font-bold rounded-lg px-4 py-2 text-sm transition-all"
              >
                {searching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                Buscar
              </button>
            </div>
            {searchError && (
              <div className="mt-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">
                {searchError}
              </div>
            )}

            {searchOpen && searchResults.length > 0 && (
              <div className="mt-3 bg-white border border-indigo-200 rounded-lg">
                <div className="flex items-center justify-between px-3 py-2 border-b border-slate-200 bg-slate-50 rounded-t-lg">
                  <div className="text-xs font-semibold text-slate-700">
                    {searchResults.length} REF(s) encontrada(s) ·{' '}
                    <span className="text-indigo-700">{searchSelected.size} selecionada(s)</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={selectAllSearchResults}
                      className="text-xs text-indigo-700 hover:underline"
                    >
                      Marcar tudo
                    </button>
                    <span className="text-slate-300">·</span>
                    <button
                      type="button"
                      onClick={clearSearchSelection}
                      className="text-xs text-slate-500 hover:underline"
                    >
                      Limpar
                    </button>
                    <span className="text-slate-300">·</span>
                    <button
                      type="button"
                      onClick={() => { setSearchOpen(false); setSearchResults([]); setSearchSelected(new Set()); }}
                      className="text-slate-400 hover:text-slate-700"
                      title="Fechar"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                </div>
                <div className="max-h-[340px] overflow-y-auto divide-y divide-slate-100">
                  {searchResults.map((r) => {
                    const checked = searchSelected.has(r.REF);
                    return (
                      <label
                        key={r.REF}
                        className={`flex items-start gap-3 px-3 py-2 cursor-pointer transition-colors ${
                          checked ? 'bg-indigo-50/70' : 'hover:bg-slate-50'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleSearchRef(r.REF)}
                          className="mt-0.5 w-4 h-4 accent-indigo-600"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-xs font-bold text-indigo-800 bg-indigo-100 rounded px-1.5 py-0.5">
                              {r.REF}
                            </span>
                            <span className="text-xs text-slate-500">
                              {r.VARIANT_COUNT} variação(ões)
                            </span>
                          </div>
                          <div className="text-sm text-slate-700 truncate mt-0.5">
                            {r.DESCRICAOCOMPLETA}
                          </div>
                        </div>
                      </label>
                    );
                  })}
                </div>
                <div className="flex items-center justify-between px-3 py-2 border-t border-slate-200 bg-slate-50 rounded-b-lg">
                  <div className="text-xs text-slate-500">
                    Marque as REFs corretas (útil quando a mesma REF se repete em produtos diferentes).
                  </div>
                  <button
                    type="button"
                    onClick={addSelectedRefsToInput}
                    disabled={!searchSelected.size}
                    className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white font-bold rounded-lg px-3 py-2 text-xs transition-all"
                  >
                    <Plus className="w-4 h-4" />
                    Adicionar selecionadas
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Ações em massa */}
        <div className="grid sm:grid-cols-2 gap-3">
          <button
            onClick={selectAllOrigins}
            className="group flex items-center justify-center gap-2 bg-indigo-50 hover:bg-indigo-600 hover:text-white border-2 border-indigo-200 hover:border-indigo-700 text-indigo-800 font-bold rounded-xl px-4 py-3 transition-all"
          >
            <ArrowUpFromLine className="w-5 h-5" />
            TODAS CEDEM
            <span className="ml-1 text-xs font-normal opacity-75">
              (marca {activeStores.length} como origem)
            </span>
          </button>
          <button
            onClick={selectAllDests}
            className="group flex items-center justify-center gap-2 bg-emerald-50 hover:bg-emerald-600 hover:text-white border-2 border-emerald-200 hover:border-emerald-700 text-emerald-800 font-bold rounded-xl px-4 py-3 transition-all"
          >
            <ArrowDownToLine className="w-5 h-5" />
            TODAS RECEBEM
            <span className="ml-1 text-xs font-normal opacity-75">
              (marca {activeStores.length} como destino)
            </span>
          </button>
        </div>

        {/* Lojas — pills ON/OFF */}
        <div className="grid md:grid-cols-2 gap-5">
          {/* ORIGEM */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm font-semibold text-slate-700">
                Lojas ORIGEM <span className="text-slate-400 font-normal">({originCodes.size}/{activeStores.length})</span>
              </div>
              <button
                onClick={clearOrigins}
                className="text-xs text-slate-500 hover:text-slate-800 hover:underline"
              >
                Limpar
              </button>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-2 gap-1.5 border border-slate-200 rounded-lg p-2 max-h-[320px] overflow-y-auto bg-slate-50/40">
              {activeStores.map((s) => {
                const on = originCodes.has(s.code);
                return (
                  <button
                    key={'o' + s.code}
                    type="button"
                    onClick={() => toggle(originCodes, s.code, setOriginCodes)}
                    className={`relative flex items-center gap-2 px-2.5 py-2 rounded-lg text-sm text-left font-medium border transition-all ${
                      on
                        ? 'bg-indigo-600 border-indigo-700 text-white shadow-sm'
                        : 'bg-white border-slate-200 text-slate-700 hover:border-indigo-400 hover:bg-indigo-50'
                    }`}
                  >
                    <span className={`font-mono text-xs w-7 shrink-0 ${on ? 'text-indigo-100' : 'text-slate-400'}`}>
                      {s.code}
                    </span>
                    <span className="truncate">{s.name}</span>
                    {on && <span className="ml-auto text-xs font-bold opacity-90">ON</span>}
                  </button>
                );
              })}
            </div>
          </div>

          {/* DESTINO */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm font-semibold text-slate-700">
                Lojas DESTINO <span className="text-slate-400 font-normal">({destCodes.size}/{activeStores.length})</span>
              </div>
              <button
                onClick={clearDests}
                className="text-xs text-slate-500 hover:text-slate-800 hover:underline"
              >
                Limpar
              </button>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-2 gap-1.5 border border-slate-200 rounded-lg p-2 max-h-[320px] overflow-y-auto bg-slate-50/40">
              {activeStores.map((s) => {
                const on = destCodes.has(s.code);
                return (
                  <button
                    key={'d' + s.code}
                    type="button"
                    onClick={() => toggle(destCodes, s.code, setDestCodes)}
                    className={`relative flex items-center gap-2 px-2.5 py-2 rounded-lg text-sm text-left font-medium border transition-all ${
                      on
                        ? 'bg-emerald-600 border-emerald-700 text-white shadow-sm'
                        : 'bg-white border-slate-200 text-slate-700 hover:border-emerald-400 hover:bg-emerald-50'
                    }`}
                  >
                    <span className={`font-mono text-xs w-7 shrink-0 ${on ? 'text-emerald-100' : 'text-slate-400'}`}>
                      {s.code}
                    </span>
                    <span className="truncate">{s.name}</span>
                    {on && <span className="ml-auto text-xs font-bold opacity-90">ON</span>}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="grid md:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-bold text-slate-800 mb-1 uppercase tracking-wide">
              Quantas peças nas lojas destino
            </label>
            <input
              type="number"
              min={0}
              value={minPerDest}
              onChange={(e) => setMinPerDest(Math.max(0, Number(e.target.value) || 0))}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-bold tabular-nums"
            />
            <div className="text-xs text-slate-500 mt-1">Cada destino precisa ter ≥ este valor por variação.</div>
          </div>
          <div>
            <label className="block text-sm font-bold text-slate-800 mb-1 uppercase tracking-wide">
              Quantas peças nas lojas origem
            </label>
            <input
              type="number"
              min={0}
              value={keepMinOrigin}
              onChange={(e) => setKeepMinOrigin(Math.max(0, Number(e.target.value) || 0))}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-bold tabular-nums"
            />
            <div className="text-xs text-slate-500 mt-1">Origem nunca fica abaixo deste nº.</div>
          </div>
          <div className="flex items-end">
            <button
              onClick={handlePreview}
              disabled={loading}
              className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 text-white font-semibold rounded-lg px-4 py-2.5 flex items-center justify-center gap-2 transition"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
              {loading ? 'Calculando...' : 'Calcular plano'}
            </button>
          </div>
        </div>
      </section>

      {/* ETAPA 2 — Preview */}
      {preview && (
        <section className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <h2 className="text-lg font-bold text-slate-800">2. Plano sugerido</h2>
            <div className="flex flex-wrap gap-3 text-xs">
              <span className="bg-indigo-50 text-indigo-800 px-2.5 py-1 rounded-full font-semibold">
                {editedTotals.totalMoves} movimentações
              </span>
              <span className="bg-indigo-50 text-indigo-800 px-2.5 py-1 rounded-full font-semibold">
                {editedTotals.totalUnits} unidades
              </span>
              <span className="bg-slate-100 text-slate-700 px-2.5 py-1 rounded-full">
                {preview.totals.refsScanned} REF(s) · {preview.totals.skusScanned} variações
              </span>
              {preview.notFoundRefs.length > 0 && (
                <span className="bg-amber-50 text-amber-800 px-2.5 py-1 rounded-full">
                  {preview.notFoundRefs.length} REF(s) não encontrada(s)
                </span>
              )}
            </div>
          </div>

          {preview.ambiguousRefs && preview.ambiguousRefs.length > 0 && (
            <div className="bg-amber-100 border-2 border-amber-400 text-amber-950 rounded-lg px-4 py-3 mb-3">
              <div className="font-bold text-sm mb-2 flex items-center gap-2">
                ⚠️ {preview.ambiguousRefs.length} REF(s) ambíguas — escolhe qual produto entra no plano
              </div>
              <div className="text-xs mb-3">
                Essa(s) REF(s) têm mais de 1 produto cadastrado no Giga (ex: mesma REF
                pra PIJAMA e VESTIDO). Clica no botão da família que você quer mover.
              </div>
              <div className="space-y-2">
                {preview.ambiguousRefs.map((a) => (
                  <div key={a.ref} className="bg-white rounded p-3 border border-amber-300">
                    <div className="font-mono font-bold text-amber-900 text-sm mb-2">REF: {a.ref}</div>
                    <div className="flex flex-col gap-1.5">
                      {a.familias.map((f, i) => {
                        // Extrai 1ª palavra significativa (>=4 chars) pra usar
                        // como filtro mínimo. Ex: "PIJAMA FEMININO..." → "pijama"
                        const palavraChave = (f.desc || '')
                          .split(/\s+/)
                          .find((w) => w.length >= 4) || f.desc;
                        const isSelected = (refFilters[a.ref] || '').toLowerCase().includes(palavraChave.toLowerCase());
                        return (
                          <button
                            key={i}
                            type="button"
                            onClick={() => {
                              // Aplica filtro APENAS com a palavra-chave da família
                              // escolhida (não a descrição completa, que filtraria
                              // demais). Depois re-roda o plano automaticamente.
                              setRefFilters((prev) => ({ ...prev, [a.ref]: palavraChave }));
                              setTimeout(() => handlePreview(), 50);
                            }}
                            className={`text-left rounded border px-3 py-2 text-xs transition ${
                              isSelected
                                ? 'bg-emerald-500 text-white border-emerald-600 font-bold'
                                : 'bg-amber-50 text-slate-800 border-amber-300 hover:bg-amber-200'
                            }`}
                          >
                            <div className="flex items-start gap-2">
                              <span className={isSelected ? 'text-white' : 'text-amber-700'}>
                                {isSelected ? '✓' : '○'}
                              </span>
                              <span className="flex-1">{f.desc}</span>
                              <span className={isSelected ? 'text-emerald-100' : 'text-slate-500'}>
                                ({f.count} var)
                              </span>
                            </div>
                          </button>
                        );
                      })}
                      {refFilters[a.ref] && (
                        <button
                          type="button"
                          onClick={() => {
                            setRefFilters((prev) => {
                              const next = { ...prev };
                              delete next[a.ref];
                              return next;
                            });
                            setTimeout(() => handlePreview(), 50);
                          }}
                          className="text-[10px] text-slate-500 hover:text-slate-800 underline mt-1 self-start"
                        >
                          Limpar escolha
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {preview.notFoundRefs.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 text-amber-900 rounded-lg px-3 py-2 text-xs">
              <b>Não encontradas no Giga:</b> {preview.notFoundRefs.join(', ')}
            </div>
          )}

          {/* Resumo por REF */}
          {preview.perRef.length > 0 && (
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {preview.perRef.map((r, i) => {
                const statusColor =
                  r.totalMoved === 0
                    ? 'bg-slate-100 text-slate-600 border-slate-200'
                    : r.stillMissing > 0
                    ? 'bg-amber-50 text-amber-900 border-amber-200'
                    : 'bg-emerald-50 text-emerald-900 border-emerald-200';
                return (
                  <div key={i} className={`border rounded-lg px-3 py-2 text-xs ${statusColor}`}>
                    <div className="font-mono font-bold text-sm">{r.ref}</div>
                    {r.desc && <div className="truncate">{r.desc}</div>}
                    <div className="mt-1 flex gap-2 tabular-nums">
                      <span>{r.variants} variação(ões)</span>
                      <span>·</span>
                      <span>movidas: {r.totalMoved}</span>
                      {r.stillMissing > 0 && <span>· faltam: {r.stillMissing}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {editedPlan.length === 0 ? (
            <div className="bg-slate-50 border border-slate-200 rounded-lg p-6 text-center text-sm text-slate-600">
              Nenhuma movimentação necessária para as REFs/lojas selecionadas.
            </div>
          ) : (
            <div className="space-y-4">
              {planByRef.map(([refKey, lines]) => {
                const desc = lines[0]?.desc || '';
                const totalQty = lines.reduce((a, l) => a + l.qty, 0);
                return (
                  <div key={refKey} className="border border-slate-200 rounded-lg overflow-hidden">
                    <div className="bg-slate-50 px-3 py-2 flex items-center justify-between">
                      <div>
                        <span className="font-mono font-bold text-sm text-slate-800">{refKey}</span>
                        {desc && <span className="ml-2 text-xs text-slate-500">{desc}</span>}
                      </div>
                      <span className="text-xs bg-white border border-slate-200 rounded-full px-2 py-0.5 font-semibold text-slate-700">
                        {lines.length} linha(s) · {totalQty}un
                      </span>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-left text-xs text-slate-500 bg-white border-b border-slate-100">
                            <th className="px-2 py-1.5">Cor</th>
                            <th className="px-2 py-1.5">Tam</th>
                            <th className="px-2 py-1.5">Origem</th>
                            <th className="px-2 py-1.5 text-center">Estoque</th>
                            <th className="px-2 py-1.5 text-center">Qty</th>
                            <th className="px-2 py-1.5">Destino</th>
                            <th className="px-2 py-1.5 text-center">Estoque dest</th>
                            <th className="px-2 py-1.5"></th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {lines.map((line) => {
                            const idx = editedPlan.indexOf(line);
                            return (
                              <tr key={idx} className="hover:bg-slate-50 transition">
                                <td className="px-2 py-1.5 text-xs font-semibold text-slate-700">{line.cor || '—'}</td>
                                <td className="px-2 py-1.5 text-xs font-semibold text-slate-700">{line.tamanho || '—'}</td>
                                <td className="px-2 py-1.5">
                                  <span className="font-semibold">{line.fromCode}</span>
                                  <span className="text-xs text-slate-500 ml-1 hidden sm:inline">{line.fromName}</span>
                                </td>
                                <td className="px-2 py-1.5 text-center tabular-nums">
                                  <span className="text-slate-500">{line.stockFromBefore}</span>
                                  <ArrowRight className="inline w-3 h-3 mx-1 text-slate-400" />
                                  <span className={`font-semibold ${line.stockFromAfter < (preview.input.keepMinOrigin || 0) ? 'text-red-600' : 'text-slate-800'}`}>
                                    {line.stockFromAfter}
                                  </span>
                                </td>
                                <td className="px-2 py-1.5 text-center">
                                  <input
                                    type="number"
                                    min={0}
                                    max={line.stockFromBefore - (preview.input.keepMinOrigin || 0)}
                                    value={line.qty}
                                    onChange={(e) => updateLineQty(idx, Number(e.target.value) || 0)}
                                    className="w-14 border border-slate-300 rounded px-2 py-0.5 text-center font-bold text-indigo-700"
                                  />
                                </td>
                                <td className="px-2 py-1.5">
                                  <span className="font-semibold">{line.toCode}</span>
                                  <span className="text-xs text-slate-500 ml-1 hidden sm:inline">{line.toName}</span>
                                </td>
                                <td className="px-2 py-1.5 text-center tabular-nums">
                                  <span className="text-slate-500">{line.stockToBefore}</span>
                                  <ArrowRight className="inline w-3 h-3 mx-1 text-slate-400" />
                                  <span className="font-semibold text-emerald-700">{line.stockToAfter}</span>
                                </td>
                                <td className="px-2 py-1.5 text-right">
                                  <button
                                    onClick={() => removeLine(idx)}
                                    className="p-1 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded"
                                    title="Remover"
                                  >
                                    <Trash2 className="w-4 h-4" />
                                  </button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* ETAPA 3 — Confirm (direto, sem PDF/WhatsApp) */}
      {preview && editedPlan.length > 0 && (
        <section className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 space-y-4">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-lg bg-emerald-500 text-white flex items-center justify-center shrink-0 shadow">
              <Send className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-800">3. Despachar pras lojas</h2>
              <p className="text-sm text-slate-500">
                Cada loja ORIGEM recebe um alerta em tempo real no app <b>/minha-loja</b>.
                Ela abre a tela de separação e marca cada peça como enviada. Você acompanha no histórico.
              </p>
            </div>
          </div>

          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-1">
              Observação (opcional)
            </label>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Ex: pro lançamento do sábado"
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
            />
          </div>

          <button
            onClick={handleConfirm}
            disabled={confirming || editedTotals.totalMoves === 0}
            className="w-full sm:w-auto bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 text-white font-semibold rounded-lg px-5 py-2.5 flex items-center justify-center gap-2 transition"
          >
            {confirming ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            {confirming
              ? 'Enviando pras lojas...'
              : `Enviar ${editedTotals.totalMoves} ordem(ns) pras lojas`}
          </button>
        </section>
      )}

      {/* Modal: Zerar realinhamentos (admin) */}
      {wipeOpen && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-2xl max-w-md w-full p-6 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2">
                <div className="w-9 h-9 rounded-lg bg-rose-100 flex items-center justify-center">
                  <Trash2 className="w-4 h-4 text-rose-700" />
                </div>
                <h3 className="text-lg font-bold text-slate-900">Zerar realinhamentos</h3>
              </div>
              <button
                type="button"
                onClick={() => !wipeExecuting && setWipeOpen(false)}
                className="text-slate-400 hover:text-slate-600 disabled:opacity-30"
                disabled={wipeExecuting}
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {wipeDone ? (
              <div className="bg-emerald-50 border border-emerald-200 text-emerald-900 rounded-lg px-4 py-3 text-sm">
                <div className="flex items-center gap-2 font-semibold mb-1">
                  <CheckCircle2 className="w-4 h-4" />
                  {wipeDone.deleted} ordens deletadas
                </div>
                <div className="text-xs text-emerald-800/80">
                  Banco limpo. A partir de agora os realinhamentos criados serão os de uso real.
                </div>
              </div>
            ) : wipeLoading ? (
              <div className="flex items-center gap-2 text-sm text-slate-500 py-6 justify-center">
                <Loader2 className="w-4 h-4 animate-spin" /> Carregando preview…
              </div>
            ) : wipePreview ? (
              <>
                <div className="text-sm text-slate-700">
                  Vai deletar <b className="text-rose-700">{wipePreview.total}</b> ordem(ns) de realinhamento de <b>todas as lojas</b>.
                  Pedidos de <b>reposição</b> e <b>venda certa</b> NÃO serão afetados.
                </div>
                {wipePreview.total > 0 && (
                  <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs space-y-1">
                    <div className="font-semibold text-slate-700">Por status:</div>
                    {Object.entries(wipePreview.byStatus)
                      .filter(([, n]) => n > 0)
                      .map(([k, n]) => (
                        <div key={k} className="flex justify-between text-slate-600">
                          <span>{k === 'null' ? 'sem status' : k}</span>
                          <span className="font-mono">{n}</span>
                        </div>
                      ))}
                    {wipePreview.byStore.length > 0 && (
                      <>
                        <div className="font-semibold text-slate-700 mt-2">Por loja origem:</div>
                        {wipePreview.byStore.map((s) => (
                          <div key={s.code} className="flex justify-between text-slate-600">
                            <span>{s.code} — {s.name}</span>
                            <span className="font-mono">{s.count}</span>
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                )}
                {wipePreview.total === 0 ? (
                  <div className="text-sm text-slate-500">Nada pra deletar — banco já está vazio.</div>
                ) : (
                  <>
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">
                        Pra confirmar, digite <span className="font-mono text-rose-700">ZERAR</span>:
                      </label>
                      <input
                        type="text"
                        value={wipeConfirmText}
                        onChange={(e) => setWipeConfirmText(e.target.value)}
                        placeholder="ZERAR"
                        className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-rose-400"
                        disabled={wipeExecuting}
                      />
                    </div>
                  </>
                )}
                {wipeError && (
                  <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded px-3 py-2">
                    {wipeError}
                  </div>
                )}
                <div className="flex justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setWipeOpen(false)}
                    disabled={wipeExecuting}
                    className="px-4 py-2 text-sm rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  >
                    Cancelar
                  </button>
                  {wipePreview.total > 0 && (
                    <button
                      type="button"
                      onClick={executeWipe}
                      disabled={wipeExecuting || wipeConfirmText !== 'ZERAR'}
                      className="px-4 py-2 text-sm rounded-lg bg-rose-600 hover:bg-rose-700 text-white font-bold flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {wipeExecuting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                      {wipeExecuting ? 'Deletando…' : `Deletar ${wipePreview.total}`}
                    </button>
                  )}
                </div>
              </>
            ) : (
              <div className="text-sm text-rose-700">{wipeError || 'Erro ao carregar.'}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
