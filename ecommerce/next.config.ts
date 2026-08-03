import type { NextConfig } from 'next';

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
      // R2 da Lurd's — fotos de produto (por cor) e banners da vitrine. O
      // subdomínio padrão é `pub-<id>.r2.dev`; se o bucket for servido por
      // domínio próprio, informe em R2_PUBLIC_HOST na Vercel (sem https://),
      // senão o next/image recusa a URL e o banner some da home.
      { protocol: 'https', hostname: '**.r2.dev' },
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
    return [
      // URL canônica é /lojas.
      { source: '/nossas-lojas', destination: '/lojas', permanent: true },
      { source: '/nossaslojas', destination: '/lojas', permanent: true },

      // TROCA FÁCIL — o portal público de trocas já existe e roda no FlowOps
      // (localiza pedido por nº + CPF, gera reversa, acompanha status). Aqui
      // ele é LINKADO, não recriado: duas telas de troca abertas ao mesmo
      // tempo seria duas políticas divergindo sozinhas. Redirect temporário
      // (307) de propósito — quando a tela for portada pra cá, é só apagar
      // esta linha sem ter deixado 301 gravado no cache dos navegadores.
      {
        source: '/trocas',
        destination: 'https://www.lurdsplussize.com.br/trocas',
        permanent: false,
      },
      { source: '/institucional/trocas', destination: '/trocas', permanent: false },
    ];
  },
};

export default nextConfig;
