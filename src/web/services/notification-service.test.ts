/**
 * notification-service テスト
 *
 * DB層のCRUD、SSEクライアント管理、通知配信フローを検証する。
 * push-service はモックして Web Push 依存を排除する。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { initSchema } from '../../db/schema.js'

// ── モック設定（動的importの前に定義） ─────────────────────────

// getDb をモック
let testDb: Database.Database
vi.mock('../../db/index.js', () => ({
  getDb: () => testDb,
}))

// push-service をモック
const mockSendPush = vi.fn().mockResolvedValue(undefined)
vi.mock('./push-service.js', () => ({
  sendPushNotification: (...args: unknown[]) => mockSendPush(...args),
}))

// テスト対象を動的import（モック適用後）
const {
  notify,
  fetchUnread,
  markRead,
  markAllRead,
  registerSSEClient,
  unregisterSSEClient,
  getSSEClientCount,
  clearAllSSEClients,
} = await import('./notification-service.js')

// ── テスト ──────────────────────────────────────────────────

beforeEach(() => {
  testDb = new Database(':memory:')
  testDb.pragma('journal_mode = WAL')
  testDb.pragma('foreign_keys = ON')
  testDb.pragma('synchronous = NORMAL')
  testDb.pragma('busy_timeout = 5000')
  initSchema(testDb)
  clearAllSSEClients()
  vi.clearAllMocks()
})

afterEach(() => {
  testDb.close()
})

describe('Notification CRUD', () => {
  it('通知を作成して未読取得できる', () => {
    notify('info', 'Test notification', 'This is a test')
    const unread = fetchUnread()
    expect(unread).toHaveLength(1)
    expect(unread[0].type).toBe('info')
    expect(unread[0].title).toBe('Test notification')
    expect(unread[0].body).toBe('This is a test')
    expect(unread[0].read).toBe(0)
  })

  it('複数の通知を作成できる', () => {
    notify('info', 'First')
    notify('warning', 'Second')
    notify('error', 'Third')
    const unread = fetchUnread()
    expect(unread).toHaveLength(3)
  })

  it('metadata付きの通知を作成できる', () => {
    notify('task_completed', 'Task done', 'PR merged', { taskId: 42, issueRef: '#123' })
    const unread = fetchUnread()
    expect(unread).toHaveLength(1)
    expect(unread[0].metadata).not.toBeNull()
    const meta = JSON.parse(unread[0].metadata!)
    expect(meta.taskId).toBe(42)
    expect(meta.issueRef).toBe('#123')
  })

  it('body省略時はnullになる', () => {
    notify('info', 'Title only')
    const unread = fetchUnread()
    expect(unread[0].body).toBeNull()
  })
})

describe('Mark read', () => {
  it('個別の通知を既読にできる', () => {
    const n1 = notify('info', 'First')
    notify('info', 'Second')
    markRead(n1.id)
    const unread = fetchUnread()
    expect(unread).toHaveLength(1)
    expect(unread[0].title).toBe('Second')
  })

  it('全通知を既読にできる', () => {
    notify('info', 'First')
    notify('info', 'Second')
    notify('info', 'Third')
    markAllRead()
    const unread = fetchUnread()
    expect(unread).toHaveLength(0)
  })

  it('既読済みの通知をもう一度既読にしてもエラーにならない', () => {
    const n = notify('info', 'Test')
    markRead(n.id)
    expect(() => markRead(n.id)).not.toThrow()
  })
})

describe('SSE client management', () => {
  it('クライアントを登録・解除できる', () => {
    const sendFn = vi.fn()
    registerSSEClient('client-1', sendFn)
    expect(getSSEClientCount()).toBe(1)
    unregisterSSEClient('client-1')
    expect(getSSEClientCount()).toBe(0)
  })

  it('複数クライアントを管理できる', () => {
    registerSSEClient('client-1', vi.fn())
    registerSSEClient('client-2', vi.fn())
    registerSSEClient('client-3', vi.fn())
    expect(getSSEClientCount()).toBe(3)
    unregisterSSEClient('client-2')
    expect(getSSEClientCount()).toBe(2)
  })

  it('存在しないクライアントの解除はエラーにならない', () => {
    expect(() => unregisterSSEClient('nonexistent')).not.toThrow()
  })
})

describe('SSE broadcast', () => {
  it('notify時にSSEクライアントにブロードキャストされる', () => {
    const send1 = vi.fn()
    const send2 = vi.fn()
    registerSSEClient('c1', send1)
    registerSSEClient('c2', send2)

    notify('info', 'Broadcast test', 'body text')

    expect(send1).toHaveBeenCalledTimes(1)
    expect(send2).toHaveBeenCalledTimes(1)

    const payload1 = JSON.parse(send1.mock.calls[0][0])
    expect(payload1.type).toBe('info')
    expect(payload1.title).toBe('Broadcast test')
    expect(payload1.body).toBe('body text')

    // cleanup
    unregisterSSEClient('c1')
    unregisterSSEClient('c2')
  })

  it('SSEクライアントがない場合もエラーにならない', () => {
    expect(() => notify('info', 'No clients')).not.toThrow()
  })

  it('送信失敗したクライアントは自動的に除去される', () => {
    const failSend = vi.fn().mockImplementation(() => { throw new Error('Connection closed') })
    registerSSEClient('fail-client', failSend)
    expect(getSSEClientCount()).toBe(1)

    notify('info', 'Test')

    expect(failSend).toHaveBeenCalledTimes(1)
    expect(getSSEClientCount()).toBe(0)
  })
})

describe('Push notification integration', () => {
  it('notify時にsendPushNotificationが呼ばれる', () => {
    notify('task_completed', 'Task finished', 'PR #42 merged')

    expect(mockSendPush).toHaveBeenCalledTimes(1)
    expect(mockSendPush).toHaveBeenCalledWith(
      'Task finished',
      'PR #42 merged',
      expect.objectContaining({ type: 'task_completed' }),
    )
  })

  it('body省略時は空文字でPushが呼ばれる', () => {
    notify('info', 'Title only')
    expect(mockSendPush).toHaveBeenCalledWith(
      'Title only',
      '',
      expect.objectContaining({ type: 'info' }),
    )
  })
})

describe('Notification delivery fallback', () => {
  it('SSE + Push + DB保存が全て実行される', () => {
    const sseSend = vi.fn()
    registerSSEClient('test-client', sseSend)

    const notification = notify('task_completed', 'Done', 'All good')

    // DB保存
    expect(notification.id).toBeGreaterThan(0)
    const unread = fetchUnread()
    expect(unread).toHaveLength(1)

    // SSE配信
    expect(sseSend).toHaveBeenCalledTimes(1)

    // Push通知
    expect(mockSendPush).toHaveBeenCalledTimes(1)

    unregisterSSEClient('test-client')
  })

  it('Push失敗してもDB保存とSSE配信は成功する', () => {
    mockSendPush.mockRejectedValueOnce(new Error('Push failed'))
    const sseSend = vi.fn()
    registerSSEClient('test-client', sseSend)

    const notification = notify('error', 'Error occurred', 'Something broke')

    // DB保存は成功
    expect(notification.id).toBeGreaterThan(0)

    // SSE配信は成功
    expect(sseSend).toHaveBeenCalledTimes(1)

    unregisterSSEClient('test-client')
  })
})
