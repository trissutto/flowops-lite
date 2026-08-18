import 'server-only';
import { api } from '@/lib/api';
import { mapPeca, type PecaApi } from '@/services/products';
import { fetchMaisTopDaSemana, fetchVitrine } from '@/services/vitrine';
import { HOME_CATEGORY_BASE } from '@/data/home';
import type { Product } from '@/types';

/**
 * OS BLOCOS DA HOME — quais saem e em que ordem.
 *
 * Antes (até 17/08/2026) as duas listas eram array chumbado no código: os
 * atalhos em `data/home.ts` e a vitrine no `page.tsx`. Subir "Moda praia" no
 * verão era commit + deploy na Vercel. Agora quem manda é a retaguarda
 * (`/retaguarda/vitrines-home`), e o site só consome.
 *
 * ── UMA REQUISIÇÃO, NÃO UMA POR CARROSSEL ──
 *
 * O backend devolve as vitrines JÁ COM AS PEÇAS. A home fazia um fetch por
 * carrossel; agora é um só, e a ordem não depende de o site saber quais
 * categorias existem.
 *
 * ── O PADRÃO NO CÓDIGO NÃO É REDUNDÂNCIA, É A HOME DE PÉ ──
 *
 * Backend fora do ar, tabela ainda não migrada ou resposta vazia → a home que
 * está no ar hoje, buscada como antes. Ela é a página mais visitada da loja:
 * não pode ficar sem catálogo porque um cadastro não existe. Mesma regra de
 * `banners.ts`.
 */

export interface AtalhoHome {
  name: string;
  image: string;
  href: string;
  alt: string;
}

export interface VitrineHome {
  id: string;
  titulo: string;
  /** Título curto do celular — vazio usa o normal. */
  tituloMobile: string | null;
  eyebrow: string | null;
  descricao: string | null;
  /** Nulo quando a vitrine não tem página própria — a seção sai sem o botão. */
  ctaLabel: string | null;
  ctaHref: string | null;
  produtos: Product[];
}

interface RespostaApi {
  atalhos?: Array<{
    id: string; tipo: string; chave: string; nome: string; href: string;
    imagemUrl: string | null; alt: string | null;
  }>;
  carrosseis?: Array<{
    id: string; titulo: string; tituloMobile: string | null; eyebrow: string | null;
    descricao: string | null; ctaLabel: string | null; ctaHref: string | null;
    itens: PecaApi[];
  }>;
}

/**
 * 60s — o mesmo TTL do catálogo (`REVALIDATE_VITRINE`) e do cache do backend.
 * Pedir mais rápido só bateria no mesmo cache. As três pontas andam juntas.
 */
const REVALIDATE = 60;

/**
 * A ARTE APROVADA DE CADA ATALHO, por destino.
 *
 * As fotos do mockup vivem no repositório (`/images/home-categorias/*.webp`) e
 * continuam mandando: a retaguarda decide QUAIS atalhos saem e em que ordem,
 * não troca a arte da capa por acidente. Atalho sem arte local usa a foto da
 * categoria (a mesma da tela Categorias) — e sem nenhuma das duas, não sai:
 * card sem foto é buraco na primeira dobra.
 */
const ARTE_LOCAL = new Map(HOME_CATEGORY_BASE.map((c) => [c.path, { image: c.image, alt: c.alt }]));

/** A home que está no ar — usada quando o backend não responde. */
function atalhosPadrao(): AtalhoHome[] {
  return HOME_CATEGORY_BASE.map(({ path, ...c }) => ({ ...c, href: path }));
}

/** Os dois carrosséis que estão no ar, na ordem: Mais Top e depois Novidades. */
async function vitrinesPadrao(): Promise<VitrineHome[]> {
  const [maisTop, novidades] = await Promise.all([
    fetchMaisTopDaSemana(),
    fetchVitrine({ ordenar: 'novidades', limite: 10, soNovidade: true }),
  ]);
  return [
    {
      id: 'padrao-mais-top',
      titulo: 'Mais Top da semana',
      tituloMobile: null,
      eyebrow: 'Escolhas da semana',
      descricao: null,
      ctaLabel: 'Ver seleção',
      ctaHref: '/mais-top-da-semana',
      produtos: maisTop.slice(0, 10),
    },
    {
      id: 'padrao-novidades',
      titulo: 'Novidades da semana',
      tituloMobile: 'Novidades',
      eyebrow: 'Acabou de chegar',
      descricao: null,
      ctaLabel: 'Ver todas',
      ctaHref: '/novidades',
      produtos: novidades,
    },
  ].filter((v) => v.produtos.length > 0);
}

export async function getBlocosDaHome(): Promise<{ atalhos: AtalhoHome[]; carrosseis: VitrineHome[] }> {
  try {
    const r = await api<RespostaApi>('/public/loja/home-vitrines', {
      revalidate: REVALIDATE,
      tags: ['catalogo', 'vitrine', 'vitrines-home'],
      timeoutMs: 15000,
    });

    const atalhos: AtalhoHome[] = (r?.atalhos ?? []).map((a) => ({
      name: a.nome,
      href: a.href,
      // Arte do mockup > foto da tela Categorias > nenhuma (o card sai
      // tipográfico — ver `HomeCategory.image`). Não sumimos com o atalho:
      // quem cadastrou precisa ver que cadastrou.
      image: ARTE_LOCAL.get(a.href)?.image || a.imagemUrl || '',
      alt: ARTE_LOCAL.get(a.href)?.alt || a.alt || `${a.nome} plus size`,
    }));

    const carrosseis: VitrineHome[] = (r?.carrosseis ?? [])
      .map((v) => ({
        id: v.id,
        titulo: v.titulo,
        tituloMobile: v.tituloMobile ?? null,
        eyebrow: v.eyebrow ?? null,
        descricao: v.descricao ?? null,
        ctaLabel: v.ctaLabel ?? null,
        ctaHref: v.ctaHref ?? null,
        produtos: (v.itens ?? []).map(mapPeca),
      }))
      .filter((v) => v.produtos.length > 0);

    // Resposta pela metade não vira home pela metade: cada lista cai no seu
    // próprio padrão. Backend novo com tabela vazia devolve as duas vazias.
    if (atalhos.length || carrosseis.length) {
      return {
        atalhos: atalhos.length ? atalhos : atalhosPadrao(),
        carrosseis: carrosseis.length ? carrosseis : await vitrinesPadrao(),
      };
    }
  } catch {
    /* cai no padrão abaixo */
  }
  return { atalhos: atalhosPadrao(), carrosseis: await vitrinesPadrao() };
}
