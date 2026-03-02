/**
 * パスガード — ファイルアクセスのセキュリティ境界チェック
 *
 * realpath 解決 + 許可ルートリストによるアクセス制御を提供する。
 * プロジェクト一覧からの動的ルート取得もここで管理。
 */
import { realpathSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { homedir } from 'node:os'

/** Tailscale CGNAT 範囲 (100.64.0.0/10) のIPリテラルかチェック */
export function isTailscaleIp(hostname: string): boolean {
  const m = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (!m) return false
  const [, a, b] = m.map(Number)
  // 100.64.0.0/10 = first octet 100, second octet 64-127
  return a === 100 && b >= 64 && b <= 127
}

/** セッションIDのフォーマット検証（パストラバーサル防止） */
export function isValidSessionId(sessionId: string): boolean {
  return /^[\w-]+$/.test(sessionId)
}

/** パスが許可されたプロジェクトルート配下かチェック（realpath解決済み） */
export function isPathAllowed(targetPath: string, allowedRoots: string[]): boolean {
  if (allowedRoots.length === 0) return false
  try {
    const resolved = realpathSync(targetPath)
    return allowedRoots.some((root) => {
      try {
        const resolvedRoot = realpathSync(root)
        return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + '/')
      } catch {
        return resolved === root || resolved.startsWith(root + '/')
      }
    })
  } catch {
    // パスが存在しない場合は正規化前の文字列でチェック
    const normalized = resolve(targetPath)
    return allowedRoots.some((root) => normalized === root || normalized.startsWith(root + '/'))
  }
}

// --- プロジェクトパスバウンダリ（共有ユーティリティ） ---

const PROJECTS_JSON = resolve(process.cwd(), 'projects.json')
const WORK_DIR = process.env.WORK_DIR || join(homedir(), 'work')

/** projects.json + ワークディレクトリスキャンから許可パス一覧を取得 */
export function getAllowedProjectRoots(): string[] {
  const roots: string[] = []

  // projects.json から読み込み
  try {
    const raw = readFileSync(PROJECTS_JSON, 'utf-8')
    const parsed = JSON.parse(raw) as Array<{ localPath: string }>
    for (const p of parsed) {
      if (p.localPath) roots.push(p.localPath)
    }
  } catch { /* file not found */ }

  // ワークディレクトリをスキャン
  try {
    const entries = readdirSync(WORK_DIR, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const dirPath = join(WORK_DIR, entry.name)
      if (existsSync(join(dirPath, '.git'))) {
        roots.push(dirPath)
      }
    }
  } catch { /* dir not found */ }

  return [...new Set(roots)]
}

/** プロジェクトルート一覧に対するパスチェック（全API共有） */
export function isProjectPathAllowed(targetPath: string): boolean {
  return isPathAllowed(targetPath, getAllowedProjectRoots())
}
