/**
 * Web Push APIルート
 *
 * VAPID公開鍵の取得、Push購読の登録・解除を提供する。
 */
import { Hono } from 'hono'
import {
  getVapidPublicKey,
  saveSubscription,
  removeSubscription,
} from '../services/push-service.js'

const pushRoutes = new Hono()

// GET /api/push/vapid-public-key — VAPID公開鍵取得
pushRoutes.get('/vapid-public-key', (c) => {
  const publicKey = getVapidPublicKey()
  if (!publicKey) {
    return c.json({ error: 'VAPID keys not initialized' }, 500)
  }
  return c.json({ publicKey })
})

// POST /api/push/subscribe — Push購読登録
pushRoutes.post('/subscribe', async (c) => {
  const body = await c.req.json<{
    endpoint: string
    keys: { p256dh: string; auth: string }
  }>()

  if (!body.endpoint || !body.keys?.p256dh || !body.keys?.auth) {
    return c.json({ error: 'Invalid subscription: endpoint and keys required' }, 400)
  }

  saveSubscription({
    endpoint: body.endpoint,
    keys: { p256dh: body.keys.p256dh, auth: body.keys.auth },
  })

  return c.json({ ok: true })
})

// POST /api/push/unsubscribe — Push購読解除
pushRoutes.post('/unsubscribe', async (c) => {
  const body = await c.req.json<{ endpoint: string }>()

  if (!body.endpoint) {
    return c.json({ error: 'endpoint is required' }, 400)
  }

  removeSubscription(body.endpoint)
  return c.json({ ok: true })
})

export default pushRoutes
