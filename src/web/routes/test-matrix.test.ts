import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { Hono } from 'hono'
import { testMatrixRoutes } from './test-matrix.js'

// ── In-memory DB セットアップ ─────────────────────────────

let db: Database.Database

/** テストマトリクス用テーブルを作成する（migrateV5 と同等） */
function createTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS test_dimensions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      name TEXT NOT NULL,
      display_name TEXT NOT NULL,
      values_json TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(project, name)
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS test_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      coordinates_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'not_tested',
      confidence INTEGER NOT NULL DEFAULT 0,
      flaky_rate REAL NOT NULL DEFAULT 0,
      pass_count INTEGER NOT NULL DEFAULT 0,
      fail_count INTEGER NOT NULL DEFAULT 0,
      skip_count INTEGER NOT NULL DEFAULT 0,
      total_runs INTEGER NOT NULL DEFAULT 0,
      last_run_at TEXT,
      notes TEXT,
      test_name TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS test_evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      record_id INTEGER NOT NULL REFERENCES test_records(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      path TEXT NOT NULL,
      description TEXT,
      created_at TEXT NOT NULL
    )
  `)
}

// getDb をモックしてインメモリ DB を返す
vi.mock('../../db/index.js', () => ({
  getDb: () => db,
}))

// logger のモック（テスト中のログ出力を抑制）
vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}))

// ── テスト用 Hono アプリ ──────────────────────────────────

function createApp(): Hono {
  const app = new Hono()
  app.route('/api/test-matrix', testMatrixRoutes)
  return app
}

// ── テストスイート ────────────────────────────────────────

describe('test-matrix routes', () => {
  let app: Hono

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    createTables(db)
    app = createApp()
  })

  afterEach(() => {
    db.close()
  })

  // ── Dimensions CRUD ───────────────────────────────────

  describe('Dimensions', () => {
    describe('GET /dimensions', () => {
      it('project パラメータ未指定で 400 を返す', async () => {
        const res = await app.request('/api/test-matrix/dimensions')
        expect(res.status).toBe(400)
        const body = await res.json()
        expect(body.error).toContain('project')
      })

      it('空の配列を返す（データなし）', async () => {
        const res = await app.request('/api/test-matrix/dimensions?project=my-project')
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body).toEqual([])
      })

      it('作成済みの次元を返す', async () => {
        // 直接 DB に挿入
        db.prepare(`
          INSERT INTO test_dimensions (project, name, display_name, values_json, sort_order, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run('my-project', 'permission', '権限', '["admin","user"]', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')

        const res = await app.request('/api/test-matrix/dimensions?project=my-project')
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body).toHaveLength(1)
        expect(body[0].name).toBe('permission')
        expect(body[0].display_name).toBe('権限')
      })

      it('他プロジェクトの次元は含めない', async () => {
        db.prepare(`
          INSERT INTO test_dimensions (project, name, display_name, values_json, sort_order, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run('other-project', 'screen', '画面', '["home","settings"]', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')

        const res = await app.request('/api/test-matrix/dimensions?project=my-project')
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body).toEqual([])
      })
    })

    describe('POST /dimensions', () => {
      it('新しい次元を作成し 201 を返す', async () => {
        const res = await app.request('/api/test-matrix/dimensions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project: 'my-project',
            name: 'permission',
            displayName: '権限',
            values: ['admin', 'user', 'guest'],
          }),
        })

        expect(res.status).toBe(201)
        const body = await res.json()
        expect(body.created).toBe(true)
        expect(body.id).toBeDefined()

        // DB 上にレコードが存在することを確認
        const row = db.prepare('SELECT * FROM test_dimensions WHERE id = ?').get(body.id) as Record<string, unknown>
        expect(row.name).toBe('permission')
        expect(row.display_name).toBe('権限')
        expect(JSON.parse(row.values_json as string)).toEqual(['admin', 'user', 'guest'])
      })

      it('同一 project+name の場合は更新する', async () => {
        // 初回作成
        await app.request('/api/test-matrix/dimensions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project: 'my-project',
            name: 'permission',
            displayName: '権限',
            values: ['admin', 'user'],
          }),
        })

        // 同名で再投入 → 更新
        const res = await app.request('/api/test-matrix/dimensions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project: 'my-project',
            name: 'permission',
            displayName: '権限（更新後）',
            values: ['admin', 'user', 'guest'],
            sortOrder: 5,
          }),
        })

        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.updated).toBe(true)

        // DB に1件のみ存在
        const count = db.prepare('SELECT COUNT(*) as cnt FROM test_dimensions WHERE project = ?').get('my-project') as { cnt: number }
        expect(count.cnt).toBe(1)

        const row = db.prepare('SELECT * FROM test_dimensions WHERE project = ? AND name = ?').get('my-project', 'permission') as Record<string, unknown>
        expect(row.display_name).toBe('権限（更新後）')
        expect(row.sort_order).toBe(5)
      })

      it('必須フィールド不足で 400 を返す', async () => {
        const cases = [
          {},
          { project: 'p' },
          { project: 'p', name: 'n' },
          { project: 'p', name: 'n', displayName: 'd' },
          { project: 'p', name: 'n', displayName: 'd', values: [] },
        ]

        for (const payload of cases) {
          const res = await app.request('/api/test-matrix/dimensions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          })
          expect(res.status).toBe(400)
        }
      })
    })

    describe('DELETE /dimensions/:id', () => {
      it('存在する次元を削除する', async () => {
        const result = db.prepare(`
          INSERT INTO test_dimensions (project, name, display_name, values_json, sort_order, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run('my-project', 'screen', '画面', '["home"]', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')

        const res = await app.request(`/api/test-matrix/dimensions/${result.lastInsertRowid}`, {
          method: 'DELETE',
        })

        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.deleted).toBe(true)

        const row = db.prepare('SELECT * FROM test_dimensions WHERE id = ?').get(result.lastInsertRowid)
        expect(row).toBeUndefined()
      })

      it('存在しない id で 404 を返す', async () => {
        const res = await app.request('/api/test-matrix/dimensions/9999', {
          method: 'DELETE',
        })
        expect(res.status).toBe(404)
      })

      it('不正な id で 400 を返す', async () => {
        const res = await app.request('/api/test-matrix/dimensions/abc', {
          method: 'DELETE',
        })
        expect(res.status).toBe(400)
      })
    })
  })

  // ── Records CRUD ──────────────────────────────────────

  describe('Records', () => {
    describe('GET /records', () => {
      it('project パラメータ未指定で 400 を返す', async () => {
        const res = await app.request('/api/test-matrix/records')
        expect(res.status).toBe(400)
        const body = await res.json()
        expect(body.error).toContain('project')
      })

      it('空の配列を返す（データなし）', async () => {
        const res = await app.request('/api/test-matrix/records?project=my-project')
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body).toEqual([])
      })

      it('プロジェクトのレコードを返す', async () => {
        db.prepare(`
          INSERT INTO test_records (project, coordinates_json, status, confidence, flaky_rate,
            pass_count, fail_count, skip_count, total_runs, last_run_at, notes, test_name, created_at, updated_at)
          VALUES (?, ?, ?, ?, 0, 1, 0, 0, 1, ?, NULL, 'test1', ?, ?)
        `).run('my-project', '{"permission":"admin","screen":"home"}', 'pass', 80, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')

        const res = await app.request('/api/test-matrix/records?project=my-project')
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body).toHaveLength(1)
        expect(body[0].status).toBe('pass')
      })

      it('status フィルタが機能する', async () => {
        const ts = '2026-01-01T00:00:00Z'
        const insert = db.prepare(`
          INSERT INTO test_records (project, coordinates_json, status, confidence, flaky_rate,
            pass_count, fail_count, skip_count, total_runs, last_run_at, notes, test_name, created_at, updated_at)
          VALUES (?, ?, ?, 0, 0, 0, 0, 0, 1, ?, NULL, NULL, ?, ?)
        `)
        insert.run('my-project', '{"a":"1"}', 'pass', ts, ts, ts)
        insert.run('my-project', '{"a":"2"}', 'fail', ts, ts, ts)
        insert.run('my-project', '{"a":"3"}', 'pass', ts, ts, ts)

        const res = await app.request('/api/test-matrix/records?project=my-project&status=fail')
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body).toHaveLength(1)
        expect(body[0].status).toBe('fail')
      })

      it('不正な status フィルタは無視される（全件返す）', async () => {
        const ts = '2026-01-01T00:00:00Z'
        db.prepare(`
          INSERT INTO test_records (project, coordinates_json, status, confidence, flaky_rate,
            pass_count, fail_count, skip_count, total_runs, last_run_at, notes, test_name, created_at, updated_at)
          VALUES (?, ?, ?, 0, 0, 0, 0, 0, 1, ?, NULL, NULL, ?, ?)
        `).run('my-project', '{"a":"1"}', 'pass', ts, ts, ts)

        const res = await app.request('/api/test-matrix/records?project=my-project&status=invalid_status')
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body).toHaveLength(1)
      })
    })

    describe('POST /records', () => {
      it('新しいレコードを作成し 201 を返す', async () => {
        const res = await app.request('/api/test-matrix/records', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project: 'my-project',
            coordinates: { permission: 'admin', screen: 'home' },
            status: 'pass',
            confidence: 90,
            notes: 'テスト通過',
            testName: 'admin-home-test',
          }),
        })

        expect(res.status).toBe(201)
        const body = await res.json()
        expect(body.created).toBe(true)
        expect(body.id).toBeDefined()

        const row = db.prepare('SELECT * FROM test_records WHERE id = ?').get(body.id) as Record<string, unknown>
        expect(row.status).toBe('pass')
        expect(row.confidence).toBe(90)
        expect(row.pass_count).toBe(1)
        expect(row.fail_count).toBe(0)
        expect(row.total_runs).toBe(1)
        expect(row.test_name).toBe('admin-home-test')
      })

      it('status 省略時は not_tested になる', async () => {
        const res = await app.request('/api/test-matrix/records', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project: 'my-project',
            coordinates: { permission: 'admin' },
          }),
        })

        expect(res.status).toBe(201)
        const body = await res.json()
        const row = db.prepare('SELECT * FROM test_records WHERE id = ?').get(body.id) as Record<string, unknown>
        expect(row.status).toBe('not_tested')
      })

      it('同じ座標のレコードが存在する場合は更新する', async () => {
        // 初回作成
        const res1 = await app.request('/api/test-matrix/records', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project: 'my-project',
            coordinates: { permission: 'admin', screen: 'home' },
            status: 'pass',
          }),
        })
        const body1 = await res1.json()

        // 同一座標で再投入 → 更新
        const res2 = await app.request('/api/test-matrix/records', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project: 'my-project',
            coordinates: { permission: 'admin', screen: 'home' },
            status: 'fail',
            notes: '失敗',
          }),
        })

        expect(res2.status).toBe(200)
        const body2 = await res2.json()
        expect(body2.updated).toBe(true)
        expect(body2.id).toBe(body1.id)

        const row = db.prepare('SELECT * FROM test_records WHERE id = ?').get(body1.id) as Record<string, unknown>
        expect(row.status).toBe('fail')
        expect(row.pass_count).toBe(1)
        expect(row.fail_count).toBe(1)
        expect(row.total_runs).toBe(2)
      })

      it('不正な status で 400 を返す', async () => {
        const res = await app.request('/api/test-matrix/records', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project: 'my-project',
            coordinates: { a: '1' },
            status: 'unknown_status',
          }),
        })

        expect(res.status).toBe(400)
        const body = await res.json()
        expect(body.error).toContain('Invalid status')
      })

      it('project 未指定で 400 を返す', async () => {
        const res = await app.request('/api/test-matrix/records', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            coordinates: { a: '1' },
          }),
        })
        expect(res.status).toBe(400)
      })

      it('coordinates が空オブジェクトで 400 を返す', async () => {
        const res = await app.request('/api/test-matrix/records', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project: 'my-project',
            coordinates: {},
          }),
        })
        expect(res.status).toBe(400)
      })

      it('coordinates 未指定で 400 を返す', async () => {
        const res = await app.request('/api/test-matrix/records', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project: 'my-project',
          }),
        })
        expect(res.status).toBe(400)
      })
    })

    describe('PUT /records/:id', () => {
      let recordId: number

      beforeEach(() => {
        const result = db.prepare(`
          INSERT INTO test_records (project, coordinates_json, status, confidence, flaky_rate,
            pass_count, fail_count, skip_count, total_runs, last_run_at, notes, test_name, created_at, updated_at)
          VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0, NULL, NULL, NULL, ?, ?)
        `).run('my-project', '{"a":"1"}', 'not_tested', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
        recordId = Number(result.lastInsertRowid)
      })

      it('ステータスを更新する', async () => {
        const res = await app.request(`/api/test-matrix/records/${recordId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'pass' }),
        })

        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.updated).toBe(true)

        const row = db.prepare('SELECT * FROM test_records WHERE id = ?').get(recordId) as Record<string, unknown>
        expect(row.status).toBe('pass')
        expect(row.pass_count).toBe(1)
        expect(row.total_runs).toBe(1)
      })

      it('confidence と notes を更新する', async () => {
        const res = await app.request(`/api/test-matrix/records/${recordId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confidence: 95, notes: '確認済み' }),
        })

        expect(res.status).toBe(200)
        const row = db.prepare('SELECT * FROM test_records WHERE id = ?').get(recordId) as Record<string, unknown>
        expect(row.confidence).toBe(95)
        expect(row.notes).toBe('確認済み')
      })

      it('不正な status で 400 を返す', async () => {
        const res = await app.request(`/api/test-matrix/records/${recordId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'invalid' }),
        })
        expect(res.status).toBe(400)
      })

      it('存在しない id で 404 を返す', async () => {
        const res = await app.request('/api/test-matrix/records/9999', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'pass' }),
        })
        expect(res.status).toBe(404)
      })

      it('不正な id で 400 を返す', async () => {
        const res = await app.request('/api/test-matrix/records/abc', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'pass' }),
        })
        expect(res.status).toBe(400)
      })
    })

    describe('DELETE /records/:id', () => {
      it('存在するレコードを削除する', async () => {
        const result = db.prepare(`
          INSERT INTO test_records (project, coordinates_json, status, confidence, flaky_rate,
            pass_count, fail_count, skip_count, total_runs, last_run_at, notes, test_name, created_at, updated_at)
          VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0, NULL, NULL, NULL, ?, ?)
        `).run('my-project', '{"a":"1"}', 'pass', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')

        const res = await app.request(`/api/test-matrix/records/${result.lastInsertRowid}`, {
          method: 'DELETE',
        })

        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.deleted).toBe(true)
      })

      it('存在しない id で 404 を返す', async () => {
        const res = await app.request('/api/test-matrix/records/9999', {
          method: 'DELETE',
        })
        expect(res.status).toBe(404)
      })

      it('不正な id で 400 を返す', async () => {
        const res = await app.request('/api/test-matrix/records/abc', {
          method: 'DELETE',
        })
        expect(res.status).toBe(400)
      })
    })
  })

  // ── Evidence CRUD ─────────────────────────────────────

  describe('Evidence', () => {
    let recordId: number

    beforeEach(() => {
      const result = db.prepare(`
        INSERT INTO test_records (project, coordinates_json, status, confidence, flaky_rate,
          pass_count, fail_count, skip_count, total_runs, last_run_at, notes, test_name, created_at, updated_at)
        VALUES (?, ?, ?, 0, 0, 0, 0, 0, 1, ?, NULL, NULL, ?, ?)
      `).run('my-project', '{"a":"1"}', 'pass', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
      recordId = Number(result.lastInsertRowid)
    })

    describe('GET /records/:id/evidence', () => {
      it('空の配列を返す（エビデンスなし）', async () => {
        const res = await app.request(`/api/test-matrix/records/${recordId}/evidence`)
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body).toEqual([])
      })

      it('エビデンス一覧を返す', async () => {
        db.prepare(`
          INSERT INTO test_evidence (record_id, type, path, description, created_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(recordId, 'screenshot_before', '/screenshots/before.png', 'ログイン画面', '2026-01-01T00:00:00Z')

        const res = await app.request(`/api/test-matrix/records/${recordId}/evidence`)
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body).toHaveLength(1)
        expect(body[0].type).toBe('screenshot_before')
        expect(body[0].path).toBe('/screenshots/before.png')
        expect(body[0].description).toBe('ログイン画面')
      })

      it('不正な id で 400 を返す', async () => {
        const res = await app.request('/api/test-matrix/records/abc/evidence')
        expect(res.status).toBe(400)
      })
    })

    describe('POST /records/:id/evidence', () => {
      it('エビデンスを作成し 201 を返す', async () => {
        const res = await app.request(`/api/test-matrix/records/${recordId}/evidence`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'screenshot_after',
            path: '/screenshots/after.png',
            description: 'テスト結果画面',
          }),
        })

        expect(res.status).toBe(201)
        const body = await res.json()
        expect(body.created).toBe(true)
        expect(body.id).toBeDefined()

        const row = db.prepare('SELECT * FROM test_evidence WHERE id = ?').get(body.id) as Record<string, unknown>
        expect(row.type).toBe('screenshot_after')
        expect(row.path).toBe('/screenshots/after.png')
        expect(row.description).toBe('テスト結果画面')
        expect(row.record_id).toBe(recordId)
      })

      it('description 省略時は null になる', async () => {
        const res = await app.request(`/api/test-matrix/records/${recordId}/evidence`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'log',
            path: '/logs/test.log',
          }),
        })

        expect(res.status).toBe(201)
        const body = await res.json()
        const row = db.prepare('SELECT * FROM test_evidence WHERE id = ?').get(body.id) as Record<string, unknown>
        expect(row.description).toBeNull()
      })

      it('type 未指定で 400 を返す', async () => {
        const res = await app.request(`/api/test-matrix/records/${recordId}/evidence`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: '/logs/test.log' }),
        })
        expect(res.status).toBe(400)
      })

      it('path 未指定で 400 を返す', async () => {
        const res = await app.request(`/api/test-matrix/records/${recordId}/evidence`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'log' }),
        })
        expect(res.status).toBe(400)
      })

      it('不正な type で 400 を返す', async () => {
        const res = await app.request(`/api/test-matrix/records/${recordId}/evidence`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'invalid_type',
            path: '/some/path',
          }),
        })
        expect(res.status).toBe(400)
        const body = await res.json()
        expect(body.error).toContain('Invalid type')
      })

      it('存在しないレコードに対して 404 を返す', async () => {
        const res = await app.request('/api/test-matrix/records/9999/evidence', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'screenshot_before',
            path: '/screenshots/before.png',
          }),
        })
        expect(res.status).toBe(404)
      })

      it('不正な record id で 400 を返す', async () => {
        const res = await app.request('/api/test-matrix/records/abc/evidence', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'screenshot_before',
            path: '/screenshots/before.png',
          }),
        })
        expect(res.status).toBe(400)
      })

      it('全ての有効な type を受け付ける', async () => {
        const validTypes = ['screenshot_before', 'screenshot_after', 'video', 'log', 'trace', 'report']

        for (const type of validTypes) {
          const res = await app.request(`/api/test-matrix/records/${recordId}/evidence`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type,
              path: `/evidence/${type}.file`,
            }),
          })
          expect(res.status).toBe(201)
        }
      })
    })

    describe('DELETE /evidence/:id', () => {
      it('存在するエビデンスを削除する', async () => {
        const result = db.prepare(`
          INSERT INTO test_evidence (record_id, type, path, description, created_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(recordId, 'log', '/logs/test.log', null, '2026-01-01T00:00:00Z')

        const res = await app.request(`/api/test-matrix/evidence/${result.lastInsertRowid}`, {
          method: 'DELETE',
        })

        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.deleted).toBe(true)
      })

      it('存在しない id で 404 を返す', async () => {
        const res = await app.request('/api/test-matrix/evidence/9999', {
          method: 'DELETE',
        })
        expect(res.status).toBe(404)
      })

      it('不正な id で 400 を返す', async () => {
        const res = await app.request('/api/test-matrix/evidence/abc', {
          method: 'DELETE',
        })
        expect(res.status).toBe(400)
      })
    })
  })

  // ── Summary ───────────────────────────────────────────

  describe('Summary', () => {
    describe('GET /summary', () => {
      it('project パラメータ未指定で 400 を返す', async () => {
        const res = await app.request('/api/test-matrix/summary')
        expect(res.status).toBe(400)
        const body = await res.json()
        expect(body.error).toContain('project')
      })

      it('レコードなしの場合にゼロカウントを返す', async () => {
        const res = await app.request('/api/test-matrix/summary?project=my-project')
        expect(res.status).toBe(200)
        const body = await res.json()

        expect(body.project).toBe('my-project')
        expect(body.counts.total).toBe(0)
        expect(body.counts.pass).toBe(0)
        expect(body.counts.fail).toBe(0)
        expect(body.counts.skip).toBe(0)
        expect(body.counts.not_tested).toBe(0)
        expect(body.counts.flaky).toBe(0)
        expect(body.dimensions).toEqual([])
      })

      it('ステータス別カウントが正しい', async () => {
        const ts = '2026-01-01T00:00:00Z'
        const insert = db.prepare(`
          INSERT INTO test_records (project, coordinates_json, status, confidence, flaky_rate,
            pass_count, fail_count, skip_count, total_runs, last_run_at, notes, test_name, created_at, updated_at)
          VALUES (?, ?, ?, 0, 0, 0, 0, 0, 1, ?, NULL, NULL, ?, ?)
        `)

        insert.run('my-project', '{"a":"1"}', 'pass', ts, ts, ts)
        insert.run('my-project', '{"a":"2"}', 'pass', ts, ts, ts)
        insert.run('my-project', '{"a":"3"}', 'fail', ts, ts, ts)
        insert.run('my-project', '{"a":"4"}', 'skip', ts, ts, ts)
        insert.run('my-project', '{"a":"5"}', 'not_tested', ts, ts, ts)
        insert.run('my-project', '{"a":"6"}', 'flaky', ts, ts, ts)

        const res = await app.request('/api/test-matrix/summary?project=my-project')
        expect(res.status).toBe(200)
        const body = await res.json()

        expect(body.counts.total).toBe(6)
        expect(body.counts.pass).toBe(2)
        expect(body.counts.fail).toBe(1)
        expect(body.counts.skip).toBe(1)
        expect(body.counts.not_tested).toBe(1)
        expect(body.counts.flaky).toBe(1)
      })

      it('次元情報を含む', async () => {
        db.prepare(`
          INSERT INTO test_dimensions (project, name, display_name, values_json, sort_order, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run('my-project', 'permission', '権限', '["admin","user"]', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')

        db.prepare(`
          INSERT INTO test_dimensions (project, name, display_name, values_json, sort_order, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run('my-project', 'screen', '画面', '["home","settings"]', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')

        const res = await app.request('/api/test-matrix/summary?project=my-project')
        expect(res.status).toBe(200)
        const body = await res.json()

        expect(body.dimensions).toHaveLength(2)
        // sort_order 順に並ぶ
        expect(body.dimensions[0].name).toBe('screen')
        expect(body.dimensions[1].name).toBe('permission')
      })

      it('他プロジェクトのデータを含めない', async () => {
        const ts = '2026-01-01T00:00:00Z'
        db.prepare(`
          INSERT INTO test_records (project, coordinates_json, status, confidence, flaky_rate,
            pass_count, fail_count, skip_count, total_runs, last_run_at, notes, test_name, created_at, updated_at)
          VALUES (?, ?, ?, 0, 0, 0, 0, 0, 1, ?, NULL, NULL, ?, ?)
        `).run('other-project', '{"a":"1"}', 'pass', ts, ts, ts)

        const res = await app.request('/api/test-matrix/summary?project=my-project')
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.counts.total).toBe(0)
      })
    })
  })
})
