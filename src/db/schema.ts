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
const CURRENT_VERSION = 8

export function initSchema(db: Database.Database): void {
  const version = db.pragma('user_version', { simple: true }) as number

  if (version >= CURRENT_VERSION) return

  log.info(`Migrating database from v${version} to v${CURRENT_VERSION}`)

  db.transaction(() => {
    if (version < 1) migrateV1(db)
    if (version < 2) migrateV2(db)
    if (version < 3) migrateV3(db)
    if (version < 4) migrateV4(db)
    if (version < 5) migrateV5(db)
    if (version < 6) migrateV6(db)
    if (version < 7) migrateV7(db)
    if (version < 8) migrateV8(db)
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

// ── v3: セッションにアーカイブフラグ追加 ────────────────────

function migrateV3(db: Database.Database): void {
  // archived カラムを追加（デフォルト0=非アーカイブ）
  db.exec(`ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`)
  db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_archived ON sessions(archived)')
}

// ── v4: セッションにコスト追跡カラム追加 ─────────────────────

function migrateV4(db: Database.Database): void {
  db.exec(`ALTER TABLE sessions ADD COLUMN total_cost REAL NOT NULL DEFAULT 0`)
  db.exec(`ALTER TABLE sessions ADD COLUMN total_turns INTEGER NOT NULL DEFAULT 0`)
  db.exec(`ALTER TABLE sessions ADD COLUMN total_duration_ms INTEGER NOT NULL DEFAULT 0`)
}

// ── v5: テストマトリクステーブル ──────────────────────────────

function migrateV5(db: Database.Database): void {
  // テスト次元定義（プロジェクトごとに独立）
  db.exec(`
    CREATE TABLE IF NOT EXISTS test_dimensions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      name TEXT NOT NULL,
      display_name TEXT NOT NULL,
      values_json TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(project, name)
    )
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_test_dimensions_project ON test_dimensions(project)')

  // テストレコード（マトリクスの各セル）
  db.exec(`
    CREATE TABLE IF NOT EXISTS test_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      coordinates_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'not_tested',
      confidence INTEGER NOT NULL DEFAULT 0,
      flaky_rate REAL NOT NULL DEFAULT 0,
      pass_count INTEGER NOT NULL DEFAULT 0,
      fail_count INTEGER NOT NULL DEFAULT 0,
      skip_count INTEGER NOT NULL DEFAULT 0,
      total_runs INTEGER NOT NULL DEFAULT 0,
      last_run_at TEXT,
      notes TEXT,
      test_name TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_test_records_project ON test_records(project)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_test_records_status ON test_records(project, status)')

  // テストエビデンス（スクリーンショット・ログ等）
  db.exec(`
    CREATE TABLE IF NOT EXISTS test_evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      record_id INTEGER NOT NULL REFERENCES test_records(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      path TEXT NOT NULL,
      description TEXT,
      created_at TEXT NOT NULL
    )
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_test_evidence_record ON test_evidence(record_id)')
}

// ── v6: ワーカー永続化テーブル ────────────────────────────────

function migrateV6(db: Database.Database): void {
  // ワーカー定義（プロジェクト × 役割）
  db.exec(`
    CREATE TABLE IF NOT EXISTS workers (
      id TEXT PRIMARY KEY,
      project_slug TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'implementer',
      display_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_active_at TEXT,
      UNIQUE(project_slug, role)
    )
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_workers_project ON workers(project_slug)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_workers_status ON workers(status)')

  // ワーカーのタスク
  db.exec(`
    CREATE TABLE IF NOT EXISTS worker_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      worker_id TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      priority TEXT NOT NULL DEFAULT 'medium',
      issue_ref TEXT,
      pr_ref TEXT,
      result TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT
    )
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_worker_tasks_worker ON worker_tasks(worker_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_worker_tasks_status ON worker_tasks(status)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_worker_tasks_priority ON worker_tasks(priority, status)')

  // worker_tasks に新カラムを追加（既存DBの場合は ALTER TABLE で追加）
  const newColumns: Array<{ name: string; definition: string }> = [
    { name: 'checkpoint', definition: 'TEXT' },
    { name: 'retry_count', definition: 'INTEGER NOT NULL DEFAULT 0' },
    { name: 'next_retry_at', definition: 'TEXT' },
    { name: 'last_error', definition: 'TEXT' },
    { name: 'execution_mode', definition: "TEXT NOT NULL DEFAULT 'safe'" },
  ]
  for (const col of newColumns) {
    try {
      db.exec(`ALTER TABLE worker_tasks ADD COLUMN ${col.name} ${col.definition}`)
    } catch (e) {
      // "column already exists" は無視（IF NOT EXISTS がない場合の安全策）
      if (!(e instanceof Error && e.message.includes('duplicate column name'))) {
        throw e
      }
    }
  }

  // タスクイベント
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES worker_tasks(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      payload TEXT,
      created_at TEXT NOT NULL
    )
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id)')

  // 通知
  db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      metadata TEXT,
      read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read, created_at)')
}

// ── v7: Push購読テーブル ──────────────────────────────────────

function migrateV7(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      endpoint TEXT NOT NULL UNIQUE,
      keys_p256dh TEXT NOT NULL,
      keys_auth TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_push_subscriptions_endpoint ON push_subscriptions(endpoint)')
}

// ── v8: テスト履歴テーブル ────────────────────────────────────

function migrateV8(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS test_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      record_id INTEGER NOT NULL REFERENCES test_records(id) ON DELETE CASCADE,
      project TEXT NOT NULL,
      coordinates_json TEXT NOT NULL,
      status TEXT NOT NULL,
      confidence INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      test_name TEXT,
      created_at TEXT NOT NULL
    )
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_test_history_record ON test_history(record_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_test_history_project ON test_history(project)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_test_history_created ON test_history(created_at DESC)')
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
