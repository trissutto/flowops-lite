/**
 * Service Worker — App Lurd's Plus Size
 *
 * Estratégias de cache:
 *   - Pre-cache:  shell mínimo do app (logo, ícones, manifest) — funciona offline
 *   - Runtime:    network-first pra dados (API), cache-first pra imagens
 *
 * Push notifications — preparado pra Semana 2 (VAPID já existente no flowops).
 *
 * Atualização: o navegador checa este arquivo no load — se mudou, atualiza tudo.
 */

// IMPORTANTE: bump a cada deploy pra invalidar cache antigo.
// Sem isso, SW antigo serve chunks JS/CSS com hashes que não existem mais,
// e usuária vê tela quebrada (CSS 404). Tem fallback network-first pra
// /_next/static/* logo abaixo que TAMBÉM mitiga isso.
const CACHE_VERSION = 'lurds-v8';
const PRECACHE_URLS = [
  '/',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
  '/images/logo-branco.png',
];

/* ─────────── INSTALL ─────────── */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(PRECACHE_URLS)),
  );
  // Ativa imediatamente sem aguardar todas as abas fecharem
  self.skipWaiting();
});

/* ─────────── ACTIVATE ─────────── */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

/* ─────────── FETCH ─────────── */
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Só GET — POST/PUT vai direto pra rede
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Network-first pra API e Next.js _next/data (sempre fresco)
  if (url.pathname.startsWith('/_next/data') || url.pathname.startsWith('/api')) {
    event.respondWith(networkFirst(request));
    return;
  }

  // CRÍTICO: chunks JS/CSS do Next.js mudam a cada build (hash no nome).
  // Cachear eles aqui causa 404 quando build novo sai e SW ainda referencia
  // chunks antigos. Solução: passar direto pra rede SEMPRE.
  // (Vercel já manda cache-control imutável nos chunks, então o navegador
  // cacheia naturalmente — não precisa do SW.)
  if (url.pathname.startsWith('/_next/static')) {
    event.respondWith(fetch(request));
    return;
  }

  // Cache-first pra ícones, fonts, imagens
  if (
    url.pathname.startsWith('/icons/') ||
    url.pathname.startsWith('/images/') ||
    url.pathname.endsWith('.woff2') ||
    url.pathname.endsWith('.woff')
  ) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // Stale-while-revalidate pra HTML
  if (request.headers.get('accept')?.includes('text/html')) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }
});

async function networkFirst(request) {
  try {
    const fresh = await fetch(request);
    const cache = await caches.open(CACHE_VERSION);
    cache.put(request, fresh.clone());
    return fresh;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response(JSON.stringify({ offline: true }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const fresh = await fetch(request);
  const cache = await caches.open(CACHE_VERSION);
  cache.put(request, fresh.clone());
  return fresh;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(request);
  const fetchPromise = fetch(request)
    .then((fresh) => {
      cache.put(request, fresh.clone());
      return fresh;
    })
    .catch(() => cached);
  return cached || fetchPromise;
}

/* ─────────── PUSH NOTIFICATIONS (Semana 2) ─────────── */
self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload = {};
  try {
    payload = event.data.json();
  } catch {
    payload = { title: "Lurd's Plus Size", body: event.data.text() };
  }

  const title = payload.title || "Lurd's Plus Size";
  const options = {
    body: payload.body || '',
    // ICON: aparece no painel expandido (Android) ou no canto (Desktop).
    // Usa o ícone colorido normal (logo Lurd's preto/dourado).
    icon: payload.icon || '/icons/icon-192.png',
    // BADGE: aparece na status bar do Android — SÓ FORMA (mono).
    // Sem isso, Android mostra um quadrado branco genérico.
    badge: '/icons/badge-72.png',
    image: payload.image,
    data: { url: payload.url || '/' },
    vibrate: [100, 50, 100],
    tag: payload.tag || 'lurds-notification',
    requireInteraction: false,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Se já tem janela aberta, foca ela
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      // Senão abre nova
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    }),
  );
});
