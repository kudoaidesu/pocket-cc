/**
 * チャットAPI — SSE ルート
 *
 * コアロジックは chat-service.ts に委譲し、
 * ここでは Hono の SSE ストリーミング変換とセッション管理のみ行う。
 */
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { readdirSync, statSync, openSync, readSync, closeSync, createReadStream, existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { startStream, readStream, getStreamStatus, abortStream } from '../services/chat-service.js'
import type { ChatEvent } from '../services/chat-service.js'
import { resolveRequest, getRequest } from '../services/permission-bridge.js'
import { runClaudeCli } from '../../llm/claude-cli.js'
import { validateInput } from '../../utils/sanitize.js'
import { isValidSessionId, isProjectPathAllowed, FRONT_DESK_SENTINEL } from '../path-guard.js'
import { createLogger } from '../../utils/logger.js'
import { getDb } from '../../db/index.js'
import { config } from '../../config.js'
import { ensureMemoryFiles } from '../../agents/memory.js'
import { buildAllAgents, buildFrontDeskPrompt } from '../../agents/definitions.js'

const log = createLogger('web:chat')

/**
 * メッセージプレビューをクリーンアップ
 * - XMLタグ（<ide_opened_file>等）を除去し、中のテキストだけ抽出
 * - system-reminder タグを除去
 * - 先頭の空白・改行をトリム
 * - UUID/ハッシュ値のみの場合は空文字を返す（呼び出し元でフォールバック）
 */
export function cleanPreview(raw: string): string {
  let text = raw
  // システムタグを中身ごと除去（閉じタグあり）
  text = text.replace(/<(ide_opened_file|ide_selection|system-reminder|user-prompt-submit-hook)[^>]*>[\s\S]*?<\/\1>/g, '')
  // 閉じタグなし（切り詰めで閉じタグが欠落）→ 開始タグ以降を全除去
  text = text.replace(/<(ide_opened_file|ide_selection|system-reminder|user-prompt-submit-hook)[^>]*>[\s\S]*/g, '')
  // 残った単独タグも除去
  text = text.replace(/<[^>]+>/g, '')
  // タグ除去済みの既存データ対応: IDEコンテキストの定型文を除去
  text = text.replace(/^The user opened the file\b.*$/gm, '')
  text = text.replace(/^The user's IDE selection.*$/gm, '')
  text = text.replace(/^This (may or may not|is|represents).*$/gm, '')
  // 改行をスペースに
  text = text.replace(/\s+/g, ' ').trim()
  // UUID/ハッシュ値のみ（例: 6e56d8c1-847...）は空にする
  if (/^[0-9a-f-]{8,}$/i.test(text)) return ''
  return text.slice(0, 200)
}

// アクティブセッション管理（SQLite永続化）
export interface SessionEntry {
  sessionId: string
  project: string
  model: string
  lastUsed: number
  messagePreview: string
}

/** セッションをSQLiteに保存（UPSERT + LRU 50件上限） */
function saveSession(key: string, entry: SessionEntry): void {
  const db = getDb()
  db.prepare(`
    INSERT INTO sessions (key, session_id, project, model, last_used, message_preview)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      session_id = excluded.session_id,
      project = excluded.project,
      model = excluded.model,
      last_used = excluded.last_used,
      message_preview = excluded.message_preview
  `).run(key, entry.sessionId, entry.project, entry.model, entry.lastUsed, entry.messagePreview)

  // LRU上限: 50件を超えた古いものを削除
  db.prepare(`
    DELETE FROM sessions WHERE key NOT IN (
      SELECT key FROM sessions ORDER BY last_used DESC LIMIT 50
    )
  `).run()
}

// SSE イベント書き出しヘルパー（POST /api/chat と POST /api/chat/reconnect で共用）
async function writeEventSSE(
  stream: { writeSSE: (msg: { id?: string; event: string; data: string }) => Promise<void> },
  event: ChatEvent,
  index: number,
  streamId?: string,
): Promise<{ sessionId?: string; streamId?: string }> {
  const id = String(index)
  switch (event.type) {
    case 'stream-start':
      await stream.writeSSE({ id, event: 'stream-start', data: JSON.stringify({ streamId: event.streamId }) })
      return { streamId: event.streamId }
    case 'session':
      await stream.writeSSE({ id, event: 'session', data: JSON.stringify({ sessionId: event.sessionId, streamId }) })
      return { sessionId: event.sessionId }
    case 'text':
      await stream.writeSSE({ id, event: 'text', data: event.text })
      break
    case 'tool':
      await stream.writeSSE({ id, event: 'tool', data: JSON.stringify({ name: event.name, status: event.status, detail: event.detail }) })
      break
    case 'warning':
      await stream.writeSSE({ id, event: 'warning', data: JSON.stringify({ command: event.command, label: event.label }) })
      break
    case 'result':
      await stream.writeSSE({
        id,
        event: 'result',
        data: JSON.stringify({
          text: event.text, sessionId: event.sessionId,
          cost: event.cost, turns: event.turns, durationMs: event.durationMs, isError: event.isError,
        }),
      })
      return { sessionId: event.sessionId }
    case 'error':
      await stream.writeSSE({ id, event: 'error', data: JSON.stringify({ message: event.message }) })
      break
    case 'status':
      await stream.writeSSE({ id, event: 'status', data: JSON.stringify({ status: event.status, permissionMode: event.permissionMode }) })
      break
    case 'compact':
      await stream.writeSSE({ id, event: 'compact', data: JSON.stringify({ trigger: event.trigger, preTokens: event.preTokens }) })
      break
    case 'tokenUsage':
      await stream.writeSSE({ id, event: 'tokenUsage', data: JSON.stringify({ inputTokens: event.inputTokens, contextWindow: event.contextWindow }) })
      break
    case 'ask-question':
      await stream.writeSSE({ id, event: 'ask-question', data: JSON.stringify({ requestId: event.requestId, questions: event.questions }) })
      break
    case 'tool-approval':
      await stream.writeSSE({
        id,
        event: 'tool-approval',
        data: JSON.stringify({ requestId: event.requestId, toolName: event.toolName, input: event.input, description: event.description, decisionReason: event.decisionReason }),
      })
      break
    case 'heartbeat':
      await stream.writeSSE({ id, event: 'heartbeat', data: '' })
      break
  }
  return {}
}

export function getSessions(): SessionEntry[] {
  const db = getDb()
  const rows = db.prepare(`
    SELECT key, session_id, project, model, last_used, message_preview
    FROM sessions ORDER BY last_used DESC
  `).all() as Array<Record<string, unknown>>

  return rows.map(row => ({
    sessionId: row.session_id as string,
    project: row.project as string,
    model: row.model as string,
    lastUsed: row.last_used as number,
    messagePreview: row.message_preview as string,
    id: row.key as string,
  } as SessionEntry & { id: string }))
}

/**
 * ~/.claude/projects/ からAgent SDKのセッションファイルを直接スキャン
 * cwdパスをハッシュ化したディレクトリ名でプロジェクトを特定
 */
export function cwdToProjectDir(cwd: string): string {
  // Agent SDKはパスの / と _ を - に変換してディレクトリ名にする
  return cwd.replace(/[/_]/g, '-')
}

// SDKセッションスキャンキャッシュ（5秒TTL）
let sdkCache: { cwd: string; data: SessionEntry[]; ts: number } | null = null
const SDK_CACHE_TTL = 5000

function scanSdkSessions(cwd: string): SessionEntry[] {
  // キャッシュヒット
  if (sdkCache && sdkCache.cwd === cwd && Date.now() - sdkCache.ts < SDK_CACHE_TTL) {
    return sdkCache.data
  }

  const claudeDir = join(homedir(), '.claude', 'projects', cwdToProjectDir(cwd))
  const results: SessionEntry[] = []

  try {
    const files = readdirSync(claudeDir).filter(f => f.endsWith('.jsonl'))

    // stat情報を取得して最新50件に絞る
    const fileStats = files.map(f => {
      try {
        const s = statSync(join(claudeDir, f))
        return { file: f, mtime: s.mtimeMs }
      } catch { return null }
    }).filter((x): x is { file: string; mtime: number } => x !== null)
    fileStats.sort((a, b) => b.mtime - a.mtime)

    for (const { file, mtime } of fileStats) {
      const filePath = join(claudeDir, file)
      const sessionId = file.replace('.jsonl', '')

      try {
        // ユーザーメッセージ行だけ抽出して高速スキャン
        // TextDecoder(stream)でUTF-8マルチバイト境界の文字化けを防止
        const chunkSize = 8192
        const buf = Buffer.alloc(chunkSize)
        const fd = openSync(filePath, 'r')
        const decoder = new TextDecoder('utf-8')
        let preview = ''
        let summary = ''
        let customTitle = ''
        let agentName = ''
        let pos = 0
        const fileSize = statSync(filePath).size
        const maxScan = Math.min(fileSize, 256 * 1024) // 最大256KB
        let partial = ''
        while (pos < maxScan) {
          const bytesRead = readSync(fd, buf, 0, chunkSize, pos)
          if (bytesRead === 0) break
          pos += bytesRead
          partial += decoder.decode(buf.subarray(0, bytesRead), { stream: pos < maxScan })
          const lines = partial.split('\n')
          partial = lines.pop() || '' // 最後の不完全行を保持
          for (const line of lines) {
            try {
              // summary/customTitle/agentName を検出
              if (line.includes('"summary"') || line.includes('"customTitle"') || line.includes('"agentName"')) {
                const obj = JSON.parse(line)
                if (obj.summary && typeof obj.summary === 'string') summary = obj.summary
                if (obj.customTitle && typeof obj.customTitle === 'string') customTitle = obj.customTitle
                if (obj.agentName && typeof obj.agentName === 'string') agentName = obj.agentName
              }
              // firstPrompt 抽出（まだ未取得の場合のみ）
              if (!preview && line.includes('"type":"user"')) {
                const obj = JSON.parse(line)
                if (obj.type === 'user' && obj.message?.content) {
                  let rawText = ''
                  if (typeof obj.message.content === 'string') {
                    const content = obj.message.content
                    if (/^(?:A:|Assistant:)\s/i.test(content)) { /* skip */ }
                    else {
                      const m = content.match(/^(?:User:\s*)?(.+?)(?:\n\n(?:A:|Assistant:)|$)/s)
                      rawText = m ? m[1].trim() : content.split('\n')[0]
                    }
                  } else if (Array.isArray(obj.message.content)) {
                    const textContent = obj.message.content.find(
                      (c: { type: string; text?: string }) => c.type === 'text'
                    )
                    rawText = textContent?.text || ''
                  }
                  if (rawText) {
                    const cleaned = cleanPreview(rawText)
                    if (cleaned) preview = cleaned
                  }
                }
              }
            } catch { /* skip malformed lines */ }
          }
        }
        closeSync(fd)

        // VSCode拡張と同じ優先度チェーン: agentName → customTitle → summary → firstPrompt → "Untitled"
        const displayName = agentName || customTitle || summary || preview
        if (!displayName) continue

        results.push({
          sessionId,
          project: cwd,
          model: '',
          lastUsed: mtime,
          messagePreview: displayName,
        })
      } catch { /* skip unreadable files */ }
    }
  } catch { /* directory doesn't exist */ }

  results.sort((a, b) => b.lastUsed - a.lastUsed)
  sdkCache = { cwd, data: results, ts: Date.now() }
  return results
}

/**
 * インメモリsessions + SDKファイルスキャンをマージ
 * インメモリに無いセッションはSDKから補完
 */
function getMergedSessions(cwd?: string): SessionEntry[] {
  const memSessions = getSessions()
  if (!cwd) return memSessions

  // インメモリセッションをプロジェクトでフィルタ
  const filtered = memSessions.filter(s => s.project === cwd)

  const sdkSessions = scanSdkSessions(cwd)
  const sdkMap = new Map(sdkSessions.map(s => [s.sessionId, s]))
  const existingIds = new Set(filtered.map(s => s.sessionId))

  // インメモリセッションのプレビューをSDKで補完（クリーン後に空になる場合）
  for (const mem of filtered) {
    if (!cleanPreview(mem.messagePreview)) {
      const sdk = sdkMap.get(mem.sessionId)
      if (sdk?.messagePreview) {
        mem.messagePreview = sdk.messagePreview
      }
    }
  }

  // SDKにしかないセッションを追加
  for (const sdk of sdkSessions) {
    if (!existingIds.has(sdk.sessionId)) {
      filtered.push({ ...sdk, id: sdk.sessionId.slice(0, 12) } as SessionEntry & { id: string })
    }
  }

  return filtered.sort((a, b) => b.lastUsed - a.lastUsed)
}

// --- 履歴メッセージ型 ---
interface HistoryMessage {
  role: 'user' | 'assistant'
  type: 'text' | 'tool_use' | 'tool_result'
  text?: string
  toolUse?: { name: string; input: Record<string, unknown> }
  toolResult?: { output: string }
}

/** JSONL ファイルをストリーミング読み取りし、UI表示用メッセージ配列に変換 */
async function parseSessionJsonl(filePath: string): Promise<HistoryMessage[]> {
  const messages: HistoryMessage[] = []

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  })

  for await (const line of rl) {
    if (!line.trim()) continue
    try {
      const record = JSON.parse(line) as {
        type?: string
        message?: {
          content?: Array<{
            type: string
            text?: string
            name?: string
            input?: Record<string, unknown>
            content?: string | Array<{ type: string; text?: string }>
            tool_use_id?: string
          }>
        }
      }

      const role = record.type as 'user' | 'assistant' | undefined
      if (!role || !record.message?.content) continue

      for (const c of record.message.content) {
        if (c.type === 'thinking') continue

        if (c.type === 'text' && c.text) {
          messages.push({ role, type: 'text', text: c.text })
        } else if (c.type === 'tool_use' && c.name) {
          messages.push({
            role: 'assistant',
            type: 'tool_use',
            toolUse: { name: c.name, input: c.input || {} },
          })
        } else if (c.type === 'tool_result') {
          let output = ''
          if (typeof c.content === 'string') {
            output = c.content
          } else if (Array.isArray(c.content)) {
            output = c.content
              .filter((x: { type: string; text?: string }) => x.type === 'text' && x.text)
              .map((x: { text?: string }) => x.text)
              .join('\n')
          }
          // 長い出力は切り詰め
          if (output.length > 3000) output = output.slice(0, 3000) + '\n... (truncated)'
          messages.push({ role: 'user', type: 'tool_result', toolResult: { output } })
        }
      }
    } catch { /* skip malformed lines */ }
  }

  return messages
}

export const chatRoutes = new Hono()

// POST /api/chat — SSEストリーミングでClaudeの応答を返す
chatRoutes.post('/', async (c) => {
  const body = await c.req.json<{
    message: string
    project?: string
    sessionId?: string
    model?: string
    planMode?: boolean
    permissionMode?: string
    images?: Array<{ name: string; mediaType: string; data: string }>
  }>()

  if (!body.message?.trim() && (!body.images || body.images.length === 0)) {
    return c.json({ error: 'message or images required' }, 400)
  }

  // 入力バリデーション
  const validation = validateInput(body.message || '')
  const sanitizedMessage = validation.sanitized || body.message || ''

  const isFrontDesk = body.project === FRONT_DESK_SENTINEL
  const cwd = isFrontDesk ? process.cwd() : (body.project || process.cwd())

  // プロジェクトパスのバウンダリチェック
  if (body.project && !isProjectPathAllowed(body.project)) {
    return c.json({ error: 'Access denied: path outside allowed projects' }, 403)
  }

  const model = body.model || 'sonnet'

  // フロントデスクモード: エージェント定義 + 追加ディレクトリ + プロンプト注入
  let agents: Record<string, unknown> | undefined
  let additionalDirectories: string[] | undefined
  let appendSystemPrompt: string | undefined
  if (isFrontDesk) {
    const projects = config.projects
    ensureMemoryFiles(projects)
    agents = buildAllAgents(projects)
    additionalDirectories = projects.map(p => p.localPath)
    appendSystemPrompt = buildFrontDeskPrompt(projects)
  }

  // SDK処理開始（HTTP接続から分離 — 接続が切れてもSDKは継続）
  let streamId: string
  try {
    streamId = await startStream({
      message: sanitizedMessage,
      cwd,
      model,
      sessionId: body.sessionId,
      planMode: body.permissionMode === 'plan' || body.planMode,
      permissionMode: body.permissionMode,
      images: body.images,
      agents,
      additionalDirectories,
      appendSystemPrompt,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error(`startStream failed: ${message}`)
    return c.json({ error: message }, 500)
  }

  return streamSSE(c, async (stream) => {
    let lastSessionId = body.sessionId || ''

    try {
      for await (const { event, index } of readStream(streamId)) {
        const result = await writeEventSSE(stream, event, index, streamId)
        if (result.sessionId) lastSessionId = result.sessionId
      }

      // セッション保存（SQLite永続化）
      if (lastSessionId) {
        const key = lastSessionId.slice(0, 12)
        saveSession(key, {
          sessionId: lastSessionId,
          project: cwd,
          model,
          lastUsed: Date.now(),
          messagePreview: cleanPreview(body.message) || body.message.slice(0, 100),
        })
      }
    } catch (err) {
      // writeSSE失敗（クライアント切断等）→ SDK処理は継続、HTTP接続だけ終了
      const message = err instanceof Error ? err.message : String(err)
      log.warn(`SSE write error (SDK continues): ${message}`)
    }
  })
})

// POST /api/chat/respond — ユーザーの質問回答 / ツール承認レスポンス
chatRoutes.post('/respond', async (c) => {
  const body = await c.req.json<{
    requestId: string
    type: 'answer' | 'approval'
    answers?: Record<string, string>
    approved?: boolean
    denyMessage?: string
  }>()

  if (!body.requestId) {
    return c.json({ error: 'requestId is required' }, 400)
  }

  const pending = getRequest(body.requestId)
  if (!pending) {
    return c.json({ error: 'Request not found or expired' }, 404)
  }

  if (body.type === 'answer' && pending.toolName === 'AskUserQuestion') {
    resolveRequest(body.requestId, {
      behavior: 'allow',
      updatedInput: { ...pending.input, answers: body.answers || {} },
    })
    return c.json({ ok: true })
  }

  if (body.type === 'approval') {
    if (body.approved) {
      resolveRequest(body.requestId, { behavior: 'allow', updatedInput: pending.input })
    } else {
      resolveRequest(body.requestId, {
        behavior: 'deny',
        message: body.denyMessage || 'User denied tool execution',
      })
    }
    return c.json({ ok: true })
  }

  return c.json({ error: 'Invalid response type' }, 400)
})

// POST /api/chat/abort — ストリーム中断
chatRoutes.post('/abort', async (c) => {
  const { streamId } = await c.req.json<{ streamId?: string }>()
  if (!streamId) {
    return c.json({ error: 'streamId is required' }, 400)
  }
  const aborted = abortStream(streamId)
  return c.json({ aborted })
})

// GET /api/chat/sessions — セッション一覧（SDKファイルスキャン付き、ページング対応）
chatRoutes.get('/sessions', (c) => {
  const project = c.req.query('project')
  const offset = parseInt(c.req.query('offset') || '0', 10)
  const limit = parseInt(c.req.query('limit') || '20', 10)

  // プロジェクトパスのバウンダリチェック
  if (project && !isProjectPathAllowed(project)) {
    return c.json({ error: 'Access denied: path outside allowed projects' }, 403)
  }

  // フロントデスクの場合はcwdをプロセスルートに変換
  const resolvedProject = project === FRONT_DESK_SENTINEL ? process.cwd() : project
  const all = getMergedSessions(resolvedProject)
  const page = all.slice(offset, offset + limit).map(s => ({
    ...s,
    messagePreview: cleanPreview(s.messagePreview) || 'Untitled',
  }))
  return c.json({ items: page, total: all.length, offset, limit })
})

// GET /api/chat/history/:sessionId — セッション会話履歴を返す
chatRoutes.get('/history/:sessionId', async (c) => {
  const sessionId = c.req.param('sessionId')
  const project = c.req.query('project')

  if (!sessionId || !project) {
    return c.json({ messages: [] })
  }

  // プロジェクトパスのバウンダリチェック
  if (!isProjectPathAllowed(project)) {
    return c.json({ error: 'Access denied: path outside allowed projects' }, 403)
  }

  // sessionId のバリデーション: パストラバーサル防止
  if (!isValidSessionId(sessionId)) {
    return c.json({ error: 'Invalid sessionId format' }, 400)
  }

  // フロントデスクの場合はcwdをプロセスルートに変換
  const resolvedProject = project === FRONT_DESK_SENTINEL ? process.cwd() : project
  const claudeDir = join(homedir(), '.claude', 'projects', cwdToProjectDir(resolvedProject))
  const filePath = join(claudeDir, `${sessionId}.jsonl`)

  if (!existsSync(filePath)) {
    return c.json({ messages: [] })
  }

  try {
    const messages = await parseSessionJsonl(filePath)
    return c.json({ messages })
  } catch (e) {
    log.warn(`Failed to parse session history: ${e}`)
    return c.json({ messages: [] })
  }
})

// ── コンパクトジョブ管理（バックグラウンド実行） ────────────
interface CompactJob {
  status: 'running' | 'done' | 'error'
  startedAt: number
  preTokens?: number
  error?: string
}

const compactJobs = new Map<string, CompactJob>()

async function runCompact(sessionId: string, cwd: string, model: string): Promise<{ preTokens?: number }> {
  let preTokens: number | undefined
  const streamId = await startStream({
    message: '/compact',
    cwd,
    model,
    sessionId,
    permissionMode: 'plan',
  })
  for await (const { event } of readStream(streamId)) {
    if (event.type === 'compact' && event.preTokens) {
      preTokens = event.preTokens
    }
  }
  return { preTokens }
}

// POST /api/chat/compact — 手動コンパクト実行（バックグラウンド）
chatRoutes.post('/compact', async (c) => {
  const { sessionId, project, model } = await c.req.json<{
    sessionId?: string
    project?: string
    model?: string
  }>()

  if (!sessionId) {
    return c.json({ error: 'sessionId is required' }, 400)
  }

  // プロジェクトパスのバウンダリチェック
  if (project && !isProjectPathAllowed(project)) {
    return c.json({ error: 'Access denied: path outside allowed projects' }, 403)
  }

  // 既に実行中ならスキップ
  const existing = compactJobs.get(sessionId)
  if (existing?.status === 'running') {
    return c.json({ started: false, reason: 'already running' })
  }

  const cwd = project || process.cwd()
  const job: CompactJob = { status: 'running', startedAt: Date.now() }
  compactJobs.set(sessionId, job)
  log.info(`Manual compact started for session ${sessionId.slice(0, 12)}`)

  // バックグラウンドで実行（レスポンスは即返す）
  runCompact(sessionId, cwd, model || 'sonnet').then(result => {
    job.status = 'done'
    job.preTokens = result.preTokens
    log.info(`Manual compact done for session ${sessionId.slice(0, 12)}, preTokens=${result.preTokens}`)
  }).catch(err => {
    job.status = 'error'
    job.error = err instanceof Error ? err.message : String(err)
    log.error(`Manual compact failed for session ${sessionId.slice(0, 12)}: ${job.error}`)
  })

  return c.json({ started: true })
})

// GET /api/chat/stream-status/:streamId — ストリーム生存確認（クライアントリコネクト用）
chatRoutes.get('/stream-status/:streamId', (c) => {
  const streamId = c.req.param('streamId')
  const status = getStreamStatus(streamId)
  if (!status) {
    return c.json({ error: 'Stream not found' }, 404)
  }
  return c.json(status)
})

// POST /api/chat/reconnect — ストリームに再接続（途切れたSSEのリカバリ）
chatRoutes.post('/reconnect', async (c) => {
  const { streamId, lastEventIndex } = await c.req.json<{
    streamId: string
    lastEventIndex?: number
  }>()

  if (!streamId) {
    return c.json({ error: 'streamId is required' }, 400)
  }

  const status = getStreamStatus(streamId)
  if (!status) {
    return c.json({ error: 'Stream not found' }, 404)
  }

  const fromIndex = (lastEventIndex ?? -1) + 1

  return streamSSE(c, async (stream) => {
    try {
      for await (const { event, index } of readStream(streamId, fromIndex)) {
        await writeEventSSE(stream, event, index, streamId)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn(`Reconnect SSE write error: ${message}`)
    }
  })
})

// GET /api/chat/compact-status/:sessionId — コンパクトジョブ状態確認
chatRoutes.get('/compact-status/:sessionId', (c) => {
  const sessionId = c.req.param('sessionId')
  const job = compactJobs.get(sessionId)
  if (!job) {
    return c.json({ status: 'none' })
  }
  return c.json(job)
})

// ── セッションサマリー（AI要約） ────────────

interface SummaryEntry {
  summary: string
  generatedAt: number
  messageCount: number
}

function getSummaryCache(sessionId: string): SummaryEntry | null {
  const db = getDb()
  const row = db.prepare(`
    SELECT summary, generated_at, message_count FROM session_summaries WHERE session_id = ?
  `).get(sessionId) as Record<string, unknown> | undefined
  if (!row) return null
  return {
    summary: row.summary as string,
    generatedAt: row.generated_at as number,
    messageCount: row.message_count as number,
  }
}

function setSummaryCache(sessionId: string, entry: SummaryEntry): void {
  const db = getDb()
  db.prepare(`
    INSERT INTO session_summaries (session_id, summary, generated_at, message_count)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      summary = excluded.summary,
      generated_at = excluded.generated_at,
      message_count = excluded.message_count
  `).run(sessionId, entry.summary, entry.generatedAt, entry.messageCount)
}

/** JONLからユーザー/アシスタントのテキストのみ抽出し、要約用トランスクリプトを返す */
async function extractSummaryTranscript(filePath: string): Promise<{ transcript: string; messageCount: number }> {
  const lines: { role: string; text: string }[] = []

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  })

  for await (const line of rl) {
    if (!line.trim()) continue
    try {
      const record = JSON.parse(line) as {
        type?: string
        message?: { content?: Array<{ type: string; text?: string }> }
      }
      const role = record.type
      if (role !== 'user' && role !== 'assistant') continue
      if (!record.message?.content) continue

      for (const c of record.message.content) {
        if (c.type === 'text' && c.text) {
          const cleaned = c.text.replace(/<(ide_opened_file|ide_selection|system-reminder|user-prompt-submit-hook)[^>]*>[\s\S]*?(<\/\1>|$)/g, '').trim()
          if (cleaned) {
            lines.push({ role, text: cleaned.slice(0, 200) })
          }
        }
      }
    } catch { /* skip */ }
  }

  // 先頭5 + 末尾5（重複なし）— コンパクトにしてLLMが安定した3行要約を出せるように
  const head = lines.slice(0, 5)
  const tail = lines.length > 10 ? lines.slice(-5) : lines.slice(5)
  const selected = [...head, ...tail]

  let transcript = ''
  for (const m of selected) {
    const prefix = m.role === 'user' ? 'User' : 'Assistant'
    transcript += `${prefix}: ${m.text}\n\n`
    if (transcript.length > 3000) break
  }

  return { transcript: transcript.slice(0, 3000), messageCount: lines.length }
}

// GET /api/chat/summary/:sessionId — AI生成セッション要約
chatRoutes.get('/summary/:sessionId', async (c) => {
  const sessionId = c.req.param('sessionId')
  const project = c.req.query('project')

  if (!sessionId || !project) {
    return c.json({ summary: null })
  }
  if (!isValidSessionId(sessionId)) {
    return c.json({ error: 'Invalid sessionId' }, 400)
  }
  if (!isProjectPathAllowed(project)) {
    return c.json({ error: 'Access denied' }, 403)
  }

  const resolvedPrj = project === FRONT_DESK_SENTINEL ? process.cwd() : project
  const claudeDir = join(homedir(), '.claude', 'projects', cwdToProjectDir(resolvedPrj))
  const filePath = join(claudeDir, `${sessionId}.jsonl`)

  if (!existsSync(filePath)) {
    return c.json({ summary: null })
  }

  try {
    // まずメッセージ数を素早くカウント（キャッシュ判定用）
    const { transcript, messageCount } = await extractSummaryTranscript(filePath)

    // メッセージが少なすぎる場合はLLM不要
    if (messageCount < 2) {
      return c.json({ summary: null, reason: 'too_short' })
    }

    // キャッシュ確認
    const cached = getSummaryCache(sessionId)
    if (cached && messageCount - cached.messageCount < 3) {
      return c.json({ summary: cached.summary })
    }

    // LLMで要約生成
    const result = await runClaudeCli({
      prompt: transcript,
      systemPrompt: [
        'あなたはセッション要約を生成するアシスタントです。',
        '以下のチャット記録を読み、3行で簡潔に要約してください。',
        '- 1行目: ユーザーが何を依頼したか',
        '- 2行目: 何が実行されたか',
        '- 3行目: 結果・現在の状態',
        '各行は50文字以内。箇条書き記号は不要。出力は要約の3行のみ。',
      ].join('\n'),
      model: 'claude-haiku-4-5-20251001',
      skipPermissions: true,
      allowedTools: [],
      timeoutMs: 30_000,
    })

    const summary = result.content.trim()

    // キャッシュ保存
    setSummaryCache(sessionId, { summary, generatedAt: Date.now(), messageCount })

    return c.json({ summary })
  } catch (e) {
    log.warn(`Summary generation failed for ${sessionId.slice(0, 12)}: ${e}`)
    return c.json({ summary: null, error: 'generation_failed' })
  }
})

// GET /api/chat/suggest-name/:sessionId — セッション名をAI提案
chatRoutes.get('/suggest-name/:sessionId', async (c) => {
  const sessionId = c.req.param('sessionId')
  const project = c.req.query('project')

  if (!sessionId || !project) {
    return c.json({ name: null })
  }
  if (!isValidSessionId(sessionId)) {
    return c.json({ error: 'Invalid sessionId' }, 400)
  }
  if (!isProjectPathAllowed(project)) {
    return c.json({ error: 'Access denied' }, 403)
  }

  const resolvedPrj = project === FRONT_DESK_SENTINEL ? process.cwd() : project
  const claudeDir = join(homedir(), '.claude', 'projects', cwdToProjectDir(resolvedPrj))
  const filePath = join(claudeDir, `${sessionId}.jsonl`)

  if (!existsSync(filePath)) {
    return c.json({ name: null })
  }

  try {
    const { transcript, messageCount } = await extractSummaryTranscript(filePath)
    if (messageCount < 1) {
      return c.json({ name: null })
    }

    // 先頭2000文字だけで十分
    const result = await runClaudeCli({
      prompt: transcript.slice(0, 2000),
      systemPrompt: [
        'このチャット記録の内容を表す短いタイトルを1つ生成してください。',
        '条件:',
        '- 日本語で20文字以内',
        '- 体言止め（例: 「タブ更新機能の追加」「認証バグの修正」）',
        '- タイトルのみ出力。説明や記号は不要。',
      ].join('\n'),
      model: 'claude-haiku-4-5-20251001',
      skipPermissions: true,
      allowedTools: [],
      timeoutMs: 15_000,
    })

    return c.json({ name: result.content.trim().slice(0, 30) })
  } catch (e) {
    log.warn(`Name suggestion failed for ${sessionId.slice(0, 12)}: ${e}`)
    return c.json({ name: null })
  }
})

