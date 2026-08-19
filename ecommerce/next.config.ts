import type { NextConfig } from 'next';
import { redirectsLegado } from './redirects-legado';

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // Este projeto é irmão do frontend do FlowOps no mesmo repositório; sem isto
  // o Turbopack sobe a raiz até o lockfile do repo e avisa da ambiguidade.
  turbopack: { root: __dirname },

  images: {
    // AVIF primeiro, WebP como fallback — o Next negocia pelo Accept do browser.
    formats: ['image/avif', 'image/webp'],
    // Larguras alinhadas com os `sizes` usados nos cards e heros.
    deviceSizes: [420, 640, 768, 1024, 1280, 1536, 1920, 2400],
    imageSizes: [160, 240, 320, 420, 560, 720],
    minimumCacheTTL: 60 * 60 * 24 * 30,
    remotePatterns: [
      // Fotos REAIS do catálogo — hoje hospedadas no WordPress do site atual
      // (`lurds.com.br/wp-content/uploads/...`). Sem estes hosts o next/image
      // recusa a URL e o produto aparece sem foto nenhuma.
      { protocol: 'https', hostname: 'lurds.com.br' },
      { protocol: 'https', hostname: 'www.lurds.com.br' },
      // TEMPORÁRIO: editoriais royalty-free enquanto o banco de imagens da
      // marca não está pronto. Remover quando as fotos próprias entrarem.
      { protocol: 'https', hostname: 'images.unsplash.com' },
      // CDN do Instagram — as fotos do feed real da @lurdsplussize (grade da
      // home). Sem estes hosts o next/image RECUSA a URL e a seção aparece
      // vazia, mesmo com a integração funcionando: o erro fica no servidor e
      // a tela só não mostra nada. Os dois subdomínios existem porque a Meta
      // alterna entre eles (`scontent-*` por região, `*.fbcdn.net` no geral).
      { protocol: 'https', hostname: '**.cdninstagram.com' },
      { protocol: 'https', hostname: '**.fbcdn.net' },
      // R2 da Lurd's — fotos de produto (por cor) e banners da vitrine. O
      // subdomínio padrão é `pub-<id>.r2.dev`; se o bucket for servido por
      // domínio próprio, informe em R2_PUBLIC_HOST na Vercel (sem https://),
      // senão o next/image recusa a URL e o banner some da home.
      { protocol: 'https', hostname: '**.r2.dev' },
      // Capa do vídeo do YouTube (o slide de vídeo da PDP). Sem este host o
      // next/image RECUSA a URL e o slide vira quadro vazio — o vídeo estaria
      // lá e ninguém veria o ▶.
      { protocol: 'https', hostname: 'i.ytimg.com' },
      ...(process.env.R2_PUBLIC_HOST
        ? [{ protocol: 'https' as const, hostname: process.env.R2_PUBLIC_HOST }]
        : []),
    ],
  },

  experimental: {
    // Tree-shaking dos barrels — corta boa parte do bundle de ícones.
    optimizePackageImports: ['lucide-react', 'framer-motion'],
  },

  async redirects() {
    /** Onde o FlowOps roda — destino de todo caminho que ainda não migrou. */
    const FLOWOPS = process.env.FLOWOPS_PORTAL_URL || 'https://crm.lurdsplussize.com.br';
    /**
     * O DOMÍNIO DA LOJA É lurdsplussize.com.br, NÃO O .vercel.app.
     *
     * Achado do dono em 10/08/2026, navegando: ele abriu o endereço da Vercel e
     * o site inteiro seguiu ali — links internos são relativos, então uma vez
     * dentro do domínio errado nunca se sai dele.
     *
     * Isso não é cosmético. O mesmo site em dois endereços é conteúdo
     * duplicado pro Google (as duas versões disputam a mesma busca e nenhuma
     * ganha), e cookie de sessão e carrinho não atravessam de um domínio pro
     * outro: quem entra pelo .vercel.app faz login e perde tudo ao clicar num
     * link que aponte pro domínio de verdade.
     *
     * `has: host` casa SÓ o alias de produção. Os endereços de preview
     * (`lurds-ecommerce-git-<branch>.vercel.app`) seguem intactos, senão testar
     * uma branch viraria um pulo pra produção.
     */
    const CANONICO = (process.env.NEXT_PUBLIC_SITE_URL || 'https://www.lurdsplussize.com.br')
      .replace(/\/$/, '');
    return [
      {
        source: '/:caminho*',
        has: [{ type: 'host', value: 'lurds-ecommerce.vercel.app' }],
        destination: `${CANONICO}/:caminho*`,
        permanent: true,
      },

      // URL canônica é /lojas.
      { source: '/nossas-lojas', destination: '/lojas', permanent: true },
      { source: '/nossaslojas', destination: '/lojas', permanent: true },

      // TROCA FÁCIL — a tela agora é DAQUI (10/08/2026), não mais um desvio
      // pro FlowOps. A REGRA continua lá (prazo, reversa grátis, motivos,
      // decisão): o site só desenha, e chama `/public/trocas/*` pra tudo que
      // decide. Duas telas com duas políticas seria duas políticas divergindo
      // sozinhas — por isso a lógica não foi copiada junto.
      //
      // O redirect que existia aqui foi apagado; a rota real vive em
      // `app/(public)/trocas`. Era 307 justamente pra este dia chegar sem
      // ninguém ficar preso num 301 gravado no navegador.
      { source: '/institucional/trocas', destination: '/trocas', permanent: false },

      /**
       * ── PONTE DO www: OS CAMINHOS DE CLIENTE QUE AINDA MORAM NO FLOWOPS ──
       *
       * O `www.lurdsplussize.com.br` era do FlowOps e passou a ser desta loja.
       * Só que o FlowOps não servia ali apenas a landing: servia PÁGINA DE
       * CLIENTE, com link já enviado por WhatsApp e Direct. Sem estas linhas,
       * cada um desses links passaria a cair no 404 da loja no dia da virada —
       * e o pior deles é o de pagamento: a cliente clica pra pagar e não paga.
       *
       * Então o domínio muda hoje e nada quebra: quem chegar por um link
       * antigo é reencaminhado pro FlowOps, onde a tela de fato está.
       *
       * 307 (temporário) em TODAS de propósito. Cada uma dessas telas vai ser
       * reconstruída aqui — trocas e cadastro da live já estão decididos. No
       * dia em que a versão nativa existir, apaga-se a linha e pronto. Com 301
       * o navegador teria gravado o desvio e continuaria pulando pro FlowOps
       * mesmo depois da tela nova existir.
       *
       * ⚠️ NUNCA apontar isto pro próprio domínio desta loja: vira laço
       * infinito e a página morre com ERR_TOO_MANY_REDIRECTS.
       */
      // Pagamento da live — o link que a apresentadora manda pra cliente.
      // `/p/:codigo` é o curto; `/pagar/:id` o longo. Os dois são gerados com
      // domínio fixo em `live-pdv/page.tsx`, então links antigos existem.
      { source: '/p/:codigo', destination: `${FLOWOPS}/p/:codigo`, permanent: false },
      { source: '/pagar/:id', destination: `${FLOWOPS}/pagar/:id`, permanent: false },
      // Comprovante de PIX do crediário.
      { source: '/pix/:id', destination: `${FLOWOPS}/pix/:id`, permanent: false },
      // Acompanhamento de pedido.
      { source: '/meu-pedido', destination: `${FLOWOPS}/meu-pedido`, permanent: false },
      { source: '/meus-pedidos', destination: `${FLOWOPS}/meus-pedidos`, permanent: false },
      // Cadastro da live (a cliente se inscreve pra participar).
      { source: '/cadastro-live', destination: `${FLOWOPS}/cadastro-live`, permanent: false },

      /**
       * ── AS URLs DO SITE ANTIGO (WooCommerce) ──
       *
       * Ficam DEPOIS das regras acima de propósito: o Next usa a primeira que
       * casa, e nenhuma delas pode ser atropelada por uma regra de museu.
       *
       * O mapa inteiro, com o porquê de cada destino, está em
       * `redirects-legado.ts`. Resumo: produto não precisa de regra (o slug do
       * WooCommerce já é o mesmo daqui), categoria precisa de mapa na mão, e
       * `/tree` é uma ponte que o WordPress carregava e agora é nossa.
       */
      ...redirectsLegado,

      /**
       * ── O DOMÍNIO ANTIGO DESTA LOJA, DEPOIS DA VIRADA ──
       *
       * Quando `lurds.com.br` passar a servir esta loja, `lurdsplussize.com.br`
       * vira endereço secundário — e o mesmo site em dois domínios é conteúdo
       * duplicado, com o Google dividindo o sinal entre os dois.
       *
       * Sai por ÚLTIMO na lista porque as regras de caminho acima (pagamento
       * da live, cadastro da live, PIX do crediário) precisam continuar
       * resolvendo em UM pulo, no domínio em que a cliente clicou.
       *
       * ⚠️ LIGADO POR ENV, não por deploy. `VIRADA_LURDS=1` só entra depois que
       * o DNS já aponta pra cá: ligar antes jogaria as clientes num domínio que
       * ainda serve o WordPress. É o interruptor da virada — e desligar volta
       * tudo sem precisar de build.
       */
      ...(process.env.VIRADA_LURDS === '1'
        ? [
            {
              source: '/:caminho*',
              has: [{ type: 'host' as const, value: 'www.lurdsplussize.com.br' }],
              destination: `https://lurds.com.br/:caminho*`,
              permanent: true,
            },
            {
              source: '/:caminho*',
              has: [{ type: 'host' as const, value: 'lurdsplussize.com.br' }],
              destination: `https://lurds.com.br/:caminho*`,
              permanent: true,
            },
          ]
        : []),
    ];
  },

  /**
   * ── AS FOTOS QUE AINDA MORAM NO WORDPRESS ──
   *
   * 49 produtos ainda servem imagem de `lurds.com.br/wp-content/uploads/...`
   * (medido no feed do Meta em 19/08/2026: 673 no R2, 49 aqui). Enquanto o
   * domínio servia o WordPress isso funcionava sozinho. No segundo em que o
   * DNS apontar pra Vercel, essas URLs passariam a bater aqui — e a peça
   * ficaria sem foto no site E no catálogo de anúncio ao mesmo tempo.
   *
   * `rewrite` e não `redirect`: a URL continua sendo `lurds.com.br/wp-content/...`
   * pra quem olha de fora, então o que o Google Imagens tem indexado segue
   * valendo.
   *
   * ⚠️ O DESTINO É `www.lurds.com.br`, E ISSO NÃO É DESCUIDO.
   *
   * O servidor do WordPress faz vhost POR NOME: provado na origem
   * (172.234.18.137) em 19/08/2026 — com `Host: lurds.com.br` ou
   * `Host: www.lurds.com.br` a foto vem em 200; com qualquer outro nome ele
   * devolve o 404 do vhost padrão. Um subdomínio novo (`legado.`) só
   * funcionaria com override de cabeçalho Host, que na Cloudflare é recurso
   * de plano Enterprise, ou com alias no cPanel.
   *
   * Por isso a virada move SÓ O APEX pra Vercel e deixa o `www` apontando pro
   * WordPress: ele continua fazendo o 301 de www pro apex que já fazia (ou
   * seja, página nenhuma fica presa no site velho), e os arquivos estáticos de
   * `/wp-content` continuam sendo servidos direto pelo Apache, sem passar por
   * redirect.
   *
   * É rede de segurança com prazo: quando as 49 fotos estiverem no R2, o `www`
   * vai pra Vercel junto e este bloco inteiro sai.
   */
  async rewrites() {
    const LEGADO = process.env.WP_LEGADO_URL || 'https://www.lurds.com.br';
    return [
      { source: '/wp-content/:caminho*', destination: `${LEGADO}/wp-content/:caminho*` },
    ];
  },
};

export default nextConfig;
