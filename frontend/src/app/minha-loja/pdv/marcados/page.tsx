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

export default function MarcadosPage() {
  const router = useRouter();
  const [cpf, setCpf] = useState('');
  const [info, setInfo] = useState<ClienteInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [voltadas, setVoltadas] = useState<Set<number>>(new Set());
  const [processing, setProcessing] = useState(false);
  const [puxando, setPuxando] = useState(false);
  const [processResult, setProcessResult] = useState<{ ok: number; falhas: string[] } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  async function buscar() {
    setErr(null);
    setInfo(null);
    setVoltadas(new Set());
    setProcessResult(null);
    const cpfLimpo = cpf.replace(/\D/g, '');
    if (cpfLimpo.length !== 11) {
      setErr('CPF inválido — digite os 11 dígitos');
      return;
    }
    setBusy(true);
    try {
      const r = await api<ClienteInfo>(`/pdv/marcados/cliente?cpf=${cpfLimpo}`);
      setInfo(r);
    } catch (e: any) {
      setErr(e?.message || 'Falha ao buscar cliente');
    } finally {
      setBusy(false);
    }
  }

  function toggleVoltada(registro: number) {
    setVoltadas((prev) => {
      const next = new Set(prev);
      if (next.has(registro)) next.delete(registro);
      else next.add(registro);
      return next;
    });
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

      {/* Busca por CPF */}
      <div className="bg-white border rounded-lg p-4 space-y-2">
        <label className="block text-sm font-bold text-slate-700">CPF do cliente</label>
        <div className="flex gap-2">
          <input
            ref={inputRef}
            type="text"
            inputMode="numeric"
            value={cpf}
            onChange={(e) => setCpf(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && buscar()}
            placeholder="Só números ou com . e -"
            maxLength={14}
            className="flex-1 border rounded px-3 py-2 text-base font-mono"
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
          </div>

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
                    onClick={selectNone}
                    className="text-xs px-2 py-1 bg-white border rounded hover:bg-slate-50"
                  >
                    Desmarcar todas
                  </button>
                </div>
              </div>

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
                      className={`border-t hover:bg-slate-50 cursor-pointer ${voltadas.has(m.REGISTRO) ? 'bg-rose-50' : ''}`}
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
