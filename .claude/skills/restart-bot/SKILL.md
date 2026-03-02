---
name: restart-bot
description: pocket-cc の launchd サービスを制御する（再起動・状態確認・ログ確認）。トリガーワード：「再起動」「restart」「ボットを再起動」「サービスを再起動」「bot restart」「起動して」「止めて」「ログ確認」。
---

# pocket-cc サービス制御

## サービス情報

| 項目 | 値 |
|------|-----|
| ラベル | `ai.pocket-cc.web` |
| plist | `~/Library/LaunchAgents/ai.pocket-cc.web.plist` |
| 実行方法 | `tsx src/web/server.ts`（ビルド不要、ソース直接実行） |
| 作業ディレクトリ | `/Users/ai-server/work/pocket-cc` |
| ログ (stdout) | `data/logs/web.log` |
| ログ (stderr) | `data/logs/web.err.log` |

## コマンド

### 再起動

tsx で直接実行のため、ビルド不要。unload → load で再起動する。

```bash
launchctl unload ~/Library/LaunchAgents/ai.pocket-cc.web.plist && \
launchctl load ~/Library/LaunchAgents/ai.pocket-cc.web.plist
```

### 状態確認

```bash
launchctl list | grep pocket-cc
# 出力例: 85735  0  ai.pocket-cc.web
# 列: PID / 終了コード / ラベル
# PID が "-" なら停止中、数値なら起動中
```

### 起動確認（ログ）

```bash
tail -20 /Users/ai-server/work/pocket-cc/data/logs/web.log
```

### エラー確認

```bash
tail -20 /Users/ai-server/work/pocket-cc/data/logs/web.err.log
```

### 停止

```bash
launchctl unload ~/Library/LaunchAgents/ai.pocket-cc.web.plist
```

### 起動

```bash
launchctl load ~/Library/LaunchAgents/ai.pocket-cc.web.plist
```

## 注意事項

- `tsx` でソースを直接実行するため、**`npm run build` は不要**
- `KeepAlive: true` のためクラッシュ時は自動再起動される
