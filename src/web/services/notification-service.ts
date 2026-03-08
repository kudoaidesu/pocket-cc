/**
 * 通知サービス
 *
 * worker-store.ts の通知CRUDを使い、通知の配信ロジックを実装する。
 * SSEクライアントへの即時配信 + DB保存 + Web Push 連携を提供。
 */
import { getDb } from '../../db/index.js'
import {
  createNotification,
  getUnreadNotifications,
  markNotificationRead,
  markAllNotificationsRead,
} from '../../agents/worker-store.js'
import type { Notification } from '../../agents/worker-store.js'
import { sendPushNotification } from './push-service.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('notification-service')

// ── SSE クライアント管理 ──────────────────────────────────────

interface SSEClient {
  send: (data: string) => void
}

const sseClients = new Map<string, SSEClient>()

/** SSEクライアントを登録 */
export function registerSSEClient(clientId: string, send: (data: string) => void): void {
  sseClients.set(clientId, { send })
  log.info(`SSE client registered: ${clientId} (total: ${sseClients.size})`)
}

/** SSEクライアントを解除 */
export function unregisterSSEClient(clientId: string): void {
  sseClients.delete(clientId)
  log.info(`SSE client unregistered: ${clientId} (total: ${sseClients.size})`)
}

/** 接続中のSSEクライアント数を返す */
export function getSSEClientCount(): number {
  return sseClients.size
}

/** 全SSEクライアントを解除（テスト用） */
export function clearAllSSEClients(): void {
  sseClients.clear()
}

// ── SSE配信 ──────────────────────────────────────────────────

interface NotificationPayload {
  id?: number
  type: string
  title: string
  body?: string
  metadata?: Record<string, unknown>
  createdAt?: string
}

/** 接続中の全SSEクライアントに即時配信 */
function broadcastToSSE(notification: NotificationPayload): void {
  const data = JSON.stringify(notification)
  for (const [clientId, client] of sseClients) {
    try {
      client.send(data)
    } catch (e) {
      log.warn(`Failed to send to SSE client ${clientId}: ${e}`)
      sseClients.delete(clientId)
    }
  }
}

// ── 通知送信 ─────────────────────────────────────────────────

/**
 * 通知を送信する（SSE + DB保存 + Web Push）
 *
 * - 常にSQLiteに保存
 * - SSE接続中のクライアントに即時配信
 * - Push購読があればWeb Push送信
 */
export function notify(
  type: string,
  title: string,
  body?: string,
  metadata?: Record<string, unknown>,
): Notification {
  const db = getDb()

  // 1. DB保存
  const notification = createNotification(db, type, title, body, metadata)

  // 2. SSE即時配信
  broadcastToSSE({
    id: notification.id,
    type,
    title,
    body: body ?? undefined,
    metadata,
    createdAt: notification.createdAt,
  })

  // 3. Web Push（非同期、エラーは握りつぶさない）
  sendPushNotification(title, body ?? '', { type, id: notification.id, ...metadata })
    .catch((e) => log.warn(`Push notification failed: ${e}`))

  return notification
}

// ── 通知取得・既読 ───────────────────────────────────────────

/** 未読通知を取得 */
export function fetchUnread(): Notification[] {
  const db = getDb()
  return getUnreadNotifications(db)
}

/** 通知を既読にする */
export function markRead(id: number): void {
  const db = getDb()
  markNotificationRead(db, id)
}

/** 全通知を既読にする */
export function markAllRead(): void {
  const db = getDb()
  markAllNotificationsRead(db)
}
