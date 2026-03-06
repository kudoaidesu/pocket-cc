/**
 * Strategy 評価トラッカー — SQLite 永続化
 *
 * タイチョーの各実行結果を記録し、Strategy 別の集計レポートを生成する。
 */
import { getDb } from '../db/index.js'
import { createLogger } from './logger.js'

const log = createLogger('cost-tracker')

export interface EvaluationRecord {
  issueNumber: number
  repository: string
  strategy: string
  difficulty?: string
  success: boolean
  durationMs?: number
  retryCount: number
  linesAdded?: number
  linesRemoved?: number
  filesChanged?: number
  buildPass?: boolean
  testPass?: boolean
  prUrl?: string
  prMerged?: boolean
  manualFixCommits?: number
  reviewComments?: number
}

export interface StrategyStats {
  strategy: string
  totalRuns: number
  successCount: number
  failCount: number
  successRate: number
  avgDurationMs: number
  avgRetries: number
  avgLinesChanged: number
}

/** 評価レコードを記録する */
export function recordEvaluation(record: EvaluationRecord): void {
  const db = getDb()
  db.prepare(`
    INSERT INTO strategy_evaluations (
      issue_number, repository, strategy, difficulty, success,
      duration_ms, retry_count, lines_added, lines_removed, files_changed,
      build_pass, test_pass, pr_url, pr_merged,
      manual_fix_commits, review_comments, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.issueNumber,
    record.repository,
    record.strategy,
    record.difficulty ?? null,
    record.success ? 1 : 0,
    record.durationMs ?? null,
    record.retryCount,
    record.linesAdded ?? null,
    record.linesRemoved ?? null,
    record.filesChanged ?? null,
    record.buildPass != null ? (record.buildPass ? 1 : 0) : null,
    record.testPass != null ? (record.testPass ? 1 : 0) : null,
    record.prUrl ?? null,
    record.prMerged != null ? (record.prMerged ? 1 : 0) : null,
    record.manualFixCommits ?? null,
    record.reviewComments ?? null,
    new Date().toISOString(),
  )

  log.info(`Recorded evaluation: Issue #${record.issueNumber} [${record.strategy}] success=${record.success}`)
}

/** Strategy 別の集計を取得する */
export function getStrategyStats(): StrategyStats[] {
  const db = getDb()
  const rows = db.prepare(`
    SELECT
      strategy,
      COUNT(*) as total_runs,
      SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as success_count,
      SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as fail_count,
      ROUND(AVG(CASE WHEN success = 1 THEN 1.0 ELSE 0.0 END) * 100, 1) as success_rate,
      ROUND(AVG(duration_ms)) as avg_duration_ms,
      ROUND(AVG(retry_count), 1) as avg_retries,
      ROUND(AVG(COALESCE(lines_added, 0) + COALESCE(lines_removed, 0))) as avg_lines_changed
    FROM strategy_evaluations
    GROUP BY strategy
    ORDER BY total_runs DESC
  `).all() as Array<Record<string, number | string>>

  return rows.map((row) => ({
    strategy: row.strategy as string,
    totalRuns: row.total_runs as number,
    successCount: row.success_count as number,
    failCount: row.fail_count as number,
    successRate: row.success_rate as number,
    avgDurationMs: row.avg_duration_ms as number,
    avgRetries: row.avg_retries as number,
    avgLinesChanged: row.avg_lines_changed as number,
  }))
}

/** 直近の評価レコードを取得する */
export function getRecentEvaluations(limit = 20): Array<Record<string, unknown>> {
  const db = getDb()
  return db.prepare(`
    SELECT * FROM strategy_evaluations
    ORDER BY created_at DESC LIMIT ?
  `).all(limit) as Array<Record<string, unknown>>
}

/** PR マージ後の手動評価を更新する */
export function updatePostMerge(
  issueNumber: number,
  repository: string,
  updates: { prMerged?: boolean; manualFixCommits?: number; reviewComments?: number },
): boolean {
  const db = getDb()
  const result = db.prepare(`
    UPDATE strategy_evaluations
    SET pr_merged = COALESCE(?, pr_merged),
        manual_fix_commits = COALESCE(?, manual_fix_commits),
        review_comments = COALESCE(?, review_comments)
    WHERE issue_number = ? AND repository = ?
    ORDER BY created_at DESC LIMIT 1
  `).run(
    updates.prMerged != null ? (updates.prMerged ? 1 : 0) : null,
    updates.manualFixCommits ?? null,
    updates.reviewComments ?? null,
    issueNumber,
    repository,
  )

  if (result.changes > 0) {
    log.info(`Updated post-merge evaluation for Issue #${issueNumber}`)
    return true
  }
  return false
}
