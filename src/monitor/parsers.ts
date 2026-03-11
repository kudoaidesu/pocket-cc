/**
 * macOS コマンド出力パーサー
 *
 * top, powermetrics, ps の出力からシステムメトリクスを抽出する。
 */
import type { SystemMetrics, TemperatureMetrics, ProcessInfo } from './types.js'

/**
 * `top -l 1 -s 0` の出力からメモリ使用率と Load Average を抽出する。
 *
 * 期待するフォーマット:
 *   Load Avg: 1.23, 2.34, 3.45
 *   PhysMem: 16G used (2345M wired, ...), 123M unused.
 */
export function parseTopOutput(output: string): SystemMetrics {
  const timestamp = new Date().toISOString()

  // Load Average
  const loadMatch = output.match(/Load Avg:\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)/)
  if (!loadMatch) {
    throw new Error('Failed to parse Load Average from top output')
  }
  const loadAverage: [number, number, number] = [
    parseFloat(loadMatch[1]),
    parseFloat(loadMatch[2]),
    parseFloat(loadMatch[3]),
  ]

  // Physical Memory: "PhysMem: 16G used (... ), 123M unused."
  const memMatch = output.match(/PhysMem:\s*([\d.]+)([MG])\s+used.*?,\s*([\d.]+)([MG])\s+unused/)
  if (!memMatch) {
    throw new Error('Failed to parse PhysMem from top output')
  }

  const usedValue = parseFloat(memMatch[1])
  const usedUnit = memMatch[2]
  const unusedValue = parseFloat(memMatch[3])
  const unusedUnit = memMatch[4]

  const memoryUsedBytes = toBytes(usedValue, usedUnit)
  const memoryUnusedBytes = toBytes(unusedValue, unusedUnit)
  const memoryTotalBytes = memoryUsedBytes + memoryUnusedBytes
  const memoryUsagePercent = memoryTotalBytes > 0
    ? Math.round((memoryUsedBytes / memoryTotalBytes) * 1000) / 10
    : 0

  return {
    memoryUsagePercent,
    memoryUsedBytes,
    memoryTotalBytes,
    loadAverage,
    timestamp,
  }
}

/**
 * `sudo powermetrics --samplers smc -i 1 -n 1` の出力から CPU die temperature を抽出する。
 *
 * 期待するフォーマット:
 *   CPU die temperature: 45.67 C
 */
export function parsePowermetricsOutput(output: string): TemperatureMetrics {
  const timestamp = new Date().toISOString()

  const tempMatch = output.match(/CPU die temperature:\s*([\d.]+)\s*C/)
  if (!tempMatch) {
    return { cpuDieTemp: null, timestamp }
  }

  return {
    cpuDieTemp: parseFloat(tempMatch[1]),
    timestamp,
  }
}

/**
 * `ps aux -m` の出力からプロセス情報を抽出する。
 * メモリ 1GB 以上かつ稼働 2 時間以上のプロセスのみ返す。
 *
 * ps aux のカラム:
 *   USER PID %CPU %MEM VSZ RSS TT STAT STARTED TIME COMMAND
 *
 * ELAPSED を使うため `ps -eo pid,user,%mem,rss,etime,command -m` のほうが正確。
 * ここでは `ps aux -m` をベースにする要件に従い、TIME カラム（CPU時間）ではなく
 * STARTED カラムから経過時間を推定する。
 *
 * ただし正確な elapsed を取るために内部で `ps -eo pid,user,%mem,rss,etime,command -m` を
 * 呼ぶ方式に変更。parseProcessList はその出力をパースする。
 */
export function parseProcessList(output: string): ProcessInfo[] {
  const lines = output.trim().split('\n')
  if (lines.length < 2) return []

  const results: ProcessInfo[] = []

  // ヘッダー行をスキップ
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue

    // ps -eo pid,user,%mem,rss,etime,command -m
    // フォーマット: PID USER %MEM RSS ELAPSED COMMAND
    const match = line.match(
      /^\s*(\d+)\s+(\S+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.+)$/
    )
    if (!match) continue

    const pid = parseInt(match[1], 10)
    const user = match[2]
    const memPercent = parseFloat(match[3])
    const rssKb = parseInt(match[4], 10)
    const rssBytes = rssKb * 1024
    const elapsedMinutes = parseElapsedTime(match[5])
    const command = match[6]

    results.push({
      pid,
      user,
      memPercent,
      rssBytes,
      elapsedMinutes,
      command,
    })
  }

  return results
}

/**
 * ps の ELAPSED 形式をパースして分に変換する。
 *
 * フォーマット:
 *   [[dd-]hh:]mm:ss
 *   例: "2-03:45:12" → 2日3時間45分12秒 = 3105.2分
 *   例: "03:45:12" → 3時間45分12秒 = 225.2分
 *   例: "45:12" → 45分12秒 = 45.2分
 */
function parseElapsedTime(elapsed: string): number {
  let days = 0
  let rest = elapsed

  // dd- 形式の日数
  const dayMatch = rest.match(/^(\d+)-(.+)$/)
  if (dayMatch) {
    days = parseInt(dayMatch[1], 10)
    rest = dayMatch[2]
  }

  const parts = rest.split(':').map(Number)
  let hours = 0
  let minutes = 0
  let seconds = 0

  if (parts.length === 3) {
    hours = parts[0]
    minutes = parts[1]
    seconds = parts[2]
  } else if (parts.length === 2) {
    minutes = parts[0]
    seconds = parts[1]
  }

  return days * 24 * 60 + hours * 60 + minutes + seconds / 60
}

/** メモリの値をバイトに変換 */
function toBytes(value: number, unit: string): number {
  switch (unit) {
    case 'G':
      return value * 1024 * 1024 * 1024
    case 'M':
      return value * 1024 * 1024
    case 'K':
      return value * 1024
    default:
      return value
  }
}
