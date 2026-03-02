---
name: codex-review
description: Claude-Codex連携によるコードレビューワークフロー。設計→レビュー→修正→実装→再レビューのサイクルをCodexセッションを維持しながら実行。トリガーワード：「プランを立てて」「設計して」「計画を作成」「アーキテクチャ検討」「Codexレビュー」「設計レビュー」「コードレビュー」「Codex連携」「実装方針を決めて」「どう実装するか検討」。前提: codex-mcp サーバー設定済み。
---

# Codex Review ワークフロー

Claude が設計・実装し、Codex がレビューするワークフロー。セッションIDでCodex側のコンテキストを維持。

## 🚨 必須: 設計前のContext7参照

**設計を開始する前に、必ずContext7で関連ライブラリのドキュメントを確認する。**

```
1. mcp__context7__resolve-library-id で対象ライブラリを特定
2. mcp__context7__query-docs で最新APIを確認
3. 確認した内容を設計に反映
```

### 確認すべきライブラリ（このプロジェクト）
- Next.js App Router（ルーティング、データフェッチ）
- React 19（Server Components、hooks）
- Supabase（認証、DB、RLS）
- shadcn/ui（コンポーネントAPI）
- Tailwind CSS（ユーティリティ）

**スキップ禁止**: 「知っているつもり」でもContext7で最新仕様を確認すること。

## モデル選択ルール（必須）

**すべてのCodex呼び出しで以下のルールを適用:**

| 段階 | モデル | reasoning | 使用条件 |
|------|--------|-----------|----------|
| 基本 | gpt-5.3-codex | high | **必ず最初にこちらを使用** |
| エスカレーション | gpt-5.3-codex | x-high | highで解決できない場合のみ |

```typescript
// 基本（必ずこちらから）
mcp__codex-mcp__codex({
  prompt: "...",
  model: "gpt-5.3-codex",
  // reasoning: high（デフォルト）
})

// エスカレーション（highで不十分な場合のみ）
mcp__codex-mcp__codex({
  prompt: "...",
  model: "gpt-5.3-codex",
  // reasoning: x-high
})
```

## レビュー方針

- **指摘がなくなるまで自動で再レビュー**（デフォルト動作）
  - 1回のレビューで終わらない。指摘→修正→再レビューを繰り返す
  - ユーザーが「1回だけ」と指定しない限り、パスするまで継続
- **厳格に指摘**: 些細な問題も見逃さない（エッジケース、型安全性、アクセシビリティ等）
- **ユーザー連絡は全指摘クリア後のみ**: 中途半端な状態でユーザーに確認を求めない
- **調査を惜しまない**: 迷ったらWEB検索、自信がなければContext7でドキュメント確認

## レビュー観点

1. **TypeScript型安全性**: `any`禁止、適切な型定義、null/undefinedハンドリング
2. **セキュリティ**: XSS、インジェクション、認証/認可の適切性
3. **パフォーマンス**: 不要なre-render、N+1クエリ、バンドルサイズ
4. **SEO/アクセシビリティ**: メタデータ、構造化データ、ARIA、キーボード操作
5. **Next.js App Router**: Server/Client Components分離、データフェッチパターン
6. **SSR/SSG/ISR方針**: このプロジェクトはSSR採用（→ supabase-authスキル参照）

## 調査の積極活用

**迷ったら調べる。自信がなければ調べる。完成度を上げたければ調べる。**

### Claude側（実装・修正時）

| ツール | 使用タイミング |
|--------|---------------|
| **Context7 MCP** | APIの正しい使い方を確認したい時 |
| **WebSearch** | ベストプラクティス、UIパターン、既知問題を調べたい時 |
| **WebFetch** | 公式ドキュメントの詳細を確認したい時 |

### Codex側（レビュー時）

Codexも同様に調査を活用すべき。レビュー依頼時に以下を明記：

```
### レビュー依頼
[内容]

### 調査推奨
- 不明点があればWEB検索で確認してください
- ベストプラクティスと比較してください
- 完成度を上げる提案があれば指摘してください
```

### 調査すべきタイミング

- 実装方法に自信がない
- 複数のアプローチで迷っている
- アクセシビリティの正しいパターンを知りたい
- UIデザインの参考が欲しい
- エラーの原因が分からない
- **完成度をもっと上げたい**

### 検索クエリ例

```
# アクセシビリティ
"ARIA tabs pattern" / "ARIA navigation best practices"
"WCAG 2.1 touch target size"

# UIデザイン
"calendar UI best practices 2025"
"event card design patterns"
"bento box layout CSS"

# 技術
"Next.js App Router [API名] best practices"
"React [問題] solution"
```

## ワークフロー概要

```
Phase 1: 設計レビュー
  Claude設計 → Codexレビュー → Claude修正（承認まで繰り返し）
                    ↓ 承認
Phase 2: 実装
  Claude が承認された設計に基づいて実装
                    ↓ 完了
Phase 3: 成果物レビュー
  Codex が実装コードをレビュー（同一セッション継続）
```

## セッション管理

セッション管理の詳細は [references/session-management.md](references/session-management.md) を参照。

### 基本パターン

**初回呼び出し**:
```
mcp__codex__codex({ prompt: "レビュー依頼" })
→ レスポンス末尾の [SESSION_ID: xxx] を抽出・保持
```

**フォローアップ**:
```
mcp__codex__codex_reply({
  conversationId: "<SESSION_ID>",
  prompt: "フォローアップ内容"
})
```

## Phase 1: 設計レビュー

### 1.1 設計作成

以下を含む設計を作成:
- 目的・背景
- 技術的アプローチ
- 変更対象ファイル
- リスク・制約

### 1.2 レビュー依頼

```
mcp__codex__codex({
  prompt: `
## 設計レビュー依頼

### 背景
[背景]

### 提案設計
[設計内容]

### 変更対象
- [ファイル一覧]

### レビュー観点
1. アーキテクチャの妥当性
2. 既存コードとの整合性
3. エッジケース・リスク

承認 or 修正要求をお願いします。
`
})
```

### 1.3 セッションID抽出

レスポンス末尾 `[SESSION_ID: xxx]` を抽出・保持。

### 1.4 修正→再レビュー

承認されるまで繰り返し:

```
mcp__codex__codex_reply({
  conversationId: "<SESSION_ID>",
  prompt: `
## 設計修正

### 修正内容
[フィードバック対応]

再レビューをお願いします。
`
})
```

## Phase 2: 実装

承認された設計に基づいて実装:
1. コード実装
2. テスト追加
3. ビルド・lint・テスト通過確認

## Phase 3: 成果物レビュー

**同一セッションを継続**:

```
mcp__codex__codex_reply({
  conversationId: "<SESSION_ID>",
  prompt: `
## 実装完了 - コードレビュー依頼

### 実装ファイル
- [ファイル]: [概要]

### 主要コード
\`\`\`typescript
[コード抜粋]
\`\`\`

### テスト結果
ビルド/Lint/テスト: OK

承認 or 修正要求をお願いします。
`
})
```

修正要求があれば対応し、承認まで繰り返し。

## 承認判定

以下の応答は承認とみなす:
- 「承認」「LGTM」「問題ありません」
- 明確な修正要求がない