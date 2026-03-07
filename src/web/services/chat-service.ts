/**
 * チャットサービス — Agent SDK を Claude Code CLI 相当の設定で実行
 *
 * Hono ルートから分離し、テスト可能にした純粋なロジック層。
 * settingSources: ['project', 'user'] で CLAUDE.md / .claude/rules/ / ユーザー設定を自動読み込みし、
 * Claude Code CLI と同等の振る舞いを実現する。
 */
import { detectDanger } from '../danger-detect.js'
import { createLogger } from '../../utils/logger.js'
import { createPendingRequest, cleanupStreamRequests, type PermissionResult } from './permission-bridge.js'

const log = createLogger('web:chat-service')

// ── 型定義 ──────────────────────────────────────────

export interface ImageParam {
  name: string
  mediaType: string
  data: string  // base64 encoded
}

export interface ChatParams {
  message: string
  cwd: string
  model: string
  sessionId?: string
  planMode?: boolean
  permissionMode?: string
  images?: ImageParam[]
  agents?: Record<string, unknown>
  additionalDirectories?: string[]
  appendSystemPrompt?: string
}

export interface ToolDetail {
  name: string
  input?: Record<string, unknown>
  output?: string
}

export interface AskQuestionOption {
  label: string
  description: string
}

export interface AskQuestionItem {
  question: string
  header: string
  options: AskQuestionOption[]
  multiSelect: boolean
}

export type ChatEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'stream-start'; streamId: string }
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; status: string; detail?: ToolDetail }
  | { type: 'warning'; command: string; label: string }
  | { type: 'result'; text: string; sessionId: string; cost?: number; turns?: number; durationMs?: number; isError?: boolean }
  | { type: 'error'; message: string }
  | { type: 'status'; status: string; permissionMode?: string }
  | { type: 'compact'; trigger: string; preTokens?: number }
  | { type: 'tokenUsage'; inputTokens: number; contextWindow: number }
  | { type: 'ask-question'; requestId: string; questions: AskQuestionItem[] }
  | { type: 'tool-approval'; requestId: string; toolName: string; input: Record<string, unknown>; description?: string; decisionReason?: string }
  | { type: 'heartbeat' }

/** Agent SDK から返される生メッセージ */
export interface SdkMessage {
  type: string
  subtype?: string // 'init' | 'compact_boundary' | 'status' etc.
  session_id?: string
  status?: string
  permissionMode?: string
  compact_metadata?: { trigger?: string; pre_tokens?: number }
  message?: {
    role: string
    content: Array<{
      type: string
      text?: string
      name?: string
      input?: Record<string, unknown>
      content?: string | Array<{ type: string; text?: string }>
    }>
  }
  result?: string
  total_cost_usd?: number
  is_error?: boolean
  num_turns?: number
  duration_ms?: number
  usage?: { input_tokens?: number; output_tokens?: number }
  modelUsage?: Record<string, { inputTokens: number; contextWindow: number }>
  event?: {
    type: string
    delta?: { type: string; text?: string }
    content_block?: { type: string; name?: string }
    message?: { usage?: { input_tokens?: number } }
  }
}

// ── SDK ローダー ────────────────────────────────────

interface SdkModule {
  query: (params: { prompt: string | AsyncIterable<unknown>; options: Record<string, unknown> }) => AsyncIterable<SdkMessage>
}

let sdkModule: SdkModule | null = null

async function loadSdk(): Promise<SdkModule> {
  if (sdkModule) return sdkModule
  delete process.env.CLAUDECODE
  sdkModule = await import('@anthropic-ai/claude-agent-sdk') as SdkModule
  return sdkModule
}

// ── Query Options ビルダー（テスト可能） ──────────────

type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: Record<string, unknown>,
) => Promise<PermissionResult>

export function buildQueryOptions(
  params: ChatParams,
  canUseTool?: CanUseTool,
): Record<string, unknown> {
  // permissionMode mapping:
  //   'plan' → plan (計画モード、デフォルト)
  //   'ask'  → default (危険操作は承認要求、AskUserQuestion対応)
  //   'auto' → acceptEdits (編集のみ自動承認)
  //   'yolo' → bypassPermissions + dangerouslySkipPermissions (全自動)
  const mode = params.permissionMode || (params.planMode ? 'plan' : 'plan')
  const sdkMode = mode === 'plan' ? 'plan'
    : mode === 'ask' ? 'default'
    : mode === 'auto' ? 'acceptEdits'
    : mode === 'yolo' ? 'bypassPermissions'
    : 'plan'
  const options: Record<string, unknown> = {
    cwd: params.cwd,
    model: params.model,
    maxTurns: mode === 'yolo' ? 200 : 50,
    permissionMode: sdkMode,
    allowDangerouslySkipPermissions: mode === 'yolo',
    includePartialMessages: true,
    // Claude Code CLI 相当: プロジェクト設定 + ユーザー設定を自動読み込み
    settingSources: ['project', 'user'],
    // Claude Code 標準のシステムプロンプトをそのまま使用
    systemPrompt: { type: 'preset', preset: 'claude_code' },
  }

  if (canUseTool) {
    options.canUseTool = canUseTool
  }

  if (params.sessionId) {
    options.resume = params.sessionId
  }

  // マルチエージェント対応: フロントデスクモード時に注入
  if (params.agents) {
    options.agents = params.agents
  }
  if (params.additionalDirectories) {
    options.additionalDirectories = params.additionalDirectories
  }
  if (params.appendSystemPrompt) {
    options.appendSystemPrompt = params.appendSystemPrompt
  }

  return options
}

// ── SDK メッセージ → ChatEvent パーサー（テスト可能） ──

export function parseSdkMessage(msg: SdkMessage, currentSessionId: string): ChatEvent[] {
  const events: ChatEvent[] = []

  // セッションID取得（初回）
  if (msg.session_id && !currentSessionId) {
    events.push({ type: 'session', sessionId: msg.session_id })
  }

  // system/init
  if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) {
    events.push({ type: 'session', sessionId: msg.session_id })
  }

  // system/compact_boundary — コンパクティング完了
  if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
    events.push({
      type: 'compact',
      trigger: msg.compact_metadata?.trigger || 'auto',
      preTokens: msg.compact_metadata?.pre_tokens,
    })
  }

  // system/status — ステータス変更（compacting, permissionMode等）
  if (msg.type === 'system' && msg.subtype === 'status') {
    if (msg.status || msg.permissionMode) {
      events.push({ type: 'status', status: msg.status || '', permissionMode: msg.permissionMode })
    }
  }

  // ストリーミングテキスト
  if (msg.type === 'stream_event' && msg.event) {
    const evt = msg.event
    if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta' && evt.delta.text) {
      events.push({ type: 'text', text: evt.delta.text })
    }
    if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use' && evt.content_block.name) {
      events.push({ type: 'tool', name: evt.content_block.name, status: 'start' })
    }
  }

  // ツール詳細 + 危険コマンド検知
  if (msg.type === 'assistant' && msg.message?.content) {
    for (const block of msg.message.content) {
      if (block.type === 'tool_use' && block.name) {
        const detail: ToolDetail = { name: block.name, input: block.input }
        events.push({ type: 'tool', name: block.name, status: 'input', detail })

        if (block.name === 'Bash' && block.input) {
          const cmd = (block.input as Record<string, string>).command || ''
          const danger = detectDanger(cmd)
          if (danger) {
            log.warn(`Dangerous command executed: ${danger.label} — ${danger.command}`)
            events.push({ type: 'warning', command: danger.command, label: danger.label })
          }
        }
      }
      if (block.type === 'tool_result' && block.name) {
        const outputText = typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content)
            ? block.content.filter(c => c.type === 'text').map(c => c.text || '').join('\n')
            : ''
        const detail: ToolDetail = { name: block.name, output: outputText }
        events.push({ type: 'tool', name: block.name, status: 'output', detail })
      }
    }
  }

  // stream_event の message_start から中間トークン使用量を取得
  if (msg.type === 'stream_event' && msg.event?.type === 'message_start' && msg.event.message?.usage) {
    const u = msg.event.message.usage
    if (u.input_tokens) {
      // contextWindow は result まで不明なので 0 で仮送信（UI側で前回値を保持）
      events.push({ type: 'tokenUsage', inputTokens: u.input_tokens, contextWindow: 0 })
    }
  }

  // 最終結果
  if (msg.type === 'result') {
    const sessionId = msg.session_id || currentSessionId
    events.push({
      type: 'result',
      text: msg.result || '',
      sessionId,
      cost: msg.total_cost_usd,
      turns: msg.num_turns,
      durationMs: msg.duration_ms,
      isError: msg.is_error,
    })
    // result メッセージから modelUsage を抽出してトークン使用量を確定
    if (msg.modelUsage) {
      const models = Object.values(msg.modelUsage)
      if (models.length > 0) {
        const totalInput = models.reduce((sum, m) => sum + (m.inputTokens || 0), 0)
        const maxContextWindow = Math.max(...models.map(m => m.contextWindow || 0))
        if (maxContextWindow > 0) {
          events.push({ type: 'tokenUsage', inputTokens: totalInput, contextWindow: maxContextWindow })
        }
      }
    }
  }

  return events
}

// ── StreamBuffer — リコネクト対応イベントバッファ ──────

/**
 * SDKメッセージと canUseTool イベントをindex付きで蓄積するバッファ。
 * 複数リーダーが独立して読める（リコネクト時に新リーダーを作成）。
 */
class StreamBuffer {
  private events: Array<ChatEvent | null> = []
  private waiters: Array<() => void> = []

  push(event: ChatEvent | null) {
    this.events.push(event)
    const w = this.waiters
    this.waiters = []
    for (const wake of w) wake()
  }

  get length() { return this.events.length }

  async *read(fromIndex = 0): AsyncGenerator<{ event: ChatEvent; index: number }> {
    let cursor = fromIndex
    while (true) {
      if (cursor < this.events.length) {
        const event = this.events[cursor]
        if (event === null) return
        yield { event, index: cursor }
        cursor++
      } else {
        await new Promise<void>((resolve) => {
          this.waiters.push(resolve)
        })
      }
    }
  }
}

// ── Detached Stream 管理 ──────────────────────────────

interface DetachedStream {
  buffer: StreamBuffer
  abortController: AbortController
  heartbeatTimer: ReturnType<typeof setInterval>
  status: 'active' | 'done' | 'error'
  sessionId: string
  createdAt: number
  doneAt?: number
}

const detachedStreams = new Map<string, DetachedStream>()

const STREAM_TTL_MS = 3 * 60 * 1000

function cleanupOldStreams() {
  const now = Date.now()
  for (const [id, stream] of detachedStreams) {
    if (stream.doneAt && now - stream.doneAt > STREAM_TTL_MS) {
      clearInterval(stream.heartbeatTimer)
      detachedStreams.delete(id)
    }
  }
}

// 定期クリーンアップ（アイドル時もメモリ回収）
setInterval(cleanupOldStreams, 60_000)

// ── 中断管理 ─────────────────────────────────────────

export function abortStream(streamId: string): boolean {
  const stream = detachedStreams.get(streamId)
  if (stream) {
    stream.abortController.abort()
    clearInterval(stream.heartbeatTimer)
    stream.status = 'error'
    stream.doneAt = Date.now()
    // ブロック中のreaderを即座に起こす（SDKループの検知を待たない）
    stream.buffer.push({ type: 'error', message: 'Aborted by user' })
    stream.buffer.push(null)
    cleanupStreamRequests(streamId)
    return true
  }
  return false
}

export function getActiveStreamIds(): string[] {
  return Array.from(detachedStreams.entries())
    .filter(([, s]) => s.status === 'active')
    .map(([id]) => id)
}

// ── ストリームステータス ──────────────────────────────

export interface StreamStatusInfo {
  status: 'active' | 'done' | 'error'
  lastEventIndex: number
  sessionId: string
}

export function getStreamStatus(streamId: string): StreamStatusInfo | null {
  const stream = detachedStreams.get(streamId)
  if (!stream) return null
  return {
    status: stream.status,
    lastEventIndex: stream.buffer.length - 1,
    sessionId: stream.sessionId,
  }
}

// ── メインストリーム（Detached） ─────────────────────

const HEARTBEAT_INTERVAL_MS = 15_000

/**
 * SDKストリームを開始し、streamId を返す。
 * HTTP接続とSDK処理のライフサイクルを分離:
 * - HTTP接続が切れてもSDK処理は継続
 * - イベントはbufferに蓄積され、readStream() で任意位置から読める
 */
export async function startStream(params: ChatParams): Promise<string> {
  cleanupOldStreams()

  const sdk = await loadSdk()
  const abortController = new AbortController()
  const streamId = `stream-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const buffer = new StreamBuffer()

  const mode = params.permissionMode || 'plan'
  const needsCanUseTool = mode !== 'yolo'

  // canUseTool コールバック（yolo以外で注入）
  const canUseTool: CanUseTool | undefined = needsCanUseTool
    ? async (toolName, input, opts) => {
      const typedOpts = opts as { signal?: AbortSignal; decisionReason?: string }
      log.info(`[canUseTool] called: tool=${toolName} mode=${mode} reason=${typedOpts.decisionReason || '(none)'}`)
      const signal = typedOpts.signal
      const decisionReason = typedOpts.decisionReason

      if (toolName === 'AskUserQuestion') {
        const questions = ((input as { questions?: AskQuestionItem[] }).questions || []).map(q => ({
          question: q.question,
          header: q.header,
          options: q.options || [],
          multiSelect: !!q.multiSelect,
        }))
        const { requestId, promise } = createPendingRequest(streamId, toolName, input, signal)
        buffer.push({ type: 'ask-question', requestId, questions })
        return promise
      }

      // その他のツール承認
      const description = (input as { description?: string }).description
      const { requestId, promise } = createPendingRequest(streamId, toolName, input, signal)
      buffer.push({ type: 'tool-approval', requestId, toolName, input, description, decisionReason })
      return promise
    }
    : undefined

  const options = buildQueryOptions(params, canUseTool)
  options.abortController = abortController

  const imgCount = params.images?.length || 0
  log.info(`Chat request [${streamId}]: "${params.message.slice(0, 60)}..." cwd=${params.cwd} model=${params.model} mode=${mode} images=${imgCount}`)

  // streamId を最初のイベントとして蓄積
  buffer.push({ type: 'stream-start', streamId })

  // 画像がある場合はコンテンツブロック配列で送信（Agent SDK のマルチモーダル対応）
  let prompt: string | AsyncIterable<unknown>
  if (params.images && params.images.length > 0) {
    const content: Array<Record<string, unknown>> = []
    if (params.message) {
      content.push({ type: 'text', text: params.message })
    }
    for (const img of params.images) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: img.mediaType, data: img.data },
      })
    }
    async function* promptGen() {
      yield {
        type: 'user',
        message: { role: 'user', content },
      }
    }
    prompt = promptGen()
  } else {
    prompt = params.message
  }

  let sessionId = params.sessionId || ''

  // Heartbeat タイマー
  const heartbeatTimer = setInterval(() => {
    buffer.push({ type: 'heartbeat' })
  }, HEARTBEAT_INTERVAL_MS)

  // DetachedStream 登録
  const detached: DetachedStream = {
    buffer,
    abortController,
    heartbeatTimer,
    status: 'active',
    sessionId,
    createdAt: Date.now(),
  }
  detachedStreams.set(streamId, detached)

  // SDKストリーム消費を背景タスクで実行 → buffer に push
  const queryStream = sdk.query({ prompt, options })
  ;(async () => {
    try {
      for await (const msg of queryStream) {
        if (abortController.signal.aborted) {
          // abortStream() が既に error+null を push 済み → ここでは push しない
          break
        }
        const events = parseSdkMessage(msg, sessionId)
        for (const event of events) {
          if (event.type === 'session') {
            sessionId = event.sessionId
            detached.sessionId = sessionId
          }
          buffer.push(event)
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error(`SDK stream error [${streamId}]: ${message}`)
      buffer.push({ type: 'error', message })
      detached.status = 'error'
    }
    // ストリーム終了
    clearInterval(heartbeatTimer)
    if (detached.status === 'active') {
      detached.status = 'done'
    }
    // abortStream() で既に null push 済みでなければ終端を送る
    if (!detached.doneAt) {
      detached.doneAt = Date.now()
      buffer.push(null)
      cleanupStreamRequests(streamId)
    }
  })()

  return streamId
}

/**
 * バッファからイベントを読む AsyncGenerator。
 * fromIndex を指定すれば途中から読める（リコネクト対応）。
 */
export async function* readStream(streamId: string, fromIndex = 0): AsyncGenerator<{ event: ChatEvent; index: number }> {
  const stream = detachedStreams.get(streamId)
  if (!stream) return

  yield* stream.buffer.read(fromIndex)
}
