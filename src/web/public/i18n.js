// ── i18n (Japanese / English) ──────────────────
(function() {
  var I18N = {
    ja: {
      // ── Chat UI: ヘッダー・タブ ──
      'drawer.sessions': 'セッション',
      'drawer.files': 'ファイル',
      'drawer.git': 'Git',
      'drawer.services': 'サービス',
      'drawer.tools': 'ツール',
      'drawer.links': 'リンク',
      'drawer.projects': 'プロジェクト',
      'chat.placeholder': 'Claudeに何でも聞いてみよう...',
      'chat.newChat': '新規チャット',
      'chat.send': '送信 (Enter)',
      'chat.stop': '停止',

      // ── Chat UI: 状態・操作 ──
      'copy': 'コピー',
      'copied': 'コピー済み!',
      'loading': '読み込み中...',
      'loadMore': 'もっと読み込む',
      'noSessions': 'セッションがありません',
      'noMatches': '一致なし',
      'noMatchingCommands': 'コマンドが見つかりません',
      'compacting': 'コンパクト中...',
      'compacted': 'コンパクト済み',
      'compact.confirm': 'コンパクションを実行しますか？',
      'compact.current': '現在:',
      'compact.queued': 'メッセージをキューしました。完了後に自動送信します。',
      'requestInterrupted': 'リクエストが中断されました',
      'loadingHistory': '履歴を読み込み中...',
      'failedToLoad': '読み込み失敗',
      'errorLoadingFiles': 'ファイル読み込みエラー',
      'failedToLoadFile': 'ファイル読み込み失敗',
      'failedToLoadGit': 'Git状態の読み込み失敗',
      'noProjectSelected': 'プロジェクト未選択',
      'noLinksYet': 'リンクがありません',
      'noServicesFound': 'リッスン中のサービスなし',
      'localOnly': 'ローカルのみ',
      'addLink': '+ 追加',
      'bookmarks': 'ブックマーク',
      'projects': 'プロジェクト',

      // ── Chat UI: トースト ──
      'toast.copied': 'コピー済み!',
      'toast.copiedClipboard': '最後の返答をクリップボードにコピーしました',
      'toast.copyFailed': 'コピー失敗',
      'toast.clipboardDenied': 'クリップボードへのアクセスが拒否されました',
      'toast.noMessages': 'エクスポートするメッセージがありません',
      'toast.exported': 'エクスポート完了!',
      'toast.messagesExported': '件のメッセージをMarkdownでコピーしました',
      'toast.downloaded': 'ダウンロード完了!',
      'toast.fileTooLarge': 'ファイルが大きすぎます (最大20MB)',
      'toast.readError': '読み込みエラー',
      'toast.noActiveSession': 'コンパクトするアクティブセッションがありません',
      'toast.waitForResponse': '現在の返答が完了するまでお待ちください',
      'toast.compactDone': 'コンパクト完了。切り替えてキュー済みメッセージを送信します。',
      'toast.compactError': 'コンパクトエラー',

      // ── セッション管理 ──
      'session.deleteConfirm': 'このセッションを削除しますか？',
      'session.deleted': 'セッションを削除しました',
      'session.archiveOld': '30日以上前のセッションをアーカイブ',
      'session.archiveConfirm': '30日以上アクセスのないセッションをアーカイブしますか？',
      'session.archived': '件のセッションをアーカイブしました',

      // ── コストダッシュボード ──
      'cost.title': 'コスト',
      'cost.overall': '全体',
      'cost.turns': 'ターン',
      'cost.duration': '合計時間',
      'cost.sessions': 'セッション',
      'cost.avgPerSession': '平均/セッション',
      'cost.byModel': 'モデル別',
      'cost.daily': '日別（7日間）',
      'cost.topSessions': 'コスト上位セッション',
      'cost.noData': 'コストデータがありません',

      // ── ダッシュボード ──
      'dash.title': 'ダッシュボード',
      'dash.health': 'ヘルス',
      'dash.server': 'サーバー',
      'dash.queue': 'キュー',
      'dash.openIssues': 'オープンIssue',
      'dash.openPRs': 'オープンPR',
      'dash.noProjects': 'プロジェクトが登録されていません',
      'dash.services': '稼働サービス',

      // ── 接続状態 ──
      'connection.reconnecting': 'サーバーに再接続中...',
      'connection.restored': '復帰しました。再読み込み中...',

      // ── スクリーンショット ──
      'ss.title': 'スクリーンショット',
      'ss.empty': 'スクリーンショットがありません',
      'ss.noDesc': '説明なし',

      // ── 設定パネル ──
      'settings.title': '設定',
      'settings.theme': 'テーマ',
      'settings.language': '言語',
      'settings.notifications': '通知',

      // ── 通知 ──
      'notif.enabled': '通知を有効にしました',
      'notif.denied': '通知の許可が拒否されました',
      'notif.unsupported': 'このブラウザは通知に対応していません',
      'notif.sessionDone': 'セッション完了',
      'notif.error': 'エラー発生',

      // ── Chat UI: ファイル添付 ──
      'fileAttachments': '(ファイル添付)',
      'tip.mobileAccess': 'Tip: スマホからアクセスするには 0.0.0.0 でバインドが必要。例: next dev --hostname 0.0.0.0',

      // ── Observer UI: レイヤータブ ──
      'obs.tab.interface': '受付',
      'obs.tab.orchestration': '指揮',
      'obs.tab.execution': '実行',
      'obs.tab.state': '状態',
      'obs.tab.governance': '監査',

      // ── Observer UI: ヘッダー ──
      'obs.title': 'Observer',
      'obs.sessionTree': 'セッションツリー',
      'obs.refresh': '更新',

      // ── Observer UI: 状態 ──
      'obs.noSessions': 'セッションが見つかりません',
      'obs.loadError': '読み込みエラー',
      'obs.treeLoadError': 'ツリー読み込みエラー',
      'obs.detailLoadError': '詳細読み込みエラー',
      'obs.updateError': '更新エラー',
      'obs.noMessages': 'テキストメッセージなし',
      'obs.noDelegations': 'Agent委譲なし（flatセッション）',
      'obs.noTools': 'ツール実行なし',
      'obs.noData': 'データなし',
      'obs.noneDetected': 'None detected',
      'obs.none': 'None',
      'obs.cleanSession': 'Clean session',
      'obs.subagents': 'Subagents',

      // ── Observer UI: 親からの指示 ──
      'obs.parentInstruction': '親からの指示',
      'obs.translate': '翻訳',
      'obs.original': '原文',
      'obs.translating': '翻訳中...',

      // ── 時間表記 ──
      'time.justNow': 'たった今',
      'time.minAgo': '分前',
      'time.hoursAgo': '時間前',
      'time.daysAgo': '日前',

      // ── Changes ──
      'cr.title': '変更レポート',
      'cr.allProjects': '全プロジェクト',
      'cr.loading': '読み込み中...',
      'cr.noReports': '変更レポートがありません',

      // ── Test Matrix ──
      'tm.title': 'テストマトリクス',
      'tm.row': '行',
      'tm.col': '列',
      'tm.filter': 'フィルター',
      'tm.showEmpty': '空セル',
      'tm.noDimensions': 'まず次元を設定してください',
      'tm.setupGuide': '2つ以上の次元（例: 権限、画面）を追加するとマトリクスが表示されます。',
      'tm.addDimension': '+ 次元追加',
      'tm.manageDimensions': '次元管理',
      'tm.noRecords': 'テストレコードがありません',
      'tm.close': '閉じる',
    },

    en: {
      // ── Chat UI: Header & Tabs ──
      'drawer.sessions': 'Sessions',
      'drawer.files': 'Files',
      'drawer.git': 'Git',
      'drawer.services': 'Services',
      'drawer.tools': 'Tools',
      'drawer.links': 'Links',
      'drawer.projects': 'Projects',
      'chat.placeholder': 'Ask Claude anything...',
      'chat.newChat': 'New Chat',
      'chat.send': 'Send (Enter)',
      'chat.stop': 'Stop',

      // ── Cost Dashboard ──
      'cost.title': 'Cost',
      'cost.overall': 'Overall',
      'cost.turns': 'Turns',
      'cost.duration': 'Duration',
      'cost.sessions': 'Sessions',
      'cost.avgPerSession': 'Avg / Session',
      'cost.byModel': 'By Model',
      'cost.daily': 'Daily (7 days)',
      'cost.topSessions': 'Top Sessions by Cost',
      'cost.noData': 'No cost data available',

      // ── Dashboard ──
      'dash.title': 'Dashboard',
      'dash.health': 'Health',
      'dash.server': 'Server',
      'dash.queue': 'Queue',
      'dash.openIssues': 'Open Issues',
      'dash.openPRs': 'Open PRs',
      'dash.noProjects': 'No projects registered',
      'dash.services': 'Running Services',

      // ── Connection ──
      'connection.reconnecting': 'Reconnecting to server...',
      'connection.restored': 'Reconnected. Reloading...',

      // ── Screenshots ──
      'ss.title': 'Screenshots',
      'ss.empty': 'No screenshots available',
      'ss.noDesc': 'No description',

      // ── Settings Panel ──
      'settings.title': 'Settings',
      'settings.theme': 'Theme',
      'settings.language': 'Language',
      'settings.notifications': 'Notifications',

      // ── Notifications ──
      'notif.enabled': 'Notifications enabled',
      'notif.denied': 'Notification permission denied',
      'notif.unsupported': 'Notifications not supported',
      'notif.sessionDone': 'Session complete',
      'notif.error': 'Error occurred',

      // ── Chat UI: Status & Actions ──
      'copy': 'Copy',
      'copied': 'Copied!',
      'loading': 'Loading...',
      'loadMore': 'Load more',
      'noSessions': 'No sessions yet',
      'noMatches': 'No matches',
      'noMatchingCommands': 'No matching commands',
      'compacting': 'Compacting...',
      'compacted': 'compacted',
      'compact.confirm': 'Run compaction?',
      'compact.current': 'Current:',
      'compact.queued': 'Message queued. Will auto-send after compaction.',
      'requestInterrupted': 'Request interrupted',
      'loadingHistory': 'Loading history...',
      'failedToLoad': 'Failed to load',
      'errorLoadingFiles': 'Error loading files',
      'failedToLoadFile': 'Failed to load file',
      'failedToLoadGit': 'Failed to load Git status',
      'noProjectSelected': 'No project selected',
      'noLinksYet': 'No links yet',
      'noServicesFound': 'No listening services found',
      'localOnly': 'Local only',
      'addLink': '+ Add',
      'bookmarks': 'Bookmarks',
      'projects': 'Projects',

      // ── Chat UI: Toasts ──
      'toast.copied': 'Copied!',
      'toast.copiedClipboard': 'Last response copied to clipboard',
      'toast.copyFailed': 'Copy failed',
      'toast.clipboardDenied': 'Clipboard access denied',
      'toast.noMessages': 'No messages to export',
      'toast.exported': 'Exported!',
      'toast.messagesExported': ' messages copied as Markdown',
      'toast.downloaded': 'Downloaded!',
      'toast.fileTooLarge': 'File too large (max 20MB)',
      'toast.readError': 'Error reading',
      'toast.noActiveSession': 'No active session to compact',
      'toast.waitForResponse': 'Wait for current response to finish',
      'toast.compactDone': 'Compact done. Switch back to send queued message.',
      'toast.compactError': 'Compact error',

      // ── Session Management ──
      'session.deleteConfirm': 'Delete this session?',
      'session.deleted': 'Session deleted',
      'session.archiveOld': 'Archive sessions older than 30 days',
      'session.archiveConfirm': 'Archive sessions not accessed for 30+ days?',
      'session.archived': 'sessions archived',

      // ── Chat UI: File Attachments ──
      'fileAttachments': '(File attachments)',
      'tip.mobileAccess': 'Tip: To access from mobile, bind to 0.0.0.0. Example: next dev --hostname 0.0.0.0',

      // ── Observer UI: Layer tabs ──
      'obs.tab.interface': 'Interface',
      'obs.tab.orchestration': 'Orchestration',
      'obs.tab.execution': 'Execution',
      'obs.tab.state': 'State',
      'obs.tab.governance': 'Governance',

      // ── Observer UI: Header ──
      'obs.title': 'Observer',
      'obs.sessionTree': 'Session Tree',
      'obs.refresh': 'Refresh',

      // ── Observer UI: States ──
      'obs.noSessions': 'No sessions found',
      'obs.loadError': 'Load error',
      'obs.treeLoadError': 'Tree load error',
      'obs.detailLoadError': 'Detail load error',
      'obs.updateError': 'Update error',
      'obs.noMessages': 'No text messages',
      'obs.noDelegations': 'No agent delegations (flat session)',
      'obs.noTools': 'No tool executions',
      'obs.noData': 'No data',
      'obs.noneDetected': 'None detected',
      'obs.none': 'None',
      'obs.cleanSession': 'Clean session',
      'obs.subagents': 'Subagents',

      // ── Observer UI: Parent instruction ──
      'obs.parentInstruction': 'Instructions from Parent',
      'obs.translate': 'Translate',
      'obs.original': 'Original',
      'obs.translating': 'Translating...',

      // ── Time ──
      'time.justNow': 'just now',
      'time.minAgo': ' min ago',
      'time.hoursAgo': ' hours ago',
      'time.daysAgo': ' days ago',

      // ── Changes ──
      'cr.title': 'Changes',
      'cr.allProjects': 'All Projects',
      'cr.loading': 'Loading...',
      'cr.noReports': 'No change reports found',

      // ── Test Matrix ──
      'tm.title': 'Test Matrix',
      'tm.row': 'Row',
      'tm.col': 'Col',
      'tm.filter': 'Filter',
      'tm.showEmpty': 'Empty',
      'tm.noDimensions': 'Set up dimensions first',
      'tm.setupGuide': 'Add at least 2 dimensions (e.g. Permission, Screen) to display the test matrix.',
      'tm.addDimension': '+ Dimension',
      'tm.manageDimensions': 'Manage Dimensions',
      'tm.noRecords': 'No test records yet',
      'tm.close': 'Close',
    }
  }

  function getLang() {
    var saved = localStorage.getItem('pocket-cc-lang')
    if (saved) return saved
    var nav = navigator.language || ''
    return nav.startsWith('ja') ? 'ja' : 'en'
  }

  var currentLang = getLang()

  function t(key) {
    var catalog = I18N[currentLang] || I18N.en
    return catalog[key] !== undefined ? catalog[key] : (I18N.en[key] || key)
  }

  function setLang(lang) {
    currentLang = lang
    localStorage.setItem('pocket-cc-lang', lang)
    document.documentElement.lang = lang
    // Update all static elements with data-i18n
    var els = document.querySelectorAll('[data-i18n]')
    for (var i = 0; i < els.length; i++) {
      els[i].textContent = t(els[i].getAttribute('data-i18n'))
    }
    // Update placeholders
    var phs = document.querySelectorAll('[data-i18n-placeholder]')
    for (var i = 0; i < phs.length; i++) {
      phs[i].placeholder = t(phs[i].getAttribute('data-i18n-placeholder'))
    }
    // Update titles
    var tls = document.querySelectorAll('[data-i18n-title]')
    for (var i = 0; i < tls.length; i++) {
      tls[i].title = t(tls[i].getAttribute('data-i18n-title'))
    }
    updateLangToggle()
    // Notify dynamic content to re-render
    window.dispatchEvent(new CustomEvent('langchange', { detail: { lang: lang } }))
  }

  function toggleLang() {
    setLang(currentLang === 'ja' ? 'en' : 'ja')
  }

  function updateLangToggle() {
    var btn = document.getElementById('langToggle')
    if (!btn) return
    btn.textContent = currentLang === 'ja' ? 'EN' : 'JP'
    btn.title = currentLang === 'ja' ? 'Switch to English' : '日本語に切り替え'
  }

  // Initialize
  document.documentElement.lang = currentLang

  // Expose globally
  window.t = t
  window.setLang = setLang
  window.toggleLang = toggleLang
  window.updateLangToggle = updateLangToggle
  window.getCurrentLang = function() { return currentLang }

  // On DOM ready, apply translations to static elements
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      setLang(currentLang)
    })
  } else {
    // Already loaded (script at bottom of body)
    setTimeout(function() { setLang(currentLang) }, 0)
  }
})()
