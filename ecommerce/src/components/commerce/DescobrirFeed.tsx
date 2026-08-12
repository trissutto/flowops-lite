'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Section, type SectionTone } from '@/components/layout/Section';
import { SectionTitle } from '@/components/sections/SectionTitle';
import { Button } from '@/components/ui/Button';
import { ProductCard } from '@/components/cards/ProductCard';
import { ProductGridSkeleton } from '@/components/ui/Skeleton';
import { useIntersection, useNearViewport } from '@/hooks';
import { fetchDescobrir, type ItemDoFeed } from '@/services/descobrir';
import { trackSelectItem, trackViewItemList } from '@/lib/tracking';
import type { Product } from '@/types';

/**
 * FEED DE DESCOBERTA — o fim da página do produto virou o começo da vitrine.
 *
 * Antes daqui havia um carrossel de QUATRO peças: quem gostou da regata tinha
 * que voltar pro menu, achar "Blusas", achar "Regatas" e recomeçar. Agora a
 * página continua na ordem em que a cliente já estava — resto da subcategoria,
 * resto da categoria, próximas categorias — sem teto (dono, 12/08/2026).
 *
 * ── O QUE SEGURA O PESO ──
 *
 * "Não deixar pesar a navegação" é requisito, não detalhe. Três coisas:
 *
 *   1. NADA é buscado enquanto a cliente está lendo a peça. A primeira página
 *      do feed só sai quando a seção se aproxima da tela (`useNearViewport`) —
 *      quem entra na PDP e compra direto não paga por este bloco.
 *   2. A ORDEM vem pronta do servidor, numa sequência só. O navegador não
 *      guarda "quais categorias já mostrei" nem dedupa nada: pede a página
 *      seguinte e desenha.
 *   3. Cada bloco já rolado sai do trabalho de layout do navegador
 *      (`content-visibility`), então a 300ª peça custa o mesmo que a 12ª. A
 *      foto é lazy por padrão (nenhum card aqui é `priority`).
 *
 * SEM react-query aqui, de propósito. A listagem de categoria usa (ela tem
 * filtro, ordenação e cache de consulta pra gerir); este feed só empilha
 * página atrás de página, e a biblioteca custaria ~14 kB de JS em TODA página
 * de produto — a mais visitada do site — pra economizar vinte linhas.
 *
 * O botão "Carregar mais" fica junto com o scroll infinito de propósito:
 * scroll infinito puro deixa quem navega por teclado sem saída.
 */

const PER_PAGE = 12;

interface DescobrirFeedProps {
  /** Peça aberta na página — ela nunca aparece no próprio feed. */
  slug: string;
  title: string;
  eyebrow?: string;
  cta?: { label: string; href: string };
  tone?: SectionTone;
}

export function DescobrirFeed({ slug, title, eyebrow, cta, tone = 'alt' }: DescobrirFeedProps) {
  // A seção existe no HTML desde o início (é âncora do observer), mas só vira
  // requisição quando chega perto da tela.
  const [gatilhoRef, near] = useNearViewport<HTMLDivElement>('600px');

  const [items, setItems] = useState<ItemDoFeed[]>([]);
  const [carregando, setCarregando] = useState(false);
  /** `null` = ainda não sabemos (nada buscado); vira false no fim da lista. */
  const [temMais, setTemMais] = useState<boolean | null>(null);

  /**
   * Refs, não estado: `carregarMais` é chamada pelo observer (que não
   * re-renderiza) e por clique. Duas chamadas na mesma página pediriam a mesma
   * página duas vezes — e o React em modo estrito chama tudo duas vezes de
   * propósito no desenvolvimento.
   */
  const proximaPagina = useRef(1);
  const emVoo = useRef(false);
  const fimDaLista = useRef(false);

  const carregarMais = useCallback(async () => {
    if (emVoo.current || fimDaLista.current) return;
    emVoo.current = true;
    setCarregando(true);
    const pagina = await fetchDescobrir({ slug, page: proximaPagina.current, perPage: PER_PAGE });
    proximaPagina.current += 1;
    if (!pagina.hasMore) fimDaLista.current = true;
    setItems((atuais) => [...atuais, ...pagina.items]);
    setTemMais(pagina.hasMore);
    setCarregando(false);
    emVoo.current = false;
  }, [slug]);

  // Peça nova na tela (navegação entre produtos): o feed recomeça do zero.
  useEffect(() => {
    proximaPagina.current = 1;
    emVoo.current = false;
    fimDaLista.current = false;
    setItems([]);
    setTemMais(null);
  }, [slug]);

  useEffect(() => {
    if (near) void carregarMais();
  }, [near, carregarMais]);

  /**
   * A lista chega achatada; o corte em BLOCOS é feito aqui porque um trecho
   * atravessa páginas (as 40 regatas ocupam as três primeiras). Agrupar por
   * página desenharia "Regatas" três vezes.
   */
  const blocos = useMemo(() => {
    const out: Array<{ grupo: string; rotulo: string; itens: ItemDoFeed[] }> = [];
    for (const item of items) {
      const ultimo = out[out.length - 1];
      if (ultimo && ultimo.grupo === item.trecho.grupo) ultimo.itens.push(item);
      else out.push({ grupo: item.trecho.grupo, rotulo: item.trecho.rotulo, itens: [item] });
    }
    return out;
  }, [items]);

  /**
   * `view_item_list` só da PRIMEIRA página. O feed pode passar de 50 páginas
   * numa sessão de rolagem, e um evento por página estouraria a cota da conta
   * de analytics sem dizer nada novo — a lista é a mesma.
   */
  const impressaoRegistrada = useRef(false);
  useEffect(() => {
    if (impressaoRegistrada.current || items.length === 0) return;
    impressaoRegistrada.current = true;
    trackViewItemList(items.slice(0, PER_PAGE).map((i) => i.product), 'descobrir-pdp');
  }, [items]);

  const sentinelRef = useIntersection(() => void carregarMais(), near);

  /** Só o clique que navega conta como seleção — favoritar não é escolher. */
  const aoClicar = (product: Product, index: number) => (event: React.MouseEvent) => {
    if ((event.target as HTMLElement).closest('a')) {
      trackSelectItem(product, 'descobrir-pdp', index);
    }
  };

  /**
   * Muda a largura, muda a altura de todo bloco congelado — e a altura
   * congelada vira mentira (a página encolhe ou estica sozinha). O contador
   * manda todo mundo medir de novo; girar o celular é o caso real.
   */
  const [medicao, setMedicao] = useState(0);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const aoRedimensionar = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setMedicao((n) => n + 1), 200);
    };
    window.addEventListener('resize', aoRedimensionar);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('resize', aoRedimensionar);
    };
  }, []);

  // Buscou e não veio nada (catálogo fora do ar, peça única): a seção some
  // inteira, como os rails — bloco vazio com título é pior que bloco nenhum.
  if (temMais !== null && items.length === 0) return null;

  const tituloId = 'descobrir-feed-titulo';
  let indiceGlobal = 0;

  return (
    <Section tone={tone} width="wide" aria-labelledby={tituloId}>
      <div ref={gatilhoRef}>
        <SectionTitle id={tituloId} eyebrow={eyebrow} title={title} cta={cta} align="left" />
      </div>

      <div className="mt-14">
        {blocos.map((bloco, i) => {
          const primeiro = indiceGlobal;
          indiceGlobal += bloco.itens.length;
          return (
            <BlocoDoFeed
              key={bloco.grupo}
              rotulo={bloco.rotulo}
              itens={bloco.itens}
              indiceBase={primeiro}
              aoClicar={aoClicar}
              primeiroDaLista={i === 0}
              // O bloco que ainda está recebendo peças NUNCA congela: medir
              // algo que está crescendo daria altura errada.
              congelavel={i < blocos.length - 1}
              medicao={medicao}
            />
          );
        })}

        {carregando && (
          <div className={blocos.length ? 'mt-14' : undefined}>
            <ProductGridSkeleton count={blocos.length ? 4 : PER_PAGE} />
          </div>
        )}

        <div ref={sentinelRef} aria-hidden className="h-px" />

        {temMais && (
          <div className="mt-14 flex justify-center">
            <Button
              variant="secondary"
              size="lg"
              onClick={() => void carregarMais()}
              disabled={carregando}
            >
              {carregando ? 'Carregando…' : 'Carregar mais peças'}
            </Button>
          </div>
        )}

        {temMais === false && items.length > 0 && (
          <p className="mt-14 text-center text-small text-ink-muted">
            Você chegou ao fim: {items.length} peças da loja inteira.
          </p>
        )}
      </div>
    </Section>
  );
}

/**
 * UM TRECHO DO FEED — as peças de uma subcategoria/categoria, com o rótulo que
 * separa dela da seguinte.
 *
 * ── POR QUE ELE SE MEDE ──
 *
 * Depois de trezentas peças na tela, o navegador refaz layout e pintura de
 * tudo a cada rolagem. `content-visibility: auto` tira do trabalho o que está
 * fora da tela — mas o navegador precisa saber que altura reservar, e o
 * palpite de um valor fixo (`contain-intrinsic-size: 900px`) faz a página
 * encolher de 15.000px pra 900px no instante em que o bloco sai de vista: a
 * rolagem PULA na mão da cliente.
 *
 * Por isso a altura não é palpite: o bloco se mede enquanto ainda está
 * desenhado por inteiro (é o último da lista, ninguém congela ele) e só depois
 * autoriza o navegador a pular seu conteúdo, reservando exatamente o espaço
 * que ele ocupava. Nada se move.
 */
function BlocoDoFeed({
  rotulo,
  itens,
  indiceBase,
  aoClicar,
  primeiroDaLista,
  congelavel,
  medicao,
}: {
  rotulo: string;
  itens: ItemDoFeed[];
  indiceBase: number;
  aoClicar: (product: Product, index: number) => (event: React.MouseEvent) => void;
  primeiroDaLista: boolean;
  congelavel: boolean;
  medicao: number;
}) {
  const ref = useRef<HTMLElement>(null);
  const [altura, setAltura] = useState<number | null>(null);

  // Nova largura de tela → a altura medida não vale mais.
  useEffect(() => setAltura(null), [medicao]);

  useEffect(() => {
    if (!congelavel || altura !== null) return;
    const medido = ref.current?.offsetHeight ?? 0;
    if (medido > 0) setAltura(medido);
  }, [congelavel, altura, itens.length]);

  return (
    <section
      ref={ref}
      aria-label={rotulo || undefined}
      style={
        congelavel && altura
          ? { contentVisibility: 'auto', containIntrinsicSize: `${altura}px` }
          : undefined
      }
    >
      {rotulo && (
        <div className={primeiroDaLista ? 'mb-8' : 'mt-20 mb-8 border-t border-border pt-10'}>
          <p className="eyebrow text-primary-strong">{rotulo}</p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-x-4 gap-y-10 lg:grid-cols-4 lg:gap-x-6 lg:gap-y-14">
        {itens.map((item, j) => (
          <div key={item.product.id} onClickCapture={aoClicar(item.product, indiceBase + j)}>
            <ProductCard product={item.product} index={j} />
          </div>
        ))}
      </div>
    </section>
  );
}
