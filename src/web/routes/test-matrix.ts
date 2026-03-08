/**
 * Test Matrix API — テストマトリクスの CRUD + 集計
 *
 * プロジェクト単位で次元（permission, screen, feature 等）とテストレコードを管理し、
 * マトリクス形式でテストカバレッジを可視化する。
 */
import { Hono } from 'hono'
import { getDb } from '../../db/index.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('web:test-matrix')

export const testMatrixRoutes = new Hono()

// ── ヘルパー ──────────────────────────────────────────

function now(): string {
  return new Date().toISOString()
}

const VALID_STATUSES = ['pass', 'fail', 'skip', 'not_tested', 'flaky'] as const
const VALID_EVIDENCE_TYPES = ['screenshot_before', 'screenshot_after', 'video', 'log', 'trace', 'report'] as const

// ── Dimensions ────────────────────────────────────────

/** GET /dimensions?project={slug} */
testMatrixRoutes.get('/dimensions', (c) => {
  const project = c.req.query('project')
  if (!project) return c.json({ error: 'project query parameter is required' }, 400)

  const db = getDb()
  const rows = db.prepare(
    'SELECT * FROM test_dimensions WHERE project = ? ORDER BY sort_order, name'
  ).all(project)

  return c.json(rows)
})

/** POST /dimensions — 作成または更新 */
testMatrixRoutes.post('/dimensions', async (c) => {
  const body = await c.req.json<{
    project: string
    name: string
    displayName: string
    values: string[]
    sortOrder?: number
  }>()

  if (!body.project || !body.name || !body.displayName || !Array.isArray(body.values) || body.values.length === 0) {
    return c.json({ error: 'project, name, displayName, and non-empty values[] are required' }, 400)
  }

  const db = getDb()
  const ts = now()

  const existing = db.prepare(
    'SELECT id FROM test_dimensions WHERE project = ? AND name = ?'
  ).get(body.project, body.name) as { id: number } | undefined

  if (existing) {
    db.prepare(`
      UPDATE test_dimensions SET display_name = ?, values_json = ?, sort_order = ?, updated_at = ?
      WHERE id = ?
    `).run(body.displayName, JSON.stringify(body.values), body.sortOrder ?? 0, ts, existing.id)
    log.info(`Updated dimension ${body.name} for ${body.project}`)
    return c.json({ id: existing.id, updated: true })
  }

  const result = db.prepare(`
    INSERT INTO test_dimensions (project, name, display_name, values_json, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(body.project, body.name, body.displayName, JSON.stringify(body.values), body.sortOrder ?? 0, ts, ts)

  log.info(`Created dimension ${body.name} for ${body.project}`)
  return c.json({ id: result.lastInsertRowid, created: true }, 201)
})

/** DELETE /dimensions/:id */
testMatrixRoutes.delete('/dimensions/:id', (c) => {
  const id = Number(c.req.param('id'))
  if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400)

  const db = getDb()
  const result = db.prepare('DELETE FROM test_dimensions WHERE id = ?').run(id)

  if (result.changes === 0) return c.json({ error: 'Not found' }, 404)
  return c.json({ deleted: true })
})

// ── Records ───────────────────────────────────────────

/** GET /records?project={slug}&status={status} */
testMatrixRoutes.get('/records', (c) => {
  const project = c.req.query('project')
  if (!project) return c.json({ error: 'project query parameter is required' }, 400)

  const status = c.req.query('status')
  const db = getDb()

  let sql = 'SELECT * FROM test_records WHERE project = ?'
  const params: unknown[] = [project]

  if (status && VALID_STATUSES.includes(status as typeof VALID_STATUSES[number])) {
    sql += ' AND status = ?'
    params.push(status)
  }

  sql += ' ORDER BY id'
  const rows = db.prepare(sql).all(...params)

  return c.json(rows)
})

/** POST /records — レコード作成 */
testMatrixRoutes.post('/records', async (c) => {
  const body = await c.req.json<{
    project: string
    coordinates: Record<string, string>
    status?: string
    confidence?: number
    notes?: string
    testName?: string
  }>()

  if (!body.project || !body.coordinates || Object.keys(body.coordinates).length === 0) {
    return c.json({ error: 'project and non-empty coordinates are required' }, 400)
  }

  const status = body.status ?? 'not_tested'
  if (!VALID_STATUSES.includes(status as typeof VALID_STATUSES[number])) {
    return c.json({ error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` }, 400)
  }

  const db = getDb()
  const ts = now()

  // 座標バリデーション: 各次元の値が既知の次元値に含まれるか検証
  for (const [dimName, dimValue] of Object.entries(body.coordinates)) {
    const dim = db.prepare(
      'SELECT values_json FROM test_dimensions WHERE project = ? AND name = ?'
    ).get(body.project, dimName) as { values_json: string } | undefined

    if (dim) {
      const allowedValues = JSON.parse(dim.values_json) as string[]
      if (!allowedValues.includes(dimValue)) {
        return c.json({
          error: `Invalid coordinate value "${dimValue}" for dimension "${dimName}". Allowed values: ${allowedValues.join(', ')}`
        }, 400)
      }
    }
  }

  // 同じ座標のレコードが既に存在するかチェック
  const coordJson = JSON.stringify(body.coordinates)
  const existing = db.prepare(
    'SELECT id, status FROM test_records WHERE project = ? AND coordinates_json = ?'
  ).get(body.project, coordJson) as { id: number; status: string } | undefined

  if (existing) {
    // 冪等性: 同じ座標・同じステータスの場合はカウンタをインクリメントしない
    if (existing.status === status) {
      return c.json({ id: existing.id, updated: true, skipped: true })
    }

    // ステータスが変わった場合のみカウンタをインクリメント
    const passInc = status === 'pass' ? 1 : 0
    const failInc = status === 'fail' ? 1 : 0
    const skipInc = status === 'skip' ? 1 : 0

    db.prepare(`
      UPDATE test_records SET
        status = ?, confidence = ?, notes = COALESCE(?, notes),
        pass_count = pass_count + ?, fail_count = fail_count + ?, skip_count = skip_count + ?,
        total_runs = total_runs + 1, last_run_at = ?, updated_at = ?,
        flaky_rate = CAST(fail_count + ? AS REAL) / (total_runs + 1)
      WHERE id = ?
    `).run(
      status, body.confidence ?? 0, body.notes ?? null,
      passInc, failInc, skipInc, ts, ts,
      failInc, existing.id
    )

    // 履歴レコードを追加
    db.prepare(`
      INSERT INTO test_history (record_id, project, coordinates_json, status, confidence, notes, test_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(existing.id, body.project, coordJson, status, body.confidence ?? 0, body.notes ?? null, body.testName ?? null, ts)

    return c.json({ id: existing.id, updated: true })
  }

  const passCount = status === 'pass' ? 1 : 0
  const failCount = status === 'fail' ? 1 : 0
  const skipCount = status === 'skip' ? 1 : 0
  const flakyRate = failCount // 1回目: 0/1=0 or 1/1=1

  const result = db.prepare(`
    INSERT INTO test_records (
      project, coordinates_json, status, confidence, flaky_rate,
      pass_count, fail_count, skip_count, total_runs,
      last_run_at, notes, test_name, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
  `).run(
    body.project, coordJson, status, body.confidence ?? 0, flakyRate,
    passCount, failCount, skipCount,
    ts, body.notes ?? null, body.testName ?? null, ts, ts
  )

  const newId = Number(result.lastInsertRowid)

  // 初回作成時も履歴レコードを追加
  db.prepare(`
    INSERT INTO test_history (record_id, project, coordinates_json, status, confidence, notes, test_name, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(newId, body.project, coordJson, status, body.confidence ?? 0, body.notes ?? null, body.testName ?? null, ts)

  log.info(`Created test record for ${body.project}: ${coordJson}`)
  return c.json({ id: newId, created: true }, 201)
})

/** PUT /records/:id — レコード更新 */
testMatrixRoutes.put('/records/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400)

  const body = await c.req.json<{
    status?: string
    confidence?: number
    notes?: string
  }>()

  if (body.status && !VALID_STATUSES.includes(body.status as typeof VALID_STATUSES[number])) {
    return c.json({ error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` }, 400)
  }

  const db = getDb()
  const record = db.prepare('SELECT * FROM test_records WHERE id = ?').get(id)
  if (!record) return c.json({ error: 'Not found' }, 404)

  const updates: string[] = ['updated_at = ?']
  const params: unknown[] = [now()]

  if (body.status !== undefined) {
    updates.push('status = ?')
    params.push(body.status)

    const passInc = body.status === 'pass' ? 1 : 0
    const failInc = body.status === 'fail' ? 1 : 0
    const skipInc = body.status === 'skip' ? 1 : 0
    updates.push('pass_count = pass_count + ?', 'fail_count = fail_count + ?', 'skip_count = skip_count + ?')
    params.push(passInc, failInc, skipInc)
    updates.push('total_runs = total_runs + 1', 'last_run_at = ?')
    params.push(now())
  }
  if (body.confidence !== undefined) {
    updates.push('confidence = ?')
    params.push(body.confidence)
  }
  if (body.notes !== undefined) {
    updates.push('notes = ?')
    params.push(body.notes)
  }

  params.push(id)
  db.prepare(`UPDATE test_records SET ${updates.join(', ')} WHERE id = ?`).run(...params)

  return c.json({ updated: true })
})

/** DELETE /records/:id */
testMatrixRoutes.delete('/records/:id', (c) => {
  const id = Number(c.req.param('id'))
  if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400)

  const db = getDb()
  const result = db.prepare('DELETE FROM test_records WHERE id = ?').run(id)

  if (result.changes === 0) return c.json({ error: 'Not found' }, 404)
  return c.json({ deleted: true })
})

// ── Evidence ──────────────────────────────────────────

/** GET /records/:id/evidence */
testMatrixRoutes.get('/records/:id/evidence', (c) => {
  const recordId = Number(c.req.param('id'))
  if (isNaN(recordId)) return c.json({ error: 'Invalid id' }, 400)

  const db = getDb()
  const rows = db.prepare(
    'SELECT * FROM test_evidence WHERE record_id = ? ORDER BY created_at DESC'
  ).all(recordId)

  return c.json(rows)
})

/** POST /records/:id/evidence */
testMatrixRoutes.post('/records/:id/evidence', async (c) => {
  const recordId = Number(c.req.param('id'))
  if (isNaN(recordId)) return c.json({ error: 'Invalid record id' }, 400)

  const body = await c.req.json<{
    type: string
    path: string
    description?: string
  }>()

  if (!body.type || !body.path) {
    return c.json({ error: 'type and path are required' }, 400)
  }
  if (!VALID_EVIDENCE_TYPES.includes(body.type as typeof VALID_EVIDENCE_TYPES[number])) {
    return c.json({ error: `Invalid type. Must be one of: ${VALID_EVIDENCE_TYPES.join(', ')}` }, 400)
  }

  const db = getDb()

  // レコード存在確認
  const record = db.prepare('SELECT id FROM test_records WHERE id = ?').get(recordId)
  if (!record) return c.json({ error: 'Record not found' }, 404)

  const result = db.prepare(`
    INSERT INTO test_evidence (record_id, type, path, description, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(recordId, body.type, body.path, body.description ?? null, now())

  return c.json({ id: result.lastInsertRowid, created: true }, 201)
})

/** DELETE /evidence/:id */
testMatrixRoutes.delete('/evidence/:id', (c) => {
  const id = Number(c.req.param('id'))
  if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400)

  const db = getDb()
  const result = db.prepare('DELETE FROM test_evidence WHERE id = ?').run(id)

  if (result.changes === 0) return c.json({ error: 'Not found' }, 404)
  return c.json({ deleted: true })
})

// ── History ───────────────────────────────────────────

/** GET /records/:id/history — テスト履歴タイムライン */
testMatrixRoutes.get('/records/:id/history', (c) => {
  const recordId = Number(c.req.param('id'))
  if (isNaN(recordId)) return c.json({ error: 'Invalid id' }, 400)

  const db = getDb()

  // レコード存在確認
  const record = db.prepare('SELECT id FROM test_records WHERE id = ?').get(recordId)
  if (!record) return c.json({ error: 'Record not found' }, 404)

  const rows = db.prepare(
    'SELECT * FROM test_history WHERE record_id = ? ORDER BY created_at DESC'
  ).all(recordId)

  return c.json(rows)
})

// ── Summary ───────────────────────────────────────────

/** GET /summary?project={slug} */
testMatrixRoutes.get('/summary', (c) => {
  const project = c.req.query('project')
  if (!project) return c.json({ error: 'project query parameter is required' }, 400)

  const db = getDb()

  const counts = db.prepare(`
    SELECT
      COUNT(*) as total,
      COALESCE(SUM(CASE WHEN status = 'pass' THEN 1 ELSE 0 END), 0) as pass,
      COALESCE(SUM(CASE WHEN status = 'fail' THEN 1 ELSE 0 END), 0) as fail,
      COALESCE(SUM(CASE WHEN status = 'skip' THEN 1 ELSE 0 END), 0) as skip,
      COALESCE(SUM(CASE WHEN status = 'not_tested' THEN 1 ELSE 0 END), 0) as not_tested,
      COALESCE(SUM(CASE WHEN status = 'flaky' THEN 1 ELSE 0 END), 0) as flaky
    FROM test_records WHERE project = ?
  `).get(project) as Record<string, number>

  const dimensions = db.prepare(
    'SELECT name, display_name, values_json FROM test_dimensions WHERE project = ? ORDER BY sort_order'
  ).all(project)

  // カバレッジ率: テスト済み（pass/fail/skip/flaky）/ 全次元の組み合わせ数
  const dimRows = dimensions as Array<{ values_json: string }>
  const totalCombinations = dimRows.reduce((acc, d) => {
    const values = JSON.parse(d.values_json) as string[]
    return acc * values.length
  }, dimRows.length > 0 ? 1 : 0)
  const testedCount = counts.pass + counts.fail + counts.skip + counts.flaky
  const coverageRate = totalCombinations > 0 ? testedCount / totalCombinations : 0

  return c.json({
    project,
    counts,
    dimensions,
    coverageRate,
    totalCombinations,
  })
})

// ── Gap View ───────────────────────────────────────────

const STALE_WARN_DAYS = 7
const STALE_DANGER_DAYS = 30

/** GET /:slug/gaps?project={slug} — 未テスト・陳腐化セルの可視化 */
testMatrixRoutes.get('/:slug/gaps', (c) => {
  const slug = c.req.param('slug')
  const db = getDb()

  const dimensions = db.prepare(
    'SELECT name, values_json FROM test_dimensions WHERE project = ? ORDER BY sort_order'
  ).all(slug) as Array<{ name: string; values_json: string }>

  if (dimensions.length === 0) {
    return c.json({
      project: slug, cells: [], totalCombinations: 0, coverageRate: 0,
      untested: 0, staleWarn: 0, staleDanger: 0, recent: 0,
      staleDays: { warn: STALE_WARN_DAYS, danger: STALE_DANGER_DAYS },
    })
  }

  // デカルト積を生成
  const dimValues = dimensions.map(d => ({
    name: d.name,
    values: JSON.parse(d.values_json) as string[],
  }))

  const cartesian = (dims: Array<{ name: string; values: string[] }>): Array<Record<string, string>> => {
    if (dims.length === 0) return [{}]
    const [first, ...rest] = dims
    const restCombinations = cartesian(rest)
    const result: Array<Record<string, string>> = []
    for (const value of first.values) {
      for (const combo of restCombinations) {
        result.push({ [first.name]: value, ...combo })
      }
    }
    return result
  }

  const allCombinations = cartesian(dimValues)
  const nowMs = Date.now()
  const warnMs = STALE_WARN_DAYS * 24 * 60 * 60 * 1000
  const dangerMs = STALE_DANGER_DAYS * 24 * 60 * 60 * 1000

  const cells = allCombinations.map(coords => {
    const coordJson = JSON.stringify(coords)
    const record = db.prepare(
      'SELECT id, status, last_run_at, flaky_rate FROM test_records WHERE project = ? AND coordinates_json = ?'
    ).get(slug, coordJson) as { id: number; status: string; last_run_at: string | null; flaky_rate: number } | undefined

    if (!record || record.status === 'not_tested') {
      return { coordinates: coords, state: 'untested' as const, record: null }
    }

    const lastRunAt = record.last_run_at
    if (!lastRunAt) {
      return { coordinates: coords, state: 'untested' as const, record }
    }

    const ageMs = nowMs - new Date(lastRunAt).getTime()
    let state: 'recent' | 'stale_warn' | 'stale_danger'
    if (ageMs >= dangerMs) {
      state = 'stale_danger'
    } else if (ageMs >= warnMs) {
      state = 'stale_warn'
    } else {
      state = 'recent'
    }

    return { coordinates: coords, state, record }
  })

  const untested = cells.filter(c => c.state === 'untested').length
  const staleWarn = cells.filter(c => c.state === 'stale_warn').length
  const staleDanger = cells.filter(c => c.state === 'stale_danger').length
  const recent = cells.filter(c => c.state === 'recent').length
  const totalCombinations = allCombinations.length
  const coverageRate = totalCombinations > 0 ? recent / totalCombinations : 0

  return c.json({
    project: slug,
    cells,
    totalCombinations,
    coverageRate,
    untested,
    staleWarn,
    staleDanger,
    recent,
    staleDays: { warn: STALE_WARN_DAYS, danger: STALE_DANGER_DAYS },
  })
})
