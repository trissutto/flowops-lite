import { Injectable, Logger } from '@nestjs/common';
import { MetaService } from '../live/meta.service';

/**
 * FEED DO INSTAGRAM PRO SITE — os posts de verdade da @lurdsplussize.
 *
 * A grade "No feed e no seu guarda-roupa" da home mostrava foto de banco de
 * imagem: bonita, e de outra marca. Prova social só vale se for a prova de
 * verdade — a cliente reconhece o próprio feed da loja, e não reconhece um
 * catálogo genérico.
 *
 * ── POR QUE CACHE, E NÃO CHAMADA DIRETA ──
 *
 * A Graph API tem limite de requisição (o `MetaService` já segura em 80/min
 * como margem). Se cada visita à home batesse no Instagram, uma campanha
 * derrubaria a integração inteira — e o `MetaService` é o MESMO que a live usa
 * pra mandar DM e responder comentário. Estourar a cota aqui calaria a live.
 *
 * Então: uma chamada a cada 30 minutos, no máximo, e o resultado fica em
 * memória. Post novo demora até meia hora pra aparecer no site, o que é
 * irrelevante — e a live nunca fica sem cota por causa da vitrine.
 *
 * ── NUNCA DERRUBA A HOME ──
 *
 * Instagram fora do ar, token vencido ou conta não configurada devolvem lista
 * VAZIA, não erro. O site cai na grade estática, que é o comportamento de
 * hoje. Uma seção a menos é chata; a home quebrada é outra coisa.
 */
@Injectable()
export class InstagramFeedService {
  private readonly logger = new Logger(InstagramFeedService.name);

  /** 30 min: a cota da Graph API é compartilhada com a live. */
  private static readonly TTL_MS = 30 * 60_000;
  private cache: { at: number; posts: PostInstagram[] } | null = null;
  /** Evita várias buscas simultâneas quando o cache vence sob tráfego. */
  private buscando: Promise<PostInstagram[]> | null = null;

  constructor(private readonly meta: MetaService) {}

  async posts(limite = 6): Promise<PostInstagram[]> {
    const agora = Date.now();
    if (this.cache && agora - this.cache.at < InstagramFeedService.TTL_MS) {
      return this.cache.posts.slice(0, limite);
    }
    if (this.buscando) return (await this.buscando).slice(0, limite);

    this.buscando = this.buscar(limite);
    try {
      const posts = await this.buscando;
      return posts.slice(0, limite);
    } finally {
      this.buscando = null;
    }
  }

  private async buscar(limite: number): Promise<PostInstagram[]> {
    if (!this.meta.isConfigured()) {
      // Sem credencial não é erro: é o site seguindo com a grade estática.
      return this.guardar([]);
    }
    try {
      // Pede mais do que precisa: VIDEO sem thumbnail e CAROUSEL sem capa são
      // descartados abaixo, e sem folga a grade viria com buraco.
      const r: any = await this.meta.getRecentMedia(Math.max(limite * 2, 12));
      if (!r || r.error || !Array.isArray(r.data)) {
        this.logger.warn(`[instagram] feed indisponível: ${r?.error ?? 'resposta inesperada'}`);
        return this.guardar([]);
      }
      const posts: PostInstagram[] = r.data
        .map((m: any) => {
          // Vídeo/reel não tem `media_url` exibível como imagem — a capa é o
          // `thumbnail_url`. Sem este fallback o card viria sem foto.
          const imagem = m.media_type === 'VIDEO' ? m.thumbnail_url : m.media_url;
          if (!imagem || !m.permalink) return null;
          return {
            id: String(m.id),
            imagem: String(imagem),
            permalink: String(m.permalink),
            video: m.media_type === 'VIDEO',
            // Primeira linha da legenda vira o alt — descrição de verdade,
            // escrita por quem publicou, em vez de "post do Instagram".
            alt: primeiraLinha(m.caption) || 'Post da Lurd’s Plus Size no Instagram',
          };
        })
        .filter(Boolean) as PostInstagram[];
      this.logger.log(`[instagram] ${posts.length} posts carregados`);
      return this.guardar(posts);
    } catch (e: any) {
      this.logger.warn(`[instagram] falhou: ${e?.message || e}`);
      return this.guardar([]);
    }
  }

  /**
   * Guarda ATÉ o resultado vazio: sem isso, uma falha faria o site tentar de
   * novo a cada visita, martelando a Graph API justamente quando ela está com
   * problema — e levando a cota da live junto.
   */
  private guardar(posts: PostInstagram[]): PostInstagram[] {
    this.cache = { at: Date.now(), posts };
    return posts;
  }
}

export interface PostInstagram {
  id: string;
  imagem: string;
  permalink: string;
  video: boolean;
  alt: string;
}

function primeiraLinha(caption?: string | null): string {
  const t = String(caption ?? '').split('\n')[0].trim();
  return t.length > 120 ? `${t.slice(0, 117)}…` : t;
}
