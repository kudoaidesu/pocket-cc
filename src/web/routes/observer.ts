/**
 * Observer API — セッション階層の読み取り専用ビューア
 *
 * Agent SDKが保存するJSONLセッションファイルを解析し、
 * 親セッション↔subagentの階層構造を5層モデルで可視化するためのAPI。
 */
import { Hono } from 'hono'
import { readdirSync, statSync, existsSync, createReadStream, openSync, readSync, closeSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'
import { isValidSessionId, isProjectPathAllowed } from '../path-guard.js'
import { cwdToProjectDir, cleanPreview } from './chat.js'
import { detectDanger } from '../danger-detect.js'
import { runClaudeCli } from '../../llm/claude-cli.js'

// ── 型定義 ──────────────────────────────────────────

interface SessionItem {
  sessionId: string
  preview: string
  lastUsed: number
  subagentCount: number
  fileSize: number
}

interface TreeNode {
  id: string
  label: string
  subagentType?: string
  model?: string
  messageCount: number
  toolUseCount: number
  children: TreeNode[]
  timestamp?: string
}

interface NodeDetail {
  meta: {
    id: string
    model?: string
    messageCount: number
    nodeType: 'root' | 'subagent'
    subagentType?: string      // Explore / Plan / Code 等
    parentInstruction?: string // 親からこのノードに渡されたプロンプト
  }
  interface: {
    messages: Array<{ role: 'user' | 'assistant'; text: string; timestamp?: string }>
  }
  orchestration: {
    delegations: Array<{
      description: string
      subagentType: string
      prompt: string
      agentId?: string
      timestamp?: string
    }>
  }
  execution: {
    tools: Array<{ name: string; summary: string; timestamp?: string }>
    summary: Record<string, number>
  }
  state: {
    models: string[]
    duration?: { first: string; last: string }
    compactEvents: number
  }
  governance: {
    dangerousCommands: Array<{ command: string; label: string; timestamp?: string }>
    errors: string[]
  }
}

// ── JSONL レコード型 ────────────────────────────────

interface JsonlContent {
  type: string
  text?: string
  name?: string
  id?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string | Array<{ type: string; text?: string }>
}

interface JsonlRecord {
  type?: string
  isSidechain?: boolean
  agentId?: string
  sessionId?: string
  timestamp?: string
  parentToolUseID?: string
  message?: {
    role?: string
    model?: string
    content?: JsonlContent[]
    usage?: Record<string, unknown>
  }
  data?: {
    type?: string
    agentId?: string
  }
  compact_metadata?: { trigger?: string; pre_tokens?: number }
  subtype?: string
}

// ── agentId バリデーション ───────────────────────────

function isValidAgentId(agentId: string): boolean {
  return /^[a-f0-9]+$/.test(agentId) && agentId.length <= 40
}

// ── セッション一覧スキャン ──────────────────────────

let sessionsCache: { cwd: string; data: SessionItem[]; ts: number } | null = null
const CACHE_TTL = 5000

function scanObserverSessions(cwd: string): SessionItem[] {
  if (sessionsCache && sessionsCache.cwd === cwd && Date.now() - sessionsCache.ts < CACHE_TTL) {
    return sessionsCache.data
  }

  const claudeDir = join(homedir(), '.claude', 'projects', cwdToProjectDir(cwd))
  const results: SessionItem[] = []

  try {
    const entries = readdirSync(claudeDir, { withFileTypes: true })
    const jsonlFiles = entries.filter(e => !e.isDirectory() && e.name.endsWith('.jsonl'))

    // stat + ソート（最新50件）
    const fileStats = jsonlFiles.map(f => {
      try {
        const s = statSync(join(claudeDir, f.name))
        return { file: f.name, mtime: s.mtimeMs, size: s.size }
      } catch { return null }
    }).filter((x): x is { file: string; mtime: number; size: number } => x !== null)
    fileStats.sort((a, b) => b.mtime - a.mtime)

    for (const { file, mtime, size } of fileStats.slice(0, 50)) {
      const sessionId = file.replace('.jsonl', '')

      // subagent数をカウント
      let subagentCount = 0
      const subagentDir = join(claudeDir, sessionId, 'subagents')
      try {
        if (existsSync(subagentDir)) {
          subagentCount = readdirSync(subagentDir).filter(f => f.endsWith('.jsonl')).length
        }
      } catch { /* skip */ }

      // 最初のユーザーメッセージをプレビュー取得（高速: 先頭8KBのみ）
      let preview = ''
      try {
        const chunkSize = 8192
        const buf = Buffer.alloc(chunkSize)
        const fd = openSync(join(claudeDir, file), 'r')
        const decoder = new TextDecoder('utf-8')
        let pos = 0
        const maxScan = Math.min(size, 256 * 1024)
        let partial = ''
        scanLoop:
        while (pos < maxScan) {
          const bytesRead = readSync(fd, buf, 0, chunkSize, pos)
          if (bytesRead === 0) break
          pos += bytesRead
          partial += decoder.decode(buf.subarray(0, bytesRead), { stream: pos < maxScan })
          const lines = partial.split('\n')
          partial = lines.pop() || ''
          for (const line of lines) {
            if (!line.includes('"type":"user"')) continue
            try {
              const obj = JSON.parse(line) as JsonlRecord
              if (obj.type === 'user' && obj.message?.content) {
                const textContent = obj.message.content.find(
                  (c) => c.type === 'text'
                )
                if (textContent?.text) {
                  const cleaned = cleanPreview(textContent.text)
                  if (cleaned) { preview = cleaned; break scanLoop }
                }
              }
            } catch { /* skip */ }
          }
        }
        closeSync(fd)
      } catch { /* skip */ }

      results.push({
        sessionId,
        preview: preview || 'Untitled',
        lastUsed: mtime,
        subagentCount,
        fileSize: size,
      })
    }
  } catch { /* dir doesn't exist */ }

  sessionsCache = { cwd, data: results, ts: Date.now() }
  return results
}

// ── ツリー構築 ──────────────────────────────────────

async function buildSessionTree(sessionId: string, claudeDir: string): Promise<TreeNode> {
  const filePath = join(claudeDir, `${sessionId}.jsonl`)

  // 親セッションをスキャン
  let messageCount = 0
  let toolUseCount = 0
  let rootLabel = ''
  let rootModel = ''
  let rootTimestamp = ''
  const agentToolUses: Array<{
    toolUseId: string
    description: string
    subagentType: string
    prompt?: string
    timestamp?: string
  }> = []
  // progress entries から agentId → toolUseId を収集（subagent紐付け用）
  const agentIdToToolUseId = new Map<string, string>()

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  })

  for await (const line of rl) {
    if (!line.trim()) continue
    try {
      const record = JSON.parse(line) as JsonlRecord
      if (!record.type || !record.message?.content) continue

      if (!rootTimestamp && record.timestamp) {
        rootTimestamp = record.timestamp
      }

      if (record.type === 'user') {
        // tool_resultでないユーザーメッセージをカウント
        const hasToolResult = record.message.content.some(c => c.type === 'tool_result')
        if (!hasToolResult) {
          messageCount++
          if (!rootLabel) {
            const text = record.message.content.find(c => c.type === 'text')
            if (text?.text) {
              // cleanPreview が空を返す場合（IDE contextのみ）はスキップして次を探す
              const cleaned = cleanPreview(text.text)
              if (cleaned) rootLabel = cleaned
            }
          }
        }
      }

      if (record.type === 'assistant') {
        messageCount++
        if (!rootModel && record.message.model) {
          rootModel = record.message.model
        }
        for (const block of record.message.content) {
          if (block.type === 'tool_use' && block.name) {
            if (block.name === 'Agent' && block.input) {
              agentToolUses.push({
                toolUseId: block.id || '',
                description: (block.input.description as string) || '',
                subagentType: (block.input.subagent_type as string) || 'general-purpose',
                prompt: (block.input.prompt as string) || '',
                timestamp: record.timestamp,
              })
            } else {
              toolUseCount++
            }
          }
        }
      }

      // progress エントリから agentId → parentToolUseID のマッピングを収集
      if (record.type === 'progress' && record.data?.agentId && record.parentToolUseID) {
        agentIdToToolUseId.set(record.data.agentId, record.parentToolUseID)
      }
    } catch { /* skip */ }
  }

  // toolUseId → agentToolUse のマップを作成
  const toolUseMap = new Map(agentToolUses.map(a => [a.toolUseId, a]))
  // prompt → agentToolUse のマップ（progress未記録のサブエージェント用フォールバック）
  const promptToEntry = new Map(agentToolUses.filter(a => a.prompt).map(a => [a.prompt!, a]))

  // subagent ファイルをスキャン（mtime順でソートして順序を保持）
  const children: TreeNode[] = []
  const subagentDir = join(claudeDir, sessionId, 'subagents')
  try {
    if (existsSync(subagentDir)) {
      const subFiles = readdirSync(subagentDir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => {
          try { return { f, mtime: statSync(join(subagentDir, f)).mtimeMs } } catch { return null }
        })
        .filter((x): x is { f: string; mtime: number } => x !== null)
        .sort((a, b) => a.mtime - b.mtime)
        .map(x => x.f)

      for (const sf of subFiles) {
        const agentId = sf.replace('.jsonl', '').replace('agent-', '')
        const subPath = join(subagentDir, sf)
        // agentId から toolUseId を引き、そこから description を取得
        const toolUseId = agentIdToToolUseId.get(agentId)
        let parentAgentEntry = toolUseId ? toolUseMap.get(toolUseId) : undefined

        // progress エントリがない場合（並列実行など）: サブエージェントの最初のメッセージ内容でマッチング
        if (!parentAgentEntry) {
          try {
            const firstLine = readFileSync(subPath, 'utf-8').split('\n')[0]
            if (firstLine) {
              const firstRecord = JSON.parse(firstLine) as JsonlRecord
              const content = firstRecord.message?.content
              if (typeof content === 'string' && content) {
                parentAgentEntry = promptToEntry.get(content)
              }
            }
          } catch { /* skip */ }
        }

        const child = await parseSubagentSummary(agentId, subPath, parentAgentEntry)
        children.push(child)
      }
    }
  } catch { /* skip */ }

  return {
    id: 'root',
    label: rootLabel || 'Untitled',
    model: rootModel,
    messageCount,
    toolUseCount,
    children,
    timestamp: rootTimestamp,
  }
}

async function parseSubagentSummary(
  agentId: string,
  filePath: string,
  parentEntry?: { toolUseId: string; description: string; subagentType: string }
): Promise<TreeNode> {
  let messageCount = 0
  let toolUseCount = 0
  let model = ''
  let timestamp = ''

  // 親のエントリから直接 label と type を取得（最優先）
  const label = parentEntry?.description || agentId.slice(0, 12)
  const subagentType = parentEntry?.subagentType || 'general-purpose'

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  })

  for await (const line of rl) {
    if (!line.trim()) continue
    try {
      const record = JSON.parse(line) as JsonlRecord

      // progress エントリはスキップ
      if (record.type === 'progress') continue

      if (!timestamp && record.timestamp) {
        timestamp = record.timestamp
      }

      if (record.type === 'user' && record.message?.content) {
        const hasToolResult = record.message.content.some(c => c.type === 'tool_result')
        if (!hasToolResult) messageCount++
      }

      if (record.type === 'assistant' && record.message?.content) {
        messageCount++
        if (!model && record.message.model) {
          model = record.message.model
        }
        for (const block of record.message.content) {
          if (block.type === 'tool_use' && block.name && block.name !== 'Agent') {
            toolUseCount++
          }
        }
      }
    } catch { /* skip */ }
  }

  return {
    id: agentId,
    label,
    subagentType,
    model,
    messageCount,
    toolUseCount,
    children: [], // ネストされたsubagentは将来対応
    timestamp,
  }
}

// ── ノード詳細（5層解析） ───────────────────────────

const LAYER_LIMIT = 100

async function extractNodeDetail(filePath: string, nodeId: string, isSubagent: boolean): Promise<NodeDetail> {
  const detail: NodeDetail = {
    meta: { id: nodeId, messageCount: 0, nodeType: isSubagent ? 'subagent' : 'root' },
    interface: { messages: [] },
    orchestration: { delegations: [] },
    execution: { tools: [], summary: {} },
    state: { models: [], compactEvents: 0 },
    governance: { dangerousCommands: [], errors: [] },
  }

  const modelsSet = new Set<string>()
  let firstTimestamp = ''
  let lastTimestamp = ''
  let isFirstLine = true

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  })

  for await (const line of rl) {
    if (!line.trim()) continue
    try {
      const record = JSON.parse(line) as JsonlRecord

      // サブエージェントの最初の user メッセージ: content が文字列 = 親からの prompt
      if (isFirstLine && isSubagent && record.type === 'user') {
        isFirstLine = false
        // サブエージェントの第1行は content が string（Agent SDKの仕様）
        const rawContent = (record.message as { content?: unknown })?.content
        if (typeof rawContent === 'string' && rawContent) {
          detail.meta.parentInstruction = rawContent.slice(0, 2000)
        }
      }
      isFirstLine = false

      // progress エントリはスキップ
      if (record.type === 'progress') continue

      // system イベント（compact等）
      if (record.type === 'system') {
        if (record.subtype === 'compact_boundary') {
          detail.state.compactEvents++
        }
        continue
      }

      if (!record.message?.content) continue

      // タイムスタンプ追跡
      if (record.timestamp) {
        if (!firstTimestamp) firstTimestamp = record.timestamp
        lastTimestamp = record.timestamp
      }

      // モデル追跡
      if (record.message.model) {
        modelsSet.add(record.message.model)
      }

      // ── ユーザーメッセージ ──
      if (record.type === 'user') {
        for (const block of record.message.content) {
          // Layer 1: Interface — テキストメッセージ
          if (block.type === 'text' && block.text && detail.interface.messages.length < LAYER_LIMIT) {
            detail.meta.messageCount++
            detail.interface.messages.push({
              role: 'user',
              text: block.text.slice(0, 2000),
              timestamp: record.timestamp,
            })
          }
        }
      }

      // ── アシスタントメッセージ ──
      if (record.type === 'assistant') {
        for (const block of record.message.content) {
          // Layer 1: Interface — テキスト
          if (block.type === 'text' && block.text && detail.interface.messages.length < LAYER_LIMIT) {
            detail.meta.messageCount++
            detail.interface.messages.push({
              role: 'assistant',
              text: block.text.slice(0, 2000),
              timestamp: record.timestamp,
            })
          }

          // tool_use ブロック
          if (block.type === 'tool_use' && block.name) {
            if (block.name === 'Agent' && block.input) {
              // Layer 2: Orchestration
              if (detail.orchestration.delegations.length < LAYER_LIMIT) {
                detail.orchestration.delegations.push({
                  description: (block.input.description as string) || '',
                  subagentType: (block.input.subagent_type as string) || 'general-purpose',
                  prompt: ((block.input.prompt as string) || '').slice(0, 500),
                  timestamp: record.timestamp,
                })
              }
            } else {
              // Layer 3: Execution
              const toolName = block.name
              detail.execution.summary[toolName] = (detail.execution.summary[toolName] || 0) + 1

              if (detail.execution.tools.length < LAYER_LIMIT) {
                let summary = ''
                if (block.input) {
                  if (toolName === 'Bash' && block.input.command) {
                    summary = (block.input.command as string).slice(0, 200)
                  } else if (toolName === 'Read' && block.input.file_path) {
                    summary = block.input.file_path as string
                  } else if ((toolName === 'Edit' || toolName === 'Write') && block.input.file_path) {
                    summary = block.input.file_path as string
                  } else if ((toolName === 'Glob') && block.input.pattern) {
                    summary = block.input.pattern as string
                  } else if ((toolName === 'Grep') && block.input.pattern) {
                    summary = block.input.pattern as string
                  } else {
                    summary = JSON.stringify(block.input).slice(0, 150)
                  }
                }

                detail.execution.tools.push({
                  name: toolName,
                  summary,
                  timestamp: record.timestamp,
                })

                // Layer 5: Governance — 危険コマンド検知
                if (toolName === 'Bash' && block.input?.command) {
                  const danger = detectDanger(block.input.command as string)
                  if (danger) {
                    detail.governance.dangerousCommands.push({
                      ...danger,
                      timestamp: record.timestamp,
                    })
                  }
                }
              }
            }
          }
        }
      }
    } catch { /* skip malformed */ }
  }

  // State 層のまとめ
  detail.state.models = Array.from(modelsSet)
  if (firstTimestamp && lastTimestamp) {
    detail.state.duration = { first: firstTimestamp, last: lastTimestamp }
  }
  if (!detail.meta.model && modelsSet.size > 0) {
    detail.meta.model = Array.from(modelsSet)[0]
  }

  return detail
}

// ── ルート定義 ──────────────────────────────────────

export const observerRoutes = new Hono()

// GET /api/observe/sessions — セッション一覧
observerRoutes.get('/sessions', (c) => {
  const project = c.req.query('project')
  if (!project) return c.json({ error: 'project is required' }, 400)
  if (!isProjectPathAllowed(project)) {
    return c.json({ error: 'Access denied: path outside allowed projects' }, 403)
  }

  const items = scanObserverSessions(project)
  return c.json({ items })
})

// GET /api/observe/tree/:sessionId — セッションツリー
observerRoutes.get('/tree/:sessionId', async (c) => {
  const sessionId = c.req.param('sessionId')
  const project = c.req.query('project')

  if (!project) return c.json({ error: 'project is required' }, 400)
  if (!isProjectPathAllowed(project)) {
    return c.json({ error: 'Access denied' }, 403)
  }
  if (!isValidSessionId(sessionId)) {
    return c.json({ error: 'Invalid sessionId' }, 400)
  }

  const claudeDir = join(homedir(), '.claude', 'projects', cwdToProjectDir(project))
  const filePath = join(claudeDir, `${sessionId}.jsonl`)

  if (!existsSync(filePath)) {
    return c.json({ error: 'Session not found' }, 404)
  }

  try {
    const tree = await buildSessionTree(sessionId, claudeDir)
    return c.json(tree)
  } catch (e) {
    return c.json({ error: `Failed to build tree: ${e}` }, 500)
  }
})

// GET /api/observe/node/:sessionId — ノード詳細（5層）
observerRoutes.get('/node/:sessionId', async (c) => {
  const sessionId = c.req.param('sessionId')
  const agentId = c.req.query('agentId')
  const project = c.req.query('project')

  if (!project) return c.json({ error: 'project is required' }, 400)
  if (!isProjectPathAllowed(project)) {
    return c.json({ error: 'Access denied' }, 403)
  }
  if (!isValidSessionId(sessionId)) {
    return c.json({ error: 'Invalid sessionId' }, 400)
  }

  const claudeDir = join(homedir(), '.claude', 'projects', cwdToProjectDir(project))
  let filePath: string

  if (agentId) {
    if (!isValidAgentId(agentId)) {
      return c.json({ error: 'Invalid agentId' }, 400)
    }
    filePath = join(claudeDir, sessionId, 'subagents', `agent-${agentId}.jsonl`)
  } else {
    filePath = join(claudeDir, `${sessionId}.jsonl`)
  }

  if (!existsSync(filePath)) {
    return c.json({ error: 'Session file not found' }, 404)
  }

  try {
    const detail = await extractNodeDetail(filePath, agentId || 'root', !!agentId)
    // subagentType は tree データから取得できるが、APIではフロントが渡す
    if (agentId) {
      const subagentType = c.req.query('subagentType')
      if (subagentType) detail.meta.subagentType = subagentType
    }
    return c.json(detail)
  } catch (e) {
    return c.json({ error: `Failed to extract detail: ${e}` }, 500)
  }
})

// POST /api/observe/translate — テキストを日本語に翻訳
observerRoutes.post('/translate', async (c) => {
  const body = await c.req.json<{ text: string }>()
  if (!body.text) return c.json({ error: 'text is required' }, 400)

  try {
    const result = await runClaudeCli({
      prompt: `以下のテキストを自然な日本語に翻訳してください。翻訳文のみを出力してください（説明や前置きは不要）:\n\n${body.text}`,
      model: 'claude-haiku-4-5-20251001',
      skipPermissions: true,
      allowedTools: [],
      timeoutMs: 30_000,
    })
    return c.json({ translated: result.content.trim() })
  } catch (e) {
    return c.json({ error: `Translation failed: ${e}` }, 500)
  }
})
