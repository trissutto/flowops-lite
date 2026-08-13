'use client';

/**
 * /retaguarda/cliques-lojas
 *
 * Quantas pessoas pediram rota, chamaram no WhatsApp, abriram o Instagram ou
 * ligaram — LOJA POR LOJA, no período escolhido.
 *
 * Pedido do dono em 13/08/2026. A página /lojas do site tinha esses quatro
 * botões em 14 unidades e nenhum deles disparava evento: o clique que mais
 * aproxima cliente de loja física era o único sem medida em todo o sistema.
 *
 * Por que a tela existe em vez de "olhe no GA4": o dado é gravado no NOSSO
 * Postgres (`site_store_clicks`), então não depende de cota de API, não sofre
 * amostragem do Google e fica ao lado do resto da operação. O evento continua
 * indo pro GA4 em paralelo — aqui é a cópia que é nossa.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, Instagram, Loader2, MapPin, MessageCircle,
  Phone, RefreshCw, Users,
} from 'lucide-react';
import { api } from '@/lib/api';

type Linha = {
  loja: string;
  comoChegar: number;
  whatsapp: number;
  instagram: number;
  telefone: number;
  total: number;
  pessoas: number;
};

type Resposta = { de: string; ate: string; totalCliques: number; linhas: Linha[] };

const iso = (d: Date) => d.toISOString().slice(0, 10);

export default function CliquesLojasPage() {
  const [de, setDe] = useState('');
  const [ate, setAte] = useState('');
  const [dados, setDados] = useState<Resposta | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');
    try {
      const qs = new URLSearchParams();
      if (de) qs.set('de', de);
      if (ate) qs.set('ate', ate);
      const r = await api<Resposta>(`/site-metrics/lojas${qs.toString() ? `?${qs}` : ''}`);
      setDados(r);
    } catch (e: any) {
      setErro(e?.message || 'Não consegui carregar');
    } finally {
      setCarregando(false);
    }
  }, [de, ate]);

  useEffect(() => { carregar(); }, [carregar]);

  /** Atalhos olham pra TRÁS — aqui o passado é que interessa, ao contrário da
   *  tela de contas a pagar, onde "7 dias" são os vencimentos que vêm. */
  const atalho = (qual: number | 'hoje' | 'ontem' | 'mes') => {
    const h = new Date();
    if (qual === 'hoje') { setDe(iso(h)); setAte(iso(h)); }
    else if (qual === 'ontem') {
      const o = new Date(h.getTime() - 86400000);
      setDe(iso(o)); setAte(iso(o));
    } else if (qual === 'mes') {
      setDe(iso(new Date(h.getFullYear(), h.getMonth(), 1)));
      setAte(iso(new Date(h.getFullYear(), h.getMonth() + 1, 0)));
    } else {
      setDe(iso(new Date(h.getTime() - qual * 86400000))); setAte(iso(h));
    }
  };

  const linhas = dados?.linhas ?? [];
  const soma = (campo: keyof Linha) =>
    linhas.reduce((s, l) => s + (Number(l[campo]) || 0), 0);

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-5">
      <div className="flex items-center gap-3">
        <Link href="/retaguarda" className="text-slate-500 hover:text-slate-800">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div className="flex-1">
          <h1 className="text-xl font-bold text-slate-800">Cliques nas lojas</h1>
          <p className="text-sm text-slate-500">
            Quem pediu rota, chamou no WhatsApp ou abriu o Instagram — por unidade.
          </p>
        </div>
        <button
          onClick={carregar}
          className="px-3 py-2 rounded-lg border border-[#E7E2D8] hover:bg-[#FBF6E6] text-slate-600"
          title="Atualizar"
        >
          <RefreshCw className={`w-4 h-4 ${carregando ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* filtros — De/Até + atalhos, padrão de toda tela com período */}
      <div className="bg-white border border-[#E7E2D8] rounded-xl p-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <label className="text-slate-500 font-semibold">De</label>
          <input
            type="date" value={de} onChange={(e) => setDe(e.target.value)}
            className="border border-[#E7E2D8] rounded-lg px-2 py-1"
          />
          <label className="text-slate-500 font-semibold">Até</label>
          <input
            type="date" value={ate} onChange={(e) => setAte(e.target.value)}
            className="border border-[#E7E2D8] rounded-lg px-2 py-1"
          />
          <button onClick={() => atalho('hoje')} className="px-3 py-1 rounded-full border border-[#E7E2D8] hover:bg-[#FBF6E6] font-semibold text-slate-600">Hoje</button>
          <button onClick={() => atalho('ontem')} className="px-3 py-1 rounded-full border border-[#E7E2D8] hover:bg-[#FBF6E6] font-semibold text-slate-600">Ontem</button>
          <button onClick={() => atalho(7)} className="px-3 py-1 rounded-full border border-[#E7E2D8] hover:bg-[#FBF6E6] font-semibold text-slate-600">7 dias</button>
          <button onClick={() => atalho('mes')} className="px-3 py-1 rounded-full border border-[#E7E2D8] hover:bg-[#FBF6E6] font-semibold text-slate-600">Mês</button>
          <button onClick={() => { setDe(''); setAte(''); }} className="px-3 py-1 rounded-full border border-[#E7E2D8] hover:bg-[#FBF6E6] text-slate-500">Limpar (30 dias)</button>
        </div>
      </div>

      {erro && (
        <div className="bg-rose-50 border border-rose-200 text-rose-700 rounded-xl p-4 text-sm">{erro}</div>
      )}

      {carregando && !dados ? (
        <div className="flex items-center gap-2 text-slate-500 p-8 justify-center">
          <Loader2 className="w-5 h-5 animate-spin" /> Carregando…
        </div>
      ) : linhas.length === 0 ? (
        <div className="bg-white border border-[#E7E2D8] rounded-xl p-8 text-center space-y-2">
          <p className="font-semibold text-slate-700">Nenhum clique no período.</p>
          {/* Vazio aqui tem 3 causas legítimas e nenhuma é "quebrou". Dizer
              quais evita o chamado de "a tela não funciona". */}
          <p className="text-sm text-slate-500 max-w-xl mx-auto">
            A contagem começa na data em que esta medição entrou no ar — não é
            retroativa. Só conta quem aceitou o banner de cookies do site
            (exigência da LGPD), e o período pode simplesmente não ter tido
            clique.
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <Cartao titulo="Como chegar" valor={soma('comoChegar')} icone={<MapPin className="w-4 h-4" />} cor="text-slate-800" />
            <Cartao titulo="WhatsApp" valor={soma('whatsapp')} icone={<MessageCircle className="w-4 h-4" />} cor="text-[#2E7D46]" />
            <Cartao titulo="Instagram" valor={soma('instagram')} icone={<Instagram className="w-4 h-4" />} cor="text-slate-800" />
            <Cartao titulo="Telefone" valor={soma('telefone')} icone={<Phone className="w-4 h-4" />} cor="text-slate-800" />
            <Cartao titulo="Pessoas" valor={soma('pessoas')} icone={<Users className="w-4 h-4" />} cor="text-[#B8912B]" />
          </div>

          <div className="bg-white border border-[#E7E2D8] rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-[#FBF6E6] text-slate-600">
                <tr>
                  <th className="text-left px-4 py-3 font-semibold">Loja</th>
                  <th className="text-right px-4 py-3 font-semibold">Como chegar</th>
                  <th className="text-right px-4 py-3 font-semibold">WhatsApp</th>
                  <th className="text-right px-4 py-3 font-semibold">Instagram</th>
                  <th className="text-right px-4 py-3 font-semibold">Telefone</th>
                  <th className="text-right px-4 py-3 font-semibold">Total</th>
                  <th className="text-right px-4 py-3 font-semibold" title="Sessões distintas: quantas pessoas, não quantos cliques">
                    Pessoas
                  </th>
                </tr>
              </thead>
              <tbody>
                {linhas.map((l) => (
                  <tr key={l.loja} className="border-t border-[#E7E2D8] hover:bg-[#FBF6E6]/40">
                    <td className="px-4 py-3 font-semibold text-slate-800">
                      {/* "—" é o clique que não nasceu de uma unidade. Aparece
                          em vez de sumir, pra o total da tela bater. */}
                      {l.loja === '—' ? <span className="text-slate-400">Sem loja definida</span> : l.loja}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{l.comoChegar || '–'}</td>
                    <td className="px-4 py-3 text-right tabular-nums font-semibold text-[#2E7D46]">{l.whatsapp || '–'}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{l.instagram || '–'}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{l.telefone || '–'}</td>
                    <td className="px-4 py-3 text-right tabular-nums font-bold text-slate-800">{l.total}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-500">{l.pessoas || '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="text-xs text-slate-400">
            Contagem anônima: nenhum dado identifica a pessoa. Para saber QUEM
            chamou, a conversa está no WhatsApp da unidade.
          </p>
        </>
      )}
    </div>
  );
}

function Cartao({ titulo, valor, icone, cor }: { titulo: string; valor: number; icone: React.ReactNode; cor: string }) {
  return (
    <div className="bg-white border border-[#E7E2D8] rounded-xl p-4">
      <div className="flex items-center gap-2 text-slate-500 text-xs font-semibold uppercase tracking-wide">
        {icone} {titulo}
      </div>
      <div className={`mt-2 text-2xl font-bold tabular-nums ${cor}`}>{valor}</div>
    </div>
  );
}
