/**
 * SQLite スキーマ定義 & マイグレーション
 *
 * PRAGMA user_version でバージョン管理し、起動時に差分マイグレーションを実行する。
 */
import type Database from 'better-sqlite3'
import { readFileSync, renameSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLogger } from '../utils/logger.js'

const log = createLogger('db:schema')
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 現在のスキーマバージョン。マイグレーション追加時にインクリメントする */
const CURRENT_VERSION = 2

export function initSchema(db: Database.Database): void {
  const version = db.pragma('user_version', { simple: true }) as number

  if (version >= CURRENT_VERSION) return

  log.info(`Migrating database from v${version} to v${CURRENT_VERSION}`)

  db.transaction(() => {
    if (version < 1) migrateV1(db)
    if (version < 2) migrateV2(db)
    db.pragma(`user_version = ${CURRENT_VERSION}`)
  })()

  log.info('Database migration complete')

  // JSON → SQLite データ移行（初回のみ）
  migrateJsonData(db)
}

// ── v1: 初期テーブル ──────────────────────────────────────

function migrateV1(db: Database.Database): void {
  // ジョブキュー
  db.exec(`
    CREATE TABLE IF NOT EXISTS queue (
      id TEXT PRIMARY KEY,
      issue_number INTEGER NOT NULL,
      repository TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'medium',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      scheduled_at TEXT,
      completed_at TEXT,
      error TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 2,
      next_retry_at TEXT
    )
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_queue_status ON queue(status)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_queue_priority ON queue(priority, status)')

  // セッションメタデータ
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      key TEXT PRIMARY KEY,
      session_id TEXT NOT NULL UNIQUE,
      project TEXT NOT NULL,
      model TEXT NOT NULL,
      last_used INTEGER NOT NULL,
      message_preview TEXT NOT NULL DEFAULT ''
    )
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_last_used ON sessions(last_used DESC)')

  // セッションサマリー
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_summaries (
      session_id TEXT PRIMARY KEY,
      summary TEXT NOT NULL,
      generated_at INTEGER NOT NULL,
      message_count INTEGER NOT NULL
    )
  `)

  // 監査ログ
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      action TEXT NOT NULL,
      actor TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      result TEXT NOT NULL DEFAULT ''
    )
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit(timestamp DESC)')
}

// ── v2: Strategy 評価テーブル ─────────────────────────────

function migrateV2(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS strategy_evaluations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_number INTEGER NOT NULL,
      repository TEXT NOT NULL,
      strategy TEXT NOT NULL,
      difficulty TEXT,
      success INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER,
      retry_count INTEGER NOT NULL DEFAULT 0,
      lines_added INTEGER,
      lines_removed INTEGER,
      files_changed INTEGER,
      build_pass INTEGER,
      test_pass INTEGER,
      pr_url TEXT,
      pr_merged INTEGER,
      manual_fix_commits INTEGER,
      review_comments INTEGER,
      created_at TEXT NOT NULL
    )
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_eval_strategy ON strategy_evaluations(strategy)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_eval_created ON strategy_evaluations(created_at DESC)')
}

// ── JSON → SQLite データ移行 ──────────────────────────────

function migrateJsonData(db: Database.Database): void {
  const dataDir = join(projectRoot, 'data')

  migrateQueueJson(db, dataDir)
  migrateSessionsJson(db, dataDir)
  migrateSummariesJson(db, dataDir)
  migrateAuditJsonl(db, dataDir)
}

function migrateQueueJson(db: Database.Database, dataDir: string): void {
  const filePath = join(dataDir, 'queue.json')
  if (!existsSync(filePath)) return

  try {
    const raw = readFileSync(filePath, 'utf-8')
    const items = JSON.parse(raw) as Array<Record<string, unknown>>
    if (!Array.isArray(items) || items.length === 0) {
      renameSync(filePath, filePath + '.bak')
      return
    }

    const insert = db.prepare(`
      INSERT OR IGNORE INTO queue (id, issue_number, repository, priority, status,
        created_at, scheduled_at, completed_at, error, retry_count, max_retries, next_retry_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    db.transaction(() => {
      for (const item of items) {
        insert.run(
          item.id, item.issueNumber ?? item.issue_number, item.repository,
          item.priority ?? 'medium', item.status ?? 'pending',
          item.createdAt ?? item.created_at ?? new Date().toISOString(),
          item.scheduledAt ?? item.scheduled_at ?? null,
          item.completedAt ?? item.completed_at ?? null,
          item.error ?? null,
          item.retryCount ?? item.retry_count ?? 0,
          item.maxRetries ?? item.max_retries ?? 2,
          item.nextRetryAt ?? item.next_retry_at ?? null,
        )
      }
    })()

    renameSync(filePath, filePath + '.bak')
    log.info(`Migrated ${items.length} queue items from JSON`)
  } catch (e) {
    log.warn(`Failed to migrate queue.json: ${e}`)
  }
}

function migrateSessionsJson(db: Database.Database, dataDir: string): void {
  const filePath = join(dataDir, 'sessions.json')
  if (!existsSync(filePath)) return

  try {
    const raw = readFileSync(filePath, 'utf-8')
    const entries = JSON.parse(raw) as Array<[string, Record<string, unknown>]>
    if (!Array.isArray(entries) || entries.length === 0) {
      renameSync(filePath, filePath + '.bak')
      return
    }

    const insert = db.prepare(`
      INSERT OR IGNORE INTO sessions (key, session_id, project, model, last_used, message_preview)
      VALUES (?, ?, ?, ?, ?, ?)
    `)

    db.transaction(() => {
      for (const [key, val] of entries) {
        insert.run(
          key,
          val.sessionId ?? val.session_id ?? key,
          val.project ?? '',
          val.model ?? 'haiku',
          val.lastUsed ?? val.last_used ?? Date.now(),
          val.messagePreview ?? val.message_preview ?? '',
        )
      }
    })()

    renameSync(filePath, filePath + '.bak')
    log.info(`Migrated ${entries.length} sessions from JSON`)
  } catch (e) {
    log.warn(`Failed to migrate sessions.json: ${e}`)
  }
}

function migrateSummariesJson(db: Database.Database, dataDir: string): void {
  const filePath = join(dataDir, 'session-summaries.json')
  if (!existsSync(filePath)) return

  try {
    const raw = readFileSync(filePath, 'utf-8')
    const entries = JSON.parse(raw) as Array<[string, Record<string, unknown>]>
    if (!Array.isArray(entries) || entries.length === 0) {
      renameSync(filePath, filePath + '.bak')
      return
    }

    const insert = db.prepare(`
      INSERT OR IGNORE INTO session_summaries (session_id, summary, generated_at, message_count)
      VALUES (?, ?, ?, ?)
    `)

    db.transaction(() => {
      for (const [sessionId, val] of entries) {
        insert.run(
          sessionId,
          val.summary ?? '',
          val.generatedAt ?? val.generated_at ?? Date.now(),
          val.messageCount ?? val.message_count ?? 0,
        )
      }
    })()

    renameSync(filePath, filePath + '.bak')
    log.info(`Migrated ${entries.length} summaries from JSON`)
  } catch (e) {
    log.warn(`Failed to migrate session-summaries.json: ${e}`)
  }
}

function migrateAuditJsonl(db: Database.Database, dataDir: string): void {
  const filePath = join(dataDir, 'audit.jsonl')
  if (!existsSync(filePath)) return

  try {
    const raw = readFileSync(filePath, 'utf-8')
    const lines = raw.split('\n').filter(l => l.trim())
    if (lines.length === 0) {
      renameSync(filePath, filePath + '.bak')
      return
    }

    const insert = db.prepare(`
      INSERT INTO audit (timestamp, action, actor, detail, result)
      VALUES (?, ?, ?, ?, ?)
    `)

    db.transaction(() => {
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as Record<string, unknown>
          insert.run(
            entry.timestamp ?? new Date().toISOString(),
            entry.action ?? '',
            entry.actor ?? 'system',
            typeof entry.detail === 'string' ? entry.detail : JSON.stringify(entry.detail ?? ''),
            entry.result ?? '',
          )
        } catch { /* skip malformed lines */ }
      }
    })()

    renameSync(filePath, filePath + '.bak')
    log.info(`Migrated ${lines.length} audit entries from JSONL`)
  } catch (e) {
    log.warn(`Failed to migrate audit.jsonl: ${e}`)
  }
}
