/**
 * Playwright E2E テスト用モックサーバー
 *
 * 本番フロントエンド (index.html) をそのまま配信し、
 * /api/chat はモックSSEレスポンスを返す。
 * Agent SDK には依存しない。
 */
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Readable } from 'node:stream'

const app = new Hono()

// --- モックセッション管理 ---
interface MockSession {
  sessionId: string
  project: string
  model: string
  lastUsed: number
  messagePreview: string
}
const mockSessions = new Map<string, MockSession>()

// --- SSEヘルパー ---
function sseEvent(event: string, data: string): string {
  // SSE仕様: 複数行データは各行に data: プレフィックスが必要
  const dataLines = data.split('\n').map(line => `data: ${line}`).join('\n')
  return `event: ${event}\n${dataLines}\n\n`
}

// --- モック プロジェクト ---
const mockProjects = [
  { slug: 'test-project', repo: 'test/test-project', localPath: '/tmp/test-project' },
  { slug: 'another-project', repo: 'test/another', localPath: '/tmp/another' },
]

// --- API ルート ---

app.get('/api/projects', (c) => c.json(mockProjects))

app.get('/api/chat/sessions', (c) => {
  const offset = parseInt(c.req.query('offset') || '0', 10)
  const limit = parseInt(c.req.query('limit') || '20', 10)
  const list = Array.from(mockSessions.values())
    .sort((a, b) => b.lastUsed - a.lastUsed)
  const page = list.slice(offset, offset + limit)
  return c.json({ items: page, total: list.length, offset, limit })
})

app.delete('/api/chat/sessions/:id', (c) => {
  const id = c.req.param('id')
  mockSessions.delete(id)
  return c.json({ deleted: true })
})

app.post('/api/chat/abort', async (c) => {
  return c.json({ aborted: true })
})

app.post('/api/chat', async (c) => {
  const body = await c.req.json<{
    message: string
    project?: string
    sessionId?: string
    model?: string
    planMode?: boolean
  }>()

  if (!body.message?.trim()) {
    return c.json({ error: 'message is required' }, 400)
  }

  const sessionId = body.sessionId || `mock-sess-${Date.now()}`
  const streamId = `mock-stream-${Date.now()}`

  // セッション保存
  mockSessions.set(sessionId.slice(0, 12), {
    sessionId,
    project: body.project || '/tmp/test-project',
    model: body.model || 'sonnet',
    lastUsed: Date.now(),
    messagePreview: body.message.slice(0, 100),
  })

  // メッセージに応じたモックレスポンスを生成
  const events = buildMockEvents(body.message, sessionId, streamId)

  // SSEストリームを返す
  const stream = new ReadableStream({
    async start(controller) {
      for (const evt of events) {
        controller.enqueue(new TextEncoder().encode(evt))
        // ストリーミング感を出すための小さなディレイ
        await new Promise(r => setTimeout(r, 10))
      }
      controller.close()
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  })
})

function buildMockEvents(message: string, sessionId: string, streamId: string): string[] {
  const events: string[] = []

  // streamId通知 + セッション通知
  events.push(sseEvent('stream-start', JSON.stringify({ streamId })))
  events.push(sseEvent('session', JSON.stringify({ sessionId, streamId })))

  if (message.includes('tool-test')) {
    // ツール詳細テスト用: Edit ツール実行のモック
    events.push(sseEvent('tool', JSON.stringify({ name: 'Edit', status: 'start' })))
    events.push(sseEvent('tool', JSON.stringify({
      name: 'Edit',
      status: 'input',
      detail: {
        name: 'Edit',
        input: {
          file_path: '/tmp/test.ts',
          old_string: 'const x = 1',
          new_string: 'const x = 2',
        },
      },
    })))
    events.push(sseEvent('tool', JSON.stringify({
      name: 'Edit',
      status: 'output',
      detail: { name: 'Edit', output: 'File edited successfully' },
    })))
    events.push(sseEvent('text', 'I edited the file.'))
  } else if (message.includes('bash-test')) {
    // Bash ツールテスト
    events.push(sseEvent('tool', JSON.stringify({ name: 'Bash', status: 'start' })))
    events.push(sseEvent('tool', JSON.stringify({
      name: 'Bash',
      status: 'input',
      detail: {
        name: 'Bash',
        input: { command: 'echo hello' },
      },
    })))
    events.push(sseEvent('tool', JSON.stringify({
      name: 'Bash',
      status: 'output',
      detail: { name: 'Bash', output: 'hello' },
    })))
    events.push(sseEvent('text', 'Command executed.'))
  } else if (message.includes('danger-test')) {
    // 危険コマンド警告テスト
    events.push(sseEvent('warning', JSON.stringify({ label: 'rm -rf', command: 'rm -rf /important' })))
    events.push(sseEvent('text', 'Warning was shown.'))
  } else if (message.includes('code-test')) {
    // コードブロックテスト（コピーボタン確認用）
    events.push(sseEvent('text', 'Here is some code:\n\n```typescript\nconst greeting = "hello world"\nconsole.log(greeting)\n```\n'))
  } else if (message.includes('compact-test')) {
    // コンパクティングテスト
    events.push(sseEvent('status', JSON.stringify({ status: 'compacting' })))
    events.push(sseEvent('text', 'Compacting...'))
    events.push(sseEvent('compact', JSON.stringify({ trigger: 'auto', preTokens: 50000 })))
    events.push(sseEvent('text', ' Done.'))
  } else if (message.includes('plan-test')) {
    // Plan Modeテスト
    events.push(sseEvent('status', JSON.stringify({ permissionMode: 'plan' })))
    events.push(sseEvent('text', 'Planning mode active.'))
  } else if (message.includes('error-test')) {
    // エラーテスト
    events.push(sseEvent('error', JSON.stringify({ message: 'Test error occurred' })))
    return events
  } else {
    // デフォルト: テキストレスポンス
    events.push(sseEvent('text', 'Hello! '))
    events.push(sseEvent('text', 'This is a mock response.'))
  }

  // 結果
  events.push(sseEvent('result', JSON.stringify({
    text: '',
    sessionId,
    cost: 0.0042,
    durationMs: 1234,
    turns: 1,
    isError: false,
  })))

  return events
}

// --- 静的ファイル ---
app.get('*', (c) => {
  try {
    const html = readFileSync(resolve(process.cwd(), 'src/web/public/index.html'), 'utf-8')
    return c.html(html)
  } catch {
    return c.text('index.html not found', 404)
  }
})

// --- サーバー起動 ---
const PORT = 3199
serve({ fetch: app.fetch, hostname: '127.0.0.1', port: PORT })
console.log(`Test server running on http://127.0.0.1:${PORT}`)
