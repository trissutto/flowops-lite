'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image';
import { AlertCircle, Loader2, ShoppingBag } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { SizePill } from '@/components/ui/Choice';
import { useToast } from '@/components/feedback/ToastProvider';
import { useCartStore } from '@/store/cart';
import { useQuickAddStore } from '@/store/quick-add';
import { trackAddToCart } from '@/lib/tracking';
import { formatPrice } from '@/lib/utils';
import type { CorApi, PecaApi } from '@/services/products';

/**
 * QUICK ADD — adicionar da vitrine sem sair da página.
 *
 * A cliente clica na sacolinha do card, escolhe COR e TAMANHO numa janelinha e
 * segue navegando. Nasceu do pedido da loja de Itanhaém ("estilo Shein"), e a
 * diferença pro Shein é a nossa: aqui a peça é uma só com várias cores, então a
 * escolha é cor → tamanho, na mesma ordem da página do produto.
 *
 * POR QUE BUSCA A PEÇA AO ABRIR: o card carrega a grade SOMADA de todas as
 * cores. Adicionar por ela colocaria na sacola um 46 que só existe no preto
 * quando a cliente escolheu o vinho. A grade real vem por cor, e é ela que
 * manda aqui.
 *
 * Montado uma vez no layout público — ver `store/quick-add.ts`.
 */
export function QuickAddSheet() {
  const produto = useQuickAddStore((s) => s.produto);
  const fechar = useQuickAddStore((s) => s.fechar);
  const addToCart = useCartStore((s) => s.add);
  const { toast } = useToast();

  const [cores, setCores] = useState<CorApi[]>([]);
  const [carregando, setCarregando] = useState(false);
  const [cor, setCor] = useState<string | null>(null);
  const [tamanho, setTamanho] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  // Zera a escolha a cada peça — senão o 48 escolhido na anterior vem junto.
  useEffect(() => {
    setCor(null);
    setTamanho(null);
    setAviso(null);
    setCores([]);
    if (!produto) return;

    let vivo = true;
    setCarregando(true);
    fetch(`/api/loja/produto/${encodeURIComponent(produto.slug)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((peca: PecaApi | null) => {
        if (!vivo) return;
        const lista = peca?.cores ?? [];
        setCores(lista);
        // A COR DO CARD vem pré-marcada (dono, 21/08): a sacolinha de um card
        // "· Marinho" abre já no Marinho — o card É a cor. Sem cor no card,
        // vale a regra de sempre: cor única se escolhe sozinha.
        const doCard = produto?.vitrineCor?.nome;
        if (doCard && lista.some((c) => c.nome === doCard && c.estoque > 0)) {
          setCor(doCard);
          return;
        }
        const comEstoque = lista.filter((c) => c.estoque > 0);
        if (comEstoque.length === 1) setCor(comEstoque[0].nome);
      })
      .catch(() => { /* fica com a grade do card, abaixo */ })
      .finally(() => vivo && setCarregando(false));

    return () => { vivo = false; };
  }, [produto]);

  if (!produto) return null;

  const corAtual = cores.find((c) => c.nome === cor);
  /** Sem detalhe (backend fora): usa a grade do card, que é melhor que nada. */
  const grade = corAtual
    ? corAtual.tamanhos.map((t) => ({ label: t.label, disponivel: t.disponivel }))
    : cores.length === 0
      ? produto.sizes.map((s) => ({ label: s.label, disponivel: s.available }))
      : [];
  const preco = corAtual && corAtual.preco > 0 ? corAtual.preco : produto.price;
  const precisaEscolherCor = cores.length > 1 && !cor;

  function adicionar() {
    if (precisaEscolherCor) {
      setAviso('Escolha a cor primeiro.');
      return;
    }
    if (!tamanho) {
      setAviso('Escolha o tamanho pra continuar.');
      return;
    }
    // Nome LIMPO: a cor vai no campo `color` e a sacola já a mostra separada.
    // Repetir aqui produzia "Vestido · VINHO · VINHO · 48" na linha do pedido.
    const nome = produto!.name;
    addToCart({
      productId: produto!.id,
      slug: produto!.slug,
      name: nome,
      image: produto!.images[0] ?? { src: '', alt: produto!.name },
      size: tamanho,
      color: cor ?? undefined,
      quantity: 1,
      unitPrice: preco,
    });
    trackAddToCart({ ...produto!, price: preco }, { tamanho, cor: cor ?? undefined });
    // O toast ainda diz a cor — ali ela é confirmação do que ela acabou de
    // escolher, não parte do nome da peça.
    toast({
      message: 'Peça adicionada ao seu look!',
      description: `${nome}${cor ? ` · ${cor}` : ''} · tamanho ${tamanho}`,
    });
    fechar();
  }

  return (
    <Modal
      open={!!produto}
      onClose={fechar}
      label={`Adicionar ${produto.name} à sacola`}
      size="sm"
    >
      <div className="flex gap-4">
        <div className="relative aspect-[3/4] w-24 shrink-0 overflow-hidden rounded-sm bg-surface-alt">
          {produto.images[0]?.src && (
            <Image
              src={produto.images[0].src}
              alt={produto.images[0].alt || produto.name}
              fill
              sizes="96px"
              className="object-cover"
            />
          )}
        </div>
        <div className="min-w-0">
          <p className="text-body">{produto.name}</p>
          <p className="mt-1 text-body tabular-nums">{formatPrice(preco)}</p>
          {produto.installments && (
            <p className="text-small text-muted tabular-nums">
              {produto.installments.times}x de {formatPrice(preco / produto.installments.times)} sem juros
            </p>
          )}
        </div>
      </div>

      {carregando ? (
        <p className="mt-6 flex items-center gap-2 text-small text-muted">
          <Loader2 className="size-4 animate-spin" /> Buscando tamanhos disponíveis…
        </p>
      ) : (
        <>
          {cores.length > 1 && (
            <div className="mt-6">
              <p className="eyebrow text-ink">
                Cor {cor && <span className="ml-1 normal-case text-ink-soft">{cor}</span>}
              </p>
              <div className="mt-3 flex flex-wrap gap-3">
                {cores.map((c) => {
                  const estilo: React.CSSProperties =
                    c.swatch?.tipo === 'foto' && c.swatch.imagem
                      ? {
                          backgroundImage: `url(${c.swatch.imagem})`,
                          backgroundSize: '400%',
                          backgroundPosition: `${(c.swatch.focoX ?? 0.5) * 100}% ${(c.swatch.focoY ?? 0.5) * 100}%`,
                        }
                      : { backgroundColor: c.swatch?.hex || '#D9D4CC' };
                  return (
                    <button
                      key={c.nome}
                      type="button"
                      aria-label={`Cor ${c.nome}`}
                      aria-pressed={cor === c.nome}
                      title={c.nome}
                      onClick={() => { setCor(c.nome); setTamanho(null); setAviso(null); }}
                      className={`relative size-8 rounded-full border transition-all ${
                        cor === c.nome
                          ? 'border-ink ring-2 ring-ink ring-offset-2 ring-offset-background'
                          : 'border-border hover:border-ink-soft'
                      } ${c.estoque <= 0 ? 'opacity-40' : ''}`}
                    >
                      <span style={estilo} className="absolute inset-[3px] rounded-full" />
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div
            className={`mt-6 rounded-lg transition-all duration-300 ${
              aviso && !precisaEscolherCor
                ? 'bg-danger/5 p-3 ring-2 ring-danger ring-offset-2 ring-offset-background'
                : ''
            }`}
          >
            <p className="eyebrow text-ink">Tamanho</p>
            {precisaEscolherCor ? (
              <p className="mt-3 text-small text-muted">Escolha a cor pra ver os tamanhos disponíveis.</p>
            ) : grade.length === 0 ? (
              <p className="mt-3 text-small text-muted">
                Não consegui carregar a grade agora.{' '}
                <a href={`/produto/${produto.slug}`} className="link-underline text-ink">
                  Abrir a página da peça
                </a>
              </p>
            ) : (
              <div className="mt-3 flex flex-wrap gap-2">
                {grade.map((t) => (
                  <SizePill
                    key={t.label}
                    label={t.label}
                    selected={tamanho === t.label}
                    disabled={!t.disponivel}
                    onSelect={() => { setTamanho(t.label); setAviso(null); }}
                  />
                ))}
              </div>
            )}
          </div>

          {aviso && (
            <p
              role="alert"
              className="mt-4 flex items-center gap-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2.5 text-small font-semibold text-danger"
            >
              <AlertCircle className="size-4 shrink-0" strokeWidth={2} />
              {aviso}
            </p>
          )}

          <Button size="lg" block className="mt-6" onClick={adicionar}>
            <ShoppingBag className="mr-2 size-4" strokeWidth={1.75} />
            Adicionar à sacola
          </Button>
          <a
            href={`/produto/${produto.slug}`}
            className="link-underline mt-3 block text-center text-small text-muted"
          >
            Ver todos os detalhes
          </a>
        </>
      )}
    </Modal>
  );
}
