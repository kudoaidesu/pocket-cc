/**
 * 並行実行制御
 *
 * 同時実行セッション数を制限する。
 * - 全体で最大 MAX_CONCURRENT_SESSIONS セッション
 * - Opus は最大 MAX_OPUS_SESSIONS セッション
 * - レート制限検出時は全スロット停止、retry_after 待ち
 * - スロット取得失敗時はタスクを pending のまま残す（キューイング）
 *
 * インメモリ管理（プロセス内）。永続化は不要。
 */
import { createLogger } from '../utils/logger.js'

const log = createLogger('concurrency-guard')

// ── 定数 ───────────────────────────────────────────────────

const MAX_CONCURRENT_SESSIONS = 3
const MAX_OPUS_SESSIONS = 1

// ── 型定義 ─────────────────────────────────────────────────

export type SessionModel = 'opus' | 'sonnet' | 'haiku'

export interface SessionSlot {
  workerId: string
  taskId: number
  model: SessionModel
  startedAt: string
}

interface RateLimitState {
  limited: boolean
  resetAt: Date | null
}

// ── 内部状態 ───────────────────────────────────────────────

const activeSessions = new Map<string, SessionSlot>()
let slotCounter = 0
const rateLimitState: RateLimitState = {
  limited: false,
  resetAt: null,
}

// ── 公開API ────────────────────────────────────────────────

/**
 * 指定モデルでスロットを取得可能か判定する。
 * レート制限中は常に false を返す。
 */
export function canAcquireSlot(model: string): boolean {
  if (isRateLimited()) return false
  if (activeSessions.size >= MAX_CONCURRENT_SESSIONS) return false
  if (model === 'opus' && countOpusSessions() >= MAX_OPUS_SESSIONS) return false
  return true
}

/**
 * スロットを取得する。取得できない場合は null を返す。
 * 取得成功時は slotId（文字列）を返す。
 */
export function acquireSlot(workerId: string, taskId: number, model: string): string | null {
  const sessionModel = model as SessionModel
  if (!canAcquireSlot(sessionModel)) {
    log.warn(
      `Slot acquisition failed for worker=${workerId} task=${taskId} model=${model} ` +
      `(active=${activeSessions.size}/${MAX_CONCURRENT_SESSIONS}, ` +
      `opus=${countOpusSessions()}/${MAX_OPUS_SESSIONS}, ` +
      `rateLimited=${rateLimitState.limited})`,
    )
    return null
  }

  slotCounter++
  const slotId = `slot-${slotCounter}`
  const slot: SessionSlot = {
    workerId,
    taskId,
    model: sessionModel,
    startedAt: new Date().toISOString(),
  }
  activeSessions.set(slotId, slot)

  log.info(`Slot acquired: ${slotId} (worker=${workerId}, task=${taskId}, model=${model})`)
  return slotId
}

/**
 * スロットを解放する。存在しない slotId は無視する。
 */
export function releaseSlot(slotId: string): void {
  const slot = activeSessions.get(slotId)
  if (slot) {
    activeSessions.delete(slotId)
    log.info(`Slot released: ${slotId} (worker=${slot.workerId}, task=${slot.taskId})`)
  }
}

/** 現在のアクティブスロット一覧を返す */
export function getActiveSlots(): SessionSlot[] {
  return Array.from(activeSessions.values())
}

/** スロット使用状況サマリーを返す */
export function getSlotUsage(): {
  total: number
  opus: number
  maxTotal: number
  maxOpus: number
} {
  return {
    total: activeSessions.size,
    opus: countOpusSessions(),
    maxTotal: MAX_CONCURRENT_SESSIONS,
    maxOpus: MAX_OPUS_SESSIONS,
  }
}

/**
 * レート制限を検出した場合に呼び出す。
 * 全スロットをレート制限状態にし、指定秒数後に解除する。
 */
export function handleRateLimit(slotId: string, retryAfterSeconds?: number): void {
  const waitSeconds = retryAfterSeconds ?? 300 // デフォルト 5分
  rateLimitState.limited = true
  rateLimitState.resetAt = new Date(Date.now() + waitSeconds * 1000)

  log.warn(
    `Rate limit detected on slot ${slotId}. ` +
    `All slots paused until ${rateLimitState.resetAt.toISOString()} ` +
    `(${waitSeconds}s)`,
  )
}

/**
 * 現在レート制限中かどうかを返す。
 * resetAt を過ぎていれば自動的に制限を解除する。
 */
export function isRateLimited(): boolean {
  if (!rateLimitState.limited) return false
  if (rateLimitState.resetAt && new Date() >= rateLimitState.resetAt) {
    rateLimitState.limited = false
    rateLimitState.resetAt = null
    log.info('Rate limit expired, slots resumed')
    return false
  }
  return true
}

/** レート制限のリセット時刻を返す。制限なしの場合は null */
export function getRateLimitResetTime(): Date | null {
  if (!rateLimitState.limited) return null
  return rateLimitState.resetAt
}

// ── テスト用リセット ───────────────────────────────────────

/** 全状態をリセットする（テスト専用） */
export function _resetForTest(): void {
  activeSessions.clear()
  slotCounter = 0
  rateLimitState.limited = false
  rateLimitState.resetAt = null
}

// ── 内部ヘルパー ───────────────────────────────────────────

function countOpusSessions(): number {
  let count = 0
  for (const slot of activeSessions.values()) {
    if (slot.model === 'opus') count++
  }
  return count
}
