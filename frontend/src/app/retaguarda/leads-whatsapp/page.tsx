'use client';

/**
 * /retaguarda/leads-whatsapp — O WHATSAPP DE QUEM CLICOU.
 *
 * A pergunta do dono (13/08): "onde vejo o whats de quem clicou?". O clique
 * no site é anônimo; a pessoa passa a existir quando ENVIA a mensagem
 * carimbada ("vim pelo site") no WhatsApp — a Evolution recebe, o n8n
 * reconhece o carimbo e grava em `whatsapp_leads`. Esta tela é a lista:
 * quem, quando, de qual loja — com o link pronto pra responder.
 *
 * Filtro De/Até + atalhos, como toda tela de período do sistema.
 */

import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { falarComCliente } from '@/lib/whatsapp';
import {
  AlertCircle, Loader2, MessageCircle, RefreshCw, Search, Store,
} from 'lucide-react';

interface Lead {
  id: string;
  telefone: string;
  nome: string | null;
  loja: string | null;
  mensagem: string | null;
  instancia: string | null;
  criadoEm: string;
}
interface Resposta {
  de: string;
  ate: string;
  total: number;
  porLoja: Array<{ loja: string; leads: number }>;
  linhas: Lead[];
}

function dataISO(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export default function LeadsWhatsappPage() {
  const [de, setDe] = useState('');
  const [ate, setAte] = useState('');
  const [dados, setDados] = useState<Resposta | null>(null);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [busca, setBusca] = useState('');

  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_token') : null;
    if (!token) window.location.href = '/login';
  }, []);

  async function carregar(deQ = de, ateQ = ate) {
    setLoading(true);
    setErro(null);
    try {
      const q = new URLSearchParams();
      if (deQ) q.set('de', deQ);
      if (ateQ) q.set('ate', ateQ);
      setDados(await api<Resposta>(`/site-metrics/whatsapp-leads?${q}`));
    } catch (e: any) {
      setErro(e?.message ?? 'Falha ao carregar');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { carregar(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  function atalho(dias: number | 'hoje' | 'ontem' | 'mes') {
    const hoje = new Date();
    let d = '';
    let a = dataISO(hoje);
    if (dias === 'hoje') d = a;
    else if (dias === 'ontem') {
      const ontem = new Date(hoje.getTime() - 24 * 60 * 60 * 1000);
      d = dataISO(ontem); a = dataISO(ontem);
    } else if (dias === 'mes') {
      d = dataISO(new Date(hoje.getFullYear(), hoje.getMonth(), 1));
    } else {
      d = dataISO(new Date(hoje.getTime() - (dias - 1) * 24 * 60 * 60 * 1000));
    }
    setDe(d); setAte(a);
    void carregar(d, a);
  }

  const linhas = useMemo(() => {
    const lista = dados?.linhas ?? [];
    const q = busca.trim().toLowerCase();
    if (!q) return lista;
    return lista.filter((l) =>
      l.telefone.includes(q.replace(/\D/g, '') || '§') ||
      (l.nome ?? '').toLowerCase().includes(q) ||
      (l.loja ?? '').toLowerCase().includes(q),
    );
  }, [dados, busca]);

  function fmtTelefone(t: string): string {
    const semDdi = t.startsWith('55') ? t.slice(2) : t;
    if (semDdi.length === 11) return `(${semDdi.slice(0, 2)}) ${semDdi.slice(2, 7)}-${semDdi.slice(7)}`;
    if (semDdi.length === 10) return `(${semDdi.slice(0, 2)}) ${semDdi.slice(2, 6)}-${semDdi.slice(6)}`;
    return t;
  }

  function fmtQuando(iso: string): string {
    return new Date(iso).toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
      timeZone: 'America/Sao_Paulo',
    });
  }

  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="mb-5 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <MessageCircle className="w-6 h-6 text-emerald-600" /> Leads do WhatsApp
          </h1>
          <p className="text-sm text-slate-500 mt-1 max-w-2xl">
            Quem clicou no site <b>e mandou a mensagem carimbada</b> (&quot;vim pelo site&quot;) —
            com nome, número e loja. Quem só clicou e não enviou continua anônimo (aparece na
            tela de cliques).
          </p>
        </div>
        <button
          onClick={() => carregar()}
          className="px-3 py-2 border rounded text-sm hover:bg-slate-50 flex items-center gap-2"
        >
          <RefreshCw className="w-4 h-4" /> Atualizar
        </button>
      </div>

      <div className="mb-5 bg-white rounded-lg shadow border p-3 flex items-end gap-3 flex-wrap">
        <div>
          <label className="block text-xs text-slate-500 mb-1">De</label>
          <input type="date" value={de} onChange={(e) => setDe(e.target.value)} className="px-3 py-2 border rounded text-sm" />
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-1">Até</label>
          <input type="date" value={ate} onChange={(e) => setAte(e.target.value)} className="px-3 py-2 border rounded text-sm" />
        </div>
        <button onClick={() => carregar()} className="px-3 py-2 bg-slate-800 text-white rounded text-sm">Buscar</button>
        <div className="flex gap-2 flex-wrap">
          <button onClick={() => atalho('hoje')} className="px-3 py-2 border rounded-full text-sm hover:bg-slate-50">Hoje</button>
          <button onClick={() => atalho('ontem')} className="px-3 py-2 border rounded-full text-sm hover:bg-slate-50">Ontem</button>
          <button onClick={() => atalho(7)} className="px-3 py-2 border rounded-full text-sm hover:bg-slate-50">7 dias</button>
          <button onClick={() => atalho('mes')} className="px-3 py-2 border rounded-full text-sm hover:bg-slate-50">Mês</button>
        </div>
      </div>

      {dados && (
        <div className="mb-5 grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="rounded-lg border bg-white p-3">
            <div className="text-2xl font-bold text-emerald-700">{dados.total}</div>
            <div className="text-xs text-slate-500">Leads no período</div>
          </div>
          {dados.porLoja.slice(0, 3).map((l) => (
            <div key={l.loja} className="rounded-lg border bg-white p-3">
              <div className="text-2xl font-bold">{l.leads}</div>
              <div className="text-xs text-slate-500 flex items-center gap-1">
                <Store className="w-3 h-3" /> {l.loja}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="mb-4 relative max-w-sm">
        <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
        <input
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          placeholder="Filtrar por nome, telefone ou loja"
          className="w-full pl-9 pr-3 py-2 border rounded text-sm"
        />
      </div>

      {erro && (
        <div className="mb-4 rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-700 flex items-center gap-2">
          <AlertCircle className="w-4 h-4" /> {erro}
        </div>
      )}

      {loading ? (
        <div className="py-16 text-center text-slate-400">
          <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" /> Carregando…
        </div>
      ) : !linhas.length ? (
        <div className="py-16 text-center text-slate-400">
          Nenhum lead no período — os carimbos começam a chegar assim que a automação do
          WhatsApp estiver ligada.
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-amber-50 text-left">
                <th className="px-4 py-3 font-semibold">Quando</th>
                <th className="px-4 py-3 font-semibold">Nome</th>
                <th className="px-4 py-3 font-semibold">WhatsApp</th>
                <th className="px-4 py-3 font-semibold">Loja</th>
                <th className="px-4 py-3 font-semibold">Mensagem</th>
              </tr>
            </thead>
            <tbody>
              {linhas.map((l) => (
                <tr key={l.id} className="border-t">
                  <td className="px-4 py-3 whitespace-nowrap text-slate-500">{fmtQuando(l.criadoEm)}</td>
                  <td className="px-4 py-3">{l.nome || <span className="text-slate-400">—</span>}</td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => falarComCliente(l.telefone)}
                      className="text-emerald-700 hover:underline font-medium"
                      title="Abre no WhatsApp que já está logado neste PC"
                    >
                      {fmtTelefone(l.telefone)}
                    </button>
                  </td>
                  <td className="px-4 py-3">{l.loja || <span className="text-slate-400">Atendimento site</span>}</td>
                  <td className="px-4 py-3 text-slate-600 max-w-md truncate" title={l.mensagem ?? ''}>
                    {l.mensagem || '—'}
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
