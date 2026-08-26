'use client';

/**
 * TrocaPecaModal — troca de peça do pedido PELA RETAGUARDA, com o dinheiro
 * fechando junto.
 *
 * Por que não reaproveitar o SwapModal da loja: lá a troca é do balcão (mesmo
 * preço ou senha de gerente) e ele é usado pela `/minha-loja` — mudar o
 * comportamento dele mexeria na separação da vendedora. Aqui a matriz precisa
 * ver o acerto ANTES de confirmar: peça mais cara vira link de pagamento (e a
 * separação TRAVA até a cliente pagar), peça mais barata vira vale nominal no
 * CPF, mesmo preço é troca seca.
 *
 * Fluxo em 3 passos:
 *   1. BUSCAR   — /products/erp-search (debounce 300ms, mesmo endpoint do PDV).
 *   2. ACERTO   — /orders/wc/:wcId/swap-item/preview: sai X / entra Y, estoque
 *                 na rede e o valor do acerto (EDITÁVEL — quem manda no
 *                 dinheiro é a matriz, a sugestão é só o ponto de partida).
 *   3. RESULTADO— /orders/wc/:wcId/swap-item aplicou: mostra o link de
 *                 pagamento (com copiar) ou o código do vale. Se o acerto
 *                 falhou, a TROCA JÁ FOI — o erro precisa dizer isso.
 *
 * Pegadinha da casa: componente com <input> declarado dentro de outro
 * componente remonta a cada tecla e o campo perde o foco. Por isso os
 * subcomponentes daqui moram no escopo do MÓDULO, nunca dentro do default
 * export.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { overlayClose } from '@/lib/overlayClose';
import {
  X, Search, ArrowRight, AlertTriangle, CheckCircle2, Copy, Check, Loader2, Lock,
} from 'lucide-react';

type ErpSearchHit = {
  CODIGO: string;
  REF: string;
  DESCRICAOCOMPLETA?: string;
  COR?: string | null;
  TAMANHO?: string | null;
  ESTOQUE?: number;
  qtyMyStore?: number;
  qtyTotal?: number;
};

type TipoAcerto = 'cobranca' | 'vale' | 'neutro';

type PreviewTroca = {
  ok: boolean;
  bloqueio: string | null;
  /** Peça separada/bipada: pode trocar, mas a troca desfaz a separação. */
  aviso?: string | null;
  item: {
    id: string; sku: string; nome: string; qty: number; precoPago: number;
    ref?: string | null; cor?: string | null; tamanho?: string | null;
  };
  nova: {
    sku: string; nome: string; ref?: string | null; cor?: string | null; tamanho?: string | null;
    precoErp: number; precoSite: number; motivoDoPreco: string;
    estoqueRede: number;
    lojasComEstoque: Array<{ storeCode: string; qty: number }>;
  };
  diferencaSugerida: number;
  tipoSugerido: TipoAcerto;
  clienteTemCpf: boolean;
};

type ResultadoTroca = {
  ok: boolean;
  swapId: string;
  tipo: TipoAcerto;
  diferenca: number;
  novoItem: { sku: string; nome: string; precoUnit: number };
  cobranca?: { shortUrl?: string; expiresAt?: string; valor?: number; erro?: string } | null;
  vale?: { code?: string; valor?: number; validoAte?: string; erro?: string } | null;
  reroteado?: any;
};

/** Mesmo formato de dinheiro da página do pedido (fmtMoney vive lá dentro). */
const fmtMoney = (v: number | string | undefined) =>
  `R$ ${Number(v ?? 0).toFixed(2).replace('.', ',')}`;

const fmtData = (iso?: string | null) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '—' : d.toLocaleString('pt-BR');
};

/**
 * A matriz digita em pt-BR ("-12,50", "1.500,00"). O SEPARADOR DE MILHAR é o
 * detalhe que custa dinheiro: trocar só a vírgula deixava "1.500,00" virar
 * "1.500.00" → NaN → 0, e a peça mais cara sairia de graça. Regra: o ÚLTIMO
 * separador é o decimal; tudo antes dele é milhar e cai fora. O sinal fica,
 * porque é ele que diz se cobra ou devolve.
 */
function parseValor(txt: string): number {
  const bruto = String(txt).replace(/\s/g, '');
  const negativo = bruto.trim().startsWith('-');
  const soDigitosESeparadores = bruto.replace(/[^0-9.,]/g, '');
  const ultimoSep = Math.max(soDigitosESeparadores.lastIndexOf(','), soDigitosESeparadores.lastIndexOf('.'));
  let normalizado: string;
  if (ultimoSep < 0) {
    normalizado = soDigitosESeparadores;
  } else {
    const inteiro = soDigitosESeparadores.slice(0, ultimoSep).replace(/[.,]/g, '');
    const decimal = soDigitosESeparadores.slice(ultimoSep + 1).replace(/[.,]/g, '');
    // "1.500" (milhar, sem centavos) não pode virar 1,50: só é decimal com 1-2 casas.
    normalizado = decimal.length > 0 && decimal.length <= 2 ? `${inteiro}.${decimal}` : `${inteiro}${decimal}`;
  }
  const n = Number(normalizado);
  if (!isFinite(n)) return 0;
  return Math.round((negativo ? -n : n) * 100) / 100;
}

/** Tipo do acerto pelo valor DIGITADO — o sugerido é só o ponto de partida. */
function tipoPeloValor(v: number): TipoAcerto {
  if (v > 0.009) return 'cobranca';
  if (v < -0.009) return 'vale';
  return 'neutro';
}

/** `api` joga Error("<status>: <corpo JSON>") — aqui sai a mensagem legível. */
function msgDoErro(e: any, padrao: string): string {
  const raw = String(e?.message || '');
  try {
    const j = e?.body ?? JSON.parse(raw.slice(raw.indexOf(': ') + 2));
    if (j?.message) return Array.isArray(j.message) ? j.message[0] : String(j.message);
  } catch { /* corpo não-JSON: usa o texto cru */ }
  return raw || padrao;
}

const rotuloPeca = (h: ErpSearchHit) =>
  [
    (h.DESCRICAOCOMPLETA || h.REF || h.CODIGO).trim(),
    [h.COR, h.TAMANHO].filter(Boolean).join(' '),
  ].filter(Boolean).join(' · ');

// ── Subcomponentes (escopo do módulo — ver cabeçalho) ────────────────────

/** Uma linha do resultado da busca. */
function LinhaResultado({
  hit, selecionado, onPick, disabled,
}: {
  hit: ErpSearchHit;
  selecionado: boolean;
  onPick: (h: ErpSearchHit) => void;
  disabled: boolean;
}) {
  // Retaguarda enxerga a REDE inteira (qtyTotal); os outros campos são
  // fallback pro shape antigo do endpoint.
  const estoque = Number(hit.qtyTotal ?? hit.ESTOQUE ?? hit.qtyMyStore) || 0;
  return (
    <button
      type="button"
      onClick={() => onPick(hit)}
      disabled={disabled}
      className={`w-full text-left px-3 py-2.5 hover:bg-[#FBF6E6] disabled:opacity-50 flex items-start gap-3 ${
        selecionado ? 'bg-[#FBF6E6]' : ''
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-slate-800 truncate">
          {(hit.DESCRICAOCOMPLETA || hit.REF || hit.CODIGO).trim()}
        </div>
        <div className="text-xs text-slate-500">
          {hit.REF ? `REF ${hit.REF}` : ''}
          {hit.COR ? ` · ${hit.COR}` : ''}
          {hit.TAMANHO ? ` ${hit.TAMANHO}` : ''}
          <span className="font-mono text-slate-400"> · cód {hit.CODIGO}</span>
        </div>
      </div>
      <span
        className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${
          estoque > 0 ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'
        }`}
        title="Estoque na rede"
      >
        {estoque} un
      </span>
    </button>
  );
}

/**
 * A faixa que explica o dinheiro. O tipo vem do valor DIGITADO — se a matriz
 * inverte o sinal, a faixa muda junto (senão a tela promete uma coisa e o
 * backend faz outra).
 */
function FaixaAcerto({
  tipo, valor, clienteTemCpf,
}: {
  tipo: TipoAcerto;
  valor: number;
  clienteTemCpf: boolean;
}) {
  if (tipo === 'cobranca') {
    return (
      <div className="rounded-lg border-2 border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
        <b>Cliente paga a diferença de {fmtMoney(Math.abs(valor))}</b> — vai sair um link de
        pagamento e a separação fica travada até ela pagar.
      </div>
    );
  }
  if (tipo === 'vale') {
    if (!clienteTemCpf) {
      return (
        <div className="rounded-lg border-2 border-red-300 bg-red-50 px-3 py-2.5 text-sm text-red-800">
          <b>Este pedido não tem CPF</b> — o vale é nominal e o sistema recusa emitir sem dono.
          Preencha o CPF da cliente no pedido antes de fazer a troca (ou zere o acerto).
        </div>
      );
    }
    return (
      <div className="rounded-lg border-2 border-emerald-300 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-900">
        <b>Vale de {fmtMoney(Math.abs(valor))} no CPF da cliente</b> — vale no site e na loja.
      </div>
    );
  }
  return (
    <div className="rounded-lg border-2 border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700">
      Mesmo preço, sem acerto.
    </div>
  );
}

/** Botão de copiar com confirmação visual (o link vai pro WhatsApp da cliente). */
function BotaoCopiar({ texto }: { texto: string }) {
  const [copiado, setCopiado] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(texto);
          setCopiado(true);
          setTimeout(() => setCopiado(false), 2000);
        } catch { /* navegador sem permissão: a pessoa copia na mão pelo campo */ }
      }}
      className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border-2 border-[#E6DFC8] bg-white px-2.5 py-1.5 text-xs font-semibold text-[#8C7325] hover:bg-[#FBF6E6]"
    >
      {copiado ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
      {copiado ? 'Copiado' : 'Copiar link'}
    </button>
  );
}

// ── Modal ────────────────────────────────────────────────────────────────

export default function TrocaPecaModal({
  wcId,
  orderItemId,
  currentLabel,
  onDone,
  onClose,
}: {
  wcId: string;
  orderItemId: string;
  /** Peça que SAI, já formatada pela página (REF · COR TAM). */
  currentLabel: string;
  /** Troca aplicada — a página recarrega pedido, cards e acertos. */
  onDone: () => void;
  onClose: () => void;
}) {
  const [passo, setPasso] = useState<'buscar' | 'acerto' | 'resultado'>('buscar');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ErpSearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<ErpSearchHit | null>(null);

  const [preview, setPreview] = useState<PreviewTroca | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [valorTxt, setValorTxt] = useState('0');
  const [motivo, setMotivo] = useState('');

  const [resultado, setResultado] = useState<ResultadoTroca | null>(null);
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  // Busca no espelho (debounce 300ms). q com 2+ chars, teto de 40 linhas.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const term = query.trim();
    if (term.length < 2) { setResults([]); setLoading(false); return; }
    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await api<ErpSearchHit[]>(`/products/erp-search?q=${encodeURIComponent(term)}`);
        setResults(Array.isArray(res) ? res.slice(0, 40) : []);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query]);

  // Quem manda no acerto é o valor DIGITADO (a sugestão do preview é só o
  // ponto de partida) — daí o tipo sair daqui e não do `tipoSugerido`.
  const valorNum = useMemo(() => parseValor(valorTxt), [valorTxt]);
  const tipoAtual = tipoPeloValor(valorNum);

  /** Escolheu a peça nova → pergunta o acerto ao backend antes de mostrar nada. */
  async function pedirPreview(hit: ErpSearchHit) {
    setSelected(hit);
    setErro(null);
    setPreviewBusy(true);
    setPasso('acerto');
    try {
      const p = await api<PreviewTroca>(`/orders/wc/${wcId}/swap-item/preview`, {
        method: 'POST',
        body: JSON.stringify({ orderItemId, codigo: hit.CODIGO }),
      });
      setPreview(p);
      // Sugestão já preenchida — em pt-BR, do jeito que ela vai ser relida.
      setValorTxt(Number(p?.diferencaSugerida ?? 0).toFixed(2).replace('.', ','));
    } catch (e: any) {
      setPreview(null);
      setErro(msgDoErro(e, 'Não deu pra calcular o acerto dessa troca.'));
    } finally {
      setPreviewBusy(false);
    }
  }

  async function confirmar() {
    if (!preview || !selected) return;
    setBusy(true);
    setErro(null);
    try {
      const r = await api<ResultadoTroca>(`/orders/wc/${wcId}/swap-item`, {
        method: 'POST',
        body: JSON.stringify({
          orderItemId,
          codigo: selected.CODIGO,
          diferenca: valorNum,
          ...(motivo.trim() ? { motivo: motivo.trim() } : {}),
        }),
      });
      setResultado(r);
      setPasso('resultado');
    } catch (e: any) {
      setErro(msgDoErro(e, 'Não foi possível trocar a peça.'));
    } finally {
      setBusy(false);
    }
  }

  const bloqueio = preview?.bloqueio ?? null;
  const novaLabel = selected ? rotuloPeca(selected) : '';
  /**
   * Vale sem CPF o backend RECUSA — e a troca já teria sido aplicada, ficando
   * a cliente sem o troco e o pedido com um acerto pela metade. Melhor não
   * deixar clicar: primeiro preenche o CPF no pedido, depois troca.
   */
  const valeSemCpf = tipoAtual === 'vale' && preview?.clienteTemCpf === false;

  /**
   * Fechar DEPOIS de trocar tem que recarregar a tela igual ao botão Fechar:
   * a peça já mudou, os cards já foram refeitos e o acerto já existe. Sem
   * isto, o X e o clique no fundo deixavam a tabela mostrando a peça velha e
   * o aviso de separação travada escondido até alguém dar F5.
   */
  const fechar = () => {
    if (resultado) onDone();
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/40 p-4 pt-10 sm:pt-16"
      {...overlayClose(fechar)}
    >
      <div className="w-full max-w-xl rounded-2xl bg-[#FAFAF7] shadow-2xl border border-[#E6DFC8] overflow-hidden">
        {/* Cabeçalho */}
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-[#E6DFC8] bg-white">
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-wide font-bold text-[#8C7325]">
              Trocar peça — com acerto do dinheiro
            </div>
            <div className="text-sm text-slate-600 truncate">
              Saindo: <span className="font-semibold text-slate-800">{currentLabel}</span>
            </div>
          </div>
          <button
            onClick={fechar}
            className="shrink-0 rounded-lg p-2 text-slate-500 hover:bg-slate-100"
            title="Fechar"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 space-y-3 max-h-[75vh] overflow-y-auto">
          {/* ── PASSO 1 · BUSCAR ─────────────────────────────────────── */}
          {passo === 'buscar' && (
            <>
              <div className="relative">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  ref={inputRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Buscar peça nova (código, ref ou descrição)…"
                  className="w-full rounded-lg border border-[#E6DFC8] bg-white py-2.5 pl-9 pr-3 text-sm outline-none focus:border-[#D4AF37] focus:ring-2 focus:ring-[#FBF6E6]"
                />
              </div>

              <div className="max-h-72 overflow-y-auto rounded-lg border border-[#E6DFC8] bg-white divide-y divide-slate-50">
                {loading && <div className="px-3 py-4 text-sm text-slate-400">Buscando…</div>}
                {!loading && query.trim().length < 2 && (
                  <div className="px-3 py-4 text-sm text-slate-400">
                    Digite ao menos 2 caracteres pra buscar.
                  </div>
                )}
                {!loading && query.trim().length >= 2 && results.length === 0 && (
                  <div className="px-3 py-4 text-sm text-slate-400">Nenhuma peça encontrada.</div>
                )}
                {!loading && results.map((r) => (
                  <LinhaResultado
                    key={r.CODIGO}
                    hit={r}
                    selecionado={selected?.CODIGO === r.CODIGO}
                    onPick={pedirPreview}
                    disabled={previewBusy}
                  />
                ))}
              </div>
            </>
          )}

          {/* ── PASSO 2 · ACERTO ─────────────────────────────────────── */}
          {passo === 'acerto' && (
            <>
              {previewBusy && (
                <div className="flex items-center gap-2 px-3 py-6 text-sm text-slate-500">
                  <Loader2 className="w-4 h-4 animate-spin" /> Calculando o acerto…
                </div>
              )}

              {!previewBusy && preview && (
                <>
                  {/* Sai / Entra */}
                  <div className="rounded-lg border border-[#E6DFC8] bg-white p-3 space-y-2 text-sm">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-[11px] uppercase font-bold text-slate-400">Sai</div>
                        <div className="font-semibold text-slate-800 truncate">{currentLabel}</div>
                      </div>
                      <div className="shrink-0 text-right text-slate-600">
                        pagou <b className="text-slate-800">{fmtMoney(preview.item.precoPago)}</b>
                        {preview.item.qty > 1 && (
                          <span className="block text-xs text-slate-400">{preview.item.qty} un</span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 text-slate-300">
                      <ArrowRight className="w-4 h-4" />
                      <div className="h-px flex-1 bg-slate-100" />
                    </div>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-[11px] uppercase font-bold text-slate-400">Entra</div>
                        <div className="font-semibold text-slate-800 truncate">
                          {novaLabel || preview.nova.nome}
                        </div>
                        <div className="font-mono text-xs text-slate-400">{preview.nova.sku}</div>
                      </div>
                      <div className="shrink-0 text-right text-slate-600">
                        <b className="text-slate-800">{fmtMoney(preview.nova.precoSite)}</b>
                        <span className="block text-xs text-slate-400">{preview.nova.motivoDoPreco}</span>
                      </div>
                    </div>
                  </div>

                  {/* Estoque na rede — trocar por peça que ninguém tem é criar
                      ruptura na linha seguinte. */}
                  {preview.nova.estoqueRede === 0 ? (
                    <div className="flex items-start gap-2 rounded-lg border-2 border-red-300 bg-red-50 px-3 py-2.5 text-sm text-red-800">
                      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                      <div>
                        <b>Nenhuma loja da rede tem essa peça.</b> A troca vai deixar o pedido sem
                        quem separe — confira o estoque antes.
                      </div>
                    </div>
                  ) : (
                    <div className="text-xs text-slate-500">
                      Estoque na rede: <b className="text-slate-700">{preview.nova.estoqueRede} un</b>
                      {preview.nova.lojasComEstoque?.length > 0 && (
                        <> · {preview.nova.lojasComEstoque.map((l) => `${l.storeCode} (${l.qty})`).join(', ')}</>
                      )}
                    </div>
                  )}

                  {/* O dinheiro */}
                  <FaixaAcerto tipo={tipoAtual} valor={valorNum} clienteTemCpf={preview.clienteTemCpf} />

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <label className="block">
                      <span className="block text-xs font-semibold text-slate-600 mb-1">
                        Valor do acerto (R$)
                      </span>
                      <input
                        value={valorTxt}
                        onChange={(e) => setValorTxt(e.target.value)}
                        inputMode="decimal"
                        placeholder="0,00"
                        className="w-full rounded-lg border border-[#E6DFC8] bg-white px-3 py-2 text-sm tabular-nums outline-none focus:border-[#D4AF37] focus:ring-2 focus:ring-[#FBF6E6]"
                      />
                      <span className="block text-[11px] text-slate-400 mt-1">
                        Positivo cobra da cliente · negativo vira vale · 0 não acerta nada.
                        Sugerido: {fmtMoney(preview.diferencaSugerida)}
                      </span>
                    </label>
                    <label className="block">
                      <span className="block text-xs font-semibold text-slate-600 mb-1">
                        Motivo (opcional)
                      </span>
                      <input
                        value={motivo}
                        onChange={(e) => setMotivo(e.target.value)}
                        placeholder="Ex: peça com defeito, cliente pediu outra cor…"
                        className="w-full rounded-lg border border-[#E6DFC8] bg-white px-3 py-2 text-sm outline-none focus:border-[#D4AF37] focus:ring-2 focus:ring-[#FBF6E6]"
                      />
                    </label>
                  </div>

                  {/* Bloqueio: a peça já SAIU (postada/caixa de juntada/NF-e). */}
                  {bloqueio && (
                    <div className="flex items-start gap-2 rounded-lg border-2 border-red-300 bg-red-50 px-3 py-2.5 text-sm text-red-800">
                      <Lock className="w-4 h-4 shrink-0 mt-0.5" />
                      <div><b>Não dá pra trocar:</b> {bloqueio}</div>
                    </div>
                  )}

                  {/* Aviso (26/08): separada/bipada TROCA — mas desfaz a
                      separação da loja. A matriz confirma sabendo. */}
                  {!bloqueio && preview?.aviso && (
                    <div className="flex items-start gap-2 rounded-lg border-2 border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-800">
                      <Lock className="w-4 h-4 shrink-0 mt-0.5" />
                      <div><b>Atenção:</b> {preview.aviso}</div>
                    </div>
                  )}

                  <div className="flex gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => { setPasso('buscar'); setPreview(null); setSelected(null); setErro(null); }}
                      disabled={busy}
                      className="rounded-lg border-2 border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                    >
                      Voltar
                    </button>
                    <button
                      type="button"
                      onClick={confirmar}
                      disabled={busy || !!bloqueio || valeSemCpf}
                      title={valeSemCpf ? 'Preencha o CPF da cliente no pedido antes — o vale é nominal.' : undefined}
                      className="flex-1 rounded-lg bg-[#B8912B] px-3 py-2 text-sm font-bold text-white hover:bg-[#8C7325] disabled:opacity-50"
                    >
                      {busy
                        ? 'Trocando…'
                        : valeSemCpf
                          ? 'Sem CPF não dá pra emitir o vale'
                          : tipoAtual === 'cobranca'
                            ? `Trocar e cobrar ${fmtMoney(Math.abs(valorNum))}`
                            : tipoAtual === 'vale'
                              ? `Trocar e dar vale de ${fmtMoney(Math.abs(valorNum))}`
                              : 'Trocar sem acerto'}
                    </button>
                  </div>
                </>
              )}

              {!previewBusy && !preview && (
                <button
                  type="button"
                  onClick={() => { setPasso('buscar'); setErro(null); }}
                  className="rounded-lg border-2 border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
                >
                  Voltar pra busca
                </button>
              )}
            </>
          )}

          {/* ── PASSO 3 · RESULTADO ──────────────────────────────────── */}
          {passo === 'resultado' && resultado && (
            <>
              <div className="flex items-center gap-2 rounded-lg bg-emerald-50 border-2 border-emerald-200 px-3 py-3 text-emerald-800 font-semibold">
                <CheckCircle2 className="w-5 h-5 shrink-0" />
                <span>
                  Peça trocada por <b>{resultado.novoItem?.nome || resultado.novoItem?.sku}</b> —
                  agora vale {fmtMoney(resultado.novoItem?.precoUnit)}.
                </span>
              </div>

              {/* Cobrança */}
              {resultado.cobranca?.shortUrl && (
                <div className="rounded-lg border-2 border-amber-300 bg-amber-50 p-3 space-y-2">
                  <div className="text-sm text-amber-900 font-semibold">
                    Link de {fmtMoney(resultado.cobranca.valor ?? Math.abs(resultado.diferenca))} pra
                    cliente pagar a diferença
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      readOnly
                      value={resultado.cobranca.shortUrl}
                      onFocus={(e) => e.currentTarget.select()}
                      className="flex-1 min-w-0 rounded-lg border border-amber-300 bg-white px-3 py-2 text-xs font-mono text-slate-700"
                    />
                    <BotaoCopiar texto={resultado.cobranca.shortUrl} />
                  </div>
                  <div className="text-xs text-amber-800">
                    🔒 A separação está <b>travada</b> até o pagamento cair. Link válido até{' '}
                    {fmtData(resultado.cobranca.expiresAt)}.
                  </div>
                </div>
              )}
              {resultado.cobranca?.erro && (
                <div className="rounded-lg border-2 border-red-300 bg-red-50 px-3 py-2.5 text-sm text-red-800">
                  <b>A troca FOI aplicada, mas o link de pagamento não saiu:</b>{' '}
                  {resultado.cobranca.erro}. Gere a cobrança por fora ou libere sem cobrar no painel
                  de acertos do pedido.
                </div>
              )}

              {/* Vale */}
              {resultado.vale?.code && (
                <div className="rounded-lg border-2 border-emerald-300 bg-emerald-50 p-3 space-y-1">
                  <div className="text-sm text-emerald-900 font-semibold">
                    Vale de {fmtMoney(resultado.vale.valor ?? Math.abs(resultado.diferenca))} emitido
                    no CPF da cliente
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-base font-bold text-emerald-900">
                      {resultado.vale.code}
                    </span>
                    <BotaoCopiar texto={resultado.vale.code} />
                  </div>
                  <div className="text-xs text-emerald-800">
                    Vale no site e no caixa da loja até {fmtData(resultado.vale.validoAte)}.
                  </div>
                </div>
              )}
              {resultado.vale?.erro && (
                <div className="rounded-lg border-2 border-red-300 bg-red-50 px-3 py-2.5 text-sm text-red-800">
                  <b>A troca FOI aplicada, mas o vale não foi emitido:</b> {resultado.vale.erro}
                </div>
              )}

              {resultado.tipo === 'neutro' && (
                <div className="rounded-lg border-2 border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700">
                  Sem diferença de valor — nada a cobrar nem a devolver.
                </div>
              )}

              <button
                type="button"
                onClick={() => { onDone(); onClose(); }}
                className="w-full rounded-lg bg-[#B8912B] px-3 py-2.5 text-sm font-bold text-white hover:bg-[#8C7325]"
              >
                Fechar
              </button>
            </>
          )}

          {erro && (
            <div className="rounded-lg bg-red-50 border-2 border-red-200 px-3 py-2 text-sm text-red-700">
              {erro}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
