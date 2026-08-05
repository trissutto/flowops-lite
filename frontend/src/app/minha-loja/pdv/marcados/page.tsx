'use client';

/**
 * /minha-loja/pdv/marcados — gerenciamento de peças marcadas (provar em casa).
 *
 * Fluxo:
 *  1. Vendedora identifica cliente por CPF
 *  2. Sistema valida (classificação 'A' + limite) + lista marcados ativos
 *  3. Cliente trouxe peças de volta:
 *     - Vendedora marca quais VOLTARAM (checkbox)
 *     - Click "Processar devolução"
 *     - Backend estorna estoque das peças marcadas (increaseStock)
 *  4. Peças que ficaram (não marcadas) são cobradas:
 *     - Vendedora vai pro PDV normal e bipa essas peças
 *     - Cobra do jeito normal (PIX/cartão/etc)
 */

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Search, Loader2, Check, AlertCircle, Tag, RefreshCw, ShoppingCart } from 'lucide-react';
import { api } from '@/lib/api';

type Marcado = {
  REGISTRO: number;
  NUMERO: number;
  CODIGO: string;
  DATA: string;
  DESCRICAO: string;
  QUANTIDADE: number;
  VALOR: number;
  VALORTOTAL: number;
  VENDEDOR: number;
  OPERADOR: number;
  LOJA: string;
};

type ClienteInfo = {
  permitido: boolean;
  motivo?: string;
  cliente: {
    codCliente: string;
    nome: string;
    cpf: string;
    classificacao: string;
    limiteTotal: number;
    ultimaCompra: string | null;
  } | null;
  marcadosAtivos: Marcado[];
  totalMarcadosAtivos: number;
  limiteDisponivel: number;
};

const brl = (n: number) =>
  Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const fmtDate = (s: string | null) => s ? new Date(s).toLocaleDateString('pt-BR') : '—';

type ClienteMatch = {
  codCliente: string;
  loja?: string;
  nome: string;
  cpf: string;
  classificacao: string;
  limiteTotal: number;
  // null = Giga não respondeu a tempo (a busca vem do espelho e não trava);
  // abre o cliente pra ver os marcados
  qtdMarcados: number | null;
  totalMarcados: number | null;
};

export default function MarcadosPage() {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<ClienteMatch[]>([]);
  const [searching, setSearching] = useState(false);
  const [info, setInfo] = useState<ClienteInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [voltadas, setVoltadas] = useState<Set<number>>(new Set());
  const [processing, setProcessing] = useState(false);
  const [puxando, setPuxando] = useState(false);
  const [processResult, setProcessResult] = useState<{ ok: number; falhas: string[] } | null>(null);
  const [dedupPlan, setDedupPlan] = useState<any>(null);
  const [dedupBusy, setDedupBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  // Debounce: ao digitar nome OU CPF parcial, busca matches automaticamente.
  // Se for CPF completo (11 digitos), faz a busca direta no cliente.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setMatches([]);
      return;
    }
    // CPF completo (11 digitos) — pula dropdown, busca direto
    const cpfLimpo = q.replace(/\D/g, '');
    if (cpfLimpo.length === 11) {
      setMatches([]);
      return;
    }
    // Debounce 350ms
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        // Escopo por loja: só clientes DESTA loja (cadastros repetem por loja)
        let lojaParam = '';
        try {
          const lj = localStorage.getItem('lurds_pdv_store') || '';
          if (lj) lojaParam = `&loja=${encodeURIComponent(lj)}`;
        } catch { /* backend usa a loja do token */ }
        const r = await api<ClienteMatch[]>(`/pdv/marcados/search?q=${encodeURIComponent(q)}${lojaParam}`);
        setMatches(Array.isArray(r) ? r : []);
      } catch {
        setMatches([]);
      } finally {
        setSearching(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [query]);

  async function buscarPorCpf(cpfNum: string) {
    return abrirFicha(`cpf=${cpfNum}`);
  }

  /**
   * Abre a ficha por CPF **ou** por loja+código (05/08). Um quarto das fichas
   * do Wincred não tem CPF — a tela recusava abrir e a loja ficava sem fechar
   * peça que já aparecia na lista de busca (caso DAIANA RUFINO: 48 peças,
   * R$ 3.323,80). Código do cliente é a chave real do Giga.
   */
  async function abrirFicha(qs: string) {
    setErr(null);
    setInfo(null);
    setVoltadas(new Set());
    setProcessResult(null);
    setMatches([]);
    setBusy(true);
    try {
      const r = await api<ClienteInfo>(`/pdv/marcados/cliente?${qs}`);
      setInfo(r);
    } catch (e: any) {
      setErr(e?.message || 'Falha ao buscar cliente');
    } finally {
      setBusy(false);
    }
  }

  // ── Corrigir duplicados: preview + aplicar ──
  // Manda cpf E codCliente — a ficha conta os marcados por cpf OU codCliente,
  // então a limpeza precisa enxergar exatamente o mesmo conjunto (senão sobra).
  async function previewDedup() {
    const cpf = (info?.cliente?.cpf || '').replace(/\D/g, '');
    const codCliente = info?.cliente?.codCliente || undefined;
    if (!cpf && !codCliente) { setErr('Cliente sem CPF/código — não dá pra analisar'); return; }
    setDedupBusy(true); setErr(null); setDedupPlan(null);
    try {
      const r = await api<any>('/pdv/marcados/desduplicar', {
        method: 'POST', body: JSON.stringify({ cpf: cpf || undefined, codCliente, dryRun: true }),
      });
      setDedupPlan(r);
    } catch (e: any) {
      setErr(e?.message || 'Falha ao analisar duplicados');
    } finally {
      setDedupBusy(false);
    }
  }
  async function aplicarDedup() {
    const cpf = (info?.cliente?.cpf || '').replace(/\D/g, '');
    const codCliente = info?.cliente?.codCliente || undefined;
    if (!cpf && !codCliente) return;
    setDedupBusy(true); setErr(null);
    try {
      await api('/pdv/marcados/desduplicar', {
        method: 'POST', body: JSON.stringify({ cpf: cpf || undefined, codCliente, dryRun: false }),
      });
      setDedupPlan(null);
      if (cpf) await buscarPorCpf(cpf); // recarrega a ficha já corrigida
    } catch (e: any) {
      setErr(e?.message || 'Falha ao aplicar correção');
    } finally {
      setDedupBusy(false);
    }
  }

  async function buscar() {
    const q = query.trim();
    const cpfLimpo = q.replace(/\D/g, '');
    if (cpfLimpo.length === 11) {
      await buscarPorCpf(cpfLimpo);
      return;
    }
    if (matches.length > 0) {
      // Se tem matches no dropdown, escolhe o primeiro
      await escolherCliente(matches[0]);
    } else {
      setErr('Digite CPF completo ou parte do nome (mínimo 2 letras)');
    }
  }

  async function escolherCliente(m: ClienteMatch) {
    const cpfNum = (m.cpf || '').replace(/\D/g, '');
    if (cpfNum.length === 11) {
      await buscarPorCpf(cpfNum);
      return;
    }
    // Ficha sem CPF (1 em cada 4 no Wincred): abre pela chave do Giga.
    if (m.codCliente) {
      const qs = new URLSearchParams({ codCliente: String(m.codCliente) });
      if (m.loja) qs.set('loja', String(m.loja));
      await abrirFicha(qs.toString());
      return;
    }
    setErr('Ficha sem CPF e sem código de cliente — não dá pra abrir os marcados');
  }

  function toggleVoltada(registro: number) {
    setVoltadas((prev) => {
      const next = new Set(prev);
      if (next.has(registro)) next.delete(registro);
      else next.add(registro);
      return next;
    });
  }

  /**
   * BIPE DO CÓDIGO DE BARRAS (04/08 — pedido do dono).
   *
   * Com a cliente na frente devolvendo 8 peças, achar cada linha na tabela e
   * clicar no checkbox é lento e erra. Agora a vendedora passa o leitor na
   * etiqueta e a peça se marca sozinha.
   *
   * O código da etiqueta é o CODIGO do Giga (mesma régua do PDV). A comparação
   * é tolerante porque o padding de zero do Giga é inconsistente ('05342853' e
   * '5342853' são a MESMA peça) — comparar string crua devolvia "não achei"
   * numa peça que está ali na lista.
   */
  const bipeRef = useRef<HTMLInputElement | null>(null);
  const [bipe, setBipe] = useState('');
  const [bipeMsg, setBipeMsg] = useState<{ tipo: 'ok' | 'erro'; texto: string } | null>(null);
  const [ultimoBipado, setUltimoBipado] = useState<number | null>(null);

  /** Normaliza pra comparar: só dígitos/letras, sem zeros à esquerda. */
  const chaveCodigo = (v: any) =>
    String(v ?? '').trim().toUpperCase().replace(/^0+/, '');

  function bipar(codigoBruto: string) {
    const codigo = codigoBruto.trim();
    if (!codigo || !info) return;
    const alvo = chaveCodigo(codigo);
    // Peças ainda NÃO marcadas primeiro: bipar a mesma etiqueta duas vezes
    // costuma ser leitor repetindo, não duas peças iguais na sacola.
    const candidatos = info.marcadosAtivos.filter((m) => chaveCodigo(m.CODIGO) === alvo);
    const alvoNovo = candidatos.find((m) => !voltadas.has(m.REGISTRO));

    if (!candidatos.length) {
      setBipeMsg({
        tipo: 'erro',
        texto: `Código ${codigo} não está na lista deste cliente.`,
      });
    } else if (!alvoNovo) {
      setBipeMsg({
        tipo: 'erro',
        texto: `Essa peça já está marcada como devolvida (${candidatos[0].DESCRICAO || codigo}).`,
      });
    } else {
      setVoltadas((prev) => new Set(prev).add(alvoNovo.REGISTRO));
      setUltimoBipado(alvoNovo.REGISTRO);
      setBipeMsg({
        tipo: 'ok',
        texto: `✓ ${alvoNovo.DESCRICAO || codigo}`,
      });
    }
    setBipe('');
    // O leitor dispara em sequência — o foco tem que voltar sozinho.
    setTimeout(() => bipeRef.current?.focus(), 10);
  }

  function selectAll() {
    if (!info) return;
    setVoltadas(new Set(info.marcadosAtivos.map((m) => m.REGISTRO)));
  }

  function selectNone() {
    setVoltadas(new Set());
  }

  async function processarDevolucao() {
    if (!info || voltadas.size === 0) return;
    if (!confirm(
      `Confirmar devolução de ${voltadas.size} peça(s)?\n\n` +
      `As peças voltam pro estoque Giga da loja de origem.\n` +
      `As que NÃO foram marcadas continuam como marcadas pra o cliente.`,
    )) return;

    setProcessing(true);
    let ok = 0;
    const falhas: string[] = [];

    for (const registro of voltadas) {
      const m = info.marcadosAtivos.find((x) => x.REGISTRO === registro);
      if (!m) continue;
      try {
        const r = await api<{ ok: boolean; error?: string }>('/pdv/marcados/devolver', {
          method: 'POST',
          body: JSON.stringify({
            registro: m.REGISTRO,
            sku: m.CODIGO,
            qty: m.QUANTIDADE || 1,
            loja: m.LOJA,
          }),
        });
        if (r.ok) ok++;
        else falhas.push(`${m.DESCRICAO}: ${r.error || 'erro'}`);
      } catch (e: any) {
        falhas.push(`${m.DESCRICAO}: ${e?.message || 'erro'}`);
      }
    }

    setProcessResult({ ok, falhas });
    setProcessing(false);

    // Recarrega lista
    await buscar();
  }

  // Puxa as pecas marcadas pra dentro do PDV como itens de uma venda nova.
  // Backend cria PdvSale aberta com os items, retorna saleId. Frontend
  // redireciona pra /pdv onde a vendedora retoma a venda e cobra normal.
  async function puxarParaVenda() {
    if (!info || voltadas.size === 0) return;
    if (!confirm(
      `Puxar ${voltadas.size} peca(s) marcada(s) pra finalizar venda no PDV?\n\n` +
      `Total: R$ ${valorVoltadas.toFixed(2).replace('.', ',')}\n\n` +
      `Vai abrir uma venda nova no PDV com essas pecas. Quando finalizar a venda, ` +
      `as pecas saem dos marcados automaticamente.`,
    )) return;

    setPuxando(true);
    try {
      const registros = Array.from(voltadas);
      const r = await api<{ saleId: string; itemsAdded: number; total: number }>(
        '/pdv/marcados/puxar-pra-venda',
        {
          method: 'POST',
          body: JSON.stringify({
            registros,
            customerCpf: info.cliente?.cpf || undefined,
            customerName: info.cliente?.nome || undefined,
          }),
        },
      );
      if (!r.saleId) throw new Error('Backend nao retornou saleId');
      try {
        localStorage.setItem('lurds_pdv_retomar_sale_id', r.saleId);
      } catch {}
      router.push('/minha-loja/pdv');
    } catch (e: any) {
      alert('Erro ao puxar pra venda: ' + (e?.message || e));
      setPuxando(false);
    }
  }

  const valorVoltadas = info
    ? info.marcadosAtivos
        .filter((m) => voltadas.has(m.REGISTRO))
        .reduce((s, m) => s + (Number(m.VALORTOTAL) || Number(m.VALOR) || 0), 0)
    : 0;

  return (
    <div className="max-w-5xl mx-auto p-4 space-y-4">
      <div className="flex items-center gap-3">
        <Link href="/minha-loja/pdv" className="text-slate-600 hover:text-slate-900">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <h1 className="text-xl font-bold text-slate-800 flex items-center gap-2">
          <Tag className="w-5 h-5" /> Marcados (Provar em Casa)
        </h1>
      </div>

      {/* Busca por CPF ou nome */}
      <div className="bg-white border rounded-lg p-4 space-y-2 relative">
        <label className="block text-sm font-bold text-slate-700">CPF ou nome do cliente</label>
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') buscar();
              if (e.key === 'Escape') { setMatches([]); }
            }}
            placeholder="Ex: MARIA SILVA, 123.456.789-00, ou 12345 (CPF parcial)"
            maxLength={120}
            className="flex-1 border rounded px-3 py-2 text-base"
          />
          <button
            onClick={buscar}
            disabled={busy}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-bold rounded flex items-center gap-2"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
            Buscar
          </button>
        </div>
        {err && (
          <div className="text-sm text-rose-700 flex items-center gap-1.5">
            <AlertCircle className="w-4 h-4" /> {err}
          </div>
        )}

        {/* DROPDOWN de matches (busca por nome ou CPF parcial) */}
        {matches.length > 0 && !info && (
          <div className="mt-2 border rounded-lg overflow-hidden bg-white shadow-md">
            <div className="px-3 py-2 bg-slate-50 border-b text-[11px] uppercase font-bold tracking-wider text-slate-600">
              {matches.length} cliente(s) — clique pra abrir os marcados
            </div>
            <div className="max-h-[400px] overflow-y-auto">
              {matches.map((m) => (
                <button
                  key={`${m.loja || ''}:${m.codCliente}`}
                  type="button"
                  onClick={() => escolherCliente(m)}
                  className="w-full px-3 py-2.5 hover:bg-blue-50 border-b last:border-b-0 text-left flex items-center gap-3 transition"
                >
                  <div className="flex-1 min-w-0">
                    <div className="font-bold text-slate-900 truncate">{m.nome || '—'}</div>
                    <div className="text-xs text-slate-500 font-mono">{m.cpf || '—'}</div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-[10px] uppercase font-bold text-slate-500">Em marca</div>
                    {m.totalMarcados == null ? (
                      <div className="text-[11px] text-slate-400 italic">abre pra ver</div>
                    ) : (
                      <>
                        <div className="font-black text-rose-700 tabular-nums">{brl(m.totalMarcados)}</div>
                        <div className="text-[10px] text-slate-500">{m.qtdMarcados} peça(s)</div>
                      </>
                    )}
                  </div>
                  {m.classificacao === 'A' && (
                    <span className="text-[10px] font-black bg-emerald-600 text-white px-1.5 py-0.5 rounded">A</span>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}
        {searching && matches.length === 0 && query.trim().length >= 2 && (
          <div className="text-xs text-slate-500 mt-1 flex items-center gap-1.5">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> buscando…
          </div>
        )}
      </div>

      {/* Info do cliente */}
      {info && (
        <>
          <div className={`border-2 rounded-lg p-4 ${info.permitido ? 'border-emerald-300 bg-emerald-50' : 'border-amber-300 bg-amber-50'}`}>
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div>
                <div className="font-bold text-lg text-slate-800">
                  {info.cliente?.nome || '—'}
                </div>
                <div className="text-xs text-slate-600 font-mono">{info.cliente?.cpf}</div>
                <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
                  <span className={`px-2 py-1 rounded font-bold ${info.cliente?.classificacao === 'A' ? 'bg-emerald-600 text-white' : 'bg-slate-300 text-slate-800'}`}>
                    Classificação: {info.cliente?.classificacao || '—'}
                  </span>
                  <span className="text-slate-700">
                    Limite: <b>{brl(info.cliente?.limiteTotal || 0)}</b>
                  </span>
                  <span className="text-slate-700">
                    Em aberto: <b>{brl(info.totalMarcadosAtivos)}</b>
                  </span>
                  <span className={`font-bold ${info.limiteDisponivel > 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                    Disponível: {brl(info.limiteDisponivel)}
                  </span>
                </div>
              </div>
              {info.permitido ? (
                <span className="text-xs px-3 py-1.5 bg-emerald-600 text-white rounded font-bold">
                  ✓ Pode marcar
                </span>
              ) : (
                <span className="text-xs px-3 py-1.5 bg-amber-500 text-white rounded font-bold max-w-xs">
                  ⚠ {info.motivo}
                </span>
              )}
            </div>
            {/* Corrigir duplicados (admin) — marcação repetida no PDV */}
            {info.marcadosAtivos.length > 0 && (
              <div className="mt-3 pt-3 border-t border-emerald-200/60">
                <button
                  onClick={previewDedup}
                  disabled={dedupBusy}
                  className="text-xs px-3 py-1.5 rounded font-bold border border-amber-400 bg-white text-amber-700 hover:bg-amber-50 disabled:opacity-50"
                  title="Detecta marcações repetidas (mesma peça marcada várias vezes) e devolve as duplicadas ao estoque"
                >
                  {dedupBusy ? '⏳ Analisando…' : '🔧 Corrigir duplicados'}
                </button>
              </div>
            )}
          </div>

          {/* Plano de correção de duplicados (preview antes de aplicar) */}
          {dedupPlan && (
            <div className="border-2 border-amber-300 bg-amber-50 rounded-lg p-4">
              {dedupPlan.pecasRemovidas > 0 ? (
                <>
                  <div className="font-bold text-amber-900 mb-1">
                    Vão sobrar <b>{dedupPlan.produtosMantidos} produto(s)</b> — total{' '}
                    <b>{brl(dedupPlan.valorMantido || 0)}</b>.
                  </div>
                  <div className="text-sm text-amber-800 mb-3">
                    Vou <b>devolver ao estoque</b> {dedupPlan.pecasRemovidas} peça(s) duplicada(s){' '}
                    (<b>{brl(dedupPlan.valorRemovido || 0)}</b> das cópias).
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={aplicarDedup}
                      disabled={dedupBusy}
                      className="text-xs px-4 py-2 rounded font-bold bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50"
                    >
                      {dedupBusy ? '⏳ Aplicando…' : `Aplicar — deixar em ${brl(dedupPlan.valorMantido || 0)}`}
                    </button>
                    <button
                      onClick={() => setDedupPlan(null)}
                      className="text-xs px-4 py-2 rounded font-bold bg-white border text-slate-600 hover:bg-slate-50"
                    >
                      Cancelar
                    </button>
                  </div>
                </>
              ) : (
                <div className="text-sm text-emerald-800 flex items-center justify-between gap-2">
                  <span>✓ Nenhum produto duplicado — está tudo certo ({dedupPlan.produtosMantidos} produto(s)).</span>
                  <button onClick={() => setDedupPlan(null)} className="text-xs px-3 py-1 rounded border bg-white hover:bg-slate-50">OK</button>
                </div>
              )}
            </div>
          )}

          {/* Lista de marcados */}
          {info.marcadosAtivos.length === 0 ? (
            <div className="bg-white border rounded-lg p-6 text-center text-slate-500">
              Cliente não tem peças marcadas ativas.
            </div>
          ) : (
            <div className="bg-white border rounded-lg overflow-hidden">
              <div className="bg-slate-100 p-3 flex items-center justify-between flex-wrap gap-2">
                <div className="text-sm font-bold text-slate-700">
                  {info.marcadosAtivos.length} peça(s) marcada(s)
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={selectAll}
                    className="text-xs px-2 py-1 bg-white border rounded hover:bg-slate-50"
                  >
                    Marcar todas voltaram
                  </button>
                  <button
                    onClick={() => bipeRef.current?.focus()}
                    className="text-xs px-2 py-1 bg-white border rounded hover:bg-slate-50"
                    title="Voltar o cursor pro campo de bipe"
                  >
                    📷 Bipar
                  </button>
                  <button
                    onClick={selectNone}
                    className="text-xs px-2 py-1 bg-white border rounded hover:bg-slate-50"
                  >
                    Desmarcar todas
                  </button>
                </div>
              </div>

              {/* BIPE — o jeito rápido de marcar o que voltou. Fica no topo da
                  lista e recebe o foco sozinho, então a vendedora só passa o
                  leitor peça por peça. */}
              <div className="px-3 py-2 border-t bg-amber-50/60">
                <label className="block text-[10px] uppercase font-bold tracking-wider text-amber-900 mb-1">
                  Bipe a etiqueta da peça que voltou
                </label>
                <div className="flex items-center gap-2 flex-wrap">
                  <input
                    ref={bipeRef}
                    value={bipe}
                    autoFocus
                    onChange={(e) => setBipe(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        bipar(bipe);
                      }
                    }}
                    placeholder="Passe o leitor ou digite o código e dê Enter"
                    className="flex-1 min-w-[240px] px-3 py-2 border-2 border-amber-300 rounded-lg font-mono text-sm focus:outline-none focus:border-amber-500"
                  />
                  <button
                    type="button"
                    onClick={() => bipar(bipe)}
                    disabled={!bipe.trim()}
                    className="px-3 py-2 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-sm font-bold disabled:opacity-40"
                  >
                    Marcar
                  </button>
                  {bipeMsg && (
                    <span
                      className={`text-xs font-bold px-2 py-1 rounded ${
                        bipeMsg.tipo === 'ok'
                          ? 'bg-emerald-100 text-emerald-800'
                          : 'bg-rose-100 text-rose-800'
                      }`}
                    >
                      {bipeMsg.texto}
                    </span>
                  )}
                </div>
              </div>

              <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-[10px] uppercase font-bold text-slate-600">
                  <tr>
                    <th className="text-center p-2 w-16">Voltou</th>
                    <th className="text-left p-2">Data</th>
                    <th className="text-left p-2">SKU</th>
                    <th className="text-left p-2">Descrição</th>
                    <th className="text-center p-2">Qty</th>
                    <th className="text-right p-2">Valor</th>
                    <th className="text-left p-2">Loja</th>
                  </tr>
                </thead>
                <tbody>
                  {info.marcadosAtivos.map((m) => (
                    <tr
                      key={m.REGISTRO}
                      className={`border-t hover:bg-slate-50 cursor-pointer ${
                        ultimoBipado === m.REGISTRO
                          ? 'bg-emerald-100 ring-2 ring-emerald-400'
                          : voltadas.has(m.REGISTRO) ? 'bg-rose-50' : ''
                      }`}
                      onClick={() => toggleVoltada(m.REGISTRO)}
                    >
                      <td className="text-center p-2">
                        <input
                          type="checkbox"
                          checked={voltadas.has(m.REGISTRO)}
                          onChange={() => toggleVoltada(m.REGISTRO)}
                          onClick={(e) => e.stopPropagation()}
                          className="w-5 h-5"
                        />
                      </td>
                      <td className="p-2 text-xs">{fmtDate(m.DATA)}</td>
                      <td className="p-2 font-mono text-xs">{m.CODIGO}</td>
                      <td className="p-2 text-xs">{m.DESCRICAO}</td>
                      <td className="text-center p-2 tabular-nums">{m.QUANTIDADE}</td>
                      <td className="text-right p-2 tabular-nums font-bold">{brl(m.VALORTOTAL || m.VALOR)}</td>
                      <td className="p-2 text-xs">{m.LOJA}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>

              {/* Footer com totais e ação */}
              <div className="bg-slate-50 p-3 flex items-center justify-between flex-wrap gap-3">
                <div className="text-sm">
                  <span className="text-slate-600">Selecionadas: </span>
                  <b>{voltadas.size}</b> peça(s) ·
                  <span className="text-slate-600 ml-2">Valor: </span>
                  <b className="text-emerald-700">{brl(valorVoltadas)}</b>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={puxarParaVenda}
                    disabled={puxando || processing || voltadas.size === 0}
                    title="Cobrar essas pecas no PDV — abre uma venda nova com elas"
                    className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 text-white font-bold rounded flex items-center gap-2 shadow-md"
                  >
                    {puxando ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShoppingCart className="w-4 h-4" />}
                    Puxar pra venda no PDV ({voltadas.size})
                  </button>
                  <button
                    onClick={processarDevolucao}
                    disabled={processing || puxando || voltadas.size === 0}
                    title="Devolver essas pecas ao estoque (cliente trouxe de volta)"
                    className="px-4 py-2 bg-rose-600 hover:bg-rose-700 disabled:opacity-40 text-white font-bold rounded flex items-center gap-2"
                  >
                    {processing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                    Devolver ao estoque ({voltadas.size})
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Resultado processamento */}
          {processResult && (
            <div className={`border-2 rounded-lg p-4 ${processResult.falhas.length === 0 ? 'border-emerald-300 bg-emerald-50' : 'border-amber-300 bg-amber-50'}`}>
              <div className="font-bold flex items-center gap-2">
                <Check className="w-5 h-5" />
                {processResult.ok} peça(s) devolvida(s) ao estoque
              </div>
              {processResult.falhas.length > 0 && (
                <div className="mt-2 text-sm">
                  <div className="font-bold text-amber-800">{processResult.falhas.length} falha(s):</div>
                  <ul className="list-disc ml-5 text-xs mt-1">
                    {processResult.falhas.map((f, i) => <li key={i}>{f}</li>)}
                  </ul>
                </div>
              )}
              <div className="mt-3 text-xs text-slate-600">
                💡 As peças que <b>não foram marcadas</b> continuam como "marcadas" pro cliente.
                Pra cobrar as que ficaram, vai pro <Link href="/minha-loja/pdv" className="text-blue-600 underline">PDV</Link> e bipa elas como uma venda nova.
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
