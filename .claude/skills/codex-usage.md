# Codex MCP 利用ルール

## 概要

OpenAI Codex MCPを使用してコード生成・分析を行う際のモデル選択ルール。

## トリガーワード

- 「Codexで」「Codexを使って」「codex」
- 複雑なコード生成・分析タスク

## モデル選択ルール

### 1. 基本モデル（デフォルト）

```
model: gpt-5.3-codex
reasoning: high
```

**すべてのCodex呼び出しはまずこのモデルを使用する。**

### 2. 高難度モデル（エスカレーション）

```
model: gpt-5.3-codex
reasoning: x-high
```

**以下の場合のみエスカレーション:**
- 基本モデル（high）で解決できなかった場合
- 回答が不完全・不正確だった場合
- 複雑なアーキテクチャ設計が必要な場合

## 使用例

```typescript
// 基本モデル（最初に必ずこちらを試す）
mcp__codex-mcp__codex({
  prompt: "...",
  model: "gpt-5.3-codex",
  // reasoning: high（デフォルト）
})

// エスカレーション（基本で解決できない場合のみ）
mcp__codex-mcp__codex({
  prompt: "...",
  model: "gpt-5.3-codex",
  // reasoning: x-high を指定
})
```

## ⚠️ 注意事項

- **コスト効率のため、必ず基本モデル（high）から試す**
- エスカレーションは明確な理由がある場合のみ
- 結果を検証し、必要に応じて再試行
- x-highを最初から使うことは禁止

## 関連スキル

- [codex-review](skills/codex-review/SKILL.md) - Codexレビューワークフロー
- [problem-solving](skills/problem-solving/SKILL.md) - 問題解決手順
