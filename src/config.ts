import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function optional(key: string, defaultValue: string): string {
  return process.env[key] ?? defaultValue
}

export type ChatModel = 'haiku' | 'sonnet' | 'opus'
export const VALID_CHAT_MODELS: readonly ChatModel[] = ['haiku', 'sonnet', 'opus'] as const

/** セレクトメニュー用モデル一覧（バージョン情報付き） */
export interface ModelOption {
  id: string
  label: string
  description: string
}

/**
 * 利用可能なモデル一覧。新モデルリリース時はここを更新する。
 * 参照: https://platform.claude.com/docs/en/about-claude/models/overview
 * id は Claude CLI の `--model` に渡す値（エイリアスまたはフルID）。
 */
export const MODEL_OPTIONS: readonly ModelOption[] = [
  // --- 最新モデル（エイリアス → 常に最新バージョンを指す） ---
  { id: 'opus', label: 'Opus 4.6 (最新)', description: '最高性能・エージェント向け' },
  { id: 'sonnet', label: 'Sonnet 4.6 (最新)', description: 'バランス型・高速+高性能' },
  { id: 'haiku', label: 'Haiku 4.5 (最新)', description: '最速・低コスト・雑談向け' },
  // --- 固定バージョン ---
  { id: 'claude-sonnet-4-5-20250929', label: 'Sonnet 4.5', description: '旧バージョン・安定' },
  { id: 'claude-opus-4-5-20251101', label: 'Opus 4.5', description: '旧バージョン・安定' },
  { id: 'claude-opus-4-1-20250805', label: 'Opus 4.1', description: '旧バージョン' },
  { id: 'claude-sonnet-4-20250514', label: 'Sonnet 4.0', description: '旧バージョン' },
  { id: 'claude-opus-4-20250514', label: 'Opus 4.0', description: '旧バージョン' },
] as const

/** MODEL_OPTIONS の最終更新日。古くなったらBot起動時に警告する */
export const MODEL_OPTIONS_UPDATED = '2026-02-23'

export interface ProjectConfig {
  slug: string
  repo: string
  localPath: string
  chatModel?: ChatModel
}

function loadProjects(): ProjectConfig[] {
  const projectsPath = resolve(process.cwd(), 'projects.json')
  try {
    const raw = readFileSync(projectsPath, 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      throw new Error('projects.json must be an array')
    }
    const projects = parsed as ProjectConfig[]
    for (const p of projects) {
      if (p.chatModel && !VALID_CHAT_MODELS.includes(p.chatModel)) {
        throw new Error(
          `Invalid chatModel "${p.chatModel}" in projects.json for project "${p.slug}". ` +
          `Valid values: ${VALID_CHAT_MODELS.join(', ')}`,
        )
      }
    }
    return projects
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw err
  }
}

export const config = {
  projects: loadProjects(),
  llm: {
    model: optional('LLM_MODEL', 'sonnet'),
  },
  chat: {
    defaultModel: optional('CHAT_MODEL', 'haiku') as ChatModel,
  },
  cron: {
    schedule: optional('CRON_SCHEDULE', '0 1 * * *'),
  },
  queue: {
    dataDir: optional('QUEUE_DATA_DIR', './data'),
    maxBatchSize: Number(optional('QUEUE_MAX_BATCH_SIZE', '5')),
    cooldownMs: Number(optional('QUEUE_COOLDOWN_MS', '60000')),
    maxRetries: Number(optional('QUEUE_MAX_RETRIES', '2')),
    retryBaseMs: Number(optional('QUEUE_RETRY_BASE_MS', '300000')),
  },
  taicho: {
    maxRetries: Number(optional('TAICHO_MAX_RETRIES', optional('CODER_MAX_RETRIES', '3'))),
    timeoutMs: Number(optional('TAICHO_TIMEOUT_MS', optional('CODER_TIMEOUT_MS', String(30 * 60 * 1000)))),
    strategy: optional('TAICHO_STRATEGY', 'claude-cli'),
  },
} as const

export function findProjectBySlug(slug: string): ProjectConfig | undefined {
  return config.projects.find((p) => p.slug === slug)
}

export function findProjectByRepo(repo: string): ProjectConfig | undefined {
  return config.projects.find((p) => p.repo === repo)
}
