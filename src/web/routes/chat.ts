/**
 * チャットAPI — SSE ルート
 *
 * コアロジックは chat-service.ts に委譲し、
 * ここでは Hono の SSE ストリーミング変換とセッション管理のみ行う。
 */
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, openSync, readSync, closeSync, createReadStream, existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { createChatStream, abortStream } from '../services/chat-service.js'
import { runClaudeCli } from '../../llm/claude-cli.js'
import { validateInput } from '../../utils/sanitize.js'
import { isValidSessionId, isProjectPathAllowed } from '../path-guard.js'
import { createLogger } from '../../utils/logger.js'

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
  return text.slice(0, 100)
}

// アクティブセッション管理（ファイル永続化）
export interface SessionEntry {
  sessionId: string
  project: string
  model: string
  lastUsed: number
  messagePreview: string
}

// プロジェクトルートの data/ に保存
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const SESSIONS_FILE = join(projectRoot, 'data', 'sessions.json')

const sessions = new Map<string, SessionEntry>()

// 起動時にファイルから復元
function loadSessions(): void {
  try {
    const raw = readFileSync(SESSIONS_FILE, 'utf-8')
    const entries: Array<[string, SessionEntry]> = JSON.parse(raw)
    for (const [key, val] of entries) {
      sessions.set(key, val)
    }
    log.info(`Loaded ${sessions.size} sessions from disk`)
  } catch {
    // ファイルが無い場合は空で開始
  }
}

function persistSessions(): void {
  try {
    mkdirSync(dirname(SESSIONS_FILE), { recursive: true })
    writeFileSync(SESSIONS_FILE, JSON.stringify(Array.from(sessions.entries()), null, 2))
  } catch (e) {
    log.warn(`Failed to persist sessions: ${e}`)
  }
}

loadSessions()

// streamId → sessionId マッピング（中断用）
const streamToSession = new Map<string, string>()

export function getSessions(): SessionEntry[] {
  return Array.from(sessions.entries())
    .map(([key, val]) => ({ ...val, id: key }))
    .sort((a, b) => b.lastUsed - a.lastUsed)
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
        let pos = 0
        const fileSize = statSync(filePath).size
        const maxScan = Math.min(fileSize, 256 * 1024) // 最大256KB
        let partial = ''
        scanLoop:
        while (pos < maxScan) {
          const bytesRead = readSync(fd, buf, 0, chunkSize, pos)
          if (bytesRead === 0) break
          pos += bytesRead
          partial += decoder.decode(buf.subarray(0, bytesRead), { stream: pos < maxScan })
          const lines = partial.split('\n')
          partial = lines.pop() || '' // 最後の不完全行を保持
          for (const line of lines) {
            if (!line.includes('"type":"user"')) continue // 高速フィルタ
            try {
              const obj = JSON.parse(line)
              if (obj.type === 'user' && obj.message?.content) {
                const textContent = obj.message.content.find(
                  (c: { type: string; text?: string }) => c.type === 'text'
                )
                if (textContent?.text) {
                  const cleaned = cleanPreview(textContent.text)
                  if (cleaned) { preview = cleaned; break scanLoop }
                }
              }
            } catch { /* skip malformed lines */ }
          }
        }
        closeSync(fd)

        results.push({
          sessionId,
          project: cwd,
          model: '',
          lastUsed: mtime,
          messagePreview: preview || 'Untitled',
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

  const cwd = body.project || process.cwd()

  // プロジェクトパスのバウンダリチェック
  if (body.project && !isProjectPathAllowed(body.project)) {
    return c.json({ error: 'Access denied: path outside allowed projects' }, 403)
  }

  const model = body.model || 'sonnet'

  return streamSSE(c, async (stream) => {
    let currentStreamId = ''

    try {
      const chatStream = createChatStream({
        message: sanitizedMessage,
        cwd,
        model,
        sessionId: body.sessionId,
        planMode: body.permissionMode === 'plan' || body.planMode,
        permissionMode: body.permissionMode,
        images: body.images,
      })

      let lastSessionId = body.sessionId || ''

      for await (const event of chatStream) {
        switch (event.type) {
          case 'stream-start':
            currentStreamId = event.streamId
            streamToSession.set(currentStreamId, lastSessionId)
            await stream.writeSSE({
              event: 'stream-start',
              data: JSON.stringify({ streamId: currentStreamId }),
            })
            break
          case 'session':
            if (event.sessionId) {
              lastSessionId = event.sessionId
            }
            await stream.writeSSE({
              event: 'session',
              data: JSON.stringify({ sessionId: event.sessionId, streamId: currentStreamId }),
            })
            break
          case 'text':
            await stream.writeSSE({ event: 'text', data: event.text })
            break
          case 'tool':
            await stream.writeSSE({
              event: 'tool',
              data: JSON.stringify({
                name: event.name,
                status: event.status,
                detail: event.detail,
              }),
            })
            break
          case 'warning':
            await stream.writeSSE({
              event: 'warning',
              data: JSON.stringify({ command: event.command, label: event.label }),
            })
            break
          case 'result':
            lastSessionId = event.sessionId || lastSessionId
            await stream.writeSSE({
              event: 'result',
              data: JSON.stringify({
                text: event.text,
                sessionId: lastSessionId,
                cost: event.cost,
                turns: event.turns,
                durationMs: event.durationMs,
                isError: event.isError,
              }),
            })
            break
          case 'error':
            await stream.writeSSE({
              event: 'error',
              data: JSON.stringify({ message: event.message }),
            })
            break
          case 'status':
            await stream.writeSSE({
              event: 'status',
              data: JSON.stringify({ status: event.status, permissionMode: event.permissionMode }),
            })
            break
          case 'compact':
            await stream.writeSSE({
              event: 'compact',
              data: JSON.stringify({ trigger: event.trigger, preTokens: event.preTokens }),
            })
            break
          case 'tokenUsage':
            await stream.writeSSE({
              event: 'tokenUsage',
              data: JSON.stringify({ inputTokens: event.inputTokens, contextWindow: event.contextWindow }),
            })
            break
        }
      }

      // セッション保存（ファイル永続化）
      if (lastSessionId) {
        const key = lastSessionId.slice(0, 12)
        sessions.set(key, {
          sessionId: lastSessionId,
          project: cwd,
          model,
          lastUsed: Date.now(),
          messagePreview: cleanPreview(body.message) || body.message.slice(0, 100),
        })
        // 古いセッションを削除（最大50件）
        if (sessions.size > 50) {
          const oldest = Array.from(sessions.entries())
            .sort((a, b) => a[1].lastUsed - b[1].lastUsed)
          for (let i = 0; i < sessions.size - 50; i++) {
            sessions.delete(oldest[i][0])
          }
        }
        persistSessions()
      }
      if (currentStreamId) {
        streamToSession.delete(currentStreamId)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error(`Chat error: ${message}`)
      await stream.writeSSE({
        event: 'error',
        data: JSON.stringify({ message }),
      })
    }
  })
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

  const all = getMergedSessions(project)
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

  const claudeDir = join(homedir(), '.claude', 'projects', cwdToProjectDir(project))
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
  const stream = createChatStream({
    message: '/compact',
    cwd,
    model,
    sessionId,
    permissionMode: 'plan',
  })
  for await (const event of stream) {
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

const SUMMARIES_FILE = join(projectRoot, 'data', 'session-summaries.json')
const summaryCache = new Map<string, SummaryEntry>()

function loadSummaryCache(): void {
  try {
    const raw = readFileSync(SUMMARIES_FILE, 'utf-8')
    const entries: Array<[string, SummaryEntry]> = JSON.parse(raw)
    for (const [key, val] of entries) summaryCache.set(key, val)
    log.info(`Loaded ${summaryCache.size} session summaries from disk`)
  } catch { /* file doesn't exist yet */ }
}

function persistSummaryCache(): void {
  try {
    mkdirSync(dirname(SUMMARIES_FILE), { recursive: true })
    writeFileSync(SUMMARIES_FILE, JSON.stringify(Array.from(summaryCache.entries()), null, 2))
  } catch (e) {
    log.warn(`Failed to persist summaries: ${e}`)
  }
}

loadSummaryCache()

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
            lines.push({ role, text: cleaned.slice(0, 500) })
          }
        }
      }
    } catch { /* skip */ }
  }

  // 先頭15 + 末尾15（重複なし）
  const head = lines.slice(0, 15)
  const tail = lines.length > 30 ? lines.slice(-15) : lines.slice(15)
  const selected = [...head, ...tail]

  let transcript = ''
  for (const m of selected) {
    const prefix = m.role === 'user' ? 'User' : 'Assistant'
    transcript += `${prefix}: ${m.text}\n\n`
    if (transcript.length > 8000) break
  }

  return { transcript: transcript.slice(0, 8000), messageCount: lines.length }
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

  const claudeDir = join(homedir(), '.claude', 'projects', cwdToProjectDir(project))
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
    const cached = summaryCache.get(sessionId)
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
    summaryCache.set(sessionId, { summary, generatedAt: Date.now(), messageCount })
    persistSummaryCache()

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

  const claudeDir = join(homedir(), '.claude', 'projects', cwdToProjectDir(project))
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

