'use client';

/**
 * CATEGORIAS DA VITRINE — a cara de cada /categoria/<slug> do site.
 *
 * CRIA E VESTE. Até 18/08 esta tela só vestia (foto, nome, texto, ordem) e
 * criar categoria só existia escondido na tela de classificação em lote —
 * atrás de "marque uma peça primeiro". O dono mandou trazer pra cá, que é
 * onde ele já vem mexer em nome, ordem e foto.
 *
 * O medo de 07/08 ("categoria à mão vira vitrine vazia, igual ao Fitness que
 * ficava no menu com zero peça") não some — mas quem protege disso NÃO é
 * esconder o botão: é o `doCatalogo`, que só deixa entrar no menu do site
 * categoria COM peça publicada. Categoria nova nasce vazia, aparece aqui com
 * o aviso "sem peça — não aparece no site", e some do site sozinha se
 * esvaziar de novo.
 *
 * Sem foto cadastrada, o site usa a foto da PEÇA MAIS NOVA da categoria. Ou
 * seja: subir foto aqui é opcional, serve pra fixar uma arte quando a
 * automática não representar bem a categoria.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { Image as ImageIcon, Loader2, Plus, Save, Trash2, Star } from 'lucide-react';

type Categoria = {
  id: string | null;
  slug: string;
  /** Preenchido = é SUBcategoria e mora embaixo deste pai. */
  paiSlug: string | null;
  nome: string | null;
  nomeExibido: string;
  titulo: string | null;
  intro: string | null;
  imagemUrl: string | null;
  alt: string | null;
  /** Recorte lido por IA — centro (fração 0..1) + zoom. Null = sem leitura. */
  focoX: number | null;
  focoY: number | null;
  focoZoom: number | null;
  /** true = foto veio sozinha (peça mais nova); false = escolhida à mão. */
  fotoAutomatica: boolean;
  ordem: number;
  ativo: boolean;
  destaque: boolean;
  qtdPecas: number;
  configurada: boolean;
};

export default function CategoriasPage() {
  const [lista, setLista] = useState<Categoria[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    setCarregando(true);
    try {
      setLista(await api<Categoria[]>('/site-categorias'));
      setErro(null);
    } catch (e: any) {
      setErro(e?.message?.replace(/^\d+:\s*/, '') || 'Não consegui carregar');
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => { void carregar(); }, [carregar]);

  /**
   * A LISTA VINHA ACHATADA — "Manga curta" aparecia ao lado de "Blusas" como
   * se fossem o mesmo nível. Aqui cada categoria leva as subs dela embaixo,
   * que é o desenho real da árvore do site (e o único jeito de "criar
   * subcategoria" ter onde morar).
   *
   * `orfas` existe porque sub cujo pai sumiu não pode evaporar da tela: ela
   * continua no banco, ainda filtra peça, e alguém precisa poder consertar.
   */
  const { topo, subsPorPai, orfas } = useMemo(() => {
    const topo = lista.filter((c) => !c.paiSlug);
    const doTopo = new Set(topo.map((c) => c.slug));
    const subsPorPai = new Map<string, Categoria[]>();
    const orfas: Categoria[] = [];
    for (const c of lista) {
      if (!c.paiSlug) continue;
      if (!doTopo.has(c.paiSlug)) { orfas.push(c); continue; }
      if (!subsPorPai.has(c.paiSlug)) subsPorPai.set(c.paiSlug, []);
      subsPorPai.get(c.paiSlug)!.push(c);
    }
    return { topo, subsPorPai, orfas };
  }, [lista]);

  return (
    <div className="max-w-[1100px] mx-auto p-4 space-y-4">
      <div>
        <h1 className="text-xl font-black text-slate-800">Categorias da vitrine</h1>
        <p className="text-xs text-slate-500 mt-1">
          Crie categorias e subcategorias, e ajuste como elas aparecem no site. Categoria nova
          <b> nasce vazia</b> e só entra no menu depois que tiver peça dentro — quem põe peça é o
          <b> Produto Master</b> (uma peça) ou <b>Classificar Produtos</b> (em lote). Sem foto
          escolhida, o site usa a <b>foto da peça mais nova</b> da categoria.
        </p>
      </div>

      <NovaCategoria onCriou={carregar} />

      {erro && (
        <div className="bg-rose-50 border border-rose-300 text-rose-800 rounded-lg p-3 text-sm font-bold">
          {erro}
        </div>
      )}

      {carregando ? (
        <div className="text-center py-12 text-slate-400 text-sm">Carregando…</div>
      ) : lista.length === 0 ? (
        <div className="text-center py-12 text-slate-400 text-sm">
          Nenhuma categoria com peça publicada ainda.
        </div>
      ) : (
        <div className="space-y-3">
          {topo.map((c) => (
            <div key={c.slug} className="space-y-2">
              <CardCategoria categoria={c} onMudou={carregar} />
              <div className="ml-5 pl-3 border-l-2 border-slate-200 space-y-2">
                {(subsPorPai.get(c.slug) ?? []).map((s) => (
                  <CardCategoria
                    key={s.slug}
                    categoria={s}
                    onMudou={carregar}
                    paiNome={c.nomeExibido}
                  />
                ))}
                <NovaSubcategoria pai={c.slug} paiNome={c.nomeExibido} onCriou={carregar} />
              </div>
            </div>
          ))}

          {orfas.length > 0 && (
            <div className="space-y-2 pt-2">
              <p className="text-[11px] font-bold text-amber-700">
                Subcategorias sem categoria pai — o pai foi removido ou renomeado
              </p>
              {orfas.map((s) => (
                <CardCategoria key={s.slug} categoria={s} onMudou={carregar} paiNome={s.paiSlug ?? '?'} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * CRIAR CATEGORIA DE NÍVEL DE CIMA — "Linha Praia" pra uma campanha.
 *
 * Nasce ativa, vazia e no fim da ordem. Vazia ela NÃO aparece no site (o
 * menu só lista categoria com peça publicada), então criar aqui não repete o
 * caso "Fitness" — ver o cabeçalho do arquivo.
 */
function NovaCategoria({ onCriou }: { onCriou: () => void }) {
  const [nome, setNome] = useState('');
  const [criando, setCriando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  async function criar() {
    const limpo = nome.trim();
    if (!limpo) return;
    setCriando(true);
    setErro(null);
    try {
      const r = await api<{ ok?: boolean; erro?: string }>('/loja-catalog/classificacao/categoria', {
        method: 'POST',
        body: JSON.stringify({ nome: limpo }),
      });
      if (r?.ok === false) throw new Error(r?.erro || 'Não consegui criar');
      setNome('');
      onCriou();
    } catch (e: unknown) {
      setErro((e as Error)?.message?.replace(/^\d+:\s*/, '') || 'Não consegui criar');
    } finally {
      setCriando(false);
    }
  }

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex-1 min-w-[220px]">
          <label className="text-[10px] font-bold text-slate-600 uppercase">Nova categoria</label>
          <input
            value={nome}
            onChange={(e) => setNome(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void criar(); }}
            placeholder="Linha Conforto"
            className="w-full px-2 py-2 border border-slate-300 rounded text-sm"
          />
        </div>
        <button
          type="button"
          onClick={() => void criar()}
          disabled={criando || !nome.trim()}
          className="inline-flex items-center gap-1.5 text-xs font-bold px-4 py-2 rounded-lg bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-40"
        >
          {criando ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
          Criar categoria
        </button>
        <p className="text-[11px] text-slate-400 basis-full">
          Nasce vazia — só entra no menu do site depois que tiver peça dentro.
        </p>
      </div>
      {erro && <p className="text-[11px] text-rose-700 font-semibold mt-1">{erro}</p>}
    </div>
  );
}

/** Cria uma subcategoria DENTRO de uma categoria — "Manga curta" em "Blusas". */
function NovaSubcategoria({
  pai, paiNome, onCriou,
}: { pai: string; paiNome: string; onCriou: () => void }) {
  const [nome, setNome] = useState('');
  const [criando, setCriando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  async function criar() {
    const limpo = nome.trim();
    if (!limpo) return;
    setCriando(true);
    setErro(null);
    try {
      const r = await api<{ ok?: boolean; erro?: string }>('/loja-catalog/classificacao/subcategoria', {
        method: 'POST',
        body: JSON.stringify({ pai, nome: limpo }),
      });
      /**
       * O backend RECUSA sub que reaproveite slug de categoria de cima — em
       * 13/08 criar a sub "Blusas" dentro de Linha Conforto capturou a
       * categoria Blusas inteira (248 peças) e ela sumiu do site na hora.
       * A mensagem dele já sugere um nome livre; mostrar é o que evita a
       * pessoa achar que o botão não funcionou.
       */
      if (r?.ok === false) throw new Error(r?.erro || 'Não consegui criar');
      setNome('');
      onCriou();
    } catch (e: unknown) {
      setErro((e as Error)?.message?.replace(/^\d+:\s*/, '') || 'Não consegui criar');
    } finally {
      setCriando(false);
    }
  }

  return (
    <div>
      <div className="flex items-center gap-2">
        <input
          value={nome}
          onChange={(e) => setNome(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void criar(); }}
          placeholder={`nova subcategoria em ${paiNome}`}
          className="flex-1 min-w-0 px-2 py-1.5 border border-dashed border-slate-300 rounded text-xs bg-white"
        />
        <button
          type="button"
          onClick={() => void criar()}
          disabled={criando || !nome.trim()}
          className="inline-flex items-center gap-1 text-[11px] font-bold px-2.5 py-1.5 rounded border border-violet-300 text-violet-700 hover:bg-violet-50 disabled:opacity-40"
        >
          {criando ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
          Criar
        </button>
      </div>
      {erro && <p className="text-[11px] text-rose-700 font-semibold mt-1">{erro}</p>}
    </div>
  );
}

function CardCategoria({
  categoria, onMudou, paiNome,
}: { categoria: Categoria; onMudou: () => void; paiNome?: string }) {
  const [form, setForm] = useState<Categoria>(categoria);
  const [salvando, setSalvando] = useState(false);
  const [subindo, setSubindo] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Só reinicia o formulário ao trocar de categoria — atualização da mesma
  // não pode jogar o retorno do servidor por cima do que está sendo digitado
  // (foi o bug dos banners, 07/08).
  useEffect(() => {
    setForm((f) =>
      f.slug !== categoria.slug
        ? categoria
        : {
            ...f,
            imagemUrl: categoria.imagemUrl,
            focoX: categoria.focoX,
            focoY: categoria.focoY,
            focoZoom: categoria.focoZoom,
            fotoAutomatica: categoria.fotoAutomatica,
          },
    );
  }, [categoria]);

  const campo = <K extends keyof Categoria>(k: K, v: Categoria[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const temMudanca =
    (form.nome ?? '') !== (categoria.nome ?? '') ||
    (form.titulo ?? '') !== (categoria.titulo ?? '') ||
    (form.intro ?? '') !== (categoria.intro ?? '') ||
    form.ordem !== categoria.ordem;

  async function salvar(patch?: Partial<Categoria>) {
    setSalvando(true);
    setErro(null);
    try {
      await api(`/site-categorias/${encodeURIComponent(form.slug)}`, {
        method: 'PATCH',
        body: JSON.stringify(
          patch ?? {
            nome: form.nome, titulo: form.titulo, intro: form.intro, ordem: form.ordem,
          },
        ),
      });
      onMudou();
    } catch (e: any) {
      setErro(e?.message?.replace(/^\d+:\s*/, '') || 'Não consegui salvar');
    } finally {
      setSalvando(false);
    }
  }

  async function subir(arquivo: File) {
    setSubindo(true);
    setErro(null);
    try {
      const fd = new FormData();
      fd.append('file', arquivo);
      await api(`/site-categorias/${encodeURIComponent(form.slug)}/imagem`, {
        method: 'POST',
        body: fd as any,
      });
      onMudou();
    } catch (e: any) {
      setErro(e?.message?.replace(/^\d+:\s*/, '') || 'Não consegui subir a foto');
    } finally {
      setSubindo(false);
    }
  }

  const input = 'w-full px-2 py-2 border border-slate-300 rounded text-sm';
  const rotulo = 'text-[10px] font-bold text-slate-600 uppercase';

  return (
    <div className="border border-slate-200 rounded-lg bg-white p-3">
      <div className="flex items-start gap-3">
        {/* Foto */}
        <div className="shrink-0">
          <div className="w-24 h-32 rounded-lg border border-slate-200 bg-slate-50 overflow-hidden flex items-center justify-center relative">
            {form.imagemUrl ? (
              // eslint-disable-next-line @next/next/no-img-element — recorte da
              // IA é o mesmo objectPosition/scale do card real (CategoriaCard),
              // pra retaguarda mostrar exatamente o que o site vai exibir.
              <img
                src={form.imagemUrl}
                alt={form.nomeExibido}
                className="w-full h-full object-cover"
                style={
                  form.focoX != null && form.focoY != null
                    ? {
                        objectPosition: `${form.focoX * 100}% ${form.focoY * 100}%`,
                        transform: `scale(${form.focoZoom ?? 1.4})`,
                        transformOrigin: `${form.focoX * 100}% ${form.focoY * 100}%`,
                      }
                    : { objectPosition: 'center top' }
                }
              />
            ) : (
              <span className="text-[9px] text-slate-400 text-center px-1 leading-tight">
                usa a peça mais nova
              </span>
            )}
            {form.imagemUrl && (
              <span
                className="absolute top-1 left-1 text-[8px] font-bold uppercase px-1 py-0.5 rounded bg-white/90 text-slate-600"
                title={
                  form.fotoAutomatica
                    ? 'Foto automática (peça mais nova) — recorte lido por IA'
                    : 'Foto escolhida à mão — recorte lido por IA'
                }
              >
                {form.fotoAutomatica ? '🤖 auto' : '✓ sua foto'}
              </span>
            )}
          </div>
          <div className="flex gap-1 mt-1">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={subindo}
              className="flex-1 text-[10px] font-bold text-violet-700 border border-violet-300 rounded px-1.5 py-1 hover:bg-violet-50 disabled:opacity-50"
            >
              {subindo ? '...' : form.imagemUrl ? 'Trocar' : 'Subir foto'}
            </button>
            {form.imagemUrl && (
              <button
                type="button"
                title="Voltar a usar a foto automática"
                onClick={async () => {
                  setSubindo(true);
                  try {
                    await api(`/site-categorias/${encodeURIComponent(form.slug)}/imagem/remover`, { method: 'POST' });
                    onMudou();
                  } catch (e: any) {
                    setErro(e?.message || 'Não consegui remover');
                  } finally {
                    setSubindo(false);
                  }
                }}
                className="text-[10px] text-rose-600 border border-rose-200 rounded px-1.5 py-1 hover:bg-rose-50"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            )}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void subir(f);
              e.target.value = '';
            }}
          />
        </div>

        {/* Campos */}
        <div className="flex-1 min-w-0 space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-xs font-bold text-violet-700">{form.slug}</span>
            {paiNome && (
              <span className="text-[10px] font-bold text-slate-500 bg-slate-100 border border-slate-200 px-1.5 py-0.5 rounded">
                ↳ subcategoria de {paiNome}
              </span>
            )}
            <span className="text-[11px] text-slate-500">{form.qtdPecas} peça(s) no site</span>
            {form.qtdPecas === 0 && (
              <span className="text-[10px] font-bold text-amber-700 bg-amber-50 border border-amber-300 px-1.5 py-0.5 rounded">
                sem peça — não aparece no site
              </span>
            )}
            <div className="ml-auto flex items-center gap-2">
              <label className="text-[11px] text-slate-500">
                ordem
                <input
                  type="number"
                  value={form.ordem}
                  onChange={(e) => campo('ordem', Number(e.target.value) || 0)}
                  className="ml-1 w-12 px-1 py-0.5 border border-slate-300 rounded text-xs"
                />
              </label>
              <button
                type="button"
                title={form.destaque ? 'Tirar o destaque' : 'Destacar no menu do site'}
                onClick={() => void salvar({ destaque: !form.destaque } as any)}
                className={`p-1.5 rounded border ${
                  form.destaque
                    ? 'bg-amber-100 border-amber-400 text-amber-700'
                    : 'bg-white border-slate-300 text-slate-400 hover:text-amber-600'
                }`}
              >
                <Star className="w-3.5 h-3.5" fill={form.destaque ? 'currentColor' : 'none'} />
              </button>
              <button
                type="button"
                onClick={() => void salvar({ ativo: !form.ativo } as any)}
                className={`text-[11px] font-bold px-2.5 py-1.5 rounded-lg ${
                  form.ativo
                    ? 'border border-slate-300 text-slate-700 bg-white hover:bg-slate-50'
                    : 'bg-emerald-600 text-white hover:bg-emerald-700'
                }`}
              >
                {form.ativo ? 'Esconder do site' : 'Mostrar no site'}
              </button>
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-3">
            <div>
              <label className={rotulo}>
                Nome no menu <span className="text-slate-400 normal-case">(vazio = {form.nomeExibido})</span>
              </label>
              <input
                value={form.nome ?? ''}
                onChange={(e) => campo('nome', e.target.value || null)}
                placeholder={form.nomeExibido}
                className={input}
              />
            </div>
            <div className="sm:col-span-2">
              <label className={rotulo}>Título da página (SEO)</label>
              <input
                value={form.titulo ?? ''}
                onChange={(e) => campo('titulo', e.target.value || null)}
                placeholder={`${form.nomeExibido} plus size`}
                className={input}
              />
            </div>
          </div>

          <div>
            <label className={rotulo}>Texto de abertura da página</label>
            <textarea
              value={form.intro ?? ''}
              onChange={(e) => campo('intro', e.target.value || null)}
              rows={2}
              placeholder="Uma frase que apresenta a categoria pra cliente."
              className={input}
            />
          </div>

          {erro && <p className="text-[11px] text-rose-700 font-semibold">{erro}</p>}

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void salvar()}
              disabled={salvando}
              className={`inline-flex items-center gap-1.5 text-xs font-bold px-4 py-2 rounded-lg text-white disabled:opacity-50 ${
                temMudanca ? 'bg-amber-600 hover:bg-amber-700' : 'bg-violet-600 hover:bg-violet-700'
              }`}
            >
              {salvando ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              {temMudanca ? 'Salvar textos' : 'Salvar'}
            </button>
            {temMudanca && (
              <span className="text-[11px] font-bold text-amber-700">
                Você mudou os textos e ainda não salvou
              </span>
            )}
            <a
              href={`https://lurds-ecommerce.vercel.app/categoria/${form.slug}`}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-auto text-[11px] text-slate-500 hover:text-violet-700 underline inline-flex items-center gap-1"
            >
              <ImageIcon className="w-3 h-3" /> ver no site
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
