// Service Worker mínimo do LURDS ORDER ONE PWA.
//
// SW_VERSION: 2026-06-18-face-cache — bump aqui força browsers a baixar
// versão nova. Toda mudança no conteúdo deste arquivo dispara o
// `updatefound` no ServiceWorkerRegister.tsx, que faz reload automático.
// Pra forçar atualização em PWAs instalados, MUDA essa string.

// Cache dedicado pros pesos do reconhecimento facial (face-api models + lib).
// São estáticos e versionados → cache-first deixa a 2ª+ abertura do PONTO
// INSTANTÂNEA (antes baixava ~6-7MB toda vez, em PC fraco de loja).
const FACE_CACHE = 'face-assets-2026-06-18';

function isFaceAsset(url) {
  return (
    url.pathname.startsWith('/face-models/') ||
    url.hostname.includes('cdn.jsdelivr.net') && url.pathname.includes('face-api')
  );
}
//
// Por que existe: Android Chrome SÓ aceita instalação de PWA se houver um
// service worker registrado (mesmo que ele não faça nada útil). Esse SW
// implementa o mínimo: passa todas as requests direto (network-first).

self.addEventListener('install', (event) => {
  // skipWaiting() = ativa imediatamente, não espera fechar abas antigas
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Limpa versões antigas do cache facial (mantém só a atual).
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k.startsWith('face-assets-') && k !== FACE_CACHE)
        .map((k) => caches.delete(k)),
    );
    // clients.claim() = assume controle das abas abertas já no primeiro load
    await self.clients.claim();
  })());
});

// Fetch handler.
self.addEventListener('fetch', (event) => {
  // Só intercepta GETs HTTP/HTTPS (ignora chrome-extension, etc)
  if (event.request.method !== 'GET') return;
  if (!event.request.url.startsWith('http')) return;

  const url = new URL(event.request.url);

  // CACHE-FIRST pros pesos faciais (estáticos/versionados): serve do cache e
  // baixa só no 1º acesso → 2ª+ abertura do PONTO fica instantânea.
  if (isFaceAsset(url)) {
    event.respondWith(
      caches.open(FACE_CACHE).then((cache) =>
        cache.match(event.request).then((hit) => {
          if (hit) return hit;
          return fetch(event.request).then((res) => {
            if (res && res.ok) cache.put(event.request, res.clone());
            return res;
          });
        }),
      ),
    );
    return;
  }

  // Network-first pro resto (mantém o sistema sempre atualizado).
  event.respondWith(fetch(event.request).catch(() => Response.error()));
});

// Push notification handler — quando o backend enviar push (futuro)
self.addEventListener('push', (event) => {
  if (!event.data) return;
  try {
    const data = event.data.json();
    const title = data.title || 'LURDS ORDER ONE';
    const options = {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: data.tag || 'lurds-notification',
      data: data.data || {},
      requireInteraction: data.requireInteraction || false,
    };
    event.waitUntil(self.registration.showNotification(title, options));
  } catch (e) {
    // payload mal-formado, ignora
  }
});

// Quando user clica na notificação, abre a URL relacionada
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Se já tem aba aberta, foca nela e navega
      for (const client of clientList) {
        if ('focus' in client) {
          client.navigate(url).catch(() => {});
          return client.focus();
        }
      }
      // Senão abre nova aba
      if (self.clients.openWindow) {
        return self.clients.openWindow(url);
      }
    }),
  );
});
