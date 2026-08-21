'use client';

/**
 * /retaguarda/produtos/[ref]?marca=X — a ficha da peça.
 *
 * DESENHO (dono, 21/08/2026): cabeçalho FIXO em todas as abas com o que
 * identifica a peça e o que decide campanha, e abas por assunto com ESTOQUE
 * primeiro — quando o dono abre uma peça, a primeira pergunta é onde ela está.
 *
 * ⚠️ POR QUE A URL LEVA `marca`: REF sozinha NÃO identifica a peça. REF
 * numérica é reciclada entre fornecedores — o próprio controller da ficha
 * exige marca em toda rota por isso. A busca sempre linka com as duas, e uma
 * REF com duas marcas vira duas linhas lá, não uma escolha escondida aqui.
 *
 * ⚠️ CUSTO E MARGEM SÓ PRA MATRIZ. A poda é no servidor (`ficha-search`); aqui
 * a coluna some inteira, em vez de virar campo vazio pedindo explicação.
 *
 * Cascata de 02/08 preservada: o que é COMUM à peça (tecido, modelagem,
 * medidas) fica em `FichaComum`; o que muda POR COR (título, vídeo, fotos,
 * publicação) fica em `FichaDaCor`, dentro das abas Fotos e Site.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, Loader2, Search } from 'lucide-react';
import { api } from '@/lib/api';
import { Badge, Button, Card, Tabs, type Aba } from '@/components/ui';
import type { AtributosPorTipo, Atributo, TipoAtributo } from '@/components/SelectAtributoPeca';
import {
  agruparPorPeca, buscarPecas, chaveDaPeca, classeDaRef, type Classe, type Peca,
} from '@/features/produtos/busca';
import type { ArvoreSite, Ficha, Grade } from '@/features/produtos/types';
import { FichaComum, FichaDaCor, VitrinesDoSite } from '@/features/produtos/components/FichaProduto';
import AbaEstoque from '@/features/produtos/components/AbaEstoque';
import AbaVendas from '@/features/produtos/components/AbaVendas';
import AbaHistorico from '@/features/produtos/components/AbaHistorico';

type AbaId = 'estoque' | 'vendas' | 'fotos' | 'site' | 'historico';

const MATRIZ = ['admin', 'operator', 'supervisor'];

function brl(n: number | null | undefined): string {
  return n == null ? '—' : n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

export default function FichaProdutoPage() {
  const params = useParams<{ ref: string }>();
  const search = useSearchParams();
  const router = useRouter();

  const ref_ = decodeURIComponent(String(params?.ref || ''));

  const [marca, setMarca] = useState<string>('');
  const [aba, setAba] = useState<AbaId>('estoque');
  const [papel, setPapel] = useState<string>('');
  const [peca, setPeca] = useState<Peca | null>(null);
  const [candidatas, setCandidatas] = useState<Peca[]>([]);
  const [classificacao, setClassificacao] = useState<Array<{ ref: string; tipoProduto: number }>>([]);
  const [lojaNomes, setLojaNomes] = useState<Map<string, string>>(new Map());
  /** TODAS as lojas da rede, na ordem — a grade mostra loja sem peça também. */
  const [lojas, setLojas] = useState<string[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  /* ficha do site (nível REF e nível COR) — só matriz, o endpoint é AdminOnly */
  const [ficha, setFicha] = useState<Ficha | null>(null);
  const [atributos, setAtributos] = useState<AtributosPorTipo>({});
  const [grades, setGrades] = useState<Grade[]>([]);
  const [arvore, setArvore] = useState<ArvoreSite | null>(null);
  const [corAberta, setCorAberta] = useState<string | null>(null);

  const ehMatriz = MATRIZ.includes(papel);

  /**
   * ⚠️ `marca` e a aba vêm da URL e são lidos em useEffect, NUNCA no
   * inicializador do useState: na navegação client-side do Next o componente
   * monta ANTES da URL trocar.
   */
  useEffect(() => {
    setMarca(search.get('marca') || '');
    const a = search.get('aba');
    if (a && ['estoque', 'vendas', 'fotos', 'site', 'historico'].includes(a)) setAba(a as AbaId);
  }, [search]);

  useEffect(() => {
    void (async () => {
      try {
        const me = await api<{ role?: string }>('/auth/me');
        setPapel(String(me?.role || ''));
      } catch { /* sem papel = trata como loja (menos permissivo) */ }
      try {
        const lojas = await api<Array<{ code?: string; codigo?: string; name?: string; nome?: string }>>('/stores');
        const m = new Map<string, string>();
        for (const l of lojas || []) {
          const code = String(l.code ?? l.codigo ?? '').padStart(2, '0');
          if (code) m.set(code, String(l.name ?? l.nome ?? code));
        }
        setLojaNomes(m);
        setLojas([...m.keys()].sort());
      } catch { /* nome de loja é enfeite — código serve */ }
    })();
  }, []);

  const carregarPeca = useCallback(async () => {
    if (!ref_) return;
    setCarregando(true);
    setErro(null);
    try {
      const r = await buscarPecas(ref_);
      const todas = agruparPorPeca(r.rows).filter((p) => p.ref === ref_);
      setClassificacao(r.classificacao || []);

      if (!todas.length) { setErro(`Não achei a peça ${ref_}.`); setPeca(null); return; }

      if (marca) {
        const achada = todas.find((p) => p.chave === chaveDaPeca(ref_, marca));
        if (achada) { setPeca(achada); setCandidatas([]); return; }
      }
      /* sem marca (ou marca que não bate): mostra as candidatas pra escolher */
      if (todas.length === 1) { setPeca(todas[0]); setCandidatas([]); }
      else { setPeca(null); setCandidatas(todas); }
    } catch (e: any) {
      setErro(e?.message || 'Não deu pra carregar a peça.');
      setPeca(null);
    } finally {
      setCarregando(false);
    }
  }, [ref_, marca]);

  useEffect(() => { void carregarPeca(); }, [carregarPeca]);

  /* ficha do site: só faz sentido (e só é permitido) pra matriz */
  useEffect(() => {
    if (!peca || !ehMatriz) return;
    void (async () => {
      const qs = `?marca=${encodeURIComponent(peca.marca)}`;
      try { setFicha(await api<Ficha>(`/produto-ficha/${encodeURIComponent(peca.ref)}${qs}`)); } catch { setFicha(null); }
      try { setAtributos(await api<AtributosPorTipo>('/atributos-peca')); } catch { /* opcional */ }
      try { setGrades(await api<Grade[]>('/produto-ficha/grades')); } catch { /* opcional */ }
      try { setArvore(await api<ArvoreSite>('/loja-catalog/classificacao/arvore')); } catch { /* opcional */ }
    })();
  }, [peca, ehMatriz]);

  const classe: Classe = useMemo(
    () => classeDaRef(ref_, classificacao),
    [ref_, classificacao],
  );

  const rotuloDoSku = useCallback((sku: string) => {
    const s = peca?.skus.find((x) => x.codigo === sku);
    return s ? [s.cor, s.tamanho].filter(Boolean).join(' · ') || sku : sku;
  }, [peca]);

  const abas: Aba<AbaId>[] = useMemo(() => {
    const base: Aba<AbaId>[] = [
      { id: 'estoque', label: 'Estoque', contagem: peca?.estoque ?? 0, tom: peca && peca.estoque > 0 ? undefined : 'warn' },
      { id: 'vendas', label: 'Vendas' },
    ];
    if (ehMatriz) {
      base.push({ id: 'fotos', label: 'Fotos', contagem: peca?.cores.length });
      base.push({ id: 'site', label: 'Site' });
    }
    base.push({ id: 'historico', label: 'Histórico' });
    return base;
  }, [peca, ehMatriz]);

  function trocarAba(id: AbaId) {
    setAba(id);
    const qs = new URLSearchParams(Array.from(search.entries()));
    qs.set('aba', id);
    router.replace(`/retaguarda/produtos/${encodeURIComponent(ref_)}?${qs.toString()}`, { scroll: false });
  }

  /* ── REF com mais de uma marca: quem escolhe é quem conhece a peça ── */
  if (!carregando && !peca && candidatas.length > 1) {
    return (
      <div className="min-h-screen bg-ground p-4">
        <div className="mx-auto max-w-3xl">
          <Card className="p-5">
            <h1 className="text-[17px] font-extrabold text-ink">
              A REF {ref_} existe em {candidatas.length} marcas
            </h1>
            <p className="mt-1 text-[13px] text-ink-soft">
              REF numérica é reciclada entre fornecedores, então são peças diferentes com o mesmo
              número. Escolha a sua:
            </p>
            <div className="mt-4 flex flex-col gap-2">
              {candidatas.map((c) => (
                <Link
                  key={c.chave}
                  href={`/retaguarda/produtos/${encodeURIComponent(c.ref)}?marca=${encodeURIComponent(c.marca)}`}
                  className="flex flex-wrap items-center gap-3 rounded-card border border-line bg-surface px-4 py-3 transition-colors hover:border-action focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action"
                >
                  <span className="font-semibold text-ink">{c.marca || 'sem marca'}</span>
                  <span className="text-[13px] text-ink-soft">{c.nome}</span>
                  <span className="ml-auto text-[13px] tabular-nums text-ink-soft">
                    {c.cores.length} cor(es) · {c.estoque} em estoque
                  </span>
                </Link>
              ))}
            </div>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-ground">
      {/* ── Cabeçalho fixo: vale pra todas as abas ── */}
      <header className="sticky top-0 z-30 border-b border-line bg-surface">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-3">
          <Link
            href="/retaguarda/produtos"
            title="Voltar pra busca"
            className="rounded-field p-2 text-ink-soft transition-colors hover:bg-line-soft hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action"
          >
            <ArrowLeft className="h-5 w-5" />
          </Link>

          <div className="min-w-[180px]">
            <div className="font-mono text-[11px] tracking-[.08em] text-ink-faint">
              REF {ref_}{peca?.marca ? ` · ${peca.marca}` : ''}
            </div>
            <h1 className="text-[16px] font-extrabold tracking-[-.02em] text-ink">
              {peca?.nome || (carregando ? 'Carregando…' : '—')}
            </h1>
            <Badge tom={classe === 'BASICO' ? 'neutro' : 'ok'} className="mt-0.5">
              {classe === 'BASICO' ? 'BÁSICO · não entra em queima' : 'MODA · entra em queima'}
            </Badge>
          </div>

          <div className="ml-auto flex flex-wrap gap-5">
            {ehMatriz && (
              <>
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-[.11em] text-ink-soft">Custo</div>
                  <div className="text-[15px] font-bold tabular-nums text-ink">{brl(peca?.custo)}</div>
                </div>
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-[.11em] text-ink-soft">Margem</div>
                  <div className="text-[15px] font-bold tabular-nums text-ink">
                    {peca?.margem != null ? `${peca.margem.toLocaleString('pt-BR')}%` : '—'}
                  </div>
                </div>
              </>
            )}
            <div>
              <div className="text-[10px] font-bold uppercase tracking-[.11em] text-ink-soft">Venda</div>
              <div className="text-[15px] font-bold tabular-nums text-ink">{brl(peca?.precoMin)}</div>
            </div>
            <div>
              <div className="text-[10px] font-bold uppercase tracking-[.11em] text-ink-soft">Estoque rede</div>
              <div className="text-[15px] font-bold tabular-nums text-ink">{peca?.estoque ?? '—'}</div>
            </div>
          </div>
        </div>

        <div className="mx-auto max-w-6xl px-4">
          <Tabs abas={abas} valor={aba} onChange={trocarAba} />
        </div>
      </header>

      <main className="mx-auto flex max-w-6xl flex-col gap-3 p-4">
        {erro && (
          <Card className="flex flex-wrap items-center gap-3 border-crit bg-crit-soft px-4 py-3 text-[13px] text-crit">
            {erro}
            <Button size="sm" onClick={() => router.push('/retaguarda/produtos')}>
              <Search className="h-3.5 w-3.5" /> Buscar outra
            </Button>
          </Card>
        )}

        {carregando && (
          <Card className="flex items-center gap-2 px-4 py-6 text-[13px] text-ink-soft">
            <Loader2 className="h-4 w-4 animate-spin" /> Carregando a peça…
          </Card>
        )}

        {peca && aba === 'estoque' && (
          <AbaEstoque
            skus={peca.skus}
            lojas={lojas.length ? lojas : [...new Set(peca.skus.flatMap((s) => Object.keys(s.estoqueLojas ?? {})))].sort()}
            lojaNomes={lojaNomes}
            podeAjustar={ehMatriz}
            onMudou={carregarPeca}
          />
        )}

        {peca && aba === 'vendas' && <AbaVendas ref_={peca.ref} />}

        {peca && aba === 'historico' && (
          <AbaHistorico
            codigos={peca.skus.map((s) => s.codigo)}
            lojaNomes={lojaNomes}
            rotuloDoSku={rotuloDoSku}
          />
        )}

        {peca && ehMatriz && aba === 'fotos' && (
          <div className="flex flex-col gap-3">
            <p className="px-1 text-[12px] text-ink-faint">
              Foto e vídeo são POR COR. Escolha a cor pra abrir.
            </p>
            {peca.cores.map((cor) => (
              <Card key={cor}>
                <button
                  type="button"
                  onClick={() => setCorAberta(corAberta === cor ? null : cor)}
                  className="flex w-full items-center gap-2 px-4 py-3 text-left text-[14px] font-semibold text-ink hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action"
                >
                  {cor}
                  <span className="ml-auto text-[12px] font-normal text-ink-soft">
                    {corAberta === cor ? 'fechar' : 'abrir'}
                  </span>
                </button>
                {corAberta === cor && (
                  <div className="border-t border-line p-4">
                    <FichaDaCor
                      ref_={peca.ref}
                      marca={peca.marca}
                      cor={cor}
                      fichaCor={ficha?.cores?.find((c) => c.cor === cor)}
                      onSalvo={setFicha}
                    />
                  </div>
                )}
              </Card>
            ))}
          </div>
        )}

        {peca && ehMatriz && aba === 'site' && (
          <div className="flex flex-col gap-3">
            <Card className="p-4">
              <FichaComum
                ref_={peca.ref}
                marca={peca.marca}
                ficha={ficha}
                atributos={atributos}
                grades={grades}
                onSalvo={setFicha}
                onCriarAtributo={(tipo: TipoAtributo, novo: Atributo) =>
                  setAtributos((a) => ({ ...a, [tipo]: [...(a[tipo] || []), novo] }))
                }
              />
            </Card>
            <Card className="p-4">
              <VitrinesDoSite ref_={peca.ref} arvore={arvore} />
            </Card>
          </div>
        )}
      </main>
    </div>
  );
}
