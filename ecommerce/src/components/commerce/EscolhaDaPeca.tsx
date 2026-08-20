'use client';

import { useEffect, useMemo, useState } from 'react';
import Image from 'next/image';
import { AlertCircle, Check } from 'lucide-react';
import { ProductGallery } from '@/components/commerce/ProductGallery';
import { BuyBox } from '@/components/commerce/BuyBox';
import { useToast } from '@/components/feedback/ToastProvider';
import { useEstoqueAoVivo } from '@/hooks/useEstoqueAoVivo';
import { youtubeId } from '@/lib/youtube';
import { trackColorSwitch } from '@/lib/tracking';
import { BLUR_DATA_URL, cn } from '@/lib/utils';
import { hexDaCor, rotuloDaCor, type CorApi, type PecaApi } from '@/services/products';
import type { Product } from '@/types';

/**
 * ESCOLHA DA PEÇA — galeria + decisão de compra compartilhando a MESMA cor.
 *
 * O FLUXO (dono, 20/08 à noite): a cor é o PASSO 1, escolhida na GRADE DE
 * CORES embaixo da foto principal — todas as cores em linhas de 4, sem
 * rolagem (a régua lateral escondia metade das cores atrás do "MAIS CORES").
 * Só depois vem o tamanho (passo 2, no BuyBox). A página abre SEM cor
 * escolhida; tentar o tamanho ou o botão antes disso rola até a grade e
 * pede a escolha. Tocou numa cor: "Cor escolhida: GOIABA" em destaque, ✓ na
 * miniatura e a foto principal vira junto.
 *
 * O link pode trazer `?cor=` (card de vitrine, anúncio, WhatsApp) — aí a
 * página abre ancorada naquela cor, já escolhida. Toda troca reescreve a
 * URL sem navegar: o link compartilhado e o analytics sabem qual cor ela viu.
 *
 * Por que este componente existe: galeria e buy box são irmãos no layout, e
 * estado compartilhado entre irmãos precisa morar no pai. Server Component
 * não guarda estado, então o pai tem que ser client — mas só ele: as duas
 * peças pesadas continuam as mesmas.
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
   * A PÁGINA ABRE SEM COR ESCOLHIDA (dono, 20/08 à noite): "a pessoa escolhe
   * a cor, DEPOIS o tamanho". Escolher a cor pela cliente — que era o
   * comportamento desde sempre (abrir na primeira com estoque) — fazia o
   * passo parecer resolvido e ela nem via que existiam outras 7 cores.
   *
   * A EXCEÇÃO é o link que já traz a cor (`?cor=`): quem chegou por card de
   * vitrine, anúncio ou WhatsApp pediu AQUELA cor — aí ela abre escolhida.
   *
   * A heurística antiga (primeira com estoque E com foto) continua viva como
   * `melhorCor`, mas só como REDE: é pra onde a página vai quando a cor
   * escolhida esgota debaixo do dedo dela.
   */
  const melhorCor = useMemo(() => {
    const comEstoque = cores.filter((c) => c.estoque > 0);
    const comFoto = comEstoque.find((c) => c.fotos.length > 0);
    return (comFoto ?? comEstoque[0] ?? cores[0])?.nome ?? null;
  }, [cores]);

  const inicial = useMemo(() => {
    if (corInicial && cores.some((c) => c.nome === corInicial)) return corInicial;
    // Peça de UMA cor não tem escolha a fazer — já abre nela.
    if (cores.length === 1) return cores[0].nome;
    return null;
  }, [cores, corInicial]);

  const [cor, setCor] = useState<string | null>(inicial);
  /** Ela tentou o tamanho (ou o botão) sem cor: o passo da cor acende. */
  const [corError, setCorError] = useState(false);

  /**
   * O `?cor=` MUDOU COM A PÁGINA JÁ ABERTA (20/08): a sugestão de cores da
   * SACOLA navega pra esta mesma PDP com outra cor — sem key no componente,
   * o estado não renasce. Então a cor do link é adotada quando chega.
   */
  useEffect(() => {
    if (corInicial && corInicial !== cor && cores.some((c) => c.nome === corInicial)) {
      trocarCor(corInicial, { silencioso: true });
    }
    // Só o link é gatilho — reagir a `cor` desfaria a troca manual seguinte.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [corInicial]);

  /**
   * TODA troca de cor passa por aqui (20/08): muda o estado (instantâneo,
   * como sempre foi) E reescreve o `?cor=` da URL sem navegar — replaceState
   * não recarrega nada e não empilha histórico (voltar do navegador continua
   * saindo da peça, não desfazendo cores). É o que faz o link compartilhado
   * abrir na cor que ela estava vendo e o funil saber qual cor foi vista.
   */
  function trocarCor(nome: string, opts?: { silencioso?: boolean }) {
    setCor(nome);
    setCorError(false);
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
   * ELA PULOU DIRETO PRO TAMANHO (ou pro botão) SEM ESCOLHER A COR.
   *
   * Regra do dono (20/08): não escolher por ela — PEDIR. A página rola até a
   * grade de cores e o passo acende, com a mesma moldura vermelha que o
   * tamanho usa quando falta. O toque dela não é perdido: assim que tocar
   * numa cor, o erro apaga e a grade de tamanhos passa a valer.
   */
  function pedirCor() {
    setCorError(true);
    document
      .getElementById('grade-de-cores')
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
    if (melhorCor) trocarCor(melhorCor, { silencioso: true });
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

  /**
   * A GRADE DE CORES (dono, 20/08 à noite) — o seletor único de cor.
   *
   * Substituiu a régua lateral de miniaturas, que em peça de 8 cores mostrava
   * 3 e escondia 5 atrás do "MAIS CORES". Aqui TODAS aparecem de uma vez,
   * em linhas de 4, sem rolagem — 8 cores são 2 linhas, 12 seriam 3.
   *
   * Toda cor entra, COM ou SEM foto (a sem foto vira swatch chapado): cor
   * escondida foi exatamente o defeito que matou a régua.
   */
  const temVariasCores = cores.length > 1;

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
        {/* A LINHA DA COR NO TOPO, ACIMA DA FOTO (dono, 20/08: "descrição bem
            menor e no topo"). A primeira versão punha o rótulo grande entre a
            foto e a grade — e um nomeAmigavel poluído do cadastro estourou em
            três linhas. Aqui é uma linha discreta; quem grita é a grade. */}
        {temVariasCores && (
          <p className="mb-2 text-center text-small text-ink-soft lg:text-left" aria-live="polite">
            {corAtual ? (
              <>
                Cor escolhida:{' '}
                <span className="font-semibold uppercase tracking-wide text-ink">
                  {rotuloDaCor(corAtual)}
                </span>
              </>
            ) : (
              'Escolha a cor abaixo da foto'
            )}
          </p>
        )}
        <ProductGallery
          key={cor ?? 'unica'}
          images={galeria}
          name={pecaDaCor.name}
          autoPlay
          badges={pecaDaCor.badges}
          video={video}
        />
        {fotoIlustrativa && (
          <p className="mt-3 text-small text-ink-muted">
            Ainda não temos foto de <strong>{corAtual!.nome}</strong> — as fotos acima são das
            outras cores desta mesma peça.
          </p>
        )}
        {/* A GRADE DE CORES mora AQUI, colada na foto que ela muda (dono,
            20/08): miniaturas embaixo da foto principal, todas de uma vez,
            sem rolagem. É o passo 1 da compra — o tamanho (passo 2) fica na
            coluna ao lado. */}
        {temVariasCores && (
          <GradeDeCores
            slug={product.slug}
            cores={cores}
            corAtualNome={corAtual?.nome ?? null}
            tamanho={tamanho}
            erro={corError}
            onEscolher={trocarCor}
          />
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
          /* A cor ainda não foi escolhida: o BuyBox trava o tamanho e o
             botão, e qualquer tentativa cai no `pedirCor` — que rola até a
             grade e acende o passo (dono, 20/08: "se a pessoa clicar no
             tamanho sem escolher a cor, o site pede para escolher a cor"). */
          corPendente={temVariasCores && !cor}
          onPedirCor={pedirCor}
        />
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */

/**
 * A GRADE DE CORES — o seletor único de cor da PDP (dono, 20/08 à noite).
 *
 * Linhas de 4, SEM rolagem: 8 cores = 2 linhas, todas visíveis de uma vez.
 * Nasceu da morte da régua lateral, que em peça de 8 cores mostrava 3 e
 * escondia 5 atrás do "MAIS CORES" — "cortou as cores que temos".
 *
 * O rótulo é o passo 1 da compra: "Escolha a cor" enquanto falta, e a
 * confirmação em voz alta — "Cor escolhida: GOIABA" — quando ela toca.
 * A miniatura tocada ganha borda + ✓ e a foto principal vira junto.
 *
 * O href é REAL (`?cor=`): o Google enxerga um link por cor, e cmd+clique /
 * abrir em nova aba funcionam. O clique normal é interceptado e troca a cor
 * na hora, sem recarregar.
 *
 * Cor SEM foto própria mostra o swatch chapado, nunca a foto de outra cor:
 * miniatura com foto errada é a armadilha da "foto ilustrativa" sem aviso.
 */
function GradeDeCores({
  slug,
  cores,
  corAtualNome,
  tamanho,
  erro,
  onEscolher,
}: {
  slug: string;
  cores: CorApi[];
  corAtualNome: string | null;
  /** O número já escolhido — risca a cor que não tem ele (nunca esconde). */
  tamanho: string | null;
  /** Ela tentou tamanho/botão sem cor: o passo inteiro acende. */
  erro: boolean;
  onEscolher: (nome: string) => void;
}) {
  const atual = cores.find((c) => c.nome === corAtualNome) ?? null;

  return (
    <div
      id="grade-de-cores"
      className={cn(
        'mt-4 scroll-mt-28 rounded-lg transition-all duration-300',
        erro && 'bg-danger/5 p-3 ring-2 ring-danger ring-offset-2 ring-offset-background',
      )}
    >
      {/* Rótulo do passo, ENXUTO (dono, 20/08: "descrição bem menor") — a
          confirmação em voz alta mora ACIMA da foto; aqui só o convite. */}
      <div className="flex items-center justify-center gap-2 lg:justify-start">
        <span
          aria-hidden
          className={cn(
            'tabular flex size-5 shrink-0 items-center justify-center rounded-pill border text-[0.6875rem] font-medium transition-colors duration-[320ms]',
            atual ? 'border-primary bg-primary text-light' : 'border-ink-soft text-ink',
          )}
        >
          {atual ? <Check className="size-3" strokeWidth={3} /> : 1}
        </span>
        <p className="text-small font-medium text-ink">
          {atual ? 'Cor escolhida' : 'Escolha a cor'}
        </p>
      </div>

      {erro && !atual && (
        <p
          role="alert"
          className="mt-3 flex items-center gap-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2.5 text-small font-semibold text-danger"
        >
          <AlertCircle className="size-4 shrink-0" strokeWidth={2} />
          Toque numa cor abaixo 👇 pra depois escolher o tamanho.
        </p>
      )}

      {/* 4 por linha, sem rolagem — o catálogo de cores INTEIRO na tela.
          `grid` em vez de fita: era a rolagem escondendo cor que matou a
          régua lateral. */}
      <div role="radiogroup" aria-label="Cores da peça" className="mt-3 grid grid-cols-4 gap-2">
        {cores.map((c) => {
          const ativa = c.nome === corAtualNome;
          const foto = c.fotos[0]?.src ?? c.swatch.imagem;
          // Já tem número escolhido e esta cor não tem ele: riscada, nunca
          // escondida — e segue clicável (ela pode trocar o número depois).
          const indisponivel =
            !!tamanho && !c.tamanhos.some((t) => t.label === tamanho && t.disponivel);
          return (
            <a
              key={c.nome}
              href={`/produto/${slug}?cor=${encodeURIComponent(c.nome)}`}
              role="radio"
              aria-checked={ativa}
              aria-label={`Cor ${rotuloDaCor(c)}`}
              onClick={(e) => {
                e.preventDefault();
                onEscolher(c.nome);
              }}
              className="group min-w-0"
            >
              <span
                className={cn(
                  'relative block aspect-3/4 overflow-hidden rounded-md border transition-all duration-[320ms]',
                  indisponivel && 'opacity-45',
                  ativa
                    ? 'border-primary ring-2 ring-primary ring-offset-2 ring-offset-background'
                    : 'border-border group-hover:border-ink-soft',
                )}
              >
                {foto ? (
                  <Image
                    src={foto}
                    alt=""
                    aria-hidden
                    fill
                    sizes="120px"
                    placeholder="blur"
                    blurDataURL={BLUR_DATA_URL}
                    className="object-cover"
                  />
                ) : (
                  <span
                    aria-hidden
                    className="absolute inset-0"
                    style={{ background: c.swatch.hex ?? hexDaCor(c.nome) }}
                  />
                )}
                {/* O ✓ não some nunca — em peça escura a borda de seleção
                    desaparece contra a própria foto. */}
                {ativa && !indisponivel && (
                  <span className="absolute right-1 top-1 flex size-5 items-center justify-center rounded-full bg-primary shadow-sm">
                    <Check className="size-3 text-light" strokeWidth={3} />
                  </span>
                )}
                {indisponivel && (
                  <span aria-hidden className="absolute inset-0 flex items-center justify-center">
                    <span className="h-px w-[140%] rotate-[38deg] bg-ink-soft/80" />
                  </span>
                )}
              </span>
              <span
                className={cn(
                  'mt-1 block truncate text-center text-[0.6875rem] leading-tight transition-colors',
                  ativa ? 'font-semibold text-ink' : 'text-ink-soft',
                )}
              >
                {rotuloDaCor(c)}
              </span>
            </a>
          );
        })}
      </div>
    </div>
  );
}
