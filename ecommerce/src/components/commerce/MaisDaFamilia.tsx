import Image from 'next/image';
import { AppLink as Link } from '@/components/ui/AppLink';
import { BLUR_DATA_URL, formatPrice } from '@/lib/utils';
import type { Product } from '@/types';

/**
 * MAIS DA FAMÍLIA — as irmãs da peça, logo abaixo do botão de compra.
 *
 * Nasceu do pedido do dono (21/08) olhando a DISNEY-012: peça de cor única
 * não tem grade de cores, então a coluna de compra termina no botão e a
 * cliente não vê mais nada pra querer. Quem tem cor (a CHIC) ganha a mesma
 * faixa — a diferença é só o que vem antes dela.
 *
 * Duas formas, uma decisão de espaço (aprovada no preview):
 *   - CELULAR: faixa que desliza pro lado. A foto é grande (é ela que vende)
 *     e a altura é curta, pra não empurrar o resto da página pra baixo.
 *   - PC: grade 2×2 com nome e preço. A coluna da direita tem sobra de
 *     altura e ali cabe informação.
 *
 * NÃO É BOTÃO. A hierarquia da coluna continua valendo: "Adicionar à sacola"
 * é o único botão grande ([[pdp-coluna-compra-hierarquia]]) — aqui são fotos
 * que levam pra outra peça.
 *
 * As peças chegam prontas do SERVIDOR (a página da peça é server component):
 * nenhuma chamada nova sai do navegador e a PDP, que é a página mais visitada
 * do site, não engorda por causa deste bloco.
 */
export function MaisDaFamilia({
  pecas,
  /**
   * NÃO repetir "Você também pode gostar": esse é o título do feed do rodapé,
   * que também começa pela subcategoria desta peça. Dois blocos com o mesmo
   * nome na mesma página fazem a cliente achar que a página bugou.
   */
  titulo = 'Peças parecidas',
  verTudoHref,
  verTudoLabel,
}: {
  /** Já vêm filtradas e sem a peça atual — este componente só apresenta. */
  pecas: Product[];
  titulo?: string;
  verTudoHref?: string;
  verTudoLabel?: string;
}) {
  if (!pecas.length) return null;

  return (
    <section className="mt-7 border-t border-border pt-6" aria-label={titulo}>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-small font-medium uppercase tracking-[0.12em] text-ink">{titulo}</h2>
        {verTudoHref && (
          <Link
            href={verTudoHref}
            className="link-underline shrink-0 text-small text-muted transition-colors hover:text-ink"
          >
            {verTudoLabel ?? 'ver tudo'}
          </Link>
        )}
      </div>

      {/* CELULAR — faixa que desliza. `snap` deixa a peça parar inteira no
          lugar em vez de cortada no meio; a barra some porque o dedo já diz
          que rola. `-mx-*`/`px-*` sangram até a borda da tela: peça cortada
          na margem é o que faz o dedo entender que tem mais coisa ao lado. */}
      <ul className="-mx-5 flex snap-x snap-mandatory gap-3 overflow-x-auto px-5 pb-1 [scrollbar-width:none] sm:-mx-6 sm:px-6 lg:hidden [&::-webkit-scrollbar]:hidden">
        {/* ~36% da largura = 2,5 peças na tela de 390px: a terceira aparece
            cortada, que é o que faz o dedo entender que desliza. Medido no
            celular: 104px de foto era miniatura; 118px já mostra a peça. */}
        {pecas.map((p) => (
          <li key={chave(p)} className="w-[36%] min-w-[118px] shrink-0 snap-start">
            <PecaFoto peca={p} sizes="(max-width: 640px) 36vw, 200px" />
          </li>
        ))}
      </ul>

      {/* PC — grade 2×2 com nome. Duas colunas cabem na coluna da direita sem
          espremer a foto, e o nome ajuda a decidir sem abrir a peça. */}
      <ul className="hidden gap-x-4 gap-y-5 lg:grid lg:grid-cols-2">
        {pecas.slice(0, 4).map((p) => (
          <li key={chave(p)}>
            <PecaComNome peca={p} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * A MESMA peça pode voltar em cores diferentes (a vitrine explode cor em card
 * próprio desde 20/08) — a chave junta REF e cor pra duas irmãs não colidirem.
 */
function chave(p: Product): string {
  return p.vitrineCor ? `${p.id}~${p.vitrineCor.nome}` : String(p.id);
}

/** Link da peça, ancorado na cor quando o card é de uma cor específica. */
function destino(p: Product): string {
  return p.vitrineCor
    ? `/produto/${p.slug}?cor=${encodeURIComponent(p.vitrineCor.nome)}`
    : `/produto/${p.slug}`;
}

/** Só foto + preço — o formato do celular, onde o espaço é curto. */
function PecaFoto({ peca, sizes }: { peca: Product; sizes: string }) {
  const foto = peca.images[0];
  return (
    <Link href={destino(peca)} className="group block">
      <div className="relative aspect-[3/4] overflow-hidden rounded-sm bg-surface-alt">
        {foto?.src && (
          <Image
            src={foto.src}
            alt={foto.alt || peca.name}
            fill
            sizes={sizes}
            placeholder="blur"
            blurDataURL={BLUR_DATA_URL}
            className="object-cover transition-transform duration-500 group-hover:scale-[1.04]"
          />
        )}
      </div>
      <p className="mt-1.5 text-small tabular-nums text-ink">{formatPrice(peca.price)}</p>
    </Link>
  );
}

/** Foto pequena + nome + preço — o formato do PC. */
function PecaComNome({ peca }: { peca: Product }) {
  const foto = peca.images[0];
  return (
    <Link href={destino(peca)} className="group flex items-center gap-3">
      <div className="relative aspect-[3/4] w-14 shrink-0 overflow-hidden rounded-sm bg-surface-alt">
        {foto?.src && (
          <Image
            src={foto.src}
            alt={foto.alt || peca.name}
            fill
            sizes="56px"
            placeholder="blur"
            blurDataURL={BLUR_DATA_URL}
            className="object-cover transition-transform duration-500 group-hover:scale-[1.04]"
          />
        )}
      </div>
      <div className="min-w-0">
        {/* Duas linhas no máximo: nome de peça plus size é comprido e três
            linhas desalinhavam as duas colunas da grade. */}
        <p className="line-clamp-2 text-small leading-snug text-ink-soft transition-colors group-hover:text-ink">
          {peca.name}
        </p>
        <p className="mt-0.5 text-small font-medium tabular-nums text-ink">{formatPrice(peca.price)}</p>
      </div>
    </Link>
  );
}
