/**
 * 通知APIルート
 *
 * 未読通知の取得、既読マーク、SSEストリーミングを提供する。
 */
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import {
  fetchUnread,
  markRead,
  markAllRead,
  registerSSEClient,
  unregisterSSEClient,
} from '../services/notification-service.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('web:notifications')

const notificationRoutes = new Hono()

// GET /api/notifications — 未読通知一覧
notificationRoutes.get('/', (c) => {
  const notifications = fetchUnread()
  return c.json({ items: notifications })
})

// POST /api/notifications/:id/read — 既読マーク
notificationRoutes.post('/:id/read', (c) => {
  const id = parseInt(c.req.param('id'), 10)
  if (isNaN(id)) {
    return c.json({ error: 'Invalid notification ID' }, 400)
  }
  markRead(id)
  return c.json({ ok: true })
})

// POST /api/notifications/read-all — 全既読
notificationRoutes.post('/read-all', (c) => {
  markAllRead()
  return c.json({ ok: true })
})

// GET /api/notifications/stream — SSE通知ストリーム
notificationRoutes.get('/stream', (c) => {
  const clientId = `sse-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  return streamSSE(c, async (stream) => {
    // クライアント登録
    registerSSEClient(clientId, (data: string) => {
      stream.writeSSE({ event: 'notification', data }).catch(() => {
        // クライアント切断 — unregister で後始末
      })
    })

    log.info(`SSE notification stream started: ${clientId}`)

    // keep-alive を30秒ごとに送信
    const keepAliveInterval = setInterval(() => {
      stream.writeSSE({ event: 'heartbeat', data: '' }).catch(() => {
        clearInterval(keepAliveInterval)
      })
    }, 30_000)

    // 接続維持（クライアントが切断するまでブロック）
    try {
      // stream.sleep は Hono SSE の接続維持メカニズム
      // 長時間維持するため、24時間を上限とする
      await stream.sleep(24 * 60 * 60 * 1000)
    } catch {
      // クライアント切断
    } finally {
      clearInterval(keepAliveInterval)
      unregisterSSEClient(clientId)
      log.info(`SSE notification stream ended: ${clientId}`)
    }
  })
})

export default notificationRoutes
