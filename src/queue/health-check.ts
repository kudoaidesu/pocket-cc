/**
 * ヘルスチェック — キュー状態の定期監視
 *
 * 毎時実行し、ストール検知・ステータスファイル書き出し・監査ログ記録を行う。
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { getStats, getPending } from './processor.js'
import { isLocked } from './rate-limiter.js'
import { appendAudit } from '../utils/audit.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('health-check')

export interface HealthStatus {
  timestamp: string
  queueStats: { pending: number; processing: number; completed: number; failed: number; total: number }
  isProcessing: boolean
  pendingIssues: Array<{ issueNumber: number; repository: string }>
  allDone: boolean
  stalled: boolean
}

let lastCompletedCount = -1
let lastCheckTime = 0

const STATUS_PATH = resolve(process.cwd(), 'data', 'health-status.json')

export function runHealthCheck(): HealthStatus {
  const stats = getStats()
  const pending = getPending()
  const locked = isLocked()

  // ストール検知: ロック中 & 前回チェックから completed 数が変わっていない
  const stalled = locked && lastCompletedCount === stats.completed && lastCheckTime > 0

  lastCompletedCount = stats.completed
  lastCheckTime = Date.now()

  const status: HealthStatus = {
    timestamp: new Date().toISOString(),
    queueStats: stats,
    isProcessing: locked,
    pendingIssues: pending.map((p) => ({ issueNumber: p.issueNumber, repository: p.repository })),
    allDone: stats.pending === 0 && !locked,
    stalled,
  }

  // ステータスファイル書き出し
  try {
    mkdirSync(dirname(STATUS_PATH), { recursive: true })
    writeFileSync(STATUS_PATH, JSON.stringify(status, null, 2), 'utf-8')
  } catch (e) {
    log.error(`Failed to write health status: ${e}`)
  }

  // 監査ログ
  appendAudit({
    action: 'health_check',
    actor: 'system',
    detail: `pending=${stats.pending} processing=${stats.processing} completed=${stats.completed} failed=${stats.failed} stalled=${stalled}`,
    result: stalled ? 'error' : 'allow',
  })

  if (stalled) {
    log.warn('Processing appears stalled — no progress since last health check')
  } else {
    log.info(`Health OK — pending: ${stats.pending}, processing: ${stats.processing}, completed: ${stats.completed}`)
  }

  return status
}

export function getStatusPath(): string {
  return STATUS_PATH
}
