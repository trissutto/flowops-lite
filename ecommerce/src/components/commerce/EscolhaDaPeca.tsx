'use client';

import { useMemo, useState } from 'react';
import { ProductGallery } from '@/components/commerce/ProductGallery';
import { BuyBox } from '@/components/commerce/BuyBox';
import { useEstoqueAoVivo } from '@/hooks/useEstoqueAoVivo';
import type { CorApi } from '@/services/products';
import type { Product } from '@/types';

/**
 * ESCOLHA DA PEÇA — galeria + decisão de compra compartilhando a MESMA cor.
 *
 * A página do site é uma só por REF. A cliente escolhe a COR na bolinha e,
 * no mesmo instante, a galeria vira as fotos daquela cor, a grade passa a
 * mostrar só os tamanhos que existem nela e o preço acompanha (liso e
 * estampado da mesma REF costumam custar diferente).
 *
 * Por que este componente existe: galeria e buy box são irmãos no layout, e
 * estado compartilhado entre irmãos precisa morar no pai. Server Component
 * não guarda estado, então o pai tem que ser client — mas só ele: as duas
 * peças pesadas continuam as mesmas.
 *
 * Cor inicial: a primeira COM ESTOQUE. Abrir na cor esgotada é convidar a
 * cliente a bater na parede logo no primeiro clique.
 */
export function EscolhaDaPeca({
  product,
  cores: coresDoServidor,
}: {
  product: Product;
  cores: CorApi[];
}) {
  /**
   * ESTOQUE VIVO (13/08): o HTML é uma fotografia do instante em que a página
   * abriu. Enquanto a cliente está aqui, a grade se reconfere sozinha — ver
   * `useEstoqueAoVivo`. A COR ESCOLHIDA NUNCA MUDA POR CAUSA DISSO: esgotar
   * enquanto ela olha vira aviso, não troca de peça debaixo do dedo dela.
   */
  const cores = useEstoqueAoVivo(product.slug, coresDoServidor);

  /**
   * COR DE ABERTURA: a primeira com estoque **E COM FOTO PRÓPRIA**.
   *
   * O "com estoque" é de sempre — abrir na cor esgotada é convidar a cliente a
   * bater na parede no primeiro clique. O "com foto" entrou em 13/08, junto com
   * a liberação das cores sem foto: as cores vêm em ordem alfabética, então a
   * VOGUE passaria a abrir em BEGE — que não tem foto — e a primeira coisa que
   * a cliente veria seria "as fotos acima são das outras cores". A cor sem foto
   * é ótima como escolha dela; é ruim como cartão de visita da peça.
   *
   * Duas redes, nesta ordem: se nenhuma cor com estoque tem foto, vale a com
   * estoque; se nem isso, a primeira que existir.
   */
  const inicial = useMemo(() => {
    const comEstoque = cores.filter((c) => c.estoque > 0);
    const comFoto = comEstoque.find((c) => c.fotos.length > 0);
    return (comFoto ?? comEstoque[0] ?? cores[0])?.nome ?? null;
  }, [cores]);

  const [cor, setCor] = useState<string | null>(inicial);

  const corAtual = cores.find((c) => c.nome === cor);

  /**
   * A peça vista pela cor escolhida. Sem cor (ou sem ficha ainda), fica
   * exatamente como está hoje — o fallback importa mais que o recurso novo
   * enquanto o cadastro de fotos não terminou.
   */
  /**
   * GALERIA: as fotos DA COR escolhida (06/08 — substituiu o "todas as fotos
   * reordenadas"). A variedade que o autoplay antigo mostrava agora mora na
   * barra lateral: uma miniatura POR COR, e clicar troca a cor inteira.
   * Cor ainda sem foto própria cai nas fotos das outras, com o aviso de
   * foto ilustrativa logo abaixo.
   */
  const galeria = useMemo(() => {
    const daCor = (c: CorApi) =>
      c.fotos.map((f) => ({ src: f.src, alt: f.alt ?? `${product.name} ${c.nome}` }));
    const escolhida = corAtual ? daCor(corAtual) : [];
    if (escolhida.length) return escolhida;
    const resto = cores.filter((c) => c.nome !== corAtual?.nome).flatMap(daCor);
    return resto.length ? resto : product.images;
  }, [cores, corAtual, product]);

  /** Barra lateral: uma miniatura por cor COM foto; clicar = trocar a cor. */
  const grupos = useMemo(() => {
    const comFoto = cores.filter((c) => c.fotos.length > 0);
    if (comFoto.length < 2) return undefined;
    return comFoto.map((c) => ({
      nome: c.nomeAmigavel || c.nome,
      capa: c.fotos[0].src,
      ativa: c.nome === corAtual?.nome,
      onSelect: () => setCor(c.nome),
    }));
  }, [cores, corAtual]);

  /** Cor sem foto própria: mostra a das outras, mas AVISA — senão vira troca. */
  const fotoIlustrativa = !!corAtual && corAtual.fotos.length === 0 && galeria.length > 0;

  const pecaDaCor: Product = useMemo(() => {
    if (!corAtual) return product;
    return {
      ...product,
      price: corAtual.preco > 0 ? corAtual.preco : product.price,
      pixPrice: corAtual.preco > 0 ? Number((corAtual.preco * 0.95).toFixed(2)) : product.pixPrice,
      installments: corAtual.preco > 0
        ? { times: 12, value: Number((corAtual.preco / 12).toFixed(2)) }
        : product.installments,
      images: corAtual.fotos.length
        ? corAtual.fotos.map((f) => ({ src: f.src, alt: f.alt ?? `${product.name} ${corAtual.nome}` }))
        : product.images,
      sizes: corAtual.tamanhos.length
        ? corAtual.tamanhos.map((t) => ({ label: t.label, available: t.disponivel }))
        : product.sizes,
    };
  }, [product, corAtual]);

  /** "Restam 2 nesta cor" — só com estoque de verdade, nunca inventado. */
  const alertaEstoque = (() => {
    if (!corAtual) return null;
    const total = corAtual.tamanhos.reduce((s, t) => s + (t.estoque || 0), 0);
    if (total <= 0 || total > 3) return null;
    return total === 1
      ? `Última peça em ${corAtual.nome}`
      : `Restam ${total} peças em ${corAtual.nome}`;
  })();

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] lg:gap-16">
      {/* `key` força a galeria a voltar pra primeira foto ao trocar de cor —
          sem isso a cliente escolhe MARINHO e continua vendo a 4ª foto do
          PRETO, que era o índice em que ela estava. */}
      <div>
        <ProductGallery key={cor ?? 'unica'} images={galeria} name={pecaDaCor.name} autoPlay grupos={grupos} />
        {fotoIlustrativa && (
          <p className="mt-3 text-small text-ink-muted">
            Ainda não temos foto de <strong>{corAtual!.nome}</strong> — as fotos acima são das
            outras cores desta mesma peça.
          </p>
        )}
      </div>
      <div className="lg:sticky lg:top-28 lg:self-start">
        <BuyBox
          alertaEstoque={alertaEstoque}
          product={pecaDaCor}
          cores={cores.map((c) => ({ nome: c.nome, swatch: c.swatch, estoque: c.estoque }))}
          corSelecionada={cor}
          onSelecionarCor={setCor}
        />
      </div>
    </div>
  );
}
