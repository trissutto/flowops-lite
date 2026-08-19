'use client';

import { useEffect, useMemo, useState } from 'react';
import { ProductGallery } from '@/components/commerce/ProductGallery';
import { BuyBox } from '@/components/commerce/BuyBox';
import { useToast } from '@/components/feedback/ToastProvider';
import { useEstoqueAoVivo } from '@/hooks/useEstoqueAoVivo';
import { youtubeId } from '@/lib/youtube';
import type { CorApi, PecaApi } from '@/services/products';
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
  look,
}: {
  product: Product;
  cores: CorApi[];
  /** As peças que saem na MESMA foto — repassado direto pro BuyBox. */
  look?: PecaApi['look'];
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
  /**
   * O TAMANHO MORA AQUI (17/08), e nao dentro do BuyBox.
   *
   * Quem risca a cor sem o numero escolhido e a FITA de miniaturas, que
   * vive na outra coluna. Irma, nao filha — entao o estado sobe pro pai
   * que enxerga as duas.
   */
  const [tamanho, setTamanho] = useState<string | null>(null);

  const corAtual = cores.find((c) => c.nome === cor);

  /**
   * A COR ESCOLHIDA ESGOTOU E SAIU DA LISTA (13/08).
   *
   * Desde que "cor sem peça não aparece" virou regra no backend, a cor pode
   * DESAPARECER da resposta enquanto a cliente está na página — o estoque se
   * reconfere sozinho a cada 45 s (ver `useEstoqueAoVivo`).
   *
   * Sem tratar, `corAtual` viraria `undefined` e a página cairia calada no
   * fallback da peça: a galeria trocaria de foto e o preço poderia mudar sem
   * nenhum motivo visível. Trocar a peça debaixo do dedo da cliente é pior que
   * a notícia ruim — então a notícia é dada, e a página vai pra uma cor que
   * existe de verdade.
   */
  const { toast } = useToast();
  const corSumiu = !!cor && cores.length > 0 && !corAtual;
  useEffect(() => {
    if (!corSumiu) return;
    const perdida = cor;
    setCor(inicial);
    toast({
      message: `A cor ${perdida} esgotou`,
      description: 'Levaram a última enquanto você olhava. Veja as outras cores desta peça.',
    });
    // Só o sumiço é gatilho: reagir à própria troca reabriria o aviso em loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [corSumiu]);

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
      // Riscada quando ela ja escolheu um numero que esta cor nao tem.
      indisponivel: !!tamanho && !c.tamanhos.some((t) => t.label === tamanho && t.disponivel),
      onSelect: () => setCor(c.nome),
    }));
  }, [cores, corAtual, tamanho]);

  /**
   * VÍDEO DA PEÇA — último slide da galeria (19/08).
   *
   * O campo "Vídeo (YouTube)" existe na tela master desde sempre e é POR COR;
   * o backend já mandava o link em `cores[].youtubeUrl` e a página
   * simplesmente não tinha onde mostrar — cadastrava e não aparecia.
   *
   * ORDEM: o vídeo da cor escolhida ganha. Não tendo, vale o de QUALQUER cor
   * da peça — a peça é a mesma e o caimento é o que a cliente quer ver — mas
   * então a capa diz de qual cor ele é. Vídeo de outra cor sem esse aviso é a
   * mesma armadilha da foto ilustrativa: ela compra achando que a cor é
   * aquela e a peça volta como troca.
   */
  const video = useMemo(() => {
    const daEscolhida = youtubeId(corAtual?.youtubeUrl);
    if (daEscolhida) return { id: daEscolhida, corDoVideo: null };
    const outra = cores.find((c) => c.nome !== corAtual?.nome && youtubeId(c.youtubeUrl));
    const id = youtubeId(outra?.youtubeUrl);
    return id ? { id, corDoVideo: outra!.nomeAmigavel || outra!.nome } : null;
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
    /* `gap-5` no mobile (dono, 15/08: "aproxime a referência e todo o bloco
       da foto"): os 40px do `gap-10` eram respiro de página larga, onde a
       galeria e a coluna de compra ficam LADO A LADO. Empilhadas no celular
       o mesmo número vira um buraco entre a foto e o nome da peça. O desktop
       segue nos 64px do `lg:gap-16`. */
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] lg:gap-16">
      {/* `key` força a galeria a voltar pra primeira foto ao trocar de cor —
          sem isso a cliente escolhe MARINHO e continua vendo a 4ª foto do
          PRETO, que era o índice em que ela estava. */}
      {/* ⚠️ `min-w-0` NOS DOIS FILHOS — o desktop já tinha o equivalente no
          `minmax(0,…)` das colunas, mas no MOBILE a coluna única implícita usa
          `min-width:auto`: a fita de miniaturas (uma POR COR, 13/08) tem
          largura mínima de 64px×N cores, e com 8 cores são 596px que o item de
          grid se recusava a encolher. O viewport de layout do celular esticava
          pra 620px e a PDP INTEIRA cortava à direita — grade de tamanhos,
          "Adicionar à sacola", tudo. Quanto mais cores a peça ganhava, pior. */}
      <div className="min-w-0">
        <ProductGallery
          key={cor ?? 'unica'}
          images={galeria}
          name={pecaDaCor.name}
          autoPlay
          grupos={grupos}
          badges={pecaDaCor.badges}
          video={video}
        />
        {fotoIlustrativa && (
          <p className="mt-3 text-small text-ink-muted">
            Ainda não temos foto de <strong>{corAtual!.nome}</strong> — as fotos acima são das
            outras cores desta mesma peça.
          </p>
        )}
      </div>
      <div className="min-w-0 lg:sticky lg:top-28 lg:self-start">
        <BuyBox
          alertaEstoque={alertaEstoque}
          look={look}
          product={pecaDaCor}
          /* `tamanhos` entra aqui (17/08) porque agora o TAMANHO vem primeiro:
             é a grade de cada cor que decide qual bolinha sai riscada quando
             ela já escolheu o número. */
          cores={cores.map((c) => ({
            nome: c.nome,
            swatch: c.swatch,
            estoque: c.estoque,
            tamanhos: c.tamanhos.map((t) => ({ label: t.label, disponivel: t.disponivel })),
          }))}
          corSelecionada={cor}
          onSelecionarCor={setCor}
          tamanho={tamanho}
          onTamanho={setTamanho}
        />
      </div>
    </div>
  );
}
