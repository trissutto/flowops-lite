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
  /** Foto: escolhida à mão na retaguarda OU da peça mais nova (automático). */
  imagemUrl: string | null;
  alt: string | null;
  /**
   * RECORTE lido por IA (dono 07/08: "trate as fotos pra dar mais close na
   * peça que simboliza a categoria") — centro (fração 0..1) + zoom sugerido.
   * Sem leitura ainda (ou foto sem foco calculado) → card usa o enquadramento
   * padrão (topo da foto), sem quebrar o card.
   */
  focoX: number | null;
  focoY: number | null;
  focoZoom: number | null;
  /**
   * SEGUNDO NÍVEL — "Blusas" → "Manga curta" (dono, 10/08/2026).
   *
   * Vira filtro dentro da página da categoria, não card no menu principal. O
   * backend só manda as que TÊM peça publicada: subcategoria vazia é promessa
   * que não se cumpre — a cliente clica e recebe página em branco.
   *
   * Vazio enquanto ninguém classificou; a página se comporta como antes.
   */
  subcategorias?: Array<{ slug: string; nome: string; qtdPecas: number }>;
}

/**
 * AS CATEGORIAS COM FOTO E RECORTE (dono 07/08).
 *
 * Toda a resolução — foto manual vs. automática (peça mais nova), e o
 * recorte por IA — acontece no BACKEND (`SiteCategoriasService`), cacheada
 * na própria linha da categoria. Aqui é só consumir `/public/loja/categorias`
 * pronto: uma requisição, não uma por categoria.
 *
 * Fallback pra `/public/loja/filtros` cobre só o caso de backend ainda não
 * atualizado (deploy em trânsito) — sem foto/foco, mas o site não cai.
 */
export async function getCategorias(): Promise<CategoriaVitrine[]> {
  try {
    const r = await api<CategoriaVitrine[]>('/public/loja/categorias', {
      revalidate: REVALIDATE,
      tags: ['categorias'],
    });
    if (Array.isArray(r) && r.length) return r;
  } catch {
    /* cai no fallback abaixo */
  }

  try {
    const filtros = await api<{ categorias?: FiltroValor[] }>('/public/loja/filtros', {
      revalidate: REVALIDATE,
      tags: ['filtros', 'categorias'],
    });
    const categorias = Array.isArray(filtros?.categorias) ? filtros.categorias : [];
    return categorias
      .filter((c) => c?.valor && (c.qtd ?? 0) > 0)
      .map((c) => ({
        slug: c.valor, nome: rotulo(c.valor), qtdPecas: c.qtd ?? 0,
        imagemUrl: null, alt: null, focoX: null, focoY: null, focoZoom: null,
      }));
  } catch {
    return [];
  }
}

/**
 * O menu com o eixo "Categorias" preenchido pelo CRM. Server-side: quem chama
 * é o layout, que passa o resultado pro Header (client) por prop.
 */
/**
 * "CATEGORIAS" VIRA LINK DIRETO (dono 07/08, depois de ver a página nova):
 * "ao clicar em Categorias abrir uma página com os cards da home... está
 * bonito e super rápido, isso que eu quis dizer".
 *
 * Antes o item abria um mega menu com a lista em TEXTO (Blusas, Vestidos...)
 * — o dono clicava e não sentia como se tivesse acontecido nada. A página
 * /categoria (cards com foto + ícone da peça, a mesma seção que já está na
 * home) resolve isso: sem painel no meio do caminho, clicar leva direto pra
 * lá. Menos um estado pra sincronizar (a lista em texto podia divergir da
 * página de cards se alguém mexesse só num dos dois).
 */
export async function getNavegacao(): Promise<NavItem[]> {
  return navigation.map((item) =>
    item.href === '/categoria' ? { ...item, menu: undefined } : item,
  );
}
