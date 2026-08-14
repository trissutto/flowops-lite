'use client';

import Image from 'next/image';
import { AppLink as Link } from '@/components/ui/AppLink';

/**
 * CARD DE CATEGORIA DA HOME — a arte-botão da categoria.
 *
 * DOIS DESENHOS, NESTA ORDEM:
 *
 * 1. ARTE-BOTÃO (dono, 12/08) — ilustração em traço sobre fundo bege, com o
 *    nome da categoria e o risco dourado JÁ COMPOSTOS no arquivo. É o desenho
 *    de hoje, e é por isso que a arte entra SEM faixa, SEM ícone e SEM nome por
 *    cima: escreveria "BLUSAS" em cima de um "BLUSAS" que já está lá.
 * 2. FOTO (desenho anterior, 07/08) — descrito no bloco abaixo. Sobrou como
 *    fallback pra categoria que ainda não tem arte; as 10 do ar já têm.
 *
 * O DESENHO ANTIGO, que só aparece no fallback:
 *
 * Desenho definido pelo dono (07/08, mockup): a foto é de uma peça REAL da
 * categoria, e por cima dela uma faixa translúcida com o ÍCONE minimalista do
 * tipo de peça e o nome em caixa alta.
 *
 * O ícone existe porque a foto sozinha não diferencia: "blusa branca" e
 * "conjunto branco" na miniatura são a mesma mancha clara. O traço da silhueta
 * diz o que é antes da cliente ler.
 *
 * ⚠️ Sem contagem de peças (o dono tirou): número de itens não ajuda a
 * escolher categoria e envelhece mal — "3 peças" faz a categoria parecer
 * abandonada mesmo quando as 3 são ótimas.
 */

export interface CategoriaCardData {
  slug: string;
  nome: string;
  imagemUrl: string | null;
  alt: string | null;
  /** Recorte lido por IA — centro (fração 0..1) + zoom. Null = sem leitura
   *  ainda; o card cai no enquadramento padrão (topo da foto). */
  focoX?: number | null;
  focoY?: number | null;
  focoZoom?: number | null;
}

/**
 * AS ARTES-BOTÃO, POR SLUG (dono, 12/08).
 *
 * Ficam no repositório (`public/categorias/`), não no R2 como as fotos: são
 * IDENTIDADE da marca, não conteúdo editorial — mudam junto com o layout, não
 * com o estoque. Vantagem: sobem no deploy, sem depender de upload e sem o
 * problema de cache que fazia a edição da retaguarda demorar a aparecer.
 *
 * ⚠️ PEGADINHA: pra estas categorias, trocar a foto em /retaguarda/categorias
 * NÃO muda mais o site — a arte daqui ganha do `imagemUrl` do CRM. Categoria
 * fora desta lista continua 100% pela retaguarda, como sempre foi.
 *
 * Arquivos: 660×880 (3:4, a proporção em que foram compostas), webp ~13 KB.
 */
const ARTE_BOTAO: Record<string, string> = {
  blusas: '/categorias/blusas.webp',
  vestidos: '/categorias/vestidos.webp',
  calcas: '/categorias/calcas.webp',
  conjuntos: '/categorias/conjuntos.webp',
  macacoes: '/categorias/macacoes.webp',
  'moda-praia': '/categorias/moda-praia.webp',
  lingerie: '/categorias/lingerie.webp',
  shorts: '/categorias/shorts.webp',
  saias: '/categorias/saias.webp',
  jaquetas: '/categorias/jaquetas.webp',
};

/**
 * Silhuetas em traço, desenhadas pro tamanho que aparecem (28px): sem
 * detalhe interno, que vira borrão. Categoria sem desenho próprio cai na
 * etiqueta — é honesto e não quebra o layout.
 */
function IconePeca({ slug, className }: { slug: string; className?: string }) {
  const comum = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className,
    'aria-hidden': true,
  };
  const s = slug.toLowerCase();

  if (s.includes('vestido')) {
    return (
      <svg {...comum}>
        <path d="M9 3h6l-1 3 3 4-2 1 1 10H8l1-10-2-1 3-4-1-3Z" />
      </svg>
    );
  }
  if (s.includes('calca') || s.includes('calça')) {
    return (
      <svg {...comum}>
        <path d="M7 3h10l-1 18h-3l-1-9-1 9H8L7 3Z" />
        <path d="M7 7h10" />
      </svg>
    );
  }
  if (s.includes('short') || s.includes('bermuda')) {
    return (
      <svg {...comum}>
        <path d="M7 4h10l-.5 10h-3.5l-1-5-1 5H7.5L7 4Z" />
      </svg>
    );
  }
  if (s.includes('saia')) {
    return (
      <svg {...comum}>
        <path d="M8 4h8l3 15H5L8 4Z" />
        <path d="M8 8h8" />
      </svg>
    );
  }
  if (s.includes('macac')) {
    return (
      <svg {...comum}>
        <path d="M9 3h6v5l1 13h-3l-1-8-1 8H8l1-13V3Z" />
        <path d="M9 3 6 6M15 3l3 3" />
      </svg>
    );
  }
  if (s.includes('conjunto')) {
    return (
      <svg {...comum}>
        <path d="M8 3h8l2 3-2 1v4H8V7L6 6l2-3Z" />
        <path d="M8 13h8l-.5 8h-3l-.5-5-.5 5h-3L8 13Z" />
      </svg>
    );
  }
  if (s.includes('jaqueta') || s.includes('casaco') || s.includes('blazer')) {
    return (
      <svg {...comum}>
        <path d="M9 3h6l3 3-1 2v13H7V8L6 6l3-3Z" />
        <path d="M12 3v18M9 3l3 4 3-4" />
      </svg>
    );
  }
  if (s.includes('praia') || s.includes('biquini') || s.includes('maio')) {
    return (
      <svg {...comum}>
        <path d="M6 6c2 2 4 2 6 0s4-2 6 0" />
        <path d="M8 11h8l-1 4a3 3 0 0 1-6 0l-1-4Z" />
      </svg>
    );
  }
  if (s.includes('outlet') || s.includes('promo')) {
    return (
      <svg {...comum}>
        <path d="M3 12 12 3h8v8l-9 9-8-8Z" />
        <circle cx="16.5" cy="7.5" r="1.2" />
      </svg>
    );
  }
  // Blusa / regata / camisa e o resto do vestuário de cima.
  return (
    <svg {...comum}>
      <path d="M9 3 5 5.5 6.5 9 8 8.5V21h8V8.5l1.5.5L19 5.5 15 3a3 3 0 0 1-6 0Z" />
    </svg>
  );
}

export function CategoriaCard({
  data, index = 0, className,
}: { data: CategoriaCardData; index?: number; className?: string }) {
  const arte = ARTE_BOTAO[data.slug];

  // RECORTE DA IA (dono 07/08: "dar mais close na peça que simboliza a
  // categoria"). O zoom da IA fica FIXO na própria <Image> (é o enquadramento
  // da categoria, não um efeito de interação); o zoom de HOVER vai no
  // wrapper de fora — são dois elementos diferentes de propósito, senão os
  // dois `transform: scale()` brigam pelo mesmo estilo inline.
  const temFoco = data.focoX != null && data.focoY != null;
  const zoom = data.focoZoom ?? 1.4;
  const estiloFoco: React.CSSProperties = temFoco
    ? {
        objectPosition: `${(data.focoX ?? 0.5) * 100}% ${(data.focoY ?? 0.4) * 100}%`,
        transform: `scale(${zoom})`,
        transformOrigin: `${(data.focoX ?? 0.5) * 100}% ${(data.focoY ?? 0.4) * 100}%`,
      }
    : { objectPosition: 'center top' };

  // O zoom acima é feito com CSS transform: scale() em cima da imagem já
  // carregada — o navegador escolhe a resolução com base no `sizes` (tamanho
  // do CARD), sem saber que ela ainda vai ser ampliada. Resultado: foto
  // "sem definição" (dono 07/08) porque pede uma imagem pequena e estica.
  // Corrige multiplicando o `sizes` pelo mesmo fator de zoom, pra pedir uma
  // imagem com resolução suficiente pro tamanho final exibido.
  const zoomFoco = temFoco ? zoom : 1;
  const sizesFoco = `(max-width: 768px) ${Math.round(50 * zoomFoco)}vw, (max-width: 1024px) ${Math.round(33 * zoomFoco)}vw, ${Math.round(20 * zoomFoco)}vw`;

  return (
    /**
     * ENTRADA IMEDIATA, não reveal-por-scroll (07/08 — "tira este espaço em
     * branco"). `/categoria` é uma página curta e a grade é o conteúdo
     * principal, já na dobra — quando o card espera cruzar o gatilho do
     * IntersectionObserver pra aparecer, ele existe no DOM mas fica com
     * opacity:0 até lá, e a cliente vê um vão em branco onde deveriam estar
     * as categorias. `reveal()` é certo pra seção que a cliente rola até
     * encontrar; aqui ela já está olhando.
     */
    <div
      className={`animate-[widget-enter_560ms_cubic-bezier(0.22,1,0.36,1)_both] ${className ?? ''}`}
      style={{ animationDelay: `${(index % 6) * 60}ms` }}
    >
      <Link
        href={`/categoria/${data.slug}`}
        /* A arte-botão já tem moldura própria (cantos arredondados e sombra
           compostos no arquivo) — a borda do card desenharia um segundo
           contorno em volta do primeiro. */
        className={`group relative block overflow-hidden rounded-md ${
          arte ? '' : 'border border-border/60 bg-surface-alt'
        }`}
      >
        {/**
         * 3:4, A PROPORÇÃO EM QUE AS ARTES-BOTÃO FORAM COMPOSTAS (1086×1448).
         *
         * A regra que vale desde 10/08 é "a caixa na mesma proporção do
         * arquivo, pro `cover` não ter o que cortar". O que mudou em 12/08 foi
         * o arquivo: as artes de modelo eram 251×379 (2:3) e as artes-botão
         * são 3:4 — então a caixa acompanhou.
         *
         * UMA proporção só pra grade inteira, de propósito: card mais alto no
         * meio de uma linha de cards menores deixa a fileira desalinhada. Uma
         * categoria sem arte (fallback de foto) é recortada nas laterais pelo
         * cover — o preço de manter a grade reta, e ninguém está nesse caso.
         */}
        <div className="relative aspect-3/4 overflow-hidden">
          {arte ? (
            /* Arte-botão: entra INTEIRA, sem recorte. O arquivo é 3:4 e a
               caixa também, então o `cover` não tem o que cortar — a
               composição (ilustração, nome, risco dourado) aparece exatamente
               como foi desenhada. Sem o zoom da IA, que é tratamento de FOTO:
               aplicado aqui, daria close no meio da ilustração e cortaria
               justamente o nome. */
            <div className="absolute inset-0 transition-transform duration-[720ms] ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:scale-[1.04]">
              <Image
                src={arte}
                alt={data.nome}
                fill
                sizes="(max-width: 768px) 50vw, (max-width: 1024px) 33vw, 20vw"
                className="object-cover"
              />
            </div>
          ) : data.imagemUrl ? (
            <div className="absolute inset-0 transition-transform duration-[720ms] ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:scale-[1.04]">
              <Image
                src={data.imagemUrl}
                alt={data.alt || data.nome}
                fill
                sizes={sizesFoco}
                className="object-cover"
                style={estiloFoco}
              />
            </div>
          ) : (
            <div className="grain size-full bg-gradient-to-br from-champagne via-surface-alt to-background" />
          )}

          {/* Faixa de leitura: só na base, e só o suficiente pro texto branco
              passar em contraste sem apagar a peça.

              NÃO ENTRA sobre a arte-botão — o nome já está composto nela, e a
              faixa escreveria o segundo. O nome da categoria continua chegando
              na leitora de tela pelo `alt` da imagem, que é o nome acessível
              do link. */}
          {!arte && (
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-ink/75 via-ink/45 to-transparent pt-10 pb-4">
            <div className="flex flex-col items-center gap-1.5 px-2">
              <IconePeca slug={data.slug} className="size-7 text-light" />
              <span className="text-center text-[0.6875rem] font-medium tracking-[0.16em] text-light uppercase">
                {data.nome}
              </span>
            </div>
          </div>
          )}
        </div>
      </Link>
    </div>
  );
}
