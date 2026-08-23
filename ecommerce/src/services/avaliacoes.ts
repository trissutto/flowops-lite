import 'server-only';
import { apiSafe } from '@/lib/api';

/**
 * AVALIAÇÕES DA PEÇA — o resumo que a PDP precisa antes da dobra.
 *
 * A seção completa (`AvaliacoesDaPeca`) já existia e já lia o mesmo endpoint,
 * mas ela mora LÁ EMBAIXO, depois da descrição. O que faltava era a nota no
 * TOPO, ao lado do nome — o `BuyBox` tem o bloco de estrelas escrito desde
 * sempre, atrás de `product.rating`, e `product.rating` NUNCA era preenchido:
 * o catálogo não devolve nota. Código vivo que nunca renderizou.
 *
 * Preenchendo `rating` aqui, três coisas acendem de uma vez sem tocar em mais
 * nada: as estrelas do BuyBox, o `aggregateRating` do JSON-LD (estrelas no
 * Google) e a ordenação "Mais avaliados", que já existe na categoria.
 */

export interface ResumoAvaliacoes {
  total: number;
  media: number;
}

interface RespostaResumo {
  total: number;
  media: number;
}

/**
 * MÍNIMO PRA MOSTRAR NOTA — 3 avaliações.
 *
 * "5,0 · 1 avaliação" é pior que nenhuma nota: a cliente lê como opinião de
 * uma pessoa (que pode ser da casa) e desconta o valor de tudo que está em
 * volta. O Google também trata rich snippet de amostra mínima como sinal
 * fraco. Abaixo disso a seção de baixo continua aparecendo — lá a avaliação é
 * lida como texto de alguém, não como estatística.
 */
export const MINIMO_PRA_NOTA = 3;

/**
 * `true` quando o site está mostrando avaliações de EXEMPLO.
 *
 * ⚠️ EXISTE PRA VER O DESENHO, NÃO PRA PUBLICAR. Avaliação inventada
 * apresentada como de cliente é propaganda enganosa (CDC art. 37) e, quando o
 * Google detecta, derruba o rich snippet do domínio inteiro — não só da peça.
 * Por isso a flag é `NEXT_PUBLIC_` (visível em auditoria), nasce DESLIGADA, e
 * o exemplo é barrado no único lugar onde um número falso viraria promessa
 * pública: o JSON-LD nunca recebe nota de exemplo (ver a PDP).
 */
export const AVALIACOES_DEMO = process.env.NEXT_PUBLIC_AVALIACOES_DEMO === '1';

/**
 * Resumo real da peça. `null` quando não há avaliação suficiente — a PDP
 * simplesmente não mostra nota, que é o comportamento de hoje.
 */
export async function resumoDeAvaliacoes(slug: string): Promise<ResumoAvaliacoes | null> {
  // Catálogo fora do ar não derruba a peça: falha vira ausência de nota.
  const dados = await apiSafe<RespostaResumo>(
    `/public/loja/avaliacoes/${encodeURIComponent(slug)}?limite=1`,
    { total: 0, media: 0 },
    { revalidate: 300 },
  );

  if (!dados.total || dados.total < MINIMO_PRA_NOTA) return null;
  return { total: dados.total, media: dados.media };
}
