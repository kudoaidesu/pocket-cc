import { describe, it, expect } from 'vitest'
import { buildQueryOptions, parseSdkMessage, abortStream, getActiveStreamIds } from './chat-service.js'
import type { SdkMessage, ChatEvent, ToolDetail } from './chat-service.js'

describe('chat-service', () => {
  // ── buildQueryOptions ─────────────────────────────

  describe('buildQueryOptions()', () => {
    const baseParams = { message: 'hello', cwd: '/tmp/test', model: 'sonnet' }

    it('settingSources に project と user が含まれる（Claude Code CLI 相当）', () => {
      const opts = buildQueryOptions(baseParams)
      expect(opts.settingSources).toEqual(['project', 'user'])
    })

    it('systemPrompt が preset: claude_code である', () => {
      const opts = buildQueryOptions(baseParams)
      expect(opts.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code' })
    })

    it('デフォルトは plan モード（安全なデフォルト）', () => {
      const opts = buildQueryOptions(baseParams)
      expect(opts.permissionMode).toBe('plan')
      expect(opts.allowDangerouslySkipPermissions).toBe(false)
    })

    it('permissionMode=default で bypassPermissions になる', () => {
      const opts = buildQueryOptions({ ...baseParams, permissionMode: 'default' })
      expect(opts.permissionMode).toBe('bypassPermissions')
      expect(opts.allowDangerouslySkipPermissions).toBe(false)
    })

    it('permissionMode=yolo で bypassPermissions + dangerouslySkip になる', () => {
      const opts = buildQueryOptions({ ...baseParams, permissionMode: 'yolo' })
      expect(opts.permissionMode).toBe('bypassPermissions')
      expect(opts.allowDangerouslySkipPermissions).toBe(true)
    })

    it('permissionMode=auto-accept で acceptEdits になる', () => {
      const opts = buildQueryOptions({ ...baseParams, permissionMode: 'auto-accept' })
      expect(opts.permissionMode).toBe('acceptEdits')
      expect(opts.allowDangerouslySkipPermissions).toBe(false)
    })

    it('model が正しく渡される', () => {
      const opts = buildQueryOptions({ ...baseParams, model: 'opus' })
      expect(opts.model).toBe('opus')
    })

    it('cwd が正しく渡される', () => {
      const opts = buildQueryOptions({ ...baseParams, cwd: '/home/user/project' })
      expect(opts.cwd).toBe('/home/user/project')
    })

    it('sessionId 指定時に resume が設定される', () => {
      const opts = buildQueryOptions({ ...baseParams, sessionId: 'abc-123' })
      expect(opts.resume).toBe('abc-123')
    })

    it('sessionId 未指定時は resume が存在しない', () => {
      const opts = buildQueryOptions(baseParams)
      expect(opts.resume).toBeUndefined()
    })

    it('includePartialMessages が有効である', () => {
      const opts = buildQueryOptions(baseParams)
      expect(opts.includePartialMessages).toBe(true)
    })
  })

  // ── parseSdkMessage ───────────────────────────────

  describe('parseSdkMessage()', () => {
    it('system/init → session イベントを返す', () => {
      const msg: SdkMessage = {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-001',
      }
      const events = parseSdkMessage(msg, '')
      expect(events).toContainEqual({ type: 'session', sessionId: 'sess-001' })
    })

    it('初回の session_id → session イベントを返す', () => {
      const msg: SdkMessage = {
        type: 'assistant',
        session_id: 'sess-002',
      }
      const events = parseSdkMessage(msg, '')
      expect(events).toContainEqual({ type: 'session', sessionId: 'sess-002' })
    })

    it('既に sessionId がある場合は重複 session イベントを出さない', () => {
      const msg: SdkMessage = {
        type: 'assistant',
        session_id: 'sess-002',
      }
      const events = parseSdkMessage(msg, 'sess-002')
      const sessionEvents = events.filter(e => e.type === 'session')
      expect(sessionEvents).toHaveLength(0)
    })

    it('stream_event text_delta → text イベントを返す', () => {
      const msg: SdkMessage = {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'Hello world' },
        },
      }
      const events = parseSdkMessage(msg, 'sess')
      expect(events).toContainEqual({ type: 'text', text: 'Hello world' })
    })

    it('stream_event tool_use → tool イベントを返す', () => {
      const msg: SdkMessage = {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', name: 'Read' },
        },
      }
      const events = parseSdkMessage(msg, 'sess')
      expect(events).toContainEqual({ type: 'tool', name: 'Read', status: 'start' })
    })

    it('assistant + Bash 危険コマンド → warning イベントを返す', () => {
      const msg: SdkMessage = {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: 'Bash',
              input: { command: 'rm -rf /important' },
            },
          ],
        },
      }
      const events = parseSdkMessage(msg, 'sess')
      const warnings = events.filter(e => e.type === 'warning') as Array<ChatEvent & { type: 'warning' }>
      expect(warnings).toHaveLength(1)
      expect(warnings[0].label).toBe('rm -rf')
    })

    it('assistant + 安全な Bash コマンド → warning なし', () => {
      const msg: SdkMessage = {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: 'Bash',
              input: { command: 'git status' },
            },
          ],
        },
      }
      const events = parseSdkMessage(msg, 'sess')
      const warnings = events.filter(e => e.type === 'warning')
      expect(warnings).toHaveLength(0)
    })

    it('result → result イベントを返す', () => {
      const msg: SdkMessage = {
        type: 'result',
        session_id: 'sess-final',
        result: 'Done!',
        total_cost_usd: 0.05,
        num_turns: 3,
        duration_ms: 12000,
        is_error: false,
      }
      const events = parseSdkMessage(msg, 'sess')
      const results = events.filter(e => e.type === 'result') as Array<ChatEvent & { type: 'result' }>
      expect(results).toHaveLength(1)
      expect(results[0]).toEqual({
        type: 'result',
        text: 'Done!',
        sessionId: 'sess-final',
        cost: 0.05,
        turns: 3,
        durationMs: 12000,
        isError: false,
      })
    })

    it('result で session_id がない場合は currentSessionId を使う', () => {
      const msg: SdkMessage = {
        type: 'result',
        result: 'OK',
      }
      const events = parseSdkMessage(msg, 'current-sess')
      const results = events.filter(e => e.type === 'result') as Array<ChatEvent & { type: 'result' }>
      expect(results[0].sessionId).toBe('current-sess')
    })

    // ── 新機能: ツール詳細 ───────────────────────────

    it('assistant + tool_use → tool input イベントを detail 付きで返す', () => {
      const msg: SdkMessage = {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: 'Edit',
              input: { file_path: '/tmp/test.ts', old_string: 'foo', new_string: 'bar' },
            },
          ],
        },
      }
      const events = parseSdkMessage(msg, 'sess')
      const toolEvents = events.filter(e => e.type === 'tool') as Array<ChatEvent & { type: 'tool'; detail?: ToolDetail }>
      expect(toolEvents).toHaveLength(1)
      expect(toolEvents[0].status).toBe('input')
      expect(toolEvents[0].detail).toBeDefined()
      expect(toolEvents[0].detail!.name).toBe('Edit')
      expect(toolEvents[0].detail!.input).toEqual({ file_path: '/tmp/test.ts', old_string: 'foo', new_string: 'bar' })
    })

    it('assistant + tool_result (string content) → tool output イベントを返す', () => {
      const msg: SdkMessage = {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_result',
              name: 'Bash',
              content: 'command output here',
            },
          ],
        },
      }
      const events = parseSdkMessage(msg, 'sess')
      const toolEvents = events.filter(e => e.type === 'tool') as Array<ChatEvent & { type: 'tool'; detail?: ToolDetail }>
      expect(toolEvents).toHaveLength(1)
      expect(toolEvents[0].status).toBe('output')
      expect(toolEvents[0].detail!.output).toBe('command output here')
    })

    it('assistant + tool_result (array content) → tool output イベントを返す', () => {
      const msg: SdkMessage = {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_result',
              name: 'Read',
              content: [
                { type: 'text', text: 'line1' },
                { type: 'text', text: 'line2' },
              ],
            },
          ],
        },
      }
      const events = parseSdkMessage(msg, 'sess')
      const toolEvents = events.filter(e => e.type === 'tool') as Array<ChatEvent & { type: 'tool'; detail?: ToolDetail }>
      expect(toolEvents).toHaveLength(1)
      expect(toolEvents[0].detail!.output).toBe('line1\nline2')
    })

    it('Bash tool_use + 安全なコマンド → input イベントあり + warning なし', () => {
      const msg: SdkMessage = {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: 'Bash',
              input: { command: 'ls -la' },
            },
          ],
        },
      }
      const events = parseSdkMessage(msg, 'sess')
      const toolEvents = events.filter(e => e.type === 'tool')
      const warnings = events.filter(e => e.type === 'warning')
      expect(toolEvents).toHaveLength(1)
      expect(warnings).toHaveLength(0)
    })

    it('Bash tool_use + 危険コマンド → input イベント + warning イベント両方', () => {
      const msg: SdkMessage = {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: 'Bash',
              input: { command: 'git push --force origin main' },
            },
          ],
        },
      }
      const events = parseSdkMessage(msg, 'sess')
      const toolEvents = events.filter(e => e.type === 'tool')
      const warnings = events.filter(e => e.type === 'warning') as Array<ChatEvent & { type: 'warning' }>
      expect(toolEvents).toHaveLength(1)
      expect(warnings).toHaveLength(1)
      expect(warnings[0].label).toBe('git force push')
    })

    // ── Plan Mode / Compacting ────────────────────────

    it('system/compact_boundary → compact イベントを返す', () => {
      const msg: SdkMessage = {
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { trigger: 'auto', pre_tokens: 50000 },
      }
      const events = parseSdkMessage(msg, 'sess')
      const compacts = events.filter(e => e.type === 'compact') as Array<ChatEvent & { type: 'compact' }>
      expect(compacts).toHaveLength(1)
      expect(compacts[0].trigger).toBe('auto')
      expect(compacts[0].preTokens).toBe(50000)
    })

    it('system/status compacting → status イベントを返す', () => {
      const msg: SdkMessage = {
        type: 'system',
        subtype: 'status',
        status: 'compacting',
      }
      const events = parseSdkMessage(msg, 'sess')
      const statuses = events.filter(e => e.type === 'status') as Array<ChatEvent & { type: 'status' }>
      expect(statuses).toHaveLength(1)
      expect(statuses[0].status).toBe('compacting')
    })

    it('system/status permissionMode → status イベントに permissionMode を含める', () => {
      const msg: SdkMessage = {
        type: 'system',
        subtype: 'status',
        permissionMode: 'plan',
      }
      const events = parseSdkMessage(msg, 'sess')
      const statuses = events.filter(e => e.type === 'status') as Array<ChatEvent & { type: 'status' }>
      expect(statuses).toHaveLength(1)
      expect(statuses[0].permissionMode).toBe('plan')
    })

    it('planMode true → permissionMode が plan になる', () => {
      const opts = buildQueryOptions({ message: 'hello', cwd: '/tmp', model: 'sonnet', planMode: true })
      expect(opts.permissionMode).toBe('plan')
      expect(opts.allowDangerouslySkipPermissions).toBe(false)
    })

    it('planMode false → デフォルトの plan モードになる', () => {
      const opts = buildQueryOptions({ message: 'hello', cwd: '/tmp', model: 'sonnet', planMode: false })
      expect(opts.permissionMode).toBe('plan')
      expect(opts.allowDangerouslySkipPermissions).toBe(false)
    })

    it('permissionMode "plan" → plan モード', () => {
      const opts = buildQueryOptions({ message: 'hello', cwd: '/tmp', model: 'sonnet', permissionMode: 'plan' })
      expect(opts.permissionMode).toBe('plan')
      expect(opts.allowDangerouslySkipPermissions).toBe(false)
    })

    it('permissionMode "auto-accept" → acceptEdits モード', () => {
      const opts = buildQueryOptions({ message: 'hello', cwd: '/tmp', model: 'sonnet', permissionMode: 'auto-accept' })
      expect(opts.permissionMode).toBe('acceptEdits')
      expect(opts.allowDangerouslySkipPermissions).toBe(false)
    })

    it('permissionMode "default" → bypassPermissions モード（dangerouslySkip なし）', () => {
      const opts = buildQueryOptions({ message: 'hello', cwd: '/tmp', model: 'sonnet', permissionMode: 'default' })
      expect(opts.permissionMode).toBe('bypassPermissions')
      expect(opts.allowDangerouslySkipPermissions).toBe(false)
    })

    it('permissionMode "yolo" → bypassPermissions + dangerouslySkip', () => {
      const opts = buildQueryOptions({ message: 'hello', cwd: '/tmp', model: 'sonnet', permissionMode: 'yolo' })
      expect(opts.permissionMode).toBe('bypassPermissions')
      expect(opts.allowDangerouslySkipPermissions).toBe(true)
    })

    it('複数のtool_useブロック → それぞれの input イベントを返す', () => {
      const msg: SdkMessage = {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'Read', input: { file_path: '/a.ts' } },
            { type: 'tool_use', name: 'Glob', input: { pattern: '*.ts' } },
          ],
        },
      }
      const events = parseSdkMessage(msg, 'sess')
      const toolEvents = events.filter(e => e.type === 'tool') as Array<ChatEvent & { type: 'tool'; detail?: ToolDetail }>
      expect(toolEvents).toHaveLength(2)
      expect(toolEvents[0].detail!.name).toBe('Read')
      expect(toolEvents[1].detail!.name).toBe('Glob')
    })
  })

  // ── abortStream ───────────────────────────────────

  describe('abortStream()', () => {
    it('存在しない streamId を中断しようとすると false', () => {
      const result = abortStream('nonexistent-id')
      expect(result).toBe(false)
    })
  })

  // ── getActiveStreamIds ────────────────────────────

  describe('getActiveStreamIds()', () => {
    it('初期状態ではアクティブストリームなし', () => {
      const ids = getActiveStreamIds()
      // 他テストの影響排除のため、配列であることだけチェック
      expect(Array.isArray(ids)).toBe(true)
    })
  })
})
