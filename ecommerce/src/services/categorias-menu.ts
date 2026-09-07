import { api } from '@/lib/api';
import { navigation } from '@/data/navigation';
import { fetchColecoesMenu } from '@/services/colecoes';
import type { NavItem } from '@/types';

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

/**
 * HISTÓRICO DO CACHE DESTA CONSULTA — três eras:
 *
 * 1. Até 10/08/2026: ISR de 1h SEM invalidação. O aviso da retaguarda
 *    (`/api/revalidar`) exigia `REVALIDATE_SECRET`, que nunca foi criada — o
 *    backend desistia em silêncio e toda edição esperava a hora inteira. O
 *    dono subiu as fotos das 12 categorias, viu as antigas e concluiu que não
 *    tinha salvo. Daí o "elimine este cache".
 * 2. 10/08 → 06/09: `fresco: true` (revalidate 0) nas páginas de categoria —
 *    confiança de volta, pagando um SSR por visita.
 * 3. Desde 06/09: o aviso FUNCIONA (cai no `LOJA_ORDER_TOKEN` desde 13/08 —
 *    se o checkout vende, o aviso anda; conferido em produção) e a
 *    classificação/edição dispara `revalidateTag('categorias')`. As páginas
 *    de categoria voltaram pro ISR de 60s e esta consulta é lida com a tag
 *    `categorias`: salvou na retaguarda → o evento derruba → a próxima visita
 *    regenera. Os 60s são só rede de segurança.
 *
 * ⚠️ `fresco: true` (revalidate 0) segue existindo pra quem chamar de rota já
 * dinâmica — mas um único fetch `no-store` numa rota ISR derruba a rota
 * inteira pro dinâmico. Não usar em página cacheada.
 */
const REVALIDATE_PADRAO = 60;
const SEMPRE_FRESCO = 0;

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
  /**
   * CATEGORIA EM DESTAQUE VIRA ABA PRÓPRIA no topo (dono, 13/08: "a Linha
   * Conforto entra como uma nova aba lá em cima; ao clicar abre em cascata").
   * O interruptor é o "Destaque" da tela /retaguarda/categorias — marcou,
   * vira aba com as subcategorias em cascata; desmarcou, volta a ser só card.
   */
  destaque?: boolean;
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
 *
 * `fresco` pula o cache — ver o bloco de REVALIDATE_PADRAO lá em cima.
 */
export async function getCategorias(
  { fresco = false }: { fresco?: boolean } = {},
): Promise<CategoriaVitrine[]> {
  const revalidate = fresco ? SEMPRE_FRESCO : REVALIDATE_PADRAO;
  try {
    const r = await api<CategoriaVitrine[]>('/public/loja/categorias', {
      revalidate,
      tags: ['categorias'],
    });
    if (Array.isArray(r) && r.length) {
      return r.map((categoria) => ({
        ...categoria,
        // O slug é canônico; evita expor nomes técnicos sem acento vindos do CRM.
        nome: ROTULOS[categoria.slug] ?? categoria.nome ?? rotulo(categoria.slug),
      }));
    }
  } catch {
    /* cai no fallback abaixo */
  }

  try {
    const filtros = await api<{ categorias?: FiltroValor[] }>('/public/loja/filtros', {
      revalidate,
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
  const base = navigation.map((item) =>
    item.href === '/categoria' ? { ...item, menu: undefined } : item,
  );

  /**
   * ABAS DINÂMICAS — categoria marcada como "Destaque" na retaguarda entra
   * como eixo próprio logo depois de "Categorias" (dono, 13/08, pra Linha
   * Conforto). A cascata são as subcategorias com peça publicada, apontando
   * pro filtro `?sub=` que a página da categoria já entende. Falhou o fetch?
   * O menu estático segue de pé — mesma regra do resto deste arquivo.
   */
  try {
    const destacadas = (await getCategorias()).filter((c) => c.destaque);
    if (destacadas.length) {
      const abas: NavItem[] = destacadas.map((c) => ({
        label: c.nome,
        href: `/categoria/${c.slug}`,
        icon: 'Sparkles',
        menu: c.subcategorias?.length
          ? {
              columns: [
                {
                  title: c.nome,
                  links: c.subcategorias.map((s) => ({
                    label: s.nome,
                    href: `/categoria/${c.slug}?sub=${encodeURIComponent(s.slug)}`,
                  })),
                },
              ],
            }
          : undefined,
      }));
      const posicao = base.findIndex((i) => i.href === '/categoria');
      base.splice(posicao < 0 ? 1 : posicao + 1, 0, ...abas);
    }
  } catch {
    /* menu estático segue de pé */
  }

  /**
   * A VAGA DE COLEÇÃO DO MENU (dono, 26/08) — o item "Mais Top da Semana"
   * deixou de ser fixo: a retaguarda (/retaguarda/colecoes) decide qual
   * coleção ocupa o lugar dele ("Coleção Resort" com as peças da JOIN da
   * semana). A distinção `null` × lista vazia é de propósito:
   *   · `null`  = backend não respondeu → o item estático fica (menu nunca
   *     depende do backend pra existir — mesma regra do resto do arquivo);
   *   · `[]`    = o dono tirou todas do menu → o item sai, porque foi escolha.
   */
  try {
    const colecoes = await fetchColecoesMenu();
    if (colecoes) {
      const vaga = base.findIndex((i) => i.href === '/mais-top-da-semana');
      if (vaga >= 0) {
        base.splice(
          vaga,
          1,
          ...colecoes.map((c) => ({ label: c.nome, href: c.href, icon: 'Flame' })),
        );
      }
    }
  } catch {
    /* menu estático segue de pé */
  }

  return base;
}
