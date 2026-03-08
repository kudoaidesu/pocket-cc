/**
 * ワーカーデーモン 動作確認スクリプト
 *
 * 使い方:
 *   npx tsx src/agents/worker-daemon-test.ts
 *
 * 動作:
 * 1. DBにテストタスクを登録する
 * 2. 10秒待機する（デーモンがタスクを拾う時間）
 * 3. task_events を確認してデーモンが処理したか報告する
 *
 * 前提: worker-daemon.ts が launchd 経由または別ターミナルで起動済みであること
 */
import { getDb } from '../db/index.js'
import { syncWorkers } from './worker-registry.js'
import { resolveWorker } from './worker-registry.js'
import {
  createTask,
  getTask,
  getTaskEvents,
} from './worker-store.js'

const WAIT_SECONDS = 15

async function main(): Promise<void> {
  console.log('=== Worker Daemon Test ===')
  console.log('')

  const db = getDb()

  // workers テーブルを同期（未初期化の場合に備えて）
  console.log('1. Syncing workers...')
  syncWorkers(db)
  console.log('   Done')

  // _general ワーカーにテストタスクを登録
  console.log('')
  console.log('2. Creating test task...')
  const worker = resolveWorker(db, '_general')
  if (!worker) {
    console.error('   ERROR: _general worker not found. DB may not be initialized.')
    process.exit(1)
  }

  const task = createTask(db, worker.id, {
    title: 'Worker Daemon Test Task',
    description: JSON.stringify({
      prompt: 'このタスクはワーカーデーモンの動作確認用です。"Hello from worker daemon!" とだけ返答してください。ツールは使わないでください。',
      model: 'claude-haiku-4-5-20251001',
    }),
    priority: 'high',
    executionMode: 'safe',
  })

  console.log(`   Task created: id=${task.id}, title="${task.title}"`)
  console.log(`   Status: ${task.status}`)

  // デーモンがタスクを拾うまで待機
  console.log('')
  console.log(`3. Waiting ${WAIT_SECONDS}s for daemon to pick up the task...`)

  for (let i = 0; i < WAIT_SECONDS; i++) {
    await sleep(1000)
    process.stdout.write('.')

    // 5秒おきに状態確認
    if ((i + 1) % 5 === 0) {
      const current = getTask(db, task.id)
      if (current) {
        process.stdout.write(` [${current.status}]`)
        if (current.status === 'completed' || current.status === 'failed') {
          console.log('')
          break
        }
      }
    }
  }
  console.log('')

  // 結果確認
  console.log('')
  console.log('4. Result:')
  const finalTask = getTask(db, task.id)
  if (!finalTask) {
    console.log('   ERROR: Task not found in DB')
    process.exit(1)
  }

  console.log(`   Task ID:    ${finalTask.id}`)
  console.log(`   Status:     ${finalTask.status}`)
  console.log(`   Started:    ${finalTask.startedAt ?? 'not started'}`)
  console.log(`   Completed:  ${finalTask.completedAt ?? 'not completed'}`)

  if (finalTask.result) {
    console.log(`   Result:     ${finalTask.result.slice(0, 200)}`)
  }
  if (finalTask.lastError) {
    console.log(`   Last Error: ${finalTask.lastError}`)
  }

  // task_events 確認
  console.log('')
  console.log('5. Task events:')
  const events = getTaskEvents(db, task.id)
  for (const ev of events) {
    const payload = ev.payload ? ` ${ev.payload.slice(0, 80)}` : ''
    console.log(`   [${ev.createdAt}] ${ev.eventType}${payload}`)
  }

  // 判定
  console.log('')
  if (finalTask.status === 'completed') {
    console.log('PASS: Task completed successfully by the worker daemon.')
  } else if (finalTask.status === 'running') {
    console.log('INFO: Task is still running. Wait longer or check daemon logs.')
    console.log('      Log: data/logs/worker.log')
    console.log('      Err: data/logs/worker.err.log')
  } else if (finalTask.status === 'pending') {
    console.log('WARN: Task was not picked up. Is the daemon running?')
    console.log('      Check: launchctl list | grep pocket-cc')
    console.log('      Or run manually: npx tsx src/agents/worker-daemon.ts')
  } else {
    console.log(`INFO: Task status = "${finalTask.status}". Check daemon logs for details.`)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

main().catch(err => {
  console.error('Test failed:', err)
  process.exit(1)
})
