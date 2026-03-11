/**
 * システムモニター
 *
 * macOS のシステムリソース（CPU、メモリ、温度）を監視し、
 * 閾値超過時に Web Push 通知を送る。
 *
 * 監視項目:
 *   - メモリ使用率 > 90%
 *   - Load Average > 8（M2 の 8 コア基準）
 *   - CPU温度 > 80℃
 *   - stuck プロセス: メモリ 1GB 以上 & 稼働 2 時間以上
 *
 * データ収集:
 *   - CPU/メモリ: `top -l 1 -s 0`
 *   - 温度: `sudo /usr/bin/powermetrics --samplers smc -i 1 -n 1`
 *   - プロセス: `ps -eo pid,user,%mem,rss,etime,command -m`
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import cron, { type ScheduledTask } from 'node-cron'
import { createLogger } from '../utils/logger.js'
import { parseTopOutput, parsePowermetricsOutput, parseProcessList } from './parsers.js'
import { sendAlert } from './alerts.js'
import type { Alert, MonitorThresholds, SystemMetrics, TemperatureMetrics, ProcessInfo } from './types.js'

const log = createLogger('system-monitor')

const execFileAsync = promisify(execFile)

/**
 * stuck_process アラートから除外するコマンドパターン（部分一致）。
 * 常時起動が想定される長寿命プロセスを登録する。
 */
const STUCK_PROCESS_ALLOWLIST: string[] = [
  'com.apple.Virtualization.VirtualMachine', // Colima（Docker VM）
  'colima',                                  // Colima デーモン
  'limactl',                                 // Lima（Colimaのバックエンド）
  'next-server',                             // Next.js 本番サーバー（常時起動）
]

/** デフォルト閾値 */
const DEFAULT_THRESHOLDS: MonitorThresholds = {
  memoryPercent: 90,
  loadAverage: 8,
  cpuTemperature: 80,
  processMemoryBytes: 1 * 1024 * 1024 * 1024, // 1GB
  processElapsedMinutes: 2 * 60, // 2時間
}

// ── データ収集 ─────────────────────────────────────────────────

/**
 * `top -l 1 -s 0` でCPU/メモリ情報を取得する。
 */
async function collectSystemMetrics(): Promise<SystemMetrics | null> {
  try {
    const { stdout } = await execFileAsync('/usr/bin/top', ['-l', '1', '-s', '0'], {
      timeout: 10_000,
    })
    return parseTopOutput(stdout)
  } catch (e) {
    log.error(`Failed to collect system metrics: ${e}`)
    return null
  }
}

/**
 * `sudo /usr/bin/powermetrics` でCPU温度を取得する。
 * sudo 権限が必要。sudoers で NOPASSWD 設定がない場合は null を返す。
 */
async function collectTemperature(): Promise<TemperatureMetrics | null> {
  try {
    const { stdout } = await execFileAsync(
      '/usr/bin/sudo',
      ['/usr/bin/powermetrics', '--samplers', 'smc', '-i', '1', '-n', '1'],
      { timeout: 15_000 },
    )
    return parsePowermetricsOutput(stdout)
  } catch (e) {
    // sudo 権限がない場合は警告のみ（初回のみログ出力）
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('password') || msg.includes('Permission denied')) {
      log.warn('powermetrics requires sudo NOPASSWD — skipping temperature monitoring')
    } else {
      log.error(`Failed to collect temperature: ${msg}`)
    }
    return null
  }
}

/**
 * `ps -eo pid,user,%mem,rss,etime,command -m` でプロセス一覧を取得する。
 */
async function collectProcessList(): Promise<ProcessInfo[]> {
  try {
    const { stdout } = await execFileAsync(
      '/bin/ps',
      ['-eo', 'pid,user,%mem,rss,etime,command', '-m'],
      { timeout: 10_000 },
    )
    return parseProcessList(stdout)
  } catch (e) {
    log.error(`Failed to collect process list: ${e}`)
    return []
  }
}

// ── 閾値判定 ─────────────────────────────────────────────────

/**
 * 収集したメトリクスから閾値超過のアラートを生成する。
 */
function evaluateAlerts(
  metrics: SystemMetrics | null,
  temperature: TemperatureMetrics | null,
  processes: ProcessInfo[],
  thresholds: MonitorThresholds,
): Alert[] {
  const alerts: Alert[] = []

  if (metrics) {
    // メモリ使用率チェック
    if (metrics.memoryUsagePercent > thresholds.memoryPercent) {
      const usedGB = (metrics.memoryUsedBytes / (1024 ** 3)).toFixed(1)
      const totalGB = (metrics.memoryTotalBytes / (1024 ** 3)).toFixed(1)
      alerts.push({
        type: 'high_memory',
        title: `メモリ使用率 ${metrics.memoryUsagePercent}%`,
        body: `使用中: ${usedGB}GB / ${totalGB}GB（閾値: ${thresholds.memoryPercent}%）`,
        metadata: {
          memoryUsagePercent: metrics.memoryUsagePercent,
          memoryUsedGB: usedGB,
          memoryTotalGB: totalGB,
        },
      })
    }

    // Load Average チェック（1分平均）
    if (metrics.loadAverage[0] > thresholds.loadAverage) {
      alerts.push({
        type: 'high_load',
        title: `Load Average ${metrics.loadAverage[0].toFixed(2)}`,
        body: `Load Avg: ${metrics.loadAverage.map((v) => v.toFixed(2)).join(', ')}（閾値: ${thresholds.loadAverage}）`,
        metadata: {
          loadAvg1: metrics.loadAverage[0],
          loadAvg5: metrics.loadAverage[1],
          loadAvg15: metrics.loadAverage[2],
        },
      })
    }
  }

  // CPU 温度チェック
  if (temperature?.cpuDieTemp != null && temperature.cpuDieTemp > thresholds.cpuTemperature) {
    alerts.push({
      type: 'high_temperature',
      title: `CPU温度 ${temperature.cpuDieTemp.toFixed(1)}℃`,
      body: `CPU die temperature が ${temperature.cpuDieTemp.toFixed(1)}℃に到達（閾値: ${thresholds.cpuTemperature}℃）`,
      metadata: {
        cpuDieTemp: temperature.cpuDieTemp,
      },
    })
  }

  // stuck プロセス検知
  for (const proc of processes) {
    const isAllowed = STUCK_PROCESS_ALLOWLIST.some((pattern) => proc.command.includes(pattern))
    if (
      !isAllowed &&
      proc.rssBytes >= thresholds.processMemoryBytes &&
      proc.elapsedMinutes >= thresholds.processElapsedMinutes
    ) {
      const memGB = (proc.rssBytes / (1024 ** 3)).toFixed(2)
      const hours = (proc.elapsedMinutes / 60).toFixed(1)
      alerts.push({
        type: 'stuck_process',
        title: `高負荷プロセス検知: PID ${proc.pid}`,
        body: `${proc.command.slice(0, 80)} — RSS: ${memGB}GB, 稼働: ${hours}h（PID: ${proc.pid}, User: ${proc.user}）`,
        metadata: {
          pid: proc.pid,
          user: proc.user,
          rssGB: memGB,
          elapsedHours: hours,
          command: proc.command.slice(0, 200),
        },
      })
    }
  }

  return alerts
}

// ── メイン監視ループ ─────────────────────────────────────────

/**
 * 1 回分の監視チェックを実行する。
 * cron から毎分呼び出される想定。
 */
export async function runMonitorCheck(
  thresholds: MonitorThresholds = DEFAULT_THRESHOLDS,
): Promise<void> {
  log.debug('Running system monitor check...')

  // データ収集を並列実行
  const [metrics, temperature, processes] = await Promise.all([
    collectSystemMetrics(),
    collectTemperature(),
    collectProcessList(),
  ])

  // 閾値判定
  const alerts = evaluateAlerts(metrics, temperature, processes, thresholds)

  if (alerts.length === 0) {
    log.debug('No alerts triggered')
    return
  }

  // アラート送信（クールダウン判定は sendAlert 側で行う）
  for (const alert of alerts) {
    await sendAlert(alert)
  }
}

// ── Cron スケジュール管理 ──────────────────────────────────────

let monitorTask: ScheduledTask | null = null

/**
 * システムモニターを起動する。1分間隔で runMonitorCheck を実行する。
 */
export function startMonitor(thresholds: MonitorThresholds = DEFAULT_THRESHOLDS): void {
  if (monitorTask) {
    log.warn('System monitor is already running')
    return
  }

  monitorTask = cron.schedule(
    '*/5 * * * *', // 5分間隔
    () => {
      void runMonitorCheck(thresholds)
    },
    { timezone: 'Asia/Tokyo' },
  )
  log.info('System monitor scheduled: every 5 minutes')
}

/**
 * システムモニターを停止する。
 */
export function stopMonitor(): void {
  if (monitorTask) {
    monitorTask.stop()
    monitorTask = null
    log.info('System monitor stopped')
  }
}

export { DEFAULT_THRESHOLDS }
