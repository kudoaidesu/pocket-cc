import { config } from './config.js'
import { createLogger } from './utils/logger.js'
import { startScheduler, stopScheduler, setProcessHandler } from './queue/scheduler.js'
import { getIssue } from './github/issues.js'
import { runTaicho } from './agents/taicho/index.js'
import type { ProgressReporter } from './agents/taicho/types.js'

const log = createLogger('main')

async function main(): Promise<void> {
  log.info('Issue AI Bot starting...')
  log.info(`LLM: Claude Code / ${config.llm.model}`)
  log.info(`Projects: ${config.projects.map((p) => p.slug).join(', ') || 'none'}`)
  log.info('GitHub: gh CLI (authenticated session)')
  log.info(`Cron schedule: ${config.cron.schedule}`)

  // キュー処理ハンドラ: タイチョーが Issue を自動実装 → Draft PR 作成
  setProcessHandler(async (issueNumber: number, repository: string, _queueItemId: string) => {
    const project = config.projects.find((p) => p.repo === repository)
    if (!project) {
      log.error(`No project config found for repository: ${repository}`)
      return
    }

    const issue = await getIssue(issueNumber, repository)
    log.info(`Processing Issue #${issueNumber} (${repository}): ${issue.title}`)

    const onProgress: ProgressReporter = (data) => {
      log.info(`[Progress] #${issueNumber} ${data.stage}: ${data.message}`)
    }

    const result = await runTaicho({ issue, project, onProgress })

    if (result.success) {
      const durationStr = result.durationMs
        ? ` (${Math.round(result.durationMs / 1000)}s)`
        : ''
      log.info(`Issue #${issueNumber} completed: ${result.prUrl}${durationStr}`)
    } else {
      log.error(`Issue #${issueNumber} failed: ${result.error} (retries: ${result.retryCount})`)
    }
  })

  // Cronスケジューラ起動
  startScheduler()
  log.info('Cron scheduler started')

  // Web UI は別プロセス: npm run web
  log.info('Web UI: run "npm run web" in a separate process')

  // Graceful shutdown
  const shutdown = async (): Promise<void> => {
    log.info('Shutting down...')
    stopScheduler()
    log.info('Goodbye')
    process.exit(0)
  }

  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

main().catch((err) => {
  log.error('Fatal error', err)
  process.exit(1)
})
