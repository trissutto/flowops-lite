import 'server-only';
import { api } from '@/lib/api';
import { instagramPosts as estaticos } from '@/data/content';
import type { InstagramPost } from '@/types';

/**
 * FEED DO INSTAGRAM — os posts de verdade da @lurdsplussize.
 *
 * A grade da home mostrava foto de banco de imagem: bonita, e de outra marca.
 * Prova social só vale sendo a de verdade — a cliente reconhece o feed da
 * loja, e não reconhece um catálogo genérico.
 *
 * O backend cuida do cache e do limite de requisição (a mesma cota da Graph
 * API que a live usa pra mandar DM — ver `InstagramFeedService`). Aqui é só
 * mais uma camada de ISR pra nem sair da Vercel a cada visita.
 *
 * **Cai na grade estática** quando a integração não está configurada ou o
 * Instagram falha: seção sem foto é pior que seção com foto genérica, e home
 * quebrada é pior que as duas.
 */

interface PostApi {
  id: string;
  imagem: string;
  permalink: string;
  video: boolean;
  alt: string;
}

export async function getInstagram(limite = 6): Promise<InstagramPost[]> {
  try {
    const posts = await api<PostApi[]>(`/public/loja/instagram?limite=${limite}`, {
      /**
       * 5 min, não 1 hora (10/08/2026).
       *
       * O backend JÁ segura 30 min em memória (`InstagramFeedService`), então
       * o custo real disto não é chamar o Instagram — é chamar o backend, que
       * responde do cache dele. Guardar mais uma hora POR CIMA disso não
       * economiza cota da Meta: só atrasa o que já está pronto.
       *
       * E atrasa no pior momento. O token da Meta venceu e ficou 3 meses
       * quebrado; quando foi trocado, a API já devolvia os 6 posts e a home
       * continuou mostrando a grade estática — o dono concluiu, de novo, que
       * não tinha funcionado. Quem acabou de consertar precisa VER consertado.
       */
      revalidate: 300,
      tags: ['instagram'],
      timeoutMs: 8000,
    });
    if (!Array.isArray(posts) || !posts.length) return estaticos.slice(0, limite);
    return posts.map((p) => ({
      id: p.id,
      image: { src: p.imagem, alt: p.alt },
      permalink: p.permalink,
      isVideo: p.video,
    }));
  } catch {
    return estaticos.slice(0, limite);
  }
}
