/**
 * システムモニター型定義
 */

/** CPU/メモリの統合メトリクス */
export interface SystemMetrics {
  /** メモリ使用率（0-100） */
  memoryUsagePercent: number
  /** メモリ使用量（バイト） */
  memoryUsedBytes: number
  /** メモリ総量（バイト） */
  memoryTotalBytes: number
  /** Load Average（1分, 5分, 15分） */
  loadAverage: [number, number, number]
  /** 取得時刻 */
  timestamp: string
}

/** CPU温度メトリクス */
export interface TemperatureMetrics {
  /** CPU die 温度（℃） */
  cpuDieTemp: number | null
  /** 取得時刻 */
  timestamp: string
}

/** プロセス情報 */
export interface ProcessInfo {
  pid: number
  user: string
  /** メモリ使用率（%） */
  memPercent: number
  /** RSS（バイト） */
  rssBytes: number
  /** 実行時間（分） */
  elapsedMinutes: number
  command: string
}

/** アラート種別 */
export type AlertType =
  | 'high_memory'
  | 'high_load'
  | 'high_temperature'
  | 'stuck_process'

/** アラート情報 */
export interface Alert {
  type: AlertType
  title: string
  body: string
  metadata: Record<string, unknown>
}

/** 監視閾値 */
export interface MonitorThresholds {
  /** メモリ使用率の閾値（%） */
  memoryPercent: number
  /** Load Average の閾値 */
  loadAverage: number
  /** CPU温度の閾値（℃） */
  cpuTemperature: number
  /** プロセスメモリ閾値（バイト） */
  processMemoryBytes: number
  /** プロセス稼働時間閾値（分） */
  processElapsedMinutes: number
}
