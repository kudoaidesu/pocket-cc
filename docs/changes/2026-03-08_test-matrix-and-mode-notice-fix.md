# テストマトリクスダッシュボード + 変更ドキュメント強化 + Mode通知バグ修正

- **Issue**: テスト可視化ダッシュボード追加 + 変更ドキュメントテンプレート拡充 + Mode通知のUXバグ2件
- **日付**: 2026-03-08
- **ブランチ**: develop
- **プロジェクト**: pocket-cc

## TL;DR

| 項目 | 内容 |
|------|------|
| **課題** | テストバリエーション（権限×画面×機能）の網羅性が可視化されていない。変更ドキュメントのテンプレートが不十分。Mode切替通知が連続表示され煩わしい＋ストリーミング中に画面下部に固定される |
| **変更内容** | `/test-matrix` ダッシュボード新規追加、SKILL.md テンプレート強化、`showSystemNotice()` でMode/Model通知を置き換え表示＋ストリーミング中の挿入位置修正 |
| **影響範囲** | テスト網羅性の一覧確認が可能に。変更ドキュメントがより構造的に。チャットUIのMode通知が1行に集約され視認性向上 |
| **リスク** | Low — 新規ページ追加とUI通知ロジック変更のみ。既存機能への影響なし |
| **切り戻し** | migrateV5のテーブルは空のため、コードリバートのみで復元可能 |

## 要件マッピング

| Req ID | 要件 | Status | Evidence |
|--------|------|--------|----------|
| REQ-1 | テストバリエーションをマトリクス表示 | Done | `/test-matrix` ページ |
| REQ-2 | プロジェクトに紐づけ | Done | 全API・DBテーブルに `project` カラム |
| REQ-3 | 変更ドキュメントテンプレート強化 | Done | SKILL.md のTL;DR/要件マッピング/設計判断テーブル |
| REQ-4 | Mode通知の連続表示を最新のみに | Done | Before/After スクリーンショット |
| REQ-5 | Mode通知が画面下部に固定される問題 | Done | `insertBefore(streamingAssistant)` で修正 |

## 変更内容

### 変更ファイル

| ファイル | 変更種別 | 概要 |
|---------|---------|------|
| `src/db/schema.ts` | 修正 | migrateV5() 追加: test_dimensions, test_records, test_evidence の3テーブル作成 |
| `src/web/routes/test-matrix.ts` | **新規** | 11 APIエンドポイント（Dimensions/Records/Evidence/Summary CRUD） |
| `src/web/routes/test-matrix.test.ts` | **新規** | 49テスト（全APIエンドポイントのバリデーション・CRUD・境界値） |
| `src/web/public/test-matrix.html` | **新規** | マトリクスダッシュボードUI（プロジェクトセレクター・次元管理・セルドロワー） |
| `src/web/server.ts` | 修正 | `/api/test-matrix` ルート登録 + `/test-matrix` HTML配信 |
| `src/web/public/i18n.js` | 修正 | `tm.*` プレフィックスで ja/en 翻訳キー追加（11キー） |
| `src/web/public/index.html` | 修正 | Features メニューにTest Matrixリンク追加 + `showSystemNotice()` 関数追加 + 4箇所の呼び出し修正 |
| `.claude/skills/change-document/SKILL.md` | 修正 | TL;DR テーブル/要件マッピング/設計判断テーブル/テストマトリクスリンク/Known Gaps セクション追加 |

### 設計判断

| 判断 | 代替案 | 理由 | トレードオフ |
|------|--------|------|------------|
| SQLite に3テーブル追加（test_dimensions, test_records, test_evidence） | 外部ファイル（JSON/YAML） | 既存のSQLiteパターンに統一。クエリ・集計が容易 | マイグレーション管理が必要 |
| `project` カラムで projects.json の slug に紐付け | localPath で紐付け | slug はURLセーフ・一意。observer.html と同じパターン | slug変更時にDB更新が必要 |
| `showSystemNotice()` で直前の同種noticeを置き換え | CSSアニメーションで古いnoticeをフェードアウト | シンプルで確実。DOM操作が最小限 | 履歴としてのMode変更が追えなくなる |
| ストリーミング中は assistant メッセージの手前に notice を挿入 | notice を別レイヤー（fixed position）で表示 | メッセージフロー内で自然な位置に表示される | `tab.sending` 状態への依存 |

## Before / After

| Before | After |
|--------|-------|
| ![before](screenshots/mode-notice-bug_before_chat.png) | ![after](screenshots/mode-notice-bug_after_chat.png) |

**Before**: Plan→Ask→Auto と連続切替すると3つのMode通知が個別に表示される
**After**: 連続切替しても "Mode → auto" の1行のみ表示（最新値で置き換え）

## バグ修正エビデンス

### Bug 1: Mode通知の連続表示

- **再現手順**: Modeボタンをクリック → Plan選択 → Ask選択 → Auto選択
- **再現結果**: 3つの "Mode → plan", "Mode → ask", "Mode → auto" が縦に並ぶ
- **証跡**: ![before](screenshots/mode-notice-bug_before_chat.png)

### Bug 1: 修正後確認

- **同手順の結果**: "Mode → auto" のみ1行表示（直前のnoticeを置き換え）
- **証跡**: ![after](screenshots/mode-notice-bug_after_chat.png)

### Bug 2: Mode通知が画面下部に固定

- **原因**: ストリーミング中に `tab.messagesEl.appendChild(notice)` で assistant メッセージの後に追加 → `scrollToBottom` で常に最下部に表示
- **修正**: `tab.sending` がtrueの場合、`insertBefore(el, streamingAssistant)` で assistant メッセージの手前に挿入
- **確認**: ストリーミング中のMode切替でnoticeがメッセージフロー内の自然な位置に表示されることを確認

## テスト

### 自動テスト

| テスト種別 | 対象 | 結果 | 件数 |
|-----------|------|------|------|
| ユニットテスト (vitest) | test-matrix API 全エンドポイント | pass | 49 pass / 49 total |
| ユニットテスト (vitest) | 既存テスト全体 | pass | 153 pass / 153 total |

### 手動テスト

| シナリオ | 手順 | 期待結果 | 実際の結果 | 判定 |
|---------|------|---------|-----------|------|
| Mode通知の連続置き換え | Plan→Ask→Auto と連続切替 | 1つのnotice のみ表示 | "Mode → auto" のみ表示 | OK |
| Model通知の連続置き換え | モデルドロップダウンから連続切替 | 1つのnotice のみ表示 | 最新モデル名のみ表示 | OK |
| チャットUI基本動作 | ページロード→メッセージ送信 | 正常動作 | 正常動作 | OK |

## リグレッションチェック

- [x] 既存テストスイート: 153 pass / 153 total
- [x] チャットUI基本動作: OK
- [x] Mode切替（Plan/Ask/Auto/YOLO）: OK
- [x] ビルド (`npm run build`): エラーなし
- [x] API後方互換性: N/A（新規エンドポイントのみ）

**影響判定**: 既存処理への影響なし

## Known Gaps / Follow-ups

- [ ] テストマトリクスUIのブラウザ実機検証（次元追加→レコード登録→マトリクス表示の一連フロー）
- [ ] ストリーミング中のMode切替の実環境テスト（SSE status イベント経由）
