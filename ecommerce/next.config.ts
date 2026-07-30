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
      // TEMPORÁRIO: fotos editoriais royalty-free enquanto o banco de imagens
      // da marca não está pronto. Remover quando as fotos reais entrarem.
      { protocol: 'https', hostname: 'images.unsplash.com' },
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
    ];
  },
};

export default nextConfig;
