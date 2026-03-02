/**
 * セキュリティ回帰テスト（パスガード、CORS、セッションIDバリデーション）
 */
import { describe, it, expect } from 'vitest'
import { isPathAllowed, isTailscaleIp, isValidSessionId } from './path-guard.js'

describe('path-guard security', () => {
  describe('isPathAllowed()', () => {
    const allowedRoots = ['/Users/ai-server/work/claude-crew', '/Users/ai-server/work/other-project']

    it('プロジェクトルート自体を許可する', () => {
      expect(isPathAllowed('/Users/ai-server/work/claude-crew', allowedRoots)).toBe(true)
    })

    it('プロジェクトルート配下のパスを許可する', () => {
      expect(isPathAllowed('/Users/ai-server/work/claude-crew/src/web/server.ts', allowedRoots)).toBe(true)
    })

    it('プロジェクトルート外のパスを拒否する', () => {
      expect(isPathAllowed('/etc/passwd', allowedRoots)).toBe(false)
    })

    it('/etc/hosts へのアクセスを拒否する', () => {
      expect(isPathAllowed('/etc/hosts', allowedRoots)).toBe(false)
    })

    it('ルートディレクトリへのアクセスを拒否する', () => {
      expect(isPathAllowed('/', allowedRoots)).toBe(false)
    })

    it('ホームディレクトリ直下の .ssh を拒否する', () => {
      expect(isPathAllowed('/Users/ai-server/.ssh', allowedRoots)).toBe(false)
    })

    it('パストラバーサル攻撃（..）を拒否する', () => {
      // resolve で正規化されるので /etc/passwd になり拒否される
      expect(isPathAllowed('/Users/ai-server/work/claude-crew/../../../etc/passwd', allowedRoots)).toBe(false)
    })

    it('プロジェクト名をプレフィックスに持つ別パスを拒否する', () => {
      expect(isPathAllowed('/Users/ai-server/work/claude-crew-malicious', allowedRoots)).toBe(false)
    })

    it('複数プロジェクトのどれかに含まれれば許可する', () => {
      expect(isPathAllowed('/Users/ai-server/work/other-project/src/index.ts', allowedRoots)).toBe(true)
    })

    it('空のallowedRootsではすべて拒否する', () => {
      expect(isPathAllowed('/Users/ai-server/work/claude-crew', [])).toBe(false)
    })

    it('コマンドインジェクション文字列を含むパスを拒否する', () => {
      // ";touch /tmp/marker;echo " がパスに含まれていても正しく拒否される
      expect(isPathAllowed('/Users/ai-server/work/claude-crew";touch /tmp/marker;echo "', allowedRoots)).toBe(false)
    })
  })

  describe('isTailscaleIp()', () => {
    it('Tailscale CGNAT 範囲 100.64.x.x を許可する', () => {
      expect(isTailscaleIp('100.64.0.1')).toBe(true)
    })

    it('Tailscale CGNAT 範囲 100.127.x.x を許可する', () => {
      expect(isTailscaleIp('100.127.255.254')).toBe(true)
    })

    it('Tailscale 範囲 100.100.x.x を許可する', () => {
      expect(isTailscaleIp('100.100.100.100')).toBe(true)
    })

    it('100.63.x.x は範囲外なので拒否する', () => {
      expect(isTailscaleIp('100.63.255.255')).toBe(false)
    })

    it('100.128.x.x は範囲外なので拒否する', () => {
      expect(isTailscaleIp('100.128.0.1')).toBe(false)
    })

    it('DNS名 100.evil.example を拒否する', () => {
      expect(isTailscaleIp('100.evil.example')).toBe(false)
    })

    it('DNS名 100.example.com を拒否する', () => {
      expect(isTailscaleIp('100.example.com')).toBe(false)
    })

    it('通常のIPアドレスを拒否する', () => {
      expect(isTailscaleIp('192.168.1.1')).toBe(false)
    })

    it('localhost を拒否する', () => {
      expect(isTailscaleIp('localhost')).toBe(false)
    })

    it('空文字を拒否する', () => {
      expect(isTailscaleIp('')).toBe(false)
    })
  })

  describe('isValidSessionId()', () => {
    it('正常なUUID形式を許可する', () => {
      expect(isValidSessionId('abc-def-123-456')).toBe(true)
    })

    it('英数字とハイフン・アンダースコアのみを許可する', () => {
      expect(isValidSessionId('session_2024_test-id')).toBe(true)
    })

    it('パストラバーサル（../）を拒否する', () => {
      expect(isValidSessionId('../../etc/passwd')).toBe(false)
    })

    it('スラッシュを含むIDを拒否する', () => {
      expect(isValidSessionId('path/to/file')).toBe(false)
    })

    it('ドットを含むIDを拒否する', () => {
      expect(isValidSessionId('session.jsonl')).toBe(false)
    })

    it('空文字を拒否する', () => {
      expect(isValidSessionId('')).toBe(false)
    })

    it('空白を含むIDを拒否する', () => {
      expect(isValidSessionId('session id')).toBe(false)
    })

    it('セミコロンを含むIDを拒否する（コマンドインジェクション防止）', () => {
      expect(isValidSessionId('session;rm -rf')).toBe(false)
    })
  })
})
