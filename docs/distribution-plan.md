# 配布可能化 実装計画

claude-crew を OSS として公開するための実装計画。
他人がクローンして `npm install → npm run setup → npm run web` で動かせる状態を目指す。

## 利用モデル

- **CLI-First が主軸**: 利用者は自分の Claude Max サブスク環境で `claude setup-token` 済みのマシン上で稼働させる
- `ANTHROPIC_API_KEY` もオプション対応（従量課金ユーザー向け）
- OAuth トークンの抜き出し・再利用は NG

---

## 現状の密結合ポイント

| # | 問題 | 深刻度 | 影響 |
|---|------|--------|------|
| 1 | `projects.json` に `/Users/ai-server/work/claude-crew` がコミット済み | **高** | 他環境で即エラー |
| 2 | Web UI 認証なし（Tailscale ACL に完全依存） | **高** | Tailscale なし環境で無防備に公開 |
| 3 | `.env.example` に実 Tailscale IP `100.116.180.63` | 中 | 誤解を与える |
| 4 | `ANTHROPIC_API_KEY` 非対応 | 中 | APIキーユーザーが使えない |
| 5 | `server.test.ts` に `/Users/ai-server/` ハードコード | 中 | 他環境でテスト結果が不正確 |
| 6 | スキル定義（restart-bot, cron-manager）に絶対パス | 中 | AI が誤パスでコマンド実行 |
| 7 | `docs/setup.md` が Discord Bot 時代の古い内容 | 中 | 初見で混乱する |
| 8 | `lsof` が macOS 前提 | 低 | Linux では `/api/processes` が空配列 |
| 9 | セットアップヘッダーが「Issue AI Bot」のまま | 低 | プロジェクト名が古い |

---

## 実装フェーズ

### Phase 1: 基盤クリーンアップ（小）

#### A. projects.json を配布から除外

| ファイル | 変更内容 |
|---------|---------|
| `.gitignore` | `projects.json` を追加 |
| `projects.json.example`（新規） | プレースホルダーパスの例を記載 |
| `src/config.ts` L.66 | ENOENT 時に `npm run setup` か `projects.json.example` のコピーを案内するログ追加 |

#### B. ハードコードパス除去

| ファイル | 変更内容 |
|---------|---------|
| `src/web/server.test.ts` | `/Users/ai-server/` → `/tmp/test-project` 等の汎用パスに置換（10箇所） |
| `.claude/skills/restart-bot/SKILL.md` | 絶対パス → `<PROJECT_ROOT>` プレースホルダーに変更 |
| `.claude/skills/cron-manager/SKILL.md` | 同上 + Discord 参照を削除 |

#### C. `.env.example` の修正

| ファイル | 変更内容 |
|---------|---------|
| `.env.example` L.34 | `WEB_HOST=100.116.180.63` → `# WEB_HOST=`（コメントアウト、自動検出がデフォルト） |
| `.env.example` 冒頭 | 認証セクション追加（Max サブスク / APIキーの選択肢を説明） |

---

### Phase 2: セットアップウィザード強化（中）

対象: `src/cli/setup.ts`

**現状の流れ**: 前提ツール確認 → LLM モデル選択 → Cron 設定 → `.env` 書き込み

**追加するステップ**:

1. **ヘッダー名の修正**: 「Issue AI Bot」→「claude-crew」

2. **Claude CLI 認証の自動化** (`setupAuth`):
   - `claude --version` で CLI 存在確認 → 未インストールなら `npm i -g @anthropic-ai/claude-code` を案内
   - 認証状態チェック → 未認証なら `claude login` を子プロセスで起動し、その場でブラウザ認証を完了させる
   - 「Max サブスク」or「API キー」の選択肢を提示。API キー選択時はキー入力 → `.env` に `ANTHROPIC_API_KEY` を書き込み

3. **WORK_DIR 設定** (`setupWorkDir`):
   - 作業ディレクトリを質問（デフォルト: `~/work`）
   - `.env` に `WORK_DIR` を書き込み

4. **projects.json 自動生成** (`setupProjects`):
   - WORK_DIR 配下の git リポジトリを自動スキャン
   - `scanWorkDirectory()` ロジックは `src/web/server.ts` に既存 → 共有ユーティリティに抽出
   - 発見したリポジトリを表示、確認後 `projects.json` に書き込み
   - 見つからなければ空配列 `[]` で作成し、手動追加を案内

5. **gh CLI 認証の自動化** (`setupGitHub`):
   - `gh --version` で存在確認 → 未インストールなら `process.platform` に応じたインストール案内
   - `gh auth status` で認証チェック → 未認証なら `gh auth login` をその場で起動

6. **Web UI 認証設定** (`setupWebAuth`):
   - Tailscale 未検出時は `WEB_USERNAME` / `WEB_PASSWORD` の設定を促す

**共有ユーティリティ抽出**:
- `src/utils/project-scanner.ts` を新規作成
- `server.ts` の `scanWorkDirectory()` + `extractRepo()` をここに移動
- `server.ts` と `setup.ts` の両方から import

---

### Phase 3: Web UI Basic Auth（小）

対象: `src/web/server.ts`

```typescript
import { basicAuth } from 'hono/basic-auth'

const webUsername = process.env.WEB_USERNAME
const webPassword = process.env.WEB_PASSWORD
const isTailscaleBound = isTailscaleIp(HOST)

if (!isTailscaleBound && webUsername && webPassword) {
  app.use('*', basicAuth({ username: webUsername, password: webPassword }))
} else if (!isTailscaleBound && HOST !== '127.0.0.1') {
  log.warn('Web UI exposed without authentication. Set WEB_USERNAME/WEB_PASSWORD in .env')
}
```

| 条件 | 動作 |
|------|------|
| Tailscale 環境 | 認証スキップ（ACL に委譲、現状維持） |
| localhost | 認証スキップ（ローカル開発用） |
| それ以外（`0.0.0.0` 等） | Basic Auth 必須。未設定時は警告ログ |

---

### Phase 4: API キー対応 — オプション（小）

`claude` CLI は `ANTHROPIC_API_KEY` 環境変数を自動認識するため、コード変更は最小限。

| ファイル | 変更内容 |
|---------|---------|
| `src/llm/claude-cli.ts` | 変更不要。既存の `cleanEnv` で `ANTHROPIC_API_KEY` は子プロセスに渡る（動作確認のみ） |
| `src/web/services/chat-service.ts` | Agent SDK の `env` オプションに `ANTHROPIC_API_KEY` を含む環境変数を渡す |
| `src/cli/setup.ts` | Phase 2 の `setupAuth` に統合済み |

---

### Phase 5: ドキュメント更新（中）

| ファイル | 変更内容 |
|---------|---------|
| `docs/setup.md` | 全面書き直し（Discord Bot → Web UI アーキテクチャ） |
| `README.md` | OSS 向けに書き直し（Quick Start、アーキテクチャ図更新） |
| `CLAUDE.md` | CLI-First に「`ANTHROPIC_API_KEY` もオプションでサポート」の注記追加 |
| `docs/architecture.md` | Discord 参照の削除、現行アーキテクチャへの更新 |

---

### Phase 6: クロスプラットフォーム最小対応（小）

| ファイル | 変更内容 |
|---------|---------|
| `src/web/server.ts` `/api/processes` | `process.platform === 'darwin'` で `lsof`、`'linux'` で `ss -tlnp` を使い分け |
| `.claude/skills/restart-bot/SKILL.md` | `launchctl` に加えて `systemctl` の代替コマンド追記 |

---

## PR 分割案

| PR | 内容 | 依存 |
|----|------|------|
| PR 1 | Phase 1（基盤クリーンアップ） | なし |
| PR 2 | Phase 2（セットアップウィザード強化）+ Phase 4（APIキー対応） | PR 1 |
| PR 3 | Phase 3（Basic Auth） | なし |
| PR 4 | Phase 5（ドキュメント）+ Phase 6（クロスプラットフォーム） | PR 1-3 |

---

## 理想的なユーザー体験

```bash
git clone https://github.com/kudoaidesu/claude-crew
cd claude-crew
npm install
npm run setup    # 対話式: Claude認証 → gh認証 → WORK_DIR → projects.json → .env 一括生成
npm run web:dev  # Web UI 起動
```

---

## 検証方法

1. `projects.json` と `.env` を削除した状態で `npm run setup` → 認証チェック・`.env` 生成・`projects.json` 生成が一連で完了することを確認
2. `claude` CLI 未認証状態で `npm run setup` → ログインフローが起動することを確認
3. `ANTHROPIC_API_KEY` を設定して `npm run web:dev` → チャットが動作することを確認
4. `WEB_HOST=0.0.0.0` + `WEB_USERNAME`/`WEB_PASSWORD` 設定 → Basic Auth が効くことを確認
5. `npm run test` — テストが環境非依存で通ることを確認
6. `npm run build` — ビルドが通ることを確認
