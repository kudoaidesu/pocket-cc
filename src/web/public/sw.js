/**
 * Service Worker — Push通知の受信とクリックハンドリング
 */

/* eslint-env serviceworker */

self.addEventListener('push', (event) => {
  const data = event.data?.json() ?? { title: 'pocket-cc', body: 'New notification' }
  const isSystemMonitor = (data.data?.type || '').startsWith('system_monitor:')

  const options = {
    body: data.body,
    icon: '/static/icon-192.png',
    badge: '/static/icon-192.png',
    data: data.data || {},
    tag: `pocket-cc-${data.data?.type || 'general'}`,
    renotify: true,
  }

  // システムモニターアラートにはアクションボタンを追加
  if (isSystemMonitor) {
    options.actions = [
      { action: 'handle', title: '対処する' },
      { action: 'dismiss', title: '閉じる' },
    ]
    options.requireInteraction = true // 自動で消えない
  }

  event.waitUntil(self.registration.showNotification(data.title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const data = event.notification.data || {}
  const actionUrl = data.actionUrl || '/'

  // 「閉じる」アクションの場合は通知を閉じるだけ
  if (event.action === 'dismiss') return

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // 既に開いているウィンドウがあればアラートURLに遷移してフォーカス
      for (const client of clients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.navigate(actionUrl)
          return client.focus()
        }
      }
      // なければ新しいウィンドウを開く
      return self.clients.openWindow(actionUrl)
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
