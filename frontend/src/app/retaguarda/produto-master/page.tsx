'use client';

/**
 * TELA MASTER DE PRODUTOS — a ficha completa de uma peça, num lugar só.
 *
 * Cascata de três níveis (desenho do dono, 02/08):
 *   1. REF em destaque + nome curto        → seta pro lado abre o que é COMUM
 *   2. cores                               → seta pra baixo abre a cascata
 *   3. grade de estoque por loja           → ao clicar na cor
 *
 * O que é comum fica no nível 1 (tecido, modelagem, coleção, ocasião, medidas,
 * elasticidade, descrição); o que muda por cor fica no nível 2 (título, vídeo,
 * fotos, publicação). Sem essa divisão, tecido e modelagem teriam que ser
 * redigitados em cada cor da mesma peça.
 *
 * ESTA TELA NÃO CRIA PRODUTO. O produto nasce no pedido de compra; aqui ele é
 * ENRIQUECIDO com o que o site precisa e não existe no catálogo.
 *
 * Convive com as telas de massa (editor-produtos, classificação BÁSICO/MODA):
 * master é profundidade, um produto por vez. Ninguém edita 65 mil registros num
 * formulário de ficha.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import {
  ChevronDown, ChevronRight, Image as ImageIcon, Loader2, Package, Save, Search,
} from 'lucide-react';

/* ─────────────────────────────── Tipos ─────────────────────────────── */

type SkuRow = {
  codigo: string;
  ref: string;
  descricao: string;
  marca: string | null;
  cor: string;
  tamanho: string;
  preco: number | null;
  estoque: number | null;
  estoqueLojas?: Record<string, number>;
};

type AtributoRef = { id: string; nome: string };
type Atributo = { id: string; nome: string };
type AtributosPorTipo = Partial<Record<'ocasiao' | 'tecido' | 'modelagem' | 'colecao', Atributo[]>>;

type Grade = { id: string; nome: string; linhas: unknown[] };

type FichaCor = {
  cor: string;
  tituloComercial: string | null;
  youtubeUrl: string | null;
  statusPublicacao: string;
  fotos: { id: string; url: string; ordem: number }[];
};

type Ficha = {
  ref: string;
  marca: string;
  nomeCurto: string | null;
  descricao: string | null;
  tecidoId: string | null;
  colecaoId: string | null;
  ocasioes: AtributoRef[];
  modelagens: AtributoRef[];
  gradeMedidasId: string | null;
  elasticidade: string | null;
  cores: FichaCor[];
};

/** Uma peça da cascata: REF + MARCA + COR, com seus tamanhos. */
type Produto = {
  chave: string;
  ref: string;
  marca: string;
  cor: string;
  nomeCurto: string;
  precos: number[];
  skus: SkuRow[];
};

const STATUS_LABEL: Record<string, { texto: string; cor: string }> = {
  publicado: { texto: 'No ar', cor: 'bg-green-100 text-green-800' },
  pronto: { texto: 'Pronto pra publicar', cor: 'bg-sky-100 text-sky-800' },
  sem_fotos: { texto: 'Faltam fotos', cor: 'bg-amber-100 text-amber-800' },
  nao_publicar: { texto: 'Fora do site', cor: 'bg-slate-100 text-slate-600' },
};

const ELASTICIDADE_LABEL: [string, string][] = [
  ['', '— não informado —'],
  ['nao', 'Não estica'],
  ['pouco', 'Estica pouco'],
  ['muito', 'Estica muito'],
];

/**
 * Nome curto = descrição sem o que já tem coluna própria (cor, tamanho, ref e
 * marca). O sistema COMPÔS a descrição com esses pedaços no pedido de compra,
 * então tirar é seguro — e as descrições não são uniformes: uma já vem limpa,
 * outra carrega tudo embutido.
 */
function derivarNomeCurto(row: SkuRow): string {
  const partes = [row.cor, row.tamanho, row.ref, row.marca ?? ''].filter(Boolean);
  let texto = ` ${row.descricao} `.toUpperCase();
  for (const p of partes) {
    texto = texto.split(new RegExp(`\\b${p.toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g')).join(' ');
  }
  return texto.replace(/\s+/g, ' ').trim() || row.descricao;
}

export default function ProdutoMasterPage() {
  const [busca, setBusca] = useState('');
  const [linhas, setLinhas] = useState<SkuRow[]>([]);
  const [buscando, setBuscando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [atributos, setAtributos] = useState<AtributosPorTipo>({});
  const [grades, setGrades] = useState<Grade[]>([]);

  // Cascata: qual REF está com o painel comum aberto, quais cores expandidas
  const [refAberta, setRefAberta] = useState<string | null>(null);
  const [corAberta, setCorAberta] = useState<string | null>(null);

  const [fichas, setFichas] = useState<Record<string, Ficha | null>>({});

  useEffect(() => {
    api<AtributosPorTipo>('/atributos-peca').then(setAtributos).catch(() => {});
    api<Grade[]>('/produto-ficha/grades').then(setGrades).catch(() => {});
  }, []);

  const buscar = useCallback(async () => {
    const q = busca.trim();
    if (q.length < 2) { setErro('Digite ao menos 2 caracteres'); return; }
    setBuscando(true);
    setErro(null);
    try {
      // ⚠️ O endpoint devolve { rows, fonte, warnings } — NÃO o array puro.
      // Jogar a resposta inteira no estado fazia o `for...of` do useMemo
      // estourar ("a is not iterable") e derrubar a tela inteira no boundary
      // do Next, com "Application error" e nada mais.
      const resp = await api<{ rows?: SkuRow[] }>(`/products-editor/search?q=${encodeURIComponent(q)}`);
      const rows = resp?.rows ?? [];
      setLinhas(rows);
      if (rows.length === 0) setErro(`Nada encontrado pra "${q}"`);
    } catch (e: any) {
      setErro(e?.message || 'Busca falhou');
      setLinhas([]);
    } finally {
      setBuscando(false);
    }
  }, [busca]);

  /**
   * Agrupa os SKUs em REF+MARCA → COR. MARCA entra na chave porque REF numérica
   * é reciclada entre fornecedores: dois "222" de marcas diferentes são peças
   * diferentes e não podem cair na mesma ficha.
   */
  const porRef = useMemo(() => {
    const mapa = new Map<string, { ref: string; marca: string; nomeCurto: string; produtos: Produto[] }>();
    // Guarda de forma: se a API mudar de formato de novo, a tela fica vazia em
    // vez de morrer inteira. Um useMemo que estoura sobe pro error boundary e
    // apaga a página — inclusive a busca, que é o único jeito de sair do erro.
    if (!Array.isArray(linhas)) return [];
    for (const row of linhas) {
      const marca = (row.marca || 'SEM MARCA').toUpperCase();
      const chaveRef = `${row.ref}|${marca}`;
      if (!mapa.has(chaveRef)) {
        mapa.set(chaveRef, { ref: row.ref, marca, nomeCurto: derivarNomeCurto(row), produtos: [] });
      }
      const grupo = mapa.get(chaveRef)!;
      const cor = (row.cor || 'ÚNICA').toUpperCase();
      let prod = grupo.produtos.find((p) => p.cor === cor);
      if (!prod) {
        prod = { chave: `${chaveRef}|${cor}`, ref: row.ref, marca, cor, nomeCurto: grupo.nomeCurto, precos: [], skus: [] };
        grupo.produtos.push(prod);
      }
      prod.skus.push(row);
      if (row.preco != null) prod.precos.push(row.preco);
    }
    for (const g of mapa.values()) {
      g.produtos.sort((a, b) => a.cor.localeCompare(b.cor));
      for (const p of g.produtos) p.skus.sort((a, b) => a.tamanho.localeCompare(b.tamanho, 'pt-BR', { numeric: true }));
    }
    return [...mapa.entries()].map(([chave, v]) => ({ chave, ...v }));
  }, [linhas]);

  const carregarFicha = useCallback(async (ref: string, marca: string) => {
    const chave = `${ref}|${marca}`;
    if (fichas[chave] !== undefined) return;
    try {
      const f = await api<Ficha | null>(`/produto-ficha/${encodeURIComponent(ref)}?marca=${encodeURIComponent(marca)}`);
      setFichas((p) => ({ ...p, [chave]: f }));
    } catch {
      setFichas((p) => ({ ...p, [chave]: null }));
    }
  }, [fichas]);

  return (
    <div className="max-w-7xl mx-auto px-3 sm:px-6 py-4 sm:py-6">
      <header className="flex items-center gap-3 mb-4">
        <div className="w-10 h-10 rounded-xl bg-violet-100 text-violet-700 grid place-items-center shrink-0">
          <Package className="w-5 h-5" />
        </div>
        <div>
          <h1 className="text-lg sm:text-xl font-bold text-slate-900">Produto — ficha completa</h1>
          <p className="text-xs text-slate-500">
            Busque a REF · abra a cor · o que é comum à peça fica no primeiro nível
          </p>
        </div>
      </header>

      <div className="flex gap-2 mb-4">
        <div className="relative flex-1">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void buscar(); }}
            placeholder="REF, descrição ou código"
            className="w-full pl-9 pr-3 py-2.5 border rounded-lg text-sm"
          />
        </div>
        <button
          type="button"
          onClick={() => void buscar()}
          disabled={buscando}
          className="px-5 py-2.5 rounded-lg bg-violet-600 text-white text-sm font-bold hover:bg-violet-700 disabled:opacity-50"
        >
          {buscando ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Buscar'}
        </button>
      </div>

      {erro && (
        <div className="mb-3 text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">{erro}</div>
      )}

      {porRef.length === 0 && !buscando && (
        <p className="text-center text-sm text-slate-400 py-12">
          Busque uma REF para abrir a ficha.
        </p>
      )}

      <div className="space-y-2">
        {porRef.map((grupo) => {
          const abertaComum = refAberta === grupo.chave;
          const ficha = fichas[grupo.chave];
          return (
            <div key={grupo.chave} className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              {/* NÍVEL 1 — REF */}
              <div className="flex items-center gap-2 px-3 py-3">
                <button
                  type="button"
                  title="Informações comuns a todas as cores"
                  onClick={() => {
                    const nova = abertaComum ? null : grupo.chave;
                    setRefAberta(nova);
                    if (nova) void carregarFicha(grupo.ref, grupo.marca);
                  }}
                  className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500"
                >
                  {abertaComum ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                </button>
                <div className="min-w-0 flex-1">
                  <p className="text-sm">
                    <span className="font-mono font-bold text-violet-700">{grupo.ref}</span>
                    <span className="text-slate-900"> {grupo.nomeCurto}</span>
                  </p>
                  <p className="text-[11px] text-slate-400">
                    {grupo.marca} · {grupo.produtos.length} cor(es)
                  </p>
                </div>
              </div>

              {/* NÍVEL 1 aberto — o que é COMUM */}
              {abertaComum && (
                <FichaComum
                  ref_={grupo.ref}
                  marca={grupo.marca}
                  ficha={ficha}
                  atributos={atributos}
                  grades={grades}
                  onSalvo={(f) => setFichas((p) => ({ ...p, [grupo.chave]: f }))}
                />
              )}

              {/* NÍVEL 2 — cores */}
              <div className="border-t border-slate-100">
                {grupo.produtos.map((prod) => {
                  const aberta = corAberta === prod.chave;
                  const fichaCor = ficha?.cores?.find((c) => c.cor.toUpperCase() === prod.cor);
                  // Status desconhecido não pode derrubar a tela — mesma lição
                  // do useMemo acima.
                  const status = STATUS_LABEL[fichaCor?.statusPublicacao ?? 'sem_fotos']
                    ?? STATUS_LABEL.sem_fotos;
                  const total = prod.skus.reduce((s, r) => s + (r.estoque || 0), 0);
                  return (
                    <div key={prod.chave} className="border-b border-slate-100 last:border-0">
                      <button
                        type="button"
                        onClick={() => {
                          setCorAberta(aberta ? null : prod.chave);
                          if (!aberta) void carregarFicha(prod.ref, prod.marca);
                        }}
                        className="w-full flex items-center gap-2 px-3 py-2.5 pl-10 hover:bg-slate-50 text-left"
                      >
                        {aberta ? <ChevronDown className="w-3.5 h-3.5 text-slate-400" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-400" />}
                        <span className="text-sm font-medium text-slate-800 flex-1">{prod.cor}</span>
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${status.cor}`}>{status.texto}</span>
                        <span className="text-[11px] text-slate-400 tabular-nums w-20 text-right">{total} un</span>
                      </button>

                      {/* NÍVEL 3 — grade + campos da cor */}
                      {aberta && (
                        <div className="pl-10 pr-3 pb-4 space-y-3">
                          <GradeEstoque skus={prod.skus} />
                          <FichaDaCor
                            ref_={prod.ref}
                            marca={prod.marca}
                            cor={prod.cor}
                            fichaCor={fichaCor}
                            onSalvo={(f) => setFichas((p) => ({ ...p, [`${prod.ref}|${prod.marca}`]: f }))}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ─────────────── Nível 1: o que vale pra todas as cores ─────────────── */

function FichaComum({
  ref_, marca, ficha, atributos, grades, onSalvo,
}: {
  ref_: string;
  marca: string;
  ficha: Ficha | null | undefined;
  atributos: AtributosPorTipo;
  grades: Grade[];
  onSalvo: (f: Ficha) => void;
}) {
  const [form, setForm] = useState({
    descricao: '', tecidoId: '', colecaoId: '', gradeMedidasId: '', elasticidade: '',
    ocasiaoIds: [] as string[], modelagemIds: [] as string[],
  });
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  // Só hidrata quando a ficha chega — sem isto o form limparia o que o usuário
  // digitou a cada re-render do pai.
  const hidratado = useRef(false);

  useEffect(() => {
    if (ficha === undefined || hidratado.current) return;
    hidratado.current = true;
    setForm({
      descricao: ficha?.descricao ?? '',
      tecidoId: ficha?.tecidoId ?? '',
      colecaoId: ficha?.colecaoId ?? '',
      gradeMedidasId: ficha?.gradeMedidasId ?? '',
      elasticidade: ficha?.elasticidade ?? '',
      ocasiaoIds: ficha?.ocasioes?.map((o) => o.id) ?? [],
      modelagemIds: ficha?.modelagens?.map((m) => m.id) ?? [],
    });
  }, [ficha]);

  async function salvar() {
    setSalvando(true);
    setErro(null);
    try {
      const f = await api<Ficha>(
        `/produto-ficha/${encodeURIComponent(ref_)}?marca=${encodeURIComponent(marca)}`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            descricao: form.descricao || null,
            tecidoId: form.tecidoId || null,
            colecaoId: form.colecaoId || null,
            gradeMedidasId: form.gradeMedidasId || null,
            elasticidade: form.elasticidade || null,
            ocasiaoIds: form.ocasiaoIds,
            modelagemIds: form.modelagemIds,
          }),
        },
      );
      onSalvo(f);
    } catch (e: any) {
      setErro(e?.message || 'Não consegui salvar');
    } finally {
      setSalvando(false);
    }
  }

  if (ficha === undefined) {
    return (
      <div className="px-10 pb-4 flex items-center gap-2 text-xs text-slate-400">
        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Carregando ficha…
      </div>
    );
  }

  return (
    <div className="px-10 pb-4 bg-violet-50/40 pt-3 space-y-3">
      <p className="text-[10px] font-bold text-violet-700 uppercase">
        Comum a todas as cores desta REF
      </p>

      <div>
        <label className="text-[10px] font-bold text-slate-600 uppercase">
          Descrição de venda <span className="text-slate-400">(uma só, serve todas as cores)</span>
        </label>
        <textarea
          rows={3}
          value={form.descricao}
          onChange={(e) => setForm((f) => ({ ...f, descricao: e.target.value }))}
          className="w-full px-2 py-2 border rounded text-sm"
        />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <SelectAtributo label="Tecido" opcoes={atributos.tecido} value={form.tecidoId}
          onChange={(v) => setForm((f) => ({ ...f, tecidoId: v }))} />
        <SelectAtributo label="Coleção" opcoes={atributos.colecao} value={form.colecaoId}
          onChange={(v) => setForm((f) => ({ ...f, colecaoId: v }))} />
        <SelectAtributo label="Ocasião" multiplo opcoes={atributos.ocasiao} values={form.ocasiaoIds}
          onChangeMany={(v) => setForm((f) => ({ ...f, ocasiaoIds: v }))} />
        <SelectAtributo label="Modelagem" multiplo opcoes={atributos.modelagem} values={form.modelagemIds}
          onChangeMany={(v) => setForm((f) => ({ ...f, modelagemIds: v }))} />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[10px] font-bold text-slate-600 uppercase">Grade de medidas</label>
          <select
            value={form.gradeMedidasId}
            onChange={(e) => setForm((f) => ({ ...f, gradeMedidasId: e.target.value }))}
            disabled={grades.length === 0}
            title={grades.length === 0 ? 'Nenhuma grade cadastrada ainda' : undefined}
            className="w-full px-2 py-2 border rounded text-sm bg-white disabled:opacity-50"
          >
            <option value="">— nenhuma —</option>
            {grades.map((g) => <option key={g.id} value={g.id}>{g.nome}</option>)}
          </select>
        </div>
        <div>
          <label className="text-[10px] font-bold text-slate-600 uppercase">Elasticidade</label>
          <select
            value={form.elasticidade}
            onChange={(e) => setForm((f) => ({ ...f, elasticidade: e.target.value }))}
            className="w-full px-2 py-2 border rounded text-sm bg-white"
          >
            {ELASTICIDADE_LABEL.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
          </select>
        </div>
      </div>

      {erro && <p className="text-xs text-rose-700">{erro}</p>}

      <button
        type="button"
        onClick={() => void salvar()}
        disabled={salvando}
        className="inline-flex items-center gap-1.5 text-xs font-bold px-4 py-2 rounded-lg bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50"
      >
        {salvando ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
        Salvar dados da peça
      </button>
    </div>
  );
}

/* ─────────────── Nível 3: grade de estoque (leitura) ─────────────── */

function GradeEstoque({ skus }: { skus: SkuRow[] }) {
  const lojas = useMemo(() => {
    const s = new Set<string>();
    for (const r of skus) for (const l of Object.keys(r.estoqueLojas ?? {})) s.add(l);
    return [...s].sort();
  }, [skus]);

  return (
    <div className="overflow-x-auto border border-slate-200 rounded-lg bg-white">
      <table className="text-xs min-w-full">
        <thead className="bg-slate-50 text-slate-500">
          <tr>
            <th className="px-2 py-1.5 text-left font-bold">TAM</th>
            {lojas.map((l) => <th key={l} className="px-2 py-1.5 font-bold">{l}</th>)}
            <th className="px-2 py-1.5 font-bold">TOT</th>
          </tr>
        </thead>
        <tbody>
          {skus.map((r) => (
            <tr key={r.codigo} className="border-t border-slate-100">
              <td className="px-2 py-1.5 font-bold text-slate-700">{r.tamanho}</td>
              {lojas.map((l) => {
                const q = r.estoqueLojas?.[l] ?? 0;
                return (
                  <td key={l} className={`px-2 py-1.5 text-center tabular-nums ${q ? 'text-slate-800' : 'text-slate-300'}`}>
                    {q || '·'}
                  </td>
                );
              })}
              <td className="px-2 py-1.5 text-center font-bold tabular-nums">{r.estoque ?? 0}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[10px] text-slate-400 px-2 py-1.5 border-t border-slate-100">
        Somente leitura por enquanto — editar a grade, entrada/saída, etiquetas e o
        arrastar-pra-remessa entram num próximo passo.
      </p>
    </div>
  );
}

/* ─────────────── Nível 3: campos da COR ─────────────── */

function FichaDaCor({
  ref_, marca, cor, fichaCor, onSalvo,
}: {
  ref_: string;
  marca: string;
  cor: string;
  fichaCor: FichaCor | undefined;
  onSalvo: (f: Ficha) => void;
}) {
  const [titulo, setTitulo] = useState(fichaCor?.tituloComercial ?? '');
  const [youtube, setYoutube] = useState(fichaCor?.youtubeUrl ?? '');
  const [status, setStatus] = useState(
    fichaCor?.statusPublicacao === 'sem_fotos' ? 'nao_publicar' : (fichaCor?.statusPublicacao ?? 'nao_publicar'),
  );
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const semFotos = (fichaCor?.fotos?.length ?? 0) === 0;

  async function salvar() {
    setSalvando(true);
    setErro(null);
    try {
      const f = await api<Ficha>(
        `/produto-ficha/${encodeURIComponent(ref_)}/cor/${encodeURIComponent(cor)}?marca=${encodeURIComponent(marca)}`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            tituloComercial: titulo || null,
            youtubeUrl: youtube || null,
            statusPublicacao: status,
          }),
        },
      );
      onSalvo(f);
    } catch (e: any) {
      setErro(e?.message || 'Não consegui salvar');
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div className="border border-slate-200 rounded-lg bg-white p-3 space-y-3">
      <p className="text-[10px] font-bold text-slate-500 uppercase">Só desta cor</p>

      <div className="grid gap-2 sm:grid-cols-2">
        <div>
          <label className="text-[10px] font-bold text-slate-600 uppercase">
            Título no site <span className="text-slate-400">(vazio = nome curto + cor)</span>
          </label>
          <input value={titulo} onChange={(e) => setTitulo(e.target.value)}
            className="w-full px-2 py-2 border rounded text-sm" />
        </div>
        <div>
          <label className="text-[10px] font-bold text-slate-600 uppercase">Vídeo (YouTube)</label>
          <input value={youtube} onChange={(e) => setYoutube(e.target.value)} placeholder="https://youtu.be/..."
            className="w-full px-2 py-2 border rounded text-sm font-mono" />
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="text-[10px] font-bold text-slate-600 uppercase">Publicação</label>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            disabled={semFotos}
            title={semFotos ? 'Sem foto o site não tem o que mostrar' : undefined}
            className="px-2 py-2 border rounded text-sm bg-white disabled:opacity-50"
          >
            <option value="nao_publicar">Fora do site</option>
            <option value="pronto">Pronto pra publicar</option>
            <option value="publicado">No ar</option>
          </select>
        </div>

        <div className="flex items-center gap-1.5">
          <ImageIcon className="w-3.5 h-3.5 text-slate-400" />
          <span className="text-xs text-slate-500">
            {semFotos
              ? 'Nenhuma foto — o status fica em "faltam fotos"'
              : `${fichaCor!.fotos.length} foto(s)`}
          </span>
        </div>
      </div>

      {erro && <p className="text-xs text-rose-700">{erro}</p>}

      <button
        type="button"
        onClick={() => void salvar()}
        disabled={salvando}
        className="inline-flex items-center gap-1.5 text-xs font-bold px-4 py-2 rounded-lg bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50"
      >
        {salvando ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
        Salvar cor
      </button>
    </div>
  );
}

/* ─────────────── Select de atributo (igual ao do pedido) ─────────────── */

function SelectAtributo({
  label, opcoes, value, values, onChange, onChangeMany, multiplo,
}: {
  label: string;
  opcoes?: Atributo[];
  value?: string;
  values?: string[];
  onChange?: (v: string) => void;
  onChangeMany?: (v: string[]) => void;
  multiplo?: boolean;
}) {
  const lista = opcoes ?? [];
  const escolhidos = values ?? [];
  const disponiveis = multiplo ? lista.filter((o) => !escolhidos.includes(o.id)) : lista;
  const vazio = lista.length === 0;

  return (
    <div>
      <label className="text-[10px] font-bold text-slate-600 uppercase">{label}</label>
      <select
        value={multiplo ? '' : (value ?? '')}
        disabled={vazio || (multiplo && disponiveis.length === 0)}
        title={vazio ? 'Cadastre em Cadastros → Classificação da Peça' : undefined}
        onChange={(e) => {
          if (!multiplo) { onChange?.(e.target.value); return; }
          if (e.target.value) onChangeMany?.([...escolhidos, e.target.value]);
        }}
        className="w-full px-2 py-2 border rounded text-sm bg-white disabled:opacity-50"
      >
        <option value="">{multiplo ? '+ adicionar' : '— nenhum —'}</option>
        {disponiveis.map((o) => <option key={o.id} value={o.id}>{o.nome}</option>)}
      </select>
      {multiplo && escolhidos.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1">
          {escolhidos.map((id) => (
            <span key={id} className="inline-flex items-center gap-1 text-[11px] bg-violet-50 text-violet-800 border border-violet-200 rounded px-1.5 py-0.5">
              {lista.find((o) => o.id === id)?.nome ?? id}
              <button type="button" aria-label="Remover"
                onClick={() => onChangeMany?.(escolhidos.filter((x) => x !== id))}
                className="text-violet-500 hover:text-violet-900 leading-none">×</button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
