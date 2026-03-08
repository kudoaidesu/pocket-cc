import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { initSchema } from '../db/schema.js'
import { syncFromProjects } from './worker-registry.js'
import {
  dispatch,
  processPendingTasks,
  completeTask,
  failTask,
  _resetForTest as resetDispatcher,
} from './task-dispatcher.js'
import {
  _resetForTest as resetConcurrency,
  acquireSlot,
  releaseSlot,
  getSlotUsage,
} from './concurrency-guard.js'
import { getTask, getTaskEvents, listTasks } from './worker-store.js'

let db: Database.Database

const testProjects = [
  { slug: 'project-a', repo: 'org/project-a', localPath: '/tmp/project-a' },
  { slug: 'project-b', repo: 'org/project-b', localPath: '/tmp/project-b' },
]

beforeEach(() => {
  db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('synchronous = NORMAL')
  db.pragma('busy_timeout = 5000')
  initSchema(db)

  // ワーカーを登録
  syncFromProjects(db, testProjects)

  // 並行制御をリセット
  resetConcurrency()
  resetDispatcher()
})

afterEach(() => {
  db.close()
})

// ── ディスパッチ（スロット空き） ────────────────────────────

describe('Dispatch with available slots', () => {
  it('スロット空きがあればタスクを即座に開始する', () => {
    const result = dispatch(db, {
      projectSlug: 'project-a',
      title: 'Fix bug #42',
      description: 'Fix the login issue',
      priority: 'high',
      model: 'sonnet',
    })

    expect(result.status).toBe('started')
    expect(result.taskId).toBeGreaterThan(0)
    expect(result.slotId).not.toBeNull()
    expect(result.message).toContain('Fix bug #42')
    expect(result.message).toContain('開始')

    // DB 上も running になっている
    const task = getTask(db, result.taskId)
    expect(task).not.toBeNull()
    expect(task!.status).toBe('running')
    expect(task!.startedAt).not.toBeNull()

    // dispatched イベントが記録されている
    const events = getTaskEvents(db, result.taskId)
    const dispatched = events.find(e => e.eventType === 'dispatched')
    expect(dispatched).toBeDefined()
  })

  it('雑務タスクを _general に割り振れる', () => {
    const result = dispatch(db, {
      projectSlug: '_general',
      title: 'Clean up logs',
    })

    expect(result.status).toBe('started')
    const task = getTask(db, result.taskId)
    expect(task!.workerId).toBe('_general-general')
  })

  it('存在しないプロジェクトでエラーを投げる', () => {
    expect(() => {
      dispatch(db, {
        projectSlug: 'nonexistent',
        title: 'Some task',
      })
    }).toThrow('Worker not found')
  })

  it('デフォルト値が正しく適用される', () => {
    const result = dispatch(db, {
      projectSlug: 'project-a',
      title: 'Simple task',
    })

    const task = getTask(db, result.taskId)
    expect(task!.priority).toBe('medium')
    expect(task!.executionMode).toBe('safe')
  })
})

// ── ディスパッチ（スロット満杯） ────────────────────────────

describe('Dispatch with full slots', () => {
  it('スロット満杯時はタスクを queued にする', () => {
    // 3スロットを埋める
    acquireSlot('w1', 100, 'sonnet')
    acquireSlot('w2', 200, 'sonnet')
    acquireSlot('w3', 300, 'sonnet')

    const result = dispatch(db, {
      projectSlug: 'project-a',
      title: 'Queued task',
      model: 'sonnet',
    })

    expect(result.status).toBe('queued')
    expect(result.slotId).toBeNull()
    expect(result.message).toContain('キュー')

    // DB 上は pending のまま
    const task = getTask(db, result.taskId)
    expect(task!.status).toBe('pending')

    // queued イベントが記録されている
    const events = getTaskEvents(db, result.taskId)
    const queued = events.find(e => e.eventType === 'queued')
    expect(queued).toBeDefined()
  })
})

// ── 保留タスクの処理 ────────────────────────────────────────

describe('processPendingTasks', () => {
  it('スロットが空いたら pending タスクを開始する', () => {
    // 3スロットを埋める
    const s1 = acquireSlot('w1', 100, 'sonnet')
    acquireSlot('w2', 200, 'sonnet')
    acquireSlot('w3', 300, 'sonnet')

    // pending タスクを作成
    const result = dispatch(db, {
      projectSlug: 'project-a',
      title: 'Waiting task',
    })
    expect(result.status).toBe('queued')

    // 1スロット解放
    releaseSlot(s1!)

    // pending タスクを処理
    const started = processPendingTasks(db)
    expect(started).toHaveLength(1)
    expect(started[0].id).toBe(result.taskId)
    expect(started[0].status).toBe('running')
  })

  it('優先度順に処理される', () => {
    // 3スロットを埋める
    acquireSlot('w1', 100, 'sonnet')
    acquireSlot('w2', 200, 'sonnet')
    acquireSlot('w3', 300, 'sonnet')

    // 異なる優先度の pending タスクを作成
    const low = dispatch(db, {
      projectSlug: 'project-a',
      title: 'Low priority',
      priority: 'low',
    })
    const critical = dispatch(db, {
      projectSlug: 'project-b',
      title: 'Critical task',
      priority: 'critical',
    })

    expect(low.status).toBe('queued')
    expect(critical.status).toBe('queued')

    // 全スロット解放
    resetConcurrency()

    // pending タスクを処理（1スロットだけ空いている場合をテスト）
    const started = processPendingTasks(db)
    // critical が先に処理される
    expect(started.length).toBeGreaterThanOrEqual(1)
    expect(started[0].title).toBe('Critical task')
  })

  it('スロットが空いていなければ何も起きない', () => {
    acquireSlot('w1', 100, 'sonnet')
    acquireSlot('w2', 200, 'sonnet')
    acquireSlot('w3', 300, 'sonnet')

    dispatch(db, { projectSlug: 'project-a', title: 'Pending' })

    const started = processPendingTasks(db)
    expect(started).toHaveLength(0)
  })
})

// ── タスク完了・失敗 ───────────────────────────────────────

describe('Task completion and failure', () => {
  it('タスクを完了にしてスロットが解放される', () => {
    const result = dispatch(db, {
      projectSlug: 'project-a',
      title: 'Task to complete',
    })
    expect(result.status).toBe('started')

    const usageBefore = getSlotUsage()
    expect(usageBefore.total).toBe(1)

    completeTask(db, result.taskId, 'All done successfully')

    const task = getTask(db, result.taskId)
    expect(task!.status).toBe('completed')
    expect(task!.result).toBe('All done successfully')
    expect(task!.completedAt).not.toBeNull()

    const usageAfter = getSlotUsage()
    expect(usageAfter.total).toBe(0)
  })

  it('タスクを失敗にしてスロットが解放される', () => {
    const result = dispatch(db, {
      projectSlug: 'project-a',
      title: 'Task to fail',
    })
    expect(result.status).toBe('started')

    failTask(db, result.taskId, 'Build failed')

    const task = getTask(db, result.taskId)
    expect(task!.status).toBe('failed')
    expect(task!.result).toBe('Build failed')

    const usageAfter = getSlotUsage()
    expect(usageAfter.total).toBe(0)
  })
})

// ── Opus制限の適用 ──────────────────────────────────────────

describe('Opus session limit', () => {
  it('Opus は 1 セッションまでしか使えない', () => {
    const r1 = dispatch(db, {
      projectSlug: 'project-a',
      title: 'Opus task 1',
      model: 'opus',
    })
    expect(r1.status).toBe('started')

    const r2 = dispatch(db, {
      projectSlug: 'project-b',
      title: 'Opus task 2',
      model: 'opus',
    })
    expect(r2.status).toBe('queued')

    // Opus が 1, 全体も 1
    const usage = getSlotUsage()
    expect(usage.opus).toBe(1)
    expect(usage.total).toBe(1)
  })

  it('Opus 完了後は次の Opus タスクを開始できる', () => {
    const r1 = dispatch(db, {
      projectSlug: 'project-a',
      title: 'Opus task 1',
      model: 'opus',
    })
    expect(r1.status).toBe('started')

    completeTask(db, r1.taskId, 'Done')

    const r2 = dispatch(db, {
      projectSlug: 'project-b',
      title: 'Opus task 2',
      model: 'opus',
    })
    expect(r2.status).toBe('started')
  })
})
