'use client';

/**
 * /retaguarda/conciliacao — CONCILIAÇÃO FINANCEIRA (aprovado 17/07).
 * Cartões/PIX das maquininhas Stone + PagBank + Pagar.me × vendas do sistema.
 * Só admin. Fluxo: Importar → Conciliar → revisar divergências.
 */

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Scale, Loader2, RefreshCw, X, FileJson } from 'lucide-react';
import { api } from '@/lib/api';

const brl = (cents: number | null | undefined) =>
  cents == null ? '—' : (Number(cents) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtData = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';

const STATUS_STYLE: Record<string, string> = {
  CONCILIADO: 'bg-emerald-50 text-emerald-800 border-emerald-300',
  DIVERGENTE: 'bg-rose-50 text-rose-700 border-rose-300',
  NAO_ENCONTRADO: 'bg-amber-50 text-amber-800 border-amber-300',
  DUPLICADO: 'bg-violet-50 text-violet-800 border-violet-300',
};
const STATUS_LABEL: Record<string, string> = {
  CONCILIADO: 'Conciliado',
  DIVERGENTE: 'Divergente',
  NAO_ENCONTRADO: 'Pgto sem venda',
  DUPLICADO: 'Duplicado',
};
// O que cada número QUER DIZER — a tela tem que se explicar sozinha (em 20/09
// eram 1.519 "Pgto sem venda" e ninguém sabia dizer por quê).
const STATUS_AJUDA: Record<string, string> = {
  CONCILIADO: 'casou com venda, live, crediário ou pedido do site',
  DIVERGENTE: 'valor diferente, ou pago em cima de venda/pedido cancelado',
  NAO_ENCONTRADO: 'dinheiro no gateway sem dono nenhum no sistema',
  DUPLICADO: 'possível pagamento em dobro',
};
// DE ONDE o dinheiro veio (dono, 20/09: "precisa identificar se foi venda física
// na loja, pagamento de crediário, venda link, estas coisas"). A ordem é a dos
// chips; a chave vem do motor (`conciliacao/classificar-pagamentos.ts`).
const ORIGENS: Array<{ key: string; label: string; ajuda: string; cor: string }> = [
  { key: 'loja', label: 'Loja', ajuda: 'venda física — PIX no balcão', cor: 'bg-slate-100 text-slate-700 border-slate-300' },
  { key: 'link', label: 'Link', ajuda: 'venda por link de pagamento', cor: 'bg-sky-50 text-sky-800 border-sky-300' },
  { key: 'pix_online', label: 'PIX online', ajuda: 'venda à distância — PIX mandado pra cliente', cor: 'bg-cyan-50 text-cyan-800 border-cyan-300' },
  { key: 'crediario', label: 'Crediário', ajuda: 'parcela de crediário paga por PIX', cor: 'bg-amber-50 text-amber-800 border-amber-300' },
  { key: 'site', label: 'Site', ajuda: 'pedido de lurds.com.br', cor: 'bg-violet-50 text-violet-800 border-violet-300' },
  { key: 'live', label: 'Live', ajuda: 'carrinho da live', cor: 'bg-pink-50 text-pink-800 border-pink-300' },
];
const ORIGEM_POR_KEY = Object.fromEntries(ORIGENS.map((o) => [o.key, o]));

// Dia LOCAL do PC (Brasília) — nunca `toISOString()`, que vira o dia seguinte depois das 21h.
const diaIso = (deslocamentoEmDias: number) => {
  const d = new Date();
  d.setDate(d.getDate() + deslocamentoEmDias);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
// O input de data dispara onChange com ANO PARCIAL enquanto a pessoa digita
// ("0002-09-21"): só data inteira vira filtro.
const diaValido = (s: string) => /^(19|20)\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(s || '');
const diaBr = (iso: string) => (diaValido(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '');

export default function ConciliacaoPage() {
  const router = useRouter();
  const [allowed, setAllowed] = useState(false);
  const [status, setStatus] = useState<any>(null);
  const [rows, setRows] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [fStatus, setFStatus] = useState('');
  const [fGateway, setFGateway] = useState('');
  const [fOrigem, setFOrigem] = useState('');
  const [fLoja, setFLoja] = useState('');
  const [de, setDe] = useState('');
  const [ate, setAte] = useState('');
  const [periodo, setPeriodo] = useState<{ de: string; ate: string }>({ de: '', ate: '' });
  // Abreviação do nome da loja (mesmo padrão do editor de produtos)
  const [lojas, setLojas] = useState<Array<{ code: string; name: string }>>([]);
  useEffect(() => {
    api<Array<{ code: string; name: string }>>('/stores').then(setLojas).catch(() => {});
  }, []);
  const lojaAbbr = (code: string | null) => {
    if (!code) return '—';
    const l = lojas.find((x) => x.code === code || x.code === String(code).padStart(2, '0'));
    if (!l?.name) return code;
    return String(l.name).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().slice(0, 5);
  };
  const [busy, setBusy] = useState(false);
  const [rodando, setRodando] = useState<'importar' | 'conciliar' | null>(null);
  const [err, setErr] = useState('');
  const [jsonDe, setJsonDe] = useState<any | null>(null);

  useEffect(() => {
    api<{ role: string }>('/auth/me')
      .then((me) => { if (me.role !== 'admin') { router.push('/'); return; } setAllowed(true); })
      .catch(() => router.push('/login'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Os números de cima e a lista saem do MESMO recorte (dono, 21/09: "filtrei
  // Itanhaém e lá em cima não mudou nada"). `pedido` descarta resposta velha:
  // clicando rápido, a do filtro anterior podia chegar por último e a tela
  // ficava com o resumo de uma loja em cima da lista de outra.
  const pedido = useRef(0);
  const carregar = async () => {
    const meu = ++pedido.current;
    setBusy(true); setErr('');
    const filtros = `status=${encodeURIComponent(fStatus)}&gateway=${encodeURIComponent(fGateway)}&origem=${encodeURIComponent(fOrigem)}&loja=${encodeURIComponent(fLoja)}&from=${encodeURIComponent(periodo.de)}&to=${encodeURIComponent(periodo.ate)}`;
    try {
      const [st, lista] = await Promise.all([
        api<any>(`/conciliacao/status?${filtros}`),
        api<any>(`/conciliacao/list?${filtros}&page=${page}`),
      ]);
      if (meu !== pedido.current) return;
      setStatus(st);
      setRows(lista.rows || []);
      setTotal(lista.total || 0);
    } catch (e: any) { if (meu === pedido.current) setErr(e?.message || 'Falha ao carregar'); }
    finally { if (meu === pedido.current) setBusy(false); }
  };
  const temFiltro = !!(fStatus || fGateway || fOrigem || fLoja || periodo.de || periodo.ate);
  const limparFiltros = () => {
    setFStatus(''); setFGateway(''); setFOrigem(''); setFLoja('');
    setDe(''); setAte(''); setPeriodo({ de: '', ate: '' }); setPage(1);
  };

  // PERÍODO (padrão da casa: De/Até livres + atalhos que aplicam na hora). A
  // data é a da VENDA, em dia de Brasília. `de`/`ate` são o que está digitado;
  // `periodo` é o que VALE — só muda com data inteira, porque o input dispara
  // com ano parcial enquanto a pessoa digita ("0002-09-21").
  const aplicarPeriodo = (novoDe: string, novoAte: string) => {
    setDe(novoDe); setAte(novoAte);
    if ((novoDe === '' || diaValido(novoDe)) && (novoAte === '' || diaValido(novoAte))) {
      setPeriodo({ de: novoDe, ate: novoAte }); setPage(1);
    }
  };
  const ATALHOS: Array<{ label: string; title: string; de: string; ate: string }> = [
    { label: 'Hoje', title: 'Só hoje', de: diaIso(0), ate: diaIso(0) },
    { label: 'Ontem', title: 'Só ontem', de: diaIso(-1), ate: diaIso(-1) },
    { label: '7 dias', title: 'Últimos 7 dias', de: diaIso(-7), ate: diaIso(0) },
    { label: 'Mês', title: 'Mês atual', de: `${diaIso(0).slice(0, 8)}01`, ate: diaIso(0) },
    { label: 'Tudo', title: 'Sem limite de data', de: '', ate: '' },
  ];

  // O seletor de loja sai dos DADOS, não do cadastro: o dinheiro do checkout do
  // site é gravado com o código `SITE`, que não existe no cadastro de lojas (lá
  // o site é a 13) — 742 pagamentos ficavam sem como filtrar. A loja clicada
  // entra sempre, mesmo zerada no recorte, senão o select fica sem valor.
  const opcoesDeLoja = (() => {
    const nome = (code: string) => {
      const l = lojas.find((x) => x.code === code || x.code === String(code).padStart(2, '0'));
      return l?.name || (code === 'SITE' ? 'checkout lurds.com.br' : '');
    };
    const contagem: Array<{ storeCode: string; qtd: number }> = status?.lojas
      || lojas.map((l) => ({ storeCode: l.code, qtd: -1 })); // backend antigo: cai no cadastro, sem número
    const codigos = new Map(contagem.map((c) => [c.storeCode, c.qtd]));
    if (fLoja && !codigos.has(fLoja)) codigos.set(fLoja, 0);
    return [...codigos.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([code, qtd]) => ({ code, label: `${code}${nome(code) ? ` · ${nome(code)}` : ''}${qtd >= 0 ? ` (${qtd})` : ''}` }));
  })();
  useEffect(() => { if (allowed) carregar(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [allowed, fStatus, fGateway, fOrigem, fLoja, periodo.de, periodo.ate, page]);

  const rodar = async (qual: 'importar' | 'conciliar') => {
    setRodando(qual); setErr('');
    try {
      const r = await api<any>(`/conciliacao/${qual}`, { method: 'POST', body: JSON.stringify({}) });
      setErr('');
      alert(qual === 'importar'
        ? `Importado: PagBank ${r.pagbank} · Pagar.me ${r.pagarme} · Stone ${r.stone}`
        : `Motor: ${r.conciliadas} conciliadas · ${r.divergentes} divergentes · ${r.semVenda} sem venda · ${r.duplicadas} duplicadas`);
      await carregar();
    } catch (e: any) { setErr(e?.message || 'Falhou'); }
    finally { setRodando(null); }
  };

  const verJson = async (transactionId: string) => {
    const t = await api<any>(`/conciliacao/tx/${transactionId}/json`).catch(() => null);
    if (t) setJsonDe(t);
  };

  const contagem = (s: string) => (status?.conciliacoes || []).find((c: any) => c.status === s)?.qtd || 0;
  // NSU/cartão só existe em transação de maquininha (Stone). PIX e link não têm:
  // a coluna inteira era "—" e o lugar dela é da Origem. Volta sozinha quando houver.
  const temNsu = rows.some((r) => r.nsu || r.cartaoFinal);

  if (!allowed) return <div className="min-h-screen flex items-center justify-center text-slate-400 text-sm">Carregando…</div>;

  return (
    <div className="min-h-screen bg-[#FAFAF7] pb-16 text-slate-800">
      <header className="bg-white border-b border-[#E7E2D8] sticky top-0 z-20">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link href="/retaguarda" className="text-slate-500 hover:text-slate-800"><ArrowLeft className="w-5 h-5" /></Link>
          <Scale className="w-5 h-5 text-[#B8912B]" />
          <div className="flex-1">
            <h1 className="font-bold text-lg">Conciliação Financeira</h1>
            <p className="text-xs text-slate-500">Stone (maquininhas) · PagBank · Pagar.me × vendas do sistema</p>
          </div>
          <button onClick={() => rodar('importar')} disabled={!!rodando}
            className="px-4 py-2 rounded-xl border-2 border-[#B8912B] text-[#8C7325] text-sm font-bold disabled:opacity-50 flex items-center gap-2">
            {rodando === 'importar' ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} 1. Importar
          </button>
          <button onClick={() => rodar('conciliar')} disabled={!!rodando}
            className="px-4 py-2 rounded-xl text-white text-sm font-black disabled:opacity-50 flex items-center gap-2"
            style={{ background: '#B8912B' }}>
            {rodando === 'conciliar' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Scale className="w-4 h-4" />} 2. Conciliar
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-5 space-y-4">
        {err && <div className="bg-rose-50 border border-rose-200 text-rose-700 px-3 py-2 rounded-lg text-sm">{err}</div>}

        {/* Cards por status (clicáveis = filtro) */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {(['CONCILIADO', 'DIVERGENTE', 'NAO_ENCONTRADO', 'DUPLICADO'] as const).map((s) => (
            <button key={s} onClick={() => { setFStatus(fStatus === s ? '' : s); setPage(1); }}
              className={`rounded-xl border-2 p-3 text-left ${fStatus === s ? STATUS_STYLE[s] : 'bg-white border-[#E7E2D8]'}`}>
              <div className="text-[11px] font-bold uppercase text-slate-500">{STATUS_LABEL[s]}</div>
              <div className={`text-2xl font-black ${s === 'CONCILIADO' ? 'text-emerald-700' : s === 'DIVERGENTE' ? 'text-rose-600' : 'text-slate-800'}`}>
                {contagem(s)}
              </div>
              <div className="text-[11px] text-slate-500 leading-tight mt-0.5">{STATUS_AJUDA[s]}</div>
            </button>
          ))}
        </div>

        {/* Período — De/Até livres + atalhos que aplicam na hora (data da VENDA, dia de Brasília) */}
        <div className="flex gap-2 flex-wrap items-center text-xs">
          <span className="text-[11px] font-bold uppercase text-slate-500">Período</span>
          <label className="flex items-center gap-1 text-slate-600 font-bold">
            De
            <input type="date" value={de} max={ate || undefined} onChange={(e) => aplicarPeriodo(e.target.value, ate)}
              className={`px-2 py-1 rounded-lg border-2 bg-white font-normal ${periodo.de ? 'border-slate-800' : 'border-[#E7E2D8]'}`} />
          </label>
          <label className="flex items-center gap-1 text-slate-600 font-bold">
            Até
            <input type="date" value={ate} min={de || undefined} onChange={(e) => aplicarPeriodo(de, e.target.value)}
              className={`px-2 py-1 rounded-lg border-2 bg-white font-normal ${periodo.ate ? 'border-slate-800' : 'border-[#E7E2D8]'}`} />
          </label>
          {ATALHOS.map((a) => {
            const ativo = periodo.de === a.de && periodo.ate === a.ate;
            return (
              <button key={a.label} title={a.title} onClick={() => aplicarPeriodo(a.de, a.ate)}
                className={`px-3 py-1.5 rounded-full border-2 font-bold ${ativo ? 'bg-slate-800 text-white border-slate-800' : 'bg-white border-[#E7E2D8] text-slate-600'}`}>
                {a.label}
              </button>
            );
          })}
          {/* Até onde os dados vão: "Hoje" vazio tem que se explicar sozinho */}
          <span className="text-[11px] text-slate-500 ml-auto">
            {status?.atualizadoEm
              ? `atualizado às ${new Date(status.atualizadoEm).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} · `
              : ''}
            atualiza sozinho a cada hora
          </span>
        </div>

        {/* Gateway e loja — os números já vêm recortados pelos OUTROS filtros ativos */}
        {status?.transacoes?.length > 0 && (
          <div className="flex gap-2 flex-wrap text-xs">
            {status.transacoes.map((t: any) => {
              // `gateways` = pagamentos PAGOS no recorte. Backend antigo (deploy no meio) não manda: cai no total importado.
              const n = status.gateways ? status.gateways.find((g: any) => g.gateway === t.gateway) || { qtd: 0, cents: 0 } : null;
              const ativo = fGateway === t.gateway;
              return (
                <button key={t.gateway} onClick={() => { setFGateway(ativo ? '' : t.gateway); setPage(1); }}
                  className={`px-3 py-1.5 rounded-full border-2 font-bold ${ativo ? 'bg-slate-800 text-white border-slate-800' : 'bg-white border-[#E7E2D8] text-slate-600'} ${n && !n.qtd && !ativo ? 'opacity-40' : ''}`}>
                  {n ? `${t.gateway} · ${n.qtd} ${n.qtd === 1 ? 'pago' : 'pagos'} · ${brl(n.cents)}` : `${t.gateway} · ${t.qtd} transações · ${brl(t.brutoCents)}`}
                </button>
              );
            })}
            <select value={fLoja} onChange={(e) => { setFLoja(e.target.value); setPage(1); }}
              className={`px-3 py-1.5 rounded-full border-2 font-bold ${fLoja ? 'bg-slate-800 text-white border-slate-800' : 'border-[#E7E2D8] bg-white text-slate-600'}`}>
              <option value="">Loja: todas</option>
              {opcoesDeLoja.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
            </select>
            {temFiltro && (
              <button onClick={limparFiltros}
                className="px-3 py-1.5 rounded-full border-2 border-rose-200 bg-rose-50 text-rose-700 font-bold flex items-center gap-1">
                <X className="w-3.5 h-3.5" /> Limpar filtros
              </button>
            )}
          </div>
        )}

        {/* De onde veio o dinheiro (clicável = filtro) */}
        {status?.origens && (
          <div className="flex gap-2 flex-wrap items-center text-xs">
            <span className="text-[11px] font-bold uppercase text-slate-500">Origem</span>
            {ORIGENS.map((o) => {
              const n = status.origens.find((x: any) => x.origem === o.key);
              const ativo = fOrigem === o.key;
              // Origem zerada no recorte some — menos a que está clicada, senão não há onde desclicar.
              if (!n?.qtd && !ativo) return null;
              return (
                <button key={o.key} title={o.ajuda} onClick={() => { setFOrigem(ativo ? '' : o.key); setPage(1); }}
                  className={`px-3 py-1.5 rounded-full border-2 font-bold ${ativo ? 'bg-slate-800 text-white border-slate-800' : o.cor}`}>
                  {o.label} · {n?.qtd || 0} · {brl(n?.cents || 0)}
                </button>
              );
            })}
          </div>
        )}

        {/* O recorte em uma linha: é o que a lista abaixo soma */}
        {temFiltro && status?.total && (
          <div className="text-sm text-slate-700">
            <b>{status.total.qtd}</b> pagamento(s) neste recorte · <b className="text-[#2E7D46]">{brl(status.total.cents)}</b>
            {(periodo.de || periodo.ate) && (
              <span className="text-slate-500">
                {' '}· vendas {periodo.de && periodo.de === periodo.ate
                  ? `de ${diaBr(periodo.de)}`
                  : `${periodo.de ? `de ${diaBr(periodo.de)} ` : ''}${periodo.ate ? `até ${diaBr(periodo.ate)}` : 'em diante'}`}
              </span>
            )}
          </div>
        )}

        {/* Tabela */}
        <div className="bg-white border border-[#E7E2D8] rounded-xl overflow-x-auto">
          {busy && !rows.length ? (
            <div className="p-10 text-center text-slate-400"><Loader2 className="w-6 h-6 animate-spin mx-auto" /></div>
          ) : (
            <table className="w-full text-sm min-w-[900px]">
              <thead>
                <tr className="bg-[#FAFAF7] text-[10px] uppercase tracking-wide text-slate-500 border-b border-[#E7E2D8]">
                  <th className="text-left px-3 py-2">Data venda</th>
                  <th className="text-left px-3 py-2">Origem</th>
                  <th className="text-left px-3 py-2">Gateway</th>
                  <th className="text-left px-3 py-2">Loja</th>
                  <th className="text-left px-3 py-2">Cliente</th>
                  <th className="text-left px-3 py-2">Forma</th>
                  {temNsu && <th className="text-left px-3 py-2">NSU / cartão</th>}
                  <th className="text-left px-3 py-2">Pedido</th>
                  <th className="text-right px-3 py-2">Sistema</th>
                  <th className="text-right px-3 py-2">Gateway</th>
                  <th className="text-right px-3 py-2">Diferença</th>
                  <th className="text-center px-3 py-2">Status</th>
                  <th className="px-2 py-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-[#F1EDE3] hover:bg-[#FBF6E6]">
                    <td className="px-3 py-2 whitespace-nowrap text-xs">{fmtData(r.dataVenda)}</td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {ORIGEM_POR_KEY[r.origem] ? (
                        <span className={`text-[10px] font-black px-2 py-0.5 rounded-full border ${ORIGEM_POR_KEY[r.origem].cor}`}
                          title={ORIGEM_POR_KEY[r.origem].ajuda}>
                          {ORIGEM_POR_KEY[r.origem].label}
                        </span>
                      ) : <span className="text-slate-400 text-xs">—</span>}
                    </td>
                    <td className="px-3 py-2 text-xs font-bold">{r.gateway}</td>
                    <td className="px-3 py-2 text-xs font-bold text-slate-600" title={r.storeCode ? `Loja ${r.storeCode}` : 'sem loja na transação'}>{lojaAbbr(r.storeCode)}</td>
                    <td className="px-3 py-2 text-xs text-slate-700 max-w-[170px] truncate" title={r.clienteNome || ''}>{r.clienteNome || '—'}</td>
                    <td className="px-3 py-2 text-xs">{r.tipoPagamento || '—'}{r.bandeira ? ` · ${r.bandeira}` : ''}{r.parcelas > 1 ? ` ${r.parcelas}x` : ''}</td>
                    {temNsu && <td className="px-3 py-2 text-xs font-mono text-slate-500">{r.nsu || '—'}{r.cartaoFinal ? ` ·${r.cartaoFinal}` : ''}</td>}
                    <td className="px-3 py-2 text-xs font-mono text-slate-500">{r.pedidoRef ? String(r.pedidoRef).slice(0, 8) : '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{brl(r.valorSistemaCents)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{brl(r.valorGatewayCents)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums font-bold ${r.diferencaCents ? 'text-rose-600' : 'text-slate-400'}`}>
                      {r.diferencaCents ? brl(r.diferencaCents) : '—'}
                    </td>
                    <td className="px-3 py-2 text-center">
                      <span className={`text-[10px] font-black px-2 py-0.5 rounded-full border ${STATUS_STYLE[r.status] || 'border-slate-200 text-slate-500'}`}
                        title={r.motivo || ''}>
                        {STATUS_LABEL[r.status] || r.status}
                      </span>
                      {/* O que pede ação traz o PORQUÊ na própria linha — tooltip ninguém descobre. */}
                      {r.status !== 'CONCILIADO' && r.motivo && (
                        <div className="text-[11px] text-slate-600 leading-tight mt-1 mx-auto max-w-[240px] text-left">{r.motivo}</div>
                      )}
                    </td>
                    <td className="px-2 py-2 text-center">
                      <button onClick={() => verJson(r.transactionId)} title="Ver JSON bruto da adquirente"
                        className="p-1.5 rounded-lg border border-[#E7E2D8] text-slate-400 hover:bg-[#FBF6E6]">
                        <FileJson className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
                {!rows.length && !busy && (
                  <tr><td colSpan={13} className="text-center text-slate-400 py-10">
                    Nada aqui ainda — clique em <b>1. Importar</b> e depois <b>2. Conciliar</b>.
                  </td></tr>
                )}
              </tbody>
            </table>
          )}
        </div>

        <div className="flex items-center justify-between text-sm text-slate-500">
          <span>{total} resultado(s)</span>
          <span className="flex items-center gap-2">
            <button disabled={page <= 1} onClick={() => setPage(page - 1)} className="px-3 py-1 rounded-lg border border-[#E7E2D8] disabled:opacity-40">‹</button>
            Pág. {page} / {Math.max(1, Math.ceil(total / 50))}
            <button disabled={page >= Math.ceil(total / 50)} onClick={() => setPage(page + 1)} className="px-3 py-1 rounded-lg border border-[#E7E2D8] disabled:opacity-40">›</button>
          </span>
        </div>
      </main>

      {/* JSON bruto */}
      {jsonDe && (
        <div className="fixed inset-0 z-40 bg-black/50 flex items-center justify-center p-4" onClick={() => setJsonDe(null)}>
          <div className="bg-white rounded-2xl max-w-3xl w-full max-h-[85vh] overflow-y-auto p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <h3 className="font-bold">JSON bruto — {jsonDe.gateway} {jsonDe.transactionId}</h3>
              <button onClick={() => setJsonDe(null)} className="text-slate-400"><X className="w-5 h-5" /></button>
            </div>
            <pre className="text-[11px] bg-slate-50 border border-slate-200 rounded-xl p-3 overflow-x-auto whitespace-pre-wrap">
              {JSON.stringify(jsonDe.rawJson ?? jsonDe, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
