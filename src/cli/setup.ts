import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const ENV_PATH = resolve(process.cwd(), '.env')

const rl = createInterface({ input: stdin, output: stdout })

function print(msg: string): void {
  stdout.write(`${msg}\n`)
}

function printHeader(): void {
  print('')
  print('╔══════════════════════════════════════╗')
  print('║       Issue AI Bot - Setup CLI       ║')
  print('╚══════════════════════════════════════╝')
  print('')
}

async function ask(question: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]` : ''
  const answer = await rl.question(`  ${question}${suffix}: `)
  return answer.trim() || defaultValue || ''
}

function checkCli(name: string, args: string[]): string | null {
  try {
    return execFileSync(name, args, { encoding: 'utf-8' }).trim()
  } catch {
    return null
  }
}

function checkPrerequisites(): void {
  print('── 前提ツール確認 ──')
  print('')

  // Claude Code CLI
  const claudeVersion = checkCli('claude', ['--version'])
  if (claudeVersion) {
    print(`  Claude Code CLI: ${claudeVersion}`)
  } else {
    print('  Claude Code CLI: 未インストール')
    print('    → npm install -g @anthropic-ai/claude-code && claude setup-token')
  }

  // gh CLI
  const ghVersion = checkCli('gh', ['--version'])
  if (ghVersion) {
    const firstLine = ghVersion.split('\n')[0]
    print(`  GitHub CLI: ${firstLine}`)

    // 認証状態チェック
    const authStatus = checkCli('gh', ['auth', 'status'])
    if (authStatus) {
      print('  GitHub CLI 認証: OK')
    } else {
      print('  GitHub CLI 認証: 未認証')
      print('    → gh auth login')
    }
  } else {
    print('  GitHub CLI: 未インストール')
    print('    → brew install gh && gh auth login')
  }

  print('')
}

async function setupLlm(): Promise<Record<string, string>> {
  print('')
  print('── Claude Code 設定 ──')
  print('  LLMはClaude Codeのサブスク枠を使用します。')
  print('  API Key不要 — claude CLIがインストール済みであればOK。')
  print('  用途に応じてCLI / SDKを直接呼び分けます。')
  print('')

  const model = await ask('使用モデル', 'sonnet')

  return {
    LLM_MODEL: model,
  }
}

async function setupCron(): Promise<Record<string, string>> {
  print('')
  print('── Cron スケジュール設定 ──')
  print('  Cron式の例: 0 22 * * * (毎日22:00)')
  print('')

  const schedule = await ask('キュー処理スケジュール', '0 22 * * *')
  const report = await ask('レポートスケジュール', '0 8 * * *')

  return {
    CRON_SCHEDULE: schedule,
    CRON_REPORT_SCHEDULE: report,
  }
}

function loadExistingEnv(): Record<string, string> {
  if (!existsSync(ENV_PATH)) return {}

  const content = readFileSync(ENV_PATH, 'utf-8')
  const env: Record<string, string> = {}

  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIndex = trimmed.indexOf('=')
    if (eqIndex === -1) continue
    const key = trimmed.slice(0, eqIndex)
    const value = trimmed.slice(eqIndex + 1)
    env[key] = value
  }

  return env
}

function writeEnv(env: Record<string, string>): void {
  const sections: { header: string; keys: string[] }[] = [
    { header: '# Claude Code', keys: ['LLM_MODEL'] },
    { header: '# Cron', keys: ['CRON_SCHEDULE', 'CRON_REPORT_SCHEDULE'] },
    { header: '# Queue', keys: ['QUEUE_DATA_DIR'] },
  ]

  const lines: string[] = []
  const written = new Set<string>()

  for (const section of sections) {
    const sectionLines: string[] = []
    for (const key of section.keys) {
      if (env[key] !== undefined && env[key] !== '') {
        sectionLines.push(`${key}=${env[key]}`)
        written.add(key)
      }
    }
    if (sectionLines.length > 0) {
      lines.push(section.header)
      lines.push(...sectionLines)
      lines.push('')
    }
  }

  for (const [key, value] of Object.entries(env)) {
    if (!written.has(key) && value) {
      lines.push(`${key}=${value}`)
    }
  }

  writeFileSync(ENV_PATH, lines.join('\n'), 'utf-8')
}

export async function runSetup(): Promise<void> {
  printHeader()
  checkPrerequisites()

  const existing = loadExistingEnv()
  if (Object.keys(existing).length > 0) {
    print('  既存の .env ファイルが見つかりました。')
    const overwrite = await ask('上書きしますか? (y/N)', 'n')
    if (overwrite.toLowerCase() !== 'y') {
      print('  セットアップを中断しました。')
      rl.close()
      return
    }
  }

  const env: Record<string, string> = {}

  // 1. Claude Code設定
  const llmEnv = await setupLlm()
  Object.assign(env, llmEnv)

  // 2. Cron設定
  const cronEnv = await setupCron()
  Object.assign(env, cronEnv)

  // 3. デフォルト値
  env.QUEUE_DATA_DIR = './data'

  // 書き込み
  writeEnv(env)

  print('')
  print('── セットアップ完了 ──')
  print(`  .env ファイルを保存しました: ${ENV_PATH}`)
  print('')
  print('  前提条件:')
  print('    1. claude CLI がインストール・認証済み')
  print('       npm i -g @anthropic-ai/claude-code && claude setup-token')
  print('    2. gh CLI がインストール・認証済み')
  print('       brew install gh && gh auth login')
  print('')
  print('  GitHub Token は不要です。gh CLI の認証セッションを使用します。')
  print('')
  print('  起動方法:')
  print('    npm run dev     (開発モード)')
  print('    npm run build && npm run start  (本番)')
  print('')

  rl.close()
}
