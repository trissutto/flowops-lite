'use client';

/**
 * /retaguarda/cores-sem-foto — RADAR E BOTÃO DAS CORES SEM FOTO.
 *
 * ── AS DUAS REGRAS QUE SE ENCONTRAM AQUI (13/08/2026) ──
 *
 * De manhã: "quem vira bolinha é quem tem PEÇA" — esconder cor sem foto
 * escondia estoque vendável (caso VOGUE: 570 peças em 21 cores, 3 com foto;
 * 392 peças anunciadas sem como comprar). Cor sem foto própria passou a
 * aparecer com as fotos das irmãs + aviso "ainda não temos foto de …".
 *
 * À tarde: "cor sem foto não devia aparecer" — verdade pra peça sem estoque
 * relevante ou foto emprestada que engana. As duas regras juntas viram ISTO:
 * o automático continua sendo o estoque, e AQUI o dono decide a exceção, cor
 * a cor, vendo o estoque de cada uma. O clique grava `nao_publicar` na ficha
 * da cor (que a vitrine agora honra) — e é reversível.
 *
 * A lista também é a FILA DE FOTOS: toda cor aqui está vendendo com foto
 * emprestada. Subiu a foto na tela master → sai da lista sozinha.
 */

import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import {
  AlertCircle, Check, Copy, Eye, EyeOff, ImageOff, Loader2, RefreshCw, Search,
} from 'lucide-react';

interface CorSemFoto {
  nome: string;
  estoque: number;
  refDona: string;
  marcaDona: string | null;
}
interface CorOculta extends CorSemFoto {
  motivo: string;
}
interface PecaRadar {
  ref: string;
  slug: string;
  nome: string;
  marca: string | null;
  capa: string | null;
  semFoto: CorSemFoto[];
  ocultas: CorOculta[];
}
interface Radar {
  pecas: PecaRadar[];
  totais: { pecasAfetadas: number; coresSemFoto: number; coresOcultas: number };
}

export default function CoresSemFotoPage() {
  const [radar, setRadar] = useState<Radar | null>(null);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [busca, setBusca] = useState('');
  /** `ref|cor` das ações em voo — trava o botão certo, não a tela inteira. */
  const [agindo, setAgindo] = useState<Set<string>>(new Set());
  const [lote, setLote] = useState(false);

  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_token') : null;
    if (!token) window.location.href = '/login';
  }, []);

  async function carregar() {
    setLoading(true);
    setErro(null);
    try {
      setRadar(await api<Radar>('/loja-catalog/cores-sem-foto'));
    } catch (e: any) {
      setErro(e?.message ?? 'Falha ao carregar');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { carregar(); }, []);

  /** Grava o status na ficha da cor e volta com o radar já recalculado. */
  async function mudarStatus(cor: CorSemFoto, status: 'nao_publicar' | 'publicado') {
    const chave = `${cor.refDona}|${cor.nome}`;
    setAgindo((s) => new Set(s).add(chave));
    setErro(null);
    try {
      const marca = cor.marcaDona ? `?marca=${encodeURIComponent(cor.marcaDona)}` : '';
      await api(
        `/produto-ficha/${encodeURIComponent(cor.refDona)}/cor/${encodeURIComponent(cor.nome)}${marca}`,
        { method: 'PATCH', body: JSON.stringify({ statusPublicacao: status }) },
      );
      // Sem o recarregar, o banco muda e a tela/site mostram o passado por
      // até 1h — o clássico "cliquei e não funcionou".
      setRadar(await api<Radar>('/loja-catalog/cores-sem-foto/recarregar', { method: 'POST' }));
      setAviso(
        status === 'nao_publicar'
          ? `${cor.nome} (${cor.refDona}) saiu do site.`
          : `${cor.nome} (${cor.refDona}) voltou pro site.`,
      );
    } catch (e: any) {
      setErro(e?.message ?? 'Falha ao gravar');
    } finally {
      setAgindo((s) => { const n = new Set(s); n.delete(chave); return n; });
    }
  }

  /** A regra dura, aplicada de uma vez — com o número na frente antes do sim. */
  async function ocultarTodas() {
    const todas = (radar?.pecas ?? []).flatMap((p) => p.semFoto);
    if (!todas.length) return;
    const estoqueTotal = todas.reduce((s, c) => s + (c.estoque || 0), 0);
    const ok = window.confirm(
      `Ocultar ${todas.length} cor(es) sem foto?\n\n` +
      `⚠️ Elas somam ${estoqueTotal} peça(s) EM ESTOQUE que deixam de ser vendidas no site ` +
      `até alguém subir foto ou publicar de volta aqui.`,
    );
    if (!ok) return;
    setLote(true);
    setErro(null);
    try {
      for (const cor of todas) {
        const marca = cor.marcaDona ? `?marca=${encodeURIComponent(cor.marcaDona)}` : '';
        await api(
          `/produto-ficha/${encodeURIComponent(cor.refDona)}/cor/${encodeURIComponent(cor.nome)}${marca}`,
          { method: 'PATCH', body: JSON.stringify({ statusPublicacao: 'nao_publicar' }) },
        );
      }
      setRadar(await api<Radar>('/loja-catalog/cores-sem-foto/recarregar', { method: 'POST' }));
      setAviso(`${todas.length} cor(es) ocultada(s).`);
    } catch (e: any) {
      setErro(e?.message ?? 'Falha no lote — parte pode ter sido aplicada; recarregue.');
    } finally {
      setLote(false);
    }
  }

  function copiarRef(ref: string) {
    navigator.clipboard?.writeText(ref);
    setAviso(`REF ${ref} copiada — cole na busca da tela master pra subir a foto.`);
  }

  const pecas = useMemo(() => {
    const lista = radar?.pecas ?? [];
    const q = busca.trim().toUpperCase();
    if (!q) return lista;
    return lista.filter(
      (p) => p.ref.toUpperCase().includes(q) || p.nome.toUpperCase().includes(q),
    );
  }, [radar, busca]);

  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="mb-5 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ImageOff className="w-6 h-6" /> Cores sem foto
          </h1>
          <p className="text-sm text-slate-500 mt-1 max-w-2xl">
            Estas cores estão <b>no ar vendendo com foto emprestada</b> das irmãs (e o site avisa
            &quot;ainda não temos foto&quot;). Subiu a foto na tela master, a cor sai daqui sozinha.
            Se preferir tirar do site, o botão grava na ficha — e dá pra desfazer.
          </p>
        </div>
        <button
          onClick={() => carregar()}
          className="px-3 py-2 border rounded text-sm hover:bg-slate-50 flex items-center gap-2"
        >
          <RefreshCw className="w-4 h-4" /> Atualizar
        </button>
      </div>

      {radar && (
        <div className="mb-5 grid grid-cols-2 sm:grid-cols-3 gap-3">
          <Kpi rotulo="Peças afetadas" valor={radar.totais.pecasAfetadas} />
          <Kpi rotulo="Cores no ar sem foto" valor={radar.totais.coresSemFoto} tom="alerta" />
          <Kpi rotulo="Cores ocultadas à mão" valor={radar.totais.coresOcultas} />
        </div>
      )}

      <div className="mb-4 flex items-end gap-3 flex-wrap">
        <div className="flex-1 min-w-[240px]">
          <label className="block text-xs text-slate-500 mb-1">Filtrar por REF ou nome</label>
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
            <input
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder="ex: VOGUE, blusa manga curta"
              className="w-full pl-9 pr-3 py-2 border rounded text-sm"
            />
          </div>
        </div>
        <button
          onClick={ocultarTodas}
          disabled={lote || !(radar?.totais.coresSemFoto ?? 0)}
          className="px-3 py-2 border border-rose-300 text-rose-700 rounded text-sm hover:bg-rose-50 disabled:opacity-40 flex items-center gap-2"
          title="Aplica 'não publicar' em todas as cores sem foto — mostra o estoque afetado antes de confirmar"
        >
          {lote ? <Loader2 className="w-4 h-4 animate-spin" /> : <EyeOff className="w-4 h-4" />}
          Ocultar todas sem foto
        </button>
      </div>

      {erro && (
        <div className="mb-4 rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-700 flex items-center gap-2">
          <AlertCircle className="w-4 h-4" /> {erro}
        </div>
      )}
      {aviso && (
        <div className="mb-4 rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-800 flex items-center gap-2">
          <Check className="w-4 h-4" /> {aviso}
        </div>
      )}

      {loading ? (
        <div className="py-16 text-center text-slate-400">
          <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" /> Montando o radar…
        </div>
      ) : !pecas.length ? (
        <div className="py-16 text-center text-slate-400">
          Nenhuma peça com cor sem foto — catálogo redondo. 🎉
        </div>
      ) : (
        <div className="space-y-3">
          {pecas.map((p) => (
            <div key={p.ref} className="bg-white rounded-lg shadow border p-4 flex gap-4">
              {p.capa ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={p.capa} alt={p.nome} className="w-16 h-20 object-cover rounded shrink-0" />
              ) : (
                <div className="w-16 h-20 rounded bg-slate-100 flex items-center justify-center shrink-0">
                  <ImageOff className="w-5 h-5 text-slate-300" />
                </div>
              )}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold">{p.nome}</span>
                  <button
                    onClick={() => copiarRef(p.ref)}
                    className="text-xs text-slate-500 border rounded px-1.5 py-0.5 hover:bg-slate-50 flex items-center gap-1"
                    title="Copiar REF pra colar na tela master"
                  >
                    {p.ref} <Copy className="w-3 h-3" />
                  </button>
                  {p.marca && <span className="text-xs text-slate-400">{p.marca}</span>}
                </div>

                {p.semFoto.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {p.semFoto.map((c) => {
                      const chave = `${c.refDona}|${c.nome}`;
                      return (
                        <span
                          key={chave}
                          className="inline-flex items-center gap-2 text-sm border border-amber-300 bg-amber-50 text-amber-900 rounded-full pl-3 pr-1 py-1"
                        >
                          {c.nome}
                          <b className="text-xs">{c.estoque} pç</b>
                          <button
                            onClick={() => mudarStatus(c, 'nao_publicar')}
                            disabled={agindo.has(chave)}
                            className="rounded-full border border-amber-300 px-2 py-0.5 text-xs hover:bg-white disabled:opacity-40 flex items-center gap-1"
                            title="Tirar esta cor do site (grava 'não publicar' na ficha)"
                          >
                            {agindo.has(chave)
                              ? <Loader2 className="w-3 h-3 animate-spin" />
                              : <EyeOff className="w-3 h-3" />}
                            ocultar
                          </button>
                        </span>
                      );
                    })}
                  </div>
                )}

                {p.ocultas.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {p.ocultas.map((c) => {
                      const chave = `${c.refDona}|${c.nome}`;
                      return (
                        <span
                          key={chave}
                          className="inline-flex items-center gap-2 text-sm border border-slate-300 bg-slate-100 text-slate-600 rounded-full pl-3 pr-1 py-1"
                        >
                          <EyeOff className="w-3 h-3" /> {c.nome}
                          <b className="text-xs">{c.estoque} pç</b>
                          <button
                            onClick={() => mudarStatus(c, 'publicado')}
                            disabled={agindo.has(chave)}
                            className="rounded-full border px-2 py-0.5 text-xs hover:bg-white disabled:opacity-40 flex items-center gap-1"
                            title="Publicar esta cor de volta"
                          >
                            {agindo.has(chave)
                              ? <Loader2 className="w-3 h-3 animate-spin" />
                              : <Eye className="w-3 h-3" />}
                            publicar
                          </button>
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Kpi({ rotulo, valor, tom }: { rotulo: string; valor: number; tom?: 'alerta' }) {
  return (
    <div className={`rounded-lg border p-3 bg-white ${tom === 'alerta' && valor > 0 ? 'border-amber-300' : ''}`}>
      <div className="text-2xl font-bold">{valor}</div>
      <div className="text-xs text-slate-500">{rotulo}</div>
    </div>
  );
}
