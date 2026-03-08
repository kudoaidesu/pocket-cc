import { describe, it, expect, beforeEach } from 'vitest'
import {
  canAcquireSlot,
  acquireSlot,
  releaseSlot,
  getActiveSlots,
  getSlotUsage,
  handleRateLimit,
  isRateLimited,
  getRateLimitResetTime,
  _resetForTest,
} from './concurrency-guard.js'

beforeEach(() => {
  _resetForTest()
})

// ── スロット取得・解放 ────────────────────────────────────

describe('Slot acquisition and release', () => {
  it('スロットを取得して解放できる', () => {
    const slotId = acquireSlot('worker-1', 1, 'sonnet')
    expect(slotId).not.toBeNull()
    expect(getActiveSlots()).toHaveLength(1)

    releaseSlot(slotId!)
    expect(getActiveSlots()).toHaveLength(0)
  })

  it('取得したスロットに正しい情報が格納される', () => {
    acquireSlot('worker-1', 42, 'opus')

    const slots = getActiveSlots()
    expect(slots).toHaveLength(1)
    expect(slots[0].workerId).toBe('worker-1')
    expect(slots[0].taskId).toBe(42)
    expect(slots[0].model).toBe('opus')
    expect(slots[0].startedAt).toBeTruthy()
  })

  it('存在しない slotId の解放は無視される', () => {
    acquireSlot('worker-1', 1, 'sonnet')
    releaseSlot('nonexistent-slot')
    expect(getActiveSlots()).toHaveLength(1)
  })

  it('canAcquireSlot はスロット空きがあれば true を返す', () => {
    expect(canAcquireSlot('sonnet')).toBe(true)
  })
})

// ── 最大3セッション制限 ─────────────────────────────────────

describe('Max 3 sessions limit', () => {
  it('3セッション目まで取得できる', () => {
    const s1 = acquireSlot('w1', 1, 'sonnet')
    const s2 = acquireSlot('w2', 2, 'haiku')
    const s3 = acquireSlot('w3', 3, 'sonnet')

    expect(s1).not.toBeNull()
    expect(s2).not.toBeNull()
    expect(s3).not.toBeNull()
    expect(getActiveSlots()).toHaveLength(3)
  })

  it('4セッション目は取得できない', () => {
    acquireSlot('w1', 1, 'sonnet')
    acquireSlot('w2', 2, 'haiku')
    acquireSlot('w3', 3, 'sonnet')

    expect(canAcquireSlot('sonnet')).toBe(false)
    const s4 = acquireSlot('w4', 4, 'sonnet')
    expect(s4).toBeNull()
    expect(getActiveSlots()).toHaveLength(3)
  })

  it('解放後は再度取得できる', () => {
    const s1 = acquireSlot('w1', 1, 'sonnet')
    acquireSlot('w2', 2, 'sonnet')
    acquireSlot('w3', 3, 'sonnet')

    expect(canAcquireSlot('sonnet')).toBe(false)

    releaseSlot(s1!)
    expect(canAcquireSlot('sonnet')).toBe(true)

    const s4 = acquireSlot('w4', 4, 'sonnet')
    expect(s4).not.toBeNull()
  })
})

// ── Opus最大1制限 ───────────────────────────────────────────

describe('Opus max 1 session limit', () => {
  it('Opus は 1 セッションまで取得できる', () => {
    const s1 = acquireSlot('w1', 1, 'opus')
    expect(s1).not.toBeNull()
    expect(canAcquireSlot('opus')).toBe(false)

    const s2 = acquireSlot('w2', 2, 'opus')
    expect(s2).toBeNull()
  })

  it('Opus が 1 つあっても sonnet/haiku は取得できる', () => {
    acquireSlot('w1', 1, 'opus')

    expect(canAcquireSlot('sonnet')).toBe(true)
    expect(canAcquireSlot('haiku')).toBe(true)

    const s2 = acquireSlot('w2', 2, 'sonnet')
    expect(s2).not.toBeNull()
  })

  it('Opus 解放後は再取得できる', () => {
    const s1 = acquireSlot('w1', 1, 'opus')
    releaseSlot(s1!)

    const s2 = acquireSlot('w2', 2, 'opus')
    expect(s2).not.toBeNull()
  })
})

// ── レート制限 ─────────────────────────────────────────────

describe('Rate limiting', () => {
  it('レート制限時は全スロット取得が停止する', () => {
    const s1 = acquireSlot('w1', 1, 'sonnet')
    handleRateLimit(s1!, 300)

    expect(isRateLimited()).toBe(true)
    expect(canAcquireSlot('sonnet')).toBe(false)
    expect(canAcquireSlot('opus')).toBe(false)
    expect(canAcquireSlot('haiku')).toBe(false)

    const s2 = acquireSlot('w2', 2, 'sonnet')
    expect(s2).toBeNull()
  })

  it('レート制限のリセット時刻を取得できる', () => {
    const s1 = acquireSlot('w1', 1, 'sonnet')
    handleRateLimit(s1!, 60)

    const resetTime = getRateLimitResetTime()
    expect(resetTime).not.toBeNull()
    expect(resetTime!.getTime()).toBeGreaterThan(Date.now())
  })

  it('制限なしの場合リセット時刻は null', () => {
    expect(getRateLimitResetTime()).toBeNull()
  })

  it('リセット時刻を過ぎると自動解除される', () => {
    const s1 = acquireSlot('w1', 1, 'sonnet')
    // retryAfterSeconds を -1 にすることで即座に期限切れにする
    handleRateLimit(s1!, -1)

    expect(isRateLimited()).toBe(false)
    expect(canAcquireSlot('sonnet')).toBe(true)
  })
})

// ── スロット使用状況 ───────────────────────────────────────

describe('Slot usage', () => {
  it('使用状況を正しく返す', () => {
    const usage0 = getSlotUsage()
    expect(usage0.total).toBe(0)
    expect(usage0.opus).toBe(0)
    expect(usage0.maxTotal).toBe(3)
    expect(usage0.maxOpus).toBe(1)

    acquireSlot('w1', 1, 'opus')
    acquireSlot('w2', 2, 'sonnet')

    const usage2 = getSlotUsage()
    expect(usage2.total).toBe(2)
    expect(usage2.opus).toBe(1)
  })

  it('解放後に使用状況が更新される', () => {
    const s1 = acquireSlot('w1', 1, 'opus')
    acquireSlot('w2', 2, 'sonnet')

    releaseSlot(s1!)

    const usage = getSlotUsage()
    expect(usage.total).toBe(1)
    expect(usage.opus).toBe(0)
  })
})
