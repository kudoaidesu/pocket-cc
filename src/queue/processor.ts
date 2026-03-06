/**
 * ジョブキュー — SQLite 永続化
 *
 * 全操作がprepared statementによる原子的クエリ。
 * JSON load-all/write-all のアンチパターンを排除。
 */
import { randomUUID } from 'node:crypto'
import { config } from '../config.js'
import { getDb } from '../db/index.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('queue')

export type Priority = 'high' | 'medium' | 'low'
export type QueueStatus = 'pending' | 'processing' | 'completed' | 'failed'

export interface QueueItem {
  id: string
  issueNumber: number
  repository: string
  priority: Priority
  status: QueueStatus
  createdAt: string
  scheduledAt?: string
  completedAt?: string
  error?: string
  retryCount?: number
  maxRetries?: number
  nextRetryAt?: string
}

/** DB行 → QueueItem 変換 */
function rowToItem(row: Record<string, unknown>): QueueItem {
  return {
    id: row.id as string,
    issueNumber: row.issue_number as number,
    repository: row.repository as string,
    priority: row.priority as Priority,
    status: row.status as QueueStatus,
    createdAt: row.created_at as string,
    scheduledAt: (row.scheduled_at as string) || undefined,
    completedAt: (row.completed_at as string) || undefined,
    error: (row.error as string) || undefined,
    retryCount: row.retry_count as number,
    maxRetries: row.max_retries as number,
    nextRetryAt: (row.next_retry_at as string) || undefined,
  }
}

export function enqueue(
  issueNumber: number,
  repository: string,
  priority: Priority = 'medium',
): QueueItem | null {
  const db = getDb()

  // 冪等性チェック: 同一issue+repoがpending/processingなら拒否
  const dup = db.prepare(`
    SELECT id FROM queue
    WHERE issue_number = ? AND repository = ? AND status IN ('pending', 'processing')
    LIMIT 1
  `).get(issueNumber, repository)

  if (dup) {
    log.warn(`Duplicate enqueue rejected: Issue #${issueNumber} (${repository})`)
    return null
  }

  const item: QueueItem = {
    id: randomUUID(),
    issueNumber,
    repository,
    priority,
    status: 'pending',
    createdAt: new Date().toISOString(),
    retryCount: 0,
    maxRetries: config.queue.maxRetries,
  }

  db.prepare(`
    INSERT INTO queue (id, issue_number, repository, priority, status,
      created_at, retry_count, max_retries)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    item.id, item.issueNumber, item.repository, item.priority, item.status,
    item.createdAt, item.retryCount, item.maxRetries,
  )

  log.info(`Enqueued Issue #${issueNumber} (${priority}) → ${item.id}`)
  return item
}

export function dequeue(): QueueItem | null {
  const db = getDb()
  const now = new Date().toISOString()

  // 原子的: SELECT + UPDATE in transaction
  const result = db.transaction(() => {
    const row = db.prepare(`
      SELECT * FROM queue
      WHERE status = 'pending'
        AND (next_retry_at IS NULL OR next_retry_at <= ?)
      ORDER BY
        CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END,
        created_at
      LIMIT 1
    `).get(now) as Record<string, unknown> | undefined

    if (!row) return null

    db.prepare(`
      UPDATE queue SET status = 'processing', next_retry_at = NULL WHERE id = ?
    `).run(row.id)

    return { ...row, status: 'processing', next_retry_at: null }
  })()

  if (!result) return null

  const item = rowToItem(result)
  log.info(`Dequeued Issue #${item.issueNumber} → ${item.id}`)
  return item
}

export function getAll(): QueueItem[] {
  const db = getDb()
  const rows = db.prepare('SELECT * FROM queue ORDER BY created_at DESC').all() as Array<Record<string, unknown>>
  return rows.map(rowToItem)
}

export function getPending(): QueueItem[] {
  const db = getDb()
  const rows = db.prepare('SELECT * FROM queue WHERE status = ?').all('pending') as Array<Record<string, unknown>>
  return rows.map(rowToItem)
}

export function updateStatus(
  id: string,
  status: QueueStatus,
  error?: string,
): void {
  const db = getDb()

  const completedAt = (status === 'completed' || status === 'failed')
    ? new Date().toISOString()
    : null

  const changes = db.prepare(`
    UPDATE queue SET status = ?, completed_at = COALESCE(?, completed_at), error = COALESCE(?, error)
    WHERE id = ?
  `).run(status, completedAt, error ?? null, id)

  if (changes.changes === 0) {
    log.warn(`Queue item not found: ${id}`)
    return
  }
  log.info(`Queue item ${id} → ${status}`)
}

export function removeCompleted(): number {
  const db = getDb()
  const result = db.prepare(`
    DELETE FROM queue WHERE status IN ('completed', 'failed')
  `).run()

  if (result.changes > 0) {
    log.info(`Removed ${result.changes} completed/failed items`)
  }
  return result.changes
}

export function getStats(): {
  pending: number
  processing: number
  completed: number
  failed: number
  total: number
} {
  const db = getDb()
  const rows = db.prepare(`
    SELECT status, COUNT(*) as count FROM queue GROUP BY status
  `).all() as Array<{ status: string; count: number }>

  const stats = { pending: 0, processing: 0, completed: 0, failed: 0, total: 0 }
  for (const row of rows) {
    if (row.status in stats) {
      (stats as Record<string, number>)[row.status] = row.count
    }
    stats.total += row.count
  }
  return stats
}

export function findById(id: string): QueueItem | undefined {
  const db = getDb()
  const row = db.prepare('SELECT * FROM queue WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return row ? rowToItem(row) : undefined
}

export function removeItem(id: string): boolean {
  const db = getDb()
  const result = db.prepare('DELETE FROM queue WHERE id = ?').run(id)
  if (result.changes > 0) {
    log.info(`Queue item removed: ${id}`)
    return true
  }
  return false
}

export function markForRetry(id: string, error: string): boolean {
  const db = getDb()
  const row = db.prepare('SELECT * FROM queue WHERE id = ?').get(id) as Record<string, unknown> | undefined
  if (!row) {
    log.warn(`Queue item not found for retry: ${id}`)
    return false
  }

  const retryCount = (row.retry_count as number) + 1
  const maxRetries = row.max_retries as number

  if (retryCount > maxRetries) {
    log.info(`Queue item ${id} exceeded max retries (${retryCount}/${maxRetries}). Marking failed.`)
    db.prepare(`
      UPDATE queue SET status = 'failed', completed_at = ?, error = ? WHERE id = ?
    `).run(new Date().toISOString(), error, id)
    return false
  }

  // Exponential backoff: retryBaseMs * 2^(retryCount-1), capped at 1 hour
  const backoffMs = Math.min(
    config.queue.retryBaseMs * Math.pow(2, retryCount - 1),
    3600000,
  )
  const nextRetryAt = new Date(Date.now() + backoffMs).toISOString()

  db.prepare(`
    UPDATE queue SET status = 'pending', retry_count = ?, error = ?, next_retry_at = ?
    WHERE id = ?
  `).run(retryCount, error, nextRetryAt, id)

  log.info(
    `Queue item ${id} scheduled for retry ${retryCount}/${maxRetries} at ${nextRetryAt} (backoff: ${backoffMs / 1000}s)`,
  )
  return true
}
