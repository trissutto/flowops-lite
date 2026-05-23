// Service Worker mínimo do LURDS ORDER ONE PWA.
//
// Por que existe: Android Chrome SÓ aceita instalação de PWA se houver um
// service worker registrado (mesmo que ele não faça nada útil). Esse SW
// implementa o mínimo: passa todas as requests direto (network-first).
//
// Sprint futuras podem evoluir pra:
//  - Cache offline (vendedora consulta produto sem internet)
//  - Push notification background (pedido novo do site)
//  - Background sync (envia ações pendentes quando voltar online)
//
// Por enquanto é só "pass-through".

self.addEventListener('install', (event) => {
  // skipWaiting() = ativa imediatamente, não espera fechar abas antigas
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // clients.claim() = assume controle das abas abertas já no primeiro load
  event.waitUntil(self.clients.claim());
});

// Fetch handler: passa direto. Sem isso, o browser não considera o SW
// "ativo" (e não habilita install prompt).
self.addEventListener('fetch', (event) => {
  // Só intercepta GETs HTTP/HTTPS (ignora chrome-extension, etc)
  if (event.request.method !== 'GET') return;
  if (!event.request.url.startsWith('http')) return;
  // Network-first: sempre pega da internet (mantém sistema sempre atualizado)
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
