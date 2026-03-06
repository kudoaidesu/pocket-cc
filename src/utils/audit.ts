/**
 * 監査ログ — SQLite 永続化
 *
 * INSERT はO(1)、読み取りはインデックス付きで末尾N件のみ取得可能。
 */
import { getDb } from '../db/index.js'

export interface AuditEntry {
  timestamp: string
  action: string
  actor: string
  detail: string
  result: 'allow' | 'block' | 'error'
}

export function appendAudit(entry: Omit<AuditEntry, 'timestamp'>): void {
  const db = getDb()
  db.prepare(`
    INSERT INTO audit (timestamp, action, actor, detail, result)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    new Date().toISOString(),
    entry.action,
    entry.actor,
    entry.detail,
    entry.result,
  )
}

export function getAuditLog(limit = 100): AuditEntry[] {
  const db = getDb()
  const rows = db.prepare(`
    SELECT timestamp, action, actor, detail, result
    FROM audit ORDER BY id DESC LIMIT ?
  `).all(limit) as AuditEntry[]

  // 昇順に戻す（古い順）
  return rows.reverse()
}
