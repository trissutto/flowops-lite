'use client';

/**
 * Componentes da ficha do produto — extraídos de `/retaguarda/produto-master`
 * em 21/08/2026 pra serem usados também pela tela nova `/retaguarda/produtos`.
 *
 * NADA MUDOU no comportamento: é o mesmo código, num arquivo onde as duas
 * telas conseguem importar. O desenho da cascata segue sendo o de 02/08 — o
 * que é COMUM à peça fica em `FichaComum` (tecido, modelagem, coleção,
 * ocasião, medidas, elasticidade, descrição) e o que muda POR COR fica em
 * `FichaDaCor` (título, vídeo, fotos, publicação). Sem essa divisão, tecido e
 * modelagem teriam que ser redigitados em cada cor da mesma peça.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Image as ImageIcon, Loader2, Package, Save, Search, Truck } from 'lucide-react';
import { api } from '@/lib/api';
import { SelectAtributoPeca, type Atributo, type AtributosPorTipo, type TipoAtributo } from '@/components/SelectAtributoPeca';
import FotosDaCor, { type FotoCor, type SwatchCor } from '@/components/FotosDaCor';
import {
  ELASTICIDADE_LABEL,
  type ArvoreSite,
  type Ficha,
  type FichaCor,
  type Grade,
  type Movimento,
  type Pendencia,
  type Produto,
  type SkuRow,
  type VitrinesPeca,
} from '../types';
import { lojasDaGrade } from '../lojas-grade';

/**
 * EM QUE VITRINES ESTA PEÇA APARECE — árvore de checkbox (dono, 18/08/2026).
 *
 * A categoria sempre foi UMA só, e o efeito colateral era silencioso: mandar
 * uma blusa pra "Linha Conforto" a TIRAVA de "Blusas" — a cliente que navega
 * por Blusas deixava de achar a peça no dia em que ela entrou na campanha.
 *
 * O primeiro desenho pedia "categoria principal" num select e as outras em
 * chips; o dono cortou na hora — "só marco o checkbox de todas as categorias e
 * subcategorias que eu quero". Então aqui NÃO se escolhe principal: marca-se
 * tudo, e o backend deriva qual manda na PDP (a que já era, se seguir marcada;
 * senão a primeira na ordem do menu).
 *
 * Duas regras que a tela aplica na hora, pra marcação impossível não existir:
 *   · marcar SUBcategoria marca o pai — sub é filtro DENTRO da página do pai;
 *   · desmarcar a categoria desmarca as subs dela.
 *
 * Vale pra FAMÍLIA inteira (todas as cores): o site mostra um card por peça,
 * montado a partir do cadastro de UMA das REFs irmãs, e gravar só na REF
 * aberta daria "marquei e não apareceu" toda vez que a dona do card fosse
 * outra.
 */
export function VitrinesDoSite({ ref_, arvore }: { ref_: string; arvore: ArvoreSite | null }) {
  const [dados, setDados] = useState<VitrinesPeca | null>(null);
  const [cats, setCats] = useState<string[]>([]);
  const [subs, setSubs] = useState<string[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [salvo, setSalvo] = useState(false);

  useEffect(() => {
    let vivo = true;
    setCarregando(true);
    setErro(null);
    setSalvo(false);
    api<VitrinesPeca>(`/loja-catalog/classificacao/peca/${encodeURIComponent(ref_)}`)
      .then((d) => {
        if (!vivo) return;
        setDados(d);
        setCats(d?.categorias ?? []);
        setSubs(d?.subcategorias ?? []);
      })
      .catch((e: unknown) => {
        if (vivo) setErro((e as Error)?.message || 'Não consegui ler as vitrines');
      })
      .finally(() => {
        if (vivo) setCarregando(false);
      });
    return () => {
      vivo = false;
    };
  }, [ref_]);

  // As subcategorias de cada categoria, na ordem do menu — o desenho da árvore.
  const subsPorPai = useMemo(() => {
    const m = new Map<string, Array<{ slug: string; nome: string }>>();
    for (const s of arvore?.subcategorias ?? []) {
      if (!m.has(s.pai)) m.set(s.pai, []);
      m.get(s.pai)!.push({ slug: s.slug, nome: s.nome });
    }
    return m;
  }, [arvore]);

  function alternarCategoria(slug: string) {
    setSalvo(false);
    const marcando = !cats.includes(slug);
    setCats((a) => (marcando ? [...a, slug] : a.filter((c) => c !== slug)));
    // Desmarcar a categoria leva as subs dela junto: sub órfã apareceria num
    // chip de um menu que não lista a peça.
    if (!marcando) {
      const filhas = new Set((subsPorPai.get(slug) ?? []).map((s) => s.slug));
      setSubs((a) => a.filter((s) => !filhas.has(s)));
    }
  }

  function alternarSub(slug: string, pai: string) {
    setSalvo(false);
    const marcando = !subs.includes(slug);
    setSubs((a) => (marcando ? [...a, slug] : a.filter((s) => s !== slug)));
    // Marcar a sub marca o pai — é dentro da página dele que o chip vive.
    if (marcando) setCats((a) => (a.includes(pai) ? a : [...a, pai]));
  }

  async function salvar() {
    setSalvando(true);
    setErro(null);
    try {
      const r = await api<VitrinesPeca>(
        `/loja-catalog/classificacao/peca/${encodeURIComponent(ref_)}`,
        { method: 'POST', body: JSON.stringify({ categorias: cats, subcategorias: subs }) },
      );
      if (r?.ok === false) throw new Error(r?.erro || 'Não consegui salvar');
      setDados(r);
      setCats(r?.categorias ?? []);
      setSubs(r?.subcategorias ?? []);
      setSalvo(true);
    } catch (e: unknown) {
      setErro((e as Error)?.message || 'Não consegui salvar');
    } finally {
      setSalvando(false);
    }
  }

  if (carregando) {
    return (
      <div className="px-10 py-3 flex items-center gap-2 text-xs text-slate-400 bg-sky-50/50">
        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Carregando vitrines…
      </div>
    );
  }

  if (dados?.ok === false) {
    return (
      <div className="px-10 py-3 bg-sky-50/50 text-xs text-slate-500">
        Esta peça ainda não tem cadastro no site — publique a REF antes de escolher as vitrines.
      </div>
    );
  }

  const marcadas = cats.length + subs.length;

  return (
    <div className="px-10 py-3 bg-sky-50/50 space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <p className="text-[10px] font-bold text-sky-700 uppercase">Vitrines do site</p>
        <p className="text-[10px] text-slate-400">
          marque TUDO onde esta peça deve aparecer · vale pras {dados?.refs?.length ?? 0} REF(s) da
          peça{dados?.publicado ? '' : ' · peça não publicada'}
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-2">
        {(arvore?.categorias ?? []).map((c) => {
          const marcada = cats.includes(c.slug);
          const filhas = subsPorPai.get(c.slug) ?? [];
          return (
            <div key={c.slug} className="min-w-0">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={marcada}
                  onChange={() => alternarCategoria(c.slug)}
                  className="w-4 h-4 accent-sky-600"
                />
                <span className={`text-sm truncate ${marcada ? 'font-bold text-sky-900' : 'text-slate-700'}`}>
                  {c.nome}
                </span>
                {dados?.principal === c.slug && (
                  <span
                    title="É a categoria que a página do produto mostra"
                    className="text-[9px] font-bold uppercase text-sky-600 bg-sky-100 rounded px-1 py-0.5 shrink-0"
                  >
                    principal
                  </span>
                )}
              </label>
              {filhas.length > 0 && (
                <div className="ml-6 mt-0.5 space-y-0.5">
                  {filhas.map((s) => (
                    <label key={s.slug} className="flex items-center gap-2 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={subs.includes(s.slug)}
                        onChange={() => alternarSub(s.slug, c.slug)}
                        className="w-3.5 h-3.5 accent-sky-600"
                      />
                      <span
                        className={`text-xs truncate ${
                          subs.includes(s.slug) ? 'text-sky-900 font-semibold' : 'text-slate-500'
                        }`}
                      >
                        {s.nome}
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {erro && <p className="text-xs text-rose-700">{erro}</p>}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void salvar()}
          disabled={salvando}
          className="inline-flex items-center gap-1.5 text-xs font-bold px-4 py-2 rounded-lg bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-50"
        >
          {salvando ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
          Salvar vitrines ({marcadas})
        </button>
        {salvo && <span className="text-xs text-emerald-700 font-semibold">Salvo — o site já mudou</span>}
      </div>
    </div>
  );
}

/* ─────────────── Nível 1: o que vale pra todas as cores ─────────────── */

export function FichaComum({
  ref_, marca, ficha, atributos, grades, onSalvo, onCriarAtributo,
}: {
  ref_: string;
  marca: string;
  ficha: Ficha | null | undefined;
  atributos: AtributosPorTipo;
  grades: Grade[];
  onSalvo: (f: Ficha) => void;
  onCriarAtributo: (tipo: TipoAtributo, novo: Atributo) => void;
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
          rows={15}
          value={form.descricao}
          onChange={(e) => setForm((f) => ({ ...f, descricao: e.target.value }))}
          className="w-full px-2 py-2 border rounded text-sm"
        />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <SelectAtributoPeca tipo="tecido" label="Tecido" opcoes={atributos.tecido}
          value={form.tecidoId} onCriado={onCriarAtributo}
          onChange={(v) => setForm((f) => ({ ...f, tecidoId: v }))} />
        <SelectAtributoPeca tipo="colecao" label="Coleção" opcoes={atributos.colecao}
          value={form.colecaoId} onCriado={onCriarAtributo}
          onChange={(v) => setForm((f) => ({ ...f, colecaoId: v }))} />
        <SelectAtributoPeca tipo="ocasiao" label="Ocasião" multiplo opcoes={atributos.ocasiao}
          values={form.ocasiaoIds} onCriado={onCriarAtributo}
          onChangeMany={(v) => setForm((f) => ({ ...f, ocasiaoIds: v }))} />
        <SelectAtributoPeca tipo="modelagem" label="Modelagem" multiplo opcoes={atributos.modelagem}
          values={form.modelagemIds} onCriado={onCriarAtributo}
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

export function GradeEstoque({
  skus, movimentos, origemSel, onMover, onClicarCelula, modo, ajustes, onAjustar, lojaNomes,
  pendencias,
}: {
  skus: SkuRow[];
  movimentos: Movimento[];
  origemSel: { codigo: string; loja: string } | null;
  onMover: (row: SkuRow, de: string, para: string) => void;
  onClicarCelula: (row: SkuRow, loja: string) => void;
  modo: 'mover' | 'ajustar';
  ajustes: Record<string, number>;
  onAjustar: (row: SkuRow, loja: string, valor: number) => void;
  lojaNomes: Map<string, string>;
  pendencias: Pendencia[];
}) {
  // A lista saiu daqui pra `lojas-grade.ts` em 24/08: a matriz de reposição
  // soma o TENHO com ela, e dois conjuntos diferentes dariam dois estoques da
  // mesma peça na mesma tela.
  const lojas = useMemo(() => lojasDaGrade(skus, lojaNomes), [skus, lojaNomes]);

  /**
   * As três camadas da célula:
   *   base      = estoque real
   *   rascunho  = arrastos ainda não autorizados (delta)
   *   pendência = transferência já AUTORIZADA e não concluída
   *
   * `pending` desconta do disponível (a peça ainda está aqui, mas tem dono);
   * `in_transit` NÃO desconta na origem (o estoque já baixou no envio) — na
   * direção do destino ele aparece como "a caminho".
   */
  function saldo(row: SkuRow, loja: string) {
    const base = row.estoqueLojas?.[loja] ?? 0;
    const saiu = movimentos.filter((m) => m.codigo === row.codigo && m.de === loja).length;
    const entrou = movimentos.filter((m) => m.codigo === row.codigo && m.para === loja).length;

    const minhas = pendencias.filter((p) => p.codigo === row.codigo);
    const soma = (lista: Pendencia[]) => lista.reduce((s, p) => s + p.qty, 0);
    const pedidoSai = soma(minhas.filter((p) => p.de === loja && p.status === 'pending'));
    const pedidoChega = soma(minhas.filter((p) => p.para === loja && p.status === 'pending'));
    const ruaChega = soma(minhas.filter((p) => p.para === loja && p.status === 'in_transit'));

    return {
      valor: base - pedidoSai - saiu + entrou,
      base,
      delta: entrou - saiu,
      pedidoSai,
      pedidoChega,
      ruaChega,
    };
  }

  return (
    <div className="overflow-x-auto border border-slate-200 rounded-lg bg-white">
      <table className="text-xs min-w-full">
        <thead className="bg-slate-50 text-slate-500">
          <tr>
            <th className="px-2 py-1.5 text-left font-bold">TAM</th>
            {/* Sigla na coluna, código no title — "03" não diz nada pra quem
                opera, mas quem confere nota às vezes precisa do número. */}
            {lojas.map((l) => (
              <th key={l} title={`Loja ${l}`} className="px-2 py-1.5 font-bold whitespace-nowrap">
                {lojaNomes.get(l) || l}
              </th>
            ))}
            <th className="px-2 py-1.5 font-bold">TOT</th>
          </tr>
        </thead>
        <tbody>
          {skus.map((r) => {
            const total = lojas.reduce((s, l) => s + saldo(r, l).valor, 0);
            return (
              <tr key={r.codigo} className="border-t border-slate-100">
                <td className="px-2 py-1.5 font-bold text-slate-700">{r.tamanho}</td>
                {lojas.map((l) => {
                  const { valor, base, delta, pedidoSai, pedidoChega, ruaChega } = saldo(r, l);
                  const selecionada = origemSel?.codigo === r.codigo && origemSel.loja === l;

                  if (modo === 'ajustar') {
                    const chave = `${r.codigo}|${l}`;
                    const base = r.estoqueLojas?.[l] ?? 0;
                    const atual = ajustes[chave] ?? base;
                    return (
                      <td key={l} className="px-1 py-1 text-center">
                        <input
                          type="number"
                          value={atual}
                          onChange={(e) => onAjustar(r, l, Number(e.target.value))}
                          className={`w-14 px-1 py-1 text-center text-xs tabular-nums border rounded ${
                            chave in ajustes
                              ? 'border-amber-400 bg-amber-50 font-bold text-amber-800'
                              : 'border-slate-200'
                          }`}
                        />
                      </td>
                    );
                  }
                  // Vermelho onde saiu, azul onde entrou — o preview pedido.
                  const temPendencia = pedidoSai > 0 || pedidoChega > 0 || ruaChega > 0;
                  const cor = delta < 0 ? 'text-rose-600 font-bold'
                    : delta > 0 ? 'text-blue-600 font-bold'
                    : valor ? 'text-slate-800' : 'text-slate-300';
                  const dicas = [
                    valor > 0 ? 'Arraste (ou clique aqui e depois no destino)' : '',
                    pedidoSai > 0 ? `${pedidoSai} já pedida(s) daqui — aguardando envio (disponível ${valor} de ${base})` : '',
                    pedidoChega > 0 ? `${pedidoChega} pedida(s) pra cá — aguardando envio` : '',
                    ruaChega > 0 ? `${ruaChega} a caminho daqui (já saiu da origem)` : '',
                  ].filter(Boolean).join(' · ');
                  return (
                    <td
                      key={l}
                      // Arrasta a peça; o drop decide o destino.
                      draggable={valor > 0}
                      onDragStart={(e) => {
                        e.dataTransfer.setData('text/plain', JSON.stringify({ codigo: r.codigo, de: l }));
                        e.dataTransfer.effectAllowed = 'move';
                      }}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault();
                        try {
                          const d = JSON.parse(e.dataTransfer.getData('text/plain'));
                          if (d?.codigo === r.codigo) onMover(r, d.de, l);
                        } catch { /* payload de outro lugar — ignora */ }
                      }}
                      onClick={() => onClicarCelula(r, l)}
                      title={dicas || undefined}
                      className={`px-2 py-1.5 text-center tabular-nums cursor-pointer select-none hover:bg-violet-50 ${cor} ${
                        selecionada ? 'ring-2 ring-violet-500 ring-inset bg-violet-50' : ''
                      }`}
                    >
                      {/* Zero vira "·" só quando não houve movimento nem
                          pendência — com marcação, "0" deixa claro que zerou
                          de propósito (senão sai "·-3", que parece defeito). */}
                      {delta !== 0 || temPendencia ? valor : (valor || '·')}
                      {/* Rascunho (forte): o que VOCÊ está montando agora. */}
                      {delta !== 0 && (
                        <span className="ml-0.5 text-[9px] align-super">
                          {delta > 0 ? `+${delta}` : delta}
                        </span>
                      )}
                      {/* Já autorizado (âmbar): pedido, aguardando envio.
                          Some sozinho quando a remessa conclui ou cancela. */}
                      {pedidoSai > 0 && (
                        <span className="ml-0.5 text-[9px] align-super font-bold text-amber-600">-{pedidoSai}</span>
                      )}
                      {pedidoChega > 0 && (
                        <span className="ml-0.5 text-[9px] align-super font-bold text-amber-600">+{pedidoChega}</span>
                      )}
                      {/* Na rua (violeta): já saiu da origem, falta chegar. */}
                      {ruaChega > 0 && (
                        <span className="ml-0.5 text-[9px] align-super font-bold text-violet-600">+{ruaChega}</span>
                      )}
                    </td>
                  );
                })}
                <td className="px-2 py-1.5 text-center font-bold tabular-nums">{total}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="text-[10px] text-slate-400 px-2 py-1.5 border-t border-slate-100">
        {modo === 'mover' ? (
          <>
            Arraste um número de uma loja para outra para mover 1 peça (ou clique na
            origem e depois no destino). <span className="text-rose-600">Vermelho</span>/
            <span className="text-blue-600">azul</span> = rascunho (não autorizado) ·{' '}
            <span className="text-amber-600 font-bold">âmbar</span> = já pedido, aguardando
            envio · <span className="text-violet-600 font-bold">violeta</span> = a caminho.
            O número da célula já desconta o que está pedido — a marcação some quando a
            transferência conclui.
          </>
        ) : (
          <>
            Digite a quantidade certa em cada loja. A diferença vira entrada ou saída
            com motivo <b>AJUSTE</b> — mexe no estoque de verdade assim que salvar, sem
            gerar ordem de separação. Negativo não é aceito aqui (só o sistema chega
            nele, quando vende peça em trânsito).
          </>
        )}
      </p>
    </div>
  );
}

/* ─────────────── Nível 3: campos da COR ─────────────── */

export function FichaDaCor({
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
  // A galeria vive aqui porque duas coisas dependem dela: o status
  // ("faltam fotos" some assim que a primeira sobe) e a bolinha, que é pintada
  // a conta-gotas EM CIMA da foto.
  const [fotos, setFotos] = useState<FotoCor[]>(fichaCor?.fotos ?? []);
  const [swatch, setSwatch] = useState<SwatchCor>({
    swatchTipo: fichaCor?.swatchTipo ?? 'cor',
    corHex: fichaCor?.corHex ?? null,
    swatchFocoX: fichaCor?.swatchFocoX ?? null,
    swatchFocoY: fichaCor?.swatchFocoY ?? null,
  });
  const [swatchSave, setSwatchSave] = useState<'salvando' | 'ok' | null>(null);
  const [statusSalvo, setStatusSalvo] = useState<'salvando' | 'ok' | null>(null);
  const semFotos = fotos.length === 0;

  const urlCor = `/produto-ficha/${encodeURIComponent(ref_)}/cor/${encodeURIComponent(cor)}?marca=${encodeURIComponent(marca)}`;

  /** Resposta de qualquer PATCH/GET → estado local + pai, numa passada só. */
  const aplicarFicha = useCallback((f: Ficha) => {
    const c = f.cores?.find((x) => x.cor === cor);
    if (c) {
      // 'sem_fotos' é calculado e não existe no select — cai no "Fora do site".
      setStatus(c.statusPublicacao === 'sem_fotos' ? 'nao_publicar' : c.statusPublicacao);
    }
    onSalvo(f);
  }, [cor, onSalvo]);

  /**
   * BOLINHA SALVA SOZINHA (pedido do dono, 06/08): o resultado da IA, do
   * conta-gotas, do recorte e do seletor "à mão" grava sem passar pelo botão.
   * Debounce curto porque o <input type=color> dispara a cada arrasto do
   * mouse dentro do picker.
   *
   * ⚠️ O BUG DAS "5 SOLICITAÇÕES" (dono 07/08): só UMA cor fica aberta por
   * vez — clicar na próxima cor DESMONTA este painel na hora, e o cleanup
   * antigo fazia clearTimeout com o PATCH ainda pendente. Quem pintava a
   * bolinha e ia direto pra próxima cor (o fluxo natural) perdia o save em
   * silêncio; testando devagar funcionava. Por isso: o pendente agora vive
   * num ref e o desmonte DISPARA o PATCH em vez de descartá-lo.
   */
  const swatchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const swatchPendente = useRef<SwatchCor | null>(null);

  useEffect(() => () => {
    if (swatchTimer.current) clearTimeout(swatchTimer.current);
    const s = swatchPendente.current;
    if (s) {
      swatchPendente.current = null;
      // Componente já morreu: nada de setState — só garante a gravação.
      void api(urlCor, { method: 'PATCH', body: JSON.stringify(s) }).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlCor]);

  function agendarSwatch(s: SwatchCor) {
    swatchPendente.current = s;
    if (swatchTimer.current) clearTimeout(swatchTimer.current);
    setSwatchSave('salvando');
    swatchTimer.current = setTimeout(async () => {
      const pendente = swatchPendente.current;
      swatchPendente.current = null;
      if (!pendente) return;
      try {
        const f = await api<Ficha>(urlCor, { method: 'PATCH', body: JSON.stringify(pendente) });
        aplicarFicha(f);
        setSwatchSave('ok');
      } catch (e: any) {
        setSwatchSave(null);
        setErro(e?.message || 'Não consegui salvar a bolinha');
      }
    }, 600);
  }

  /**
   * Publicação vale no clique — era o "mudei e esqueci de salvar" clássico.
   *
   * E DIZ QUE AVISOU O SITE: o salvamento invisível é o que fez o dono trocar
   * pra "Fora do site", olhar a vitrine no mesmo minuto e concluir que não
   * tinha salvado (19/08). O backend derruba o cache e avisa a borda do site
   * neste PATCH; a tela agora conta isso em vez de deixar em silêncio.
   */
  async function mudarStatus(novo: string) {
    const anterior = status;
    setStatus(novo);
    setErro(null);
    setStatusSalvo('salvando');
    try {
      const f = await api<Ficha>(urlCor, {
        method: 'PATCH',
        body: JSON.stringify({ statusPublicacao: novo }),
      });
      aplicarFicha(f);
      setStatusSalvo('ok');
    } catch (e: any) {
      setStatus(anterior);
      setStatusSalvo(null);
      setErro(e?.message || 'Não consegui mudar a publicação');
    }
  }

  /**
   * Depois que a galeria muda, o backend pode ter publicado a peça sozinho
   * (upload = publicar). Busca a ficha fresca pra tela contar essa verdade —
   * sem isso o select seguia em "Fora do site" com a peça já no ar.
   */
  async function sincronizarFicha() {
    try {
      const f = await api<Ficha>(`/produto-ficha/${encodeURIComponent(ref_)}?marca=${encodeURIComponent(marca)}`);
      if (f) aplicarFicha(f);
    } catch { /* informativo — a próxima interação sincroniza */ }
  }

  async function salvar() {
    setSalvando(true);
    setErro(null);
    try {
      const f = await api<Ficha>(urlCor, {
        method: 'PATCH',
        body: JSON.stringify({
          tituloComercial: titulo || null,
          youtubeUrl: youtube || null,
          statusPublicacao: status,
          ...swatch,
        }),
      });
      aplicarFicha(f);
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
            onChange={(e) => void mudarStatus(e.target.value)}
            disabled={semFotos}
            title={semFotos ? 'Sem foto o site não tem o que mostrar' : 'Vale na hora — sem precisar salvar'}
            className="px-2 py-2 border rounded text-sm bg-white disabled:opacity-50"
          >
            <option value="nao_publicar">Fora do site</option>
            <option value="pronto">Pronto pra publicar</option>
            <option value="publicado">No ar</option>
          </select>
        </div>

        {statusSalvo && (
          <p className="text-[11px] text-slate-500 pb-2">
            {statusSalvo === 'salvando' ? (
              'Salvando…'
            ) : (
              <span className="text-emerald-700 font-bold">
                Salvo — já avisei o site (leva alguns segundos pra atualizar a vitrine)
              </span>
            )}
          </p>
        )}

        <div className="flex items-center gap-1.5">
          <ImageIcon className="w-3.5 h-3.5 text-slate-400" />
          <span className="text-xs text-slate-500">
            {semFotos
              ? 'Nenhuma foto — o status fica em "faltam fotos"'
              : `${fotos.length} foto(s)`}
          </span>
        </div>
      </div>

      <FotosDaCor
        refSku={ref_}
        cor={cor}
        fotosIniciais={fichaCor?.fotos ?? []}
        swatch={swatch}
        onSwatchChange={(s) => { setSwatch(s); agendarSwatch(s); }}
        onFotosChange={(novas) => { setFotos(novas); void sincronizarFicha(); }}
        swatchSave={swatchSave}
      />

      {erro && <p className="text-xs text-rose-700">{erro}</p>}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void salvar()}
          disabled={salvando}
          className="inline-flex items-center gap-1.5 text-xs font-bold px-4 py-2 rounded-lg bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50"
        >
          {salvando ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
          Salvar título e vídeo
        </button>
        <span className="text-[11px] text-slate-400">
          Fotos, bolinha e publicação já salvam sozinhas.
        </span>
      </div>
    </div>
  );
}
