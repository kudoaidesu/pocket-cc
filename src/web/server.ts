/**
 * Web サーバー — Hono + Tailscaleバインド
 *
 * Tailscaleインターフェースのみにバインドし、ローカルポートは公開しない。
 * 認証はTailscaleのACLに委譲する。
 * 起動: npx tsx src/web/server.ts
 */
import 'dotenv/config'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from '@hono/node-server/serve-static'
import { serve } from '@hono/node-server'
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { resolve, join, basename } from 'node:path'
import { homedir, networkInterfaces } from 'node:os'
import { execFileSync } from 'node:child_process'
import { isTailscaleIp, isProjectPathAllowed } from './path-guard.js'
import { chatRoutes } from './routes/chat.js'
import { observerRoutes } from './routes/observer.js'
import { createLogger } from '../utils/logger.js'
import { getStrategyStats, getRecentEvaluations } from '../utils/cost-tracker.js'
import { getDb } from '../db/index.js'
import { listIssues, createIssue } from '../github/issues.js'

const log = createLogger('web:server')

// --- 設定 ---
const PORT = Number(process.env.WEB_PORT || '3100')

/** ネットワークインターフェースからTailscale IPを動的検出 */
function detectTailscaleIp(): string {
  const ifaces = networkInterfaces()
  for (const iface of Object.values(ifaces)) {
    for (const addr of iface ?? []) {
      if (addr.family === 'IPv4' && isTailscaleIp(addr.address)) {
        return addr.address
      }
    }
  }
  return '127.0.0.1' // Tailscaleが使えない環境ではローカルのみ
}

const HOST = process.env.WEB_HOST || detectTailscaleIp()

// --- プロジェクト一覧（projects.json + 自動スキャン） ---
interface ProjectEntry {
  slug: string
  repo: string
  localPath: string
  source: 'manual' | 'scanned'
}

const PROJECTS_JSON = resolve(process.cwd(), 'projects.json')
const WORK_DIR = process.env.WORK_DIR || join(homedir(), 'work')

/** projects.json から手動登録プロジェクトを読み込み */
function loadProjectsJson(): ProjectEntry[] {
  try {
    const raw = readFileSync(PROJECTS_JSON, 'utf-8')
    const parsed = JSON.parse(raw) as Array<{ slug: string; repo: string; localPath: string }>
    return parsed.map((p) => ({ slug: p.slug, repo: p.repo, localPath: p.localPath, source: 'manual' as const }))
  } catch {
    return []
  }
}

/** projects.json に保存 */
function saveProjectsJson(entries: ProjectEntry[]): void {
  const data = entries.map((p) => ({ slug: p.slug, repo: p.repo, localPath: p.localPath }))
  writeFileSync(PROJECTS_JSON, JSON.stringify(data, null, 2) + '\n', 'utf-8')
}

/** git remote URL から owner/repo を抽出 */
function extractRepo(remoteUrl: string): string {
  // https://github.com/owner/repo.git → owner/repo
  // git@github.com:owner/repo.git → owner/repo
  const m = remoteUrl.match(/github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/)
  return m ? m[1] : ''
}

/** ディレクトリをスキャンして git リポジトリを検出 */
function scanWorkDirectory(): ProjectEntry[] {
  const results: ProjectEntry[] = []
  try {
    const entries = readdirSync(WORK_DIR, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const dirPath = join(WORK_DIR, entry.name)
      if (!existsSync(join(dirPath, '.git'))) continue

      let repo = ''
      try {
        const url = gitExec(dirPath, ['remote', 'get-url', 'origin'], 3000)
        repo = extractRepo(url)
      } catch { /* no remote */ }

      results.push({
        slug: entry.name,
        repo,
        localPath: dirPath,
        source: 'scanned',
      })
    }
  } catch (e) {
    log.warn(`Failed to scan ${WORK_DIR}: ${e}`)
  }
  return results
}

/** 手動登録 + 自動スキャンをマージ（手動の slug/repo が優先） */
function getProjects(): ProjectEntry[] {
  const manual = loadProjectsJson()
  const scanned = scanWorkDirectory()
  const scannedPaths = new Set(scanned.map((s) => s.localPath))

  // manual エントリがスキャン範囲内なら source を scanned に（削除ボタン非表示）
  const merged = manual.map((m) => (scannedPaths.has(m.localPath) ? { ...m, source: 'scanned' as const } : m))
  const seen = new Set(manual.map((p) => p.localPath))
  return [...merged, ...scanned.filter((s) => !seen.has(s.localPath))]
}

// isProjectPathAllowed は path-guard.ts から import 済み

/** git コマンドを argv 形式で安全に実行 */
function gitExec(projectPath: string, args: string[], timeout = 5000): string {
  return execFileSync('git', ['-C', projectPath, ...args], {
    encoding: 'utf-8',
    timeout,
  }).trim()
}

// --- Hono アプリ ---
const app = new Hono()

// CORS（Tailscale ネットワーク内のオリジンのみ許可）
app.use('*', cors({
  origin: (origin) => {
    if (!origin) return `http://${HOST}:${PORT}` // same-origin requests
    // Tailscale IP (100.64.0.0/10 リテラル) と localhost を許可
    try {
      const url = new URL(origin)
      if (isTailscaleIp(url.hostname) || url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
        return origin
      }
    } catch { /* invalid origin */ }
    return null // deny
  },
}))

// 静的ファイル配信
app.use('/static/*', serveStatic({ root: resolve(process.cwd(), 'src/web/public'), rewriteRequestPath: (path) => path.replace('/static', '') }))

// --- API ルート ---

// チャット（SSEストリーミング）
app.route('/api/chat', chatRoutes)

// プロジェクト一覧（手動 + 自動スキャン + フロントデスク）
app.get('/api/projects', (c) => {
  const projects = getProjects()
  // フロントデスクエントリを先頭に追加
  const frontDesk: ProjectEntry = {
    slug: 'front-desk',
    repo: '',
    localPath: '__front-desk__',
    source: 'manual',
  }
  return c.json([frontDesk, ...projects])
})

// プロジェクト追加（projects.json に永続化）
app.post('/api/projects', async (c) => {
  const body = await c.req.json<{ localPath: string; slug?: string; repo?: string }>()
  const { localPath } = body
  if (!localPath) return c.json({ error: 'localPath is required' }, 400)

  // パスの存在チェック
  try {
    const stat = statSync(localPath)
    if (!stat.isDirectory()) return c.json({ error: 'Path is not a directory' }, 400)
  } catch {
    return c.json({ error: 'Path does not exist' }, 400)
  }

  // git リポジトリチェック
  if (!existsSync(join(localPath, '.git'))) {
    return c.json({ error: 'Not a git repository' }, 400)
  }

  // slug 自動検出
  const slug = body.slug || basename(localPath)

  // repo 自動検出
  let repo = body.repo || ''
  if (!repo) {
    try {
      const url = gitExec(localPath, ['remote', 'get-url', 'origin'], 3000)
      repo = extractRepo(url)
    } catch { /* no remote */ }
  }

  // 既に projects.json にあるか確認
  const manual = loadProjectsJson()
  if (manual.some((p) => p.localPath === localPath)) {
    return c.json({ error: 'Project already registered' }, 409)
  }

  // 追加して保存
  manual.push({ slug, repo, localPath, source: 'manual' })
  saveProjectsJson(manual)

  return c.json(getProjects())
})

// プロジェクト削除（projects.json から除去）
app.delete('/api/projects', async (c) => {
  const body = await c.req.json<{ localPath: string }>()
  const { localPath } = body
  if (!localPath) return c.json({ error: 'localPath is required' }, 400)

  const manual = loadProjectsJson()
  const filtered = manual.filter((p) => p.localPath !== localPath)
  if (filtered.length === manual.length) {
    return c.json({ error: 'Project not found in manual list' }, 404)
  }

  saveProjectsJson(filtered)
  return c.json(getProjects())
})

// Issue一覧（担当者情報付き）
app.get('/api/issues', async (c) => {
  const slug = c.req.query('project')
  const state = (c.req.query('state') || 'open') as 'open' | 'closed' | 'all'
  const projects = getProjects()
  const project = slug ? projects.find((p) => p.slug === slug) : projects[0]
  const repo = project?.repo || undefined
  try {
    const issues = await listIssues(repo, state)
    return c.json(issues)
  } catch (e) {
    return c.json({ error: String(e) }, 500)
  }
})

// Issue作成
app.post('/api/issues', async (c) => {
  const body = await c.req.json<{ title: string; body: string; labels?: string[]; project?: string }>()
  if (!body.title) return c.json({ error: 'title is required' }, 400)
  const projects = getProjects()
  const project = body.project ? projects.find((p) => p.slug === body.project) : projects[0]
  const repo = project?.repo || undefined
  try {
    const issue = await createIssue({ title: body.title, body: body.body || '', labels: body.labels, repo })
    return c.json(issue)
  } catch (e) {
    return c.json({ error: String(e) }, 500)
  }
})

// ヘルスチェック（キュー状態を含む）
app.get('/api/health', (c) => {
  let queueDetail = null
  try {
    const raw = readFileSync(resolve(process.cwd(), 'data', 'health-status.json'), 'utf-8')
    queueDetail = JSON.parse(raw)
  } catch {
    // health-status.json がまだ存在しない場合は null
  }
  return c.json({ ok: true, timestamp: Date.now(), queue: queueDetail })
})

// --- プロジェクト横断ダッシュボード API ---
app.get('/api/dashboard', async (c) => {
  const projects = getProjects().filter(p => p.repo)
  const result: Array<Record<string, unknown>> = []

  for (const p of projects) {
    const item: Record<string, unknown> = { slug: p.slug, repo: p.repo, localPath: p.localPath }
    try {
      item.branch = gitExec(p.localPath, ['rev-parse', '--abbrev-ref', 'HEAD'])
      item.lastCommit = gitExec(p.localPath, ['log', '-1', '--format=%h %s', '--date=short'])
      const status = gitExec(p.localPath, ['status', '--porcelain'])
      item.dirtyFiles = status ? status.split('\n').length : 0
    } catch { /* git not available */ }
    try {
      const issueJson = execFileSync('gh', [
        '--repo', p.repo, 'issue', 'list', '--state', 'open', '--limit', '100',
        '--json', 'number,title,labels,updatedAt',
      ], { encoding: 'utf-8', timeout: 10000 }).trim()
      const issues = JSON.parse(issueJson) as Array<{ number: number; title: string; labels: Array<{ name: string }>; updatedAt: string }>
      item.openIssues = issues.length
      item.issues = issues.slice(0, 5).map(i => ({ number: i.number, title: i.title, labels: i.labels.map(l => l.name) }))
    } catch { item.openIssues = 0; item.issues = [] }
    try {
      const prJson = execFileSync('gh', [
        '--repo', p.repo, 'pr', 'list', '--state', 'open', '--limit', '100',
        '--json', 'number,title,headRefName,isDraft',
      ], { encoding: 'utf-8', timeout: 10000 }).trim()
      const prs = JSON.parse(prJson) as Array<{ number: number; title: string; headRefName: string; isDraft: boolean }>
      item.openPRs = prs.length
      item.prs = prs.slice(0, 5).map(pr => ({ number: pr.number, title: pr.title, branch: pr.headRefName, isDraft: pr.isDraft }))
    } catch { item.openPRs = 0; item.prs = [] }
    result.push(item)
  }

  let health = null
  try {
    const raw = readFileSync(resolve(process.cwd(), 'data', 'health-status.json'), 'utf-8')
    health = JSON.parse(raw)
  } catch { /* not available */ }

  return c.json({ projects: result, health, timestamp: Date.now() })
})

// Strategy 評価レポート
app.get('/api/evaluations', (c) => {
  return c.json({
    stats: getStrategyStats(),
    recent: getRecentEvaluations(20),
  })
})

// --- スクリーンショット API ---
const SCREENSHOTS_DIR = resolve(process.cwd(), 'data', 'screenshots')

app.get('/api/screenshots', (c) => {
  try {
    if (!existsSync(SCREENSHOTS_DIR)) return c.json([])
    const files = readdirSync(SCREENSHOTS_DIR)
      .filter(f => /\.(png|jpe?g|webp|gif)$/i.test(f))
      .map(f => {
        const st = statSync(join(SCREENSHOTS_DIR, f))
        return { name: f, size: st.size, mtime: st.mtimeMs }
      })
      .sort((a, b) => b.mtime - a.mtime)
    return c.json(files)
  } catch (e) {
    return c.json({ error: String(e) }, 500)
  }
})

app.get('/screenshots/:name', (c) => {
  const name = c.req.param('name')
  if (!name || /[/\\]/.test(name)) return c.json({ error: 'invalid' }, 400)
  const filePath = join(SCREENSHOTS_DIR, name)
  if (!existsSync(filePath)) return c.json({ error: 'not found' }, 404)
  const data = readFileSync(filePath)
  const ext = name.split('.').pop()?.toLowerCase()
  const mime = ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png'
  return new Response(data, { headers: { 'Content-Type': mime, 'Cache-Control': 'public, max-age=3600' } })
})

// --- コスト集計 API ---
app.get('/api/cost-summary', (c) => {
  try {
    const db = getDb()
    // 全体サマリー
    const overall = db.prepare(`
      SELECT
        SUM(total_cost) as totalCost,
        SUM(total_turns) as totalTurns,
        SUM(total_duration_ms) as totalDuration,
        COUNT(*) as sessionCount
      FROM sessions WHERE archived = 0
    `).get() as Record<string, number> | undefined

    // モデル別集計
    const byModel = db.prepare(`
      SELECT
        model,
        SUM(total_cost) as totalCost,
        SUM(total_turns) as totalTurns,
        COUNT(*) as sessionCount
      FROM sessions WHERE archived = 0 AND model != '' GROUP BY model ORDER BY totalCost DESC
    `).all() as Array<Record<string, unknown>>

    // 日別集計（直近7日）
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
    const daily = db.prepare(`
      SELECT
        date(last_used / 1000, 'unixepoch', 'localtime') as day,
        SUM(total_cost) as totalCost,
        SUM(total_turns) as totalTurns,
        COUNT(*) as sessionCount
      FROM sessions WHERE last_used > ? AND archived = 0
      GROUP BY day ORDER BY day DESC
    `).all(sevenDaysAgo) as Array<Record<string, unknown>>

    // コスト上位セッション
    const topSessions = db.prepare(`
      SELECT session_id, message_preview, model, total_cost, total_turns, total_duration_ms, last_used
      FROM sessions WHERE total_cost > 0 AND archived = 0
      ORDER BY total_cost DESC LIMIT 10
    `).all() as Array<Record<string, unknown>>

    return c.json({ overall, byModel, daily, topSessions })
  } catch (e) {
    return c.json({ error: String(e) }, 500)
  }
})

// --- ファイルツリー・ソース閲覧 API ---

/** ディレクトリの内容を返す */
app.get('/api/files', (c) => {
  const dirPath = c.req.query('path')
  if (!dirPath) return c.json({ error: 'path is required' }, 400)

  // パスがプロジェクトルート配下かチェック
  if (!isProjectPathAllowed(dirPath)) {
    return c.json({ error: 'Access denied: path outside allowed projects' }, 403)
  }

  try {
    const entries = readdirSync(dirPath, { withFileTypes: true })
    const items = entries
      .filter(e => !e.name.startsWith('.'))
      .map(e => {
        const fullPath = join(dirPath, e.name)
        const isDir = e.isDirectory()
        let size = 0
        if (!isDir) {
          try { size = statSync(fullPath).size } catch { /* skip */ }
        }
        return { name: e.name, path: fullPath, isDir, size }
      })
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
        return a.name.localeCompare(b.name)
      })
    return c.json({ items })
  } catch (e) {
    return c.json({ error: String(e) }, 400)
  }
})

/** ファイルの中身を返す */
app.get('/api/files/content', (c) => {
  const filePath = c.req.query('path')
  if (!filePath) return c.json({ error: 'path is required' }, 400)

  // パスがプロジェクトルート配下かチェック
  if (!isProjectPathAllowed(filePath)) {
    return c.json({ error: 'Access denied: path outside allowed projects' }, 403)
  }

  try {
    const stat = statSync(filePath)
    // 1MB以上は拒否
    if (stat.size > 1024 * 1024) {
      return c.json({ error: 'File too large (>1MB)' }, 400)
    }
    const content = readFileSync(filePath, 'utf-8')
    return c.json({ content, size: stat.size, path: filePath })
  } catch (e) {
    return c.json({ error: String(e) }, 400)
  }
})

/** ファイル名検索（再帰、最大100件） */
app.get('/api/files/search', (c) => {
  const project = c.req.query('project')
  const query = c.req.query('q')
  if (!project || !query) return c.json({ items: [] })

  // パスがプロジェクトルート配下かチェック
  if (!isProjectPathAllowed(project)) {
    return c.json({ error: 'Access denied: path outside allowed projects' }, 403)
  }

  const results: Array<{ name: string; path: string; isDir: boolean }> = []
  const lowerQ = query.toLowerCase()
  const maxResults = 100
  const ignoreDirs = new Set(['node_modules', '.git', 'dist', '.next', '.cache', 'coverage', '__pycache__'])

  function walk(dir: string, depth: number) {
    if (depth > 8 || results.length >= maxResults) return
    try {
      const entries = readdirSync(dir, { withFileTypes: true })
      for (const e of entries) {
        if (results.length >= maxResults) break
        if (e.name.startsWith('.') || ignoreDirs.has(e.name)) continue
        const fullPath = join(dir, e.name)
        if (e.name.toLowerCase().includes(lowerQ)) {
          results.push({ name: e.name, path: fullPath, isDir: e.isDirectory() })
        }
        if (e.isDirectory()) walk(fullPath, depth + 1)
      }
    } catch { /* skip unreadable dirs */ }
  }
  walk(project, 0)
  return c.json({ items: results })
})

// --- Git 状況 API ---
app.get('/api/git/status', (c) => {
  const project = c.req.query('project')
  if (!project) return c.json({ error: 'project is required' }, 400)

  // パスがプロジェクトルート配下かチェック
  if (!isProjectPathAllowed(project)) {
    return c.json({ error: 'Access denied: path outside allowed projects' }, 403)
  }

  try {
    // ブランチ名
    const branch = gitExec(project, ['branch', '--show-current'])

    // 未コミットファイル
    const statusRaw = gitExec(project, ['status', '--porcelain'])
    const files = statusRaw ? statusRaw.split('\n').map(line => ({
      status: line.slice(0, 2).trim(),
      file: line.slice(2).trimStart(),
    })) : []

    // 未プッシュ / 未プル コミット数
    let unpushed = 0
    let unpulled = 0
    try {
      const lr = gitExec(project, ['rev-list', '--left-right', '--count', 'HEAD...@{u}'])
      const [a, b] = lr.split('\t').map(n => parseInt(n, 10) || 0)
      unpushed = a
      unpulled = b
    } catch { /* no upstream */ }

    // ブランチ一覧
    let branches: Array<{ name: string; current: boolean }> = []
    try {
      const branchRaw = gitExec(project, ['branch', '--format=%(refname:short)'])
      branches = branchRaw ? branchRaw.split('\n').map(b => ({ name: b, current: b === branch })) : []
    } catch { /* skip */ }

    // リモートURL → repo
    let repo = ''
    try {
      const url = gitExec(project, ['remote', 'get-url', 'origin'], 3000)
      repo = extractRepo(url)
    } catch { /* no remote */ }

    return c.json({ branch, branches, files, unpushed, unpulled, repo })
  } catch (e) {
    return c.json({ error: String(e) }, 500)
  }
})

// --- プロセス/サーバー一覧 API ---
app.get('/api/processes', (c) => {
  try {
    const raw = execFileSync('lsof', ['-i', '-P', '-n', '-sTCP:LISTEN'], { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'ignore'] }).trim()
    const lines = raw.split('\n').slice(1) // skip header
    const seen = new Map<number, { pid: number; command: string; port: number; host: string; accessible: boolean }>()

    // システムプロセス・ブラウザ内部ポートは除外
    const ignoreCommands = new Set(['Google', 'GoogleSof', 'com.apple', 'rapportd', 'sharingd', 'ControlCe'])

    for (const line of lines) {
      const parts = line.split(/\s+/)
      if (parts.length < 9) continue
      const command = parts[0]
      const pid = parseInt(parts[1], 10)
      const nameCol = parts[8] || ''
      const portMatch = nameCol.match(/:(\d+)$/)
      if (!portMatch) continue
      const port = parseInt(portMatch[1], 10)

      // システムプロセスをスキップ
      if (ignoreCommands.has(command)) continue

      // 重複排除（同一ポート最初のみ）
      if (!seen.has(port)) {
        const host = nameCol.replace(`:${port}`, '')
        // Tailscaleからアクセス可能か判定
        // 0.0.0.0 / * / [::] = 全インターフェース → アクセス可能
        // 127.0.0.1 / [::1] = ローカルのみ → アクセス不可
        // Tailscale CGNAT IP (100.64.0.0/10) にバインド → アクセス可能
        const accessible = host === '*' || host === '0.0.0.0' || host === '[::]' || isTailscaleIp(host)
        seen.set(port, { pid, command, port, host, accessible })
      }
    }

    const items = Array.from(seen.values()).sort((a, b) => a.port - b.port)
    return c.json({ items })
  } catch (e) {
    return c.json({ items: [] })
  }
})

// --- MCP サーバー一覧 API ---
app.get('/api/mcp', (c) => {
  const project = c.req.query('project') || ''

  // プロジェクトパスが指定されている場合はバウンダリチェック
  if (project && !isProjectPathAllowed(project)) {
    return c.json({ error: 'Access denied: path outside allowed projects' }, 403)
  }

  const items: Array<{ name: string; type: string; command: string; source: string; disabled?: boolean; envKeys?: string[] }> = []
  const sources: Array<{ path: string; label: string }> = [
    ...(project ? [{ path: join(project, '.mcp.json'), label: 'project' }] : []),
    { path: join(homedir(), '.claude', 'settings.json'), label: 'user' },
    { path: join(homedir(), '.claude', 'settings.local.json'), label: 'user-local' },
  ]
  for (const src of sources) {
    try {
      const raw = JSON.parse(readFileSync(src.path, 'utf-8'))
      const servers = raw.mcpServers || {}
      for (const [name, cfg] of Object.entries(servers as Record<string, { type?: string; command?: string; args?: string[]; disabled?: boolean; env?: Record<string, string> }>)) {
        if (!items.find(i => i.name === name)) {
          items.push({
            name,
            type: cfg.type || 'stdio',
            command: [cfg.command, ...(cfg.args || [])].filter(Boolean).join(' '),
            source: src.label,
            disabled: cfg.disabled || false,
            envKeys: cfg.env ? Object.keys(cfg.env) : [],
          })
        }
      }
    } catch { /* file not found or parse error */ }
  }
  return c.json({ items })
})

// --- SKILLS 一覧 API ---
app.get('/api/skills', (c) => {
  const project = c.req.query('project') || ''

  // プロジェクトパスが指定されている場合はバウンダリチェック
  if (project && !isProjectPathAllowed(project)) {
    return c.json({ error: 'Access denied: path outside allowed projects' }, 403)
  }

  const items: Array<{ name: string; title: string }> = []
  const dirs = [
    ...(project ? [join(project, '.claude', 'skills')] : []),
    join(homedir(), '.claude', 'skills'),
  ]
  for (const dir of dirs) {
    try {
      const files = readdirSync(dir)
      for (const f of files) {
        const name = f.replace(/\.(md|txt)$/, '')
        if (!items.find(i => i.name === name)) {
          // 1行目をタイトルとして取得
          let title = name
          try {
            const firstLine = readFileSync(join(dir, f), 'utf-8').split('\n').find(l => l.trim())
            title = firstLine?.replace(/^#+\s*/, '').trim() || name
          } catch { /* skip */ }
          items.push({ name, title })
        }
      }
    } catch { /* dir not found */ }
  }
  return c.json({ items: items.sort((a, b) => a.name.localeCompare(b.name)) })
})

// --- Observer UI ---
app.route('/api/observe', observerRoutes)
app.get('/observer.html', (c) => c.redirect('/observer', 301))
app.get('/observer', (c) => {
  try {
    const html = readFileSync(resolve(process.cwd(), 'src/web/public/observer.html'), 'utf-8')
    c.header('Cache-Control', 'no-cache, no-store, must-revalidate')
    return c.html(html)
  } catch {
    return c.text('observer.html not found', 404)
  }
})

// --- SPA フォールバック ---
app.get('*', (c) => {
  try {
    const html = readFileSync(resolve(process.cwd(), 'src/web/public/index.html'), 'utf-8')
    c.header('Cache-Control', 'no-cache, no-store, must-revalidate')
    return c.html(html)
  } catch {
    return c.text('index.html not found', 404)
  }
})

// --- サーバー起動 ---
log.info(`Starting web server on ${HOST}:${PORT} (Tailscale only)`)

const server = serve({
  fetch: app.fetch,
  hostname: HOST,
  port: PORT,
})

// SSEストリーミングは長時間接続 — Node.jsデフォルトタイムアウト(120s)を無効化
const httpServer = server as unknown as { timeout: number; keepAliveTimeout: number }
httpServer.timeout = 0
httpServer.keepAliveTimeout = 0

log.info(`Web server running: http://${HOST}:${PORT}`)
