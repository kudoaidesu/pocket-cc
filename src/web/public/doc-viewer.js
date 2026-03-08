/**
 * DocViewer — 共通ドキュメントビューア
 *
 * 一覧ページ (loadList) と詳細ページ (loadDynamic) の両方で使用。
 * changes / status / incidents 等のドキュメントタイプで共有する。
 */
;(function(){
  var DV = {}

  // ── Utilities ──

  DV.esc = function(s) {
    var d = document.createElement('div')
    d.textContent = s
    return d.innerHTML
  }

  DV.slugify = function(s) {
    return s.toLowerCase().replace(/[^\w\u3000-\u9fff]+/g, '-').replace(/^-|-$/g, '')
  }

  DV.toggleTheme = function() {
    var html = document.documentElement
    var next = html.getAttribute('data-theme') === 'light' ? '' : 'light'
    if (next) html.setAttribute('data-theme', 'light')
    else html.removeAttribute('data-theme')
    localStorage.setItem('theme', next || 'dark')
  }

  DV.initTheme = function() {
    var saved = localStorage.getItem('theme')
    if (saved === 'light') document.documentElement.setAttribute('data-theme', 'light')
  }

  // ── TOC Tracking ──

  DV.initTocTracking = function() {
    var tocLinks = document.querySelectorAll('.toc a')
    var sections = []
    tocLinks.forEach(function(a) {
      var id = a.getAttribute('href')
      if (!id) return
      id = id.slice(1)
      var el = document.getElementById(id)
      if (el) sections.push({ el: el, a: a })
    })
    function update() {
      var current = sections[0]
      for (var i = 0; i < sections.length; i++) {
        if (sections[i].el.getBoundingClientRect().top <= 80) current = sections[i]
      }
      tocLinks.forEach(function(a) { a.classList.remove('active') })
      if (current) current.a.classList.add('active')
    }
    window.addEventListener('scroll', update, { passive: true })
    update()
  }

  // ── Fullscreen Image Overlay ──

  DV.showFull = function(img) {
    var ov = document.getElementById('overlay')
    if (!ov) return
    document.getElementById('overlayImg').src = img.src
    ov.classList.add('open')
  }

  DV.initOverlay = function() {
    var ov = document.getElementById('overlay')
    if (ov) ov.addEventListener('click', function() { ov.classList.remove('open') })
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' && ov) ov.classList.remove('open')
    })
  }

  // ── Markdown Inline Formatting ──

  DV.inline = function(s, proj, docType) {
    var e = DV.esc
    var apiBase = '/api/' + docType
    // Images with screenshot path rewriting
    s = s.replace(/!\[([^\]]*)\]\(screenshots\/([^)]+)\)/g, function(_, alt, path) {
      return '<img src="' + apiBase + '/' + encodeURIComponent(proj) + '/screenshots/' + encodeURIComponent(path) + '" alt="' + e(alt) + '" onclick="DocViewer.showFull(this)" style="max-width:100%;cursor:pointer;border-radius:6px">'
    })
    s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" style="max-width:100%">')
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" style="color:var(--accent)">$1</a>')
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong style="color:var(--text-bright)">$1</strong>')
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>')
    return s
  }

  // ── Markdown Full Renderer ──

  DV.renderMd = function(md, proj, docType, contentEl, tocEl) {
    var e = DV.esc
    var lines = md.split('\n'), html = '', tocH = '', meta = '', title = ''
    var inTbl = false, inCode = false, inList = false, ltag = ''
    var gotTitle = false, inMeta = false, firstH2 = true

    function cl() { if (inList) { html += '</' + ltag + '>'; inList = false } }
    function ct() { if (inTbl) { html += '</tbody></table></div>'; inTbl = false } }
    function inl(s) { return DV.inline(s, proj, docType) }

    for (var i = 0; i < lines.length; i++) {
      var L = lines[i]
      // Code block
      if (L.startsWith('```')) {
        if (inCode) { html += '</code></pre>'; inCode = false }
        else { cl(); ct(); inCode = true; html += '<pre style="background:var(--surface);padding:12px;border-radius:6px;overflow-x:auto;margin:8px 0;font-size:12px"><code style="background:none;padding:0">' }
        continue
      }
      if (inCode) { html += e(L) + '\n'; continue }
      // Title
      if (L.startsWith('# ') && !gotTitle) {
        title = '<h1 class="title">' + inl(L.slice(2).trim()) + '</h1>'
        gotTitle = true; inMeta = true; continue
      }
      // Meta
      if (inMeta) {
        var mm = L.match(/^- \*\*(.+?)\*\*[：:]\s*(.+)$/)
        if (mm) {
          var k = mm[1], v = mm[2]
          if (k === '日付' || k === 'Date') meta += '<span class="meta-tag date">' + e(v) + '</span>'
          else if (k === 'ブランチ' || k === 'Branch') meta += '<span class="meta-tag branch">' + e(v) + '</span>'
          else meta += '<span class="meta-tag status">' + e(v) + '</span>'
          continue
        }
        if (L.trim() === '') continue
        if (!L.startsWith('- **')) inMeta = false
      }
      // h2
      if (L.startsWith('## ')) {
        cl(); ct()
        var t2 = L.slice(3).trim(), id = DV.slugify(t2)
        if (firstH2 && (t2 === 'TL;DR' || t2 === '概要')) id = 'tldr'
        html += '<h2 id="' + id + '">' + inl(t2) + '</h2>'
        tocH += '<a href="#' + id + '" class="toc-h2">' + e(t2) + '</a>'
        firstH2 = false; continue
      }
      // h3
      if (L.startsWith('### ')) {
        cl(); ct()
        var t3 = L.slice(4).trim(), id3 = DV.slugify(t3)
        html += '<h3 id="' + id3 + '">' + inl(t3) + '</h3>'
        tocH += '<a href="#' + id3 + '">' + e(t3) + '</a>'
        continue
      }
      // Table
      if (L.startsWith('|')) {
        cl()
        var cells = L.split('|').slice(1, -1).map(function(c) { return c.trim() })
        if (cells.every(function(c) { return /^[-:]+$/.test(c) })) continue
        if (!inTbl) {
          var isTldr = cells.length === 2 && (cells[0] === '項目' || cells[0] === 'Item')
          html += '<div class="table-wrap"><table' + (isTldr ? ' class="tldr-table"' : '') + '><thead><tr>'
          for (var j = 0; j < cells.length; j++) html += '<th>' + inl(cells[j]) + '</th>'
          html += '</tr></thead><tbody>'; inTbl = true
        } else {
          html += '<tr>'
          for (var j = 0; j < cells.length; j++) html += '<td>' + inl(cells[j]) + '</td>'
          html += '</tr>'
        }
        continue
      }
      if (inTbl && !L.startsWith('|')) ct()
      // Checklist
      var clm = L.match(/^- \[([ xX])\] (.+)/)
      if (clm) {
        if (!inList || ltag !== 'ul') { cl(); html += '<ul class="checklist">'; inList = true; ltag = 'ul' }
        var chk = clm[1] !== ' '
        html += '<li><span class="' + (chk ? 'check' : 'uncheck') + '">' + (chk ? '&#10003;' : '') + '</span>' + inl(clm[2]) + '</li>'
        continue
      }
      // UL
      if (L.startsWith('- ')) {
        if (!inList) { html += '<ul>'; inList = true; ltag = 'ul' }
        html += '<li>' + inl(L.slice(2)) + '</li>'; continue
      }
      // OL
      var olm = L.match(/^\d+\. (.+)/)
      if (olm) {
        if (!inList || ltag !== 'ol') { cl(); html += '<ol>'; inList = true; ltag = 'ol' }
        html += '<li>' + inl(olm[1]) + '</li>'; continue
      }
      // HR
      if (/^---+$/.test(L.trim())) { html += '<hr style="border:none;border-top:1px solid var(--border);margin:16px 0">'; continue }
      // Empty
      if (L.trim() === '') { cl(); continue }
      // Paragraph
      html += '<p>' + inl(L) + '</p>'
    }
    cl(); ct(); if (inCode) html += '</code></pre>'

    contentEl.innerHTML = title + (meta ? '<div class="meta">' + meta + '</div>' : '') + html
    if (tocEl && tocH) tocEl.innerHTML = tocH
    DV.initTocTracking()
  }

  // ── Detail Page: Dynamic Loading ──

  /**
   * 詳細ページの動的ロード
   * @param {string} docType - ドキュメントタイプ（changes / status / incidents）
   * @param {string} listUrl - 一覧ページURL（戻りリンク用）
   * @param {string} listLabel - 戻りリンクのラベル
   */
  DV.loadDynamic = function(docType, listUrl, listLabel) {
    var params = new URLSearchParams(location.search)
    var proj = params.get('project'), file = params.get('file')
    if (!proj || !file) return false

    var e = DV.esc

    // Update header with back link
    var hdr = document.querySelector('.page-header')
    if (hdr) {
      hdr.innerHTML = '<a href="' + e(listUrl) + '">\u2190 ' + e(listLabel) + '</a>'
        + '<span class="sep">/</span>'
        + '<span style="font-size:12px;color:var(--muted)">' + e(proj) + '</span>'
        + '<span class="sep">/</span>'
        + '<h1>' + e(file.replace('.md', '')) + '</h1>'
        + '<button class="theme-toggle" onclick="DocViewer.toggleTheme()">Theme</button>'
    }

    var contentEl = document.querySelector('.content')
    var tocEl = document.getElementById('toc')
    if (contentEl) contentEl.innerHTML = '<p style="color:var(--muted)">Loading...</p>'
    if (tocEl) tocEl.innerHTML = ''

    fetch('/api/' + docType + '/' + encodeURIComponent(proj) + '/' + encodeURIComponent(file))
      .then(function(r) { return r.json() })
      .then(function(d) {
        if (d.error) throw new Error(d.error)
        DV.renderMd(d.content, proj, docType, contentEl, tocEl)
      })
      .catch(function(err) {
        if (contentEl) contentEl.innerHTML = '<p style="color:var(--danger)">Failed to load: ' + e(String(err.message || err)) + '</p>'
      })

    return true
  }

  // ── List Page: Load & Render ──

  /**
   * 一覧ページのロード
   * @param {string} docType - ドキュメントタイプ
   * @param {object} config
   * @param {string} config.reportUrl - 詳細ページURL pattern (e.g., '/change-report')
   * @param {string} config.storageKey - localStorage key for project filter
   * @param {string} config.emptyI18n - 空メッセージの i18n key
   */
  DV.loadList = function(docType, config) {
    var currentProject = ''
    var sel = document.getElementById('projectSelect')
    var container = document.getElementById('reportList')

    // Load projects
    fetch('/api/projects')
      .then(function(r) { return r.json() })
      .then(function(projects) {
        var valid = projects.filter(function(p) { return p.localPath !== '__front-desk__' })
        for (var i = 0; i < valid.length; i++) {
          var opt = document.createElement('option')
          opt.value = valid[i].slug
          opt.textContent = valid[i].slug
          sel.appendChild(opt)
        }
        var saved = localStorage.getItem(config.storageKey)
        if (saved && valid.some(function(p) { return p.slug === saved })) {
          sel.value = saved
          currentProject = saved
        }
        refresh()
      })
      .catch(function(e) {
        console.error('Failed to load projects:', e)
        refresh()
      })

    function refresh() {
      var url = currentProject
        ? '/api/' + docType + '?project=' + encodeURIComponent(currentProject)
        : '/api/' + docType
      fetch(url)
        .then(function(r) { return r.json() })
        .then(function(data) { renderReports(data.reports) })
        .catch(function() {
          container.innerHTML = '<div class="empty-state"><p>Failed to load</p></div>'
        })
    }

    function renderReports(reports) {
      var e = DV.esc
      if (!reports || !reports.length) {
        container.innerHTML = '<div class="empty-state">'
          + '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>'
          + '<p data-i18n="' + (config.emptyI18n || '') + '">No documents found</p></div>'
        return
      }

      // Group by date
      var groups = {}
      for (var i = 0; i < reports.length; i++) {
        var key = reports[i].date || 'Unknown'
        if (!groups[key]) groups[key] = []
        groups[key].push(reports[i])
      }

      var html = ''
      var entries = Object.entries(groups)
      for (var g = 0; g < entries.length; g++) {
        var date = entries[g][0], items = entries[g][1]
        html += '<div class="date-group">'
        html += '<div class="date-group-header">' + e(date) + '</div>'
        for (var k = 0; k < items.length; k++) {
          var r = items[k]
          var href = config.reportUrl + '?project=' + encodeURIComponent(r.project) + '&file=' + encodeURIComponent(r.filename)
          html += '<a class="report-card" href="' + e(href) + '">'
          html += '<div class="rc-icon"><svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg></div>'
          html += '<div class="rc-content">'
          html += '<div class="rc-title">' + e(r.title) + '</div>'
          html += '<div class="rc-meta">'
          html += '<span class="rc-badge project">' + e(r.project) + '</span>'
          if (r.branch) html += '<span class="rc-badge branch">' + e(r.branch) + '</span>'
          if (r.issue) html += '<span class="rc-badge issue">' + e(r.issue) + '</span>'
          html += '</div></div>'
          html += '<div class="rc-chevron"><svg viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg></div>'
          html += '</a>'
        }
        html += '</div>'
      }
      container.innerHTML = html
    }

    // Expose refresh for external use
    sel.addEventListener('change', function() {
      currentProject = sel.value
      localStorage.setItem(config.storageKey, currentProject)
      refresh()
    })

    // Expose refresh on the button
    window._dvRefresh = refresh
  }

  // Expose globally
  window.DocViewer = DV
})()
