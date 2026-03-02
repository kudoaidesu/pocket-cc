# プロジェクトルール

## 設計思想: CLI-First

本プロジェクトは **外部サービスのトークンを環境変数で管理しない** 方針をとる。
各ツールのCLIが持つ認証セッションをそのまま利用し、Node.jsプロセスにシークレットを渡さない。

| サービス | アクセス手段 | 認証方法 |
|---------|-------------|---------|
| GitHub | `gh` CLI | `gh auth login`（OAuth/ブラウザ認証） |
| Claude | `claude` CLI / Agent SDK | `claude setup-token`（サブスク認証） |

`.env` は現在使用していない。認証はTailscaleのACLに委譲する。

## 絶対厳守ルール

### データベース操作
- **禁止**: `db reset`、`DELETE FROM`、`TRUNCATE` をユーザー許可なく実行
- **必須**: 破壊的操作は必ずユーザーに確認してから実行

### コマンド実行
- **原則**: 権限は広く持たせているが、破壊的・不可逆なコマンドは必要最小限にとどめる
- **禁止**: 不要なファイル削除、不要なプロセス停止をむやみに実行しない
- **心構え**: 「実行できる」と「実行すべき」は別。目的に必要なコマンドだけを実行する

### 言語制限
- **禁止**: Pythonスクリプトの実行（スキル内のPythonも含む）
- **必須**: スクリプトはすべてTypeScript（tsx）またはNode.jsで作成
- **必須**: `npx tsx` でTypeScriptスクリプトを実行

## 技術スタック

- **ランタイム**: Node.js + TypeScript
- **Web UI**: Hono（SSE、Tailscale経由）
- **GitHub連携**: `gh` CLI（トークン不要、`gh auth login` の認証セッションを使用）
- **LLM**: Claude Code CLI / Agent SDK — 用途ベースで使い分け
- **Cronジョブ**: node-cron
- **ネットワーク**: Tailscale（スマホからのリモートアクセス）
- **テスト**: Vitest（ユニット）

## LLM使い分けポリシー

| ファイル | ツール | 用途 |
|---------|-------|------|
| `llm/claude-cli.ts` | Claude CLI (`claude -p`) | 軽量な1ショット処理（タイチョー戦略） |
| `web/routes/chat.ts` | Agent SDK（直接利用） | Web UIチャット（SSEストリーミング） |

**モデルは呼び出し元が指定する:**
- 計画生成 → opus
- コード生成 → sonnet
- 雑談 → haiku

## マルチプロジェクト設計

- **`projects.json`** でプロジェクトを登録（slug, repo, localPath）
- 各プロジェクトリポジトリの **CLAUDE.md** がAIのコンテキスト管理の中心
- プロジェクト追加 = `projects.json` 追記 + CLAUDE.md配置（コード変更ゼロ）

## ブランチ戦略

```
feature/* or fix/* → develop → main（PR経由）
```

- 1ブランチ1機能、ビルド確認必須
- mainへの直接マージ禁止

## コーディング規約

- 命名: camelCase（変数・関数）/ PascalCase（型・コンポーネント）
- `any`型禁止
- ESM (import/export) を使用

## 実行コマンド

```bash
npm run setup            # 対話式セットアップ
npm run dev              # 開発サーバー（Cron + Queue）
npm run web              # Web UI起動
npm run web:dev          # Web UI開発モード（watch）
npm run build            # ビルド
npm run test             # テスト
npm run start            # 本番起動
```

## 前提ツール

```bash
# 必須: Claude Code CLI
npm install -g @anthropic-ai/claude-code
claude setup-token

# 必須: GitHub CLI
brew install gh
gh auth login

# Web UI認証情報は .env に記載
# 認証はTailscaleのACLに委譲（.envは不要）
```

## ディレクトリ構造

```
src/
├── agents/            # AIエージェント
│   └── taicho/        # タイチョー（実行隊長）: Issue→コード→Draft PR
│       ├── index.ts       # メインオーケストレーター
│       ├── types.ts       # 型定義
│       ├── prompt.ts      # システムプロンプト
│       ├── git.ts         # Git操作（ブランチ作成・PR作成）
│       ├── difficulty-selector.ts  # タスク難易度推定
│       └── strategies/    # 実装戦略（claude-cli 等、差し替え可能）
├── cli/               # CLIツール
│   ├── index.ts       # CLI エントリーポイント
│   └── setup.ts       # 対話式セットアップウィザード
├── github/            # GitHub連携
│   ├── issues.ts      # Issue CRUD（gh CLI経由、マルチリポ対応）
│   └── pulls.ts       # PR操作（gh CLI経由）
├── llm/               # LLMレイヤー
│   └── claude-cli.ts  # Claude CLI ラッパー（1ショット処理用）
├── queue/             # ジョブキュー
│   ├── processor.ts   # キュー管理（JSON永続化、冪等性、リトライ）
│   ├── scheduler.ts   # Cronスケジューラ（バッチ制限）
│   └── rate-limiter.ts # 同時実行ガード
├── web/               # Web UI（スマホ操作用）
│   ├── server.ts      # Hono サーバー（Tailscaleバインド）
│   ├── danger-detect.ts # 危険コマンド事後報告
│   ├── routes/
│   │   └── chat.ts    # Agent SDK + SSEストリーミング
│   └── public/
│       └── index.html # モバイルファーストチャットUI
├── utils/             # ユーティリティ
│   ├── logger.ts      # 構造化ログ
│   ├── audit.ts       # 監査ログ（JSONL）
│   └── sanitize.ts    # 入力サニタイズ
├── config.ts          # 設定管理
└── index.ts           # エントリーポイント（Cron + Queue）

projects.json          # プロジェクト登録（slug, repo, localPath）
```

## プロジェクト概要

- **ビジョン**: Issue駆動 × AI駆動の自律型開発ワークフローを構築する
- **ターゲット**: 個人開発者（自分自身）がスマホや別PCから指示を出し、AIが夜間にIssueを処理する
- **制約**:
  - サーバー: MacBook 2018 (Intel CPU) 常時稼働
  - ネットワーク: Tailscale経由のリモートアクセス
  - LLM: Claude Code CLI/Agent SDK（Maxサブスク枠、ローカル実行）

## アーキテクチャ概要

```
[スマホ/別PC]                     [MacBook 2018 サーバー]
    │                                     │
    └── Tailscale VPN ───────── Web UI (Hono)
                                          │
                                  slug → projects.json 逆引き
                                          │
                                  ┌───────┴───────┐
                                  │ Agent SDK      │ ← SSEストリーミング
                                  │ (チャット)      │ ← 危険コマンド事後報告
                                  └───────┬───────┘
                                          │
                                  ┌───────┴───────┐
                                  │ GitHub Issue   │ ← gh --repo でマルチリポ対応
                                  │ (gh CLI)       │
                                  └───────┬───────┘
                                          │
                                  ┌───────┴───────┐
                                  │ 即時 or キュー  │
                                  └───┬───────┬───┘
                                      │       │
                               immediate    queued
                                      │       │
                              processImmediate │
                                      │  ┌────┴────┐
                                      │  │Job Queue│ ← Cron 01:00 JST
                                      │  └────┬────┘
                                      │       │
                                  ┌───┴───────┴───┐
                                  │ タイチョー      │ ← Strategy パターンで実装切替
                                  │ (claude CLI)   │ ← claude -p --cwd で自動コンテキスト
                                  └───────┬───────┘
                                          │
                                  └── Draft PR作成 → PRマージは人間が判断
```

## LLM利用ポリシー

本プロジェクトは **Claude Code CLI / Agent SDK** をサブスク枠で使用する。

**OK（サブスク範囲内）:**
- 公式SDK/CLIを使ったローカル・個人用の自動化
- 個人マシン上でのcron実行（自分だけが使う場合）

**NG（ToS違反）:**
- OAuthトークンを抜き出して第三者ツールに渡す
- 他人に配布・公開サービス化する場合はAPIキー（従量課金）に移行が必要

**レート制限の注意:**
- Max枠は5時間ごとにリセットされるセッション上限あり
- Claude Code と Claude 本体の使用量は共通枠
- 夜間バッチはジョブ分散・モデル選択最適化が必要
