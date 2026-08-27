'use client';

/**
 * /retaguarda/pecas-extraviadas — A FILA DAS PEÇAS QUE NINGUÉM ACHOU.
 *
 * Quando a loja diz "não achei", o sistema NÃO zera mais o estoque dela (isso
 * apagava inventário de verdade na palavra de uma pessoa). O que ele faz é
 * marcar a peça como EXTRAVIADA naquela loja: o saldo fica, mas ela sai do
 * roteamento pra aquele SKU.
 *
 * O risco desse desenho é a marca virar lixo eterno — peça marcada em 40 lojas,
 * ninguém revisando, e o roteamento perdendo opção pra sempre. Esta tela existe
 * pra isso não acontecer: mostra o que está marcado, há quanto tempo, e dá o
 * caminho de volta num clique.
 *
 * "Achei" NÃO apaga a linha: ela ganha data de encontrada e sai da fila. Peça
 * que vive sumindo e reaparecendo é sintoma de arara bagunçada, e é justamente
 * isso que o histórico denuncia.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, RefreshCw, Loader2, PackageX, Check, Search } from 'lucide-react';
import { api } from '@/lib/api';

type Extraviada = {
  id: string;
  storeCode: string;
  storeName: string | null;
  sku: string;
  qty: number;
  rotulo: string;
  ref: string | null;
  descricao: string | null;
  motivo: string | null;
  nota: string | null;
  pedido: string | null;
  marcadaEm: string;
  achadaEm: string | null;
  diasParada: number;
};

const fmtData = (iso: string) =>
  new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

export default function PecasExtraviadasPage() {
  const router = useRouter();
  const [allowed, setAllowed] = useState(false);
  const [linhas, setLinhas] = useState<Extraviada[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [achando, setAchando] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [loja, setLoja] = useState('');
  const [mostrarAchadas, setMostrarAchadas] = useState(false);
  const [lojas, setLojas] = useState<Array<{ code: string; name: string }>>([]);

  useEffect(() => {
    api<{ role: string }>('/auth/me')
      .then((u) => {
        if (['admin', 'operator', 'supervisor'].includes(u.role)) setAllowed(true);
        else router.replace('/retaguarda');
      })
      .catch(() => router.replace('/login'));
    api<Array<{ code: string; name: string }>>('/stores').then(setLojas).catch(() => {});
  }, [router]);

  const carregar = async () => {
    setCarregando(true);
    setErro('');
    try {
      const p = new URLSearchParams();
      if (loja) p.set('loja', loja);
      if (mostrarAchadas) p.set('todas', '1');
      setLinhas(await api<Extraviada[]>(`/pecas-extraviadas?${p.toString()}`));
    } catch (e: any) {
      setErro(e?.message || 'Não consegui carregar a lista.');
    } finally {
      setCarregando(false);
    }
  };

  useEffect(() => {
    if (allowed) void carregar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowed, loja, mostrarAchadas]);

  const achei = async (l: Extraviada) => {
    if (!window.confirm(
      `Confirmar que a peça FOI ENCONTRADA?\n\n${l.rotulo}\nLoja ${l.storeCode}${l.storeName ? ` · ${l.storeName}` : ''}\n\n` +
      'Ela volta a ser escolhida pelo sistema nos próximos pedidos.',
    )) return;
    setAchando(l.id);
    try {
      await api(`/pecas-extraviadas/${l.id}/achei`, { method: 'POST' });
      await carregar();
    } catch (e: any) {
      alert(`Não consegui marcar como encontrada: ${e?.message || e}`);
    } finally {
      setAchando(null);
    }
  };

  const visiveis = useMemo(() => {
    const termo = q.trim().toLowerCase();
    if (!termo) return linhas;
    return linhas.filter((l) =>
      [l.rotulo, l.sku, l.descricao, l.storeName, l.storeCode, l.pedido]
        .filter(Boolean)
        .some((c) => String(c).toLowerCase().includes(termo)),
    );
  }, [linhas, q]);

  const abertas = visiveis.filter((l) => !l.achadaEm);
  const velhas = abertas.filter((l) => l.diasParada >= 7).length;

  if (!allowed) return null;

  return (
    <div className="min-h-screen bg-slate-50 p-4 md:p-6">
      <div className="mx-auto max-w-6xl">
        <Link href="/retaguarda" className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-600 hover:text-slate-900">
          <ArrowLeft className="h-4 w-4" /> Retaguarda
        </Link>

        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-bold text-slate-900">
              <PackageX className="h-5 w-5 text-red-600" /> Peças extraviadas
            </h1>
            <p className="mt-1 max-w-2xl text-sm text-slate-600">
              A loja procurou e não achou. O <b>estoque dela não foi alterado</b> — o que muda é que
              o sistema deixa de escolhê-la pra essa peça. Se a peça aparecer, marque como
              encontrada e ela volta ao jogo.
            </p>
          </div>
          <button
            onClick={carregar}
            disabled={carregando}
            className="inline-flex items-center gap-1.5 rounded-lg border bg-white px-3 py-2 text-sm font-semibold hover:bg-slate-50 disabled:opacity-50"
          >
            {carregando ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Atualizar
          </button>
        </div>

        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Buscar peça, SKU, loja ou pedido…"
              className="w-72 rounded-lg border py-2 pl-8 pr-3 text-sm"
            />
          </div>
          <select value={loja} onChange={(e) => setLoja(e.target.value)} className="rounded-lg border px-3 py-2 text-sm">
            <option value="">Todas as lojas</option>
            {lojas.map((l) => (
              <option key={l.code} value={l.code}>{l.code} · {l.name}</option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 text-sm text-slate-600">
            <input type="checkbox" checked={mostrarAchadas} onChange={(e) => setMostrarAchadas(e.target.checked)} />
            mostrar as já encontradas
          </label>
          <span className="ml-auto text-sm text-slate-600">
            <b className="text-slate-900">{abertas.length}</b> em aberto
            {velhas > 0 && <span className="ml-2 text-red-700">· {velhas} há mais de 7 dias</span>}
          </span>
        </div>

        {erro && <div className="mb-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{erro}</div>}

        <div className="overflow-x-auto rounded-xl border bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left">Peça</th>
                <th className="px-3 py-2 text-left">SKU</th>
                <th className="px-3 py-2 text-left">Loja</th>
                <th className="px-3 py-2 text-right">Qtd</th>
                <th className="px-3 py-2 text-left">Marcada</th>
                <th className="px-3 py-2 text-left">Veio do pedido</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {visiveis.map((l) => (
                <tr key={l.id} className={`border-t ${l.achadaEm ? 'opacity-50' : ''}`}>
                  <td className="px-3 py-2">
                    <div className="font-semibold text-slate-900">{l.rotulo}</div>
                    {l.descricao && <div className="max-w-xs truncate text-xs text-slate-500">{l.descricao}</div>}
                    {l.nota && <div className="mt-0.5 text-xs italic text-slate-500">“{l.nota}”</div>}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-500">{l.sku}</td>
                  <td className="px-3 py-2 text-xs">
                    <span className="font-semibold">{l.storeCode}</span>
                    {l.storeName && <span className="text-slate-500"> · {l.storeName}</span>}
                  </td>
                  <td className="px-3 py-2 text-right font-semibold tabular-nums">{l.qty}</td>
                  <td className="px-3 py-2 text-xs">
                    <div>{fmtData(l.marcadaEm)}</div>
                    {!l.achadaEm && (
                      // Dias parada em vermelho a partir de uma semana: é o que
                      // separa "aconteceu agora" de "ninguém foi olhar".
                      <div className={l.diasParada >= 7 ? 'font-bold text-red-700' : 'text-slate-500'}>
                        {l.diasParada === 0 ? 'hoje' : `há ${l.diasParada} dia${l.diasParada > 1 ? 's' : ''}`}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-500">{l.pedido || '—'}</td>
                  <td className="px-3 py-2 text-right">
                    {l.achadaEm ? (
                      <span className="text-xs font-semibold text-emerald-700">
                        encontrada {fmtData(l.achadaEm)}
                      </span>
                    ) : (
                      <button
                        onClick={() => achei(l)}
                        disabled={achando === l.id}
                        className="inline-flex items-center gap-1 rounded-lg border border-emerald-300 bg-emerald-50 px-2.5 py-1.5 text-xs font-bold text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
                      >
                        {achando === l.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                        Achei a peça
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {!visiveis.length && !carregando && (
                <tr>
                  <td colSpan={7} className="px-3 py-10 text-center text-slate-500">
                    Nenhuma peça extraviada {loja ? 'nessa loja' : 'na rede'}. Bom sinal.
                  </td>
                </tr>
              )}
              {carregando && !visiveis.length && (
                <tr><td colSpan={7} className="px-3 py-10 text-center text-slate-500">Carregando…</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <p className="mt-3 text-xs text-slate-500">
          Marcar como encontrada não apaga o registro: ele fica com a data de quando a peça
          apareceu. Peça que some e reaparece toda hora é sinal de arara desorganizada — e é
          isso que esse histórico mostra.
        </p>
      </div>
    </div>
  );
}
