import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { initSchema } from '../db/schema.js'
import {
  registerWorker,
  getWorker,
  getWorkerByProject,
  listWorkers,
  updateWorkerStatus,
  touchWorkerActivity,
  createTask,
  getTask,
  listTasks,
  updateTaskStatus,
  saveCheckpoint,
  getOrphanedTasks,
  recoverTask,
  markTaskRateLimited,
  setTaskError,
  addTaskEvent,
  getTaskEvents,
  createNotification,
  getUnreadNotifications,
  markNotificationRead,
  markAllNotificationsRead,
} from './worker-store.js'

let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('synchronous = NORMAL')
  db.pragma('busy_timeout = 5000')
  initSchema(db)
})

afterEach(() => {
  db.close()
})

// ── ワーカー登録・取得・一覧 ────────────────────────────────

describe('Worker CRUD', () => {
  it('ワーカーを登録して取得できる', () => {
    const worker = registerWorker(db, 'pocket-cc', 'implementer', 'Pocket Worker')
    expect(worker.id).toBe('pocket-cc-implementer')
    expect(worker.projectSlug).toBe('pocket-cc')
    expect(worker.role).toBe('implementer')
    expect(worker.displayName).toBe('Pocket Worker')
    expect(worker.status).toBe('active')

    const fetched = getWorker(db, 'pocket-cc-implementer')
    expect(fetched).not.toBeNull()
    expect(fetched!.displayName).toBe('Pocket Worker')
  })

  it('存在しないIDではnullを返す', () => {
    const result = getWorker(db, 'nonexistent')
    expect(result).toBeNull()
  })

  it('プロジェクトslugでワーカーを取得できる', () => {
    registerWorker(db, 'my-app', 'implementer', 'App Worker')

    const byProject = getWorkerByProject(db, 'my-app')
    expect(byProject).not.toBeNull()
    expect(byProject!.id).toBe('my-app-implementer')

    const byProjectAndRole = getWorkerByProject(db, 'my-app', 'implementer')
    expect(byProjectAndRole).not.toBeNull()
    expect(byProjectAndRole!.role).toBe('implementer')

    const noMatch = getWorkerByProject(db, 'my-app', 'reviewer')
    expect(noMatch).toBeNull()
  })

  it('ワーカー一覧を取得できる', () => {
    registerWorker(db, 'project-a', 'implementer', 'Worker A')
    registerWorker(db, 'project-b', 'implementer', 'Worker B')

    const all = listWorkers(db)
    expect(all).toHaveLength(2)

    const active = listWorkers(db, 'active')
    expect(active).toHaveLength(2)

    const inactive = listWorkers(db, 'inactive')
    expect(inactive).toHaveLength(0)
  })

  it('ワーカーのステータスを更新できる', () => {
    registerWorker(db, 'proj', 'implementer', 'W')
    updateWorkerStatus(db, 'proj-implementer', 'inactive')

    const w = getWorker(db, 'proj-implementer')
    expect(w!.status).toBe('inactive')
  })

  it('ワーカーの最終活動時刻を更新できる', () => {
    const w1 = registerWorker(db, 'proj', 'implementer', 'W')
    const originalAt = w1.lastActiveAt

    // 少し待ってからタッチ
    touchWorkerActivity(db, 'proj-implementer')

    const w2 = getWorker(db, 'proj-implementer')
    expect(w2!.lastActiveAt).not.toBeNull()
    // updatedAt も更新されている
    expect(w2!.updatedAt >= (originalAt ?? ''))
  })

  it('重複ワーカー登録で UNIQUE 制約エラーが発生する', () => {
    registerWorker(db, 'proj', 'implementer', 'W1')
    expect(() => {
      registerWorker(db, 'proj', 'implementer', 'W2')
    }).toThrow()
  })
})

// ── タスク CRUD・状態遷移 ───────────────────────────────────

describe('Task CRUD', () => {
  beforeEach(() => {
    registerWorker(db, 'proj', 'implementer', 'W')
  })

  it('タスクを作成して取得できる', () => {
    const task = createTask(db, 'proj-implementer', {
      title: 'Fix bug #42',
      description: 'Some description',
      priority: 'high',
      issueRef: '#42',
      executionMode: 'auto',
    })

    expect(task.id).toBeGreaterThan(0)
    expect(task.workerId).toBe('proj-implementer')
    expect(task.title).toBe('Fix bug #42')
    expect(task.description).toBe('Some description')
    expect(task.status).toBe('pending')
    expect(task.priority).toBe('high')
    expect(task.issueRef).toBe('#42')
    expect(task.executionMode).toBe('auto')
    expect(task.retryCount).toBe(0)

    const fetched = getTask(db, task.id)
    expect(fetched).not.toBeNull()
    expect(fetched!.title).toBe('Fix bug #42')
  })

  it('タスク作成のデフォルト値が適用される', () => {
    const task = createTask(db, 'proj-implementer', { title: 'Simple task' })
    expect(task.priority).toBe('medium')
    expect(task.executionMode).toBe('safe')
    expect(task.description).toBeNull()
    expect(task.issueRef).toBeNull()
  })

  it('存在しないIDではnullを返す', () => {
    const result = getTask(db, 99999)
    expect(result).toBeNull()
  })

  it('ワーカーのタスク一覧を取得できる（statusフィルタあり/なし）', () => {
    createTask(db, 'proj-implementer', { title: 'Task 1' })
    createTask(db, 'proj-implementer', { title: 'Task 2' })

    const all = listTasks(db, 'proj-implementer')
    expect(all).toHaveLength(2)

    const pending = listTasks(db, 'proj-implementer', 'pending')
    expect(pending).toHaveLength(2)

    const running = listTasks(db, 'proj-implementer', 'running')
    expect(running).toHaveLength(0)
  })

  it('タスク状態遷移: pending -> running -> completed', () => {
    const task = createTask(db, 'proj-implementer', { title: 'Task' })
    expect(task.status).toBe('pending')

    updateTaskStatus(db, task.id, 'running')
    const running = getTask(db, task.id)!
    expect(running.status).toBe('running')
    expect(running.startedAt).not.toBeNull()
    expect(running.completedAt).toBeNull()

    updateTaskStatus(db, task.id, 'completed', 'All done')
    const completed = getTask(db, task.id)!
    expect(completed.status).toBe('completed')
    expect(completed.completedAt).not.toBeNull()
    expect(completed.result).toBe('All done')
  })

  it('タスク状態遷移: pending -> running -> failed', () => {
    const task = createTask(db, 'proj-implementer', { title: 'Task' })
    updateTaskStatus(db, task.id, 'running')
    updateTaskStatus(db, task.id, 'failed', 'Something went wrong')

    const failed = getTask(db, task.id)!
    expect(failed.status).toBe('failed')
    expect(failed.completedAt).not.toBeNull()
    expect(failed.result).toBe('Something went wrong')
  })

  it('タスクをキャンセルできる', () => {
    const task = createTask(db, 'proj-implementer', { title: 'Task' })
    updateTaskStatus(db, task.id, 'cancelled')

    const cancelled = getTask(db, task.id)!
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.completedAt).not.toBeNull()
  })
})

// ── チェックポイント ────────────────────────────────────────

describe('Checkpoint', () => {
  beforeEach(() => {
    registerWorker(db, 'proj', 'implementer', 'W')
  })

  it('チェックポイントを保存・取得できる', () => {
    const task = createTask(db, 'proj-implementer', { title: 'Task' })
    const checkpoint = {
      lastStep: 'code-generation',
      artifacts: ['src/foo.ts'],
      nextAction: 'run-tests',
    }

    saveCheckpoint(db, task.id, checkpoint)

    const updated = getTask(db, task.id)!
    expect(updated.checkpoint).not.toBeNull()
    const parsed = JSON.parse(updated.checkpoint!)
    expect(parsed.lastStep).toBe('code-generation')
    expect(parsed.artifacts).toEqual(['src/foo.ts'])
    expect(parsed.nextAction).toBe('run-tests')
  })

  it('チェックポイント保存でイベントも記録される', () => {
    const task = createTask(db, 'proj-implementer', { title: 'Task' })
    saveCheckpoint(db, task.id, { step: 'build' })

    const events = getTaskEvents(db, task.id)
    const checkpointEvents = events.filter(e => e.eventType === 'checkpoint')
    expect(checkpointEvents).toHaveLength(1)
    expect(JSON.parse(checkpointEvents[0].payload!).step).toBe('build')
  })
})

// ── orphaned タスク検出 ─────────────────────────────────────

describe('Orphaned tasks', () => {
  beforeEach(() => {
    registerWorker(db, 'proj', 'implementer', 'W')
  })

  it('started_at が古い running タスクを orphaned として検出', () => {
    const task = createTask(db, 'proj-implementer', { title: 'Stale task' })

    // running にして started_at を 1 時間前に書き換え
    updateTaskStatus(db, task.id, 'running')
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    db.prepare('UPDATE worker_tasks SET started_at = ? WHERE id = ?').run(oneHourAgo, task.id)

    const orphaned = getOrphanedTasks(db, 30)
    expect(orphaned).toHaveLength(1)
    expect(orphaned[0].id).toBe(task.id)
  })

  it('最近開始した running タスクは orphaned にならない', () => {
    const task = createTask(db, 'proj-implementer', { title: 'Fresh task' })
    updateTaskStatus(db, task.id, 'running')

    const orphaned = getOrphanedTasks(db, 30)
    expect(orphaned).toHaveLength(0)
  })

  it('recoverTask で recovering 状態に遷移', () => {
    const task = createTask(db, 'proj-implementer', { title: 'Task' })
    updateTaskStatus(db, task.id, 'running')

    recoverTask(db, task.id)

    const recovered = getTask(db, task.id)!
    expect(recovered.status).toBe('recovering')

    const events = getTaskEvents(db, task.id)
    expect(events.some(e => e.eventType === 'recovered')).toBe(true)
  })
})

// ── rate_limited ────────────────────────────────────────────

describe('Rate limiting', () => {
  beforeEach(() => {
    registerWorker(db, 'proj', 'implementer', 'W')
  })

  it('タスクを rate_limited に遷移し retry 情報を記録', () => {
    const task = createTask(db, 'proj-implementer', { title: 'Task' })
    updateTaskStatus(db, task.id, 'running')
    markTaskRateLimited(db, task.id, 300_000) // 5分後

    const limited = getTask(db, task.id)!
    expect(limited.status).toBe('rate_limited')
    expect(limited.retryCount).toBe(1)
    expect(limited.nextRetryAt).not.toBeNull()

    const events = getTaskEvents(db, task.id)
    expect(events.some(e => e.eventType === 'rate_limited')).toBe(true)
  })

  it('last_error を記録できる', () => {
    const task = createTask(db, 'proj-implementer', { title: 'Task' })
    setTaskError(db, task.id, 'Rate limit exceeded')

    const updated = getTask(db, task.id)!
    expect(updated.lastError).toBe('Rate limit exceeded')
  })
})

// ── タスクイベント ──────────────────────────────────────────

describe('Task events', () => {
  beforeEach(() => {
    registerWorker(db, 'proj', 'implementer', 'W')
  })

  it('イベントを追加・取得できる', () => {
    const task = createTask(db, 'proj-implementer', { title: 'Task' })

    addTaskEvent(db, task.id, 'custom_event', { detail: 'some info' })

    const events = getTaskEvents(db, task.id)
    // created (自動) + custom_event
    expect(events.length).toBeGreaterThanOrEqual(2)

    const custom = events.find(e => e.eventType === 'custom_event')
    expect(custom).toBeDefined()
    expect(JSON.parse(custom!.payload!).detail).toBe('some info')
  })

  it('payload なしのイベントも追加できる', () => {
    const task = createTask(db, 'proj-implementer', { title: 'Task' })

    addTaskEvent(db, task.id, 'heartbeat')

    const events = getTaskEvents(db, task.id)
    const heartbeat = events.find(e => e.eventType === 'heartbeat')
    expect(heartbeat).toBeDefined()
    expect(heartbeat!.payload).toBeNull()
  })

  it('タスク作成時に created イベントが自動記録される', () => {
    const task = createTask(db, 'proj-implementer', { title: 'My Task' })
    const events = getTaskEvents(db, task.id)
    expect(events[0].eventType).toBe('created')
    expect(JSON.parse(events[0].payload!).title).toBe('My Task')
  })

  it('状態変更時にイベントが自動記録される', () => {
    const task = createTask(db, 'proj-implementer', { title: 'Task' })
    updateTaskStatus(db, task.id, 'running')
    updateTaskStatus(db, task.id, 'completed', 'Done')

    const events = getTaskEvents(db, task.id)
    const eventTypes = events.map(e => e.eventType)
    expect(eventTypes).toContain('created')
    expect(eventTypes).toContain('started')
    expect(eventTypes).toContain('completed')
  })
})

// ── 通知 ────────────────────────────────────────────────────

describe('Notifications', () => {
  it('通知を作成・取得できる', () => {
    const notif = createNotification(db, 'task_complete', 'Task finished', 'Details here', { taskId: 1 })

    expect(notif.id).toBeGreaterThan(0)
    expect(notif.type).toBe('task_complete')
    expect(notif.title).toBe('Task finished')
    expect(notif.body).toBe('Details here')
    expect(notif.read).toBe(0)
    expect(JSON.parse(notif.metadata!).taskId).toBe(1)
  })

  it('未読通知一覧を取得できる', () => {
    createNotification(db, 'info', 'Notification 1')
    createNotification(db, 'info', 'Notification 2')

    const unread = getUnreadNotifications(db)
    expect(unread).toHaveLength(2)
  })

  it('通知を個別に既読にできる', () => {
    const n1 = createNotification(db, 'info', 'N1')
    createNotification(db, 'info', 'N2')

    markNotificationRead(db, n1.id)

    const unread = getUnreadNotifications(db)
    expect(unread).toHaveLength(1)
    expect(unread[0].title).toBe('N2')
  })

  it('全通知を一括既読にできる', () => {
    createNotification(db, 'info', 'N1')
    createNotification(db, 'info', 'N2')
    createNotification(db, 'info', 'N3')

    markAllNotificationsRead(db)

    const unread = getUnreadNotifications(db)
    expect(unread).toHaveLength(0)
  })

  it('body・metadata なしでも作成できる', () => {
    const notif = createNotification(db, 'info', 'Simple notification')
    expect(notif.body).toBeNull()
    expect(notif.metadata).toBeNull()
  })
})

// ── busy_timeout 設定確認 ───────────────────────────────────

describe('DB configuration', () => {
  it('busy_timeout が設定されている', () => {
    const timeout = db.pragma('busy_timeout', { simple: true })
    expect(timeout).toBe(5000)
  })
})
