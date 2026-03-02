---
name: cron-manager
description: issue-ai-bot の Cron ジョブを確認・設定変更・無効化する。トリガーワード：「cron」「スケジュール確認」「スケジュール変更」「cronを変更」「cronを削除」「無効化」「スケジュール設定」「定期実行」。
---

# Cron ジョブ管理

## 登録済み Cron ジョブ

| name | 環境変数 | デフォルト | 用途 |
|------|---------|-----------|------|
| `queue-process` | `CRON_SCHEDULE` | `0 1 * * *` | 毎日 01:00 — Issue キューをバッチ処理 |
| `usage-scrape` | `USAGE_SCRAPE_SCHEDULE` | `*/20 * * * *` | 20分ごと — LLM使用量スクレイプ & 閾値超過アラート |
| `daily-usage-status` | `CRON_DAILY_USAGE_STATUS_SCHEDULE` | `0 18 * * *` | 毎日 18:00 — LLM使用量 + キュー状況の日次レポート |

タイムゾーンはすべて `Asia/Tokyo`。

## 現在のスケジュール確認

### ① Discord コマンド（推奨）

Discord で `/cron` を実行すると現在の登録済みジョブとスケジュールが表示される。

### ② .env の直接確認

```bash
grep -E '(CRON|SCRAPE|SCHEDULE)' /Users/ai-server/work/issue-ai-bot/.env
```

### ③ サービス稼働確認

```bash
launchctl list | grep issue-ai-bot
# PID が数値なら起動中、"-" なら停止中
```

## スケジュール変更

`.env` を編集後、**再起動のみでOK**（TypeScript 変更なし → ビルド不要）。

```bash
# 1. .env を編集（該当行を書き換える）
# 例: daily-usage-status を 20:00 に変更
#   CRON_DAILY_USAGE_STATUS_SCHEDULE=0 20 * * *

# 2. ボット再起動
launchctl stop ai.issue-ai-bot && sleep 2 && launchctl start ai.issue-ai-bot

# 3. 反映確認
launchctl list | grep issue-ai-bot
```

### cron 式クイックリファレンス

```
分  時  日  月  曜  意味
0   1  *   *   *   毎日 01:00
0  18  *   *   *   毎日 18:00
*/20 *  *   *   *   20分ごと
0   9  *   *  1-5  平日 09:00
```

## Cron の無効化

スケジュールを「絶対に実行されない日時」に設定してから再起動する。
ソースコードは変更しない。

```bash
# 例: usage-scrape を無効化
# .env に追記または書き換え:
#   USAGE_SCRAPE_SCHEDULE=0 0 31 2 *
# (2月31日 = 存在しない日付 → 実行されない)

launchctl stop ai.issue-ai-bot && sleep 2 && launchctl start ai.issue-ai-bot
```

### 再有効化

`.env` の該当行を元のスケジュールに戻して再起動する。

## 注意事項

- `.env` に該当変数がない場合はコード内のデフォルト値が使われる
- 以下の変数は現在 **未使用**（削除または無視してよい）:
  - `CRON_REPORT_SCHEDULE` — `status-report` cron は廃止済み
  - `USAGE_REPORT_SCHEDULE` — どの cron にも紐付いていない
- スケジュール変更はコード変更ではないため、ビルド（`npm run build`）は不要
- TypeScript ソース（`src/`）を変更した場合は `npm run build` + 再起動が必要
