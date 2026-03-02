/**
 * 危険コマンド検知（事後報告用）
 * tool-guard.ts のブロックパターンを流用し、ブロックではなく検知のみ行う
 */

const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /rm\s+-rf\s+/, label: 'rm -rf' },
  { pattern: /git\s+push\s+--force/, label: 'git force push' },
  { pattern: /git\s+reset\s+--hard/, label: 'git reset --hard' },
  { pattern: /git\s+clean\s+-f/, label: 'git clean -f' },
  { pattern: /DROP\s+(?:TABLE|DATABASE)/i, label: 'SQL DROP' },
  { pattern: /TRUNCATE\s+TABLE/i, label: 'SQL TRUNCATE' },
  { pattern: /DELETE\s+FROM\s+\w+\s*(?:;|$)/i, label: 'SQL DELETE (no WHERE)' },
  { pattern: /chmod\s+777/, label: 'chmod 777' },
  { pattern: /curl\s+.*\|\s*(?:ba)?sh/, label: 'curl | sh' },
  { pattern: /npm\s+publish/, label: 'npm publish' },
  { pattern: /gh\s+pr\s+merge/, label: 'PR merge' },
]

export interface DangerWarning {
  command: string
  label: string
}

export function detectDanger(command: string): DangerWarning | null {
  for (const { pattern, label } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return { command: command.slice(0, 200), label }
    }
  }
  return null
}
