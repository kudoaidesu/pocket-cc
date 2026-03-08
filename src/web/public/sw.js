/**
 * Service Worker — Push通知の受信とクリックハンドリング
 */

/* eslint-env serviceworker */

self.addEventListener('push', (event) => {
  const data = event.data?.json() ?? { title: 'pocket-cc', body: 'New notification' }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/static/icon-192.png',
      badge: '/static/icon-192.png',
      data: data.data || {},
      tag: `pocket-cc-${data.data?.type || 'general'}`,
      renotify: true,
    })
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // 既に開いているウィンドウがあればフォーカス
      for (const client of clients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus()
        }
      }
      // なければ新しいウィンドウを開く
      return self.clients.openWindow('/')
    })
  )
})

// Service Worker のインストール → 即座にアクティブ化
self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})
