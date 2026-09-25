'use client';

/**
 * ESTORNOS E DEVOLUÇÕES — /site/estornos (22/09/2026).
 *
 * Devolver dinheiro da cliente pelo sistema, sem ninguém abrir a conta do
 * PagBank. Quatro fontes entram aqui: pedido do site (PagBank e Pagar.me),
 * venda online do PDV, carrinho da live e diferença de troca.
 *
 * ── O QUE ESTA TELA PROMETE (e o que ela NÃO faz) ──
 *
 * Ela pede o estorno ao GATEWAY e mostra o que ele respondeu. Ela não muda
 * status por conta própria: "processado" só aparece quando o gateway
 * confirmou, e resposta em aberto aparece como EM PROCESSAMENTO — com todas
 * as letras, porque o dinheiro pode estar a caminho.
 *
 * ── A SENHA ──
 *
 * A porta pede senha MASTER ou SUPREMA e devolve um bilhete de 15 minutos que
 * só serve pra LER. Cada operação de dinheiro (estornar, mandar comprovante)
 * pede a senha DE NOVO. O bilhete vive na memória desta aba: recarregou a
 * página, digita de novo — de propósito.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle, ArrowLeft, Ban, CheckCircle2, Clock, Download, FileText,
  Loader2, Lock, Mail, RefreshCw, Search, Undo2,
} from 'lucide-react';
import { api, API_URL, getAuthToken } from '@/lib/api';

// ── Tipos que o backend devolve ──────────────────────────────────────────────

type Pagamento = {
  pagamentoId: string;
  gateway: 'pagbank' | 'pagarme';
  chargeId: string | null;
  gatewayOrderId: string | null;
  metodo: string;
  metodoLabel: string;
  storeCode: string | null;
  valorPagoCents: number;
  pagoEm: string | null;
  estornadoCents: number;
  saldoCents: number;
  pode: boolean;
  motivoBloqueio?: string;
  emAndamento: boolean;
  origem: string;
  refId: string;
  refNumero: string | null;
  refWcOrderId: number | null;
  refStatus: string | null;
  clienteNome: string | null;
  clienteCpf: string | null;
  clienteEmail: string | null;
  totalCents: number | null;
  aviso?: string;
};

type Estorno = {
  id: string;
  status: string;
  tipo: string;
  valorCents: number;
  metodo: string;
  motivo: string;
  statusGateway?: string | null;
  mensagemGateway?: string | null;
  refNumero?: string | null;
  refId?: string;
  clienteEmail?: string | null;
  createdAt?: string;
  processadoEm?: string | null;
  usuarioNome?: string | null;
  comprovanteEnviadoEm?: string | null;
  comprovanteEmail?: string | null;
};

type Resumo = {
  quantidade: number;
  totalCents: number;
  pixCents: number;
  pixQtd: number;
  cartaoCents: number;
  cartaoQtd: number;
  pendentes: number;
  pendentesCents: number;
  erros: number;
};

type Motivo = { codigo: string; label: string; exigeTexto: boolean };

// ── Formatação ───────────────────────────────────────────────────────────────

const brl = (cents: number | null | undefined) =>
  (Number(cents || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const iso = (d: Date) => d.toISOString().slice(0, 10);
const dataHora = (v: string | null | undefined) =>
  v
    ? new Date(v).toLocaleString('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit',
      })
    : '—';
const limpo = (e: unknown) => String((e as Error)?.message || '').replace(/^\d+:\s*/, '') || 'Falhou';

/**
 * O que a pessoa lê quando o download (PDF/planilha) falha. A API responde
 * JSON `{ statusCode, message }`; é a `message` que vale — nunca o JSON cru
 * (`{"statusCode":500,"message":"Internal server error"}` foi o que apareceu
 * na tela em 25/09/2026). Erro de servidor sem frase própria vira um convite
 * a tentar de novo: gerar o arquivo é leitura, não repete nem altera nada.
 */
const mensagemDaResposta = async (res: Response, oQue: string): Promise<string> => {
  const texto = await res.text().catch(() => '');
  let msg = '';
  try {
    const corpo = JSON.parse(texto);
    const m = corpo?.message;
    msg = Array.isArray(m) ? m.join(' ') : String(m || '');
  } catch {
    msg = texto;
  }
  if (res.status >= 500 && (!msg || /internal server error/i.test(msg))) {
    return `Não foi possível gerar ${oQue} agora. Nada foi alterado — tente de novo em instantes.`;
  }
  return msg || `HTTP ${res.status}`;
};

const ORIGENS: Record<string, string> = {
  site: 'Pedido do site',
  pdv_online: 'Venda online do PDV',
  live: 'Live',
  pdv_balcao: 'Balcão',
  crediario: 'Crediário',
  desconhecido: 'Sem dono identificado',
};

/** O status do estorno em português, com a cor que a operação entende. */
const STATUS: Record<string, { label: string; cor: string; icone: typeof Clock }> = {
  iniciado: { label: 'Solicitação iniciada', cor: 'bg-slate-100 text-slate-700', icone: Clock },
  enviado: { label: 'Enviado ao PagBank', cor: 'bg-amber-100 text-amber-800', icone: Clock },
  processando: { label: 'Em processamento', cor: 'bg-amber-100 text-amber-800', icone: Clock },
  processado: { label: 'Processado', cor: 'bg-emerald-100 text-emerald-800', icone: CheckCircle2 },
  recusado: { label: 'Recusado', cor: 'bg-rose-100 text-rose-800', icone: Ban },
  erro: { label: 'Erro', cor: 'bg-rose-100 text-rose-800', icone: AlertTriangle },
};

function Selo({ status }: { status: string }) {
  const s = STATUS[status] || { label: status, cor: 'bg-slate-100 text-slate-700', icone: Clock };
  const Icone = s.icone;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold ${s.cor}`}>
      <Icone className="w-3 h-3" /> {s.label}
    </span>
  );
}

// ── A tela ───────────────────────────────────────────────────────────────────

export default function EstornosPage() {
  /** O bilhete de 15 min. Vive só nesta aba — nada de localStorage. */
  const [sessao, setSessao] = useState<string | null>(null);
  const [aba, setAba] = useState<'buscar' | 'historico'>('buscar');
  const [pagamento, setPagamento] = useState<Pagamento | null>(null);
  const [estorno, setEstorno] = useState<Estorno | null>(null);

  const expirou = useCallback((e: unknown) => {
    if (/sess[aã]o de estornos/i.test(String((e as Error)?.message || ''))) {
      setSessao(null);
      setPagamento(null);
      setEstorno(null);
      return true;
    }
    return false;
  }, []);

  if (!sessao) return <Porta aoEntrar={setSessao} />;

  return (
    <div className="max-w-[1500px] mx-auto p-4 space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-black text-slate-800 flex items-center gap-2">
            <Undo2 className="w-5 h-5 text-rose-600" /> Estornos e devoluções
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            Devolve o dinheiro pela API do gateway. <b>Quem confirma é o PagBank</b> — a tela mostra
            o que ele respondeu, nunca um &quot;pronto&quot; que não aconteceu.
          </p>
        </div>
        <Link
          href="/site"
          className="px-3 py-2 rounded-lg bg-white border border-slate-200 text-sm font-semibold text-slate-700 hover:bg-slate-50 flex items-center gap-1.5"
        >
          <ArrowLeft className="w-4 h-4" /> Site
        </Link>
      </div>

      <div className="flex gap-2 border-b">
        {([['buscar', 'Estornar um pagamento'], ['historico', 'Histórico geral']] as const).map(([k, rotulo]) => (
          <button
            key={k}
            type="button"
            onClick={() => { setAba(k); setPagamento(null); setEstorno(null); }}
            className={`px-4 py-2 text-sm font-bold border-b-2 -mb-px ${
              aba === k ? 'border-rose-500 text-rose-700' : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            {rotulo}
          </button>
        ))}
      </div>

      {aba === 'historico' ? (
        <Historico sessao={sessao} expirou={expirou} />
      ) : estorno ? (
        <Resultado
          estorno={estorno}
          pagamento={pagamento}
          sessao={sessao}
          expirou={expirou}
          aoVoltar={() => { setEstorno(null); setPagamento(null); }}
          aoAtualizar={setEstorno}
        />
      ) : pagamento ? (
        <Ficha
          pagamentoId={pagamento.pagamentoId}
          sessao={sessao}
          expirou={expirou}
          aoVoltar={() => setPagamento(null)}
          aoEstornar={(e, p) => { setEstorno(e); setPagamento(p); }}
        />
      ) : (
        <Busca sessao={sessao} expirou={expirou} aoAbrir={setPagamento} />
      )}
    </div>
  );
}

// ── Porta ────────────────────────────────────────────────────────────────────

function Porta({ aoEntrar }: { aoEntrar: (token: string) => void }) {
  const [senha, setSenha] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [indo, setIndo] = useState(false);
  const campo = useRef<HTMLInputElement>(null);

  useEffect(() => { campo.current?.focus(); }, []);

  const entrar = async () => {
    if (!senha.trim() || indo) return;
    setIndo(true);
    setErro(null);
    try {
      const r = await api<{ token: string }>('/admin/estornos/sessao', {
        method: 'POST',
        body: JSON.stringify({ password: senha }),
      });
      setSenha('');
      aoEntrar(r.token);
    } catch (e) {
      setErro(limpo(e));
      setSenha('');
      campo.current?.focus();
    } finally {
      setIndo(false);
    }
  };

  return (
    <div className="max-w-md mx-auto mt-16 bg-white rounded-xl shadow border p-6">
      <div className="flex items-center gap-2 text-slate-800">
        <Lock className="w-5 h-5 text-rose-600" />
        <h1 className="text-lg font-black">Estornos e devoluções</h1>
      </div>
      <p className="text-xs text-slate-500 mt-2">
        Esta função devolve dinheiro pra cliente. Só entra com <b>senha Master ou Suprema</b>, e
        cada estorno pede a senha de novo. Toda tentativa fica registrada.
      </p>
      <input
        ref={campo}
        type="password"
        value={senha}
        onChange={(e) => setSenha(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') void entrar(); }}
        placeholder="Senha Master ou Suprema"
        className="w-full mt-4 px-3 py-2.5 border rounded-lg text-sm"
        autoComplete="off"
      />
      {erro && (
        <div className="mt-3 text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded p-2">{erro}</div>
      )}
      <button
        type="button"
        onClick={() => void entrar()}
        disabled={indo || !senha.trim()}
        className="w-full mt-4 px-4 py-2.5 rounded-lg bg-rose-600 text-white text-sm font-bold hover:bg-rose-700 disabled:opacity-50 flex items-center justify-center gap-2"
      >
        {indo ? <Loader2 className="w-4 h-4 animate-spin" /> : <Lock className="w-4 h-4" />} Entrar
      </button>
      <Link href="/site" className="block text-center text-xs text-slate-500 hover:text-slate-700 mt-4">
        Voltar pro Site
      </Link>
    </div>
  );
}

// ── Busca ────────────────────────────────────────────────────────────────────

function Busca({
  sessao, expirou, aoAbrir,
}: {
  sessao: string;
  expirou: (e: unknown) => boolean;
  aoAbrir: (p: Pagamento) => void;
}) {
  const [termo, setTermo] = useState('');
  const [origem, setOrigem] = useState('todos');
  const [metodo, setMetodo] = useState('todos');
  const [de, setDe] = useState('');
  const [ate, setAte] = useState('');
  const [linhas, setLinhas] = useState<Pagamento[]>([]);
  const [buscando, setBuscando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [buscou, setBuscou] = useState(false);

  const buscar = useCallback(async () => {
    setBuscando(true);
    setErro(null);
    try {
      const q = new URLSearchParams();
      if (termo.trim()) q.set('termo', termo.trim());
      if (origem !== 'todos') q.set('origem', origem);
      if (metodo !== 'todos') q.set('metodo', metodo);
      if (de) q.set('de', de);
      if (ate) q.set('ate', ate);
      const r = await api<{ pagamentos: Pagamento[] }>(`/admin/estornos/buscar?${q.toString()}`, {
        headers: { 'x-estorno-sessao': sessao },
      });
      setLinhas(r?.pagamentos || []);
      setBuscou(true);
    } catch (e) {
      if (!expirou(e)) setErro(limpo(e));
    } finally {
      setBuscando(false);
    }
  }, [termo, origem, metodo, de, ate, sessao, expirou]);

  const atalho = (tipo: 'hoje' | 'ontem' | '7d' | 'mes') => {
    const h = new Date();
    if (tipo === 'hoje') { setDe(iso(h)); setAte(iso(h)); return; }
    if (tipo === 'ontem') {
      const o = new Date(h); o.setDate(o.getDate() - 1);
      setDe(iso(o)); setAte(iso(o)); return;
    }
    if (tipo === '7d') {
      const i = new Date(h); i.setDate(i.getDate() - 6);
      setDe(iso(i)); setAte(iso(h)); return;
    }
    setDe(iso(new Date(h.getFullYear(), h.getMonth(), 1))); setAte(iso(h));
  };

  const th = 'px-3 py-2 text-left text-[11px] font-bold uppercase text-slate-500 whitespace-nowrap';
  const td = 'px-3 py-2 text-sm whitespace-nowrap';

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-lg shadow border p-4 space-y-3">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              value={termo}
              onChange={(e) => setTermo(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void buscar(); }}
              placeholder="Número do pedido, nome, CPF, e-mail ou código da transação"
              className="w-full pl-9 pr-3 py-2.5 border rounded-lg text-sm"
            />
          </div>
          <button
            type="button"
            onClick={() => void buscar()}
            disabled={buscando}
            className="px-5 py-2.5 rounded-lg bg-slate-800 text-white text-sm font-bold hover:bg-slate-900 disabled:opacity-50 flex items-center gap-2"
          >
            {buscando ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />} Buscar
          </button>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Origem</label>
            <select value={origem} onChange={(e) => setOrigem(e.target.value)} className="px-2 py-2 border rounded text-sm">
              <option value="todos">Todas</option>
              <option value="site">Pedido do site</option>
              <option value="pdv_online">Venda online do PDV</option>
              <option value="live">Live</option>
              <option value="pdv_balcao">Balcão</option>
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Forma</label>
            <select value={metodo} onChange={(e) => setMetodo(e.target.value)} className="px-2 py-2 border rounded text-sm">
              <option value="todos">Todas</option>
              <option value="pix">PIX</option>
              <option value="credit_card">Cartão</option>
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">De</label>
            <input type="date" value={de} onChange={(e) => setDe(e.target.value)} className="px-2 py-2 border rounded text-sm" />
          </div>
          <div>
            <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Até</label>
            <input type="date" value={ate} onChange={(e) => setAte(e.target.value)} className="px-2 py-2 border rounded text-sm" />
          </div>
          <div className="flex flex-wrap gap-1 pb-1">
            {([['hoje', 'Hoje'], ['ontem', 'Ontem'], ['7d', '7 dias'], ['mes', 'Mês']] as const).map(([k, rotulo]) => (
              <button key={k} type="button" onClick={() => atalho(k)} className="px-2.5 py-1.5 rounded-full border text-xs hover:bg-slate-50">
                {rotulo}
              </button>
            ))}
          </div>
        </div>
        <p className="text-[11px] text-slate-400">
          A busca traz só pagamento <b>confirmado</b> — cobrança que não foi paga não tem o que estornar.
        </p>
      </div>

      {erro && <div className="bg-rose-50 border border-rose-200 text-rose-700 text-sm rounded-lg p-3">{erro}</div>}

      {buscou && !linhas.length && !buscando && (
        <div className="bg-white rounded-lg shadow border p-8 text-center text-sm text-slate-500">
          Nada encontrado com esse filtro. Tente o número do pedido ou o CPF da cliente.
        </div>
      )}

      {!!linhas.length && (
        <div className="bg-white rounded-lg shadow border overflow-x-auto">
          <table className="w-full">
            <thead className="bg-slate-50 border-b">
              <tr>
                <th className={th}>Pago em</th>
                <th className={th}>Pedido</th>
                <th className={th}>Origem</th>
                <th className={th}>Cliente</th>
                <th className={th}>Forma</th>
                <th className={`${th} text-right`}>Pago</th>
                <th className={`${th} text-right`}>Já estornado</th>
                <th className={`${th} text-right`}>Saldo</th>
                <th className={th}></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {linhas.map((p) => (
                <tr key={p.pagamentoId} className="hover:bg-slate-50">
                  <td className={`${td} text-slate-500`}>{dataHora(p.pagoEm)}</td>
                  <td className={`${td} font-bold text-slate-800`}>{p.refNumero || '—'}</td>
                  <td className={`${td} text-slate-600`}>{ORIGENS[p.origem] || p.origem}</td>
                  <td className={td}>{p.clienteNome || '—'}</td>
                  <td className={`${td} text-slate-600`}>
                    {p.metodoLabel}
                    <span className="text-[10px] text-slate-400 ml-1">{p.gateway === 'pagbank' ? 'PagBank' : 'Pagar.me'}</span>
                  </td>
                  <td className={`${td} text-right font-semibold`}>{brl(p.valorPagoCents)}</td>
                  <td className={`${td} text-right ${p.estornadoCents ? 'text-rose-700 font-semibold' : 'text-slate-400'}`}>
                    {p.estornadoCents ? brl(p.estornadoCents) : '—'}
                  </td>
                  <td className={`${td} text-right font-bold ${p.saldoCents ? 'text-emerald-700' : 'text-slate-400'}`}>
                    {brl(p.saldoCents)}
                  </td>
                  <td className={`${td} text-right`}>
                    {p.emAndamento ? (
                      <span className="text-[11px] text-amber-700 font-bold">estorno em andamento</span>
                    ) : p.pode ? (
                      <button
                        type="button"
                        onClick={() => aoAbrir(p)}
                        className="px-3 py-1.5 rounded-lg bg-rose-600 text-white text-xs font-bold hover:bg-rose-700"
                      >
                        Abrir
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => aoAbrir(p)}
                        className="px-3 py-1.5 rounded-lg border text-xs font-semibold text-slate-600 hover:bg-slate-50"
                        title={p.motivoBloqueio}
                      >
                        Ver
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Ficha do pagamento + pedido de estorno ───────────────────────────────────

function Ficha({
  pagamentoId, sessao, expirou, aoVoltar, aoEstornar,
}: {
  pagamentoId: string;
  sessao: string;
  expirou: (e: unknown) => boolean;
  aoVoltar: () => void;
  aoEstornar: (e: Estorno, p: Pagamento) => void;
}) {
  const [dados, setDados] = useState<{
    pagamento: Pagamento;
    gatewayOnline: boolean;
    gatewayErro?: string;
    statusGateway?: string;
    historico: Estorno[];
  } | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  const [tipo, setTipo] = useState<'integral' | 'parcial'>('integral');
  const [valor, setValor] = useState('');
  const [motivo, setMotivo] = useState('');
  const [motivoTexto, setMotivoTexto] = useState('');
  const [observacao, setObservacao] = useState('');
  const [motivos, setMotivos] = useState<Motivo[]>([]);
  const [confirmando, setConfirmando] = useState(false);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const r = await api<any>(`/admin/estornos/pagamento/${encodeURIComponent(pagamentoId)}`, {
        headers: { 'x-estorno-sessao': sessao },
      });
      setDados(r);
    } catch (e) {
      if (!expirou(e)) setErro(limpo(e));
    } finally {
      setCarregando(false);
    }
  }, [pagamentoId, sessao, expirou]);

  useEffect(() => { void carregar(); }, [carregar]);
  useEffect(() => {
    api<{ motivos: Motivo[] }>('/admin/estornos/motivos')
      .then((r) => setMotivos(r?.motivos || []))
      .catch(() => {});
  }, []);

  const p = dados?.pagamento;
  const valorCents = useMemo(() => {
    const n = Number(String(valor).replace(/\./g, '').replace(',', '.'));
    return Number.isFinite(n) ? Math.round(n * 100) : 0;
  }, [valor]);
  const motivoEscolhido = motivos.find((m) => m.codigo === motivo);
  const pronto =
    !!p?.pode &&
    !!motivo &&
    (!motivoEscolhido?.exigeTexto || motivoTexto.trim().length >= 5) &&
    (tipo === 'integral' || (valorCents > 0 && valorCents <= (p?.saldoCents || 0)));

  if (carregando) {
    return <div className="bg-white rounded-lg shadow border p-8 text-center text-slate-500"><Loader2 className="w-5 h-5 animate-spin inline" /></div>;
  }
  if (erro || !p) {
    return (
      <div className="space-y-3">
        <button type="button" onClick={aoVoltar} className="text-sm text-slate-600 hover:text-slate-900 flex items-center gap-1">
          <ArrowLeft className="w-4 h-4" /> Voltar
        </button>
        <div className="bg-rose-50 border border-rose-200 text-rose-700 text-sm rounded-lg p-3">{erro || 'Pagamento não encontrado.'}</div>
      </div>
    );
  }

  const linha = (k: string, v: React.ReactNode) => (
    <div className="flex justify-between gap-4 py-1.5 border-b border-slate-100 last:border-0">
      <span className="text-xs text-slate-500">{k}</span>
      <span className="text-sm text-slate-800 font-semibold text-right">{v}</span>
    </div>
  );

  return (
    <div className="space-y-4">
      <button type="button" onClick={aoVoltar} className="text-sm text-slate-600 hover:text-slate-900 flex items-center gap-1">
        <ArrowLeft className="w-4 h-4" /> Voltar pra busca
      </button>

      <div className="grid lg:grid-cols-2 gap-4">
        {/* ── O pagamento ── */}
        <div className="bg-white rounded-lg shadow border p-4">
          <h2 className="text-sm font-black text-slate-800 uppercase tracking-wide mb-3">Pagamento</h2>
          {linha('Pedido', p.refNumero || '—')}
          {linha('Origem', ORIGENS[p.origem] || p.origem)}
          {linha('Situação do pedido', p.refStatus || '—')}
          {linha('Cliente', p.clienteNome || '—')}
          {linha('CPF', p.clienteCpf || '—')}
          {linha('E-mail', p.clienteEmail || '—')}
          {linha('Forma', `${p.metodoLabel} · ${p.gateway === 'pagbank' ? 'PagBank' : 'Pagar.me'}`)}
          {linha('Pago em', dataHora(p.pagoEm))}
          {linha('Transação', <span className="font-mono text-[11px]">{p.chargeId || '—'}</span>)}
          {dados?.gatewayErro && (
            <div className="mt-3 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded p-2">
              Não consegui falar com o gateway agora ({dados.gatewayErro}). Os valores abaixo são os
              últimos que o sistema conhece — o saldo é conferido de novo na hora de estornar.
            </div>
          )}
          {p.aviso && (
            <div className="mt-3 text-xs text-slate-600 bg-slate-50 border rounded p-2">{p.aviso}</div>
          )}
        </div>

        {/* ── O dinheiro ── */}
        <div className="bg-white rounded-lg shadow border p-4">
          <h2 className="text-sm font-black text-slate-800 uppercase tracking-wide mb-3">Valores</h2>
          {linha('Valor pago', brl(p.valorPagoCents))}
          {linha('Já estornado', p.estornadoCents ? <span className="text-rose-700">{brl(p.estornadoCents)}</span> : '—')}
          <div className="flex justify-between items-center gap-4 pt-3 mt-2 border-t">
            <span className="text-xs font-bold text-slate-500 uppercase">Disponível pra estorno</span>
            <span className="text-2xl font-black text-emerald-700">{brl(p.saldoCents)}</span>
          </div>
          {dados?.gatewayOnline && (
            <p className="text-[11px] text-slate-400 mt-2">
              Saldo conferido agora no gateway{dados.statusGateway ? ` (cobrança ${dados.statusGateway})` : ''}.
            </p>
          )}

          {!p.pode ? (
            <div className="mt-4 text-sm text-slate-700 bg-slate-50 border rounded p-3">
              <b>Não dá pra estornar por aqui.</b> {p.motivoBloqueio}
            </div>
          ) : p.emAndamento ? (
            <div className="mt-4 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded p-3">
              Já existe um estorno em andamento nesta cobrança. Atualize o status dele antes de pedir outro.
            </div>
          ) : (
            <div className="mt-4 space-y-3">
              <div>
                <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Tipo</label>
                <div className="flex gap-2">
                  {([['integral', `Integral (${brl(p.saldoCents)})`], ['parcial', 'Parcial']] as const).map(([k, rotulo]) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setTipo(k)}
                      className={`px-3 py-2 rounded-lg border text-xs font-bold ${
                        tipo === k ? 'bg-rose-600 text-white border-rose-600' : 'bg-white text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      {rotulo}
                    </button>
                  ))}
                </div>
              </div>

              {tipo === 'parcial' && (
                <div>
                  <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Valor a devolver</label>
                  <input
                    value={valor}
                    onChange={(e) => setValor(e.target.value.replace(/[^\d.,]/g, ''))}
                    placeholder="0,00"
                    inputMode="decimal"
                    className="w-full px-3 py-2 border rounded-lg text-sm"
                  />
                  {valorCents > p.saldoCents && (
                    <p className="text-[11px] text-rose-600 mt-1">
                      Maior que o disponível ({brl(p.saldoCents)}).
                    </p>
                  )}
                </div>
              )}

              <div>
                <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Motivo</label>
                <select value={motivo} onChange={(e) => setMotivo(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm">
                  <option value="">Escolha o motivo…</option>
                  {motivos.map((m) => <option key={m.codigo} value={m.codigo}>{m.label}</option>)}
                </select>
              </div>

              {motivoEscolhido?.exigeTexto && (
                <div>
                  <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Descreva o motivo</label>
                  <input
                    value={motivoTexto}
                    onChange={(e) => setMotivoTexto(e.target.value)}
                    maxLength={300}
                    className="w-full px-3 py-2 border rounded-lg text-sm"
                    placeholder="O que aconteceu (sai no comprovante da cliente)"
                  />
                </div>
              )}

              <div>
                <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">
                  Observação interna <span className="font-normal normal-case text-slate-400">(não vai pra cliente)</span>
                </label>
                <textarea
                  value={observacao}
                  onChange={(e) => setObservacao(e.target.value)}
                  maxLength={500}
                  rows={2}
                  className="w-full px-3 py-2 border rounded-lg text-sm"
                />
              </div>

              <button
                type="button"
                onClick={() => setConfirmando(true)}
                disabled={!pronto}
                className="w-full px-4 py-3 rounded-lg bg-rose-600 text-white text-sm font-black hover:bg-rose-700 disabled:opacity-40 flex items-center justify-center gap-2"
              >
                <Undo2 className="w-4 h-4" />
                Estornar {tipo === 'integral' ? brl(p.saldoCents) : brl(valorCents)}
              </button>
            </div>
          )}
        </div>
      </div>

      {!!dados?.historico?.length && (
        <div className="bg-white rounded-lg shadow border p-4">
          <h2 className="text-sm font-black text-slate-800 uppercase tracking-wide mb-2">Estornos deste pedido</h2>
          <div className="divide-y">
            {dados.historico.map((h) => (
              <div key={h.id} className="py-2 flex items-center justify-between gap-3 text-sm">
                <span className="text-slate-500 text-xs">{dataHora(h.createdAt)}</span>
                <span className="font-semibold">{brl(h.valorCents)}</span>
                <span className="text-xs text-slate-500">{h.tipo}</span>
                <Selo status={h.status} />
              </div>
            ))}
          </div>
        </div>
      )}

      {confirmando && (
        <Confirmacao
          pagamento={p}
          tipo={tipo}
          valorCents={tipo === 'integral' ? p.saldoCents : valorCents}
          motivo={motivo}
          motivoLabel={motivoEscolhido?.label || motivo}
          motivoTexto={motivoTexto}
          observacao={observacao}
          aoCancelar={() => setConfirmando(false)}
          aoConcluir={(e) => { setConfirmando(false); aoEstornar(e, p); }}
          expirou={expirou}
        />
      )}
    </div>
  );
}

// ── Confirmação (a senha de novo) ────────────────────────────────────────────

function Confirmacao({
  pagamento, tipo, valorCents, motivo, motivoLabel, motivoTexto, observacao, aoCancelar, aoConcluir, expirou,
}: {
  pagamento: Pagamento;
  tipo: 'integral' | 'parcial';
  valorCents: number;
  motivo: string;
  motivoLabel: string;
  motivoTexto: string;
  observacao: string;
  aoCancelar: () => void;
  aoConcluir: (e: Estorno) => void;
  expirou: (e: unknown) => boolean;
}) {
  const [senha, setSenha] = useState('');
  const [indo, setIndo] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  /**
   * A CHAVE DA OPERAÇÃO nasce aqui, UMA vez por modal aberto. É ela que
   * impede o duplo clique de virar dois estornos — vale até no PagBank, que
   * recebe a mesma chave e não cobra de novo.
   */
  const operacaoId = useRef(
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  const confirmar = async () => {
    if (indo || !senha.trim()) return;
    setIndo(true);
    setErro(null);
    try {
      const r = await api<{ estorno: Estorno }>('/admin/estornos/solicitar', {
        method: 'POST',
        body: JSON.stringify({
          pagamentoId: pagamento.pagamentoId,
          tipo,
          valorCents,
          motivo,
          motivoTexto,
          observacao,
          operacaoId: operacaoId.current,
          password: senha,
        }),
      });
      setSenha('');
      aoConcluir(r.estorno);
    } catch (e) {
      if (!expirou(e)) setErro(limpo(e));
      setSenha('');
    } finally {
      setIndo(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-5">
        <div className="flex items-center gap-2 text-rose-700">
          <AlertTriangle className="w-5 h-5" />
          <h3 className="font-black text-lg">Confirmar estorno</h3>
        </div>
        <p className="text-sm text-slate-600 mt-2">
          O dinheiro vai ser devolvido pela <b>{pagamento.gateway === 'pagbank' ? 'PagBank' : 'Pagar.me'}</b>.
          Esta operação <b>não tem desfazer</b>.
        </p>

        <div className="mt-3 bg-slate-50 border rounded-lg p-3 space-y-1 text-sm">
          <div className="flex justify-between"><span className="text-slate-500">Pedido</span><b>{pagamento.refNumero || '—'}</b></div>
          <div className="flex justify-between"><span className="text-slate-500">Cliente</span><b>{pagamento.clienteNome || '—'}</b></div>
          <div className="flex justify-between"><span className="text-slate-500">Forma</span><b>{pagamento.metodoLabel}</b></div>
          <div className="flex justify-between"><span className="text-slate-500">Motivo</span><b>{motivoLabel}</b></div>
          <div className="flex justify-between items-center pt-1 border-t mt-1">
            <span className="text-slate-500">Valor a devolver</span>
            <b className="text-xl text-rose-700">{brl(valorCents)}</b>
          </div>
        </div>

        <p className="text-[11px] text-slate-500 mt-3">
          {pagamento.metodo.includes('pix')
            ? 'O PIX volta pra mesma conta que pagou, em geral em minutos.'
            : 'No cartão, o crédito aparece na fatura em até 2 dias úteis (prazo do banco da cliente).'}
        </p>

        <input
          type="password"
          value={senha}
          onChange={(e) => setSenha(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void confirmar(); }}
          placeholder="Senha Master ou Suprema"
          className="w-full mt-3 px-3 py-2.5 border rounded-lg text-sm"
          autoComplete="off"
          autoFocus
        />
        {erro && <div className="mt-2 text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded p-2">{erro}</div>}

        <div className="flex gap-2 mt-4">
          <button
            type="button"
            onClick={aoCancelar}
            disabled={indo}
            className="flex-1 px-4 py-2.5 rounded-lg border text-sm font-bold text-slate-700 hover:bg-slate-50"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={() => void confirmar()}
            disabled={indo || !senha.trim()}
            className="flex-1 px-4 py-2.5 rounded-lg bg-rose-600 text-white text-sm font-black hover:bg-rose-700 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {indo ? <Loader2 className="w-4 h-4 animate-spin" /> : <Undo2 className="w-4 h-4" />}
            {indo ? 'Enviando…' : 'Confirmar estorno'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Resultado + comprovante ──────────────────────────────────────────────────

function Resultado({
  estorno, pagamento, sessao, expirou, aoVoltar, aoAtualizar,
}: {
  estorno: Estorno;
  pagamento: Pagamento | null;
  sessao: string;
  expirou: (e: unknown) => boolean;
  aoVoltar: () => void;
  aoAtualizar: (e: Estorno) => void;
}) {
  const [indo, setIndo] = useState<'consulta' | 'email' | 'pdf' | 'cancelar' | null>(null);
  const [email, setEmail] = useState(estorno.clienteEmail || pagamento?.clienteEmail || '');
  const [senhaEmail, setSenhaEmail] = useState('');
  const [aviso, setAviso] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [pedidoCancelado, setPedidoCancelado] = useState(false);

  const pendente = ['iniciado', 'enviado', 'processando'].includes(estorno.status);
  const deuCerto = estorno.status === 'processado';
  const podeComprovante = deuCerto || pendente;

  const consultar = async () => {
    setIndo('consulta');
    setErro(null);
    try {
      const r = await api<Estorno>(`/admin/estornos/${estorno.id}/consultar`, {
        method: 'POST',
        headers: { 'x-estorno-sessao': sessao },
      });
      aoAtualizar(r);
    } catch (e) {
      if (!expirou(e)) setErro(limpo(e));
    } finally {
      setIndo(null);
    }
  };

  /**
   * Baixar é LEITURA: falhou, clica de novo — o estorno não é repetido nem
   * alterado. Estorno ainda em aberto é reconsultado no gateway pelo backend
   * antes de imprimir, então depois do download a tela relê o estorno pra
   * mostrar o mesmo status que saiu no papel.
   */
  const baixarPdf = async () => {
    setIndo('pdf');
    setErro(null);
    try {
      const res = await fetch(`${API_URL}/api/admin/estornos/${estorno.id}/comprovante`, {
        headers: {
          Authorization: `Bearer ${getAuthToken() || ''}`,
          'x-estorno-sessao': sessao,
        },
      });
      if (!res.ok) throw new Error(await mensagemDaResposta(res, 'o PDF do comprovante'));
      const blob = await res.blob();
      if (blob.type && !blob.type.includes('pdf')) {
        throw new Error('A resposta não veio como PDF. Nada foi alterado — tente de novo em instantes.');
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `estorno-${estorno.refNumero || estorno.id.slice(0, 8)}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
      if (pendente) {
        try {
          const atual = await api<Estorno>(`/admin/estornos/estorno/${estorno.id}`, {
            headers: { 'x-estorno-sessao': sessao },
          });
          if (atual?.id) aoAtualizar(atual);
        } catch {
          /* a tela fica como está — o botão "Atualizar status" continua ali */
        }
      }
    } catch (e) {
      if (!expirou(e)) setErro(limpo(e));
    } finally {
      setIndo(null);
    }
  };

  const mandarEmail = async () => {
    if (!senhaEmail.trim()) { setErro('Digite a senha pra enviar o comprovante.'); return; }
    setIndo('email');
    setErro(null);
    setAviso(null);
    try {
      await api(`/admin/estornos/${estorno.id}/comprovante/email`, {
        method: 'POST',
        body: JSON.stringify({ para: email, password: senhaEmail }),
      });
      setSenhaEmail('');
      setAviso(`Comprovante enviado para ${email}.`);
    } catch (e) {
      if (!expirou(e)) setErro(limpo(e));
      setSenhaEmail('');
    } finally {
      setIndo(null);
    }
  };

  /**
   * CANCELAR O PEDIDO é o caminho de SEMPRE (`PATCH /orders/wc/:id`): ele
   * cancela os cards, devolve a peça bipada e avisa a cliente. Nada disso é
   * refeito aqui — estorno devolve dinheiro, cancelamento desfaz o pedido, e
   * cada um continua com um dono só.
   */
  const cancelarPedido = async () => {
    if (!pagamento?.refWcOrderId) return;
    if (!confirm('Cancelar o pedido inteiro? As peças voltam pro estoque e a cliente é avisada.')) return;
    setIndo('cancelar');
    setErro(null);
    try {
      await api(`/orders/wc/${pagamento.refWcOrderId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'cancelled', cancelReason: 'Estorno integral do pagamento' }),
      });
      setPedidoCancelado(true);
      setAviso('Pedido cancelado.');
    } catch (e) {
      setErro(limpo(e));
    } finally {
      setIndo(null);
    }
  };

  return (
    <div className="space-y-4">
      <button type="button" onClick={aoVoltar} className="text-sm text-slate-600 hover:text-slate-900 flex items-center gap-1">
        <ArrowLeft className="w-4 h-4" /> Voltar pra busca
      </button>

      <div className={`rounded-lg border p-5 ${deuCerto ? 'bg-emerald-50 border-emerald-200' : pendente ? 'bg-amber-50 border-amber-200' : 'bg-rose-50 border-rose-200'}`}>
        <div className="flex items-center gap-2">
          <Selo status={estorno.status} />
          <span className="text-sm text-slate-600">{estorno.tipo === 'integral' ? 'Integral' : 'Parcial'}</span>
        </div>
        <div className="text-3xl font-black text-slate-800 mt-2">{brl(estorno.valorCents)}</div>
        <p className="text-sm text-slate-700 mt-1">
          {deuCerto && 'O gateway confirmou a devolução.'}
          {pendente && 'Estorno solicitado e aguardando processamento do PagBank. Ainda NÃO está concluído.'}
          {!deuCerto && !pendente && `O gateway não concluiu o estorno${estorno.mensagemGateway ? `: ${estorno.mensagemGateway}` : '.'} Nada foi marcado como devolvido.`}
        </p>
        {estorno.statusGateway && (
          <p className="text-[11px] text-slate-500 mt-1">Situação no gateway: {estorno.statusGateway}</p>
        )}
        {pendente && (
          <button
            type="button"
            onClick={() => void consultar()}
            disabled={indo === 'consulta'}
            className="mt-3 px-3 py-2 rounded-lg bg-white border text-sm font-bold text-slate-700 hover:bg-slate-50 flex items-center gap-2"
          >
            {indo === 'consulta' ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            Atualizar status
          </button>
        )}
      </div>

      {erro && <div className="bg-rose-50 border border-rose-200 text-rose-700 text-sm rounded-lg p-3">{erro}</div>}
      {aviso && <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm rounded-lg p-3">{aviso}</div>}

      {podeComprovante && (
        <div className="bg-white rounded-lg shadow border p-4 space-y-3">
          <h2 className="text-sm font-black text-slate-800 uppercase tracking-wide">Comprovante</h2>
          <p className="text-xs text-slate-500">
            {deuCerto
              ? 'O PDF sai como ESTORNO PROCESSADO.'
              : 'O PDF sai como ESTORNO EM PROCESSAMENTO — ele não diz que o dinheiro já voltou, porque o gateway ainda não confirmou.'}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void baixarPdf()}
              disabled={indo === 'pdf'}
              className="px-4 py-2 rounded-lg bg-slate-800 text-white text-sm font-bold hover:bg-slate-900 flex items-center gap-2"
            >
              {indo === 'pdf' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} Baixar PDF
            </button>
          </div>
          <div className="pt-3 border-t space-y-2">
            <label className="block text-[10px] font-bold text-slate-500 uppercase">Enviar pra cliente</label>
            <div className="flex flex-wrap gap-2">
              <input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="email@cliente.com"
                className="flex-1 min-w-[220px] px-3 py-2 border rounded-lg text-sm"
              />
              <input
                type="password"
                value={senhaEmail}
                onChange={(e) => setSenhaEmail(e.target.value)}
                placeholder="Senha Master/Suprema"
                className="w-[200px] px-3 py-2 border rounded-lg text-sm"
                autoComplete="off"
              />
              <button
                type="button"
                onClick={() => void mandarEmail()}
                disabled={indo === 'email' || !email.includes('@')}
                className="px-4 py-2 rounded-lg bg-sky-600 text-white text-sm font-bold hover:bg-sky-700 disabled:opacity-50 flex items-center gap-2"
              >
                {indo === 'email' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />} Enviar
              </button>
            </div>
            {estorno.comprovanteEnviadoEm && (
              <p className="text-[11px] text-slate-500">
                Último envio: {dataHora(estorno.comprovanteEnviadoEm)} para {estorno.comprovanteEmail}.
              </p>
            )}
          </div>
        </div>
      )}

      {deuCerto && estorno.tipo === 'integral' && pagamento?.refWcOrderId && !pedidoCancelado && (
        <div className="bg-white rounded-lg shadow border p-4">
          <h2 className="text-sm font-black text-slate-800 uppercase tracking-wide">E o pedido?</h2>
          <p className="text-xs text-slate-500 mt-1">
            O estorno devolveu o dinheiro, mas o pedido <b>{pagamento.refNumero}</b> continua como está.
            Se a compra não vai acontecer, cancele: as peças voltam pro estoque e a cliente é avisada.
          </p>
          <button
            type="button"
            onClick={() => void cancelarPedido()}
            disabled={indo === 'cancelar'}
            className="mt-3 px-4 py-2 rounded-lg border border-rose-300 text-rose-700 text-sm font-bold hover:bg-rose-50 flex items-center gap-2"
          >
            {indo === 'cancelar' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Ban className="w-4 h-4" />}
            Cancelar o pedido também
          </button>
        </div>
      )}
    </div>
  );
}

// ── Histórico geral ──────────────────────────────────────────────────────────

function Historico({ sessao, expirou }: { sessao: string; expirou: (e: unknown) => boolean }) {
  const [termo, setTermo] = useState('');
  const [origem, setOrigem] = useState('todos');
  const [metodo, setMetodo] = useState('todos');
  const [status, setStatus] = useState('todos');
  const [de, setDe] = useState('');
  const [ate, setAte] = useState('');
  const [linhas, setLinhas] = useState<any[]>([]);
  const [resumo, setResumo] = useState<Resumo | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  const filtros = useCallback(() => {
    const q = new URLSearchParams();
    if (termo.trim()) q.set('termo', termo.trim());
    if (origem !== 'todos') q.set('origem', origem);
    if (metodo !== 'todos') q.set('metodo', metodo);
    if (status !== 'todos') q.set('status', status);
    if (de) q.set('de', de);
    if (ate) q.set('ate', ate);
    return q;
  }, [termo, origem, metodo, status, de, ate]);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const r = await api<{ linhas: any[]; resumo: Resumo }>(`/admin/estornos/historico?${filtros().toString()}`, {
        headers: { 'x-estorno-sessao': sessao },
      });
      setLinhas(r?.linhas || []);
      setResumo(r?.resumo || null);
    } catch (e) {
      if (!expirou(e)) setErro(limpo(e));
    } finally {
      setCarregando(false);
    }
  }, [filtros, sessao, expirou]);

  useEffect(() => { void carregar(); }, [carregar]);

  const exportar = async (formato: 'csv' | 'xlsx' | 'pdf') => {
    const q = filtros();
    q.set('formato', formato);
    try {
      const res = await fetch(`${API_URL}/api/admin/estornos/historico/exportar?${q.toString()}`, {
        headers: { Authorization: `Bearer ${getAuthToken() || ''}`, 'x-estorno-sessao': sessao },
      });
      if (!res.ok) throw new Error(await mensagemDaResposta(res, 'a exportação'));
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `estornos.${formato}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      if (!expirou(e)) setErro(limpo(e));
    }
  };

  const th = 'px-3 py-2 text-left text-[11px] font-bold uppercase text-slate-500 whitespace-nowrap';
  const td = 'px-3 py-2 text-sm whitespace-nowrap';

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-lg shadow border p-4 space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[220px]">
            <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Buscar</label>
            <input
              value={termo}
              onChange={(e) => setTermo(e.target.value)}
              placeholder="Pedido, cliente, CPF, transação ou quem fez"
              className="w-full px-3 py-2 border rounded text-sm"
            />
          </div>
          <div>
            <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Origem</label>
            <select value={origem} onChange={(e) => setOrigem(e.target.value)} className="px-2 py-2 border rounded text-sm">
              <option value="todos">Todas</option>
              <option value="site">Site</option>
              <option value="pdv_online">Venda online</option>
              <option value="live">Live</option>
              <option value="pdv_balcao">Balcão</option>
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Forma</label>
            <select value={metodo} onChange={(e) => setMetodo(e.target.value)} className="px-2 py-2 border rounded text-sm">
              <option value="todos">Todas</option>
              <option value="pix">PIX</option>
              <option value="credit_card">Cartão</option>
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Status</label>
            <select value={status} onChange={(e) => setStatus(e.target.value)} className="px-2 py-2 border rounded text-sm">
              <option value="todos">Todos</option>
              <option value="processado">Processado</option>
              <option value="processando">Em processamento</option>
              <option value="enviado">Enviado</option>
              <option value="recusado">Recusado</option>
              <option value="erro">Erro</option>
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">De</label>
            <input type="date" value={de} onChange={(e) => setDe(e.target.value)} className="px-2 py-2 border rounded text-sm" />
          </div>
          <div>
            <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Até</label>
            <input type="date" value={ate} onChange={(e) => setAte(e.target.value)} className="px-2 py-2 border rounded text-sm" />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {(['csv', 'xlsx', 'pdf'] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => void exportar(f)}
              className="px-3 py-1.5 rounded-lg border text-xs font-bold text-slate-700 hover:bg-slate-50 flex items-center gap-1.5"
            >
              <FileText className="w-3.5 h-3.5" /> {f.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {resumo && (
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          {[
            { rotulo: 'Estornos', valor: String(resumo.quantidade), cor: 'text-slate-800' },
            { rotulo: 'Total devolvido', valor: brl(resumo.totalCents), cor: 'text-rose-700' },
            { rotulo: `PIX (${resumo.pixQtd})`, valor: brl(resumo.pixCents), cor: 'text-slate-800' },
            { rotulo: `Cartão (${resumo.cartaoQtd})`, valor: brl(resumo.cartaoCents), cor: 'text-slate-800' },
            { rotulo: `Pendentes (${resumo.pendentes}) · erros (${resumo.erros})`, valor: brl(resumo.pendentesCents), cor: 'text-amber-700' },
          ].map((k) => (
            <div key={k.rotulo} className="bg-white rounded-lg shadow border p-3">
              <div className="text-[10px] font-bold text-slate-500 uppercase">{k.rotulo}</div>
              <div className={`text-lg font-black ${k.cor}`}>{k.valor}</div>
            </div>
          ))}
        </div>
      )}

      {erro && <div className="bg-rose-50 border border-rose-200 text-rose-700 text-sm rounded-lg p-3">{erro}</div>}

      <div className="bg-white rounded-lg shadow border overflow-x-auto">
        {carregando ? (
          <div className="p-8 text-center text-slate-500"><Loader2 className="w-5 h-5 animate-spin inline" /></div>
        ) : !linhas.length ? (
          <div className="p-8 text-center text-sm text-slate-500">Nenhum estorno nesse recorte.</div>
        ) : (
          <table className="w-full">
            <thead className="bg-slate-50 border-b">
              <tr>
                <th className={th}>Quando</th>
                <th className={th}>Pedido</th>
                <th className={th}>Origem</th>
                <th className={th}>Cliente</th>
                <th className={th}>Forma</th>
                <th className={`${th} text-right`}>Valor</th>
                <th className={th}>Situação</th>
                <th className={th}>Motivo</th>
                <th className={th}>Quem fez</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {linhas.map((l) => (
                <tr key={l.id} className="hover:bg-slate-50">
                  <td className={`${td} text-slate-500`}>{dataHora(l.createdAt)}</td>
                  <td className={`${td} font-bold text-slate-800`}>{l.refNumero || '—'}</td>
                  <td className={`${td} text-slate-600`}>{ORIGENS[l.origem] || l.origem}</td>
                  <td className={td}>{l.clienteNome || '—'}</td>
                  <td className={`${td} text-slate-600`}>{String(l.metodo || '').includes('pix') ? 'PIX' : 'Cartão'}</td>
                  <td className={`${td} text-right font-bold`}>{brl(l.valorCents)}</td>
                  <td className={td}><Selo status={l.status} /></td>
                  <td className={`${td} text-slate-600`}>{l.motivoTexto || l.motivo}</td>
                  <td className={`${td} text-slate-500 text-xs`}>
                    {l.usuarioNome || '—'}
                    {l.autorizadoPorNome ? ` · PIN ${l.autorizadoPorNome}` : ''}
                    <span className="ml-1 text-[10px] text-slate-400">{l.nivelAutorizacao}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
