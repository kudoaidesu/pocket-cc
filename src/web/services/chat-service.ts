/**
 * チャットサービス — Agent SDK を Claude Code CLI 相当の設定で実行
 *
 * Hono ルートから分離し、テスト可能にした純粋なロジック層。
 * settingSources: ['project', 'user'] で CLAUDE.md / .claude/rules/ / ユーザー設定を自動読み込みし、
 * Claude Code CLI と同等の振る舞いを実現する。
 */
import { detectDanger } from '../danger-detect.js'
import { createLogger } from '../../utils/logger.js'

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
}

export interface ToolDetail {
  name: string
  input?: Record<string, unknown>
  output?: string
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

export function buildQueryOptions(params: ChatParams): Record<string, unknown> {
  // permissionMode mapping:
  //   'default'     → bypassPermissions (個人サーバー用、明示選択のみ)
  //   'plan'        → plan (計画モード、デフォルト)
  //   'auto-accept' → acceptEdits (編集のみ自動承認)
  //   'yolo'        → bypassPermissions + dangerouslySkipPermissions (全ツール無制限)
  const mode = params.permissionMode || (params.planMode ? 'plan' : 'plan')
  const sdkMode = mode === 'plan' ? 'plan'
    : mode === 'auto-accept' ? 'acceptEdits'
    : mode === 'default' ? 'bypassPermissions'
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

  if (params.sessionId) {
    options.resume = params.sessionId
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

// ── 中断管理 ─────────────────────────────────────────

const activeStreams = new Map<string, AbortController>()

export function abortStream(streamId: string): boolean {
  const controller = activeStreams.get(streamId)
  if (controller) {
    controller.abort()
    activeStreams.delete(streamId)
    return true
  }
  return false
}

export function getActiveStreamIds(): string[] {
  return Array.from(activeStreams.keys())
}

// ── メインストリーム ─────────────────────────────────

export async function* createChatStream(params: ChatParams): AsyncGenerator<ChatEvent> {
  const sdk = await loadSdk()
  const options = buildQueryOptions(params)
  const abortController = new AbortController()
  const streamId = `stream-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  activeStreams.set(streamId, abortController)

  // AbortSignal を options に追加
  options.abortController = abortController

  const imgCount = params.images?.length || 0
  log.info(`Chat request [${streamId}]: "${params.message.slice(0, 60)}..." cwd=${params.cwd} model=${params.model} images=${imgCount}`)

  // streamId を最初に通知
  yield { type: 'stream-start', streamId } as ChatEvent

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

  const queryStream = sdk.query({ prompt, options })
  let sessionId = params.sessionId || ''

  try {
    for await (const msg of queryStream) {
      if (abortController.signal.aborted) {
        yield { type: 'error', message: 'Aborted by user' }
        break
      }
      const events = parseSdkMessage(msg, sessionId)
      for (const event of events) {
        if (event.type === 'session') {
          sessionId = event.sessionId
        }
        yield event
      }
    }
  } finally {
    activeStreams.delete(streamId)
  }
}
