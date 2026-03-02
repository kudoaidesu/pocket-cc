const MAX_INPUT_LENGTH = 4000

// プロンプトインジェクション対策: system/assistant 偽装パターン
const INJECTION_PATTERNS = [
  /\bsystem\s*:/gi,
  /\bassistant\s*:/gi,
  /\b(?:ignore|disregard)\s+(?:all\s+)?(?:previous|above)\s+(?:instructions?|prompts?)/gi,
  /\byou\s+are\s+now\b/gi,
  /\bact\s+as\b/gi,
  /<\/?(?:system|assistant|user)>/gi,
]

export interface ValidationResult {
  valid: boolean
  sanitized: string
  warnings: string[]
}

export function validateInput(text: string, maxLength = MAX_INPUT_LENGTH): ValidationResult {
  const warnings: string[] = []

  // 空入力チェック
  if (!text || !text.trim()) {
    return { valid: false, sanitized: '', warnings: ['入力が空です'] }
  }

  let sanitized = text.trim()

  // 長さ制限
  if (sanitized.length > maxLength) {
    sanitized = sanitized.slice(0, maxLength)
    warnings.push(`入力を${maxLength}文字に切り詰めました`)
  }

  // 制御文字除去（改行・タブは許可）
  sanitized = sanitized.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')

  return { valid: true, sanitized, warnings }
}

export function sanitizePromptInput(text: string): string {
  let sanitized = text

  for (const pattern of INJECTION_PATTERNS) {
    sanitized = sanitized.replace(pattern, (match) => {
      // パターンを無害化: コロンを全角に、HTML括弧を全角に置換
      return match
        .replace(/:/g, '\uff1a')
        .replace(/</g, '\uff1c')
        .replace(/>/g, '\uff1e')
    })
  }

  return sanitized
}
