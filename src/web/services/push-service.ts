/**
 * Web Push サービス
 *
 * VAPID鍵の生成・管理とPush通知の送信を提供する。
 * 鍵は data/vapid-keys.json に永続化し、購読情報はSQLiteに保存する。
 */
import webpush from 'web-push'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getDb } from '../../db/index.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('push-service')

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const VAPID_KEYS_PATH = join(projectRoot, 'data', 'vapid-keys.json')

interface VapidKeys {
  publicKey: string
  privateKey: string
  subject: string
}

let vapidKeys: VapidKeys | null = null
let initialized = false

// ── Push購読の型 ─────────────────────────────────────────────

export interface PushSubscriptionRecord {
  id: number
  endpoint: string
  keysP256dh: string
  keysAuth: string
  createdAt: string
}

// ── VAPID鍵の初期化 ─────────────────────────────────────────

/**
 * VAPID鍵を初期化する。
 * - data/vapid-keys.json が存在すれば読み込み
 * - 存在しなければ新規生成して保存
 */
export function initWebPush(): void {
  if (initialized) return

  try {
    if (existsSync(VAPID_KEYS_PATH)) {
      const raw = readFileSync(VAPID_KEYS_PATH, 'utf-8')
      vapidKeys = JSON.parse(raw) as VapidKeys
      log.info('Loaded existing VAPID keys')
    } else {
      const generated = webpush.generateVAPIDKeys()
      vapidKeys = {
        publicKey: generated.publicKey,
        privateKey: generated.privateKey,
        subject: 'https://teruyamac-mini.tail65878f.ts.net',
      }
      // data/ ディレクトリがなければ作成
      const dataDir = dirname(VAPID_KEYS_PATH)
      if (!existsSync(dataDir)) {
        mkdirSync(dataDir, { recursive: true })
      }
      writeFileSync(VAPID_KEYS_PATH, JSON.stringify(vapidKeys, null, 2), 'utf-8')
      log.info('Generated and saved new VAPID keys')
    }

    webpush.setVapidDetails(
      vapidKeys.subject,
      vapidKeys.publicKey,
      vapidKeys.privateKey,
    )
    initialized = true
  } catch (e) {
    log.error(`Failed to initialize Web Push: ${e}`)
  }
}

/** VAPID公開鍵を返す */
export function getVapidPublicKey(): string {
  if (!vapidKeys) {
    initWebPush()
  }
  return vapidKeys?.publicKey ?? ''
}

// ── 購読管理 ─────────────────────────────────────────────────

/** Push購読を保存 */
export function saveSubscription(subscription: {
  endpoint: string
  keys: { p256dh: string; auth: string }
}): void {
  const db = getDb()
  const ts = new Date().toISOString()

  db.prepare(`
    INSERT INTO push_subscriptions (endpoint, keys_p256dh, keys_auth, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET
      keys_p256dh = excluded.keys_p256dh,
      keys_auth = excluded.keys_auth
  `).run(subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, ts)

  log.info(`Push subscription saved: ${subscription.endpoint.slice(0, 60)}...`)
}

/** Push購読を削除 */
export function removeSubscription(endpoint: string): void {
  const db = getDb()
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint)
  log.info(`Push subscription removed: ${endpoint.slice(0, 60)}...`)
}

/** 全購読を取得 */
export function getAllSubscriptions(): PushSubscriptionRecord[] {
  const db = getDb()
  const rows = db.prepare('SELECT * FROM push_subscriptions ORDER BY created_at')
    .all() as Array<Record<string, unknown>>
  return rows.map((row) => ({
    id: row.id as number,
    endpoint: row.endpoint as string,
    keysP256dh: row.keys_p256dh as string,
    keysAuth: row.keys_auth as string,
    createdAt: row.created_at as string,
  }))
}

// ── Push通知送信 ─────────────────────────────────────────────

/**
 * 全購読者にPush通知を送信する。
 * 期限切れの購読は自動的に削除する。
 */
export async function sendPushNotification(
  title: string,
  body: string,
  data?: Record<string, unknown>,
): Promise<void> {
  if (!initialized) {
    initWebPush()
  }
  if (!vapidKeys) {
    log.warn('VAPID keys not available, skipping push notification')
    return
  }

  const subscriptions = getAllSubscriptions()
  if (subscriptions.length === 0) return

  const payload = JSON.stringify({ title, body, data })

  const results = await Promise.allSettled(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: {
              p256dh: sub.keysP256dh,
              auth: sub.keysAuth,
            },
          },
          payload,
          { TTL: 60 * 60 }, // 1時間
        )
      } catch (e) {
        const err = e as { statusCode?: number }
        // 410 Gone = 購読期限切れ → 自動削除
        if (err.statusCode === 410 || err.statusCode === 404) {
          removeSubscription(sub.endpoint)
          log.info(`Removed expired subscription: ${sub.endpoint.slice(0, 60)}...`)
        } else {
          throw e
        }
      }
    }),
  )

  const failed = results.filter((r) => r.status === 'rejected')
  if (failed.length > 0) {
    log.warn(`Push notification: ${results.length - failed.length}/${results.length} succeeded`)
  }
}
