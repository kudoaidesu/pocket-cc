/**
 * ワーカー永続化レイヤー
 *
 * workers / worker_tasks / task_events / notifications テーブルに対する
 * CRUD + 状態遷移 + イベント記録 + 通知管理を提供する。
 *
 * 全ての書き込み操作で BEGIN IMMEDIATE を使い、WAL モード下の競合を防止する。
 */
import type Database from 'better-sqlite3'
import { createLogger } from '../utils/logger.js'

const log = createLogger('worker-store')

// ── 型定義 ──────────────────────────────────────────────────

export interface Worker {
  id: string
  projectSlug: string
  role: string
  displayName: string
  status: string
  createdAt: string
  updatedAt: string
  lastActiveAt: string | null
}

export interface CreateTaskInput {
  title: string
  description?: string
  priority?: string
  issueRef?: string
  executionMode?: 'safe' | 'auto'
}

export interface WorkerTask {
  id: number
  workerId: string
  title: string
  description: string | null
  status: string
  priority: string
  issueRef: string | null
  prRef: string | null
  result: string | null
  checkpoint: string | null
  retryCount: number
  nextRetryAt: string | null
  lastError: string | null
  executionMode: string
  createdAt: string
  updatedAt: string
  startedAt: string | null
  completedAt: string | null
}

export interface TaskEvent {
  id: number
  taskId: number
  eventType: string
  payload: string | null
  createdAt: string
}

export interface Notification {
  id: number
  type: string
  title: string
  body: string | null
  metadata: string | null
  read: number
  createdAt: string
}

// ── ヘルパー ────────────────────────────────────────────────

function now(): string {
  return new Date().toISOString()
}

/** snake_case の DB 行を camelCase の Worker 型に変換 */
function rowToWorker(row: Record<string, unknown>): Worker {
  return {
    id: row.id as string,
    projectSlug: row.project_slug as string,
    role: row.role as string,
    displayName: row.display_name as string,
    status: row.status as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    lastActiveAt: (row.last_active_at as string | null) ?? null,
  }
}

/** snake_case の DB 行を camelCase の WorkerTask 型に変換 */
function rowToTask(row: Record<string, unknown>): WorkerTask {
  return {
    id: row.id as number,
    workerId: row.worker_id as string,
    title: row.title as string,
    description: (row.description as string | null) ?? null,
    status: row.status as string,
    priority: row.priority as string,
    issueRef: (row.issue_ref as string | null) ?? null,
    prRef: (row.pr_ref as string | null) ?? null,
    result: (row.result as string | null) ?? null,
    checkpoint: (row.checkpoint as string | null) ?? null,
    retryCount: (row.retry_count as number) ?? 0,
    nextRetryAt: (row.next_retry_at as string | null) ?? null,
    lastError: (row.last_error as string | null) ?? null,
    executionMode: (row.execution_mode as string) ?? 'safe',
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    startedAt: (row.started_at as string | null) ?? null,
    completedAt: (row.completed_at as string | null) ?? null,
  }
}

/** snake_case の DB 行を camelCase の TaskEvent 型に変換 */
function rowToEvent(row: Record<string, unknown>): TaskEvent {
  return {
    id: row.id as number,
    taskId: row.task_id as number,
    eventType: row.event_type as string,
    payload: (row.payload as string | null) ?? null,
    createdAt: row.created_at as string,
  }
}

/** snake_case の DB 行を camelCase の Notification 型に変換 */
function rowToNotification(row: Record<string, unknown>): Notification {
  return {
    id: row.id as number,
    type: row.type as string,
    title: row.title as string,
    body: (row.body as string | null) ?? null,
    metadata: (row.metadata as string | null) ?? null,
    read: row.read as number,
    createdAt: row.created_at as string,
  }
}

// ── ワーカー CRUD ───────────────────────────────────────────

/**
 * ワーカーを登録する。project_slug + role の組み合わせが UNIQUE。
 * ID は `{projectSlug}-{role}` の形式で自動生成。
 */
export function registerWorker(
  db: Database.Database,
  projectSlug: string,
  role: string,
  displayName: string,
): Worker {
  const id = `${projectSlug}-${role}`
  const ts = now()

  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(`
      INSERT INTO workers (id, project_slug, role, display_name, status, created_at, updated_at, last_active_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
    `).run(id, projectSlug, role, displayName, ts, ts, ts)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }

  log.info(`Registered worker: ${id} (${displayName})`)

  return {
    id,
    projectSlug,
    role,
    displayName,
    status: 'active',
    createdAt: ts,
    updatedAt: ts,
    lastActiveAt: ts,
  }
}

/** ID でワーカーを取得 */
export function getWorker(db: Database.Database, id: string): Worker | null {
  const row = db.prepare('SELECT * FROM workers WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return row ? rowToWorker(row) : null
}

/** プロジェクト slug（と任意の role）でワーカーを取得 */
export function getWorkerByProject(
  db: Database.Database,
  projectSlug: string,
  role?: string,
): Worker | null {
  if (role) {
    const row = db.prepare('SELECT * FROM workers WHERE project_slug = ? AND role = ?')
      .get(projectSlug, role) as Record<string, unknown> | undefined
    return row ? rowToWorker(row) : null
  }
  const row = db.prepare('SELECT * FROM workers WHERE project_slug = ? LIMIT 1')
    .get(projectSlug) as Record<string, unknown> | undefined
  return row ? rowToWorker(row) : null
}

/** ワーカー一覧（オプションで status フィルタ） */
export function listWorkers(db: Database.Database, status?: string): Worker[] {
  if (status) {
    const rows = db.prepare('SELECT * FROM workers WHERE status = ? ORDER BY created_at')
      .all(status) as Record<string, unknown>[]
    return rows.map(rowToWorker)
  }
  const rows = db.prepare('SELECT * FROM workers ORDER BY created_at')
    .all() as Record<string, unknown>[]
  return rows.map(rowToWorker)
}

/** ワーカーのステータスを更新 */
export function updateWorkerStatus(db: Database.Database, id: string, status: string): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('UPDATE workers SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, now(), id)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

/** ワーカーの最終活動時刻を更新 */
export function touchWorkerActivity(db: Database.Database, id: string): void {
  const ts = now()
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('UPDATE workers SET last_active_at = ?, updated_at = ? WHERE id = ?')
      .run(ts, ts, id)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

// ── タスク CRUD ─────────────────────────────────────────────

/** タスクを作成（pending 状態） */
export function createTask(
  db: Database.Database,
  workerId: string,
  task: CreateTaskInput,
): WorkerTask {
  const ts = now()

  db.exec('BEGIN IMMEDIATE')
  try {
    const info = db.prepare(`
      INSERT INTO worker_tasks (
        worker_id, title, description, status, priority, issue_ref,
        execution_mode, created_at, updated_at
      )
      VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?)
    `).run(
      workerId,
      task.title,
      task.description ?? null,
      task.priority ?? 'medium',
      task.issueRef ?? null,
      task.executionMode ?? 'safe',
      ts,
      ts,
    )
    const taskId = Number(info.lastInsertRowid)

    // created イベントを記録
    db.prepare(`
      INSERT INTO task_events (task_id, event_type, payload, created_at)
      VALUES (?, 'created', ?, ?)
    `).run(taskId, JSON.stringify({ title: task.title }), ts)

    db.exec('COMMIT')

    return getTask(db, taskId)!
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

/** ID でタスクを取得 */
export function getTask(db: Database.Database, id: number): WorkerTask | null {
  const row = db.prepare('SELECT * FROM worker_tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return row ? rowToTask(row) : null
}

/** ワーカーのタスク一覧（オプションで status フィルタ） */
export function listTasks(db: Database.Database, workerId: string, status?: string): WorkerTask[] {
  if (status) {
    const rows = db.prepare('SELECT * FROM worker_tasks WHERE worker_id = ? AND status = ? ORDER BY created_at')
      .all(workerId, status) as Record<string, unknown>[]
    return rows.map(rowToTask)
  }
  const rows = db.prepare('SELECT * FROM worker_tasks WHERE worker_id = ? ORDER BY created_at')
    .all(workerId) as Record<string, unknown>[]
  return rows.map(rowToTask)
}

/** タスクのステータスを更新 */
export function updateTaskStatus(
  db: Database.Database,
  id: number,
  status: string,
  result?: string,
): void {
  const ts = now()

  db.exec('BEGIN IMMEDIATE')
  try {
    const updates: string[] = ['status = ?', 'updated_at = ?']
    const params: unknown[] = [status, ts]

    if (status === 'running') {
      updates.push('started_at = COALESCE(started_at, ?)')
      params.push(ts)
    }
    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      updates.push('completed_at = ?')
      params.push(ts)
    }
    if (result !== undefined) {
      updates.push('result = ?')
      params.push(result)
    }

    params.push(id)
    db.prepare(`UPDATE worker_tasks SET ${updates.join(', ')} WHERE id = ?`).run(...params)

    // ステータス変更イベントを記録
    const eventType = status === 'running' ? 'started' : status
    db.prepare(`
      INSERT INTO task_events (task_id, event_type, payload, created_at)
      VALUES (?, ?, ?, ?)
    `).run(id, eventType, result ? JSON.stringify({ result }) : null, ts)

    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

/** チェックポイントを保存 */
export function saveCheckpoint(db: Database.Database, taskId: number, checkpoint: object): void {
  const ts = now()
  const json = JSON.stringify(checkpoint)

  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('UPDATE worker_tasks SET checkpoint = ?, updated_at = ? WHERE id = ?')
      .run(json, ts, taskId)

    db.prepare(`
      INSERT INTO task_events (task_id, event_type, payload, created_at)
      VALUES (?, 'checkpoint', ?, ?)
    `).run(taskId, json, ts)

    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

/**
 * orphaned タスクを検出する。
 * running 状態で started_at が staleMinutes 分以上前のタスクを返す。
 */
export function getOrphanedTasks(db: Database.Database, staleMinutes = 30): WorkerTask[] {
  const cutoff = new Date(Date.now() - staleMinutes * 60 * 1000).toISOString()
  const rows = db.prepare(`
    SELECT * FROM worker_tasks
    WHERE status = 'running' AND started_at < ?
    ORDER BY started_at
  `).all(cutoff) as Record<string, unknown>[]
  return rows.map(rowToTask)
}

/** orphaned タスクを recovering 状態に遷移 */
export function recoverTask(db: Database.Database, taskId: number): void {
  const ts = now()

  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(`
      UPDATE worker_tasks SET status = 'recovering', updated_at = ? WHERE id = ?
    `).run(ts, taskId)

    db.prepare(`
      INSERT INTO task_events (task_id, event_type, payload, created_at)
      VALUES (?, 'recovered', NULL, ?)
    `).run(taskId, ts)

    db.exec('COMMIT')

    log.info(`Task ${taskId} moved to recovering state`)
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

/**
 * タスクを rate_limited 状態に遷移。
 * retryCount をインクリメントし、nextRetryAt を設定する。
 */
export function markTaskRateLimited(
  db: Database.Database,
  taskId: number,
  retryAfterMs: number,
): void {
  const ts = now()
  const nextRetryAt = new Date(Date.now() + retryAfterMs).toISOString()

  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(`
      UPDATE worker_tasks
      SET status = 'rate_limited',
          retry_count = retry_count + 1,
          next_retry_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(nextRetryAt, ts, taskId)

    db.prepare(`
      INSERT INTO task_events (task_id, event_type, payload, created_at)
      VALUES (?, 'rate_limited', ?, ?)
    `).run(taskId, JSON.stringify({ nextRetryAt, retryAfterMs }), ts)

    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

/**
 * タスクの last_error を記録する
 */
export function setTaskError(db: Database.Database, taskId: number, error: string): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('UPDATE worker_tasks SET last_error = ?, updated_at = ? WHERE id = ?')
      .run(error, now(), taskId)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

// ── タスクイベント ──────────────────────────────────────────

/** タスクイベントを追加 */
export function addTaskEvent(
  db: Database.Database,
  taskId: number,
  eventType: string,
  payload?: object,
): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(`
      INSERT INTO task_events (task_id, event_type, payload, created_at)
      VALUES (?, ?, ?, ?)
    `).run(taskId, eventType, payload ? JSON.stringify(payload) : null, now())
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

/** タスクのイベント一覧を取得 */
export function getTaskEvents(db: Database.Database, taskId: number): TaskEvent[] {
  const rows = db.prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at')
    .all(taskId) as Record<string, unknown>[]
  return rows.map(rowToEvent)
}

// ── 通知 ────────────────────────────────────────────────────

/** 通知を作成 */
export function createNotification(
  db: Database.Database,
  type: string,
  title: string,
  body?: string,
  metadata?: object,
): Notification {
  db.exec('BEGIN IMMEDIATE')
  try {
    const ts = now()
    const info = db.prepare(`
      INSERT INTO notifications (type, title, body, metadata, read, created_at)
      VALUES (?, ?, ?, ?, 0, ?)
    `).run(type, title, body ?? null, metadata ? JSON.stringify(metadata) : null, ts)

    db.exec('COMMIT')

    return {
      id: Number(info.lastInsertRowid),
      type,
      title,
      body: body ?? null,
      metadata: metadata ? JSON.stringify(metadata) : null,
      read: 0,
      createdAt: ts,
    }
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

/** 未読通知を取得（新しい順） */
export function getUnreadNotifications(db: Database.Database): Notification[] {
  const rows = db.prepare('SELECT * FROM notifications WHERE read = 0 ORDER BY created_at DESC')
    .all() as Record<string, unknown>[]
  return rows.map(rowToNotification)
}

/** 通知を既読にする */
export function markNotificationRead(db: Database.Database, id: number): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('UPDATE notifications SET read = 1 WHERE id = ?').run(id)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

/** 全通知を既読にする */
export function markAllNotificationsRead(db: Database.Database): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('UPDATE notifications SET read = 1 WHERE read = 0').run()
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}
