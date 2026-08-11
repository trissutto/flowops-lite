import { api } from '@/lib/api';
import { navigation } from '@/data/navigation';
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
 * SEM CACHE nas páginas de categoria (dono, 10/08/2026: "elimine este cache").
 *
 * O mecanismo que derrubava o cache ao gravar (`/api/revalidar`) existe desde
 * 07/08 e **nunca funcionou em produção**: `REVALIDATE_SECRET` não está
 * configurada em nenhum dos dois lados, e sem ela o backend desiste em silêncio
 * e a rota do site responde 503. Resultado: TODA edição de retaguarda esperava
 * a hora inteira. O dono subiu as fotos das 12 categorias, abriu o site, viu as
 * antigas e concluiu que não tinha salvo — as fotos estavam gravadas.
 *
 * Enquanto o segredo não existe, o cache é uma promessa de velocidade paga com
 * a confiança de quem edita. Então:
 *
 *   · PÁGINAS DE CATEGORIA (`/categoria` e `/categoria/<slug>`) — a vitrine que
 *     ele edita e confere: FRESCO SEMPRE. É o que ele abre pra ver se pegou.
 *   · HOME: 60s. Ela é a página mais visitada e já carrega banner e vitrine
 *     junto; um minuto é invisível pra quem edita e não abre mão do estático
 *     justamente onde o tráfego está.
 *
 * A consulta é barata (16 linhas com contagem), não a grade de produtos — que
 * segue com o cache dela.
 *
 * Ligando o `REVALIDATE_SECRET` nos dois lados, dá pra voltar tudo pra 3600 —
 * aí o cache volta a ser velocidade de graça, que era a intenção original.
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
  return navigation.map((item) =>
    item.href === '/categoria' ? { ...item, menu: undefined } : item,
  );
}
