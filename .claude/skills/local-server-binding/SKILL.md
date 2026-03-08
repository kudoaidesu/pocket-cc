---
name: local-server-binding
description: サーバーのバインドアドレスは0.0.0.0をデフォルトにする。特定IPへの動的バインドはローカルアクセスを妨げる。トリガーワード：「サーバー起動」「バインド」「ポート」「アドレス」「listen」「hostname」「接続できない」「localhost」「Tailscale」。サーバー設定の実装・修正時、接続問題のデバッグ時に使用。
---

# ローカルサーバーバインドの原則

## 原則

**サーバーは `0.0.0.0` にバインドする。特定IPの動的検出をデフォルトにしない。**

## なぜか

| バインド先 | localhost | Tailscale IP | LAN IP |
|-----------|-----------|-------------|--------|
| `0.0.0.0` | OK | OK | OK |
| 特定IP (例: Tailscale) | NG | OK | NG |
| `127.0.0.1` | OK | NG | NG |

`0.0.0.0` は全インターフェースでリッスンするため、ローカル・Tailscale・LAN すべてからアクセスできる。

## アンチパターン

```typescript
// NG: 特定IPを動的検出してバインド
const HOST = detectTailscaleIp() // → 100.x.x.x のみ、localhostからアクセス不可

// NG: IPが変わるとリンクが壊れる
const HOST = '100.105.117.73' // ハードコード
```

## 正しいパターン

```typescript
// OK: 全インターフェースにバインド、環境変数でオーバーライド可能
const HOST = process.env.WEB_HOST || '0.0.0.0'
```

## セキュリティの担保

`0.0.0.0` バインド ≠ セキュリティリスク。認証・アクセス制御は別レイヤーで担保する：

- **Tailscale ACL**: ネットワークレベルでアクセス制御
- **ファイアウォール**: OS レベルでポートを制限
- **アプリ認証**: ミドルウェアで認証チェック

バインドアドレスの制限はセキュリティ手段ではない。

## リンク生成ルール

**ユーザーに渡すリンクは必ず Tailscale IP を使う。`localhost` は使わない。**

ユーザーはスマホや別PCから Tailscale 経由でアクセスしている。`localhost` リンクはユーザーの端末自身を指すため開けない。

### Tailscale IP の取得方法

```bash
/sbin/ifconfig 2>/dev/null | grep 'inet 100\.' | awk '{print $2}'
```

### 使い分け

| 用途 | ホスト | 例 |
|------|--------|-----|
| AI自身の検証 (curl, Playwright) | `localhost` | `curl http://localhost:3100/` |
| ユーザーに共有するリンク | Tailscale IP | `http://100.75.121.88:3100/path` |

### リンク生成手順

1. Tailscale IP を取得する
2. `http://{TAILSCALE_IP}:3100/path` 形式でリンクを生成
3. マークダウンリンクとして提示: `[表示名](http://{TAILSCALE_IP}:3100/path)`
