import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { config } from '../../config.js'
import { addComment } from '../../github/issues.js'
import { createLogger } from '../../utils/logger.js'
import { appendAudit } from '../../utils/audit.js'
import { recordEvaluation } from '../../utils/cost-tracker.js'
import type { TaichoInput, TaichoResult } from './types.js'

const execFileAsync = promisify(execFile)
import {
  generateBranchName,
  getBaseBranch,
  ensureCleanWorkingTree,
  createFeatureBranch,
  hasNewCommits,
  pushBranch,
  createDraftPR,
  cleanupBranch,
  resetToBase,
} from './git.js'
import { getStrategy, getDefaultStrategy } from './strategies/index.js'

const log = createLogger('taicho')

async function getDiffstat(cwd: string, baseBranch: string): Promise<{ linesAdded: number; linesRemoved: number; filesChanged: number }> {
  try {
    const { stdout } = await execFileAsync('git', ['diff', '--shortstat', baseBranch], { cwd })
    const filesMatch = stdout.match(/(\d+) file/)
    const addMatch = stdout.match(/(\d+) insertion/)
    const delMatch = stdout.match(/(\d+) deletion/)
    return {
      filesChanged: filesMatch ? Number(filesMatch[1]) : 0,
      linesAdded: addMatch ? Number(addMatch[1]) : 0,
      linesRemoved: delMatch ? Number(delMatch[1]) : 0,
    }
  } catch {
    return { linesAdded: 0, linesRemoved: 0, filesChanged: 0 }
  }
}

export async function runTaicho(input: TaichoInput): Promise<TaichoResult> {
  const { issue, project } = input
  const startTime = Date.now()
  const maxRetries = config.taicho.maxRetries

  const strategy = input.strategy
    ? getStrategy(input.strategy)
    : getDefaultStrategy()

  log.info(`Starting taicho for Issue #${issue.number} (${project.repo}) [strategy: ${strategy.name}]`)

  appendAudit({
    action: 'taicho_start',
    actor: 'taicho',
    detail: `Issue #${issue.number}: ${issue.title} (${project.repo}) [strategy: ${strategy.name}]`,
    result: 'allow',
  })

  const branchName = generateBranchName(issue.number, issue.title)
  let baseBranch: string

  void input.onProgress?.({ stage: 'setup', message: 'Git セットアップ中...' })

  try {
    baseBranch = await getBaseBranch(project.localPath)
    await ensureCleanWorkingTree(project.localPath)
    await createFeatureBranch(project.localPath, branchName, baseBranch)
  } catch (err) {
    const error = `Git setup failed: ${(err as Error).message}`
    log.error(error)
    void input.onProgress?.({ stage: 'failed', message: error, error })
    return { success: false, error, retryCount: 0, durationMs: Date.now() - startTime }
  }

  let lastError = ''

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      log.info(`Attempt ${attempt + 1}/${maxRetries} for Issue #${issue.number}`)

      void input.onProgress?.({
        stage: 'coding',
        message: `タイチョーがコード生成中... (試行 ${attempt + 1}/${maxRetries})`,
        attempt: attempt + 1,
        maxAttempts: maxRetries,
      })

      await strategy.execute({
        issue,
        project,
        baseBranch,
        branchName,
        attempt: attempt + 1,
        maxAttempts: maxRetries,
      })

      // コミットが生成されたか確認
      void input.onProgress?.({ stage: 'verifying', message: 'コミットを確認中...' })

      const hasCommits = await hasNewCommits(project.localPath, baseBranch)
      if (!hasCommits) {
        throw new Error('Strategy produced no code changes')
      }

      // Push & PR 作成
      void input.onProgress?.({ stage: 'pushing', message: 'PR を作成中...' })

      await pushBranch(project.localPath, branchName)
      const prUrl = await createDraftPR(project.repo, branchName, baseBranch, issue)

      // Issue にコメント追加
      await addComment(
        issue.number,
        `タイチョーが Draft PR を作成しました: ${prUrl}`,
        project.repo,
      )

      const durationMs = Date.now() - startTime
      const diffstat = await getDiffstat(project.localPath, baseBranch)

      // 評価レコードを記録
      const difficultyLabel = issue.labels?.find((l) => /^difficulty:/.test(l))?.replace('difficulty:', '') as string | undefined
      recordEvaluation({
        issueNumber: issue.number,
        repository: project.repo,
        strategy: strategy.name,
        difficulty: difficultyLabel,
        success: true,
        durationMs,
        retryCount: attempt,
        linesAdded: diffstat.linesAdded,
        linesRemoved: diffstat.linesRemoved,
        filesChanged: diffstat.filesChanged,
        prUrl,
      })

      appendAudit({
        action: 'taicho_complete',
        actor: 'taicho',
        detail: `Issue #${issue.number}: PR ${prUrl} (strategy: ${strategy.name}, duration: ${Math.round(durationMs / 1000)}s, attempts: ${attempt + 1})`,
        result: 'allow',
      })

      log.info(`Taicho completed for Issue #${issue.number}: ${prUrl}`)

      void input.onProgress?.({
        stage: 'done',
        message: `完了: ${prUrl}`,
        prUrl,
        durationMs,
      })

      return {
        success: true,
        prUrl,
        branchName,
        durationMs,
        retryCount: attempt,
      }
    } catch (err) {
      lastError = (err as Error).message
      log.warn(`Attempt ${attempt + 1}/${maxRetries} failed: ${lastError}`)

      if (attempt < maxRetries - 1) {
        // リトライ前にブランチをリセット
        void input.onProgress?.({
          stage: 'retrying',
          message: `リトライ準備中... (${attempt + 2}/${maxRetries})`,
          attempt: attempt + 2,
          maxAttempts: maxRetries,
        })

        try {
          await resetToBase(project.localPath, baseBranch)
        } catch (resetErr) {
          log.error(`Reset failed: ${(resetErr as Error).message}`)
          break
        }
      }
    }
  }

  // 全リトライ失敗
  await cleanupBranch(project.localPath, baseBranch, branchName)

  const durationMs = Date.now() - startTime
  const error = `Failed after ${maxRetries} attempts. Last error: ${lastError}`

  // 失敗の評価レコードを記録
  const difficultyLabel = issue.labels?.find((l) => /^difficulty:/.test(l))?.replace('difficulty:', '') as string | undefined
  recordEvaluation({
    issueNumber: issue.number,
    repository: project.repo,
    strategy: strategy.name,
    difficulty: difficultyLabel,
    success: false,
    durationMs,
    retryCount: maxRetries,
  })

  void input.onProgress?.({
    stage: 'failed',
    message: `失敗: ${lastError}`,
    error,
    durationMs,
  })

  appendAudit({
    action: 'taicho_failed',
    actor: 'taicho',
    detail: `Issue #${issue.number}: ${error} (strategy: ${strategy.name}, duration: ${Math.round(durationMs / 1000)}s)`,
    result: 'error',
  })

  // Issue に失敗コメントを追加
  try {
    await addComment(
      issue.number,
      `タイチョーが実装に失敗しました（${maxRetries}回試行）。手動での対応が必要です。\n\nエラー: ${lastError}`,
      project.repo,
    )
  } catch {
    log.warn('Failed to add failure comment to Issue')
  }

  log.error(`Taicho failed for Issue #${issue.number}: ${error}`)

  return {
    success: false,
    error,
    durationMs,
    retryCount: maxRetries,
  }
}
