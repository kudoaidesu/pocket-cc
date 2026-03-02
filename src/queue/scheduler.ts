import cron, { type ScheduledTask } from 'node-cron'
import { config } from '../config.js'
import { createLogger } from '../utils/logger.js'
import { dequeue, getStats, updateStatus, markForRetry } from './processor.js'
import { acquireLock, releaseLock } from './rate-limiter.js'

const log = createLogger('scheduler')

const tasks = new Map<string, ScheduledTask>()

export type QueueProcessHandler = (issueNumber: number, repository: string, queueItemId: string) => Promise<void>

let processHandler: QueueProcessHandler | null = null

export function setProcessHandler(handler: QueueProcessHandler): void {
  processHandler = handler
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function processQueue(): Promise<void> {
  if (!acquireLock()) {
    log.warn('Queue processing already in progress. Skipping.')
    return
  }

  try {
    const stats = getStats()
    log.info(`Queue processing started — ${stats.pending} pending items`)

    if (stats.pending === 0) {
      log.info('No pending items. Skipping.')
      return
    }

    const maxBatch = config.queue.maxBatchSize
    const cooldownMs = config.queue.cooldownMs
    let processed = 0

    let item = dequeue()
    while (item && processed < maxBatch) {
      log.info(`Processing Issue #${item.issueNumber} (${item.id}) [${processed + 1}/${maxBatch}]`)

      if (processHandler) {
        try {
          await processHandler(item.issueNumber, item.repository, item.id)
          updateStatus(item.id, 'completed')
          log.info(`Issue #${item.issueNumber} completed`)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          const willRetry = markForRetry(item.id, message)
          if (willRetry) {
            log.warn(`Issue #${item.issueNumber} failed, scheduled for retry: ${message}`)
          } else {
            log.error(`Issue #${item.issueNumber} failed permanently: ${message}`)
          }
        }
      } else {
        log.warn('No process handler registered. Skipping item.')
        updateStatus(item.id, 'pending')
        break
      }

      processed++

      // Cooldown: 次のジョブ前に待機
      item = dequeue()
      if (item && processed < maxBatch) {
        log.info(`Cooldown: waiting ${cooldownMs / 1000}s before next job...`)
        await sleep(cooldownMs)
      }
    }

    const after = getStats()
    log.info(
      `Queue processing done — processed: ${processed}, completed: ${after.completed}, failed: ${after.failed}`,
    )
  } finally {
    releaseLock()
  }
}

export function startScheduler(): void {
  const processTask = cron.schedule(
    config.cron.schedule,
    () => {
      void processQueue()
    },
    { timezone: 'Asia/Tokyo' },
  )
  tasks.set('queue-process', processTask)
  log.info(`Queue processing scheduled: ${config.cron.schedule}`)
}

export function stopScheduler(): void {
  for (const [name, task] of tasks) {
    task.stop()
    log.info(`Stopped cron: ${name}`)
  }
}

export function getScheduledTasks(): { name: string; schedule: string }[] {
  return [
    { name: 'queue-process', schedule: config.cron.schedule },
  ]
}

export async function runNow(): Promise<void> {
  log.info('Manual queue processing triggered')
  await processQueue()
}

// --- 即時処理 ---

export type ImmediateResult =
  | { status: 'started' }
  | { status: 'locked'; reason: string }
  | { status: 'no_handler' }

export async function processImmediate(
  issueNumber: number,
  repository: string,
): Promise<ImmediateResult> {
  log.info(`Immediate processing requested for Issue #${issueNumber} (${repository})`)

  if (!processHandler) {
    log.warn('No process handler registered for immediate processing')
    return { status: 'no_handler' }
  }

  if (!acquireLock()) {
    log.warn('Lock held. Cannot process immediately — will fall back to queue.')
    return { status: 'locked', reason: '別のタスクが処理中です' }
  }

  // Fire-and-forget: ロック取得後に即座に return し、処理はバックグラウンドで実行
  const queueItemId = `immediate-${issueNumber}-${Date.now()}`

  void (async () => {
    try {
      await processHandler!(issueNumber, repository, queueItemId)
      log.info(`Immediate processing completed for Issue #${issueNumber}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error(`Immediate processing failed for Issue #${issueNumber}: ${message}`)
    } finally {
      releaseLock()
    }
  })()

  return { status: 'started' }
}
