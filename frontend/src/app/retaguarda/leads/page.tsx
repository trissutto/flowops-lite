'use client';

/**
 * /retaguarda/leads
 *
 * Quem deixou nome, celular e e-mail no popup do cupom da loja online.
 *
 * ── POR QUE ESTA TELA EXISTE ──
 *
 * Captar lead sem lugar pra olhar é o mesmo que não captar. O popup entrega
 * 10% na primeira compra e grava em `site_lead` — uma tabela SEPARADA do CRM
 * de propósito: aqui é gente que ainda NÃO comprou, e misturar isso com a base
 * mestra embaralha LTV e enche a ficha de cliente que nunca existiu. Quando ela
 * compra, o pedido cria/atualiza o cadastro pelos caminhos de sempre.
 *
 * O botão de EXPORTAR é o ponto da tela: a lista serve pra virar disparo de
 * WhatsApp/e-mail, e isso acontece fora daqui.
 */

import { useCallback, useEffect, useState } from 'react';
import { Download, Loader2, RefreshCw, Search, Users } from 'lucide-react';
import { api } from '@/lib/api';
import { falarComCliente } from '@/lib/whatsapp';

interface Lead {
  id: string;
  nome: string;
  telefone: string;
  email: string;
  cupom: string;
  origem: string | null;
  createdAt: string;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** "13996050174" → "(13) 99605-0174". O banco guarda só dígitos. */
function formatarTelefone(v: string): string {
  const d = String(v || '').replace(/\D/g, '');
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return v;
}

export default function LeadsPage() {
  const hoje = new Date();
  const mesPassado = new Date(hoje.getFullYear(), hoje.getMonth() - 1, hoje.getDate());

  const [de, setDe] = useState(iso(mesPassado));
  const [ate, setAte] = useState(iso(hoje));
  const [busca, setBusca] = useState('');
  const [itens, setItens] = useState<Lead[]>([]);
  const [total, setTotal] = useState(0);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const buscar = useCallback(async (pDe = de, pAte = ate, pBusca = busca) => {
    setCarregando(true);
    setErro(null);
    try {
      const qs = new URLSearchParams({ de: pDe, ate: pAte });
      if (pBusca.trim()) qs.set('busca', pBusca.trim());
      const r = await api<{ itens: Lead[]; total: number }>(`/site-leads?${qs.toString()}`);
      setItens(r?.itens || []);
      setTotal(r?.total || 0);
    } catch (e: any) {
      setErro(e?.message || 'Falha ao carregar');
    } finally {
      setCarregando(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [de, ate, busca]);

  useEffect(() => { buscar(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  /** Atalhos de período — convenção da casa: De/Até + Hoje/Ontem/7 dias/Mês. */
  const atalho = (tipo: 'hoje' | 'ontem' | '7d' | 'mes' | 'mesAnterior') => {
    const h = new Date();
    let nDe = de;
    let nAte = ate;
    if (tipo === 'hoje') { nDe = iso(h); nAte = iso(h); }
    if (tipo === 'ontem') { const d = new Date(h); d.setDate(d.getDate() - 1); nDe = iso(d); nAte = iso(d); }
    if (tipo === '7d') { const d = new Date(h); d.setDate(d.getDate() - 7); nDe = iso(d); nAte = iso(h); }
    if (tipo === 'mes') { nDe = iso(new Date(h.getFullYear(), h.getMonth(), 1)); nAte = iso(h); }
    if (tipo === 'mesAnterior') {
      nDe = iso(new Date(h.getFullYear(), h.getMonth() - 1, 1));
      nAte = iso(new Date(h.getFullYear(), h.getMonth(), 0));
    }
    setDe(nDe); setAte(nAte);
    buscar(nDe, nAte, busca);
  };

  /**
   * CSV com BOM: sem ele o Excel em português abre "João" como "JoÃ£o" e a
   * planilha chega torta na mão de quem vai disparar as mensagens.
   */
  const exportar = () => {
    const linhas = [
      ['Nome', 'Celular', 'E-mail', 'Cupom', 'Origem', 'Cadastro'],
      ...itens.map((l) => [
        l.nome,
        formatarTelefone(l.telefone),
        l.email,
        l.cupom,
        l.origem || '',
        new Date(l.createdAt).toLocaleString('pt-BR'),
      ]),
    ];
    const csv = linhas
      .map((cols) => cols.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(';'))
      .join('\r\n');
    const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `leads-site-${de}-a-${ate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Users className="h-5 w-5 text-emerald-600" />
        <h1 className="text-lg font-bold text-slate-800">Cadastros do site (cupom de boas-vindas)</h1>
      </div>

      {/* Filtros — De/Até + atalhos (convenção da casa) */}
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-3">
        <div>
          <label className="block text-[10px] font-bold text-slate-400 uppercase">De</label>
          <input type="date" value={de} onChange={(e) => setDe(e.target.value)}
            className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm" />
        </div>
        <div>
          <label className="block text-[10px] font-bold text-slate-400 uppercase">Até</label>
          <input type="date" value={ate} onChange={(e) => setAte(e.target.value)}
            className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm" />
        </div>
        <div className="flex gap-1">
          {([['hoje', 'Hoje'], ['ontem', 'Ontem'], ['7d', '7 dias'], ['mes', 'Mês'], ['mesAnterior', 'Mês anterior']] as const).map(([k, l]) => (
            <button key={k} onClick={() => atalho(k)}
              className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-bold text-slate-600 hover:border-emerald-300 hover:bg-emerald-50">
              {l}
            </button>
          ))}
        </div>
        <div className="min-w-[200px] flex-1">
          <label className="block text-[10px] font-bold text-slate-400 uppercase">Buscar</label>
          <input
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') buscar(); }}
            placeholder="nome, e-mail ou celular"
            className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
          />
        </div>
        <button onClick={() => buscar()} disabled={carregando}
          className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-700 disabled:opacity-50">
          {carregando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />} Buscar
        </button>
        <button onClick={() => buscar()} disabled={carregando} title="Atualizar"
          className="rounded-lg border border-slate-300 px-3 py-2 text-slate-600 hover:bg-slate-50">
          <RefreshCw className="h-4 w-4" />
        </button>
        <button onClick={exportar} disabled={!itens.length}
          className="ml-auto flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm font-bold text-slate-600 hover:bg-slate-50 disabled:opacity-40">
          <Download className="h-4 w-4" /> Exportar CSV
        </button>
      </div>

      {erro && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{erro}</div>
      )}

      <div className="rounded-xl border border-slate-200 bg-white">
        <div className="border-b border-slate-100 px-4 py-2.5 text-xs font-bold text-slate-500">
          {total} cadastro{total === 1 ? '' : 's'} no período
          {itens.length < total && ` · mostrando os ${itens.length} mais recentes`}
        </div>

        {!carregando && itens.length === 0 ? (
          <p className="p-8 text-center text-sm text-slate-500">
            Nenhum cadastro neste período. O popup só aparece pra quem rolou meia tela e ficou
            uns 15 segundos — e uma vez por pessoa.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-[11px] font-bold text-slate-500 uppercase">
                <tr>
                  <th className="px-4 py-2">Nome</th>
                  <th className="px-4 py-2">Celular</th>
                  <th className="px-4 py-2">E-mail</th>
                  <th className="px-4 py-2">Cupom</th>
                  <th className="px-4 py-2">Onde se cadastrou</th>
                  <th className="px-4 py-2">Quando</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {itens.map((l) => (
                  <tr key={l.id} className="hover:bg-slate-50">
                    <td className="px-4 py-2 font-medium text-slate-800">{l.nome}</td>
                    <td className="px-4 py-2 text-slate-600 tabular-nums">
                      <button
                        type="button"
                        onClick={() => falarComCliente(l.telefone)}
                        className="text-emerald-700 hover:underline"
                        title="Abre no WhatsApp que já está logado neste PC"
                      >
                        {formatarTelefone(l.telefone)}
                      </button>
                    </td>
                    <td className="px-4 py-2 text-slate-600">{l.email}</td>
                    <td className="px-4 py-2">
                      <span className="rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-xs font-bold text-amber-800">
                        {l.cupom}
                      </span>
                    </td>
                    <td className="max-w-[240px] truncate px-4 py-2 text-xs text-slate-500" title={l.origem || ''}>
                      {l.origem || '—'}
                    </td>
                    <td className="px-4 py-2 text-xs text-slate-500">
                      {new Date(l.createdAt).toLocaleString('pt-BR')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
