'use client';

/**
 * Cadastros → Classificação da Peça (Ocasião · Tecido · Modelagem · Coleção).
 *
 * São os quatro eixos que o site usa pra montar vitrine além da categoria.
 * Cada aba é um cadastro com cara própria; o que compartilham é a tabela
 * (atributos_peca, separada por `tipo`) e este componente.
 *
 * UMA TELA COM ABAS, não quatro no menu: são listas curtas e o hub da Loja já
 * tem quase 20 atalhos.
 *
 * O `slug` é o endereço no site (/ocasioes/casamento). Nasce do nome mas NÃO
 * muda sozinho ao renomear — link publicado que quebra é link perdido. Pra
 * trocar, edita o campo na mão.
 *
 * Desativar não apaga: peça já classificada guarda o nome junto, e o histórico
 * do pedido de compra continua legível.
 */

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { overlayClose } from '@/lib/overlayClose';
import {
  Check, Layers, Loader2, Pencil, Plus, RotateCcw, Shirt, Sparkles, Trash2, X,
} from 'lucide-react';

type Tipo = 'ocasiao' | 'tecido' | 'modelagem' | 'colecao';

interface Atributo {
  id: string;
  tipo: Tipo;
  nome: string;
  slug: string;
  descricao: string | null;
  fotoUrl: string | null;
  ativo: boolean;
  ordem: number;
}

/**
 * `singular` é escrito à mão de propósito: tirar o "s" do plural não funciona
 * em português ("Ocasiões" viraria "ocasiõe").
 */
const ABAS: {
  tipo: Tipo; label: string; singular: string; artigo: 'a' | 'o';
  icon: typeof Shirt; ajuda: string; exemplo: string;
}[] = [
  {
    tipo: 'ocasiao', label: 'Ocasiões', singular: 'ocasião', artigo: 'a', icon: Sparkles,
    ajuda: 'Para onde a cliente vai. É como ela pensa: "casamento sábado", não "vestido 52".',
    exemplo: 'Casamento, Trabalho, Festa, Praia',
  },
  {
    tipo: 'tecido', label: 'Tecidos', singular: 'tecido', artigo: 'o', icon: Layers,
    ajuda: 'O material da peça. Cada um veste de um jeito — é atalho pro caimento certo.',
    exemplo: 'Viscolycra, Linho, Crepe, Jeans',
  },
  {
    tipo: 'modelagem', label: 'Modelagens', singular: 'modelagem', artigo: 'a', icon: Shirt,
    ajuda: 'O que a peça valoriza. Consultoria de estilo virada em filtro.',
    exemplo: 'Valoriza a cintura, Alonga a silhueta',
  },
  {
    tipo: 'colecao', label: 'Coleções', singular: 'coleção', artigo: 'a', icon: Sparkles,
    ajuda: 'O agrupamento comercial da temporada.',
    exemplo: 'Verão 26, Alfaiataria, Essenciais',
  },
];

const VAZIO = { nome: '', slug: '', descricao: '', fotoUrl: '', ordem: 0 };

export default function ClassificacaoPecaPage() {
  const [aba, setAba] = useState<Tipo>('ocasiao');
  const [linhas, setLinhas] = useState<Atributo[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  // null = formulário fechado; '' = criando; id = editando
  const [editandoId, setEditandoId] = useState<string | null>(null);
  const [form, setForm] = useState({ ...VAZIO });
  const [confirmarRemocao, setConfirmarRemocao] = useState<Atributo | null>(null);

  const abaAtual = ABAS.find((a) => a.tipo === aba)!;

  const carregar = useCallback(async (tipo: Tipo) => {
    setCarregando(true);
    setErro(null);
    try {
      // incluirInativos=1: quem administra precisa enxergar o que desativou.
      setLinhas(await api<Atributo[]>(`/atributos-peca/${tipo}?incluirInativos=1`));
    } catch (e: any) {
      setErro(e?.message || 'Não consegui carregar a lista');
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => { void carregar(aba); }, [aba, carregar]);

  function abrirNovo() {
    setForm({ ...VAZIO, ordem: linhas.length });
    setEditandoId('');
  }

  function abrirEdicao(linha: Atributo) {
    setForm({
      nome: linha.nome,
      slug: linha.slug,
      descricao: linha.descricao || '',
      fotoUrl: linha.fotoUrl || '',
      ordem: linha.ordem,
    });
    setEditandoId(linha.id);
  }

  async function salvar() {
    if (!form.nome.trim()) { setErro('O nome é obrigatório'); return; }
    setSalvando(true);
    setErro(null);
    try {
      const corpo = {
        nome: form.nome.trim(),
        descricao: form.descricao.trim() || null,
        fotoUrl: form.fotoUrl.trim() || null,
        ordem: Number(form.ordem) || 0,
        // No cadastro novo o slug sai do nome (manda vazio); na edição só vai
        // se o campo foi preenchido, pra não trocar URL publicada sem querer.
        ...(form.slug.trim() ? { slug: form.slug.trim() } : {}),
      };
      if (editandoId) {
        await api(`/atributos-peca/item/${editandoId}`, { method: 'PATCH', body: JSON.stringify(corpo) });
      } else {
        await api(`/atributos-peca/${aba}`, { method: 'POST', body: JSON.stringify(corpo) });
      }
      setEditandoId(null);
      await carregar(aba);
    } catch (e: any) {
      setErro(e?.message || 'Não consegui salvar');
    } finally {
      setSalvando(false);
    }
  }

  async function alternarAtivo(linha: Atributo) {
    setSalvando(true);
    try {
      await api(`/atributos-peca/item/${linha.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ ativo: !linha.ativo }),
      });
      await carregar(aba);
    } catch (e: any) {
      setErro(e?.message || 'Não consegui alterar');
    } finally {
      setSalvando(false);
      setConfirmarRemocao(null);
    }
  }

  return (
    <div className="max-w-5xl mx-auto px-3 sm:px-6 py-4 sm:py-6">
      <header className="flex items-center gap-3 mb-1">
        <div className="w-10 h-10 rounded-xl bg-violet-100 text-violet-700 grid place-items-center shrink-0">
          <Shirt className="w-5 h-5" />
        </div>
        <div>
          <h1 className="text-lg sm:text-xl font-bold text-slate-900">Classificação da Peça</h1>
          <p className="text-xs text-slate-500">
            Os eixos que o site usa pra montar vitrine — escolhidos já no pedido de compra
          </p>
        </div>
      </header>

      {/* Abas */}
      <div className="flex flex-wrap gap-1.5 mt-5 mb-4 border-b border-slate-200 pb-3">
        {ABAS.map((a) => {
          const Icone = a.icon;
          const ativa = a.tipo === aba;
          return (
            <button
              key={a.tipo}
              type="button"
              onClick={() => { setAba(a.tipo); setEditandoId(null); setErro(null); }}
              className={`inline-flex items-center gap-1.5 text-xs font-bold px-3 py-2 rounded-lg transition-colors ${
                ativa
                  ? 'bg-violet-600 text-white'
                  : 'bg-white text-slate-600 border border-slate-300 hover:bg-slate-50'
              }`}
            >
              <Icone className="w-3.5 h-3.5" />
              {a.label}
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <p className="text-xs text-slate-500 max-w-xl">
          {abaAtual.ajuda} <span className="text-slate-400">Ex.: {abaAtual.exemplo}</span>
        </p>
        <button
          type="button"
          onClick={abrirNovo}
          className="inline-flex items-center gap-1.5 text-xs font-bold px-3 py-2 rounded-lg bg-violet-600 text-white hover:bg-violet-700"
        >
          <Plus className="w-3.5 h-3.5" />
          {abaAtual.artigo === 'a' ? 'Nova' : 'Novo'} {abaAtual.singular}
        </button>
      </div>

      {erro && (
        <div className="mb-3 text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">
          {erro}
        </div>
      )}

      {/* Formulário */}
      {editandoId !== null && (
        <div className="mb-4 bg-white border border-violet-200 rounded-xl p-4 shadow-sm">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="text-[10px] font-bold text-slate-600 uppercase">Nome *</label>
              <input
                autoFocus
                value={form.nome}
                onChange={(e) => setForm((f) => ({ ...f, nome: e.target.value }))}
                placeholder={abaAtual.exemplo.split(',')[0].trim()}
                className="w-full px-2 py-2 border rounded text-sm"
              />
            </div>
            <div>
              <label className="text-[10px] font-bold text-slate-600 uppercase">
                Endereço no site {editandoId === '' && <span className="text-slate-400">(automático)</span>}
              </label>
              <input
                value={form.slug}
                onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value }))}
                placeholder={editandoId === '' ? 'gerado a partir do nome' : ''}
                className="w-full px-2 py-2 border rounded text-sm font-mono"
              />
              {editandoId !== '' && (
                <p className="text-[10px] text-amber-700 mt-1">
                  Mudar isto quebra o link já publicado.
                </p>
              )}
            </div>
            <div className="sm:col-span-2">
              <label className="text-[10px] font-bold text-slate-600 uppercase">
                Descrição <span className="text-slate-400">(texto da página no site)</span>
              </label>
              <textarea
                rows={2}
                value={form.descricao}
                onChange={(e) => setForm((f) => ({ ...f, descricao: e.target.value }))}
                className="w-full px-2 py-2 border rounded text-sm"
              />
            </div>
            <div>
              <label className="text-[10px] font-bold text-slate-600 uppercase">Foto de capa (URL)</label>
              <input
                value={form.fotoUrl}
                onChange={(e) => setForm((f) => ({ ...f, fotoUrl: e.target.value }))}
                placeholder="https://..."
                className="w-full px-2 py-2 border rounded text-sm font-mono"
              />
            </div>
            <div>
              <label className="text-[10px] font-bold text-slate-600 uppercase">
                Ordem <span className="text-slate-400">(menor aparece antes)</span>
              </label>
              <input
                type="number"
                value={form.ordem}
                onChange={(e) => setForm((f) => ({ ...f, ordem: Number(e.target.value) }))}
                className="w-full px-2 py-2 border rounded text-sm"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-3">
            <button
              type="button"
              onClick={() => { setEditandoId(null); setErro(null); }}
              className="text-xs font-bold px-3 py-2 rounded-lg border border-slate-300 hover:bg-slate-50"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={salvar}
              disabled={salvando}
              className="inline-flex items-center gap-1.5 text-xs font-bold px-4 py-2 rounded-lg bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50"
            >
              {salvando ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
              Salvar
            </button>
          </div>
        </div>
      )}

      {/* Lista */}
      {carregando ? (
        <div className="flex items-center gap-2 text-sm text-slate-500 py-10 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" /> Carregando…
        </div>
      ) : linhas.length === 0 ? (
        <div className="text-center py-12 text-sm text-slate-500 bg-white border border-dashed border-slate-300 rounded-xl">
          {abaAtual.artigo === 'a' ? 'Nenhuma' : 'Nenhum'} {abaAtual.singular}{' '}
          {abaAtual.artigo === 'a' ? 'cadastrada' : 'cadastrado'} ainda.
          <br />
          <span className="text-xs text-slate-400">
            Enquanto a lista estiver vazia, o campo aparece vazio no pedido de compra.
          </span>
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          {linhas.map((linha) => (
            <div
              key={linha.id}
              className={`flex items-center gap-3 px-3 py-2.5 border-b border-slate-100 last:border-0 ${
                linha.ativo ? '' : 'bg-slate-50 opacity-60'
              }`}
            >
              <span className="text-[10px] font-mono text-slate-400 w-6 text-right shrink-0">{linha.ordem}</span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-slate-900 truncate">
                  {linha.nome}
                  {!linha.ativo && (
                    <span className="ml-2 text-[10px] font-bold text-slate-500 uppercase">desativada</span>
                  )}
                </p>
                <p className="text-[11px] text-slate-400 font-mono truncate">/{linha.slug}</p>
              </div>
              <button
                type="button"
                onClick={() => abrirEdicao(linha)}
                title="Editar"
                className="p-2 rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-900"
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => (linha.ativo ? setConfirmarRemocao(linha) : void alternarAtivo(linha))}
                title={linha.ativo ? 'Desativar' : 'Reativar'}
                className="p-2 rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-900"
              >
                {linha.ativo ? <Trash2 className="w-3.5 h-3.5" /> : <RotateCcw className="w-3.5 h-3.5" />}
              </button>
            </div>
          ))}
        </div>
      )}

      {confirmarRemocao && (
        <div
          className="fixed inset-0 bg-black/40 grid place-items-center z-50 p-4"
          {...overlayClose(() => setConfirmarRemocao(null))}
        >
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-3">
              <h2 className="text-base font-bold text-slate-900">
                Desativar &ldquo;{confirmarRemocao.nome}&rdquo;?
              </h2>
              <button type="button" onClick={() => setConfirmarRemocao(null)} className="text-slate-400 hover:text-slate-700">
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-xs text-slate-600 mt-2">
              Some dos selects do pedido de compra e da vitrine do site. As peças que já foram
              classificadas com ela continuam intactas — nada é apagado, e dá pra reativar depois.
            </p>
            <div className="flex justify-end gap-2 mt-4">
              <button
                type="button"
                onClick={() => setConfirmarRemocao(null)}
                className="text-xs font-bold px-3 py-2 rounded-lg border border-slate-300 hover:bg-slate-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => void alternarAtivo(confirmarRemocao)}
                disabled={salvando}
                className="text-xs font-bold px-4 py-2 rounded-lg bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-50"
              >
                Desativar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
