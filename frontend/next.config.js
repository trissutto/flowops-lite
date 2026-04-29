/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',

  // === REORG · F2: redirects 301 ===
  // Bookmarks antigos continuam funcionando depois que a gente mover telas/hubs.
  // Só adicionar aqui DEPOIS que o destination existir (Next valida em build).
  async redirects() {
    return [
      // Hub órfão /gestao não tinha entrada na home. Mantemos /retaguarda
      // (que está sendo renomeado pra "Gestão" só no UI, URL preservada).
      { source: '/gestao', destination: '/retaguarda', permanent: true },
      // Hub órfão /sistema continha cadastros (Lojas/Usuários/Logs) — agora
      // tudo isso vive no novo hub /config.
      { source: '/sistema', destination: '/config', permanent: true },
    ];
  },
};
module.exports = nextConfig;
