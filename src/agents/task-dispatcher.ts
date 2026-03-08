/**
 * タスクディスパッチャー
 *
 * 窓口からタスクを受けてワーカーに割り振り、並行制御を通す。
 * - スロット空きがあれば即 running にして返す
 * - スロット満杯なら pending のまま queued として返す
 * - タスク完了・失敗時にスロットを解放し、通知を送信する
 * - 保留タスクの再処理機能（processPendingTasks）
 */
import type Database from 'better-sqlite3'
import {
  createTask,
  updateTaskStatus,
  addTaskEvent,
  getTask,
  touchWorkerActivity,
} from './worker-store.js'
import type { WorkerTask } from './worker-store.js'
import { canAcquireSlot, acquireSlot, releaseSlot } from './concurrency-guard.js'
import { resolveWorker } from './worker-registry.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('task-dispatcher')

// ── 型定義 ─────────────────────────────────────────────────

export interface DispatchRequest {
  projectSlug: string        // '_general' for 雑務
  title: string
  description?: string
  issueRef?: string
  priority?: 'low' | 'medium' | 'high' | 'critical'
  executionMode?: 'safe' | 'auto'
  model?: 'opus' | 'sonnet' | 'haiku'
}

export interface DispatchResult {
  taskId: number
  status: 'queued' | 'started'
  slotId: string | null
  message: string
}

// ── slotId ↔ taskId のマッピング ────────────────────────────

const taskSlotMap = new Map<number, string>()

// ── 公開API ────────────────────────────────────────────────

/**
 * タスクをディスパッチする。
 * 1. プロジェクトスラッグからワーカーを解決
 * 2. タスクを DB に作成
 * 3. スロット空きがあれば running に遷移して返す
 * 4. スロット満杯なら pending のまま queued として返す
 */
export function dispatch(
  db: Database.Database,
  request: DispatchRequest,
): DispatchResult {
  const worker = resolveWorker(db, request.projectSlug)
  if (!worker) {
    throw new Error(`Worker not found for project: ${request.projectSlug}`)
  }

  // タスク作成
  const task = createTask(db, worker.id, {
    title: request.title,
    description: request.description,
    priority: request.priority ?? 'medium',
    issueRef: request.issueRef,
    executionMode: request.executionMode ?? 'safe',
  })

  const model = request.model ?? 'sonnet'

  // スロット取得を試行
  if (canAcquireSlot(model)) {
    const slotId = acquireSlot(worker.id, task.id, model)
    if (slotId) {
      updateTaskStatus(db, task.id, 'running')
      touchWorkerActivity(db, worker.id)
      taskSlotMap.set(task.id, slotId)

      addTaskEvent(db, task.id, 'dispatched', {
        model,
        slotId,
        immediate: true,
      })

      log.info(`Task ${task.id} dispatched immediately (slot=${slotId}, model=${model})`)

      return {
        taskId: task.id,
        status: 'started',
        slotId,
        message: `タスク「${request.title}」を開始しました (${worker.displayName})`,
      }
    }
  }

  // スロット取得失敗 → キューイング
  addTaskEvent(db, task.id, 'queued', {
    model,
    reason: 'no_available_slot',
  })

  log.info(`Task ${task.id} queued (no available slot, model=${model})`)

  return {
    taskId: task.id,
    status: 'queued',
    slotId: null,
    message: `タスク「${request.title}」をキューに追加しました (スロット空き待ち)`,
  }
}

/**
 * 保留中 (pending) のタスクを処理する。
 * 優先度順にスロット取得を試行し、空きがあれば running に遷移する。
 * 返り値: 開始したタスクの一覧
 */
export function processPendingTasks(
  db: Database.Database,
  model?: 'opus' | 'sonnet' | 'haiku',
): WorkerTask[] {
  const effectiveModel = model ?? 'sonnet'
  const started: WorkerTask[] = []

  // pending タスクを優先度順に取得
  const rows = db.prepare(`
    SELECT * FROM worker_tasks
    WHERE status = 'pending'
    ORDER BY
      CASE priority
        WHEN 'critical' THEN 0
        WHEN 'high' THEN 1
        WHEN 'medium' THEN 2
        WHEN 'low' THEN 3
        ELSE 4
      END,
      created_at ASC
  `).all() as Record<string, unknown>[]

  for (const row of rows) {
    if (!canAcquireSlot(effectiveModel)) break

    const taskId = row.id as number
    const workerId = row.worker_id as string
    const title = row.title as string

    const slotId = acquireSlot(workerId, taskId, effectiveModel)
    if (slotId) {
      updateTaskStatus(db, taskId, 'running')
      touchWorkerActivity(db, workerId)
      taskSlotMap.set(taskId, slotId)

      addTaskEvent(db, taskId, 'dispatched', {
        model: effectiveModel,
        slotId,
        immediate: false,
      })

      log.info(`Pending task ${taskId} ("${title}") started (slot=${slotId})`)

      const task = getTask(db, taskId)
      if (task) started.push(task)
    }
  }

  return started
}

/**
 * タスクを完了にする。スロットを解放する。
 */
export function completeTask(
  db: Database.Database,
  taskId: number,
  result: string,
): void {
  updateTaskStatus(db, taskId, 'completed', result)

  const slotId = taskSlotMap.get(taskId)
  if (slotId) {
    releaseSlot(slotId)
    taskSlotMap.delete(taskId)
  }

  log.info(`Task ${taskId} completed`)
}

/**
 * タスクを失敗にする。スロットを解放する。
 */
export function failTask(
  db: Database.Database,
  taskId: number,
  error: string,
): void {
  updateTaskStatus(db, taskId, 'failed', error)

  const slotId = taskSlotMap.get(taskId)
  if (slotId) {
    releaseSlot(slotId)
    taskSlotMap.delete(taskId)
  }

  log.info(`Task ${taskId} failed: ${error}`)
}

// ── テスト用リセット ───────────────────────────────────────

/** 全状態をリセットする（テスト専用） */
export function _resetForTest(): void {
  taskSlotMap.clear()
}
