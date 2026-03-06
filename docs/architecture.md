# アーキテクチャ設計

## 実装フェーズ

| フェーズ | 内容 | 状態 |
|---------|------|------|
| Phase 1 | Issue精緻化 & キューイング | **完了** |
| Phase 2 | コード簡素化 + マルチプロジェクト基盤 | **完了** |
| Phase 3 | セキュリティ基盤 + ガードレール | **完了** |
| Phase 4 | AI Coder Agent（コード生成→PR作成） | **完了** |
| Phase 5 | Discord UX強化 | **完了** (5-1〜5-4) |
| Phase 6 | 運用強化 | **一部完了** (6-1〜6-3) |

## 全体像

```
┌─────────────────────────────────────────────────────────────────┐
│                     Mac mini M2 サーバー                          │
│                     (Tailscale経由でアクセス)                      │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐     │
│  │              issue-ai-bot (1プロセス)                     │     │
│  │                                                         │     │
│  │  [Discord Bot] ──── guildId ──── [projects.json]        │     │
│  │       │              逆引き       (プロジェクト登録)      │     │
│  │       ▼                                                 │     │
│  │  [Issue Refiner] ── claude CLI ── [LLM Layer]           │     │
│  │       │                           claude.ts (CLI)       │     │
│  │       ▼                           agent.ts  (SDK)       │     │
│  │  [GitHub Issue] ── gh --repo ──── マルチリポ対応          │     │
│  │       │                                                 │     │
│  │       ▼                                                 │     │
│  │  [Job Queue] ── node-cron ── 夜間バッチ                  │     │
│  │       │          (共有キュー: 全プロジェクト)              │     │
│  │       ▼                                                 │     │
│  │  [AI Coder Agent] ── Agent SDK                          │     │
│  │       │    └── Docker サンドボックス内で実行              │     │
│  │       │    └── claude -p --cwd /path/to/project         │     │
│  │       │         (各プロジェクトの CLAUDE.md を自動ロード)  │     │
│  │       ▼                                                 │     │
│  │  [Notifier] ── プロジェクト別チャンネルに通知             │     │
│  └─────────────────────────────────────────────────────────┘     │
│                                                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                      │
│  │project-a │  │project-b │  │project-c │  (ローカルclone)      │
│  │CLAUDE.md │  │CLAUDE.md │  │CLAUDE.md │                      │
│  └──────────┘  └──────────┘  └──────────┘                      │
└─────────────────────────────────────────────────────────────────┘

[Discord Server A] ←──── guildId:111 ──── project-a
[Discord Server B] ←──── guildId:222 ──── project-b
[Discord Server C] ←──── guildId:333 ──── project-c
```

## マルチプロジェクト設計

### プロジェクト登録 (`projects.json`)

```json
[
  {
    "slug": "eisa-map",
    "guildId": "111111111111",
    "channelId": "222222222222",
    "repo": "kudoaidesu/eisa-map",
    "localPath": "/Users/teruya/workspace/eisa-map"
  },
  {
    "slug": "issue-ai-bot",
    "guildId": "333333333333",
    "channelId": "444444444444",
    "repo": "kudoaidesu/issue-ai-bot",
    "localPath": "/Users/teruya/workspace/issue-ai-bot"
  }
]
```

### プロジェクト特定フロー

```
スラッシュコマンド / サーバー内メッセージ:
  interaction.guildId → projects.json 逆引き → プロジェクト確定

DM:
  ユーザーが参加しているサーバーが1つ → 自動確定
  複数サーバー → プロジェクト選択UI表示
```

### プロジェクト追加手順

1. `projects.json` にエントリ追加（5行）
2. Discord新サーバー作成 → Botを招待
3. 対象リポジトリに `CLAUDE.md` を配置
4. Bot再起動

**コード変更ゼロ。**

## コンポーネント詳細

### 1. Discord Bot (`src/bot/`)

Discord.jsで実装。1つのBotが複数Discordサーバーに参加し、guildIdでプロジェクトを自動特定する。

**スラッシュコマンド:**

| コマンド | 説明 |
|---------|------|
| `/issue <内容>` | 新しいIssueリクエストを送信 |
| `/status` | キューの状態を確認 |
| `/queue` | 現在のキュー一覧を表示 |
| `/run` | 手動でキュー処理を開始 |
| `/cron` | Cronジョブの状態確認 |
| `/cost` | コスト情報を表示 |

**DMモード:**
- DMで直接メッセージ → Issueリクエストとして処理
- 複数サーバー参加時はプロジェクト選択UI
- ユーザーごとのセッション管理によるマルチターン対話

**通知 (`bot/theme.ts` + `bot/notifier.ts`):**
- カラー・絵文字・Embed生成を `theme.ts` に集約
- `notify()` 1関数でプロジェクト別チャンネルに通知

### 2. LLM Layer (`src/llm/`)

用途ベースでCLI/SDKを使い分ける。グローバルな `LLM_MODE` 切り替えは廃止。

| ファイル | 用途 | 使用場面 |
|---------|------|---------|
| `claude.ts` | Claude CLI (`claude -p`) | 軽量な1ショット処理 |
| `agent.ts` | Agent SDK (`@anthropic-ai/claude-code`) | 予算制御・進捗通知・セッション管理 |
| `codex.ts` (将来) | Codex CLI | レビュー |

**Agent SDK の活用機能:**

| 機能 | 用途 |
|------|------|
| `maxBudgetUsd` | 夜間バッチの暴走防止 |
| `includePartialMessages` | Discordリアルタイム進捗通知 |
| `canUseTool` | 危険コマンドの動的ブロック |
| `resume` / `forkSession` | Issue Refinerのマルチターン会話 |
| `agents` | coder/reviewer サブエージェント定義 |
| `total_cost_usd` / `modelUsage` | コスト通知 |
| `outputFormat` | 構造化出力 |
| `hooks` | ライフサイクルイベントのコールバック |

**モデル選択ガイドライン:**

| 用途 | 推奨モデル | 理由 |
|------|----------|------|
| Issue精緻化 | Sonnet | バランス型で十分 |
| 計画生成 | Opus | 複雑な判断が必要 |
| コード生成 | Sonnet | コスパ重視 |
| テスト生成 | Haiku | 高速・低コスト |
| レビュー | Codex CLI | 別ツール |

### 3. Issue Refiner Agent (`src/agents/issue-refiner/`)

曖昧なユーザー入力を構造化されたGitHub Issueに変換するAIエージェント。

**フロー:**
```
曖昧な入力 → コンテキスト分析 → 不足情報チェック → 逆質問 or Issue生成（urgency判定付き）
```

**緊急度（urgency）判定:**
- `immediate`: 調査依頼、確認作業、「すぐ」「調べて」「確認して」等 → キューをスキップして即時処理
- `queued`: 機能追加、リファクタリング、ドキュメント等 → 通常キューに追加

**即時処理フロー:**
```
urgency=immediate → processImmediate()
  ├── ロック空き + 予算内 → fire-and-forget で AI Coder 起動
  ├── ロック保持中       → 高優先度でキューにフォールバック
  └── 予算超過           → 高優先度でキューにフォールバック
```

**セッション管理:**
- Phase 2まで: 自前のMap管理
- Phase 4以降: Agent SDK の `resume` / `forkSession` に移行

### 4. GitHub Issue Manager (`src/github/issues.ts`)

`gh` CLI経由でIssue操作。マルチリポ対応のため全関数に `repo?` パラメータを追加。

```typescript
// gh issue create --repo owner/project-a
createIssue(params, repo?)
getIssue(issueNumber, repo?)
updateIssueState(issueNumber, state, repo?)
addComment(issueNumber, comment, repo?)
```

### 5. Job Queue + Cron Scheduler (`src/queue/`)

全プロジェクトのIssueを1つの共有キューで管理。2つの処理パスを持つ:

- **キュー処理**: Cron（デフォルト 01:00 JST）でバッチ処理
- **即時処理**: Issue Refiner の urgency 判定に基づき、キューをスキップして直接実行

```typescript
interface QueueItem {
  id: string
  issueNumber: number
  repository: string        // プロジェクト識別キー
  priority: 'high' | 'medium' | 'low'
  status: 'pending' | 'processing' | 'completed' | 'failed'
  createdAt: string
  completedAt?: string
  error?: string
  retryCount?: number
  maxRetries?: number
  nextRetryAt?: string      // exponential backoff 用
}
```

**処理ハンドラ:**
```typescript
type QueueProcessHandler = (issueNumber: number, repository: string, queueItemId: string) => Promise<void>
```

**即時処理 (`processImmediate`):**
ロック取得 → 予算チェック → processHandler を fire-and-forget で実行。ロック保持中はキューにフォールバック。

### 6. AI Coder Agent（別リポジトリ: `ai-coder-agent`）

Agent SDK ベースの自律型コーディングエージェント。

**サブエージェント構成:**
```
.claude/agents/
├── planner.md      # Issue → 実装計画の生成
├── coder.md        # 計画 → コード変更
├── reviewer.md     # コード品質・セキュリティチェック
└── tester.md       # テスト生成・実行
```

**実行フロー:**
```
1. Issue の要件を読み込み
2. Planner が実装計画を生成 → Discord通知 → 人間が承認
3. Coder がコード変更を生成（Docker サンドボックス内）
4. ビルド・テスト実行 → 失敗時自動修正（最大3回）
5. Tester がテストを自動生成・実行
6. Reviewer がコード品質・セキュリティチェック
7. Codex CLI でセキュリティレビュー
8. Draft PR 作成
9. 結果を Discord に通知（コスト・実行時間含む）
```

**セーフガード:**
- Docker サンドボックス内で実行（ファイルシステム・ネットワーク分離）
- `canUseTool` で危険コマンドを動的ブロック
- `maxBudgetUsd` で予算制御
- featureブランチへのみ push、mainへの直接push禁止
- 各ステップ後にGitチェックポイント、失敗時はreset
- 3回失敗 → 人間にエスカレーション
- PRサイズ制限（500行超はStacked PRに分割）

## セキュリティ設計

### 多層防御

```
Layer 1: 入力サニタイズ
  → Discord入力のプロンプトインジェクション対策
  → コマンド許可リスト化

Layer 2: canUseTool / Hooks
  → rm -rf, git push --force, eval 等のブロック
  → .env / credentials への書き込み防止
  → 重要ファイル保護リスト

Layer 3: Docker サンドボックス
  → AIのコード生成・実行をコンテナ内に隔離
  → ファイルシステムとネットワークの分離

Layer 4: 静的解析
  → PR作成前にLint / Formatter / 型チェック実行
  → 将来: CodeQL / Semgrep 統合

Layer 5: AI Code Review
  → Reviewer Agent + Codex CLI による自動レビュー

Layer 6: GitHub ブランチ保護
  → main への force push 禁止
  → 必須CI、必須レビュー
  → 変更範囲制限
```

### 監査ログ

ジョブ単位で以下を記録:
- 誰が依頼したか（Discord userId）
- どのプロジェクトか（guildId → slug）
- AIが何を実行したか（ツール使用ログ）
- どのPRが作られたか
- コスト・実行時間

## レート制限・コスト管理

### Claude Max サブスク枠の注意点

- 5時間ごとにリセットされるセッション上限がある
- Claude Code と Claude 本体の使用量は共通枠
- 週次上限あり（Anthropic裁量で変動）

### 対策

- バッチ分散（一度に処理するジョブ数を制限）
- モデル選択の最適化（Haiku/Sonnet/Opus の使い分け）
- `maxBudgetUsd` で1ジョブあたりの上限設定
- 日次/週次コストレポートをDiscordに投稿
- 閾値超過時のアラート

## 技術選定理由

| 選定 | 理由 |
|------|------|
| **discord.js** | Discord Bot の定番ライブラリ、TypeScript対応 |
| **gh CLI** | トークン不要、`gh auth login` の認証セッションを使用、`--repo` でマルチリポ対応 |
| **Claude Code CLI** | 軽量な1ショット処理、サブスク枠で動作 |
| **Claude Agent SDK** | 予算制御・進捗通知・セッション管理・危険コマンドブロック |
| **Codex CLI** | レビュー用 |
| **node-cron** | 軽量なCronジョブライブラリ |
| **Docker** | AI実行環境のサンドボックス化 |
| **Tailscale** | ゼロコンフィグVPN、NAT越え不要 |

---

## Phase 詳細

### Phase 2: コード簡素化 + マルチプロジェクト基盤

**目的**: 決定事項を既存コードに反映し、マルチプロジェクト対応の土台を作る。

```
2-1. LLM層リファクタ
     - llm/index.ts の mode分岐削除
     - claude-sdk.ts → agent.ts にリネーム
     - LLM_MODE 環境変数廃止
     - config.ts から llm.mode 削除

2-2. 通知・Embed共通化
     - bot/theme.ts 新設（カラー・絵文字・Embed生成ヘルパー）
     - notifier.ts → notify() 1関数に統合
     - commands/* の Embed生成を theme.ts 経由に

2-3. マルチプロジェクト対応
     - projects.json 導入（プロジェクト登録）
     - config.ts: guildId/channelId 削除 → projects読み込み
     - github/issues.ts: 全関数に repo パラメータ追加
     - processor.ts: enqueue() に repository 必須化、getRepoSlug() 削除
     - scheduler.ts: handler に repository パラメータ追加
     - bot/commands/*: guildId → project 解決
     - bot/events/messageCreate.ts: DM時のプロジェクト選択
     - notifier.ts: プロジェクト別チャンネル通知
     - bot/index.ts: 全サーバーにコマンド登録

2-4. ビルド確認
     - npm run build
     - npm run typecheck
```

### Phase 3: セキュリティ基盤 + ガードレール

**目的**: AI Coder を動かす前の必須安全策を構築。

```
3-1. Docker サンドボックス化
     - AI Coder 実行用の Dockerfile 作成
     - ファイルシステム・ネットワークの制限設定
     - ホスト ↔ コンテナ間のファイル共有設定

3-2. canUseTool / Hooks 定義
     - 危険コマンドのブロックリスト定義
     - .env / credentials への書き込み防止
     - 重要ファイル保護リスト
     - PreToolUse / PostToolUse Hooks

3-3. 入力サニタイズ
     - Discord入力のバリデーション
     - プロンプトインジェクション対策

3-4. GitHub ブランチ保護
     - リポジトリごとのブランチ保護ルール設定
     - 必須CI、必須レビュー
     - PRサイズ上限の設定

3-5. 監査ログ
     - ジョブ単位の実行ログ構造定義
     - ログ出力の実装
```

### Phase 4: AI Coder Agent 実装

**目的**: Issue → コード → テスト → PR の自律フロー構築。

```
4-1. ai-coder-agent リポジトリ作成
     - Agent SDK ベースのプロジェクト初期化
     - .claude/agents/ でサブエージェント定義
       - planner.md / coder.md / reviewer.md / tester.md

4-2. 計画承認チェックポイント
     - Planner Agent が実装計画を生成
     - Discord通知（Embed + ボタン）
     - 人間が承認 → コード生成開始

4-3. コード生成 + テスト自動実行
     - Docker サンドボックス内で実行
     - ビルド → 既存テスト → 失敗時自動修正（最大3回）
     - Tester Agent によるテスト自動生成
     - Lint / Formatter 実行

4-4. Git チェックポイント + ロールバック
     - 各ステップ後にチェックポイント commit
     - 失敗時は git reset でクリーン状態に復帰
     - 3回失敗 → 人間にエスカレーション

4-5. PR作成 + レビュー
     - Draft PR 作成
     - Reviewer Agent + Codex CLI でレビュー
     - レビュー結果を PR コメントに投稿

4-6. issue-ai-bot との連携
     - processHandler から ai-coder-agent を呼び出し
     - maxBudgetUsd で予算制御
     - 完了時のコスト・実行時間通知
```

### Phase 5: Discord UX強化 ✅

**目的**: リアルタイム進捗表示・インタラクティブ操作。

```
5-1. Thread化 ✅
     - Issue処理ごとに Discord Thread を作成
     - 中間結果を Thread 内に投稿（createIssueThread / updateProgress）

5-2. ボタン操作 ✅
     - キュー確認: [今すぐ処理] [キューから削除]
     - PR完了: [PR を見る] [承認 & マージ]
     - ※ 計画承認ボタンはAgent実行モデル変更が必要なため保留

5-3. リアルタイム進捗 ✅
     - ProgressReporter コールバックでステージ通知
     - Embed edit で進捗更新

5-4. DM マルチプロジェクト対応 ✅
     - StringSelectMenu によるプロジェクト選択 UI
```

### Phase 6: 運用強化（一部完了）

**目的**: コスト管理・可用性・監視。

```
6-1. コスト追跡 ✅
     - costs.jsonl に構造化コストデータを蓄積
     - 日次/週次コストレポートを Discord に自動投稿
     - /cost コマンドで集計表示
     - 予算超過アラート

6-2. レート制限対策 ✅
     - acquireLock / releaseLock（同時実行ガード）
     - バッチサイズ制限 + ジョブ間クールダウン
     - 日次予算ガード（バッチ開始前 + 各ジョブ前）

6-3. キュー強化 ✅
     - 冪等性チェック（重複 enqueue 防止）
     - exponential backoff リトライ（markForRetry）
     - ※ SQLite 移行は将来検討

6-4. Observability（未実装）
     - 構造化ログの強化
     - ジョブ単位のメトリクス
     - 失敗要因の可視化ダッシュボード

6-5. バックアップ・復旧（未実装）
     - Mac mini M2 障害時の復旧手順
     - 設定・キューデータのバックアップ
```
