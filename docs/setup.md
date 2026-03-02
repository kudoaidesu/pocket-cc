# セットアップ手順

## Quick Start

```bash
git clone https://github.com/kudoaidesu/claude-crew
cd claude-crew
npm install
npm run setup    # 対話式セットアップ（.env + projects.json を生成）
npm run web:dev  # Web UI 起動（開発モード）
```

## 前提条件

- **Node.js 20+**
- **Claude Code CLI** — Claude Max サブスク、または API キー
- **GitHub CLI** — `gh auth login` で認証済み
- **Git**
- **Tailscale**（オプション — リモートアクセス用）

## 1. 外部ツールの準備

### 1.1 Claude Code CLI

Claude Code CLI をインストールし、認証する。

```bash
# インストール
npm install -g @anthropic-ai/claude-code

# 認証（ブラウザが開く）
claude login

# 確認
claude --version
```

**認証方式（いずれか）:**

| 方式 | 設定 | 用途 |
|------|------|------|
| Max サブスク（推奨） | `claude login` or `claude setup-token` | 個人利用 |
| API キー | `.env` に `ANTHROPIC_API_KEY=sk-ant-...` | 従量課金 |

### 1.2 GitHub CLI

GitHub CLI をインストールし、認証する。Issue 操作・PR 作成に使用。

**macOS:**
```bash
brew install gh
```

**Linux:**
```bash
# https://github.com/cli/cli/blob/trunk/docs/install_linux.md を参照
```

```bash
# ブラウザ認証でログイン
gh auth login

# 認証確認
gh auth status
```

> GitHub Token は `.env` に書かない。CLI-First 方針に基づき `gh` CLI の認証セッションを使用する。

### 1.3 Tailscale（オプション）

リモートアクセス（スマホや別 PC から Web UI を操作）に使用。ローカルのみで使う場合は不要。

```bash
# macOS
brew install --cask tailscale

# 接続
tailscale up

# IP 確認
tailscale ip -4
```

Tailscale 接続時、Web UI は自動的に Tailscale IP にバインドされる。認証は Tailscale ACL に委譲。

## 2. プロジェクトセットアップ

```bash
git clone https://github.com/kudoaidesu/claude-crew
cd claude-crew
npm install
```

### 対話式セットアップ

```bash
npm run setup
```

ウィザードが以下を順に設定する:

1. **前提ツール確認** — claude CLI, gh CLI のインストール・認証状態チェック
2. **LLM モデル選択** — デフォルト: `sonnet`
3. **Cron スケジュール** — キュー処理と日次レポートのタイミング
4. **`.env` ファイル生成**

### 手動セットアップ

対話式ウィザードを使わない場合:

```bash
cp .env.example .env
# .env を編集

cp projects.json.example projects.json
# projects.json を編集（localPath を自分の環境に合わせる）
```

## 3. 環境変数リファレンス

`.env` の全設定項目:

### 認証

```env
# Claude Max サブスクの場合は不要（claude login で認証済み）
# API キーの場合のみ設定
# ANTHROPIC_API_KEY=sk-ant-...
```

### LLM

```env
# タイチョー（実行隊長）のデフォルトモデル
LLM_MODEL=sonnet

# Web UI チャットのデフォルトモデル (haiku / sonnet / opus)
CHAT_MODEL=haiku
```

### Cron

```env
# キュー処理スケジュール (cron expression, Asia/Tokyo)
CRON_SCHEDULE=0 1 * * *

# レポートスケジュール
CRON_REPORT_SCHEDULE=0 9 * * *
```

### Queue

```env
QUEUE_DATA_DIR=./data
QUEUE_MAX_BATCH_SIZE=5         # 1回のバッチで最大何件処理するか
QUEUE_COOLDOWN_MS=60000        # ジョブ間の待機時間（ms）
QUEUE_MAX_RETRIES=2            # 最大リトライ回数
QUEUE_RETRY_BASE_MS=300000     # リトライ基本待機時間（5分、exponential backoff）
```

### タイチョー（実行隊長）

```env
TAICHO_MAX_RETRIES=3           # 最大リトライ回数
TAICHO_TIMEOUT_MS=1800000      # タイムアウト（30分）
TAICHO_STRATEGY=claude-cli     # 実装戦略
```

### Web UI

```env
WEB_PORT=3100
# WEB_HOST=                    # 空欄で Tailscale IP を自動検出。Tailscale なしなら 127.0.0.1
WEB_USERNAME=admin             # Basic Auth ユーザー名（Tailscale なし環境で必要）
WEB_PASSWORD=                  # Basic Auth パスワード
```

### Usage Monitor

```env
USAGE_SCRAPE_SCHEDULE=*/20 * * * *
USAGE_REPORT_SCHEDULE=0 9 * * *
USAGE_ALERT_THRESHOLD=80
USAGE_CHROME_USER_DATA_DIR=./data/chrome-usage-profile
USAGE_MONITOR_TIMEOUT_MS=60000
```

## 4. プロジェクト登録

`projects.json` でAI が作業する対象リポジトリを登録する:

```json
[
  {
    "slug": "my-project",
    "repo": "owner/repo-name",
    "localPath": "/path/to/your/local/repo"
  }
]
```

| フィールド | 説明 |
|-----------|------|
| `slug` | プロジェクト識別子（URL やログで使用） |
| `repo` | GitHub リポジトリ（`owner/repo` 形式） |
| `localPath` | ローカルの git clone パス（絶対パス） |
| `chatModel` | プロジェクト固有のチャットモデル（省略可、デフォルト: `CHAT_MODEL`） |

**自動スキャン**: Web UI 起動時に `WORK_DIR`（デフォルト `~/work`）配下の git リポジトリを自動検出する。手動登録不要で使い始められる。

## 5. 起動

```bash
# Web UI のみ（開発モード、ホットリロード付き）
npm run web:dev

# Web UI のみ（本番）
npm run web

# Cron + Queue（バックグラウンドジョブ処理）
npm run dev

# ビルド → 本番起動
npm run build && npm run start
```

| コマンド | 内容 |
|---------|------|
| `npm run setup` | 対話式セットアップ |
| `npm run dev` | 開発モード（Cron + Queue、ホットリロード） |
| `npm run web` | Web UI 起動 |
| `npm run web:dev` | Web UI 開発モード（ホットリロード） |
| `npm run build` | TypeScript ビルド |
| `npm run start` | 本番起動（要ビルド） |
| `npm run test` | テスト実行 |

> **注意**: `npm run dev`（Cron + Queue）と `npm run web`（Web UI）は別プロセス。両方必要な場合はそれぞれ起動する。

## 6. サーバー常時起動設定

### macOS（launchd）

`~/Library/LaunchAgents/com.claude-crew.web.plist` を作成:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.claude-crew.web</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/npx</string>
        <string>tsx</string>
        <string>src/web/server.ts</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/path/to/claude-crew</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>NODE_ENV</key>
        <string>production</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/path/to/claude-crew/data/logs/web.log</string>
    <key>StandardErrorPath</key>
    <string>/path/to/claude-crew/data/logs/web.err.log</string>
</dict>
</plist>
```

> `/path/to/claude-crew` を実際のパスに置き換えること。

```bash
# サービス登録・起動
launchctl load ~/Library/LaunchAgents/com.claude-crew.web.plist

# サービス停止
launchctl unload ~/Library/LaunchAgents/com.claude-crew.web.plist

# ログ確認
tail -f data/logs/web.log
```

### Linux（systemd）

`/etc/systemd/system/claude-crew-web.service` を作成:

```ini
[Unit]
Description=claude-crew Web UI
After=network.target

[Service]
Type=simple
User=your-username
WorkingDirectory=/path/to/claude-crew
ExecStart=/usr/bin/npx tsx src/web/server.ts
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
# サービス有効化・起動
sudo systemctl enable claude-crew-web
sudo systemctl start claude-crew-web

# 状態確認
sudo systemctl status claude-crew-web

# ログ確認
journalctl -u claude-crew-web -f
```

## 7. Tailscale 設定（オプション）

Tailscale を使うと、スマホや別 PC から Web UI にリモートアクセスできる。

```bash
# Tailscale の状態確認
tailscale status

# Tailscale IP 確認
tailscale ip -4
```

Web UI は Tailscale IP を自動検出してバインドする。`.env` で `WEB_HOST` を手動指定する必要はない。

**認証**: Tailscale ACL に委譲。Tailscale ネットワーク内のデバイスからのみアクセス可能。

**Tailscale なしの場合**: Web UI は `127.0.0.1`（localhost のみ）にバインドされる。LAN に公開する場合は `WEB_HOST=0.0.0.0` を設定し、`WEB_USERNAME` / `WEB_PASSWORD` で Basic Auth を有効にすること。

## トラブルシューティング

| 症状 | 対処 |
|------|------|
| `claude` コマンドが見つからない | `npm i -g @anthropic-ai/claude-code` でインストール |
| Claude CLI 認証エラー | `claude login` で再認証 |
| GitHub API エラー | `gh auth status` で認証状態を確認 |
| Web UI にアクセスできない | `tailscale status` で接続確認。Tailscale なしなら `http://localhost:3100` |
| Web UI が `127.0.0.1` にバインドされる | Tailscale 未接続。リモートアクセスが必要なら Tailscale を起動するか `WEB_HOST=0.0.0.0` を設定 |
| Cron が動かない | `npm run dev` でプロセスが起動しているか確認 |
| projects.json が見つからない | `npm run setup` を実行するか、`projects.json.example` をコピーして編集 |
| テストが落ちる | `npm run test` でエラーメッセージを確認。環境依存の問題がないか確認 |
