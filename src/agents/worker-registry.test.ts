import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { initSchema } from '../db/schema.js'
import { syncFromProjects, getAvailableWorkers, resolveWorker } from './worker-registry.js'
import { getWorkerByProject, listWorkers, updateWorkerStatus } from './worker-store.js'

let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('synchronous = NORMAL')
  db.pragma('busy_timeout = 5000')
  initSchema(db)
})

afterEach(() => {
  db.close()
})

// ── テスト用プロジェクトリスト ────────────────────────────

const testProjects = [
  { slug: 'project-a', repo: 'org/project-a', localPath: '/tmp/project-a' },
  { slug: 'project-b', repo: 'org/project-b', localPath: '/tmp/project-b' },
]

// ── projects.json からワーカー同期 ─────────────────────────

describe('syncFromProjects', () => {
  it('プロジェクトリストからワーカーを登録する', () => {
    syncFromProjects(db, testProjects)

    const workerA = getWorkerByProject(db, 'project-a', 'implementer')
    expect(workerA).not.toBeNull()
    expect(workerA!.id).toBe('project-a-implementer')
    expect(workerA!.displayName).toBe('project-a 担当')

    const workerB = getWorkerByProject(db, 'project-b', 'implementer')
    expect(workerB).not.toBeNull()
    expect(workerB!.id).toBe('project-b-implementer')
  })

  it('雑務担当 (_general) を固定登録する', () => {
    syncFromProjects(db, testProjects)

    const general = getWorkerByProject(db, '_general', 'general')
    expect(general).not.toBeNull()
    expect(general!.id).toBe('_general-general')
    expect(general!.displayName).toBe('雑務担当')
  })

  it('空のプロジェクトリストでも雑務担当は登録される', () => {
    syncFromProjects(db, [])

    const general = getWorkerByProject(db, '_general', 'general')
    expect(general).not.toBeNull()

    const all = listWorkers(db)
    expect(all).toHaveLength(1)
  })
})

// ── 重複同期（冪等性）──────────────────────────────────────

describe('Idempotent sync', () => {
  it('同じプロジェクトリストで2回同期しても重複登録されない', () => {
    syncFromProjects(db, testProjects)
    syncFromProjects(db, testProjects)

    const all = listWorkers(db)
    // project-a, project-b, _general = 3
    expect(all).toHaveLength(3)
  })

  it('プロジェクト追加後に再同期すると新規分だけ追加される', () => {
    syncFromProjects(db, testProjects)
    expect(listWorkers(db)).toHaveLength(3)

    const extendedProjects = [
      ...testProjects,
      { slug: 'project-c', repo: 'org/project-c', localPath: '/tmp/project-c' },
    ]
    syncFromProjects(db, extendedProjects)

    expect(listWorkers(db)).toHaveLength(4)
    const workerC = getWorkerByProject(db, 'project-c', 'implementer')
    expect(workerC).not.toBeNull()
  })
})

// ── ワーカー解決 ───────────────────────────────────────────

describe('resolveWorker', () => {
  beforeEach(() => {
    syncFromProjects(db, testProjects)
  })

  it('プロジェクトスラッグで implementer ワーカーを解決する', () => {
    const worker = resolveWorker(db, 'project-a')
    expect(worker).not.toBeNull()
    expect(worker!.id).toBe('project-a-implementer')
    expect(worker!.role).toBe('implementer')
  })

  it('_general で雑務担当を解決する', () => {
    const worker = resolveWorker(db, '_general')
    expect(worker).not.toBeNull()
    expect(worker!.id).toBe('_general-general')
    expect(worker!.role).toBe('general')
  })

  it('存在しないプロジェクトスラッグは null を返す', () => {
    const worker = resolveWorker(db, 'nonexistent')
    expect(worker).toBeNull()
  })
})

// ── 利用可能なワーカー一覧 ─────────────────────────────────

describe('getAvailableWorkers', () => {
  it('active のワーカーのみ返す', () => {
    syncFromProjects(db, testProjects)

    const available = getAvailableWorkers(db)
    expect(available).toHaveLength(3) // a, b, _general

    // 1つを inactive にする
    updateWorkerStatus(db, 'project-a-implementer', 'inactive')

    const available2 = getAvailableWorkers(db)
    expect(available2).toHaveLength(2)
    expect(available2.every(w => w.status === 'active')).toBe(true)
  })
})
