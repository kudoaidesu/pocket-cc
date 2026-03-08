/**
 * ワーカーレジストリ
 *
 * projects.json + 固定定義から全ワーカーを SQLite に登録・同期する。
 * 既存の definitions.ts の buildWorkerAgent / buildAllAgents は変更せず、
 * 新しい登録パスとして DB 永続化を提供する。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type Database from 'better-sqlite3'
import {
  registerWorker,
  getWorkerByProject,
  listWorkers,
} from './worker-store.js'
import type { Worker } from './worker-store.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('worker-registry')

// ── 型定義 ─────────────────────────────────────────────────

interface ProjectConfig {
  slug: string
  repo: string
  localPath: string
}

// ── 公開API ────────────────────────────────────────────────

/**
 * projects.json を読み込み、ワーカーを SQLite に同期する。
 * - 各プロジェクトの担当を 'implementer' ロールで登録（既存なら何もしない）
 * - 雑務担当 (_general) を固定登録
 *
 * @param db - SQLite データベースインスタンス
 * @param projectsPath - projects.json のパス（デフォルト: CWD/projects.json）
 */
export function syncWorkers(
  db: Database.Database,
  projectsPath?: string,
): void {
  const resolvedPath = projectsPath ?? resolve(process.cwd(), 'projects.json')
  let projects: ProjectConfig[]

  try {
    const raw = readFileSync(resolvedPath, 'utf-8')
    projects = JSON.parse(raw) as ProjectConfig[]
  } catch (e) {
    log.warn(`Failed to read projects.json at ${resolvedPath}: ${e}`)
    projects = []
  }

  syncFromProjects(db, projects)
}

/**
 * プロジェクトリストからワーカーを SQLite に同期する。
 * テスト時は直接プロジェクトリストを渡せる。
 */
export function syncFromProjects(
  db: Database.Database,
  projects: ProjectConfig[],
): void {
  let registered = 0

  for (const project of projects) {
    const existing = getWorkerByProject(db, project.slug, 'implementer')
    if (!existing) {
      registerWorker(db, project.slug, 'implementer', `${project.slug} 担当`)
      registered++
    }
  }

  // 雑務担当を固定登録
  const generalWorker = getWorkerByProject(db, '_general', 'general')
  if (!generalWorker) {
    registerWorker(db, '_general', 'general', '雑務担当')
    registered++
  }

  if (registered > 0) {
    log.info(`Synced ${registered} new worker(s)`)
  }
}

/**
 * 利用可能なワーカー一覧を返す（active のみ）。
 */
export function getAvailableWorkers(db: Database.Database): Worker[] {
  return listWorkers(db, 'active')
}

/**
 * プロジェクトスラッグからワーカーを解決する。
 * '_general' スラッグは雑務担当 (role='general') に解決される。
 * それ以外は implementer ロールで検索する。
 */
export function resolveWorker(
  db: Database.Database,
  projectSlug: string,
): Worker | null {
  if (projectSlug === '_general') {
    return getWorkerByProject(db, '_general', 'general')
  }
  return getWorkerByProject(db, projectSlug, 'implementer')
}
