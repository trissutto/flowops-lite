'use client';

/**
 * /minha-loja/pdv/devolucao
 *
 * Fluxo:
 *  1. Bipa/digita ID ou nº NFC-e do cupom original
 *  2. Vê itens da venda + quantidade já devolvida
 *  3. Marca peças e quantidade a devolver
 *  4. Escolhe modo: Dinheiro / Troca / Vale-troca
 *  5. Confirma
 *
 * Após confirmar, mostra:
 *  - Modo dinheiro: aviso "sangria automática registrada"
 *  - Modo troca/credito: código TROCA-XXXXX (cliente leva o vale)
 */

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { ArrowLeft, Search, Check, X, Banknote, ArrowRightLeft, CreditCard } from 'lucide-react';
import { api } from '@/lib/api';

type Item = {
  id: string;
  sku: string;
  ref?: string;
  cor?: string;
  tamanho?: string;
  descricao: string;
  qty: number;
  precoUnit: number;
  total: number;
  jaDevolvido: number;
  disponivel: number;
};

type Sale = {
  id: string;
  storeCode: string;
  storeName: string;
  customerName?: string;
  customerCpf?: string;
  total: number;
  finalizedAt: string;
  nfceNumber?: string;
};

type LookupResult = {
  sale: Sale;
  items: Item[];
  previousReturns: number;
};

const fmt = (n: number) =>
  n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function DevolucaoPage() {
  const [query, setQuery] = useState('');
  const [data, setData] = useState<LookupResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [selected, setSelected] = useState<Record<string, number>>({});
  // Role do user logado — decide se aparece o toggle "outras lojas"
  // (modo A2: vendedora SÓ vê vendas da loja dela; admin pode quebrar regra)
  const [userRole, setUserRole] = useState<string>('store');
  // Toggle de override admin — só aparece se userRole === 'admin'/'operator'
  const [crossStore, setCrossStore] = useState(false);
  // Modo default = TROCA (caso mais comum: cliente leva outra peça no
  // mesmo dia). Vendedora pode trocar pra Dinheiro/Crédito se precisar.
  const [modo, setModo] = useState<'dinheiro' | 'pix' | 'troca' | 'credito'>('troca');
  const [motivo, setMotivo] = useState('');
  const [validade, setValidade] = useState(90);
  const [success, setSuccess] = useState<any>(null);
  // Indica que a vendedora veio do PDV com uma venda em andamento (F4 ou
  // botão Trocar). O crédito da troca será ANEXADO nessa venda, sem
  // reiniciar o carrinho. Mostra banner pra confirmar visualmente.
  const [attachInfo, setAttachInfo] = useState<{ id: string; items: number } | null>(null);
  // DEVOLUÇÃO MANUAL (Giga) — quando não achou venda flowops mas peça
  // foi vendida na loja em algum momento (caixa antigo).
  const [manualEligible, setManualEligible] = useState<{
    produto: { codigo: string; descricao: string; cor: string | null; tamanho: string | null; preco: number };
    vendas: Array<{ data: string; numero: string; valor: number; quantidade: number }>;
    salesCount: number;
    diasJanela: number;
  } | null>(null);
  const [manualBlocked, setManualBlocked] = useState<string | null>(null);
  const [manualBusy, setManualBusy] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    // Carrega role do user logado pra decidir se mostra toggle cross-loja
    api<{ role?: string }>('/auth/me')
      .then((me) => setUserRole(me?.role || 'store'))
      .catch(() => {});
    // Lê info do attach (venda em andamento) só pra display.
    try {
      const raw = localStorage.getItem('lurds_pdv_attach_to_sale_id');
      if (raw && raw.startsWith('{')) {
        const p = JSON.parse(raw);
        const ageMs = Date.now() - (p.ts || 0);
        if (ageMs < 30 * 60 * 1000 && p.id) {
          setAttachInfo({ id: String(p.id), items: Number(p.items) || 0 });
        }
      }
    } catch {}
  }, []);

  // Lista de vendas encontradas pela busca por SKU (peça que voltou)
  const [salesBySku, setSalesBySku] = useState<Array<{
    saleId: string;
    nfceNumber?: string;
    storeName?: string;
    customerName?: string;
    customerCpf?: string;
    finalizedAt: string;
    totalVenda: number;
    sellerName?: string;
    matchedItems: Item[];
    totalmenteDevolvido: boolean;
  }> | null>(null);

  // Feedback visual da ultima bipa (peca recem-incrementada)
  const [lastScanFeedback, setLastScanFeedback] = useState<string | null>(null);

  async function lookup() {
    setErr('');
    const q = query.trim();
    if (!q) return;

    // ── MODO "JA TENHO VENDA CARREGADA" ──
    // Se ja escolheu uma venda (data tem items), CADA bipada de SKU/REF dessa
    // venda INCREMENTA a qty selecionada daquele item — em vez de fazer nova busca.
    // Cliente devolveu 3 pecas? Vendedora bipa 3 vezes, cada bipa soma 1.
    if (data && data.items.length > 0) {
      const norm = q.toUpperCase().trim();
      const match = data.items.find(
        (it) => it.sku.toUpperCase() === norm
              || (it.ref && it.ref.toUpperCase() === norm),
      );
      if (match) {
        const atual = selected[match.id] || 0;
        const novaQty = atual + 1;
        if (novaQty > match.disponivel) {
          setErr(`Maximo ${match.disponivel} pecas dessa REF ja foi atingido`);
          setQuery('');
          return;
        }
        setSelected((prev) => ({ ...prev, [match.id]: novaQty }));
        setLastScanFeedback(`✓ ${match.ref || match.sku} ${match.cor || ''} ${match.tamanho || ''} — ${novaQty}/${match.disponivel}`);
        setQuery('');
        inputRef.current?.focus();
        // Limpa feedback apos 3s
        setTimeout(() => setLastScanFeedback(null), 3000);
        return;
      }
      // Peca NAO esta nessa venda — avisa mas nao reseta
      setErr(`SKU/REF "${q}" nao esta nessa venda. Bipe pecas dessa venda OU clique em "Nova busca".`);
      setQuery('');
      return;
    }

    // ── MODO BUSCA NORMAL — primeira bipa ou apos reset ──
    setData(null);
    setSelected({});
    setSuccess(null);
    setSalesBySku(null);
    setManualEligible(null);
    setManualBlocked(null);
    setBusy(true);
    try {
      // ESTRATÉGIA: sempre tenta SKU/REF primeiro (caso 95% — vendedora bipa
      // a peça que voltou). Se não achar, e o input parecer ID/número de venda
      // (UUID ou número longo), tenta lookup direto. Sem heuristicas frageis.
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(q);
      const looksLikeSaleNumber = isUuid || /^\d{9,}$/.test(q); // NFC-e tem 9+ digitos

      // 1a tentativa: busca por SKU/REF (lista vendas com essa peca)
      // crossStore só é respeitado pelo backend se o user for admin/operator.
      // Pra vendedora comum, é ignorado (segurança no servidor).
      let foundBySku = false;
      try {
        const qs = new URLSearchParams({ sku: q });
        if (crossStore) qs.set('crossStore', '1');
        const r = await api<{
          sku: string;
          sales: Array<any>;
        }>(`/pdv/devolucao/lookup-by-sku?${qs.toString()}`);
        if (r.sales?.length) {
          setSalesBySku(r.sales);
          foundBySku = true;
        }
      } catch {
        // ignora — vai tentar por venda abaixo
      }

      // 2a tentativa: busca por ID/NFC-e da venda (so se SKU nao achou nada)
      if (!foundBySku) {
        if (looksLikeSaleNumber) {
          // Input parece ID/NFC-e — tenta busca direta
          try {
            const r = await api<LookupResult>(`/pdv/devolucao/lookup?q=${encodeURIComponent(q)}`);
            setData(r);
            return;
          } catch (e: any) {
            // nao achou por venda tambem — mensagem unificada
            setErr(`Nada encontrado pra "${q}". Verifique o SKU/REF da peca ou o numero da NFC-e.`);
            return;
          }
        }
        // 3a tentativa: DEVOLUÇÃO MANUAL GIGA — peça antiga, sem cupom flowops.
        // Verifica se foi vendida na loja atual nos últimos 60d (caixa Giga).
        try {
          const r = await api<{
            eligible: boolean;
            reason?: string;
            message?: string;
            produto?: any;
            vendas?: any[];
            salesCount?: number;
            diasJanela?: number;
          }>(`/pdv/devolucao/lookup-manual?sku=${encodeURIComponent(q)}`);
          if (r.eligible && r.produto) {
            setManualEligible({
              produto: r.produto,
              vendas: r.vendas || [],
              salesCount: r.salesCount || 0,
              diasJanela: r.diasJanela || 60,
            });
            return;
          }
          // não elegível: SKU não existe OU sem histórico na loja
          setManualBlocked(r.message || 'Devolução não permitida');
        } catch {
          setErr(`Nenhuma venda encontrada com SKU/REF "${q}"`);
        }
      }
    } catch (e: any) {
      setErr(e?.message || 'Falha na busca');
    } finally {
      setBusy(false);
    }
  }

  // Cria devolução manual (sem cupom — peça do Giga)
  async function confirmManual(modoEscolhido: 'dinheiro' | 'troca' | 'credito') {
    if (!manualEligible) return;
    setManualBusy(true);
    setErr('');
    try {
      // Recupera attachToSaleId se vier de venda em andamento
      let attachToSaleId: string | null = null;
      try {
        const raw = localStorage.getItem('lurds_pdv_attach_to_sale_id');
        if (raw && raw.startsWith('{')) {
          const p = JSON.parse(raw);
          const ageMs = Date.now() - (p.ts || 0);
          if (ageMs < 30 * 60 * 1000 && p.id) attachToSaleId = String(p.id);
        }
      } catch {}

      const r = await api<any>('/pdv/devolucao/manual', {
        method: 'POST',
        body: JSON.stringify({
          sku: manualEligible.produto.codigo,
          modo: modoEscolhido,
          motivo: motivo || 'Sem cupom (Giga)',
          creditoValidadeDias: modoEscolhido === 'credito' ? validade : undefined,
          attachToSaleId: modoEscolhido === 'troca' ? attachToSaleId : null,
        }),
      });
      try { localStorage.removeItem('lurds_pdv_attach_to_sale_id'); } catch {}
      setSuccess(r);
      setManualEligible(null);
    } catch (e: any) {
      setErr(e?.message || 'Falha ao criar devolução manual');
    } finally {
      setManualBusy(false);
    }
  }

  /**
   * Vendedora escolheu UMA das vendas listadas — carrega ela com lookup
   * tradicional (que traz TODOS os itens da venda + saldo) e marca o
   * item bipado pra devolução automaticamente.
   */
  async function escolherVendaDoSku(saleId: string, autoSelectSku: string) {
    setBusy(true);
    setErr('');
    try {
      const r = await api<LookupResult>(`/pdv/devolucao/lookup?q=${encodeURIComponent(saleId)}`);
      setData(r);
      setSalesBySku(null);
      // Conta UMA peca bipada (a que a vendedora acabou de bipar pra escolher venda).
      // Pra adicionar mais pecas da mesma venda, vendedora bipa de novo no input —
      // cada bipa incrementa qty (ver `lookup()`).
      const item = r.items.find((it) => it.sku === autoSelectSku || it.ref === autoSelectSku);
      if (item && item.disponivel > 0) {
        setSelected({ [item.id]: 1 });
        setLastScanFeedback(`✓ ${item.ref || item.sku} ${item.cor || ''} ${item.tamanho || ''} — 1/${item.disponivel}`);
        setTimeout(() => setLastScanFeedback(null), 3000);
      }
      setQuery('');
      inputRef.current?.focus();
    } catch (e: any) {
      setErr(e?.message || 'Falha ao carregar venda');
    } finally {
      setBusy(false);
    }
  }

  function toggle(itemId: string, max: number) {
    setSelected((prev) => {
      const next = { ...prev };
      if (next[itemId]) {
        delete next[itemId];
      } else {
        next[itemId] = max; // padrão: tudo
      }
      return next;
    });
  }

  function setQty(itemId: string, qty: number, max: number) {
    setSelected((prev) => ({
      ...prev,
      [itemId]: Math.max(1, Math.min(max, qty)),
    }));
  }

  const totalDevolucao = (data?.items || [])
    .filter((it) => selected[it.id])
    .reduce((s, it) => {
      const valorUnit = it.qty > 0 ? it.total / it.qty : it.precoUnit;
      return s + valorUnit * (selected[it.id] || 0);
    }, 0);

  async function confirm() {
    setErr('');
    const items = Object.entries(selected).map(([originalItemId, qty]) => ({
      originalItemId,
      qty,
    }));
    if (!items.length) {
      setErr('Selecione ao menos uma peça');
      return;
    }
    setBusy(true);
    try {
      // Se veio do PDV com uma venda em andamento (F4 / botão Trocar), anexa
      // o vale_troca naquela venda em vez de criar uma nova. Backend só usa
      // attachToSaleId quando modo === 'troca'. TTL de 30min pra evitar
      // anexar em sale stale de sessão antiga.
      let attachToSaleId: string | null = null;
      try {
        const raw = localStorage.getItem('lurds_pdv_attach_to_sale_id');
        if (raw) {
          // Aceita formato novo (JSON) ou antigo (string pura)
          if (raw.startsWith('{')) {
            const parsed = JSON.parse(raw);
            const ageMs = Date.now() - (parsed.ts || 0);
            if (ageMs < 30 * 60 * 1000) attachToSaleId = parsed.id;
          } else {
            attachToSaleId = raw;
          }
        }
      } catch {}
      const r = await api<any>('/pdv/devolucao', {
        method: 'POST',
        body: JSON.stringify({
          originalSaleId: data!.sale.id,
          modo,
          items,
          motivo: motivo || undefined,
          creditoValidadeDias: modo === 'credito' ? validade : undefined,
          attachToSaleId: modo === 'troca' ? attachToSaleId : null,
        }),
      });
      // Consome o attach (uso único)
      try { localStorage.removeItem('lurds_pdv_attach_to_sale_id'); } catch {}
      setSuccess(r);

      // AUTO-IMPRIME o vale assim que a devolução em modo crédito/troca
      // for confirmada — entrega o cupom pra cliente sem vendedora precisar
      // clicar em mais nada.
      //
      // Estrategia (igual PixPaidListener):
      //   1) Electron desktop → silentPrintUrl (direto na termica)
      //   2) Browser puro → POPUP VISIVEL (nao iframe oculto). Chrome bloqueia
      //      window.print() em iframes offscreen. Como esse codigo roda dentro
      //      do event handler do clique "Confirmar devolução", o popup eh
      //      permitido (interacao do user). Popup carrega o vale, imprime
      //      sozinho via autoprint=1 e fecha apos afterprint.
      // AUTO-IMPRIME so pro modo CREDITO (90 dias). Modo TROCA (1 dia) NAO
      // imprime — cliente esta presente e vai usar o credito na hora. Backend
      // ja criou a venda nova com o vale aplicado, frontend redireciona pro PDV.
      if (r.modo === 'credito' && r.creditoCode) {
        try {
          const url = `/minha-loja/pdv/vale-troca/${encodeURIComponent(r.creditoCode)}?autoprint=1`;
          const { routePrint } = await import('@/lib/printer-router');
          await routePrint({ kind: 'vale', url }).catch(() => openValePopup(url));
        } catch { /* segue — botão Imprimir Vale fica disponível */ }
      }
      // Auto-imprime COMPROVANTE de devolucao pra modos DINHEIRO / PIX —
      // assinatura da cliente confirmando que recebeu o reembolso.
      if ((r.modo === 'dinheiro' || r.modo === 'pix') && r.id) {
        try {
          const url = `/minha-loja/pdv/recibo-devolucao/${encodeURIComponent(r.id)}?autoprint=1`;
          const { routePrint } = await import('@/lib/printer-router');
          await routePrint({ kind: 'vale', url }).catch(() => openValePopup(url));
        } catch { /* segue — botão fica disponível se falhar */ }
      }
    } catch (e: any) {
      setErr(e?.message || 'Falha na devolução');
    } finally {
      setBusy(false);
    }
  }

  // Abre POPUP VISIVEL pequeno pra imprimir o vale-troca. Substitui o
  // iframe oculto offscreen (que era bloqueado pelo Chrome — print silencioso
  // sem interacao do user nao funciona em browsers modernos).
  //
  // O popup carrega /vale-troca/[code]?autoprint=1 que dispara window.print()
  // sozinho via useEffect, e fecha apos afterprint. Janela aparece brevemente
  // mas eh mais rapido que carregar a UI inteira.
  function openValePopup(url: string) {
    const w = window.open(
      url,
      `lurds_vale_${Date.now()}`,
      'width=420,height=720,resizable=yes,scrollbars=yes',
    );
    if (!w) {
      // Popup blocker — fallback abre em nova aba (vendedora vê e imprime manual)
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  }

  function reset() {
    setQuery('');
    setData(null);
    setSelected({});
    setSuccess(null);
    setErr('');
    setMotivo('');
    inputRef.current?.focus();
  }

  return (
    <div className="min-h-screen bg-[#f4f1ec] p-4 md:p-6">
      <div className="max-w-5xl mx-auto">
        {/* Header compacto: voltar + título na mesma linha */}
        <div className="flex items-center gap-3 mb-3">
          <Link
            href="/minha-loja/pdv"
            className="inline-flex items-center gap-1 text-rose-700 hover:text-rose-900 text-sm shrink-0"
          >
            <ArrowLeft size={16} /> Voltar
          </Link>
          <h1 className="text-xl md:text-2xl font-bold text-rose-900">Devolução / Troca</h1>
        </div>

        {/* Banner compacto: venda em andamento aguardando crédito */}
        {attachInfo && !success && (
          <div className="mb-2 bg-teal-50 border border-teal-400 rounded-lg px-3 py-1.5 flex items-center gap-2 text-xs">
            <span>🛒</span>
            <span className="font-bold text-teal-900">Venda no PDV ({attachInfo.items} {attachInfo.items === 1 ? 'item' : 'itens'}):</span>
            <span className="text-teal-700">Troca anexa nela — itens não somem.</span>
          </div>
        )}

        {!success && (
          <div className="bg-white rounded-xl shadow-sm p-3 mb-2">
            <div className="flex gap-2">
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') lookup(); }}
                placeholder={data ? "Bipe MAIS peças dessa venda (cada bipa soma 1)" : "Bipe o SKU/REF da peça ou número da NFC-e"}
                className={`flex-1 p-2 border-2 rounded text-base focus:ring-2 focus:ring-rose-400 focus:outline-none ${data ? 'border-emerald-400 bg-emerald-50' : ''}`}
              />
              <button
                onClick={lookup}
                disabled={busy}
                className="bg-rose-600 hover:bg-rose-700 text-white px-4 py-2 rounded font-semibold disabled:opacity-50 flex items-center gap-1.5 text-sm"
              >
                <Search size={16} /> {data ? 'Bipar' : 'Buscar'}
              </button>
              {data && (
                <button
                  onClick={reset}
                  className="bg-slate-200 hover:bg-slate-300 text-slate-700 px-3 py-2 rounded font-semibold text-sm"
                  title="Limpa e começa nova devolução"
                >
                  Nova
                </button>
              )}
            </div>
            {lastScanFeedback && (
              <div className="mt-2 bg-emerald-100 border-2 border-emerald-400 rounded px-3 py-1.5 text-sm font-bold text-emerald-900 flex items-center gap-2 animate-pulse">
                {lastScanFeedback}
              </div>
            )}
            {/*
              Toggle "Outras lojas" — SÓ pra admin/operator.
              Vendedora comum (role=store) nunca vê esse checkbox; backend
              ignora `crossStore` no JWT dela mesmo se enviado.
            */}
            {(userRole === 'admin' || userRole === 'operator') && (
              <label className="mt-2 flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={crossStore}
                  onChange={(e) => setCrossStore(e.target.checked)}
                  className="w-4 h-4"
                />
                <span className="font-medium">
                  🔓 Buscar vendas de <b>todas as lojas</b>
                </span>
                <span className="text-slate-500">
                  (modo admin — devolução fora da loja vendedora gera NF cross-CNPJ; use com cuidado)
                </span>
              </label>
            )}
            {err && <div className="mt-1.5 text-xs text-red-600">{err}</div>}
          </div>
        )}

        {/* Lista de vendas encontradas pela busca por SKU */}
        {salesBySku && salesBySku.length > 0 && !data && !success && (
          <div className="bg-white rounded-2xl shadow-md p-5 mb-6">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-bold text-rose-900">
                {salesBySku.length} venda(s) encontrada(s) com essa peça
              </h2>
              <span className="text-xs text-slate-500">Ordenado da mais recente</span>
            </div>
            <div className="text-xs text-slate-600 mb-3">
              Click na venda do cliente que está devolvendo (geralmente é a mais recente).
            </div>
            <div className="space-y-2">
              {salesBySku.map((s) => {
                const item = s.matchedItems[0]; // primeiro match
                const dataFmt = new Date(s.finalizedAt).toLocaleString('pt-BR');
                const disabled = s.totalmenteDevolvido;
                return (
                  <button
                    key={s.saleId}
                    onClick={() => !disabled && escolherVendaDoSku(s.saleId, item.sku)}
                    disabled={disabled || busy}
                    className={`w-full text-left p-3 rounded-lg border-2 transition ${
                      disabled
                        ? 'bg-slate-50 border-slate-200 cursor-not-allowed opacity-60'
                        : 'bg-white border-rose-200 hover:border-rose-500 hover:bg-rose-50 cursor-pointer'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                      <div className="flex-1 min-w-0">
                        <div className="font-bold text-slate-800">
                          {s.customerName || <span className="text-slate-400 italic">Sem identificação</span>}
                          {s.customerCpf && <span className="ml-2 text-xs text-slate-500 font-mono">{s.customerCpf}</span>}
                        </div>
                        <div className="text-xs text-slate-600 mt-0.5">
                          {dataFmt} · {s.storeName || '—'}
                          {s.nfceNumber && <> · NFC-e {s.nfceNumber}</>}
                          {s.sellerName && <> · {s.sellerName}</>}
                        </div>
                        <div className="text-xs text-slate-700 mt-1">
                          <span className="font-mono bg-slate-100 px-1.5 py-0.5 rounded">{item.sku}</span>
                          {' '}{item.descricao || item.ref}
                          {item.cor && <> · {item.cor}</>}
                          {item.tamanho && <> · {item.tamanho}</>}
                          {' · '}<b>{item.qty}× R$ {fmt(item.precoUnit)}</b>
                          {item.jaDevolvido > 0 && (
                            <span className="ml-2 text-amber-700">
                              ({item.jaDevolvido} já devolvida{item.jaDevolvido > 1 ? 's' : ''})
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-xs text-slate-500">Venda total</div>
                        <div className="font-bold text-emerald-700 tabular-nums">R$ {fmt(s.totalVenda)}</div>
                        {disabled && (
                          <div className="text-[10px] text-rose-700 mt-1 font-bold">JÁ DEVOLVIDA</div>
                        )}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
            <button
              onClick={() => { setSalesBySku(null); setQuery(''); inputRef.current?.focus(); }}
              className="mt-4 text-sm text-slate-600 hover:underline"
            >
              ← Buscar outra peça
            </button>
          </div>
        )}

        {/* ─── DEVOLUÇÃO MANUAL GIGA ─── */}
        {/* Bloqueada: peça não tem histórico de venda nesta loja */}
        {manualBlocked && !manualEligible && !success && (
          <div className="bg-rose-50 border-2 border-rose-300 rounded-xl p-4 mb-3">
            <div className="font-bold text-rose-900 text-lg flex items-center gap-2">
              🚫 Devolução bloqueada
            </div>
            <p className="text-sm text-rose-800 mt-1.5 leading-snug">{manualBlocked}</p>
            <button
              onClick={() => {
                setManualBlocked(null);
                setQuery('');
                inputRef.current?.focus();
              }}
              className="mt-3 text-sm text-rose-700 hover:underline font-medium"
            >
              ← Buscar outra peça
            </button>
          </div>
        )}

        {/* Elegível: peça do Giga, foi vendida na loja → libera devolução manual */}
        {manualEligible && !success && (
          <div className="space-y-3 mb-3">
            <div className="bg-amber-50 border-2 border-amber-400 rounded-xl p-4">
              <div className="flex items-center gap-2 text-amber-900 font-bold text-sm uppercase tracking-wide mb-2">
                ⚠ Devolução manual · sem cupom flowops
              </div>
              <div className="bg-white rounded-lg p-3 border border-amber-200">
                <div className="font-bold text-slate-900 text-base leading-tight">
                  {manualEligible.produto.descricao || 'Peça sem descrição'}
                </div>
                <div className="flex flex-wrap items-center gap-1.5 mt-1.5 text-xs">
                  <span className="px-2 py-0.5 bg-violet-100 text-violet-800 rounded font-mono font-bold">
                    {manualEligible.produto.codigo}
                  </span>
                  {manualEligible.produto.cor && (
                    <span className="px-2 py-0.5 bg-slate-100 text-slate-700 rounded font-bold">
                      {manualEligible.produto.cor}
                    </span>
                  )}
                  {manualEligible.produto.tamanho && (
                    <span className="px-2 py-0.5 bg-amber-100 text-amber-900 rounded font-bold">
                      TAM {manualEligible.produto.tamanho}
                    </span>
                  )}
                  <span className="ml-auto text-base font-black text-emerald-700">
                    R$ {fmt(manualEligible.produto.preco)}
                  </span>
                </div>
              </div>

              {manualEligible.vendas.length > 0 && (
                <div className="mt-3">
                  <div className="text-[10px] font-bold uppercase text-amber-800 tracking-wide mb-1.5">
                    📜 Histórico desta peça nesta loja (últimos {manualEligible.diasJanela} dias)
                  </div>
                  <div className="bg-white rounded-lg border border-amber-200 divide-y divide-amber-100 max-h-32 overflow-y-auto">
                    {manualEligible.vendas.slice(0, 6).map((v, i) => (
                      <div key={i} className="flex items-center justify-between px-2.5 py-1.5 text-xs">
                        <span className="text-slate-700">
                          {v.data} · cupom {v.numero}
                        </span>
                        <span className="font-bold text-slate-900">
                          R$ {fmt(v.valor)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="mt-3 text-xs text-amber-900 bg-amber-100 rounded px-2 py-1.5 leading-snug">
                ℹ Devolução interna · estoque volta pro Giga · sem NFC-e ·
                motivo: <b>Sem cupom (Giga)</b>
              </div>
            </div>

            {/* Botões de modo */}
            <div className="bg-white rounded-xl shadow-sm p-3">
              <div className="text-xs font-bold uppercase text-slate-600 tracking-wide mb-2">
                Como vai resolver?
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <button
                  onClick={() => confirmManual('troca')}
                  disabled={manualBusy}
                  className="px-3 py-3 bg-fuchsia-600 hover:bg-fuchsia-700 disabled:opacity-50 text-white rounded-lg font-bold flex flex-col items-center gap-0.5"
                >
                  <ArrowRightLeft className="w-5 h-5" />
                  <span className="text-sm">Troca</span>
                  <span className="text-[10px] opacity-90">leva outra peça agora</span>
                </button>
                <button
                  onClick={() => confirmManual('credito')}
                  disabled={manualBusy}
                  className="px-3 py-3 bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white rounded-lg font-bold flex flex-col items-center gap-0.5"
                >
                  <CreditCard className="w-5 h-5" />
                  <span className="text-sm">Vale-troca</span>
                  <span className="text-[10px] opacity-90">{validade} dias</span>
                </button>
                <button
                  onClick={() => confirmManual('dinheiro')}
                  disabled={manualBusy}
                  className="px-3 py-3 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-lg font-bold flex flex-col items-center gap-0.5"
                >
                  <Banknote className="w-5 h-5" />
                  <span className="text-sm">Dinheiro</span>
                  <span className="text-[10px] opacity-90">sangria automática</span>
                </button>
              </div>
              <button
                onClick={() => {
                  setManualEligible(null);
                  setQuery('');
                  inputRef.current?.focus();
                }}
                className="mt-3 text-xs text-slate-600 hover:underline"
              >
                ← Cancelar
              </button>
            </div>
          </div>
        )}

        {data && !success && (
          <div className="space-y-2">
            {/* Venda original — ULTRA-COMPACTO: 2 linhas só */}
            <div className="bg-white rounded-xl shadow-sm px-3 py-2 text-xs">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="font-bold text-rose-900">
                  {data.sale.nfceNumber ? `NFC-e #${data.sale.nfceNumber}` : 'Venda original'}
                  <span className="text-gray-500 font-normal ml-2">
                    {data.sale.storeName} · {new Date(data.sale.finalizedAt).toLocaleDateString('pt-BR')}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {data.previousReturns > 0 && (
                    <span className="text-[10px] bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded">
                      {data.previousReturns} devolução(ões) anteriores
                    </span>
                  )}
                  <span className="font-bold text-rose-900">R$ {fmt(data.sale.total)}</span>
                </div>
              </div>
              <div className="text-gray-600 truncate">
                {data.sale.customerName || 'Sem identificação'}
                {data.sale.customerCpf ? ` · CPF ${data.sale.customerCpf}` : ''}
              </div>
            </div>

            <div className="bg-white rounded-xl shadow-sm p-3">
              <h3 className="font-bold text-rose-900 text-sm mb-2">Selecione as peças a devolver</h3>
              <div className="space-y-1">
                {data.items.map((it) => {
                  const isSel = !!selected[it.id];
                  const sel = selected[it.id] || 0;
                  const disabled = it.disponivel <= 0;
                  return (
                    <div
                      key={it.id}
                      className={`rounded-lg px-2.5 py-1.5 transition-all border-2 ${
                        disabled
                          ? 'bg-gray-100 border-gray-200 opacity-50'
                          : isSel
                          ? 'bg-rose-50 border-rose-400'
                          : 'bg-white border-gray-200 hover:border-rose-300'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={isSel}
                          disabled={disabled}
                          onChange={() => toggle(it.id, it.disponivel)}
                          className="w-5 h-5 shrink-0"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="font-semibold text-gray-800 text-sm leading-tight truncate">
                            {it.descricao}
                          </div>
                          <div className="text-[11px] text-gray-500 leading-tight">
                            SKU {it.sku}
                            {it.cor ? ` · ${it.cor}` : ''}
                            {it.tamanho ? ` · ${it.tamanho}` : ''}
                            <span className="text-gray-700"> · R$ {fmt(it.precoUnit)} · Comprou {it.qty}</span>
                            {it.jaDevolvido > 0 && (
                              <span className="text-amber-700"> · já devolveu {it.jaDevolvido}</span>
                            )}
                          </div>
                        </div>
                        {isSel && it.disponivel > 1 && (
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => setQty(it.id, sel - 1, it.disponivel)}
                              className="w-8 h-8 bg-rose-200 rounded font-bold"
                            >
                              −
                            </button>
                            <span className="w-8 text-center font-bold">{sel}</span>
                            <button
                              onClick={() => setQty(it.id, sel + 1, it.disponivel)}
                              className="w-8 h-8 bg-rose-200 rounded font-bold"
                            >
                              +
                            </button>
                          </div>
                        )}
                        {disabled && (
                          <div className="text-xs text-red-600">Tudo já devolvido</div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {Object.keys(selected).length > 0 && (
              <div className="bg-white rounded-xl shadow-sm p-3">
                {/* GRID: modo (esq) + valor+confirmar (dir) lado a lado */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <div className="text-xs font-bold text-rose-900 uppercase tracking-wide mb-1.5">Modo</div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                      <ModoBtn
                        active={modo === 'dinheiro'}
                        onClick={() => setModo('dinheiro')}
                        icon={<Banknote size={16} />}
                        title="Dinheiro"
                        sub="Sangria"
                      />
                      <ModoBtn
                        active={modo === 'pix'}
                        onClick={() => setModo('pix')}
                        icon={<span className="text-base font-black">📲</span>}
                        title="PIX"
                        sub="Sangria"
                      />
                      <ModoBtn
                        active={modo === 'troca'}
                        onClick={() => setModo('troca')}
                        icon={<ArrowRightLeft size={16} />}
                        title="Troca"
                        sub="Hoje"
                      />
                      <ModoBtn
                        active={modo === 'credito'}
                        onClick={() => setModo('credito')}
                        icon={<CreditCard size={16} />}
                        title="Vale"
                        sub="Depois"
                      />
                    </div>

                    {modo === 'credito' && (
                      <div className="mt-2">
                        <label className="text-[11px] font-semibold text-gray-700">
                          Validade do vale (dias)
                        </label>
                        <input
                          type="number"
                          value={validade}
                          onChange={(e) => setValidade(parseInt(e.target.value, 10) || 90)}
                          min={1}
                          max={365}
                          className="w-full p-1.5 border rounded text-sm"
                        />
                      </div>
                    )}

                    <div className="mt-2">
                      <label className="text-[11px] font-semibold text-gray-700">
                        Motivo (opcional)
                      </label>
                      <input
                        type="text"
                        value={motivo}
                        onChange={(e) => setMotivo(e.target.value)}
                        placeholder="Defeito, tamanho, arrependimento…"
                        className="w-full p-1.5 border rounded text-sm"
                      />
                    </div>
                  </div>

                  <div className="flex flex-col">
                    <div className="bg-rose-50 rounded-lg p-3 text-center flex-1 flex flex-col justify-center">
                      <div className="text-xs text-rose-700 uppercase tracking-wide">Valor da devolução</div>
                      <div className="text-3xl font-black text-rose-900 tabular-nums leading-tight">
                        R$ {fmt(totalDevolucao)}
                      </div>
                    </div>

                    {err && <div className="mt-2 text-xs text-red-600">{err}</div>}

                    <button
                      onClick={confirm}
                      disabled={busy || !Object.keys(selected).length}
                      className="mt-2 w-full py-3 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-bold text-base disabled:opacity-50 shadow-md"
                    >
                      {busy ? 'Processando…' : 'Confirmar Devolução'}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {success && (
          <div className="bg-white rounded-2xl shadow-md p-8 text-center">
            <div className="w-20 h-20 mx-auto bg-emerald-100 rounded-full flex items-center justify-center mb-4">
              <Check size={36} className="text-emerald-600" />
            </div>
            <h2 className="text-2xl font-bold text-rose-900 mb-2">Devolução registrada</h2>
            <div className="text-gray-600 mb-4">
              R$ {fmt(success.valorTotal)} em {success.modo}
            </div>

            {success.modo === 'dinheiro' && (
              <div className="bg-amber-50 rounded-lg p-4 mb-4 text-amber-800">
                <strong>Sangria automática</strong> registrada no caixa.
                <br />
                Entregue R$ {fmt(success.valorTotal)} em dinheiro pra cliente.
                <div className="mt-2">
                  <a
                    href={`/minha-loja/pdv/recibo-devolucao/${encodeURIComponent(success.id)}?autoprint=1`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-block px-3 py-1.5 bg-rose-600 hover:bg-rose-700 text-white rounded text-xs font-bold"
                  >
                    🖨️ Reimprimir comprovante
                  </a>
                </div>
              </div>
            )}
            {success.modo === 'pix' && (
              <div className="bg-cyan-50 rounded-lg p-4 mb-4 text-cyan-900">
                <strong>Sangria PIX</strong> registrada no caixa.
                <br />
                Envie R$ {fmt(success.valorTotal)} via PIX para a cliente.
                <br />
                <span className="text-xs text-cyan-700">⚠️ Comprovante impresso — colete assinatura após confirmação do PIX.</span>
                <div className="mt-2">
                  <a
                    href={`/minha-loja/pdv/recibo-devolucao/${encodeURIComponent(success.id)}?autoprint=1`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-block px-3 py-1.5 bg-rose-600 hover:bg-rose-700 text-white rounded text-xs font-bold"
                  >
                    🖨️ Reimprimir comprovante
                  </a>
                </div>
              </div>
            )}
            {(success.modo === 'troca' || success.modo === 'credito') && (
              <>
                {/* MODO TROCA (mesmo dia) — cliente esta na frente do balcao.
                    Sem codigo, sem impresso. Backend ja criou nova PdvSale com
                    o vale_troca aplicado direto — vendedora vai pro PDV bipar
                    as peças novas e finalizar. */}
                {success.modo === 'troca' && success.attachedToExistingSale ? (
                  /* Vale_troca foi ANEXADO na venda em andamento no PDV.
                     Não reinicia nada — só volta pra venda que estava aberta. */
                  <div className="bg-teal-50 border-2 border-teal-400 rounded-2xl p-5 mb-4">
                    <div className="text-xs uppercase tracking-widest text-teal-700 font-bold">
                      ✓ Crédito anexado à venda em andamento
                    </div>
                    <div className="text-2xl font-black text-teal-900 mt-2">
                      R$ {fmt(success.valorTotal)} abatido na venda atual
                    </div>
                    <div className="text-sm text-slate-700 mt-1">
                      Os itens já no carrinho continuam intactos. O crédito da troca foi aplicado como forma de pagamento.
                    </div>
                    <button
                      onClick={() => { window.location.href = '/minha-loja/pdv'; }}
                      className="mt-4 w-full py-3 rounded-xl bg-teal-600 hover:bg-teal-700 text-white font-black text-lg flex items-center justify-center gap-2"
                    >
                      → VOLTAR PRO PDV
                    </button>
                  </div>
                ) : success.modo === 'troca' && success.directSaleId ? (
                  <div className="bg-teal-50 border-2 border-teal-400 rounded-2xl p-5 mb-4">
                    <div className="text-xs uppercase tracking-widest text-teal-700 font-bold">
                      ✓ Crédito aplicado direto
                    </div>
                    <div className="text-2xl font-black text-teal-900 mt-2">
                      R$ {fmt(success.valorTotal)} disponível
                    </div>
                    <div className="text-sm text-slate-700 mt-1">
                      Nova venda aberta no PDV pra <b>{success.customerName || 'cliente'}</b> com o crédito já aplicado.
                    </div>
                    <button
                      onClick={() => {
                        try {
                          localStorage.setItem('lurds_pdv_retomar_sale_id', success.directSaleId);
                        } catch { /* segue */ }
                        window.location.href = '/minha-loja/pdv';
                      }}
                      className="mt-4 w-full py-3 rounded-xl bg-teal-600 hover:bg-teal-700 text-white font-black text-lg flex items-center justify-center gap-2"
                    >
                      → CONTINUAR NO PDV
                    </button>
                    <div className="text-[11px] text-slate-500 mt-2 text-center">
                      No PDV bipa as peças novas — o sistema abate o crédito automaticamente.
                    </div>
                  </div>
                ) : success.creditoCode ? (
                  /* MODO CREDITO (90 dias) — cliente leva cupom pra usar depois.
                     Imprime + mostra codigo + valor + items devolvidos. */
                  <div className="bg-emerald-50 border-2 border-emerald-300 rounded-2xl p-5 mb-4">
                    <div className="text-xs uppercase tracking-widest text-emerald-700 font-bold">
                      ★ Vale-Crédito gerado ★
                    </div>
                    <div
                      className="text-3xl sm:text-4xl font-mono font-black tracking-widest text-slate-900 mt-2 mb-1 cursor-text select-all"
                      title="Clique pra selecionar — Ctrl+C pra copiar"
                    >
                      {success.creditoCode}
                    </div>
                    <div className="text-2xl font-black text-emerald-700 tabular-nums">
                      R$ {fmt(success.valorTotal)}
                    </div>
                    <div className="text-sm text-slate-600 mt-2">
                      Válido até{' '}
                      <strong>
                        {success.creditoValidade
                          ? new Date(success.creditoValidade).toLocaleDateString('pt-BR')
                          : '—'}
                      </strong>
                    </div>

                    {/* Lista do que foi devolvido — pra cliente ver no cupom */}
                    {success.items && success.items.length > 0 && (
                      <div className="mt-3 bg-white rounded-lg border border-emerald-200 p-2 text-xs">
                        <div className="font-bold text-emerald-800 mb-1 uppercase tracking-wide text-[10px]">Referente à devolução:</div>
                        <ul className="space-y-0.5">
                          {success.items.map((it: any, i: number) => (
                            <li key={i} className="flex justify-between gap-2">
                              <span className="truncate text-slate-700">
                                {it.qty}× {it.ref || it.sku} {it.cor ? `· ${it.cor}` : ''} {it.tamanho ? `/ ${it.tamanho}` : ''}
                              </span>
                              <span className="font-mono text-slate-600 tabular-nums shrink-0">R$ {fmt(Number(it.total) || 0)}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <CopiarCodigoBtn code={success.creditoCode} />
                      <button
                        onClick={async () => {
                          const url = `/minha-loja/pdv/vale-troca/${encodeURIComponent(success.creditoCode)}?autoprint=1`;
                          try {
                            const { routePrint } = await import('@/lib/printer-router');
                            await routePrint({ kind: 'vale', url });
                          } catch {
                            window.open(url, 'lurds_vale', 'width=400,height=700');
                          }
                        }}
                        className="py-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-black text-lg flex items-center justify-center gap-2"
                      >
                        🖨 IMPRIMIR
                      </button>
                    </div>
                    <div className="text-[11px] text-slate-500 mt-2">
                      Entregue o cupom impresso pra cliente — ela vai precisar pra trocar.
                    </div>
                  </div>
                ) : (
                  <div className="bg-rose-50 border-2 border-rose-300 rounded-lg p-4 mb-4 text-rose-800">
                    <strong>⚠ Vale-troca NÃO foi gerado</strong>
                    <br />
                    A devolução foi registrada mas o código TROCA-XXXXX não veio
                    do servidor. Recarregue a página de listagem de devoluções
                    e busque pelo cliente pra emitir o vale manualmente.
                  </div>
                )}
              </>
            )}

            {success.items?.some((it: any) => it.stockError) && (
              <div className="bg-red-50 rounded-lg p-3 mb-4 text-red-800 text-sm">
                ⚠️ Atenção: estoque Giga não foi estornado em uma ou mais peças.
                <br />
                Faça a entrada manual no Gigasistemas.
              </div>
            )}

            <button
              onClick={reset}
              className="w-full py-3 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-semibold"
            >
              Nova Devolução
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ModoBtn({
  active,
  onClick,
  icon,
  title,
  sub,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  sub: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`p-3 rounded-xl text-center transition-all ${
        active
          ? 'bg-rose-600 text-white shadow-lg scale-105'
          : 'bg-rose-50 hover:bg-rose-100 text-rose-900'
      }`}
    >
      <div className="flex justify-center mb-1">{icon}</div>
      <div className="font-bold">{title}</div>
      <div className={`text-xs ${active ? 'text-rose-100' : 'text-gray-500'}`}>{sub}</div>
    </button>
  );
}

// Botao "Copiar codigo" — clipboard API + feedback visual 2s.
// Em browsers antigos/sem permissao, usa fallback document.execCommand.
function CopiarCodigoBtn({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(code);
      } else {
        const ta = document.createElement('textarea');
        ta.value = code;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      alert('Falha ao copiar — selecione o codigo manualmente');
    }
  };
  return (
    <button
      onClick={copy}
      className={`py-3 rounded-xl font-black text-lg flex items-center justify-center gap-2 transition ${
        copied
          ? 'bg-emerald-700 text-white'
          : 'bg-slate-800 hover:bg-slate-900 text-white'
      }`}
    >
      {copied ? '✓ COPIADO!' : '📋 COPIAR CÓDIGO'}
    </button>
  );
}
