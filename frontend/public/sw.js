self.addEventListener('push', event => {
  const data = event.data?.json() || {}
  const title = data.title || '🔔 Asset Dashboard'
  const options = {
    body: data.body || '',
    icon: '/favicon.ico',
    badge: '/favicon.ico',
    tag: 'asset-alert',
    renotify: true
  }
  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  event.waitUntil(clients.matchAll({ type: 'window' }).then(windowClients => {
    for (const client of windowClients) {
      if (client.url.includes('/alerts') && 'focus' in client) return client.focus()
    }
    if (clients.openWindow) return clients.openWindow('/alerts')
  }))
})
