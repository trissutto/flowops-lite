import { api } from '@/lib/api';
import { navigation } from '@/data/navigation';
import type { MenuColumn, NavItem } from '@/types';

/**
 * AS CATEGORIAS DO MENU VÊM DO CRM (dono 07/08).
 *
 * O eixo "Categorias" era lista fixa no código: entrava "Fitness" (zero peça
 * publicada) e sumia qualquer categoria nova sem deploy. Agora a lista é a do
 * catálogo — as mesmas categorias que a barra de filtro usa, já com contagem —
 * então categoria só aparece quando existe peça pra mostrar.
 *
 * SEM SUBCATEGORIA (ordem do dono, 07/08): uma lista só, ordenada pela
 * quantidade. As colunas do mega menu são quebra VISUAL (5 por coluna), não
 * hierarquia — por isso vão sem título.
 *
 * Fallback: qualquer falha devolve o menu estático. Categoria é navegação; se
 * o backend cair, o site continua navegável (mesma regra de `banners.ts`).
 */

type FiltroValor = { valor: string; qtd: number };

/** Uma hora, igual à revalidação da home e dos banners. */
const REVALIDATE = 3600;

/** "moda-praia" → "Moda praia" · "calcas" → "Calças". */
const ROTULOS: Record<string, string> = {
  calcas: 'Calças',
  macacoes: 'Macacões',
  'moda-praia': 'Moda praia',
};

function rotulo(slug: string): string {
  const s = String(slug || '').trim();
  if (!s) return '';
  if (ROTULOS[s]) return ROTULOS[s];
  const limpo = s.replace(/[-_]+/g, ' ');
  return limpo.charAt(0).toUpperCase() + limpo.slice(1);
}

export interface CategoriaVitrine {
  slug: string;
  nome: string;
  qtdPecas: number;
  /** Foto da peça MAIS NOVA da categoria — a vitrine se renova sozinha. */
  imagemUrl: string | null;
  alt: string | null;
}

/**
 * AS CATEGORIAS COM FOTO (dono 07/08).
 *
 * A foto de cada card é a da PEÇA MAIS RECENTE daquela categoria: a vitrine
 * se atualiza sozinha conforme a loja cadastra, sem ninguém subir banner de
 * categoria toda semana. A lista de categorias é a do CRM — as mesmas do menu
 * e do filtro, só o que tem peça publicada.
 *
 * Uma requisição por categoria (9 hoje), todas em paralelo e cacheadas por 1h
 * junto com a página. Categoria que falhar volta sem foto em vez de derrubar
 * a página inteira.
 */
export async function getCategorias(): Promise<CategoriaVitrine[]> {
  let categorias: FiltroValor[] = [];
  try {
    const filtros = await api<{ categorias?: FiltroValor[] }>('/public/loja/filtros', {
      revalidate: REVALIDATE,
      tags: ['filtros', 'categorias'],
    });
    categorias = Array.isArray(filtros?.categorias) ? filtros.categorias : [];
  } catch {
    return [];
  }

  const validas = categorias.filter((c) => c?.valor && (c.qtd ?? 0) > 0);

  return Promise.all(
    validas.map(async (c) => {
      const base: CategoriaVitrine = {
        slug: c.valor,
        nome: rotulo(c.valor),
        qtdPecas: c.qtd ?? 0,
        imagemUrl: null,
        alt: null,
      };
      try {
        const r = await api<{ itens?: any[] }>(
          `/public/loja/produtos?categoria=${encodeURIComponent(c.valor)}&perPage=1&ordenar=novidades`,
          { revalidate: REVALIDATE, tags: ['categorias', `categoria:${c.valor}`] },
        );
        const peca = r?.itens?.[0];
        const foto = peca?.imagens?.[0];
        if (foto?.src) {
          base.imagemUrl = foto.src;
          base.alt = `${base.nome} — ${peca.nome ?? ''}`.trim();
        }
      } catch {
        /* card sem foto é melhor que página fora do ar */
      }
      return base;
    }),
  );
}

/**
 * O menu com o eixo "Categorias" preenchido pelo CRM. Server-side: quem chama
 * é o layout, que passa o resultado pro Header (client) por prop.
 */
export async function getNavegacao(): Promise<NavItem[]> {
  let categorias: FiltroValor[] = [];
  try {
    const filtros = await api<{ categorias?: FiltroValor[] }>('/public/loja/filtros', {
      revalidate: REVALIDATE,
      tags: ['filtros', 'categorias'],
    });
    categorias = Array.isArray(filtros?.categorias) ? filtros.categorias : [];
  } catch {
    return navigation;
  }

  const links = categorias
    .filter((c) => c?.valor && (c.qtd ?? 0) > 0)
    .map((c) => ({ label: rotulo(c.valor), href: `/categoria/${c.valor}` }));

  // Catálogo sem categoria classificada: o estático é melhor que menu vazio.
  if (!links.length) return navigation;

  // A mais vendida ganha destaque — é o mesmo critério do card editorial.
  const comDestaque = links.map((l, i) => (i === 0 ? { ...l, highlight: true } : l));

  const colunas: MenuColumn[] = [];
  for (let i = 0; i < comDestaque.length; i += 5) {
    colunas.push({ title: '', links: comDestaque.slice(i, i + 5) });
  }

  return navigation.map((item) => {
    if (item.href !== '/categoria' || !item.menu) return item;
    // "Por preço" fica: é corte da mesma vitrine, não categoria do CRM, e
    // aponta pras únicas rotas de faixa de preço que existem.
    const porPreco = item.menu.columns.filter((c) => c.title === 'Por preço');
    return { ...item, menu: { ...item.menu, columns: [...colunas, ...porPreco] } };
  });
}
