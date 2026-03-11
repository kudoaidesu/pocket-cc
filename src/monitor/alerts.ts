/**
 * アラート管理
 *
 * クールダウン制御と Web Push 通知送信を担当する。
 * 同一アラートが解消されるまで 1 時間おきに再通知する。
 */
import { createLogger } from '../utils/logger.js'
import { getDb } from '../db/index.js'
import { createNotification } from '../agents/worker-store.js'
import { initWebPush, sendPushNotification } from '../web/services/push-service.js'
import type { Alert, AlertType } from './types.js'

const log = createLogger('monitor:alerts')

/** クールダウン期間（ミリ秒）— 1時間 */
const COOLDOWN_MS = 60 * 60 * 1000

/** アラートキーごとの最終通知時刻 */
const lastAlertTime = new Map<string, number>()

/** アラートキーを生成する */
function alertKey(type: AlertType, metadata?: Record<string, unknown>): string {
  if (type === 'stuck_process' && metadata?.['pid']) {
    return `${type}:${metadata['pid']}`
  }
  return type
}

/**
 * クールダウン中かどうかを判定する。
 */
function isCoolingDown(type: AlertType, metadata?: Record<string, unknown>): boolean {
  const key = alertKey(type, metadata)
  const lastTime = lastAlertTime.get(key)
  if (!lastTime) return false
  return Date.now() - lastTime < COOLDOWN_MS
}

/**
 * クールダウンタイマーを更新する。
 */
function updateCooldown(type: AlertType, metadata?: Record<string, unknown>): void {
  const key = alertKey(type, metadata)
  lastAlertTime.set(key, Date.now())
}

/**
 * アラートが解消されたらクールダウンをクリアする。
 * 次回検知時に即座に通知が飛ぶようになる。
 */
export function clearAlert(type: AlertType, metadata?: Record<string, unknown>): void {
  const key = alertKey(type, metadata)
  if (lastAlertTime.delete(key)) {
    log.info(`Alert cleared: ${key}`)
  }
}

/** 通知クリック時に開くURLを構築する */
function buildActionUrl(alert: Alert): string {
  const baseUrl = '/'
  // チャットUIにアラート内容をプリセットして開く
  const message = buildActionMessage(alert)
  return `${baseUrl}?alert=${encodeURIComponent(message)}`
}

/** アラートに応じたアクション用メッセージを生成する */
function buildActionMessage(alert: Alert): string {
  switch (alert.type) {
    case 'stuck_process': {
      const pid = alert.metadata['pid'] ?? ''
      const cmd = alert.metadata['command'] ?? ''
      return `PID ${pid} (${cmd}) がstuckしています。killしてください。`
    }
    case 'high_memory':
      return `メモリ使用率が ${alert.metadata['memoryPercent'] ?? ''}% です。状況を確認してください。`
    case 'high_load':
      return `Load Averageが ${alert.metadata['loadAverage'] ?? ''} です。負荷の原因を確認してください。`
    case 'high_temperature':
      return `CPU温度が ${alert.metadata['cpuTemp'] ?? ''}℃ です。負荷の原因を確認してください。`
    default:
      return alert.body
  }
}

/**
 * アラートを送信する。
 *
 * 1. クールダウン判定（1時間）
 * 2. SQLite の notifications テーブルに記録
 * 3. Web Push で全購読者に通知（アクションURL付き）
 */
export async function sendAlert(alert: Alert): Promise<void> {
  if (isCoolingDown(alert.type, alert.metadata)) {
    log.debug(`Alert ${alert.type} is cooling down, skipping`)
    return
  }

  updateCooldown(alert.type, alert.metadata)

  const actionUrl = buildActionUrl(alert)

  // DB に通知を記録
  try {
    const db = getDb()
    createNotification(db, `system_monitor:${alert.type}`, alert.title, alert.body, {
      ...alert.metadata,
      actionUrl,
    })
  } catch (e) {
    log.error(`Failed to create notification record: ${e}`)
  }

  // Web Push 送信（アクションURL付き）
  try {
    initWebPush()
    await sendPushNotification(alert.title, alert.body, {
      type: `system_monitor:${alert.type}`,
      actionUrl,
      ...alert.metadata,
    })
    log.info(`Alert sent: ${alert.type} — ${alert.title}`)
  } catch (e) {
    log.error(`Failed to send push notification: ${e}`)
  }
}

/**
 * テスト用: クールダウンをリセットする
 */
export function resetCooldowns(): void {
  lastAlertTime.clear()
}
