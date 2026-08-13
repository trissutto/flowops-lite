'use client';

/**
 * /retaguarda/looks — peças que se vendem juntas.
 *
 * Dono, 13/08/2026: a Regata Alcinha (403048) e a Calça Aladdin (406027) saem
 * na MESMA foto e têm que se puxar no site. O look é curadoria HUMANA: quem
 * decide o que combina é gente, aqui — a vitrine só obedece. A PDP de cada
 * peça do look mostra as irmãs no bloco "Complete o look".
 *
 * Fase 2 (combinada): quando houver mais fotos de conjunto, o look ganha
 * botão "Comprar o look" e card próprio na vitrine — a estrutura já é esta.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Layers, Loader2, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { api } from '@/lib/api';

type PecaDoLook = {
  ref: string;
  /** null = fora da vitrine agora (sem foto/despublicada). */
  cartao: { ref: string; slug: string; nome: string; preco: number; imagem: string | null } | null;
};

type Look = {
  id: string;
  nome: string;
  criadoPor?: string | null;
  criadoEm: string;
  pecas: PecaDoLook[];
};

export default function LooksPage() {
  const [looks, setLooks] = useState<Look[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);

  // formulário de criação
  const [nome, setNome] = useState('');
  const [refs, setRefs] = useState('');

  // adicionar peça a um look existente (id do look → ref digitada)
  const [novaPeca, setNovaPeca] = useState<Record<string, string>>({});

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');
    try {
      setLooks(await api<Look[]>('/loja-catalog/looks'));
    } catch (e: any) {
      setErro(e?.message || 'Não consegui carregar');
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => { carregar(); }, [carregar]);

  const criar = async () => {
    const lista = refs.split(/[\s,;]+/).map((r) => r.trim()).filter(Boolean);
    if (!nome.trim() || lista.length < 2) {
      setErro('Dê um nome e pelo menos 2 REFs (separadas por espaço ou vírgula).');
      return;
    }
    setSalvando(true);
    setErro('');
    try {
      await api('/loja-catalog/looks', { method: 'POST', body: JSON.stringify({ nome, refs: lista }) });
      setNome('');
      setRefs('');
      await carregar();
    } catch (e: any) {
      setErro(e?.message || 'Não consegui criar o look');
    } finally {
      setSalvando(false);
    }
  };

  const adicionarPeca = async (lookId: string) => {
    const ref = (novaPeca[lookId] || '').trim();
    if (!ref) return;
    try {
      await api(`/loja-catalog/looks/${lookId}/pecas`, { method: 'POST', body: JSON.stringify({ ref }) });
      setNovaPeca((m) => ({ ...m, [lookId]: '' }));
      await carregar();
    } catch (e: any) {
      setErro(e?.message || 'Não consegui adicionar a peça');
    }
  };

  const removerPeca = async (lookId: string, ref: string) => {
    try {
      await api(`/loja-catalog/looks/${lookId}/pecas/${encodeURIComponent(ref)}`, { method: 'DELETE' });
      await carregar();
    } catch (e: any) {
      setErro(e?.message || 'Não consegui remover a peça');
    }
  };

  const excluirLook = async (lookId: string, nomeDoLook: string) => {
    // Confirmação nativa basta: excluir look não apaga produto nenhum.
    if (!window.confirm(`Excluir o look "${nomeDoLook}"? As peças continuam no site, só deixam de se puxar.`)) return;
    try {
      await api(`/loja-catalog/looks/${lookId}`, { method: 'DELETE' });
      await carregar();
    } catch (e: any) {
      setErro(e?.message || 'Não consegui excluir o look');
    }
  };

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-5">
      <div className="flex items-center gap-3">
        <Link href="/retaguarda" className="text-slate-500 hover:text-slate-800">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div className="flex-1">
          <h1 className="text-xl font-bold text-slate-800 flex items-center gap-2">
            <Layers className="w-5 h-5 text-[#B8912B]" /> Looks
          </h1>
          <p className="text-sm text-slate-500">
            Peças que saem na mesma foto se vendem juntas — cada uma puxa as irmãs na página do produto.
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

      {/* criar look */}
      <div className="bg-white border border-[#E7E2D8] rounded-xl p-4 space-y-2">
        <div className="text-sm font-semibold text-slate-600">Novo look</div>
        <div className="flex flex-wrap gap-2">
          <input
            value={nome}
            onChange={(e) => setNome(e.target.value)}
            placeholder="Nome (ex.: Cetim Verde)"
            className="border border-[#E7E2D8] rounded-lg px-3 py-2 text-sm flex-1 min-w-[180px]"
          />
          <input
            value={refs}
            onChange={(e) => setRefs(e.target.value)}
            placeholder="REFs separadas por espaço (ex.: 403048 406027)"
            className="border border-[#E7E2D8] rounded-lg px-3 py-2 text-sm flex-[2] min-w-[240px]"
          />
          <button
            onClick={criar}
            disabled={salvando}
            className="px-4 py-2 rounded-lg bg-[#B8912B] text-white text-sm font-semibold hover:bg-[#8C7325] disabled:opacity-50 flex items-center gap-1.5"
          >
            {salvando ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            Criar
          </button>
        </div>
      </div>

      {erro && (
        <p role="alert" className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          {erro}
        </p>
      )}

      {carregando && !looks.length ? (
        <div className="flex items-center gap-2 text-slate-500 text-sm p-6">
          <Loader2 className="w-4 h-4 animate-spin" /> Carregando…
        </div>
      ) : !looks.length ? (
        <p className="text-sm text-slate-500 p-6 text-center">
          Nenhum look ainda — crie o primeiro acima.
        </p>
      ) : (
        <div className="space-y-4">
          {looks.map((l) => (
            <div key={l.id} className="bg-white border border-[#E7E2D8] rounded-xl p-4">
              <div className="flex items-center gap-2 mb-3">
                <span className="font-semibold text-slate-800">{l.nome}</span>
                <span className="text-xs text-slate-400">
                  {new Date(l.criadoEm).toLocaleDateString('pt-BR')}
                </span>
                <div className="flex-1" />
                <button
                  onClick={() => excluirLook(l.id, l.nome)}
                  className="text-slate-400 hover:text-red-600"
                  title="Excluir look"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>

              <div className="flex flex-wrap gap-3">
                {l.pecas.map((p) => (
                  <div
                    key={p.ref}
                    className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 ${
                      p.cartao ? 'border-[#E7E2D8] bg-[#FAFAF7]' : 'border-amber-300 bg-amber-50'
                    }`}
                  >
                    {p.cartao?.imagem && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={p.cartao.imagem}
                        alt={p.cartao.nome}
                        className="w-9 h-12 object-cover rounded"
                      />
                    )}
                    <div className="text-xs leading-tight">
                      <div className="font-semibold text-slate-700">{p.ref}</div>
                      {p.cartao ? (
                        <>
                          <div className="text-slate-500 max-w-[160px] truncate">{p.cartao.nome}</div>
                          <div className="text-slate-500">R$ {Number(p.cartao.preco).toFixed(2)}</div>
                        </>
                      ) : (
                        <div className="text-amber-700">fora da vitrine agora</div>
                      )}
                    </div>
                    <button
                      onClick={() => removerPeca(l.id, p.ref)}
                      className="text-slate-400 hover:text-red-600"
                      title="Tirar do look"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}

                <div className="flex items-center gap-1.5">
                  <input
                    value={novaPeca[l.id] || ''}
                    onChange={(e) => setNovaPeca((m) => ({ ...m, [l.id]: e.target.value }))}
                    onKeyDown={(e) => { if (e.key === 'Enter') adicionarPeca(l.id); }}
                    placeholder="+ REF"
                    className="border border-[#E7E2D8] rounded-lg px-2 py-1.5 text-xs w-24"
                  />
                  <button
                    onClick={() => adicionarPeca(l.id)}
                    className="px-2 py-1.5 rounded-lg border border-[#E7E2D8] hover:bg-[#FBF6E6] text-slate-600"
                    title="Adicionar peça"
                  >
                    <Plus className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
