# claude-crew

Issue 駆動 x AI 駆動の自律型開発ワークフロー。Web UI から指示を出すと、AI が GitHub Issue を処理し、Draft PR を自動生成する。

## コンセプト

```
人間（Web UI）→ GitHub Issue → Cron Queue → タイチョー（AI）→ Draft PR
```

1. **Web UI から指示**: スマホや別 PC から Tailscale 経由でアクセス
2. **Issue 管理**: GitHub Issue をキューに登録
3. **夜間バッチ処理**: Cron でタイチョー（AI 実行隊長）が Issue を順次処理
4. **Draft PR 作成**: 人間がレビュー・マージを判断

## 設計思想: CLI-First

外部サービスのトークンを環境変数で管理しない。各 CLI の認証セッションをそのまま利用する。

| サービス | アクセス手段 | 認証 |
|---------|-------------|------|
| GitHub | `gh` CLI | `gh auth login` |
| Claude | `claude` CLI / Agent SDK | `claude login` or `ANTHROPIC_API_KEY` |

## アーキテクチャ

```
[スマホ/別PC]                     [サーバー]
    |                                  |
    +-- Tailscale VPN ---------- Web UI (Hono)
                                       |
                               slug -> projects.json
                                       |
                               +-------+-------+
                               | Agent SDK     | <- SSE ストリーミング
                               | (チャット)     |
                               +-------+-------+
                                       |
                               +-------+-------+
                               | GitHub Issue  | <- gh --repo でマルチリポ対応
                               | (gh CLI)      |
                               +-------+-------+
                                       |
                               +-------+-------+
                               | 即時 or キュー |
                               +---+-------+---+
                                   |       |
                            immediate    queued
                                   |       |
                                   |  +----+----+
                                   |  |Job Queue| <- Cron
                                   |  +----+----+
                                   |       |
                               +---+-------+---+
                               | タイチョー     | <- Strategy パターンで実装切替
                               | (claude CLI)  |
                               +-------+-------+
                                       |
                               +-- Draft PR 作成
```

## 技術スタック

| カテゴリ | 技術 |
|---------|------|
| ランタイム | Node.js + TypeScript |
| Web UI | Hono（SSE ストリーミング） |
| GitHub 連携 | `gh` CLI（トークン不要） |
| LLM | Claude Code CLI / Agent SDK |
| Cron ジョブ | node-cron |
| ネットワーク | Tailscale（リモートアクセス） |
| テスト | Vitest |

## セットアップ

### 前提条件

- Node.js 20+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) — `npm i -g @anthropic-ai/claude-code`
- [GitHub CLI](https://cli.github.com/) — `gh auth login`

### インストール

```bash
git clone https://github.com/kudoaidesu/claude-crew
cd claude-crew
npm install
npm run setup    # 対話式セットアップ（.env + projects.json 生成）
npm run web:dev  # Web UI 起動
```

詳細は [docs/setup.md](docs/setup.md) を参照。

## ドキュメント

| ドキュメント | 内容 |
|-------------|------|
| [docs/setup.md](docs/setup.md) | セットアップ手順・環境変数リファレンス |
| [docs/architecture.md](docs/architecture.md) | アーキテクチャ設計詳細 |
| [docs/distribution-plan.md](docs/distribution-plan.md) | 配布可能化の実装計画 |

## ライセンス

MIT
