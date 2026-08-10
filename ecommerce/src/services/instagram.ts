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
      // Uma hora: post novo demora no máximo isso pra aparecer, e a home
      // continua servida do cache no meio tempo.
      revalidate: 3600,
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
