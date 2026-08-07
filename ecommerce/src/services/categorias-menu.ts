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

/**
 * O mínimo que a vitrine precisa da peça: nome e a primeira foto. Tipado à
 * mão de propósito — `any` aqui QUEBRA O BUILD da Vercel (o lint de produção
 * trata `no-explicit-any` como erro, não como aviso). Derrubou o deploy do
 * site em 07/08.
 */
interface PecaDaCategoria {
  nome?: string;
  imagens?: Array<{ src?: string }>;
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
  /**
   * A CONFIGURAÇÃO DA RETAGUARDA VEM PRIMEIRO (/retaguarda/categorias):
   * nome de exibição, ordem e a foto escolhida à mão. Só o que ela não
   * define é que cai no automático (nome do slug, foto da peça mais nova).
   * Escolha humana ganha de heurística — sempre.
   */
  let configuradas: Array<{
    slug: string; nome: string; imagemUrl: string | null; alt: string | null;
    qtdPecas: number; ordem: number;
  }> = [];
  try {
    const r = await api<typeof configuradas>('/public/loja/categorias', {
      revalidate: REVALIDATE,
      tags: ['categorias'],
    });
    if (Array.isArray(r)) configuradas = r;
  } catch {
    /* backend antigo (deploy pendente) — cai no caminho dos filtros abaixo */
  }

  let categorias: FiltroValor[] = configuradas.length
    ? configuradas.map((c) => ({ valor: c.slug, qtd: c.qtdPecas }))
    : [];

  if (!categorias.length) {
    try {
      const filtros = await api<{ categorias?: FiltroValor[] }>('/public/loja/filtros', {
        revalidate: REVALIDATE,
        tags: ['filtros', 'categorias'],
      });
      categorias = Array.isArray(filtros?.categorias) ? filtros.categorias : [];
    } catch {
      return [];
    }
  }

  const porSlug = new Map(configuradas.map((c) => [c.slug, c]));
  const validas = categorias.filter((c) => c?.valor && (c.qtd ?? 0) > 0);

  return Promise.all(
    validas.map(async (c) => {
      const cfg = porSlug.get(c.valor);
      const base: CategoriaVitrine = {
        slug: c.valor,
        nome: cfg?.nome || rotulo(c.valor),
        qtdPecas: c.qtd ?? 0,
        imagemUrl: cfg?.imagemUrl ?? null,
        alt: cfg?.alt ?? null,
      };
      // Foto escolhida na retaguarda manda — não gasta requisição buscando peça.
      if (base.imagemUrl) return base;
      try {
        const r = await api<{ itens?: PecaDaCategoria[] }>(
          `/public/loja/produtos?categoria=${encodeURIComponent(c.valor)}&perPage=1&ordenar=novidades`,
          { revalidate: REVALIDATE, tags: ['categorias', `categoria:${c.valor}`] },
        );
        const peca = r?.itens?.[0];
        const foto = peca?.imagens?.[0];
        if (peca && foto?.src) {
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
