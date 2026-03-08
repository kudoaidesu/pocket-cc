/**
 * ワーカーデーモン
 *
 * 常駐プロセスとして pending タスクをポーリングし、Agent SDK で実行する。
 * 窓口が DB にタスク登録 → デーモンがバックグラウンドで実行 → 完了通知。
 *
 * 起動フロー:
 * 1. worker-registry で workers テーブルを projects.json と同期
 * 2. 孤立タスク（running のまま残ったもの）を recovering に遷移
 * 3. ポーリングループ（デフォルト5秒）で pending タスクを処理
 *
 * グレースフルシャットダウン:
 * - SIGTERM/SIGINT を受けたら進行中タスクを checkpoint 保存して終了
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getDb } from '../db/index.js'
import { syncWorkers } from './worker-registry.js'
import {
  getOrphanedTasks,
  recoverTask,
  updateTaskStatus,
  addTaskEvent,
  saveCheckpoint,
  setTaskError,
  markTaskRateLimited,
  touchWorkerActivity,
} from './worker-store.js'
import type { WorkerTask } from './worker-store.js'
import {
  canAcquireSlot,
  acquireSlot,
  releaseSlot,
} from './concurrency-guard.js'
import { notify } from '../web/services/notification-service.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('worker-daemon')

// ── 定数 ─────────────────────────────────────────────────────

const PROJECT_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..')
const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? '5000')
const CHECKPOINT_INTERVAL_MS = 60_000  // チェックポイント保存間隔（1分）
const STALE_TASK_MINUTES = 30          // orphaned 判定の閾値

// ── SDK ローダー ──────────────────────────────────────────────

interface SdkMessage {
  type: string
  subtype?: string
  session_id?: string
  is_error?: boolean
  result?: string
  num_turns?: number
  total_cost_usd?: number
  errors?: string[]
  message?: {
    role?: string
    content?: Array<{
      type: string
      text?: string
      name?: string
      input?: Record<string, unknown>
    }>
  }
  error?: string
  retry_after_seconds?: number
}

interface SdkModule {
  query: (params: { prompt: string; options?: Record<string, unknown> }) => AsyncIterable<SdkMessage>
}

let _sdk: SdkModule | null = null

async function loadSdk(): Promise<SdkModule> {
  if (_sdk) return _sdk
  // CLAUDECODE 環境変数が query() の多重起動を防ぐため削除する
  delete process.env.CLAUDECODE
  _sdk = await import('@anthropic-ai/claude-agent-sdk') as unknown as SdkModule
  return _sdk
}

// ── アクティブタスク管理 ──────────────────────────────────────

/** 実行中タスクのコンテキスト */
interface RunningTask {
  taskId: number
  slotId: string
  abortController: AbortController
  lastCheckpointAt: number
  partialOutput: string
}

const runningTasks = new Map<number, RunningTask>()

// ── タスク実行 ───────────────────────────────────────────────

/**
 * タスクを Agent SDK で実行する。
 * 完了/失敗に応じて DB を更新し、通知を送信する。
 */
async function executeTask(task: WorkerTask): Promise<void> {
  const db = getDb()

  const model = (() => {
    // task.description に model フィールドがあれば使う（JSON形式）
    try {
      const desc = JSON.parse(task.description ?? '{}') as Record<string, unknown>
      if (typeof desc.model === 'string') return desc.model
    } catch { /* ignore */ }
    return 'claude-sonnet-4-6'
  })()

  // スロット取得
  if (!canAcquireSlot(model)) {
    log.info(`Task ${task.id}: no available slot, skipping`)
    return
  }

  const slotId = acquireSlot(task.workerId, task.id, model)
  if (!slotId) {
    log.warn(`Task ${task.id}: slot acquisition failed`)
    return
  }

  // 実行状態に遷移
  updateTaskStatus(db, task.id, 'running')
  touchWorkerActivity(db, task.workerId)
  addTaskEvent(db, task.id, 'daemon_started', { slotId, model })

  const abort = new AbortController()
  const ctx: RunningTask = {
    taskId: task.id,
    slotId,
    abortController: abort,
    lastCheckpointAt: Date.now(),
    partialOutput: '',
  }
  runningTasks.set(task.id, ctx)

  log.info(`Task ${task.id} started (slot=${slotId}, model=${model})`)

  try {
    const sdk = await loadSdk()

    // プロジェクトの cwd を解決
    const workerCwd = await resolveProjectCwdAsync(task.workerId)

    // prompt を構築
    const prompt = buildPrompt(task)

    // safe モードのツール制限
    const allowedTools = task.executionMode === 'safe'
      ? ['Read', 'Grep', 'Glob', 'WebSearch', 'LS']
      : undefined

    const queryOptions: Record<string, unknown> = {
      cwd: workerCwd,
      model,
      maxTurns: 50,
      permissionMode: task.executionMode === 'safe' ? 'plan' : 'acceptEdits',
      settingSources: ['project', 'user'],
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      abortController: abort,
    }

    if (allowedTools) {
      queryOptions.allowedTools = allowedTools
    }

    let resultText = ''
    let isError = false

    const messages = sdk.query({ prompt, options: queryOptions })

    for await (const msg of messages) {
      if (abort.signal.aborted) break

      // アシスタントメッセージのテキストを収集
      if (msg.type === 'assistant' && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === 'text' && block.text) {
            ctx.partialOutput += block.text
            // task_events に進捗を記録
            addTaskEvent(db, task.id, 'progress', { text: block.text.slice(0, 500) })
          }
        }
      }

      // 結果メッセージ
      if (msg.type === 'result') {
        if (msg.subtype === 'success') {
          resultText = msg.result ?? ctx.partialOutput
          isError = msg.is_error ?? false
        } else {
          // エラーサブタイプ
          resultText = (msg.errors ?? []).join('\n') || 'Task failed'
          isError = true
        }
      }

      // レート制限検出
      if (msg.type === 'assistant' && msg.error === 'rate_limit') {
        const retryAfterMs = (msg.retry_after_seconds ?? 300) * 1000
        log.warn(`Task ${task.id}: rate limited, retry after ${retryAfterMs}ms`)
        markTaskRateLimited(db, task.id, retryAfterMs)

        releaseSlot(slotId)
        runningTasks.delete(task.id)

        notify(
          'rate_limited',
          `タスク rate_limited: ${task.title}`,
          `${retryAfterMs / 1000}秒後に再試行します`,
          { taskId: task.id },
        )
        return
      }

      // 定期チェックポイント
      if (Date.now() - ctx.lastCheckpointAt > CHECKPOINT_INTERVAL_MS) {
        saveCheckpoint(db, task.id, { partialOutput: ctx.partialOutput.slice(-2000) })
        ctx.lastCheckpointAt = Date.now()
        log.debug?.(`Task ${task.id}: checkpoint saved`)
      }
    }

    // 完了処理
    releaseSlot(slotId)
    runningTasks.delete(task.id)

    if (isError || !resultText) {
      const errMsg = resultText || 'タスク実行に失敗しました'
      updateTaskStatus(db, task.id, 'failed', errMsg)
      setTaskError(db, task.id, errMsg)
      log.error(`Task ${task.id} failed: ${errMsg.slice(0, 200)}`)

      notify(
        'task_failed',
        `タスク失敗: ${task.title}`,
        errMsg.slice(0, 200),
        { taskId: task.id },
      )
    } else {
      updateTaskStatus(db, task.id, 'completed', resultText.slice(0, 5000))
      log.info(`Task ${task.id} completed successfully`)

      notify(
        'task_completed',
        `タスク完了: ${task.title}`,
        resultText.slice(0, 200),
        { taskId: task.id },
      )
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    log.error(`Task ${task.id} threw: ${errMsg}`)

    releaseSlot(slotId)
    runningTasks.delete(task.id)

    updateTaskStatus(db, task.id, 'failed', errMsg)
    setTaskError(db, task.id, errMsg)

    notify(
      'task_failed',
      `タスク失敗: ${task.title}`,
      errMsg.slice(0, 200),
      { taskId: task.id },
    )
  }
}

/** プロジェクトの cwd を非同期で解決する（sync import 回避） */
async function resolveProjectCwdAsync(workerId: string): Promise<string> {
  const slug = workerId.replace(/-implementer$|-general$/, '')
  if (slug === '_general') return PROJECT_ROOT

  try {
    const { readFileSync } = await import('node:fs')
    const raw = readFileSync(join(PROJECT_ROOT, 'projects.json'), 'utf-8')
    const projects = JSON.parse(raw) as Array<{ slug: string; localPath: string }>
    const project = projects.find(p => p.slug === slug)
    if (project?.localPath) return project.localPath
  } catch (e) {
    log.warn(`Failed to resolve cwd for workerId=${workerId}: ${e}`)
  }

  return PROJECT_ROOT
}

/** タスクの実行プロンプトを構築する */
function buildPrompt(task: WorkerTask): string {
  const lines: string[] = []

  lines.push(`# タスク: ${task.title}`)
  lines.push('')

  if (task.description) {
    // JSON形式の description の場合は prompt フィールドを優先する
    try {
      const desc = JSON.parse(task.description) as Record<string, unknown>
      if (typeof desc.prompt === 'string') {
        lines.push(desc.prompt)
      } else {
        lines.push(task.description)
      }
    } catch {
      lines.push(task.description)
    }
  }

  if (task.issueRef) {
    lines.push('')
    lines.push(`Issue: ${task.issueRef}`)
  }

  lines.push('')
  lines.push(`実行モード: ${task.executionMode}`)
  lines.push(`優先度: ${task.priority}`)

  return lines.join('\n')
}

// ── ポーリングループ ─────────────────────────────────────────

/** pending タスクを優先度順に取得する */
function fetchPendingTasks(db: ReturnType<typeof getDb>): WorkerTask[] {
  const rows = db.prepare(`
    SELECT * FROM worker_tasks
    WHERE status = 'pending'
      OR (status = 'recovering')
      OR (status = 'rate_limited' AND next_retry_at IS NOT NULL AND next_retry_at <= datetime('now'))
    ORDER BY
      CASE priority
        WHEN 'critical' THEN 0
        WHEN 'high'     THEN 1
        WHEN 'medium'   THEN 2
        WHEN 'low'      THEN 3
        ELSE 4
      END,
      created_at ASC
    LIMIT 10
  `).all() as Array<Record<string, unknown>>

  return rows.map(row => ({
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
  }))
}

let polling = false
let stopRequested = false

/**
 * 1サイクルのポーリング処理。
 * pending タスクを取得し、スロット空きがあれば非同期で実行する。
 */
async function poll(): Promise<void> {
  if (polling) return
  polling = true

  try {
    const db = getDb()
    const pending = fetchPendingTasks(db)

    for (const task of pending) {
      if (stopRequested) break

      // 既に実行中なら skip
      if (runningTasks.has(task.id)) continue

      // スロット空きチェック（モデルを推定）
      const model = resolveModel(task)
      if (!canAcquireSlot(model)) {
        log.debug?.(`No available slot for model=${model}, skipping remaining tasks`)
        break
      }

      // 非同期で実行（await しない → 並行実行）
      executeTask(task).catch(err => {
        log.error(`Unhandled error in executeTask(${task.id}): ${err}`)
      })
    }
  } catch (err) {
    log.error(`Poll error: ${err}`)
  } finally {
    polling = false
  }
}

/** タスクの description から使用モデルを推定する */
function resolveModel(task: WorkerTask): string {
  try {
    const desc = JSON.parse(task.description ?? '{}') as Record<string, unknown>
    if (typeof desc.model === 'string') return desc.model
  } catch { /* ignore */ }
  return 'claude-sonnet-4-6'
}

// ── グレースフルシャットダウン ───────────────────────────────

async function shutdown(signal: string): Promise<void> {
  log.info(`Received ${signal}, shutting down gracefully...`)
  stopRequested = true

  // 実行中タスクに abort シグナルを送り、チェックポイント保存
  const db = getDb()
  for (const [taskId, ctx] of runningTasks) {
    log.info(`Saving checkpoint for task ${taskId}`)
    ctx.abortController.abort()

    try {
      saveCheckpoint(db, taskId, {
        partialOutput: ctx.partialOutput.slice(-2000),
        shutdownAt: new Date().toISOString(),
      })
      updateTaskStatus(db, taskId, 'recovering')
    } catch (e) {
      log.error(`Failed to checkpoint task ${taskId}: ${e}`)
    }

    releaseSlot(ctx.slotId)
  }
  runningTasks.clear()

  log.info('Worker daemon stopped')
  process.exit(0)
}

// ── メインエントリーポイント ──────────────────────────────────

async function main(): Promise<void> {
  // ログディレクトリを確保
  const logsDir = join(PROJECT_ROOT, 'data', 'logs')
  mkdirSync(logsDir, { recursive: true })

  log.info(`Worker daemon starting (poll interval: ${POLL_INTERVAL_MS}ms)`)
  log.info(`Project root: ${PROJECT_ROOT}`)

  // シグナルハンドラー登録
  process.on('SIGTERM', () => { shutdown('SIGTERM').catch(() => process.exit(1)) })
  process.on('SIGINT', () => { shutdown('SIGINT').catch(() => process.exit(1)) })

  const db = getDb()

  // 1. workers テーブルを projects.json と同期
  log.info('Syncing workers from projects.json...')
  syncWorkers(db)
  log.info('Workers synced')

  // 2. 孤立タスクを recovering に遷移
  const orphaned = getOrphanedTasks(db, STALE_TASK_MINUTES)
  if (orphaned.length > 0) {
    log.warn(`Found ${orphaned.length} orphaned task(s), moving to recovering`)
    for (const task of orphaned) {
      recoverTask(db, task.id)
    }
  }

  // 3. ポーリングループ開始
  log.info('Starting poll loop...')

  // 初回は即座に実行
  await poll()

  const timer = setInterval(() => {
    if (stopRequested) {
      clearInterval(timer)
      return
    }
    poll().catch(err => log.error(`Poll error: ${err}`))
  }, POLL_INTERVAL_MS)

  log.info('Worker daemon is running')

  // プロセスをアクティブに維持（interval が GC されないよう）
  // メインの async function が return しても interval が動き続ける
}

main().catch(err => {
  log.error(`Worker daemon startup failed: ${err}`)
  process.exit(1)
})
