/**
 * Document Viewer API Factory
 *
 * 汎用ドキュメントビューア API を生成するファクトリ。
 * 各プロジェクトの docs/{subdir}/*.md をスキャンし、
 * メタデータ一覧の返却と個別MDコンテンツの配信を行う。
 */
import { Hono } from 'hono'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createLogger } from '../../utils/logger.js'

interface ProjectEntry {
  slug: string
  repo: string
  localPath: string
}

interface DocReportEntry {
  filename: string
  title: string
  date: string
  branch: string
  issue: string
  project: string
}

const PROJECTS_JSON = resolve(process.cwd(), 'projects.json')

function loadProjects(): ProjectEntry[] {
  try {
    const raw = readFileSync(PROJECTS_JSON, 'utf-8')
    return JSON.parse(raw) as ProjectEntry[]
  } catch { return [] }
}

/** MD先頭からメタデータをパース */
function parseMeta(content: string, fallbackProject: string): Omit<DocReportEntry, 'filename'> {
  const head = content.slice(0, 2000)
  const title = head.match(/^# (.+)$/m)?.[1]?.trim() || 'Untitled'
  const date = head.match(/\*\*日付\*\*:\s*(.+)$/m)?.[1]?.trim() || ''
  const branch = head.match(/\*\*ブランチ\*\*:\s*(.+)$/m)?.[1]?.trim() || ''
  const issue = head.match(/\*\*Issue\*\*:\s*(.+)$/m)?.[1]?.trim() || ''
  const project = head.match(/\*\*プロジェクト\*\*:\s*(.+)$/m)?.[1]?.trim() || fallbackProject
  return { title, date, branch, issue, project }
}

/** ファイル名バリデーション（パストラバーサル防止） */
function isValidFilename(name: string): boolean {
  return /^[\w][\w.-]*\.md$/.test(name) && !name.includes('..')
}

function isValidScreenshotName(name: string): boolean {
  return /^[\w][\w.-]*\.(png|jpe?g|webp|gif)$/i.test(name) && !name.includes('..')
}

/**
 * ドキュメントビューア API ルートを生成する
 * @param docType - ドキュメント種別（ログ出力用）
 * @param subdir - docs/ 以下のサブディレクトリ名
 */
export function createDocRoutes(docType: string, subdir: string): Hono {
  const log = createLogger(`web:${docType}`)
  const routes = new Hono()

  /** GET / — ドキュメント一覧 */
  routes.get('/', (c) => {
    const filterProject = c.req.query('project') || ''
    const projects = loadProjects()
    const reports: DocReportEntry[] = []

    for (const p of projects) {
      if (filterProject && p.slug !== filterProject) continue
      const docsDir = join(p.localPath, 'docs', subdir)
      if (!existsSync(docsDir)) continue

      try {
        const files = readdirSync(docsDir).filter(f => f.endsWith('.md'))
        for (const f of files) {
          try {
            const content = readFileSync(join(docsDir, f), 'utf-8')
            const meta = parseMeta(content, p.slug)
            reports.push({ filename: f, ...meta })
          } catch (e) {
            log.warn(`Failed to parse ${f}: ${e}`)
          }
        }
      } catch (e) {
        log.warn(`Failed to read ${docsDir}: ${e}`)
      }
    }

    reports.sort((a, b) => {
      const dateCmp = b.date.localeCompare(a.date)
      if (dateCmp !== 0) return dateCmp
      return b.filename.localeCompare(a.filename)
    })

    return c.json({ reports })
  })

  /** GET /:project/:filename — MDコンテンツ返却 */
  routes.get('/:project/:filename', (c) => {
    const projectSlug = c.req.param('project')
    const filename = c.req.param('filename')

    if (!isValidFilename(filename)) {
      return c.json({ error: 'Invalid filename' }, 400)
    }

    const projects = loadProjects()
    const project = projects.find(p => p.slug === projectSlug)
    if (!project) return c.json({ error: 'Project not found' }, 404)

    const filePath = join(project.localPath, 'docs', subdir, filename)
    if (!existsSync(filePath)) return c.json({ error: 'Report not found' }, 404)

    try {
      const content = readFileSync(filePath, 'utf-8')
      return c.json({ content, filename, project: projectSlug })
    } catch {
      return c.json({ error: 'Failed to read file' }, 500)
    }
  })

  /** GET /:project/screenshots/:name — スクリーンショット配信 */
  routes.get('/:project/screenshots/:name', (c) => {
    const projectSlug = c.req.param('project')
    const name = c.req.param('name')

    if (!name || !isValidScreenshotName(name)) {
      return c.json({ error: 'Invalid filename' }, 400)
    }

    const projects = loadProjects()
    const project = projects.find(p => p.slug === projectSlug)
    if (!project) return c.json({ error: 'Project not found' }, 404)

    const filePath = join(project.localPath, 'docs', subdir, 'screenshots', name)
    if (!existsSync(filePath)) return c.json({ error: 'Not found' }, 404)

    const data = readFileSync(filePath)
    const ext = name.split('.').pop()?.toLowerCase()
    const mime = ext === 'png' ? 'image/png'
      : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
      : ext === 'webp' ? 'image/webp' : 'image/png'

    return new Response(data, {
      headers: { 'Content-Type': mime, 'Cache-Control': 'public, max-age=3600' },
    })
  })

  return routes
}
