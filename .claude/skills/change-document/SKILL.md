---
name: change-document
description: |
  タスク・Issue完了時に変更ドキュメントを生成するワークフロー。
  Before/Afterスクリーンショット、テスト内容、リグレッションチェック結果、
  バグ修正時の再現エビデンスを1つの資料にまとめる。
  出力先: docs/changes/ (MD) + /change-report (HTML) + PR description。
  HTMLレポートはテンプレート (templates/change-report.html) からCatppuccin
  テーマの閲覧ページを生成し、src/web/public/change-report.html に出力する。
  トリガー: 「変更ドキュメント作成」「成果物をまとめて」「ドキュメントにして」
  「エビデンス残して」「変更内容をまとめて」「納品資料」「レポート作成」。
  また、タスク完了報告時・PR作成前に自動的に発動する。
---

# Change Document ワークフロー

タスク完了時に「何を・なぜ・どう変えたか」を視覚的証跡付きで記録する。

## ワークフロー全体像

```
1. Before撮影 → 2. 実装 → 3. After撮影 → 4. MD生成 → 5. HTMLレポート生成 → 6. PR記載 → 7. URLをユーザーに表示
```

**重要**: Before スクリーンショットは実装開始前に撮る。後からは撮れない。

## Phase 1: Before 撮影（実装開始前）

UI変更を伴うタスクの場合、変更対象の画面を撮影する。

```bash
# 保存先ディレクトリ
mkdir -p docs/changes/screenshots

# ファイル命名規則: {issue番号またはslug}_before_{画面名}.png
# 例: 042_before_dashboard.png, fix-header_before_top.png
```

撮影手段:
- Web UI → Playwright MCP または Chrome DevTools MCP の `take_screenshot`
- CLI出力 → Bash実行結果をそのまま記録

UI変更がない場合（ロジックのみ）はスキップし、ドキュメントに「UI変更なし」と明記。

## Phase 2: 実装

通常通り実装を進める。実装中の判断・設計選択はドキュメント用にメモしておく。

## Phase 3: After 撮影 + エビデンス収集

### 3a. After スクリーンショット

Before と同じ画面・条件で撮影する。

```bash
# 例: 042_after_dashboard.png
```

### 3b. バグ修正の場合: 再現→修正エビデンス

バグ修正タスクでは以下を必ず記録:

1. **再現確認**（修正前）: Issue記載の再現手順を実行し、バグが再現することを確認
   - スクリーンショットまたはログ出力を `{slug}_repro.png` として保存
2. **修正後確認**: 同じ手順を実行し、バグが解消されていることを確認
   - スクリーンショットまたはログ出力を `{slug}_fixed.png` として保存

### 3c. リグレッションチェック

既存処理に影響がないか確認し、結果を記録:

- 既存テストスイートの実行結果（pass/fail数）
- 変更ファイルに関連する画面の目視確認（必要に応じてスクリーンショット）
- 確認した範囲と「問題なし」or「影響あり→対処済み」を明記

## Phase 4: ドキュメント生成

`docs/changes/` に Markdown ファイルを生成する。

```bash
# ファイル命名: YYYY-MM-DD_{issue番号またはslug}.md
# 例: docs/changes/2026-03-08_042.md
#      docs/changes/2026-03-08_fix-header-layout.md
```

### テンプレート構造

```markdown
# {タスクタイトル}

- **Issue**: #{番号} または タスク概要
- **日付**: YYYY-MM-DD
- **ブランチ**: {ブランチ名}
- **プロジェクト**: {slug}

## TL;DR

| 項目 | 内容 |
|------|------|
| **課題** | {解決する問題を1行で} |
| **変更内容** | {変更内容を1行で} |
| **影響範囲** | {誰に・どう影響するか} |
| **リスク** | {Low/Medium/High + 1行理由} |
| **切り戻し** | {戻し方} |

## 要件マッピング

| Req ID | 要件 | Status | Evidence |
|--------|------|--------|----------|
| REQ-1 | {要件内容} | Done/Partial/N/A | [リンク or テスト名] |

## 変更内容

### 変更ファイル
| ファイル | 変更種別 | 概要 |
|---------|---------|------|
| src/xxx.ts | 修正 | ○○ロジックを変更 |

### 設計判断
| 判断 | 代替案 | 理由 | トレードオフ |
|------|--------|------|------------|
| {選択したアプローチ} | {検討した代替案} | {この選択の理由} | {犠牲にしたもの} |

## Before / After

| Before | After |
|--------|-------|
| ![before](screenshots/{slug}_before_{画面}.png) | ![after](screenshots/{slug}_after_{画面}.png) |

{UI変更がない場合: 「本タスクはロジック変更のみのため、UI差分なし」}

## バグ修正エビデンス（バグ修正時のみ）

### 再現確認
- **再現手順**: {Issue記載の手順}
- **結果**: 再現した
- **証跡**: ![repro](screenshots/{slug}_repro.png)

### 修正後確認
- **同手順の結果**: 解消を確認
- **証跡**: ![fixed](screenshots/{slug}_fixed.png)

## テスト

### 自動テスト
| テスト種別 | 対象 | 結果 | 件数 |
|-----------|------|------|------|
| ユニットテスト (vitest) | {対象} | pass/fail | {N pass / M total} |
| E2E | {対象} | pass/fail | {N pass / M total} |

### 手動テスト
| シナリオ | 手順 | 期待結果 | 実際の結果 | 判定 |
|---------|------|---------|-----------|------|
| {シナリオ} | {手順} | {期待} | {実際} | OK/NG |

### テストマトリクスリンク
- `/test-matrix#project={slug}&filter={feature}`

## リグレッションチェック

- [ ] 既存テストスイート: {N pass / M total}
- [ ] 関連画面の目視確認
  - [ ] {画面1}: OK
  - [ ] {画面2}: OK
- [ ] API後方互換性: OK/N/A
- [ ] パフォーマンス: 劣化なし / N/A

**影響判定**: {既存処理への影響なし / 影響あり→対処内容}

## Known Gaps / Follow-ups

- [ ] {Gap 1: 説明} → Issue #{番号}
- [ ] {Gap 2: 説明} → 次スプリント
```

## Phase 5: HTMLレポートページ生成

MDファイルと同時に、ブラウザで閲覧できるHTMLレポートページを生成する。

### 手順

1. テンプレートを読み込む:
   ```
   .claude/skills/change-document/templates/change-report.html
   ```

2. テンプレートの `<!-- %%TOC%% -->` と `<!-- %%CONTENT%% -->` を実際のコンテンツで置き換えて、以下に出力:
   ```
   src/web/public/change-report.html
   ```
   **注意**: 1プロジェクトにつき1ファイル。新しいレポートで上書きする（履歴はgitで管理）。

3. server.ts のルート `/change-report` と静的ファイル配信 `/changes/screenshots/*` は初回セットアップ済み。追加不要。

### コンテンツ部分のHTMLパーツ

テンプレートの `<!-- %%CONTENT%% -->` を以下の構造で埋める。MDのセクションと1:1対応。

| セクション | HTML構造 | CSSクラス |
|-----------|---------|-----------|
| タイトル | `<h1 class="title">` | — |
| メタ情報 | `.meta` > `.meta-tag.date` / `.meta-tag.branch` / `.meta-tag.status` | — |
| サマリー数値 | `.summary-bar` > `.summary-item` > `.num` + `.lbl` | 3〜6個を目安 |
| 概要テーブル | `<table class="tldr-table">` > `<tr><th>項目名</th><td>内容</td></tr>` | 項目名は日本語 |
| 要件マッピング | `<table>` + `<span class="badge done">Done</span>` | badge: done/partial |
| 変更ファイル | `<table>` + `<span class="badge new">新規</span>` or `<span class="badge mod">修正</span>` | — |
| 設計判断 | `<table>` 4列（判断/代替案/理由/トレードオフ） | — |
| Before/After | `.screenshots` > `.screenshot-card` > `<img onclick="showFull(this)">` + `.label.before` or `.label.after` | 画像パス: `/changes/screenshots/{file}` |
| バグ修正エビデンス | `<div class="evidence">` > `<p><strong>ラベル:</strong> テキスト</p>` | バグ修正時のみ |
| テスト結果 | `<table>` + `<span class="badge pass">pass</span>` | badge: pass/fail |
| リグレッション | `<ul class="checklist">` > `<li><span class="check">&#10003;</span>` or `<span class="uncheck">` | — |
| 影響判定 | `<div class="impact">テキスト</div>` | `.impact.warn` で警告色 |
| Follow-ups | `<ul class="checklist">` + `.uncheck` | — |

`<!-- %%TOC%% -->` は `<nav class="toc" id="toc">` で、実際のセクションに合わせたリンクを生成する。

### スクリーンショットのパス

- 保存先: `docs/changes/screenshots/{slug}_{before|after}_{画面名}.png`
- HTML内のsrc: `/changes/screenshots/{slug}_{before|after}_{画面名}.png`
- 静的配信ルート `/changes/screenshots/*` → `docs/changes/screenshots/` は設定済み

### UI変更がない場合

スクリーンショットセクションを省略し、概要・変更ファイル・テスト結果のみで構成する。TOCも実際のセクションに合わせて調整。

## Phase 6: PR への記載

PR作成時、description に以下を含める:

```markdown
## Summary
{概要 1-3行}

## Changes
{変更内容の箇条書き}

## Evidence
- 変更ドキュメント: docs/changes/{filename}.md
- Before/After スクリーンショット: 上記ドキュメント内に添付
- テスト結果: {pass/fail サマリ}
- リグレッションチェック: {OK / 要確認}

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

## Phase 7: レポートURLをユーザーに表示する（必須）

**全フェーズ完了後、必ず以下のURLをユーザーに提示する。**

```
https://teruyamac-mini.tail65878f.ts.net/change-report
```

この手順はスキップ不可。コミット・PR作成が終わった後、最後に必ずURLを出力する。

## 注意事項

- Before撮影を忘れた場合: git stash → 撮影 → git stash pop で復元可能。それも難しい場合は「Before撮影なし（実装着手後に気づいたため）」と正直に記載
- スクリーンショットが不要な変更（設定ファイルのみ等）でも、テストとリグレッションチェックの記録は必須
- ドキュメント内の不要セクション（バグ修正でない場合のエビデンスセクション等）は省略してよい
