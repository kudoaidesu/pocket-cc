/**
 * SQLite データベース — シングルトン
 *
 * WALモードで同時読み書き対応。プロセス終了時に自動クローズ。
 * 起動: getDb() を呼ぶだけでスキーマ初期化+データ移行が走る。
 */
import Database from 'better-sqlite3'
import { existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initSchema } from './schema.js'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DB_PATH = join(projectRoot, 'data', 'pocket-cc.db')

let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (db) return db

  const dir = dirname(DB_PATH)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  // パフォーマンス: 通常同期レベルで十分（WAL + シングルライター）
  db.pragma('synchronous = NORMAL')
  // WALモードでの書き込み競合対策（5秒待機）
  db.pragma('busy_timeout = 5000')

  initSchema(db)

  process.on('exit', () => {
    db?.close()
    db = null
  })

  return db
}

/** テスト用: DBをクローズしてシングルトンをリセット */
export function closeDb(): void {
  db?.close()
  db = null
}

export { DB_PATH }
