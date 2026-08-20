'use client';

import { useEffect, useMemo, useState } from 'react';
import Image from 'next/image';
import { ProductGallery } from '@/components/commerce/ProductGallery';
import { BuyBox } from '@/components/commerce/BuyBox';
import { useToast } from '@/components/feedback/ToastProvider';
import { useEstoqueAoVivo } from '@/hooks/useEstoqueAoVivo';
import { youtubeId } from '@/lib/youtube';
import { trackColorSwitch } from '@/lib/tracking';
import { BLUR_DATA_URL, formatPrice } from '@/lib/utils';
import { hexDaCor, type CorApi, type PecaApi } from '@/services/products';
import type { Product } from '@/types';

/**
 * ESCOLHA DA PEÇA — galeria + decisão de compra compartilhando a MESMA cor.
 *
 * A página do site é uma só por REF, mas desde 20/08 ela abre ANCORADA numa
 * cor: o link pode trazer `?cor=` (card de vitrine, anúncio, WhatsApp) e é
 * nela que galeria, grade e preço abrem. Trocar de cor continua instantâneo
 * (estado client), só que agora TODA troca reescreve a URL — o link que a
 * cliente compartilha e o analytics passam a saber QUAL cor ela viu, o que
 * antes se perdia (a bolinha não deixava rastro nenhum).
 *
 * Por que a mudança: medição do funil mostrou 16% de trava na compra em peça
 * multicor contra 5% na de cor única — o PASSO da cor consumia a decisão.
 * A cor saiu do fluxo do BuyBox (lá virou confirmação) e as outras cores
 * viraram CARDS de peça depois do botão (`OutrasCoresDaPeca`), que é também
 * a venda casada: "temos esta mesma peça em...".
 *
 * Por que este componente existe: galeria e buy box são irmãos no layout, e
 * estado compartilhado entre irmãos precisa morar no pai. Server Component
 * não guarda estado, então o pai tem que ser client — mas só ele: as duas
 * peças pesadas continuam as mesmas.
 *
 * Cor inicial sem `?cor=` no link: a primeira COM ESTOQUE. Abrir na cor
 * esgotada é convidar a cliente a bater na parede logo no primeiro clique.
 */
export function EscolhaDaPeca({
  product,
  cores: coresDoServidor,
  look,
  corInicial,
}: {
  product: Product;
  cores: CorApi[];
  /** As peças que saem na MESMA foto — repassado direto pro BuyBox. */
  look?: PecaApi['look'];
  /**
   * A cor que o LINK pediu (`?cor=`), já validada pelo server component
   * contra a lista de cores à venda. Nula = link sem cor, vale a heurística.
   */
  corInicial?: string | null;
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
    // A cor do LINK ganha da heurística (20/08): quem chegou por um card de
    // cor, anúncio ou link de WhatsApp pediu AQUELA cor — abrir em outra é
    // trocar a peça antes do primeiro toque. O server já validou que existe.
    if (corInicial && cores.some((c) => c.nome === corInicial)) return corInicial;
    const comEstoque = cores.filter((c) => c.estoque > 0);
    const comFoto = comEstoque.find((c) => c.fotos.length > 0);
    return (comFoto ?? comEstoque[0] ?? cores[0])?.nome ?? null;
  }, [cores, corInicial]);

  const [cor, setCor] = useState<string | null>(inicial);

  /**
   * TODA troca de cor passa por aqui (20/08): muda o estado (instantâneo,
   * como sempre foi) E reescreve o `?cor=` da URL sem navegar — replaceState
   * não recarrega nada e não empilha histórico (voltar do navegador continua
   * saindo da peça, não desfazendo cores). É o que faz o link compartilhado
   * abrir na cor que ela estava vendo e o funil saber qual cor foi vista.
   */
  function trocarCor(nome: string, opts?: { silencioso?: boolean }) {
    setCor(nome);
    if (!opts?.silencioso) trackColorSwitch(product, nome);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('cor', nome);
      window.history.replaceState(null, '', url);
    } catch {
      /* URL é conveniência — a troca de cor nunca pode falhar por causa dela. */
    }
  }
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
    if (inicial) trocarCor(inicial, { silencioso: true });
    else setCor(null);
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
      onSelect: () => trocarCor(c.nome),
    }));
    // `trocarCor` é estável na prática (só usa setters); fora das deps de propósito.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      <div id="galeria-da-peca" className="min-w-0 scroll-mt-24">
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
          /* `capa` e `nomeAmigavel` entram em 19/08 pela FOLHA DE CORES do
             BuyBox: ela mostra a mesma foto que a fita de miniaturas mostra
             (a primeira da cor) e o nome que a cliente lê — o cru do ERP
             ("VD MUSGO ESC") segue sendo só a chave da seleção. */
          cores={cores.map((c) => ({
            nome: c.nome,
            nomeAmigavel: c.nomeAmigavel,
            capa: c.fotos[0]?.src ?? null,
            swatch: c.swatch,
            estoque: c.estoque,
            tamanhos: c.tamanhos.map((t) => ({ label: t.label, disponivel: t.disponivel })),
          }))}
          corSelecionada={cor}
          tamanho={tamanho}
          onTamanho={setTamanho}
          outrasCores={
            <OutrasCoresDaPeca
              slug={product.slug}
              cores={cores}
              corAtualNome={corAtual?.nome ?? null}
              onTrocar={(nome) => {
                trocarCor(nome);
                /* A prova de que algo aconteceu é a FOTO virar — então a
                   página rola até a galeria. No celular os cards ficam bem
                   abaixo dela; trocar sem subir seria de novo uma mudança
                   fora da vista (a raiz do "nem percebi que escolhi"). */
                document
                  .getElementById('galeria-da-peca')
                  ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }}
            />
          }
        />
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */

/**
 * TEMOS TAMBÉM NESTAS CORES — as outras cores como CARDS de peça (20/08).
 *
 * É o que sobrou (e cresceu) da folha de cores: em vez de um seletor no meio
 * do fluxo de compra, cada cor vira um mini-card com a foto grande, nome e
 * preço — a mesma peça oferecida de novo, que é a venda casada que a
 * vendedora faz no balcão ("esse modelo também veio no preto, quer ver?").
 *
 * O href é REAL (`?cor=`): o Google enxerga um link por cor, e cmd+clique /
 * abrir em nova aba funcionam. O clique normal é interceptado e troca a cor
 * na hora, sem recarregar — com a rolagem até a galeria feita pelo chamador.
 *
 * Cor SEM foto própria mostra o swatch chapado, nunca a foto de outra cor:
 * card com foto errada é a mesma armadilha da "foto ilustrativa" sem aviso.
 */
function OutrasCoresDaPeca({
  slug,
  cores,
  corAtualNome,
  onTrocar,
}: {
  slug: string;
  cores: CorApi[];
  corAtualNome: string | null;
  onTrocar: (nome: string) => void;
}) {
  const outras = cores.filter((c) => c.nome !== corAtualNome);
  if (!outras.length) return null;

  return (
    <div id="outras-cores-da-peca" className="mt-9 scroll-mt-28">
      <p className="eyebrow text-ink">
        {outras.length === 1 ? 'Temos também nesta cor' : 'Temos também nestas cores'}
      </p>
      <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-3">
        {outras.map((c) => {
          const foto = c.fotos[0]?.src ?? c.swatch.imagem;
          return (
            <a
              key={c.nome}
              href={`/produto/${slug}?cor=${encodeURIComponent(c.nome)}`}
              onClick={(e) => {
                e.preventDefault();
                onTrocar(c.nome);
              }}
              className="group rounded-md border border-border p-1.5 transition-colors duration-[180ms] hover:border-ink-soft"
            >
              <span className="relative block aspect-3/4 overflow-hidden rounded-sm bg-surface-alt">
                {foto ? (
                  <Image
                    src={foto}
                    alt={`${c.nomeAmigavel || c.nome}`}
                    fill
                    sizes="200px"
                    placeholder="blur"
                    blurDataURL={BLUR_DATA_URL}
                    className="object-cover transition-transform duration-[320ms] group-hover:scale-[1.03]"
                  />
                ) : (
                  <span
                    className="absolute inset-0"
                    style={{ background: c.swatch.hex ?? hexDaCor(c.nome) }}
                  />
                )}
              </span>
              <span className="mt-1.5 block truncate text-small font-medium text-ink">
                {c.nomeAmigavel || c.nome}
              </span>
              {c.preco > 0 && (
                <span className="tabular block text-small font-light text-ink-soft">
                  {formatPrice(c.preco)}
                </span>
              )}
            </a>
          );
        })}
      </div>
    </div>
  );
}
